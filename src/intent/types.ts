import type { JsonValue } from '../domain/canonical-json.js';
import type { Sha256Digest } from '../domain/types.js';

export const INTENT_SCHEMA = 'semwitness.dev/intent-ir/v1alpha1' as const;
export const NORMALIZATION_WITNESS_SCHEMA =
  'semwitness.dev/normalization-witness/v1alpha1' as const;
export const CACHE_HIT_WITNESS_SCHEMA =
  'semwitness.dev/cache-hit-witness/v1alpha1' as const;

export const INTENT_EFFECTS = ['read', 'write', 'irreversible'] as const;
export type IntentEffect = (typeof INTENT_EFFECTS)[number];

export const CACHE_TIERS = ['plan', 'observation', 'response'] as const;
export type CacheTier = (typeof CACHE_TIERS)[number];

export const INTENT_POLARITIES = ['affirm', 'negate'] as const;
export type IntentPolarity = (typeof INTENT_POLARITIES)[number];

export const CONSTRAINT_OPERATORS = [
  'eq',
  'neq',
  'lt',
  'lte',
  'gt',
  'gte',
  'contains',
  'not-contains',
] as const;
export type ConstraintOperator = (typeof CONSTRAINT_OPERATORS)[number];

export interface OntologyBinding {
  readonly id: string;
  readonly version: string;
  readonly digest: Sha256Digest;
}

export interface NormalizerBinding {
  readonly id: string;
  readonly version: string;
  readonly artifactDigest: Sha256Digest;
  readonly configDigest: Sha256Digest;
}

export interface IntentSlot {
  readonly name: string;
  readonly value: JsonValue;
}

export interface IntentConstraint {
  readonly path: string;
  readonly operator: ConstraintOperator;
  readonly value: JsonValue;
}

export type IntentTemporal =
  | { readonly kind: 'none' }
  | { readonly kind: 'as-of'; readonly instant: string }
  | {
      readonly kind: 'range';
      readonly start: string;
      readonly end: string;
    };

export interface IntentOutputContract {
  readonly format: string;
  readonly locale: string;
  readonly detail: string;
}

/**
 * A normalizer-produced, ontology-bound frame. It contains no original user
 * utterance. SemWitness canonicalizes this structure but does not infer it.
 */
export interface IntentIR {
  readonly schema: typeof INTENT_SCHEMA;
  readonly ontology: OntologyBinding;
  readonly goal: {
    readonly namespace: string;
    readonly action: string;
    readonly object: string;
    readonly polarity: IntentPolarity;
  };
  readonly slots: readonly IntentSlot[];
  readonly constraints: readonly IntentConstraint[];
  readonly temporal: IntentTemporal;
  readonly output: IntentOutputContract;
  readonly effect: IntentEffect;
}

export const SCOPE_DOMAINS = [
  'cache-namespace',
  'tenant',
  'principal',
  'authorization',
  'context',
] as const;
export type ScopeDomain = (typeof SCOPE_DOMAINS)[number];

/** A pseudonymous, domain-separated scope binding. */
export type HmacScopeDigest<Domain extends ScopeDomain = ScopeDomain> =
  `hmac-sha256:${Domain}:${string}`;

/** A deployment-keyed cache key; it is never an authorization credential. */
export type CacheKeyDigest = `hmac-sha256:cache-key:${string}`;

/** Keyed, scope-bound commitments for content-addressed cache artifacts. */
export type CacheEntryCommitment = `hmac-sha256:cache-entry:${string}`;
export type CacheValueCommitment = `hmac-sha256:cache-value:${string}`;

/** A keyed source fingerprint avoids equality leaks for low-entropy prompts. */
export type HmacIntentSourceDigest = `hmac-sha256:intent-source:${string}`;
export type IntentSourceDigest = Sha256Digest | HmacIntentSourceDigest;

export interface CacheBindingBase {
  readonly intentDigest: Sha256Digest;
  readonly normalization: {
    readonly normalizer: NormalizerBinding;
    readonly policyDigest: Sha256Digest;
    readonly minimumConfidencePpm: number;
  };
  readonly scope: {
    readonly cacheNamespace: HmacScopeDigest<'cache-namespace'>;
    readonly tenant: HmacScopeDigest<'tenant'>;
    readonly principal: HmacScopeDigest<'principal'>;
  };
  readonly authorizationDigest: HmacScopeDigest<'authorization'>;
  readonly contextDigest: HmacScopeDigest<'context'>;
  readonly policyDigest: Sha256Digest;
  readonly effect: IntentEffect;
}

