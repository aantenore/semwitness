import { isSha256Digest } from '../domain/hash.js';
import type { AnchorProofEntry, ProofEnvelope } from '../domain/proof.js';
import { REASON_CODES, isReasonCode } from '../domain/reason-codes.js';
import {
  MAX_PROTECTED_ANCHORS,
  SAFE_VERSION_PATTERN,
  isEquivalenceLevel,
  isSafeIdentifier,
  isSafeMediaType,
} from '../domain/types.js';
import { isSafeTokenizerFingerprint } from '../ports/tokenizer.js';
import { snapshotDataRecord, snapshotDenseDataArray } from './data-only.js';

const ROOT_FIELDS = [
  'schema',
  'segmentId',
  'segmentMetadataDigest',
  'policyDigest',
  'codec',
  'claim',
  'original',
  'encoded',
  'anchorManifest',
  'tokenEvidence',
  'decision',
  'proofDigest',
] as const;
const CODEC_FIELDS = ['id', 'version', 'configDigest'] as const;
const CLAIM_FIELDS = ['equivalence', 'verifierId', 'verifierVersion'] as const;
const ORIGINAL_FIELDS = ['sha256', 'byteLength', 'cas', 'stored'] as const;
const ENCODED_FIELDS = ['sha256', 'byteLength', 'mediaType', 'stored'] as const;
const ANCHOR_MANIFEST_FIELDS = ['sha256', 'entries'] as const;
const ANCHOR_ENTRY_FIELDS = [
  'id',
  'ordinal',
  'sha256',
  'encodedStartByte',
  'encodedEndByte',
] as const;
const TOKEN_EVIDENCE_FIELDS = [
  'tokenizerId',
  'tokenizerFingerprint',
  'reliability',
  'originalTokens',
  'encodedTokens',
  'decoderOverheadTokens',
] as const;
const DECISION_FIELDS = ['status', 'reasons'] as const;
const MAX_TOKEN_EVIDENCE = 16;

/**
 * Convert a live proof into a bounded, deeply frozen data-only snapshot.
 * Source accessors are rejected without invocation and no nested alias is kept.
 */
export function snapshotProofEnvelope(value: unknown): ProofEnvelope {
  const root = snapshotDataRecord(value, ROOT_FIELDS);
  const schema = root.schema;
  const segmentId = root.segmentId;
  const segmentMetadataDigest = root.segmentMetadataDigest;
  const policyDigest = root.policyDigest;
  const proofDigest = root.proofDigest;
  if (
    schema !== 'semwitness.dev/proof/v1alpha1' ||
    !isSafeIdentifier(segmentId) ||
    !isSha256Digest(segmentMetadataDigest) ||
    !isSha256Digest(policyDigest) ||
    !isSha256Digest(proofDigest)
  ) {
    throw malformedProof();
  }

  const codecRecord = snapshotDataRecord(root.codec, CODEC_FIELDS);
  const codecId = codecRecord.id;
  const codecVersion = codecRecord.version;
  const codecConfigDigest = codecRecord.configDigest;
  if (
    !isSafeIdentifier(codecId) ||
    typeof codecVersion !== 'string' ||
    !SAFE_VERSION_PATTERN.test(codecVersion) ||
    !isSha256Digest(codecConfigDigest)
  ) {
    throw malformedProof();
  }

  const claimRecord = snapshotDataRecord(root.claim, CLAIM_FIELDS);
  const equivalence = claimRecord.equivalence;
  if (
    !isEquivalenceLevel(equivalence) ||
    claimRecord.verifierId !== 'semwitness-core' ||
    claimRecord.verifierVersion !== '1'
  ) {
    throw malformedProof();
  }

  const originalRecord = snapshotDataRecord(root.original, ORIGINAL_FIELDS);
  const originalSha256 = originalRecord.sha256;
  const originalByteLength = originalRecord.byteLength;
  const originalCas = originalRecord.cas;
  const originalStored = originalRecord.stored;
  if (
    !isSha256Digest(originalSha256) ||
    !isNonNegativeSafeInteger(originalByteLength) ||
    !isSha256Digest(originalCas) ||
    typeof originalStored !== 'boolean'
  ) {
    throw malformedProof();
  }

  const encodedRecord = snapshotDataRecord(root.encoded, ENCODED_FIELDS);
  const encodedSha256 = encodedRecord.sha256;
  const encodedByteLength = encodedRecord.byteLength;
  const encodedMediaType = encodedRecord.mediaType;
  const encodedStored = encodedRecord.stored;
  if (
    !isSha256Digest(encodedSha256) ||
    !isNonNegativeSafeInteger(encodedByteLength) ||
    !isSafeMediaType(encodedMediaType) ||
    typeof encodedStored !== 'boolean'
  ) {
    throw malformedProof();
  }

  const anchorManifestRecord = snapshotDataRecord(
    root.anchorManifest,
    ANCHOR_MANIFEST_FIELDS,
  );
  const anchorManifestDigest = anchorManifestRecord.sha256;
  if (!isSha256Digest(anchorManifestDigest)) {
    throw malformedProof();
  }
  const anchorEntries = snapshotDenseDataArray(
    anchorManifestRecord.entries,
    0,
    MAX_PROTECTED_ANCHORS,
  ).map(snapshotAnchorEntry);

  const tokenEvidence = snapshotDenseDataArray(
    root.tokenEvidence,
    0,
    MAX_TOKEN_EVIDENCE,
  ).map(snapshotTokenEvidence);

  const decisionRecord = snapshotDataRecord(root.decision, DECISION_FIELDS);
  const decisionStatus = decisionRecord.status;
  if (decisionStatus !== 'applied' && decisionStatus !== 'bypassed') {
    throw malformedProof();
  }
  const decisionReasons = snapshotDenseDataArray(
    decisionRecord.reasons,
    0,
    REASON_CODES.length,
  );
  if (!decisionReasons.every(isReasonCode)) {
    throw malformedProof();
  }

  return Object.freeze({
    schema,
    segmentId,
    segmentMetadataDigest,
    policyDigest,
    codec: Object.freeze({
      id: codecId,
      version: codecVersion,
      configDigest: codecConfigDigest,
    }),
    claim: Object.freeze({
      equivalence,
      verifierId: 'semwitness-core',
      verifierVersion: '1',
    }),
    original: Object.freeze({
      sha256: originalSha256,
      byteLength: originalByteLength,
      cas: originalCas,
      stored: originalStored,
    }),
    encoded: Object.freeze({
      sha256: encodedSha256,
      byteLength: encodedByteLength,
      mediaType: encodedMediaType,
      stored: encodedStored,
    }),
    anchorManifest: Object.freeze({
      sha256: anchorManifestDigest,
      entries: Object.freeze(anchorEntries),
    }),
    tokenEvidence: Object.freeze(tokenEvidence),
    decision: Object.freeze({
      status: decisionStatus,
      reasons: Object.freeze([...decisionReasons]),
    }),
    proofDigest,
  });
}

