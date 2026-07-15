#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Command, CommanderError, InvalidArgumentError } from 'commander';
import { HeuristicTokenizer } from '../adapters/heuristic-tokenizer.js';
import { analyzeSegment } from '../application/analyze.js';
import { simulateSegment } from '../application/simulate.js';
import {
  createDefaultRegistry,
  createSemWitness,
} from '../composition-root.js';
import { canonicalJson, toJsonValue } from '../domain/canonical-json.js';
import { SemWitnessError } from '../domain/errors.js';
import { isSha256Digest } from '../domain/hash.js';
import {
  isSegmentKind,
  isSegmentRole,
  isTrustLevel,
  createSegment,
  type SegmentKind,
  type SegmentRole,
  type TrustLevel,
} from '../domain/types.js';
import {
  maximumReplayStringCodeUnits,
  parseReplayJsonl,
  replayCases,
} from '../eval/replay.js';
import {
  DeclarativeIntentNormalizer,
  IntentWitnessError,
  evaluateIntentNormalizer,
  parseIntentEvaluationJsonl,
  type IntentEvaluationCase,
} from '../intent/index.js';
import {
  createSimulationBundle,
  parseSimulationBundle,
  serializeSegmentMetadata,
  verifySimulationBundle,
} from './bundle.js';
import {
  MAX_BUNDLE_BYTES,
  MAX_FIXTURE_BYTES,
  assertShadowPolicy,
  collectCasStats,
  decodeUtf8,
  loadPolicyFile,
  readBoundedRegularFile,
  readInputBytes,
  writeNewPrivateFile,
} from './io.js';

const VERSION = '0.3.0-alpha.1';
const ERROR_SCHEMA = 'semwitness.dev/cli-error/v1alpha1';
const MAX_INTENT_NORMALIZER_BYTES = 4 * 1024 * 1024;

interface InputOptions {
  readonly input: string;
  readonly role: SegmentRole;
  readonly kind: SegmentKind;
  readonly trust: TrustLevel;
  readonly policy?: string;
  readonly store?: string;
}

