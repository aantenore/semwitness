import { toJsonValue } from '../domain/canonical-json.js';
import { compareCodeUnits } from '../domain/deterministic-order.js';
import { hashCanonical, isSha256Digest, sha256 } from '../domain/hash.js';
import { zeroFailureGateUpperBound95Ppm } from '../eval/binomial.js';
import { digestIntent, digestIntentSource } from './canonical.js';
import { normalizeIntentShadow } from './compiler.js';
import {
  createIntentEvaluationCheckpoint,
  createIntentEvaluationCheckpointClaim,
  intentEvaluationCheckpointReference,
  parseIntentEvaluationCheckpoint,
} from './evaluation-checkpoint.js';
import { assertParsedIntentEvaluationFixture } from './normalizer-schemas.js';
import {
  INTENT_EVALUATION_REPORT_SCHEMA,
  type EvaluateIntentNormalizerInput,
  type IntentEvaluationCase,
  type IntentEvaluationCaseResult,
  type IntentEvaluationProgress,
  type IntentEvaluationReport,
  type RunIntentNormalizerEvaluationInput,
  type RunIntentNormalizerEvaluationResult,
} from './normalizer-types.js';
import type { IntentReasonCode } from './types.js';

const EVALUATION_POLICY_DIGEST = sha256(
  'semwitness.dev/intent-normalizer-evaluation-policy/v1',
);
const UNAVAILABLE_CONTRACT_DIGEST = sha256(
  'semwitness.dev/intent-normalizer-evaluation/unavailable-contract/v1',
);
const UNAVAILABLE_NORMALIZER_BINDING_DIGEST = sha256(
  'semwitness.dev/intent-normalizer-evaluation/unavailable-normalizer/v1',
);
const UNAVAILABLE_ONTOLOGY_BINDING_DIGEST = sha256(
  'semwitness.dev/intent-normalizer-evaluation/unavailable-ontology/v1',
);

interface AttemptObservation {
  readonly actual: 'intent' | 'bypass';
  readonly fingerprint: string;
  readonly intentDigest?: ReturnType<typeof digestIntent>;
  readonly reasons: readonly IntentReasonCode[];
  readonly executionFailure: boolean;
  readonly contractDigest: ReturnType<typeof sha256>;
  readonly normalizerBindingDigest: ReturnType<typeof sha256>;
  readonly ontologyBindingDigest: ReturnType<typeof sha256>;
}

export async function evaluateIntentNormalizer(
  input: EvaluateIntentNormalizerInput,
): Promise<IntentEvaluationReport> {
  const result = await runIntentNormalizerEvaluation(input);
  if (result.status !== 'complete') {
    throw new TypeError('Unbounded intent evaluation did not complete');
  }
  return result.report;
}

/**
 * Evaluate a fixture in deterministic case/attempt order. When a checkpoint
 * store is supplied, every provider call is preceded by an atomic claim and
 * followed by an immutable content-free checkpoint. A claim without a
 * checkpoint is deliberately indeterminate and is never retried implicitly.
 */
