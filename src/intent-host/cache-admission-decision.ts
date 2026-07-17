import { Buffer } from 'node:buffer';
import { types as utilTypes } from 'node:util';

import { canonicalJson, toJsonValue } from '../domain/canonical-json.js';
import { SemWitnessError } from '../domain/errors.js';
import { hashCanonical, isSha256Digest, sha256 } from '../domain/hash.js';
import type { Sha256Digest } from '../domain/types.js';
import {
  snapshotDataRecord,
  snapshotDenseDataArray,
} from '../host/data-only.js';
import {
  digestCacheHitWitnessArtifact,
  hmacCacheArtifactCommitments,
  hmacCacheKey,
  MAX_CACHE_HIT_WITNESS_ARTIFACT_BYTES,
  parseCacheHitWitnessArtifact,
  parseNormalizationWitness,
  serializeCacheHitWitnessArtifact,
  verifyCacheHitWitnessArtifact,
  verifyCacheHitWitnessIntegrity,
} from '../intent/index.js';
import { assertWellFormedUnicode } from '../intent/unicode.js';
import {
  parseIntentCacheAdmissionPassportStatement,
  verifyIntentCacheAdmissionPassportStatementBinding,
} from './cache-admission-passport.js';
import {
  IN_TOTO_STATEMENT_V1_TYPE,
  MAX_INTENT_CACHE_ADMISSION_PASSPORT_BYTES,
} from './cache-admission-passport-types.js';
import {
  INTENT_CACHE_ADMISSION_DECISION_ARTIFACT,
  INTENT_CACHE_ADMISSION_DECISION_PASSPORT_SUBJECT_NAME,
  INTENT_CACHE_ADMISSION_DECISION_PREDICATE_TYPE,
  INTENT_CACHE_ADMISSION_DECISION_WITNESS_SUBJECT_NAME,
  MAX_INTENT_CACHE_ADMISSION_DECISION_BYTES,
  MAX_INTENT_CACHE_ADMISSION_SECRET_BYTES,
  MAX_INTENT_CACHE_ADMISSION_VALUE_BYTES,
  type IntentCacheAdmissionDecisionBindingVerification,
  type IntentCacheAdmissionDecisionEvidence,
  type IntentCacheAdmissionDecisionPredicate,
  type IntentCacheAdmissionDecisionStatement,
  type IntentCacheAdmissionDecisionSubject,
} from './cache-admission-decision-types.js';
import {
  createInTotoProfileParseContext,
  digestExactInTotoPayload,
  parseInTotoProfileSource,
  snapshotRequiredInTotoProfileRecord,
  type InTotoProfileParseContext,
} from './in-toto-profile.js';
import {
  digestIntentCacheShadowQualificationManifest,
  parseIntentCacheShadowQualificationManifest,
} from './promotion.js';
import { parseIntentCacheEntrySourceBinding } from './promotion-evidence.js';
import { parseIntentCacheOperationBinding } from './receipts.js';

const ROOT_FIELDS = ['_type', 'subject', 'predicateType', 'predicate'] as const;
const SUBJECT_FIELDS = ['name', 'digest'] as const;
const DIGEST_FIELDS = ['sha256'] as const;
const PREDICATE_FIELDS = [
  'artifact',
  'profile',
  'authentication',
  'mode',
  'activationCeiling',
  'decision',
  'servingAuthority',
  'lineage',
  'scope',
  'candidate',
  'contracts',
  'privacy',
] as const;
const ARTIFACT_FIELDS = ['id', 'version'] as const;
const DECISION_FIELDS = ['verdict', 'applied', 'reasons'] as const;
const LINEAGE_FIELDS = [
  'qualificationDigest',
  'normalizationWitnessDigest',
  'cacheHitWitnessDigest',
  'operationBindingDigest',
  'entrySourceBindingDigest',
] as const;
const SCOPE_FIELDS = [
  'qualificationDeploymentScopeDigest',
  'cacheNamespace',
  'tenant',
  'principal',
  'authorization',
  'context',
  'domain',
  'operation',
] as const;
const CANDIDATE_FIELDS = [
  'cacheKeyDigest',
  'entryCommitment',
  'valueCommitment',
  'tier',
  'effect',
] as const;
const CONTRACT_FIELDS = [
  'cacheAdmissionPolicyDigest',
  'normalizationPolicyDigest',
  'qualificationDependenciesDigest',
] as const;
const PRIVACY_FIELDS = [
  'sourceDigest',
  'sourceContentIncluded',
  'valueContentIncluded',
  'rawIdentifiersIncluded',
] as const;
const EVIDENCE_FIELDS = [
  'passport',
  'qualification',
  'cacheHitWitness',
  'normalizationWitness',
  'operationBinding',
  'entrySourceBinding',
  'cacheKeySecret',
  'value',
] as const;

