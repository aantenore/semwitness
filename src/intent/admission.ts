import { canonicalJson, toJsonValue } from '../domain/canonical-json.js';
import { hashCanonical, sha256 } from '../domain/hash.js';
import type { Sha256Digest } from '../domain/types.js';
import { canonicalizeRevisions, parseIntentIR } from './canonical.js';
import {
  verifyNormalizationWitness,
  verifyNormalizationWitnessIntegrity,
} from './normalization.js';
import {
  isInternalCacheHitWitness,
  isInternalNormalizationWitness,
} from './parsed-witness-internal.js';
import {
  parseCacheEntryDocument,
  parseCacheEntryPayloadDocument,
  parseCacheHitWitnessDocument,
  parseCacheLookupDocument,
  parseNormalizationWitnessDocument,
} from './schemas.js';
import {
  CACHE_HIT_WITNESS_SCHEMA,
  type CacheBinding,
  type CacheEntry,
  type CacheHitWitness,
  type CacheLookup,
  type IntentEffect,
  type IntentIR,
  type IntentSourceDigest,
  type IntentReasonCode,
  type NormalizationWitness,
  type NormalizerBinding,
  type ShadowDecision,
  type UnsignedCacheHitWitness,
} from './types.js';

export interface AdmitCacheHitInput {
  readonly entry: CacheEntry;
  readonly lookup: CacheLookup;
  readonly normalizationWitness: NormalizationWitness;
  readonly sourceDigest: IntentSourceDigest;
  readonly intent: IntentIR;
  readonly expectedNormalizer: NormalizerBinding;
  readonly expectedNormalizationPolicyDigest: Sha256Digest;
  readonly expectedMinimumConfidencePpm: number;
}

export interface CacheHitVerification {
  readonly verified: boolean;
  readonly reasons: readonly IntentReasonCode[];
}

export interface CacheHitVerificationContext {
  readonly normalizationWitness: NormalizationWitness;
  readonly sourceDigest: IntentSourceDigest;
  readonly intent: IntentIR;
  readonly expectedNormalizer: NormalizerBinding;
  readonly expectedNormalizationPolicyDigest: Sha256Digest;
  readonly expectedMinimumConfidencePpm: number;
}

export type CreateCacheEntryInput = Omit<CacheEntry, 'entryDigest'>;

const CACHE_ENTRY_DIGEST_PREFIX =
  'semwitness.dev/cache-entry-payload/v1alpha1\0';

/**
 * The entry digest detects accidental or in-envelope tampering. It is not an
 * authenticity or provenance signature; deployments must authenticate storage.
 */
export function createCacheEntry(input: CreateCacheEntryInput): CacheEntry {
  const canonical = canonicalizeEntryPayload(input);
  return parseCacheEntryDocument({
    ...canonical,
    entryDigest: digestCacheEntryPayload(canonical),
  });
}

export function digestCacheEntryPayload(
  input: CreateCacheEntryInput | CacheEntry,
): Sha256Digest {
  return digestParsedCacheEntryPayload(
    canonicalizeEntryPayload({
      valueDigest: input.valueDigest,
      binding: input.binding,
      freshness: input.freshness,
    }),
  );
}

