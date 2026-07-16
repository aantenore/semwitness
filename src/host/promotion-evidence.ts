import {
  immutableJson,
  toJsonValue,
  type JsonValue,
} from '../domain/canonical-json.js';
import { compareCodeUnits } from '../domain/deterministic-order.js';
import { SemWitnessError } from '../domain/errors.js';
import { hashCanonical, isSha256Digest, sha256 } from '../domain/hash.js';
import {
  digestPolicy,
  validatePolicy,
  type CodecPolicy,
  type PolicyRule,
} from '../domain/policy.js';
import { parseStrictJson } from '../domain/strict-json.js';
import {
  SAFE_IDENTIFIER_PATTERN,
  SAFE_VERSION_PATTERN,
  TRUST_LEVELS,
  type Sha256Digest,
  type TrustLevel,
} from '../domain/types.js';
import { isSafeTokenizerFingerprint } from '../ports/tokenizer.js';
import { snapshotDataRecord, snapshotDenseDataArray } from './data-only.js';
import {
  HOST_PREPARER_ARTIFACT,
  MIN_HOST_PROMOTION_SAVINGS_RATIO_PPM,
  digestHostPromotionManifest,
  isHostActiveCodec,
  parseHostPromotionManifest,
} from './promotion.js';
import type { HostPromotionManifest } from './types.js';

export const HOST_PROMOTION_EVIDENCE_SCHEMA =
  'semwitness.dev/host-promotion-evidence/v1alpha1' as const;
export const HOST_PROMOTION_EVALUATION_REPORT_SCHEMA =
  'semwitness.dev/host-promotion-evaluation-report/v1alpha1' as const;
export const HOST_PROMOTION_WORKBENCH_RESULT_SCHEMA =
  'semwitness.dev/host-promotion-workbench-result/v1alpha1' as const;

export const HOST_PROMOTION_DIFFICULTY_STRATA = [
  'simple',
  'medium',
  'complex',
  'adversarial',
] as const;
export const HOST_PROMOTION_CACHE_REGIMES = ['cold', 'warm'] as const;
export const HOST_PROMOTION_EXECUTION_FAILURE_REASONS = [
  'BASELINE_EXECUTION_FAILED',
  'CANDIDATE_EXECUTION_FAILED',
  'ACCOUNTING_INCOMPLETE',
  'TASK_ORACLE_FAILED',
  'MODEL_SCOPE_DRIFT',
  'TIMEOUT',
  'BOUNDED_EXECUTION_FAILURE',
] as const;
export const HOST_PROMOTION_GATE_REASONS = [
  'ARTIFACT_MISMATCH',
  'POLICY_NOT_APPLY_VERIFIED',
  'POLICY_DIGEST_MISMATCH',
  'TOKENIZER_MISMATCH',
  'TOKENIZER_NOT_EXACT',
  'USAGE_NOT_EXACT',
  'SPLIT_NOT_HELD_OUT',
  'EVALUATION_DESIGN_INVALID',
  'CORPUS_TOO_SMALL',
  'INCOMPLETE_CORPUS',
  'MISSING_REQUIRED_STRATUM',
  'MISSING_REQUIRED_CACHE_REGIME',
  'EXECUTION_FAILURES',
  'DEPLOYMENT_SCOPE_MISMATCH',
  'UNSUPPORTED_ACTIVE_CODEC',
  'UNDECLARED_CODEC_EVIDENCE',
  'CODEC_NOT_ALLOWED_BY_POLICY',
  'UNEVALUATED_CODEC',
  'UNSAFE_ACCEPTS',
  'TASK_QUALITY_REGRESSIONS',
  'PROMOTION_THRESHOLD_TOO_LOW',
  'NET_SAVINGS_BELOW_THRESHOLD',
  'CODEC_NET_SAVINGS_BELOW_THRESHOLD',
  'LATENCY_REGRESSION_ABOVE_THRESHOLD',
] as const;

export type HostPromotionDifficultyStratum =
  (typeof HOST_PROMOTION_DIFFICULTY_STRATA)[number];
export type HostPromotionCacheRegime =
  (typeof HOST_PROMOTION_CACHE_REGIMES)[number];
export type HostPromotionExecutionFailureReason =
  (typeof HOST_PROMOTION_EXECUTION_FAILURE_REASONS)[number];
export type HostPromotionGateReason =
  (typeof HOST_PROMOTION_GATE_REASONS)[number];

export interface HostPromotionCodecRef {
  readonly id: string;
  readonly version: string;
}

export interface HostPromotionEvidenceBinding {
  readonly schema: typeof HOST_PROMOTION_EVIDENCE_SCHEMA;
  readonly kind: 'binding';
  readonly artifact: {
    readonly id: string;
    readonly version: string;
  };
  readonly policyDigest: Sha256Digest;
  readonly deploymentScopeDigest: Sha256Digest;
  readonly corpusDigest: Sha256Digest;
  readonly evaluationProtocolDigest: Sha256Digest;
  readonly split: 'held-out' | 'development' | 'conformance';
  readonly usageEvidence: {
    readonly source: 'provider-response' | 'runtime-accounting' | 'estimate';
    readonly reliability: 'exact' | 'estimated';
  };
  readonly expectedCases: number;
  readonly tokenizer: {
    readonly id: string;
    readonly fingerprint: string;
    readonly reliability: 'exact' | 'heuristic' | 'estimated';
  };
  readonly codecs: readonly HostPromotionCodecRef[];
  readonly design: {
    readonly pairing: 'paired' | 'unpaired';
    readonly order: 'randomized' | 'counterbalanced' | 'fixed';
    readonly requiredStrata: readonly HostPromotionDifficultyStratum[];
    readonly requiredCacheRegimes: readonly HostPromotionCacheRegime[];
  };
  readonly gate: {
    readonly minimumMedianNetSavingsRatioPpm: number;
    readonly maximumMedianLatencyRegressionRatioPpm: number;
  };
}

