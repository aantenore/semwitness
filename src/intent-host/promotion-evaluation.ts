import { immutableJson, toJsonValue } from '../domain/canonical-json.js';
import { SemWitnessError } from '../domain/errors.js';
import { hashCanonical } from '../domain/hash.js';
import type { Sha256Digest } from '../domain/types.js';
import { zeroFailureGateUpperBound95Ppm } from '../eval/binomial.js';
import {
  INTENT_CACHE_SHADOW_QUALIFIER_ARTIFACT,
  MAX_INTENT_CACHE_QUALIFICATION_BYPASS_OVERHEAD_RATIO_PPM,
  MAX_INTENT_CACHE_QUALIFICATION_CASE_NET_REGRESSION_RATIO_PPM,
  MAX_INTENT_CACHE_QUALIFICATION_FALSE_HIT_BOUND_PPM,
  MIN_INTENT_CACHE_QUALIFICATION_ADVERSARIAL_CELL_CASES,
  MIN_INTENT_CACHE_QUALIFICATION_CRITICAL_CELL_CASES,
  MIN_INTENT_CACHE_QUALIFICATION_CRITICAL_CELL_HITS,
  MIN_INTENT_CACHE_QUALIFICATION_NET_SAVINGS_RATIO_PPM,
  MIN_INTENT_CACHE_QUALIFICATION_OPERATION_COVERAGE_PPM,
  MIN_INTENT_CACHE_QUALIFICATION_OPERATION_HITS,
  MIN_INTENT_CACHE_QUALIFICATION_P10_NET_SAVINGS_RATIO_PPM,
  digestIntentCacheShadowQualificationManifest,
  parseIntentCacheShadowQualificationManifest,
} from './promotion.js';
import {
  summarizeIntentCachePromotionOverhead,
  summarizeIntentCachePromotionSavings,
  type IntentCachePromotionOverheadEvaluation,
  type IntentCachePromotionOverheadMetrics,
  type IntentCachePromotionSavingsEvaluation,
} from './promotion-metrics.js';
import {
  INTENT_CACHE_PROMOTION_CACHE_REGIMES,
  INTENT_CACHE_PROMOTION_DIFFICULTIES,
  INTENT_CACHE_PROMOTION_EVALUATION_REPORT_SCHEMA,
  INTENT_CACHE_PROMOTION_WORKBENCH_RESULT_SCHEMA,
  INTENT_CACHE_REQUIRED_ADVERSARIAL_SCENARIOS,
  INTENT_CACHE_SHADOW_QUALIFICATION_SCHEMA,
  REQUIRED_INTENT_CACHE_QUALIFICATION_ADVERSARIAL_INTERSECTIONS,
  REQUIRED_INTENT_CACHE_QUALIFICATION_CRITICAL_INTERSECTIONS,
  type IntentCacheAdversarialCompleteCase,
  type IntentCacheAdversarialEvidenceCase,
  type IntentCacheArtifactRelation,
  type IntentCacheAuthorizationOracleState,
  type IntentCacheEffectTierOracleState,
  type IntentCacheFreshnessOracleState,
  type IntentCacheNoCandidateOracle,
  type IntentCachePolicyOracleState,
  type IntentCachePopulationEvidenceCase,
  type IntentCachePromotionCacheRegime,
  type IntentCachePromotionCompletePath,
  type IntentCachePromotionDifficulty,
  type IntentCachePromotionEvidenceCase,
  type IntentCachePromotionEvidenceFixture,
  type IntentCachePromotionSourceRelation,
  type IntentCacheRequiredAdversarialScenario,
  type IntentCacheScopeOracleState,
  type IntentCacheShadowQualificationManifest,
  type IntentCacheTaskQualityOracleState,
} from './types.js';

export const INTENT_CACHE_PROMOTION_EVALUATOR_ARTIFACT = Object.freeze({
  id: 'semwitness-intent-cache-promotion-evaluator',
  version: '1',
} as const);

export const INTENT_CACHE_PROMOTION_GATE_REASONS = [
  'POPULATION_INCOMPLETE',
  'POPULATION_FAILURES',
  'DUPLICATE_POPULATION_CLUSTERS',
  'VALUE_ACCOUNTING_UNAVAILABLE',
  'UNSAFE_NORMALIZED_INTENT_HITS',
  'TASK_QUALITY_REGRESSIONS',
  'FALSE_DISCOVERY_BOUND_ABOVE_CEILING',
  'UNSAFE_ADMISSION_BOUND_ABOVE_CEILING',
  'INSUFFICIENT_OPERATION_HITS',
  'OPERATION_COVERAGE_BELOW_THRESHOLD',
  'GLOBAL_MEDIAN_NET_SAVINGS_BELOW_THRESHOLD',
  'GLOBAL_AGGREGATE_NET_SAVINGS_BELOW_THRESHOLD',
  'GLOBAL_P10_NET_SAVINGS_BELOW_FLOOR',
  'GLOBAL_CASE_REGRESSION_ABOVE_THRESHOLD',
  'CRITICAL_CELL_MISSING',
  'CRITICAL_CELL_CASES_BELOW_MINIMUM',
  'CRITICAL_CELL_HITS_BELOW_MINIMUM',
  'CRITICAL_CELL_MEDIAN_VALUE_BELOW_THRESHOLD',
  'CRITICAL_CELL_AGGREGATE_VALUE_BELOW_THRESHOLD',
  'CRITICAL_CELL_P10_VALUE_BELOW_FLOOR',
  'CRITICAL_CELL_CASE_REGRESSION_ABOVE_THRESHOLD',
  'ADVERSARIAL_INCOMPLETE',
  'ADVERSARIAL_FAILURES',
  'ADVERSARIAL_CELL_CASES_BELOW_MINIMUM',
  'ADVERSARIAL_TRUTH_TABLE_VIOLATIONS',
  'STORE_FAULT_FAIL_CLOSED_VIOLATION',
  'SIDE_EFFECT_POLICY_BYPASS_VIOLATION',
  'BYPASS_CELL_MEDIAN_COST_OVERHEAD_ABOVE_THRESHOLD',
  'BYPASS_CELL_AGGREGATE_COST_OVERHEAD_ABOVE_THRESHOLD',
  'BYPASS_CELL_MEDIAN_LATENCY_OVERHEAD_ABOVE_THRESHOLD',
  'BYPASS_CELL_AGGREGATE_LATENCY_OVERHEAD_ABOVE_THRESHOLD',
] as const;

