import type { Sha256Digest } from '../domain/types.js';
import type {
  CacheKeyDigest,
  HmacIntentSourceDigest,
  IntentEffect,
  NormalizerBinding,
  OntologyBinding,
} from '../intent/types.js';

export const INTENT_CACHE_PROMOTION_EVIDENCE_SCHEMA =
  'semwitness.dev/intent-cache-promotion-evidence/v1alpha1' as const;
export const INTENT_CACHE_PROMOTION_EVALUATION_REPORT_SCHEMA =
  'semwitness.dev/intent-cache-promotion-evaluation-report/v1alpha1' as const;
export const INTENT_CACHE_PROMOTION_WORKBENCH_RESULT_SCHEMA =
  'semwitness.dev/intent-cache-promotion-workbench-result/v1alpha1' as const;
export const INTENT_CACHE_SHADOW_QUALIFICATION_SCHEMA =
  'semwitness.dev/intent-cache-shadow-qualification/v1alpha1' as const;
export const INTENT_CACHE_OPERATION_BINDING_SCHEMA =
  'semwitness.dev/intent-cache-operation-binding/v1alpha1' as const;
export const INTENT_CACHE_LOOKUP_RECEIPT_SCHEMA =
  'semwitness.dev/intent-cache-lookup-receipt/v1alpha1' as const;
export const INTENT_NORMALIZATION_BYPASS_RECEIPT_SCHEMA =
  'semwitness.dev/intent-normalization-bypass-receipt/v1alpha1' as const;

/** The v1alpha1 qualification schema deliberately accepts only plan evidence. */
export const INTENT_CACHE_PROMOTION_TIERS = ['plan'] as const;
export type IntentCachePromotionTier =
  (typeof INTENT_CACHE_PROMOTION_TIERS)[number];

export const INTENT_CACHE_PROMOTION_COHORTS = [
  'population',
  'adversarial',
] as const;
export type IntentCachePromotionCohort =
  (typeof INTENT_CACHE_PROMOTION_COHORTS)[number];

export const INTENT_CACHE_PROMOTION_SOURCE_RELATIONS = [
  'exact-source',
  'normalized-intent',
] as const;
export type IntentCachePromotionSourceRelation =
  (typeof INTENT_CACHE_PROMOTION_SOURCE_RELATIONS)[number];

/** Frozen v1alpha1 population/adversarial difficulty strata. */
export const INTENT_CACHE_PROMOTION_DIFFICULTIES = [
  'simple',
  'medium',
  'complex',
  'adversarial',
] as const;
export type IntentCachePromotionDifficulty =
  (typeof INTENT_CACHE_PROMOTION_DIFFICULTIES)[number];

/** Frozen v1alpha1 cache-state strata. */
export const INTENT_CACHE_PROMOTION_CACHE_REGIMES = ['cold', 'warm'] as const;
export type IntentCachePromotionCacheRegime =
  (typeof INTENT_CACHE_PROMOTION_CACHE_REGIMES)[number];

/** Mandatory v1alpha1 conformance scenarios; none may enter statistical n. */
export const INTENT_CACHE_REQUIRED_ADVERSARIAL_SCENARIOS = [
  'equivalent-paraphrase',
  'distinct-near-miss',
  'cross-tenant',
  'authorization-drift',
  'context-drift',
  'stale',
  'dependency-drift',
  'side-effect',
  'store-fault',
] as const;
export type IntentCacheRequiredAdversarialScenario =
  (typeof INTENT_CACHE_REQUIRED_ADVERSARIAL_SCENARIOS)[number];

export const REQUIRED_INTENT_CACHE_QUALIFICATION_ADVERSARIAL_INTERSECTIONS =
  72 as const;
export const REQUIRED_INTENT_CACHE_QUALIFICATION_CRITICAL_INTERSECTIONS =
  8 as const;

export const INTENT_CACHE_ARTIFACT_RELATIONS = [
  'equivalent',
  'different',
  'not-comparable',
] as const;
export type IntentCacheArtifactRelation =
  (typeof INTENT_CACHE_ARTIFACT_RELATIONS)[number];

export const INTENT_CACHE_SCOPE_ORACLE_STATES = [
  'match',
  'mismatch',
  'unknown',
] as const;
export type IntentCacheScopeOracleState =
  (typeof INTENT_CACHE_SCOPE_ORACLE_STATES)[number];

export const INTENT_CACHE_AUTHORIZATION_ORACLE_STATES = [
  'current-allow',
  'deny',
  'unknown',
] as const;
export type IntentCacheAuthorizationOracleState =
  (typeof INTENT_CACHE_AUTHORIZATION_ORACLE_STATES)[number];

