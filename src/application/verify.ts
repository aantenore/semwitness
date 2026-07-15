import { Buffer } from 'node:buffer';
import { canonicalJson, toJsonValue } from '../domain/canonical-json.js';
import { reasonFromError } from '../domain/errors.js';
import { hashCanonical, sha256 } from '../domain/hash.js';
import { digestPolicy, type CodecPolicy } from '../domain/policy.js';
import {
  digestSegmentMetadata,
  recomputeProofDigest,
  type AnchorProofEntry,
  type ProofEnvelope,
} from '../domain/proof.js';
import type { ReasonCode } from '../domain/reason-codes.js';
import { parseStrictJson } from '../domain/strict-json.js';
import {
  isHardProtected,
  validateSegment,
  type Segment,
  type Sha256Digest,
} from '../domain/types.js';
import {
  codecAccepts,
  type Codec,
  type EncodedCandidate,
} from '../ports/codec.js';
import type { ContentStore } from '../ports/content-store.js';
import {
  isSafeTokenizerFingerprint,
  isTokenCount,
  type TokenizerAdapter,
} from '../ports/tokenizer.js';
import { CodecRegistry } from './codec-registry.js';
import { withCodecDeadline } from './codec-execution.js';
import {
  candidateNetBenefitReasons,
  candidatePolicyReasons,
} from './eligibility.js';

export interface VerificationResult {
  readonly verified: boolean;
  readonly reasons: readonly ReasonCode[];
}

export async function verifyCodecCandidate(input: {
  readonly codec: Codec;
  readonly segment: Segment;
  readonly candidate: EncodedCandidate;
  readonly policy: CodecPolicy;
}): Promise<VerificationResult> {
  const reasons: ReasonCode[] = [];
  const candidate = sanitizeCandidate(input.candidate);
  if (candidate === undefined) {
    return result(['CODEC_ERROR']);
  }
  if (!codecAccepts(input.codec, input.segment)) {
    return result(['CODEC_NOT_APPLICABLE']);
  }
  if (candidate.bytes.byteLength > input.policy.limits.maxEncodedBytes) {
    reasons.push('OUTPUT_EXPANSION');
    return result(reasons);
  }

  if (input.codec.descriptor.id === 'identity') {
    return bytesEqual(candidate.bytes, input.segment.content)
      ? result([])
      : result(['ROUNDTRIP_MISMATCH']);
  }

  try {
    const reproduced = sanitizeCandidate(
      await withCodecDeadline(
        () => input.codec.encode(input.segment, { policy: input.policy }),
        input.policy.limits.maxCodecMs,
      ),
    );
    if (reproduced === undefined) {
      return result(['CODEC_ERROR']);
    }
    if (reproduced.bytes.byteLength > input.policy.limits.maxEncodedBytes) {
      return result(['OUTPUT_EXPANSION']);
    }
    if (!bytesEqual(reproduced.bytes, candidate.bytes)) {
      return result(['ENCODER_MISMATCH']);
    }
  } catch (error) {
    return result([reasonFromError(error)]);
  }

  let decoded: Uint8Array;
  try {
    decoded = await withCodecDeadline(
      () =>
        input.codec.decode(candidate, {
          maxOutputBytes: input.policy.limits.maxDecodeBytes,
          maxDepth: input.policy.limits.maxDepth,
          maxItems: input.policy.limits.maxItems,
        }),
      input.policy.limits.maxCodecMs,
    );
  } catch (error) {
    reasons.push(reasonFromError(error));
    return result(reasons);
  }
  if (!(decoded instanceof Uint8Array)) {
    return result(['CODEC_ERROR']);
  }
  if (decoded.byteLength > input.policy.limits.maxDecodeBytes) {
    return result(['DECODE_LIMIT']);
  }

  if (input.codec.descriptor.equivalence === 'byte-exact') {
    if (
      !bytesEqual(candidate.bytes, input.segment.content) ||
      !bytesEqual(decoded, input.segment.content)
    ) {
      reasons.push('ROUNDTRIP_MISMATCH');
    }
  } else if (input.codec.descriptor.equivalence === 'roundtrip-exact') {
    if (!bytesEqual(decoded, input.segment.content)) {
      reasons.push('ROUNDTRIP_MISMATCH');
    }
  } else if (input.codec.descriptor.equivalence === 'typed-semantic') {
    try {
      const original = parseStrictJson(decodeUtf8(input.segment.content), {
        maxDepth: input.policy.limits.maxDepth,
        maxItems: input.policy.limits.maxItems,
        maxStringCodeUnits: input.policy.limits.maxInputBytes,
      });
      const reconstructed = parseStrictJson(decodeUtf8(decoded), {
        maxDepth: input.policy.limits.maxDepth,
        maxItems: input.policy.limits.maxItems,
        maxStringCodeUnits: input.policy.limits.maxDecodeBytes,
      });
      if (canonicalJson(original) !== canonicalJson(reconstructed)) {
        reasons.push('TYPED_AST_MISMATCH');
      }
    } catch {
      reasons.push('TYPED_AST_MISMATCH');
    }
  } else {
    reasons.push('CODEC_NOT_APPLICABLE');
  }

  return result(reasons);
}

