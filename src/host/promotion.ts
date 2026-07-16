import { toJsonValue } from '../domain/canonical-json.js';
import { compareCodeUnits } from '../domain/deterministic-order.js';
import { SemWitnessError } from '../domain/errors.js';
import { hashCanonical, isSha256Digest } from '../domain/hash.js';
import {
  SAFE_IDENTIFIER_PATTERN,
  SAFE_VERSION_PATTERN,
  type Sha256Digest,
} from '../domain/types.js';
import { isSafeTokenizerFingerprint } from '../ports/tokenizer.js';
import { snapshotDataRecord, snapshotDenseDataArray } from './data-only.js';
import type { HostPromotionManifest } from './types.js';

export const HOST_PREPARER_ARTIFACT = Object.freeze({
  id: 'semwitness-text-request-preparer',
  version: '1',
} as const);

export const HOST_ACTIVE_CODECS = Object.freeze([
  Object.freeze({ id: 'json-jcs', version: '1' }),
] as const);

export const MIN_HOST_PROMOTION_SAVINGS_RATIO_PPM = 100_000;

const MANIFEST_SCHEMA = 'semwitness.dev/host-promotion/v1alpha1' as const;
const ROOT_FIELDS = [
  'schema',
  'artifact',
  'policyDigest',
  'deploymentScopeDigest',
  'tokenizer',
  'codecs',
  'evaluation',
] as const;
const ARTIFACT_FIELDS = ['id', 'version'] as const;
const TOKENIZER_FIELDS = ['id', 'fingerprint'] as const;
const CODEC_FIELDS = ['id', 'version'] as const;
const EVALUATION_FIELDS = [
  'corpusDigest',
  'reportDigest',
  'split',
  'unsafeAccepts',
  'taskQualityRegressions',
  'medianNetSavingsRatioPpm',
] as const;
const TOKENIZER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const CODEC_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const MAX_PROMOTED_CODECS = 128;

export function parseHostPromotionManifest(
  value: unknown,
): HostPromotionManifest {
  try {
    return parseManifest(value);
  } catch {
    throw malformed();
  }
}

export function digestHostPromotionManifest(value: unknown): Sha256Digest {
  const manifest = parseHostPromotionManifest(value);
  return hashCanonical(toJsonValue(manifest));
}

function parseManifest(value: unknown): HostPromotionManifest {
  const root = snapshotDataRecord(value, ROOT_FIELDS);
  const schema = root.schema;
  const policyDigest = root.policyDigest;
  const deploymentScopeDigest = root.deploymentScopeDigest;
  if (
    schema !== MANIFEST_SCHEMA ||
    !isSha256Digest(policyDigest) ||
    !isSha256Digest(deploymentScopeDigest)
  ) {
    throw malformed();
  }

  const artifactRecord = snapshotDataRecord(root.artifact, ARTIFACT_FIELDS);
  const artifactId = artifactRecord.id;
  const artifactVersion = artifactRecord.version;
  if (
    typeof artifactId !== 'string' ||
    !SAFE_IDENTIFIER_PATTERN.test(artifactId) ||
    typeof artifactVersion !== 'string' ||
    !SAFE_VERSION_PATTERN.test(artifactVersion)
  ) {
    throw malformed();
  }

  const tokenizerRecord = snapshotDataRecord(root.tokenizer, TOKENIZER_FIELDS);
  const tokenizerId = tokenizerRecord.id;
  const tokenizerFingerprint = tokenizerRecord.fingerprint;
  if (
    typeof tokenizerId !== 'string' ||
    !TOKENIZER_ID_PATTERN.test(tokenizerId) ||
    !isSafeTokenizerFingerprint(tokenizerFingerprint)
  ) {
    throw malformed();
  }

  const codecValues = snapshotDenseDataArray(
    root.codecs,
    1,
    MAX_PROMOTED_CODECS,
  );
  const codecs = codecValues.map((candidate) => {
    const codecRecord = snapshotDataRecord(candidate, CODEC_FIELDS);
    const id = codecRecord.id;
    const version = codecRecord.version;
    if (
      typeof id !== 'string' ||
      !CODEC_ID_PATTERN.test(id) ||
      typeof version !== 'string' ||
      !SAFE_VERSION_PATTERN.test(version)
    ) {
      throw malformed();
    }
    return Object.freeze({ id, version });
  });
  for (let index = 1; index < codecs.length; index += 1) {
    if (compareCodec(codecAt(codecs, index - 1), codecAt(codecs, index)) >= 0) {
      throw malformed();
    }
  }

  const evaluationRecord = snapshotDataRecord(
    root.evaluation,
    EVALUATION_FIELDS,
  );
  const corpusDigest = evaluationRecord.corpusDigest;
  const reportDigest = evaluationRecord.reportDigest;
  const split = evaluationRecord.split;
  const unsafeAccepts = evaluationRecord.unsafeAccepts;
  const taskQualityRegressions = evaluationRecord.taskQualityRegressions;
  const medianNetSavingsRatioPpm = evaluationRecord.medianNetSavingsRatioPpm;
  if (
    !isSha256Digest(corpusDigest) ||
    !isSha256Digest(reportDigest) ||
    split !== 'held-out' ||
    unsafeAccepts !== 0 ||
    taskQualityRegressions !== 0 ||
    !Number.isSafeInteger(medianNetSavingsRatioPpm) ||
    (medianNetSavingsRatioPpm as number) <
      MIN_HOST_PROMOTION_SAVINGS_RATIO_PPM ||
    (medianNetSavingsRatioPpm as number) > 1_000_000
  ) {
    throw malformed();
  }

  return Object.freeze({
    schema: MANIFEST_SCHEMA,
    artifact: Object.freeze({
      id: artifactId,
      version: artifactVersion,
    }),
    policyDigest,
    deploymentScopeDigest,
    tokenizer: Object.freeze({
      id: tokenizerId,
      fingerprint: tokenizerFingerprint,
    }),
    codecs: Object.freeze(codecs),
    evaluation: Object.freeze({
      corpusDigest,
      reportDigest,
      split: 'held-out',
      unsafeAccepts: 0,
      taskQualityRegressions: 0,
      medianNetSavingsRatioPpm: medianNetSavingsRatioPpm as number,
    }),
  });
}

export function isHostActiveCodec(value: {
  readonly id: string;
  readonly version: string;
}): boolean {
  return HOST_ACTIVE_CODECS.some(
    (codec) => codec.id === value.id && codec.version === value.version,
  );
}

function compareCodec(
  left: { readonly id: string; readonly version: string },
  right: { readonly id: string; readonly version: string },
): number {
  const idOrder = compareCodeUnits(left.id, right.id);
  return idOrder === 0
    ? compareCodeUnits(left.version, right.version)
    : idOrder;
}

function codecAt(
  codecs: readonly { readonly id: string; readonly version: string }[],
  index: number,
): { readonly id: string; readonly version: string } {
  const codec = codecs[index];
  if (codec === undefined) {
    throw malformed();
  }
  return codec;
}

function malformed(): SemWitnessError {
  return new SemWitnessError(
    'MALFORMED_ENVELOPE',
    'Host promotion manifest is malformed',
  );
}
