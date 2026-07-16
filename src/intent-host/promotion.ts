import { toJsonValue } from '../domain/canonical-json.js';
import { SemWitnessError } from '../domain/errors.js';
import { zeroFailureGateUpperBound95Ppm } from '../eval/binomial.js';
import { hashCanonical, isSha256Digest } from '../domain/hash.js';
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
  INTENT_CACHE_PROMOTION_TIERS,
  INTENT_CACHE_SHADOW_QUALIFICATION_SCHEMA,
  REQUIRED_INTENT_CACHE_QUALIFICATION_ADVERSARIAL_INTERSECTIONS,
  REQUIRED_INTENT_CACHE_QUALIFICATION_CRITICAL_INTERSECTIONS,
  type IntentCacheBoundArtifact,
  type IntentCacheDependencyInventory,
  type IntentCacheDomainHmac,
  type IntentCacheOperationHmac,
  type IntentCachePromotionTier,
  type IntentCacheQualifiedOperation,
  type IntentCacheShadowQualificationManifest,
} from './types.js';

export const INTENT_CACHE_SHADOW_QUALIFIER_ARTIFACT = Object.freeze({
  id: 'semwitness-intent-cache-shadow-qualifier',
  version: '1',
} as const);

export const MIN_INTENT_CACHE_QUALIFICATION_NET_SAVINGS_RATIO_PPM = 100_000;
export const MIN_INTENT_CACHE_QUALIFICATION_OPERATION_HITS = 25;
export const MIN_INTENT_CACHE_QUALIFICATION_OPERATION_COVERAGE_PPM = 100_000;
export const MIN_INTENT_CACHE_QUALIFICATION_CRITICAL_CELL_CASES = 5;
export const MIN_INTENT_CACHE_QUALIFICATION_CRITICAL_CELL_HITS = 5;
export const MIN_INTENT_CACHE_QUALIFICATION_ADVERSARIAL_CELL_CASES = 5;
export const MIN_INTENT_CACHE_QUALIFICATION_P10_NET_SAVINGS_RATIO_PPM = 0;
export const MAX_INTENT_CACHE_QUALIFICATION_CASE_NET_REGRESSION_RATIO_PPM = 500_000;
export const MAX_INTENT_CACHE_QUALIFICATION_BYPASS_OVERHEAD_RATIO_PPM = 250_000;
export const MAX_INTENT_CACHE_QUALIFICATION_FALSE_HIT_BOUND_PPM = 1_000;