const TYPED_ARRAY_BUFFER_GETTER = Reflect.getOwnPropertyDescriptor(
  Reflect.getPrototypeOf(Uint8Array.prototype) as object,
  'buffer',
)?.get;
const TYPED_ARRAY_BYTE_LENGTH_GETTER = Reflect.getOwnPropertyDescriptor(
  Reflect.getPrototypeOf(Uint8Array.prototype) as object,
  'byteLength',
)?.get;

const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/u;
const HMAC_HEX = '[a-f0-9]{64}';
const SOURCE_HMAC = new RegExp(`^hmac-sha256:intent-source:${HMAC_HEX}$`, 'u');
const CACHE_KEY_HMAC = new RegExp(`^hmac-sha256:cache-key:${HMAC_HEX}$`, 'u');
const CACHE_ENTRY_HMAC = new RegExp(
  `^hmac-sha256:cache-entry:${HMAC_HEX}$`,
  'u',
);
const CACHE_VALUE_HMAC = new RegExp(
  `^hmac-sha256:cache-value:${HMAC_HEX}$`,
  'u',
);
const CACHE_NAMESPACE_HMAC = new RegExp(
  `^hmac-sha256:cache-namespace:${HMAC_HEX}$`,
  'u',
);
const TENANT_HMAC = new RegExp(`^hmac-sha256:tenant:${HMAC_HEX}$`, 'u');
const PRINCIPAL_HMAC = new RegExp(`^hmac-sha256:principal:${HMAC_HEX}$`, 'u');
const AUTHORIZATION_HMAC = new RegExp(
  `^hmac-sha256:authorization:${HMAC_HEX}$`,
  'u',
);
const CONTEXT_HMAC = new RegExp(`^hmac-sha256:context:${HMAC_HEX}$`, 'u');
const DOMAIN_HMAC = new RegExp(`^hmac-sha256:intent-domain:${HMAC_HEX}$`, 'u');
const OPERATION_HMAC = new RegExp(`^hmac-sha256:operation:${HMAC_HEX}$`, 'u');

interface ParsedDecisionProfile {
  readonly statement: IntentCacheAdmissionDecisionStatement;
  readonly extensionsPresent: boolean;
}

export function createIntentCacheAdmissionDecisionStatement(
  evidence: IntentCacheAdmissionDecisionEvidence,
): IntentCacheAdmissionDecisionStatement {
  try {
    return createDecisionStatementFromSnapshot(
      snapshotDecisionEvidence(evidence),
    );
  } catch {
    throw malformedDecision();
  }
}

export function parseIntentCacheAdmissionDecisionStatement(
  source: unknown,
): IntentCacheAdmissionDecisionStatement {
  try {
    return parseDecisionProfile(source).statement;
  } catch {
    throw malformedDecision();
  }
}

/** Canonical JSON without a BOM or trailing line feed, ready for DSSE. */
export function serializeIntentCacheAdmissionDecisionStatement(
  source: unknown,
): string {
  return canonicalJson(
    toJsonValue(parseIntentCacheAdmissionDecisionStatement(source)),
  );
}

