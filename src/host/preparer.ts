import type { SemWitnessCore } from '../composition-root.js';
import { isSha256Digest, sha256 } from '../domain/hash.js';
import {
  digestSegmentMetadata,
  recomputeProofDigest,
  type ProofEnvelope,
} from '../domain/proof.js';
import {
  digestPolicy,
  validatePolicy,
  type CodecPolicy,
} from '../domain/policy.js';
import {
  createSegment,
  isEquivalenceLevel,
  isSafeIdentifier,
  isSafeMediaType,
  isSegmentKind,
  isSegmentRole,
  isTrustLevel,
  validateSegment,
  type Segment,
  type Sha256Digest,
} from '../domain/types.js';
import { cloneProofEnvelope, snapshotProofEnvelope } from './proof-snapshot.js';
import {
  HOST_PREPARER_ARTIFACT,
  digestHostPromotionManifest,
  parseHostPromotionManifest,
} from './promotion.js';
import type {
  HostPromotionManifest,
  HostReasonCode,
  TextPreparationRequest,
  TextPreparationResult,
  TextRequestPreparer,
} from './types.js';

interface PreparedFactoryState {
  readonly core: SemWitnessCore;
  readonly policy: CodecPolicy;
  readonly policyDigest: Sha256Digest;
  readonly promotion?: HostPromotionManifest;
  readonly promotionDigest?: Sha256Digest;
  readonly staticReasons: readonly HostReasonCode[];
}

interface RequestSnapshotResult {
  readonly original: string;
  readonly request?: Readonly<TextPreparationRequest>;
  readonly reason?: 'REQUEST_INVALID' | 'RUNTIME_ERROR';
}

interface SimulationSnapshot {
  readonly segmentId: string;
  readonly applied: boolean;
  readonly selectedCodec: string;
  readonly effectiveReference: Sha256Digest;
  readonly projectedReference: Sha256Digest;
  readonly projectedStored: boolean;
  readonly proof: ProofEnvelope;
}

interface SimulationSnapshotResult {
  readonly simulation?: SimulationSnapshot;
  readonly reason?:
    'PROOF_DECISION_INVALID' | 'PROOF_VERIFICATION_FAILED' | 'RUNTIME_ERROR';
}

export function createVerifiedTextRequestPreparer(
  core: SemWitnessCore,
  policy: CodecPolicy,
  promotion?: HostPromotionManifest,
): TextRequestPreparer {
  const validatedPolicy = validatePolicy(policy);
  const parsedPromotion =
    promotion === undefined ? undefined : parseHostPromotionManifest(promotion);
  const state: PreparedFactoryState = Object.freeze({
    core,
    policy: validatedPolicy,
    policyDigest: digestPolicy(validatedPolicy),
    ...(parsedPromotion === undefined
      ? {}
      : {
          promotion: parsedPromotion,
          promotionDigest: digestHostPromotionManifest(parsedPromotion),
        }),
    staticReasons: Object.freeze(
      staticPromotionReasons(core, validatedPolicy, parsedPromotion),
    ),
  });

  return Object.freeze({
    async prepare(
      request: TextPreparationRequest,
    ): Promise<TextPreparationResult> {
      return prepareText(state, request);
    },
  });
}

async function prepareText(
  state: PreparedFactoryState,
  request: TextPreparationRequest,
): Promise<TextPreparationResult> {
  const captured = snapshotRequest(request);
  if (captured.request === undefined) {
    return fallback(
      captured.original,
      'identity',
      [captured.reason ?? 'REQUEST_INVALID'],
      state,
    );
  }
  try {
    return await prepareSnapshot(state, captured.request);
  } catch {
    return fallback(captured.original, 'identity', ['RUNTIME_ERROR'], state);
  }
}

