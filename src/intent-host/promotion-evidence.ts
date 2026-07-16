import {
  immutableJson,
  toJsonValue,
  type JsonValue,
} from '../domain/canonical-json.js';
import { compareCodeUnits } from '../domain/deterministic-order.js';
import { SemWitnessError } from '../domain/errors.js';
import { hashCanonical, isSha256Digest } from '../domain/hash.js';
import { parseStrictJson } from '../domain/strict-json.js';
import {
  SAFE_IDENTIFIER_PATTERN,
  SAFE_VERSION_PATTERN,
  type Sha256Digest,
} from '../domain/types.js';
import {
  snapshotDataRecord,
  snapshotDenseDataArray,
} from '../host/data-only.js';
import {
  parseCacheHitWitness,
  parseNormalizationWitness,
  verifyCacheHitWitnessIntegrity,
  verifyNormalizationWitnessIntegrity,
  type CacheBinding,
  type CacheHitWitness,
  type HmacIntentSourceDigest,
  type NormalizationWitness,
  type NormalizerBinding,
  type OntologyBinding,
} from '../intent/index.js';
import {
  parseIntentCacheLookupReceipt,
  parseIntentCacheOperationBinding,
  parseIntentNormalizationBypassReceipt,
} from './receipts.js';
import {
  INTENT_CACHE_ARTIFACT_RELATIONS,
  INTENT_CACHE_AUTHORIZATION_ORACLE_STATES,
  INTENT_CACHE_DEPENDENCY_STATUSES,
  INTENT_CACHE_EFFECT_TIER_ORACLE_STATES,
  INTENT_CACHE_ENTRY_SOURCE_BINDING_SCHEMA,
  INTENT_CACHE_FRESHNESS_ORACLE_STATES,
  INTENT_CACHE_POLICY_ORACLE_STATES,
  INTENT_CACHE_PROMOTION_CACHE_REGIMES,
  INTENT_CACHE_PROMOTION_DIFFICULTIES,
  INTENT_CACHE_PROMOTION_EVIDENCE_SCHEMA,
  INTENT_CACHE_PROMOTION_FAILURE_REASONS,
  INTENT_CACHE_PROMOTION_FAILURE_STAGES,
  INTENT_CACHE_PROMOTION_PAIR_ORDERS,
  INTENT_CACHE_PROMOTION_PHENOMENA,
  INTENT_CACHE_REQUIRED_ADVERSARIAL_SCENARIOS,
  INTENT_CACHE_SCOPE_ORACLE_STATES,
  INTENT_CACHE_TASK_QUALITY_ORACLE_STATES,
  type IntentCacheAccountingBinding,
  type IntentCacheAdversarialEvidenceCase,
  type IntentCacheArtifactRelation,
  type IntentCacheBoundArtifact,
  type IntentCacheCandidateBearingPath,
  type IntentCacheCandidateOracle,
  type IntentCacheDependencyBinding,
  type IntentCacheDependencyInventory,
  type IntentCacheDomainHmac,
  type IntentCacheEntrySourceBinding,
  type IntentCacheNoCandidateOracle,
  type IntentCacheNoCandidateReference,
  type IntentCacheNormalizationBypassOracle,
  type IntentCacheNormalizationBypassPath,
  type IntentCacheNormalizedNoCandidatePath,
  type IntentCacheOperationBinding,
  type IntentCacheOperationHmac,
  type IntentCacheOracleOperation,
  type IntentCachePopulationEvidenceCase,
  type IntentCachePromotionAttemptedOperation,
  type IntentCachePromotionCompletePath,
  type IntentCachePromotionEvidenceBinding,
  type IntentCachePromotionEvidenceCase,
  type IntentCachePromotionEvidenceFixture,
  type IntentCachePromotionFailure,
  type IntentCachePromotionStoreFault,
  type IntentCachePromotionUsageObservation,
  type IntentCachePromotionUsagePair,
  type IntentNormalizationBypassReceipt,
} from './types.js';

export const INTENT_CACHE_PROMOTION_EVIDENCE_ARTIFACT = Object.freeze({
  id: 'semwitness-intent-cache-promotion-evidence',
  version: '1',
} as const);

export const MAX_INTENT_CACHE_PROMOTION_EVIDENCE_CASES = 50_000;
export const MAX_INTENT_CACHE_PROMOTION_EVIDENCE_LINE_BYTES = 256 * 1024;
export const MAX_INTENT_CACHE_PROMOTION_EVIDENCE_DOCUMENT_BYTES =
  128 * 1024 * 1024;

const MAX_EVIDENCE_LINE_ITEMS = 20_000;
const MAX_EVIDENCE_STRING_CODE_UNITS = 16 * 1024;
const MAX_SNAPSHOT_ITEMS = 100_000;
const MAX_SNAPSHOT_DEPTH = 32;

const HEX_64 = '[a-f0-9]{64}';
const OPERATION_HMAC = new RegExp(`^hmac-sha256:operation:${HEX_64}$`, 'u');
const DOMAIN_HMAC = new RegExp(`^hmac-sha256:intent-domain:${HEX_64}$`, 'u');
const SOURCE_HMAC = new RegExp(`^hmac-sha256:intent-source:${HEX_64}$`, 'u');
const CACHE_KEY_HMAC = new RegExp(`^hmac-sha256:cache-key:${HEX_64}$`, 'u');
const CLUSTER_HMAC = new RegExp(`^hmac-sha256:cluster:${HEX_64}$`, 'u');
const REVOCATION_HMAC = new RegExp(`^hmac-sha256:revocation:${HEX_64}$`, 'u');
const NAMESPACE_HMAC = new RegExp(
  `^hmac-sha256:cache-namespace:${HEX_64}$`,
  'u',
);
const TENANT_HMAC = new RegExp(`^hmac-sha256:tenant:${HEX_64}$`, 'u');

const BINDING_FIELDS = [
  'schema',
  'kind',
  'artifact',
  'provenance',
  'evidenceAuthentication',
  'activationCeiling',
  'mode',
  'tier',
  'qualifiedOperation',
  'scope',
  'validity',
  'intentContract',
  'dependencies',
  'population',
  'adversarial',
  'evaluation',
  'bindingDigest',
] as const;
const ARTIFACT_FIELDS = ['id', 'version'] as const;
const QUALIFIED_OPERATION_FIELDS = ['operation', 'domain', 'effect'] as const;
const SCOPE_FIELDS = [
  'cacheNamespace',
  'tenant',
  'deploymentScopeDigest',
] as const;
const VALIDITY_FIELDS = [
  'notBeforeEpochMs',
  'notAfterEpochMs',
  'revocationId',
] as const;
const INTENT_CONTRACT_FIELDS = [
  'intentIrSchema',
  'ontology',
  'normalizer',
  'operationRegistry',
  'resolver',
  'normalizationPolicyDigest',
  'cacheAdmissionPolicyDigest',
  'sourceHmacKeyVersionDigest',
] as const;
const NORMALIZER_FIELDS = [
  'id',
  'version',
  'artifactDigest',
  'configDigest',
] as const;
const ONTOLOGY_FIELDS = ['id', 'version', 'digest'] as const;
const BOUND_ARTIFACT_FIELDS = ['id', 'version', 'digest'] as const;
const DEPENDENCY_FIELDS = [
  'prompt',
  'tool',
  'planner',
  'provider',
  'model',
  'output',
  'safety',
  'personalization',
  'determinism',
  'tokenizer',
  'embedding',
  'candidateIndex',
  'store',
  'recordAuthentication',
  'freshness',
  'invalidation',
  'key',
] as const;
const DEPENDENCY_BINDING_FIELDS = ['status', 'artifact'] as const;
const POPULATION_FIELDS = [
  'populationFrameDigest',
  'corpusDigest',
  'sourceLogRootDigest',
  'samplingProtocolDigest',
  'inclusionPolicyDigest',
  'samplingWindowDigest',
  'independenceUnit',
  'attempted',
  'emitted',
  'dropped',
  'complete',
  'failed',
] as const;
const ADVERSARIAL_FIELDS = [
  'corpusDigest',
  'coverageDigest',
  'expected',
  'emitted',
  'complete',
  'failed',
] as const;
const EVALUATION_FIELDS = [
  'split',
  'evaluationProtocolDigest',
  'evaluatorDigest',
  'oracleDigest',
  'accountingContractDigest',
  'costModel',
  'currencyUnitDigest',
] as const;
const ENTRY_SOURCE_BINDING_FIELDS = [
  'schema',
  'entryDigest',
  'valueDigest',
  'entrySourceHmac',
  'bindingDigest',
] as const;