const ROOT_FIELDS = [
  'schema',
  'artifact',
  'provenance',
  'evidenceAuthentication',
  'producerIdentity',
  'activationCeiling',
  'validity',
  'tier',
  'effect',
  'candidateOrigin',
  'deploymentScopeDigest',
  'scope',
  'intentContract',
  'dependencies',
  'population',
  'adversarial',
  'statisticalClaims',
  'value',
  'mandatoryBypassOverhead',
  'evidence',
] as const;
const ARTIFACT_FIELDS = ['id', 'version'] as const;
const BOUND_ARTIFACT_FIELDS = ['id', 'version', 'digest'] as const;
const NORMALIZER_FIELDS = [
  'id',
  'version',
  'artifactDigest',
  'configDigest',
] as const;
const ONTOLOGY_FIELDS = ['id', 'version', 'digest'] as const;
const VALIDITY_FIELDS = [
  'notBeforeEpochMs',
  'notAfterEpochMs',
  'revocationId',
] as const;
const SCOPE_FIELDS = [
  'cacheNamespace',
  'tenant',
  'domains',
  'operations',
] as const;
const OPERATION_FIELDS = [
  'operation',
  'domain',
  'independentNormalizedIntentWouldHits',
  'oraclePermittedEquivalentOpportunities',
  'normalizedIntentCoveragePpm',
] as const;
const INTENT_CONTRACT_FIELDS = [
  'intentIrSchema',
  'ontology',
  'normalizer',
  'operationRegistry',
  'resolver',
  'normalizationPolicyDigest',
  'cacheAdmissionPolicyDigest',
] as const;
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
const POPULATION_FIELDS = [
  'populationFrameDigest',
  'corpusDigest',
  'sourceLogRootDigest',
  'samplingProtocolDigest',
  'inclusionPolicyDigest',
  'samplingWindowDigest',
  'attempted',
  'emitted',
  'dropped',
  'complete',
  'failed',
  'uniqueClusters',
  'exactSourceWouldHits',
  'normalizedIntentWouldHits',
  'misses',
  'bypasses',
] as const;
const ADVERSARIAL_FIELDS = [
  'corpusDigest',
  'coverageDigest',
  'expectedCases',
  'emittedCases',
  'failedCases',
  'requiredIntersections',
  'minimumCasesPerIntersection',
  'truthTableViolations',
  'unexpectedExecutionFailures',
] as const;
const STATISTICAL_FIELDS = [
  'falseDiscoveryRate',
  'unsafeAdmissionRate',
  'falseMissRate',
] as const;
const ZERO_FAILURE_FIELDS = [
  'failures',
  'trials',
  'upperBound95Ppm',
  'ceilingPpm',
] as const;
const FALSE_MISS_FIELDS = [
  'missesOrBypasses',
  'oraclePermittedEquivalentOpportunities',
  'observedRatePpm',
] as const;
const VALUE_FIELDS = [
  'medianNetSavingsRatioPpm',
  'aggregateNetSavingsRatioPpm',
  'p10NetSavingsRatioPpm',
  'maximumCaseNetRegressionRatioPpm',
  'criticalIntersectionsDigest',
  'criticalIntersections',
  'minimumCasesPerCriticalIntersection',
  'minimumWouldHitsPerCriticalIntersection',
  'minimumCriticalMedianNetSavingsRatioPpm',
  'minimumCriticalAggregateNetSavingsRatioPpm',
  'minimumCriticalP10NetSavingsRatioPpm',
  'maximumCriticalCaseNetRegressionRatioPpm',
] as const;
const OVERHEAD_FIELDS = [
  'medianCostOverheadRatioPpm',
  'aggregateCostOverheadRatioPpm',
  'medianLatencyOverheadRatioPpm',
  'aggregateLatencyOverheadRatioPpm',
] as const;
const EVIDENCE_FIELDS = [
  'evaluationProtocolDigest',
  'evaluatorDigest',
  'oracleDigest',
  'costModelDigest',
  'accountingContractDigest',
  'reportDigest',
] as const;

const HEX_64 = '[a-f0-9]{64}';
const OPERATION_HMAC = new RegExp(`^hmac-sha256:operation:${HEX_64}$`, 'u');
const DOMAIN_HMAC = new RegExp(`^hmac-sha256:intent-domain:${HEX_64}$`, 'u');
const REVOCATION_HMAC = new RegExp(`^hmac-sha256:revocation:${HEX_64}$`, 'u');
const CACHE_NAMESPACE_HMAC = new RegExp(
  `^hmac-sha256:cache-namespace:${HEX_64}$`,
  'u',
);
const TENANT_HMAC = new RegExp(`^hmac-sha256:tenant:${HEX_64}$`, 'u');

export function parseIntentCacheShadowQualificationManifest(
  value: unknown,
): IntentCacheShadowQualificationManifest {
  try {
    return parseManifest(value);
  } catch {
    throw malformedManifest();
  }
}

export function digestIntentCacheShadowQualificationManifest(
  value: unknown,
): Sha256Digest {
  return hashCanonical(
    toJsonValue(parseIntentCacheShadowQualificationManifest(value)),
  );
}