export interface HostPromotionUsageObservation {
  readonly traceDigest: Sha256Digest;
  readonly totalInputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheWriteInputTokens: number;
  readonly totalOutputTokens: number;
  readonly reasoningOutputTokens: number;
  readonly normalizedCostUnits: number;
  readonly endToEndLatencyMicros: number;
  readonly compressorLatencyMicros: number;
  readonly attempts: number;
  readonly retryCount: number;
  readonly recoveryCount: number;
}

interface HostPromotionCaseBase {
  readonly schema: typeof HOST_PROMOTION_EVIDENCE_SCHEMA;
  readonly kind: 'case';
  readonly ordinal: number;
  readonly stratum: HostPromotionDifficultyStratum;
  readonly cacheRegime: HostPromotionCacheRegime;
  readonly codec: HostPromotionCodecRef;
  readonly deploymentScopeDigest: Sha256Digest;
}

export interface HostPromotionCompleteCase extends HostPromotionCaseBase {
  readonly status: 'complete';
  readonly decision: 'applied' | 'bypassed';
  readonly baseline: HostPromotionUsageObservation;
  readonly candidate: HostPromotionUsageObservation;
  readonly unsafeAccepted: boolean;
  readonly taskQualityRegression: boolean;
  readonly qualityEvidenceDigest: Sha256Digest;
}

export interface HostPromotionFailedCase extends HostPromotionCaseBase {
  readonly status: 'failed';
  readonly failureReason: HostPromotionExecutionFailureReason;
}

export type HostPromotionEvidenceCase =
  HostPromotionCompleteCase | HostPromotionFailedCase;

export interface HostPromotionEvidenceFixture {
  readonly binding: HostPromotionEvidenceBinding;
  readonly cases: readonly HostPromotionEvidenceCase[];
}

export interface HostPromotionUsageTotals {
  readonly totalInputTokens: string;
  readonly cacheReadInputTokens: string;
  readonly cacheWriteInputTokens: string;
  readonly totalOutputTokens: string;
  readonly reasoningOutputTokens: string;
  readonly normalizedCostUnits: string;
  readonly endToEndLatencyMicros: string;
  readonly compressorLatencyMicros: string;
  readonly attempts: string;
  readonly retryCount: string;
  readonly recoveryCount: string;
}

export interface HostPromotionMetricSlice {
  readonly caseCount: number;
  readonly complete: number;
  readonly failed: number;
  readonly applied: number;
  readonly bypassed: number;
  readonly medianInputSavingsRatioPpm: number | null;
  readonly medianCostSavingsRatioPpm: number | null;
  readonly medianNetSavingsRatioPpm: number | null;
  readonly medianLatencyRegressionRatioPpm: number | null;
}

export interface HostPromotionCaseResult {
  readonly caseRef: Sha256Digest;
  readonly ordinal: number;
  readonly status: 'complete' | 'failed';
  readonly stratum: HostPromotionDifficultyStratum;
  readonly cacheRegime: HostPromotionCacheRegime;
  readonly codec: HostPromotionCodecRef;
  readonly deploymentScopeMatched: boolean;
  readonly evidenceDigest: Sha256Digest;
  readonly decision?: 'applied' | 'bypassed';
  readonly inputSavingsRatioPpm?: number;
  readonly costSavingsRatioPpm?: number;
  readonly netSavingsRatioPpm?: number;
  readonly latencyRegressionRatioPpm?: number;
  readonly failureReason?: HostPromotionExecutionFailureReason;
}

export interface HostPromotionEvaluationReport {
  readonly schema: typeof HOST_PROMOTION_EVALUATION_REPORT_SCHEMA;
  readonly provenance: 'host-attested-unsigned';
  readonly binding: HostPromotionEvidenceBinding;
  readonly evaluatedPolicyDigest: Sha256Digest;
  readonly caseMetrics: {
    readonly expected: number;
    readonly observed: number;
    readonly complete: number;
    readonly failed: number;
    readonly applied: number;
    readonly bypassed: number;
    readonly unsafeAccepts: number;
    readonly taskQualityRegressions: number;
    readonly deploymentScopeMismatches: number;
    readonly undeclaredCodecCases: number;
  };
  readonly usageMetrics: {
    readonly baseline: HostPromotionUsageTotals;
    readonly candidate: HostPromotionUsageTotals;
    readonly medianInputSavingsRatioPpm: number | null;
    readonly medianCostSavingsRatioPpm: number | null;
    readonly medianNetSavingsRatioPpm: number | null;
    readonly medianLatencyRegressionRatioPpm: number | null;
  };
  readonly codecMetrics: readonly (HostPromotionMetricSlice & {
    readonly codec: HostPromotionCodecRef;
  })[];
  readonly stratumMetrics: readonly (HostPromotionMetricSlice & {
    readonly stratum: HostPromotionDifficultyStratum;
  })[];
  readonly cacheRegimeMetrics: readonly (HostPromotionMetricSlice & {
    readonly cacheRegime: HostPromotionCacheRegime;
  })[];
  readonly gate: {
    readonly passed: boolean;
    readonly reasons: readonly HostPromotionGateReason[];
  };
  readonly cases: readonly HostPromotionCaseResult[];
}

export interface HostPromotionWorkbenchResult {
  readonly schema: typeof HOST_PROMOTION_WORKBENCH_RESULT_SCHEMA;
  readonly qualified: boolean;
  readonly report: HostPromotionEvaluationReport;
  readonly reportDigest: Sha256Digest;
  readonly promotion?: HostPromotionManifest;
  readonly promotionDigest?: Sha256Digest;
}

export const MIN_HOST_PROMOTION_CASES = 50;
export const MAX_HOST_PROMOTION_CASES = 10_000;
const MAX_EVIDENCE_LINE_STRING_CODE_UNITS = 2_048;
const MAX_EVIDENCE_LINE_ITEMS = 256;
const MAX_CODEC_COUNT = 128;
const MAX_LATENCY_RATIO_PPM = 1_000_000_000;
const MAX_CONFIGURED_LATENCY_RATIO_PPM = 10_000_000;
const TOKENIZER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const CODEC_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

