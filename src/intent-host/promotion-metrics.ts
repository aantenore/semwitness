import { SemWitnessError } from '../domain/errors.js';
import type {
  IntentCachePromotionCompleteUsageObservation,
  IntentCachePromotionUsagePair,
} from './types.js';

const PPM = 1_000_000n;

export const INTENT_CACHE_PROMOTION_USAGE_COUNTER_FIELDS = [
  'physicalInputTokens',
  'providerPrefixCacheReadInputTokens',
  'providerPrefixCacheWriteInputTokens',
  'applicationSemanticCacheLookups',
  'applicationSemanticCacheReads',
  'applicationSemanticCacheWrites',
  'applicationSemanticCacheInvalidations',
  'outputTokens',
  'reasoningTokens',
  'normalizedCostUnits',
  'allocatedInvalidationCostUnits',
  'endToEndLatencyMicros',
  'normalizerLatencyMicros',
  'candidateIndexLatencyMicros',
  'storeLatencyMicros',
  'lookupLatencyMicros',
  'verifierLatencyMicros',
  'fallbackLatencyMicros',
  'toolCalls',
  'attempts',
  'retries',
  'recoveries',
] as const;

type UsageCounterField =
  (typeof INTENT_CACHE_PROMOTION_USAGE_COUNTER_FIELDS)[number];

export type IntentCachePromotionUsageTotals = Readonly<
  Record<UsageCounterField, string>
> & {
  readonly effectiveCostUnits: string;
};

export interface IntentCachePromotionSavingsMetrics {
  readonly medianNetSavingsRatioPpm: number;
  readonly aggregateNetSavingsRatioPpm: number;
  readonly p10NetSavingsRatioPpm: number;
  readonly maximumCaseNetRegressionRatioPpm: number;
}

export interface IntentCachePromotionSavingsTotals {
  readonly ordinary: IntentCachePromotionUsageTotals;
  readonly candidate: IntentCachePromotionUsageTotals;
  readonly creditedCandidate: {
    readonly physicalInputTokens: string;
    readonly effectiveCostUnits: string;
  };
}

export type IntentCachePromotionSavingsEvaluation =
  | {
      readonly status: 'available';
      readonly caseCount: number;
      readonly safeNormalizedIntentWouldHits: number;
      readonly metrics: IntentCachePromotionSavingsMetrics;
      readonly totals: IntentCachePromotionSavingsTotals;
    }
  | {
      readonly status: 'unavailable';
      readonly caseCount: number;
      readonly safeNormalizedIntentWouldHits: number;
      readonly reason: 'NO_CASES' | 'INCOMPLETE_ACCOUNTING';
    };

export interface IntentCachePromotionOverheadMetrics {
  readonly medianCostOverheadRatioPpm: number;
  readonly aggregateCostOverheadRatioPpm: number;
  readonly medianLatencyOverheadRatioPpm: number;
  readonly aggregateLatencyOverheadRatioPpm: number;
}

export type IntentCachePromotionOverheadEvaluation =
  | {
      readonly status: 'available';
      readonly caseCount: number;
      readonly metrics: IntentCachePromotionOverheadMetrics;
    }
  | {
      readonly status: 'unavailable';
      readonly caseCount: number;
      readonly reason: 'NO_CASES' | 'INCOMPLETE_ACCOUNTING';
    };

export interface IntentCachePromotionValueCase {
  readonly usage: IntentCachePromotionUsagePair;
  readonly creditPositiveSavings: boolean;
}

