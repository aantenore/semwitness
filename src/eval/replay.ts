import { Buffer } from 'node:buffer';
import { z } from 'zod';
import type { SimulationResult } from '../application/simulate.js';
import { SemWitnessError, reasonFromError } from '../domain/errors.js';
import type { CodecPolicy } from '../domain/policy.js';
import { REASON_CODES, type ReasonCode } from '../domain/reason-codes.js';
import { parseStrictJson } from '../domain/strict-json.js';
import {
  SEGMENT_KINDS,
  SEGMENT_ROLES,
  SAFE_IDENTIFIER_PATTERN,
  TRUST_LEVELS,
  createSegment,
  type Segment,
  type SegmentKind,
  type SegmentRole,
  type Sha256Digest,
  type TrustLevel,
} from '../domain/types.js';

export const REPLAY_REPORT_SCHEMA =
  'semwitness.dev/replay-report/v1alpha1' as const;

export interface ReplayExpectation {
  readonly decisionStatus: 'applied' | 'bypassed';
  readonly codecId: string;
  readonly reasonIncludes?: readonly ReasonCode[];
}

export interface ReplayInput {
  readonly role: SegmentRole;
  readonly kind: SegmentKind;
  readonly trust: TrustLevel;
  readonly content?: string;
  readonly contentBase64?: string;
}

export interface ReplayCase {
  readonly id: string;
  readonly input: ReplayInput;
  readonly expect?: ReplayExpectation;
}

export interface ReplayCaseResult {
  readonly id: string;
  readonly status: 'passed' | 'failed' | 'unassessed';
  readonly expectationFailures: readonly string[];
  readonly errorReason?: ReasonCode;
  readonly actual?: {
    readonly selectedCodec: string;
    readonly applied: boolean;
    readonly decisionStatus: 'applied' | 'bypassed';
    readonly originalSha256: Sha256Digest;
    readonly projectedSha256: Sha256Digest;
    readonly reasons: readonly ReasonCode[];
    readonly originalTokens: number;
    readonly encodedTokens: number;
    readonly decoderOverheadTokens: number;
    readonly netTokenSavings: number;
    readonly savingsRatioPpm: number;
  };
}

export interface ReplayReport {
  readonly schema: typeof REPLAY_REPORT_SCHEMA;
  readonly total: number;
  readonly assessed: number;
  readonly passed: number;
  readonly failed: number;
  readonly unassessed: number;
  readonly executionFailures: number;
  readonly expectationPassRatePpm: number;
  readonly aggregate: {
    readonly originalTokens: number;
    readonly encodedTokens: number;
    readonly decoderOverheadTokens: number;
    readonly netTokenSavings: number;
    readonly medianSavingsRatioPpm: number;
  };
  readonly cases: readonly ReplayCaseResult[];
}

export interface ReplaySimulator {
  simulate(segment: Segment, policy?: CodecPolicy): Promise<SimulationResult>;
}

const expectSchema = z
  .object({
    decisionStatus: z.enum(['applied', 'bypassed']),
    codecId: z.string().min(1).max(128),
    reasonIncludes: z
      .array(z.enum(REASON_CODES))
      .min(1)
      .max(REASON_CODES.length)
      .optional(),
  })
  .strict();
const replayInputFields = {
  role: z.enum(SEGMENT_ROLES),
  kind: z.enum(SEGMENT_KINDS),
  trust: z.enum(TRUST_LEVELS),
};
const replayInputSchema = z.union([
  z
    .object({
      ...replayInputFields,
      content: z.string(),
    })
    .strict(),
  z
    .object({
      ...replayInputFields,
      contentBase64: z.string(),
    })
    .strict(),
]);
const replayCaseSchema = z
  .object({
    id: z.string().regex(SAFE_IDENTIFIER_PATTERN),
    input: replayInputSchema,
    expect: expectSchema.optional(),
  })
  .strict();