/** Extension-eliding supported-profile digest, not an exact payload identity. */
export function digestIntentCacheAdmissionDecisionCanonicalProfile(
  source: unknown,
): Sha256Digest {
  return sha256(serializeIntentCacheAdmissionDecisionStatement(source));
}

export function verifyIntentCacheAdmissionDecisionStatementBinding(
  statementSource: unknown,
  evidence: IntentCacheAdmissionDecisionEvidence,
): IntentCacheAdmissionDecisionBindingVerification {
  let parsed: ParsedDecisionProfile;
  let statementSnapshot: unknown;
  let evidenceSnapshot: IntentCacheAdmissionDecisionEvidence;
  let expected: IntentCacheAdmissionDecisionStatement;
  try {
    statementSnapshot = snapshotPayloadSource(
      statementSource,
      MAX_INTENT_CACHE_ADMISSION_DECISION_BYTES,
    );
    evidenceSnapshot = snapshotDecisionEvidence(evidence);
    parsed = parseDecisionProfileSnapshot(statementSnapshot);
    expected = createDecisionStatementFromSnapshot(evidenceSnapshot);
  } catch {
    throw malformedDecision();
  }
  const canonicalProfileDigest =
    digestIntentCacheAdmissionDecisionCanonicalProfile(parsed.statement);
  const payloadDigest = digestExactInTotoPayload(statementSnapshot);
  const canonicalPayload =
    payloadDigest === null ? null : payloadDigest === canonicalProfileDigest;
  const suppliedPassportPayloadDigest = sha256(evidenceSnapshot.passport);
  const suppliedWitnessPayloadDigest = sha256(evidenceSnapshot.cacheHitWitness);
  const passportSubject = parsed.statement.subject[0];
  const witnessSubject = parsed.statement.subject[1];
  const profileBound =
    !parsed.extensionsPresent &&
    serializeIntentCacheAdmissionDecisionStatement(parsed.statement) ===
      serializeIntentCacheAdmissionDecisionStatement(expected);
  return Object.freeze({
    bound: profileBound && canonicalPayload === true,
    profileBound,
    extensionsPresent: parsed.extensionsPresent,
    canonicalProfileDigest,
    payloadDigest,
    canonicalPayload,
    statementPassportPayloadDigest:
      `sha256:${passportSubject.digest.sha256}` as Sha256Digest,
    suppliedPassportPayloadDigest,
    statementWitnessPayloadDigest:
      `sha256:${witnessSubject.digest.sha256}` as Sha256Digest,
    suppliedWitnessPayloadDigest,
    servingAuthority: 'none',
  });
}

function createDecisionStatementFromSnapshot(
  evidence: IntentCacheAdmissionDecisionEvidence,
): IntentCacheAdmissionDecisionStatement {
  return parseIntentCacheAdmissionDecisionStatement(
    deriveDecisionStatement(evidence),
  );
}

function snapshotDecisionEvidence(
  source: unknown,
): IntentCacheAdmissionDecisionEvidence {
  const root = snapshotDataRecord(source, EVIDENCE_FIELDS);
  return Object.freeze({
    passport: snapshotBytesOrString(
      root.passport,
      MAX_INTENT_CACHE_ADMISSION_PASSPORT_BYTES,
    ),
    qualification: root.qualification,
    cacheHitWitness: snapshotBytesOrString(
      root.cacheHitWitness,
      MAX_CACHE_HIT_WITNESS_ARTIFACT_BYTES,
    ),
    normalizationWitness: root.normalizationWitness,
    operationBinding: root.operationBinding,
    entrySourceBinding: root.entrySourceBinding,
    cacheKeySecret: snapshotBytesOrString(
      root.cacheKeySecret,
      MAX_INTENT_CACHE_ADMISSION_SECRET_BYTES,
    ),
    value: snapshotBytesOrString(
      root.value,
      MAX_INTENT_CACHE_ADMISSION_VALUE_BYTES,
    ),
  });
}