export function summarizeIntentCachePromotionSavings(
  cases: readonly IntentCachePromotionValueCase[],
): IntentCachePromotionSavingsEvaluation {
  const safeNormalizedIntentWouldHits = cases.filter(
    (item) => item.creditPositiveSavings,
  ).length;
  if (cases.length === 0) {
    return Object.freeze({
      status: 'unavailable' as const,
      caseCount: 0,
      safeNormalizedIntentWouldHits,
      reason: 'NO_CASES' as const,
    });
  }
  if (cases.some((item) => item.usage.accounting.completeness !== 'complete')) {
    return Object.freeze({
      status: 'unavailable' as const,
      caseCount: cases.length,
      safeNormalizedIntentWouldHits,
      reason: 'INCOMPLETE_ACCOUNTING' as const,
    });
  }

  const completeCases = cases as readonly {
    readonly usage: Extract<
      IntentCachePromotionUsagePair,
      { readonly accounting: { readonly completeness: 'complete' } }
    >;
    readonly creditPositiveSavings: boolean;
  }[];
  const ordinaryObservations = completeCases.map((item) => item.usage.ordinary);
  const candidateObservations = completeCases.map(
    (item) => item.usage.candidate,
  );
  const ordinaryTotals = sumUsage(ordinaryObservations);
  const candidateTotals = sumUsage(candidateObservations);
  let creditedInput = 0n;
  let creditedCost = 0n;
  const perCaseNetSavings: bigint[] = [];

  for (const item of completeCases) {
    const ordinaryInput = BigInt(item.usage.ordinary.physicalInputTokens);
    const candidateInput = BigInt(item.usage.candidate.physicalInputTokens);
    const ordinaryCost = effectiveCost(item.usage.ordinary);
    const candidateCost = effectiveCost(item.usage.candidate);
    assertPositiveBaseline(ordinaryInput, 'physical input tokens');
    assertPositiveBaseline(ordinaryCost, 'effective cost units');

    const creditedCaseInput = item.creditPositiveSavings
      ? candidateInput
      : maxBigInt(candidateInput, ordinaryInput);
    const creditedCaseCost = item.creditPositiveSavings
      ? candidateCost
      : maxBigInt(candidateCost, ordinaryCost);
    creditedInput += creditedCaseInput;
    creditedCost += creditedCaseCost;
    perCaseNetSavings.push(
      minBigInt(
        savingsPpm(ordinaryInput, creditedCaseInput),
        savingsPpm(ordinaryCost, creditedCaseCost),
      ),
    );
  }

  const aggregateNetSavings = minBigInt(
    savingsPpm(BigInt(ordinaryTotals.physicalInputTokens), creditedInput),
    savingsPpm(BigInt(ordinaryTotals.effectiveCostUnits), creditedCost),
  );
  const sorted = [...perCaseNetSavings].sort(compareBigInt);
  const median = lowerNearestRank(sorted, 50);
  const p10 = lowerNearestRank(sorted, 10);
  const maximumRegression = sorted.reduce(
    (maximum, value) => maxBigInt(maximum, value < 0n ? -value : 0n),
    0n,
  );

  return Object.freeze({
    status: 'available' as const,
    caseCount: cases.length,
    safeNormalizedIntentWouldHits,
    metrics: Object.freeze({
      medianNetSavingsRatioPpm: boundedInteger(median),
      aggregateNetSavingsRatioPpm: boundedInteger(aggregateNetSavings),
      p10NetSavingsRatioPpm: boundedInteger(p10),
      maximumCaseNetRegressionRatioPpm: boundedInteger(maximumRegression),
    }),
    totals: Object.freeze({
      ordinary: ordinaryTotals,
      candidate: candidateTotals,
      creditedCandidate: Object.freeze({
        physicalInputTokens: creditedInput.toString(),
        effectiveCostUnits: creditedCost.toString(),
      }),
    }),
  });
}