export function parseReplayJsonl(
  source: string,
  maximumCases = 10_000,
  maximumStringCodeUnits = 2 * 1024 * 1024,
): readonly ReplayCase[] {
  const cases: ReplayCase[] = [];
  const identifiers = new Set<string>();
  let lineStart = 0;
  let lineNumber = 0;
  for (let cursor = 0; cursor <= source.length; cursor += 1) {
    if (cursor < source.length && source.charCodeAt(cursor) !== 0x0a) {
      continue;
    }
    lineNumber += 1;
    let start = lineStart;
    let end = cursor;
    if (end > start && source.charCodeAt(end - 1) === 0x0d) {
      end -= 1;
    }
    while (
      start < end &&
      (source.charCodeAt(start) === 0x20 || source.charCodeAt(start) === 0x09)
    ) {
      start += 1;
    }
    while (
      end > start &&
      (source.charCodeAt(end - 1) === 0x20 ||
        source.charCodeAt(end - 1) === 0x09)
    ) {
      end -= 1;
    }
    lineStart = cursor + 1;
    if (start === end) {
      continue;
    }
    if (cases.length >= maximumCases) {
      throw malformed('Replay fixture exceeds the case limit');
    }
    const line = source.slice(start, end);
    let value;
    try {
      value = parseStrictJson(line, {
        maxDepth: 32,
        maxItems: 10_000,
        maxStringCodeUnits: maximumStringCodeUnits,
      });
    } catch {
      throw malformed(`Replay fixture line ${lineNumber} is not strict JSON`);
    }
    const parsed = replayCaseSchema.safeParse(value);
    if (!parsed.success) {
      throw malformed(
        `Replay fixture line ${lineNumber} has an invalid schema`,
      );
    }
    if (identifiers.has(parsed.data.id)) {
      throw malformed('Replay fixture contains a duplicate id');
    }
    identifiers.add(parsed.data.id);
    cases.push(parsed.data as ReplayCase);
  }
  if (cases.length === 0) {
    throw malformed('Replay fixture contains no cases');
  }
  return cases;
}

export function maximumReplayStringCodeUnits(
  maximumInputBytes: number,
): number {
  if (!Number.isSafeInteger(maximumInputBytes) || maximumInputBytes < 1) {
    throw malformed('Replay input byte limit is invalid');
  }
  return Math.min(128 * 1024 * 1024, 4 * Math.ceil(maximumInputBytes / 3) + 4);
}