export type IntentCachePromotionGateReason =
  (typeof INTENT_CACHE_PROMOTION_GATE_REASONS)[number];

interface ZeroFailureReport {
  readonly failures: number;
  readonly trials: number;
  readonly upperBound95Ppm: number | null;
  readonly ceilingPpm: number;
}

interface FalseMissReport {
  readonly missesOrBypasses: number;
  readonly oraclePermittedEquivalentOpportunities: number;
  readonly observedRatePpm: number | null;
}

interface CriticalCellReport {
  readonly difficulty: IntentCachePromotionDifficulty;
  readonly cacheRegime: IntentCachePromotionCacheRegime;
  readonly evaluation: IntentCachePromotionSavingsEvaluation;
}

type AdversarialCellOverhead =
  | { readonly status: 'not-applicable' }
  | IntentCachePromotionOverheadEvaluation;

interface AdversarialCellReport {
  readonly primaryScenario: IntentCacheRequiredAdversarialScenario;
  readonly difficulty: IntentCachePromotionDifficulty;
  readonly cacheRegime: IntentCachePromotionCacheRegime;
  readonly emitted: number;
  readonly complete: number;
  readonly failed: number;
  readonly truthTableViolations: number;
  readonly overhead: AdversarialCellOverhead;
}

type MandatoryBypassOverheadSummary =
  | {
      readonly status: 'available';
      readonly basis: 'worst-required-cell';
      readonly metrics: IntentCachePromotionOverheadMetrics;
    }
  | {
      readonly status: 'unavailable';
      readonly basis: 'worst-required-cell';
      readonly reason: 'EMPTY_OR_INCOMPLETE_CELL';
    };

export interface IntentCachePromotionEvaluationReport {
  readonly schema: typeof INTENT_CACHE_PROMOTION_EVALUATION_REPORT_SCHEMA;
  readonly artifact: typeof INTENT_CACHE_PROMOTION_EVALUATOR_ARTIFACT;
  readonly provenance: 'host-attested-unsigned';
  readonly evidenceAuthentication: 'none';
  readonly producerIdentity: null;
  readonly activationCeiling: 'shadow-only';
  readonly independenceClaim: 'sampling-protocol-attested-only';
  readonly bindingDigest: Sha256Digest;
  readonly population: {
    readonly attempted: number;
    readonly emitted: number;
    readonly complete: number;
    readonly failed: number;
    readonly uniqueClusters: number;
    readonly exactSourceWouldHits: number;
    readonly normalizedIntentWouldHits: number;
    readonly misses: number;
    readonly bypasses: number;
  };
  readonly statisticalClaims: {
    readonly falseDiscoveryRate: ZeroFailureReport;
    readonly unsafeAdmissionRate: ZeroFailureReport;
    readonly falseMissRate: FalseMissReport;
  };
  readonly operationCoverage: {
    readonly safeNormalizedIntentWouldHits: number;
    readonly oraclePermittedEquivalentOpportunities: number;
    readonly observedCoveragePpm: number | null;
    readonly minimumHits: number;
    readonly minimumCoveragePpm: number;
  };
  readonly value: {
    readonly global: IntentCachePromotionSavingsEvaluation;
    readonly criticalIntersectionsDigest: Sha256Digest;
    readonly criticalIntersections: readonly CriticalCellReport[];
  };
  readonly adversarial: {
    readonly expected: number;
    readonly emitted: number;
    readonly complete: number;
    readonly failed: number;
    readonly requiredIntersections: number;
    readonly truthTableViolations: number;
    readonly unexpectedExecutionFailures: number;
    readonly intersections: readonly AdversarialCellReport[];
  };
  readonly mandatoryBypassOverhead: MandatoryBypassOverheadSummary;
  readonly gateReasons: readonly IntentCachePromotionGateReason[];
  readonly failureRefs: readonly {
    readonly reason: IntentCachePromotionGateReason;
    readonly caseDigests: readonly Sha256Digest[];
  }[];
}

export type IntentCachePromotionWorkbenchResult =
  | {
      readonly schema: typeof INTENT_CACHE_PROMOTION_WORKBENCH_RESULT_SCHEMA;
      readonly qualified: false;
      readonly report: IntentCachePromotionEvaluationReport;
      readonly reportDigest: Sha256Digest;
    }
  | {
      readonly schema: typeof INTENT_CACHE_PROMOTION_WORKBENCH_RESULT_SCHEMA;
      readonly qualified: true;
      readonly report: IntentCachePromotionEvaluationReport;
      readonly reportDigest: Sha256Digest;
      readonly qualification: IntentCacheShadowQualificationManifest;
      readonly qualificationDigest: Sha256Digest;
    };

interface OracleFacts {
  readonly artifactRelation: IntentCacheArtifactRelation;
  readonly scope: IntentCacheScopeOracleState;
  readonly authorization: IntentCacheAuthorizationOracleState;
  readonly freshness: IntentCacheFreshnessOracleState;
  readonly effectTier: IntentCacheEffectTierOracleState;
  readonly policy: IntentCachePolicyOracleState;
  readonly taskQuality: IntentCacheTaskQualityOracleState;
}

interface CaseDerivation {
  readonly sourceRelation: IntentCachePromotionSourceRelation | null;
  readonly wouldHit: boolean;
  readonly safeWouldHit: boolean;
  readonly unsafeOpportunity: boolean;
  readonly permissionSafeEquivalentOpportunity: boolean;
  readonly taskQualityRegression: boolean;
  readonly disposition: 'hit' | 'miss' | 'bypass';
  readonly oracle: OracleFacts | null;
}

const MAX_FAILURE_REFS_PER_REASON = 20;

/**
 * Evaluate an already strict-parsed fixture. The public package wrapper calls
 * the strict fixture parser before entering this derivation boundary.
 */