function snapshotPayloadSource(source: unknown, maximumBytes: number): unknown {
  if (typeof source === 'string') {
    if (Buffer.byteLength(source, 'utf8') > maximumBytes) {
      throw malformedDecision();
    }
    return source;
  }
  if (utilTypes.isProxy(source)) throw malformedDecision();
  return utilTypes.isUint8Array(source)
    ? snapshotBytes(source, maximumBytes)
    : source;
}

function snapshotBytesOrString(
  source: unknown,
  maximumBytes: number,
): string | Uint8Array {
  if (typeof source === 'string') {
    if (Buffer.byteLength(source, 'utf8') > maximumBytes) {
      throw malformedDecision();
    }
    return source;
  }
  if (utilTypes.isProxy(source) || !utilTypes.isUint8Array(source)) {
    throw malformedDecision();
  }
  return snapshotBytes(source, maximumBytes);
}

function snapshotBytes(source: Uint8Array, maximumBytes: number): Uint8Array {
  if (
    TYPED_ARRAY_BUFFER_GETTER === undefined ||
    TYPED_ARRAY_BYTE_LENGTH_GETTER === undefined
  ) {
    throw malformedDecision();
  }
  const buffer = Reflect.apply(TYPED_ARRAY_BUFFER_GETTER, source, []);
  if (utilTypes.isSharedArrayBuffer(buffer)) throw malformedDecision();
  const byteLength = Reflect.apply(TYPED_ARRAY_BYTE_LENGTH_GETTER, source, []);
  if (byteLength > maximumBytes) throw malformedDecision();
  return new Uint8Array(source);
}

