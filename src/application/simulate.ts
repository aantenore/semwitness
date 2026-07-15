import { reasonFromError, SemWitnessError } from '../domain/errors.js';
import { sha256 } from '../domain/hash.js';
import {
  digestPolicy,
  resolvePolicyRule,
  type CodecPolicy,
} from '../domain/policy.js';
import {
  digestSegmentMetadata,
  finalizeProof,
  type ProofEnvelope,
} from '../domain/proof.js';
import type { ReasonCode } from '../domain/reason-codes.js';
import {
  isHardProtected,
  validateSegment,
  type Segment,
} from '../domain/types.js';
import type { Codec, EncodedCandidate } from '../ports/codec.js';
import type { ContentStore } from '../ports/content-store.js';
import {
  isSafeTokenizerFingerprint,
  isTokenCount,
  type TokenCount,
  type TokenizerAdapter,
} from '../ports/tokenizer.js';
import { CodecRegistry } from './codec-registry.js';
import { withCodecDeadline } from './codec-execution.js';
import { compareCodeUnits } from '../domain/deterministic-order.js';
import {
  candidateNetBenefitReasons,
  candidatePolicyReasons,
  computeTokenBenefit,
} from './eligibility.js';
import {
  anchorEntries,
  digestAnchorEntries,
  digestCodecDescriptor,
  verifyCodecCandidate,
  verifyProofEnvelope,
} from './verify.js';

export interface CandidateReport {
  readonly codecId: string;
  readonly codecVersion: string;
  readonly equivalence: string;
  readonly byteLength: number;
  readonly encodedSha256: string;
  readonly originalTokens: number;
  readonly encodedTokens: number;
  readonly decoderOverheadTokens: number;
  readonly netTokenSavings: number;
  readonly savingsRatioPpm: number;
  readonly eligible: boolean;
  readonly reasons: readonly ReasonCode[];
}

export interface SimulationResult {
  readonly segmentId: string;
  readonly applied: boolean;
  readonly selectedCodec: string;
  readonly effectiveReference: `sha256:${string}`;
  readonly projectedReference: `sha256:${string}`;
  readonly projectedStored: boolean;
  readonly proof: ProofEnvelope;
  readonly candidates: readonly CandidateReport[];
}

export interface SimulationDependencies {
  readonly registry: CodecRegistry;
  readonly tokenizer: TokenizerAdapter;
  readonly store?: ContentStore;
}

interface EvaluatedCandidate {
  readonly codec: Codec;
  readonly candidate: EncodedCandidate;
  readonly report: CandidateReport;
  readonly reliability: 'exact' | 'heuristic';
}

