import { Buffer } from 'node:buffer';
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalJson, toJsonValue } from '../src/domain/canonical-json.js';
import { hashCanonical } from '../src/domain/hash.js';
import {
  parseSimulationBundle,
  type SimulationBundle,
} from '../src/entrypoints/bundle.js';
import { runCli } from '../src/entrypoints/cli.js';

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
