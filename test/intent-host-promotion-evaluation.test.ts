import { describe, expect, it } from 'vitest';

import {
  INTENT_CACHE_PROMOTION_GATE_REASONS,
  evaluateIntentCachePromotionEvidence,
} from '../src/intent-host/index.js';
import {
  createDistinctIntentPromotionFixture,
  createEmptyIntentPromotionFixture,
  createSideEffectIntentPromotionFixture,
  createUnsafeHitIntentPromotionFixture,
} from './support/intent-promotion-qualification-fixture.js';

describe('intent cache promotion evaluation', () => {
  it('materializes every fixed cell and returns stable ordered gate failures', () => {
    const fixture = createEmptyIntentPromotionFixture();
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
          'ADVERSARIAL_PHENOMENA_MISSING',
        ].includes(reason),
      ),
    );
    expect(first.reportDigest).toBe(second.reportDigest);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.report.adversarial.intersections)).toBe(true);
    expect('qualification' in first).toBe(false);
  });

  it('derives unsafe normalized hits and does not credit their apparent savings', () => {
    const fixture = createUnsafeHitIntentPromotionFixture();
    const result = evaluateIntentCachePromotionEvidence(fixture);

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
          effectiveCostUnits: '1000',
        },
      },
    });
    expect(result.report.gateReasons).toContain(
      'UNSAFE_NORMALIZED_INTENT_HITS',
    );
    expect(result.report.failureRefs).toContainEqual({
      reason: 'UNSAFE_NORMALIZED_INTENT_HITS',
      caseDigests: [fixture.cases[0]!.caseDigest],
    });
  });

  it('accepts only a coherent, separately bound side-effect probe', () => {
    const coherent = evaluateIntentCachePromotionEvidence(
      createSideEffectIntentPromotionFixture(),
    );

    expect(coherent.report.adversarial.truthTableViolations).toBe(0);
    expect(coherent.report.gateReasons).not.toContain(
      'SIDE_EFFECT_POLICY_BYPASS_VIOLATION',
    );
    expect(() =>
      evaluateIntentCachePromotionEvidence(
        createSideEffectIntentPromotionFixture(false),
      ),
    ).toThrowError(expect.objectContaining({ code: 'MALFORMED_ENVELOPE' }));
  });

  it('rejects a distinct near miss that merely misses instead of proving a candidate bypass', () => {
    const bypass = evaluateIntentCachePromotionEvidence(
      createDistinctIntentPromotionFixture('candidate-bypass'),
    );
    const miss = evaluateIntentCachePromotionEvidence(
      createDistinctIntentPromotionFixture('miss'),
    );

    expect(bypass.report.adversarial.truthTableViolations).toBe(0);
    expect(miss.report.adversarial.truthTableViolations).toBe(1);
    expect(miss.report.gateReasons).toContain(
      'ADVERSARIAL_TRUTH_TABLE_VIOLATIONS',
    );
  });

  it('reports missing required phenomenon tags and strictly parses every public input form', () => {
    const result = evaluateIntentCachePromotionEvidence(
      createDistinctIntentPromotionFixture('candidate-bypass'),
    );

    expect(result.report.adversarial.phenomenonCoverage.observed).toEqual([
      'negation',
    ]);
    expect(result.report.adversarial.phenomenonCoverage.missing).toContain(
      'unicode',
    );
    expect(result.report.gateReasons).toContain(
      'ADVERSARIAL_PHENOMENA_MISSING',
    );
    const emptyJsonl = JSON.stringify(
      createEmptyIntentPromotionFixture().binding,
    );
    expect(
      evaluateIntentCachePromotionEvidence(emptyJsonl).report.bindingDigest,
    ).toBe(
      evaluateIntentCachePromotionEvidence(new TextEncoder().encode(emptyJsonl))
        .report.bindingDigest,
    );
    expect(() =>
      evaluateIntentCachePromotionEvidence({
        binding: { bindingDigest: 'trusted-looking' },
        cases: [],
      }),
    ).toThrowError(expect.objectContaining({ code: 'MALFORMED_ENVELOPE' }));
    expect(() =>
      evaluateIntentCachePromotionEvidence('{"kind":"binding"}'),
    ).toThrowError(expect.objectContaining({ code: 'MALFORMED_ENVELOPE' }));
    expect(() =>
      evaluateIntentCachePromotionEvidence(
        new TextEncoder().encode('{"kind":"binding"}'),
      ),
    ).toThrowError(expect.objectContaining({ code: 'MALFORMED_ENVELOPE' }));
  });
});
