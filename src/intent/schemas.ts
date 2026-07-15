import { z } from 'zod';

import {
  canonicalJson,
  toJsonValue,
  type JsonValue,
} from '../domain/canonical-json.js';
import { parseStrictJson } from '../domain/strict-json.js';
import { isSha256Digest } from '../domain/hash.js';
import {
  CACHE_HIT_WITNESS_SCHEMA,
  CONSTRAINT_OPERATORS,
  INTENT_EFFECTS,
  INTENT_POLARITIES,
  INTENT_REASON_CODES,
  INTENT_SCHEMA,
  NORMALIZATION_WITNESS_SCHEMA,
  IntentWitnessError,
  type CacheEntry,
  type CacheBinding,
  type CacheHitWitness,
  type CacheLookup,
  type IntentIR,
  type IntentReasonCode,
  type NormalizationWitness,
  type NormalizationVerificationContext,
  type ScopeDomain,
  type UnsignedNormalizationWitness,
} from './types.js';
import { assertWellFormedUnicode } from './unicode.js';

const MAX_DOCUMENT_BYTES = 64 * 1024;
const MAX_COLLECTION_ITEMS = 256;
const MAX_VALUE_ITEMS = 2_048;
const MAX_VALUE_STRING_CODE_UNITS = 4_096;

const safeId = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/u);
const safeVersion = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u);
const path = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,255}$/u);
const locale = z.string().regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,4}$/u);
const sha256Digest = z
  .string()
  .refine(isSha256Digest, { message: 'invalid SHA-256 digest' });
const intentSourceDigest = z.union([
  sha256Digest,
  z.string().regex(/^hmac-sha256:intent-source:[a-f0-9]{64}$/u),
]);
const ppm = z.number().int().min(0).max(1_000_000);
const epochMs = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const utcInstant = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u)
  .refine((value) => {
    const date = new Date(value);
    return Number.isFinite(date.valueOf()) && date.toISOString() === value;
  });

const jsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string().max(MAX_VALUE_STRING_CODE_UNITS),
    z.array(jsonValue).max(MAX_COLLECTION_ITEMS),
    z.record(z.string().min(1).max(128), jsonValue),
  ]),
);

const ontology = z
  .object({ id: safeId, version: safeVersion, digest: sha256Digest })
  .strict();

const normalizer = z
  .object({
    id: safeId,
    version: safeVersion,
    artifactDigest: sha256Digest,
    configDigest: sha256Digest,
  })
  .strict();

const temporal = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  z.object({ kind: z.literal('as-of'), instant: utcInstant }).strict(),
  z
    .object({ kind: z.literal('range'), start: utcInstant, end: utcInstant })
    .strict()
    .refine((value) => value.start < value.end),
]);

export const intentIRSchema = z
  .object({
    schema: z.literal(INTENT_SCHEMA),
    ontology,
    goal: z
      .object({
        namespace: safeId,
        action: safeId,
        object: safeId,
        polarity: z.enum(INTENT_POLARITIES),
      })
      .strict(),
    slots: z
      .array(z.object({ name: path, value: jsonValue }).strict())
      .max(MAX_COLLECTION_ITEMS)
      .refine(uniqueBy((slot: { readonly name: string }) => slot.name)),
    constraints: z
      .array(
        z
          .object({
            path,
            operator: z.enum(CONSTRAINT_OPERATORS),
            value: jsonValue,
          })
          .strict(),
      )
      .max(MAX_COLLECTION_ITEMS),
    temporal,
    output: z.object({ format: safeId, locale, detail: safeId }).strict(),
    effect: z.enum(INTENT_EFFECTS),
  })
  .strict();

const candidateEvidence = z
  .object({
    kind: z.enum(['embedding', 'similarity']),
    providerId: safeId,
    evidenceDigest: sha256Digest,
    scorePpm: ppm,
    authoritative: z.literal(false),
  })
  .strict();

const reason = z.enum(INTENT_REASON_CODES);
const shadowDecision = z
  .object({
    verdict: z.enum(['eligible', 'bypass']),
    applied: z.literal(false),
    reasons: z.array(reason).min(1).max(32),
  })
  .strict();