const BINDING_FIELDS = [
  'schema',
  'kind',
  'artifact',
  'policyDigest',
  'deploymentScopeDigest',
  'corpusDigest',
  'evaluationProtocolDigest',
  'split',
  'usageEvidence',
  'expectedCases',
  'tokenizer',
  'codecs',
  'design',
  'gate',
] as const;
const COMPLETE_CASE_FIELDS = [
  'schema',
  'kind',
  'ordinal',
  'status',
  'stratum',
  'cacheRegime',
  'codec',
  'deploymentScopeDigest',
  'decision',
  'baseline',
  'candidate',
  'unsafeAccepted',
  'taskQualityRegression',
  'qualityEvidenceDigest',
] as const;
const FAILED_CASE_FIELDS = [
  'schema',
  'kind',
  'ordinal',
  'status',
  'stratum',
  'cacheRegime',
  'codec',
  'deploymentScopeDigest',
  'failureReason',
] as const;
const USAGE_FIELDS = [
  'traceDigest',
  'totalInputTokens',
  'cacheReadInputTokens',
  'cacheWriteInputTokens',
  'totalOutputTokens',
  'reasoningOutputTokens',
  'normalizedCostUnits',
  'endToEndLatencyMicros',
  'compressorLatencyMicros',
  'attempts',
  'retryCount',
  'recoveryCount',
] as const;

export function parseHostPromotionEvidenceJsonl(
  source: string,
  maximumCases = MAX_HOST_PROMOTION_CASES,
): HostPromotionEvidenceFixture {
  if (
    !Number.isSafeInteger(maximumCases) ||
    maximumCases < 1 ||
    maximumCases > MAX_HOST_PROMOTION_CASES
  ) {
    throw malformedEvidence('Evidence case limit is invalid');
  }

  let binding: HostPromotionEvidenceBinding | undefined;
  const cases: HostPromotionEvidenceCase[] = [];
  const ordinals = new Set<number>();
  let lineStart = 0;
  let lineNumber = 0;
  for (let cursor = 0; cursor <= source.length; cursor += 1) {
    if (cursor < source.length && source.charCodeAt(cursor) !== 0x0a) {
      continue;
    }
    lineNumber += 1;
    let start = lineStart;
    let end = cursor;
    lineStart = cursor + 1;
    if (end > start && source.charCodeAt(end - 1) === 0x0d) end -= 1;
    while (start < end && isHorizontalWhitespace(source.charCodeAt(start))) {
      start += 1;
    }
    while (end > start && isHorizontalWhitespace(source.charCodeAt(end - 1))) {
      end -= 1;
    }
    if (start === end) continue;

    let value: JsonValue;
    try {
      value = parseStrictJson(source.slice(start, end), {
        maxDepth: 8,
        maxItems: MAX_EVIDENCE_LINE_ITEMS,
        maxStringCodeUnits: MAX_EVIDENCE_LINE_STRING_CODE_UNITS,
        maxNumberCodeUnits: 32,
      });
    } catch {
      throw malformedEvidence(`Evidence line ${lineNumber} is not strict JSON`);
    }

    const kind = dataField(value, 'kind');
    if (binding === undefined) {
      if (kind !== 'binding') {
        throw malformedEvidence('The first evidence record must be a binding');
      }
      binding = parseBinding(value);
      if (binding.expectedCases > maximumCases) {
        throw malformedEvidence('Evidence binding exceeds the case limit');
      }
      continue;
    }
    if (kind !== 'case') {
      throw malformedEvidence('Evidence contains more than one binding');
    }
    if (cases.length >= maximumCases) {
      throw malformedEvidence('Evidence exceeds the case limit');
    }
    const item = parseCase(value);
    if (item.ordinal >= binding.expectedCases) {
      throw malformedEvidence('Evidence case ordinal is outside the corpus');
    }
    if (ordinals.has(item.ordinal)) {
      throw malformedEvidence('Evidence contains a duplicate ordinal');
    }
    ordinals.add(item.ordinal);
    cases.push(item);
  }
  if (binding === undefined) {
    throw malformedEvidence('Evidence contains no binding');
  }
  cases.sort((left, right) => left.ordinal - right.ordinal);
  return freezeJson({ binding, cases });
}

export function parseHostPromotionEvidenceFixture(
  value: unknown,
): HostPromotionEvidenceFixture {
  try {
    const root = snapshotDataRecord(value, ['binding', 'cases']);
    const binding = parseBinding(root.binding);
    const caseValues = snapshotDenseDataArray(
      root.cases,
      0,
      MAX_HOST_PROMOTION_CASES,
    );
    if (binding.expectedCases > MAX_HOST_PROMOTION_CASES) {
      throw malformedEvidence('Evidence binding exceeds the case limit');
    }
    const ordinals = new Set<number>();
    const cases = caseValues.map((candidate) => {
      const item = parseCase(candidate);
      if (item.ordinal >= binding.expectedCases || ordinals.has(item.ordinal)) {
        throw malformedEvidence('Evidence contains an invalid ordinal');
      }
      ordinals.add(item.ordinal);
      return item;
    });
    cases.sort((left, right) => left.ordinal - right.ordinal);
    return freezeJson({ binding, cases });
  } catch (error) {
    if (error instanceof SemWitnessError) throw error;
    throw malformedEvidence('Evidence fixture is malformed');
  }
}

