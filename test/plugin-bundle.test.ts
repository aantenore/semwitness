import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { canonicalJson, toJsonValue } from '../src/domain/canonical-json.js';
import { sha256 } from '../src/domain/hash.js';
import { digestPolicy } from '../src/domain/policy.js';
import {
  HOST_PREPARER_ARTIFACT,
  digestHostPromotionCorpus,
} from '../src/host/index.js';
import {
  createIntentCacheAdmissionPassportStatement,
  parseIntentCacheShadowQualificationManifest,
  serializeIntentCacheAdmissionPassportStatement,
  serializeIntentCacheShadowQualificationManifest,
} from '../src/intent-host/index.js';
import { serializeCacheHitWitnessArtifact } from '../src/intent/index.js';
import { makePolicy } from './helpers.js';
import {
  createEmptyIntentPromotionFixture,
  createUnsafeHitIntentPromotionFixture,
} from './support/intent-promotion-qualification-fixture.js';

const executeFile = promisify(execFile);
const pluginRoot = fileURLToPath(
  new URL('../plugins/semwitness/', import.meta.url),
);
const intentQualificationFixturePath = fileURLToPath(
  new URL('./fixtures/intent-cache-shadow-qualification.json', import.meta.url),
);
const compactResponseContractPath = fileURLToPath(
  new URL(
    '../examples/compact-response/change-report.contract.json',
    import.meta.url,
  ),
);
const compactResponseCandidatePath = fileURLToPath(
  new URL(
    '../examples/compact-response/change-report.candidate.json',
    import.meta.url,
  ),
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

interface IsolatedPlugin {
  readonly root: string;
  readonly runtimePath: string;
  readonly skillPath: string;
  readonly manifestPath: string;
}

async function executeBundle(
  ...arguments_: readonly string[]
): Promise<BundleExecution> {
  return executeIsolatedBundle(await copyIsolatedPlugin(), ...arguments_);
}

async function executeIsolatedBundle(
  plugin: IsolatedPlugin,
  ...arguments_: readonly string[]
): Promise<BundleExecution> {
  try {
    const { stdout, stderr } = await executeFile(
      process.execPath,
      [plugin.runtimePath, ...arguments_],
      {
        cwd: plugin.root,
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

async function copyIsolatedPlugin(): Promise<IsolatedPlugin> {
  const container = await temporaryRoot();
  const root = join(container, 'semwitness');
  await cp(pluginRoot, root, {
    recursive: true,
    force: false,
    errorOnExist: true,
  });
  return {
    root,
    runtimePath: join(root, 'dist', 'cli.mjs'),
    skillPath: join(root, 'skills', 'semwitness', 'SKILL.md'),
    manifestPath: join(root, '.codex-plugin', 'plugin.json'),
  };
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
      stdout: '0.7.0-alpha.1\n',
      stderr: '',
    });
  });

  it('renders and verifies Compact Response through an isolated plugin copy', async () => {
    const root = await temporaryRoot();
    const plugin = await copyIsolatedPlugin();
    const contractPath = join(root, 'contract.json');
    const candidatePath = join(root, 'candidate.json');
    const renderedPath = join(root, 'rendered.md');
    const witnessPath = join(root, 'witness.json');
    await Promise.all([
      cp(compactResponseContractPath, contractPath),
      cp(compactResponseCandidatePath, candidatePath),
    ]);

    const inspection = await executeIsolatedBundle(
      plugin,
      'response',
      'contract',
      'inspect',
      '--contract',
      contractPath,
    );
    const render = await executeIsolatedBundle(
      plugin,
      'response',
      'render',
      '--contract',
      contractPath,
      '--candidate',
      candidatePath,
      '--out',
      renderedPath,
    );
    await writeFile(witnessPath, render.stdout);
    const verification = await executeIsolatedBundle(
      plugin,
      'response',
      'verify',
      '--contract',
      contractPath,
      '--candidate',
      candidatePath,
      '--rendered',
      renderedPath,
      '--witness',
      witnessPath,
    );

    expect(inspection).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(inspection.stdout)).toMatchObject({
      schema: 'semwitness.dev/compact-response-contract-inspection/v1alpha1',
      valid: true,
      rendererAvailable: true,
      billedOutputSavings: null,
      universalSemanticEquivalence: false,
    });
    expect(render).toMatchObject({ code: 0, stderr: '' });
    expect(render.stdout).not.toMatch(/\n$/u);
    expect(JSON.parse(render.stdout)).toMatchObject({
      schema: 'semwitness.dev/compact-response-witness/v1alpha1',
      decision: 'rendered',
      billedOutputSavings: null,
      universalSemanticEquivalence: false,
    });
    expect(await readFile(renderedPath, 'utf8')).toContain('# Change report');
    expect(verification).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(verification.stdout)).toMatchObject({
      schema: 'semwitness.dev/compact-response-verification/v1alpha1',
      bound: true,
      reasons: [],
      billedOutputSavings: null,
      universalSemanticEquivalence: false,
    });
  });

  it('ships the Promotion Evidence Workbench through the installed launcher', async () => {
    const plugin = await copyIsolatedPlugin();
    const runtime = await readFile(plugin.runtimePath, 'utf8');
    const skill = await readFile(plugin.skillPath, 'utf8');
    const manifest = JSON.parse(
      await readFile(plugin.manifestPath, 'utf8'),
    ) as {
      readonly name: string;
      readonly interface: { readonly defaultPrompt: readonly string[] };
    };
    const { code, stdout, stderr } = await executeIsolatedBundle(
      plugin,
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
    expect(manifest.interface.defaultPrompt).toContain(
      'Evaluate this payload-free intent-cache evidence and emit a shadow qualification only if every gate passes.',
    );
  });

  it('executes the intent qualification evaluator from an isolated plugin copy', async () => {
    const root = await temporaryRoot();
    const plugin = await copyIsolatedPlugin();
    const evidencePath = join(root, 'intent-promotion-evidence.jsonl');
    const fixture = createEmptyIntentPromotionFixture();
    await writeFile(evidencePath, `${JSON.stringify(fixture.binding)}\n`);

    const result = await executeIsolatedBundle(
      plugin,
      'intent',
      'promotion',
      'evaluate',
      '--evidence',
      evidencePath,
      '--json',
    );

    expect(result.code).toBe(2);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({
      schema: 'semwitness.dev/intent-cache-promotion-workbench-result/v1alpha1',
      qualified: false,
      report: { activationCeiling: 'shadow-only' },
    });
  });

  it('ships Passport Statement creation and inspection in the isolated plugin', async () => {
    const root = await temporaryRoot();
    const plugin = await copyIsolatedPlugin();
    const qualificationPath = join(root, 'qualification.json');
    const statementPath = join(root, 'passport.statement.json');
    const qualificationFixture = JSON.parse(
      await readFile(intentQualificationFixturePath, 'utf8'),
    ) as unknown;
    await writeFile(
      qualificationPath,
      serializeIntentCacheShadowQualificationManifest(
        parseIntentCacheShadowQualificationManifest(qualificationFixture),
      ),
    );
    const skill = await readFile(plugin.skillPath, 'utf8');
    const manifest = JSON.parse(
      await readFile(plugin.manifestPath, 'utf8'),
    ) as {
      readonly interface: { readonly defaultPrompt: readonly string[] };
    };
    const create = await executeIsolatedBundle(
      plugin,
      'intent',
      'passport',
      'create',
      '--qualification',
      qualificationPath,
      '--statement-out',
      statementPath,
      '--json',
    );
    const inspect = await executeIsolatedBundle(
      plugin,
      'intent',
      'passport',
      'inspect',
      '--statement',
      statementPath,
      '--qualification',
      qualificationPath,
      '--json',
    );

    expect(create).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(create.stdout)).toMatchObject({
      schema:
        'semwitness.dev/intent-cache-admission-passport-creation/v1alpha1',
      kind: 'creation-only',
      created: true,
      activationCeiling: 'shadow-only',
    });
    expect(inspect).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(inspect.stdout)).toMatchObject({
      bound: true,
      extensionsPresent: false,
      canonicalPayload: true,
    });
    expect(await readFile(statementPath, 'utf8')).not.toMatch(/\n$/u);
    expect(skill).toContain('Cache Admission Passport Statement');
    expect(skill).toContain('`bound: true` does not');
    expect(manifest.interface.defaultPrompt).toContain(
      'Create or inspect a shadow-only Cache Admission Passport Statement for this qualification.',
    );
  });

  it('creates and inspects Admission Decision Statements in an isolated plugin', async () => {
    const root = await temporaryRoot();
    const plugin = await copyIsolatedPlugin();
    const qualification = parseIntentCacheShadowQualificationManifest(
      JSON.parse(await readFile(intentQualificationFixturePath, 'utf8')),
    );
    const fixture = createUnsafeHitIntentPromotionFixture();
    const candidate = fixture.cases[0];
    if (
      candidate === undefined ||
      (candidate.kind !== 'population-complete' &&
        candidate.kind !== 'adversarial-complete') ||
      candidate.path.kind !== 'candidate-bearing'
    ) {
      throw new TypeError('Expected one candidate-bearing admission fixture');
    }

    const paths = {
      qualification: join(root, 'qualification.json'),
      passport: join(root, 'passport.statement.json'),
      cacheHitWitness: join(root, 'cache-hit-witness.json'),
      normalizationWitness: join(root, 'normalization-witness.json'),
      operationBinding: join(root, 'operation-binding.json'),
      entrySourceBinding: join(root, 'entry-source-binding.json'),
      value: join(root, 'candidate-value.bin'),
      statement: join(root, 'admission-decision.statement.json'),
    };
    await Promise.all([
      writeFile(
        paths.qualification,
        serializeIntentCacheShadowQualificationManifest(qualification),
      ),
      writeFile(
        paths.passport,
        serializeIntentCacheAdmissionPassportStatement(
          createIntentCacheAdmissionPassportStatement(qualification),
        ),
      ),
      writeFile(
        paths.cacheHitWitness,
        serializeCacheHitWitnessArtifact(candidate.path.cacheHitWitness),
      ),
      writeFile(
        paths.normalizationWitness,
        canonicalJson(toJsonValue(candidate.path.normalizationWitness)),
      ),
      writeFile(
        paths.operationBinding,
        canonicalJson(toJsonValue(candidate.path.operationBinding)),
      ),
      writeFile(
        paths.entrySourceBinding,
        canonicalJson(toJsonValue(candidate.path.entrySourceBinding)),
      ),
      writeFile(paths.value, 'candidate-artifact:true'),
    ]);

    const secretRef = 'SEMWITNESS_PLUGIN_ADMISSION_SECRET';
    const previousSecret = process.env[secretRef];
    process.env[secretRef] = '0123456789abcdef0123456789abcdef';
    const evidenceArguments = [
      '--qualification',
      paths.qualification,
      '--passport',
      paths.passport,
      '--cache-hit-witness',
      paths.cacheHitWitness,
      '--normalization-witness',
      paths.normalizationWitness,
      '--operation-binding',
      paths.operationBinding,
      '--entry-source-binding',
      paths.entrySourceBinding,
      '--cache-key-secret-env',
      secretRef,
      '--value-file',
      paths.value,
    ] as const;
    let results:
      | { readonly create: BundleExecution; readonly inspect: BundleExecution }
      | undefined;
    try {
      const create = await executeIsolatedBundle(
        plugin,
        'intent',
        'admission',
        'create',
        ...evidenceArguments,
        '--statement-out',
        paths.statement,
        '--json',
      );
      const inspect = await executeIsolatedBundle(
        plugin,
        'intent',
        'admission',
        'inspect',
        ...evidenceArguments,
        '--statement',
        paths.statement,
        '--json',
      );
      results = { create, inspect };
    } finally {
      if (previousSecret === undefined) {
        delete process.env[secretRef];
      } else {
        process.env[secretRef] = previousSecret;
      }
    }
    if (results === undefined) {
      throw new TypeError('Admission Decision plugin execution was incomplete');
    }
    const { create, inspect } = results;

    expect(create).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(create.stdout)).toMatchObject({
      schema:
        'semwitness.dev/intent-cache-admission-decision-creation/v1alpha1',
      authentication: 'none',
      mode: 'shadow',
      activationCeiling: 'shadow-only',
      servingAuthority: 'none',
    });
    expect(inspect).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(inspect.stdout)).toMatchObject({
      bound: true,
      profileBound: true,
      canonicalPayload: true,
      servingAuthority: 'none',
    });
    expect(await readFile(paths.statement, 'utf8')).not.toMatch(/\n$/u);
    expect(create.stdout).not.toContain('candidate-artifact:true');
    expect(inspect.stdout).not.toContain('0123456789abcdef');

    const skill = await readFile(plugin.skillPath, 'utf8');
    const manifest = JSON.parse(
      await readFile(plugin.manifestPath, 'utf8'),
    ) as {
      readonly interface: { readonly defaultPrompt: readonly string[] };
    };
    expect(skill).toContain('Cache Admission Decision Statement');
    expect(skill).toContain('`servingAuthority: none`');
    expect(manifest.interface.defaultPrompt).toContain(
      'Create or inspect a shadow-only Cache Admission Decision Statement for this exact Passport and eligible hit.',
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