async function prepareSnapshot(
  state: PreparedFactoryState,
  request: Readonly<TextPreparationRequest>,
): Promise<TextPreparationResult> {
  const original = request.content;
  if (state.staticReasons.length > 0) {
    return fallback(original, 'identity', state.staticReasons, state);
  }
  if (
    state.promotion === undefined ||
    request.deploymentScopeDigest !== state.promotion.deploymentScopeDigest
  ) {
    return fallback(original, 'identity', ['PROMOTION_SCOPE_MISMATCH'], state);
  }
  if (!isLosslessUtf8(original)) {
    return fallback(original, 'identity', ['INVALID_UTF8'], state);
  }

  const segment = createPrivateSegment(request);
  if (!validateSegment(segment).valid) {
    return fallback(original, 'identity', ['REQUEST_INVALID'], state);
  }

  let liveSimulation: unknown;
  try {
    liveSimulation = await state.core.simulate(
      cloneSegment(segment),
      state.policy,
    );
  } catch {
    return fallback(original, 'identity', ['SIMULATION_FAILED'], state);
  }

  const capturedSimulation = snapshotSimulation(liveSimulation);
  if (capturedSimulation.simulation === undefined) {
    return fallback(
      original,
      'identity',
      [capturedSimulation.reason ?? 'RUNTIME_ERROR'],
      state,
    );
  }
  const simulation = capturedSimulation.simulation;

  const selectedCodec = simulation.selectedCodec;
  const proof = simulation.proof;
  if (!simulation.applied) {
    return fallback(
      original,
      selectedCodec,
      ['SIMULATION_BYPASSED'],
      state,
      proof,
    );
  }
  const invariantReason = appliedProofInvariantReason(
    state,
    simulation,
    segment,
    request.deploymentScopeDigest,
  );
  if (invariantReason !== undefined) {
    return fallback(original, selectedCodec, [invariantReason], state, proof);
  }

  const expectedLength = proof.encoded.byteLength;
  const expectedDigest = proof.encoded.sha256;
  let privateBytes: Uint8Array;
  try {
    const retrieved = await state.core.retrieve(expectedDigest, state.policy);
    privateBytes = new Uint8Array(retrieved);
  } catch {
    return fallback(
      original,
      selectedCodec,
      ['RETRIEVAL_FAILED'],
      state,
      proof,
    );
  }
  if (!matchesEncodedEvidence(privateBytes, expectedLength, expectedDigest)) {
    return fallback(
      original,
      selectedCodec,
      ['RETRIEVED_CONTENT_MISMATCH'],
      state,
      proof,
    );
  }

  try {
    const verifierBytes = new Uint8Array(privateBytes);
    const verification = await state.core.verify(
      cloneProofEnvelope(proof),
      cloneSegment(segment),
      { bytes: verifierBytes },
      state.policy,
    );
    if (!verification.verified || verification.reasons.length > 0) {
      return fallback(
        original,
        selectedCodec,
        ['PROOF_VERIFICATION_FAILED'],
        state,
        proof,
      );
    }
  } catch {
    return fallback(
      original,
      selectedCodec,
      ['PROOF_VERIFICATION_FAILED'],
      state,
      proof,
    );
  }

  if (!matchesEncodedEvidence(privateBytes, expectedLength, expectedDigest)) {
    return fallback(
      original,
      selectedCodec,
      ['RETRIEVED_CONTENT_MISMATCH'],
      state,
      proof,
    );
  }

  const postVerificationReason = appliedProofInvariantReason(
    state,
    simulation,
    segment,
    request.deploymentScopeDigest,
  );
  if (postVerificationReason !== undefined) {
    return fallback(
      original,
      selectedCodec,
      [postVerificationReason],
      state,
      proof,
    );
  }

  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(privateBytes);
  } catch {
    return fallback(original, selectedCodec, ['INVALID_UTF8'], state, proof);
  }

  return Object.freeze({
    content,
    applied: true,
    selectedCodec,
    reasons: Object.freeze(['APPLIED'] as const),
    proof,
    ...promotionEvidence(state),
  });
}