export function evaluateHostPromotionEvidence(input: {
  readonly policy: CodecPolicy;
  readonly fixture: HostPromotionEvidenceFixture;
}): HostPromotionWorkbenchResult {
  const policy = validatePolicy(input.policy);
  const fixture = parseHostPromotionEvidenceFixture(input.fixture);
  const binding = fixture.binding;
  const evaluatedPolicyDigest = digestPolicy(policy);
  const completeCases = fixture.cases.filter(isCompleteCase);
  const failedCases = fixture.cases.filter(isFailedCase);
  const declaredCodecKeys = new Set(binding.codecs.map(codecKey));
  const deploymentScopeMismatches = fixture.cases.filter(
    (item) => item.deploymentScopeDigest !== binding.deploymentScopeDigest,
  ).length;
  const undeclaredCodecCases = fixture.cases.filter(
    (item) => !declaredCodecKeys.has(codecKey(item.codec)),
  ).length;
  const unsafeAccepts = completeCases.filter(
    (item) => item.unsafeAccepted,
  ).length;
  const taskQualityRegressions = completeCases.filter(
    (item) => item.taskQualityRegression,
  ).length;
  const caseResults = fixture.cases.map((item) => evaluateCase(binding, item));
  const usageMetrics = summarizeUsage(completeCases, caseResults);
  const codecRefs = uniqueSortedCodecs([
    ...binding.codecs,
    ...fixture.cases.map((item) => item.codec),
  ]);
  const codecMetrics = codecRefs.map((codec) => ({
    codec,
    ...metricSlice(
      fixture.cases.filter((item) => codecKey(item.codec) === codecKey(codec)),
      caseResults,
    ),
  }));
  const presentStrata = uniqueSortedEnum(
    fixture.cases.map((item) => item.stratum),
  );
  const stratumMetrics = presentStrata.map((stratum) => ({
    stratum,
    ...metricSlice(
      fixture.cases.filter((item) => item.stratum === stratum),
      caseResults,
    ),
  }));
  const presentCacheRegimes = uniqueSortedEnum(
    fixture.cases.map((item) => item.cacheRegime),
  );
  const cacheRegimeMetrics = presentCacheRegimes.map((cacheRegime) => ({
    cacheRegime,
    ...metricSlice(
      fixture.cases.filter((item) => item.cacheRegime === cacheRegime),
      caseResults,
    ),
  }));

  const reasons: HostPromotionGateReason[] = [];
  const addReason = (reason: HostPromotionGateReason): void => {
    if (!reasons.includes(reason)) reasons.push(reason);
  };
  if (
    binding.artifact.id !== HOST_PREPARER_ARTIFACT.id ||
    binding.artifact.version !== HOST_PREPARER_ARTIFACT.version
  ) {
    addReason('ARTIFACT_MISMATCH');
  }
  if (policy.mode !== 'apply-verified') {
    addReason('POLICY_NOT_APPLY_VERIFIED');
  }
  if (binding.policyDigest !== evaluatedPolicyDigest) {
    addReason('POLICY_DIGEST_MISMATCH');
  }
  if (binding.tokenizer.id !== policy.tokenizerId) {
    addReason('TOKENIZER_MISMATCH');
  }
  if (binding.tokenizer.reliability !== 'exact') {
    addReason('TOKENIZER_NOT_EXACT');
  }
  if (
    binding.usageEvidence.reliability !== 'exact' ||
    binding.usageEvidence.source === 'estimate'
  ) {
    addReason('USAGE_NOT_EXACT');
  }
  if (binding.split !== 'held-out') addReason('SPLIT_NOT_HELD_OUT');
  if (binding.design.pairing !== 'paired' || binding.design.order === 'fixed') {
    addReason('EVALUATION_DESIGN_INVALID');
  }
  if (binding.expectedCases < MIN_HOST_PROMOTION_CASES) {
    addReason('CORPUS_TOO_SMALL');
  }
  if (!hasCompleteOrdinalRange(fixture)) addReason('INCOMPLETE_CORPUS');
  if (
    binding.design.requiredStrata.some(
      (stratum) => !presentStrata.includes(stratum),
    )
  ) {
    addReason('MISSING_REQUIRED_STRATUM');
  }
  if (
    binding.design.requiredCacheRegimes.some(
      (regime) => !presentCacheRegimes.includes(regime),
    )
  ) {
    addReason('MISSING_REQUIRED_CACHE_REGIME');
  }
  if (failedCases.length > 0) addReason('EXECUTION_FAILURES');
  if (deploymentScopeMismatches > 0) {
    addReason('DEPLOYMENT_SCOPE_MISMATCH');
  }
  if (binding.codecs.some((codec) => !isHostActiveCodec(codec))) {
    addReason('UNSUPPORTED_ACTIVE_CODEC');
  }
  if (undeclaredCodecCases > 0) addReason('UNDECLARED_CODEC_EVIDENCE');
  if (binding.codecs.some((codec) => !policyAllowsCodec(policy, codec))) {
    addReason('CODEC_NOT_ALLOWED_BY_POLICY');
  }
  if (
    binding.codecs.some(
      (codec) =>
        !completeCases.some((item) => codecKey(item.codec) === codecKey(codec)),
    )
  ) {
    addReason('UNEVALUATED_CODEC');
  }
  if (unsafeAccepts > 0) addReason('UNSAFE_ACCEPTS');
  if (taskQualityRegressions > 0) addReason('TASK_QUALITY_REGRESSIONS');
  if (
    binding.gate.minimumMedianNetSavingsRatioPpm <
    MIN_HOST_PROMOTION_SAVINGS_RATIO_PPM
  ) {
    addReason('PROMOTION_THRESHOLD_TOO_LOW');
  }
  const effectiveSavingsThreshold = Math.max(
    binding.gate.minimumMedianNetSavingsRatioPpm,
    MIN_HOST_PROMOTION_SAVINGS_RATIO_PPM,
  );
  if (
    usageMetrics.medianNetSavingsRatioPpm === null ||
    usageMetrics.medianNetSavingsRatioPpm < effectiveSavingsThreshold
  ) {
    addReason('NET_SAVINGS_BELOW_THRESHOLD');
  }
  if (
    binding.codecs.some((codec) => {
      const metrics = codecMetrics.find(
        (item) => codecKey(item.codec) === codecKey(codec),
      );
      return (
        metrics === undefined ||
        metrics.medianNetSavingsRatioPpm === null ||
        metrics.medianNetSavingsRatioPpm < effectiveSavingsThreshold
      );
    })
  ) {
    addReason('CODEC_NET_SAVINGS_BELOW_THRESHOLD');
  }
  if (
    usageMetrics.medianLatencyRegressionRatioPpm === null ||
    usageMetrics.medianLatencyRegressionRatioPpm >
      binding.gate.maximumMedianLatencyRegressionRatioPpm
  ) {
    addReason('LATENCY_REGRESSION_ABOVE_THRESHOLD');
  }

  const orderedReasons = HOST_PROMOTION_GATE_REASONS.filter((reason) =>
    reasons.includes(reason),
  );
  const report = freezeJson<HostPromotionEvaluationReport>({
    schema: HOST_PROMOTION_EVALUATION_REPORT_SCHEMA,
    provenance: 'host-attested-unsigned',
    binding,
    evaluatedPolicyDigest,
    caseMetrics: {
      expected: binding.expectedCases,
      observed: fixture.cases.length,
      complete: completeCases.length,
      failed: failedCases.length,
      applied: completeCases.filter((item) => item.decision === 'applied')
        .length,
      bypassed: completeCases.filter((item) => item.decision === 'bypassed')
        .length,
      unsafeAccepts,
      taskQualityRegressions,
      deploymentScopeMismatches,
      undeclaredCodecCases,
    },
    usageMetrics,
    codecMetrics,
    stratumMetrics,
    cacheRegimeMetrics,
    gate: { passed: orderedReasons.length === 0, reasons: orderedReasons },
    cases: caseResults,
  });
  const reportDigest = hashCanonical(toJsonValue(report));
  if (!report.gate.passed) {
    return freezeJson({
      schema: HOST_PROMOTION_WORKBENCH_RESULT_SCHEMA,
      qualified: false,
      report,
      reportDigest,
    });
  }

  const medianNetSavingsRatioPpm = report.usageMetrics.medianNetSavingsRatioPpm;
  if (medianNetSavingsRatioPpm === null) {
    throw malformedEvidence('Qualified report omitted its net savings metric');
  }
  const promotion = parseHostPromotionManifest({
    schema: 'semwitness.dev/host-promotion/v1alpha1',
    artifact: binding.artifact,
    policyDigest: evaluatedPolicyDigest,
    deploymentScopeDigest: binding.deploymentScopeDigest,
    tokenizer: {
      id: binding.tokenizer.id,
      fingerprint: binding.tokenizer.fingerprint,
    },
    codecs: binding.codecs,
    evaluation: {
      corpusDigest: binding.corpusDigest,
      reportDigest,
      split: 'held-out',
      unsafeAccepts: 0,
      taskQualityRegressions: 0,
      medianNetSavingsRatioPpm,
    },
  });
  return freezeJson({
    schema: HOST_PROMOTION_WORKBENCH_RESULT_SCHEMA,
    qualified: true,
    report,
    reportDigest,
    promotion,
    promotionDigest: digestHostPromotionManifest(promotion),
  });
}

