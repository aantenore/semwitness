#!/usr/bin/env node

import { Buffer } from 'node:buffer';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Command, CommanderError, InvalidArgumentError } from 'commander';
import { HeuristicTokenizer } from '../adapters/heuristic-tokenizer.js';
import {
  OpenAICompatibleIntentCompiler,
  type OpenAICompatibleIntentCompilerConfig,
} from '../adapters/openai-compatible-intent-compiler.js';
import { analyzeSegment } from '../application/analyze.js';
import { simulateSegment } from '../application/simulate.js';
import {
  createDefaultRegistry,
  createSemWitness,
} from '../composition-root.js';
import {
  canonicalJson,
  toJsonValue,
  type JsonValue,
} from '../domain/canonical-json.js';
import { SemWitnessError } from '../domain/errors.js';
import { isSha256Digest } from '../domain/hash.js';
import { parseStrictJson } from '../domain/strict-json.js';
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
  MAX_CACHE_HIT_WITNESS_ARTIFACT_BYTES,
  evaluateIntentNormalizer,
  parseIntentEvaluationJsonl,
  type IntentEvaluationCase,
  type IntentEvaluationFixture,
} from '../intent/index.js';
import {
  MAX_INTENT_CACHE_ADMISSION_DECISION_BYTES,
  MAX_INTENT_CACHE_ADMISSION_PASSPORT_BYTES,
  MAX_INTENT_CACHE_ADMISSION_SECRET_BYTES,
  MAX_INTENT_CACHE_ADMISSION_VALUE_BYTES,
  createIntentCacheAdmissionDecisionStatement,
  createIntentCacheAdmissionPassportStatement,
  digestIntentCacheAdmissionDecisionCanonicalProfile,
  digestIntentCacheAdmissionPassportCanonicalProfile,
  evaluateIntentCachePromotionEvidence,
  serializeIntentCacheAdmissionDecisionStatement,
  serializeIntentCacheShadowQualificationManifest,
  serializeIntentCacheAdmissionPassportStatement,
  verifyIntentCacheAdmissionDecisionStatementBinding,
  verifyIntentCacheAdmissionPassportStatementBinding,
  type IntentCacheAdmissionDecisionEvidence,
} from '../intent-host/index.js';
import {
  evaluateHostPromotionEvidence,
  parseHostPromotionEvidenceJsonl,
} from '../host/promotion-evidence.js';
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

const VERSION = '0.5.0-alpha.5';
const ERROR_SCHEMA = 'semwitness.dev/cli-error/v1alpha1';
const MAX_INTENT_NORMALIZER_BYTES = 4 * 1024 * 1024;
const MAX_INTENT_COMPILER_BINDING_BYTES = 64 * 1024;
const MAX_PROMOTION_EVIDENCE_BYTES = 32 * 1024 * 1024;
const MAX_INTENT_PROMOTION_EVIDENCE_BYTES = 128 * 1024 * 1024;
const MAX_INTENT_CACHE_QUALIFICATION_BYTES = 256 * 1024;
const MAX_INTENT_ADMISSION_EVIDENCE_DOCUMENT_BYTES = 256 * 1024;
const MAX_INTENT_ADMISSION_BINDING_BYTES = 64 * 1024;
const INTENT_CACHE_ADMISSION_PASSPORT_BINDING_SCHEMA =
  'semwitness.dev/intent-cache-admission-passport-binding-verification/v1alpha1' as const;
const INTENT_CACHE_ADMISSION_PASSPORT_CREATION_SCHEMA =
  'semwitness.dev/intent-cache-admission-passport-creation/v1alpha1' as const;
const INTENT_CACHE_ADMISSION_DECISION_BINDING_SCHEMA =
  'semwitness.dev/intent-cache-admission-decision-binding-verification/v1alpha1' as const;
const INTENT_CACHE_ADMISSION_DECISION_CREATION_SCHEMA =
  'semwitness.dev/intent-cache-admission-decision-creation/v1alpha1' as const;
const DEFAULT_MAX_INTENT_REQUESTS = 100;
const MAX_INTENT_REQUESTS = 1_000;
const INTENT_COMPILER_BINDING_SCHEMA =
  'semwitness.dev/intent-compiler-binding/v1' as const;
const SAFE_ENVIRONMENT_REF = /^SEMWITNESS_[A-Z0-9_]{1,116}$/u;
const SAFE_PROVIDER_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

