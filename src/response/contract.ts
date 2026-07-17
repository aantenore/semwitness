import {
  canonicalJson,
  immutableJson,
  toJsonValue,
  type JsonValue,
} from '../domain/canonical-json.js';
import { hashCanonical, isSha256Digest } from '../domain/hash.js';
import { parseStrictJson } from '../domain/strict-json.js';
import {
  SAFE_VERSION_PATTERN,
  isSafeIdentifier,
  isSafeMediaType,
  type Sha256Digest,
} from '../domain/types.js';
import { CompactResponseError } from './errors.js';
import {
  COMPACT_RESPONSE_LIMIT_CAPS,
  matchesBoundedJsonSchema,
  parseBoundedJsonSchema,
} from './schema.js';
import {
  BOUNDED_JSON_SCHEMA_DIALECT,
  COMPACT_RESPONSE_CONTRACT_SCHEMA,
  type CompactResponseContract,
  type CompactResponseLimits,
  type ParsedCompactResponseCandidate,
} from './types.js';

export const MAX_COMPACT_RESPONSE_CONTRACT_BYTES = 4 * 1024 * 1024;
export const SAFE_COMPACT_RESPONSE_LOCALE_PATTERN =
  /^[a-z]{2,3}(?:-[A-Z]{2})?$/u;

const parsedContracts = new WeakSet<object>();

export function parseCompactResponseContract(
  source: string | Uint8Array,
): CompactResponseContract {
  try {
    const bytes = copyExactUtf8(source, MAX_COMPACT_RESPONSE_CONTRACT_BYTES);
    const text = decodeUtf8(bytes);
    const value = parseStrictJson(text, {
      maxDepth: 96,
      maxItems: 200_000,
      maxStringCodeUnits: COMPACT_RESPONSE_LIMIT_CAPS.maxStringCodeUnits,
      maxNumberCodeUnits: 128,
    });
    const root = exactRecord(value, [
      'schema',
      'id',
      'version',
      'candidate',
      'renderer',
      'limits',
    ]);
    const candidate = exactRecord(root.candidate!, [
      'mediaType',
      'schemaDialect',
      'schema',
    ]);
    const renderer = exactRecord(root.renderer!, [
      'id',
      'version',
      'artifactDigest',
      'outputMediaType',
      'locale',
    ]);
    const limits = parseLimits(root.limits!);
    if (
      root.schema !== COMPACT_RESPONSE_CONTRACT_SCHEMA ||
      !isSafeIdentifier(root.id) ||
      typeof root.version !== 'string' ||
      !SAFE_VERSION_PATTERN.test(root.version) ||
      candidate.mediaType !== 'application/json' ||
      candidate.schemaDialect !== BOUNDED_JSON_SCHEMA_DIALECT ||
      !isSafeIdentifier(renderer.id) ||
      typeof renderer.version !== 'string' ||
      !SAFE_VERSION_PATTERN.test(renderer.version) ||
      !isSha256Digest(renderer.artifactDigest) ||
      !isSafeMediaType(renderer.outputMediaType) ||
      typeof renderer.locale !== 'string' ||
      !SAFE_COMPACT_RESPONSE_LOCALE_PATTERN.test(renderer.locale)
    ) {
      throw invalidContract();
    }
    const schema = parseBoundedJsonSchema(candidate.schema!, limits);
    const parsed = immutableJson(
      toJsonValue({
        schema: COMPACT_RESPONSE_CONTRACT_SCHEMA,
        id: root.id,
        version: root.version,
        candidate: {
          mediaType: 'application/json',
          schemaDialect: BOUNDED_JSON_SCHEMA_DIALECT,
          schema,
        },
        renderer: {
          id: renderer.id,
          version: renderer.version,
          artifactDigest: renderer.artifactDigest,
          outputMediaType: renderer.outputMediaType,
          locale: renderer.locale,
        },
        limits,
      }),
    ) as unknown as CompactResponseContract;
    parsedContracts.add(parsed);
    return parsed;
  } catch (error) {
    if (
      error instanceof CompactResponseError &&
      error.code === 'CONTRACT_MALFORMED'
    ) {
      throw error;
    }
    throw invalidContract();
  }
}

export function digestCompactResponseContract(
  source: CompactResponseContract | string | Uint8Array,
): Sha256Digest {
  const contract =
    typeof source === 'string' || source instanceof Uint8Array
      ? parseCompactResponseContract(source)
      : requireParsedContract(source);
  return hashCanonical(toJsonValue(contract));
}