const normalizationWitnessUnsigned = z
  .object({
    schema: z.literal(NORMALIZATION_WITNESS_SCHEMA),
    mode: z.literal('shadow'),
    sourceDigest: intentSourceDigest,
    intentDigest: sha256Digest,
    normalizer,
    ontology,
    policyDigest: sha256Digest,
    assessment: z
      .object({
        ambiguous: z.boolean(),
        confidencePpm: ppm,
        minimumConfidencePpm: ppm,
      })
      .strict(),
    candidateEvidence: z.array(candidateEvidence).max(32),
    claim: z
      .object({
        kind: z.literal('bounded-typed-intent-normalization'),
        universalNaturalLanguageEquivalence: z.literal(false),
        cacheAuthorization: z.literal('none'),
      })
      .strict(),
    decision: shadowDecision,
  })
  .strict();

export const normalizationVerificationContextSchema = z
  .object({
    sourceDigest: intentSourceDigest,
    intent: intentIRSchema,
    normalizer,
    policyDigest: sha256Digest,
    minimumConfidencePpm: ppm,
  })
  .strict();

export const normalizationWitnessSchema = normalizationWitnessUnsigned
  .extend({ witnessDigest: sha256Digest })
  .strict();

const hmacScopeDigest = (domain: ScopeDomain) =>
  z.string().regex(new RegExp(`^hmac-sha256:${domain}:[a-f0-9]{64}$`, 'u'));

const cacheBindingBase = z
  .object({
    intentDigest: sha256Digest,
    normalization: z
      .object({
        normalizer,
        policyDigest: sha256Digest,
        minimumConfidencePpm: ppm,
      })
      .strict(),
    scope: z
      .object({
        cacheNamespace: hmacScopeDigest('cache-namespace'),
        tenant: hmacScopeDigest('tenant'),
        principal: hmacScopeDigest('principal'),
      })
      .strict(),
    authorizationDigest: hmacScopeDigest('authorization'),
    contextDigest: hmacScopeDigest('context'),
    policyDigest: sha256Digest,
    effect: z.enum(INTENT_EFFECTS),
  })
  .strict();

const planDependencies = z
  .object({
    operationRegistryDigest: sha256Digest,
    plannerDigest: sha256Digest,
    toolRegistryDigest: sha256Digest,
  })
  .strict();

const observationDependencies = z
  .object({
    planDigest: sha256Digest,
    executionDigest: sha256Digest,
    toolDigest: sha256Digest,
  })
  .strict();

const responseDependencies = z
  .object({
    observationValueDigest: sha256Digest,
    outputContractDigest: sha256Digest,
    promptDigest: sha256Digest,
    providerDigest: sha256Digest,
    modelDigest: sha256Digest,
    determinism: z.literal('deterministic'),
    determinismDigest: sha256Digest,
    personalization: z.literal('none'),
    personalizationDigest: sha256Digest,
    safety: z.literal('cache-eligible'),
    safetyPolicyDigest: sha256Digest,
  })
  .strict();

export const cacheBindingSchema = z.discriminatedUnion('tier', [
  cacheBindingBase
    .extend({ tier: z.literal('plan'), dependencies: planDependencies })
    .strict(),
  cacheBindingBase
    .extend({
      tier: z.literal('observation'),
      dependencies: observationDependencies,
    })
    .strict(),
  cacheBindingBase
    .extend({ tier: z.literal('response'), dependencies: responseDependencies })
    .strict(),
]);

const revision = z.object({ namespace: safeId, digest: sha256Digest }).strict();

const revisionSet = z
  .array(revision)
  .min(1)
  .max(MAX_COLLECTION_ITEMS)
  .refine(uniqueBy((item: { readonly namespace: string }) => item.namespace));

const cacheEntryFreshness = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('ttl'),
      createdAtEpochMs: epochMs,
      ttlMs: z
        .number()
        .int()
        .min(1)
        .max(30 * 24 * 60 * 60 * 1_000),
    })
    .strict(),
  z
    .object({ kind: z.literal('revision-set'), revisions: revisionSet })
    .strict(),
]);

const cacheLookupFreshness = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ttl'), checkedAtEpochMs: epochMs }).strict(),
  z
    .object({ kind: z.literal('revision-set'), revisions: revisionSet })
    .strict(),
]);

export const cacheEntryPayloadSchema = z
  .object({
    valueDigest: sha256Digest,
    binding: cacheBindingSchema,
    freshness: cacheEntryFreshness,
  })
  .strict();

export const cacheEntrySchema = cacheEntryPayloadSchema
  .extend({ entryDigest: sha256Digest })
  .strict();

export const cacheLookupSchema = z
  .object({ binding: cacheBindingSchema, freshness: cacheLookupFreshness })
  .strict();