interface InputOptions {
  readonly input: string;
  readonly role: SegmentRole;
  readonly kind: SegmentKind;
  readonly trust: TrustLevel;
  readonly policy?: string;
  readonly store?: string;
}

interface IntentAdmissionEvidenceOptions {
  readonly qualification: string;
  readonly passport: string;
  readonly cacheHitWitness: string;
  readonly normalizationWitness: string;
  readonly operationBinding: string;
  readonly entrySourceBinding: string;
  readonly cacheKeySecretEnv: string;
  readonly valueFile: string;
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
    .description(
      'Evaluate typed intent normalization and shadow cache lineage, offline by default.',
    );

  intent
    .command('evaluate')
    .description(
      'Evaluate an offline exact-alias or explicitly networked compiler against strict JSONL ground truth.',
    )
    .requiredOption('--fixture <file>', 'Strict intent evaluation JSONL file')
    .requiredOption(
      '--normalizer <file>',
      'Trusted strict operation-registry JSON file',
    )
    .option(
      '--compiler-config <file>',
      'Strict versioned compiler binding; openai-compatible only',
    )
    .option(
      '--allow-network',
      'Explicitly permit requests selected by --compiler-config',
      false,
    )
    .option(
      '--max-requests <count>',
      'Maximum selected cases multiplied by runs',
      parseMaxRequests,
      DEFAULT_MAX_INTENT_REQUESTS,
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
        compilerConfig?: string;
        allowNetwork: boolean;
        maxRequests: number;
        split: IntentEvaluationCase['split'] | 'all';
        runs: number;
      }) => {
        assertIntentNetworkSelection(options);
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
        const fixture = parseIntentEvaluationJsonl(fixtureSource);
        let normalizer:
          DeclarativeIntentNormalizer | OpenAICompatibleIntentCompiler;
        if (options.compilerConfig === undefined) {
          normalizer = new DeclarativeIntentNormalizer(normalizerSource);
        } else {
          const plannedRequests = assertIntentRequestBudget(
            fixture,
            options.split,
            options.runs,
            options.maxRequests,
          );
          const bindingSource = decodeUtf8(
            await readBoundedRegularFile(
              options.compilerConfig,
              MAX_INTENT_COMPILER_BINDING_BYTES,
            ),
            'Intent compiler binding must be UTF-8',
          );
          normalizer = new OpenAICompatibleIntentCompiler({
            registrySource: normalizerSource,
            config: parseIntentCompilerBinding(bindingSource),
            fetch: createRequestBudgetFetch(plannedRequests),
          });
        }
        const report = await evaluateIntentNormalizer({
          compiler: normalizer,
          registry: normalizer,
          fixture,
          split: options.split,
          attempts: options.runs,
        });
        writeJson(report);
        if (!report.gate.passed) {
          verdictExitCode = Math.max(verdictExitCode, 2);
        }
      },
    );

  const intentPromotion = intent
    .command('promotion')
    .description(
      'Evaluate payload-free intent-cache evidence for a shadow qualification.',
    );

  intentPromotion
    .command('evaluate')
    .description(
      'Evaluate strict intent-cache JSONL and emit a qualification only when every hard gate passes.',
    )
    .requiredOption(
      '--evidence <file>',
      'Strict intent-cache promotion evidence JSONL file',
    )
    .option(
      '--manifest-out <file>',
      'Optional new private qualification path; existing files are refused',
    )
    .option('--json', 'Emit stable JSON (default)')
    .action(async (options: { evidence: string; manifestOut?: string }) => {
      const result = evaluateIntentCachePromotionEvidence(
        await readBoundedRegularFile(
          options.evidence,
          MAX_INTENT_PROMOTION_EVIDENCE_BYTES,
        ),
      );
      if (result.qualified && options.manifestOut !== undefined) {
        await writeNewPrivateFile(
          options.manifestOut,
          new TextEncoder().encode(
            serializeIntentCacheShadowQualificationManifest(
              result.qualification,
            ),
          ),
        );
      }
      writeJson(result);
      if (!result.qualified) {
        verdictExitCode = Math.max(verdictExitCode, 2);
      }
    });

  const intentPassport = intent
    .command('passport')
    .description(
      'Create and inspect unsigned shadow-only Cache Admission Passport Statements.',
    );

  intentPassport
    .command('create')
    .description(
      'Derive a content-free in-toto Statement from one shadow qualification.',
    )
    .requiredOption(
      '--qualification <file>',
      'Exact canonical shadow qualification artifact',
    )
    .requiredOption(
      '--statement-out <file>',
      'New private Statement path; existing files are refused',
    )
    .option('--json', 'Emit stable JSON (default)')
    .action(
      async (options: { qualification: string; statementOut: string }) => {
        const qualification = parseIntentCacheQualificationDocument(
          await readBoundedRegularFile(
            options.qualification,
            MAX_INTENT_CACHE_QUALIFICATION_BYTES,
          ),
        );
        const statement =
          createIntentCacheAdmissionPassportStatement(qualification);
        const statementBytes =
          serializeIntentCacheAdmissionPassportStatement(statement);
        const canonicalProfileDigest =
          digestIntentCacheAdmissionPassportCanonicalProfile(statement);
        await writeNewPrivateFile(
          options.statementOut,
          new TextEncoder().encode(statementBytes),
        );
        writeJson({
          schema: INTENT_CACHE_ADMISSION_PASSPORT_CREATION_SCHEMA,
          kind: 'creation-only',
          created: true,
          authentication: 'none',
          activationCeiling: 'shadow-only',
          canonicalProfileDigest,
          payloadDigest: canonicalProfileDigest,
          statementQualificationDigest: `sha256:${statement.subject[0].digest.sha256}`,
        });
      },
    );

  intentPassport
    .command('inspect')
    .description(
      'Validate a Statement and compare every derived field with its qualification.',
    )
    .requiredOption('--statement <file>', 'Passport Statement JSON file')
    .requiredOption(
      '--qualification <file>',
      'Exact canonical shadow qualification artifact',
    )
    .option('--json', 'Emit stable JSON (default)')
    .action(async (options: { statement: string; qualification: string }) => {
      const verification = verifyIntentCacheAdmissionPassportStatementBinding(
        await readBoundedRegularFile(
          options.statement,
          MAX_INTENT_CACHE_ADMISSION_PASSPORT_BYTES,
        ),
        parseIntentCacheQualificationDocument(
          await readBoundedRegularFile(
            options.qualification,
            MAX_INTENT_CACHE_QUALIFICATION_BYTES,
          ),
        ),
      );
      writeJson({
        schema: INTENT_CACHE_ADMISSION_PASSPORT_BINDING_SCHEMA,
        kind: 'binding-only',
        authentication: 'none',
        activationCeiling: 'shadow-only',
        ...verification,
      });
      if (!verification.bound) {
        verdictExitCode = Math.max(verdictExitCode, 2);
      }
    });

  const intentAdmission = intent
    .command('admission')
    .description(
      'Create and inspect unsigned shadow-only Cache Admission Decision Statements.',
    );

  addIntentAdmissionEvidenceOptions(
    intentAdmission
      .command('create')
      .description(
        'Bind one exact Passport and eligible cache-hit witness without granting serving authority.',
      )
      .requiredOption(
        '--statement-out <file>',
        'New private Statement path; existing files are refused',
      ),
  )
    .option('--json', 'Emit stable JSON (default)')
    .action(
      async (
        options: IntentAdmissionEvidenceOptions & { statementOut: string },
      ) => {
        const evidence = await loadIntentAdmissionEvidence(options);
        const statement = createIntentCacheAdmissionDecisionStatement(evidence);
        const statementBytes =
          serializeIntentCacheAdmissionDecisionStatement(statement);
        const canonicalProfileDigest =
          digestIntentCacheAdmissionDecisionCanonicalProfile(statement);
        await writeNewPrivateFile(
          options.statementOut,
          new TextEncoder().encode(statementBytes),
        );
        writeJson({
          schema: INTENT_CACHE_ADMISSION_DECISION_CREATION_SCHEMA,
          kind: 'creation-only',
          created: true,
          authentication: 'none',
          mode: 'shadow',
          activationCeiling: 'shadow-only',
          servingAuthority: 'none',
          canonicalProfileDigest,
          payloadDigest: canonicalProfileDigest,
          statementPassportPayloadDigest: `sha256:${statement.subject[0].digest.sha256}`,
          statementWitnessPayloadDigest: `sha256:${statement.subject[1].digest.sha256}`,
        });
      },
    );

  addIntentAdmissionEvidenceOptions(
    intentAdmission
      .command('inspect')
      .description(
        'Verify exact Statement bytes and every derived field against private creation evidence.',
      )
      .requiredOption(
        '--statement <file>',
        'Admission Decision Statement file',
      ),
  )
    .option('--json', 'Emit stable JSON (default)')
    .action(
      async (
        options: IntentAdmissionEvidenceOptions & { statement: string },
      ) => {
        const verification = verifyIntentCacheAdmissionDecisionStatementBinding(
          await readBoundedRegularFile(
            options.statement,
            MAX_INTENT_CACHE_ADMISSION_DECISION_BYTES,
          ),
          await loadIntentAdmissionEvidence(options),
        );
        writeJson({
          schema: INTENT_CACHE_ADMISSION_DECISION_BINDING_SCHEMA,
          kind: 'binding-only',
          authentication: 'none',
          mode: 'shadow',
          activationCeiling: 'shadow-only',
          ...verification,
        });
        if (!verification.bound) {
          verdictExitCode = Math.max(verdictExitCode, 2);
        }
      },
    );

  const promotion = program
    .command('promotion')
    .description(
      'Compile deployment-owned held-out evidence into a gated host promotion.',
    );

  promotion
    .command('evaluate')
    .description(
      'Evaluate strict content-free JSONL and emit a promotion only when every hard gate passes.',
    )
    .requiredOption('--evidence <file>', 'Strict promotion evidence JSONL file')
    .requiredOption('--policy <file>', 'Exact apply-verified YAML policy')
    .option(
      '--manifest-out <file>',
      'Optional new private manifest path; existing files are refused',
    )
    .option('--json', 'Emit stable JSON (default)')
    .action(
      async (options: {
        evidence: string;
        policy: string;
        manifestOut?: string;
      }) => {
        const policy = await loadPolicyFile(options.policy);
        const source = decodeUtf8(
          await readBoundedRegularFile(
            options.evidence,
            MAX_PROMOTION_EVIDENCE_BYTES,
          ),
          'Promotion evidence must be UTF-8',
        );
        const result = evaluateHostPromotionEvidence({
          policy,
          fixture: parseHostPromotionEvidenceJsonl(source),
        });
        if (result.qualified && options.manifestOut !== undefined) {
          if (result.promotion === undefined) {
            throw new SemWitnessError(
              'MALFORMED_ENVELOPE',
              'Qualified evidence omitted its promotion manifest',
            );
          }
          await writeNewPrivateFile(
            options.manifestOut,
            new TextEncoder().encode(
              `${canonicalJson(toJsonValue(result.promotion))}\n`,
            ),
          );
        }
        writeJson(result);
        if (!result.qualified) {
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

function addIntentAdmissionEvidenceOptions(command: Command): Command {
  return command
    .requiredOption(
      '--qualification <file>',
      'Exact canonical shadow qualification artifact',
    )
    .requiredOption(
      '--passport <file>',
      'Exact canonical Cache Admission Passport payload',
    )
    .requiredOption(
      '--cache-hit-witness <file>',
      'Exact canonical eligible CacheHitWitness payload',
    )
    .requiredOption(
      '--normalization-witness <file>',
      'Current NormalizationWitness JSON file',
    )
    .requiredOption(
      '--operation-binding <file>',
      'Intent-cache operation binding JSON file',
    )
    .requiredOption(
      '--entry-source-binding <file>',
      'Intent-cache entry-source binding JSON file',
    )
    .requiredOption(
      '--cache-key-secret-env <name>',
      'SEMWITNESS_* environment variable containing the deployment HMAC secret',
    )
    .requiredOption(
      '--value-file <file>',
      'Exact private candidate value bytes; never emitted',
    );
}

async function loadIntentAdmissionEvidence(
  options: IntentAdmissionEvidenceOptions,
): Promise<IntentCacheAdmissionDecisionEvidence> {
  const [
    qualificationBytes,
    passport,
    cacheHitWitness,
    normalizationWitnessBytes,
    operationBindingBytes,
    entrySourceBindingBytes,
    value,
  ] = await Promise.all([
    readBoundedRegularFile(
      options.qualification,
      MAX_INTENT_CACHE_QUALIFICATION_BYTES,
    ),
    readBoundedRegularFile(
      options.passport,
      MAX_INTENT_CACHE_ADMISSION_PASSPORT_BYTES,
    ),
    readBoundedRegularFile(
      options.cacheHitWitness,
      MAX_CACHE_HIT_WITNESS_ARTIFACT_BYTES,
    ),
    readBoundedRegularFile(
      options.normalizationWitness,
      MAX_INTENT_ADMISSION_EVIDENCE_DOCUMENT_BYTES,
    ),
    readBoundedRegularFile(
      options.operationBinding,
      MAX_INTENT_ADMISSION_BINDING_BYTES,
    ),
    readBoundedRegularFile(
      options.entrySourceBinding,
      MAX_INTENT_ADMISSION_BINDING_BYTES,
    ),
    readBoundedRegularFile(
      options.valueFile,
      MAX_INTENT_CACHE_ADMISSION_VALUE_BYTES,
    ),
  ]);
  return Object.freeze({
    qualification: parseIntentCacheQualificationDocument(qualificationBytes),
    passport,
    cacheHitWitness,
    normalizationWitness: parseIntentAdmissionJsonDocument(
      normalizationWitnessBytes,
      'Normalization witness',
    ),
    operationBinding: parseIntentAdmissionJsonDocument(
      operationBindingBytes,
      'Operation binding',
    ),
    entrySourceBinding: parseIntentAdmissionJsonDocument(
      entrySourceBindingBytes,
      'Entry-source binding',
    ),
    cacheKeySecret: resolveIntentAdmissionSecret(options.cacheKeySecretEnv),
    value,
  });
}

function parseIntentAdmissionJsonDocument(
  bytes: Uint8Array,
  label: string,
): JsonValue {
  return parseStrictJson(decodeUtf8(bytes, `${label} must be UTF-8`), {
    maxDepth: 32,
    maxItems: 16_384,
    maxStringCodeUnits: 64 * 1024,
    maxNumberCodeUnits: 32,
  });
}

function resolveIntentAdmissionSecret(environmentRef: string): string {
  if (!SAFE_ENVIRONMENT_REF.test(environmentRef)) {
    throw new SemWitnessError(
      'MALFORMED_ENVELOPE',
      'Intent admission HMAC secret reference is invalid',
    );
  }
  const secret = process.env[environmentRef];
  if (
    secret === undefined ||
    Buffer.byteLength(secret, 'utf8') > MAX_INTENT_CACHE_ADMISSION_SECRET_BYTES
  ) {
    throw new SemWitnessError(
      'MALFORMED_ENVELOPE',
      'Intent admission HMAC secret is unavailable or invalid',
    );
  }
  return secret;
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

function parseMaxRequests(value: string): number {
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 1 ||
    parsed > MAX_INTENT_REQUESTS
  ) {
    throw new InvalidArgumentError(
      `Maximum requests must be an integer between 1 and ${MAX_INTENT_REQUESTS}`,
    );
  }
  return parsed;
}

function assertIntentNetworkSelection(options: {
  readonly compilerConfig?: string;
  readonly allowNetwork: boolean;
}): void {
  if (
    (options.compilerConfig === undefined && options.allowNetwork) ||
    (options.compilerConfig !== undefined && !options.allowNetwork)
  ) {
    throw new SemWitnessError(
      'MALFORMED_ENVELOPE',
      'Network intent evaluation requires compiler config and explicit opt-in',
    );
  }
}

function assertIntentRequestBudget(
  fixture: IntentEvaluationFixture,
  split: IntentEvaluationCase['split'] | 'all',
  runs: number,
  maximumRequests: number,
): number {
  const selectedCases = fixture.cases.filter(
    (item) => split === 'all' || item.split === split,
  ).length;
  if (
    selectedCases === 0 ||
    selectedCases > Math.floor(maximumRequests / runs)
  ) {
    throw new SemWitnessError(
      'MALFORMED_ENVELOPE',
      'Intent evaluation exceeds the explicit request budget',
    );
  }
  return selectedCases * runs;
}

function parseIntentCompilerBinding(
  source: string,
): OpenAICompatibleIntentCompilerConfig {
  let value: JsonValue;
  try {
    value = parseStrictJson(source, {
      maxDepth: 8,
      maxItems: 64,
      maxStringCodeUnits: 2_048,
      maxNumberCodeUnits: 32,
    });
  } catch {
    throw malformedCompilerBinding();
  }
  const binding = strictJsonObject(value, ['schema', 'adapter', 'config']);
  if (
    binding === undefined ||
    binding.schema !== INTENT_COMPILER_BINDING_SCHEMA ||
    binding.adapter !== 'openai-compatible'
  ) {
    throw malformedCompilerBinding();
  }
  const config = strictJsonObject(binding.config, ['provider', 'policy']);
  const provider = strictJsonObject(
    config?.provider,
    ['name', 'baseUrl', 'model'],
    ['environmentRef'],
  );
  const policy = strictJsonObject(config?.policy, [
    'requestTimeoutMs',
    'maxResponseBytes',
    'maxOutputTokens',
    'maxPromptBytes',
  ]);
  const environmentRef = provider?.environmentRef;
  if (
    provider === undefined ||
    policy === undefined ||
    typeof provider.name !== 'string' ||
    !SAFE_PROVIDER_NAME.test(provider.name) ||
    typeof provider.baseUrl !== 'string' ||
    provider.baseUrl.length === 0 ||
    provider.baseUrl.length > 2_048 ||
    typeof provider.model !== 'string' ||
    !isSafeModel(provider.model) ||
    (environmentRef !== undefined &&
      (typeof environmentRef !== 'string' ||
        !SAFE_ENVIRONMENT_REF.test(environmentRef))) ||
    !integerWithin(policy.requestTimeoutMs, 1, 300_000) ||
    !integerWithin(policy.maxResponseBytes, 256, 8 * 1024 * 1024) ||
    !integerWithin(policy.maxOutputTokens, 16, 4_096) ||
    !integerWithin(policy.maxPromptBytes, 1_024, 1024 * 1024)
  ) {
    throw malformedCompilerBinding();
  }
  return Object.freeze({
    provider: Object.freeze({
      name: provider.name,
      baseUrl: provider.baseUrl,
      model: provider.model,
      ...(environmentRef === undefined ? {} : { environmentRef }),
    }),
    policy: Object.freeze({
      requestTimeoutMs: policy.requestTimeoutMs as number,
      maxResponseBytes: policy.maxResponseBytes as number,
      maxOutputTokens: policy.maxOutputTokens as number,
      maxPromptBytes: policy.maxPromptBytes as number,
    }),
  });
}

function parseIntentCacheQualificationDocument(bytes: Uint8Array): JsonValue {
  try {
    const source = decodeUtf8(
      bytes,
      'Intent-cache qualification must be UTF-8',
    );
    const qualification = parseStrictJson(source, {
      maxDepth: 32,
      maxItems: 2_048,
      maxStringCodeUnits: 4 * 1024,
      maxNumberCodeUnits: 32,
    });
    const canonicalBytes = new TextEncoder().encode(
      serializeIntentCacheShadowQualificationManifest(qualification),
    );
    if (
      bytes.byteLength !== canonicalBytes.byteLength ||
      canonicalBytes.some((byte, index) => byte !== bytes[index])
    ) {
      throw new SemWitnessError(
        'MALFORMED_ENVELOPE',
        'Intent-cache qualification must use exact canonical artifact bytes',
      );
    }
    return qualification;
  } catch (error) {
    throw new SemWitnessError(
      'MALFORMED_ENVELOPE',
      'Intent-cache qualification is invalid',
      error,
    );
  }
}

function strictJsonObject(
  input: JsonValue | undefined,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): Readonly<Record<string, JsonValue>> | undefined {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return undefined;
  }
  const keys = Object.keys(input);
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  if (
    !requiredKeys.every((key) => Object.hasOwn(input, key)) ||
    keys.some((key) => !allowed.has(key)) ||
    keys.length < requiredKeys.length ||
    keys.length > requiredKeys.length + optionalKeys.length
  ) {
    return undefined;
  }
  return input as Readonly<Record<string, JsonValue>>;
}

function isSafeModel(input: string): boolean {
  if (input.length === 0 || input.length > 256) return false;
  for (let index = 0; index < input.length; index += 1) {
    const codeUnit = input.charCodeAt(index);
    if (codeUnit <= 0x1f || codeUnit === 0x7f) return false;
  }
  return true;
}

function integerWithin(
  input: JsonValue | undefined,
  minimum: number,
  maximum: number,
): input is number {
  return (
    typeof input === 'number' &&
    Number.isSafeInteger(input) &&
    input >= minimum &&
    input <= maximum
  );
}

function malformedCompilerBinding(): SemWitnessError {
  return new SemWitnessError(
    'MALFORMED_ENVELOPE',
    'Intent compiler binding is invalid',
  );
}

function createRequestBudgetFetch(
  maximumRequests: number,
): typeof globalThis.fetch {
  const upstream = globalThis.fetch;
  let remaining = maximumRequests;
  return async (input, init) => {
    if (remaining <= 0) throw new Error('request_budget_exhausted');
    remaining -= 1;
    return upstream(input, init);
  };
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