export async function verifyProofEnvelope(input: {
  readonly proof: ProofEnvelope;
  readonly segment: Segment;
  readonly encoded: EncodedCandidate;
  readonly policy: CodecPolicy;
  readonly registry: CodecRegistry;
  readonly tokenizer: TokenizerAdapter;
  readonly store?: ContentStore;
}): Promise<VerificationResult> {
  const reasons: ReasonCode[] = [];
  const { proof, segment, encoded, policy } = input;
  const segmentValidation = validateSegment(segment);
  reasons.push(...segmentValidation.reasons);
  if (
    proof.schema !== 'semwitness.dev/proof/v1alpha1' ||
    proof.segmentId !== segment.id ||
    proof.segmentMetadataDigest !== digestSegmentMetadata(segment)
  ) {
    reasons.push('MALFORMED_ENVELOPE');
  }
  if (
    proof.claim.verifierId !== 'semwitness-core' ||
    proof.claim.verifierVersion !== '1' ||
    proof.encoded.mediaType !== segment.mediaType
  ) {
    reasons.push('MALFORMED_ENVELOPE');
  }
  if (proof.proofDigest !== recomputeProofDigest(proof)) {
    reasons.push('PROOF_DIGEST_MISMATCH');
  }
  if (proof.policyDigest !== digestPolicy(policy)) {
    reasons.push('POLICY_DIGEST_MISMATCH');
  }
  if (
    proof.original.sha256 !== sha256(segment.content) ||
    proof.original.byteLength !== segment.content.byteLength
  ) {
    reasons.push('ORIGINAL_HASH_MISMATCH');
  }
  if (
    proof.encoded.sha256 !== sha256(encoded.bytes) ||
    proof.encoded.byteLength !== encoded.bytes.byteLength
  ) {
    reasons.push('ENCODED_HASH_MISMATCH');
  }

  const codec = input.registry.resolve(proof.codec.id, proof.codec.version);
  if (codec === undefined) {
    reasons.push('CODEC_NOT_REGISTERED');
  } else {
    if (proof.codec.configDigest !== digestCodecDescriptor(codec)) {
      reasons.push('CODEC_VERSION_MISMATCH');
    }
    if (proof.claim.equivalence !== codec.descriptor.equivalence) {
      reasons.push('CODEC_VERSION_MISMATCH');
    }
    reasons.push(...candidatePolicyReasons({ codec, segment, policy }));
    const codecVerification = await verifyCodecCandidate({
      codec,
      segment,
      candidate: encoded,
      policy,
    });
    reasons.push(...codecVerification.reasons);
  }

  const tokenVerification = await verifyTokenEvidence({
    proof,
    segment,
    encoded,
    policy,
    codec,
    tokenizer: input.tokenizer,
  });
  reasons.push(...tokenVerification);
  const tokenEvidence = proof.tokenEvidence[0];
  if (codec !== undefined && tokenEvidence !== undefined) {
    reasons.push(
      ...candidateNetBenefitReasons({
        codec,
        policy,
        accounting: tokenEvidence,
      }),
    );
  }
  reasons.push(...verifyDecisionClaim(proof, segment, policy));

  const expectedAnchors = anchorEntries(
    segment,
    encoded.bytes,
    proof.codec.id === 'identity',
  );
  if (expectedAnchors === undefined) {
    reasons.push('ANCHOR_MUTATED');
  } else {
    if (
      proof.anchorManifest.sha256 !==
      digestAnchorEntries(proof.anchorManifest.entries)
    ) {
      reasons.push('ANCHOR_MUTATED');
    }
    if (
      canonicalJson(toJsonValue(proof.anchorManifest.entries)) !==
      canonicalJson(toJsonValue(expectedAnchors))
    ) {
      reasons.push('ANCHOR_MUTATED');
    }
  }

  if (proof.original.stored) {
    if (input.store === undefined) {
      reasons.push('CAS_MISS');
    } else {
      try {
        const stored = await input.store.get(proof.original.cas);
        if (!bytesEqual(stored, segment.content)) {
          reasons.push('CAS_CORRUPT');
        }
      } catch (error) {
        reasons.push(reasonFromError(error, 'CAS_MISS'));
      }
    }
  }
  if (proof.encoded.stored) {
    if (input.store === undefined) {
      reasons.push('CAS_MISS');
    } else {
      try {
        const stored = await input.store.get(proof.encoded.sha256);
        if (!bytesEqual(stored, encoded.bytes)) {
          reasons.push('CAS_CORRUPT');
        }
      } catch (error) {
        reasons.push(reasonFromError(error, 'CAS_MISS'));
      }
    }
  }
  return result(reasons);
}

