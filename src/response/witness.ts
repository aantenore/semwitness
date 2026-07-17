import {
  canonicalJson,
  toJsonValue,
  type JsonValue,
} from '../domain/canonical-json.js';
import { hashCanonical, isSha256Digest } from '../domain/hash.js';
import { parseStrictJson } from '../domain/strict-json.js';
import {
  isSafeIdentifier,
  isSafeMediaType,
  type Sha256Digest,
} from '../domain/types.js';
import {
  isSafeTokenizerFingerprint,
  type TokenCount,
} from '../ports/tokenizer.js';
import { CompactResponseError } from './errors.js';

export const COMPACT_RESPONSE_WITNESS_SCHEMA =
  'semwitness.dev/compact-response-witness/v1alpha1' as const;

const SAFE_LOCALE_PATTERN = /^[a-z]{2,3}(?:-[A-Z]{2})?$/u;
const SAFE_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u;
const MAX_WITNESS_BYTES = 64 * 1024;
const MAX_TOKEN_COUNT = 1_000_000_000_000;

export interface CompactResponseTokenProjection {
  readonly tokenizer: {
    readonly id: string;
    readonly fingerprint: string;
    readonly reliability: 'exact' | 'heuristic';
  };
  readonly candidateTokens: number;
  readonly renderedTokens: number;
  readonly projectedAvoidedModelTokens: number;
  readonly projectedSavingsRatioPpm: number;
  readonly benefitProjected: boolean;
}

export interface CompactResponseWitness {
  readonly schema: typeof COMPACT_RESPONSE_WITNESS_SCHEMA;
  readonly contractDigest: Sha256Digest;
  readonly candidate: {
    readonly exactDigest: Sha256Digest;
    readonly canonicalDigest: Sha256Digest;
    readonly byteLength: number;
  };
  readonly renderer: {
    readonly id: string;
    readonly version: string;
    readonly artifactDigest: Sha256Digest;
    readonly outputMediaType: string;
    readonly locale: string;
  };
  readonly rendered: {
    readonly digest: Sha256Digest;
    readonly byteLength: number;
  };
  readonly localTokenProjection: CompactResponseTokenProjection | null;
  readonly billedOutputSavings: null;
  readonly universalSemanticEquivalence: false;
  readonly decision: 'rendered';
  readonly witnessDigest: Sha256Digest;
}

export interface CreateCompactResponseWitnessInput {
  readonly contractDigest: Sha256Digest;
  readonly candidate: CompactResponseWitness['candidate'];
  readonly renderer: CompactResponseWitness['renderer'];
  readonly rendered: CompactResponseWitness['rendered'];
  readonly tokenCounts?: {
    readonly tokenizerId: string;
    readonly tokenizerFingerprint: string;
    readonly candidate: TokenCount;
    readonly rendered: TokenCount;
  };
}

export function createCompactResponseWitness(
  input: CreateCompactResponseWitnessInput,
): CompactResponseWitness {
  const unsigned = Object.freeze({
    schema: COMPACT_RESPONSE_WITNESS_SCHEMA,
    contractDigest: input.contractDigest,
    candidate: Object.freeze({ ...input.candidate }),
    renderer: Object.freeze({ ...input.renderer }),
    rendered: Object.freeze({ ...input.rendered }),
    localTokenProjection:
      input.tokenCounts === undefined
        ? null
        : createTokenProjection(input.tokenCounts),
    billedOutputSavings: null,
    universalSemanticEquivalence: false as const,
    decision: 'rendered' as const,
  });
  const witness = Object.freeze({
    ...unsigned,
    witnessDigest: hashCanonical(toJsonValue(unsigned)),
  });
  return parseWitnessValue(toJsonValue(witness));
}

export function serializeCompactResponseWitness(
  witness: CompactResponseWitness,
): string {
  return canonicalJson(toJsonValue(witness));
}

export function parseCompactResponseWitness(
  source: string | Uint8Array,
): CompactResponseWitness {
  const text = decodeExactUtf8(source, MAX_WITNESS_BYTES);
  let value: JsonValue;
  try {
    value = parseStrictJson(text, {
      maxDepth: 8,
      maxItems: 128,
      maxStringCodeUnits: 512,
      maxNumberCodeUnits: 32,
    });
  } catch (error) {
    throw malformedWitness(error);
  }
  const witness = parseWitnessValue(value);
  if (text !== serializeCompactResponseWitness(witness)) {
    throw malformedWitness();
  }
  return witness;
}