const COMMON_CASE_FIELDS = [
  'schema',
  'kind',
  'ordinal',
  'difficulty',
  'cacheRegime',
  'pairOrder',
  'stateSnapshotDigest',
  'usage',
  'caseDigest',
] as const;
const COMPLETE_CASE_FIELDS = ['storeFault', 'path'] as const;
const FAILURE_CASE_FIELDS = ['attemptedOperation', 'failure'] as const;
const POPULATION_CASE_FIELDS = ['clusterHmac'] as const;
const ADVERSARIAL_CASE_FIELDS = ['primaryScenario', 'phenomena'] as const;
const PROBE_OPERATION_FIELDS = ['probeOperation'] as const;
const USAGE_PAIR_FIELDS = [
  'accounting',
  'costModelDigest',
  'currencyUnitDigest',
  'ordinary',
  'candidate',
] as const;
const USAGE_COUNTER_FIELDS = [
  'physicalInputTokens',
  'providerPrefixCacheReadInputTokens',
  'providerPrefixCacheWriteInputTokens',
  'applicationSemanticCacheLookups',
  'applicationSemanticCacheReads',
  'applicationSemanticCacheWrites',
  'applicationSemanticCacheInvalidations',
  'outputTokens',
  'reasoningTokens',
  'normalizedCostUnits',
  'allocatedInvalidationCostUnits',
  'endToEndLatencyMicros',
  'normalizerLatencyMicros',
  'candidateIndexLatencyMicros',
  'storeLatencyMicros',
  'lookupLatencyMicros',
  'verifierLatencyMicros',
  'fallbackLatencyMicros',
  'toolCalls',
  'attempts',
  'retries',
  'recoveries',
] as const;
const COMPLETE_USAGE_FIELDS = [
  'completeness',
  'traceDigest',
  ...USAGE_COUNTER_FIELDS,
] as const;
const INCOMPLETE_USAGE_FIELDS = [
  'completeness',
  'failureDigest',
  'traceDigest',
  ...USAGE_COUNTER_FIELDS,
] as const;
const COMPLETE_ACCOUNTING_FIELDS = ['completeness'] as const;
const INCOMPLETE_ACCOUNTING_FIELDS = ['completeness', 'failureDigest'] as const;
const STORE_FAULT_NONE_FIELDS = ['kind'] as const;
const STORE_FAULT_INJECTED_FIELDS = [
  'kind',
  'evidenceDigest',
  'expectedFaultObserved',
  'ordinaryPathSucceeded',
  'candidateFallbackSucceeded',
  'unexpectedExecutionFailure',
] as const;
const CANDIDATE_PATH_FIELDS = [
  'kind',
  'normalizationWitness',
  'operationBinding',
  'entrySourceBinding',
  'cacheHitWitness',
  'oracle',
] as const;
const NO_CANDIDATE_PATH_FIELDS = [
  'kind',
  'normalizationWitness',
  'lookupReceipt',
  'oracle',
] as const;
const BYPASS_PATH_FIELDS = ['kind', 'receipt', 'lookup', 'oracle'] as const;
const PERMISSION_ORACLE_FIELDS = [
  'artifactRelation',
  'scope',
  'authorization',
  'freshness',
  'effectTier',
  'policy',
] as const;
const CANDIDATE_ORACLE_FIELDS = [
  'kind',
  'ordinaryArtifactDigest',
  'observedCandidateArtifactDigest',
  'qualityEvidenceDigest',
  ...PERMISSION_ORACLE_FIELDS,
  'taskQuality',
] as const;
const NO_CANDIDATE_ORACLE_FIELDS = [
  'kind',
  'ordinaryArtifactDigest',
  ...PERMISSION_ORACLE_FIELDS,
  'taskQuality',
  'reference',
] as const;
const NO_REFERENCE_FIELDS = ['kind'] as const;
const ATTESTED_REFERENCE_FIELDS = [
  'kind',
  'artifactDigest',
  'cacheKeyDigest',
  'entrySourceBinding',
  'operationBinding',
] as const;
const BYPASS_ORACLE_FIELDS = [
  'kind',
  'ordinaryArtifactDigest',
  'artifactRelation',
  'oracleOperation',
] as const;
const NO_ORACLE_OPERATION_FIELDS = ['kind'] as const;
const ATTESTED_ORACLE_OPERATION_FIELDS = ['kind', 'binding'] as const;
const UNAVAILABLE_OPERATION_FIELDS = ['status'] as const;
const OBSERVED_OPERATION_FIELDS = ['status', 'binding'] as const;
const FAILURE_FIELDS = ['stage', 'reason', 'evidenceDigest'] as const;

export function parseIntentCachePromotionEvidenceJsonl(
  source: string | Uint8Array,
): IntentCachePromotionEvidenceFixture {
  try {
    const text = decodeBoundedUtf8(source);
    assertJsonlRecordLimit(text);
    const lines = text.split('\n');
    if (lines.length > 1 && lines.at(-1) === '') lines.pop();
    if (lines.length === 0 || lines.some((line) => blankJsonlLine(line))) {
      throw malformedEvidence('Evidence contains a blank record');
    }

    const records: unknown[] = [];
    for (const [index, rawLine] of lines.entries()) {
      if (
        Buffer.byteLength(rawLine, 'utf8') >
        MAX_INTENT_CACHE_PROMOTION_EVIDENCE_LINE_BYTES
      ) {
        throw malformedEvidence(`Evidence line ${index + 1} exceeds the limit`);
      }
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      try {
        records.push(
          parseStrictJson(line, {
            maxDepth: MAX_SNAPSHOT_DEPTH,
            maxItems: MAX_EVIDENCE_LINE_ITEMS,
            maxStringCodeUnits: MAX_EVIDENCE_STRING_CODE_UNITS,
            maxNumberCodeUnits: 64,
          }),
        );
      } catch {
        throw malformedEvidence(
          `Evidence line ${index + 1} is not strict JSON`,
        );
      }
    }
    if (
      records.length === 0 ||
      dataDiscriminator(records[0], 'kind') !== 'binding'
    ) {
      throw malformedEvidence('The first evidence record must be the binding');
    }
    if (
      records
        .slice(1)
        .some((record) => dataDiscriminator(record, 'kind') === 'binding')
    ) {
      throw malformedEvidence('Evidence contains more than one binding');
    }
    return parseRecords(records[0], records.slice(1));
  } catch (error) {
    throw normalizeEvidenceError(error);
  }
}

export function parseIntentCachePromotionEvidenceFixture(
  value: unknown,
): IntentCachePromotionEvidenceFixture {
  try {
    const root = snapshotDataRecord(value, ['binding', 'cases']);
    const caseValues = snapshotDenseDataArray(
      root.cases,
      0,
      MAX_INTENT_CACHE_PROMOTION_EVIDENCE_CASES,
    );
    return parseRecords(root.binding, caseValues);
  } catch (error) {
    throw normalizeEvidenceError(error);
  }
}

export function recomputeIntentCachePromotionEvidenceBindingDigest(
  value: unknown,
): Sha256Digest {
  try {
    return digestBinding(parseBindingDocument(value));
  } catch (error) {
    throw normalizeEvidenceError(error);
  }
}

export function recomputeIntentCachePromotionEvidenceCaseDigest(
  value: unknown,
): Sha256Digest {
  try {
    return digestCase(parseCaseDocument(value));
  } catch (error) {
    throw normalizeEvidenceError(error);
  }
}

export function parseIntentCacheEntrySourceBinding(
  value: unknown,
): IntentCacheEntrySourceBinding {
  try {
    const binding = parseEntrySourceBindingDocument(value);
    if (digestEntrySourceBinding(binding) !== binding.bindingDigest) {
      throw malformedEvidence('Entry-source binding digest mismatch');
    }
    return binding;
  } catch (error) {
    throw normalizeEvidenceError(error);
  }
}

export function recomputeIntentCacheEntrySourceBindingDigest(
  value: unknown,
): Sha256Digest {
  try {
    return digestEntrySourceBinding(parseEntrySourceBindingDocument(value));
  } catch (error) {
    throw normalizeEvidenceError(error);
  }
}

export function digestIntentCachePromotionPopulationCorpus(
  caseDigests: readonly Sha256Digest[],
): Sha256Digest {
  return digestCorpus('population', caseDigests);
}

export function digestIntentCachePromotionAdversarialCorpus(
  caseDigests: readonly Sha256Digest[],
): Sha256Digest {
  return digestCorpus('adversarial', caseDigests);
}

export function digestIntentCachePromotionUsageFailures(
  ordinaryFailureDigest: Sha256Digest | null,
  candidateFailureDigest: Sha256Digest | null,
): Sha256Digest {
  if (
    (ordinaryFailureDigest !== null &&
      !isSha256Digest(ordinaryFailureDigest)) ||
    (candidateFailureDigest !== null &&
      !isSha256Digest(candidateFailureDigest)) ||
    (ordinaryFailureDigest === null && candidateFailureDigest === null)
  ) {
    throw malformedEvidence('Incomplete usage failure binding is malformed');
  }
  return hashCanonical({
    schema: 'semwitness.dev/intent-cache-promotion-usage-failures/v1alpha1',
    ordinaryFailureDigest,
    candidateFailureDigest,
  });
}

function parseRecords(
  bindingValue: unknown,
  caseValues: readonly unknown[],
): IntentCachePromotionEvidenceFixture {
  if (caseValues.length > MAX_INTENT_CACHE_PROMOTION_EVIDENCE_CASES) {
    throw malformedEvidence('Evidence exceeds the case limit');
  }
  const binding = parseBinding(bindingValue);
  const cases = caseValues.map(parseCase);
  validateFixture(binding, cases);
  return freezeData({ binding, cases });
}

function parseBinding(value: unknown): IntentCachePromotionEvidenceBinding {
  const binding = parseBindingDocument(value);
  if (digestBinding(binding) !== binding.bindingDigest) {
    throw malformedEvidence('Evidence binding digest mismatch');
  }
  return binding;
}