function parseBinding(value: unknown): HostPromotionEvidenceBinding {
  try {
    const root = snapshotDataRecord(value, BINDING_FIELDS);
    if (
      root.schema !== HOST_PROMOTION_EVIDENCE_SCHEMA ||
      root.kind !== 'binding' ||
      !isSha256Digest(root.policyDigest) ||
      !isSha256Digest(root.deploymentScopeDigest) ||
      !isSha256Digest(root.corpusDigest) ||
      !isSha256Digest(root.evaluationProtocolDigest)
    ) {
      throw malformedEvidence('Evidence binding identity is invalid');
    }
    const artifact = parseArtifact(root.artifact);
    const usageEvidenceRecord = snapshotDataRecord(root.usageEvidence, [
      'source',
      'reliability',
    ]);
    if (
      !isOneOf(usageEvidenceRecord.source, [
        'provider-response',
        'runtime-accounting',
        'estimate',
      ] as const) ||
      !isOneOf(usageEvidenceRecord.reliability, ['exact', 'estimated'] as const)
    ) {
      throw malformedEvidence('Usage evidence binding is invalid');
    }
    const tokenizerRecord = snapshotDataRecord(root.tokenizer, [
      'id',
      'fingerprint',
      'reliability',
    ]);
    if (
      typeof tokenizerRecord.id !== 'string' ||
      !TOKENIZER_ID_PATTERN.test(tokenizerRecord.id) ||
      !isSafeTokenizerFingerprint(tokenizerRecord.fingerprint) ||
      !isOneOf(tokenizerRecord.reliability, [
        'exact',
        'heuristic',
        'estimated',
      ] as const)
    ) {
      throw malformedEvidence('Tokenizer binding is invalid');
    }
    const designRecord = snapshotDataRecord(root.design, [
      'pairing',
      'order',
      'requiredStrata',
      'requiredCacheRegimes',
    ]);
    if (
      !isOneOf(designRecord.pairing, ['paired', 'unpaired'] as const) ||
      !isOneOf(designRecord.order, [
        'randomized',
        'counterbalanced',
        'fixed',
      ] as const)
    ) {
      throw malformedEvidence('Evaluation design is invalid');
    }
    const requiredStrata = parseEnumArray(
      designRecord.requiredStrata,
      HOST_PROMOTION_DIFFICULTY_STRATA,
    );
    const requiredCacheRegimes = parseEnumArray(
      designRecord.requiredCacheRegimes,
      HOST_PROMOTION_CACHE_REGIMES,
    );
    const gateRecord = snapshotDataRecord(root.gate, [
      'minimumMedianNetSavingsRatioPpm',
      'maximumMedianLatencyRegressionRatioPpm',
    ]);
    const minimumMedianNetSavingsRatioPpm = integerWithin(
      gateRecord.minimumMedianNetSavingsRatioPpm,
      0,
      1_000_000,
    );
    const maximumMedianLatencyRegressionRatioPpm = integerWithin(
      gateRecord.maximumMedianLatencyRegressionRatioPpm,
      -1_000_000,
      MAX_CONFIGURED_LATENCY_RATIO_PPM,
    );
    const expectedCases = integerWithin(
      root.expectedCases,
      1,
      MAX_HOST_PROMOTION_CASES,
    );
    if (
      !isOneOf(root.split, ['held-out', 'development', 'conformance'] as const)
    ) {
      throw malformedEvidence('Evidence split is invalid');
    }
    return {
      schema: HOST_PROMOTION_EVIDENCE_SCHEMA,
      kind: 'binding',
      artifact,
      policyDigest: root.policyDigest,
      deploymentScopeDigest: root.deploymentScopeDigest,
      corpusDigest: root.corpusDigest,
      evaluationProtocolDigest: root.evaluationProtocolDigest,
      split: root.split,
      usageEvidence: {
        source: usageEvidenceRecord.source,
        reliability: usageEvidenceRecord.reliability,
      },
      expectedCases,
      tokenizer: {
        id: tokenizerRecord.id,
        fingerprint: tokenizerRecord.fingerprint,
        reliability: tokenizerRecord.reliability,
      },
      codecs: parseCodecs(root.codecs),
      design: {
        pairing: designRecord.pairing,
        order: designRecord.order,
        requiredStrata,
        requiredCacheRegimes,
      },
      gate: {
        minimumMedianNetSavingsRatioPpm,
        maximumMedianLatencyRegressionRatioPpm,
      },
    };
  } catch (error) {
    if (error instanceof SemWitnessError) throw error;
    throw malformedEvidence('Evidence binding is malformed');
  }
}

