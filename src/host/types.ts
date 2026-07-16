import type { ProofEnvelope } from '../domain/proof.js';
import type {
  EquivalenceLevel,
  SegmentKind,
  SegmentRole,
  Sha256Digest,
  TrustLevel,
} from '../domain/types.js';

export {
  isEquivalenceLevel,
  isSafeIdentifier,
  isSafeMediaType,
  isSegmentKind,
  isSegmentRole,
  isTrustLevel,
} from '../domain/types.js';
export { isSha256Digest } from '../domain/hash.js';

export const HOST_PREPARATION_REASON_CODES = [
  'APPLIED',
  'PROMOTION_MISSING',
  'POLICY_MODE_NOT_APPLY_VERIFIED',
  'PROMOTION_ARTIFACT_MISMATCH',
  'PROMOTION_POLICY_MISMATCH',
  'PROMOTION_TOKENIZER_MISMATCH',
  'PROMOTION_CODEC_MISMATCH',
  'PROMOTION_SCOPE_MISMATCH',
  'REQUEST_INVALID',
  'SIMULATION_FAILED',
  'SIMULATION_BYPASSED',
  'ACTIVE_DELIVERY_UNSUPPORTED',
  'PROOF_DECISION_INVALID',
  'PROOF_TOKEN_EVIDENCE_INVALID',
  'PROOF_VERIFICATION_FAILED',
  'RETRIEVAL_FAILED',
  'RETRIEVED_CONTENT_MISMATCH',
  'INVALID_UTF8',
  'RUNTIME_ERROR',
] as const;

export type HostReasonCode = (typeof HOST_PREPARATION_REASON_CODES)[number];

export interface TextPreparationRequest {
  readonly id: string;
  readonly role: SegmentRole;
  readonly kind: SegmentKind;
  readonly trust: TrustLevel;
  readonly mediaType: string;
  readonly equivalence: EquivalenceLevel;
  readonly deploymentScopeDigest: Sha256Digest;
  readonly content: string;
}

export interface TextPreparationResult {
  readonly content: string;
  readonly applied: boolean;
  readonly selectedCodec: string;
  readonly reasons: readonly HostReasonCode[];
  readonly proof?: ProofEnvelope;
  readonly promotionDigest?: Sha256Digest;
  readonly deploymentScopeDigest?: Sha256Digest;
}

export interface TextRequestPreparer {
  prepare(request: TextPreparationRequest): Promise<TextPreparationResult>;
}

export interface HostPromotionManifest {
  readonly schema: 'semwitness.dev/host-promotion/v1alpha1';
  readonly artifact: {
    readonly id: string;
    readonly version: string;
  };
  readonly policyDigest: Sha256Digest;
  readonly deploymentScopeDigest: Sha256Digest;
  readonly tokenizer: {
    readonly id: string;
    readonly fingerprint: string;
  };
  readonly codecs: readonly {
    readonly id: string;
    readonly version: string;
  }[];
  readonly evaluation: {
    readonly corpusDigest: Sha256Digest;
    readonly reportDigest: Sha256Digest;
    readonly split: 'held-out';
    readonly unsafeAccepts: 0;
    readonly taskQualityRegressions: 0;
    readonly medianNetSavingsRatioPpm: number;
  };
}

export function isHostReasonCode(value: unknown): value is HostReasonCode {
  return (
    typeof value === 'string' &&
    (HOST_PREPARATION_REASON_CODES as readonly string[]).includes(value)
  );
}
