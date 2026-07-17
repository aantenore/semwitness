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

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { runCli } from '../src/entrypoints/cli.js';
import { sha256 } from '../src/domain/hash.js';
import {
  evaluateIntentCachePromotionEvidence,
  digestIntentCacheAdmissionPassportCanonicalProfile,
  digestIntentCacheShadowQualificationManifest,
  parseIntentCacheAdmissionPassportStatement,
  parseIntentCacheShadowQualificationManifest,
  serializeIntentCacheShadowQualificationManifest,
  verifyIntentCacheAdmissionPassportStatementBinding,
  type IntentCachePromotionEvidenceFixture,
} from '../src/intent-host/index.js';
import { createQualifyingIntentPromotionFixture } from './support/intent-promotion-qualification-fixture.js';

interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

let temporaryRoot: string;
let evidencePath: string;

function serializeFixture(
  fixture: IntentCachePromotionEvidenceFixture,
): string {
  return `${[fixture.binding, ...fixture.cases]
    .map((record) => JSON.stringify(record))
    .join('\n')}\n`;
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

beforeAll(async () => {
  temporaryRoot = await mkdtemp(
    join(tmpdir(), 'semwitness-intent-promotion-qualification-'),
  );
  evidencePath = join(temporaryRoot, 'qualifying.jsonl');
  const fixture = createQualifyingIntentPromotionFixture();
  await writeFile(evidencePath, serializeFixture(fixture));
}, 90_000);

afterAll(async () => {
  vi.restoreAllMocks();
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe.sequential('intent-cache promotion qualification integration', () => {
  it('qualifies the complete serialized evidence through the public byte boundary', async () => {
    const result = evaluateIntentCachePromotionEvidence(
      await readFile(evidencePath),
    );

    expect(result.qualified).toBe(true);
    if (!result.qualified) throw new TypeError('Expected qualification');
    expect(result.report.gateReasons).toEqual([]);
    expect(result.report.population).toMatchObject({
      attempted: 5_998,
      emitted: 5_998,
      complete: 5_998,
      failed: 0,
      normalizedIntentWouldHits: 3_003,
      bypasses: 2_995,
    });
    expect(result.report.adversarial).toMatchObject({
      expected: 360,
      emitted: 360,
      complete: 360,
      failed: 0,
    });
    expect(result.report.adversarial.phenomenonCoverage.missing).toEqual([]);
    expect(result.report.operationCoverage).toMatchObject({
      safeNormalizedIntentWouldHits: 3_003,
      oraclePermittedEquivalentOpportunities: 3_003,
      observedCoveragePpm: 1_000_000,
    });
    expect(result.report.statisticalClaims.falseDiscoveryRate).toMatchObject({
      failures: 0,
      trials: 3_003,
      upperBound95Ppm: 998,
    });
    expect(result.report.statisticalClaims.unsafeAdmissionRate).toMatchObject({
      failures: 0,
      trials: 2_995,
      upperBound95Ppm: 1_000,
    });
    expect(
      parseIntentCacheShadowQualificationManifest(result.qualification),
    ).toEqual(result.qualification);
  }, 90_000);

  it('writes the qualified shadow manifest through the real CLI', async () => {
    const manifestPath = join(temporaryRoot, 'qualification.json');
    const qualified = await invoke(
      'intent',
      'promotion',
      'evaluate',
      '--evidence',
      evidencePath,
      '--manifest-out',
      manifestPath,
      '--json',
    );

    expect(qualified.code).toBe(0);
    expect(qualified.stderr).toBe('');
    const result = JSON.parse(qualified.stdout) as {
      readonly qualified: boolean;
      readonly qualification: unknown;
    };
    expect(result.qualified).toBe(true);
    const written = await readFile(manifestPath, 'utf8');
    expect(
      parseIntentCacheShadowQualificationManifest(JSON.parse(written)),
    ).toEqual(result.qualification);
    expect(written).toBe(
      serializeIntentCacheShadowQualificationManifest(result.qualification),
    );
    expect(written.endsWith('\n')).toBe(false);
    expect(sha256(written)).toBe(
      digestIntentCacheShadowQualificationManifest(result.qualification),
    );
    expect(written).not.toContain('cases');
    expect(qualified.stdout).not.toContain('normalizationWitness');
    expect(qualified.stdout).not.toContain('cacheHitWitness');

    const statementPath = join(temporaryRoot, 'passport.statement.json');
    const created = await invoke(
      'intent',
      'passport',
      'create',
      '--qualification',
      manifestPath,
      '--statement-out',
      statementPath,
      '--json',
    );
    expect(created).toMatchObject({ code: 0, stderr: '' });
    const statementBytes = await readFile(statementPath);
    const statementText = statementBytes.toString('utf8');
    const statement =
      parseIntentCacheAdmissionPassportStatement(statementBytes);
    const creationReceipt = JSON.parse(created.stdout) as Record<
      string,
      unknown
    >;
    expect(creationReceipt).toMatchObject({
      schema:
        'semwitness.dev/intent-cache-admission-passport-creation/v1alpha1',
      kind: 'creation-only',
      created: true,
      authentication: 'none',
      activationCeiling: 'shadow-only',
      canonicalProfileDigest:
        digestIntentCacheAdmissionPassportCanonicalProfile(statement),
      payloadDigest: sha256(statementBytes),
      statementQualificationDigest: sha256(written),
    });
    expect(creationReceipt).not.toHaveProperty('predicate');
    expect(creationReceipt).not.toHaveProperty('subject');
    expect(statementText.endsWith('\n')).toBe(false);
    expect(statementText).toBe(JSON.stringify(JSON.parse(statementText)));
    expect(`sha256:${statement.subject[0].digest.sha256}`).toBe(
      sha256(written),
    );
    if (process.platform !== 'win32') {
      expect((await stat(statementPath)).mode & 0o777).toBe(0o600);
    }
    expect(statementText).not.toContain('normalizationWitness');
    expect(statementText).not.toContain('cacheHitWitness');
    expect(statementText).not.toContain('safe-lookup');

    const inspected = await invoke(
      'intent',
      'passport',
      'inspect',
      '--statement',
      statementPath,
      '--qualification',
      manifestPath,
      '--json',
    );
    expect(inspected).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(inspected.stdout)).toMatchObject({
      schema:
        'semwitness.dev/intent-cache-admission-passport-binding-verification/v1alpha1',
      kind: 'binding-only',
      authentication: 'none',
      activationCeiling: 'shadow-only',
      bound: true,
      extensionsPresent: false,
      canonicalProfileDigest:
        digestIntentCacheAdmissionPassportCanonicalProfile(statement),
      payloadDigest: sha256(statementBytes),
      canonicalPayload: true,
    });
    expect(
      verifyIntentCacheAdmissionPassportStatementBinding(
        statement,
        JSON.parse(written),
      ).bound,
    ).toBe(true);

    const nonCanonicalStatementPath = join(
      temporaryRoot,
      'noncanonical-passport.statement.json',
    );
    await writeFile(nonCanonicalStatementPath, `${statementText}\n`);
    const nonCanonical = await invoke(
      'intent',
      'passport',
      'inspect',
      '--statement',
      nonCanonicalStatementPath,
      '--qualification',
      manifestPath,
      '--json',
    );
    expect(nonCanonical).toMatchObject({ code: 2, stderr: '' });
    expect(JSON.parse(nonCanonical.stdout)).toMatchObject({
      bound: false,
      extensionsPresent: false,
      canonicalPayload: false,
    });

    const differentQualification = JSON.parse(written) as Record<
      string,
      unknown
    >;
    differentQualification.deploymentScopeDigest = sha256(
      'different-deployment-scope',
    );
    const differentQualificationPath = join(
      temporaryRoot,
      'different-qualification.json',
    );
    await writeFile(
      differentQualificationPath,
      serializeIntentCacheShadowQualificationManifest(differentQualification),
    );
    const mismatch = await invoke(
      'intent',
      'passport',
      'inspect',
      '--statement',
      statementPath,
      '--qualification',
      differentQualificationPath,
      '--json',
    );
    expect(mismatch).toMatchObject({ code: 2, stderr: '' });
    expect(JSON.parse(mismatch.stdout)).toMatchObject({ bound: false });

    const refusedStatement = await invoke(
      'intent',
      'passport',
      'create',
      '--qualification',
      manifestPath,
      '--statement-out',
      statementPath,
      '--json',
    );
    expect(refusedStatement.code).toBe(1);
    expect(refusedStatement.stdout).toBe('');
    expect(JSON.parse(refusedStatement.stderr)).toMatchObject({
      ok: false,
      error: { reason: 'CAS_WRITE_FAILED' },
    });
    expect((await readFile(statementPath)).toString('utf8')).toBe(
      statementText,
    );

    if (process.platform !== 'win32') {
      const linkPath = join(temporaryRoot, 'passport-link.json');
      await symlink(statementPath, linkPath);
      const refusedLink = await invoke(
        'intent',
        'passport',
        'create',
        '--qualification',
        manifestPath,
        '--statement-out',
        linkPath,
        '--json',
      );
      expect(refusedLink.code).toBe(1);
      expect(refusedLink.stdout).toBe('');
      expect(JSON.parse(refusedLink.stderr)).toMatchObject({
        ok: false,
        error: { reason: 'CAS_WRITE_FAILED' },
      });
    }

    const refused = await invoke(
      'intent',
      'promotion',
      'evaluate',
      '--evidence',
      evidencePath,
      '--manifest-out',
      manifestPath,
      '--json',
    );

    expect(refused.code).toBe(1);
    expect(refused.stdout).toBe('');
    expect(JSON.parse(refused.stderr)).toMatchObject({
      ok: false,
      error: { reason: 'CAS_WRITE_FAILED' },
    });
    expect(await readFile(manifestPath, 'utf8')).toBe(written);
  }, 90_000);
});
