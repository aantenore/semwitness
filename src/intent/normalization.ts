import { toJsonValue } from '../domain/canonical-json.js';
import { hashCanonical } from '../domain/hash.js';
import type { Sha256Digest } from '../domain/types.js';
import {
  canonicalizeCandidateEvidence,
  digestIntent,
  parseIntentIR,
} from './canonical.js';
import {
  parseNormalizationVerificationContextDocument,
  parseNormalizationWitnessDocument,
  parseUnsignedNormalizationWitnessDocument,
} from './schemas.js';
import { isInternalNormalizationWitness } from './parsed-witness-internal.js';
import {
  NORMALIZATION_WITNESS_SCHEMA,
  type CandidateEvidence,
  type IntentIR,
  type IntentSourceDigest,
  type IntentReasonCode,
  type NormalizerBinding,
  type NormalizationWitness,
  type NormalizationVerificationContext,
  type OntologyBinding,
  type ShadowDecision,
  type UnsignedNormalizationWitness,
} from './types.js';

export interface CreateNormalizationWitnessInput {
  readonly sourceDigest: IntentSourceDigest;
  readonly intent: IntentIR;
  readonly normalizer: NormalizerBinding;
  readonly ontology: OntologyBinding;
  readonly policyDigest: Sha256Digest;
  readonly assessment: {
    readonly ambiguous: boolean;
    readonly confidencePpm: number;
    readonly minimumConfidencePpm: number;
  };
  readonly candidateEvidence?: readonly CandidateEvidence[];
}

export interface NormalizationVerification {
  readonly verified: boolean;
  readonly reasons: readonly IntentReasonCode[];
}

export function createNormalizationWitness(
  input: CreateNormalizationWitnessInput,
): NormalizationWitness {
  const intent = parseIntentIR(input.intent);
  if (
    input.ontology.id !== intent.ontology.id ||
    input.ontology.version !== intent.ontology.version ||
    input.ontology.digest !== intent.ontology.digest
  ) {
    throw new TypeError('Normalization ontology must match the IntentIR');
  }

  const decision = normalizationDecision(input.assessment);
  const uncanonicalized: UnsignedNormalizationWitness = {
    schema: NORMALIZATION_WITNESS_SCHEMA,
    mode: 'shadow',
    sourceDigest: input.sourceDigest,
    intentDigest: digestIntent(intent),
    normalizer: input.normalizer,
    ontology: input.ontology,
    policyDigest: input.policyDigest,
    assessment: input.assessment,
    candidateEvidence: input.candidateEvidence ?? [],
    claim: {
      kind: 'bounded-typed-intent-normalization',
      universalNaturalLanguageEquivalence: false,
      cacheAuthorization: 'none',
    },
    decision,
  };
  const validated = parseUnsignedNormalizationWitnessDocument(uncanonicalized);
  const unsigned: UnsignedNormalizationWitness = {
    ...validated,
    candidateEvidence: canonicalizeCandidateEvidence(
      validated.candidateEvidence,
    ),
  };
  const witness = {
    ...unsigned,
    witnessDigest: hashCanonical(toJsonValue(unsigned)),
  };
  return parseNormalizationWitnessDocument(witness);
}

export function parseNormalizationWitness(
  input: unknown,
): NormalizationWitness {
  return parseNormalizationWitnessDocument(input);
}

export function recomputeNormalizationWitnessDigest(
  witness: NormalizationWitness,
): Sha256Digest {
  const parsed = parseNormalizationWitnessDocument(witness);
  return digestParsedNormalizationWitness(parsed);
}

export function verifyNormalizationWitness(
  input: unknown,
  expectations: NormalizationVerificationContext,
): NormalizationVerification {
  if (expectations === undefined) {
    return { verified: false, reasons: ['INTENT_MALFORMED'] };
  }
  return verifyNormalization(input, expectations);
}

/** Checks internal consistency only; it never authorizes cache admission. */
export function verifyNormalizationWitnessIntegrity(
  input: unknown,
): NormalizationVerification {
  return verifyNormalization(input);
}

