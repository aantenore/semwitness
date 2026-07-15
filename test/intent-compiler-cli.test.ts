import { Buffer } from 'node:buffer';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { sha256 } from '../src/domain/hash.js';
import { runCli } from '../src/entrypoints/cli.js';
import {
  INTENT_EVALUATION_FIXTURE_SCHEMA,
  INTENT_OPERATION_REGISTRY_SCHEMA,
  INTENT_SCHEMA,
} from '../src/intent/index.js';

interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface IntentCliFixture {
  readonly root: string;
  readonly normalizerPath: string;
  readonly fixturePath: string;
  readonly compilerPath: string;
  readonly source: string;
  readonly privateObject: string;
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

function compilerBinding(): Record<string, unknown> {
  return {
    schema: 'semwitness.dev/intent-compiler-binding/v1',
    adapter: 'openai-compatible',
    config: {
      provider: {
        name: 'cli-mock-provider',
        baseUrl: 'https://provider.invalid/v1',
        model: 'intent-model',
      },
      policy: {
        requestTimeoutMs: 1_000,
        maxResponseBytes: 4_096,
        maxOutputTokens: 64,
        maxPromptBytes: 16_384,
      },
    },
  };
}

async function createIntentCliFixture(): Promise<IntentCliFixture> {
  const root = await mkdtemp(join(tmpdir(), 'semwitness-intent-cli-test-'));
  temporaryRoots.add(root);
  const normalizerPath = join(root, 'normalizer.json');
  const fixturePath = join(root, 'fixture.jsonl');
  const compilerPath = join(root, 'compiler.json');
  const source = 'CLI_NETWORK_SOURCE_SENTINEL_45bd11';
  const privateObject = 'private-network-runtime';
  const ontology = {
    id: 'cli-network-intents',
    version: '1.0.0',
    digest: sha256('cli-network-intents-v1'),
  };
  const intent = {
    schema: INTENT_SCHEMA,
    ontology,
    goal: {
      namespace: 'knowledge',
      action: 'explain',
      object: privateObject,
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
      minimumConfidencePpm: 900_000,
      operations: [
        {
          id: 'explain-runtime',
          aliases: [{ locale: 'it-IT', text: source }],
          intent,
        },
      ],
    }),
  );
  await writeFile(
    fixturePath,
    `${[
      {
        schema: INTENT_EVALUATION_FIXTURE_SCHEMA,
        kind: 'case',
        id: 'network-case',
        familyId: 'network-family',
        split: 'conformance',
        difficulty: 'simple',
        phenomena: ['paraphrase'],
        input: { source, locale: 'it-IT' },
        expect: { kind: 'intent', intent },
      },
      {
        schema: INTENT_EVALUATION_FIXTURE_SCHEMA,
        kind: 'case',
        id: 'held-out-case',
        familyId: 'held-out-family',
        split: 'held-out',
        difficulty: 'adversarial',
        phenomena: ['prompt-injection'],
        input: {
          source: 'Held-out case must not consume budget',
          locale: 'en-US',
        },
        expect: { kind: 'bypass' },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join('\n')}\n`,
  );
  await writeFile(compilerPath, JSON.stringify(compilerBinding()));
  return {
    root,
    normalizerPath,
    fixturePath,
    compilerPath,
    source,
    privateObject,
  };
}

function networkArguments(fixture: IntentCliFixture): readonly string[] {
  return [
    'intent',
    'evaluate',
    '--normalizer',
    fixture.normalizerPath,
    '--fixture',
    fixture.fixturePath,
    '--compiler-config',
    fixture.compilerPath,
    '--runs',
    '2',
  ];
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

describe('CLI OpenAI-compatible intent compiler binding', () => {
  it('refuses either half of the network capability pair before any request', async () => {
    const fixture = await createIntentCliFixture();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('network must not run'));

    const missingOptIn = await invoke(...networkArguments(fixture));
    expect(missingOptIn.code).toBe(1);
    expect(missingOptIn.stdout).toBe('');
    expect(JSON.parse(missingOptIn.stderr)).toMatchObject({
      ok: false,
      error: { reason: 'MALFORMED_ENVELOPE' },
    });

    const configlessOptIn = await invoke(
      'intent',
      'evaluate',
      '--normalizer',
      fixture.normalizerPath,
      '--fixture',
      fixture.fixturePath,
      '--allow-network',
    );
    expect(configlessOptIn.code).toBe(1);
    expect(configlessOptIn.stdout).toBe('');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects an over-budget selected split before constructing or calling the network compiler', async () => {
    const fixture = await createIntentCliFixture();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('network must not run'));

    const result = await invoke(
      ...networkArguments(fixture),
      '--allow-network',
      '--max-requests',
      '1',
    );

    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      error: { reason: 'MALFORMED_ENVELOPE' },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('runs the selected case exactly once per run through a mocked provider', async () => {
    const fixture = await createIntentCliFixture();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () =>
        Response.json({
          choices: [
            {
              message: {
                role: 'assistant',
                content: JSON.stringify({
                  noMatch: false,
                  operationId: 'explain-runtime',
                  confidencePpm: 975_000,
                  ambiguous: false,
                }),
              },
              finish_reason: 'stop',
            },
          ],
        }),
      );

    const result = await invoke(
      ...networkArguments(fixture),
      '--allow-network',
      '--max-requests',
      '2',
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schema: 'semwitness.dev/intent-normalizer-eval-report/v1alpha1',
      mode: 'shadow',
      activeCacheQualified: false,
      attemptsPerCase: 2,
      caseMetrics: {
        total: 1,
        passed: 1,
        executionFailures: 0,
      },
      gate: { passed: true, reasons: [] },
    });
    expect(result.stdout).not.toContain(fixture.source);
    expect(result.stdout).not.toContain(fixture.privateObject);
  });

  it('rejects duplicate keys, unknown adapters and secret-valued fields without leakage', async () => {
    const fixture = await createIntentCliFixture();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('network must not run'));
    const valid = JSON.stringify(compilerBinding());
    const secret = 'CLI_COMPILER_SECRET_SENTINEL_81bdfa';
    const invalidBindings = [
      valid.replace(
        '"adapter":"openai-compatible"',
        '"adapter":"openai-compatible","adapter":"openai-compatible"',
      ),
      JSON.stringify({ ...compilerBinding(), adapter: 'shell-command' }),
      JSON.stringify({
        ...compilerBinding(),
        config: {
          ...(compilerBinding().config as Record<string, unknown>),
          provider: {
            ...((compilerBinding().config as Record<string, unknown>)
              .provider as Record<string, unknown>),
            apiKey: secret,
          },
        },
      }),
    ];

    for (const binding of invalidBindings) {
      await writeFile(fixture.compilerPath, binding);
      const result = await invoke(
        ...networkArguments(fixture),
        '--allow-network',
        '--max-requests',
        '2',
      );
      expect(result.code).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).not.toContain(secret);
      expect(JSON.parse(result.stderr)).toMatchObject({ ok: false });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