export async function simulateSegment(
  dependencies: SimulationDependencies,
  segment: Segment,
  policy: CodecPolicy,
): Promise<SimulationResult> {
  const validation = validateSegment(segment);
  if (!validation.valid) {
    throw new SemWitnessError(
      validation.reasons[0] ?? 'MALFORMED_ENVELOPE',
      'Invalid segment',
    );
  }
  if (segment.content.byteLength > policy.limits.maxInputBytes) {
    throw new SemWitnessError(
      'INPUT_TOO_LARGE',
      'Segment exceeds policy input limit',
    );
  }
  if (
    dependencies.tokenizer.id !== policy.tokenizerId ||
    !isSafeTokenizerFingerprint(dependencies.tokenizer.fingerprint)
  ) {
    throw new SemWitnessError(
      'TOKENIZER_UNAVAILABLE',
      `Tokenizer ${policy.tokenizerId} is not configured`,
    );
  }

  const originalReference = sha256(segment.content);
  let stored = false;
  if (dependencies.store !== undefined) {
    try {
      stored =
        (await dependencies.store.put(segment.content)) === originalReference;
    } catch {
      stored = false;
    }
  }

  const originalCount = await countTokens(
    dependencies.tokenizer,
    segment.content,
    segment.mediaType,
  );
  const rule = resolvePolicyRule(policy, segment);
  const requestedCodecIds = [...new Set([...rule.codecs, 'identity'])];
  const evaluated: EvaluatedCandidate[] = [];

  for (const codecId of requestedCodecIds) {
    const codec = dependencies.registry.resolve(codecId);
    if (codec === undefined) {
      evaluated.push(missingCodec(codecId, originalCount.tokens));
      continue;
    }
    evaluated.push(
      await evaluateCandidate({
        codec,
        segment,
        policy,
        tokenizer: dependencies.tokenizer,
        originalTokens: originalCount.tokens,
        originalReliability: originalCount.reliability,
      }),
    );
  }

  const identity = evaluated.find(
    (item) => item.codec.descriptor.id === 'identity',
  );
  if (identity === undefined) {
    throw new SemWitnessError(
      'CODEC_NOT_REGISTERED',
      'Identity codec is required',
    );
  }
  const selected =
    [...evaluated]
      .filter(
        (item) =>
          item.report.eligible && item.codec.descriptor.id !== 'identity',
      )
      .sort(compareCandidates)[0] ?? identity;

  let projectedStored = false;
  if (dependencies.store !== undefined) {
    try {
      projectedStored =
        (await dependencies.store.put(selected.candidate.bytes)) ===
        sha256(selected.candidate.bytes);
    } catch {
      projectedStored = false;
    }
  }

  const applicationReasons: ReasonCode[] = [];
  let applied = selected.codec.descriptor.id !== 'identity';
  if (policy.mode === 'shadow' && applied) {
    applied = false;
    applicationReasons.push('SHADOW_ONLY');
  }
  if (
    applied &&
    selected.reliability === 'heuristic' &&
    !policy.selection.allowHeuristicApply
  ) {
    applied = false;
    applicationReasons.push('TOKENIZER_NOT_EXACT');
  }
  if (applied && (!stored || !projectedStored)) {
    applied = false;
    applicationReasons.push('CAS_WRITE_FAILED');
  }
  if (selected.codec.descriptor.id === 'identity') {
    applicationReasons.push('IDENTITY_SELECTED', 'NO_ELIGIBLE_CODEC');
    if (isHardProtected(segment)) {
      applicationReasons.push(
        segment.role === 'system' || segment.role === 'developer'
          ? 'PROTECTED_ROLE'
          : 'PROTECTED_KIND',
      );
    }
  }
  if (applied) {
    applicationReasons.push('APPLIED');
  } else if (
    selected.codec.descriptor.id !== 'identity' &&
    applicationReasons.length === 0
  ) {
    applicationReasons.push('FALLBACK_ORIGINAL');
  }

  const proof = buildProof({
    segment,
    policy,
    codec: selected.codec,
    candidate: selected.candidate,
    report: selected.report,
    reliability: selected.reliability,
    originalReference,
    stored,
    projectedStored,
    applied,
    reasons: applicationReasons,
    tokenizerFingerprint: dependencies.tokenizer.fingerprint,
  });
  const verification = await verifyProofEnvelope({
    proof,
    segment,
    encoded: selected.candidate,
    policy,
    registry: dependencies.registry,
    tokenizer: dependencies.tokenizer,
    ...(dependencies.store === undefined ? {} : { store: dependencies.store }),
  });

  if (!verification.verified) {
    const fallbackStored = await confirmStored(
      dependencies.store,
      originalReference,
    );
    const fallbackReasons = [
      ...verification.reasons,
      'FALLBACK_ORIGINAL' as const,
      'IDENTITY_SELECTED' as const,
    ];
    if (isHardProtected(segment)) {
      fallbackReasons.push(
        segment.role === 'system' || segment.role === 'developer'
          ? 'PROTECTED_ROLE'
          : 'PROTECTED_KIND',
      );
    }
    const fallbackProof = buildProof({
      segment,
      policy,
      codec: identity.codec,
      candidate: identity.candidate,
      report: identity.report,
      reliability: identity.reliability,
      originalReference,
      stored: fallbackStored,
      projectedStored: fallbackStored,
      applied: false,
      reasons: fallbackReasons,
      tokenizerFingerprint: dependencies.tokenizer.fingerprint,
    });
    const fallbackVerification = await verifyProofEnvelope({
      proof: fallbackProof,
      segment,
      encoded: identity.candidate,
      policy,
      registry: dependencies.registry,
      tokenizer: dependencies.tokenizer,
      ...(dependencies.store === undefined
        ? {}
        : { store: dependencies.store }),
    });
    if (!fallbackVerification.verified) {
      throw new SemWitnessError(
        fallbackVerification.reasons[0] ?? 'CODEC_ERROR',
        'Unable to produce a verifiable identity fallback',
      );
    }
    return {
      segmentId: segment.id,
      applied: false,
      selectedCodec: 'identity',
      effectiveReference: originalReference,
      projectedReference: originalReference,
      projectedStored: fallbackStored,
      proof: fallbackProof,
      candidates: evaluated.map((item) => item.report),
    };
  }

  return {
    segmentId: segment.id,
    applied,
    selectedCodec: selected.codec.descriptor.id,
    effectiveReference: applied
      ? sha256(selected.candidate.bytes)
      : originalReference,
    projectedReference: sha256(selected.candidate.bytes),
    projectedStored,
    proof,
    candidates: evaluated.map((item) => item.report),
  };
}

