import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { describe, expect, it, vi } from 'vitest';

import { toJsonValue } from '../src/domain/canonical-json.js';
import { hashCanonical, sha256 } from '../src/domain/hash.js';
import {
  INTENT_EVALUATION_FIXTURE_SCHEMA,
  INTENT_OPERATION_REGISTRY_SCHEMA,
  INTENT_SCHEMA,
  DeclarativeIntentNormalizer,
  digestIntent,
  digestIntentSource,
  evaluateIntentNormalizer,
  falseMergeUpperBound95Ppm,
  hmacIntentSourceDigest,
  normalizeIntentShadow,
  parseIntentEvaluationJsonl,
  runIntentNormalizerEvaluation,
  type IntentCompilerResult,
  type IntentEvaluationCase,
  type IntentEvaluationCheckpoint,
  type IntentEvaluationCheckpointStore,
  type IntentIR,
  type IntentOperationRegistryDocument,
  type IntentProposalCompiler,
} from '../src/intent/index.js';

const ontology = {
  id: 'knowledge-intents',
  version: '1.0.0',
  digest: sha256('knowledge-intents-v1'),
} as const;
const policyDigest = sha256('normalizer-policy-v1');
const execFileAsync = promisify(execFile);

function intent(action: string, effect: IntentIR['effect'] = 'read'): IntentIR {
  return {
    schema: INTENT_SCHEMA,
    ontology,
    goal: {
      namespace: 'knowledge',
      action,
      object: 'redis-configuration',
      polarity: 'affirm',
    },
    slots: [],
    constraints: [],
    temporal: { kind: 'none' },
    output: { format: 'markdown', locale: 'it-IT', detail: 'concise' },
    effect,
  };
}

const explainIntent = intent('explain');
const disableIntent = intent('disable', 'write');

function registryDocument(): IntentOperationRegistryDocument {
  return {
    schema: INTENT_OPERATION_REGISTRY_SCHEMA,
    ontology,
    minimumConfidencePpm: 950_000,
    operations: [
      {
        id: 'explain-redis',
        aliases: [
          { locale: 'it-IT', text: 'Spiegami come configurare Redis' },
          { locale: 'it-IT', text: 'Come si configura Redis?' },
        ],
        intent: explainIntent,
      },
      {
        id: 'disable-redis',
        aliases: [{ locale: 'it-IT', text: 'Disabilita Redis' }],
        intent: disableIntent,
      },
    ],
  };
}

function createNormalizer(
  document: IntentOperationRegistryDocument = registryDocument(),
): DeclarativeIntentNormalizer {
  return new DeclarativeIntentNormalizer(JSON.stringify(document));
}

async function normalize(
  normalizer: DeclarativeIntentNormalizer,
  source: string,
  locale = 'it-IT',
) {
  return normalizeIntentShadow({
    source,
    locale,
    sourceDigest: digestIntentSource(source),
    policyDigest,
    compiler: normalizer,
    registry: normalizer,
  });
}

function caseRecord(input: {
  readonly id: string;
  readonly familyId: string;
  readonly source: string;
  readonly expected: IntentIR | 'bypass';
  readonly split?: IntentEvaluationCase['split'];
  readonly phenomena?: readonly string[];
}) {
  return {
    schema: INTENT_EVALUATION_FIXTURE_SCHEMA,
    kind: 'case',
    id: input.id,
    familyId: input.familyId,
    split: input.split ?? 'conformance',
    difficulty: 'adversarial',
    phenomena: input.phenomena ?? ['paraphrase'],
    input: { source: input.source, locale: 'it-IT' },
    expect:
      input.expected === 'bypass'
        ? { kind: 'bypass' }
        : { kind: 'intent', intent: input.expected },
  };
}

function comparisonRecord(input: {
  readonly id: string;
  readonly left: string;
  readonly right: string;
  readonly relation: 'equivalent' | 'distinct';
}) {
  return {
    schema: INTENT_EVALUATION_FIXTURE_SCHEMA,
    kind: 'comparison',
    id: input.id,
    split: 'conformance',
    leftCaseId: input.left,
    rightCaseId: input.right,
    relation: input.relation,
  };
}

function jsonl(records: readonly unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n');
}

function memoryCheckpointStore(input?: {
  readonly failCommit?: boolean;
  readonly failAfterCommit?: boolean;
}) {
  const records = new Map<string, unknown>();
  const claims = new Set<string>();
  const store: IntentEvaluationCheckpointStore = {
    inspect(claim) {
      const { checkpointRef } = claim;
      if (records.has(checkpointRef)) {
        return { status: 'completed', checkpoint: records.get(checkpointRef) };
      }
      return claims.has(checkpointRef)
        ? { status: 'indeterminate' }
        : { status: 'missing' };
    },
    begin(claim) {
      if (records.has(claim.checkpointRef)) {
        return {
          status: 'completed',
          checkpoint: records.get(claim.checkpointRef),
        };
      }
      if (claims.has(claim.checkpointRef)) {
        return { status: 'indeterminate' };
      }
      claims.add(claim.checkpointRef);
      return {
        status: 'acquired',
        commit(checkpoint: IntentEvaluationCheckpoint) {
          if (input?.failCommit) throw new Error('simulated persistence loss');
          if (records.has(claim.checkpointRef)) {
            throw new Error('checkpoint already exists');
          }
          records.set(claim.checkpointRef, checkpoint);
          if (input?.failAfterCommit) {
            throw new Error('simulated lost commit acknowledgement');
          }
        },
      };
    },
  };
  return { store, records, claims };
}

function resignCheckpoint(value: unknown): unknown {
  const { recordDigest: _recordDigest, ...payload } = value as Record<
    string,
    unknown
  >;
  return { ...payload, recordDigest: hashCanonical(toJsonValue(payload)) };
}