async function verifyTokenEvidence(input: {
  readonly proof: ProofEnvelope;
  readonly segment: Segment;
  readonly encoded: EncodedCandidate;
  readonly policy: CodecPolicy;
  readonly codec: Codec | undefined;
  readonly tokenizer: TokenizerAdapter;
}): Promise<readonly ReasonCode[]> {
  if (
    input.tokenizer.id !== input.policy.tokenizerId ||
    !isSafeTokenizerFingerprint(input.tokenizer.fingerprint)
  ) {
    return ['TOKENIZER_UNAVAILABLE'];
  }
  if (input.proof.tokenEvidence.length !== 1) {
    return ['MALFORMED_ENVELOPE'];
  }
  const evidence = input.proof.tokenEvidence[0]!;
  if (
    evidence.tokenizerId !== input.tokenizer.id ||
    evidence.tokenizerFingerprint !== input.tokenizer.fingerprint
  ) {
    return ['TOKENIZER_UNAVAILABLE'];
  }
  try {
    const original = await input.tokenizer.count(
      input.segment.content,
      input.segment.mediaType,
    );
    const encoded = await input.tokenizer.count(
      input.encoded.bytes,
      input.segment.mediaType,
    );
    if (!isTokenCount(original) || !isTokenCount(encoded)) {
      return ['TOKENIZER_ERROR'];
    }
    let decoderOverheadTokens = 0;
    let reliability: 'exact' | 'heuristic' =
      original.reliability === 'exact' && encoded.reliability === 'exact'
        ? 'exact'
        : 'heuristic';
    if (
      input.policy.selection.includeDecoderLegendTokens &&
      input.codec?.descriptor.decoderLegend !== undefined
    ) {
      const legend = await input.tokenizer.count(
        input.codec.descriptor.decoderLegend,
        'text/plain; charset=utf-8',
      );
      if (!isTokenCount(legend)) {
        return ['TOKENIZER_ERROR'];
      }
      decoderOverheadTokens = legend.tokens;
      if (legend.reliability === 'heuristic') {
        reliability = 'heuristic';
      }
    }
    if (
      evidence.originalTokens !== original.tokens ||
      evidence.encodedTokens !== encoded.tokens ||
      evidence.decoderOverheadTokens !== decoderOverheadTokens ||
      evidence.reliability !== reliability
    ) {
      return ['TOKENIZER_ERROR'];
    }
    return [];
  } catch {
    return ['TOKENIZER_ERROR'];
  }
}

