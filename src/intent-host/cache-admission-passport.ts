import { Buffer } from 'node:buffer';
import { types as utilTypes } from 'node:util';

import { canonicalJson, toJsonValue } from '../domain/canonical-json.js';
import { SemWitnessError } from '../domain/errors.js';
import { hashCanonical, isSha256Digest, sha256 } from '../domain/hash.js';
import { parseStrictJson } from '../domain/strict-json.js';
import {
  SAFE_IDENTIFIER_PATTERN,
  SAFE_VERSION_PATTERN,
  type Sha256Digest,
} from '../domain/types.js';
import { snapshotDenseDataArray } from '../host/data-only.js';
import {
  digestIntentCacheShadowQualificationManifest,
  parseIntentCacheShadowQualificationManifest,
} from './promotion.js';
import {
  IN_TOTO_STATEMENT_V1_TYPE,
  INTENT_CACHE_ADMISSION_PASSPORT_ARTIFACT,
  INTENT_CACHE_ADMISSION_PASSPORT_PREDICATE_TYPE,
  INTENT_CACHE_ADMISSION_PASSPORT_SUBJECT_NAME,
  MAX_INTENT_CACHE_ADMISSION_PASSPORT_BYTES,
  type IntentCacheAdmissionPassportBindingVerification,
  type IntentCacheAdmissionPassportPredicate,
  type IntentCacheAdmissionPassportStatement,
  type IntentCacheAdmissionPassportSubject,
} from './cache-admission-passport-types.js';

const ROOT_FIELDS = ['_type', 'subject', 'predicateType', 'predicate'] as const;
const SUBJECT_FIELDS = ['name', 'digest'] as const;
const DIGEST_FIELDS = ['sha256'] as const;
const PREDICATE_FIELDS = [
  'artifact',
  'profile',
  'authentication',
  'decision',
  'activationCeiling',
  'basis',
  'validity',
  'scope',
  'contracts',
  'evidence',
] as const;
const ARTIFACT_FIELDS = ['id', 'version'] as const;
const BASIS_FIELDS = [
  'schema',
  'artifact',
  'provenance',
  'evidenceAuthentication',
  'producerIdentity',
] as const;
const VALIDITY_FIELDS = ['notBefore', 'notAfter', 'revocationId'] as const;
const SCOPE_FIELDS = [
  'deploymentScopeDigest',
  'cacheNamespace',
  'tenant',
  'domain',
  'operation',
] as const;
const CONTRACT_FIELDS = [
  'cacheAdmissionPolicyDigest',
  'normalizationPolicyDigest',
  'dependenciesDigest',
] as const;
const EVIDENCE_FIELDS = ['reportDigest', 'evaluatorDigest'] as const;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/u;
const HMAC_HEX = '[a-f0-9]{64}';
const CACHE_NAMESPACE_HMAC = new RegExp(
  `^hmac-sha256:cache-namespace:${HMAC_HEX}$`,
  'u',
);
const TENANT_HMAC = new RegExp(`^hmac-sha256:tenant:${HMAC_HEX}$`, 'u');
const DOMAIN_HMAC = new RegExp(`^hmac-sha256:intent-domain:${HMAC_HEX}$`, 'u');
const OPERATION_HMAC = new RegExp(`^hmac-sha256:operation:${HMAC_HEX}$`, 'u');
const REVOCATION_HMAC = new RegExp(`^hmac-sha256:revocation:${HMAC_HEX}$`, 'u');
const CANONICAL_RFC3339_UTC_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

interface StatementParseContext {
  extensionsPresent: boolean;
  extensionItems: number;
  readonly extensionObjects: WeakSet<object>;
}

interface ParsedStatementProfile {
  readonly statement: IntentCacheAdmissionPassportStatement;
  readonly extensionsPresent: boolean;
}