export function parseCompactResponseCandidate(
  source: string | Uint8Array,
  contractSource: CompactResponseContract,
): ParsedCompactResponseCandidate {
  const contract = requireParsedContract(contractSource);
  let bytes: Uint8Array;
  try {
    bytes = copyExactUtf8(source, contract.limits.maxCandidateBytes);
  } catch {
    const length =
      typeof source === 'string'
        ? undefined
        : source instanceof Uint8Array
          ? source.byteLength
          : undefined;
    if (length !== undefined && length > contract.limits.maxCandidateBytes) {
      throw candidateLimitExceeded();
    }
    if (typeof source === 'string') {
      try {
        assertWellFormedUnicode(source, 'Compact response candidate');
        if (
          new TextEncoder().encode(source).byteLength >
          contract.limits.maxCandidateBytes
        ) {
          throw candidateLimitExceeded();
        }
      } catch (error) {
        if (
          error instanceof CompactResponseError &&
          error.code === 'CANDIDATE_LIMIT_EXCEEDED'
        ) {
          throw error;
        }
      }
    }
    throw candidateMalformed();
  }

  let value: JsonValue;
  try {
    const text = decodeUtf8(bytes);
    value = parseStrictJson(text, {
      maxDepth: contract.limits.maxDepth,
      maxItems: contract.limits.maxItems,
      maxStringCodeUnits: contract.limits.maxStringCodeUnits,
      maxNumberCodeUnits: 128,
    });
    assertWellFormedJson(value);
  } catch (error) {
    if (isStrictJsonLimitFailure(error)) throw candidateLimitExceeded();
    throw candidateMalformed();
  }

  if (!matchesBoundedJsonSchema(value, contract.candidate.schema)) {
    throw new CompactResponseError(
      'CANDIDATE_SCHEMA_MISMATCH',
      'Compact response candidate does not match its bounded schema',
    );
  }
  const immutableValue = immutableJson(value);
  const canonicalBytes = new TextEncoder().encode(
    canonicalJson(immutableValue),
  );
  return Object.freeze({
    value: immutableValue,
    bytes,
    canonicalBytes,
  });
}

function parseLimits(source: JsonValue): CompactResponseLimits {
  const record = exactRecord(source, [
    'maxCandidateBytes',
    'maxRenderedBytes',
    'maxDepth',
    'maxItems',
    'maxStringCodeUnits',
    'maxRenderMs',
  ]);
  return Object.freeze({
    maxCandidateBytes: positiveSafeInteger(
      record.maxCandidateBytes,
      COMPACT_RESPONSE_LIMIT_CAPS.maxCandidateBytes,
    ),
    maxRenderedBytes: positiveSafeInteger(
      record.maxRenderedBytes,
      COMPACT_RESPONSE_LIMIT_CAPS.maxRenderedBytes,
    ),
    maxDepth: positiveSafeInteger(
      record.maxDepth,
      COMPACT_RESPONSE_LIMIT_CAPS.maxDepth,
    ),
    maxItems: positiveSafeInteger(
      record.maxItems,
      COMPACT_RESPONSE_LIMIT_CAPS.maxItems,
    ),
    maxStringCodeUnits: positiveSafeInteger(
      record.maxStringCodeUnits,
      COMPACT_RESPONSE_LIMIT_CAPS.maxStringCodeUnits,
    ),
    maxRenderMs: positiveSafeInteger(
      record.maxRenderMs,
      COMPACT_RESPONSE_LIMIT_CAPS.maxRenderMs,
    ),
  });
}

function positiveSafeInteger(value: JsonValue | undefined, maximum: number) {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > maximum
  ) {
    throw invalidContract();
  }
  return value;
}

function exactRecord(
  source: JsonValue,
  expectedFields: readonly string[],
): Readonly<Record<string, JsonValue>> {
  if (source === null || typeof source !== 'object' || Array.isArray(source)) {
    throw invalidContract();
  }
  const keys = Object.keys(source);
  const expected = new Set(expectedFields);
  if (
    keys.length !== expectedFields.length ||
    keys.some((key) => !expected.has(key))
  ) {
    throw invalidContract();
  }
  return source as Readonly<Record<string, JsonValue>>;
}

function copyExactUtf8(
  source: string | Uint8Array,
  maximumBytes: number,
): Uint8Array {
  let bytes: Uint8Array;
  if (typeof source === 'string') {
    assertWellFormedUnicode(source, 'Compact response JSON');
    bytes = new TextEncoder().encode(source);
  } else if (source instanceof Uint8Array) {
    bytes = new Uint8Array(source);
  } else {
    throw new TypeError('Compact response JSON must be text or bytes');
  }
  if (bytes.byteLength > maximumBytes) {
    throw new RangeError('Compact response JSON exceeds its byte limit');
  }
  return bytes;
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
    bytes,
  );
}

function assertWellFormedJson(value: JsonValue): void {
  if (typeof value === 'string') {
    assertWellFormedUnicode(value, 'Compact response JSON string');
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) assertWellFormedJson(item);
    return;
  }
  const record = value as Readonly<Record<string, JsonValue>>;
  for (const key of Object.keys(value)) {
    assertWellFormedUnicode(key, 'Compact response JSON key');
    assertWellFormedJson(record[key]!);
  }
}

function assertWellFormedUnicode(value: string, label: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError(`${label} must be well-formed Unicode`);
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new TypeError(`${label} must be well-formed Unicode`);
    }
  }
}

function requireParsedContract(
  contract: CompactResponseContract,
): CompactResponseContract {
  if (
    contract === null ||
    typeof contract !== 'object' ||
    !parsedContracts.has(contract)
  ) {
    throw invalidContract();
  }
  return contract;
}

function isStrictJsonLimitFailure(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    if (
      /(?:item|string source|string|number literal|nesting) limit exceeded/u.test(
        current.message,
      )
    ) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

function invalidContract(): CompactResponseError {
  return new CompactResponseError(
    'CONTRACT_MALFORMED',
    'Compact response contract is malformed',
  );
}

function candidateMalformed(): CompactResponseError {
  return new CompactResponseError(
    'CANDIDATE_MALFORMED',
    'Compact response candidate is not strict UTF-8 JSON',
  );
}

function candidateLimitExceeded(): CompactResponseError {
  return new CompactResponseError(
    'CANDIDATE_LIMIT_EXCEEDED',
    'Compact response candidate exceeds its configured limits',
  );
}