export function summarizeIntentCachePromotionOverhead(
  usagePairs: readonly IntentCachePromotionUsagePair[],
): IntentCachePromotionOverheadEvaluation {
  if (usagePairs.length === 0) {
    return Object.freeze({
      status: 'unavailable' as const,
      caseCount: 0,
      reason: 'NO_CASES' as const,
    });
  }
  if (
    usagePairs.some((usage) => usage.accounting.completeness !== 'complete')
  ) {
    return Object.freeze({
      status: 'unavailable' as const,
      caseCount: usagePairs.length,
      reason: 'INCOMPLETE_ACCOUNTING' as const,
    });
  }

  const completePairs = usagePairs as readonly Extract<
    IntentCachePromotionUsagePair,
    { readonly accounting: { readonly completeness: 'complete' } }
  >[];
  const costRatios: bigint[] = [];
  const latencyRatios: bigint[] = [];
  let ordinaryCostTotal = 0n;
  let candidateCostTotal = 0n;
  let ordinaryLatencyTotal = 0n;
  let candidateLatencyTotal = 0n;

  for (const usage of completePairs) {
    const ordinaryCost = effectiveCost(usage.ordinary);
    const candidateCost = effectiveCost(usage.candidate);
    const ordinaryLatency = BigInt(usage.ordinary.endToEndLatencyMicros);
    const candidateLatency = BigInt(usage.candidate.endToEndLatencyMicros);
    assertPositiveBaseline(ordinaryCost, 'effective cost units');
    assertPositiveBaseline(ordinaryLatency, 'end-to-end latency');
    costRatios.push(overheadPpm(ordinaryCost, candidateCost));
    latencyRatios.push(overheadPpm(ordinaryLatency, candidateLatency));
    ordinaryCostTotal += ordinaryCost;
    candidateCostTotal += candidateCost;
    ordinaryLatencyTotal += ordinaryLatency;
    candidateLatencyTotal += candidateLatency;
  }

  costRatios.sort(compareBigInt);
  latencyRatios.sort(compareBigInt);
  return Object.freeze({
    status: 'available' as const,
    caseCount: usagePairs.length,
    metrics: Object.freeze({
      medianCostOverheadRatioPpm: boundedInteger(upperMedian(costRatios)),
      aggregateCostOverheadRatioPpm: boundedInteger(
        overheadPpm(ordinaryCostTotal, candidateCostTotal),
      ),
      medianLatencyOverheadRatioPpm: boundedInteger(upperMedian(latencyRatios)),
      aggregateLatencyOverheadRatioPpm: boundedInteger(
        overheadPpm(ordinaryLatencyTotal, candidateLatencyTotal),
      ),
    }),
  });
}

function sumUsage(
  observations: readonly IntentCachePromotionCompleteUsageObservation[],
): IntentCachePromotionUsageTotals {
  const totals: Record<UsageCounterField, bigint> = Object.create(
    null,
  ) as Record<UsageCounterField, bigint>;
  for (const field of INTENT_CACHE_PROMOTION_USAGE_COUNTER_FIELDS) {
    totals[field] = observations.reduce(
      (sum, observation) => sum + BigInt(observation[field]),
      0n,
    );
  }
  const output: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  for (const field of INTENT_CACHE_PROMOTION_USAGE_COUNTER_FIELDS) {
    output[field] = totals[field].toString();
  }
  output.effectiveCostUnits = (
    totals.normalizedCostUnits + totals.allocatedInvalidationCostUnits
  ).toString();
  return Object.freeze(output) as IntentCachePromotionUsageTotals;
}

function effectiveCost(
  observation: IntentCachePromotionCompleteUsageObservation,
): bigint {
  return (
    BigInt(observation.normalizedCostUnits) +
    BigInt(observation.allocatedInvalidationCostUnits)
  );
}

function savingsPpm(baseline: bigint, candidate: bigint): bigint {
  assertPositiveBaseline(baseline, 'savings denominator');
  return floorDivide((baseline - candidate) * PPM, baseline);
}

function overheadPpm(baseline: bigint, candidate: bigint): bigint {
  assertPositiveBaseline(baseline, 'overhead denominator');
  return ceilDivide((candidate - baseline) * PPM, baseline);
}

function floorDivide(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return remainder !== 0n && numerator < 0n ? quotient - 1n : quotient;
}

function ceilDivide(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return remainder !== 0n && numerator > 0n ? quotient + 1n : quotient;
}

function lowerNearestRank(
  sorted: readonly bigint[],
  percentile: 10 | 50,
): bigint {
  const index = Math.max(0, Math.ceil((sorted.length * percentile) / 100) - 1);
  return sorted[index]!;
}

function upperMedian(sorted: readonly bigint[]): bigint {
  return sorted[Math.floor(sorted.length / 2)]!;
}

function boundedInteger(value: bigint): number {
  const maximum = BigInt(Number.MAX_SAFE_INTEGER);
  if (value > maximum) return Number.MAX_SAFE_INTEGER;
  if (value < -maximum) return -Number.MAX_SAFE_INTEGER;
  return Number(value);
}

function assertPositiveBaseline(value: bigint, label: string): void {
  if (value <= 0n) {
    throw new SemWitnessError(
      'MALFORMED_ENVELOPE',
      `Intent cache promotion ${label} must be positive`,
    );
  }
}

function compareBigInt(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function minBigInt(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

function maxBigInt(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}