/** Create a fully detached mutable copy for an untrusted asynchronous verifier. */
export function cloneProofEnvelope(proof: ProofEnvelope): ProofEnvelope {
  return {
    schema: proof.schema,
    segmentId: proof.segmentId,
    segmentMetadataDigest: proof.segmentMetadataDigest,
    policyDigest: proof.policyDigest,
    codec: { ...proof.codec },
    claim: { ...proof.claim },
    original: { ...proof.original },
    encoded: { ...proof.encoded },
    anchorManifest: {
      sha256: proof.anchorManifest.sha256,
      entries: proof.anchorManifest.entries.map((entry) => ({ ...entry })),
    },
    tokenEvidence: proof.tokenEvidence.map((evidence) => ({ ...evidence })),
    decision: {
      status: proof.decision.status,
      reasons: [...proof.decision.reasons],
    },
    proofDigest: proof.proofDigest,
  };
}

function snapshotAnchorEntry(value: unknown): AnchorProofEntry {
  const record = snapshotDataRecord(value, ANCHOR_ENTRY_FIELDS);
  const id = record.id;
  const ordinal = record.ordinal;
  const sha256 = record.sha256;
  const encodedStartByte = record.encodedStartByte;
  const encodedEndByte = record.encodedEndByte;
  if (
    !isSafeIdentifier(id) ||
    !isNonNegativeSafeInteger(ordinal) ||
    !isSha256Digest(sha256) ||
    !isNonNegativeSafeInteger(encodedStartByte) ||
    !isNonNegativeSafeInteger(encodedEndByte) ||
    encodedEndByte <= encodedStartByte
  ) {
    throw malformedProof();
  }
  return Object.freeze({
    id,
    ordinal,
    sha256,
    encodedStartByte,
    encodedEndByte,
  });
}

function snapshotTokenEvidence(
  value: unknown,
): ProofEnvelope['tokenEvidence'][number] {
  const record = snapshotDataRecord(value, TOKEN_EVIDENCE_FIELDS);
  const tokenizerId = record.tokenizerId;
  const tokenizerFingerprint = record.tokenizerFingerprint;
  const reliability = record.reliability;
  const originalTokens = record.originalTokens;
  const encodedTokens = record.encodedTokens;
  const decoderOverheadTokens = record.decoderOverheadTokens;
  if (
    !isSafeIdentifier(tokenizerId) ||
    !isSafeTokenizerFingerprint(tokenizerFingerprint) ||
    (reliability !== 'exact' && reliability !== 'heuristic') ||
    !isNonNegativeSafeInteger(originalTokens) ||
    !isNonNegativeSafeInteger(encodedTokens) ||
    !isNonNegativeSafeInteger(decoderOverheadTokens)
  ) {
    throw malformedProof();
  }
  return Object.freeze({
    tokenizerId,
    tokenizerFingerprint,
    reliability,
    originalTokens,
    encodedTokens,
    decoderOverheadTokens,
  });
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    !Object.is(value, -0) &&
    (value as number) >= 0
  );
}

function malformedProof(): TypeError {
  return new TypeError('Proof envelope must be bounded data-only state');
}
