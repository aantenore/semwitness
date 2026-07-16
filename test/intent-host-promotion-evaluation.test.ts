import { describe, expect, it } from 'vitest';

import { sha256 } from '../src/domain/hash.js';
import {
  INTENT_CACHE_PROMOTION_GATE_REASONS,
  evaluateIntentCachePromotionEvidence,
} from '../src/intent-host/promotion-evaluation.js';
import type {
  IntentCacheAdversarialCompleteCase,
  IntentCachePopulationCompleteCase,
  IntentCachePromotionCompleteUsageObservation,
  IntentCachePromotionEvidenceBinding,
  IntentCachePromotionEvidenceFixture,
  IntentCachePromotionUsagePair,
} from '../src/intent-host/types.js';

function binding(
  population: number,
  adversarial: number,
): IntentCachePromotionEvidenceBinding {
  return {
    bindingDigest: sha256('binding'),
    population: {
      attempted: population,
      emitted: population,
      complete: population,
      failed: 0,
      dropped: 0,
    },
    adversarial: {
      expected: adversarial,
      emitted: adversarial,
      complete: adversarial,
      failed: 0,
    },
  } as IntentCachePromotionEvidenceBinding;
}

function observation(
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

function usage(label: string): IntentCachePromotionUsagePair {
  return {
    costModelDigest: sha256('cost-model'),
    currencyUnitDigest: sha256('currency'),
    accounting: { completeness: 'complete' },
    ordinary: observation(`${label}:ordinary`),
    candidate: observation(`${label}:candidate`, {
      physicalInputTokens: 80,
      normalizedCostUnits: 80,
    }),
  };
}

function unsafePopulationCase(): IntentCachePopulationCompleteCase {
  return {
    kind: 'population-complete',
    clusterHmac: `hmac-sha256:cluster:${'1'.repeat(64)}`,
    difficulty: 'simple',
    cacheRegime: 'cold',
    usage: usage('unsafe'),
    caseDigest: sha256('unsafe-case'),
    storeFault: { kind: 'not-injected' },
    path: {
      kind: 'candidate-bearing',
      normalizationWitness: {
        sourceDigest: `hmac-sha256:intent-source:${'2'.repeat(64)}`,
      },
      entrySourceBinding: {
        entrySourceHmac: `hmac-sha256:intent-source:${'3'.repeat(64)}`,
      },
      cacheHitWitness: { decision: { verdict: 'eligible' } },
      oracle: {
        kind: 'candidate',
        artifactRelation: 'different',
        scope: 'match',
        authorization: 'current-allow',
        freshness: 'fresh',
        effectTier: 'allowed',
        policy: 'allow',
        taskQuality: 'pass',
      },
    },
  } as IntentCachePopulationCompleteCase;
}

function invalidSideEffectCase(): IntentCacheAdversarialCompleteCase {
  return {
    kind: 'adversarial-complete',
    primaryScenario: 'side-effect',
    phenomena: [],
    difficulty: 'simple',
    cacheRegime: 'cold',
    usage: usage('side-effect'),
    caseDigest: sha256('side-effect-case'),
    storeFault: { kind: 'not-injected' },
    path: unsafePopulationCase().path,
  } as unknown as IntentCacheAdversarialCompleteCase;
}

describe('intent cache promotion evaluation', () => {
  it('materializes every fixed cell and returns stable ordered gate failures', () => {
    const fixture: IntentCachePromotionEvidenceFixture = {
      binding: binding(0, 0),
      cases: [],
    };
    const first = evaluateIntentCachePromotionEvidence(fixture);
    const second = evaluateIntentCachePromotionEvidence(fixture);

    expect(first.qualified).toBe(false);
    expect(first.report.value.criticalIntersections).toHaveLength(8);
    expect(first.report.adversarial.intersections).toHaveLength(72);
    expect(first.report.gateReasons).toEqual(
      INTENT_CACHE_PROMOTION_GATE_REASONS.filter((reason) =>
        [
          'VALUE_ACCOUNTING_UNAVAILABLE',
          'FALSE_DISCOVERY_BOUND_ABOVE_CEILING',
          'UNSAFE_ADMISSION_BOUND_ABOVE_CEILING',
          'INSUFFICIENT_OPERATION_HITS',
          'OPERATION_COVERAGE_BELOW_THRESHOLD',
          'CRITICAL_CELL_MISSING',
          'ADVERSARIAL_CELL_CASES_BELOW_MINIMUM',
        ].includes(reason),
      ),
    );
    expect(first.reportDigest).toBe(second.reportDigest);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.report.adversarial.intersections)).toBe(true);
    expect('qualification' in first).toBe(false);
  });

  it('derives unsafe normalized hits and does not credit their apparent savings', () => {
    const result = evaluateIntentCachePromotionEvidence({
      binding: binding(1, 0),
      cases: [unsafePopulationCase()],
    });

    expect(result.qualified).toBe(false);
    expect(result.report.population.normalizedIntentWouldHits).toBe(1);
    expect(result.report.statisticalClaims.falseDiscoveryRate).toMatchObject({
      failures: 1,
      trials: 1,
      upperBound95Ppm: 1_000_000,
    });
    expect(result.report.statisticalClaims.unsafeAdmissionRate).toMatchObject({
      failures: 1,
      trials: 1,
      upperBound95Ppm: 1_000_000,
    });
    expect(result.report.value.global).toMatchObject({
      status: 'available',
      metrics: {
        medianNetSavingsRatioPpm: 0,
        aggregateNetSavingsRatioPpm: 0,
      },
      totals: {
        creditedCandidate: {
          physicalInputTokens: '100',
          effectiveCostUnits: '100',
        },
      },
    });
    expect(result.report.gateReasons).toContain(
      'UNSAFE_NORMALIZED_INTENT_HITS',
    );
    expect(result.report.failureRefs).toContainEqual({
      reason: 'UNSAFE_NORMALIZED_INTENT_HITS',
      caseDigests: [sha256('unsafe-case')],
    });
  });

  it('derives side-effect conformance instead of trusting the scenario label', () => {
    const result = evaluateIntentCachePromotionEvidence({
      binding: binding(0, 1),
      cases: [invalidSideEffectCase()],
    });

    expect(result.qualified).toBe(false);
    expect(result.report.adversarial.truthTableViolations).toBe(1);
    expect(result.report.gateReasons).toContain(
      'SIDE_EFFECT_POLICY_BYPASS_VIOLATION',
    );
    expect(result.report.failureRefs).toContainEqual({
      reason: 'SIDE_EFFECT_POLICY_BYPASS_VIOLATION',
      caseDigests: [sha256('side-effect-case')],
    });
  });
});