/** Create a Statement from only trusted fields already present in the manifest. */
export function createIntentCacheAdmissionPassportStatement(
  qualificationSource: unknown,
): IntentCacheAdmissionPassportStatement {
  const qualification =
    parseIntentCacheShadowQualificationManifest(qualificationSource);
  const qualificationDigest =
    digestIntentCacheShadowQualificationManifest(qualification);
  return parseIntentCacheAdmissionPassportStatement({
    _type: IN_TOTO_STATEMENT_V1_TYPE,
    subject: [
      {
        name: INTENT_CACHE_ADMISSION_PASSPORT_SUBJECT_NAME,
        digest: { sha256: qualificationDigest.slice('sha256:'.length) },
      },
    ],
    predicateType: INTENT_CACHE_ADMISSION_PASSPORT_PREDICATE_TYPE,
    predicate: {
      artifact: INTENT_CACHE_ADMISSION_PASSPORT_ARTIFACT,
      profile: 'intent-plan-read',
      authentication: 'none',
      decision: 'shadow-qualified',
      activationCeiling: 'shadow-only',
      basis: {
        schema: qualification.schema,
        artifact: qualification.artifact,
        provenance: qualification.provenance,
        evidenceAuthentication: qualification.evidenceAuthentication,
        producerIdentity: qualification.producerIdentity,
      },
      validity: {
        notBefore: toCanonicalRfc3339Utc(
          qualification.validity.notBeforeEpochMs,
        ),
        notAfter: toCanonicalRfc3339Utc(qualification.validity.notAfterEpochMs),
        revocationId: qualification.validity.revocationId,
      },
      scope: {
        deploymentScopeDigest: qualification.deploymentScopeDigest,
        cacheNamespace: qualification.scope.cacheNamespace,
        tenant: qualification.scope.tenant,
        domain: qualification.scope.domain,
        operation: qualification.scope.operation.operation,
      },
      contracts: {
        cacheAdmissionPolicyDigest:
          qualification.intentContract.cacheAdmissionPolicyDigest,
        normalizationPolicyDigest:
          qualification.intentContract.normalizationPolicyDigest,
        dependenciesDigest: hashCanonical(
          toJsonValue(qualification.dependencies),
        ),
      },
      evidence: {
        reportDigest: qualification.evidence.reportDigest,
        evaluatorDigest: qualification.evidence.evaluatorDigest,
      },
    },
  });
}

/**
 * Parse bounded strict JSON and validate the SemWitness profile. Unrecognized
 * in-toto/predicate extension fields are ignored monotonically as required by
 * the in-toto v1 parsing rules; they can never turn a mismatch into `bound`.
 */
export function parseIntentCacheAdmissionPassportStatement(
  source: unknown,
): IntentCacheAdmissionPassportStatement {
  try {
    return parseStatementProfile(source).statement;
  } catch {
    throw malformedPassport();
  }
}

/** Canonical JSON without a trailing newline, suitable for exact DSSE payload bytes. */
export function serializeIntentCacheAdmissionPassportStatement(
  source: unknown,
): string {
  return canonicalJson(
    toJsonValue(parseIntentCacheAdmissionPassportStatement(source)),
  );
}

/** Digest of the extension-eliding supported profile; never a raw payload commitment. */
export function digestIntentCacheAdmissionPassportCanonicalProfile(
  source: unknown,
): Sha256Digest {
  return sha256(serializeIntentCacheAdmissionPassportStatement(source));
}

/**
 * Verify canonical bytes when present, plus subject and every derived field
 * against a separate qualification. `bound` never means authorization.
 */
export function verifyIntentCacheAdmissionPassportStatementBinding(
  statementSource: unknown,
  qualificationSource: unknown,
): IntentCacheAdmissionPassportBindingVerification {
  let parsed: ParsedStatementProfile;
  try {
    parsed = parseStatementProfile(statementSource);
  } catch {
    throw malformedPassport();
  }
  const statement = parsed.statement;
  const qualification =
    parseIntentCacheShadowQualificationManifest(qualificationSource);
  const expected = createIntentCacheAdmissionPassportStatement(qualification);
  const suppliedQualificationDigest =
    digestIntentCacheShadowQualificationManifest(qualification);
  const canonicalProfileDigest =
    digestIntentCacheAdmissionPassportCanonicalProfile(statement);
  const payloadDigest = digestExactPayload(statementSource);
  const canonicalPayload =
    payloadDigest === null ? null : payloadDigest === canonicalProfileDigest;
  return Object.freeze({
    bound:
      !parsed.extensionsPresent &&
      canonicalPayload !== false &&
      serializeIntentCacheAdmissionPassportStatement(statement) ===
        serializeIntentCacheAdmissionPassportStatement(expected),
    extensionsPresent: parsed.extensionsPresent,
    canonicalProfileDigest,
    payloadDigest,
    canonicalPayload,
    statementQualificationDigest:
      `sha256:${statement.subject[0].digest.sha256}` as Sha256Digest,
    suppliedQualificationDigest,
  });
}

function parseStatementProfile(source: unknown): ParsedStatementProfile {
  const context: StatementParseContext = {
    extensionsPresent: false,
    extensionItems: 0,
    extensionObjects: new WeakSet<object>(),
  };
  const statement = parseStatement(parseStatementSource(source), context);
  return Object.freeze({
    statement,
    extensionsPresent: context.extensionsPresent,
  });
}