describe('declarative intent normalization', () => {
  it('converges declared paraphrases on the exact same IntentIR', async () => {
    const normalizer = createNormalizer();
    const first = await normalize(
      normalizer,
      'Spiegami come configurare Redis',
    );
    const second = await normalize(normalizer, 'Come si configura Redis?');

    expect(first.status).toBe('normalized');
    expect(second.status).toBe('normalized');
    if (first.status !== 'normalized' || second.status !== 'normalized') return;
    expect(digestIntent(first.intent)).toBe(digestIntent(second.intent));
    expect(first.witness.decision).toEqual({
      verdict: 'eligible',
      applied: false,
      reasons: ['INTENT_NORMALIZATION_ELIGIBLE'],
    });
  });

  it('folds Unicode compatibility forms, case and whitespace', async () => {
    const normalizer = createNormalizer();
    const compatible = await normalize(
      normalizer,
      '  ＣＯＭＥ   ＳＩ ＣＯＮＦＩＧＵＲＡ ＲＥＤＩＳ？  ',
    );
    const punctuation = await normalize(normalizer, 'Come si configura Redis');

    expect(compatible.status).toBe('normalized');
    expect(normalizer.manifest.normalizer.artifactDigest).toBe(
      sha256(
        `semwitness.dev/builtin-declarative-exact-alias/v1\0unicode:${process.versions.unicode ?? 'unknown'}\0icu:${process.versions.icu ?? 'unknown'}`,
      ),
    );
    expect(punctuation).toMatchObject({
      status: 'bypass',
      decision: { reasons: ['INTENT_NO_MATCH'], applied: false },
    });
  });

  it('fails closed for negation, locale drift, malformed Unicode and limits', async () => {
    const normalizer = createNormalizer();
    await expect(
      normalize(normalizer, 'Non configurare Redis'),
    ).resolves.toMatchObject({
      status: 'bypass',
      decision: { reasons: ['INTENT_NO_MATCH'] },
    });
    await expect(
      normalize(normalizer, 'Come si configura Redis?', 'en-US'),
    ).resolves.toMatchObject({
      status: 'bypass',
      decision: { reasons: ['INTENT_NO_MATCH'] },
    });
    await expect(
      normalizeIntentShadow({
        source: '\ud800',
        locale: 'it-IT',
        sourceDigest: sha256('malformed-source-fixture'),
        policyDigest,
        compiler: normalizer,
        registry: normalizer,
      }),
    ).rejects.toMatchObject({ code: 'INTENT_MALFORMED' });
    await expect(
      normalize(normalizer, 'x'.repeat(16_385)),
    ).rejects.toMatchObject({ code: 'INTENT_MALFORMED' });
  });

  it('makes registry and alias order irrelevant to the config digest', () => {
    const first = createNormalizer();
    const base = registryDocument();
    const reordered: IntentOperationRegistryDocument = {
      ...base,
      operations: [...base.operations].reverse().map((operation) => ({
        ...operation,
        aliases: [...operation.aliases].reverse(),
      })),
    };
    const second = createNormalizer(reordered);
    expect(second.manifest.normalizer.configDigest).toBe(
      first.manifest.normalizer.configDigest,
    );
  });

  it('rejects aliases that collide after lexical normalization', () => {
    const base = registryDocument();
    const document: IntentOperationRegistryDocument = {
      ...base,
      operations: base.operations.map((operation, index) =>
        index === 1
          ? {
              ...operation,
              aliases: [
                { locale: 'IT-it', text: '  COME SI CONFIGURA REDIS? ' },
              ],
            }
          : operation,
      ),
    };
    expect(() => createNormalizer(document)).toThrow(
      /ambiguous normalized alias/u,
    );
  });

  it('rejects ontology mismatch and unknown configuration fields', () => {
    const base = registryDocument();
    const mismatch: IntentOperationRegistryDocument = {
      ...base,
      operations: base.operations.map((operation, index) =>
        index === 0
          ? {
              ...operation,
              intent: {
                ...explainIntent,
                ontology: { ...ontology, version: '2.0.0' },
              },
            }
          : operation,
      ),
    };
    expect(() => createNormalizer(mismatch)).toThrow(
      /does not match registry ontology/u,
    );
    expect(
      () =>
        new DeclarativeIntentNormalizer(
          JSON.stringify({
            ...registryDocument(),
            dynamicImport: './unsafe.js',
          }),
        ),
    ).toThrow(/strict validation/u);
  });

  it('binds SHA-256 and HMAC source digests to the exact source', async () => {
    const normalizer = createNormalizer();
    const source = 'Spiegami come configurare Redis';
    const secret = 'intent-source-test-secret-is-at-least-thirty-two-bytes';
    const hmacDigest = hmacIntentSourceDigest(secret, source);

    await expect(
      normalizeIntentShadow({
        source,
        locale: 'it-IT',
        sourceDigest: digestIntentSource('a different source'),
        policyDigest,
        compiler: normalizer,
        registry: normalizer,
      }),
    ).rejects.toMatchObject({ code: 'INTENT_MALFORMED' });
    await expect(
      normalizeIntentShadow({
        source,
        locale: 'it-IT',
        sourceDigest: hmacDigest,
        policyDigest,
        compiler: normalizer,
        registry: normalizer,
      }),
    ).rejects.toMatchObject({ code: 'INTENT_MALFORMED' });
    await expect(
      normalizeIntentShadow({
        source,
        locale: 'it-IT',
        sourceDigest: hmacDigest,
        sourceDigestSecret:
          'a-wrong-intent-source-secret-that-is-also-long-enough',
        policyDigest,
        compiler: normalizer,
        registry: normalizer,
      }),
    ).rejects.toMatchObject({ code: 'INTENT_MALFORMED' });
    await expect(
      normalizeIntentShadow({
        source,
        locale: 'it-IT',
        sourceDigest: hmacDigest,
        sourceDigestSecret: secret,
        policyDigest,
        compiler: normalizer,
        registry: normalizer,
      }),
    ).resolves.toMatchObject({ status: 'normalized' });
  });

  it('fails closed when aborted before or during compiler execution', async () => {
    const normalizer = createNormalizer();
    const preAborted = new AbortController();
    preAborted.abort();
    const compile = vi.fn<IntentProposalCompiler['compile']>(() => ({
      status: 'proposed',
      operationId: 'explain-redis',
      confidencePpm: 1_000_000,
      ambiguous: false,
    }));
    const preAbortedCompiler: IntentProposalCompiler = {
      manifest: normalizer.manifest,
      compile,
    };
    await expect(
      normalizeIntentShadow({
        source: 'anything',
        locale: 'it-IT',
        sourceDigest: digestIntentSource('anything'),
        policyDigest,
        compiler: preAbortedCompiler,
        registry: normalizer,
        signal: preAborted.signal,
      }),
    ).resolves.toMatchObject({
      status: 'bypass',
      decision: { reasons: ['INTENT_COMPILER_FAILURE'] },
    });
    expect(compile).not.toHaveBeenCalled();

    const midAbort = new AbortController();
    let compilerStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      compilerStarted = resolve;
    });
    const hangingCompiler: IntentProposalCompiler = {
      manifest: normalizer.manifest,
      compile: () => {
        compilerStarted();
        return new Promise<IntentCompilerResult>(() => undefined);
      },
    };
    const pending = normalizeIntentShadow({
      source: 'anything',
      locale: 'it-IT',
      sourceDigest: digestIntentSource('anything'),
      policyDigest,
      compiler: hangingCompiler,
      registry: normalizer,
      signal: midAbort.signal,
    });
    await started;
    midAbort.abort();
    await expect(pending).resolves.toMatchObject({
      status: 'bypass',
      decision: { reasons: ['INTENT_COMPILER_FAILURE'] },
    });
  });

  it('turns adapter exceptions, accessors and malformed results into bypass evidence', async () => {
    const normalizer = createNormalizer();
    let getterInvoked = false;
    const accessorResult = Object.defineProperty({}, 'status', {
      enumerable: true,
      get() {
        getterInvoked = true;
        throw new Error('untrusted getter must not run');
      },
    }) as unknown as IntentCompilerResult;
    const throwing: IntentProposalCompiler = {
      manifest: normalizer.manifest,
      compile: () => {
        throw new Error('source must never escape');
      },
    };
    const malformed: IntentProposalCompiler = {
      manifest: normalizer.manifest,
      compile: () => null as unknown as IntentCompilerResult,
    };
    const accessor: IntentProposalCompiler = {
      manifest: normalizer.manifest,
      compile: () => accessorResult,
    };
    const extraField: IntentProposalCompiler = {
      manifest: normalizer.manifest,
      compile: () =>
        ({
          status: 'proposed',
          operationId: 'explain-redis',
          confidencePpm: 1_000_000,
          ambiguous: false,
          unauthorized: true,
        }) as unknown as IntentCompilerResult,
    };
    for (const compiler of [throwing, malformed, accessor, extraField]) {
      await expect(
        normalizeIntentShadow({
          source: 'secret source',
          locale: 'it-IT',
          sourceDigest: digestIntentSource('secret source'),
          policyDigest,
          compiler,
          registry: normalizer,
        }),
      ).resolves.toMatchObject({
        status: 'bypass',
        decision: {
          applied: false,
          reasons: ['INTENT_COMPILER_FAILURE'],
        },
      });
    }
    expect(getterInvoked).toBe(false);
  });

  it('does not let a compiler invent an operation or bypass confidence policy', async () => {
    const normalizer = createNormalizer();
    const unknown: IntentProposalCompiler = {
      manifest: normalizer.manifest,
      compile: () => ({
        status: 'proposed',
        operationId: 'invented-write',
        confidencePpm: 1_000_000,
        ambiguous: false,
      }),
    };
    const lowConfidence: IntentProposalCompiler = {
      manifest: normalizer.manifest,
      compile: () => ({
        status: 'proposed',
        operationId: 'explain-redis',
        confidencePpm: 949_999,
        ambiguous: false,
      }),
    };

    await expect(
      normalizeIntentShadow({
        source: 'anything',
        locale: 'it-IT',
        sourceDigest: digestIntentSource('anything'),
        policyDigest,
        compiler: unknown,
        registry: normalizer,
      }),
    ).resolves.toMatchObject({
      status: 'bypass',
      decision: { reasons: ['INTENT_REGISTRY_MISMATCH'] },
    });
    const result = await normalizeIntentShadow({
      source: 'anything',
      locale: 'it-IT',
      sourceDigest: digestIntentSource('anything'),
      policyDigest,
      compiler: lowConfidence,
      registry: normalizer,
    });
    expect(result).toMatchObject({
      status: 'bypass',
      witness: {
        decision: {
          verdict: 'bypass',
          applied: false,
          reasons: ['INTENT_CONFIDENCE_LOW'],
        },
      },
    });
    expect('intent' in result).toBe(false);
  });

  it('returns the exact immutable frame bound into the witness', async () => {
    const normalizer = createNormalizer();
    const mutableIntent = JSON.parse(JSON.stringify(explainIntent)) as IntentIR;
    const mutableRegistry = {
      ontology,
      minimumConfidencePpm: 950_000,
      resolve: () => mutableIntent,
    };
    const result = await normalizeIntentShadow({
      source: 'Spiegami come configurare Redis',
      locale: 'it-IT',
      sourceDigest: digestIntentSource('Spiegami come configurare Redis'),
      policyDigest,
      compiler: normalizer,
      registry: mutableRegistry,
    });

    expect(result.status).toBe('normalized');
    if (result.status !== 'normalized') return;
    expect(Object.isFrozen(result.intent)).toBe(true);
    expect(Object.isFrozen(result.intent.goal)).toBe(true);
    expect(digestIntent(result.intent)).toBe(result.witness.intentDigest);

    (mutableIntent as unknown as { effect: string }).effect = 'write';
    expect(result.intent.effect).toBe('read');
    expect(digestIntent(result.intent)).toBe(result.witness.intentDigest);
  });
});