export async function runIntentNormalizerEvaluation(
  input: RunIntentNormalizerEvaluationInput,
): Promise<RunIntentNormalizerEvaluationResult> {
  const attempts = input.attempts ?? 2;
  const split = input.split ?? 'all';
  if (!Number.isSafeInteger(attempts) || attempts < 2 || attempts > 20) {
    throw new TypeError('Intent evaluation attempts must be between 2 and 20');
  }
  if (
    input.maxNewObservations !== undefined &&
    (!Number.isSafeInteger(input.maxNewObservations) ||
      input.maxNewObservations < 0)
  ) {
    throw new TypeError(
      'Intent evaluation maxNewObservations must be a non-negative integer',
    );
  }
  if (input.maxNewObservations !== undefined && !input.checkpointStore) {
    throw new TypeError(
      'Intent evaluation maxNewObservations requires a checkpoint store',
    );
  }
  if (input.checkpointStore && !isSha256Digest(input.checkpointBindingDigest)) {
    throw new TypeError(
      'Intent evaluation checkpointBindingDigest must be a SHA-256 digest',
    );
  }
  assertParsedIntentEvaluationFixture(input.fixture);

  const selectedCases = input.fixture.cases.filter(
    (item) => split === 'all' || item.split === split,
  );
  if (selectedCases.length === 0) {
    throw new TypeError('Intent evaluation split contains no cases');
  }
  const selectedIds = new Set(selectedCases.map((item) => item.id));
  const canonicalOrdinals = new Map(
    input.fixture.cases.map((item, index) => [item, index] as const),
  );
  const selectedComparisons = input.fixture.comparisons.filter(
    (item) =>
      (split === 'all' || item.split === split) &&
      selectedIds.has(item.leftCaseId) &&
      selectedIds.has(item.rightCaseId),
  );

  const checkpointBindingDigest =
    input.checkpointBindingDigest ??
    sha256('semwitness.dev/intent-eval/unbound-checkpoint-run/v1');
  const evaluationBindingDigest = hashCanonical(
    toJsonValue({
      schema: 'semwitness.dev/intent-eval-run-binding/v1',
      evaluationPolicyDigest: EVALUATION_POLICY_DIGEST,
      checkpointBindingDigest,
      corpusDigest: input.fixture.corpusDigest,
      split,
      attemptsPerCase: attempts,
      totalObservations: selectedCases.length * attempts,
    }),
  );
  const totalObservations = selectedCases.length * attempts;
  let resumedObservations = 0;
  let observedThisRun = 0;

  const observations = new Map<string, AttemptObservation[]>();

  for (const fixture of selectedCases) {
    const trial: AttemptObservation[] = [];
    for (let index = 0; index < attempts; index += 1) {
      const caseRef = caseReference(
        input.fixture.corpusDigest,
        canonicalOrdinals.get(fixture)!,
      );
      let observation: AttemptObservation;
      if (!input.checkpointStore) {
        observation = await observe(input, fixture);
        observedThisRun += 1;
      } else {
        const checkpointRef = intentEvaluationCheckpointReference(
          evaluationBindingDigest,
          caseRef,
          index,
        );
        const claim = createIntentEvaluationCheckpointClaim(
          checkpointRef,
          evaluationBindingDigest,
          caseRef,
          index,
        );
        const inspected = await input.checkpointStore.inspect(claim);
        if (inspected.status === 'completed') {
          observation = parseIntentEvaluationCheckpoint(inspected.checkpoint, {
            checkpointRef,
            evaluationBindingDigest,
            caseRef,
            attemptOrdinal: index,
          }).observation;
          resumedObservations += 1;
        } else if (inspected.status === 'indeterminate') {
          return {
            status: 'indeterminate',
            progress: evaluationProgress(
              evaluationBindingDigest,
              totalObservations,
              resumedObservations,
              observedThisRun,
              trial.length + completedObservationCount(observations),
            ),
            checkpointRef,
          };
        } else if (inspected.status === 'missing') {
          if (
            observedThisRun >=
            (input.maxNewObservations ?? Number.POSITIVE_INFINITY)
          ) {
            return {
              status: 'incomplete',
              progress: evaluationProgress(
                evaluationBindingDigest,
                totalObservations,
                resumedObservations,
                observedThisRun,
                trial.length + completedObservationCount(observations),
              ),
            };
          }
          const acquired = await input.checkpointStore.begin(claim);
          if (acquired.status === 'completed') {
            observation = parseIntentEvaluationCheckpoint(acquired.checkpoint, {
              checkpointRef,
              evaluationBindingDigest,
              caseRef,
              attemptOrdinal: index,
            }).observation;
            resumedObservations += 1;
          } else if (acquired.status === 'indeterminate') {
            return {
              status: 'indeterminate',
              progress: evaluationProgress(
                evaluationBindingDigest,
                totalObservations,
                resumedObservations,
                observedThisRun,
                trial.length + completedObservationCount(observations),
              ),
              checkpointRef,
            };
          } else if (acquired.status === 'acquired') {
            if (typeof acquired.commit !== 'function') {
              throw new TypeError(
                'Intent evaluation checkpoint acquisition is malformed',
              );
            }
            observation = await observe(input, fixture);
            const checkpoint = createIntentEvaluationCheckpoint(
              checkpointRef,
              evaluationBindingDigest,
              caseRef,
              index,
              observation,
            );
            await acquired.commit(checkpoint);
            observedThisRun += 1;
          } else {
            throw new TypeError(
              'Intent evaluation checkpoint acquisition is malformed',
            );
          }
        } else {
          throw new TypeError(
            'Intent evaluation checkpoint inspection is malformed',
          );
        }
      }
      trial.push(observation);
    }
    observations.set(fixture.id, trial);
  }

  const report = buildReport(
    input,
    split,
    attempts,
    selectedCases,
    selectedComparisons,
    canonicalOrdinals,
    observations,
  );
  return {
    status: 'complete',
    progress: evaluationProgress(
      evaluationBindingDigest,
      totalObservations,
      resumedObservations,
      observedThisRun,
      totalObservations,
    ),
    report,
  };
}