export function evaluateIntentCachePromotionEvidence(
  fixture: IntentCachePromotionEvidenceFixture,
): IntentCachePromotionWorkbenchResult {
  const populationCases = fixture.cases.filter(isPopulationCase);
  const adversarialCases = fixture.cases.filter(isAdversarialCase);
  const populationComplete = populationCases.filter(
    (item) => item.kind === 'population-complete',
  );
  const populationFailures = populationCases.filter(
    (item) => item.kind === 'population-failure',
  );
  const adversarialComplete = adversarialCases.filter(
    (item) => item.kind === 'adversarial-complete',
  );
  const adversarialFailures = adversarialCases.filter(
    (item) => item.kind === 'adversarial-failure',
  );
  const populationDerivations = populationComplete.map((item) => ({
    item,
    derived: deriveCompleteCase(item.path),
  }));
  const failureRefs = new Map<IntentCachePromotionGateReason, Sha256Digest[]>();
  for (const item of populationFailures) {
    addFailureRef(failureRefs, 'POPULATION_FAILURES', item.caseDigest);
  }

  const clusterCounts = new Map<string, number>();
  for (const item of populationCases) {
    const count = clusterCounts.get(item.clusterHmac) ?? 0;
    clusterCounts.set(item.clusterHmac, count + 1);
    if (count > 0) {
      addFailureRef(
        failureRefs,
        'DUPLICATE_POPULATION_CLUSTERS',
        item.caseDigest,
      );
    }
  }

  let exactSourceWouldHits = 0;
  let normalizedIntentWouldHits = 0;
  let misses = 0;
  let bypasses = 0;
  let unsafeNormalizedIntentHits = 0;
  let taskQualityRegressions = 0;
  let falseDiscoveryTrials = 0;
  let unsafeAdmissionTrials = 0;
  let unsafeAdmissionFailures = 0;
  let falseMissTrials = 0;
  let falseMissFailures = 0;
  let safeNormalizedIntentWouldHits = 0;

  for (const { item, derived } of populationDerivations) {
    if (derived.disposition === 'hit') {
      if (derived.sourceRelation === 'exact-source') {
        exactSourceWouldHits += 1;
      } else if (derived.sourceRelation === 'normalized-intent') {
        normalizedIntentWouldHits += 1;
      } else {
        throw malformedEvaluation();
      }
    } else if (derived.disposition === 'miss') {
      misses += 1;
    } else {
      bypasses += 1;
    }
    if (derived.sourceRelation === 'normalized-intent' && derived.wouldHit) {
      falseDiscoveryTrials += 1;
      if (!derived.safeWouldHit) {
        unsafeNormalizedIntentHits += 1;
        addFailureRef(
          failureRefs,
          'UNSAFE_NORMALIZED_INTENT_HITS',
          item.caseDigest,
        );
      } else {
        safeNormalizedIntentWouldHits += 1;
      }
      if (derived.taskQualityRegression) {
        taskQualityRegressions += 1;
        addFailureRef(failureRefs, 'TASK_QUALITY_REGRESSIONS', item.caseDigest);
      }
    }
    if (
      derived.sourceRelation === 'normalized-intent' &&
      derived.unsafeOpportunity
    ) {
      unsafeAdmissionTrials += 1;
      if (derived.wouldHit) unsafeAdmissionFailures += 1;
    }
    if (
      derived.sourceRelation === 'normalized-intent' &&
      derived.permissionSafeEquivalentOpportunity
    ) {
      falseMissTrials += 1;
      if (!derived.wouldHit) falseMissFailures += 1;
    }
  }

  const falseDiscoveryBound = zeroFailureGateUpperBound95Ppm(
    unsafeNormalizedIntentHits,
    falseDiscoveryTrials,
  );
  const unsafeAdmissionBound = zeroFailureGateUpperBound95Ppm(
    unsafeAdmissionFailures,
    unsafeAdmissionTrials,
  );
  const observedFalseMissRate = ratePpm(falseMissFailures, falseMissTrials);
  const operationCoverage = ratioPpm(
    safeNormalizedIntentWouldHits,
    falseMissTrials,
  );

  const populationValueCases = populationCases.map((item) => {
    const derivation =
      item.kind === 'population-complete'
        ? deriveCompleteCase(item.path)
        : null;
    return {
      usage: item.usage,
      creditPositiveSavings:
        derivation?.sourceRelation === 'normalized-intent' &&
        derivation.wouldHit &&
        derivation.safeWouldHit,
    };
  });
  const globalValue =
    summarizeIntentCachePromotionSavings(populationValueCases);
  const criticalIntersections = buildCriticalIntersections(populationCases);
  const criticalIntersectionsDigest = hashCanonical(
    toJsonValue(criticalIntersections),
  );

  const adversarialAnalysis = buildAdversarialIntersections(
    adversarialCases,
    failureRefs,
  );
  const mandatoryBypassOverhead = summarizeWorstOverhead(
    adversarialAnalysis.intersections,
  );
  for (const item of adversarialFailures) {
    addFailureRef(failureRefs, 'ADVERSARIAL_FAILURES', item.caseDigest);
  }

  const populationCompleteContract =
    fixture.binding.population.attempted ===
      fixture.binding.population.emitted &&
    fixture.binding.population.emitted === populationCases.length &&
    fixture.binding.population.complete === populationComplete.length &&
    fixture.binding.population.failed === populationFailures.length;
  const adversarialCompleteContract =
    fixture.binding.adversarial.expected ===
      fixture.binding.adversarial.emitted &&
    fixture.binding.adversarial.emitted === adversarialCases.length &&
    fixture.binding.adversarial.complete === adversarialComplete.length &&
    fixture.binding.adversarial.failed === adversarialFailures.length;
  const allAccountingAvailable =
    fixture.cases.every(
      (item) => item.usage.accounting.completeness === 'complete',
    ) &&
    globalValue.status === 'available' &&
    criticalIntersections.every(
      (item) => item.evaluation.status === 'available',
    ) &&
    mandatoryBypassOverhead.status === 'available';

  const gateSet = new Set<IntentCachePromotionGateReason>();
  if (!populationCompleteContract) gateSet.add('POPULATION_INCOMPLETE');
  if (populationFailures.length > 0) gateSet.add('POPULATION_FAILURES');
  if (clusterCounts.size !== populationCases.length) {
    gateSet.add('DUPLICATE_POPULATION_CLUSTERS');
  }
  if (!allAccountingAvailable) gateSet.add('VALUE_ACCOUNTING_UNAVAILABLE');
  if (unsafeNormalizedIntentHits > 0) {
    gateSet.add('UNSAFE_NORMALIZED_INTENT_HITS');
  }
  if (taskQualityRegressions > 0) gateSet.add('TASK_QUALITY_REGRESSIONS');
  if (
    falseDiscoveryBound === null ||
    falseDiscoveryBound > MAX_INTENT_CACHE_QUALIFICATION_FALSE_HIT_BOUND_PPM
  ) {
    gateSet.add('FALSE_DISCOVERY_BOUND_ABOVE_CEILING');
  }
  if (
    unsafeAdmissionBound === null ||
    unsafeAdmissionBound > MAX_INTENT_CACHE_QUALIFICATION_FALSE_HIT_BOUND_PPM
  ) {
    gateSet.add('UNSAFE_ADMISSION_BOUND_ABOVE_CEILING');
  }
  if (
    safeNormalizedIntentWouldHits <
    MIN_INTENT_CACHE_QUALIFICATION_OPERATION_HITS
  ) {
    gateSet.add('INSUFFICIENT_OPERATION_HITS');
  }
  if (
    operationCoverage === null ||
    operationCoverage < MIN_INTENT_CACHE_QUALIFICATION_OPERATION_COVERAGE_PPM
  ) {
    gateSet.add('OPERATION_COVERAGE_BELOW_THRESHOLD');
  }
  addValueGateReasons(gateSet, globalValue, criticalIntersections);
  if (!adversarialCompleteContract) gateSet.add('ADVERSARIAL_INCOMPLETE');
  if (adversarialFailures.length > 0) gateSet.add('ADVERSARIAL_FAILURES');
  addAdversarialGateReasons(
    gateSet,
    adversarialAnalysis.intersections,
    adversarialAnalysis.storeFaultViolations,
    adversarialAnalysis.sideEffectViolations,
  );
  addOverheadGateReasons(gateSet, adversarialAnalysis.intersections);
  const gateReasons = INTENT_CACHE_PROMOTION_GATE_REASONS.filter((reason) =>
    gateSet.has(reason),
  );

  const report = freezeJson<IntentCachePromotionEvaluationReport>({
    schema: INTENT_CACHE_PROMOTION_EVALUATION_REPORT_SCHEMA,
    artifact: INTENT_CACHE_PROMOTION_EVALUATOR_ARTIFACT,
    provenance: 'host-attested-unsigned',
    evidenceAuthentication: 'none',
    producerIdentity: null,
    activationCeiling: 'shadow-only',
    independenceClaim: 'sampling-protocol-attested-only',
    bindingDigest: fixture.binding.bindingDigest,
    population: {
      attempted: fixture.binding.population.attempted,
      emitted: populationCases.length,
      complete: populationComplete.length,
      failed: populationFailures.length,
      uniqueClusters: clusterCounts.size,
      exactSourceWouldHits,
      normalizedIntentWouldHits,
      misses,
      bypasses,
    },
    statisticalClaims: {
      falseDiscoveryRate: {
        failures: unsafeNormalizedIntentHits,
        trials: falseDiscoveryTrials,
        upperBound95Ppm: falseDiscoveryBound,
        ceilingPpm: MAX_INTENT_CACHE_QUALIFICATION_FALSE_HIT_BOUND_PPM,
      },
      unsafeAdmissionRate: {
        failures: unsafeAdmissionFailures,
        trials: unsafeAdmissionTrials,
        upperBound95Ppm: unsafeAdmissionBound,
        ceilingPpm: MAX_INTENT_CACHE_QUALIFICATION_FALSE_HIT_BOUND_PPM,
      },
      falseMissRate: {
        missesOrBypasses: falseMissFailures,
        oraclePermittedEquivalentOpportunities: falseMissTrials,
        observedRatePpm: observedFalseMissRate,
      },
    },
    operationCoverage: {
      safeNormalizedIntentWouldHits,
      oraclePermittedEquivalentOpportunities: falseMissTrials,
      observedCoveragePpm: operationCoverage,
      minimumHits: MIN_INTENT_CACHE_QUALIFICATION_OPERATION_HITS,
      minimumCoveragePpm: MIN_INTENT_CACHE_QUALIFICATION_OPERATION_COVERAGE_PPM,
    },
    value: {
      global: globalValue,
      criticalIntersectionsDigest,
      criticalIntersections,
    },
    adversarial: {
      expected: fixture.binding.adversarial.expected,
      emitted: adversarialCases.length,
      complete: adversarialComplete.length,
      failed: adversarialFailures.length,
      requiredIntersections:
        REQUIRED_INTENT_CACHE_QUALIFICATION_ADVERSARIAL_INTERSECTIONS,
      truthTableViolations: adversarialAnalysis.truthTableViolations,
      unexpectedExecutionFailures: adversarialAnalysis.unexpectedFailures,
      intersections: adversarialAnalysis.intersections,
    },
    mandatoryBypassOverhead,
    gateReasons,
    failureRefs: INTENT_CACHE_PROMOTION_GATE_REASONS.flatMap((reason) => {
      const caseDigests = failureRefs.get(reason);
      return caseDigests === undefined || caseDigests.length === 0
        ? []
        : [{ reason, caseDigests }];
    }),
  });
  const reportDigest = hashCanonical(toJsonValue(report));
  if (gateReasons.length > 0) {
    return freezeJson({
      schema: INTENT_CACHE_PROMOTION_WORKBENCH_RESULT_SCHEMA,
      qualified: false as const,
      report,
      reportDigest,
    });
  }

  const qualification = buildQualification(fixture, report, reportDigest);
  return freezeJson({
    schema: INTENT_CACHE_PROMOTION_WORKBENCH_RESULT_SCHEMA,
    qualified: true as const,
    report,
    reportDigest,
    qualification,
    qualificationDigest:
      digestIntentCacheShadowQualificationManifest(qualification),
  });
}