function deriveDecisionStatement(
  evidence: IntentCacheAdmissionDecisionEvidence,
): IntentCacheAdmissionDecisionStatement {
  const qualification = parseIntentCacheShadowQualificationManifest(
    evidence.qualification,
  );
  const passport = parseIntentCacheAdmissionPassportStatement(
    evidence.passport,
  );
  const passportBinding = verifyIntentCacheAdmissionPassportStatementBinding(
    evidence.passport,
    qualification,
  );
  if (
    !passportBinding.bound ||
    passportBinding.canonicalPayload !== true ||
    passportBinding.payloadDigest === null
  ) {
    throw malformedDecision();
  }

  const cacheHit = parseCacheHitWitnessArtifact(evidence.cacheHitWitness);
  const cacheHitArtifact = verifyCacheHitWitnessArtifact(
    evidence.cacheHitWitness,
  );
  if (
    cacheHitArtifact.canonical !== true ||
    cacheHitArtifact.payloadDigest === null
  ) {
    throw malformedDecision();
  }
  const normalization = parseNormalizationWitness(
    evidence.normalizationWitness,
  );
  const integrity = verifyCacheHitWitnessIntegrity(cacheHit, normalization);
  const operation = parseIntentCacheOperationBinding(evidence.operationBinding);
  const entrySource = parseIntentCacheEntrySourceBinding(
    evidence.entrySourceBinding,
  );
  if (
    !integrity.verified ||
    cacheHit.decision.verdict !== 'eligible' ||
    cacheHit.decision.applied !== false ||
    cacheHit.decision.reasons.length !== 1 ||
    cacheHit.decision.reasons[0] !== 'CACHE_HIT_ELIGIBLE' ||
    cacheHit.lookup.binding.tier !== 'plan' ||
    cacheHit.lookup.binding.effect !== 'read' ||
    cacheHit.entry.binding.tier !== 'plan' ||
    cacheHit.entry.binding.effect !== 'read' ||
    typeof normalization.sourceDigest !== 'string' ||
    !SOURCE_HMAC.test(normalization.sourceDigest)
  ) {
    throw malformedDecision();
  }

  const binding = cacheHit.lookup.binding;
  if (
    operation.operation !== passport.predicate.scope.operation ||
    operation.domain !== passport.predicate.scope.domain ||
    operation.intentDigest !== binding.intentDigest ||
    operation.effect !== binding.effect ||
    operation.operationRegistryDigest !==
      qualification.intentContract.operationRegistry.digest ||
    operation.operationRegistryDigest !==
      binding.dependencies.operationRegistryDigest ||
    operation.ontologyDigest !== qualification.intentContract.ontology.digest ||
    hashCanonical(toJsonValue(normalization.normalizer)) !==
      hashCanonical(toJsonValue(qualification.intentContract.normalizer)) ||
    hashCanonical(toJsonValue(normalization.ontology)) !==
      hashCanonical(toJsonValue(qualification.intentContract.ontology)) ||
    binding.dependencies.plannerDigest !==
      qualification.dependencies.planner.artifact.digest ||
    binding.dependencies.toolRegistryDigest !==
      qualification.dependencies.tool.artifact.digest ||
    entrySource.entryDigest !== cacheHit.entry.entryDigest ||
    entrySource.valueDigest !== cacheHit.entry.valueDigest ||
    binding.scope.cacheNamespace !== passport.predicate.scope.cacheNamespace ||
    binding.scope.tenant !== passport.predicate.scope.tenant ||
    binding.policyDigest !==
      passport.predicate.contracts.cacheAdmissionPolicyDigest ||
    binding.normalization.policyDigest !==
      passport.predicate.contracts.normalizationPolicyDigest
  ) {
    throw malformedDecision();
  }

  if (typeof evidence.value === 'string') {
    assertWellFormedUnicode(evidence.value, 'Cache value');
  }
  if (sha256(evidence.value) !== cacheHit.entry.valueDigest) {
    throw malformedDecision();
  }
  const dependenciesDigest = hashCanonical(
    toJsonValue(qualification.dependencies),
  );
  if (dependenciesDigest !== passport.predicate.contracts.dependenciesDigest) {
    throw malformedDecision();
  }
  const witnessPayload = serializeCacheHitWitnessArtifact(cacheHit);
  const passportPayloadDigest = passportBinding.payloadDigest;
  const witnessPayloadDigest = digestCacheHitWitnessArtifact(witnessPayload);
  const artifactCommitments = hmacCacheArtifactCommitments(
    evidence.cacheKeySecret,
    binding,
    cacheHit.entry.entryDigest,
    cacheHit.entry.valueDigest,
  );
  const predicate: IntentCacheAdmissionDecisionPredicate = {
    artifact: INTENT_CACHE_ADMISSION_DECISION_ARTIFACT,
    profile: 'intent-plan-read',
    authentication: 'none',
    mode: 'shadow',
    activationCeiling: 'shadow-only',
    decision: {
      verdict: 'eligible',
      applied: false,
      reasons: ['CACHE_HIT_ELIGIBLE'],
    },
    servingAuthority: 'none',
    lineage: {
      qualificationDigest:
        digestIntentCacheShadowQualificationManifest(qualification),
      normalizationWitnessDigest: normalization.witnessDigest,
      cacheHitWitnessDigest: cacheHit.witnessDigest,
      operationBindingDigest: operation.bindingDigest,
      entrySourceBindingDigest: entrySource.bindingDigest,
    },
    scope: {
      qualificationDeploymentScopeDigest:
        passport.predicate.scope.deploymentScopeDigest,
      cacheNamespace: passport.predicate.scope.cacheNamespace,
      tenant: passport.predicate.scope.tenant,
      principal: binding.scope.principal,
      authorization: binding.authorizationDigest,
      context: binding.contextDigest,
      domain: passport.predicate.scope.domain,
      operation: passport.predicate.scope.operation,
    },
    candidate: {
      cacheKeyDigest: hmacCacheKey(evidence.cacheKeySecret, binding),
      entryCommitment: artifactCommitments.entry,
      valueCommitment: artifactCommitments.value,
      tier: 'plan',
      effect: 'read',
    },
    contracts: {
      cacheAdmissionPolicyDigest:
        passport.predicate.contracts.cacheAdmissionPolicyDigest,
      normalizationPolicyDigest:
        passport.predicate.contracts.normalizationPolicyDigest,
      qualificationDependenciesDigest: dependenciesDigest,
    },
    privacy: {
      sourceDigest:
        normalization.sourceDigest as IntentCacheAdmissionDecisionPredicate['privacy']['sourceDigest'],
      sourceContentIncluded: false,
      valueContentIncluded: false,
      rawIdentifiersIncluded: false,
    },
  };

  return {
    _type: IN_TOTO_STATEMENT_V1_TYPE,
    subject: [
      subject(
        INTENT_CACHE_ADMISSION_DECISION_PASSPORT_SUBJECT_NAME,
        passportPayloadDigest,
      ),
      subject(
        INTENT_CACHE_ADMISSION_DECISION_WITNESS_SUBJECT_NAME,
        witnessPayloadDigest,
      ),
    ],
    predicateType: INTENT_CACHE_ADMISSION_DECISION_PREDICATE_TYPE,
    predicate,
  };
}