export function admitCacheHit(input: AdmitCacheHitInput): CacheHitWitness {
  const entry = canonicalizeEntry(parseCacheEntryDocument(input.entry));
  const lookup = canonicalizeLookup(parseCacheLookupDocument(input.lookup));
  const normalization = parseNormalizationWitnessDocument(
    input.normalizationWitness,
  );
  const currentIntent = parseIntentIR(input.intent);
  const normalizationVerification = verifyNormalizationWitness(normalization, {
    sourceDigest: input.sourceDigest,
    intent: currentIntent,
    normalizer: input.expectedNormalizer,
    policyDigest: input.expectedNormalizationPolicyDigest,
    minimumConfidencePpm: input.expectedMinimumConfidencePpm,
  });
  const decision = evaluateAdmission(
    entry,
    lookup,
    normalization,
    normalizationVerification.verified,
    currentIntent.effect,
  );

  const unsigned: UnsignedCacheHitWitness = {
    schema: CACHE_HIT_WITNESS_SCHEMA,
    mode: 'shadow',
    normalization: {
      witnessDigest: normalization.witnessDigest,
      sourceDigest: normalization.sourceDigest,
      intentDigest: normalization.intentDigest,
      verdict: normalization.decision.verdict,
      reasons: normalization.decision.reasons,
    },
    entry,
    lookup,
    claim: {
      comparison: 'exact-bound-digests',
      candidateEvidenceAuthorizesHit: false,
      universalSemanticEquivalence: false,
    },
    decision,
  };
  const witness = {
    ...unsigned,
    witnessDigest: hashCanonical(toJsonValue(unsigned)),
  };
  return parseCacheHitWitnessDocument(witness);
}

export function parseCacheHitWitness(input: unknown): CacheHitWitness {
  return parseCacheHitWitnessDocument(input);
}

export function recomputeCacheHitWitnessDigest(
  witness: CacheHitWitness,
): Sha256Digest {
  const parsed = parseCacheHitWitnessDocument(witness);
  return digestParsedCacheHitWitness(parsed);
}

export function verifyCacheHitWitness(
  input: unknown,
  context?: CacheHitVerificationContext,
): CacheHitVerification {
  let witness: CacheHitWitness;
  try {
    witness = isInternalCacheHitWitness(input)
      ? input
      : parseCacheHitWitnessDocument(input);
  } catch {
    return { verified: false, reasons: ['INTENT_MALFORMED'] };
  }
  const reasons: IntentReasonCode[] = [];
  if (digestParsedCacheHitWitness(witness) !== witness.witnessDigest) {
    reasons.push('CACHE_WITNESS_TAMPERED');
  }

  let normalizationVerified = true;
  let currentEffect = witness.lookup.binding.effect;
  let normalizationForAdmission: Pick<
    NormalizationWitness,
    'intentDigest' | 'normalizer' | 'policyDigest' | 'assessment' | 'decision'
  > = {
    intentDigest: witness.normalization.intentDigest,
    normalizer: witness.lookup.binding.normalization.normalizer,
    policyDigest: witness.lookup.binding.normalization.policyDigest,
    assessment: {
      ambiguous: false,
      confidencePpm: witness.lookup.binding.normalization.minimumConfidencePpm,
      minimumConfidencePpm:
        witness.lookup.binding.normalization.minimumConfidencePpm,
    },
    decision: {
      verdict: witness.normalization.verdict,
      applied: false,
      reasons: witness.normalization.reasons,
    },
  };
  if (context === undefined) {
    reasons.push('CACHE_NORMALIZATION_WITNESS_INVALID');
  } else {
    try {
      const currentIntent = parseIntentIR(context.intent);
      const currentNormalization = parseNormalizationWitnessDocument(
        context.normalizationWitness,
      );
      currentEffect = currentIntent.effect;
      normalizationForAdmission = currentNormalization;
      const verification = verifyNormalizationWitness(currentNormalization, {
        sourceDigest: context.sourceDigest,
        intent: currentIntent,
        normalizer: context.expectedNormalizer,
        policyDigest: context.expectedNormalizationPolicyDigest,
        minimumConfidencePpm: context.expectedMinimumConfidencePpm,
      });
      normalizationVerified = verification.verified;
      if (
        !verification.verified ||
        !cacheWitnessMatchesNormalization(witness, currentNormalization)
      ) {
        reasons.push('CACHE_NORMALIZATION_WITNESS_INVALID');
      }
    } catch {
      normalizationVerified = false;
      reasons.push('INTENT_MALFORMED', 'CACHE_NORMALIZATION_WITNESS_INVALID');
    }
  }

  const expected = evaluateAdmission(
    witness.entry,
    witness.lookup,
    normalizationForAdmission,
    normalizationVerified,
    currentEffect,
  );
  if (!sameDecision(expected, witness.decision)) {
    reasons.push('CACHE_WITNESS_TAMPERED');
  }

  return { verified: reasons.length === 0, reasons: [...new Set(reasons)] };
}

