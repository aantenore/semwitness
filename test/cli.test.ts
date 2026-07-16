import { Buffer } from 'node:buffer';
import {
  lstat,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalJson, toJsonValue } from '../src/domain/canonical-json.js';
import { hashCanonical, sha256 } from '../src/domain/hash.js';
import { digestPolicy } from '../src/domain/policy.js';
import {
  parseSimulationBundle,
  type SimulationBundle,
} from '../src/entrypoints/bundle.js';
import { runCli } from '../src/entrypoints/cli.js';
import {
  INTENT_EVALUATION_FIXTURE_SCHEMA,
  INTENT_OPERATION_REGISTRY_SCHEMA,
  INTENT_SCHEMA,
} from '../src/intent/index.js';
import {
  HOST_PREPARER_ARTIFACT,
  digestHostPromotionCorpus,
} from '../src/host/index.js';
import { makePolicy } from './helpers.js';

type DeepMutable<T> = T extends readonly (infer Item)[]
  ? DeepMutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: DeepMutable<T[Key]> }
    : T;

interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface SimulationFixture {
  readonly source: string;
  readonly bundle: SimulationBundle;
  readonly wire: string;
  readonly store: string;
}

const checkedInReplayPath = fileURLToPath(
  new URL('../examples/replay.jsonl', import.meta.url),
);
const temporaryRoots = new Set<string>();

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'semwitness-cli-test-'));
  temporaryRoots.add(root);
  return root;
}

