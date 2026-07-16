import { toJsonValue } from '../domain/canonical-json.js';
import { SemWitnessError } from '../domain/errors.js';
import { hashCanonical, isSha256Digest } from '../domain/hash.js';
import {
  SAFE_IDENTIFIER_PATTERN,
  SAFE_VERSION_PATTERN,
  type Sha256Digest,
} from '../domain/types.js';
import { snapshotDataRecord } from '../host/data-only.js';
import { INTENT_EFFECTS } from '../intent/types.js';
import type {
  CacheKeyDigest,
  HmacIntentSourceDigest,
  IntentEffect,
  NormalizerBinding,
  OntologyBinding,
} from '../intent/types.js';
import {
  INTENT_CACHE_DEPENDENCY_STATUSES,
  INTENT_CACHE_LOOKUP_RECEIPT_SCHEMA,
  INTENT_CACHE_OPERATION_BINDING_SCHEMA,
  INTENT_NORMALIZATION_BYPASS_REASONS,
  INTENT_NORMALIZATION_BYPASS_RECEIPT_SCHEMA,
  type IntentCacheAccountingBinding,
  type IntentCacheBoundArtifact,
  type IntentCacheDependencyBinding,
  type IntentCacheDomainHmac,
  type IntentCacheLookupDisposition,
  type IntentCacheLookupReceipt,
  type IntentCacheOperationBinding,
  type IntentCacheOperationHmac,
  type IntentNormalizationBypassReceipt,
  type IntentNormalizationBypassReason,
} from './types.js';

const OPERATION_BINDING_FIELDS = [
  'schema',
  'operation',
  'domain',
  'intentDigest',
  'tier',
  'effect',
  'operationRegistryDigest',
  'ontologyDigest',
  'bindingDigest',
] as const;
const LOOKUP_RECEIPT_FIELDS = [
  'schema',
  'mode',
  'applied',
  'sourceDigest',
  'normalizer',
  'ontology',
  'normalizationPolicyDigest',
  'cacheAdmissionPolicyDigest',
  'cacheKeyDigest',
  'observedOperationBinding',
  'candidateIndex',
  'store',
  'outcome',
  'reason',
  'storeAccess',
  'accounting',
  'receiptDigest',
] as const;
const NORMALIZATION_BYPASS_RECEIPT_FIELDS = [
  'schema',
  'mode',
  'applied',
  'sourceDigest',
  'normalizer',
  'ontology',
  'normalizationPolicyDigest',
  'cacheAdmissionPolicyDigest',
  'reason',
  'accounting',
  'receiptDigest',
] as const;
const NORMALIZER_FIELDS = [
  'id',
  'version',
  'artifactDigest',
  'configDigest',
] as const;
const ONTOLOGY_FIELDS = ['id', 'version', 'digest'] as const;
const DEPENDENCY_BINDING_FIELDS = ['status', 'artifact'] as const;
const BOUND_ARTIFACT_FIELDS = ['id', 'version', 'digest'] as const;
const COMPLETE_ACCOUNTING_FIELDS = ['completeness'] as const;
const INCOMPLETE_ACCOUNTING_FIELDS = ['completeness', 'failureDigest'] as const;

const HEX_64 = '[a-f0-9]{64}';
const OPERATION_HMAC = new RegExp(`^hmac-sha256:operation:${HEX_64}$`, 'u');
const DOMAIN_HMAC = new RegExp(`^hmac-sha256:intent-domain:${HEX_64}$`, 'u');
const SOURCE_HMAC = new RegExp(`^hmac-sha256:intent-source:${HEX_64}$`, 'u');
const CACHE_KEY_HMAC = new RegExp(`^hmac-sha256:cache-key:${HEX_64}$`, 'u');

export function parseIntentCacheOperationBinding(
  value: unknown,
): IntentCacheOperationBinding {
  try {
    const parsed = parseOperationBindingDocument(value);
    if (digestOperationBinding(parsed) !== parsed.bindingDigest) {
      throw malformedReceipt();
    }
    return parsed;
  } catch {
    throw malformedReceipt();
  }
}

export function recomputeIntentCacheOperationBindingDigest(
  value: unknown,
): Sha256Digest {
  try {
    return digestOperationBinding(parseOperationBindingDocument(value));
  } catch {
    throw malformedReceipt();
  }
}

