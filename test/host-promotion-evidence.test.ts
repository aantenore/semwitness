import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createSemWitness } from '../src/composition-root.js';
import { digestPolicy, type CodecPolicy } from '../src/domain/policy.js';
import { sha256 } from '../src/domain/hash.js';
import {
  HOST_PREPARER_ARTIFACT,
  createVerifiedTextRequestPreparer,
  evaluateHostPromotionEvidence,
  parseHostPromotionEvidenceFixture,
  parseHostPromotionEvidenceJsonl,
  parseHostPromotionManifest,
  type HostPromotionCompleteCase,
  type HostPromotionEvidenceBinding,
  type HostPromotionEvidenceFixture,
  type HostPromotionFailedCase,
} from '../src/host/index.js';
import { DeterministicByteTokenizer, makePolicy } from './helpers.js';

type DeepMutable<T> = T extends readonly (infer Item)[]
  ? DeepMutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: DeepMutable<T[Key]> }
    : T;

const temporaryRoots = new Set<string>();
const TOKENIZER_ID = 'promotion-exact';
const TOKENIZER_FINGERPRINT = 'test/byte-tokenizer:exact';
const DEPLOYMENT_SCOPE_DIGEST = sha256('promotion-deployment-scope-v1');
const CORPUS_DIGEST = sha256('promotion-held-out-corpus-v1');
const PROTOCOL_DIGEST = sha256('promotion-evaluation-protocol-v1');

function policy(mode: CodecPolicy['mode'] = 'apply-verified'): CodecPolicy {
  return makePolicy({
    mode,
    tokenizerId: TOKENIZER_ID,
    selection: {
      includeDecoderLegendTokens: false,
      minTokenSavings: 1,
      minSavingsRatioPpm: 0,
      allowHeuristicApply: false,
    },
  });
}

function binding(
  targetPolicy: CodecPolicy = policy(),
): HostPromotionEvidenceBinding {
  return {
    schema: 'semwitness.dev/host-promotion-evidence/v1alpha1',
    kind: 'binding',
    artifact: { ...HOST_PREPARER_ARTIFACT },
    policyDigest: digestPolicy(targetPolicy),
    deploymentScopeDigest: DEPLOYMENT_SCOPE_DIGEST,
    corpusDigest: CORPUS_DIGEST,
    evaluationProtocolDigest: PROTOCOL_DIGEST,
    split: 'held-out',
    usageEvidence: {
      source: 'provider-response',
      reliability: 'exact',
    },
    expectedCases: 50,
    tokenizer: {
      id: TOKENIZER_ID,
      fingerprint: TOKENIZER_FINGERPRINT,
      reliability: 'exact',
    },
    codecs: [{ id: 'json-jcs', version: '1' }],
    design: {
      pairing: 'paired',
      order: 'counterbalanced',
      requiredStrata: ['simple', 'medium', 'complex', 'adversarial'],
      requiredCacheRegimes: ['cold', 'warm'],
    },
    gate: {
      minimumMedianNetSavingsRatioPpm: 100_000,
      maximumMedianLatencyRegressionRatioPpm: 250_000,
    },
  };
}

function completeCase(ordinal: number): HostPromotionCompleteCase {
  const strata = ['simple', 'medium', 'complex', 'adversarial'] as const;
  return {
    schema: 'semwitness.dev/host-promotion-evidence/v1alpha1',
    kind: 'case',
    ordinal,
    status: 'complete',
    stratum: strata[ordinal % strata.length]!,
    cacheRegime: ordinal % 2 === 0 ? 'cold' : 'warm',
    codec: { id: 'json-jcs', version: '1' },
    deploymentScopeDigest: DEPLOYMENT_SCOPE_DIGEST,
    decision: 'applied',
    baseline: {
      traceDigest: sha256(`baseline-trace-${ordinal}`),
      totalInputTokens: 1_000,
      cacheReadInputTokens: 400,
      cacheWriteInputTokens: 100,
      totalOutputTokens: 100,
      reasoningOutputTokens: 20,
      normalizedCostUnits: 1_000_000,
      endToEndLatencyMicros: 1_000_000,
      compressorLatencyMicros: 0,
      attempts: 1,
      retryCount: 0,
      recoveryCount: 0,
    },
    candidate: {
      traceDigest: sha256(`candidate-trace-${ordinal}`),
      totalInputTokens: 700,
      cacheReadInputTokens: 300,
      cacheWriteInputTokens: 50,
      totalOutputTokens: 100,
      reasoningOutputTokens: 20,
      normalizedCostUnits: 800_000,
      endToEndLatencyMicros: 1_100_000,
      compressorLatencyMicros: 50_000,
      attempts: 1,
      retryCount: 0,
      recoveryCount: 0,
    },
    unsafeAccepted: false,
    taskQualityRegression: false,
    qualityEvidenceDigest: sha256(`quality-evidence-${ordinal}`),
  };
}