function parseBindingDocument(
  value: unknown,
): IntentCachePromotionEvidenceBinding {
  const root = snapshotDataRecord(value, BINDING_FIELDS);
  if (
    root.schema !== INTENT_CACHE_PROMOTION_EVIDENCE_SCHEMA ||
    root.kind !== 'binding' ||
    root.provenance !== 'host-attested-unsigned' ||
    root.evidenceAuthentication !== 'none' ||
    root.activationCeiling !== 'shadow-only' ||
    root.mode !== 'shadow' ||
    root.tier !== 'plan' ||
    !isSha256Digest(root.bindingDigest)
  ) {
    throw malformedEvidence('Evidence binding is malformed');
  }
  const artifact = snapshotDataRecord(root.artifact, ARTIFACT_FIELDS);
  if (
    artifact.id !== INTENT_CACHE_PROMOTION_EVIDENCE_ARTIFACT.id ||
    artifact.version !== INTENT_CACHE_PROMOTION_EVIDENCE_ARTIFACT.version
  ) {
    throw malformedEvidence('Evidence artifact is malformed');
  }
  const qualified = snapshotDataRecord(
    root.qualifiedOperation,
    QUALIFIED_OPERATION_FIELDS,
  );
  if (
    typeof qualified.operation !== 'string' ||
    !OPERATION_HMAC.test(qualified.operation) ||
    typeof qualified.domain !== 'string' ||
    !DOMAIN_HMAC.test(qualified.domain) ||
    qualified.effect !== 'read'
  ) {
    throw malformedEvidence('Qualified operation is malformed');
  }
  const scope = snapshotDataRecord(root.scope, SCOPE_FIELDS);
  if (
    typeof scope.cacheNamespace !== 'string' ||
    !NAMESPACE_HMAC.test(scope.cacheNamespace) ||
    typeof scope.tenant !== 'string' ||
    !TENANT_HMAC.test(scope.tenant) ||
    !isSha256Digest(scope.deploymentScopeDigest)
  ) {
    throw malformedEvidence('Evidence scope is malformed');
  }
  const validity = snapshotDataRecord(root.validity, VALIDITY_FIELDS);
  if (
    !isNonNegativeSafeInteger(validity.notBeforeEpochMs) ||
    !isNonNegativeSafeInteger(validity.notAfterEpochMs) ||
    (validity.notAfterEpochMs as number) <=
      (validity.notBeforeEpochMs as number) ||
    typeof validity.revocationId !== 'string' ||
    !REVOCATION_HMAC.test(validity.revocationId)
  ) {
    throw malformedEvidence('Evidence validity is malformed');
  }
  const contractRoot = snapshotDataRecord(
    root.intentContract,
    INTENT_CONTRACT_FIELDS,
  );
  if (
    contractRoot.intentIrSchema !== 'semwitness.dev/intent-ir/v1alpha1' ||
    !isSha256Digest(contractRoot.normalizationPolicyDigest) ||
    !isSha256Digest(contractRoot.cacheAdmissionPolicyDigest) ||
    !isSha256Digest(contractRoot.sourceHmacKeyVersionDigest)
  ) {
    throw malformedEvidence('Intent contract is malformed');
  }
  const population = parsePopulationBinding(root.population);
  const adversarial = parseAdversarialBinding(root.adversarial);
  if (
    population.emitted + adversarial.emitted >
    MAX_INTENT_CACHE_PROMOTION_EVIDENCE_CASES
  ) {
    throw malformedEvidence('Evidence binding exceeds the case limit');
  }
  const evaluationRoot = snapshotDataRecord(root.evaluation, EVALUATION_FIELDS);
  if (
    evaluationRoot.split !== 'held-out' ||
    !isSha256Digest(evaluationRoot.evaluationProtocolDigest) ||
    !isSha256Digest(evaluationRoot.evaluatorDigest) ||
    !isSha256Digest(evaluationRoot.oracleDigest) ||
    !isSha256Digest(evaluationRoot.accountingContractDigest) ||
    !isSha256Digest(evaluationRoot.currencyUnitDigest)
  ) {
    throw malformedEvidence('Evaluation binding is malformed');
  }
  return freezeData({
    schema: INTENT_CACHE_PROMOTION_EVIDENCE_SCHEMA,
    kind: 'binding',
    artifact: INTENT_CACHE_PROMOTION_EVIDENCE_ARTIFACT,
    provenance: 'host-attested-unsigned',
    evidenceAuthentication: 'none',
    activationCeiling: 'shadow-only',
    mode: 'shadow',
    tier: 'plan',
    qualifiedOperation: {
      operation: qualified.operation as IntentCacheOperationHmac,
      domain: qualified.domain as IntentCacheDomainHmac,
      effect: 'read',
    },
    scope: {
      cacheNamespace:
        scope.cacheNamespace as IntentCachePromotionEvidenceBinding['scope']['cacheNamespace'],
      tenant:
        scope.tenant as IntentCachePromotionEvidenceBinding['scope']['tenant'],
      deploymentScopeDigest: scope.deploymentScopeDigest,
    },
    validity: {
      notBeforeEpochMs: validity.notBeforeEpochMs as number,
      notAfterEpochMs: validity.notAfterEpochMs as number,
      revocationId:
        validity.revocationId as IntentCachePromotionEvidenceBinding['validity']['revocationId'],
    },
    intentContract: {
      intentIrSchema: 'semwitness.dev/intent-ir/v1alpha1',
      ontology: parseOntology(contractRoot.ontology),
      normalizer: parseNormalizer(contractRoot.normalizer),
      operationRegistry: parseBoundArtifact(contractRoot.operationRegistry),
      resolver: parseBoundArtifact(contractRoot.resolver),
      normalizationPolicyDigest: contractRoot.normalizationPolicyDigest,
      cacheAdmissionPolicyDigest: contractRoot.cacheAdmissionPolicyDigest,
      sourceHmacKeyVersionDigest: contractRoot.sourceHmacKeyVersionDigest,
    },
    dependencies: parseDependencyInventory(root.dependencies),
    population,
    adversarial,
    evaluation: {
      split: 'held-out',
      evaluationProtocolDigest: evaluationRoot.evaluationProtocolDigest,
      evaluatorDigest: evaluationRoot.evaluatorDigest,
      oracleDigest: evaluationRoot.oracleDigest,
      accountingContractDigest: evaluationRoot.accountingContractDigest,
      costModel: parseBoundArtifact(evaluationRoot.costModel),
      currencyUnitDigest: evaluationRoot.currencyUnitDigest,
    },
    bindingDigest: root.bindingDigest,
  });
}

function parsePopulationBinding(
  value: unknown,
): IntentCachePromotionEvidenceBinding['population'] {
  const root = snapshotDataRecord(value, POPULATION_FIELDS);
  const digestFields = [
    root.populationFrameDigest,
    root.corpusDigest,
    root.sourceLogRootDigest,
    root.samplingProtocolDigest,
    root.inclusionPolicyDigest,
    root.samplingWindowDigest,
  ];
  if (
    digestFields.some((item) => !isSha256Digest(item)) ||
    root.independenceUnit !== 'cluster' ||
    !isNonNegativeSafeInteger(root.attempted) ||
    !isNonNegativeSafeInteger(root.emitted) ||
    root.dropped !== 0 ||
    !isNonNegativeSafeInteger(root.complete) ||
    !isNonNegativeSafeInteger(root.failed) ||
    root.attempted !== root.emitted ||
    root.emitted !== (root.complete as number) + (root.failed as number)
  ) {
    throw malformedEvidence('Population binding is malformed');
  }
  return freezeData({
    populationFrameDigest: root.populationFrameDigest as Sha256Digest,
    corpusDigest: root.corpusDigest as Sha256Digest,
    sourceLogRootDigest: root.sourceLogRootDigest as Sha256Digest,
    samplingProtocolDigest: root.samplingProtocolDigest as Sha256Digest,
    inclusionPolicyDigest: root.inclusionPolicyDigest as Sha256Digest,
    samplingWindowDigest: root.samplingWindowDigest as Sha256Digest,
    independenceUnit: 'cluster',
    attempted: root.attempted as number,
    emitted: root.emitted as number,
    dropped: 0,
    complete: root.complete as number,
    failed: root.failed as number,
  });
}

function parseAdversarialBinding(
  value: unknown,
): IntentCachePromotionEvidenceBinding['adversarial'] {
  const root = snapshotDataRecord(value, ADVERSARIAL_FIELDS);
  if (
    !isSha256Digest(root.corpusDigest) ||
    !isSha256Digest(root.coverageDigest) ||
    !isNonNegativeSafeInteger(root.expected) ||
    !isNonNegativeSafeInteger(root.emitted) ||
    !isNonNegativeSafeInteger(root.complete) ||
    !isNonNegativeSafeInteger(root.failed) ||
    root.expected !== root.emitted ||
    root.emitted !== (root.complete as number) + (root.failed as number)
  ) {
    throw malformedEvidence('Adversarial binding is malformed');
  }
  return freezeData({
    corpusDigest: root.corpusDigest,
    coverageDigest: root.coverageDigest,
    expected: root.expected as number,
    emitted: root.emitted as number,
    complete: root.complete as number,
    failed: root.failed as number,
  });
}

function parseCase(value: unknown): IntentCachePromotionEvidenceCase {
  const item = parseCaseDocument(value);
  if (digestCase(item) !== item.caseDigest) {
    throw malformedEvidence('Evidence case digest mismatch');
  }
  return item;
}