export function parseIntentCacheLookupReceipt(
  value: unknown,
): IntentCacheLookupReceipt {
  try {
    const parsed = parseLookupReceiptDocument(value);
    if (digestLookupReceipt(parsed) !== parsed.receiptDigest) {
      throw malformedReceipt();
    }
    return parsed;
  } catch {
    throw malformedReceipt();
  }
}

export function recomputeIntentCacheLookupReceiptDigest(
  value: unknown,
): Sha256Digest {
  try {
    return digestLookupReceipt(parseLookupReceiptDocument(value));
  } catch {
    throw malformedReceipt();
  }
}

export function parseIntentNormalizationBypassReceipt(
  value: unknown,
): IntentNormalizationBypassReceipt {
  try {
    const parsed = parseNormalizationBypassReceiptDocument(value);
    if (digestNormalizationBypassReceipt(parsed) !== parsed.receiptDigest) {
      throw malformedReceipt();
    }
    return parsed;
  } catch {
    throw malformedReceipt();
  }
}

export function recomputeIntentNormalizationBypassReceiptDigest(
  value: unknown,
): Sha256Digest {
  try {
    return digestNormalizationBypassReceipt(
      parseNormalizationBypassReceiptDocument(value),
    );
  } catch {
    throw malformedReceipt();
  }
}

function parseOperationBindingDocument(
  value: unknown,
): IntentCacheOperationBinding {
  const root = snapshotDataRecord(value, OPERATION_BINDING_FIELDS);
  if (
    root.schema !== INTENT_CACHE_OPERATION_BINDING_SCHEMA ||
    typeof root.operation !== 'string' ||
    !OPERATION_HMAC.test(root.operation) ||
    typeof root.domain !== 'string' ||
    !DOMAIN_HMAC.test(root.domain) ||
    !isSha256Digest(root.intentDigest) ||
    root.tier !== 'plan' ||
    typeof root.effect !== 'string' ||
    !(INTENT_EFFECTS as readonly string[]).includes(root.effect) ||
    !isSha256Digest(root.operationRegistryDigest) ||
    !isSha256Digest(root.ontologyDigest) ||
    !isSha256Digest(root.bindingDigest)
  ) {
    throw malformedReceipt();
  }
  return Object.freeze({
    schema: INTENT_CACHE_OPERATION_BINDING_SCHEMA,
    operation: root.operation as IntentCacheOperationHmac,
    domain: root.domain as IntentCacheDomainHmac,
    intentDigest: root.intentDigest,
    tier: 'plan' as const,
    effect: root.effect as IntentEffect,
    operationRegistryDigest: root.operationRegistryDigest,
    ontologyDigest: root.ontologyDigest,
    bindingDigest: root.bindingDigest,
  });
}

function parseLookupReceiptDocument(value: unknown): IntentCacheLookupReceipt {
  const root = snapshotDataRecord(value, LOOKUP_RECEIPT_FIELDS);
  if (
    root.schema !== INTENT_CACHE_LOOKUP_RECEIPT_SCHEMA ||
    root.mode !== 'shadow' ||
    root.applied !== false ||
    typeof root.sourceDigest !== 'string' ||
    !SOURCE_HMAC.test(root.sourceDigest) ||
    !isSha256Digest(root.normalizationPolicyDigest) ||
    !isSha256Digest(root.cacheAdmissionPolicyDigest) ||
    typeof root.cacheKeyDigest !== 'string' ||
    !CACHE_KEY_HMAC.test(root.cacheKeyDigest) ||
    !isSha256Digest(root.receiptDigest)
  ) {
    throw malformedReceipt();
  }
  const normalizer = parseNormalizer(root.normalizer);
  const ontology = parseOntology(root.ontology);
  const observedOperationBinding = parseVerifiedOperationBinding(
    root.observedOperationBinding,
  );
  const candidateIndex = parseDependencyBinding(root.candidateIndex);
  const store = parseDependencyBinding(root.store);
  const accounting = parseAccounting(root.accounting);
  const disposition = parseLookupDisposition(
    root.outcome,
    root.reason,
    root.storeAccess,
  );
  if (
    observedOperationBinding.ontologyDigest !== ontology.digest ||
    !effectMatchesDisposition(observedOperationBinding.effect, disposition) ||
    (disposition.storeAccess === 'attempted' && store.status !== 'enabled') ||
    (disposition.outcome !== 'policy-bypass' &&
      candidateIndex.status !== 'enabled')
  ) {
    throw malformedReceipt();
  }
  return Object.freeze({
    schema: INTENT_CACHE_LOOKUP_RECEIPT_SCHEMA,
    mode: 'shadow' as const,
    applied: false as const,
    sourceDigest: root.sourceDigest as HmacIntentSourceDigest,
    normalizer,
    ontology,
    normalizationPolicyDigest: root.normalizationPolicyDigest,
    cacheAdmissionPolicyDigest: root.cacheAdmissionPolicyDigest,
    cacheKeyDigest: root.cacheKeyDigest as CacheKeyDigest,
    observedOperationBinding,
    candidateIndex,
    store,
    ...disposition,
    accounting,
    receiptDigest: root.receiptDigest,
  });
}

