import { Buffer } from 'node:buffer';

import { canonicalJson, toJsonValue } from '../domain/canonical-json.js';
import { SemWitnessError } from '../domain/errors.js';
import { sha256 } from '../domain/hash.js';
import { parseStrictJson } from '../domain/strict-json.js';
import type { Sha256Digest } from '../domain/types.js';
import { parseCacheHitWitness } from './admission.js';
import type { CacheHitWitness } from './types.js';

export const MAX_CACHE_HIT_WITNESS_ARTIFACT_BYTES = 1024 * 1024;

export interface CacheHitWitnessArtifactVerification {
  readonly canonical: boolean | null;
  readonly canonicalDigest: Sha256Digest;
  readonly payloadDigest: Sha256Digest | null;
}

/** Parse strict bounded JSON or an object through the existing witness schema. */
export function parseCacheHitWitnessArtifact(source: unknown): CacheHitWitness {
  try {
    return parseCacheHitWitness(parseArtifactSource(source));
  } catch {
    throw malformedArtifact();
  }
}

/** Exact canonical UTF-8 JSON without a BOM or trailing line feed. */
export function serializeCacheHitWitnessArtifact(source: unknown): string {
  return canonicalJson(toJsonValue(parseCacheHitWitnessArtifact(source)));
}

export function digestCacheHitWitnessArtifact(source: unknown): Sha256Digest {
  return sha256(serializeCacheHitWitnessArtifact(source));
}

/**
 * Distinguish the supported canonical artifact from the exact supplied bytes.
 * Object input has no byte identity and therefore reports `canonical: null`.
 */
export function verifyCacheHitWitnessArtifact(
  source: unknown,
): CacheHitWitnessArtifactVerification {
  const canonicalDigest = digestCacheHitWitnessArtifact(source);
  const payloadDigest = digestExactPayload(source);
  return Object.freeze({
    canonical:
      payloadDigest === null ? null : payloadDigest === canonicalDigest,
    canonicalDigest,
    payloadDigest,
  });
}

function parseArtifactSource(source: unknown): unknown {
  if (typeof source === 'string') {
    if (
      Buffer.byteLength(source, 'utf8') > MAX_CACHE_HIT_WITNESS_ARTIFACT_BYTES
    ) {
      throw malformedArtifact();
    }
    return parseStrictJson(source, artifactJsonLimits());
  }
  if (source instanceof Uint8Array) {
    if (source.byteLength > MAX_CACHE_HIT_WITNESS_ARTIFACT_BYTES) {
      throw malformedArtifact();
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(source);
    return parseStrictJson(text, artifactJsonLimits());
  }
  return source;
}

function artifactJsonLimits() {
  return {
    maxDepth: 32,
    maxItems: 16_384,
    maxStringCodeUnits: 64 * 1024,
    maxNumberCodeUnits: 32,
  } as const;
}

function digestExactPayload(source: unknown): Sha256Digest | null {
  if (typeof source === 'string' || source instanceof Uint8Array) {
    return sha256(source);
  }
  return null;
}

function malformedArtifact(): SemWitnessError {
  return new SemWitnessError(
    'MALFORMED_ENVELOPE',
    'Cache-hit witness artifact is malformed',
  );
}
