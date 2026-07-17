import { Buffer } from 'node:buffer';
import {
  access,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runCli } from '../src/entrypoints/cli.js';
import { parseCompactResponseWitness } from '../src/response/index.js';

const contractUrl = new URL(
  '../examples/compact-response/change-report.contract.json',
  import.meta.url,
);
const candidateUrl = new URL(
  '../examples/compact-response/change-report.candidate.json',
  import.meta.url,
);
const temporaryRoots = new Set<string>();

interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'semwitness-response-cli-'));
  temporaryRoots.add(root);
  return root;
}

function capture(target: { value: string }): typeof process.stdout.write {
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
    .mockImplementation(capture(stdout));
  const stderrSpy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation(capture(stderr));
  try {
    const code = await runCli(['node', 'semwitness', ...arguments_]);
    return { code, stdout: stdout.value, stderr: stderr.value };
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }
}

async function copyFixture(root: string) {
  const contract = join(root, 'contract.json');
  const candidate = join(root, 'candidate.json');
  await Promise.all([
    writeFile(contract, await readFile(contractUrl)),
    writeFile(candidate, await readFile(candidateUrl)),
  ]);
  return { contract, candidate };
}

afterEach(async () => {
  await Promise.all(
    [...temporaryRoots].map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
  temporaryRoots.clear();
});

describe('compact response CLI', () => {
  it('inspects the checked-in contract without exposing payload content', async () => {
    const root = await temporaryRoot();
    const { contract } = await copyFixture(root);
    const result = await invoke(
      'response',
      'contract',
      'inspect',
      '--contract',
      contract,
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({
      schema: 'semwitness.dev/compact-response-contract-inspection/v1alpha1',
      valid: true,
      rendererAvailable: true,
      billedOutputSavings: null,
      universalSemanticEquivalence: false,
    });
    expect(result.stdout).not.toContain('Implemented proof-bound');
  });

  it('renders one private no-clobber output and emits an exact witness', async () => {
    const root = await temporaryRoot();
    const { contract, candidate } = await copyFixture(root);
    const output = join(root, 'report.md');
    const result = await invoke(
      'response',
      'render',
      '--contract',
      contract,
      '--candidate',
      candidate,
      '--out',
      output,
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.endsWith('\n')).toBe(false);
    expect(parseCompactResponseWitness(result.stdout).decision).toBe(
      'rendered',
    );
    expect(await readFile(output, 'utf8')).toContain('# Change report');
    if (process.platform !== 'win32') {
      expect((await stat(output)).mode & 0o777).toBe(0o600);
    }
    expect(result.stdout).not.toContain('Implemented proof-bound');
  });

  it('returns exit two and writes nothing for a rejected candidate', async () => {
    const root = await temporaryRoot();
    const { contract, candidate } = await copyFixture(root);
    const output = join(root, 'rejected.md');
    await writeFile(
      candidate,
      '{"s":"ok","m":"PRIVATE_SENTINEL","c":[],"v":[],"w":[],"extra":true}',
    );
    const result = await invoke(
      'response',
      'render',
      '--contract',
      contract,
      '--candidate',
      candidate,
      '--out',
      output,
    );

    expect(result.code).toBe(2);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      schema: 'semwitness.dev/compact-response-render-result/v1alpha1',
      status: 'retry-required',
      reasons: ['CANDIDATE_SCHEMA_MISMATCH'],
      outputWritten: false,
      billedOutputSavings: null,
    });
    expect(result.stdout).not.toContain('PRIVATE_SENTINEL');
    await expect(access(output)).rejects.toBeDefined();
  });

  it('verifies and replays exact artifacts, then detects output tampering', async () => {
    const root = await temporaryRoot();
    const { contract, candidate } = await copyFixture(root);
    const output = join(root, 'report.md');
    const witness = join(root, 'witness.json');
    const rendered = await invoke(
      'response',
      'render',
      '--contract',
      contract,
      '--candidate',
      candidate,
      '--out',
      output,
    );
    expect(rendered.code).toBe(0);
    await writeFile(witness, rendered.stdout);

    const verified = await invoke(
      'response',
      'verify',
      '--contract',
      contract,
      '--candidate',
      candidate,
      '--rendered',
      output,
      '--witness',
      witness,
    );
    expect(verified.code).toBe(0);
    expect(JSON.parse(verified.stdout)).toMatchObject({
      bound: true,
      reasons: [],
      authentication: 'none',
      servingAuthority: 'none',
    });

    const replayed = await invoke(
      'response',
      'replay',
      '--contract',
      contract,
      '--candidate',
      candidate,
      '--witness',
      witness,
    );
    expect(replayed.code).toBe(0);
    expect(JSON.parse(replayed.stdout).bound).toBe(true);

    await writeFile(output, 'tampered output');
    const mismatch = await invoke(
      'response',
      'verify',
      '--contract',
      contract,
      '--candidate',
      candidate,
      '--rendered',
      output,
      '--witness',
      witness,
    );
    expect(mismatch.code).toBe(2);
    expect(JSON.parse(mismatch.stdout)).toMatchObject({
      bound: false,
      reasons: ['WITNESS_MISMATCH'],
    });
  });

  it('refuses to overwrite an existing output', async () => {
    const root = await temporaryRoot();
    const { contract, candidate } = await copyFixture(root);
    const output = join(root, 'existing.md');
    await writeFile(output, 'keep me');
    const result = await invoke(
      'response',
      'render',
      '--contract',
      contract,
      '--candidate',
      candidate,
      '--out',
      output,
    );

    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      error: { reason: 'CAS_WRITE_FAILED' },
    });
    expect(await readFile(output, 'utf8')).toBe('keep me');
  });
});