function parseManifest(value: unknown): IntentCacheShadowQualificationManifest {
  const root = snapshotDataRecord(value, ROOT_FIELDS);
  const tier = parseTier(root.tier);
  if (
    root.schema !== INTENT_CACHE_SHADOW_QUALIFICATION_SCHEMA ||
    root.provenance !== 'host-attested-unsigned' ||
    root.evidenceAuthentication !== 'none' ||
    root.producerIdentity !== null ||
    root.activationCeiling !== 'shadow-only' ||
    root.effect !== 'read' ||
    root.candidateOrigin !== 'normalized-intent' ||
    !isSha256Digest(root.deploymentScopeDigest)
  ) {
    throw malformedManifest();
  }

  const artifact = parseIdentifierVersion(root.artifact);
  if (
    artifact.id !== INTENT_CACHE_SHADOW_QUALIFIER_ARTIFACT.id ||
    artifact.version !== INTENT_CACHE_SHADOW_QUALIFIER_ARTIFACT.version
  ) {
    throw malformedManifest();
  }

  const validity = parseValidity(root.validity);
  const scope = parseScope(root.scope);
  const intentContract = parseIntentContract(root.intentContract);
  const dependencies = parseDependencies(root.dependencies);
  const population = parsePopulation(root.population);
  const adversarial = parseAdversarial(root.adversarial);
  const statisticalClaims = parseStatisticalClaims(
    root.statisticalClaims,
    tier,
  );
  const valueSummary = parseValueSummary(root.value);
  const mandatoryBypassOverhead = parseOverhead(root.mandatoryBypassOverhead);
  const evidence = parseDigestRecord(root.evidence, EVIDENCE_FIELDS);

  const operationHitTotal = scope.operations.reduce(
    (total, item) => total + BigInt(item.independentNormalizedIntentWouldHits),
    0n,
  );
  const operationOpportunityTotal = scope.operations.reduce(
    (total, item) =>
      total + BigInt(item.oraclePermittedEquivalentOpportunities),
    0n,
  );
  if (
    operationHitTotal !== BigInt(population.normalizedIntentWouldHits) ||
    operationHitTotal !== BigInt(statisticalClaims.falseDiscoveryRate.trials) ||
    operationOpportunityTotal !==
      BigInt(
        statisticalClaims.falseMissRate.oraclePermittedEquivalentOpportunities,
      ) ||
    BigInt(
      statisticalClaims.falseMissRate.oraclePermittedEquivalentOpportunities,
    ) +
      BigInt(statisticalClaims.unsafeAdmissionRate.trials) >
      BigInt(population.uniqueClusters) ||
    BigInt(statisticalClaims.falseMissRate.missesOrBypasses) >
      BigInt(population.misses) + BigInt(population.bypasses) ||
    statisticalClaims.falseDiscoveryRate.trials > population.uniqueClusters ||
    statisticalClaims.unsafeAdmissionRate.trials > population.uniqueClusters ||
    statisticalClaims.falseDiscoveryRate.trials > population.complete ||
    statisticalClaims.unsafeAdmissionRate.trials > population.complete ||
    statisticalClaims.falseMissRate.oraclePermittedEquivalentOpportunities >
      population.complete
  ) {
    throw malformedManifest();
  }

  return Object.freeze({
    schema: INTENT_CACHE_SHADOW_QUALIFICATION_SCHEMA,
    artifact,
    provenance: 'host-attested-unsigned',
    evidenceAuthentication: 'none',
    producerIdentity: null,
    activationCeiling: 'shadow-only',
    validity,
    tier,
    effect: 'read',
    candidateOrigin: 'normalized-intent',
    deploymentScopeDigest: root.deploymentScopeDigest,
    scope,
    intentContract,
    dependencies,
    population,
    adversarial,
    statisticalClaims,
    value: valueSummary,
    mandatoryBypassOverhead,
    evidence,
  });
}

function parseValidity(value: unknown) {
  const root = snapshotDataRecord(value, VALIDITY_FIELDS);
  const notBeforeEpochMs = parseNonNegativeInteger(root.notBeforeEpochMs);
  const notAfterEpochMs = parsePositiveInteger(root.notAfterEpochMs);
  if (
    notBeforeEpochMs >= notAfterEpochMs ||
    typeof root.revocationId !== 'string' ||
    !REVOCATION_HMAC.test(root.revocationId)
  ) {
    throw malformedManifest();
  }
  return Object.freeze({
    notBeforeEpochMs,
    notAfterEpochMs,
    revocationId: root.revocationId as `hmac-sha256:revocation:${string}`,
  });
}

