import { canonicalJson, toJsonValue } from '../domain/canonical-json.js';
import { SemWitnessError } from '../domain/errors.js';
import { hashCanonical, isSha256Digest, sha256 } from '../domain/hash.js';
import {
  SAFE_IDENTIFIER_PATTERN,
  SAFE_VERSION_PATTERN,
  type Sha256Digest,
} from '../domain/types.js';
import { snapshotDenseDataArray } from '../host/data-only.js';
import {
  digestIntentCacheShadowQualificationManifest,
  parseIntentCacheShadowQualificationManifest,
} from './promotion.js';
import {
  IN_TOTO_STATEMENT_V1_TYPE,
  INTENT_CACHE_ADMISSION_PASSPORT_ARTIFACT,
  INTENT_CACHE_ADMISSION_PASSPORT_PREDICATE_TYPE,
  INTENT_CACHE_ADMISSION_PASSPORT_SUBJECT_NAME,
  MAX_INTENT_CACHE_ADMISSION_PASSPORT_BYTES,
  type IntentCacheAdmissionPassportBindingVerification,
  type IntentCacheAdmissionPassportPredicate,
  type IntentCacheAdmissionPassportStatement,
  type IntentCacheAdmissionPassportSubject,
} from './cache-admission-passport-types.js';
import {
  createInTotoProfileParseContext,
  digestExactInTotoPayload as digestExactPayload,
  parseCanonicalRfc3339Utc,
  parseInTotoProfileSource as parseProfileSource,
  snapshotRequiredInTotoProfileRecord as snapshotRequiredRecord,
  toCanonicalRfc3339Utc,
  type InTotoProfileParseContext as StatementParseContext,
} from './in-toto-profile.js';

const ROOT_FIELDS = ['_type', 'subject', 'predicateType', 'predicate'] as const;
const SUBJECT_FIELDS = ['name', 'digest'] as const;
const DIGEST_FIELDS = ['sha256'] as const;
const PREDICATE_FIELDS = [
  'artifact',
  'profile',
  'authentication',
  'decision',
  'activationCeiling',
  'basis',
  'validity',
  'scope',
  'contracts',
  'evidence',
] as const;
const ARTIFACT_FIELDS = ['id', 'version'] as const;
const BASIS_FIELDS = [
  'schema',
  'artifact',
  'provenance',
  'evidenceAuthentication',
  'producerIdentity',
] as const;
const VALIDITY_FIELDS = ['notBefore', 'notAfter', 'revocationId'] as const;
const SCOPE_FIELDS = [
  'deploymentScopeDigest',
  'cacheNamespace',
  'tenant',
  'domain',
  'operation',
] as const;
const CONTRACT_FIELDS = [
  'cacheAdmissionPolicyDigest',
  'normalizationPolicyDigest',
  'dependenciesDigest',
] as const;
const EVIDENCE_FIELDS = ['reportDigest', 'evaluatorDigest'] as const;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/u;
const HMAC_HEX = '[a-f0-9]{64}';
const CACHE_NAMESPACE_HMAC = new RegExp(
  `^hmac-sha256:cache-namespace:${HMAC_HEX}$`,
  'u',
);
const TENANT_HMAC = new RegExp(`^hmac-sha256:tenant:${HMAC_HEX}$`, 'u');
const DOMAIN_HMAC = new RegExp(`^hmac-sha256:intent-domain:${HMAC_HEX}$`, 'u');
const OPERATION_HMAC = new RegExp(`^hmac-sha256:operation:${HMAC_HEX}$`, 'u');
const REVOCATION_HMAC = new RegExp(`^hmac-sha256:revocation:${HMAC_HEX}$`, 'u');
interface ParsedStatementProfile {
  readonly statement: IntentCacheAdmissionPassportStatement;
  readonly extensionsPresent: boolean;
}