/**
 * Checks payload-free envelope integrity, cross-links, and the derived shadow
 * decision. It does not prove semantic equivalence and never authorizes a hit.
 */
export function verifyCacheHitWitnessIntegrity(
  input: unknown,
  normalizationInput: unknown,
): CacheHitVerification {
  let witness: CacheHitWitness;
  try {
    witness = isInternalCacheHitWitness(input)
      ? input
      : parseCacheHitWitnessDocument(input);
  } catch {
    return { verified: false, reasons: ['INTENT_MALFORMED'] };
  }
  const witnessDigestMatches =
    digestParsedCacheHitWitness(witness) === witness.witnessDigest;

  let normalization: NormalizationWitness;
  try {
    normalization = isInternalNormalizationWitness(normalizationInput)
      ? normalizationInput
      : parseNormalizationWitnessDocument(normalizationInput);
  } catch {
    return {
      verified: false,
      reasons: [
        ...(witnessDigestMatches ? [] : (['CACHE_WITNESS_TAMPERED'] as const)),
        'INTENT_MALFORMED',
        'CACHE_NORMALIZATION_WITNESS_INVALID',
      ],
    };
  }
  return verifyParsedCacheHitWitnessIntegrity(
    witness,
    normalization,
    witnessDigestMatches,
  );
}

/**
 * Internal fast path for snapshots already accepted by the strict schemas.
 * It is intentionally omitted from the public intent entrypoint.
 */
function verifyParsedCacheHitWitnessIntegrity(
  witness: CacheHitWitness,
  normalization: NormalizationWitness,
  witnessDigestMatches: boolean,
): CacheHitVerification {
  const reasons: IntentReasonCode[] = [];
  if (!witnessDigestMatches) {
    reasons.push('CACHE_WITNESS_TAMPERED');
  }
  const normalizationVerification =
    verifyNormalizationWitnessIntegrity(normalization);
  if (
    !normalizationVerification.verified ||
    !cacheWitnessMatchesNormalization(witness, normalization)
  ) {
    reasons.push('CACHE_NORMALIZATION_WITNESS_INVALID');
  }

  const expected = evaluateAdmission(
    witness.entry,
    witness.lookup,
    normalization,
    normalizationVerification.verified,
    witness.lookup.binding.effect,
  );
  if (!sameDecision(expected, witness.decision)) {
    reasons.push('CACHE_WITNESS_TAMPERED');
  }

  return { verified: reasons.length === 0, reasons: [...new Set(reasons)] };
}

/** Internal digest path for an already strict-schema-parsed cache witness. */
function digestParsedCacheHitWitness(witness: CacheHitWitness): Sha256Digest {
  const { witnessDigest: _witnessDigest, ...unsigned } = witness;
  return hashCanonical(toJsonValue(unsigned));
}

function cacheWitnessMatchesNormalization(
  witness: CacheHitWitness,
  normalization: NormalizationWitness,
): boolean {
  return (
    normalization.witnessDigest === witness.normalization.witnessDigest &&
    normalization.sourceDigest === witness.normalization.sourceDigest &&
    normalization.intentDigest === witness.normalization.intentDigest &&
    normalization.decision.verdict === witness.normalization.verdict &&
    canonicalJson(toJsonValue(normalization.decision.reasons)) ===
      canonicalJson(toJsonValue(witness.normalization.reasons))
  );
}