function deriveCompleteCase(
  path: IntentCachePromotionCompletePath,
): CaseDerivation {
  if (path.kind === 'normalization-bypass') {
    return Object.freeze({
      sourceRelation: null,
      wouldHit: false,
      safeWouldHit: false,
      unsafeOpportunity: false,
      permissionSafeEquivalentOpportunity: false,
      taskQualityRegression: false,
      disposition: 'bypass' as const,
      oracle: null,
    });
  }
  if (path.kind === 'candidate-bearing') {
    const oracle: OracleFacts = path.oracle;
    const sourceRelation = sourceRelationFromHmacs(
      path.entrySourceBinding.entrySourceHmac,
      path.normalizationWitness.sourceDigest,
    );
    const wouldHit = path.cacheHitWitness.decision.verdict === 'eligible';
    const safeWouldHit = isSafeCandidateOracle(oracle);
    return Object.freeze({
      sourceRelation,
      wouldHit,
      safeWouldHit,
      unsafeOpportunity: !safeWouldHit,
      permissionSafeEquivalentOpportunity: safeWouldHit,
      taskQualityRegression: oracle.taskQuality === 'regression',
      disposition: wouldHit ? ('hit' as const) : ('bypass' as const),
      oracle,
    });
  }

  const oracle = noCandidateFacts(path.oracle);
  const sourceRelation =
    path.oracle.reference.kind === 'attested'
      ? sourceRelationFromHmacs(
          path.oracle.reference.entrySourceBinding.entrySourceHmac,
          path.normalizationWitness.sourceDigest,
        )
      : null;
  const comparable = path.oracle.reference.kind === 'attested';
  const permissionSafeEquivalentOpportunity =
    comparable && isPermissionSafeEquivalent(oracle);
  return Object.freeze({
    sourceRelation,
    wouldHit: false,
    safeWouldHit: false,
    unsafeOpportunity: comparable && !permissionSafeEquivalentOpportunity,
    permissionSafeEquivalentOpportunity,
    taskQualityRegression: false,
    disposition:
      path.lookupReceipt.outcome === 'miss'
        ? ('miss' as const)
        : ('bypass' as const),
    oracle,
  });
}