export const INTENT_CACHE_FRESHNESS_ORACLE_STATES = [
  'fresh',
  'stale',
  'unknown',
] as const;
export type IntentCacheFreshnessOracleState =
  (typeof INTENT_CACHE_FRESHNESS_ORACLE_STATES)[number];

export const INTENT_CACHE_EFFECT_TIER_ORACLE_STATES = [
  'allowed',
  'forbidden',
  'unknown',
] as const;
export type IntentCacheEffectTierOracleState =
  (typeof INTENT_CACHE_EFFECT_TIER_ORACLE_STATES)[number];

export const INTENT_CACHE_POLICY_ORACLE_STATES = [
  'allow',
  'deny',
  'unknown',
] as const;
export type IntentCachePolicyOracleState =
  (typeof INTENT_CACHE_POLICY_ORACLE_STATES)[number];

export const INTENT_CACHE_TASK_QUALITY_ORACLE_STATES = [
  'pass',
  'regression',
  'not-evaluated',
] as const;
export type IntentCacheTaskQualityOracleState =
  (typeof INTENT_CACHE_TASK_QUALITY_ORACLE_STATES)[number];

export interface IntentCacheOracleFacts {
  readonly artifactRelation: IntentCacheArtifactRelation;
  readonly scope: IntentCacheScopeOracleState;
  readonly authorization: IntentCacheAuthorizationOracleState;
  readonly freshness: IntentCacheFreshnessOracleState;
  readonly effectTier: IntentCacheEffectTierOracleState;
  readonly policy: IntentCachePolicyOracleState;
  readonly taskQuality: IntentCacheTaskQualityOracleState;
}

export type IntentCacheOperationHmac = `hmac-sha256:operation:${string}`;
export type IntentCacheDomainHmac = `hmac-sha256:intent-domain:${string}`;
export type IntentCacheClusterHmac = `hmac-sha256:cluster:${string}`;
export type IntentCacheRevocationHmac = `hmac-sha256:revocation:${string}`;
export type IntentCacheNamespaceHmac = `hmac-sha256:cache-namespace:${string}`;
export type IntentCacheTenantHmac = `hmac-sha256:tenant:${string}`;

export interface IntentCacheBoundArtifact {
  readonly id: string;
  readonly version: string;
  readonly digest: Sha256Digest;
}

export const INTENT_CACHE_DEPENDENCY_STATUSES = [
  'enabled',
  'disabled',
] as const;
export type IntentCacheDependencyStatus =
  (typeof INTENT_CACHE_DEPENDENCY_STATUSES)[number];

export interface IntentCacheDependencyBinding {
  readonly status: IntentCacheDependencyStatus;
  readonly artifact: IntentCacheBoundArtifact;
}

export interface IntentCacheDependencyInventory {
  readonly prompt: IntentCacheDependencyBinding;
  readonly tool: IntentCacheDependencyBinding;
  readonly planner: IntentCacheDependencyBinding;
  readonly provider: IntentCacheDependencyBinding;
  readonly model: IntentCacheDependencyBinding;
  readonly output: IntentCacheDependencyBinding;
  readonly safety: IntentCacheDependencyBinding;
  readonly personalization: IntentCacheDependencyBinding;
  readonly determinism: IntentCacheDependencyBinding;
  readonly tokenizer: IntentCacheDependencyBinding;
  readonly embedding: IntentCacheDependencyBinding;
  readonly candidateIndex: IntentCacheDependencyBinding;
  readonly store: IntentCacheDependencyBinding;
  readonly recordAuthentication: IntentCacheDependencyBinding;
  readonly freshness: IntentCacheDependencyBinding;
  readonly invalidation: IntentCacheDependencyBinding;
  readonly key: IntentCacheDependencyBinding;
}

export interface UnsignedIntentCacheOperationBinding {
  readonly schema: typeof INTENT_CACHE_OPERATION_BINDING_SCHEMA;
  readonly operation: IntentCacheOperationHmac;
  readonly domain: IntentCacheDomainHmac;
  readonly intentDigest: Sha256Digest;
  readonly tier: 'plan';
  readonly effect: IntentEffect;
  readonly operationRegistryDigest: Sha256Digest;
  readonly ontologyDigest: Sha256Digest;
}

export interface IntentCacheOperationBinding extends UnsignedIntentCacheOperationBinding {
  readonly bindingDigest: Sha256Digest;
}