function parseStatement(
  source: unknown,
  context: StatementParseContext,
): IntentCacheAdmissionPassportStatement {
  const root = snapshotRequiredRecord(source, ROOT_FIELDS, 32, context, 0);
  if (
    root._type !== IN_TOTO_STATEMENT_V1_TYPE ||
    root.predicateType !== INTENT_CACHE_ADMISSION_PASSPORT_PREDICATE_TYPE
  ) {
    throw malformedPassport();
  }
  const subject = parseSubject(root.subject, context);
  const predicate = parsePredicate(root.predicate, context);
  return Object.freeze({
    _type: IN_TOTO_STATEMENT_V1_TYPE,
    subject: Object.freeze([subject]) as readonly [
      IntentCacheAdmissionPassportSubject,
    ],
    predicateType: INTENT_CACHE_ADMISSION_PASSPORT_PREDICATE_TYPE,
    predicate,
  });
}

function parseSubject(
  source: unknown,
  context: StatementParseContext,
): IntentCacheAdmissionPassportSubject {
  const subjects = snapshotDenseDataArray(source, 1, 1);
  const root = snapshotRequiredRecord(
    subjects[0],
    SUBJECT_FIELDS,
    16,
    context,
    2,
  );
  const digest = snapshotRequiredRecord(
    root.digest,
    DIGEST_FIELDS,
    16,
    context,
    3,
  );
  if (
    root.name !== INTENT_CACHE_ADMISSION_PASSPORT_SUBJECT_NAME ||
    typeof digest.sha256 !== 'string' ||
    !SHA256_HEX_PATTERN.test(digest.sha256)
  ) {
    throw malformedPassport();
  }
  return Object.freeze({
    name: INTENT_CACHE_ADMISSION_PASSPORT_SUBJECT_NAME,
    digest: Object.freeze({ sha256: digest.sha256 }),
  });
}

function parsePredicate(
  source: unknown,
  context: StatementParseContext,
): IntentCacheAdmissionPassportPredicate {
  const root = snapshotRequiredRecord(source, PREDICATE_FIELDS, 32, context, 1);
  if (
    root.profile !== 'intent-plan-read' ||
    root.authentication !== 'none' ||
    root.decision !== 'shadow-qualified' ||
    root.activationCeiling !== 'shadow-only'
  ) {
    throw malformedPassport();
  }
  const artifact = parseArtifact(root.artifact, context, 2);
  if (
    artifact.id !== INTENT_CACHE_ADMISSION_PASSPORT_ARTIFACT.id ||
    artifact.version !== INTENT_CACHE_ADMISSION_PASSPORT_ARTIFACT.version
  ) {
    throw malformedPassport();
  }
  const basis = parseBasis(root.basis, context);
  const validity = parseValidity(root.validity, context);
  const scope = parseScope(root.scope, context);
  const contracts = parseDigestRecord(
    root.contracts,
    CONTRACT_FIELDS,
    context,
    2,
  );
  const evidence = parseDigestRecord(
    root.evidence,
    EVIDENCE_FIELDS,
    context,
    2,
  );
  return Object.freeze({
    artifact: INTENT_CACHE_ADMISSION_PASSPORT_ARTIFACT,
    profile: 'intent-plan-read',
    authentication: 'none',
    decision: 'shadow-qualified',
    activationCeiling: 'shadow-only',
    basis,
    validity,
    scope,
    contracts,
    evidence,
  });
}

function parseBasis(source: unknown, context: StatementParseContext) {
  const root = snapshotRequiredRecord(source, BASIS_FIELDS, 24, context, 2);
  if (
    root.schema !==
      'semwitness.dev/intent-cache-shadow-qualification/v1alpha1' ||
    root.provenance !== 'host-attested-unsigned' ||
    root.evidenceAuthentication !== 'none' ||
    root.producerIdentity !== null
  ) {
    throw malformedPassport();
  }
  const artifact = parseArtifact(root.artifact, context, 3);
  if (
    artifact.id !== 'semwitness-intent-cache-shadow-qualifier' ||
    artifact.version !== '1'
  ) {
    throw malformedPassport();
  }
  return Object.freeze({
    schema:
      'semwitness.dev/intent-cache-shadow-qualification/v1alpha1' as const,
    artifact,
    provenance: 'host-attested-unsigned' as const,
    evidenceAuthentication: 'none' as const,
    producerIdentity: null,
  });
}