function subject(
  name: IntentCacheAdmissionDecisionSubject['name'],
  digest: Sha256Digest,
): IntentCacheAdmissionDecisionSubject {
  return {
    name,
    digest: { sha256: digest.slice('sha256:'.length) },
  };
}

function parseDecisionProfile(source: unknown): ParsedDecisionProfile {
  return parseDecisionProfileSnapshot(
    snapshotPayloadSource(source, MAX_INTENT_CACHE_ADMISSION_DECISION_BYTES),
  );
}

function parseDecisionProfileSnapshot(source: unknown): ParsedDecisionProfile {
  const limits = decisionJsonLimits();
  const context = createInTotoProfileParseContext(limits);
  const statement = parseStatement(
    parseInTotoProfileSource(
      source,
      MAX_INTENT_CACHE_ADMISSION_DECISION_BYTES,
      limits,
    ),
    context,
  );
  return Object.freeze({
    statement,
    extensionsPresent: context.extensionsPresent,
  });
}

function parseStatement(
  source: unknown,
  context: InTotoProfileParseContext,
): IntentCacheAdmissionDecisionStatement {
  const root = record(source, ROOT_FIELDS, 32, context, 0);
  if (
    root._type !== IN_TOTO_STATEMENT_V1_TYPE ||
    root.predicateType !== INTENT_CACHE_ADMISSION_DECISION_PREDICATE_TYPE
  ) {
    throw malformedDecision();
  }
  return Object.freeze({
    _type: IN_TOTO_STATEMENT_V1_TYPE,
    subject: parseSubjects(root.subject, context),
    predicateType: INTENT_CACHE_ADMISSION_DECISION_PREDICATE_TYPE,
    predicate: parsePredicate(root.predicate, context),
  });
}

function parseSubjects(
  source: unknown,
  context: InTotoProfileParseContext,
): IntentCacheAdmissionDecisionStatement['subject'] {
  const values = snapshotDenseDataArray(source, 2, 2).map((value) =>
    parseSubject(value, context),
  );
  const passport = values.find(
    (value) =>
      value.name === INTENT_CACHE_ADMISSION_DECISION_PASSPORT_SUBJECT_NAME,
  );
  const witness = values.find(
    (value) =>
      value.name === INTENT_CACHE_ADMISSION_DECISION_WITNESS_SUBJECT_NAME,
  );
  if (passport === undefined || witness === undefined || passport === witness) {
    throw malformedDecision();
  }
  return Object.freeze([passport, witness]);
}