function snapshotRequest(value: unknown): RequestSnapshotResult {
  if (value === null || typeof value !== 'object') {
    return { original: '', reason: 'REQUEST_INVALID' };
  }

  let content: unknown;
  try {
    content = Reflect.get(value, 'content');
  } catch {
    return { original: '', reason: 'RUNTIME_ERROR' };
  }
  if (typeof content !== 'string') {
    return { original: '', reason: 'REQUEST_INVALID' };
  }

  try {
    const id = Reflect.get(value, 'id');
    const role = Reflect.get(value, 'role');
    const kind = Reflect.get(value, 'kind');
    const trust = Reflect.get(value, 'trust');
    const mediaType = Reflect.get(value, 'mediaType');
    const equivalence = Reflect.get(value, 'equivalence');
    const deploymentScopeDigest = Reflect.get(value, 'deploymentScopeDigest');
    if (
      !isSafeIdentifier(id) ||
      !isSegmentRole(role) ||
      !isSegmentKind(kind) ||
      !isTrustLevel(trust) ||
      !isSafeMediaType(mediaType) ||
      !isEquivalenceLevel(equivalence) ||
      !isSha256Digest(deploymentScopeDigest)
    ) {
      return { original: content, reason: 'REQUEST_INVALID' };
    }
    return {
      original: content,
      request: Object.freeze({
        id,
        role,
        kind,
        trust,
        mediaType,
        equivalence,
        deploymentScopeDigest,
        content,
      }),
    };
  } catch {
    return { original: content, reason: 'REQUEST_INVALID' };
  }
}

function snapshotSimulation(value: unknown): SimulationSnapshotResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { reason: 'RUNTIME_ERROR' };
  }

  let proof: ProofEnvelope;
  try {
    proof = snapshotProofEnvelope(ownEnumerableDataValue(value, 'proof'));
  } catch {
    return { reason: 'PROOF_VERIFICATION_FAILED' };
  }

  try {
    const segmentId = ownEnumerableDataValue(value, 'segmentId');
    const applied = ownEnumerableDataValue(value, 'applied');
    const selectedCodec = ownEnumerableDataValue(value, 'selectedCodec');
    const effectiveReference = ownEnumerableDataValue(
      value,
      'effectiveReference',
    );
    const projectedReference = ownEnumerableDataValue(
      value,
      'projectedReference',
    );
    const projectedStored = ownEnumerableDataValue(value, 'projectedStored');
    if (
      !isSafeIdentifier(segmentId) ||
      typeof applied !== 'boolean' ||
      typeof selectedCodec !== 'string' ||
      safeSelectedCodec(selectedCodec) !== selectedCodec ||
      !isSha256Digest(effectiveReference) ||
      !isSha256Digest(projectedReference) ||
      typeof projectedStored !== 'boolean'
    ) {
      return { reason: 'PROOF_DECISION_INVALID' };
    }
    return {
      simulation: Object.freeze({
        segmentId,
        applied,
        selectedCodec,
        effectiveReference,
        projectedReference,
        projectedStored,
        proof,
      }),
    };
  } catch {
    return { reason: 'PROOF_DECISION_INVALID' };
  }
}

function ownEnumerableDataValue(value: object, field: string): unknown {
  const descriptor = Reflect.getOwnPropertyDescriptor(value, field);
  if (
    descriptor === undefined ||
    !descriptor.enumerable ||
    !Object.hasOwn(descriptor, 'value') ||
    Object.hasOwn(descriptor, 'get') ||
    Object.hasOwn(descriptor, 'set')
  ) {
    throw new TypeError('Simulation result must expose data-only fields');
  }
  return descriptor.value;
}

function createPrivateSegment(
  request: Readonly<TextPreparationRequest>,
): Segment {
  const created = createSegment({
    id: request.id,
    role: request.role,
    kind: request.kind,
    trust: request.trust,
    mediaType: request.mediaType,
    equivalence: request.equivalence,
    content: request.content,
  });
  return Object.freeze({
    ...created,
    content: new Uint8Array(created.content),
    anchors: Object.freeze(
      created.anchors.map((anchor) => Object.freeze({ ...anchor })),
    ),
  });
}

function cloneSegment(segment: Segment): Segment {
  return {
    schema: segment.schema,
    id: segment.id,
    role: segment.role,
    roleOrigin: segment.roleOrigin,
    kind: segment.kind,
    trust: segment.trust,
    mediaType: segment.mediaType,
    content: new Uint8Array(segment.content),
    equivalence: segment.equivalence,
    anchors: segment.anchors.map((anchor) => ({ ...anchor })),
  };
}