function noCandidateFacts(oracle: IntentCacheNoCandidateOracle): OracleFacts {
  return {
    artifactRelation: oracle.artifactRelation,
    scope: oracle.scope,
    authorization: oracle.authorization,
    freshness: oracle.freshness,
    effectTier: oracle.effectTier,
    policy: oracle.policy,
    taskQuality: 'not-evaluated',
  };
}

function isSafeCandidateOracle(oracle: OracleFacts): boolean {
  return isPermissionSafeEquivalent(oracle) && oracle.taskQuality === 'pass';
}

function isPermissionSafeEquivalent(oracle: OracleFacts): boolean {
  return (
    oracle.artifactRelation === 'equivalent' &&
    oracle.scope === 'match' &&
    oracle.authorization === 'current-allow' &&
    oracle.freshness === 'fresh' &&
    oracle.effectTier === 'allowed' &&
    oracle.policy === 'allow'
  );
}

function sourceRelationFromHmacs(
  entrySourceHmac: string,
  lookupSourceHmac: string,
): IntentCachePromotionSourceRelation {
  return entrySourceHmac === lookupSourceHmac
    ? 'exact-source'
    : 'normalized-intent';
}

function buildCriticalIntersections(
  cases: readonly IntentCachePopulationEvidenceCase[],
): readonly CriticalCellReport[] {
  return Object.freeze(
    INTENT_CACHE_PROMOTION_DIFFICULTIES.flatMap((difficulty) =>
      INTENT_CACHE_PROMOTION_CACHE_REGIMES.map((cacheRegime) => {
        const cellCases = cases.filter(
          (item) =>
            item.difficulty === difficulty && item.cacheRegime === cacheRegime,
        );
        return Object.freeze({
          difficulty,
          cacheRegime,
          evaluation: summarizeIntentCachePromotionSavings(
            cellCases.map((item) => {
              const derived =
                item.kind === 'population-complete'
                  ? deriveCompleteCase(item.path)
                  : null;
              return {
                usage: item.usage,
                creditPositiveSavings:
                  derived?.sourceRelation === 'normalized-intent' &&
                  derived.wouldHit &&
                  derived.safeWouldHit,
              };
            }),
          ),
        });
      }),
    ),
  );
}

function buildAdversarialIntersections(
  cases: readonly IntentCacheAdversarialEvidenceCase[],
  failureRefs: Map<IntentCachePromotionGateReason, Sha256Digest[]>,
): {
  readonly intersections: readonly AdversarialCellReport[];
  readonly truthTableViolations: number;
  readonly storeFaultViolations: number;
  readonly sideEffectViolations: number;
  readonly unexpectedFailures: number;
} {
  let truthTableViolations = 0;
  let storeFaultViolations = 0;
  let sideEffectViolations = 0;
  let unexpectedFailures = 0;
  const intersections: AdversarialCellReport[] = [];

  for (const primaryScenario of INTENT_CACHE_REQUIRED_ADVERSARIAL_SCENARIOS) {
    for (const difficulty of INTENT_CACHE_PROMOTION_DIFFICULTIES) {
      for (const cacheRegime of INTENT_CACHE_PROMOTION_CACHE_REGIMES) {
        const cell = cases.filter(
          (item) =>
            item.primaryScenario === primaryScenario &&
            item.difficulty === difficulty &&
            item.cacheRegime === cacheRegime,
        );
        const complete = cell.filter(
          (item): item is IntentCacheAdversarialCompleteCase =>
            item.kind === 'adversarial-complete',
        );
        let cellTruthViolations = 0;
        for (const item of complete) {
          const pass = adversarialTruthTablePass(item);
          if (!pass) {
            cellTruthViolations += 1;
            truthTableViolations += 1;
            addFailureRef(
              failureRefs,
              'ADVERSARIAL_TRUTH_TABLE_VIOLATIONS',
              item.caseDigest,
            );
          }
          if (primaryScenario === 'store-fault' && !pass) {
            storeFaultViolations += 1;
            addFailureRef(
              failureRefs,
              'STORE_FAULT_FAIL_CLOSED_VIOLATION',
              item.caseDigest,
            );
          }
          if (primaryScenario === 'side-effect' && !pass) {
            sideEffectViolations += 1;
            addFailureRef(
              failureRefs,
              'SIDE_EFFECT_POLICY_BYPASS_VIOLATION',
              item.caseDigest,
            );
          }
          if (
            item.storeFault.kind === 'injected' &&
            item.storeFault.unexpectedExecutionFailure
          ) {
            unexpectedFailures += 1;
          }
        }
        intersections.push(
          Object.freeze({
            primaryScenario,
            difficulty,
            cacheRegime,
            emitted: cell.length,
            complete: complete.length,
            failed: cell.length - complete.length,
            truthTableViolations: cellTruthViolations,
            overhead:
              primaryScenario === 'equivalent-paraphrase'
                ? Object.freeze({ status: 'not-applicable' as const })
                : summarizeIntentCachePromotionOverhead(
                    cell.map((item) => item.usage),
                  ),
          }),
        );
      }
    }
  }
  return Object.freeze({
    intersections: Object.freeze(intersections),
    truthTableViolations,
    storeFaultViolations,
    sideEffectViolations,
    unexpectedFailures,
  });
}