function parseNormalizationBypassReceiptDocument(
  value: unknown,
): IntentNormalizationBypassReceipt {
  const root = snapshotDataRecord(value, NORMALIZATION_BYPASS_RECEIPT_FIELDS);
  if (
    root.schema !== INTENT_NORMALIZATION_BYPASS_RECEIPT_SCHEMA ||
    root.mode !== 'shadow' ||
    root.applied !== false ||
    typeof root.sourceDigest !== 'string' ||
    !SOURCE_HMAC.test(root.sourceDigest) ||
    !isSha256Digest(root.normalizationPolicyDigest) ||
    !isSha256Digest(root.cacheAdmissionPolicyDigest) ||
    typeof root.reason !== 'string' ||
    !(INTENT_NORMALIZATION_BYPASS_REASONS as readonly string[]).includes(
      root.reason,
    ) ||
    !isSha256Digest(root.receiptDigest)
  ) {
    throw malformedReceipt();
  }
  return Object.freeze({
    schema: INTENT_NORMALIZATION_BYPASS_RECEIPT_SCHEMA,
    mode: 'shadow' as const,
    applied: false as const,
    sourceDigest: root.sourceDigest as HmacIntentSourceDigest,
    normalizer: parseNormalizer(root.normalizer),
    ontology: parseOntology(root.ontology),
    normalizationPolicyDigest: root.normalizationPolicyDigest,
    cacheAdmissionPolicyDigest: root.cacheAdmissionPolicyDigest,
    reason: root.reason as IntentNormalizationBypassReason,
    accounting: parseAccounting(root.accounting),
    receiptDigest: root.receiptDigest,
  });
}

function parseVerifiedOperationBinding(
  value: unknown,
): IntentCacheOperationBinding {
  const parsed = parseOperationBindingDocument(value);
  if (digestOperationBinding(parsed) !== parsed.bindingDigest) {
    throw malformedReceipt();
  }
  return parsed;
}

function parseLookupDisposition(
  outcome: unknown,
  reason: unknown,
  storeAccess: unknown,
): IntentCacheLookupDisposition {
  if (
    outcome === 'miss' &&
    reason === 'NO_CANDIDATE_FOUND' &&
    storeAccess === 'attempted'
  ) {
    return Object.freeze({ outcome, reason, storeAccess });
  }
  if (
    outcome === 'policy-bypass' &&
    (reason === 'ALPHA_EFFECT_FORBIDDEN' ||
      reason === 'POLICY_DENY' ||
      reason === 'NORMALIZATION_INELIGIBLE') &&
    storeAccess === 'not-attempted'
  ) {
    return Object.freeze({ outcome, reason, storeAccess });
  }
  if (
    outcome === 'store-fault' &&
    reason === 'EXPECTED_STORE_FAULT' &&
    storeAccess === 'attempted'
  ) {
    return Object.freeze({ outcome, reason, storeAccess });
  }
  if (
    outcome === 'timeout' &&
    reason === 'LOOKUP_TIMEOUT' &&
    storeAccess === 'attempted'
  ) {
    return Object.freeze({ outcome, reason, storeAccess });
  }
  if (
    outcome === 'fallback' &&
    reason === 'LOOKUP_FALLBACK' &&
    storeAccess === 'attempted'
  ) {
    return Object.freeze({ outcome, reason, storeAccess });
  }
  throw malformedReceipt();
}

function effectMatchesDisposition(
  effect: IntentEffect,
  disposition: IntentCacheLookupDisposition,
): boolean {
  return effect === 'read'
    ? disposition.reason !== 'ALPHA_EFFECT_FORBIDDEN'
    : disposition.outcome === 'policy-bypass' &&
        disposition.reason === 'ALPHA_EFFECT_FORBIDDEN';
}