function parseValidity(source: unknown, context: StatementParseContext) {
  const root = snapshotRequiredRecord(source, VALIDITY_FIELDS, 16, context, 2);
  const notBefore = parseCanonicalRfc3339Utc(root.notBefore);
  const notAfter = parseCanonicalRfc3339Utc(root.notAfter);
  if (
    Date.parse(notBefore) >= Date.parse(notAfter) ||
    typeof root.revocationId !== 'string' ||
    !REVOCATION_HMAC.test(root.revocationId)
  ) {
    throw malformedPassport();
  }
  return Object.freeze({
    notBefore,
    notAfter,
    revocationId: root.revocationId as `hmac-sha256:revocation:${string}`,
  });
}

function parseScope(source: unknown, context: StatementParseContext) {
  const root = snapshotRequiredRecord(source, SCOPE_FIELDS, 24, context, 2);
  if (
    !isSha256Digest(root.deploymentScopeDigest) ||
    typeof root.cacheNamespace !== 'string' ||
    !CACHE_NAMESPACE_HMAC.test(root.cacheNamespace) ||
    typeof root.tenant !== 'string' ||
    !TENANT_HMAC.test(root.tenant) ||
    typeof root.domain !== 'string' ||
    !DOMAIN_HMAC.test(root.domain) ||
    typeof root.operation !== 'string' ||
    !OPERATION_HMAC.test(root.operation)
  ) {
    throw malformedPassport();
  }
  return Object.freeze({
    deploymentScopeDigest: root.deploymentScopeDigest,
    cacheNamespace:
      root.cacheNamespace as `hmac-sha256:cache-namespace:${string}`,
    tenant: root.tenant as `hmac-sha256:tenant:${string}`,
    domain: root.domain as `hmac-sha256:intent-domain:${string}`,
    operation: root.operation as `hmac-sha256:operation:${string}`,
  });
}

function parseDigestRecord<const Field extends string>(
  source: unknown,
  fields: readonly Field[],
  context: StatementParseContext,
  recordDepth: number,
): Readonly<Record<Field, Sha256Digest>> {
  const root = snapshotRequiredRecord(source, fields, 24, context, recordDepth);
  const result: Partial<Record<Field, Sha256Digest>> = Object.create(
    null,
  ) as Partial<Record<Field, Sha256Digest>>;
  for (const field of fields) {
    if (!isSha256Digest(root[field])) throw malformedPassport();
    result[field] = root[field];
  }
  return Object.freeze(result as Record<Field, Sha256Digest>);
}

function parseArtifact(
  source: unknown,
  context: StatementParseContext,
  recordDepth: number,
) {
  const root = snapshotRequiredRecord(
    source,
    ARTIFACT_FIELDS,
    16,
    context,
    recordDepth,
  );
  if (
    typeof root.id !== 'string' ||
    !SAFE_IDENTIFIER_PATTERN.test(root.id) ||
    typeof root.version !== 'string' ||
    !SAFE_VERSION_PATTERN.test(root.version)
  ) {
    throw malformedPassport();
  }
  return Object.freeze({ id: root.id, version: root.version });
}