export interface PlanDependencies {
  readonly operationRegistryDigest: Sha256Digest;
  readonly plannerDigest: Sha256Digest;
  readonly toolRegistryDigest: Sha256Digest;
}

export interface ObservationDependencies {
  readonly planDigest: Sha256Digest;
  readonly executionDigest: Sha256Digest;
  readonly toolDigest: Sha256Digest;
}

export interface ResponseDependencies {
  readonly observationValueDigest: Sha256Digest;
  readonly outputContractDigest: Sha256Digest;
  readonly promptDigest: Sha256Digest;
  readonly providerDigest: Sha256Digest;
  readonly modelDigest: Sha256Digest;
  readonly determinism: 'deterministic';
  readonly determinismDigest: Sha256Digest;
  readonly personalization: 'none';
  readonly personalizationDigest: Sha256Digest;
  readonly safety: 'cache-eligible';
  readonly safetyPolicyDigest: Sha256Digest;
}

export type CacheBinding =
  | (CacheBindingBase & {
      readonly tier: 'plan';
      readonly dependencies: PlanDependencies;
    })
  | (CacheBindingBase & {
      readonly tier: 'observation';
      readonly dependencies: ObservationDependencies;
    })
  | (CacheBindingBase & {
      readonly tier: 'response';
      readonly dependencies: ResponseDependencies;
    });

export interface RevisionBinding {
  readonly namespace: string;
  readonly digest: Sha256Digest;
}

export type CacheEntryFreshness =
  | {
      readonly kind: 'ttl';
      readonly createdAtEpochMs: number;
      readonly ttlMs: number;
    }
  | {
      readonly kind: 'revision-set';
      readonly revisions: readonly RevisionBinding[];
    };

export type CacheLookupFreshness =
  | { readonly kind: 'ttl'; readonly checkedAtEpochMs: number }
  | {
      readonly kind: 'revision-set';
      readonly revisions: readonly RevisionBinding[];
    };

export interface CacheEntry {
  readonly entryDigest: Sha256Digest;
  readonly valueDigest: Sha256Digest;
  readonly binding: CacheBinding;
  readonly freshness: CacheEntryFreshness;
}

export interface CacheLookup {
  readonly binding: CacheBinding;
  readonly freshness: CacheLookupFreshness;
}

export type CandidateEvidenceKind = 'embedding' | 'similarity';

/** Candidate evidence can nominate a frame; it can never authorize reuse. */
export interface CandidateEvidence {
  readonly kind: CandidateEvidenceKind;
  readonly providerId: string;
  readonly evidenceDigest: Sha256Digest;
  readonly scorePpm: number;
  readonly authoritative: false;
}