function parseScope(value: unknown) {
  const root = snapshotDataRecord(value, SCOPE_FIELDS);
  if (
    typeof root.cacheNamespace !== 'string' ||
    !CACHE_NAMESPACE_HMAC.test(root.cacheNamespace) ||
    typeof root.tenant !== 'string' ||
    !TENANT_HMAC.test(root.tenant)
  ) {
    throw malformedManifest();
  }
  const parsedDomains = parseUniqueSortedStrings(
    root.domains,
    1,
    1,
    DOMAIN_HMAC,
  ) as readonly IntentCacheDomainHmac[];
  const domains = Object.freeze([parsedDomains[0]!]) as readonly [
    IntentCacheDomainHmac,
  ];
  const parsedOperations = snapshotDenseDataArray(root.operations, 1, 1).map(
    parseQualifiedOperation,
  );
  const operations = Object.freeze([parsedOperations[0]!]) as readonly [
    IntentCacheQualifiedOperation,
  ];
  assertUniqueSortedOperations(operations);
  const domainSet = new Set(domains);
  if (
    operations.some((item) => !domainSet.has(item.domain)) ||
    domains.some(
      (domain) => !operations.some((operation) => operation.domain === domain),
    )
  ) {
    throw malformedManifest();
  }
  return Object.freeze({
    cacheNamespace:
      root.cacheNamespace as `hmac-sha256:cache-namespace:${string}`,
    tenant: root.tenant as `hmac-sha256:tenant:${string}`,
    domains,
    operations,
  });
}

function parseQualifiedOperation(
  value: unknown,
): IntentCacheQualifiedOperation {
  const root = snapshotDataRecord(value, OPERATION_FIELDS);
  if (
    typeof root.operation !== 'string' ||
    !OPERATION_HMAC.test(root.operation) ||
    typeof root.domain !== 'string' ||
    !DOMAIN_HMAC.test(root.domain)
  ) {
    throw malformedManifest();
  }
  const independentNormalizedIntentWouldHits = parsePositiveInteger(
    root.independentNormalizedIntentWouldHits,
  );
  const oraclePermittedEquivalentOpportunities = parsePositiveInteger(
    root.oraclePermittedEquivalentOpportunities,
  );
  const normalizedIntentCoveragePpm = parsePpm(
    root.normalizedIntentCoveragePpm,
  );
  if (
    independentNormalizedIntentWouldHits <
      MIN_INTENT_CACHE_QUALIFICATION_OPERATION_HITS ||
    independentNormalizedIntentWouldHits >
      oraclePermittedEquivalentOpportunities ||
    normalizedIntentCoveragePpm !==
      coverageRatioPpm(
        independentNormalizedIntentWouldHits,
        oraclePermittedEquivalentOpportunities,
      ) ||
    normalizedIntentCoveragePpm <
      MIN_INTENT_CACHE_QUALIFICATION_OPERATION_COVERAGE_PPM
  ) {
    throw malformedManifest();
  }
  return Object.freeze({
    operation: root.operation as IntentCacheOperationHmac,
    domain: root.domain as IntentCacheDomainHmac,
    independentNormalizedIntentWouldHits,
    oraclePermittedEquivalentOpportunities,
    normalizedIntentCoveragePpm,
  });
}

function parseIntentContract(value: unknown) {
  const root = snapshotDataRecord(value, INTENT_CONTRACT_FIELDS);
  if (
    root.intentIrSchema !== 'semwitness.dev/intent-ir/v1alpha1' ||
    !isSha256Digest(root.normalizationPolicyDigest) ||
    !isSha256Digest(root.cacheAdmissionPolicyDigest)
  ) {
    throw malformedManifest();
  }
  return Object.freeze({
    intentIrSchema: 'semwitness.dev/intent-ir/v1alpha1' as const,
    ontology: parseOntology(root.ontology),
    normalizer: parseNormalizer(root.normalizer),
    operationRegistry: parseBoundArtifact(root.operationRegistry),
    resolver: parseBoundArtifact(root.resolver),
    normalizationPolicyDigest: root.normalizationPolicyDigest,
    cacheAdmissionPolicyDigest: root.cacheAdmissionPolicyDigest,
  });
}

