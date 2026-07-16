import { describe, expect, it } from 'vitest';

import { sha256 } from '../src/domain/hash.js';
import {
  summarizeIntentCachePromotionOverhead,
  summarizeIntentCachePromotionSavings,
} from '../src/intent-host/promotion-metrics.js';
import type {
  IntentCachePromotionCompleteUsageObservation,
  IntentCachePromotionIncompleteUsageObservation,
  IntentCachePromotionUsagePair,
} from '../src/intent-host/types.js';

function completeObservation(
  label: string,
  overrides: Partial<IntentCachePromotionCompleteUsageObservation> = {},
): IntentCachePromotionCompleteUsageObservation {
  return {
    completeness: 'complete',
    traceDigest: sha256(`trace:${label}`),
    physicalInputTokens: 100,
    providerPrefixCacheReadInputTokens: 0,
    providerPrefixCacheWriteInputTokens: 0,
    applicationSemanticCacheLookups: 1,
    applicationSemanticCacheReads: 0,
    applicationSemanticCacheWrites: 0,
    applicationSemanticCacheInvalidations: 0,
    outputTokens: 10,
    reasoningTokens: 0,
    normalizedCostUnits: 100,
    allocatedInvalidationCostUnits: 0,
    endToEndLatencyMicros: 100,
    normalizerLatencyMicros: 1,
    candidateIndexLatencyMicros: 1,
    storeLatencyMicros: 1,
    lookupLatencyMicros: 1,
    verifierLatencyMicros: 1,
    fallbackLatencyMicros: 0,
    toolCalls: 0,
    attempts: 1,
    retries: 0,
    recoveries: 0,
    ...overrides,
  };
}

function incompleteObservation(
  label: string,
): IntentCachePromotionIncompleteUsageObservation {
  return {
    ...completeObservation(label),
    completeness: 'incomplete',
    failureDigest: sha256(`failure:${label}`),
    fallbackLatencyMicros: null,
  };
}

function completePair(
  label: string,
  ordinary: Partial<IntentCachePromotionCompleteUsageObservation> = {},
  candidate: Partial<IntentCachePromotionCompleteUsageObservation> = {},
): IntentCachePromotionUsagePair {
  return {
    costModelDigest: sha256('cost-model'),
    currencyUnitDigest: sha256('currency-unit'),
    accounting: { completeness: 'complete' },
    ordinary: completeObservation(`${label}:ordinary`, ordinary),
    candidate: completeObservation(`${label}:candidate`, candidate),
  };
}

describe('intent cache promotion metrics', () => {
  it('computes conservative savings and exact decimal totals', () => {
    const result = summarizeIntentCachePromotionSavings([
      {
        usage: completePair(
          'safe',
          {},
          { physicalInputTokens: 80, normalizedCostUnits: 80 },
        ),
        creditPositiveSavings: true,
      },
    ]);

    expect(result).toMatchObject({
      status: 'available',
      caseCount: 1,
      safeNormalizedIntentWouldHits: 1,
      metrics: {
        medianNetSavingsRatioPpm: 200_000,
        aggregateNetSavingsRatioPpm: 200_000,
        p10NetSavingsRatioPpm: 200_000,
        maximumCaseNetRegressionRatioPpm: 0,
      },
      totals: {
        ordinary: {
          physicalInputTokens: '100',
          effectiveCostUnits: '100',
        },
        candidate: {
          physicalInputTokens: '80',
          effectiveCostUnits: '80',
        },
      },
    });
  });

  it('never credits positive savings outside a safe normalized would-hit', () => {
    const result = summarizeIntentCachePromotionSavings([
      {
        usage: completePair(
          'bypass',
          {},
          { physicalInputTokens: 20, normalizedCostUnits: 20 },
        ),
        creditPositiveSavings: false,
      },
      {
        usage: completePair(
          'regression',
          {},
          { physicalInputTokens: 150, normalizedCostUnits: 150 },
        ),
        creditPositiveSavings: false,
      },
    ]);

    expect(result).toMatchObject({
      status: 'available',
      metrics: {
        medianNetSavingsRatioPpm: -500_000,
        aggregateNetSavingsRatioPpm: -250_000,
        p10NetSavingsRatioPpm: -500_000,
        maximumCaseNetRegressionRatioPpm: 500_000,
      },
      totals: {
        creditedCandidate: {
          physicalInputTokens: '250',
          effectiveCostUnits: '250',
        },
      },
    });
  });

  it('includes allocated invalidation cost and rounds regressions away from zero', () => {
    const result = summarizeIntentCachePromotionSavings([
      {
        usage: completePair(
          'rounding',
          {
            physicalInputTokens: 3,
            normalizedCostUnits: 90,
            allocatedInvalidationCostUnits: 10,
          },
          {
            physicalInputTokens: 4,
            normalizedCostUnits: 80,
            allocatedInvalidationCostUnits: 20,
          },
        ),
        creditPositiveSavings: true,
      },
    ]);

    expect(result).toMatchObject({
      status: 'available',
      metrics: {
        medianNetSavingsRatioPpm: -333_334,
        aggregateNetSavingsRatioPpm: -333_334,
        maximumCaseNetRegressionRatioPpm: 333_334,
      },
    });
  });

  it('makes all value unavailable instead of imputing incomplete accounting', () => {
    const result = summarizeIntentCachePromotionSavings([
      {
        creditPositiveSavings: false,
        usage: {
          costModelDigest: sha256('cost-model'),
          currencyUnitDigest: sha256('currency-unit'),
          accounting: {
            completeness: 'incomplete',
            failureDigest: sha256('pair-failure'),
          },
          ordinary: incompleteObservation('ordinary'),
          candidate: completeObservation('candidate'),
        },
      },
    ]);

    expect(result).toEqual({
      status: 'unavailable',
      caseCount: 1,
      safeNormalizedIntentWouldHits: 0,
      reason: 'INCOMPLETE_ACCOUNTING',
    });
  });

  it('uses upper medians and conservative ceiling arithmetic for overhead', () => {
    const result = summarizeIntentCachePromotionOverhead([
      completePair(
        'lower',
        { normalizedCostUnits: 3, endToEndLatencyMicros: 3 },
        { normalizedCostUnits: 3, endToEndLatencyMicros: 2 },
      ),
      completePair(
        'upper',
        { normalizedCostUnits: 3, endToEndLatencyMicros: 3 },
        { normalizedCostUnits: 4, endToEndLatencyMicros: 4 },
      ),
    ]);

    expect(result).toMatchObject({
      status: 'available',
      metrics: {
        medianCostOverheadRatioPpm: 333_334,
        aggregateCostOverheadRatioPpm: 166_667,
        medianLatencyOverheadRatioPpm: 333_334,
        aggregateLatencyOverheadRatioPpm: 0,
      },
    });
  });

  it('rejects zero baselines rather than fabricating ratios', () => {
    expect(() =>
      summarizeIntentCachePromotionSavings([
        {
          usage: completePair('zero', { physicalInputTokens: 0 }),
          creditPositiveSavings: true,
        },
      ]),
    ).toThrow(/must be positive/u);
    expect(() =>
      summarizeIntentCachePromotionOverhead([
        completePair('zero-latency', { endToEndLatencyMicros: 0 }),
      ]),
    ).toThrow(/must be positive/u);
  });
});