function parseCaseDocument(value: unknown): IntentCachePromotionEvidenceCase {
  const kind = dataDiscriminator(value, 'kind');
  if (
    kind !== 'population-complete' &&
    kind !== 'population-failure' &&
    kind !== 'adversarial-complete' &&
    kind !== 'adversarial-failure'
  ) {
    throw malformedEvidence('Evidence case kind is malformed');
  }
  const complete = kind.endsWith('-complete');
  const population = kind.startsWith('population-');
  const scenario = population
    ? undefined
    : dataDiscriminator(value, 'primaryScenario');
  const fields = [
    ...COMMON_CASE_FIELDS,
    ...(complete ? COMPLETE_CASE_FIELDS : FAILURE_CASE_FIELDS),
    ...(population ? POPULATION_CASE_FIELDS : ADVERSARIAL_CASE_FIELDS),
    ...(!population && scenario === 'side-effect'
      ? PROBE_OPERATION_FIELDS
      : []),
  ];
  const root = snapshotDataRecord(value, fields);
  if (
    root.schema !== INTENT_CACHE_PROMOTION_EVIDENCE_SCHEMA ||
    !isNonNegativeSafeInteger(root.ordinal) ||
    typeof root.difficulty !== 'string' ||
    !includesString(INTENT_CACHE_PROMOTION_DIFFICULTIES, root.difficulty) ||
    typeof root.cacheRegime !== 'string' ||
    !includesString(INTENT_CACHE_PROMOTION_CACHE_REGIMES, root.cacheRegime) ||
    typeof root.pairOrder !== 'string' ||
    !includesString(INTENT_CACHE_PROMOTION_PAIR_ORDERS, root.pairOrder) ||
    !isSha256Digest(root.stateSnapshotDigest) ||
    !isSha256Digest(root.caseDigest)
  ) {
    throw malformedEvidence('Evidence case is malformed');
  }
  const common = {
    schema: INTENT_CACHE_PROMOTION_EVIDENCE_SCHEMA,
    ordinal: root.ordinal as number,
    difficulty:
      root.difficulty as IntentCachePromotionEvidenceCase['difficulty'],
    cacheRegime:
      root.cacheRegime as IntentCachePromotionEvidenceCase['cacheRegime'],
    pairOrder: root.pairOrder as IntentCachePromotionEvidenceCase['pairOrder'],
    stateSnapshotDigest: root.stateSnapshotDigest,
    usage: parseUsagePair(root.usage),
    caseDigest: root.caseDigest,
  };
  if (kind === 'population-complete') {
    return freezeData({
      ...common,
      kind,
      clusterHmac: parseClusterHmac(root.clusterHmac),
      storeFault: parseStoreFault(root.storeFault),
      path: parseCompletePath(root.path),
    });
  }
  if (kind === 'population-failure') {
    return freezeData({
      ...common,
      kind,
      clusterHmac: parseClusterHmac(root.clusterHmac),
      attemptedOperation: parseAttemptedOperation(root.attemptedOperation),
      failure: parseFailure(root.failure),
    });
  }
  const phenomena = parsePhenomena(root.phenomena);
  if (
    typeof root.primaryScenario !== 'string' ||
    !includesString(
      INTENT_CACHE_REQUIRED_ADVERSARIAL_SCENARIOS,
      root.primaryScenario,
    )
  ) {
    throw malformedEvidence('Adversarial labels are malformed');
  }
  const labels =
    root.primaryScenario === 'side-effect'
      ? {
          primaryScenario: 'side-effect' as const,
          phenomena,
          probeOperation: parseIntentCacheOperationBinding(root.probeOperation),
        }
      : {
          primaryScenario: root.primaryScenario as Exclude<
            IntentCacheAdversarialEvidenceCase['primaryScenario'],
            'side-effect'
          >,
          phenomena,
        };
  if (kind === 'adversarial-complete') {
    return freezeData({
      ...common,
      kind,
      ...labels,
      storeFault: parseStoreFault(root.storeFault),
      path: parseCompletePath(root.path),
    }) as IntentCachePromotionEvidenceCase;
  }
  return freezeData({
    ...common,
    kind,
    ...labels,
    attemptedOperation: parseAttemptedOperation(root.attemptedOperation),
    failure: parseFailure(root.failure),
  }) as IntentCachePromotionEvidenceCase;
}

function parseUsagePair(value: unknown): IntentCachePromotionUsagePair {
  const root = snapshotDataRecord(value, USAGE_PAIR_FIELDS);
  if (
    !isSha256Digest(root.costModelDigest) ||
    !isSha256Digest(root.currencyUnitDigest)
  ) {
    throw malformedEvidence('Usage binding is malformed');
  }
  const accounting = parseAccounting(root.accounting);
  const ordinary = parseUsageObservation(root.ordinary);
  const candidate = parseUsageObservation(root.candidate);
  if (accounting.completeness === 'complete') {
    if (
      ordinary.completeness !== 'complete' ||
      candidate.completeness !== 'complete'
    ) {
      throw malformedEvidence('Complete accounting has incomplete usage');
    }
    return freezeData({
      accounting,
      costModelDigest: root.costModelDigest,
      currencyUnitDigest: root.currencyUnitDigest,
      ordinary,
      candidate,
    });
  }
  if (
    ordinary.completeness === 'complete' &&
    candidate.completeness === 'complete'
  ) {
    throw malformedEvidence('Incomplete accounting has no incomplete usage');
  }
  const expectedFailureDigest = digestIntentCachePromotionUsageFailures(
    ordinary.completeness === 'incomplete' ? ordinary.failureDigest : null,
    candidate.completeness === 'incomplete' ? candidate.failureDigest : null,
  );
  if (accounting.failureDigest !== expectedFailureDigest) {
    throw malformedEvidence('Usage failure binding mismatch');
  }
  return freezeData({
    accounting,
    costModelDigest: root.costModelDigest,
    currencyUnitDigest: root.currencyUnitDigest,
    ordinary,
    candidate,
  }) as IntentCachePromotionUsagePair;
}

function parseUsageObservation(
  value: unknown,
): IntentCachePromotionUsageObservation {
  const completeness = dataDiscriminator(value, 'completeness');
  const root = snapshotDataRecord(
    value,
    completeness === 'complete'
      ? COMPLETE_USAGE_FIELDS
      : completeness === 'incomplete'
        ? INCOMPLETE_USAGE_FIELDS
        : [],
  );
  if (!isSha256Digest(root.traceDigest)) {
    throw malformedEvidence('Usage trace digest is malformed');
  }
  if (completeness === 'complete') {
    for (const field of USAGE_COUNTER_FIELDS) {
      if (!isNonNegativeSafeInteger(root[field])) {
        throw malformedEvidence('Complete usage counter is malformed');
      }
    }
    if ((root.attempts as number) < 1) {
      throw malformedEvidence('Usage attempts must be positive');
    }
    return freezeData({
      completeness,
      traceDigest: root.traceDigest,
      ...usageCounters(root, false),
    }) as IntentCachePromotionUsageObservation;
  }
  if (completeness !== 'incomplete' || !isSha256Digest(root.failureDigest)) {
    throw malformedEvidence('Incomplete usage is malformed');
  }
  let nullCounters = 0;
  for (const field of USAGE_COUNTER_FIELDS) {
    const counter = root[field];
    if (counter === null) {
      nullCounters += 1;
    } else if (!isNonNegativeSafeInteger(counter)) {
      throw malformedEvidence('Incomplete usage counter is malformed');
    }
  }
  const attempts = root.attempts;
  if (
    nullCounters === 0 ||
    (attempts !== null && (typeof attempts !== 'number' || attempts < 1))
  ) {
    throw malformedEvidence(
      'Incomplete usage must expose unavailable counters',
    );
  }
  return freezeData({
    completeness,
    failureDigest: root.failureDigest,
    traceDigest: root.traceDigest,
    ...usageCounters(root, true),
  }) as IntentCachePromotionUsageObservation;
}

function usageCounters(
  root: Readonly<Record<string, unknown>>,
  nullable: boolean,
): Record<(typeof USAGE_COUNTER_FIELDS)[number], number | null> {
  const counters = Object.create(null) as Record<
    (typeof USAGE_COUNTER_FIELDS)[number],
    number | null
  >;
  for (const field of USAGE_COUNTER_FIELDS) {
    const value = root[field];
    counters[field] = nullable ? (value as number | null) : (value as number);
  }
  return counters;
}

function parseAccounting(value: unknown): IntentCacheAccountingBinding {
  const completeness = dataDiscriminator(value, 'completeness');
  if (completeness === 'complete') {
    snapshotDataRecord(value, COMPLETE_ACCOUNTING_FIELDS);
    return Object.freeze({ completeness });
  }
  if (completeness === 'incomplete') {
    const root = snapshotDataRecord(value, INCOMPLETE_ACCOUNTING_FIELDS);
    if (!isSha256Digest(root.failureDigest)) {
      throw malformedEvidence('Accounting failure digest is malformed');
    }
    return Object.freeze({ completeness, failureDigest: root.failureDigest });
  }
  throw malformedEvidence('Accounting binding is malformed');
}

function parseStoreFault(value: unknown): IntentCachePromotionStoreFault {
  const kind = dataDiscriminator(value, 'kind');
  if (kind === 'not-injected') {
    snapshotDataRecord(value, STORE_FAULT_NONE_FIELDS);
    return Object.freeze({ kind });
  }
  if (kind === 'injected') {
    const root = snapshotDataRecord(value, STORE_FAULT_INJECTED_FIELDS);
    if (
      !isSha256Digest(root.evidenceDigest) ||
      typeof root.expectedFaultObserved !== 'boolean' ||
      typeof root.ordinaryPathSucceeded !== 'boolean' ||
      typeof root.candidateFallbackSucceeded !== 'boolean' ||
      typeof root.unexpectedExecutionFailure !== 'boolean'
    ) {
      throw malformedEvidence('Store-fault evidence is malformed');
    }
    return freezeData({
      kind,
      evidenceDigest: root.evidenceDigest,
      expectedFaultObserved: root.expectedFaultObserved,
      ordinaryPathSucceeded: root.ordinaryPathSucceeded,
      candidateFallbackSucceeded: root.candidateFallbackSucceeded,
      unexpectedExecutionFailure: root.unexpectedExecutionFailure,
    });
  }
  throw malformedEvidence('Store-fault evidence is malformed');
}