function parseCase(value: unknown): HostPromotionEvidenceCase {
  try {
    const status = dataField(value, 'status');
    if (status === 'complete') {
      const root = snapshotDataRecord(value, COMPLETE_CASE_FIELDS);
      const base = parseCaseBase(root);
      if (root.decision !== 'applied' && root.decision !== 'bypassed') {
        throw malformedEvidence('Evidence decision is invalid');
      }
      if (
        typeof root.unsafeAccepted !== 'boolean' ||
        typeof root.taskQualityRegression !== 'boolean' ||
        !isSha256Digest(root.qualityEvidenceDigest)
      ) {
        throw malformedEvidence('Evidence quality result is invalid');
      }
      return {
        ...base,
        status: 'complete',
        decision: root.decision,
        baseline: parseUsage(root.baseline, true),
        candidate: parseUsage(root.candidate, false),
        unsafeAccepted: root.unsafeAccepted,
        taskQualityRegression: root.taskQualityRegression,
        qualityEvidenceDigest: root.qualityEvidenceDigest,
      };
    }
    if (status === 'failed') {
      const root = snapshotDataRecord(value, FAILED_CASE_FIELDS);
      const base = parseCaseBase(root);
      if (
        !isOneOf(root.failureReason, HOST_PROMOTION_EXECUTION_FAILURE_REASONS)
      ) {
        throw malformedEvidence('Execution failure reason is invalid');
      }
      return { ...base, status: 'failed', failureReason: root.failureReason };
    }
    throw malformedEvidence('Evidence case status is invalid');
  } catch (error) {
    if (error instanceof SemWitnessError) throw error;
    throw malformedEvidence('Evidence case is malformed');
  }
}

function parseCaseBase(
  root: Readonly<Record<string, unknown>>,
): HostPromotionCaseBase {
  if (
    root.schema !== HOST_PROMOTION_EVIDENCE_SCHEMA ||
    root.kind !== 'case' ||
    !isOneOf(root.stratum, HOST_PROMOTION_DIFFICULTY_STRATA) ||
    !isOneOf(root.cacheRegime, HOST_PROMOTION_CACHE_REGIMES) ||
    !isSha256Digest(root.deploymentScopeDigest)
  ) {
    throw malformedEvidence('Evidence case binding is invalid');
  }
  return {
    schema: HOST_PROMOTION_EVIDENCE_SCHEMA,
    kind: 'case',
    ordinal: integerWithin(root.ordinal, 0, MAX_HOST_PROMOTION_CASES - 1),
    stratum: root.stratum,
    cacheRegime: root.cacheRegime,
    codec: parseCodec(root.codec),
    deploymentScopeDigest: root.deploymentScopeDigest,
  };
}

function parseUsage(
  value: unknown,
  requirePositiveTotals: boolean,
): HostPromotionUsageObservation {
  const root = snapshotDataRecord(value, USAGE_FIELDS);
  if (!isSha256Digest(root.traceDigest)) {
    throw malformedEvidence('Usage trace digest is invalid');
  }
  const totalInputTokens = integerWithin(
    root.totalInputTokens,
    requirePositiveTotals ? 1 : 0,
    Number.MAX_SAFE_INTEGER,
  );
  const cacheReadInputTokens = integerWithin(
    root.cacheReadInputTokens,
    0,
    Number.MAX_SAFE_INTEGER,
  );
  const cacheWriteInputTokens = integerWithin(
    root.cacheWriteInputTokens,
    0,
    Number.MAX_SAFE_INTEGER,
  );
  const totalOutputTokens = integerWithin(
    root.totalOutputTokens,
    0,
    Number.MAX_SAFE_INTEGER,
  );
  const reasoningOutputTokens = integerWithin(
    root.reasoningOutputTokens,
    0,
    Number.MAX_SAFE_INTEGER,
  );
  const normalizedCostUnits = integerWithin(
    root.normalizedCostUnits,
    requirePositiveTotals ? 1 : 0,
    Number.MAX_SAFE_INTEGER,
  );
  const endToEndLatencyMicros = integerWithin(
    root.endToEndLatencyMicros,
    1,
    Number.MAX_SAFE_INTEGER,
  );
  const compressorLatencyMicros = integerWithin(
    root.compressorLatencyMicros,
    0,
    Number.MAX_SAFE_INTEGER,
  );
  const attempts = integerWithin(root.attempts, 1, 1_000_000);
  const retryCount = integerWithin(root.retryCount, 0, attempts - 1);
  const recoveryCount = integerWithin(root.recoveryCount, 0, attempts - 1);
  if (
    BigInt(cacheReadInputTokens) + BigInt(cacheWriteInputTokens) >
      BigInt(totalInputTokens) ||
    reasoningOutputTokens > totalOutputTokens ||
    compressorLatencyMicros > endToEndLatencyMicros
  ) {
    throw malformedEvidence('Usage accounting invariants are invalid');
  }
  return {
    traceDigest: root.traceDigest,
    totalInputTokens,
    cacheReadInputTokens,
    cacheWriteInputTokens,
    totalOutputTokens,
    reasoningOutputTokens,
    normalizedCostUnits,
    endToEndLatencyMicros,
    compressorLatencyMicros,
    attempts,
    retryCount,
    recoveryCount,
  };
}