export async function runCli(
  argv: readonly string[] = process.argv,
): Promise<number> {
  let verdictExitCode = 0;
  const program = new Command()
    .name('semwitness')
    .description('Proof-carrying semantic compression in explicit shadow mode.')
    .version(VERSION)
    .showHelpAfterError(false)
    .allowExcessArguments(false)
    .exitOverride()
    .configureOutput({ writeErr: () => undefined });

  addInputOptions(
    program
      .command('analyze')
      .description(
        'Analyze candidates without emitting source or projected content.',
      ),
    false,
  ).action(async (options: InputOptions) => {
    const policy = await loadPolicyFile(options.policy);
    assertShadowPolicy(policy);
    const segment = createSegment({
      role: options.role,
      kind: options.kind,
      trust: options.trust,
      content: await readInputBytes(options.input, policy.limits.maxInputBytes),
    });
    const report =
      options.store === undefined
        ? await analyzeSegment(
            {
              registry: createDefaultRegistry(),
              tokenizer: new HeuristicTokenizer(),
            },
            segment,
            policy,
          )
        : await createSemWitness({ storeRoot: options.store, policy }).analyze(
            segment,
            policy,
          );
    writeJson({
      schema: 'semwitness.dev/analysis-report/v1alpha1',
      input: serializeSegmentMetadata(segment),
      decision: {
        applied: report.applied,
        selectedCodec: report.selectedCodec,
        originalSha256: report.originalSha256,
        encodedSha256: report.encodedSha256,
      },
      proof: report.proof,
      candidates: report.candidates,
    });
  });

  addInputOptions(
    program
      .command('simulate')
      .description(
        'Emit a content-free projected-reference bundle in shadow mode.',
      ),
    true,
  ).action(async (options: InputOptions) => {
    const policy = await loadPolicyFile(options.policy);
    assertShadowPolicy(policy);
    const segment = createSegment({
      role: options.role,
      kind: options.kind,
      trust: options.trust,
      content: await readInputBytes(options.input, policy.limits.maxInputBytes),
    });
    if (options.store === undefined) {
      throw new SemWitnessError(
        'MALFORMED_ENVELOPE',
        'Simulation requires an explicit store',
      );
    }
    const core = createSemWitness({ storeRoot: options.store, policy });
    const simulation = await core.simulate(segment, policy);
    if (!simulation.projectedStored) {
      throw new SemWitnessError(
        'CAS_WRITE_FAILED',
        'Projected content was not persisted, so no bundle can be emitted',
      );
    }
    writeJson(
      createSimulationBundle({
        segment,
        policy,
        simulation,
      }),
    );
  });

  program
    .command('verify')
    .description('Verify a bundle against its original in the local CAS.')
    .requiredOption('--bundle <file>', 'Simulation bundle JSON file')
    .requiredOption('--store <directory>', 'Local CAS parent directory')
    .option('--json', 'Emit stable JSON (default)')
    .action(async (options: { bundle: string; store: string }) => {
      const source = decodeUtf8(
        await readBoundedRegularFile(options.bundle, MAX_BUNDLE_BYTES),
        'Simulation bundle must be UTF-8',
      );
      const bundle = parseSimulationBundle(source);
      const core = createSemWitness({
        storeRoot: options.store,
        policy: bundle.policy,
      });
      const verification = await verifySimulationBundle(core, bundle);
      writeJson({
        schema: 'semwitness.dev/verification-report/v1alpha1',
        verified: verification.verified,
        reasons: verification.reasons,
        bundleDigest: bundle.bundleDigest,
        proofDigest: bundle.proof.proofDigest,
        originalSha256: bundle.input.sha256,
        projectedSha256: bundle.proof.encoded.sha256,
      });
      if (!verification.verified) {
        verdictExitCode = Math.max(verdictExitCode, 2);
      }
    });

  program
    .command('retrieve')
    .description('Recover one exact CAS object into a new private file.')
    .argument('<digest>', 'sha256:<64 lowercase hex>')
    .requiredOption('--store <directory>', 'Local CAS parent directory')
    .requiredOption(
      '--out <file>',
      'New destination file; existing files are refused',
    )
    .option('--policy <file>', 'Validated YAML policy for its CAS namespace')
    .option('--json', 'Emit stable JSON (default)')
    .action(
      async (
        digest: string,
        options: { store: string; out: string; policy?: string },
      ) => {
        if (!isSha256Digest(digest)) {
          throw new SemWitnessError(
            'MALFORMED_ENVELOPE',
            'Digest must be sha256 followed by 64 lowercase hex characters',
          );
        }
        const policy = await loadPolicyFile(options.policy);
        assertShadowPolicy(policy);
        const core = createSemWitness({ storeRoot: options.store, policy });
        const bytes = await core.retrieve(digest, policy);
        await writeNewPrivateFile(options.out, bytes);
        writeJson({
          schema: 'semwitness.dev/retrieval-report/v1alpha1',
          digest,
          byteLength: bytes.byteLength,
          written: true,
        });
      },
    );

  const intent = program
    .command('intent')
    .description('Evaluate typed intent normalization in offline shadow mode.');

  intent
    .command('evaluate')
    .description(
      'Evaluate a declarative normalizer against strict JSONL ground truth.',
    )
    .requiredOption('--fixture <file>', 'Strict intent evaluation JSONL file')
    .requiredOption(
      '--normalizer <file>',
      'Strict declarative normalizer JSON file',
    )
    .option(
      '--split <split>',
      'conformance, development, held-out, or all',
      parseIntentSplit,
      'conformance',
    )
    .option('--runs <count>', 'Repeatability attempts per case', parseRuns, 2)
    .option('--json', 'Emit stable JSON (default)')
    .action(
      async (options: {
        fixture: string;
        normalizer: string;
        split: IntentEvaluationCase['split'] | 'all';
        runs: number;
      }) => {
        const normalizerSource = decodeUtf8(
          await readBoundedRegularFile(
            options.normalizer,
            MAX_INTENT_NORMALIZER_BYTES,
          ),
          'Intent normalizer must be UTF-8',
        );
        const fixtureSource = decodeUtf8(
          await readBoundedRegularFile(options.fixture, MAX_FIXTURE_BYTES),
          'Intent evaluation fixture must be UTF-8',
        );
        const normalizer = new DeclarativeIntentNormalizer(normalizerSource);
        const report = await evaluateIntentNormalizer({
          compiler: normalizer,
          registry: normalizer,
          fixture: parseIntentEvaluationJsonl(fixtureSource),
          split: options.split,
          attempts: options.runs,
        });
        writeJson(report);
        if (!report.gate.passed) {
          verdictExitCode = Math.max(verdictExitCode, 2);
        }
      },
    );

  program
    .command('stats')
    .description('Report content-free CAS object counts and bytes.')
    .requiredOption('--store <directory>', 'Local CAS parent directory')
    .option('--json', 'Emit stable JSON (default)')
    .action(async (options: { store: string }) => {
      writeJson(await collectCasStats(options.store));
    });

  program
    .command('replay')
    .description(
      'Replay strict JSONL fixtures and evaluate optional expectations.',
    )
    .requiredOption('--fixture <file>', 'Strict JSONL fixture file')
    .option('--policy <file>', 'Validated YAML policy')
    .option('--store <directory>', 'Optional local CAS parent directory')
    .option(
      '--allow-unassessed',
      'Allow fixtures without expect to produce exit zero',
      false,
    )
    .option('--json', 'Emit stable JSON (default)')
    .action(
      async (options: {
        fixture: string;
        policy?: string;
        store?: string;
        allowUnassessed: boolean;
      }) => {
        const policy = await loadPolicyFile(options.policy);
        assertShadowPolicy(policy);
        const source = decodeUtf8(
          await readBoundedRegularFile(options.fixture, MAX_FIXTURE_BYTES),
          'Replay fixture must be UTF-8',
        );
        const core =
          options.store === undefined
            ? {
                simulate: (segment: Parameters<typeof simulateSegment>[1]) =>
                  simulateSegment(
                    {
                      registry: createDefaultRegistry(),
                      tokenizer: new HeuristicTokenizer(),
                    },
                    segment,
                    policy,
                  ),
              }
            : createSemWitness({ storeRoot: options.store, policy });
        const report = await replayCases({
          core,
          policy,
          cases: parseReplayJsonl(
            source,
            10_000,
            maximumReplayStringCodeUnits(policy.limits.maxInputBytes),
          ),
        });
        writeJson(report);
        if (
          report.failed > 0 ||
          report.executionFailures > 0 ||
          (!options.allowUnassessed && report.unassessed > 0)
        ) {
          verdictExitCode = Math.max(verdictExitCode, 2);
        }
      },
    );

  try {
    await program.parseAsync([...argv], { from: 'node' });
    return verdictExitCode;
  } catch (error) {
    if (
      error instanceof CommanderError &&
      (error.code === 'commander.helpDisplayed' ||
        error.code === 'commander.version')
    ) {
      return 0;
    }
    writeError(error);
    return 1;
  }
}