function staticPromotionReasons(
  core: SemWitnessCore,
  policy: CodecPolicy,
  promotion: HostPromotionManifest | undefined,
): readonly HostReasonCode[] {
  const reasons: HostReasonCode[] = [];
  if (promotion === undefined) {
    reasons.push('PROMOTION_MISSING');
  }
  if (policy.mode !== 'apply-verified') {
    reasons.push('POLICY_MODE_NOT_APPLY_VERIFIED');
  }
  if (promotion !== undefined) {
    if (
      promotion.artifact.id !== HOST_PREPARER_ARTIFACT.id ||
      promotion.artifact.version !== HOST_PREPARER_ARTIFACT.version
    ) {
      reasons.push('PROMOTION_ARTIFACT_MISMATCH');
    }
    if (promotion.policyDigest !== digestPolicy(policy)) {
      reasons.push('PROMOTION_POLICY_MISMATCH');
    }
    if (
      policy.tokenizerId !== core.tokenizer.id ||
      promotion.tokenizer.id !== policy.tokenizerId ||
      promotion.tokenizer.id !== core.tokenizer.id ||
      promotion.tokenizer.fingerprint !== core.tokenizer.fingerprint
    ) {
      reasons.push('PROMOTION_TOKENIZER_MISMATCH');
    }
  } else if (policy.tokenizerId !== core.tokenizer.id) {
    reasons.push('PROMOTION_TOKENIZER_MISMATCH');
  }
  return reasons;
}

function promotionAllowsProof(
  state: PreparedFactoryState,
  proof: ProofEnvelope,
  deploymentScopeDigest: Sha256Digest,
): boolean {
  const promotion = state.promotion;
  return (
    promotion !== undefined &&
    promotion.deploymentScopeDigest === deploymentScopeDigest &&
    proof.policyDigest === state.policyDigest &&
    promotion.policyDigest === proof.policyDigest &&
    state.policy.tokenizerId === state.core.tokenizer.id &&
    promotion.tokenizer.id === state.core.tokenizer.id &&
    promotion.tokenizer.fingerprint === state.core.tokenizer.fingerprint &&
    promotion.codecs.some(
      (codec) =>
        codec.id === proof.codec.id && codec.version === proof.codec.version,
    )
  );
}

function appliedProofInvariantReason(
  state: PreparedFactoryState,
  simulation: SimulationSnapshot,
  segment: Segment,
  deploymentScopeDigest: Sha256Digest,
): HostReasonCode | undefined {
  const proof = simulation.proof;
  if (!hasValidProofDigest(proof)) {
    return 'PROOF_VERIFICATION_FAILED';
  }
  if (!isAppliedDecisionConsistent(simulation, proof, segment)) {
    return 'PROOF_DECISION_INVALID';
  }
  if (!isActiveDeliverySupported(segment, proof)) {
    return 'ACTIVE_DELIVERY_UNSUPPORTED';
  }
  if (!promotionAllowsProof(state, proof, deploymentScopeDigest)) {
    return promotionMismatchReason(state, proof);
  }
  if (!hasExactTokenEvidence(state, proof)) {
    return 'PROOF_TOKEN_EVIDENCE_INVALID';
  }
  return undefined;
}

function hasValidProofDigest(proof: ProofEnvelope): boolean {
  try {
    return proof.proofDigest === recomputeProofDigest(proof);
  } catch {
    return false;
  }
}

function promotionMismatchReason(
  state: PreparedFactoryState,
  proof: ProofEnvelope,
): HostReasonCode {
  const promotion = state.promotion;
  if (
    promotion === undefined ||
    proof.policyDigest !== state.policyDigest ||
    promotion.policyDigest !== proof.policyDigest
  ) {
    return 'PROMOTION_POLICY_MISMATCH';
  }
  if (
    promotion.tokenizer.id !== state.core.tokenizer.id ||
    promotion.tokenizer.fingerprint !== state.core.tokenizer.fingerprint
  ) {
    return 'PROMOTION_TOKENIZER_MISMATCH';
  }
  return 'PROMOTION_CODEC_MISMATCH';
}