async function evaluateCandidate(input: {
  readonly codec: Codec;
  readonly segment: Segment;
  readonly policy: CodecPolicy;
  readonly tokenizer: TokenizerAdapter;
  readonly originalTokens: number;
  readonly originalReliability: 'exact' | 'heuristic';
}): Promise<EvaluatedCandidate> {
  const reasons: ReasonCode[] = [
    ...candidatePolicyReasons({
      codec: input.codec,
      segment: input.segment,
      policy: input.policy,
    }),
  ];

  let candidate: EncodedCandidate = {
    bytes: input.segment.content,
  };
  if (reasons.length === 0) {
    if (input.codec.descriptor.id === 'identity') {
      candidate = { bytes: input.segment.content };
    } else {
      try {
        candidate = sanitizeCandidate(
          await withCodecDeadline(
            () => input.codec.encode(input.segment, { policy: input.policy }),
            input.policy.limits.maxCodecMs,
          ),
        );
      } catch (error) {
        reasons.push(reasonFromError(error));
      }
    }
  }
  if (candidate.bytes.byteLength > input.policy.limits.maxEncodedBytes) {
    reasons.push('OUTPUT_EXPANSION');
  }

  if (reasons.length === 0) {
    const verification = await verifyCodecCandidate({
      codec: input.codec,
      segment: input.segment,
      candidate,
      policy: input.policy,
    });
    reasons.push(...verification.reasons);
  }

  let encodedTokens = input.originalTokens;
  let decoderOverheadTokens = 0;
  let reliability = input.originalReliability;
  try {
    const encodedCount = await countTokens(
      input.tokenizer,
      candidate.bytes,
      input.segment.mediaType,
    );
    encodedTokens = encodedCount.tokens;
    reliability =
      reliability === 'exact' && encodedCount.reliability === 'exact'
        ? 'exact'
        : 'heuristic';
    if (
      input.policy.selection.includeDecoderLegendTokens &&
      input.codec.descriptor.decoderLegend !== undefined
    ) {
      const legendCount = await countTokens(
        input.tokenizer,
        input.codec.descriptor.decoderLegend,
        'text/plain; charset=utf-8',
      );
      decoderOverheadTokens = legendCount.tokens;
      if (legendCount.reliability === 'heuristic') {
        reliability = 'heuristic';
      }
    }
  } catch {
    reasons.push('TOKENIZER_ERROR');
  }

  const accounting = {
    originalTokens: input.originalTokens,
    encodedTokens,
    decoderOverheadTokens,
  };
  const benefit = computeTokenBenefit(accounting);
  if (benefit === undefined) {
    reasons.push('TOKENIZER_ERROR');
  }
  reasons.push(
    ...candidateNetBenefitReasons({
      codec: input.codec,
      policy: input.policy,
      accounting,
    }),
  );

  const uniqueReasons = [...new Set(reasons)];
  return {
    codec: input.codec,
    candidate,
    reliability,
    report: {
      codecId: input.codec.descriptor.id,
      codecVersion: input.codec.descriptor.version,
      equivalence: input.codec.descriptor.equivalence,
      byteLength: candidate.bytes.byteLength,
      encodedSha256: sha256(candidate.bytes),
      originalTokens: input.originalTokens,
      encodedTokens,
      decoderOverheadTokens,
      netTokenSavings: benefit?.netTokenSavings ?? 0,
      savingsRatioPpm: benefit?.savingsRatioPpm ?? 0,
      eligible:
        input.codec.descriptor.id === 'identity' || uniqueReasons.length === 0,
      reasons: uniqueReasons,
    },
  };
}

async function countTokens(
  tokenizer: TokenizerAdapter,
  bytes: Uint8Array,
  mediaType: string,
): Promise<TokenCount> {
  try {
    const result = await tokenizer.count(bytes, mediaType);
    if (!isTokenCount(result)) {
      throw new TypeError('Invalid tokenizer result');
    }
    return result;
  } catch (error) {
    throw new SemWitnessError(
      'TOKENIZER_ERROR',
      'Tokenizer failed or returned invalid evidence',
      error,
    );
  }
}