function parseDependencies(value: unknown): IntentCacheDependencyInventory {
  const root = snapshotDataRecord(value, DEPENDENCY_FIELDS);
  const result: Record<string, IntentCacheBoundArtifact> = Object.create(
    null,
  ) as Record<string, IntentCacheBoundArtifact>;
  for (const field of DEPENDENCY_FIELDS) {
    result[field] = parseBoundArtifact(root[field]);
  }
  return Object.freeze(result) as unknown as IntentCacheDependencyInventory;
}

function parsePopulation(value: unknown) {
  const root = snapshotDataRecord(value, POPULATION_FIELDS);
  for (const field of POPULATION_FIELDS.slice(0, 6)) {
    if (!isSha256Digest(root[field])) throw malformedManifest();
  }
  const attempted = parsePositiveInteger(root.attempted);
  const emitted = parsePositiveInteger(root.emitted);
  const complete = parseNonNegativeInteger(root.complete);
  const failed = parseNonNegativeInteger(root.failed);
  const uniqueClusters = parsePositiveInteger(root.uniqueClusters);
  const exactSourceWouldHits = parseNonNegativeInteger(
    root.exactSourceWouldHits,
  );
  const normalizedIntentWouldHits = parsePositiveInteger(
    root.normalizedIntentWouldHits,
  );
  const misses = parseNonNegativeInteger(root.misses);
  const bypasses = parseNonNegativeInteger(root.bypasses);
  if (
    root.dropped !== 0 ||
    attempted !== emitted ||
    failed !== 0 ||
    emitted !== complete ||
    complete !== uniqueClusters ||
    BigInt(exactSourceWouldHits) +
      BigInt(normalizedIntentWouldHits) +
      BigInt(misses) +
      BigInt(bypasses) !==
      BigInt(complete)
  ) {
    throw malformedManifest();
  }
  return Object.freeze({
    populationFrameDigest: root.populationFrameDigest as Sha256Digest,
    corpusDigest: root.corpusDigest as Sha256Digest,
    sourceLogRootDigest: root.sourceLogRootDigest as Sha256Digest,
    samplingProtocolDigest: root.samplingProtocolDigest as Sha256Digest,
    inclusionPolicyDigest: root.inclusionPolicyDigest as Sha256Digest,
    samplingWindowDigest: root.samplingWindowDigest as Sha256Digest,
    attempted,
    emitted,
    dropped: 0 as const,
    complete,
    failed: 0 as const,
    uniqueClusters,
    exactSourceWouldHits,
    normalizedIntentWouldHits,
    misses,
    bypasses,
  });
}

function parseAdversarial(value: unknown) {
  const root = snapshotDataRecord(value, ADVERSARIAL_FIELDS);
  if (
    !isSha256Digest(root.corpusDigest) ||
    !isSha256Digest(root.coverageDigest)
  ) {
    throw malformedManifest();
  }
  const expectedCases = parsePositiveInteger(root.expectedCases);
  const emittedCases = parsePositiveInteger(root.emittedCases);
  const requiredIntersections = parsePositiveInteger(
    root.requiredIntersections,
  );
  const minimumCasesPerIntersection = parsePositiveInteger(
    root.minimumCasesPerIntersection,
  );
  if (
    expectedCases !== emittedCases ||
    root.failedCases !== 0 ||
    root.truthTableViolations !== 0 ||
    root.unexpectedExecutionFailures !== 0 ||
    requiredIntersections !==
      REQUIRED_INTENT_CACHE_QUALIFICATION_ADVERSARIAL_INTERSECTIONS ||
    minimumCasesPerIntersection <
      MIN_INTENT_CACHE_QUALIFICATION_ADVERSARIAL_CELL_CASES ||
    BigInt(expectedCases) <
      BigInt(requiredIntersections) * BigInt(minimumCasesPerIntersection)
  ) {
    throw malformedManifest();
  }
  return Object.freeze({
    corpusDigest: root.corpusDigest,
    coverageDigest: root.coverageDigest,
    expectedCases,
    emittedCases,
    failedCases: 0 as const,
    requiredIntersections,
    minimumCasesPerIntersection,
    truthTableViolations: 0 as const,
    unexpectedExecutionFailures: 0 as const,
  });
}