function parseSubject(
  source: unknown,
  context: InTotoProfileParseContext,
): IntentCacheAdmissionDecisionSubject {
  const root = record(source, SUBJECT_FIELDS, 16, context, 2);
  const digest = record(root.digest, DIGEST_FIELDS, 16, context, 3);
  if (
    (root.name !== INTENT_CACHE_ADMISSION_DECISION_PASSPORT_SUBJECT_NAME &&
      root.name !== INTENT_CACHE_ADMISSION_DECISION_WITNESS_SUBJECT_NAME) ||
    typeof digest.sha256 !== 'string' ||
    !SHA256_HEX_PATTERN.test(digest.sha256)
  ) {
    throw malformedDecision();
  }
  return Object.freeze({
    name: root.name,
    digest: Object.freeze({ sha256: digest.sha256 }),
  });
}

function parsePredicate(
  source: unknown,
  context: InTotoProfileParseContext,
): IntentCacheAdmissionDecisionPredicate {
  const root = record(source, PREDICATE_FIELDS, 32, context, 1);
  const artifact = record(root.artifact, ARTIFACT_FIELDS, 16, context, 2);
  if (
    artifact.id !== INTENT_CACHE_ADMISSION_DECISION_ARTIFACT.id ||
    artifact.version !== INTENT_CACHE_ADMISSION_DECISION_ARTIFACT.version ||
    root.profile !== 'intent-plan-read' ||
    root.authentication !== 'none' ||
    root.mode !== 'shadow' ||
    root.activationCeiling !== 'shadow-only' ||
    root.servingAuthority !== 'none'
  ) {
    throw malformedDecision();
  }
  return Object.freeze({
    artifact: INTENT_CACHE_ADMISSION_DECISION_ARTIFACT,
    profile: 'intent-plan-read',
    authentication: 'none',
    mode: 'shadow',
    activationCeiling: 'shadow-only',
    decision: parseDecision(root.decision, context),
    servingAuthority: 'none',
    lineage: parseDigestRecord(root.lineage, LINEAGE_FIELDS, context, 2),
    scope: parseScope(root.scope, context),
    candidate: parseCandidate(root.candidate, context),
    contracts: parseDigestRecord(root.contracts, CONTRACT_FIELDS, context, 2),
    privacy: parsePrivacy(root.privacy, context),
  });
}

function parseDecision(
  source: unknown,
  context: InTotoProfileParseContext,
): IntentCacheAdmissionDecisionPredicate['decision'] {
  const root = record(source, DECISION_FIELDS, 16, context, 2);
  const reasons = snapshotDenseDataArray(root.reasons, 1, 1);
  if (
    root.verdict !== 'eligible' ||
    root.applied !== false ||
    reasons[0] !== 'CACHE_HIT_ELIGIBLE'
  ) {
    throw malformedDecision();
  }
  return Object.freeze({
    verdict: 'eligible',
    applied: false,
    reasons: Object.freeze(['CACHE_HIT_ELIGIBLE'] as const),
  });
}

function parseScope(
  source: unknown,
  context: InTotoProfileParseContext,
): IntentCacheAdmissionDecisionPredicate['scope'] {
  const root = record(source, SCOPE_FIELDS, 24, context, 2);
  if (
    !isSha256Digest(root.qualificationDeploymentScopeDigest) ||
    !matches(root.cacheNamespace, CACHE_NAMESPACE_HMAC) ||
    !matches(root.tenant, TENANT_HMAC) ||
    !matches(root.principal, PRINCIPAL_HMAC) ||
    !matches(root.authorization, AUTHORIZATION_HMAC) ||
    !matches(root.context, CONTEXT_HMAC) ||
    !matches(root.domain, DOMAIN_HMAC) ||
    !matches(root.operation, OPERATION_HMAC)
  ) {
    throw malformedDecision();
  }
  return Object.freeze({
    qualificationDeploymentScopeDigest: root.qualificationDeploymentScopeDigest,
    cacheNamespace:
      root.cacheNamespace as IntentCacheAdmissionDecisionPredicate['scope']['cacheNamespace'],
    tenant:
      root.tenant as IntentCacheAdmissionDecisionPredicate['scope']['tenant'],
    principal:
      root.principal as IntentCacheAdmissionDecisionPredicate['scope']['principal'],
    authorization:
      root.authorization as IntentCacheAdmissionDecisionPredicate['scope']['authorization'],
    context:
      root.context as IntentCacheAdmissionDecisionPredicate['scope']['context'],
    domain:
      root.domain as IntentCacheAdmissionDecisionPredicate['scope']['domain'],
    operation:
      root.operation as IntentCacheAdmissionDecisionPredicate['scope']['operation'],
  });
}