function parseAccounting(value: unknown): IntentCacheAccountingBinding {
  const completeness = dataDiscriminator(value, 'completeness');
  if (completeness === 'complete') {
    snapshotDataRecord(value, COMPLETE_ACCOUNTING_FIELDS);
    return Object.freeze({ completeness });
  }
  if (completeness === 'incomplete') {
    const root = snapshotDataRecord(value, INCOMPLETE_ACCOUNTING_FIELDS);
    if (!isSha256Digest(root.failureDigest)) throw malformedReceipt();
    return Object.freeze({ completeness, failureDigest: root.failureDigest });
  }
  throw malformedReceipt();
}

function parseDependencyBinding(value: unknown): IntentCacheDependencyBinding {
  const root = snapshotDataRecord(value, DEPENDENCY_BINDING_FIELDS);
  if (
    typeof root.status !== 'string' ||
    !(INTENT_CACHE_DEPENDENCY_STATUSES as readonly string[]).includes(
      root.status,
    )
  ) {
    throw malformedReceipt();
  }
  return Object.freeze({
    status: root.status as IntentCacheDependencyBinding['status'],
    artifact: parseBoundArtifact(root.artifact),
  });
}

function parseBoundArtifact(value: unknown): IntentCacheBoundArtifact {
  const root = snapshotDataRecord(value, BOUND_ARTIFACT_FIELDS);
  if (
    typeof root.id !== 'string' ||
    !SAFE_IDENTIFIER_PATTERN.test(root.id) ||
    typeof root.version !== 'string' ||
    !SAFE_VERSION_PATTERN.test(root.version) ||
    !isSha256Digest(root.digest)
  ) {
    throw malformedReceipt();
  }
  return Object.freeze({
    id: root.id,
    version: root.version,
    digest: root.digest,
  });
}

function parseNormalizer(value: unknown): NormalizerBinding {
  const root = snapshotDataRecord(value, NORMALIZER_FIELDS);
  if (
    typeof root.id !== 'string' ||
    !SAFE_IDENTIFIER_PATTERN.test(root.id) ||
    typeof root.version !== 'string' ||
    !SAFE_VERSION_PATTERN.test(root.version) ||
    !isSha256Digest(root.artifactDigest) ||
    !isSha256Digest(root.configDigest)
  ) {
    throw malformedReceipt();
  }
  return Object.freeze({
    id: root.id,
    version: root.version,
    artifactDigest: root.artifactDigest,
    configDigest: root.configDigest,
  });
}

function parseOntology(value: unknown): OntologyBinding {
  const root = snapshotDataRecord(value, ONTOLOGY_FIELDS);
  if (
    typeof root.id !== 'string' ||
    !SAFE_IDENTIFIER_PATTERN.test(root.id) ||
    typeof root.version !== 'string' ||
    !SAFE_VERSION_PATTERN.test(root.version) ||
    !isSha256Digest(root.digest)
  ) {
    throw malformedReceipt();
  }
  return Object.freeze({
    id: root.id,
    version: root.version,
    digest: root.digest,
  });
}

function dataDiscriminator(value: unknown, field: string): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw malformedReceipt();
  }
  const descriptor = Reflect.getOwnPropertyDescriptor(value, field);
  if (
    descriptor === undefined ||
    !descriptor.enumerable ||
    !Object.hasOwn(descriptor, 'value') ||
    Object.hasOwn(descriptor, 'get') ||
    Object.hasOwn(descriptor, 'set')
  ) {
    throw malformedReceipt();
  }
  return descriptor.value;
}

function digestOperationBinding(
  binding: IntentCacheOperationBinding,
): Sha256Digest {
  const { bindingDigest: _bindingDigest, ...unsigned } = binding;
  return hashCanonical(toJsonValue(unsigned));
}

function digestLookupReceipt(receipt: IntentCacheLookupReceipt): Sha256Digest {
  const { receiptDigest: _receiptDigest, ...unsigned } = receipt;
  return hashCanonical(toJsonValue(unsigned));
}

function digestNormalizationBypassReceipt(
  receipt: IntentNormalizationBypassReceipt,
): Sha256Digest {
  const { receiptDigest: _receiptDigest, ...unsigned } = receipt;
  return hashCanonical(toJsonValue(unsigned));
}

function malformedReceipt(): SemWitnessError {
  return new SemWitnessError(
    'MALFORMED_ENVELOPE',
    'Intent cache evidence receipt is malformed',
  );
}