function verifyDecisionClaim(
  proof: ProofEnvelope,
  segment: Segment,
  policy: CodecPolicy,
): readonly ReasonCode[] {
  const reasons: ReasonCode[] = [];
  const evidence = proof.tokenEvidence[0];
  if (proof.decision.status === 'applied') {
    if (
      policy.mode === 'shadow' ||
      proof.codec.id === 'identity' ||
      isHardProtected(segment) ||
      segment.anchors.length > 0 ||
      !proof.original.stored ||
      !proof.encoded.stored ||
      evidence === undefined
    ) {
      reasons.push('MALFORMED_ENVELOPE');
    } else {
      const savings =
        evidence.originalTokens -
        evidence.encodedTokens -
        evidence.decoderOverheadTokens;
      const ratio = Math.floor(
        (Math.max(0, savings) * 1_000_000) /
          Math.max(1, evidence.originalTokens),
      );
      if (
        savings < policy.selection.minTokenSavings ||
        ratio < policy.selection.minSavingsRatioPpm
      ) {
        reasons.push('BELOW_MIN_SAVINGS');
      }
      if (
        evidence.reliability === 'heuristic' &&
        !policy.selection.allowHeuristicApply
      ) {
        reasons.push('TOKENIZER_NOT_EXACT');
      }
    }
    if (!proof.decision.reasons.includes('APPLIED')) {
      reasons.push('MALFORMED_ENVELOPE');
    }
  } else {
    if (proof.decision.reasons.includes('APPLIED')) {
      reasons.push('MALFORMED_ENVELOPE');
    }
    if (proof.codec.id === 'identity' && isHardProtected(segment)) {
      const expected =
        segment.role === 'system' || segment.role === 'developer'
          ? 'PROTECTED_ROLE'
          : 'PROTECTED_KIND';
      if (!proof.decision.reasons.includes(expected)) {
        reasons.push('MALFORMED_ENVELOPE');
      }
    }
    if (
      proof.codec.id === 'identity' &&
      !proof.decision.reasons.includes('IDENTITY_SELECTED')
    ) {
      reasons.push('MALFORMED_ENVELOPE');
    }
    if (
      proof.codec.id !== 'identity' &&
      policy.mode === 'shadow' &&
      !proof.decision.reasons.includes('SHADOW_ONLY')
    ) {
      reasons.push('MALFORMED_ENVELOPE');
    }
  }
  return reasons;
}

export function digestCodecDescriptor(codec: Codec): Sha256Digest {
  return hashCanonical(
    toJsonValue({
      id: codec.descriptor.id,
      version: codec.descriptor.version,
      deterministic: codec.descriptor.deterministic,
      acceptedKinds: codec.descriptor.acceptedKinds,
      equivalence: codec.descriptor.equivalence,
      decoderLegendSha256:
        codec.descriptor.decoderLegend === undefined
          ? null
          : sha256(codec.descriptor.decoderLegend),
    }),
  );
}

export function anchorEntries(
  segment: Segment,
  encoded: Uint8Array,
  offsetsUnchanged: boolean,
): readonly AnchorProofEntry[] | undefined {
  if (segment.anchors.length === 0) {
    return [];
  }
  if (!offsetsUnchanged) {
    return undefined;
  }
  const entries: AnchorProofEntry[] = [];
  for (const anchor of segment.anchors) {
    if (anchor.endByte > encoded.byteLength) {
      return undefined;
    }
    const bytes = encoded.subarray(anchor.startByte, anchor.endByte);
    if (sha256(bytes) !== anchor.sha256) {
      return undefined;
    }
    entries.push({
      id: anchor.id,
      ordinal: anchor.ordinal,
      sha256: anchor.sha256,
      encodedStartByte: anchor.startByte,
      encodedEndByte: anchor.endByte,
    });
  }
  return entries;
}

export function digestAnchorEntries(
  entries: readonly AnchorProofEntry[],
): Sha256Digest {
  return hashCanonical(toJsonValue(entries));
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength && Buffer.compare(left, right) === 0
  );
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function result(reasons: readonly ReasonCode[]): VerificationResult {
  const unique = [...new Set(reasons)];
  return { verified: unique.length === 0, reasons: unique };
}

function sanitizeCandidate(value: unknown): EncodedCandidate | undefined {
  if (
    value === null ||
    typeof value !== 'object' ||
    !('bytes' in value) ||
    !(value.bytes instanceof Uint8Array) ||
    Object.keys(value).length !== 1
  ) {
    return undefined;
  }
  return { bytes: new Uint8Array(value.bytes) };
}