export const INTENT_CACHE_ACCOUNTING_COMPLETENESS = [
  'complete',
  'incomplete',
] as const;
export type IntentCacheAccountingCompleteness =
  (typeof INTENT_CACHE_ACCOUNTING_COMPLETENESS)[number];
export type IntentCacheAccountingBinding =
  | {
      readonly completeness: 'complete';
    }
  | {
      readonly completeness: 'incomplete';
      readonly failureDigest: Sha256Digest;
    };

export type IntentCacheLookupDisposition =
  | {
      readonly outcome: 'miss';
      readonly reason: 'NO_CANDIDATE_FOUND';
      readonly storeAccess: 'attempted';
    }
  | {
      readonly outcome: 'policy-bypass';
      readonly reason:
        'ALPHA_EFFECT_FORBIDDEN' | 'POLICY_DENY' | 'NORMALIZATION_INELIGIBLE';
      readonly storeAccess: 'not-attempted';
    }
  | {
      readonly outcome: 'store-fault';
      readonly reason: 'EXPECTED_STORE_FAULT';
      readonly storeAccess: 'attempted';
    }
  | {
      readonly outcome: 'timeout';
      readonly reason: 'LOOKUP_TIMEOUT';
      readonly storeAccess: 'attempted';
    }
  | {
      readonly outcome: 'fallback';
      readonly reason: 'LOOKUP_FALLBACK';
      readonly storeAccess: 'attempted';
    };

export interface IntentCacheLookupReceiptBase {
  readonly schema: typeof INTENT_CACHE_LOOKUP_RECEIPT_SCHEMA;
  readonly mode: 'shadow';
  readonly applied: false;
  readonly sourceDigest: HmacIntentSourceDigest;
  readonly normalizer: NormalizerBinding;
  readonly ontology: OntologyBinding;
  readonly normalizationPolicyDigest: Sha256Digest;
  readonly cacheAdmissionPolicyDigest: Sha256Digest;
  readonly cacheKeyDigest: CacheKeyDigest;
  readonly observedOperationBinding: IntentCacheOperationBinding;
  readonly candidateIndex: IntentCacheDependencyBinding;
  readonly store: IntentCacheDependencyBinding;
  readonly accounting: IntentCacheAccountingBinding;
}

export type UnsignedIntentCacheLookupReceipt = IntentCacheLookupReceiptBase &
  IntentCacheLookupDisposition;

export type IntentCacheLookupReceipt = UnsignedIntentCacheLookupReceipt & {
  readonly receiptDigest: Sha256Digest;
};

export const INTENT_NORMALIZATION_BYPASS_REASONS = [
  'INTENT_NO_MATCH',
  'INTENT_COMPILER_FAILURE',
  'INTENT_REGISTRY_MISMATCH',
] as const;
export type IntentNormalizationBypassReason =
  (typeof INTENT_NORMALIZATION_BYPASS_REASONS)[number];

export interface UnsignedIntentNormalizationBypassReceipt {
  readonly schema: typeof INTENT_NORMALIZATION_BYPASS_RECEIPT_SCHEMA;
  readonly mode: 'shadow';
  readonly applied: false;
  readonly sourceDigest: HmacIntentSourceDigest;
  readonly normalizer: NormalizerBinding;
  readonly ontology: OntologyBinding;
  readonly normalizationPolicyDigest: Sha256Digest;
  readonly cacheAdmissionPolicyDigest: Sha256Digest;
  readonly reason: IntentNormalizationBypassReason;
  readonly accounting: IntentCacheAccountingBinding;
}

export interface IntentNormalizationBypassReceipt extends UnsignedIntentNormalizationBypassReceipt {
  readonly receiptDigest: Sha256Digest;
}

export interface IntentCacheQualifiedOperation {
  readonly operation: IntentCacheOperationHmac;
  readonly domain: IntentCacheDomainHmac;
  readonly independentNormalizedIntentWouldHits: number;
  readonly oraclePermittedEquivalentOpportunities: number;
  readonly normalizedIntentCoveragePpm: number;
}

export interface IntentCacheZeroFailureClaim {
  readonly failures: 0;
  readonly trials: number;
  readonly upperBound95Ppm: number;
  readonly ceilingPpm: number;
}

export interface IntentCacheFalseMissClaim {
  readonly missesOrBypasses: number;
  readonly oraclePermittedEquivalentOpportunities: number;
  readonly observedRatePpm: number;
}

/**
 * Unsigned evidence that one frozen semantic-cache bundle passed shadow gates.
 * It is deliberately not an activation credential and cannot authorize value
 * delivery in a future runtime.
 */
