import type { Sha256Digest } from '../domain/types.js';
import type {
  IntentCacheDomainHmac,
  IntentCacheNamespaceHmac,
  IntentCacheOperationHmac,
  IntentCacheRevocationHmac,
  IntentCacheTenantHmac,
} from './types.js';

export const IN_TOTO_STATEMENT_V1_TYPE =
  'https://in-toto.io/Statement/v1' as const;
export const INTENT_CACHE_ADMISSION_PASSPORT_PREDICATE_TYPE =
  'https://github.com/aantenore/semwitness/blob/main/docs/attestations/cache-admission-passport/v0.1.md' as const;
export const INTENT_CACHE_ADMISSION_PASSPORT_DSSE_PAYLOAD_TYPE =
  'application/vnd.in-toto+json' as const;
export const INTENT_CACHE_ADMISSION_PASSPORT_SUBJECT_NAME =
  'semwitness-intent-cache-shadow-qualification' as const;
export const INTENT_CACHE_ADMISSION_PASSPORT_ARTIFACT = Object.freeze({
  id: 'semwitness-cache-admission-passport',
  version: '0.1.0',
} as const);

/** The canonical v0.1 Statement is far below this fail-closed limit. */
export const MAX_INTENT_CACHE_ADMISSION_PASSPORT_BYTES = 16 * 1024;

export interface IntentCacheAdmissionPassportSubject {
  readonly name: typeof INTENT_CACHE_ADMISSION_PASSPORT_SUBJECT_NAME;
  readonly digest: {
    /** in-toto digest values use lowercase hexadecimal without `sha256:`. */
    readonly sha256: string;
  };
}

export interface IntentCacheAdmissionPassportPredicate {
  readonly artifact: typeof INTENT_CACHE_ADMISSION_PASSPORT_ARTIFACT;
  readonly profile: 'intent-plan-read';
  /** This is an unsigned Statement, not a bearer credential. */
  readonly authentication: 'none';
  readonly decision: 'shadow-qualified';
  readonly activationCeiling: 'shadow-only';
  readonly basis: {
    readonly schema: 'semwitness.dev/intent-cache-shadow-qualification/v1alpha1';
    readonly artifact: {
      readonly id: string;
      readonly version: string;
    };
    readonly provenance: 'host-attested-unsigned';
    readonly evidenceAuthentication: 'none';
    readonly producerIdentity: null;
  };
  /** Copied, digest-bound claims; v0.1 does not enforce time/revocation. */
  readonly validity: {
    /** Canonical RFC 3339 UTC with millisecond precision. */
    readonly notBefore: string;
    /** Canonical RFC 3339 UTC with millisecond precision. */
    readonly notAfter: string;
    readonly revocationId: IntentCacheRevocationHmac;
  };
  readonly scope: {
    readonly deploymentScopeDigest: Sha256Digest;
    readonly cacheNamespace: IntentCacheNamespaceHmac;
    readonly tenant: IntentCacheTenantHmac;
    readonly domain: IntentCacheDomainHmac;
    readonly operation: IntentCacheOperationHmac;
  };
  readonly contracts: {
    readonly cacheAdmissionPolicyDigest: Sha256Digest;
    readonly normalizationPolicyDigest: Sha256Digest;
    readonly dependenciesDigest: Sha256Digest;
  };
  readonly evidence: {
    readonly reportDigest: Sha256Digest;
    readonly evaluatorDigest: Sha256Digest;
  };
}

/**
 * Content-free lineage Statement for one shadow qualification. It never
 * authorizes cache reads, writes, canaries, or live traffic.
 */
export interface IntentCacheAdmissionPassportStatement {
  readonly _type: typeof IN_TOTO_STATEMENT_V1_TYPE;
  readonly subject: readonly [IntentCacheAdmissionPassportSubject];
  readonly predicateType: typeof INTENT_CACHE_ADMISSION_PASSPORT_PREDICATE_TYPE;
  readonly predicate: IntentCacheAdmissionPassportPredicate;
}

export interface IntentCacheAdmissionPassportBindingVerification {
  /** Profile equality plus canonical exact bytes when supplied; never authorization. */
  readonly bound: boolean;
  /** True when bounded, data-only fields outside the supported profile exist. */
  readonly extensionsPresent: boolean;
  /** Digest of the extension-eliding supported canonical profile. */
  readonly canonicalProfileDigest: Sha256Digest;
  /** Digest of exact supplied string/byte payload, or null for object input. */
  readonly payloadDigest: Sha256Digest | null;
  /** Whether exact supplied bytes equal the canonical profile, or null for objects. */
  readonly canonicalPayload: boolean | null;
  readonly statementQualificationDigest: Sha256Digest;
  readonly suppliedQualificationDigest: Sha256Digest;
}