function parseWitnessValue(value: JsonValue): CompactResponseWitness {
  const root = exactObject(value, [
    'schema',
    'contractDigest',
    'candidate',
    'renderer',
    'rendered',
    'localTokenProjection',
    'billedOutputSavings',
    'universalSemanticEquivalence',
    'decision',
    'witnessDigest',
  ]);
  const candidate = exactObject(root?.candidate, [
    'exactDigest',
    'canonicalDigest',
    'byteLength',
  ]);
  const renderer = exactObject(root?.renderer, [
    'id',
    'version',
    'artifactDigest',
    'outputMediaType',
    'locale',
  ]);
  const rendered = exactObject(root?.rendered, ['digest', 'byteLength']);
  const projection = parseTokenProjection(root?.localTokenProjection);
  if (
    root === undefined ||
    candidate === undefined ||
    renderer === undefined ||
    rendered === undefined ||
    root.schema !== COMPACT_RESPONSE_WITNESS_SCHEMA ||
    !isSha256Digest(root.contractDigest) ||
    !isSha256Digest(candidate.exactDigest) ||
    !isSha256Digest(candidate.canonicalDigest) ||
    !isBoundedCount(candidate.byteLength) ||
    !isSafeIdentifier(renderer.id) ||
    !isSafeVersion(renderer.version) ||
    !isSha256Digest(renderer.artifactDigest) ||
    !isSafeMediaType(renderer.outputMediaType) ||
    !isLocale(renderer.locale) ||
    !isSha256Digest(rendered.digest) ||
    !isBoundedCount(rendered.byteLength) ||
    projection === undefined ||
    root.billedOutputSavings !== null ||
    root.universalSemanticEquivalence !== false ||
    root.decision !== 'rendered' ||
    !isSha256Digest(root.witnessDigest)
  ) {
    throw malformedWitness();
  }
  const unsigned = {
    schema: root.schema,
    contractDigest: root.contractDigest,
    candidate: {
      exactDigest: candidate.exactDigest,
      canonicalDigest: candidate.canonicalDigest,
      byteLength: candidate.byteLength,
    },
    renderer: {
      id: renderer.id,
      version: renderer.version,
      artifactDigest: renderer.artifactDigest,
      outputMediaType: renderer.outputMediaType,
      locale: renderer.locale,
    },
    rendered: {
      digest: rendered.digest,
      byteLength: rendered.byteLength,
    },
    localTokenProjection: projection,
    billedOutputSavings: null,
    universalSemanticEquivalence: false as const,
    decision: 'rendered' as const,
  };
  if (hashCanonical(toJsonValue(unsigned)) !== root.witnessDigest) {
    throw malformedWitness();
  }
  return Object.freeze({
    ...unsigned,
    candidate: Object.freeze(unsigned.candidate),
    renderer: Object.freeze(unsigned.renderer),
    rendered: Object.freeze(unsigned.rendered),
    localTokenProjection:
      projection === null ? null : Object.freeze(projection),
    witnessDigest: root.witnessDigest,
  });
}

function createTokenProjection(input: {
  readonly tokenizerId: string;
  readonly tokenizerFingerprint: string;
  readonly candidate: TokenCount;
  readonly rendered: TokenCount;
}): CompactResponseTokenProjection {
  if (
    !isSafeIdentifier(input.tokenizerId) ||
    !isSafeTokenizerFingerprint(input.tokenizerFingerprint) ||
    !isTokenCount(input.candidate) ||
    !isTokenCount(input.rendered)
  ) {
    throw new CompactResponseError(
      'TOKENIZER_ERROR',
      'Tokenizer evidence is invalid',
    );
  }
  const avoided = Math.max(0, input.rendered.tokens - input.candidate.tokens);
  return Object.freeze({
    tokenizer: Object.freeze({
      id: input.tokenizerId,
      fingerprint: input.tokenizerFingerprint,
      reliability:
        input.candidate.reliability === 'exact' &&
        input.rendered.reliability === 'exact'
          ? 'exact'
          : 'heuristic',
    }),
    candidateTokens: input.candidate.tokens,
    renderedTokens: input.rendered.tokens,
    projectedAvoidedModelTokens: avoided,
    projectedSavingsRatioPpm:
      input.rendered.tokens === 0
        ? 0
        : Math.floor((avoided * 1_000_000) / input.rendered.tokens),
    benefitProjected: avoided > 0,
  });
}