function buildReport(
  input: EvaluateIntentNormalizerInput,
  split: IntentEvaluationReport['split'],
  attempts: number,
  selectedCases: readonly IntentEvaluationCase[],
  selectedComparisons: readonly {
    readonly leftCaseId: string;
    readonly rightCaseId: string;
    readonly relation: 'equivalent' | 'distinct';
  }[],
  canonicalOrdinals: ReadonlyMap<IntentEvaluationCase, number>,
  observations: ReadonlyMap<string, readonly AttemptObservation[]>,
): IntentEvaluationReport {
  const caseResults: IntentEvaluationCaseResult[] = [];
  const contractDigests = new Set<string>();
  const normalizerBindingDigests = new Set<ReturnType<typeof sha256>>();
  const ontologyBindingDigests = new Set<ReturnType<typeof sha256>>();
  let executionFailures = 0;
  let unsafeAccepts = 0;

  for (const fixture of selectedCases) {
    const trial = observations.get(fixture.id)!;
    for (const observation of trial) {
      contractDigests.add(observation.contractDigest);
      normalizerBindingDigests.add(observation.normalizerBindingDigest);
      ontologyBindingDigests.add(observation.ontologyBindingDigest);
    }

    const first = trial[0]!;
    const repeatable = trial.every(
      (observation) => observation.fingerprint === first.fingerprint,
    );
    const expectedIntentDigest =
      fixture.expect.kind === 'intent'
        ? digestIntent(fixture.expect.intent)
        : undefined;
    const allMatchExpectation = trial.every((observation) =>
      fixture.expect.kind === 'intent'
        ? observation.actual === 'intent' &&
          observation.intentDigest === expectedIntentDigest
        : observation.actual === 'bypass',
    );
    const unsafe = trial.some(
      (observation) =>
        observation.actual === 'intent' &&
        (fixture.expect.kind === 'bypass' ||
          observation.intentDigest !== expectedIntentDigest),
    );
    const actualKeys = new Set(trial.map(outcomeKey));
    const actual =
      actualKeys.size !== 1
        ? 'mixed'
        : first.actual === 'intent'
          ? 'intent'
          : 'bypass';
    const actualIntentDigest =
      actual === 'intent' ? first.intentDigest : undefined;
    const reason = actual === 'bypass' ? first.reasons[0] : undefined;

    if (trial.some((item) => item.executionFailure)) executionFailures += 1;
    if (unsafe) unsafeAccepts += 1;
    caseResults.push({
      caseRef: caseReference(
        input.fixture.corpusDigest,
        canonicalOrdinals.get(fixture)!,
      ),
      split: fixture.split,
      difficulty: fixture.difficulty,
      phenomena: fixture.phenomena,
      expected: fixture.expect.kind,
      actual,
      passed: repeatable && allMatchExpectation,
      repeatable,
      ...(expectedIntentDigest === undefined ? {} : { expectedIntentDigest }),
      ...(actualIntentDigest === undefined ? {} : { actualIntentDigest }),
      ...(reason === undefined ? {} : { reason }),
    });
  }

  const expectedIntent = caseResults.filter(
    (item) => item.expected === 'intent',
  );
  const expectedBypass = caseResults.filter(
    (item) => item.expected === 'bypass',
  );
  const exactIntentMatches = expectedIntent.filter(
    (item) =>
      item.passed &&
      item.actual === 'intent' &&
      item.actualIntentDigest === item.expectedIntentDigest,
  ).length;
  const correctBypasses = expectedBypass.filter(
    (item) => item.passed && item.actual === 'bypass',
  ).length;
  const repeatabilityFailures = caseResults.filter(
    (item) => !item.repeatable,
  ).length;

  let equivalentTrials = 0;
  let convergencePasses = 0;
  let distinctTrials = 0;
  let falseMerges = 0;
  for (const comparison of selectedComparisons) {
    const left = observations.get(comparison.leftCaseId)!;
    const right = observations.get(comparison.rightCaseId)!;
    const alignedSameIntent = left.map((observation, index) => {
      const peer = right[index]!;
      return (
        observation.actual === 'intent' &&
        peer.actual === 'intent' &&
        observation.intentDigest === peer.intentDigest
      );
    });
    if (comparison.relation === 'equivalent') {
      equivalentTrials += 1;
      if (alignedSameIntent.every(Boolean)) convergencePasses += 1;
    } else {
      distinctTrials += 1;
      if (alignedSameIntent.some(Boolean)) falseMerges += 1;
    }
  }

  const contractDrift = contractDigests.size > 1;
  const failed = caseResults.filter((item) => !item.passed).length;
  const comparisonFailures = equivalentTrials - convergencePasses + falseMerges;
  const gateReasons: IntentEvaluationReport['gate']['reasons'][number][] = [];
  if (failed > 0) gateReasons.push('CASE_FAILURES');
  if (unsafeAccepts > 0) gateReasons.push('UNSAFE_ACCEPTS');
  if (executionFailures > 0) gateReasons.push('EXECUTION_FAILURES');
  if (repeatabilityFailures > 0 || contractDrift) {
    gateReasons.push('NON_REPEATABLE');
  }
  if (comparisonFailures > 0) gateReasons.push('COMPARISON_FAILURES');

  const statisticalReasons: IntentEvaluationReport['statisticalReadiness']['reasons'][number][] =
    ['IID_SAMPLING_NOT_ATTESTED'];
  if (distinctTrials === 0) statisticalReasons.push('NO_DISTINCT_TRIALS');
  if (falseMerges > 0) statisticalReasons.push('OBSERVED_FALSE_MERGE');
  if (repeatabilityFailures > 0 || contractDrift) {
    statisticalReasons.push('NON_REPEATABLE');
  }

  return {
    schema: INTENT_EVALUATION_REPORT_SCHEMA,
    mode: 'shadow',
    activeCacheQualified: false,
    corpusDigest: input.fixture.corpusDigest,
    normalizerBindingDigest: aggregateBindingDigest(
      'normalizer',
      normalizerBindingDigests,
    ),
    ontologyBindingDigest: aggregateBindingDigest(
      'ontology',
      ontologyBindingDigests,
    ),
    split,
    attemptsPerCase: attempts,
    caseMetrics: {
      total: caseResults.length,
      passed: caseResults.length - failed,
      failed,
      expectedIntent: expectedIntent.length,
      exactIntentMatches,
      exactIntentAccuracyPpm: ratePpm(
        exactIntentMatches,
        expectedIntent.length,
      ),
      expectedBypass: expectedBypass.length,
      correctBypasses,
      bypassAccuracyPpm: ratePpm(correctBypasses, expectedBypass.length),
      proposed: caseResults.filter((item) => item.actual === 'intent').length,
      bypassed: caseResults.filter((item) => item.actual === 'bypass').length,
      unsafeAccepts,
      executionFailures,
      repeatabilityFailures,
      contractDrift,
    },
    comparisonMetrics: {
      equivalentTrials,
      convergencePasses,
      convergenceRecallPpm: ratePpm(convergencePasses, equivalentTrials),
      distinctTrials,
      falseMerges,
      falseMergeRatePpm: ratePpm(falseMerges, distinctTrials),
      // Fixture relationships are intentionally not represented as IID trials.
      falseMergeUpperBound95Ppm: null,
    },
    phenomena: summarizePhenomena(caseResults),
    gate: { passed: gateReasons.length === 0, reasons: gateReasons },
    statisticalReadiness: {
      ready: false,
      reasons: statisticalReasons,
    },
    cases: caseResults,
  };
}