export interface IntentCacheShadowQualificationManifest {
  readonly schema: typeof INTENT_CACHE_SHADOW_QUALIFICATION_SCHEMA;
  readonly artifact: {
    readonly id: string;
    readonly version: string;
  };
  readonly provenance: 'host-attested-unsigned';
  readonly evidenceAuthentication: 'none';
  readonly producerIdentity: null;
  readonly activationCeiling: 'shadow-only';
  readonly validity: {
    readonly notBeforeEpochMs: number;
    readonly notAfterEpochMs: number;
    readonly revocationId: IntentCacheRevocationHmac;
  };
  readonly tier: IntentCachePromotionTier;
  readonly effect: 'read';
  readonly candidateOrigin: 'normalized-intent';
  readonly deploymentScopeDigest: Sha256Digest;
  readonly scope: {
    readonly cacheNamespace: IntentCacheNamespaceHmac;
    readonly tenant: IntentCacheTenantHmac;
    readonly domain: IntentCacheDomainHmac;
    readonly operation: IntentCacheQualifiedOperation;
  };
  readonly intentContract: {
    readonly intentIrSchema: 'semwitness.dev/intent-ir/v1alpha1';
    readonly ontology: OntologyBinding;
    readonly normalizer: NormalizerBinding;
    readonly operationRegistry: IntentCacheBoundArtifact;
    readonly resolver: IntentCacheBoundArtifact;
    readonly normalizationPolicyDigest: Sha256Digest;
    readonly cacheAdmissionPolicyDigest: Sha256Digest;
  };
  readonly dependencies: IntentCacheDependencyInventory;
  readonly population: {
    readonly populationFrameDigest: Sha256Digest;
    readonly corpusDigest: Sha256Digest;
    readonly sourceLogRootDigest: Sha256Digest;
    readonly samplingProtocolDigest: Sha256Digest;
    readonly inclusionPolicyDigest: Sha256Digest;
    readonly samplingWindowDigest: Sha256Digest;
    readonly attempted: number;
    readonly emitted: number;
    readonly dropped: 0;
    readonly complete: number;
    readonly failed: 0;
    readonly uniqueClusters: number;
    readonly exactSourceWouldHits: number;
    readonly normalizedIntentWouldHits: number;
    readonly misses: number;
    readonly bypasses: number;
  };
  readonly adversarial: {
    readonly corpusDigest: Sha256Digest;
    readonly coverageDigest: Sha256Digest;
    readonly expectedCases: number;
    readonly emittedCases: number;
    readonly failedCases: 0;
    readonly requiredIntersections: typeof REQUIRED_INTENT_CACHE_QUALIFICATION_ADVERSARIAL_INTERSECTIONS;
    readonly minimumCasesPerIntersection: number;
    readonly truthTableViolations: 0;
    readonly unexpectedExecutionFailures: 0;
  };
  readonly statisticalClaims: {
    readonly falseDiscoveryRate: IntentCacheZeroFailureClaim;
    readonly unsafeAdmissionRate: IntentCacheZeroFailureClaim;
    readonly falseMissRate: IntentCacheFalseMissClaim;
  };
  readonly value: {
    readonly medianNetSavingsRatioPpm: number;
    readonly aggregateNetSavingsRatioPpm: number;
    readonly p10NetSavingsRatioPpm: number;
    readonly maximumCaseNetRegressionRatioPpm: number;
    readonly criticalIntersectionsDigest: Sha256Digest;
    readonly criticalIntersections: typeof REQUIRED_INTENT_CACHE_QUALIFICATION_CRITICAL_INTERSECTIONS;
    readonly minimumCasesPerCriticalIntersection: number;
    readonly minimumWouldHitsPerCriticalIntersection: number;
    readonly minimumCriticalMedianNetSavingsRatioPpm: number;
    readonly minimumCriticalAggregateNetSavingsRatioPpm: number;
    readonly minimumCriticalP10NetSavingsRatioPpm: number;
    readonly maximumCriticalCaseNetRegressionRatioPpm: number;
  };
  readonly mandatoryBypassOverhead: {
    readonly medianCostOverheadRatioPpm: number;
    readonly aggregateCostOverheadRatioPpm: number;
    readonly medianLatencyOverheadRatioPpm: number;
    readonly aggregateLatencyOverheadRatioPpm: number;
  };
  readonly evidence: {
    readonly evaluationProtocolDigest: Sha256Digest;
    readonly evaluatorDigest: Sha256Digest;
    readonly oracleDigest: Sha256Digest;
    readonly costModelDigest: Sha256Digest;
    readonly accountingContractDigest: Sha256Digest;
    readonly reportDigest: Sha256Digest;
  };
}