function parseCandidate(
  source: unknown,
  context: InTotoProfileParseContext,
): IntentCacheAdmissionDecisionPredicate['candidate'] {
  const root = record(source, CANDIDATE_FIELDS, 16, context, 2);
  if (
    !matches(root.cacheKeyDigest, CACHE_KEY_HMAC) ||
    !matches(root.entryCommitment, CACHE_ENTRY_HMAC) ||
    !matches(root.valueCommitment, CACHE_VALUE_HMAC) ||
    root.tier !== 'plan' ||
    root.effect !== 'read'
  ) {
    throw malformedDecision();
  }
  return Object.freeze({
    cacheKeyDigest:
      root.cacheKeyDigest as IntentCacheAdmissionDecisionPredicate['candidate']['cacheKeyDigest'],
    entryCommitment:
      root.entryCommitment as IntentCacheAdmissionDecisionPredicate['candidate']['entryCommitment'],
    valueCommitment:
      root.valueCommitment as IntentCacheAdmissionDecisionPredicate['candidate']['valueCommitment'],
    tier: 'plan',
    effect: 'read',
  });
}

function parsePrivacy(
  source: unknown,
  context: InTotoProfileParseContext,
): IntentCacheAdmissionDecisionPredicate['privacy'] {
  const root = record(source, PRIVACY_FIELDS, 16, context, 2);
  if (
    !matches(root.sourceDigest, SOURCE_HMAC) ||
    root.sourceContentIncluded !== false ||
    root.valueContentIncluded !== false ||
    root.rawIdentifiersIncluded !== false
  ) {
    throw malformedDecision();
  }
  return Object.freeze({
    sourceDigest:
      root.sourceDigest as IntentCacheAdmissionDecisionPredicate['privacy']['sourceDigest'],
    sourceContentIncluded: false,
    valueContentIncluded: false,
    rawIdentifiersIncluded: false,
  });
}

function parseDigestRecord<const Field extends string>(
  source: unknown,
  fields: readonly Field[],
  context: InTotoProfileParseContext,
  depth: number,
): Readonly<Record<Field, Sha256Digest>> {
  const root = record(source, fields, 24, context, depth);
  const result: Partial<Record<Field, Sha256Digest>> = Object.create(
    null,
  ) as Partial<Record<Field, Sha256Digest>>;
  for (const field of fields) {
    if (!isSha256Digest(root[field])) throw malformedDecision();
    result[field] = root[field];
  }
  return Object.freeze(result as Record<Field, Sha256Digest>);
}

function record<const Field extends string>(
  source: unknown,
  fields: readonly Field[],
  maximumFields: number,
  context: InTotoProfileParseContext,
  depth: number,
): Readonly<Record<Field, unknown>> {
  return snapshotRequiredInTotoProfileRecord(
    source,
    fields,
    maximumFields,
    context,
    depth,
  );
}

function matches<const Value extends string>(
  value: unknown,
  pattern: RegExp,
): value is Value {
  return typeof value === 'string' && pattern.test(value);
}

function decisionJsonLimits() {
  return {
    maxDepth: 12,
    maxItems: 384,
    maxStringCodeUnits: 1_024,
    maxNumberCodeUnits: 32,
  } as const;
}

function malformedDecision(): SemWitnessError {
  return new SemWitnessError(
    'MALFORMED_ENVELOPE',
    'Malformed intent-cache Admission Decision Statement',
  );
}
