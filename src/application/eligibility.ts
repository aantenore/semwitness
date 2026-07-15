import { resolvePolicyRule, type CodecPolicy } from '../domain/policy.js';
import type { ReasonCode } from '../domain/reason-codes.js';
import {
  equivalenceSatisfies,
  isHardProtected,
  type Segment,
} from '../domain/types.js';
import { codecAccepts, type Codec } from '../ports/codec.js';

export interface TokenAccounting {
  readonly originalTokens: number;
  readonly encodedTokens: number;
  readonly decoderOverheadTokens: number;
}

export interface TokenBenefit {
  readonly netTokenSavings: number;
  readonly savingsRatioPpm: number;
}

export function candidatePolicyReasons(input: {
  readonly codec: Codec;
  readonly segment: Segment;
  readonly policy: CodecPolicy;
}): readonly ReasonCode[] {
  const { codec, segment, policy } = input;
  const reasons: ReasonCode[] = [];
  if (!codecAccepts(codec, segment)) {
    reasons.push('CODEC_NOT_APPLICABLE');
  }
  if (
    !equivalenceSatisfies(codec.descriptor.equivalence, segment.equivalence)
  ) {
    reasons.push('CODEC_NOT_APPLICABLE');
  }
  if (codec.descriptor.id === 'identity') {
    return [...new Set(reasons)];
  }

  const rule = resolvePolicyRule(policy, segment);
  if (
    !rule.codecs.includes(codec.descriptor.id) ||
    !rule.allowEquivalence.includes(codec.descriptor.equivalence)
  ) {
    reasons.push('CODEC_NOT_APPLICABLE');
  }
  if (isHardProtected(segment)) {
    reasons.push(
      segment.role === 'system' || segment.role === 'developer'
        ? 'PROTECTED_ROLE'
        : 'PROTECTED_KIND',
    );
  }
  if (segment.anchors.length > 0) {
    reasons.push('PROTECTED_ANCHOR');
  }
  return [...new Set(reasons)];
}

export function computeTokenBenefit(
  accounting: TokenAccounting,
): TokenBenefit | undefined {
  if (
    !isTokenValue(accounting.originalTokens) ||
    !isTokenValue(accounting.encodedTokens) ||
    !isTokenValue(accounting.decoderOverheadTokens)
  ) {
    return undefined;
  }
  const netTokenSavings =
    accounting.originalTokens -
    accounting.encodedTokens -
    accounting.decoderOverheadTokens;
  const savingsRatioPpm = Math.floor(
    (Math.max(0, netTokenSavings) * 1_000_000) /
      Math.max(1, accounting.originalTokens),
  );
  return { netTokenSavings, savingsRatioPpm };
}

export function candidateNetBenefitReasons(input: {
  readonly codec: Codec;
  readonly policy: CodecPolicy;
  readonly accounting: TokenAccounting;
}): readonly ReasonCode[] {
  if (input.codec.descriptor.id === 'identity') {
    return [];
  }
  const benefit = computeTokenBenefit(input.accounting);
  if (benefit === undefined) {
    return ['TOKENIZER_ERROR'];
  }
  if (benefit.netTokenSavings <= 0) {
    return [
      input.accounting.decoderOverheadTokens >=
      input.accounting.originalTokens - input.accounting.encodedTokens
        ? 'DECODER_OVERHEAD_EXCEEDS_SAVINGS'
        : 'NO_SAVINGS',
    ];
  }
  if (
    benefit.netTokenSavings < input.policy.selection.minTokenSavings ||
    benefit.savingsRatioPpm < input.policy.selection.minSavingsRatioPpm
  ) {
    return ['BELOW_MIN_SAVINGS'];
  }
  return [];
}

function isTokenValue(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
