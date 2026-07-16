import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { sha256 } from '../src/domain/hash.js';
import { digestPolicy } from '../src/domain/policy.js';
import {
  HOST_PREPARER_ARTIFACT,
  digestHostPromotionCorpus,
} from '../src/host/index.js';
import { makePolicy } from './helpers.js';

const executeFile = promisify(execFile);
const pluginRoot = fileURLToPath(
  new URL('../plugins/semwitness/', import.meta.url),
);
const runtimePath = fileURLToPath(
  new URL('../plugins/semwitness/dist/cli.mjs', import.meta.url),
);
const skillPath = fileURLToPath(
  new URL('../plugins/semwitness/skills/semwitness/SKILL.md', import.meta.url),
);
const manifestPath = fileURLToPath(
  new URL('../plugins/semwitness/.codex-plugin/plugin.json', import.meta.url),
);
const temporaryRoots = new Set<string>();

interface BundleExecution {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface FailedBundleExecution extends Error {
  readonly code?: number | string;
  readonly stdout?: string;
  readonly stderr?: string;
}

async function executeBundle(
  ...arguments_: readonly string[]
): Promise<BundleExecution> {
  try {
    const { stdout, stderr } = await executeFile(
      process.execPath,
      [runtimePath, ...arguments_],
      {
        cwd: pluginRoot,
        encoding: 'utf8',
        timeout: 10_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as FailedBundleExecution;
    if (typeof failed.code !== 'number') throw error;
    return {
      code: failed.code,
      stdout: failed.stdout ?? '',
      stderr: failed.stderr ?? '',
    };
  }
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'semwitness-plugin-bundle-'));
  temporaryRoots.add(root);
  return root;
}

function promotionEvidence(duplicateQualityEvidence = false): {
  readonly policy: ReturnType<typeof makePolicy>;
  readonly source: string;
} {
  const policy = makePolicy({
    mode: 'apply-verified',
    tokenizerId: 'plugin-bundle-promotion-exact',
  });
  const deploymentScopeDigest = sha256('plugin-bundle-promotion-scope-v1');
  const caseDigests = Array.from({ length: 50 }, (_, ordinal) =>
    sha256(`plugin-bundle-held-out-case-${ordinal}`),
  );
  const binding = {
    schema: 'semwitness.dev/host-promotion-evidence/v1alpha1',
    kind: 'binding',
    artifact: HOST_PREPARER_ARTIFACT,
    policyDigest: digestPolicy(policy),
    deploymentScopeDigest,
    corpusDigest: digestHostPromotionCorpus(caseDigests),
    evaluationProtocolDigest: sha256('plugin-bundle-promotion-protocol-v1'),
    split: 'held-out',
    usageEvidence: {
      source: 'runtime-accounting',
      reliability: 'exact',
    },
    expectedCases: 50,
    tokenizer: {
      id: policy.tokenizerId,
      fingerprint: sha256('plugin-bundle-exact-tokenizer-v1'),
      reliability: 'exact',
    },
    codecs: [{ id: 'json-jcs', version: '1' }],
    design: {
      pairing: 'paired',
      order: 'counterbalanced',
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
      traceDigest: sha256(`plugin-bundle-baseline-${ordinal}`),
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
      traceDigest: sha256(`plugin-bundle-candidate-${ordinal}`),
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
    qualityEvidenceDigest: sha256(
      `plugin-bundle-quality-${duplicateQualityEvidence && ordinal === 1 ? 0 : ordinal}`,
    ),
  }));
  return {
    policy,
    source: `${[binding, ...cases].map((item) => JSON.stringify(item)).join('\n')}\n`,
  };
}

async function writePromotionFixture(
  root: string,
  duplicateQualityEvidence = false,
): Promise<{ readonly evidencePath: string; readonly policyPath: string }> {
  const evidencePath = join(root, 'promotion-evidence.jsonl');
  const policyPath = join(root, 'apply-policy.json');
  const candidate = promotionEvidence(duplicateQualityEvidence);
  await Promise.all([
    writeFile(evidencePath, candidate.source),
    writeFile(policyPath, JSON.stringify(candidate.policy)),
  ]);
  return { evidencePath, policyPath };
}

afterEach(async () => {
  await Promise.all(
    [...temporaryRoots].map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
  temporaryRoots.clear();
});

describe('bundled Codex plugin', () => {
  it('reports the installable plugin version', async () => {
    const result = await executeBundle('--version');

    expect(result).toEqual({
      code: 0,
      stdout: '0.5.0-alpha.2\n',
      stderr: '',
    });
  });

  it('ships the Promotion Evidence Workbench through the installed launcher', async () => {
    const runtime = await readFile(runtimePath, 'utf8');
    const skill = await readFile(skillPath, 'utf8');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      readonly name: string;
      readonly interface: { readonly defaultPrompt: readonly string[] };
    };
    const { code, stdout, stderr } = await executeBundle(
      'promotion',
      'evaluate',
      '--help',
    );

    expect(runtime.startsWith('#!/usr/bin/env node\n')).toBe(true);
    expect(code).toBe(0);
    expect(stderr).toBe('');
    expect(stdout).toContain('semwitness promotion evaluate');
    expect(stdout).toContain('--manifest-out <file>');
    expect(skill).toContain('Promotion Evidence Workbench');
    expect(skill).toContain('host-attested-unsigned');
    expect(manifest.name).toBe('semwitness');
    expect(manifest.interface.defaultPrompt).toContain(
      'Evaluate this held-out promotion evidence and emit a manifest only if every gate passes.',
    );
  });

  it('qualifies a valid held-out corpus through the installed launcher', async () => {
    const root = await temporaryRoot();
    const { evidencePath, policyPath } = await writePromotionFixture(root);

    const result = await executeBundle(
      'promotion',
      'evaluate',
      '--evidence',
      evidencePath,
      '--policy',
      policyPath,
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({
      qualified: true,
      report: { gate: { passed: true, reasons: [] } },
      promotion: {
        artifact: HOST_PREPARER_ARTIFACT,
        policyDigest: digestPolicy(promotionEvidence().policy),
      },
    });
  });

  it('returns exit two when duplicate quality evidence fails the new gate', async () => {
    const root = await temporaryRoot();
    const { evidencePath, policyPath } = await writePromotionFixture(
      root,
      true,
    );

    const result = await executeBundle(
      'promotion',
      'evaluate',
      '--evidence',
      evidencePath,
      '--policy',
      policyPath,
    );

    expect(result.code).toBe(2);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({
      qualified: false,
      report: {
        caseMetrics: { duplicateQualityEvidenceDigests: 1 },
        gate: {
          passed: false,
          reasons: ['DUPLICATE_QUALITY_EVIDENCE'],
        },
      },
    });
    expect(JSON.parse(result.stdout)).not.toHaveProperty('promotion');
  });
});
