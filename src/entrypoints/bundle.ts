import { z } from 'zod';
import type { SimulationResult } from '../application/simulate.js';
import type { SemWitnessCore } from '../composition-root.js';
import { hashCanonical, isSha256Digest, sha256 } from '../domain/hash.js';
import { validatePolicy, type CodecPolicy } from '../domain/policy.js';
import type { ProofEnvelope } from '../domain/proof.js';
import { REASON_CODES } from '../domain/reason-codes.js';
import { parseStrictJson } from '../domain/strict-json.js';
import {
  EQUIVALENCE_LEVELS,
  SAFE_IDENTIFIER_PATTERN,
  SAFE_MEDIA_TYPE_PATTERN,
  SAFE_VERSION_PATTERN,
  SEGMENT_KINDS,
  SEGMENT_ROLES,
  TRUST_LEVELS,
  createSegment,
  validateSegment,
  type EquivalenceLevel,
  type ProtectedAnchor,
  type Segment,
  type SegmentKind,
  type SegmentRole,
  type Sha256Digest,
  type TrustLevel,
} from '../domain/types.js';
import { SAFE_TOKENIZER_FINGERPRINT_PATTERN } from '../ports/tokenizer.js';
import { toJsonValue, type JsonValue } from '../domain/canonical-json.js';
import { SemWitnessError } from '../domain/errors.js';

export const SIMULATION_BUNDLE_SCHEMA =
  'semwitness.dev/simulation-bundle/v1alpha1' as const;

export interface SerializableSegmentMetadata {
  readonly segmentId: string;
  readonly role: SegmentRole;
  readonly roleOrigin: 'host';
  readonly kind: SegmentKind;
  readonly trust: TrustLevel;
  readonly mediaType: string;
  readonly equivalence: EquivalenceLevel;
  readonly sha256: Sha256Digest;
  readonly byteLength: number;
  readonly anchors: readonly ProtectedAnchor[];
}

export interface SimulationBundle {
  readonly schema: typeof SIMULATION_BUNDLE_SCHEMA;
  readonly input: SerializableSegmentMetadata;
  readonly policy: CodecPolicy;
  readonly proof: ProofEnvelope;
  readonly bundleDigest: Sha256Digest;
}

const sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const nonNegativeInteger = z.number().int().nonnegative().safe();
const safeId = z.string().regex(SAFE_IDENTIFIER_PATTERN);
const safeVersion = z.string().regex(SAFE_VERSION_PATTERN);
const safeMediaType = z.string().regex(SAFE_MEDIA_TYPE_PATTERN);
const reasonCodeSchema = z.enum(REASON_CODES);
const protectedAnchorSchema = z
  .object({
    id: safeId,
    startByte: nonNegativeInteger,
    endByte: nonNegativeInteger,
    sha256: sha256Schema,
    ordinal: nonNegativeInteger,
  })
  .strict();

const segmentMetadataSchema = z
  .object({
    segmentId: safeId,
    role: z.enum(SEGMENT_ROLES),
    roleOrigin: z.literal('host'),
    kind: z.enum(SEGMENT_KINDS),
    trust: z.enum(TRUST_LEVELS),
    mediaType: safeMediaType,
    equivalence: z.enum(EQUIVALENCE_LEVELS),
    sha256: sha256Schema,
    byteLength: nonNegativeInteger,
    anchors: z.array(protectedAnchorSchema).max(10_000),
  })
  .strict();

const proofSchema = z
  .object({
    schema: z.literal('semwitness.dev/proof/v1alpha1'),
    segmentId: safeId,
    segmentMetadataDigest: sha256Schema,
    policyDigest: sha256Schema,
    codec: z
      .object({
        id: safeId,
        version: safeVersion,
        configDigest: sha256Schema,
      })
      .strict(),
    claim: z
      .object({
        equivalence: z.enum(EQUIVALENCE_LEVELS),
        verifierId: z.literal('semwitness-core'),
        verifierVersion: z.literal('1'),
      })
      .strict(),
    original: z
      .object({
        sha256: sha256Schema,
        byteLength: nonNegativeInteger,
        cas: sha256Schema,
        stored: z.boolean(),
      })
      .strict(),
    encoded: z
      .object({
        sha256: sha256Schema,
        byteLength: nonNegativeInteger,
        mediaType: safeMediaType,
        stored: z.boolean(),
      })
      .strict(),
    anchorManifest: z
      .object({
        sha256: sha256Schema,
        entries: z
          .array(
            z
              .object({
                id: safeId,
                ordinal: nonNegativeInteger,
                sha256: sha256Schema,
                encodedStartByte: nonNegativeInteger,
                encodedEndByte: nonNegativeInteger,
              })
              .strict(),
          )
          .max(10_000),
      })
      .strict(),
    tokenEvidence: z
      .array(
        z
          .object({
            tokenizerId: safeId,
            tokenizerFingerprint: z
              .string()
              .regex(SAFE_TOKENIZER_FINGERPRINT_PATTERN),
            reliability: z.enum(['exact', 'heuristic']),
            originalTokens: nonNegativeInteger,
            encodedTokens: nonNegativeInteger,
            decoderOverheadTokens: nonNegativeInteger,
          })
          .strict(),
      )
      .min(1)
      .max(16),
    decision: z
      .object({
        status: z.enum(['applied', 'bypassed']),
        reasons: z.array(reasonCodeSchema).max(REASON_CODES.length),
      })
      .strict(),
    proofDigest: sha256Schema,
  })
  .strict();

