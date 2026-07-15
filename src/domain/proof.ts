import { toJsonValue } from './canonical-json.js';
import { hashCanonical, sha256 } from './hash.js';
import type { ReasonCode } from './reason-codes.js';
import type { EquivalenceLevel, Segment, Sha256Digest } from './types.js';

export interface AnchorProofEntry {
  readonly id: string;
  readonly ordinal: number;
  readonly sha256: Sha256Digest;
  readonly encodedStartByte: number;
  readonly encodedEndByte: number;
}

export interface ProofEnvelope {
  readonly schema: 'semwitness.dev/proof/v1alpha1';
  readonly segmentId: string;
  readonly segmentMetadataDigest: Sha256Digest;
  readonly policyDigest: Sha256Digest;
  readonly codec: {
    readonly id: string;
    readonly version: string;
    readonly configDigest: Sha256Digest;
  };
  readonly claim: {
    readonly equivalence: EquivalenceLevel;
    readonly verifierId: 'semwitness-core';
    readonly verifierVersion: '1';
  };
  readonly original: {
    readonly sha256: Sha256Digest;
    readonly byteLength: number;
    readonly cas: Sha256Digest;
    readonly stored: boolean;
  };
  readonly encoded: {
    readonly sha256: Sha256Digest;
    readonly byteLength: number;
    readonly mediaType: string;
    readonly stored: boolean;
  };
  readonly anchorManifest: {
    readonly sha256: Sha256Digest;
    readonly entries: readonly AnchorProofEntry[];
  };
  readonly tokenEvidence: readonly {
    readonly tokenizerId: string;
    readonly tokenizerFingerprint: string;
    readonly reliability: 'exact' | 'heuristic';
    readonly originalTokens: number;
    readonly encodedTokens: number;
    readonly decoderOverheadTokens: number;
  }[];
  readonly decision: {
    readonly status: 'applied' | 'bypassed';
    readonly reasons: readonly ReasonCode[];
  };
  readonly proofDigest: Sha256Digest;
}

export type UnsignedProofEnvelope = Omit<ProofEnvelope, 'proofDigest'>;

export function finalizeProof(envelope: UnsignedProofEnvelope): ProofEnvelope {
  return {
    ...envelope,
    proofDigest: hashCanonical(toJsonValue(envelope)),
  };
}

export function recomputeProofDigest(proof: ProofEnvelope): Sha256Digest {
  const { proofDigest: _proofDigest, ...unsigned } = proof;
  return hashCanonical(toJsonValue(unsigned));
}

export function digestSegmentMetadata(segment: Segment): Sha256Digest {
  return hashCanonical(
    toJsonValue({
      schema: segment.schema,
      id: segment.id,
      role: segment.role,
      roleOrigin: segment.roleOrigin,
      kind: segment.kind,
      trust: segment.trust,
      mediaType: segment.mediaType,
      equivalence: segment.equivalence,
      contentSha256: sha256(segment.content),
      contentByteLength: segment.content.byteLength,
      anchors: segment.anchors,
    }),
  );
}