function parseStatementSource(source: unknown): unknown {
  if (typeof source === 'string') {
    if (
      Buffer.byteLength(source, 'utf8') >
      MAX_INTENT_CACHE_ADMISSION_PASSPORT_BYTES
    ) {
      throw malformedPassport();
    }
    return parseStrictJson(source, statementJsonLimits());
  }
  if (source instanceof Uint8Array) {
    if (source.byteLength > MAX_INTENT_CACHE_ADMISSION_PASSPORT_BYTES) {
      throw malformedPassport();
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(source);
    return parseStrictJson(text, statementJsonLimits());
  }
  return source;
}

function statementJsonLimits() {
  return {
    maxDepth: 12,
    maxItems: 256,
    maxStringCodeUnits: 1_024,
    maxNumberCodeUnits: 32,
  } as const;
}

/**
 * Snapshot required fields without invoking accessors. Unknown fields are
 * accepted for in-toto monotonic extension compatibility, then discarded.
 */
function snapshotRequiredRecord<const Field extends string>(
  source: unknown,
  requiredFields: readonly Field[],
  maximumFields: number,
  context: StatementParseContext,
  recordDepth: number,
): Readonly<Record<Field, unknown>> {
  if (
    utilTypes.isProxy(source) ||
    source === null ||
    typeof source !== 'object' ||
    Array.isArray(source)
  ) {
    throw malformedPassport();
  }
  const prototype = Reflect.getPrototypeOf(source);
  if (prototype !== Object.prototype && prototype !== null) {
    throw malformedPassport();
  }
  const ownKeys = Reflect.ownKeys(source);
  if (
    ownKeys.length > maximumFields ||
    ownKeys.some(
      (key) =>
        typeof key !== 'string' ||
        key.length > statementJsonLimits().maxStringCodeUnits,
    )
  ) {
    throw malformedPassport();
  }

  const values: Partial<Record<Field, unknown>> = Object.create(
    null,
  ) as Partial<Record<Field, unknown>>;
  const required = new Set<string>(requiredFields);
  for (const key of ownKeys as string[]) {
    const descriptor = Reflect.getOwnPropertyDescriptor(source, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, 'value') ||
      Object.hasOwn(descriptor, 'get') ||
      Object.hasOwn(descriptor, 'set')
    ) {
      throw malformedPassport();
    }
    if (required.has(key)) {
      values[key as Field] = descriptor.value;
    } else {
      context.extensionsPresent = true;
      validateExtensionValue(descriptor.value, context, recordDepth + 1);
    }
  }
  if (requiredFields.some((field) => !Object.hasOwn(values, field))) {
    throw malformedPassport();
  }
  return Object.freeze(values as Record<Field, unknown>);
}

function validateExtensionValue(
  value: unknown,
  context: StatementParseContext,
  depth: number,
): void {
  context.extensionItems += 1;
  if (
    context.extensionItems > statementJsonLimits().maxItems ||
    depth > statementJsonLimits().maxDepth
  ) {
    throw malformedPassport();
  }
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    if (value.length > statementJsonLimits().maxStringCodeUnits) {
      throw malformedPassport();
    }
    return;
  }
  if (typeof value === 'number') {
    if (
      !Number.isFinite(value) ||
      Object.is(value, -0) ||
      (Number.isInteger(value) && !Number.isSafeInteger(value))
    ) {
      throw malformedPassport();
    }
    return;
  }
  if (
    value === undefined ||
    typeof value === 'bigint' ||
    typeof value === 'function' ||
    typeof value === 'symbol' ||
    utilTypes.isProxy(value)
  ) {
    throw malformedPassport();
  }
  if (context.extensionObjects.has(value)) throw malformedPassport();
  context.extensionObjects.add(value);
  try {
    if (Array.isArray(value)) {
      const remaining = statementJsonLimits().maxItems - context.extensionItems;
      const items = snapshotDenseDataArray(value, 0, remaining);
      for (const item of items) {
        validateExtensionValue(item, context, depth + 1);
      }
      return;
    }
    const prototype = Reflect.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw malformedPassport();
    }
    const keys = Reflect.ownKeys(value);
    if (
      keys.length > statementJsonLimits().maxItems - context.extensionItems ||
      keys.some(
        (key) =>
          typeof key !== 'string' ||
          key.length > statementJsonLimits().maxStringCodeUnits,
      )
    ) {
      throw malformedPassport();
    }
    for (const key of keys as string[]) {
      context.extensionItems += 1;
      const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      if (
        context.extensionItems > statementJsonLimits().maxItems ||
        descriptor === undefined ||
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, 'value') ||
        Object.hasOwn(descriptor, 'get') ||
        Object.hasOwn(descriptor, 'set')
      ) {
        throw malformedPassport();
      }
      validateExtensionValue(descriptor.value, context, depth + 1);
    }
  } finally {
    context.extensionObjects.delete(value);
  }
}

function parseCanonicalRfc3339Utc(value: unknown): string {
  if (typeof value !== 'string' || !CANONICAL_RFC3339_UTC_PATTERN.test(value)) {
    throw malformedPassport();
  }
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime()) || instant.toISOString() !== value) {
    throw malformedPassport();
  }
  return value;
}

function toCanonicalRfc3339Utc(epochMs: number): string {
  const instant = new Date(epochMs);
  if (!Number.isFinite(instant.getTime())) throw malformedPassport();
  return parseCanonicalRfc3339Utc(instant.toISOString());
}

function digestExactPayload(source: unknown): Sha256Digest | null {
  if (typeof source === 'string' || source instanceof Uint8Array) {
    return sha256(source);
  }
  return null;
}

function malformedPassport(): SemWitnessError {
  return new SemWitnessError(
    'MALFORMED_ENVELOPE',
    'Malformed intent-cache admission Passport Statement',
  );
}