function parseArtifact(value: unknown): {
  readonly id: string;
  readonly version: string;
} {
  const root = snapshotDataRecord(value, ['id', 'version']);
  if (
    typeof root.id !== 'string' ||
    !SAFE_IDENTIFIER_PATTERN.test(root.id) ||
    typeof root.version !== 'string' ||
    !SAFE_VERSION_PATTERN.test(root.version)
  ) {
    throw malformedEvidence('Evidence artifact is invalid');
  }
  return { id: root.id, version: root.version };
}

function parseCodecs(value: unknown): readonly HostPromotionCodecRef[] {
  const values = snapshotDenseDataArray(value, 1, MAX_CODEC_COUNT);
  return uniqueSortedCodecs(values.map(parseCodec), true);
}

function parseCodec(value: unknown): HostPromotionCodecRef {
  const root = snapshotDataRecord(value, ['id', 'version']);
  if (
    typeof root.id !== 'string' ||
    !CODEC_ID_PATTERN.test(root.id) ||
    typeof root.version !== 'string' ||
    !SAFE_VERSION_PATTERN.test(root.version)
  ) {
    throw malformedEvidence('Evidence codec is invalid');
  }
  return { id: root.id, version: root.version };
}

function evaluateCase(
  binding: HostPromotionEvidenceBinding,
  item: HostPromotionEvidenceCase,
): HostPromotionCaseResult {
  const common = {
    caseRef: sha256(
      `semwitness.dev/host-promotion-case-ref/v1\0${binding.corpusDigest}\0${item.ordinal}`,
    ),
    ordinal: item.ordinal,
    status: item.status,
    stratum: item.stratum,
    cacheRegime: item.cacheRegime,
    codec: item.codec,
    deploymentScopeMatched:
      item.deploymentScopeDigest === binding.deploymentScopeDigest,
    evidenceDigest: hashCanonical(toJsonValue(item)),
  } as const;
  if (item.status === 'failed') {
    return { ...common, status: 'failed', failureReason: item.failureReason };
  }
  const inputSavingsRatioPpm = savingsRatioPpm(
    item.baseline.totalInputTokens,
    item.candidate.totalInputTokens,
  );
  const costSavingsRatioPpm = savingsRatioPpm(
    item.baseline.normalizedCostUnits,
    item.candidate.normalizedCostUnits,
  );
  const measuredNetSavingsRatioPpm = Math.min(
    inputSavingsRatioPpm,
    costSavingsRatioPpm,
  );
  const netSavingsRatioPpm =
    item.decision === 'applied'
      ? measuredNetSavingsRatioPpm
      : Math.min(0, measuredNetSavingsRatioPpm);
  return {
    ...common,
    status: 'complete',
    decision: item.decision,
    inputSavingsRatioPpm,
    costSavingsRatioPpm,
    netSavingsRatioPpm,
    latencyRegressionRatioPpm: latencyRegressionRatioPpm(
      item.baseline.endToEndLatencyMicros,
      item.candidate.endToEndLatencyMicros,
    ),
  };
}

function summarizeUsage(
  cases: readonly HostPromotionCompleteCase[],
  results: readonly HostPromotionCaseResult[],
): HostPromotionEvaluationReport['usageMetrics'] {
  const completedResults = results.filter(hasCompletedMetrics);
  return {
    baseline: sumUsage(cases.map((item) => item.baseline)),
    candidate: sumUsage(cases.map((item) => item.candidate)),
    medianInputSavingsRatioPpm: median(
      completedResults.map((item) => item.inputSavingsRatioPpm),
    ),
    medianCostSavingsRatioPpm: median(
      completedResults.map((item) => item.costSavingsRatioPpm),
    ),
    medianNetSavingsRatioPpm: median(
      completedResults.map((item) => item.netSavingsRatioPpm),
    ),
    medianLatencyRegressionRatioPpm: median(
      completedResults.map((item) => item.latencyRegressionRatioPpm),
    ),
  };
}

function metricSlice(
  cases: readonly HostPromotionEvidenceCase[],
  results: readonly HostPromotionCaseResult[],
): HostPromotionMetricSlice {
  const ordinals = new Set(cases.map((item) => item.ordinal));
  const selectedResults = results.filter((item) => ordinals.has(item.ordinal));
  const completedResults = selectedResults.filter(hasCompletedMetrics);
  const completeCases = cases.filter(isCompleteCase);
  return {
    caseCount: cases.length,
    complete: completeCases.length,
    failed: cases.length - completeCases.length,
    applied: completeCases.filter((item) => item.decision === 'applied').length,
    bypassed: completeCases.filter((item) => item.decision === 'bypassed')
      .length,
    medianInputSavingsRatioPpm: median(
      completedResults.map((item) => item.inputSavingsRatioPpm),
    ),
    medianCostSavingsRatioPpm: median(
      completedResults.map((item) => item.costSavingsRatioPpm),
    ),
    medianNetSavingsRatioPpm: median(
      completedResults.map((item) => item.netSavingsRatioPpm),
    ),
    medianLatencyRegressionRatioPpm: median(
      completedResults.map((item) => item.latencyRegressionRatioPpm),
    ),
  };
}

function sumUsage(
  values: readonly HostPromotionUsageObservation[],
): HostPromotionUsageTotals {
  const sum = (select: (item: HostPromotionUsageObservation) => number) =>
    values.reduce((total, item) => total + BigInt(select(item)), 0n).toString();
  return {
    totalInputTokens: sum((item) => item.totalInputTokens),
    cacheReadInputTokens: sum((item) => item.cacheReadInputTokens),
    cacheWriteInputTokens: sum((item) => item.cacheWriteInputTokens),
    totalOutputTokens: sum((item) => item.totalOutputTokens),
    reasoningOutputTokens: sum((item) => item.reasoningOutputTokens),
    normalizedCostUnits: sum((item) => item.normalizedCostUnits),
    endToEndLatencyMicros: sum((item) => item.endToEndLatencyMicros),
    compressorLatencyMicros: sum((item) => item.compressorLatencyMicros),
    attempts: sum((item) => item.attempts),
    retryCount: sum((item) => item.retryCount),
    recoveryCount: sum((item) => item.recoveryCount),
  };
}

