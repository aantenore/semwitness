import { createHmac } from 'node:crypto';

import {
  canonicalJson,
  immutableJson,
  toJsonValue,
  type JsonValue,
} from '../domain/canonical-json.js';
import { compareCodeUnits } from '../domain/deterministic-order.js';
import { hashCanonical, isSha256Digest, sha256 } from '../domain/hash.js';
import type { Sha256Digest } from '../domain/types.js';
import { parseIntentIRDocument } from './schemas.js';
import { parseCacheBindingDocument } from './schemas.js';
import {
  type CacheBinding,
  type CacheEntryCommitment,
  type CacheKeyDigest,
  type CacheValueCommitment,
  type CandidateEvidence,
  type HmacScopeDigest,
  type IntentConstraint,
  type IntentIR,
  type IntentSlot,
  type RevisionBinding,
  type ScopeDomain,
  type HmacIntentSourceDigest,
} from './types.js';
import { assertWellFormedUnicode } from './unicode.js';

const SCOPE_HMAC_PREFIX = 'semwitness.dev/intent-scope-hmac/v1\0';
const CACHE_KEY_HMAC_PREFIX = 'semwitness.dev/intent-cache-key/v1\0';
const CACHE_ARTIFACT_HMAC_PREFIX =
  'semwitness.dev/intent-cache-artifact-commitment/v1\0';
const SOURCE_HMAC_PREFIX = 'semwitness.dev/intent-source-hmac/v1\0';

export function parseIntentIR(input: unknown): IntentIR {
  return canonicalizeIntentIR(parseIntentIRDocument(input));
}

export function canonicalizeIntentIR(input: IntentIR): IntentIR {
  const validated = parseIntentIRDocument(input);
  const slots = [...validated.slots].sort(compareSlots);
  const constraints = deduplicateConstraints(
    [...validated.constraints].sort(compareConstraints),
  );
  return immutableJson(
    toJsonValue({ ...validated, slots, constraints }),
  ) as unknown as IntentIR;
}

export function canonicalIntentJson(input: unknown): string {
  return canonicalJson(toJsonValue(parseIntentIR(input)));
}

export function digestIntent(input: unknown): Sha256Digest {
  return hashCanonical(toJsonValue(parseIntentIR(input)));
}

export function digestIntentSource(source: Uint8Array | string): Sha256Digest {
  if (typeof source === 'string') {
    assertWellFormedUnicode(source, 'Intent source');
  }
  return sha256(source);
}

/** Prefer this keyed source fingerprint when witnesses leave a trusted host. */
export function hmacIntentSourceDigest(
  secret: Uint8Array | string,
  source: Uint8Array | string,
): HmacIntentSourceDigest {
  const secretBytes = validateHmacSecret(secret);
  if (typeof source === 'string') {
    assertWellFormedUnicode(source, 'Intent source');
  }
  const digest = createHmac('sha256', secretBytes)
    .update(SOURCE_HMAC_PREFIX, 'utf8')
    .update(source)
    .digest('hex');
  return `hmac-sha256:intent-source:${digest}`;
}

/**
 * Produces a pseudonymous scope digest. Domain is part of both the type and
 * HMAC message, so a tenant digest cannot be reused as an authorization digest.
 */
export function hmacScopeDigest<Domain extends ScopeDomain>(
  domain: Domain,
  secret: Uint8Array | string,
  scopeValue: Uint8Array | string,
): HmacScopeDigest<Domain> {
  const secretBytes = validateHmacSecret(secret);
  if (typeof scopeValue === 'string') {
    assertWellFormedUnicode(scopeValue, 'Scope value');
  }
  const digest = createHmac('sha256', secretBytes)
    .update(SCOPE_HMAC_PREFIX, 'utf8')
    .update(domain, 'utf8')
    .update('\0', 'utf8')
    .update(scopeValue)
    .digest('hex');
  return `hmac-sha256:${domain}:${digest}`;
}

/**
 * Builds a pseudonymous key from every answer-affecting cache binding. The
 * keyed digest prevents low-entropy tenant or intent values from becoming a
 * public dictionary oracle. It does not replace authorization at lookup time.
 */