function adversarialTruthTablePass(
  item: IntentCacheAdversarialCompleteCase,
): boolean {
  const derived = deriveCompleteCase(item.path);
  if (item.primaryScenario === 'equivalent-paraphrase') {
    return (
      item.storeFault.kind === 'not-injected' &&
      derived.sourceRelation === 'normalized-intent' &&
      derived.wouldHit &&
      derived.safeWouldHit
    );
  }
  if (item.primaryScenario === 'side-effect') {
    return (
      item.storeFault.kind === 'not-injected' &&
      item.path.kind === 'normalized-no-candidate' &&
      item.path.lookupReceipt.outcome === 'policy-bypass' &&
      item.path.lookupReceipt.reason === 'ALPHA_EFFECT_FORBIDDEN' &&
      item.path.lookupReceipt.storeAccess === 'not-attempted' &&
      !derived.wouldHit
    );
  }
  if (item.primaryScenario === 'store-fault') {
    return (
      item.path.kind === 'normalized-no-candidate' &&
      item.path.lookupReceipt.outcome === 'store-fault' &&
      item.path.lookupReceipt.reason === 'EXPECTED_STORE_FAULT' &&
      item.storeFault.kind === 'injected' &&
      item.storeFault.expectedFaultObserved &&
      item.storeFault.ordinaryPathSucceeded &&
      item.storeFault.candidateFallbackSucceeded &&
      !item.storeFault.unexpectedExecutionFailure &&
      !derived.wouldHit
    );
  }
  if (
    item.storeFault.kind !== 'not-injected' ||
    derived.sourceRelation !== 'normalized-intent' ||
    derived.wouldHit ||
    derived.oracle === null
  ) {
    return false;
  }
  switch (item.primaryScenario) {
    case 'distinct-near-miss':
      return derived.oracle.artifactRelation === 'different';
    case 'cross-tenant':
    case 'context-drift':
      return derived.oracle.scope === 'mismatch';
    case 'authorization-drift':
      return derived.oracle.authorization === 'deny';
    case 'stale':
      return derived.oracle.freshness === 'stale';
    case 'dependency-drift':
      return (
        derived.oracle.policy === 'deny' &&
        item.phenomena.some((value) =>
          [
            'invalidation-drift',
            'model-drift',
            'policy-drift',
            'resolver-drift',
            'tool-drift',
          ].includes(value),
        )
      );
    default:
      return false;
  }
}

function summarizeWorstOverhead(
  intersections: readonly AdversarialCellReport[],
): MandatoryBypassOverheadSummary {
  const required = intersections.filter(
    (item) => item.primaryScenario !== 'equivalent-paraphrase',
  );
  const evaluations = required
    .map((item) => item.overhead)
    .filter(
      (
        item,
      ): item is Extract<
        IntentCachePromotionOverheadEvaluation,
        { readonly status: 'available' }
      > => item.status === 'available',
    );
  if (evaluations.length !== required.length) {
    return Object.freeze({
      status: 'unavailable' as const,
      basis: 'worst-required-cell' as const,
      reason: 'EMPTY_OR_INCOMPLETE_CELL' as const,
    });
  }
  return Object.freeze({
    status: 'available' as const,
    basis: 'worst-required-cell' as const,
    metrics: Object.freeze({
      medianCostOverheadRatioPpm: Math.max(
        ...evaluations.map((item) => item.metrics.medianCostOverheadRatioPpm),
      ),
      aggregateCostOverheadRatioPpm: Math.max(
        ...evaluations.map(
          (item) => item.metrics.aggregateCostOverheadRatioPpm,
        ),
      ),
      medianLatencyOverheadRatioPpm: Math.max(
        ...evaluations.map(
          (item) => item.metrics.medianLatencyOverheadRatioPpm,
        ),
      ),
      aggregateLatencyOverheadRatioPpm: Math.max(
        ...evaluations.map(
          (item) => item.metrics.aggregateLatencyOverheadRatioPpm,
        ),
      ),
    }),
  });
}

function addValueGateReasons(
  gates: Set<IntentCachePromotionGateReason>,
  globalValue: IntentCachePromotionSavingsEvaluation,
  cells: readonly CriticalCellReport[],
): void {
  if (globalValue.status === 'available') {
    if (
      globalValue.metrics.medianNetSavingsRatioPpm <
      MIN_INTENT_CACHE_QUALIFICATION_NET_SAVINGS_RATIO_PPM
    ) {
      gates.add('GLOBAL_MEDIAN_NET_SAVINGS_BELOW_THRESHOLD');
    }
    if (
      globalValue.metrics.aggregateNetSavingsRatioPpm <
      MIN_INTENT_CACHE_QUALIFICATION_NET_SAVINGS_RATIO_PPM
    ) {
      gates.add('GLOBAL_AGGREGATE_NET_SAVINGS_BELOW_THRESHOLD');
    }
    if (
      globalValue.metrics.p10NetSavingsRatioPpm <
      MIN_INTENT_CACHE_QUALIFICATION_P10_NET_SAVINGS_RATIO_PPM
    ) {
      gates.add('GLOBAL_P10_NET_SAVINGS_BELOW_FLOOR');
    }
    if (
      globalValue.metrics.maximumCaseNetRegressionRatioPpm >
      MAX_INTENT_CACHE_QUALIFICATION_CASE_NET_REGRESSION_RATIO_PPM
    ) {
      gates.add('GLOBAL_CASE_REGRESSION_ABOVE_THRESHOLD');
    }
  }
  for (const cell of cells) {
    const evaluation = cell.evaluation;
    if (evaluation.caseCount === 0) {
      gates.add('CRITICAL_CELL_MISSING');
      continue;
    }
    if (
      evaluation.caseCount < MIN_INTENT_CACHE_QUALIFICATION_CRITICAL_CELL_CASES
    ) {
      gates.add('CRITICAL_CELL_CASES_BELOW_MINIMUM');
    }
    if (
      evaluation.safeNormalizedIntentWouldHits <
      MIN_INTENT_CACHE_QUALIFICATION_CRITICAL_CELL_HITS
    ) {
      gates.add('CRITICAL_CELL_HITS_BELOW_MINIMUM');
    }
    if (evaluation.status !== 'available') continue;
    if (
      evaluation.metrics.medianNetSavingsRatioPpm <
      MIN_INTENT_CACHE_QUALIFICATION_NET_SAVINGS_RATIO_PPM
    ) {
      gates.add('CRITICAL_CELL_MEDIAN_VALUE_BELOW_THRESHOLD');
    }
    if (
      evaluation.metrics.aggregateNetSavingsRatioPpm <
      MIN_INTENT_CACHE_QUALIFICATION_NET_SAVINGS_RATIO_PPM
    ) {
      gates.add('CRITICAL_CELL_AGGREGATE_VALUE_BELOW_THRESHOLD');
    }
    if (
      evaluation.metrics.p10NetSavingsRatioPpm <
      MIN_INTENT_CACHE_QUALIFICATION_P10_NET_SAVINGS_RATIO_PPM
    ) {
      gates.add('CRITICAL_CELL_P10_VALUE_BELOW_FLOOR');
    }
    if (
      evaluation.metrics.maximumCaseNetRegressionRatioPpm >
      MAX_INTENT_CACHE_QUALIFICATION_CASE_NET_REGRESSION_RATIO_PPM
    ) {
      gates.add('CRITICAL_CELL_CASE_REGRESSION_ABOVE_THRESHOLD');
    }
  }
}