function parseStatisticalClaims(
  value: unknown,
  tier: IntentCachePromotionTier,
) {
  const root = snapshotDataRecord(value, STATISTICAL_FIELDS);
  return Object.freeze({
    falseDiscoveryRate: parseZeroFailureClaim(root.falseDiscoveryRate, tier),
    unsafeAdmissionRate: parseZeroFailureClaim(root.unsafeAdmissionRate, tier),
    falseMissRate: parseFalseMissClaim(root.falseMissRate),
  });
}

function parseZeroFailureClaim(
  value: unknown,
  _tier: IntentCachePromotionTier,
) {
  const root = snapshotDataRecord(value, ZERO_FAILURE_FIELDS);
  const trials = parsePositiveInteger(root.trials);
  const upperBound95Ppm = parsePpm(root.upperBound95Ppm);
  const ceilingPpm = parsePpm(root.ceilingPpm);
  const expectedCeiling = MAX_INTENT_CACHE_QUALIFICATION_FALSE_HIT_BOUND_PPM;
  if (
    root.failures !== 0 ||
    upperBound95Ppm !== zeroFailureGateUpperBound95Ppm(0, trials) ||
    ceilingPpm !== expectedCeiling ||
    upperBound95Ppm > expectedCeiling
  ) {
    throw malformedManifest();
  }
  return Object.freeze({
    failures: 0 as const,
    trials,
    upperBound95Ppm,
    ceilingPpm,
  });
}

function parseFalseMissClaim(value: unknown) {
  const root = snapshotDataRecord(value, FALSE_MISS_FIELDS);
  const missesOrBypasses = parseNonNegativeInteger(root.missesOrBypasses);
  const oraclePermittedEquivalentOpportunities = parsePositiveInteger(
    root.oraclePermittedEquivalentOpportunities,
  );
  const observedRatePpm = parsePpm(root.observedRatePpm);
  if (
    missesOrBypasses > oraclePermittedEquivalentOpportunities ||
    observedRatePpm !==
      failureRatePpm(missesOrBypasses, oraclePermittedEquivalentOpportunities)
  ) {
    throw malformedManifest();
  }
  return Object.freeze({
    missesOrBypasses,
    oraclePermittedEquivalentOpportunities,
    observedRatePpm,
  });
}