const bundleWireSchema = z
  .object({
    schema: z.literal(SIMULATION_BUNDLE_SCHEMA),
    input: segmentMetadataSchema,
    policy: z.unknown(),
    proof: proofSchema,
    bundleDigest: sha256Schema,
  })
  .strict();

export function serializeSegmentMetadata(
  segment: Segment,
): SerializableSegmentMetadata {
  return {
    segmentId: segment.id,
    role: segment.role,
    roleOrigin: 'host',
    kind: segment.kind,
    trust: segment.trust,
    mediaType: segment.mediaType,
    equivalence: segment.equivalence,
    sha256: sha256(segment.content),
    byteLength: segment.content.byteLength,
    anchors: segment.anchors.map((anchor) => ({ ...anchor })),
  };
}

export function createSimulationBundle(input: {
  readonly segment: Segment;
  readonly policy: CodecPolicy;
  readonly simulation: SimulationResult;
}): SimulationBundle {
  if (
    input.policy.mode !== 'shadow' ||
    input.simulation.applied ||
    input.simulation.selectedCodec !== input.simulation.proof.codec.id ||
    input.simulation.effectiveReference !==
      input.simulation.proof.original.sha256 ||
    input.simulation.projectedReference !==
      input.simulation.proof.encoded.sha256 ||
    !input.simulation.projectedStored
  ) {
    throw malformed('Simulation bundles are shadow-only');
  }
  const unsigned = {
    schema: SIMULATION_BUNDLE_SCHEMA,
    input: serializeSegmentMetadata(input.segment),
    policy: input.policy,
    proof: input.simulation.proof,
  };
  const bundle: SimulationBundle = {
    ...unsigned,
    bundleDigest: hashCanonical(toJsonValue(unsigned)),
  };
  validateBundleRelations(bundle);
  return bundle;
}

export function parseSimulationBundle(source: string): SimulationBundle {
  let parsedJson: JsonValue;
  try {
    parsedJson = parseStrictJson(source, {
      maxDepth: 128,
      maxItems: 200_000,
      maxStringCodeUnits: 1024 * 1024,
    });
  } catch {
    throw malformed('Simulation bundle is not strict JSON');
  }
  const parsed = bundleWireSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw malformed('Simulation bundle does not match the v1alpha1 schema');
  }
  let policy: CodecPolicy;
  try {
    policy = validatePolicy(parsed.data.policy);
  } catch {
    throw malformed('Simulation bundle contains an invalid policy');
  }
  const bundle = { ...parsed.data, policy } as SimulationBundle;
  validateBundleRelations(bundle);
  return bundle;
}

export async function verifySimulationBundle(
  core: SemWitnessCore,
  bundle: SimulationBundle,
) {
  validateBundleRelations(bundle);
  const original = await core.retrieve(
    bundle.proof.original.cas,
    bundle.policy,
  );
  const segment = createSegment({
    id: bundle.input.segmentId,
    role: bundle.input.role,
    kind: bundle.input.kind,
    trust: bundle.input.trust,
    mediaType: bundle.input.mediaType,
    equivalence: bundle.input.equivalence,
    anchors: bundle.input.anchors,
    content: original,
  });
  const segmentValidation = validateSegment(segment);
  if (!segmentValidation.valid) {
    throw new SemWitnessError(
      segmentValidation.reasons[0] ?? 'MALFORMED_ENVELOPE',
      'Bundle segment metadata is invalid',
    );
  }
  const projected = await core.retrieve(
    bundle.proof.encoded.sha256,
    bundle.policy,
  );
  return core.verify(
    bundle.proof,
    segment,
    {
      bytes: projected,
    },
    bundle.policy,
  );
}

function validateBundleRelations(bundle: SimulationBundle): void {
  if (bundle.policy.mode !== 'shadow') {
    throw malformed('Simulation bundle policy must be shadow mode');
  }
  if (
    bundle.proof.decision.status !== 'bypassed' ||
    bundle.proof.original.sha256 !== bundle.input.sha256
  ) {
    throw malformed('Simulation bundle contains a non-shadow decision');
  }
  if (
    bundle.input.segmentId !== bundle.proof.segmentId ||
    bundle.input.sha256 !== bundle.proof.original.sha256 ||
    bundle.input.byteLength !== bundle.proof.original.byteLength ||
    bundle.proof.original.cas !== bundle.input.sha256 ||
    !bundle.proof.original.stored
  ) {
    throw malformed('Simulation bundle original metadata is inconsistent');
  }
  if (!bundle.proof.encoded.stored) {
    throw malformed('Simulation bundle projected metadata is inconsistent');
  }
  if (!isSha256Digest(bundle.bundleDigest)) {
    throw malformed('Simulation bundle digest is malformed');
  }
  const { bundleDigest: _bundleDigest, ...unsigned } = bundle;
  if (hashCanonical(toJsonValue(unsigned)) !== bundle.bundleDigest) {
    throw malformed('Simulation bundle digest does not match');
  }
}

function malformed(message: string): SemWitnessError {
  return new SemWitnessError('MALFORMED_ENVELOPE', message);
}