export function hmacCacheKey(
  secret: Uint8Array | string,
  binding: CacheBinding,
): CacheKeyDigest {
  const secretBytes = validateHmacSecret(secret);
  const canonicalBinding = canonicalJson(
    toJsonValue(parseCacheBindingDocument(binding)),
  );
  const digest = createHmac('sha256', secretBytes)
    .update(CACHE_KEY_HMAC_PREFIX, 'utf8')
    .update(canonicalBinding, 'utf8')
    .digest('hex');
  return `hmac-sha256:cache-key:${digest}`;
}

/**
 * Produces keyed entry and value commitments bound to the complete cache
 * binding. They resist public dictionary attacks but remain linkable wherever
 * the same secret and binding are reused. Domain separation keeps the two
 * commitments non-interchangeable.
 */
export function hmacCacheArtifactCommitments(
  secret: Uint8Array | string,
  binding: CacheBinding,
  entryDigest: Sha256Digest,
  valueDigest: Sha256Digest,
): Readonly<{
  entry: CacheEntryCommitment;
  value: CacheValueCommitment;
}> {
  const secretBytes = validateHmacSecret(secret);
  if (!isSha256Digest(entryDigest) || !isSha256Digest(valueDigest)) {
    throw new TypeError('Cache artifact digests must be SHA-256 digests');
  }
  const canonicalBinding = canonicalJson(
    toJsonValue(parseCacheBindingDocument(binding)),
  );
  const commit = (domain: 'entry' | 'value', digest: Sha256Digest): string =>
    createHmac('sha256', secretBytes)
      .update(CACHE_ARTIFACT_HMAC_PREFIX, 'utf8')
      .update(domain, 'utf8')
      .update('\0', 'utf8')
      .update(canonicalBinding, 'utf8')
      .update('\0', 'utf8')
      .update(digest, 'utf8')
      .digest('hex');
  return Object.freeze({
    entry: `hmac-sha256:cache-entry:${commit('entry', entryDigest)}`,
    value: `hmac-sha256:cache-value:${commit('value', valueDigest)}`,
  });
}

export function canonicalizeRevisions(
  revisions: readonly RevisionBinding[],
): readonly RevisionBinding[] {
  return [...revisions].sort((left, right) =>
    compareCodeUnits(left.namespace, right.namespace),
  );
}

export function canonicalizeCandidateEvidence(
  evidence: readonly CandidateEvidence[],
): readonly CandidateEvidence[] {
  return [...evidence].sort((left, right) =>
    compareCodeUnits(candidateKey(left), candidateKey(right)),
  );
}

function compareSlots(left: IntentSlot, right: IntentSlot): number {
  return compareCodeUnits(slotKey(left), slotKey(right));
}

function compareConstraints(
  left: IntentConstraint,
  right: IntentConstraint,
): number {
  return compareCodeUnits(constraintKey(left), constraintKey(right));
}

function slotKey(slot: IntentSlot): string {
  return `${slot.name}\0${canonicalValue(slot.value)}`;
}

function constraintKey(constraint: IntentConstraint): string {
  return `${constraint.path}\0${constraint.operator}\0${canonicalValue(constraint.value)}`;
}

function candidateKey(evidence: CandidateEvidence): string {
  return `${evidence.kind}\0${evidence.providerId}\0${evidence.evidenceDigest}\0${String(evidence.scorePpm).padStart(7, '0')}`;
}

function canonicalValue(value: JsonValue): string {
  return canonicalJson(value);
}

function deduplicateConstraints(
  constraints: readonly IntentConstraint[],
): readonly IntentConstraint[] {
  const result: IntentConstraint[] = [];
  let previous: string | undefined;
  for (const constraint of constraints) {
    const key = constraintKey(constraint);
    if (key !== previous) {
      result.push(constraint);
      previous = key;
    }
  }
  return result;
}

function validateHmacSecret(secret: Uint8Array | string): Uint8Array {
  if (typeof secret === 'string') {
    assertWellFormedUnicode(secret, 'HMAC secret');
  }
  const secretBytes =
    typeof secret === 'string' ? Buffer.from(secret, 'utf8') : secret;
  if (secretBytes.byteLength < 32) {
    throw new TypeError('HMAC secret must contain at least 32 bytes');
  }
  return secretBytes;
}
