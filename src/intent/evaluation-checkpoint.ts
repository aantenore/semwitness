import { toJsonValue } from '../domain/canonical-json.js';
import { hashCanonical, isSha256Digest, sha256 } from '../domain/hash.js';
import type { Sha256Digest } from '../domain/types.js';
import {
  INTENT_EVALUATION_CHECKPOINT_CLAIM_SCHEMA,
  INTENT_EVALUATION_CHECKPOINT_SCHEMA,
  type IntentEvaluationCheckpoint,
  type IntentEvaluationCheckpointClaim,
  type IntentEvaluationCheckpointObservation,
} from './normalizer-types.js';
import { INTENT_REASON_CODES, type IntentReasonCode } from './types.js';

const intentReasonCodeSet: ReadonlySet<string> = new Set(INTENT_REASON_CODES);
const unavailableContractDigest = sha256(
  'semwitness.dev/intent-normalizer-evaluation/unavailable-contract/v1',
);
const unavailableNormalizerBindingDigest = sha256(
  'semwitness.dev/intent-normalizer-evaluation/unavailable-normalizer/v1',
);
const unavailableOntologyBindingDigest = sha256(
  'semwitness.dev/intent-normalizer-evaluation/unavailable-ontology/v1',
);

export function intentEvaluationCheckpointReference(
  evaluationBindingDigest: Sha256Digest,
  caseRef: Sha256Digest,
  attemptOrdinal: number,
): Sha256Digest {
  return sha256(
    `semwitness.dev/intent-eval-checkpoint-ref/v1\0${evaluationBindingDigest}\0${caseRef}\0${attemptOrdinal}`,
  );
}

export function createIntentEvaluationCheckpointClaim(
  checkpointRef: Sha256Digest,
  evaluationBindingDigest: Sha256Digest,
  caseRef: Sha256Digest,
  attemptOrdinal: number,
): IntentEvaluationCheckpointClaim {
  const payload = {
    schema: INTENT_EVALUATION_CHECKPOINT_CLAIM_SCHEMA,
    checkpointRef,
    evaluationBindingDigest,
    caseRef,
    attemptOrdinal,
  } as const;
  return Object.freeze({
    ...payload,
    claimDigest: hashCanonical(toJsonValue(payload)),
  });
}

export function createIntentEvaluationCheckpoint(
  checkpointRef: Sha256Digest,
  evaluationBindingDigest: Sha256Digest,
  caseRef: Sha256Digest,
  attemptOrdinal: number,
  observation: IntentEvaluationCheckpointObservation,
): IntentEvaluationCheckpoint {
  const checkpointObservation = Object.freeze({
    actual: observation.actual,
    fingerprint: observation.fingerprint,
    ...(observation.intentDigest === undefined
      ? {}
      : { intentDigest: observation.intentDigest }),
    reasons: Object.freeze([...observation.reasons]),
    executionFailure: observation.executionFailure,
    contractDigest: observation.contractDigest,
    normalizerBindingDigest: observation.normalizerBindingDigest,
    ontologyBindingDigest: observation.ontologyBindingDigest,
  });
  const payload = {
    schema: INTENT_EVALUATION_CHECKPOINT_SCHEMA,
    mode: 'shadow',
    activeCacheQualified: false,
    checkpointRef,
    evaluationBindingDigest,
    caseRef,
    attemptOrdinal,
    observation: checkpointObservation,
  } as const;
  return Object.freeze({
    ...payload,
    recordDigest: hashCanonical(toJsonValue(payload)),
  });
}