export const INTENT_REASON_CODES = [
  'INTENT_NORMALIZATION_ELIGIBLE',
  'INTENT_AMBIGUOUS',
  'INTENT_CONFIDENCE_LOW',
  'INTENT_NO_MATCH',
  'INTENT_COMPILER_FAILURE',
  'INTENT_REGISTRY_MISMATCH',
  'INTENT_MALFORMED',
  'INTENT_DOCUMENT_LIMIT',
  'INTENT_SOURCE_DIGEST_MISMATCH',
  'INTENT_DIGEST_MISMATCH',
  'INTENT_NORMALIZER_MISMATCH',
  'INTENT_POLICY_MISMATCH',
  'INTENT_WITNESS_TAMPERED',
  'CACHE_HIT_ELIGIBLE',
  'CACHE_NORMALIZATION_BYPASS',
  'CACHE_NORMALIZATION_WITNESS_INVALID',
  'CACHE_ENTRY_DIGEST_MISMATCH',
  'CACHE_INTENT_MISMATCH',
  'CACHE_NAMESPACE_MISMATCH',
  'CACHE_TENANT_MISMATCH',
  'CACHE_PRINCIPAL_MISMATCH',
  'CACHE_AUTHORIZATION_MISMATCH',
  'CACHE_CONTEXT_MISMATCH',
  'CACHE_NORMALIZER_MISMATCH',
  'CACHE_NORMALIZATION_POLICY_MISMATCH',
  'CACHE_OPERATION_REGISTRY_MISMATCH',
  'CACHE_PLANNER_MISMATCH',
  'CACHE_TOOL_REGISTRY_MISMATCH',
  'CACHE_PLAN_MISMATCH',
  'CACHE_TOOL_MISMATCH',
  'CACHE_EXECUTION_MISMATCH',
  'CACHE_OBSERVATION_MISMATCH',
  'CACHE_OUTPUT_CONTRACT_MISMATCH',
  'CACHE_PROMPT_MISMATCH',
  'CACHE_PROVIDER_MISMATCH',
  'CACHE_MODEL_MISMATCH',
  'CACHE_DETERMINISM_MISMATCH',
  'CACHE_PERSONALIZATION_MISMATCH',
  'CACHE_SAFETY_POLICY_MISMATCH',
  'CACHE_POLICY_MISMATCH',
  'CACHE_EFFECT_MISMATCH',
  'CACHE_TIER_MISMATCH',
  'CACHE_FRESHNESS_MODE_MISMATCH',
  'CACHE_STALE',
  'CACHE_REVISION_MISMATCH',
  'CACHE_TIER_EFFECT_FORBIDDEN',
  'CACHE_WITNESS_TAMPERED',
] as const;
export type IntentReasonCode = (typeof INTENT_REASON_CODES)[number];

export interface ShadowDecision {
  readonly verdict: 'eligible' | 'bypass';
  readonly applied: false;
  readonly reasons: readonly IntentReasonCode[];
}

export interface NormalizationWitness {
  readonly schema: typeof NORMALIZATION_WITNESS_SCHEMA;
  readonly mode: 'shadow';
  readonly sourceDigest: IntentSourceDigest;
  readonly intentDigest: Sha256Digest;
  readonly normalizer: NormalizerBinding;
  readonly ontology: OntologyBinding;
  readonly policyDigest: Sha256Digest;
  readonly assessment: {
    readonly ambiguous: boolean;
    readonly confidencePpm: number;
    readonly minimumConfidencePpm: number;
  };
  readonly candidateEvidence: readonly CandidateEvidence[];
  readonly claim: {
    readonly kind: 'bounded-typed-intent-normalization';
    readonly universalNaturalLanguageEquivalence: false;
    readonly cacheAuthorization: 'none';
  };
  readonly decision: ShadowDecision;
  readonly witnessDigest: Sha256Digest;
}

export interface NormalizationVerificationContext {
  readonly sourceDigest: IntentSourceDigest;
  readonly intent: IntentIR;
  readonly normalizer: NormalizerBinding;
  readonly policyDigest: Sha256Digest;
  readonly minimumConfidencePpm: number;
}

export type UnsignedNormalizationWitness = Omit<
  NormalizationWitness,
  'witnessDigest'
>;

export interface CacheHitWitness {
  readonly schema: typeof CACHE_HIT_WITNESS_SCHEMA;
  readonly mode: 'shadow';
  readonly normalization: {
    readonly witnessDigest: Sha256Digest;
    readonly sourceDigest: IntentSourceDigest;
    readonly intentDigest: Sha256Digest;
    readonly verdict: 'eligible' | 'bypass';
    readonly reasons: readonly IntentReasonCode[];
  };
  readonly entry: CacheEntry;
  readonly lookup: CacheLookup;
  readonly claim: {
    readonly comparison: 'exact-bound-digests';
    readonly candidateEvidenceAuthorizesHit: false;
    readonly universalSemanticEquivalence: false;
  };
  readonly decision: ShadowDecision;
  readonly witnessDigest: Sha256Digest;
}

export type UnsignedCacheHitWitness = Omit<CacheHitWitness, 'witnessDigest'>;

export class IntentWitnessError extends Error {
  readonly code: IntentReasonCode;
  override readonly cause?: unknown;

  constructor(code: IntentReasonCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'IntentWitnessError';
    this.code = code;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}