const cacheHitWitnessUnsigned = z
  .object({
    schema: z.literal(CACHE_HIT_WITNESS_SCHEMA),
    mode: z.literal('shadow'),
    normalization: z
      .object({
        witnessDigest: sha256Digest,
        sourceDigest: intentSourceDigest,
        intentDigest: sha256Digest,
        verdict: z.enum(['eligible', 'bypass']),
        reasons: z.array(reason).min(1).max(32),
      })
      .strict(),
    entry: cacheEntrySchema,
    lookup: cacheLookupSchema,
    claim: z
      .object({
        comparison: z.literal('exact-bound-digests'),
        candidateEvidenceAuthorizesHit: z.literal(false),
        universalSemanticEquivalence: z.literal(false),
      })
      .strict(),
    decision: shadowDecision,
  })
  .strict();

export const cacheHitWitnessSchema = cacheHitWitnessUnsigned
  .extend({ witnessDigest: sha256Digest })
  .strict();

export function parseIntentIRDocument(input: unknown): IntentIR {
  return parseDocument(input, intentIRSchema, 'INTENT_MALFORMED') as IntentIR;
}

export function parseNormalizationWitnessDocument(
  input: unknown,
): NormalizationWitness {
  return parseDocument(
    input,
    normalizationWitnessSchema,
    'INTENT_MALFORMED',
  ) as NormalizationWitness;
}

export function parseUnsignedNormalizationWitnessDocument(
  input: unknown,
): UnsignedNormalizationWitness {
  return parseDocument(
    input,
    normalizationWitnessUnsigned,
    'INTENT_MALFORMED',
  ) as UnsignedNormalizationWitness;
}

export function parseNormalizationVerificationContextDocument(
  input: unknown,
): NormalizationVerificationContext {
  return parseDocument(
    input,
    normalizationVerificationContextSchema,
    'INTENT_MALFORMED',
  ) as NormalizationVerificationContext;
}

export function parseCacheEntryPayloadDocument(
  input: unknown,
): Omit<CacheEntry, 'entryDigest'> {
  return parseDocument(
    input,
    cacheEntryPayloadSchema,
    'INTENT_MALFORMED',
  ) as Omit<CacheEntry, 'entryDigest'>;
}

export function parseCacheEntryDocument(input: unknown): CacheEntry {
  return parseDocument(
    input,
    cacheEntrySchema,
    'INTENT_MALFORMED',
  ) as CacheEntry;
}

export function parseCacheBindingDocument(input: unknown): CacheBinding {
  return parseDocument(
    input,
    cacheBindingSchema,
    'INTENT_MALFORMED',
  ) as CacheBinding;
}

export function parseCacheLookupDocument(input: unknown): CacheLookup {
  return parseDocument(
    input,
    cacheLookupSchema,
    'INTENT_MALFORMED',
  ) as CacheLookup;
}

export function parseCacheHitWitnessDocument(input: unknown): CacheHitWitness {
  return parseDocument(
    input,
    cacheHitWitnessSchema,
    'INTENT_MALFORMED',
  ) as CacheHitWitness;
}

function parseDocument<T extends z.ZodType>(
  input: unknown,
  schema: T,
  malformedCode: IntentReasonCode,
): z.output<T> {
  try {
    let json: JsonValue;
    if (typeof input === 'string') {
      if (Buffer.byteLength(input, 'utf8') > MAX_DOCUMENT_BYTES) {
        throw new IntentWitnessError(
          'INTENT_DOCUMENT_LIMIT',
          'Intent document exceeds the byte limit',
        );
      }
      json = parseStrictJson(input, {
        maxDepth: 16,
        maxItems: MAX_VALUE_ITEMS,
        maxStringCodeUnits: MAX_VALUE_STRING_CODE_UNITS,
        maxNumberCodeUnits: 128,
      });
      preflightJsonDocument(json, malformedCode);
    } else {
      preflightJsonDocument(input, malformedCode);
      const preflight = schema.safeParse(input);
      if (!preflight.success) {
        throw new IntentWitnessError(
          malformedCode,
          'Intent document failed strict schema validation',
        );
      }
      const serialized = canonicalJson(toJsonValue(preflight.data));
      if (Buffer.byteLength(serialized, 'utf8') > MAX_DOCUMENT_BYTES) {
        throw new IntentWitnessError(
          'INTENT_DOCUMENT_LIMIT',
          'Intent document exceeds the byte limit',
        );
      }
      json = parseStrictJson(serialized, {
        maxDepth: 16,
        maxItems: MAX_VALUE_ITEMS,
        maxStringCodeUnits: MAX_VALUE_STRING_CODE_UNITS,
        maxNumberCodeUnits: 128,
      });
    }

    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new IntentWitnessError(
        malformedCode,
        'Intent document failed strict schema validation',
      );
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof IntentWitnessError) {
      throw error;
    }
    throw new IntentWitnessError(
      malformedCode,
      'Intent document is not strict bounded JSON',
      error,
    );
  }
}

