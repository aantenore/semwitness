import { Buffer } from 'node:buffer';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runCli } from '../src/entrypoints/cli.js';
import {
  parseIntentCacheShadowQualificationManifest,
  serializeIntentCacheShadowQualificationManifest,
  type IntentCachePromotionEvidenceFixture,
} from '../src/intent-host/index.js';
import { createEmptyIntentPromotionFixture } from './support/intent-promotion-qualification-fixture.js';

interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const temporaryRoots = new Set<string>();

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
    join(tmpdir(), 'semwitness-intent-promotion-cli-'),
  );
  temporaryRoots.add(root);
  return root;
}

function serializeFixture(
  fixture: IntentCachePromotionEvidenceFixture,
): string {
  return `${[fixture.binding, ...fixture.cases]
    .map((record) => JSON.stringify(record))
    .join('\n')}\n`;
}

async function expectMissing(path: string): Promise<void> {
  await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
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

describe('CLI intent-cache promotion workbench', () => {
  it('documents the isolated policy-free command boundary', async () => {
    const result = await invoke('intent', 'promotion', 'evaluate', '--help');

    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(result.stdout).toContain(
      'semwitness intent promotion evaluate [options]',
    );
    expect(result.stdout).toContain('--evidence <file>');
    expect(result.stdout).toContain('--manifest-out <file>');
    expect(result.stdout).toContain('--json');
    expect(result.stdout).not.toContain('--policy');
  });

  it('returns exit one for malformed bytes and never creates a manifest', async () => {
    const root = await temporaryRoot();
    const evidencePath = join(root, 'malformed.jsonl');
    const manifestPath = join(root, 'qualification.json');
    await writeFile(evidencePath, '{"kind":"binding"}\n');

    const result = await invoke(
      'intent',
      'promotion',
      'evaluate',
      '--evidence',
      evidencePath,
      '--manifest-out',
      manifestPath,
      '--json',
    );

    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toMatchObject({
      schema: 'semwitness.dev/cli-error/v1alpha1',
      ok: false,
      error: { reason: 'MALFORMED_ENVELOPE' },
    });
    await expectMissing(manifestPath);
  });

  it('returns exit two for well-formed gate failure and never creates a manifest', async () => {
    const root = await temporaryRoot();
    const evidencePath = join(root, 'unqualified.jsonl');
    const manifestPath = join(root, 'qualification.json');
    await writeFile(
      evidencePath,
      serializeFixture(createEmptyIntentPromotionFixture()),
    );

    const result = await invoke(
      'intent',
      'promotion',
      'evaluate',
      '--evidence',
      evidencePath,
      '--manifest-out',
      manifestPath,
      '--json',
    );

    expect(result.code).toBe(2);
    expect(result.stderr).toBe('');
    const workbench = JSON.parse(result.stdout) as {
      readonly qualified: boolean;
      readonly report: { readonly gateReasons: readonly string[] };
    };
    expect(workbench).toMatchObject({
      schema: 'semwitness.dev/intent-cache-promotion-workbench-result/v1alpha1',
      qualified: false,
    });
    expect(workbench.report.gateReasons.length).toBeGreaterThan(0);
    expect(workbench).not.toHaveProperty('qualification');
    await expectMissing(manifestPath);
  });

  it('documents Passport Statement creation and binding inspection only', async () => {
    const create = await invoke('intent', 'passport', 'create', '--help');
    expect(create).toMatchObject({ code: 0, stderr: '' });
    expect(create.stdout).toContain(
      'semwitness intent passport create [options]',
    );
    expect(create.stdout).toContain('--qualification <file>');
    expect(create.stdout).toContain('--statement-out <file>');
    expect(create.stdout).not.toMatch(/--(?:key|sign|approve|policy)/u);

    const inspect = await invoke('intent', 'passport', 'inspect', '--help');
    expect(inspect).toMatchObject({ code: 0, stderr: '' });
    expect(inspect.stdout).toContain(
      'semwitness intent passport inspect [options]',
    );
    expect(inspect.stdout).toContain('--statement <file>');
    expect(inspect.stdout).toContain('--qualification <file>');
    expect(inspect.stdout).not.toMatch(/--(?:key|sign|approve|policy)/u);
  });

  it('rejects malformed qualification bytes without creating a Statement', async () => {
    const root = await temporaryRoot();
    const qualificationPath = join(root, 'malformed-qualification.json');
    const statementPath = join(root, 'passport.statement.json');
    await writeFile(qualificationPath, '{"schema":"wrong"}\n');

    const result = await invoke(
      'intent',
      'passport',
      'create',
      '--qualification',
      qualificationPath,
      '--statement-out',
      statementPath,
      '--json',
    );

    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toMatchObject({
      schema: 'semwitness.dev/cli-error/v1alpha1',
      ok: false,
      error: { reason: 'MALFORMED_ENVELOPE' },
    });
    await expectMissing(statementPath);
  });

  it('rejects a valid qualification that is not the exact canonical artifact', async () => {
    const root = await temporaryRoot();
    const qualificationPath = join(root, 'formatted-qualification.json');
    const statementPath = join(root, 'passport.statement.json');
    const fixture = await readFile(
      new URL(
        './fixtures/intent-cache-shadow-qualification.json',
        import.meta.url,
      ),
      'utf8',
    );
    await writeFile(qualificationPath, `${fixture.trim()}\n`);

    const result = await invoke(
      'intent',
      'passport',
      'create',
      '--qualification',
      qualificationPath,
      '--statement-out',
      statementPath,
      '--json',
    );

    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: { reason: 'MALFORMED_ENVELOPE' },
    });
    await expectMissing(statementPath);
  });

  it('rejects a BOM-prefixed canonical qualification without creating a Statement', async () => {
    const root = await temporaryRoot();
    const qualificationPath = join(root, 'bom-qualification.json');
    const statementPath = join(root, 'passport.statement.json');
    const fixture = JSON.parse(
      await readFile(
        new URL(
          './fixtures/intent-cache-shadow-qualification.json',
          import.meta.url,
        ),
        'utf8',
      ),
    ) as unknown;
    const canonical = serializeIntentCacheShadowQualificationManifest(
      parseIntentCacheShadowQualificationManifest(fixture),
    );
    await writeFile(
      qualificationPath,
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from(canonical, 'utf8'),
      ]),
    );

    const result = await invoke(
      'intent',
      'passport',
      'create',
      '--qualification',
      qualificationPath,
      '--statement-out',
      statementPath,
      '--json',
    );

    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: { reason: 'MALFORMED_ENVELOPE' },
    });
    await expectMissing(statementPath);
  });
});