function parseCompletePath(value: unknown): IntentCachePromotionCompletePath {
  const kind = dataDiscriminator(value, 'kind');
  if (kind === 'candidate-bearing') return parseCandidatePath(value);
  if (kind === 'normalized-no-candidate') return parseNoCandidatePath(value);
  if (kind === 'normalization-bypass') return parseBypassPath(value);
  throw malformedEvidence('Complete evidence path is malformed');
}

function parseCandidatePath(value: unknown): IntentCacheCandidateBearingPath {
  const root = snapshotDataRecord(value, CANDIDATE_PATH_FIELDS);
  if (root.kind !== 'candidate-bearing') {
    throw malformedEvidence('Candidate path is malformed');
  }
  const normalizationWitness = parseVerifiedNormalizationWitness(
    root.normalizationWitness,
  );
  const cacheHitWitness = parseVerifiedCacheHitWitness(
    root.cacheHitWitness,
    normalizationWitness,
  );
  const operationBinding = parseIntentCacheOperationBinding(
    root.operationBinding,
  );
  const entrySourceBinding = parseIntentCacheEntrySourceBinding(
    root.entrySourceBinding,
  );
  const oracle = parseCandidateOracle(root.oracle);
  if (
    entrySourceBinding.entryDigest !== cacheHitWitness.entry.entryDigest ||
    entrySourceBinding.valueDigest !== cacheHitWitness.entry.valueDigest ||
    oracle.observedCandidateArtifactDigest !==
      cacheHitWitness.entry.valueDigest ||
    operationBinding.intentDigest !== normalizationWitness.intentDigest ||
    operationBinding.intentDigest !==
      cacheHitWitness.entry.binding.intentDigest ||
    operationBinding.intentDigest !==
      cacheHitWitness.lookup.binding.intentDigest ||
    operationBinding.effect !== cacheHitWitness.entry.binding.effect ||
    operationBinding.effect !== cacheHitWitness.lookup.binding.effect ||
    operationBinding.operationRegistryDigest !==
      planOperationRegistryDigest(cacheHitWitness.entry.binding) ||
    operationBinding.operationRegistryDigest !==
      planOperationRegistryDigest(cacheHitWitness.lookup.binding)
  ) {
    throw malformedEvidence('Candidate path cross-link mismatch');
  }
  return freezeData({
    kind: 'candidate-bearing',
    normalizationWitness,
    operationBinding,
    entrySourceBinding,
    cacheHitWitness,
    oracle,
  });
}

function parseNoCandidatePath(
  value: unknown,
): IntentCacheNormalizedNoCandidatePath {
  const root = snapshotDataRecord(value, NO_CANDIDATE_PATH_FIELDS);
  if (root.kind !== 'normalized-no-candidate') {
    throw malformedEvidence('No-candidate path is malformed');
  }
  const normalizationWitness = parseVerifiedNormalizationWitness(
    root.normalizationWitness,
  );
  const lookupReceipt = parseIntentCacheLookupReceipt(root.lookupReceipt);
  const oracle = parseNoCandidateOracle(root.oracle);
  if (
    lookupReceipt.sourceDigest !== normalizationWitness.sourceDigest ||
    !sameCanonical(lookupReceipt.normalizer, normalizationWitness.normalizer) ||
    !sameCanonical(lookupReceipt.ontology, normalizationWitness.ontology) ||
    lookupReceipt.normalizationPolicyDigest !==
      normalizationWitness.policyDigest ||
    lookupReceipt.observedOperationBinding.intentDigest !==
      normalizationWitness.intentDigest
  ) {
    throw malformedEvidence('No-candidate path cross-link mismatch');
  }
  const normalizationWasIneligible =
    lookupReceipt.outcome === 'policy-bypass' &&
    lookupReceipt.reason === 'NORMALIZATION_INELIGIBLE';
  if (
    (normalizationWitness.decision.verdict === 'bypass') !==
    normalizationWasIneligible
  ) {
    throw malformedEvidence('Normalization decision disposition mismatch');
  }
  if (oracle.reference.kind === 'attested') {
    if (
      oracle.reference.artifactDigest !==
        oracle.reference.entrySourceBinding.valueDigest ||
      oracle.reference.cacheKeyDigest !== lookupReceipt.cacheKeyDigest ||
      !sameOperationBinding(
        oracle.reference.operationBinding,
        lookupReceipt.observedOperationBinding,
      )
    ) {
      throw malformedEvidence('No-candidate reference mismatch');
    }
  }
  return freezeData({
    kind: 'normalized-no-candidate',
    normalizationWitness,
    lookupReceipt,
    oracle,
  });
}

function parseBypassPath(value: unknown): IntentCacheNormalizationBypassPath {
  const root = snapshotDataRecord(value, BYPASS_PATH_FIELDS);
  if (root.kind !== 'normalization-bypass' || root.lookup !== 'not-attempted') {
    throw malformedEvidence('Normalization-bypass path is malformed');
  }
  const receipt = parseIntentNormalizationBypassReceipt(root.receipt);
  const oracle = parseBypassOracle(root.oracle);
  return freezeData({
    kind: 'normalization-bypass',
    receipt,
    lookup: 'not-attempted',
    oracle,
  });
}

function parseCandidateOracle(value: unknown): IntentCacheCandidateOracle {
  const root = snapshotDataRecord(value, CANDIDATE_ORACLE_FIELDS);
  const permission = parsePermissionOracle(root);
  if (
    root.kind !== 'candidate' ||
    !isSha256Digest(root.ordinaryArtifactDigest) ||
    !isSha256Digest(root.observedCandidateArtifactDigest) ||
    !isSha256Digest(root.qualityEvidenceDigest) ||
    typeof root.taskQuality !== 'string' ||
    !includesString(INTENT_CACHE_TASK_QUALITY_ORACLE_STATES, root.taskQuality)
  ) {
    throw malformedEvidence('Candidate oracle is malformed');
  }
  return freezeData({
    kind: 'candidate',
    ordinaryArtifactDigest: root.ordinaryArtifactDigest,
    observedCandidateArtifactDigest: root.observedCandidateArtifactDigest,
    qualityEvidenceDigest: root.qualityEvidenceDigest,
    ...permission,
    taskQuality: root.taskQuality,
  });
}

function parseNoCandidateOracle(value: unknown): IntentCacheNoCandidateOracle {
  const root = snapshotDataRecord(value, NO_CANDIDATE_ORACLE_FIELDS);
  const permission = parsePermissionOracle(root);
  if (
    root.kind !== 'no-candidate' ||
    !isSha256Digest(root.ordinaryArtifactDigest) ||
    root.taskQuality !== 'not-evaluated'
  ) {
    throw malformedEvidence('No-candidate oracle is malformed');
  }
  const reference = parseNoCandidateReference(root.reference);
  if (
    reference.kind === 'none' &&
    permission.artifactRelation !== 'not-comparable'
  ) {
    throw malformedEvidence('Unreferenced oracle must be not-comparable');
  }
  return freezeData({
    kind: 'no-candidate',
    ordinaryArtifactDigest: root.ordinaryArtifactDigest,
    ...permission,
    taskQuality: 'not-evaluated',
    reference,
  }) as IntentCacheNoCandidateOracle;
}

function parseNoCandidateReference(
  value: unknown,
): IntentCacheNoCandidateReference {
  const kind = dataDiscriminator(value, 'kind');
  if (kind === 'none') {
    snapshotDataRecord(value, NO_REFERENCE_FIELDS);
    return Object.freeze({ kind });
  }
  if (kind === 'attested') {
    const root = snapshotDataRecord(value, ATTESTED_REFERENCE_FIELDS);
    if (
      !isSha256Digest(root.artifactDigest) ||
      typeof root.cacheKeyDigest !== 'string' ||
      !CACHE_KEY_HMAC.test(root.cacheKeyDigest)
    ) {
      throw malformedEvidence('Attested no-candidate reference is malformed');
    }
    return freezeData({
      kind,
      artifactDigest: root.artifactDigest,
      cacheKeyDigest: root.cacheKeyDigest as Extract<
        IntentCacheNoCandidateReference,
        { readonly kind: 'attested' }
      >['cacheKeyDigest'],
      entrySourceBinding: parseIntentCacheEntrySourceBinding(
        root.entrySourceBinding,
      ),
      operationBinding: parseIntentCacheOperationBinding(root.operationBinding),
    });
  }
  throw malformedEvidence('No-candidate reference is malformed');
}

function parseBypassOracle(
  value: unknown,
): IntentCacheNormalizationBypassOracle {
  const root = snapshotDataRecord(value, BYPASS_ORACLE_FIELDS);
  if (
    root.kind !== 'normalization-bypass' ||
    !isSha256Digest(root.ordinaryArtifactDigest) ||
    root.artifactRelation !== 'not-comparable'
  ) {
    throw malformedEvidence('Normalization-bypass oracle is malformed');
  }
  return freezeData({
    kind: 'normalization-bypass',
    ordinaryArtifactDigest: root.ordinaryArtifactDigest,
    artifactRelation: 'not-comparable',
    oracleOperation: parseOracleOperation(root.oracleOperation),
  });
}

function parseOracleOperation(value: unknown): IntentCacheOracleOperation {
  const kind = dataDiscriminator(value, 'kind');
  if (kind === 'none') {
    snapshotDataRecord(value, NO_ORACLE_OPERATION_FIELDS);
    return Object.freeze({ kind });
  }
  if (kind === 'attested') {
    const root = snapshotDataRecord(value, ATTESTED_ORACLE_OPERATION_FIELDS);
    return freezeData({
      kind,
      binding: parseIntentCacheOperationBinding(root.binding),
    });
  }
  throw malformedEvidence('Oracle operation is malformed');
}