function buildProof(input: {
  readonly segment: Segment;
  readonly policy: CodecPolicy;
  readonly codec: Codec;
  readonly candidate: EncodedCandidate;
  readonly report: CandidateReport;
  readonly reliability: 'exact' | 'heuristic';
  readonly originalReference: `sha256:${string}`;
  readonly stored: boolean;
  readonly projectedStored: boolean;
  readonly applied: boolean;
  readonly reasons: readonly ReasonCode[];
  readonly tokenizerFingerprint: string;
}): ProofEnvelope {
  const entries =
    anchorEntries(
      input.segment,
      input.candidate.bytes,
      input.codec.descriptor.id === 'identity',
    ) ?? [];
  return finalizeProof({
    schema: 'semwitness.dev/proof/v1alpha1',
    segmentId: input.segment.id,
    segmentMetadataDigest: digestSegmentMetadata(input.segment),
    policyDigest: digestPolicy(input.policy),
    codec: {
      id: input.codec.descriptor.id,
      version: input.codec.descriptor.version,
      configDigest: digestCodecDescriptor(input.codec),
    },
    claim: {
      equivalence: input.codec.descriptor.equivalence,
      verifierId: 'semwitness-core',
      verifierVersion: '1',
    },
    original: {
      sha256: input.originalReference,
      byteLength: input.segment.content.byteLength,
      cas: input.originalReference,
      stored: input.stored,
    },
    encoded: {
      sha256: sha256(input.candidate.bytes),
      byteLength: input.candidate.bytes.byteLength,
      mediaType: input.segment.mediaType,
      stored: input.projectedStored,
    },
    anchorManifest: {
      sha256: digestAnchorEntries(entries),
      entries,
    },
    tokenEvidence: [
      {
        tokenizerId: input.policy.tokenizerId,
        tokenizerFingerprint: input.tokenizerFingerprint,
        reliability: input.reliability,
        originalTokens: input.report.originalTokens,
        encodedTokens: input.report.encodedTokens,
        decoderOverheadTokens: input.report.decoderOverheadTokens,
      },
    ],
    decision: {
      status: input.applied ? 'applied' : 'bypassed',
      reasons: [...new Set(input.reasons)],
    },
  });
}

function missingCodec(
  codecId: string,
  originalTokens: number,
): EvaluatedCandidate {
  const placeholder: Codec = {
    descriptor: {
      id: codecId,
      version: 'missing',
      deterministic: true,
      acceptedKinds: '*',
      equivalence: 'byte-exact',
    },
    async encode(segment) {
      return { bytes: new Uint8Array(segment.content) };
    },
    async decode(candidate) {
      return new Uint8Array(candidate.bytes);
    },
  };
  return {
    codec: placeholder,
    candidate: { bytes: new Uint8Array() },
    reliability: 'heuristic',
    report: {
      codecId,
      codecVersion: 'missing',
      equivalence: 'byte-exact',
      byteLength: 0,
      encodedSha256: sha256(new Uint8Array()),
      originalTokens,
      encodedTokens: originalTokens,
      decoderOverheadTokens: 0,
      netTokenSavings: 0,
      savingsRatioPpm: 0,
      eligible: false,
      reasons: ['CODEC_NOT_REGISTERED'],
    },
  };
}

function compareCandidates(
  left: EvaluatedCandidate,
  right: EvaluatedCandidate,
): number {
  const leftTokens =
    left.report.encodedTokens + left.report.decoderOverheadTokens;
  const rightTokens =
    right.report.encodedTokens + right.report.decoderOverheadTokens;
  return (
    leftTokens - rightTokens ||
    left.report.byteLength - right.report.byteLength ||
    compareCodeUnits(left.report.codecId, right.report.codecId) ||
    compareCodeUnits(left.report.codecVersion, right.report.codecVersion)
  );
}

function sanitizeCandidate(value: unknown): EncodedCandidate {
  if (
    value === null ||
    typeof value !== 'object' ||
    !('bytes' in value) ||
    !(value.bytes instanceof Uint8Array) ||
    Object.keys(value).length !== 1
  ) {
    throw new SemWitnessError(
      'CODEC_ERROR',
      'Codec candidates must contain bytes and no out-of-band fields',
    );
  }
  return { bytes: new Uint8Array(value.bytes) };
}

async function confirmStored(
  store: ContentStore | undefined,
  reference: `sha256:${string}`,
): Promise<boolean> {
  if (store === undefined) {
    return false;
  }
  try {
    return sha256(await store.get(reference)) === reference;
  } catch {
    return false;
  }
}