function evaluateAdmission(
  entry: CacheEntry,
  lookup: CacheLookup,
  normalization: Pick<
    NormalizationWitness,
    'intentDigest' | 'normalizer' | 'policyDigest' | 'assessment' | 'decision'
  >,
  normalizationVerified: boolean,
  currentIntentEffect: IntentEffect,
): ShadowDecision {
  const reasons: IntentReasonCode[] = [];
  if (!normalizationVerified) {
    reasons.push('CACHE_NORMALIZATION_WITNESS_INVALID');
  }
  if (normalization.decision.verdict !== 'eligible') {
    reasons.push('CACHE_NORMALIZATION_BYPASS');
  }
  if (
    normalization.intentDigest !== lookup.binding.intentDigest ||
    entry.binding.intentDigest !== lookup.binding.intentDigest
  ) {
    reasons.push('CACHE_INTENT_MISMATCH');
  }
  if (digestParsedCacheEntryPayload(entry) !== entry.entryDigest) {
    reasons.push('CACHE_ENTRY_DIGEST_MISMATCH');
  }
  if (
    currentIntentEffect !== lookup.binding.effect ||
    currentIntentEffect !== entry.binding.effect
  ) {
    reasons.push('CACHE_EFFECT_MISMATCH');
  }
  compareNormalizationContract(lookup.binding, normalization, reasons);
  compareBinding(entry.binding, lookup.binding, reasons);
  evaluateTierEffect(lookup.binding, reasons);
  evaluateFreshness(entry, lookup, reasons);

  return reasons.length === 0
    ? {
        verdict: 'eligible',
        applied: false,
        reasons: ['CACHE_HIT_ELIGIBLE'],
      }
    : { verdict: 'bypass', applied: false, reasons: [...new Set(reasons)] };
}

function compareBinding(
  entry: CacheBinding,
  lookup: CacheBinding,
  reasons: IntentReasonCode[],
): void {
  compare(
    entry.scope.cacheNamespace,
    lookup.scope.cacheNamespace,
    'CACHE_NAMESPACE_MISMATCH',
    reasons,
  );
  compare(
    entry.scope.tenant,
    lookup.scope.tenant,
    'CACHE_TENANT_MISMATCH',
    reasons,
  );
  compare(
    entry.scope.principal,
    lookup.scope.principal,
    'CACHE_PRINCIPAL_MISMATCH',
    reasons,
  );
  compare(
    entry.authorizationDigest,
    lookup.authorizationDigest,
    'CACHE_AUTHORIZATION_MISMATCH',
    reasons,
  );
  compare(
    entry.contextDigest,
    lookup.contextDigest,
    'CACHE_CONTEXT_MISMATCH',
    reasons,
  );
  compareNormalizer(
    entry.normalization.normalizer,
    lookup.normalization.normalizer,
    'CACHE_NORMALIZER_MISMATCH',
    reasons,
  );
  compare(
    entry.normalization.policyDigest,
    lookup.normalization.policyDigest,
    'CACHE_NORMALIZATION_POLICY_MISMATCH',
    reasons,
  );
  compareNumber(
    entry.normalization.minimumConfidencePpm,
    lookup.normalization.minimumConfidencePpm,
    'CACHE_NORMALIZATION_POLICY_MISMATCH',
    reasons,
  );
  compare(
    entry.policyDigest,
    lookup.policyDigest,
    'CACHE_POLICY_MISMATCH',
    reasons,
  );
  compare(entry.effect, lookup.effect, 'CACHE_EFFECT_MISMATCH', reasons);
  if (entry.tier !== lookup.tier) {
    reasons.push('CACHE_TIER_MISMATCH');
    return;
  }
  compareTierDependencies(entry, lookup, reasons);
}