function parsePermissionOracle(root: Readonly<Record<string, unknown>>): {
  readonly artifactRelation: IntentCacheArtifactRelation;
  readonly scope: IntentCacheCandidateOracle['scope'];
  readonly authorization: IntentCacheCandidateOracle['authorization'];
  readonly freshness: IntentCacheCandidateOracle['freshness'];
  readonly effectTier: IntentCacheCandidateOracle['effectTier'];
  readonly policy: IntentCacheCandidateOracle['policy'];
} {
  if (
    typeof root.artifactRelation !== 'string' ||
    !includesString(INTENT_CACHE_ARTIFACT_RELATIONS, root.artifactRelation) ||
    typeof root.scope !== 'string' ||
    !includesString(INTENT_CACHE_SCOPE_ORACLE_STATES, root.scope) ||
    typeof root.authorization !== 'string' ||
    !includesString(
      INTENT_CACHE_AUTHORIZATION_ORACLE_STATES,
      root.authorization,
    ) ||
    typeof root.freshness !== 'string' ||
    !includesString(INTENT_CACHE_FRESHNESS_ORACLE_STATES, root.freshness) ||
    typeof root.effectTier !== 'string' ||
    !includesString(INTENT_CACHE_EFFECT_TIER_ORACLE_STATES, root.effectTier) ||
    typeof root.policy !== 'string' ||
    !includesString(INTENT_CACHE_POLICY_ORACLE_STATES, root.policy)
  ) {
    throw malformedEvidence('Permission oracle is malformed');
  }
  return Object.freeze({
    artifactRelation: root.artifactRelation,
    scope: root.scope,
    authorization: root.authorization,
    freshness: root.freshness,
    effectTier: root.effectTier,
    policy: root.policy,
  });
}

function parseAttemptedOperation(
  value: unknown,
): IntentCachePromotionAttemptedOperation {
  const status = dataDiscriminator(value, 'status');
  if (status === 'unavailable') {
    snapshotDataRecord(value, UNAVAILABLE_OPERATION_FIELDS);
    return Object.freeze({ status });
  }
  if (status === 'observed') {
    const root = snapshotDataRecord(value, OBSERVED_OPERATION_FIELDS);
    return freezeData({
      status,
      binding: parseIntentCacheOperationBinding(root.binding),
    });
  }
  throw malformedEvidence('Attempted operation is malformed');
}

function parseFailure(value: unknown): IntentCachePromotionFailure {
  const root = snapshotDataRecord(value, FAILURE_FIELDS);
  if (
    typeof root.stage !== 'string' ||
    !includesString(INTENT_CACHE_PROMOTION_FAILURE_STAGES, root.stage) ||
    typeof root.reason !== 'string' ||
    !includesString(INTENT_CACHE_PROMOTION_FAILURE_REASONS, root.reason) ||
    !isSha256Digest(root.evidenceDigest)
  ) {
    throw malformedEvidence('Execution failure is malformed');
  }
  return Object.freeze({
    stage: root.stage,
    reason: root.reason,
    evidenceDigest: root.evidenceDigest,
  });
}

function parsePhenomena(
  value: unknown,
): readonly (typeof INTENT_CACHE_PROMOTION_PHENOMENA)[number][] {
  const values = snapshotDenseDataArray(
    value,
    0,
    INTENT_CACHE_PROMOTION_PHENOMENA.length,
  );
  if (
    values.some(
      (item) =>
        typeof item !== 'string' ||
        !includesString(INTENT_CACHE_PROMOTION_PHENOMENA, item),
    )
  ) {
    throw malformedEvidence('Adversarial phenomena are malformed');
  }
  const result =
    values as readonly (typeof INTENT_CACHE_PROMOTION_PHENOMENA)[number][];
  for (let index = 1; index < result.length; index += 1) {
    if (compareCodeUnits(result[index - 1]!, result[index]!) >= 0) {
      throw malformedEvidence('Adversarial phenomena are not canonical');
    }
  }
  return Object.freeze([...result]);
}

function parseClusterHmac(
  value: unknown,
): IntentCachePopulationEvidenceCase['clusterHmac'] {
  if (typeof value !== 'string' || !CLUSTER_HMAC.test(value)) {
    throw malformedEvidence('Population cluster HMAC is malformed');
  }
  return value as IntentCachePopulationEvidenceCase['clusterHmac'];
}

function parseEntrySourceBindingDocument(
  value: unknown,
): IntentCacheEntrySourceBinding {
  const root = snapshotDataRecord(value, ENTRY_SOURCE_BINDING_FIELDS);
  if (
    root.schema !== INTENT_CACHE_ENTRY_SOURCE_BINDING_SCHEMA ||
    !isSha256Digest(root.entryDigest) ||
    !isSha256Digest(root.valueDigest) ||
    typeof root.entrySourceHmac !== 'string' ||
    !SOURCE_HMAC.test(root.entrySourceHmac) ||
    !isSha256Digest(root.bindingDigest)
  ) {
    throw malformedEvidence('Entry-source binding is malformed');
  }
  return Object.freeze({
    schema: INTENT_CACHE_ENTRY_SOURCE_BINDING_SCHEMA,
    entryDigest: root.entryDigest,
    valueDigest: root.valueDigest,
    entrySourceHmac: root.entrySourceHmac as HmacIntentSourceDigest,
    bindingDigest: root.bindingDigest,
  });
}

function parseVerifiedNormalizationWitness(
  value: unknown,
): NormalizationWitness {
  const data = snapshotJsonData(value);
  const witness = parseNormalizationWitness(data);
  if (
    !verifyNormalizationWitnessIntegrity(witness).verified ||
    typeof witness.sourceDigest !== 'string' ||
    !SOURCE_HMAC.test(witness.sourceDigest)
  ) {
    throw malformedEvidence('Normalization witness is invalid');
  }
  return freezeData(witness);
}

function parseVerifiedCacheHitWitness(
  value: unknown,
  normalizationWitness: NormalizationWitness,
): CacheHitWitness {
  const data = snapshotJsonData(value);
  const witness = parseCacheHitWitness(data);
  if (!verifyCacheHitWitnessIntegrity(witness, normalizationWitness).verified) {
    throw malformedEvidence('Cache-hit witness is invalid');
  }
  return freezeData(witness);
}

function validateFixture(
  binding: IntentCachePromotionEvidenceBinding,
  cases: readonly IntentCachePromotionEvidenceCase[],
): void {
  const expectedTotal =
    binding.population.emitted + binding.adversarial.emitted;
  if (cases.length !== expectedTotal) {
    throw malformedEvidence('Evidence record count does not match binding');
  }
  const counts = {
    populationComplete: 0,
    populationFailure: 0,
    adversarialComplete: 0,
    adversarialFailure: 0,
  };
  const caseDigests = new Set<Sha256Digest>();
  const traceDigests = new Set<Sha256Digest>();
  const qualityDigests = new Set<Sha256Digest>();
  const clusters = new Set<string>();
  let previousKindRank = -1;
  for (const [index, item] of cases.entries()) {
    if (item.ordinal !== index) {
      throw malformedEvidence(
        'Evidence ordinals are not contiguous and ordered',
      );
    }
    const kindRank = caseKindRank(item.kind);
    if (kindRank < previousKindRank) {
      throw malformedEvidence('Evidence case kinds are not ordered');
    }
    previousKindRank = kindRank;
    if (caseDigests.has(item.caseDigest)) {
      throw malformedEvidence('Evidence contains duplicate case digests');
    }
    caseDigests.add(item.caseDigest);
    for (const observation of [item.usage.ordinary, item.usage.candidate]) {
      if (traceDigests.has(observation.traceDigest)) {
        throw malformedEvidence('Evidence contains duplicate trace digests');
      }
      traceDigests.add(observation.traceDigest);
    }
    if (
      item.usage.costModelDigest !== binding.evaluation.costModel.digest ||
      item.usage.currencyUnitDigest !== binding.evaluation.currencyUnitDigest
    ) {
      throw malformedEvidence('Usage contract does not match binding');
    }
    if (
      item.kind === 'population-complete' ||
      item.kind === 'population-failure'
    ) {
      if (clusters.has(item.clusterHmac)) {
        throw malformedEvidence(
          'Evidence contains duplicate population clusters',
        );
      }
      clusters.add(item.clusterHmac);
    }
    if (
      item.kind === 'population-complete' ||
      item.kind === 'adversarial-complete'
    ) {
      const qualityDigest = candidateQualityDigest(item.path);
      if (qualityDigest !== undefined) {
        if (qualityDigests.has(qualityDigest)) {
          throw malformedEvidence(
            'Evidence contains duplicate quality digests',
          );
        }
        qualityDigests.add(qualityDigest);
      }
      validateCompleteCaseBinding(binding, item);
    } else {
      validateFailureCaseBinding(binding, item);
    }
    if (item.kind === 'population-complete') counts.populationComplete += 1;
    if (item.kind === 'population-failure') counts.populationFailure += 1;
    if (item.kind === 'adversarial-complete') counts.adversarialComplete += 1;
    if (item.kind === 'adversarial-failure') counts.adversarialFailure += 1;
  }
  if (
    counts.populationComplete !== binding.population.complete ||
    counts.populationFailure !== binding.population.failed ||
    counts.adversarialComplete !== binding.adversarial.complete ||
    counts.adversarialFailure !== binding.adversarial.failed
  ) {
    throw malformedEvidence('Evidence cohort counters do not match records');
  }
  const populationCases = cases.filter(
    (item): item is IntentCachePopulationEvidenceCase =>
      item.kind.startsWith('population-'),
  );
  const adversarialCases = cases.filter(
    (item): item is IntentCacheAdversarialEvidenceCase =>
      item.kind.startsWith('adversarial-'),
  );
  if (
    digestIntentCachePromotionPopulationCorpus(
      populationCases.map((item) => item.caseDigest),
    ) !== binding.population.corpusDigest ||
    digestIntentCachePromotionAdversarialCorpus(
      adversarialCases.map((item) => item.caseDigest),
    ) !== binding.adversarial.corpusDigest
  ) {
    throw malformedEvidence('Evidence corpus digest mismatch');
  }
}

