import type { Sha256Digest } from '../domain/types.js';
import type {
  CacheEntryCommitment,
  CacheKeyDigest,
  CacheValueCommitment,
  HmacIntentSourceDigest,
  HmacScopeDigest,
} from '../intent/types.js';
import type {
  IntentCacheDomainHmac,
  IntentCacheNamespaceHmac,
  IntentCacheOperationHmac,
  IntentCacheTenantHmac,
} from './types.js';

export const INTENT_CACHE_ADMISSION_DECISION_PREDICATE_TYPE =
  'https://github.com/aantenore/semwitness/blob/v0.5.0-alpha.5/docs/attestations/cache-admission-decision/v0.1.md' as const;
export const INTENT_CACHE_ADMISSION_DECISION_DSSE_PAYLOAD_TYPE =
  'application/vnd.in-toto+json' as const;
export const INTENT_CACHE_ADMISSION_DECISION_PASSPORT_SUBJECT_NAME =
  'semwitness-cache-admission-passport-payload' as const;
export const INTENT_CACHE_ADMISSION_DECISION_WITNESS_SUBJECT_NAME =
  'semwitness-cache-hit-witness-payload' as const;
export const INTENT_CACHE_ADMISSION_DECISION_ARTIFACT = Object.freeze({
  id: 'semwitness-cache-admission-decision',
  version: '0.1.0',
} as const);
export const MAX_INTENT_CACHE_ADMISSION_DECISION_BYTES = 32 * 1024;
export const MAX_INTENT_CACHE_ADMISSION_SECRET_BYTES = 4 * 1024;
export const MAX_INTENT_CACHE_ADMISSION_VALUE_BYTES = 8 * 1024 * 1024;

export interface IntentCacheAdmissionDecisionSubject {
  readonly name:
    | typeof INTENT_CACHE_ADMISSION_DECISION_PASSPORT_SUBJECT_NAME
    | typeof INTENT_CACHE_ADMISSION_DECISION_WITNESS_SUBJECT_NAME;
  readonly digest: { readonly sha256: string };
}

export interface IntentCacheAdmissionDecisionPredicate {
  readonly artifact: typeof INTENT_CACHE_ADMISSION_DECISION_ARTIFACT;
  readonly profile: 'intent-plan-read';
  readonly authentication: 'none';
  readonly mode: 'shadow';
  readonly activationCeiling: 'shadow-only';
  readonly decision: {
    readonly verdict: 'eligible';
    readonly applied: false;
    readonly reasons: readonly ['CACHE_HIT_ELIGIBLE'];
  };
  readonly servingAuthority: 'none';
  readonly lineage: {
    readonly qualificationDigest: Sha256Digest;
    readonly normalizationWitnessDigest: Sha256Digest;
    readonly cacheHitWitnessDigest: Sha256Digest;
    readonly operationBindingDigest: Sha256Digest;
    readonly entrySourceBindingDigest: Sha256Digest;
  };
  readonly scope: {
    /** Qualification scope declared by the exact Passport, not hit-runtime proof. */
    readonly qualificationDeploymentScopeDigest: Sha256Digest;
    readonly cacheNamespace: IntentCacheNamespaceHmac;
    readonly tenant: IntentCacheTenantHmac;
    readonly principal: HmacScopeDigest<'principal'>;
    readonly authorization: HmacScopeDigest<'authorization'>;
    readonly context: HmacScopeDigest<'context'>;
    readonly domain: IntentCacheDomainHmac;
    readonly operation: IntentCacheOperationHmac;
  };
  readonly candidate: {
    readonly cacheKeyDigest: CacheKeyDigest;
    readonly entryCommitment: CacheEntryCommitment;
    readonly valueCommitment: CacheValueCommitment;
    readonly tier: 'plan';
    readonly effect: 'read';
  };
  readonly contracts: {
    readonly cacheAdmissionPolicyDigest: Sha256Digest;
    readonly normalizationPolicyDigest: Sha256Digest;
    /** Full qualification inventory declared by the exact Passport. */
    readonly qualificationDependenciesDigest: Sha256Digest;
  };
  readonly privacy: {
    readonly sourceDigest: HmacIntentSourceDigest;
    readonly sourceContentIncluded: false;
    readonly valueContentIncluded: false;
    readonly rawIdentifiersIncluded: false;
  };
}

/**
 * Joint Statement about the exact Passport and exact eligible cache-hit
 * witness payloads. It is evidence only and never grants serving authority.
 */
export interface IntentCacheAdmissionDecisionStatement {
  readonly _type: 'https://in-toto.io/Statement/v1';
  readonly subject: readonly [
    IntentCacheAdmissionDecisionSubject,
    IntentCacheAdmissionDecisionSubject,
  ];
  readonly predicateType: typeof INTENT_CACHE_ADMISSION_DECISION_PREDICATE_TYPE;
  readonly predicate: IntentCacheAdmissionDecisionPredicate;
}

export interface IntentCacheAdmissionDecisionEvidence {
  /** Exact canonical Passport bytes. */
  readonly passport: string | Uint8Array;
  readonly qualification: unknown;
  /** Exact canonical CacheHitWitness bytes. */
  readonly cacheHitWitness: string | Uint8Array;
  readonly normalizationWitness: unknown;
  readonly operationBinding: unknown;
  readonly entrySourceBinding: unknown;
  /** Secret used for domain-separated cache key and artifact commitments. */
  readonly cacheKeySecret: string | Uint8Array;
  /** Exact candidate value bytes; never enter the Statement. */
  readonly value: string | Uint8Array;
}

export interface IntentCacheAdmissionDecisionBindingVerification {
  /** Exact canonical payload equality; never authorization or permission to serve. */
  readonly bound: boolean;
  /** Supported profile equality before exact payload-byte enforcement. */
  readonly profileBound: boolean;
  readonly extensionsPresent: boolean;
  readonly canonicalProfileDigest: Sha256Digest;
  readonly payloadDigest: Sha256Digest | null;
  readonly canonicalPayload: boolean | null;
  readonly statementPassportPayloadDigest: Sha256Digest;
  readonly suppliedPassportPayloadDigest: Sha256Digest;
  readonly statementWitnessPayloadDigest: Sha256Digest;
  readonly suppliedWitnessPayloadDigest: Sha256Digest;
  readonly servingAuthority: 'none';
}