function writeCapture(target: { value: string }): typeof process.stdout.write {
  return ((chunk: string | Uint8Array) => {
    target.value +=
      typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stdout.write;
}

async function invoke(...arguments_: readonly string[]): Promise<CliResult> {
  const stdout = { value: '' };
  const stderr = { value: '' };
  const stdoutSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation(writeCapture(stdout));
  const stderrSpy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation(writeCapture(stderr));
  try {
    const code = await runCli(['node', 'semwitness', ...arguments_]);
    return { code, stdout: stdout.value, stderr: stderr.value };
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }
}

async function simulateFixture(root: string): Promise<SimulationFixture> {
  const sourceMarker = 'CLI_SOURCE_SENTINEL_d10fe5f068c3';
  const records = Array.from(
    { length: 48 },
    (_, index) =>
      `    { "index": ${index}, "marker": "${sourceMarker}", "status": "ready" }`,
  ).join(',\n');
  const source = `{
  "records": [
${records}
  ]
}`;
  const input = join(root, 'input.json');
  const store = join(root, 'store');
  await writeFile(input, source);

  const result = await invoke(
    'simulate',
    '--input',
    input,
    '--role',
    'tool',
    '--kind',
    'json-data',
    '--trust',
    'workspace-trusted',
    '--store',
    store,
  );
  expect(result.code).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.stdout).not.toContain(sourceMarker);
  expect(result.stdout).not.toContain(Buffer.from(source).toString('base64'));
  return {
    source,
    bundle: parseSimulationBundle(result.stdout),
    wire: result.stdout,
    store,
  };
}

function resealBundle(bundle: DeepMutable<SimulationBundle>): void {
  const { bundleDigest: _bundleDigest, ...unsigned } = bundle;
  bundle.bundleDigest = hashCanonical(toJsonValue(unsigned));
}

function promotionCliEvidence(unsafeAccepted = false): {
  readonly policy: ReturnType<typeof makePolicy>;
  readonly source: string;
} {
  const policy = makePolicy({
    mode: 'apply-verified',
    tokenizerId: 'cli-promotion-exact',
  });
  const deploymentScopeDigest = sha256('cli-promotion-scope-v1');
  const privateSourceSentinel = 'PRIVATE_PROMPT_SENTINEL_cli_promotion';
  const caseDigests = Array.from({ length: 50 }, (_, ordinal) =>
    sha256(`${privateSourceSentinel}-${ordinal}`),
  );
  const binding = {
    schema: 'semwitness.dev/host-promotion-evidence/v1alpha1',
    kind: 'binding',
    artifact: HOST_PREPARER_ARTIFACT,
    policyDigest: digestPolicy(policy),
    deploymentScopeDigest,
    corpusDigest: digestHostPromotionCorpus(caseDigests),
    evaluationProtocolDigest: sha256('cli-promotion-protocol-v1'),
    split: 'held-out',
    usageEvidence: {
      source: 'runtime-accounting',
      reliability: 'exact',
    },
    expectedCases: 50,
    tokenizer: {
      id: policy.tokenizerId,
      fingerprint: sha256('cli-exact-tokenizer-v1'),
      reliability: 'exact',
    },
    codecs: [{ id: 'json-jcs', version: '1' }],
    design: {
      pairing: 'paired',
      order: 'randomized',
      requiredStrata: ['simple', 'medium', 'complex', 'adversarial'],
      requiredCacheRegimes: ['cold', 'warm'],
      minimumCasesPerStratumCacheCell: 5,
    },
    gate: {
      minimumMedianNetSavingsRatioPpm: 100_000,
      maximumMedianLatencyRegressionRatioPpm: 250_000,
      maximumCaseNetRegressionRatioPpm: 500_000,
      maximumCaseLatencyRegressionRatioPpm: 500_000,
    },
  };
  const strata = ['simple', 'medium', 'complex', 'adversarial'] as const;
  const cases = Array.from({ length: 50 }, (_, ordinal) => ({
    schema: 'semwitness.dev/host-promotion-evidence/v1alpha1',
    kind: 'case',
    ordinal,
    caseDigest: caseDigests[ordinal],
    status: 'complete',
    stratum: strata[Math.floor(ordinal / 2) % strata.length],
    cacheRegime: ordinal % 2 === 0 ? 'cold' : 'warm',
    codec: { id: 'json-jcs', version: '1' },
    deploymentScopeDigest,
    decision: 'applied',
    baseline: {
      traceDigest: sha256(`cli-baseline-${ordinal}`),
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
      traceDigest: sha256(`cli-candidate-${ordinal}`),
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
    unsafeAccepted: unsafeAccepted && ordinal === 0,
    taskQualityRegression: false,
    qualityEvidenceDigest: sha256(`cli-quality-${ordinal}`),
  }));
  return {
    policy,
    source: `${[binding, ...cases].map((item) => JSON.stringify(item)).join('\n')}\n`,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    [...temporaryRoots].map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
  temporaryRoots.clear();
});

describe('CLI end-to-end verdicts', () => {
  it('simulates, verifies and reports content-free CAS statistics with exit zero', async () => {
    const root = await temporaryRoot();
    const fixture = await simulateFixture(root);
    const bundlePath = join(root, 'bundle.json');
    await writeFile(bundlePath, fixture.wire);

    const verification = await invoke(
      'verify',
      '--bundle',
      bundlePath,
      '--store',
      fixture.store,
    );
    expect(verification.code).toBe(0);
    expect(verification.stderr).toBe('');
    expect(JSON.parse(verification.stdout)).toMatchObject({
      schema: 'semwitness.dev/verification-report/v1alpha1',
      verified: true,
      reasons: [],
      bundleDigest: fixture.bundle.bundleDigest,
      originalSha256: fixture.bundle.input.sha256,
      projectedSha256: fixture.bundle.proof.encoded.sha256,
    });

    const stats = await invoke('stats', '--store', fixture.store);
    expect(stats.code).toBe(0);
    expect(stats.stderr).toBe('');
    expect(JSON.parse(stats.stdout)).toMatchObject({
      schema: 'semwitness.dev/cas-stats/v1alpha1',
      objectCount: expect.any(Number),
      totalBytes: expect.any(Number),
      ignoredEntries: 0,
    });
    expect(stats.stdout).not.toContain(fixture.source);
    expect(stats.stdout).not.toContain(
      Buffer.from(fixture.source).toString('base64'),
    );
  });

  it('returns verdict exit two for a cryptographically resealed but invalid proof', async () => {
    const root = await temporaryRoot();
    const fixture = await simulateFixture(root);
    const tampered = structuredClone(
      fixture.bundle,
    ) as DeepMutable<SimulationBundle>;
    tampered.proof.tokenEvidence[0]!.encodedTokens += 1;
    resealBundle(tampered);
    const bundlePath = join(root, 'tampered-bundle.json');
    await writeFile(bundlePath, canonicalJson(toJsonValue(tampered)));

    const verification = await invoke(
      'verify',
      '--bundle',
      bundlePath,
      '--store',
      fixture.store,
    );

    expect(verification.code).toBe(2);
    expect(verification.stderr).toBe('');
    expect(JSON.parse(verification.stdout)).toMatchObject({
      schema: 'semwitness.dev/verification-report/v1alpha1',
      verified: false,
      reasons: expect.arrayContaining([
        'PROOF_DIGEST_MISMATCH',
        'TOKENIZER_ERROR',
      ]),
    });
  });

  it('replays the checked-in corpus with explicit unassessed semantics', async () => {
    const strict = await invoke('replay', '--fixture', checkedInReplayPath);
    const strictReport = JSON.parse(strict.stdout) as {
      readonly failed: number;
      readonly executionFailures: number;
      readonly unassessed: number;
    };
    expect(strict.code).toBe(strictReport.unassessed > 0 ? 2 : 0);
    expect(strict.stderr).toBe('');
    expect(strictReport.failed).toBe(0);
    expect(strictReport.executionFailures).toBe(0);

    const exploratory = await invoke(
      'replay',
      '--fixture',
      checkedInReplayPath,
      '--allow-unassessed',
    );
    expect(exploratory.code).toBe(0);
    expect(exploratory.stderr).toBe('');
  });

  it('returns verdict exit two when a replay expectation fails', async () => {
    const root = await temporaryRoot();
    const fixture = join(root, 'failing-replay.jsonl');
    await writeFile(
      fixture,
      `${JSON.stringify({
        id: 'deliberate-expectation-failure',
        input: {
          role: 'developer',
          kind: 'instruction',
          trust: 'host-trusted',
          content: 'protected instruction',
        },
        expect: { decisionStatus: 'bypassed', codecId: 'json-jcs' },
      })}\n`,
    );

    const replay = await invoke('replay', '--fixture', fixture);

    expect(replay.code).toBe(2);
    expect(replay.stderr).toBe('');
    expect(JSON.parse(replay.stdout)).toMatchObject({
      failed: 1,
      executionFailures: 0,
      unassessed: 0,
      cases: [
        {
          id: 'deliberate-expectation-failure',
          status: 'failed',
          expectationFailures: ['codecId'],
        },
      ],
    });
  });
});

describe('CLI retrieval and stable errors', () => {
  it('retrieves to a new private file and refuses an overwrite without leaking content or path', async () => {
    const root = await temporaryRoot();
    const fixture = await simulateFixture(root);
    const destination = join(root, 'retrieved-private.json');

    const retrieved = await invoke(
      'retrieve',
      fixture.bundle.input.sha256,
      '--store',
      fixture.store,
      '--out',
      destination,
    );
    expect(retrieved.code).toBe(0);
    expect(retrieved.stderr).toBe('');
    expect(await readFile(destination, 'utf8')).toBe(fixture.source);
    if (process.platform !== 'win32') {
      expect((await lstat(destination)).mode & 0o777).toBe(0o600);
    }
    expect(retrieved.stdout).not.toContain(fixture.source);
    expect(retrieved.stdout).not.toContain(destination);

    const refused = await invoke(
      'retrieve',
      fixture.bundle.input.sha256,
      '--store',
      fixture.store,
      '--out',
      destination,
    );
    expect(refused).toEqual({
      code: 1,
      stdout: '',
      stderr:
        '{"error":{"message":"Content could not be written safely","reason":"CAS_WRITE_FAILED"},"ok":false,"schema":"semwitness.dev/cli-error/v1alpha1"}\n',
    });
    expect(await readFile(destination, 'utf8')).toBe(fixture.source);
  });

  it('emits a deterministic generic error envelope for invalid command input', async () => {
    const root = await temporaryRoot();
    const input = join(root, 'input.txt');
    await writeFile(input, 'not exposed');

    const result = await invoke(
      'simulate',
      '--input',
      input,
      '--role',
      'not-a-role',
      '--kind',
      'prose',
      '--trust',
      'workspace-trusted',
      '--store',
      join(root, 'store'),
    );

    expect(result).toEqual({
      code: 1,
      stdout: '',
      stderr:
        '{"error":{"message":"Command input or serialized data is invalid","reason":"MALFORMED_ENVELOPE"},"ok":false,"schema":"semwitness.dev/cli-error/v1alpha1"}\n',
    });
  });
});

describe('CLI intent normalizer evaluation', () => {
  it('evaluates offline without exposing source or IntentIR payloads', async () => {
    const root = await temporaryRoot();
    const normalizerPath = join(root, 'normalizer.json');
    const fixturePath = join(root, 'intent-eval.jsonl');
    const source = 'CLI_INTENT_SOURCE_SENTINEL_8d06ba';
    const ontology = {
      id: 'cli-intents',
      version: '1.0.0',
      digest: sha256('cli-intents-v1'),
    };
    const intent = {
      schema: INTENT_SCHEMA,
      ontology,
      goal: {
        namespace: 'knowledge',
        action: 'explain',
        object: 'private-cli-object',
        polarity: 'affirm',
      },
      slots: [],
      constraints: [],
      temporal: { kind: 'none' },
      output: { format: 'markdown', locale: 'it-IT', detail: 'concise' },
      effect: 'read',
    };
    await writeFile(
      normalizerPath,
      JSON.stringify({
        schema: INTENT_OPERATION_REGISTRY_SCHEMA,
        ontology,
        minimumConfidencePpm: 950_000,
        operations: [
          {
            id: 'explain-private-cli-object',
            aliases: [{ locale: 'it-IT', text: source }],
            intent,
          },
        ],
      }),
    );
    await writeFile(
      fixturePath,
      `${JSON.stringify({
        schema: INTENT_EVALUATION_FIXTURE_SCHEMA,
        kind: 'case',
        id: 'cli-case',
        familyId: 'cli-family',
        split: 'conformance',
        difficulty: 'simple',
        phenomena: ['paraphrase'],
        input: { source, locale: 'it-IT' },
        expect: { kind: 'intent', intent },
      })}\n`,
    );

    const result = await invoke(
      'intent',
      'evaluate',
      '--normalizer',
      normalizerPath,
      '--fixture',
      fixturePath,
      '--runs',
      '2',
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({
      schema: 'semwitness.dev/intent-normalizer-eval-report/v1alpha1',
      mode: 'shadow',
      activeCacheQualified: false,
      gate: { passed: true, reasons: [] },
      caseMetrics: { total: 1, passed: 1 },
    });
    expect(result.stdout).not.toContain(source);
    expect(result.stdout).not.toContain('private-cli-object');
  });

  it('uses exit two for a completed failed gate and exit one for malformed config', async () => {
    const root = await temporaryRoot();
    const normalizerPath = join(root, 'normalizer.json');
    const fixturePath = join(root, 'intent-eval.jsonl');
    const ontology = {
      id: 'cli-intents',
      version: '1.0.0',
      digest: sha256('cli-intents-v1'),
    };
    const intent = {
      schema: INTENT_SCHEMA,
      ontology,
      goal: {
        namespace: 'knowledge',
        action: 'explain',
        object: 'redis',
        polarity: 'affirm',
      },
      slots: [],
      constraints: [],
      temporal: { kind: 'none' },
      output: { format: 'markdown', locale: 'it-IT', detail: 'concise' },
      effect: 'read',
    };
    const registry = {
      schema: INTENT_OPERATION_REGISTRY_SCHEMA,
      ontology,
      minimumConfidencePpm: 950_000,
      operations: [
        {
          id: 'explain-redis',
          aliases: [{ locale: 'it-IT', text: 'Spiegami Redis' }],
          intent,
        },
      ],
    };
    await writeFile(normalizerPath, JSON.stringify(registry));
    await writeFile(
      fixturePath,
      `${JSON.stringify({
        schema: INTENT_EVALUATION_FIXTURE_SCHEMA,
        kind: 'case',
        id: 'cli-failure',
        familyId: 'cli-failure',
        split: 'conformance',
        difficulty: 'adversarial',
        phenomena: ['negation'],
        input: { source: 'Spiegami Redis', locale: 'it-IT' },
        expect: { kind: 'bypass' },
      })}\n`,
    );
    const failed = await invoke(
      'intent',
      'evaluate',
      '--normalizer',
      normalizerPath,
      '--fixture',
      fixturePath,
    );
    expect(failed.code).toBe(2);
    expect(JSON.parse(failed.stdout)).toMatchObject({
      gate: { passed: false },
      caseMetrics: { unsafeAccepts: 1 },
    });

    await writeFile(
      normalizerPath,
      JSON.stringify({ ...registry, dynamicImport: './unsafe.js' }),
    );
    const malformed = await invoke(
      'intent',
      'evaluate',
      '--normalizer',
      normalizerPath,
      '--fixture',
      fixturePath,
    );
    expect(malformed.code).toBe(1);
    expect(malformed.stdout).toBe('');
    expect(JSON.parse(malformed.stderr)).toMatchObject({
      ok: false,
      error: { reason: 'INTENT_MALFORMED' },
    });
  });
});

describe('CLI promotion evidence workbench', () => {
  it('writes a new private manifest only after the held-out gate passes', async () => {
    const root = await temporaryRoot();
    const evidencePath = join(root, 'promotion-evidence.jsonl');
    const policyPath = join(root, 'apply-policy.json');
    const manifestPath = join(root, 'promotion.json');
    const candidate = promotionCliEvidence();
    await writeFile(evidencePath, candidate.source);
    await writeFile(policyPath, JSON.stringify(candidate.policy));

    const result = await invoke(
      'promotion',
      'evaluate',
      '--evidence',
      evidencePath,
      '--policy',
      policyPath,
      '--manifest-out',
      manifestPath,
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).not.toContain(
      'PRIVATE_PROMPT_SENTINEL_cli_promotion',
    );
    const report = JSON.parse(result.stdout) as {
      readonly qualified: boolean;
      readonly reportDigest: string;
      readonly promotion: unknown;
      readonly promotionDigest: string;
    };
    expect(report).toMatchObject({
      qualified: true,
      reportDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      promotionDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });
    expect(JSON.parse(await readFile(manifestPath, 'utf8'))).toEqual(
      report.promotion,
    );
    if (process.platform !== 'win32') {
      expect((await lstat(manifestPath)).mode & 0o777).toBe(0o600);
    }
  });

  it('uses exit two and creates no manifest when valid evidence fails a gate', async () => {
    const root = await temporaryRoot();
    const evidencePath = join(root, 'unsafe-evidence.jsonl');
    const policyPath = join(root, 'apply-policy.json');
    const manifestPath = join(root, 'must-not-exist.json');
    const candidate = promotionCliEvidence(true);
    await writeFile(evidencePath, candidate.source);
    await writeFile(policyPath, JSON.stringify(candidate.policy));

    const result = await invoke(
      'promotion',
      'evaluate',
      '--evidence',
      evidencePath,
      '--policy',
      policyPath,
      '--manifest-out',
      manifestPath,
    );

    expect(result.code).toBe(2);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({
      qualified: false,
      report: {
        caseMetrics: { unsafeAccepts: 1 },
        gate: { passed: false, reasons: ['UNSAFE_ACCEPTS'] },
      },
    });
    expect(JSON.parse(result.stdout)).not.toHaveProperty('promotion');
    await expect(lstat(manifestPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails with a generic content-free error for malformed evidence', async () => {
    const root = await temporaryRoot();
    const evidencePath = join(root, 'malformed-evidence.jsonl');
    const policyPath = join(root, 'apply-policy.json');
    const manifestPath = join(root, 'must-not-exist.json');
    const candidate = promotionCliEvidence();
    const records = candidate.source.trimEnd().split('\n');
    const malformedCase = JSON.parse(records[1]!) as Record<string, unknown>;
    malformedCase.prompt = 'PRIVATE_MALFORMED_EVIDENCE_SENTINEL';
    records[1] = JSON.stringify(malformedCase);
    await writeFile(evidencePath, `${records.join('\n')}\n`);
    await writeFile(policyPath, JSON.stringify(candidate.policy));

    const result = await invoke(
      'promotion',
      'evaluate',
      '--evidence',
      evidencePath,
      '--policy',
      policyPath,
      '--manifest-out',
      manifestPath,
    );

    expect(result).toEqual({
      code: 1,
      stdout: '',
      stderr:
        '{"error":{"message":"Command input or serialized data is invalid","reason":"MALFORMED_ENVELOPE"},"ok":false,"schema":"semwitness.dev/cli-error/v1alpha1"}\n',
    });
    expect(result.stderr).not.toContain('PRIVATE_MALFORMED_EVIDENCE_SENTINEL');
    await expect(lstat(manifestPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.runIf(process.platform !== 'win32')(
    'refuses promotion evidence read through a symbolic link',
    async () => {
      const root = await temporaryRoot();
      const evidencePath = join(root, 'promotion-evidence.jsonl');
      const linkedEvidencePath = join(root, 'linked-evidence.jsonl');
      const policyPath = join(root, 'apply-policy.json');
      const candidate = promotionCliEvidence();
      await writeFile(evidencePath, candidate.source);
      await symlink(evidencePath, linkedEvidencePath);
      await writeFile(policyPath, JSON.stringify(candidate.policy));

      const result = await invoke(
        'promotion',
        'evaluate',
        '--evidence',
        linkedEvidencePath,
        '--policy',
        policyPath,
      );

      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).not.toContain('PRIVATE_PROMPT_SENTINEL');
    },
  );
});