function validateCompleteCaseBinding(
  binding: IntentCachePromotionEvidenceBinding,
  item: Extract<
    IntentCachePromotionEvidenceCase,
    { readonly kind: 'population-complete' | 'adversarial-complete' }
  >,
): void {
  const sideEffect =
    item.kind === 'adversarial-complete' &&
    item.primaryScenario === 'side-effect';
  const probe = sideEffect ? item.probeOperation : undefined;
  if (probe !== undefined) validateProbeOperation(binding, probe);
  validateStoreFaultCoherence(item);

  const path = item.path;
  if (path.kind === 'candidate-bearing') {
    validateNormalizationContract(binding, path.normalizationWitness);
    validateExpectedOperation(binding, path.operationBinding, probe);
    validateCandidateCacheBindings(binding, path.cacheHitWitness);
    if (
      path.operationBinding.ontologyDigest !==
      path.normalizationWitness.ontology.digest
    ) {
      throw malformedEvidence('Candidate operation ontology mismatch');
    }
    return;
  }
  if (path.kind === 'normalized-no-candidate') {
    validateNormalizationContract(binding, path.normalizationWitness);
    validateLookupReceiptContract(binding, path.lookupReceipt);
    validateExpectedOperation(
      binding,
      path.lookupReceipt.observedOperationBinding,
      probe,
    );
    requireAccountingMatch(
      path.lookupReceipt.accounting,
      item.usage.accounting,
    );
    if (path.oracle.reference.kind === 'attested') {
      validateExpectedOperation(
        binding,
        path.oracle.reference.operationBinding,
        probe,
      );
    }
    return;
  }
  validateBypassReceiptContract(binding, path.receipt);
  requireAccountingMatch(path.receipt.accounting, item.usage.accounting);
  const oracleOperation = path.oracle.oracleOperation;
  if (oracleOperation.kind === 'attested') {
    validateExpectedOperation(binding, oracleOperation.binding, probe);
  }
  if (
    item.kind === 'adversarial-complete' &&
    oracleOperation.kind !== 'attested'
  ) {
    throw malformedEvidence(
      'Adversarial normalization bypass lacks an attested operation',
    );
  }
}

function validateStoreFaultCoherence(
  item: Extract<
    IntentCachePromotionEvidenceCase,
    { readonly kind: 'population-complete' | 'adversarial-complete' }
  >,
): void {
  const receiptShowsFault =
    item.path.kind === 'normalized-no-candidate' &&
    item.path.lookupReceipt.outcome === 'store-fault';
  const factsShowObservedFault =
    item.storeFault.kind === 'injected' &&
    item.storeFault.expectedFaultObserved;
  if (receiptShowsFault !== factsShowObservedFault) {
    throw malformedEvidence('Store-fault receipt and facts contradict');
  }
  if (
    item.kind === 'adversarial-complete' &&
    (item.primaryScenario === 'store-fault') !== receiptShowsFault
  ) {
    throw malformedEvidence('Store-fault scenario and receipt contradict');
  }
}

function validateFailureCaseBinding(
  binding: IntentCachePromotionEvidenceBinding,
  item: Extract<
    IntentCachePromotionEvidenceCase,
    { readonly kind: 'population-failure' | 'adversarial-failure' }
  >,
): void {
  const sideEffect =
    item.kind === 'adversarial-failure' &&
    item.primaryScenario === 'side-effect';
  const probe = sideEffect ? item.probeOperation : undefined;
  if (probe !== undefined) validateProbeOperation(binding, probe);
  if (item.attemptedOperation.status === 'observed') {
    validateExpectedOperation(binding, item.attemptedOperation.binding, probe);
  }
}

function validateProbeOperation(
  binding: IntentCachePromotionEvidenceBinding,
  probe: IntentCacheOperationBinding,
): void {
  if (
    probe.tier !== 'plan' ||
    probe.effect === 'read' ||
    probe.operation === binding.qualifiedOperation.operation ||
    probe.domain !== binding.qualifiedOperation.domain ||
    probe.operationRegistryDigest !==
      binding.intentContract.operationRegistry.digest ||
    probe.ontologyDigest !== binding.intentContract.ontology.digest
  ) {
    throw malformedEvidence('Side-effect probe operation is malformed');
  }
}

function validateExpectedOperation(
  binding: IntentCachePromotionEvidenceBinding,
  operation: IntentCacheOperationBinding,
  probe: IntentCacheOperationBinding | undefined,
): void {
  if (
    operation.operationRegistryDigest !==
      binding.intentContract.operationRegistry.digest ||
    operation.ontologyDigest !== binding.intentContract.ontology.digest
  ) {
    throw malformedEvidence('Operation contract mismatch');
  }
  if (probe !== undefined) {
    if (!sameOperationBinding(operation, probe)) {
      throw malformedEvidence('Side-effect probe binding mismatch');
    }
    return;
  }
  if (
    operation.operation !== binding.qualifiedOperation.operation ||
    operation.domain !== binding.qualifiedOperation.domain ||
    operation.effect !== 'read' ||
    operation.tier !== 'plan'
  ) {
    throw malformedEvidence('Qualified operation scope mismatch');
  }
}

function validateNormalizationContract(
  binding: IntentCachePromotionEvidenceBinding,
  witness: NormalizationWitness,
): void {
  if (
    !sameCanonical(witness.normalizer, binding.intentContract.normalizer) ||
    !sameCanonical(witness.ontology, binding.intentContract.ontology) ||
    witness.policyDigest !== binding.intentContract.normalizationPolicyDigest ||
    typeof witness.sourceDigest !== 'string' ||
    !SOURCE_HMAC.test(witness.sourceDigest)
  ) {
    throw malformedEvidence('Normalization contract mismatch');
  }
}

function validateLookupReceiptContract(
  binding: IntentCachePromotionEvidenceBinding,
  receipt: ReturnType<typeof parseIntentCacheLookupReceipt>,
): void {
  if (
    !sameCanonical(receipt.normalizer, binding.intentContract.normalizer) ||
    !sameCanonical(receipt.ontology, binding.intentContract.ontology) ||
    receipt.normalizationPolicyDigest !==
      binding.intentContract.normalizationPolicyDigest ||
    receipt.cacheAdmissionPolicyDigest !==
      binding.intentContract.cacheAdmissionPolicyDigest ||
    !sameCanonical(
      receipt.candidateIndex,
      binding.dependencies.candidateIndex,
    ) ||
    !sameCanonical(receipt.store, binding.dependencies.store)
  ) {
    throw malformedEvidence('Lookup receipt contract mismatch');
  }
}

function validateBypassReceiptContract(
  binding: IntentCachePromotionEvidenceBinding,
  receipt: IntentNormalizationBypassReceipt,
): void {
  if (
    !sameCanonical(receipt.normalizer, binding.intentContract.normalizer) ||
    !sameCanonical(receipt.ontology, binding.intentContract.ontology) ||
    receipt.normalizationPolicyDigest !==
      binding.intentContract.normalizationPolicyDigest ||
    receipt.cacheAdmissionPolicyDigest !==
      binding.intentContract.cacheAdmissionPolicyDigest
  ) {
    throw malformedEvidence('Normalization-bypass receipt contract mismatch');
  }
}

function validateCandidateCacheBindings(
  binding: IntentCachePromotionEvidenceBinding,
  witness: CacheHitWitness,
): void {
  validatePlanCacheBinding(binding, witness.entry.binding);
  validatePlanCacheBinding(binding, witness.lookup.binding);
  if (
    binding.dependencies.candidateIndex.status !== 'enabled' ||
    binding.dependencies.store.status !== 'enabled'
  ) {
    throw malformedEvidence('Candidate dependencies are disabled');
  }
}

function validatePlanCacheBinding(
  binding: IntentCachePromotionEvidenceBinding,
  cacheBinding: CacheBinding,
): void {
  if (
    cacheBinding.tier !== 'plan' ||
    !sameCanonical(
      cacheBinding.normalization.normalizer,
      binding.intentContract.normalizer,
    ) ||
    cacheBinding.normalization.policyDigest !==
      binding.intentContract.normalizationPolicyDigest ||
    cacheBinding.scope.cacheNamespace !== binding.scope.cacheNamespace ||
    cacheBinding.scope.tenant !== binding.scope.tenant ||
    cacheBinding.policyDigest !==
      binding.intentContract.cacheAdmissionPolicyDigest ||
    cacheBinding.dependencies.operationRegistryDigest !==
      binding.intentContract.operationRegistry.digest ||
    cacheBinding.dependencies.plannerDigest !==
      binding.dependencies.planner.artifact.digest ||
    cacheBinding.dependencies.toolRegistryDigest !==
      binding.dependencies.tool.artifact.digest
  ) {
    throw malformedEvidence('Cache binding contract mismatch');
  }
}