function parseValueSummary(value: unknown) {
  const root = snapshotDataRecord(value, VALUE_FIELDS);
  const medianNetSavingsRatioPpm = parseSignedRatio(
    root.medianNetSavingsRatioPpm,
  );
  const aggregateNetSavingsRatioPpm = parseSignedRatio(
    root.aggregateNetSavingsRatioPpm,
  );
  const p10NetSavingsRatioPpm = parseSignedRatio(root.p10NetSavingsRatioPpm);
  const maximumCaseNetRegressionRatioPpm = parseNonNegativeRatio(
    root.maximumCaseNetRegressionRatioPpm,
  );
  const criticalIntersections = parsePositiveInteger(
    root.criticalIntersections,
  );
  const minimumCasesPerCriticalIntersection = parsePositiveInteger(
    root.minimumCasesPerCriticalIntersection,
  );
  const minimumWouldHitsPerCriticalIntersection = parsePositiveInteger(
    root.minimumWouldHitsPerCriticalIntersection,
  );
  const minimumCriticalMedianNetSavingsRatioPpm = parseSignedRatio(
    root.minimumCriticalMedianNetSavingsRatioPpm,
  );
  const minimumCriticalAggregateNetSavingsRatioPpm = parseSignedRatio(
    root.minimumCriticalAggregateNetSavingsRatioPpm,
  );
  const minimumCriticalP10NetSavingsRatioPpm = parseSignedRatio(
    root.minimumCriticalP10NetSavingsRatioPpm,
  );
  const maximumCriticalCaseNetRegressionRatioPpm = parseNonNegativeRatio(
    root.maximumCriticalCaseNetRegressionRatioPpm,
  );
  if (
    !isSha256Digest(root.criticalIntersectionsDigest) ||
    medianNetSavingsRatioPpm <
      MIN_INTENT_CACHE_QUALIFICATION_NET_SAVINGS_RATIO_PPM ||
    aggregateNetSavingsRatioPpm <
      MIN_INTENT_CACHE_QUALIFICATION_NET_SAVINGS_RATIO_PPM ||
    p10NetSavingsRatioPpm <
      MIN_INTENT_CACHE_QUALIFICATION_P10_NET_SAVINGS_RATIO_PPM ||
    maximumCaseNetRegressionRatioPpm >
      MAX_INTENT_CACHE_QUALIFICATION_CASE_NET_REGRESSION_RATIO_PPM ||
    criticalIntersections !==
      REQUIRED_INTENT_CACHE_QUALIFICATION_CRITICAL_INTERSECTIONS ||
    minimumCasesPerCriticalIntersection <
      MIN_INTENT_CACHE_QUALIFICATION_CRITICAL_CELL_CASES ||
    minimumWouldHitsPerCriticalIntersection <
      MIN_INTENT_CACHE_QUALIFICATION_CRITICAL_CELL_HITS ||
    minimumCriticalMedianNetSavingsRatioPpm <
      MIN_INTENT_CACHE_QUALIFICATION_NET_SAVINGS_RATIO_PPM ||
    minimumCriticalAggregateNetSavingsRatioPpm <
      MIN_INTENT_CACHE_QUALIFICATION_NET_SAVINGS_RATIO_PPM ||
    minimumCriticalP10NetSavingsRatioPpm <
      MIN_INTENT_CACHE_QUALIFICATION_P10_NET_SAVINGS_RATIO_PPM ||
    maximumCriticalCaseNetRegressionRatioPpm >
      MAX_INTENT_CACHE_QUALIFICATION_CASE_NET_REGRESSION_RATIO_PPM
  ) {
    throw malformedManifest();
  }
  return Object.freeze({
    medianNetSavingsRatioPpm,
    aggregateNetSavingsRatioPpm,
    p10NetSavingsRatioPpm,
    maximumCaseNetRegressionRatioPpm,
    criticalIntersectionsDigest: root.criticalIntersectionsDigest,
    criticalIntersections,
    minimumCasesPerCriticalIntersection,
    minimumWouldHitsPerCriticalIntersection,
    minimumCriticalMedianNetSavingsRatioPpm,
    minimumCriticalAggregateNetSavingsRatioPpm,
    minimumCriticalP10NetSavingsRatioPpm,
    maximumCriticalCaseNetRegressionRatioPpm,
  });
}

function parseOverhead(value: unknown) {
  const root = snapshotDataRecord(value, OVERHEAD_FIELDS);
  const medianCostOverheadRatioPpm = parseSignedRatio(
    root.medianCostOverheadRatioPpm,
  );
  const aggregateCostOverheadRatioPpm = parseSignedRatio(
    root.aggregateCostOverheadRatioPpm,
  );
  const medianLatencyOverheadRatioPpm = parseSignedRatio(
    root.medianLatencyOverheadRatioPpm,
  );
  const aggregateLatencyOverheadRatioPpm = parseSignedRatio(
    root.aggregateLatencyOverheadRatioPpm,
  );
  if (
    [
      medianCostOverheadRatioPpm,
      aggregateCostOverheadRatioPpm,
      medianLatencyOverheadRatioPpm,
      aggregateLatencyOverheadRatioPpm,
    ].some(
      (ratio) =>
        ratio > MAX_INTENT_CACHE_QUALIFICATION_BYPASS_OVERHEAD_RATIO_PPM,
    )
  ) {
    throw malformedManifest();
  }
  return Object.freeze({
    medianCostOverheadRatioPpm,
    aggregateCostOverheadRatioPpm,
    medianLatencyOverheadRatioPpm,
    aggregateLatencyOverheadRatioPpm,
  });
}

function parseDigestRecord<const Fields extends readonly string[]>(
  value: unknown,
  fields: Fields,
): { readonly [Key in Fields[number]]: Sha256Digest } {
  const root = snapshotDataRecord(value, fields);
  const result: Record<string, Sha256Digest> = Object.create(null) as Record<
    string,
    Sha256Digest
  >;
  for (const field of fields) {
    const digest = root[field];
    if (!isSha256Digest(digest)) throw malformedManifest();
    result[field] = digest;
  }
  return Object.freeze(result) as {
    readonly [Key in Fields[number]]: Sha256Digest;
  };
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
    throw malformedManifest();
  }
  return Object.freeze({
    id: root.id,
    version: root.version,
    digest: root.digest,
  });
}