function verifyNormalization(
  input: unknown,
  expectations?: NormalizationVerificationContext,
): NormalizationVerification {
  let witness: NormalizationWitness;
  try {
    witness = isInternalNormalizationWitness(input)
      ? input
      : parseNormalizationWitnessDocument(input);
  } catch {
    return { verified: false, reasons: ['INTENT_MALFORMED'] };
  }

  const integrity = inspectParsedNormalizationWitnessIntegrity(witness);
  const reasons: IntentReasonCode[] = [];
  if (!integrity.digestMatches) reasons.push('INTENT_WITNESS_TAMPERED');
  let current: NormalizationVerificationContext | undefined;
  if (expectations !== undefined) {
    try {
      current = parseNormalizationVerificationContextDocument(expectations);
      const intent = parseIntentIR(current.intent);
      if (digestIntent(intent) !== witness.intentDigest) {
        reasons.push('INTENT_DIGEST_MISMATCH');
      }
      if (
        intent.ontology.id !== witness.ontology.id ||
        intent.ontology.version !== witness.ontology.version ||
        intent.ontology.digest !== witness.ontology.digest
      ) {
        reasons.push('INTENT_DIGEST_MISMATCH');
      }
    } catch {
      reasons.push('INTENT_MALFORMED');
    }
  }
  if (current !== undefined && current.sourceDigest !== witness.sourceDigest) {
    reasons.push('INTENT_SOURCE_DIGEST_MISMATCH');
  }
  if (
    current !== undefined &&
    (current.normalizer.id !== witness.normalizer.id ||
      current.normalizer.version !== witness.normalizer.version ||
      current.normalizer.artifactDigest !== witness.normalizer.artifactDigest ||
      current.normalizer.configDigest !== witness.normalizer.configDigest)
  ) {
    reasons.push('INTENT_NORMALIZER_MISMATCH');
  }
  if (current !== undefined && current.policyDigest !== witness.policyDigest) {
    reasons.push('INTENT_POLICY_MISMATCH');
  }
  if (
    current !== undefined &&
    current.minimumConfidencePpm !== witness.assessment.minimumConfidencePpm
  ) {
    reasons.push('INTENT_POLICY_MISMATCH');
  }
  if (!integrity.decisionMatches) reasons.push('INTENT_WITNESS_TAMPERED');
  return { verified: reasons.length === 0, reasons: [...new Set(reasons)] };
}

/** Inspect an already strict-schema-parsed witness without parsing it again. */
function inspectParsedNormalizationWitnessIntegrity(
  witness: NormalizationWitness,
): { readonly digestMatches: boolean; readonly decisionMatches: boolean } {
  return {
    digestMatches:
      digestParsedNormalizationWitness(witness) === witness.witnessDigest,
    decisionMatches: sameDecision(
      normalizationDecision(witness.assessment),
      witness.decision,
    ),
  };
}

/** Internal digest path for an already strict-schema-parsed witness. */
function digestParsedNormalizationWitness(
  witness: NormalizationWitness,
): Sha256Digest {
  const { witnessDigest: _witnessDigest, ...unsigned } = witness;
  return hashCanonical(toJsonValue(unsigned));
}

export function normalizationDecision(input: {
  readonly ambiguous: boolean;
  readonly confidencePpm: number;
  readonly minimumConfidencePpm: number;
}): ShadowDecision {
  if (
    input === null ||
    typeof input !== 'object' ||
    typeof input.ambiguous !== 'boolean' ||
    !Number.isInteger(input.confidencePpm) ||
    input.confidencePpm < 0 ||
    input.confidencePpm > 1_000_000 ||
    !Number.isInteger(input.minimumConfidencePpm) ||
    input.minimumConfidencePpm < 0 ||
    input.minimumConfidencePpm > 1_000_000
  ) {
    return {
      verdict: 'bypass',
      applied: false,
      reasons: ['INTENT_MALFORMED'],
    };
  }
  const reasons: IntentReasonCode[] = [];
  if (input.ambiguous) {
    reasons.push('INTENT_AMBIGUOUS');
  }
  if (input.confidencePpm < input.minimumConfidencePpm) {
    reasons.push('INTENT_CONFIDENCE_LOW');
  }
  return reasons.length === 0
    ? {
        verdict: 'eligible',
        applied: false,
        reasons: ['INTENT_NORMALIZATION_ELIGIBLE'],
      }
    : { verdict: 'bypass', applied: false, reasons };
}

function sameDecision(left: ShadowDecision, right: ShadowDecision): boolean {
  return (
    left.verdict === right.verdict &&
    left.applied === right.applied &&
    left.reasons.length === right.reasons.length &&
    left.reasons.every((reason, index) => reason === right.reasons[index])
  );
}