function parseTokenProjection(
  value: JsonValue | undefined,
): CompactResponseTokenProjection | null | undefined {
  if (value === null) return null;
  const projection = exactObject(value, [
    'tokenizer',
    'candidateTokens',
    'renderedTokens',
    'projectedAvoidedModelTokens',
    'projectedSavingsRatioPpm',
    'benefitProjected',
  ]);
  const tokenizer = exactObject(projection?.tokenizer, [
    'id',
    'fingerprint',
    'reliability',
  ]);
  if (
    projection === undefined ||
    tokenizer === undefined ||
    !isSafeIdentifier(tokenizer.id) ||
    !isSafeTokenizerFingerprint(tokenizer.fingerprint) ||
    (tokenizer.reliability !== 'exact' &&
      tokenizer.reliability !== 'heuristic') ||
    !isTokenInteger(projection.candidateTokens) ||
    !isTokenInteger(projection.renderedTokens) ||
    !isTokenInteger(projection.projectedAvoidedModelTokens) ||
    !isPpm(projection.projectedSavingsRatioPpm) ||
    typeof projection.benefitProjected !== 'boolean'
  ) {
    return undefined;
  }
  const avoided = Math.max(
    0,
    projection.renderedTokens - projection.candidateTokens,
  );
  const ppm =
    projection.renderedTokens === 0
      ? 0
      : Math.floor((avoided * 1_000_000) / projection.renderedTokens);
  if (
    projection.projectedAvoidedModelTokens !== avoided ||
    projection.projectedSavingsRatioPpm !== ppm ||
    projection.benefitProjected !== avoided > 0
  ) {
    return undefined;
  }
  return Object.freeze({
    tokenizer: Object.freeze({
      id: tokenizer.id,
      fingerprint: tokenizer.fingerprint,
      reliability: tokenizer.reliability,
    }),
    candidateTokens: projection.candidateTokens,
    renderedTokens: projection.renderedTokens,
    projectedAvoidedModelTokens: avoided,
    projectedSavingsRatioPpm: ppm,
    benefitProjected: avoided > 0,
  });
}

function exactObject(
  value: JsonValue | undefined,
  keys: readonly string[],
): Readonly<Record<string, JsonValue>> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    return undefined;
  }
  return value as Readonly<Record<string, JsonValue>>;
}

function isTokenCount(value: unknown): value is TokenCount {
  return (
    value !== null &&
    typeof value === 'object' &&
    'tokens' in value &&
    isTokenInteger(value.tokens) &&
    'reliability' in value &&
    (value.reliability === 'exact' || value.reliability === 'heuristic')
  );
}

function isTokenInteger(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= MAX_TOKEN_COUNT
  );
}

function isPpm(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= 1_000_000
  );
}

function isBoundedCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isLocale(value: unknown): value is string {
  return typeof value === 'string' && SAFE_LOCALE_PATTERN.test(value);
}

function isSafeVersion(value: unknown): value is string {
  return typeof value === 'string' && SAFE_VERSION_PATTERN.test(value);
}

function decodeExactUtf8(source: string | Uint8Array, limit: number): string {
  if (typeof source === 'string') {
    const bytes = new TextEncoder().encode(source);
    if (bytes.byteLength > limit || !isWellFormedUnicode(source)) {
      throw malformedWitness();
    }
    return source;
  }
  const snapshot = new Uint8Array(source);
  if (snapshot.byteLength > limit) throw malformedWitness();
  try {
    return new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: true,
    }).decode(snapshot);
  } catch (error) {
    throw malformedWitness(error);
  }
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function malformedWitness(cause?: unknown): CompactResponseError {
  return new CompactResponseError(
    'WITNESS_MALFORMED',
    'Compact response witness is malformed',
    cause,
  );
}
