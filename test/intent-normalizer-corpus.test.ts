import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  DeclarativeIntentNormalizer,
  INTENT_EVALUATION_PHENOMENA,
  evaluateIntentNormalizer,
  parseIntentEvaluationJsonl,
  parseIntentOperationRegistry,
} from '../src/intent/index.js';
import {
  canonicalIntentAliasText,
  canonicalIntentLocale,
} from '../src/intent/intent-lexical.js';

const registryPath = fileURLToPath(
  new URL('../examples/intent-normalizer.json', import.meta.url),
);
const fixturePath = fileURLToPath(
  new URL('../examples/intent-normalizer-eval.jsonl', import.meta.url),
);

function aliasKey(locale: string, source: string): string {
  return `${canonicalIntentLocale(locale)}\\0${canonicalIntentAliasText(source)}`;
}

async function loadCorpus() {
  const [registrySource, fixtureSource] = await Promise.all([
    readFile(registryPath, 'utf8'),
    readFile(fixturePath, 'utf8'),
  ]);
  return {
    registrySource,
    registry: parseIntentOperationRegistry(registrySource),
    fixture: parseIntentEvaluationJsonl(fixtureSource),
  };
}

describe('checked-in intent-normalizer corpus', () => {
  it('encodes balanced intent, safety-bypass, equivalent, and distinct coverage', async () => {
    const { registry, fixture } = await loadCorpus();

    expect(fixture.cases).toHaveLength(120);
    const splitCases = Map.groupBy(fixture.cases, (item) => item.split);
    expect(splitCases.get('conformance')).toHaveLength(30);
    expect(splitCases.get('development')).toHaveLength(30);
    expect(splitCases.get('held-out')).toHaveLength(60);

    const intentCases = fixture.cases.filter(
      (item) => item.expect.kind === 'intent',
    );
    const bypassCases = fixture.cases.filter(
      (item) => item.expect.kind === 'bypass',
    );
    expect(intentCases).toHaveLength(96);
    expect(bypassCases).toHaveLength(24);
    const intentSplits = Map.groupBy(intentCases, (item) => item.split);
    expect(intentSplits.get('conformance')).toHaveLength(24);
    expect(intentSplits.get('development')).toHaveLength(24);
    expect(intentSplits.get('held-out')).toHaveLength(48);
    const bypassSplits = Map.groupBy(bypassCases, (item) => item.split);
    expect(bypassSplits.get('conformance')).toHaveLength(6);
    expect(bypassSplits.get('development')).toHaveLength(6);
    expect(bypassSplits.get('held-out')).toHaveLength(12);

    const families = Map.groupBy(intentCases, (item) => item.familyId);
    expect(families.size).toBe(12);
    for (const cases of families.values()) expect(cases).toHaveLength(8);

    const equivalents = fixture.comparisons.filter(
      (item) => item.relation === 'equivalent',
    );
    const distinct = fixture.comparisons.filter(
      (item) => item.relation === 'distinct',
    );
    expect(equivalents).toHaveLength(48);
    expect(distinct).toHaveLength(96);

    const equivalentDegree = new Map<string, number>(
      intentCases.map((item) => [item.id, 0]),
    );
    const distinctDegree = new Map<string, number>(
      intentCases.map((item) => [item.id, 0]),
    );
    for (const comparison of equivalents) {
      equivalentDegree.set(
        comparison.leftCaseId,
        equivalentDegree.get(comparison.leftCaseId)! + 1,
      );
      equivalentDegree.set(
        comparison.rightCaseId,
        equivalentDegree.get(comparison.rightCaseId)! + 1,
      );
    }
    for (const comparison of distinct) {
      distinctDegree.set(
        comparison.leftCaseId,
        distinctDegree.get(comparison.leftCaseId)! + 1,
      );
      distinctDegree.set(
        comparison.rightCaseId,
        distinctDegree.get(comparison.rightCaseId)! + 1,
      );
    }
    expect([...equivalentDegree.values()].every((count) => count === 1)).toBe(
      true,
    );
    expect([...distinctDegree.values()].every((count) => count === 2)).toBe(
      true,
    );
    const comparedCaseIds = new Set(
      fixture.comparisons.flatMap((item) => [
        item.leftCaseId,
        item.rightCaseId,
      ]),
    );
    expect(bypassCases.every((item) => !comparedCaseIds.has(item.id))).toBe(
      true,
    );

    const phenomena = new Set(
      fixture.cases.flatMap((item) => [...item.phenomena]),
    );
    expect([...phenomena].sort()).toEqual(
      [...INTENT_EVALUATION_PHENOMENA].sort(),
    );

    const caseKeys = new Set(
      fixture.cases.map((item) =>
        aliasKey(item.input.locale, item.input.source),
      ),
    );
    for (const operation of registry.operations) {
      expect(
        operation.aliases.some(
          (alias) => !caseKeys.has(aliasKey(alias.locale, alias.text)),
        ),
      ).toBe(true);
    }

    const aliasKeys = new Set(
      registry.operations.flatMap((operation) =>
        operation.aliases.map((alias) => aliasKey(alias.locale, alias.text)),
      ),
    );
    const inDistribution = fixture.cases.filter((item) =>
      aliasKeys.has(aliasKey(item.input.locale, item.input.source)),
    );
    expect(
      Map.groupBy(inDistribution, (item) => item.split).get('conformance'),
    ).toHaveLength(24);

    // These 72 intent cases are OOD relative to the exact-alias baseline,
    // while their typed Intent IR remains ground truth for future candidates.
    expect(
      intentCases.filter(
        (item) =>
          item.split !== 'conformance' &&
          aliasKeys.has(aliasKey(item.input.locale, item.input.source)),
      ),
    ).toHaveLength(0);
  });

  it('passes conformance and measures the exact-alias OOD ceiling elsewhere', async () => {
    const { registrySource, fixture } = await loadCorpus();
    const normalizer = new DeclarativeIntentNormalizer(registrySource);

    const [conformance, all] = await Promise.all([
      evaluateIntentNormalizer({
        compiler: normalizer,
        registry: normalizer,
        fixture,
        split: 'conformance',
        attempts: 2,
      }),
      evaluateIntentNormalizer({
        compiler: normalizer,
        registry: normalizer,
        fixture,
        split: 'all',
        attempts: 2,
      }),
    ]);

    expect(conformance.caseMetrics).toMatchObject({
      total: 30,
      passed: 30,
      failed: 0,
      expectedIntent: 24,
      exactIntentMatches: 24,
      exactIntentAccuracyPpm: 1_000_000,
      expectedBypass: 6,
      correctBypasses: 6,
      bypassAccuracyPpm: 1_000_000,
      proposed: 24,
      bypassed: 6,
      unsafeAccepts: 0,
      executionFailures: 0,
      repeatabilityFailures: 0,
      contractDrift: false,
    });
    expect(conformance.comparisonMetrics).toMatchObject({
      equivalentTrials: 12,
      convergencePasses: 12,
      convergenceRecallPpm: 1_000_000,
      distinctTrials: 24,
      falseMerges: 0,
      falseMergeRatePpm: 0,
      falseMergeUpperBound95Ppm: null,
    });
    expect(conformance.gate).toEqual({ passed: true, reasons: [] });

    expect(all.caseMetrics).toMatchObject({
      total: 120,
      passed: 48,
      failed: 72,
      expectedIntent: 96,
      exactIntentMatches: 24,
      exactIntentAccuracyPpm: 250_000,
      expectedBypass: 24,
      correctBypasses: 24,
      bypassAccuracyPpm: 1_000_000,
      proposed: 24,
      bypassed: 96,
      unsafeAccepts: 0,
      executionFailures: 0,
      repeatabilityFailures: 0,
      contractDrift: false,
    });
    expect(all.comparisonMetrics).toMatchObject({
      equivalentTrials: 48,
      convergencePasses: 12,
      convergenceRecallPpm: 250_000,
      distinctTrials: 96,
      falseMerges: 0,
      falseMergeRatePpm: 0,
      falseMergeUpperBound95Ppm: null,
    });
    expect(all.gate).toEqual({
      passed: false,
      reasons: ['CASE_FAILURES', 'COMPARISON_FAILURES'],
    });
    expect(all.statisticalReadiness).toEqual({
      ready: false,
      reasons: ['IID_SAMPLING_NOT_ATTESTED'],
    });
  });
});