export function parseIntentEvaluationCheckpoint(
  value: unknown,
  expected: {
    readonly checkpointRef: Sha256Digest;
    readonly evaluationBindingDigest: Sha256Digest;
    readonly caseRef: Sha256Digest;
    readonly attemptOrdinal: number;
  },
): IntentEvaluationCheckpoint {
  const checkpoint = plainRecord(value, 'checkpoint');
  exactKeys(checkpoint, [
    'schema',
    'mode',
    'activeCacheQualified',
    'checkpointRef',
    'evaluationBindingDigest',
    'caseRef',
    'attemptOrdinal',
    'observation',
    'recordDigest',
  ]);
  const observation = plainRecord(
    checkpoint.observation,
    'checkpoint observation',
  );
  exactKeys(observation, [
    'actual',
    'fingerprint',
    'intentDigest',
    'reasons',
    'executionFailure',
    'contractDigest',
    'normalizerBindingDigest',
    'ontologyBindingDigest',
  ]);

  if (checkpoint.schema !== INTENT_EVALUATION_CHECKPOINT_SCHEMA) {
    throw malformedCheckpoint('schema is invalid');
  }
  if (
    checkpoint.mode !== 'shadow' ||
    checkpoint.activeCacheQualified !== false
  ) {
    throw malformedCheckpoint('cannot grant active cache authority');
  }
  if (
    checkpoint.checkpointRef !== expected.checkpointRef ||
    checkpoint.evaluationBindingDigest !== expected.evaluationBindingDigest ||
    checkpoint.caseRef !== expected.caseRef ||
    checkpoint.attemptOrdinal !== expected.attemptOrdinal
  ) {
    throw malformedCheckpoint('does not match the requested evaluation slot');
  }
  if (
    !isSha256Digest(checkpoint.checkpointRef) ||
    !isSha256Digest(checkpoint.evaluationBindingDigest) ||
    !isSha256Digest(checkpoint.caseRef) ||
    !Number.isSafeInteger(checkpoint.attemptOrdinal) ||
    checkpoint.attemptOrdinal < 0 ||
    !isSha256Digest(checkpoint.recordDigest)
  ) {
    throw malformedCheckpoint('metadata is invalid');
  }

  if (observation.actual !== 'intent' && observation.actual !== 'bypass') {
    throw malformedCheckpoint('actual outcome is invalid');
  }
  if (
    typeof observation.fingerprint !== 'string' ||
    (!isSha256Digest(observation.fingerprint) &&
      observation.fingerprint !== 'failure:INTENT_COMPILER_FAILURE')
  ) {
    throw malformedCheckpoint('fingerprint is invalid');
  }
  if (!isValidObservationReasons(observation.actual, observation.reasons)) {
    throw malformedCheckpoint('reason codes are invalid');
  }
  if (
    typeof observation.executionFailure !== 'boolean' ||
    observation.executionFailure !==
      observation.reasons.includes('INTENT_COMPILER_FAILURE')
  ) {
    throw malformedCheckpoint('execution failure state is invalid');
  }
  if (
    !isSha256Digest(observation.contractDigest) ||
    !isSha256Digest(observation.normalizerBindingDigest) ||
    !isSha256Digest(observation.ontologyBindingDigest)
  ) {
    throw malformedCheckpoint('binding digests are invalid');
  }
  if (
    (observation.actual === 'intent' &&
      !isSha256Digest(observation.intentDigest)) ||
    (observation.actual === 'bypass' && observation.intentDigest !== undefined)
  ) {
    throw malformedCheckpoint('intent digest is inconsistent with outcome');
  }
  if (
    observation.fingerprint === 'failure:INTENT_COMPILER_FAILURE' &&
    (observation.actual !== 'bypass' ||
      observation.reasons.length !== 1 ||
      observation.reasons[0] !== 'INTENT_COMPILER_FAILURE' ||
      observation.contractDigest !== unavailableContractDigest ||
      observation.normalizerBindingDigest !==
        unavailableNormalizerBindingDigest ||
      observation.ontologyBindingDigest !== unavailableOntologyBindingDigest)
  ) {
    throw malformedCheckpoint('failure sentinel is inconsistent');
  }

  const parsedObservation: IntentEvaluationCheckpointObservation =
    Object.freeze({
      actual: observation.actual,
      fingerprint: observation.fingerprint,
      ...(observation.intentDigest === undefined
        ? {}
        : { intentDigest: observation.intentDigest as Sha256Digest }),
      reasons: Object.freeze([...(observation.reasons as IntentReasonCode[])]),
      executionFailure: observation.executionFailure,
      contractDigest: observation.contractDigest,
      normalizerBindingDigest: observation.normalizerBindingDigest,
      ontologyBindingDigest: observation.ontologyBindingDigest,
    });
  const payload = {
    schema: checkpoint.schema,
    mode: checkpoint.mode,
    activeCacheQualified: checkpoint.activeCacheQualified,
    checkpointRef: checkpoint.checkpointRef,
    evaluationBindingDigest: checkpoint.evaluationBindingDigest,
    caseRef: checkpoint.caseRef,
    attemptOrdinal: checkpoint.attemptOrdinal,
    observation: parsedObservation,
  } as const;
  if (checkpoint.recordDigest !== hashCanonical(toJsonValue(payload))) {
    throw malformedCheckpoint('record digest is invalid');
  }
  return Object.freeze({ ...payload, recordDigest: checkpoint.recordDigest });
}

function isValidObservationReasons(
  actual: unknown,
  reasons: unknown,
): reasons is IntentReasonCode[] {
  if (
    !Array.isArray(reasons) ||
    reasons.length === 0 ||
    reasons.some(
      (reason) =>
        typeof reason !== 'string' || !intentReasonCodeSet.has(reason),
    ) ||
    new Set(reasons).size !== reasons.length
  ) {
    return false;
  }
  if (actual === 'intent') {
    return (
      reasons.length === 1 && reasons[0] === 'INTENT_NORMALIZATION_ELIGIBLE'
    );
  }
  if (actual !== 'bypass') return false;
  if (reasons.length === 1) {
    return [
      'INTENT_NO_MATCH',
      'INTENT_AMBIGUOUS',
      'INTENT_CONFIDENCE_LOW',
      'INTENT_COMPILER_FAILURE',
      'INTENT_REGISTRY_MISMATCH',
    ].includes(reasons[0] as string);
  }
  return (
    reasons.length === 2 &&
    reasons[0] === 'INTENT_AMBIGUOUS' &&
    reasons[1] === 'INTENT_CONFIDENCE_LOW'
  );
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw malformedCheckpoint(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw malformedCheckpoint(`${label} must be plain data`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw malformedCheckpoint(
      `contains unknown fields: ${unknown.sort().join(', ')}`,
    );
  }
}

function malformedCheckpoint(detail: string): TypeError {
  return new TypeError(`Intent evaluation checkpoint ${detail}`);
}