function parseNormalizer(value: unknown) {
  const root = snapshotDataRecord(value, NORMALIZER_FIELDS);
  if (
    typeof root.id !== 'string' ||
    !SAFE_IDENTIFIER_PATTERN.test(root.id) ||
    typeof root.version !== 'string' ||
    !SAFE_VERSION_PATTERN.test(root.version) ||
    !isSha256Digest(root.artifactDigest) ||
    !isSha256Digest(root.configDigest)
  ) {
    throw malformedManifest();
  }
  return Object.freeze({
    id: root.id,
    version: root.version,
    artifactDigest: root.artifactDigest,
    configDigest: root.configDigest,
  });
}

function parseOntology(value: unknown) {
  const root = snapshotDataRecord(value, ONTOLOGY_FIELDS);
  if (
    typeof root.id !== 'string' ||
    !SAFE_IDENTIFIER_PATTERN.test(root.id) ||
    typeof root.version !== 'string' ||
    !SAFE_VERSION_PATTERN.test(root.version) ||
    !isSha256Digest(root.digest)
  ) {
    throw malformedManifest();
  }
  return Object.freeze({
    id: root.id,
    version: root.version,
    digest: root.digest,
  });
}

function parseIdentifierVersion(value: unknown) {
  const root = snapshotDataRecord(value, ARTIFACT_FIELDS);
  if (
    typeof root.id !== 'string' ||
    !SAFE_IDENTIFIER_PATTERN.test(root.id) ||
    typeof root.version !== 'string' ||
    !SAFE_VERSION_PATTERN.test(root.version)
  ) {
    throw malformedManifest();
  }
  return Object.freeze({ id: root.id, version: root.version });
}

function parseTier(value: unknown): IntentCachePromotionTier {
  if (
    typeof value !== 'string' ||
    !(INTENT_CACHE_PROMOTION_TIERS as readonly string[]).includes(value)
  ) {
    throw malformedManifest();
  }
  return value as IntentCachePromotionTier;
}

function parseUniqueSortedStrings(
  value: unknown,
  minimum: number,
  maximum: number,
  pattern: RegExp,
): readonly string[] {
  const values = snapshotDenseDataArray(value, minimum, maximum);
  const result = values.map((item) => {
    if (typeof item !== 'string' || !pattern.test(item)) {
      throw malformedManifest();
    }
    return item;
  });
  for (let index = 1; index < result.length; index += 1) {
    if (result[index - 1]! >= result[index]!) throw malformedManifest();
  }
  return result;
}

function assertUniqueSortedOperations(
  operations: readonly IntentCacheQualifiedOperation[],
): void {
  for (let index = 1; index < operations.length; index += 1) {
    if (operations[index - 1]!.operation >= operations[index]!.operation) {
      throw malformedManifest();
    }
  }
}

function parseNonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw malformedManifest();
  }
  return value as number;
}

function parsePositiveInteger(value: unknown): number {
  const parsed = parseNonNegativeInteger(value);
  if (parsed < 1) throw malformedManifest();
  return parsed;
}

function parsePpm(value: unknown): number {
  const parsed = parseNonNegativeInteger(value);
  if (parsed > 1_000_000) throw malformedManifest();
  return parsed;
}

function parseSignedRatio(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < -1_000_000 ||
    (value as number) > 1_000_000
  ) {
    throw malformedManifest();
  }
  return value as number;
}

function parseNonNegativeRatio(value: unknown): number {
  return parsePpm(value);
}

function coverageRatioPpm(numerator: number, denominator: number): number {
  return Number((BigInt(numerator) * 1_000_000n) / BigInt(denominator));
}

function failureRatePpm(numerator: number, denominator: number): number {
  return Number(
    (BigInt(numerator) * 1_000_000n + BigInt(denominator) - 1n) /
      BigInt(denominator),
  );
}

function malformedManifest(): SemWitnessError {
  return new SemWitnessError(
    'MALFORMED_ENVELOPE',
    'Intent cache shadow qualification manifest is malformed',
  );
}