function evaluationProgress(
  evaluationBindingDigest: ReturnType<typeof sha256>,
  totalObservations: number,
  resumedObservations: number,
  observedThisRun: number,
  completedObservations: number,
): IntentEvaluationProgress {
  return {
    evaluationBindingDigest,
    totalObservations,
    completedObservations,
    resumedObservations,
    observedThisRun,
    remainingObservations: totalObservations - completedObservations,
  };
}

function completedObservationCount(
  observations: ReadonlyMap<string, readonly AttemptObservation[]>,
): number {
  let completed = 0;
  for (const trial of observations.values()) completed += trial.length;
  return completed;
}

/**
 * Exact one-sided 95% upper binomial bound for an externally validated,
 * independent zero-failure sample. The built-in evaluator never claims that
 * its explicit fixture pairs satisfy this precondition.
 */
export function falseMergeUpperBound95Ppm(
  falseMerges: number,
  distinctTrials: number,
): number | null {
  return zeroFailureGateUpperBound95Ppm(falseMerges, distinctTrials);
}

async function observe(
  input: EvaluateIntentNormalizerInput,
  fixture: IntentEvaluationCase,
): Promise<AttemptObservation> {
  try {
    const result = await normalizeIntentShadow({
      source: fixture.input.source,
      locale: fixture.input.locale,
      sourceDigest: digestIntentSource(fixture.input.source),
      policyDigest: EVALUATION_POLICY_DIGEST,
      compiler: input.compiler,
      registry: input.registry,
    });
    const normalizer =
      result.status === 'normalized'
        ? result.witness.normalizer
        : result.normalizer;
    const ontology =
      result.status === 'normalized'
        ? result.witness.ontology
        : result.ontology;
    const normalizerBindingDigest = hashCanonical(toJsonValue(normalizer));
    const ontologyBindingDigest = hashCanonical(toJsonValue(ontology));

    if (result.status === 'normalized') {
      const intentDigest = digestIntent(result.intent);
      return {
        actual: 'intent',
        intentDigest,
        reasons: result.witness.decision.reasons,
        fingerprint: hashCanonical(
          toJsonValue({
            status: result.status,
            contractDigest: result.contractDigest,
            witnessDigest: result.witness.witnessDigest,
            intentDigest,
          }),
        ),
        executionFailure: false,
        contractDigest: result.contractDigest,
        normalizerBindingDigest,
        ontologyBindingDigest,
      };
    }
    const reasons = result.decision.reasons;
    return {
      actual: 'bypass',
      reasons,
      fingerprint: hashCanonical(
        toJsonValue({
          status: result.status,
          contractDigest: result.contractDigest,
          decision: result.decision,
          witnessDigest: result.witness?.witnessDigest ?? null,
        }),
      ),
      executionFailure: reasons.includes('INTENT_COMPILER_FAILURE'),
      contractDigest: result.contractDigest,
      normalizerBindingDigest,
      ontologyBindingDigest,
    };
  } catch {
    return {
      actual: 'bypass',
      reasons: ['INTENT_COMPILER_FAILURE'],
      fingerprint: 'failure:INTENT_COMPILER_FAILURE',
      executionFailure: true,
      contractDigest: UNAVAILABLE_CONTRACT_DIGEST,
      normalizerBindingDigest: UNAVAILABLE_NORMALIZER_BINDING_DIGEST,
      ontologyBindingDigest: UNAVAILABLE_ONTOLOGY_BINDING_DIGEST,
    };
  }
}