function compareNormalizationContract(
  binding: CacheBinding,
  normalization: Pick<
    NormalizationWitness,
    'normalizer' | 'policyDigest' | 'assessment'
  >,
  reasons: IntentReasonCode[],
): void {
  compareNormalizer(
    binding.normalization.normalizer,
    normalization.normalizer,
    'CACHE_NORMALIZER_MISMATCH',
    reasons,
  );
  compare(
    binding.normalization.policyDigest,
    normalization.policyDigest,
    'CACHE_NORMALIZATION_POLICY_MISMATCH',
    reasons,
  );
  compareNumber(
    binding.normalization.minimumConfidencePpm,
    normalization.assessment.minimumConfidencePpm,
    'CACHE_NORMALIZATION_POLICY_MISMATCH',
    reasons,
  );
}

function compareNormalizer(
  left: NormalizerBinding,
  right: NormalizerBinding,
  reason: IntentReasonCode,
  reasons: IntentReasonCode[],
): void {
  if (
    left.id !== right.id ||
    left.version !== right.version ||
    left.artifactDigest !== right.artifactDigest ||
    left.configDigest !== right.configDigest
  ) {
    reasons.push(reason);
  }
}

function compareTierDependencies(
  entry: CacheBinding,
  lookup: CacheBinding,
  reasons: IntentReasonCode[],
): void {
  switch (entry.tier) {
    case 'plan': {
      const current = (lookup as Extract<CacheBinding, { tier: 'plan' }>)
        .dependencies;
      compare(
        entry.dependencies.operationRegistryDigest,
        current.operationRegistryDigest,
        'CACHE_OPERATION_REGISTRY_MISMATCH',
        reasons,
      );
      compare(
        entry.dependencies.plannerDigest,
        current.plannerDigest,
        'CACHE_PLANNER_MISMATCH',
        reasons,
      );
      compare(
        entry.dependencies.toolRegistryDigest,
        current.toolRegistryDigest,
        'CACHE_TOOL_REGISTRY_MISMATCH',
        reasons,
      );
      return;
    }
    case 'observation': {
      const current = (lookup as Extract<CacheBinding, { tier: 'observation' }>)
        .dependencies;
      compare(
        entry.dependencies.planDigest,
        current.planDigest,
        'CACHE_PLAN_MISMATCH',
        reasons,
      );
      compare(
        entry.dependencies.executionDigest,
        current.executionDigest,
        'CACHE_EXECUTION_MISMATCH',
        reasons,
      );
      compare(
        entry.dependencies.toolDigest,
        current.toolDigest,
        'CACHE_TOOL_MISMATCH',
        reasons,
      );
      return;
    }
    case 'response': {
      const current = (lookup as Extract<CacheBinding, { tier: 'response' }>)
        .dependencies;
      compare(
        entry.dependencies.observationValueDigest,
        current.observationValueDigest,
        'CACHE_OBSERVATION_MISMATCH',
        reasons,
      );
      compare(
        entry.dependencies.outputContractDigest,
        current.outputContractDigest,
        'CACHE_OUTPUT_CONTRACT_MISMATCH',
        reasons,
      );
      compare(
        entry.dependencies.promptDigest,
        current.promptDigest,
        'CACHE_PROMPT_MISMATCH',
        reasons,
      );
      compare(
        entry.dependencies.providerDigest,
        current.providerDigest,
        'CACHE_PROVIDER_MISMATCH',
        reasons,
      );
      compare(
        entry.dependencies.modelDigest,
        current.modelDigest,
        'CACHE_MODEL_MISMATCH',
        reasons,
      );
      compare(
        entry.dependencies.determinismDigest,
        current.determinismDigest,
        'CACHE_DETERMINISM_MISMATCH',
        reasons,
      );
      compare(
        entry.dependencies.personalizationDigest,
        current.personalizationDigest,
        'CACHE_PERSONALIZATION_MISMATCH',
        reasons,
      );
      compare(
        entry.dependencies.safetyPolicyDigest,
        current.safetyPolicyDigest,
        'CACHE_SAFETY_POLICY_MISMATCH',
        reasons,
      );
    }
  }
}