function hasExactTokenEvidence(
  state: PreparedFactoryState,
  proof: ProofEnvelope,
): boolean {
  if (proof.tokenEvidence.length !== 1) {
    return false;
  }
  const evidence = proof.tokenEvidence[0];
  const promotion = state.promotion;
  return (
    evidence !== undefined &&
    promotion !== undefined &&
    evidence.reliability === 'exact' &&
    evidence.tokenizerId === state.policy.tokenizerId &&
    evidence.tokenizerId === state.core.tokenizer.id &&
    evidence.tokenizerFingerprint === state.core.tokenizer.fingerprint &&
    evidence.tokenizerId === promotion.tokenizer.id &&
    evidence.tokenizerFingerprint === promotion.tokenizer.fingerprint
  );
}

function isActiveDeliverySupported(
  segment: Segment,
  proof: ProofEnvelope,
): boolean {
  return (
    segment.role === 'tool' &&
    segment.kind === 'json-data' &&
    segment.equivalence === 'typed-semantic' &&
    /^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json(?:; ?charset=utf-8)?$/u.test(
      segment.mediaType,
    ) &&
    proof.codec.id === 'json-jcs' &&
    proof.codec.version === '1' &&
    proof.claim.equivalence === 'typed-semantic'
  );
}

function isAppliedDecisionConsistent(
  simulation: SimulationSnapshot,
  proof: ProofEnvelope,
  segment: Segment,
): boolean {
  return (
    simulation.applied &&
    simulation.segmentId === segment.id &&
    simulation.selectedCodec !== 'identity' &&
    simulation.selectedCodec === proof.codec.id &&
    simulation.effectiveReference === proof.encoded.sha256 &&
    simulation.projectedReference === proof.encoded.sha256 &&
    simulation.projectedStored &&
    proof.encoded.stored &&
    proof.original.stored &&
    proof.schema === 'semwitness.dev/proof/v1alpha1' &&
    proof.segmentId === segment.id &&
    proof.segmentMetadataDigest === digestSegmentMetadata(segment) &&
    proof.original.sha256 === sha256(segment.content) &&
    proof.original.cas === proof.original.sha256 &&
    proof.original.byteLength === segment.content.byteLength &&
    proof.encoded.mediaType === segment.mediaType &&
    proof.decision.status === 'applied' &&
    proof.decision.reasons.length === 1 &&
    proof.decision.reasons[0] === 'APPLIED' &&
    proof.anchorManifest.entries.length === 0
  );
}

function safeSelectedCodec(value: unknown): string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/u.test(value)
    ? value
    : 'identity';
}

function isLosslessUtf8(value: string): boolean {
  try {
    const encoded = new TextEncoder().encode(value);
    return new TextDecoder('utf-8', { fatal: true }).decode(encoded) === value;
  } catch {
    return false;
  }
}

function matchesEncodedEvidence(
  bytes: Uint8Array,
  expectedLength: number,
  expectedDigest: Sha256Digest,
): boolean {
  return (
    bytes.byteLength === expectedLength && sha256(bytes) === expectedDigest
  );
}

function promotionEvidence(
  state: PreparedFactoryState,
): Pick<TextPreparationResult, 'promotionDigest' | 'deploymentScopeDigest'> {
  if (state.promotion === undefined || state.promotionDigest === undefined) {
    return {};
  }
  return {
    promotionDigest: state.promotionDigest,
    deploymentScopeDigest: state.promotion.deploymentScopeDigest,
  };
}

function fallback(
  content: string,
  selectedCodec: string,
  reasons: readonly HostReasonCode[],
  state: PreparedFactoryState,
  proof?: ProofEnvelope,
): TextPreparationResult {
  return Object.freeze({
    content,
    applied: false,
    selectedCodec,
    reasons: Object.freeze([...new Set(reasons)]),
    ...(proof === undefined ? {} : { proof }),
    ...promotionEvidence(state),
  });
}