function addAdversarialGateReasons(
  gates: Set<IntentCachePromotionGateReason>,
  cells: readonly AdversarialCellReport[],
  storeFaultViolations: number,
  sideEffectViolations: number,
): void {
  if (
    cells.some(
      (cell) =>
        cell.complete < MIN_INTENT_CACHE_QUALIFICATION_ADVERSARIAL_CELL_CASES,
    )
  ) {
    gates.add('ADVERSARIAL_CELL_CASES_BELOW_MINIMUM');
  }
  if (cells.some((cell) => cell.truthTableViolations > 0)) {
    gates.add('ADVERSARIAL_TRUTH_TABLE_VIOLATIONS');
  }
  if (storeFaultViolations > 0) {
    gates.add('STORE_FAULT_FAIL_CLOSED_VIOLATION');
  }
  if (sideEffectViolations > 0) {
    gates.add('SIDE_EFFECT_POLICY_BYPASS_VIOLATION');
  }
}

function addOverheadGateReasons(
  gates: Set<IntentCachePromotionGateReason>,
  cells: readonly AdversarialCellReport[],
): void {
  const metrics = cells.flatMap((cell) =>
    cell.overhead.status === 'available' ? [cell.overhead.metrics] : [],
  );
  if (
    metrics.some(
      (item) =>
        item.medianCostOverheadRatioPpm >
        MAX_INTENT_CACHE_QUALIFICATION_BYPASS_OVERHEAD_RATIO_PPM,
    )
  ) {
    gates.add('BYPASS_CELL_MEDIAN_COST_OVERHEAD_ABOVE_THRESHOLD');
  }
  if (
    metrics.some(
      (item) =>
        item.aggregateCostOverheadRatioPpm >
        MAX_INTENT_CACHE_QUALIFICATION_BYPASS_OVERHEAD_RATIO_PPM,
    )
  ) {
    gates.add('BYPASS_CELL_AGGREGATE_COST_OVERHEAD_ABOVE_THRESHOLD');
  }
  if (
    metrics.some(
      (item) =>
        item.medianLatencyOverheadRatioPpm >
        MAX_INTENT_CACHE_QUALIFICATION_BYPASS_OVERHEAD_RATIO_PPM,
    )
  ) {
    gates.add('BYPASS_CELL_MEDIAN_LATENCY_OVERHEAD_ABOVE_THRESHOLD');
  }
  if (
    metrics.some(
      (item) =>
        item.aggregateLatencyOverheadRatioPpm >
        MAX_INTENT_CACHE_QUALIFICATION_BYPASS_OVERHEAD_RATIO_PPM,
    )
  ) {
    gates.add('BYPASS_CELL_AGGREGATE_LATENCY_OVERHEAD_ABOVE_THRESHOLD');
  }
}