describe('intent normalizer evaluation fixture', () => {
  it('rejects duplicate ids, dangling comparisons and split leakage', () => {
    const first = caseRecord({
      id: 'case-a',
      familyId: 'redis',
      source: 'Spiegami come configurare Redis',
      expected: explainIntent,
    });
    expect(() => parseIntentEvaluationJsonl(jsonl([first, first]))).toThrow(
      /duplicate id/u,
    );
    expect(() =>
      parseIntentEvaluationJsonl(
        jsonl([
          first,
          comparisonRecord({
            id: 'pair-a',
            left: 'case-a',
            right: 'missing',
            relation: 'distinct',
          }),
        ]),
      ),
    ).toThrow(/dangling case id/u);
    expect(() =>
      parseIntentEvaluationJsonl(
        jsonl([first, { ...first, id: 'case-b', split: 'development' }]),
      ),
    ).toThrow(/family crosses a split/u);
  });

  it('rejects normalized-input duplicates and renamed intent families', () => {
    const first = caseRecord({
      id: 'case-a',
      familyId: 'redis-explain',
      source: 'Spiegami come configurare Redis',
      expected: explainIntent,
    });
    expect(() =>
      parseIntentEvaluationJsonl(
        jsonl([
          first,
          caseRecord({
            id: 'case-b',
            familyId: 'redis-other',
            source: '  SPIEGAMI   come configurare Redis  ',
            expected: explainIntent,
          }),
        ]),
      ),
    ).toThrow(/duplicate normalized input/u);
    expect(() =>
      parseIntentEvaluationJsonl(
        jsonl([
          first,
          caseRecord({
            id: 'case-b',
            familyId: 'renamed-family',
            source: 'Come si configura Redis?',
            expected: explainIntent,
          }),
        ]),
      ),
    ).toThrow(/multiple families/u);
  });

  it('rejects self/duplicate pairs and comparisons that contradict ground truth', () => {
    const left = caseRecord({
      id: 'case-a',
      familyId: 'redis-a',
      source: 'Spiegami come configurare Redis',
      expected: explainIntent,
    });
    const right = caseRecord({
      id: 'case-b',
      familyId: 'redis-a',
      source: 'Come si configura Redis?',
      expected: explainIntent,
    });
    expect(() =>
      parseIntentEvaluationJsonl(
        jsonl([
          left,
          comparisonRecord({
            id: 'pair-self',
            left: 'case-a',
            right: 'case-a',
            relation: 'equivalent',
          }),
        ]),
      ),
    ).toThrow(/cannot reference itself/u);
    const pair = comparisonRecord({
      id: 'pair-a',
      left: 'case-a',
      right: 'case-b',
      relation: 'equivalent',
    });
    expect(() =>
      parseIntentEvaluationJsonl(
        jsonl([left, right, pair, { ...pair, id: 'pair-b' }]),
      ),
    ).toThrow(/duplicate pair/u);
    expect(() =>
      parseIntentEvaluationJsonl(
        jsonl([left, right, { ...pair, relation: 'distinct' }]),
      ),
    ).toThrow(/contradicts ground truth/u);
  });

  it('permits distinct case pairs between the same families', () => {
    const records = [
      caseRecord({
        id: 'explain-a',
        familyId: 'redis-explain',
        source: 'Spiegami come configurare Redis',
        expected: explainIntent,
      }),
      caseRecord({
        id: 'explain-b',
        familyId: 'redis-explain',
        source: 'Come si configura Redis?',
        expected: explainIntent,
      }),
      caseRecord({
        id: 'disable-a',
        familyId: 'redis-disable',
        source: 'Disabilita Redis',
        expected: disableIntent,
      }),
      caseRecord({
        id: 'disable-b',
        familyId: 'redis-disable',
        source: 'Arresta Redis',
        expected: disableIntent,
      }),
      comparisonRecord({
        id: 'pair-a',
        left: 'explain-a',
        right: 'disable-a',
        relation: 'distinct',
      }),
      comparisonRecord({
        id: 'pair-b',
        left: 'explain-b',
        right: 'disable-b',
        relation: 'distinct',
      }),
    ];
    const fixture = parseIntentEvaluationJsonl(jsonl(records));
    expect(fixture.comparisons).toHaveLength(2);
    expect(
      fixture.comparisons.every((item) => item.relation === 'distinct'),
    ).toBe(true);
  });
});