export async function replayCases(input: {
  readonly core: ReplaySimulator;
  readonly policy: CodecPolicy;
  readonly cases: readonly ReplayCase[];
}): Promise<ReplayReport> {
  const results: ReplayCaseResult[] = [];
  const ratios: number[] = [];
  let originalTokens = 0;
  let encodedTokens = 0;
  let decoderOverheadTokens = 0;

  for (const fixture of input.cases) {
    try {
      const content = decodeFixtureContent(
        fixture,
        input.policy.limits.maxInputBytes,
      );
      const segment = createSegment({
        id: fixture.id,
        role: fixture.input.role,
        kind: fixture.input.kind,
        trust: fixture.input.trust,
        content,
      });
      const simulation = await input.core.simulate(segment, input.policy);
      const selected = simulation.candidates.find(
        (candidate) => candidate.codecId === simulation.selectedCodec,
      );
      if (selected === undefined) {
        throw malformed('Simulation omitted its selected candidate report');
      }
      originalTokens = safeAdd(originalTokens, selected.originalTokens);
      encodedTokens = safeAdd(encodedTokens, selected.encodedTokens);
      decoderOverheadTokens = safeAdd(
        decoderOverheadTokens,
        selected.decoderOverheadTokens,
      );
      ratios.push(selected.savingsRatioPpm);
      const actual = {
        selectedCodec: simulation.selectedCodec,
        applied: simulation.applied,
        decisionStatus: simulation.proof.decision.status,
        originalSha256: simulation.proof.original.sha256,
        projectedSha256: simulation.projectedReference,
        reasons: simulation.proof.decision.reasons,
        originalTokens: selected.originalTokens,
        encodedTokens: selected.encodedTokens,
        decoderOverheadTokens: selected.decoderOverheadTokens,
        netTokenSavings: selected.netTokenSavings,
        savingsRatioPpm: selected.savingsRatioPpm,
      };
      const failures = expectationFailures(fixture.expect, actual);
      results.push({
        id: fixture.id,
        status:
          fixture.expect === undefined
            ? 'unassessed'
            : failures.length === 0
              ? 'passed'
              : 'failed',
        expectationFailures: failures,
        actual,
      });
    } catch (error) {
      results.push({
        id: fixture.id,
        status: 'failed',
        expectationFailures: ['execution'],
        errorReason: reasonFromError(error),
      });
    }
  }

  const executionFailures = results.filter(
    (result) => result.errorReason !== undefined,
  ).length;
  const passed = results.filter((result) => result.status === 'passed').length;
  const failed = results.filter(
    (result) => result.status === 'failed' && result.errorReason === undefined,
  ).length;
  const unassessed = results.filter(
    (result) => result.status === 'unassessed',
  ).length;
  const assessed = passed + failed;
  const total = results.length;
  return {
    schema: REPLAY_REPORT_SCHEMA,
    total,
    assessed,
    passed,
    failed,
    unassessed,
    executionFailures,
    expectationPassRatePpm: Math.floor(
      (passed * 1_000_000) / Math.max(1, assessed),
    ),
    aggregate: {
      originalTokens,
      encodedTokens,
      decoderOverheadTokens,
      netTokenSavings: originalTokens - encodedTokens - decoderOverheadTokens,
      medianSavingsRatioPpm: median(ratios),
    },
    cases: results,
  };
}

function decodeFixtureContent(
  fixture: ReplayCase,
  maximumBytes: number,
): Uint8Array {
  if (fixture.input.content !== undefined) {
    if (Buffer.byteLength(fixture.input.content, 'utf8') > maximumBytes) {
      throw new SemWitnessError(
        'INPUT_TOO_LARGE',
        'Replay fixture content exceeds the policy input limit',
      );
    }
    return new TextEncoder().encode(fixture.input.content);
  }
  const encoded = fixture.input.contentBase64;
  if (encoded === undefined || !hasCanonicalBase64Syntax(encoded)) {
    throw malformed('Replay fixture inputBase64 is not canonical base64');
  }
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  const decodedLength = (encoded.length / 4) * 3 - padding;
  if (decodedLength > maximumBytes) {
    throw new SemWitnessError(
      'INPUT_TOO_LARGE',
      'Replay fixture content exceeds the policy input limit',
    );
  }
  const decoded = Buffer.from(encoded, 'base64');
  if (decoded.toString('base64') !== encoded) {
    throw malformed('Replay fixture inputBase64 is not canonical base64');
  }
  return new Uint8Array(decoded);
}

function expectationFailures(
  expected: ReplayExpectation | undefined,
  actual: NonNullable<ReplayCaseResult['actual']>,
): readonly string[] {
  if (expected === undefined) {
    return [];
  }
  const failures: string[] = [];
  if (expected.decisionStatus !== actual.decisionStatus) {
    failures.push('decisionStatus');
  }
  if (expected.codecId !== actual.selectedCodec) {
    failures.push('codecId');
  }
  if (
    expected.reasonIncludes !== undefined &&
    !expected.reasonIncludes.every((reason) => actual.reasons.includes(reason))
  ) {
    failures.push('reasonIncludes');
  }
  return failures;
}

function hasCanonicalBase64Syntax(value: string): boolean {
  return (
    value.length % 4 === 0 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      value,
    )
  );
}

function median(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle]!;
  }
  return Math.floor((sorted[middle - 1]! + sorted[middle]!) / 2);
}

function safeAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw malformed('Replay aggregate exceeds safe integer range');
  }
  return result;
}

function malformed(message: string): SemWitnessError {
  return new SemWitnessError('MALFORMED_ENVELOPE', message);
}