function evaluateTierEffect(
  binding: CacheBinding,
  reasons: IntentReasonCode[],
): void {
  if (binding.tier === 'response' && binding.effect !== 'read') {
    reasons.push('CACHE_TIER_EFFECT_FORBIDDEN');
  }
  if (binding.effect !== 'read' && binding.tier !== 'plan') {
    reasons.push('CACHE_TIER_EFFECT_FORBIDDEN');
  }
}

function evaluateFreshness(
  entry: CacheEntry,
  lookup: CacheLookup,
  reasons: IntentReasonCode[],
): void {
  if (entry.freshness.kind !== lookup.freshness.kind) {
    reasons.push('CACHE_FRESHNESS_MODE_MISMATCH');
    return;
  }
  if (entry.freshness.kind === 'ttl' && lookup.freshness.kind === 'ttl') {
    const age =
      lookup.freshness.checkedAtEpochMs - entry.freshness.createdAtEpochMs;
    if (age < 0 || age >= entry.freshness.ttlMs) {
      reasons.push('CACHE_STALE');
    }
    return;
  }
  if (
    entry.freshness.kind === 'revision-set' &&
    lookup.freshness.kind === 'revision-set' &&
    canonicalJson(
      toJsonValue(canonicalizeRevisions(entry.freshness.revisions)),
    ) !==
      canonicalJson(
        toJsonValue(canonicalizeRevisions(lookup.freshness.revisions)),
      )
  ) {
    reasons.push('CACHE_REVISION_MISMATCH');
  }
}

function canonicalizeEntry(entry: CacheEntry): CacheEntry {
  return entry.freshness.kind === 'revision-set'
    ? {
        ...entry,
        freshness: {
          ...entry.freshness,
          revisions: canonicalizeRevisions(entry.freshness.revisions),
        },
      }
    : entry;
}

function canonicalizeEntryPayload(
  input: CreateCacheEntryInput,
): CreateCacheEntryInput {
  const validated = parseCacheEntryPayloadDocument(input);
  return canonicalizeParsedEntryPayload(validated);
}

function canonicalizeParsedEntryPayload(
  validated: CreateCacheEntryInput,
): CreateCacheEntryInput {
  return validated.freshness.kind === 'revision-set'
    ? {
        valueDigest: validated.valueDigest,
        binding: validated.binding,
        freshness: {
          ...validated.freshness,
          revisions: canonicalizeRevisions(validated.freshness.revisions),
        },
      }
    : {
        valueDigest: validated.valueDigest,
        binding: validated.binding,
        freshness: validated.freshness,
      };
}

function digestParsedCacheEntryPayload(
  input: CreateCacheEntryInput | CacheEntry,
): Sha256Digest {
  const canonical = canonicalizeParsedEntryPayload({
    valueDigest: input.valueDigest,
    binding: input.binding,
    freshness: input.freshness,
  });
  return sha256(
    `${CACHE_ENTRY_DIGEST_PREFIX}${canonicalJson(toJsonValue(canonical))}`,
  );
}

function canonicalizeLookup(lookup: CacheLookup): CacheLookup {
  return lookup.freshness.kind === 'revision-set'
    ? {
        ...lookup,
        freshness: {
          ...lookup.freshness,
          revisions: canonicalizeRevisions(lookup.freshness.revisions),
        },
      }
    : lookup;
}

function compare(
  left: string,
  right: string,
  reason: IntentReasonCode,
  reasons: IntentReasonCode[],
): void {
  if (left !== right) {
    reasons.push(reason);
  }
}

function compareNumber(
  left: number,
  right: number,
  reason: IntentReasonCode,
  reasons: IntentReasonCode[],
): void {
  if (left !== right) {
    reasons.push(reason);
  }
}

function sameDecision(left: ShadowDecision, right: ShadowDecision): boolean {
  return (
    left.verdict === right.verdict &&
    left.applied === right.applied &&
    left.reasons.length === right.reasons.length &&
    left.reasons.every((reason, index) => reason === right.reasons[index])
  );
}