function addInputOptions(command: Command, requireStore: boolean): Command {
  const configured = command
    .requiredOption('--input <file|->', 'Input file, or - for bounded stdin')
    .requiredOption('--role <role>', 'Host-supplied segment role', parseRole)
    .requiredOption('--kind <kind>', 'Host-supplied segment kind', parseKind)
    .requiredOption('--trust <level>', 'Host-supplied trust level', parseTrust)
    .option('--policy <file>', 'Validated YAML policy')
    .option('--json', 'Emit stable JSON (default)');
  return requireStore
    ? configured.requiredOption(
        '--store <directory>',
        'Explicit local CAS parent directory',
      )
    : configured.option(
        '--store <directory>',
        'Optional local CAS parent directory',
      );
}

function parseRole(value: string): SegmentRole {
  if (!isSegmentRole(value)) {
    throw new InvalidArgumentError('Unsupported segment role');
  }
  return value;
}

function parseKind(value: string): SegmentKind {
  if (!isSegmentKind(value)) {
    throw new InvalidArgumentError('Unsupported segment kind');
  }
  return value;
}

function parseTrust(value: string): TrustLevel {
  if (!isTrustLevel(value)) {
    throw new InvalidArgumentError('Unsupported trust level');
  }
  return value;
}

function parseIntentSplit(
  value: string,
): IntentEvaluationCase['split'] | 'all' {
  if (
    value !== 'conformance' &&
    value !== 'development' &&
    value !== 'held-out' &&
    value !== 'all'
  ) {
    throw new InvalidArgumentError('Unsupported intent evaluation split');
  }
  return value;
}

function parseRuns(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 2 || parsed > 20) {
    throw new InvalidArgumentError('Runs must be an integer between 2 and 20');
  }
  return parsed;
}

function writeJson(value: unknown): void {
  process.stdout.write(`${canonicalJson(toJsonValue(value))}\n`);
}

function writeError(error: unknown): void {
  const reason =
    error instanceof SemWitnessError || error instanceof IntentWitnessError
      ? error.code
      : 'MALFORMED_ENVELOPE';
  process.stderr.write(
    `${canonicalJson(
      toJsonValue({
        schema: ERROR_SCHEMA,
        ok: false,
        error: { reason, message: safeErrorMessage(reason) },
      }),
    )}\n`,
  );
}

function safeErrorMessage(reason: string): string {
  switch (reason) {
    case 'INPUT_TOO_LARGE':
      return 'Input exceeds the configured safety limit';
    case 'CAS_MISS':
      return 'Required content is unavailable in the local store';
    case 'CAS_CORRUPT':
      return 'Local content-addressed storage failed integrity checks';
    case 'CAS_WRITE_FAILED':
      return 'Content could not be written safely';
    case 'SHADOW_ONLY':
      return 'This command accepts shadow-mode policies only';
    case 'FORMAT_UNSUPPORTED':
      return 'Input format is unsupported or malformed';
    case 'MALFORMED_ENVELOPE':
      return 'Command input or serialized data is invalid';
    default:
      return 'SemWitness failed closed with the reported reason code';
  }
}

function isMainEntrypoint(entrypoint: string | undefined): boolean {
  if (entrypoint === undefined) {
    return false;
  }

  try {
    return (
      realpathSync(entrypoint) === realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (isMainEntrypoint(process.argv[1])) {
  void runCli().then((code) => {
    process.exitCode = code;
  });
}