function savingsRatioPpm(baseline: number, candidate: number): number {
  const ratio =
    ((BigInt(baseline) - BigInt(candidate)) * 1_000_000n) / BigInt(baseline);
  return Number(clampBigInt(ratio, -1_000_000n, 1_000_000n));
}

function latencyRegressionRatioPpm(
  baseline: number,
  candidate: number,
): number {
  const ratio =
    ((BigInt(candidate) - BigInt(baseline)) * 1_000_000n) / BigInt(baseline);
  return Number(clampBigInt(ratio, -1_000_000n, BigInt(MAX_LATENCY_RATIO_PPM)));
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle];
  if (upper === undefined) return null;
  if (sorted.length % 2 === 1) return upper;
  const lower = sorted[middle - 1];
  if (lower === undefined) return null;
  return Math.floor((lower + upper) / 2);
}

function policyAllowsCodec(
  policy: CodecPolicy,
  codec: HostPromotionCodecRef,
): boolean {
  return TRUST_LEVELS.some((trust) => {
    const rule = firstActiveRule(policy.rules, trust);
    return (
      rule !== undefined &&
      rule.codecs.includes(codec.id) &&
      rule.allowEquivalence.includes('typed-semantic')
    );
  });
}

function firstActiveRule(
  rules: readonly PolicyRule[],
  trust: TrustLevel,
): PolicyRule | undefined {
  return rules.find(
    (rule) =>
      (rule.match.roles === undefined || rule.match.roles.includes('tool')) &&
      (rule.match.kinds === undefined ||
        rule.match.kinds.includes('json-data')) &&
      (rule.match.trust === undefined || rule.match.trust.includes(trust)),
  );
}

function hasCompleteOrdinalRange(
  fixture: HostPromotionEvidenceFixture,
): boolean {
  if (fixture.cases.length !== fixture.binding.expectedCases) return false;
  return fixture.cases.every((item, index) => item.ordinal === index);
}

function parseEnumArray<const Value extends string>(
  value: unknown,
  allowed: readonly Value[],
): readonly Value[] {
  const values = snapshotDenseDataArray(value, 1, allowed.length);
  if (!values.every((item): item is Value => isOneOf(item, allowed))) {
    throw malformedEvidence('Evidence enum array is invalid');
  }
  if (new Set(values).size !== values.length) {
    throw malformedEvidence('Evidence enum array contains duplicates');
  }
  return [...values].sort(compareCodeUnits);
}

function uniqueSortedEnum<Value extends string>(
  values: readonly Value[],
): readonly Value[] {
  return [...new Set(values)].sort(compareCodeUnits);
}

function uniqueSortedCodecs(
  values: readonly HostPromotionCodecRef[],
  rejectDuplicates = false,
): readonly HostPromotionCodecRef[] {
  const byKey = new Map<string, HostPromotionCodecRef>();
  for (const value of values) {
    const key = codecKey(value);
    if (rejectDuplicates && byKey.has(key)) {
      throw malformedEvidence('Evidence codec list contains duplicates');
    }
    byKey.set(key, value);
  }
  return [...byKey.values()].sort(compareCodec);
}

function compareCodec(
  left: HostPromotionCodecRef,
  right: HostPromotionCodecRef,
): number {
  const idOrder = compareCodeUnits(left.id, right.id);
  return idOrder === 0
    ? compareCodeUnits(left.version, right.version)
    : idOrder;
}

function codecKey(value: HostPromotionCodecRef): string {
  return `${value.id}\0${value.version}`;
}

function dataField(value: unknown, field: string): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw malformedEvidence('Evidence record must be an object');
  }
  const descriptor = Reflect.getOwnPropertyDescriptor(value, field);
  if (
    descriptor === undefined ||
    !descriptor.enumerable ||
    !Object.hasOwn(descriptor, 'value') ||
    Object.hasOwn(descriptor, 'get') ||
    Object.hasOwn(descriptor, 'set')
  ) {
    throw malformedEvidence('Evidence discriminator is invalid');
  }
  return descriptor.value;
}

function integerWithin(
  value: unknown,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    Object.is(value, -0) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw malformedEvidence('Evidence integer is outside its bound');
  }
  return value as number;
}

function isOneOf<const Value extends string>(
  value: unknown,
  allowed: readonly Value[],
): value is Value {
  return (
    typeof value === 'string' && (allowed as readonly string[]).includes(value)
  );
}

function isHorizontalWhitespace(codeUnit: number): boolean {
  return codeUnit === 0x20 || codeUnit === 0x09;
}

function isCompleteCase(
  value: HostPromotionEvidenceCase,
): value is HostPromotionCompleteCase {
  return value.status === 'complete';
}

function isFailedCase(
  value: HostPromotionEvidenceCase,
): value is HostPromotionFailedCase {
  return value.status === 'failed';
}

function hasCompletedMetrics(
  value: HostPromotionCaseResult,
): value is HostPromotionCaseResult & {
  readonly decision: 'applied' | 'bypassed';
  readonly inputSavingsRatioPpm: number;
  readonly costSavingsRatioPpm: number;
  readonly netSavingsRatioPpm: number;
  readonly latencyRegressionRatioPpm: number;
} {
  return value.status === 'complete';
}

function clampBigInt(value: bigint, minimum: bigint, maximum: bigint): bigint {
  return value < minimum ? minimum : value > maximum ? maximum : value;
}

function freezeJson<Value>(value: Value): Value {
  return immutableJson(toJsonValue(value)) as unknown as Value;
}

function malformedEvidence(message: string): SemWitnessError {
  return new SemWitnessError('MALFORMED_ENVELOPE', message);
}
