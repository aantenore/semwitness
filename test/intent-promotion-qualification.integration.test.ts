import { Buffer } from 'node:buffer';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { runCli } from '../src/entrypoints/cli.js';
import {
  evaluateIntentCachePromotionEvidence,
  parseIntentCacheShadowQualificationManifest,
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
    expect(written).not.toContain('cases');
    expect(qualified.stdout).not.toContain('normalizationWitness');
    expect(qualified.stdout).not.toContain('cacheHitWitness');

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