function preflightJsonDocument(
  input: unknown,
  malformedCode: IntentReasonCode,
): void {
  const stack: {
    readonly value: unknown;
    readonly depth: number;
    readonly ancestors: readonly object[];
  }[] = [{ value: input, depth: 0, ancestors: [] }];
  let items = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    items += 1;
    if (items > MAX_VALUE_ITEMS) {
      throw new IntentWitnessError(
        'INTENT_DOCUMENT_LIMIT',
        'Intent document exceeds the item limit',
      );
    }

    const { value, depth, ancestors } = current;
    if (value === null || typeof value === 'boolean') continue;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        throw new IntentWitnessError(
          malformedCode,
          'Intent document contains a non-finite number',
        );
      }
      continue;
    }
    if (typeof value === 'string') {
      assertWellFormedUnicode(value, 'Intent document string');
      if (value.length > MAX_VALUE_STRING_CODE_UNITS) {
        throw new IntentWitnessError(
          'INTENT_DOCUMENT_LIMIT',
          'Intent document exceeds the string limit',
        );
      }
      continue;
    }
    if (typeof value !== 'object') {
      throw new IntentWitnessError(
        malformedCode,
        'Intent document contains a non-JSON value',
      );
    }
    if (depth >= 16) {
      throw new IntentWitnessError(
        'INTENT_DOCUMENT_LIMIT',
        'Intent document exceeds the depth limit',
      );
    }
    if (ancestors.includes(value)) {
      throw new IntentWitnessError(
        malformedCode,
        'Intent document contains a reference cycle',
      );
    }
    const childAncestors = [...ancestors, value];

    if (Array.isArray(value)) {
      if (value.length > MAX_COLLECTION_ITEMS) {
        throw new IntentWitnessError(
          'INTENT_DOCUMENT_LIMIT',
          'Intent document exceeds the collection limit',
        );
      }
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const elementKeys = Object.keys(descriptors).filter(
        (key) => key !== 'length',
      );
      if (
        elementKeys.length !== value.length ||
        elementKeys.some((key) => {
          const index = Number(key);
          return (
            !Number.isInteger(index) ||
            String(index) !== key ||
            index < 0 ||
            index >= value.length
          );
        }) ||
        Object.getOwnPropertySymbols(value).length
      ) {
        throw new IntentWitnessError(
          malformedCode,
          'Intent document array contains non-JSON properties',
        );
      }
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (descriptor === undefined || !('value' in descriptor)) {
          throw new IntentWitnessError(
            malformedCode,
            'Intent document arrays must be dense data arrays',
          );
        }
        stack.push({
          value: descriptor.value,
          depth: depth + 1,
          ancestors: childAncestors,
        });
      }
      continue;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new IntentWitnessError(
        malformedCode,
        'Intent document objects must be plain JSON objects',
      );
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new IntentWitnessError(
        malformedCode,
        'Intent document contains symbol properties',
      );
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(descriptors);
    if (keys.length > MAX_COLLECTION_ITEMS) {
      throw new IntentWitnessError(
        'INTENT_DOCUMENT_LIMIT',
        'Intent document exceeds the object-key limit',
      );
    }
    for (const key of keys) {
      assertWellFormedUnicode(key, 'Intent document key');
      if (key === '__proto__') {
        throw new IntentWitnessError(
          malformedCode,
          'Intent document contains a reserved object key',
        );
      }
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !('value' in descriptor)
      ) {
        throw new IntentWitnessError(
          malformedCode,
          'Intent document objects must contain enumerable data properties',
        );
      }
      stack.push({
        value: descriptor.value,
        depth: depth + 1,
        ancestors: childAncestors,
      });
    }
  }
}

function uniqueBy<T>(key: (item: T) => string): (items: T[]) => boolean {
  return (items) => new Set(items.map(key)).size === items.length;
}