function fixture(
  targetPolicy: CodecPolicy = policy(),
): HostPromotionEvidenceFixture {
  return {
    binding: binding(targetPolicy),
    cases: Array.from({ length: 50 }, (_, ordinal) => completeCase(ordinal)),
  };
}

function mutableFixture(
  targetPolicy: CodecPolicy = policy(),
): DeepMutable<HostPromotionEvidenceFixture> {
  return structuredClone(
    fixture(targetPolicy),
  ) as DeepMutable<HostPromotionEvidenceFixture>;
}

function jsonl(value: HostPromotionEvidenceFixture): string {
  return [value.binding, ...value.cases]
    .map((record) => JSON.stringify(record))
    .join('\n');
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'semwitness-promotion-evidence-'));
  temporaryRoots.add(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    [...temporaryRoots].map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
  temporaryRoots.clear();
});

describe('host promotion evidence workbench', () => {
  it('compiles complete held-out evidence into a deterministic host manifest', () => {
    const targetPolicy = policy();
    const parsed = parseHostPromotionEvidenceJsonl(
      jsonl(fixture(targetPolicy)),
    );
    const first = evaluateHostPromotionEvidence({
      policy: targetPolicy,
      fixture: parsed,
    });
    const reversed = parseHostPromotionEvidenceJsonl(
      jsonl({ binding: parsed.binding, cases: [...parsed.cases].reverse() }),
    );
    const second = evaluateHostPromotionEvidence({
      policy: targetPolicy,
      fixture: reversed,
    });

    expect(first.qualified).toBe(true);
    expect(first.report.gate).toEqual({ passed: true, reasons: [] });
    expect(first.report.caseMetrics).toMatchObject({
      expected: 50,
      observed: 50,
      complete: 50,
      failed: 0,
      applied: 50,
      unsafeAccepts: 0,
      taskQualityRegressions: 0,
    });
    expect(first.report.usageMetrics).toMatchObject({
      baseline: {
        totalInputTokens: '50000',
        normalizedCostUnits: '50000000',
      },
      candidate: {
        totalInputTokens: '35000',
        normalizedCostUnits: '40000000',
      },
      medianInputSavingsRatioPpm: 300_000,
      medianCostSavingsRatioPpm: 200_000,
      medianNetSavingsRatioPpm: 200_000,
      medianLatencyRegressionRatioPpm: 100_000,
    });
    expect(first.report.codecMetrics).toEqual([
      expect.objectContaining({
        codec: { id: 'json-jcs', version: '1' },
        caseCount: 50,
        medianNetSavingsRatioPpm: 200_000,
      }),
    ]);
    expect(first.reportDigest).toBe(second.reportDigest);
    expect(first.report).toEqual(second.report);
    expect(first.promotionDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(parseHostPromotionManifest(first.promotion)).toEqual(
      first.promotion,
    );
    expect(first.promotion).toMatchObject({
      policyDigest: digestPolicy(targetPolicy),
      deploymentScopeDigest: DEPLOYMENT_SCOPE_DIGEST,
      evaluation: {
        corpusDigest: CORPUS_DIGEST,
        reportDigest: first.reportDigest,
        split: 'held-out',
        unsafeAccepts: 0,
        taskQualityRegressions: 0,
        medianNetSavingsRatioPpm: 200_000,
      },
    });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.report)).toBe(true);
  });

  it('binds every content-free observation into the report digest', () => {
    const targetPolicy = policy();
    const original = evaluateHostPromotionEvidence({
      policy: targetPolicy,
      fixture: fixture(targetPolicy),
    });
    const tampered = mutableFixture(targetPolicy);
    const firstCase = tampered
      .cases[0] as DeepMutable<HostPromotionCompleteCase>;
    firstCase.candidate.traceDigest = sha256('different-trace');
    const changedTrace = evaluateHostPromotionEvidence({
      policy: targetPolicy,
      fixture: tampered,
    });
    firstCase.candidate.normalizedCostUnits = 799_999;
    const changedCounter = evaluateHostPromotionEvidence({
      policy: targetPolicy,
      fixture: tampered,
    });

    expect(changedTrace.reportDigest).not.toBe(original.reportDigest);
    expect(changedCounter.reportDigest).not.toBe(changedTrace.reportDigest);
    expect(changedTrace.report.cases[0]!.evidenceDigest).not.toBe(
      original.report.cases[0]!.evidenceDigest,
    );
  });

  it('does not credit bypass noise as positive promotion savings', () => {
    const targetPolicy = policy();
    const candidate = mutableFixture(targetPolicy);
    for (const item of candidate.cases as DeepMutable<HostPromotionCompleteCase>[]) {
      item.decision = 'bypassed';
    }

    const result = evaluateHostPromotionEvidence({
      policy: targetPolicy,
      fixture: candidate,
    });

    expect(result.qualified).toBe(false);
    expect(result.report.usageMetrics).toMatchObject({
      medianInputSavingsRatioPpm: 300_000,
      medianCostSavingsRatioPpm: 200_000,
      medianNetSavingsRatioPpm: 0,
    });
    expect(result.report.gate.reasons).toEqual([
      'NET_SAVINGS_BELOW_THRESHOLD',
      'CODEC_NET_SAVINGS_BELOW_THRESHOLD',
    ]);
    expect(result).not.toHaveProperty('promotion');
    expect(result).not.toHaveProperty('promotionDigest');
  });

  it.each([
    {
      name: 'artifact drift',
      mutate: (value: DeepMutable<HostPromotionEvidenceFixture>) => {
        value.binding.artifact.version = '2';
      },
      reasons: ['ARTIFACT_MISMATCH'],
    },
    {
      name: 'policy digest drift',
      mutate: (value: DeepMutable<HostPromotionEvidenceFixture>) => {
        value.binding.policyDigest = sha256('wrong-policy');
      },
      reasons: ['POLICY_DIGEST_MISMATCH'],
    },
    {
      name: 'heuristic tokenizer',
      mutate: (value: DeepMutable<HostPromotionEvidenceFixture>) => {
        value.binding.tokenizer.reliability = 'heuristic';
      },
      reasons: ['TOKENIZER_NOT_EXACT'],
    },
    {
      name: 'estimated usage',
      mutate: (value: DeepMutable<HostPromotionEvidenceFixture>) => {
        value.binding.usageEvidence.source = 'estimate';
        value.binding.usageEvidence.reliability = 'estimated';
      },
      reasons: ['USAGE_NOT_EXACT'],
    },
    {
      name: 'development split',
      mutate: (value: DeepMutable<HostPromotionEvidenceFixture>) => {
        value.binding.split = 'development';
      },
      reasons: ['SPLIT_NOT_HELD_OUT'],
    },
    {
      name: 'fixed execution order',
      mutate: (value: DeepMutable<HostPromotionEvidenceFixture>) => {
        value.binding.design.order = 'fixed';
      },
      reasons: ['EVALUATION_DESIGN_INVALID'],
    },
    {
      name: 'scope drift',
      mutate: (value: DeepMutable<HostPromotionEvidenceFixture>) => {
        value.cases[0]!.deploymentScopeDigest = sha256('different-scope');
      },
      reasons: ['DEPLOYMENT_SCOPE_MISMATCH'],
    },
    {
      name: 'unsafe accept',
      mutate: (value: DeepMutable<HostPromotionEvidenceFixture>) => {
        (
          value.cases[0] as DeepMutable<HostPromotionCompleteCase>
        ).unsafeAccepted = true;
      },
      reasons: ['UNSAFE_ACCEPTS'],
    },
    {
      name: 'quality regression',
      mutate: (value: DeepMutable<HostPromotionEvidenceFixture>) => {
        (
          value.cases[0] as DeepMutable<HostPromotionCompleteCase>
        ).taskQualityRegression = true;
      },
      reasons: ['TASK_QUALITY_REGRESSIONS'],
    },
    {
      name: 'underpowered threshold',
      mutate: (value: DeepMutable<HostPromotionEvidenceFixture>) => {
        value.binding.gate.minimumMedianNetSavingsRatioPpm = 50_000;
      },
      reasons: ['PROMOTION_THRESHOLD_TOO_LOW'],
    },
    {
      name: 'latency regression',
      mutate: (value: DeepMutable<HostPromotionEvidenceFixture>) => {
        for (const item of value.cases as DeepMutable<HostPromotionCompleteCase>[]) {
          item.candidate.endToEndLatencyMicros = 1_500_000;
        }
      },
      reasons: ['LATENCY_REGRESSION_ABOVE_THRESHOLD'],
    },
    {
      name: 'insufficient net benefit',
      mutate: (value: DeepMutable<HostPromotionEvidenceFixture>) => {
        for (const item of value.cases as DeepMutable<HostPromotionCompleteCase>[]) {
          item.candidate.totalInputTokens = 950;
          item.candidate.normalizedCostUnits = 950_000;
        }
      },
      reasons: [
        'NET_SAVINGS_BELOW_THRESHOLD',
        'CODEC_NET_SAVINGS_BELOW_THRESHOLD',
      ],
    },
  ])('fails closed for $name', ({ mutate, reasons }) => {
    const targetPolicy = policy();
    const candidate = mutableFixture(targetPolicy);
    mutate(candidate);

    const result = evaluateHostPromotionEvidence({
      policy: targetPolicy,
      fixture: candidate,
    });

    expect(result.qualified).toBe(false);
    expect(result.report.gate.passed).toBe(false);
    expect(result.report.gate.reasons).toEqual(expect.arrayContaining(reasons));
    expect(result).not.toHaveProperty('promotion');
  });

  it('requires complete, stratified, cache-aware, executable codec evidence', () => {
    const targetPolicy = policy();
    const candidate = mutableFixture(targetPolicy);
    candidate.cases.pop();
    for (const item of candidate.cases) {
      item.stratum = 'simple';
      item.cacheRegime = 'cold';
    }
    candidate.cases[0] = {
      schema: 'semwitness.dev/host-promotion-evidence/v1alpha1',
      kind: 'case',
      ordinal: 0,
      status: 'failed',
      stratum: 'simple',
      cacheRegime: 'cold',
      codec: { id: 'json-jcs', version: '1' },
      deploymentScopeDigest: DEPLOYMENT_SCOPE_DIGEST,
      failureReason: 'ACCOUNTING_INCOMPLETE',
    } satisfies DeepMutable<HostPromotionFailedCase>;

    const result = evaluateHostPromotionEvidence({
      policy: targetPolicy,
      fixture: candidate,
    });

    expect(result.report.gate.reasons).toEqual(
      expect.arrayContaining([
        'INCOMPLETE_CORPUS',
        'MISSING_REQUIRED_STRATUM',
        'MISSING_REQUIRED_CACHE_REGIME',
        'EXECUTION_FAILURES',
      ]),
    );
  });

  it('rejects undeclared, unsupported, or policy-ineligible active codecs', () => {
    const targetPolicy = policy();
    const undeclared = mutableFixture(targetPolicy);
    undeclared.cases[0]!.codec = { id: 'identity', version: '1' };
    const undeclaredResult = evaluateHostPromotionEvidence({
      policy: targetPolicy,
      fixture: undeclared,
    });
    expect(undeclaredResult.report.gate.reasons).toContain(
      'UNDECLARED_CODEC_EVIDENCE',
    );

    const unsupported = mutableFixture(targetPolicy);
    unsupported.binding.codecs = [{ id: 'whitespace-rle', version: '1' }];
    for (const item of unsupported.cases) {
      item.codec = { id: 'whitespace-rle', version: '1' };
    }
    const unsupportedResult = evaluateHostPromotionEvidence({
      policy: targetPolicy,
      fixture: unsupported,
    });
    expect(unsupportedResult.report.gate.reasons).toContain(
      'UNSUPPORTED_ACTIVE_CODEC',
    );

    const identityOnlyPolicy = makePolicy({
      mode: 'apply-verified',
      tokenizerId: TOKENIZER_ID,
      rules: [
        {
          match: {},
          codecs: ['identity'],
          allowEquivalence: ['byte-exact'],
        },
      ],
    });
    const ineligible = fixture(identityOnlyPolicy);
    const ineligibleResult = evaluateHostPromotionEvidence({
      policy: identityOnlyPolicy,
      fixture: ineligible,
    });
    expect(ineligibleResult.report.gate.reasons).toContain(
      'CODEC_NOT_ALLOWED_BY_POLICY',
    );
  });

  it('strictly rejects duplicate keys, extra content, duplicate ordinals, and invalid accounting', () => {
    const targetPolicy = policy();
    const valid = fixture(targetPolicy);
    const sourceSentinel = 'PRIVATE_PROMPT_SENTINEL_123';
    const extra = structuredClone(valid.cases[0]!) as unknown as Record<
      string,
      unknown
    >;
    extra.prompt = sourceSentinel;
    const duplicateOrdinal = {
      binding: valid.binding,
      cases: [...valid.cases, valid.cases[0]!],
    };
    const invalidAccounting = mutableFixture(targetPolicy);
    (
      invalidAccounting.cases[0] as DeepMutable<HostPromotionCompleteCase>
    ).candidate.cacheReadInputTokens = 701;

    expect(() =>
      parseHostPromotionEvidenceJsonl(
        `${JSON.stringify(valid.binding)}\n{"schema":"semwitness.dev/host-promotion-evidence/v1alpha1","schema":"semwitness.dev/host-promotion-evidence/v1alpha1"}`,
      ),
    ).toThrow();
    expect(() =>
      parseHostPromotionEvidenceJsonl(
        [JSON.stringify(valid.binding), JSON.stringify(extra)].join('\n'),
      ),
    ).toThrowError(
      expect.objectContaining({
        message: expect.not.stringContaining(sourceSentinel),
      }),
    );
    expect(() => parseHostPromotionEvidenceFixture(duplicateOrdinal)).toThrow();
    expect(() =>
      parseHostPromotionEvidenceFixture(invalidAccounting),
    ).toThrow();
  });

  it('rejects accessor-backed evidence without invoking the accessor', () => {
    let invoked = false;
    const candidate = fixture();
    Object.defineProperty(candidate.binding, 'policyDigest', {
      enumerable: true,
      get() {
        invoked = true;
        return digestPolicy(policy());
      },
    });

    expect(() => parseHostPromotionEvidenceFixture(candidate)).toThrow();
    expect(invoked).toBe(false);
  });

  it('produces a manifest that activates the matching verified host preparer', async () => {
    const targetPolicy = policy();
    const result = evaluateHostPromotionEvidence({
      policy: targetPolicy,
      fixture: fixture(targetPolicy),
    });
    expect(result.promotion).toBeDefined();
    const core = createSemWitness({
      storeRoot: await temporaryRoot(),
      policy: targetPolicy,
      tokenizer: new DeterministicByteTokenizer(TOKENIZER_ID, 'exact'),
    });
    const preparer = createVerifiedTextRequestPreparer(
      core,
      targetPolicy,
      result.promotion,
    );
    const source = `{
      "records": [
        { "id": 1, "status": "ready", "enabled": true },
        { "id": 2, "status": "ready", "enabled": true },
        { "id": 3, "status": "ready", "enabled": true }
      ]
    }`;

    const prepared = await preparer.prepare({
      id: 'generated-promotion-case',
      role: 'tool',
      kind: 'json-data',
      trust: 'workspace-trusted',
      mediaType: 'application/json',
      equivalence: 'typed-semantic',
      deploymentScopeDigest: DEPLOYMENT_SCOPE_DIGEST,
      content: source,
    });

    expect(prepared.applied).toBe(true);
    expect(prepared.selectedCodec).toBe('json-jcs');
    expect(JSON.parse(prepared.content)).toEqual(JSON.parse(source));
    expect(prepared.content.length).toBeLessThan(source.length);
    expect(prepared.promotionDigest).toBe(result.promotionDigest);
  });
});