function buildQualification(
  fixture: IntentCachePromotionEvidenceFixture,
  report: IntentCachePromotionEvaluationReport,
  reportDigest: Sha256Digest,
): IntentCacheShadowQualificationManifest {
  const globalValue = requireSavings(report.value.global);
  const criticalMetrics = report.value.criticalIntersections.map(
    (cell) => requireSavings(cell.evaluation).metrics,
  );
  const overhead = report.mandatoryBypassOverhead;
  if (
    overhead.status !== 'available' ||
    report.statisticalClaims.falseDiscoveryRate.failures !== 0 ||
    report.statisticalClaims.falseDiscoveryRate.upperBound95Ppm === null ||
    report.statisticalClaims.unsafeAdmissionRate.failures !== 0 ||
    report.statisticalClaims.unsafeAdmissionRate.upperBound95Ppm === null ||
    report.statisticalClaims.falseMissRate.observedRatePpm === null ||
    report.operationCoverage.observedCoveragePpm === null
  ) {
    throw malformedEvaluation();
  }
  const manifest: IntentCacheShadowQualificationManifest = {
    schema: INTENT_CACHE_SHADOW_QUALIFICATION_SCHEMA,
    artifact: INTENT_CACHE_SHADOW_QUALIFIER_ARTIFACT,
    provenance: 'host-attested-unsigned',
    evidenceAuthentication: 'none',
    producerIdentity: null,
    activationCeiling: 'shadow-only',
    validity: fixture.binding.validity,
    tier: 'plan',
    effect: 'read',
    candidateOrigin: 'normalized-intent',
    deploymentScopeDigest: fixture.binding.scope.deploymentScopeDigest,
    scope: {
      cacheNamespace: fixture.binding.scope.cacheNamespace,
      tenant: fixture.binding.scope.tenant,
      domain: fixture.binding.qualifiedOperation.domain,
      operation: {
        operation: fixture.binding.qualifiedOperation.operation,
        domain: fixture.binding.qualifiedOperation.domain,
        independentNormalizedIntentWouldHits:
          report.operationCoverage.safeNormalizedIntentWouldHits,
        oraclePermittedEquivalentOpportunities:
          report.operationCoverage.oraclePermittedEquivalentOpportunities,
        normalizedIntentCoveragePpm:
          report.operationCoverage.observedCoveragePpm,
      },
    },
    intentContract: {
      intentIrSchema: fixture.binding.intentContract.intentIrSchema,
      ontology: fixture.binding.intentContract.ontology,
      normalizer: fixture.binding.intentContract.normalizer,
      operationRegistry: fixture.binding.intentContract.operationRegistry,
      resolver: fixture.binding.intentContract.resolver,
      normalizationPolicyDigest:
        fixture.binding.intentContract.normalizationPolicyDigest,
      cacheAdmissionPolicyDigest:
        fixture.binding.intentContract.cacheAdmissionPolicyDigest,
    },
    dependencies: fixture.binding.dependencies,
    population: {
      populationFrameDigest: fixture.binding.population.populationFrameDigest,
      corpusDigest: fixture.binding.population.corpusDigest,
      sourceLogRootDigest: fixture.binding.population.sourceLogRootDigest,
      samplingProtocolDigest: fixture.binding.population.samplingProtocolDigest,
      inclusionPolicyDigest: fixture.binding.population.inclusionPolicyDigest,
      samplingWindowDigest: fixture.binding.population.samplingWindowDigest,
      attempted: report.population.attempted,
      emitted: report.population.emitted,
      dropped: 0,
      complete: report.population.complete,
      failed: 0,
      uniqueClusters: report.population.uniqueClusters,
      exactSourceWouldHits: report.population.exactSourceWouldHits,
      normalizedIntentWouldHits: report.population.normalizedIntentWouldHits,
      misses: report.population.misses,
      bypasses: report.population.bypasses,
    },
    adversarial: {
      corpusDigest: fixture.binding.adversarial.corpusDigest,
      coverageDigest: fixture.binding.adversarial.coverageDigest,
      expectedCases: report.adversarial.expected,
      emittedCases: report.adversarial.emitted,
      failedCases: 0,
      requiredIntersections:
        REQUIRED_INTENT_CACHE_QUALIFICATION_ADVERSARIAL_INTERSECTIONS,
      minimumCasesPerIntersection:
        MIN_INTENT_CACHE_QUALIFICATION_ADVERSARIAL_CELL_CASES,
      truthTableViolations: 0,
      unexpectedExecutionFailures: 0,
    },
    statisticalClaims: {
      falseDiscoveryRate: {
        failures: 0,
        trials: report.statisticalClaims.falseDiscoveryRate.trials,
        upperBound95Ppm:
          report.statisticalClaims.falseDiscoveryRate.upperBound95Ppm,
        ceilingPpm: MAX_INTENT_CACHE_QUALIFICATION_FALSE_HIT_BOUND_PPM,
      },
      unsafeAdmissionRate: {
        failures: 0,
        trials: report.statisticalClaims.unsafeAdmissionRate.trials,
        upperBound95Ppm:
          report.statisticalClaims.unsafeAdmissionRate.upperBound95Ppm,
        ceilingPpm: MAX_INTENT_CACHE_QUALIFICATION_FALSE_HIT_BOUND_PPM,
      },
      falseMissRate: {
        missesOrBypasses:
          report.statisticalClaims.falseMissRate.missesOrBypasses,
        oraclePermittedEquivalentOpportunities:
          report.statisticalClaims.falseMissRate
            .oraclePermittedEquivalentOpportunities,
        observedRatePpm: report.statisticalClaims.falseMissRate.observedRatePpm,
      },
    },
    value: {
      ...globalValue.metrics,
      criticalIntersectionsDigest: report.value.criticalIntersectionsDigest,
      criticalIntersections:
        REQUIRED_INTENT_CACHE_QUALIFICATION_CRITICAL_INTERSECTIONS,
      minimumCasesPerCriticalIntersection:
        MIN_INTENT_CACHE_QUALIFICATION_CRITICAL_CELL_CASES,
      minimumWouldHitsPerCriticalIntersection:
        MIN_INTENT_CACHE_QUALIFICATION_CRITICAL_CELL_HITS,
      minimumCriticalMedianNetSavingsRatioPpm: Math.min(
        ...criticalMetrics.map((item) => item.medianNetSavingsRatioPpm),
      ),
      minimumCriticalAggregateNetSavingsRatioPpm: Math.min(
        ...criticalMetrics.map((item) => item.aggregateNetSavingsRatioPpm),
      ),
      minimumCriticalP10NetSavingsRatioPpm: Math.min(
        ...criticalMetrics.map((item) => item.p10NetSavingsRatioPpm),
      ),
      maximumCriticalCaseNetRegressionRatioPpm: Math.max(
        ...criticalMetrics.map((item) => item.maximumCaseNetRegressionRatioPpm),
      ),
    },
    mandatoryBypassOverhead: overhead.metrics,
    evidence: {
      evaluationProtocolDigest:
        fixture.binding.evaluation.evaluationProtocolDigest,
      evaluatorDigest: fixture.binding.evaluation.evaluatorDigest,
      oracleDigest: fixture.binding.evaluation.oracleDigest,
      costModelDigest: fixture.binding.evaluation.costModel.digest,
      accountingContractDigest:
        fixture.binding.evaluation.accountingContractDigest,
      reportDigest,
    },
  };
  return parseIntentCacheShadowQualificationManifest(manifest);
}

function requireSavings(
  value: IntentCachePromotionSavingsEvaluation,
): Extract<
  IntentCachePromotionSavingsEvaluation,
  { readonly status: 'available' }
> {
  if (value.status !== 'available') throw malformedEvaluation();
  return value;
}

function ratioPpm(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return Number((BigInt(numerator) * 1_000_000n) / BigInt(denominator));
}

function ratePpm(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return Number(
    (BigInt(numerator) * 1_000_000n + BigInt(denominator) - 1n) /
      BigInt(denominator),
  );
}

function addFailureRef(
  refs: Map<IntentCachePromotionGateReason, Sha256Digest[]>,
  reason: IntentCachePromotionGateReason,
  caseDigest: Sha256Digest,
): void {
  const values = refs.get(reason) ?? [];
  if (values.length < MAX_FAILURE_REFS_PER_REASON) values.push(caseDigest);
  refs.set(reason, values);
}

function isPopulationCase(
  item: IntentCachePromotionEvidenceCase,
): item is IntentCachePopulationEvidenceCase {
  return item.kind.startsWith('population-');
}

function isAdversarialCase(
  item: IntentCachePromotionEvidenceCase,
): item is IntentCacheAdversarialEvidenceCase {
  return item.kind.startsWith('adversarial-');
}

function freezeJson<Value>(value: Value): Value {
  return immutableJson(toJsonValue(value)) as unknown as Value;
}

function malformedEvaluation(): SemWitnessError {
  return new SemWitnessError(
    'MALFORMED_ENVELOPE',
    'Intent cache promotion evidence is internally inconsistent',
  );
}
