import { Buffer } from 'node:buffer';
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runCli } from '../src/entrypoints/cli.js';
import { canonicalJson, toJsonValue } from '../src/domain/canonical-json.js';
import { sha256 } from '../src/domain/hash.js';
import { serializeCacheHitWitnessArtifact } from '../src/intent/index.js';
import {
  createIntentCacheAdmissionPassportStatement,
  parseIntentCacheAdmissionDecisionStatement,
  parseIntentCacheShadowQualificationManifest,
  serializeIntentCacheAdmissionDecisionStatement,
  serializeIntentCacheAdmissionPassportStatement,
  serializeIntentCacheShadowQualificationManifest,
} from '../src/intent-host/index.js';
import { createUnsafeHitIntentPromotionFixture } from './support/intent-promotion-qualification-fixture.js';

interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface AdmissionEvidencePaths {
  readonly root: string;
  readonly qualification: string;
  readonly passport: string;
  readonly cacheHitWitness: string;
  readonly normalizationWitness: string;
  readonly operationBinding: string;
  readonly entrySourceBinding: string;
  readonly valueFile: string;
}

const CACHE_KEY_SECRET_ENV = 'SEMWITNESS_TEST_ADMISSION_SECRET';
const CACHE_KEY_SECRET = '0123456789abcdef0123456789abcdef';
const CANDIDATE_VALUE = 'candidate-artifact:true';
const temporaryRoots = new Set<string>();

let originalSecret: string | undefined;

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

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(
    join(tmpdir(), 'semwitness-intent-admission-cli-'),
  );
  temporaryRoots.add(root);
  return root;
}