/** Create a Statement from only trusted fields already present in the manifest. */
export function createIntentCacheAdmissionPassportStatement(
  qualificationSource: unknown,
): IntentCacheAdmissionPassportStatement {
  const qualification =
    parseIntentCacheShadowQualificationManifest(qualificationSource);
  const qualificationDigest =
    digestIntentCacheShadowQualificationManifest(qualification);
  return parseIntentCacheAdmissionPassportStatement({
    _type: IN_TOTO_STATEMENT_V1_TYPE,
    subject: [
      {
        name: INTENT_CACHE_ADMISSION_PASSPORT_SUBJECT_NAME,
        digest: { sha256: qualificationDigest.slice('sha256:'.length) },
      },
    ],
    predicateType: INTENT_CACHE_ADMISSION_PASSPORT_PREDICATE_TYPE,
    predicate: {
      artifact: INTENT_CACHE_ADMISSION_PASSPORT_ARTIFACT,
      profile: 'intent-plan-read',
      authentication: 'none',
      decision: 'shadow-qualified',
      activationCeiling: 'shadow-only',
      basis: {
        schema: qualification.schema,
        artifact: qualification.artifact,
        provenance: qualification.provenance,
        evidenceAuthentication: qualification.evidenceAuthentication,
        producerIdentity: qualification.producerIdentity,
      },
      validity: {
        notBefore: toCanonicalRfc3339Utc(
          qualification.validity.notBeforeEpochMs,
        ),
        notAfter: toCanonicalRfc3339Utc(qualification.validity.notAfterEpochMs),
        revocationId: qualification.validity.revocationId,
      },
      scope: {
        deploymentScopeDigest: qualification.deploymentScopeDigest,
        cacheNamespace: qualification.scope.cacheNamespace,
        tenant: qualification.scope.tenant,
        domain: qualification.scope.domain,
        operation: qualification.scope.operation.operation,
      },
      contracts: {
        cacheAdmissionPolicyDigest:
          qualification.intentContract.cacheAdmissionPolicyDigest,
        normalizationPolicyDigest:
          qualification.intentContract.normalizationPolicyDigest,
        dependenciesDigest: hashCanonical(
          toJsonValue(qualification.dependencies),
        ),
      },
      evidence: {
        reportDigest: qualification.evidence.reportDigest,
        evaluatorDigest: qualification.evidence.evaluatorDigest,
      },
    },
  });
}

/**
 * Parse bounded strict JSON and validate the SemWitness profile. Unrecognized
 * in-toto/predicate extension fields are ignored monotonically as required by
 * the in-toto v1 parsing rules; they can never turn a mismatch into `bound`.
 */
export function parseIntentCacheAdmissionPassportStatement(
  source: unknown,
): IntentCacheAdmissionPassportStatement {
  try {
    return parseStatementProfile(source).statement;
  } catch {
    throw malformedPassport();
  }
}

/** Canonical JSON without a trailing newline, suitable for exact DSSE payload bytes. */
export function serializeIntentCacheAdmissionPassportStatement(
  source: unknown,
): string {
  return canonicalJson(
    toJsonValue(parseIntentCacheAdmissionPassportStatement(source)),
  );
}

/** Digest of the extension-eliding supported profile; never a raw payload commitment. */
export function digestIntentCacheAdmissionPassportCanonicalProfile(
  source: unknown,
): Sha256Digest {
  return sha256(serializeIntentCacheAdmissionPassportStatement(source));
}

/**
 * Verify canonical bytes when present, plus subject and every derived field
 * against a separate qualification. `bound` never means authorization.
 */
export function verifyIntentCacheAdmissionPassportStatementBinding(
  statementSource: unknown,
  qualificationSource: unknown,
): IntentCacheAdmissionPassportBindingVerification {
  let parsed: ParsedStatementProfile;
  try {
    parsed = parseStatementProfile(statementSource);
  } catch {
    throw malformedPassport();
  }
  const statement = parsed.statement;
  const qualification =
    parseIntentCacheShadowQualificationManifest(qualificationSource);
  const expected = createIntentCacheAdmissionPassportStatement(qualification);
  const suppliedQualificationDigest =
    digestIntentCacheShadowQualificationManifest(qualification);
  const canonicalProfileDigest =
    digestIntentCacheAdmissionPassportCanonicalProfile(statement);
  const payloadDigest = digestExactPayload(statementSource);
  const canonicalPayload =
    payloadDigest === null ? null : payloadDigest === canonicalProfileDigest;
  return Object.freeze({
    bound:
      !parsed.extensionsPresent &&
      canonicalPayload !== false &&
      serializeIntentCacheAdmissionPassportStatement(statement) ===
        serializeIntentCacheAdmissionPassportStatement(expected),
    extensionsPresent: parsed.extensionsPresent,
    canonicalProfileDigest,
    payloadDigest,
    canonicalPayload,
    statementQualificationDigest:
      `sha256:${statement.subject[0].digest.sha256}` as Sha256Digest,
    suppliedQualificationDigest,
  });
}