describe('intent normalizer evaluation', () => {
  function representativeFixture() {
    return parseIntentEvaluationJsonl(
      jsonl([
        caseRecord({
          id: 'redis-a',
          familyId: 'redis-explain',
          source: 'Spiegami come configurare Redis',
          expected: explainIntent,
          phenomena: ['paraphrase'],
        }),
        caseRecord({
          id: 'redis-b',
          familyId: 'redis-explain',
          source: 'Come si configura Redis?',
          expected: explainIntent,
          phenomena: ['paraphrase', 'word-order'],
        }),
        caseRecord({
          id: 'redis-disable',
          familyId: 'redis-disable',
          source: 'Disabilita Redis',
          expected: disableIntent,
          phenomena: ['effect'],
        }),
        caseRecord({
          id: 'redis-negated',
          familyId: 'redis-negated',
          source: 'Non configurare Redis',
          expected: 'bypass',
          phenomena: ['negation'],
        }),
        comparisonRecord({
          id: 'pair-equivalent',
          left: 'redis-a',
          right: 'redis-b',
          relation: 'equivalent',
        }),
        comparisonRecord({
          id: 'pair-distinct',
          left: 'redis-a',
          right: 'redis-disable',
          relation: 'distinct',
        }),
      ]),
    );
  }

  it('reports exact conformance without claiming IID statistical readiness', async () => {
    const normalizer = createNormalizer();
    const report = await evaluateIntentNormalizer({
      compiler: normalizer,
      registry: normalizer,
      fixture: representativeFixture(),
      attempts: 2,
    });

    expect(report.gate).toEqual({ passed: true, reasons: [] });
    expect(report.activeCacheQualified).toBe(false);
    expect(report.caseMetrics).toMatchObject({
      total: 4,
      passed: 4,
      unsafeAccepts: 0,
      repeatabilityFailures: 0,
      exactIntentAccuracyPpm: 1_000_000,
      bypassAccuracyPpm: 1_000_000,
    });
    expect(report.comparisonMetrics).toEqual({
      equivalentTrials: 1,
      convergencePasses: 1,
      convergenceRecallPpm: 1_000_000,
      distinctTrials: 1,
      falseMerges: 0,
      falseMergeRatePpm: 0,
      falseMergeUpperBound95Ppm: null,
    });
    expect(report.statisticalReadiness).toEqual({
      ready: false,
      reasons: ['IID_SAMPLING_NOT_ATTESTED'],
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('Spiegami');
    expect(serialized).not.toContain('Disabilita');
    expect(serialized).not.toContain('redis-configuration');
  });

  it('separates false merges and unsafe accepts from ordinary misses', async () => {
    const normalizer = createNormalizer();
    const alwaysExplain: IntentProposalCompiler = {
      manifest: normalizer.manifest,
      compile: () => ({
        status: 'proposed',
        operationId: 'explain-redis',
        confidencePpm: 1_000_000,
        ambiguous: false,
      }),
    };
    const report = await evaluateIntentNormalizer({
      compiler: alwaysExplain,
      registry: normalizer,
      fixture: representativeFixture(),
      attempts: 2,
    });

    expect(report.gate.passed).toBe(false);
    expect(report.caseMetrics.unsafeAccepts).toBe(2);
    expect(report.comparisonMetrics.falseMerges).toBe(1);
    expect(report.comparisonMetrics.falseMergeUpperBound95Ppm).toBeNull();
    expect(report.statisticalReadiness).toMatchObject({ ready: false });
  });

  it('requires an immutable parser-branded corpus', async () => {
    const normalizer = createNormalizer();
    const fixture = representativeFixture();
    expect(Object.isFrozen(fixture)).toBe(true);
    expect(Object.isFrozen(fixture.cases)).toBe(true);
    expect(Object.isFrozen(fixture.cases[0]?.input)).toBe(true);
    expect(() => {
      (fixture.cases as unknown as unknown[]).push(fixture.cases[0]);
    }).toThrow(TypeError);

    await expect(
      evaluateIntentNormalizer({
        compiler: normalizer,
        registry: normalizer,
        fixture: { ...fixture },
        attempts: 2,
      }),
    ).rejects.toMatchObject({ code: 'INTENT_MALFORMED' });
  });

  it('counts an unsafe later attempt instead of trusting the first run', async () => {
    const normalizer = createNormalizer();
    let calls = 0;
    const unsafeSecondRun: IntentProposalCompiler = {
      manifest: normalizer.manifest,
      compile: () => {
        calls += 1;
        return calls === 1
          ? { status: 'bypass', reason: 'INTENT_NO_MATCH' }
          : {
              status: 'proposed',
              operationId: 'explain-redis',
              confidencePpm: 1_000_000,
              ambiguous: false,
            };
      },
    };
    const fixture = parseIntentEvaluationJsonl(
      jsonl([
        caseRecord({
          id: 'must-bypass',
          familyId: 'must-bypass',
          source: 'Do not reuse this result',
          expected: 'bypass',
          phenomena: ['prompt-injection'],
        }),
      ]),
    );
    const report = await evaluateIntentNormalizer({
      compiler: unsafeSecondRun,
      registry: normalizer,
      fixture,
      attempts: 2,
    });

    expect(report.caseMetrics.unsafeAccepts).toBe(1);
    expect(report.caseMetrics.repeatabilityFailures).toBe(1);
    expect(report.cases[0]).toMatchObject({
      actual: 'mixed',
      passed: false,
      repeatable: false,
    });
    expect(report.gate.reasons).toEqual(
      expect.arrayContaining(['UNSAFE_ACCEPTS', 'NON_REPEATABLE']),
    );
  });

  it('detects repeatability drift independently', async () => {
    const normalizer = createNormalizer();
    let calls = 0;
    const drifting: IntentProposalCompiler = {
      manifest: normalizer.manifest,
      compile: () => {
        calls += 1;
        return calls % 2 === 1
          ? {
              status: 'proposed',
              operationId: 'explain-redis',
              confidencePpm: 1_000_000,
              ambiguous: false,
            }
          : { status: 'bypass', reason: 'INTENT_NO_MATCH' };
      },
    };
    const fixture = parseIntentEvaluationJsonl(
      jsonl([
        caseRecord({
          id: 'redis-a',
          familyId: 'redis-explain',
          source: 'Spiegami come configurare Redis',
          expected: explainIntent,
        }),
      ]),
    );
    const report = await evaluateIntentNormalizer({
      compiler: drifting,
      registry: normalizer,
      fixture,
      attempts: 2,
    });
    expect(report.caseMetrics.repeatabilityFailures).toBe(1);
    expect(report.gate.reasons).toContain('NON_REPEATABLE');
  });

  it('detects manifest and normalization-contract drift across attempts', async () => {
    const normalizer = createNormalizer();
    let manifestReads = 0;
    const driftingManifest: IntentProposalCompiler = {
      get manifest() {
        manifestReads += 1;
        return {
          ...normalizer.manifest,
          normalizer: {
            ...normalizer.manifest.normalizer,
            configDigest:
              manifestReads % 2 === 1
                ? normalizer.manifest.normalizer.configDigest
                : sha256('drifting-normalizer-config'),
          },
        };
      },
      compile: () => ({
        status: 'proposed',
        operationId: 'explain-redis',
        confidencePpm: 1_000_000,
        ambiguous: false,
      }),
    };
    const fixture = parseIntentEvaluationJsonl(
      jsonl([
        caseRecord({
          id: 'stable-source',
          familyId: 'redis-explain',
          source: 'Spiegami come configurare Redis',
          expected: explainIntent,
        }),
      ]),
    );
    const report = await evaluateIntentNormalizer({
      compiler: driftingManifest,
      registry: normalizer,
      fixture,
      attempts: 2,
    });

    expect(report.caseMetrics.contractDrift).toBe(true);
    expect(report.caseMetrics.repeatabilityFailures).toBe(1);
    expect(report.gate.reasons).toContain('NON_REPEATABLE');
  });

  it('keeps report labels opaque and nulls metrics without comparisons', async () => {
    const normalizer = createNormalizer();
    const fixture = parseIntentEvaluationJsonl(
      jsonl([
        caseRecord({
          id: 'raw-case-sentinel',
          familyId: 'raw-family-sentinel',
          source: 'Spiegami come configurare Redis',
          expected: explainIntent,
        }),
      ]),
    );
    const report = await evaluateIntentNormalizer({
      compiler: normalizer,
      registry: normalizer,
      fixture,
      attempts: 2,
    });

    expect(report.gate).toEqual({ passed: true, reasons: [] });
    expect(report.comparisonMetrics).toEqual({
      equivalentTrials: 0,
      convergencePasses: 0,
      convergenceRecallPpm: null,
      distinctTrials: 0,
      falseMerges: 0,
      falseMergeRatePpm: null,
      falseMergeUpperBound95Ppm: null,
    });
    expect(report.caseMetrics.bypassAccuracyPpm).toBeNull();
    expect(report.statisticalReadiness).toEqual({
      ready: false,
      reasons: ['IID_SAMPLING_NOT_ATTESTED', 'NO_DISTINCT_TRIALS'],
    });
    const serialized = JSON.stringify(report);
    for (const secretLabel of [
      'raw-case-sentinel',
      'raw-family-sentinel',
      ontology.id,
      normalizer.manifest.normalizer.id,
      'redis-configuration',
    ]) {
      expect(serialized).not.toContain(secretLabel);
    }
    expect(report.cases[0]?.caseRef).not.toBe(
      sha256(
        `semwitness.dev/intent-eval-case-ref/v1\0${fixture.corpusDigest}\0raw-case-sentinel`,
      ),
    );
    expect(report.cases[0]?.caseRef).toBe(
      sha256(
        `semwitness.dev/intent-eval-case-ref/v2\0${fixture.corpusDigest}\0${0}`,
      ),
    );
  });

  it('rejects a single attempt because repeatability needs at least two runs', async () => {
    const normalizer = createNormalizer();
    await expect(
      evaluateIntentNormalizer({
        compiler: normalizer,
        registry: normalizer,
        fixture: representativeFixture(),
        attempts: 1,
      }),
    ).rejects.toThrow(/between 2 and 20/u);
  });

  it('resumes content-free checkpoints without duplicate compiler calls', async () => {
    const normalizer = createNormalizer();
    let calls = 0;
    const compiler: IntentProposalCompiler = {
      manifest: normalizer.manifest,
      compile(request) {
        calls += 1;
        return normalizer.compile(request);
      },
    };
    const fixture = representativeFixture();
    const uninterrupted = await evaluateIntentNormalizer({
      compiler: normalizer,
      registry: normalizer,
      fixture,
      attempts: 2,
    });
    const checkpoints = memoryCheckpointStore();
    const common = {
      compiler,
      registry: normalizer,
      fixture,
      attempts: 2,
      checkpointStore: checkpoints.store,
      checkpointBindingDigest: sha256('host-bound-run-v1'),
    } as const;

    const empty = await runIntentNormalizerEvaluation({
      ...common,
      maxNewObservations: 0,
    });
    expect(empty).toMatchObject({
      status: 'incomplete',
      progress: {
        totalObservations: 8,
        completedObservations: 0,
        observedThisRun: 0,
      },
    });
    expect(calls).toBe(0);

    const first = await runIntentNormalizerEvaluation({
      ...common,
      maxNewObservations: 3,
    });
    expect(first).toMatchObject({
      status: 'incomplete',
      progress: {
        completedObservations: 3,
        resumedObservations: 0,
        observedThisRun: 3,
        remainingObservations: 5,
      },
    });
    expect('report' in first).toBe(false);
    expect(
      first.progress.resumedObservations + first.progress.observedThisRun,
    ).toBe(first.progress.completedObservations);
    expect(calls).toBe(3);

    const second = await runIntentNormalizerEvaluation({
      ...common,
      maxNewObservations: 2,
    });
    expect(second).toMatchObject({
      status: 'incomplete',
      progress: {
        completedObservations: 5,
        resumedObservations: 3,
        observedThisRun: 2,
      },
    });
    expect('report' in second).toBe(false);
    expect(
      second.progress.resumedObservations + second.progress.observedThisRun,
    ).toBe(second.progress.completedObservations);
    expect(calls).toBe(5);

    const completed = await runIntentNormalizerEvaluation({
      ...common,
      maxNewObservations: 3,
    });
    expect(completed.status).toBe('complete');
    if (completed.status !== 'complete') return;
    expect(completed.progress).toMatchObject({
      completedObservations: 8,
      resumedObservations: 5,
      observedThisRun: 3,
      remainingObservations: 0,
    });
    expect(completed.report).toEqual(uninterrupted);
    expect(JSON.stringify(completed.report)).toBe(
      JSON.stringify(uninterrupted),
    );
    expect(calls).toBe(8);

    const replay = await runIntentNormalizerEvaluation({
      ...common,
      maxNewObservations: 0,
    });
    expect(replay.status).toBe('complete');
    expect(replay.progress).toMatchObject({
      completedObservations: 8,
      resumedObservations: 8,
      observedThisRun: 0,
    });
    expect(calls).toBe(8);

    const persisted = JSON.stringify([...checkpoints.records.values()]);
    for (const rawValue of [
      'Spiegami',
      'Disabilita',
      'redis-a',
      'redis-explain',
      'knowledge-intents',
      'redis-configuration',
    ]) {
      expect(persisted).not.toContain(rawValue);
    }
  });

  it('rejects malformed checkpoint records before another compiler call', async () => {
    const normalizer = createNormalizer();
    let calls = 0;
    const compiler: IntentProposalCompiler = {
      manifest: normalizer.manifest,
      compile(request) {
        calls += 1;
        return normalizer.compile(request);
      },
    };
    const checkpoints = memoryCheckpointStore();
    const input = {
      compiler,
      registry: normalizer,
      fixture: representativeFixture(),
      attempts: 2,
      checkpointStore: checkpoints.store,
      checkpointBindingDigest: sha256('tamper-test-run'),
    } as const;
    await runIntentNormalizerEvaluation({ ...input, maxNewObservations: 1 });
    expect(calls).toBe(1);
    const [checkpointRef, original] = [...checkpoints.records.entries()][0]!;
    checkpoints.records.set(checkpointRef, {
      ...(original as object),
      leakedCaseId: 'raw-case-id',
    });

    await expect(runIntentNormalizerEvaluation(input)).rejects.toThrow(
      /unknown fields/u,
    );
    expect(calls).toBe(1);

    checkpoints.records.set(checkpointRef, original);
    expect(Object.isFrozen(original)).toBe(true);
    expect(
      Object.isFrozen((original as IntentEvaluationCheckpoint).observation),
    ).toBe(true);
    expect(
      Object.isFrozen(
        (original as IntentEvaluationCheckpoint).observation.reasons,
      ),
    ).toBe(true);

    const base = structuredClone(original) as IntentEvaluationCheckpoint;
    const impossible = [
      resignCheckpoint({
        ...base,
        observation: {
          ...base.observation,
          actual: 'intent',
          intentDigest: sha256('fabricated-intent'),
          reasons: ['INTENT_NO_MATCH'],
          executionFailure: false,
        },
      }),
      resignCheckpoint({
        ...base,
        observation: {
          ...base.observation,
          actual: 'bypass',
          reasons: ['CACHE_HIT_ELIGIBLE'],
          executionFailure: false,
        },
      }),
      resignCheckpoint({
        ...base,
        observation: {
          ...base.observation,
          reasons: [
            'INTENT_NORMALIZATION_ELIGIBLE',
            'INTENT_NORMALIZATION_ELIGIBLE',
          ],
        },
      }),
      resignCheckpoint({
        ...base,
        observation: { ...base.observation, unexpected: true },
      }),
      { ...base, recordDigest: sha256('wrong-record-digest') },
    ];
    for (const malformed of impossible) {
      checkpoints.records.set(checkpointRef, malformed);
      await expect(runIntentNormalizerEvaluation(input)).rejects.toThrow(
        /Intent evaluation checkpoint/u,
      );
      expect(calls).toBe(1);
    }
  });

  it('passes frozen opaque claims and records across the store boundary', async () => {
    const normalizer = createNormalizer();
    const stored = memoryCheckpointStore();
    let inspections = 0;
    const store: IntentEvaluationCheckpointStore = {
      inspect(claim) {
        inspections += 1;
        expect(Object.isFrozen(claim)).toBe(true);
        expect(
          Reflect.set(claim as object, 'checkpointRef', sha256('mutated')),
        ).toBe(false);
        const { claimDigest, ...payload } = claim;
        expect(claimDigest).toBe(hashCanonical(toJsonValue(payload)));
        expect(JSON.stringify(claim)).not.toContain('redis');
        return stored.store.inspect(claim);
      },
      begin(claim) {
        expect(Object.isFrozen(claim)).toBe(true);
        const result = stored.store.begin(claim);
        if (result instanceof Promise || result.status !== 'acquired') {
          return result;
        }
        return {
          status: 'acquired',
          commit(checkpoint: IntentEvaluationCheckpoint) {
            expect(Object.isFrozen(checkpoint)).toBe(true);
            expect(Object.isFrozen(checkpoint.observation)).toBe(true);
            expect(Object.isFrozen(checkpoint.observation.reasons)).toBe(true);
            return result.commit(checkpoint);
          },
        };
      },
    };

    const result = await runIntentNormalizerEvaluation({
      compiler: normalizer,
      registry: normalizer,
      fixture: representativeFixture(),
      attempts: 2,
      checkpointStore: store,
      checkpointBindingDigest: sha256('frozen-port-run'),
      maxNewObservations: 1,
    });
    expect(result.status).toBe('incomplete');
    expect(inspections).toBe(2);
  });

  it('never retries an attempt whose claim has an unknown outcome', async () => {
    const normalizer = createNormalizer();
    let calls = 0;
    const compiler: IntentProposalCompiler = {
      manifest: normalizer.manifest,
      compile(request) {
        calls += 1;
        return normalizer.compile(request);
      },
    };
    const checkpoints = memoryCheckpointStore({ failCommit: true });
    const input = {
      compiler,
      registry: normalizer,
      fixture: representativeFixture(),
      attempts: 2,
      checkpointStore: checkpoints.store,
      checkpointBindingDigest: sha256('indeterminate-run'),
      maxNewObservations: 1,
    } as const;

    await expect(runIntentNormalizerEvaluation(input)).rejects.toThrow(
      /simulated persistence loss/u,
    );
    expect(calls).toBe(1);
    const resumed = await runIntentNormalizerEvaluation(input);
    expect(resumed).toMatchObject({
      status: 'indeterminate',
      progress: { completedObservations: 0, observedThisRun: 0 },
    });
    expect('report' in resumed).toBe(false);
    expect(calls).toBe(1);
  });

  it('resumes a durable checkpoint when commit acknowledgement is lost', async () => {
    const normalizer = createNormalizer();
    let calls = 0;
    const compiler: IntentProposalCompiler = {
      manifest: normalizer.manifest,
      compile(request) {
        calls += 1;
        return normalizer.compile(request);
      },
    };
    const checkpoints = memoryCheckpointStore({ failAfterCommit: true });
    const base = {
      compiler,
      registry: normalizer,
      fixture: representativeFixture(),
      attempts: 2,
      checkpointStore: checkpoints.store,
      checkpointBindingDigest: sha256('lost-acknowledgement-run'),
    } as const;

    await expect(
      runIntentNormalizerEvaluation({ ...base, maxNewObservations: 1 }),
    ).rejects.toThrow(/lost commit acknowledgement/u);
    expect(calls).toBe(1);
    const resumed = await runIntentNormalizerEvaluation({
      ...base,
      maxNewObservations: 0,
    });
    expect(resumed).toMatchObject({
      status: 'incomplete',
      progress: {
        completedObservations: 1,
        resumedObservations: 1,
        observedThisRun: 0,
      },
    });
    expect(calls).toBe(1);
  });

  it('allows only one concurrent worker to acquire an attempt', async () => {
    const normalizer = createNormalizer();
    let calls = 0;
    let release!: () => void;
    const providerGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const compiler: IntentProposalCompiler = {
      manifest: normalizer.manifest,
      async compile(request) {
        calls += 1;
        await providerGate;
        return normalizer.compile(request);
      },
    };
    const checkpoints = memoryCheckpointStore();
    let inspected = 0;
    let releaseInspection!: () => void;
    const inspectionBarrier = new Promise<void>((resolve) => {
      releaseInspection = resolve;
    });
    const concurrentStore: IntentEvaluationCheckpointStore = {
      async inspect(claim) {
        inspected += 1;
        if (inspected <= 2) {
          if (inspected === 2) releaseInspection();
          await inspectionBarrier;
          return { status: 'missing' };
        }
        return checkpoints.store.inspect(claim);
      },
      begin: (claim) => checkpoints.store.begin(claim),
    };
    const input = {
      compiler,
      registry: normalizer,
      fixture: representativeFixture(),
      attempts: 2,
      checkpointStore: concurrentStore,
      checkpointBindingDigest: sha256('concurrent-run'),
      maxNewObservations: 1,
    } as const;

    const owner = runIntentNormalizerEvaluation(input);
    const peerRun = runIntentNormalizerEvaluation(input);
    await vi.waitFor(() => expect(calls).toBe(1));
    const peer = await peerRun;
    expect(peer.status).toBe('indeterminate');
    expect(calls).toBe(1);

    release();
    await expect(owner).resolves.toMatchObject({
      status: 'incomplete',
      progress: { completedObservations: 1, observedThisRun: 1 },
    });
    expect(calls).toBe(1);
  });

  it('requires a host binding and persistent store for bounded runs', async () => {
    const normalizer = createNormalizer();
    const fixture = representativeFixture();
    await expect(
      runIntentNormalizerEvaluation({
        compiler: normalizer,
        registry: normalizer,
        fixture,
        maxNewObservations: 0,
      }),
    ).rejects.toThrow(/requires a checkpoint store/u);
    await expect(
      runIntentNormalizerEvaluation({
        compiler: normalizer,
        registry: normalizer,
        fixture,
        checkpointStore: memoryCheckpointStore().store,
      }),
    ).rejects.toThrow(/checkpointBindingDigest/u);

    for (const invalid of [
      -1,
      0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      await expect(
        runIntentNormalizerEvaluation({
          compiler: normalizer,
          registry: normalizer,
          fixture,
          checkpointStore: memoryCheckpointStore().store,
          checkpointBindingDigest: sha256('invalid-budget-run'),
          maxNewObservations: invalid,
        }),
      ).rejects.toThrow(/non-negative integer/u);
    }
  });

  it('preserves the exact pre-refactor CLI report bytes', async () => {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [
        '--import',
        'tsx',
        'src/entrypoints/cli.ts',
        'intent',
        'evaluate',
        '--normalizer',
        'examples/intent-normalizer.json',
        '--fixture',
        'examples/intent-normalizer-eval.jsonl',
        '--split',
        'conformance',
        '--runs',
        '2',
        '--json',
      ],
      { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 1_000_000 },
    );
    expect(stderr).toBe('');
    expect(Buffer.byteLength(stdout)).toBe(14_430);
    expect(sha256(stdout)).toBe(
      'sha256:efb604b8eeeffed45eeeee4257dd8cf1de25edd420db6a27bb1ed5c7321badf9',
    );
  });

  it('computes predeclared zero-failure bounds without sample-size theater', () => {
    expect(falseMergeUpperBound95Ppm(0, 0)).toBeNull();
    expect(falseMergeUpperBound95Ppm(0, 2_994)).toBe(1_001);
    expect(falseMergeUpperBound95Ppm(0, 2_995)).toBe(1_000);
    expect(falseMergeUpperBound95Ppm(0, 29_955)).toBe(101);
    expect(falseMergeUpperBound95Ppm(0, 29_956)).toBe(100);
    expect(falseMergeUpperBound95Ppm(1, 29_956)).toBe(1_000_000);
  });
});