function outcomeKey(observation: AttemptObservation): string {
  return observation.actual === 'intent'
    ? `intent:${observation.intentDigest ?? 'missing'}`
    : `bypass:${observation.reasons.join(',')}`;
}

function caseReference(
  corpusDigest: string,
  canonicalOrdinal: number,
): ReturnType<typeof sha256> {
  return sha256(
    `semwitness.dev/intent-eval-case-ref/v2\0${corpusDigest}\0${canonicalOrdinal}`,
  );
}

function aggregateBindingDigest(
  domain: 'normalizer' | 'ontology',
  values: ReadonlySet<ReturnType<typeof sha256>>,
): ReturnType<typeof sha256> {
  if (values.size === 1) return [...values][0]!;
  return hashCanonical(
    toJsonValue({
      schema: 'semwitness.dev/intent-eval-binding-set/v1',
      domain,
      digests: [...values].sort(compareCodeUnits),
    }),
  );
}

function summarizePhenomena(
  results: readonly IntentEvaluationCaseResult[],
): IntentEvaluationReport['phenomena'] {
  const aggregate = new Map<string, { cases: number; passed: number }>();
  for (const result of results) {
    for (const phenomenon of result.phenomena) {
      const current = aggregate.get(phenomenon) ?? { cases: 0, passed: 0 };
      current.cases += 1;
      current.passed += result.passed ? 1 : 0;
      aggregate.set(phenomenon, current);
    }
  }
  return [...aggregate]
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([phenomenon, value]) => ({
      phenomenon,
      cases: value.cases,
      passed: value.passed,
      passRatePpm: ratePpm(value.passed, value.cases),
    })) as IntentEvaluationReport['phenomena'];
}

function ratePpm(numerator: number, denominator: number): number | null {
  return denominator === 0
    ? null
    : Math.round((numerator * 1_000_000) / denominator);
}