function parseStatementProfile(source: unknown): ParsedStatementProfile {
  const context = createInTotoProfileParseContext(statementJsonLimits());
  const statement = parseStatement(
    parseProfileSource(
      source,
      MAX_INTENT_CACHE_ADMISSION_PASSPORT_BYTES,
      statementJsonLimits(),
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
  context: StatementParseContext,
): IntentCacheAdmissionPassportStatement {
  const root = snapshotRequiredRecord(source, ROOT_FIELDS, 32, context, 0);
  if (
    root._type !== IN_TOTO_STATEMENT_V1_TYPE ||
    root.predicateType !== INTENT_CACHE_ADMISSION_PASSPORT_PREDICATE_TYPE
  ) {
    throw malformedPassport();
  }
  const subject = parseSubject(root.subject, context);
  const predicate = parsePredicate(root.predicate, context);
  return Object.freeze({
    _type: IN_TOTO_STATEMENT_V1_TYPE,
    subject: Object.freeze([subject]) as readonly [
      IntentCacheAdmissionPassportSubject,
    ],
    predicateType: INTENT_CACHE_ADMISSION_PASSPORT_PREDICATE_TYPE,
    predicate,
  });
}

function parseSubject(
  source: unknown,
  context: StatementParseContext,
): IntentCacheAdmissionPassportSubject {
  const subjects = snapshotDenseDataArray(source, 1, 1);
  const root = snapshotRequiredRecord(
    subjects[0],
    SUBJECT_FIELDS,
    16,
    context,
    2,
  );
  const digest = snapshotRequiredRecord(
    root.digest,
    DIGEST_FIELDS,
    16,
    context,
    3,
  );
  if (
    root.name !== INTENT_CACHE_ADMISSION_PASSPORT_SUBJECT_NAME ||
    typeof digest.sha256 !== 'string' ||
    !SHA256_HEX_PATTERN.test(digest.sha256)
  ) {
    throw malformedPassport();
  }
  return Object.freeze({
    name: INTENT_CACHE_ADMISSION_PASSPORT_SUBJECT_NAME,
    digest: Object.freeze({ sha256: digest.sha256 }),
  });
}

function parsePredicate(
  source: unknown,
  context: StatementParseContext,
): IntentCacheAdmissionPassportPredicate {
  const root = snapshotRequiredRecord(source, PREDICATE_FIELDS, 32, context, 1);
  if (
    root.profile !== 'intent-plan-read' ||
    root.authentication !== 'none' ||
    root.decision !== 'shadow-qualified' ||
    root.activationCeiling !== 'shadow-only'
  ) {
    throw malformedPassport();
  }
  const artifact = parseArtifact(root.artifact, context, 2);
  if (
    artifact.id !== INTENT_CACHE_ADMISSION_PASSPORT_ARTIFACT.id ||
    artifact.version !== INTENT_CACHE_ADMISSION_PASSPORT_ARTIFACT.version
  ) {
    throw malformedPassport();
  }
  const basis = parseBasis(root.basis, context);
  const validity = parseValidity(root.validity, context);
  const scope = parseScope(root.scope, context);
  const contracts = parseDigestRecord(
    root.contracts,
    CONTRACT_FIELDS,
    context,
    2,
  );
  const evidence = parseDigestRecord(
    root.evidence,
    EVIDENCE_FIELDS,
    context,
    2,
  );
  return Object.freeze({
    artifact: INTENT_CACHE_ADMISSION_PASSPORT_ARTIFACT,
    profile: 'intent-plan-read',
    authentication: 'none',
    decision: 'shadow-qualified',
    activationCeiling: 'shadow-only',
    basis,
    validity,
    scope,
    contracts,
    evidence,
  });
}

function parseBasis(source: unknown, context: StatementParseContext) {
  const root = snapshotRequiredRecord(source, BASIS_FIELDS, 24, context, 2);
  if (
    root.schema !==
      'semwitness.dev/intent-cache-shadow-qualification/v1alpha1' ||
    root.provenance !== 'host-attested-unsigned' ||
    root.evidenceAuthentication !== 'none' ||
    root.producerIdentity !== null
  ) {
    throw malformedPassport();
  }
  const artifact = parseArtifact(root.artifact, context, 3);
  if (
    artifact.id !== 'semwitness-intent-cache-shadow-qualifier' ||
    artifact.version !== '1'
  ) {
    throw malformedPassport();
  }
  return Object.freeze({
    schema:
      'semwitness.dev/intent-cache-shadow-qualification/v1alpha1' as const,
    artifact,
    provenance: 'host-attested-unsigned' as const,
    evidenceAuthentication: 'none' as const,
    producerIdentity: null,
  });
}

function parseValidity(source: unknown, context: StatementParseContext) {
  const root = snapshotRequiredRecord(source, VALIDITY_FIELDS, 16, context, 2);
  const notBefore = parseCanonicalRfc3339Utc(root.notBefore);
  const notAfter = parseCanonicalRfc3339Utc(root.notAfter);
  if (
    Date.parse(notBefore) >= Date.parse(notAfter) ||
    typeof root.revocationId !== 'string' ||
    !REVOCATION_HMAC.test(root.revocationId)
  ) {
    throw malformedPassport();
  }
  return Object.freeze({
    notBefore,
    notAfter,
    revocationId: root.revocationId as `hmac-sha256:revocation:${string}`,
  });
}

function parseScope(source: unknown, context: StatementParseContext) {
  const root = snapshotRequiredRecord(source, SCOPE_FIELDS, 24, context, 2);
  if (
    !isSha256Digest(root.deploymentScopeDigest) ||
    typeof root.cacheNamespace !== 'string' ||
    !CACHE_NAMESPACE_HMAC.test(root.cacheNamespace) ||
    typeof root.tenant !== 'string' ||
    !TENANT_HMAC.test(root.tenant) ||
    typeof root.domain !== 'string' ||
    !DOMAIN_HMAC.test(root.domain) ||
    typeof root.operation !== 'string' ||
    !OPERATION_HMAC.test(root.operation)
  ) {
    throw malformedPassport();
  }
  return Object.freeze({
    deploymentScopeDigest: root.deploymentScopeDigest,
    cacheNamespace:
      root.cacheNamespace as `hmac-sha256:cache-namespace:${string}`,
    tenant: root.tenant as `hmac-sha256:tenant:${string}`,
    domain: root.domain as `hmac-sha256:intent-domain:${string}`,
    operation: root.operation as `hmac-sha256:operation:${string}`,
  });
}

function parseDigestRecord<const Field extends string>(
  source: unknown,
  fields: readonly Field[],
  context: StatementParseContext,
  recordDepth: number,
): Readonly<Record<Field, Sha256Digest>> {
  const root = snapshotRequiredRecord(source, fields, 24, context, recordDepth);
  const result: Partial<Record<Field, Sha256Digest>> = Object.create(
    null,
  ) as Partial<Record<Field, Sha256Digest>>;
  for (const field of fields) {
    if (!isSha256Digest(root[field])) throw malformedPassport();
    result[field] = root[field];
  }
  return Object.freeze(result as Record<Field, Sha256Digest>);
}

function parseArtifact(
  source: unknown,
  context: StatementParseContext,
  recordDepth: number,
) {
  const root = snapshotRequiredRecord(
    source,
    ARTIFACT_FIELDS,
    16,
    context,
    recordDepth,
  );
  if (
    typeof root.id !== 'string' ||
    !SAFE_IDENTIFIER_PATTERN.test(root.id) ||
    typeof root.version !== 'string' ||
    !SAFE_VERSION_PATTERN.test(root.version)
  ) {
    throw malformedPassport();
  }
  return Object.freeze({ id: root.id, version: root.version });
}

function statementJsonLimits() {
  return {
    maxDepth: 12,
    maxItems: 256,
    maxStringCodeUnits: 1_024,
    maxNumberCodeUnits: 32,
  } as const;
}

function malformedPassport(): SemWitnessError {
  return new SemWitnessError(
    'MALFORMED_ENVELOPE',
    'Malformed intent-cache admission Passport Statement',
  );
}