function requireAccountingMatch(
  receipt: IntentCacheAccountingBinding,
  usage: IntentCacheAccountingBinding,
): void {
  if (!sameCanonical(receipt, usage)) {
    throw malformedEvidence('Receipt accounting does not match usage');
  }
}

function candidateQualityDigest(
  path: IntentCachePromotionCompletePath,
): Sha256Digest | undefined {
  return path.kind === 'candidate-bearing'
    ? path.oracle.qualityEvidenceDigest
    : undefined;
}

function parseDependencyInventory(
  value: unknown,
): IntentCacheDependencyInventory {
  const root = snapshotDataRecord(value, DEPENDENCY_FIELDS);
  const inventory = Object.create(null) as Record<
    (typeof DEPENDENCY_FIELDS)[number],
    IntentCacheDependencyBinding
  >;
  for (const field of DEPENDENCY_FIELDS) {
    inventory[field] = parseDependencyBinding(root[field]);
  }
  return freezeData(inventory) as unknown as IntentCacheDependencyInventory;
}

function parseDependencyBinding(value: unknown): IntentCacheDependencyBinding {
  const root = snapshotDataRecord(value, DEPENDENCY_BINDING_FIELDS);
  if (
    typeof root.status !== 'string' ||
    !includesString(INTENT_CACHE_DEPENDENCY_STATUSES, root.status)
  ) {
    throw malformedEvidence('Dependency binding is malformed');
  }
  return freezeData({
    status: root.status,
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
    throw malformedEvidence('Bound artifact is malformed');
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
    throw malformedEvidence('Normalizer binding is malformed');
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
    throw malformedEvidence('Ontology binding is malformed');
  }
  return Object.freeze({
    id: root.id,
    version: root.version,
    digest: root.digest,
  });
}

function digestBinding(
  binding: IntentCachePromotionEvidenceBinding,
): Sha256Digest {
  const { bindingDigest: _bindingDigest, ...unsigned } = binding;
  return hashCanonical(toJsonValue(unsigned));
}

function digestCase(item: IntentCachePromotionEvidenceCase): Sha256Digest {
  const { caseDigest: _caseDigest, ...unsigned } = item;
  return hashCanonical(toJsonValue(unsigned));
}

function digestEntrySourceBinding(
  binding: IntentCacheEntrySourceBinding,
): Sha256Digest {
  const { bindingDigest: _bindingDigest, ...unsigned } = binding;
  return hashCanonical(toJsonValue(unsigned));
}

function digestCorpus(
  cohort: 'population' | 'adversarial',
  input: readonly Sha256Digest[],
): Sha256Digest {
  try {
    const values = snapshotDenseDataArray(
      input,
      0,
      MAX_INTENT_CACHE_PROMOTION_EVIDENCE_CASES,
    );
    if (values.some((value) => !isSha256Digest(value))) {
      throw malformedEvidence('Corpus case digests are malformed');
    }
    return hashCanonical({
      schema: `semwitness.dev/intent-cache-promotion-${cohort}-corpus/v1alpha1`,
      caseDigests: values as readonly Sha256Digest[],
    });
  } catch (error) {
    throw normalizeEvidenceError(error);
  }
}

function planOperationRegistryDigest(binding: CacheBinding): Sha256Digest {
  if (binding.tier !== 'plan') {
    throw malformedEvidence('Candidate cache tier is not plan');
  }
  return binding.dependencies.operationRegistryDigest;
}

function sameOperationBinding(
  left: IntentCacheOperationBinding,
  right: IntentCacheOperationBinding,
): boolean {
  return (
    left.bindingDigest === right.bindingDigest && sameCanonical(left, right)
  );
}

function sameCanonical(left: unknown, right: unknown): boolean {
  return hashCanonical(toJsonValue(left)) === hashCanonical(toJsonValue(right));
}

function caseKindRank(kind: IntentCachePromotionEvidenceCase['kind']): number {
  switch (kind) {
    case 'population-complete':
      return 0;
    case 'population-failure':
      return 1;
    case 'adversarial-complete':
      return 2;
    case 'adversarial-failure':
      return 3;
  }
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    !Object.is(value, -0) &&
    value >= 0
  );
}

function includesString<const Values extends readonly string[]>(
  values: Values,
  value: string,
): value is Values[number] {
  return (values as readonly string[]).includes(value);
}

function dataDiscriminator(value: unknown, field: string): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw malformedEvidence('Evidence record is malformed');
  }
  const prototype = Reflect.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw malformedEvidence('Evidence record is not data-only');
  }
  const descriptor = Reflect.getOwnPropertyDescriptor(value, field);
  if (
    descriptor === undefined ||
    !descriptor.enumerable ||
    !Object.hasOwn(descriptor, 'value') ||
    Object.hasOwn(descriptor, 'get') ||
    Object.hasOwn(descriptor, 'set')
  ) {
    throw malformedEvidence('Evidence discriminator is malformed');
  }
  return descriptor.value;
}

function snapshotJsonData(value: unknown): JsonValue {
  const seen = new Set<object>();
  const state = { items: 0 };
  const visit = (candidate: unknown, depth: number): JsonValue => {
    state.items += 1;
    if (state.items > MAX_SNAPSHOT_ITEMS || depth > MAX_SNAPSHOT_DEPTH) {
      throw malformedEvidence('Nested evidence exceeds data-only limits');
    }
    if (candidate === null || typeof candidate === 'boolean') return candidate;
    if (typeof candidate === 'string') {
      if (
        candidate.length > MAX_EVIDENCE_STRING_CODE_UNITS ||
        !isWellFormedUtf16(candidate)
      ) {
        throw malformedEvidence('Nested evidence string is malformed');
      }
      return candidate;
    }
    if (typeof candidate === 'number') {
      if (
        !Number.isFinite(candidate) ||
        (Number.isInteger(candidate) && !Number.isSafeInteger(candidate))
      ) {
        throw malformedEvidence('Nested evidence number is malformed');
      }
      return Object.is(candidate, -0) ? 0 : candidate;
    }
    if (candidate === null || typeof candidate !== 'object') {
      throw malformedEvidence('Nested evidence is not JSON data');
    }
    if (seen.has(candidate)) {
      throw malformedEvidence('Nested evidence is cyclic');
    }
    seen.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        const values = snapshotDenseDataArray(candidate, 0, MAX_SNAPSHOT_ITEMS);
        return Object.freeze(values.map((item) => visit(item, depth + 1)));
      }
      const prototype = Reflect.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) {
        throw malformedEvidence('Nested evidence has a custom prototype');
      }
      const keys = Reflect.ownKeys(candidate);
      if (keys.some((key) => typeof key !== 'string')) {
        throw malformedEvidence('Nested evidence has a symbol key');
      }
      const result: Record<string, JsonValue> = Object.create(null) as Record<
        string,
        JsonValue
      >;
      for (const key of (keys as string[]).sort(compareCodeUnits)) {
        const descriptor = Reflect.getOwnPropertyDescriptor(candidate, key);
        if (
          descriptor === undefined ||
          !descriptor.enumerable ||
          !Object.hasOwn(descriptor, 'value') ||
          Object.hasOwn(descriptor, 'get') ||
          Object.hasOwn(descriptor, 'set')
        ) {
          throw malformedEvidence('Nested evidence contains an accessor');
        }
        result[key] = visit(descriptor.value, depth + 1);
      }
      return Object.freeze(result);
    } finally {
      seen.delete(candidate);
    }
  };
  return visit(value, 0);
}

function decodeBoundedUtf8(source: string | Uint8Array): string {
  let text: string;
  if (typeof source === 'string') {
    if (!isWellFormedUtf16(source)) {
      throw malformedEvidence('Evidence contains malformed Unicode');
    }
    if (
      Buffer.byteLength(source, 'utf8') >
      MAX_INTENT_CACHE_PROMOTION_EVIDENCE_DOCUMENT_BYTES
    ) {
      throw malformedEvidence('Evidence document exceeds the byte limit');
    }
    text = source;
  } else if (source instanceof Uint8Array) {
    if (
      source.byteLength > MAX_INTENT_CACHE_PROMOTION_EVIDENCE_DOCUMENT_BYTES
    ) {
      throw malformedEvidence('Evidence document exceeds the byte limit');
    }
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(source);
    } catch {
      throw malformedEvidence('Evidence is not valid UTF-8');
    }
  } else {
    throw malformedEvidence('Evidence input must be text or UTF-8 bytes');
  }
  if (text.includes('\uFEFF')) {
    throw malformedEvidence('Evidence must not contain a byte-order mark');
  }
  return text;
}

function isWellFormedUtf16(value: string): boolean {
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

function blankJsonlLine(value: string): boolean {
  const line = value.endsWith('\r') ? value.slice(0, -1) : value;
  return line.trim().length === 0;
}

function assertJsonlRecordLimit(value: string): void {
  const maximumRecords = MAX_INTENT_CACHE_PROMOTION_EVIDENCE_CASES + 1;
  let records = 1;
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 0x0a || index === value.length - 1) {
      continue;
    }
    records += 1;
    if (records > maximumRecords) {
      throw malformedEvidence('Evidence exceeds the case limit');
    }
  }
}

function freezeData<T>(value: T): T {
  return immutableJson(toJsonValue(value)) as T;
}

function malformedEvidence(message: string): SemWitnessError {
  return new SemWitnessError(
    'MALFORMED_ENVELOPE',
    `Intent cache promotion evidence is malformed: ${message}`,
  );
}

function normalizeEvidenceError(error: unknown): SemWitnessError {
  if (error instanceof SemWitnessError && error.code === 'MALFORMED_ENVELOPE') {
    return error;
  }
  return malformedEvidence('strict validation failed');
}