async function writeAdmissionEvidence(): Promise<AdmissionEvidencePaths> {
  const root = await temporaryRoot();
  const qualification = parseIntentCacheShadowQualificationManifest(
    JSON.parse(
      await readFile(
        new URL(
          './fixtures/intent-cache-shadow-qualification.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ),
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

  const paths: AdmissionEvidencePaths = {
    root,
    qualification: join(root, 'qualification.json'),
    passport: join(root, 'passport.statement.json'),
    cacheHitWitness: join(root, 'cache-hit-witness.json'),
    normalizationWitness: join(root, 'normalization-witness.json'),
    operationBinding: join(root, 'operation-binding.json'),
    entrySourceBinding: join(root, 'entry-source-binding.json'),
    valueFile: join(root, 'candidate-value.bin'),
  };
  const passport = serializeIntentCacheAdmissionPassportStatement(
    createIntentCacheAdmissionPassportStatement(qualification),
  );
  await Promise.all([
    writeFile(
      paths.qualification,
      serializeIntentCacheShadowQualificationManifest(qualification),
    ),
    writeFile(paths.passport, passport),
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
    writeFile(paths.valueFile, CANDIDATE_VALUE),
  ]);
  return paths;
}

function evidenceArguments(
  paths: AdmissionEvidencePaths,
  overrides: Partial<AdmissionEvidencePaths> = {},
  environmentRef = CACHE_KEY_SECRET_ENV,
): readonly string[] {
  const selected = { ...paths, ...overrides };
  return [
    '--qualification',
    selected.qualification,
    '--passport',
    selected.passport,
    '--cache-hit-witness',
    selected.cacheHitWitness,
    '--normalization-witness',
    selected.normalizationWitness,
    '--operation-binding',
    selected.operationBinding,
    '--entry-source-binding',
    selected.entrySourceBinding,
    '--cache-key-secret-env',
    environmentRef,
    '--value-file',
    selected.valueFile,
  ];
}

function parseReceipt(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>;
}

function expectCliError(result: CliResult, reason: string): void {
  expect(result.code).toBe(1);
  expect(result.stdout).toBe('');
  expect(JSON.parse(result.stderr)).toMatchObject({
    schema: 'semwitness.dev/cli-error/v1alpha1',
    ok: false,
    error: { reason },
  });
}

function expectContentFreeReceipt(
  result: CliResult,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  const receipt = parseReceipt(result.stdout);
  expect(result.stdout).toBe(`${canonicalJson(toJsonValue(receipt))}\n`);
  expect(Object.keys(receipt).sort()).toEqual([...expectedKeys].sort());
  expect(
    Object.values(receipt).every(
      (value) =>
        value === null ||
        typeof value === 'string' ||
        typeof value === 'boolean',
    ),
  ).toBe(true);
  expect(result.stdout).not.toContain(CACHE_KEY_SECRET);
  expect(result.stdout).not.toContain(CANDIDATE_VALUE);
  expect(result.stdout).not.toContain('CACHE_HIT_ELIGIBLE');
  return receipt;
}

async function expectMissing(path: string): Promise<void> {
  await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
}

beforeEach(() => {
  originalSecret = process.env[CACHE_KEY_SECRET_ENV];
  delete process.env[CACHE_KEY_SECRET_ENV];
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (originalSecret === undefined) {
    delete process.env[CACHE_KEY_SECRET_ENV];
  } else {
    process.env[CACHE_KEY_SECRET_ENV] = originalSecret;
  }
  await Promise.all(
    [...temporaryRoots].map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
  temporaryRoots.clear();
});

describe('CLI intent-cache Admission Decision Statements', () => {
  it('documents the evidence-only, unsigned create and inspect boundary', async () => {
    const create = await invoke('intent', 'admission', 'create', '--help');
    expect(create).toMatchObject({ code: 0, stderr: '' });
    expect(create.stdout).toContain('semwitness intent admission create');
    for (const option of [
      '--qualification <file>',
      '--passport <file>',
      '--cache-hit-witness <file>',
      '--normalization-witness <file>',
      '--operation-binding <file>',
      '--entry-source-binding <file>',
      '--cache-key-secret-env <name>',
      '--value-file <file>',
      '--statement-out <file>',
      '--json',
    ]) {
      expect(create.stdout).toContain(option);
    }
    expect(create.stdout).not.toMatch(
      /--(?:sign|approve|active|policy)(?:\s|$)/u,
    );

    const inspect = await invoke('intent', 'admission', 'inspect', '--help');
    expect(inspect).toMatchObject({ code: 0, stderr: '' });
    expect(inspect.stdout).toContain('semwitness intent admission inspect');
    expect(inspect.stdout).toContain('--statement <file>');
    expect(inspect.stdout).toContain('--value-file <file>');
    expect(inspect.stdout).toContain('--cache-key-secret-env <name>');
    expect(inspect.stdout).not.toMatch(
      /--(?:sign|approve|active|policy)(?:\s|$)/u,
    );
  });

  it('creates and inspects a content-free canonical private Statement without clobbering', async () => {
    const paths = await writeAdmissionEvidence();
    const statementPath = join(paths.root, 'admission.statement.json');
    process.env[CACHE_KEY_SECRET_ENV] = CACHE_KEY_SECRET;

    const created = await invoke(
      'intent',
      'admission',
      'create',
      ...evidenceArguments(paths),
      '--statement-out',
      statementPath,
      '--json',
    );
    expect(created).toMatchObject({ code: 0, stderr: '' });
    const creationReceipt = expectContentFreeReceipt(created, [
      'schema',
      'kind',
      'created',
      'authentication',
      'mode',
      'activationCeiling',
      'servingAuthority',
      'canonicalProfileDigest',
      'payloadDigest',
      'statementPassportPayloadDigest',
      'statementWitnessPayloadDigest',
    ]);
    expect(creationReceipt).toMatchObject({
      schema:
        'semwitness.dev/intent-cache-admission-decision-creation/v1alpha1',
      kind: 'creation-only',
      created: true,
      authentication: 'none',
      mode: 'shadow',
      activationCeiling: 'shadow-only',
      servingAuthority: 'none',
    });

    const statementBytes = await readFile(statementPath);
    const statementSource = statementBytes.toString('utf8');
    expect(statementSource.endsWith('\n')).toBe(false);
    expect(
      serializeIntentCacheAdmissionDecisionStatement(
        parseIntentCacheAdmissionDecisionStatement(statementSource),
      ),
    ).toBe(statementSource);
    expect(creationReceipt.canonicalProfileDigest).toBe(
      sha256(statementSource),
    );
    expect(creationReceipt.payloadDigest).toBe(
      creationReceipt.canonicalProfileDigest,
    );
    if (process.platform !== 'win32') {
      expect((await stat(statementPath)).mode & 0o777).toBe(0o600);
    }

    const inspected = await invoke(
      'intent',
      'admission',
      'inspect',
      ...evidenceArguments(paths),
      '--statement',
      statementPath,
      '--json',
    );
    expect(inspected).toMatchObject({ code: 0, stderr: '' });
    const inspectionReceipt = expectContentFreeReceipt(inspected, [
      'schema',
      'kind',
      'authentication',
      'mode',
      'activationCeiling',
      'bound',
      'profileBound',
      'extensionsPresent',
      'canonicalProfileDigest',
      'payloadDigest',
      'canonicalPayload',
      'statementPassportPayloadDigest',
      'suppliedPassportPayloadDigest',
      'statementWitnessPayloadDigest',
      'suppliedWitnessPayloadDigest',
      'servingAuthority',
    ]);
    expect(inspectionReceipt).toMatchObject({
      schema:
        'semwitness.dev/intent-cache-admission-decision-binding-verification/v1alpha1',
      kind: 'binding-only',
      authentication: 'none',
      mode: 'shadow',
      activationCeiling: 'shadow-only',
      bound: true,
      profileBound: true,
      extensionsPresent: false,
      canonicalPayload: true,
      servingAuthority: 'none',
    });

    const refused = await invoke(
      'intent',
      'admission',
      'create',
      ...evidenceArguments(paths),
      '--statement-out',
      statementPath,
      '--json',
    );
    expectCliError(refused, 'CAS_WRITE_FAILED');
    expect(await readFile(statementPath)).toEqual(statementBytes);
  });

  it('returns exit two for a well-formed mismatch and noncanonical exact bytes', async () => {
    const paths = await writeAdmissionEvidence();
    const statementPath = join(paths.root, 'admission.statement.json');
    process.env[CACHE_KEY_SECRET_ENV] = CACHE_KEY_SECRET;
    expect(
      (
        await invoke(
          'intent',
          'admission',
          'create',
          ...evidenceArguments(paths),
          '--statement-out',
          statementPath,
          '--json',
        )
      ).code,
    ).toBe(0);
    const canonical = await readFile(statementPath, 'utf8');

    const changed = JSON.parse(canonical) as any;
    changed.predicate.candidate.valueCommitment = `hmac-sha256:cache-value:${'9'.repeat(64)}`;
    const mismatchPath = join(paths.root, 'mismatch.statement.json');
    await writeFile(
      mismatchPath,
      serializeIntentCacheAdmissionDecisionStatement(changed),
    );
    const mismatch = await invoke(
      'intent',
      'admission',
      'inspect',
      ...evidenceArguments(paths),
      '--statement',
      mismatchPath,
      '--json',
    );
    expect(mismatch).toMatchObject({ code: 2, stderr: '' });
    expect(parseReceipt(mismatch.stdout)).toMatchObject({
      bound: false,
      profileBound: false,
      extensionsPresent: false,
      canonicalPayload: true,
      servingAuthority: 'none',
    });

    const noncanonicalPath = join(paths.root, 'noncanonical.statement.json');
    await writeFile(noncanonicalPath, `${canonical}\n`);
    const noncanonical = await invoke(
      'intent',
      'admission',
      'inspect',
      ...evidenceArguments(paths),
      '--statement',
      noncanonicalPath,
      '--json',
    );
    expect(noncanonical).toMatchObject({ code: 2, stderr: '' });
    expect(parseReceipt(noncanonical.stdout)).toMatchObject({
      bound: false,
      profileBound: true,
      extensionsPresent: false,
      canonicalPayload: false,
      servingAuthority: 'none',
    });
  });

  it('returns exit one when the HMAC secret is missing or invalid', async () => {
    const paths = await writeAdmissionEvidence();

    const missingPath = join(paths.root, 'missing-secret.statement.json');
    const missing = await invoke(
      'intent',
      'admission',
      'create',
      ...evidenceArguments(paths),
      '--statement-out',
      missingPath,
      '--json',
    );
    expectCliError(missing, 'MALFORMED_ENVELOPE');
    await expectMissing(missingPath);

    const invalidRefPath = join(paths.root, 'invalid-ref.statement.json');
    const invalidRef = await invoke(
      'intent',
      'admission',
      'create',
      ...evidenceArguments(paths, {}, 'ADMISSION_SECRET'),
      '--statement-out',
      invalidRefPath,
      '--json',
    );
    expectCliError(invalidRef, 'MALFORMED_ENVELOPE');
    await expectMissing(invalidRefPath);

    process.env[CACHE_KEY_SECRET_ENV] = 'x'.repeat(4 * 1024 + 1);
    const oversizedPath = join(paths.root, 'oversized-secret.statement.json');
    const oversized = await invoke(
      'intent',
      'admission',
      'create',
      ...evidenceArguments(paths),
      '--statement-out',
      oversizedPath,
      '--json',
    );
    expectCliError(oversized, 'MALFORMED_ENVELOPE');
    await expectMissing(oversizedPath);
  });

  it('returns exit one for malformed or symlinked evidence inputs', async () => {
    process.env[CACHE_KEY_SECRET_ENV] = CACHE_KEY_SECRET;
    const malformedPaths = await writeAdmissionEvidence();
    const malformedStatement = join(
      malformedPaths.root,
      'malformed.statement.json',
    );
    await writeFile(malformedPaths.normalizationWitness, '{');
    const malformed = await invoke(
      'intent',
      'admission',
      'create',
      ...evidenceArguments(malformedPaths),
      '--statement-out',
      malformedStatement,
      '--json',
    );
    expectCliError(malformed, 'FORMAT_UNSUPPORTED');
    await expectMissing(malformedStatement);

    if (process.platform !== 'win32') {
      const symlinkPaths = await writeAdmissionEvidence();
      const passportLink = join(symlinkPaths.root, 'passport-link.json');
      const symlinkStatement = join(
        symlinkPaths.root,
        'symlink.statement.json',
      );
      await symlink(symlinkPaths.passport, passportLink);
      const linked = await invoke(
        'intent',
        'admission',
        'create',
        ...evidenceArguments(symlinkPaths, { passport: passportLink }),
        '--statement-out',
        symlinkStatement,
        '--json',
      );
      expectCliError(linked, 'MALFORMED_ENVELOPE');
      await expectMissing(symlinkStatement);
    }
  });
});
