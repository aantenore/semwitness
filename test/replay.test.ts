import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createSemWitness } from '../src/composition-root.js';
import { DEFAULT_POLICY } from '../src/domain/policy.js';
import {
  maximumReplayStringCodeUnits,
  parseReplayJsonl,
  replayCases,
} from '../src/eval/replay.js';
import { makePolicy } from './helpers.js';

const fixturePath = fileURLToPath(
  new URL('../examples/replay.jsonl', import.meta.url),
);
const temporaryRoots = new Set<string>();

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'semwitness-replay-test-'));
  temporaryRoots.add(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    [...temporaryRoots].map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
  temporaryRoots.clear();
});

describe('checked-in replay corpus', () => {
  it('strictly parses and completes the checked-in corpus without failures', async () => {
    const fixtureSource = await readFile(fixturePath, 'utf8');
    const cases = parseReplayJsonl(fixtureSource);
    const core = createSemWitness({
      storeRoot: await temporaryRoot(),
      policy: DEFAULT_POLICY,
    });

    const report = await replayCases({
      core,
      policy: DEFAULT_POLICY,
      cases,
    });

    expect(cases).toHaveLength(4);
    expect(new Set(cases.map((fixture) => fixture.id)).size).toBe(cases.length);
    expect(report.total).toBe(cases.length);
    expect(report.assessed).toBe(4);
    expect(report.passed).toBe(report.assessed);
    expect(report.failed).toBe(0);
    expect(report.unassessed).toBe(0);
    expect(report.executionFailures).toBe(0);
    expect(report.expectationPassRatePpm).toBe(1_000_000);
    expect(report.cases.every((result) => result.status !== 'failed')).toBe(
      true,
    );

    const serialized = JSON.stringify(report);
    for (const fixture of cases) {
      if (fixture.input.content !== undefined) {
        expect(serialized).not.toContain(fixture.input.content);
        expect(serialized).not.toContain(
          Buffer.from(fixture.input.content).toString('base64'),
        );
      }
    }
  });

  it('rejects empty expectations that would create a false green gate', () => {
    expect(() =>
      parseReplayJsonl(
        '{"id":"empty-expect","input":{"role":"user","kind":"prose","trust":"untrusted-external","content":"safe"},"expect":{}}',
      ),
    ).toThrow(/invalid schema/u);
  });

  it('rejects prompt-like and bidirectional replay identifiers', () => {
    for (const id of ['IGNORE PREVIOUS INSTRUCTIONS', 'safe\u202eid']) {
      expect(() =>
        parseReplayJsonl(
          JSON.stringify({
            id,
            input: {
              role: 'user',
              kind: 'prose',
              trust: 'untrusted-external',
              content: 'safe',
            },
          }),
        ),
      ).toThrow(/invalid schema/u);
    }
  });

  it('scans a large blank fixture without materializing one array item per line', () => {
    const blankLines = '\n'.repeat(2_000_000);

    expect(() => parseReplayJsonl(blankLines)).toThrow(/contains no cases/u);
  });

  it('accepts canonical base64 at the configured decoded-byte boundary', async () => {
    const maxInputBytes = 1024;
    const encoded = Buffer.alloc(maxInputBytes, 0x5a).toString('base64');
    const cases = parseReplayJsonl(
      JSON.stringify({
        id: 'base64-boundary',
        input: {
          role: 'user',
          kind: 'prose',
          trust: 'untrusted-external',
          contentBase64: encoded,
        },
      }),
      10,
      maximumReplayStringCodeUnits(maxInputBytes),
    );
    const policy = makePolicy({ limits: { maxInputBytes } });
    const core = createSemWitness({
      storeRoot: await temporaryRoot(),
      policy,
    });

    const report = await replayCases({ core, policy, cases });
    expect(report.executionFailures).toBe(0);
    expect(report.unassessed).toBe(1);
  });
});
