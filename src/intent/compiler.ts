import { toJsonValue } from '../domain/canonical-json.js';
import { hashCanonical, isSha256Digest } from '../domain/hash.js';
import {
  digestIntentSource,
  hmacIntentSourceDigest,
  parseIntentIR,
} from './canonical.js';
import { createNormalizationWitness } from './normalization.js';
import { assertWellFormedUnicode } from './unicode.js';
import type {
  IntentCompilerRequest,
  IntentCompilerResult,
  NormalizeIntentShadowInput,
  NormalizeIntentShadowResult,
} from './normalizer-types.js';
import {
  IntentWitnessError,
  type CandidateEvidence,
  type IntentIR,
  type IntentReasonCode,
  type IntentSourceDigest,
  type NormalizerBinding,
  type NormalizationWitness,
  type OntologyBinding,
  type ShadowDecision,
} from './types.js';

interface BoundarySnapshot {
  readonly source: string;
  readonly locale: string;
  readonly sourceDigest: IntentSourceDigest;
  readonly policyDigest: NormalizeIntentShadowInput['policyDigest'];
  readonly contractDigest: NormalizeIntentShadowInput['policyDigest'];
  readonly normalizer: NormalizerBinding;
  readonly compilerOntology: OntologyBinding;
  readonly registryOntology: OntologyBinding;
  readonly minimumConfidencePpm: number;
  readonly signal?: AbortSignal;
  compile(request: IntentCompilerRequest): Promise<unknown> | unknown;
  resolve(operationId: string): IntentIR | undefined;
}

export async function normalizeIntentShadow(
  input: NormalizeIntentShadowInput,
): Promise<NormalizeIntentShadowResult> {
  const boundary = snapshotBoundary(input);
  if (!sameOntology(boundary.compilerOntology, boundary.registryOntology)) {
    return bypass(boundary, ['INTENT_REGISTRY_MISMATCH']);
  }
  if (isAborted(boundary.signal)) {
    return bypass(boundary, ['INTENT_COMPILER_FAILURE']);
  }

  let result: IntentCompilerResult | undefined;
  try {
    const candidate = await runCompiler(boundary);
    if (!isAborted(boundary.signal)) {
      result = snapshotCompilerResult(candidate);
    }
  } catch {
    // Adapter errors are untrusted data and always become a constant bypass.
  }
  if (result === undefined) {
    return bypass(boundary, ['INTENT_COMPILER_FAILURE']);
  }
  if (result.status === 'bypass') {
    return bypass(boundary, [result.reason]);
  }

  let rawIntent: IntentIR | undefined;
  try {
    rawIntent = boundary.resolve(result.operationId);
  } catch {
    return bypass(boundary, ['INTENT_REGISTRY_MISMATCH']);
  }
  if (rawIntent === undefined || isAborted(boundary.signal)) {
    return bypass(boundary, [
      rawIntent === undefined
        ? 'INTENT_REGISTRY_MISMATCH'
        : 'INTENT_COMPILER_FAILURE',
    ]);
  }

  let intent: IntentIR;
  try {
    intent = parseIntentIR(rawIntent);
  } catch {
    return bypass(boundary, ['INTENT_REGISTRY_MISMATCH']);
  }

  let witness: NormalizationWitness;
  try {
    witness = createNormalizationWitness({
      sourceDigest: boundary.sourceDigest,
      intent,
      normalizer: boundary.normalizer,
      ontology: boundary.registryOntology,
      policyDigest: boundary.policyDigest,
      assessment: {
        ambiguous: result.ambiguous,
        confidencePpm: result.confidencePpm,
        minimumConfidencePpm: boundary.minimumConfidencePpm,
      },
      ...(result.candidateEvidence === undefined
        ? {}
        : { candidateEvidence: result.candidateEvidence }),
    });
  } catch {
    return bypass(boundary, ['INTENT_COMPILER_FAILURE']);
  }
  if (witness.decision.verdict === 'bypass') {
    return bypass(boundary, witness.decision.reasons, witness);
  }
  return {
    status: 'normalized',
    contractDigest: boundary.contractDigest,
    intent,
    witness,
  };
}

function bypass(
  boundary: BoundarySnapshot,
  reasons: readonly IntentReasonCode[],
  witness?: NormalizationWitness,
): NormalizeIntentShadowResult {
  const decision: ShadowDecision = {
    verdict: 'bypass',
    applied: false,
    reasons,
  };
  return {
    status: 'bypass',
    contractDigest: boundary.contractDigest,
    sourceDigest: boundary.sourceDigest,
    normalizer: boundary.normalizer,
    ontology: boundary.registryOntology,
    decision,
    ...(witness === undefined ? {} : { witness }),
  };
}

function snapshotBoundary(input: NormalizeIntentShadowInput): BoundarySnapshot {
  try {
    const source = input.source;
    const locale = input.locale;
    const sourceDigest = input.sourceDigest;
    const sourceDigestSecret = input.sourceDigestSecret;
    const policyDigest = input.policyDigest;
    const compiler = input.compiler;
    const registry = input.registry;
    const manifest = plainDataRecord(compiler.manifest);
    if (
      manifest === undefined ||
      !onlyKeys(manifest, ['normalizer', 'ontology'])
    ) {
      throw malformed('Intent compiler manifest is invalid');
    }
    const normalizer = snapshotNormalizerBinding(manifest.normalizer);
    const compilerOntology = snapshotOntologyBinding(manifest.ontology);
    const registryOntology = snapshotOntologyBinding(registry.ontology);
    const minimumConfidencePpm = registry.minimumConfidencePpm;
    const signal = input.signal;
    const compile = compiler.compile;
    const resolve = registry.resolve;

    if (
      typeof source !== 'string' ||
      typeof locale !== 'string' ||
      source.length === 0 ||
      source.length > 16_384 ||
      locale.length === 0 ||
      locale.length > 64 ||
      !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,4}$/u.test(locale) ||
      !isSha256Digest(policyDigest) ||
      typeof compile !== 'function' ||
      typeof resolve !== 'function' ||
      !Number.isInteger(minimumConfidencePpm) ||
      minimumConfidencePpm < 0 ||
      minimumConfidencePpm > 1_000_000
    ) {
      throw malformed('Intent compiler boundary is invalid');
    }
    assertWellFormedUnicode(source, 'Intent source');
    assertWellFormedUnicode(locale, 'Intent locale');
    verifySourceBinding(source, sourceDigest, sourceDigestSecret);
    const contractDigest = hashCanonical(
      toJsonValue({
        schema: 'semwitness.dev/intent-normalizer-contract/v1',
        normalizer,
        compilerOntology,
        registryOntology,
        minimumConfidencePpm,
        policyDigest,
      }),
    );

    return {
      source,
      locale,
      sourceDigest,
      policyDigest,
      contractDigest,
      normalizer,
      compilerOntology,
      registryOntology,
      minimumConfidencePpm,
      ...(signal === undefined ? {} : { signal }),
      compile: (request) => Reflect.apply(compile, compiler, [request]),
      resolve: (operationId) =>
        Reflect.apply(resolve, registry, [operationId]) as IntentIR | undefined,
    };
  } catch (error) {
    if (error instanceof IntentWitnessError) throw error;
    throw malformed('Intent compiler boundary is invalid');
  }
}

async function runCompiler(boundary: BoundarySnapshot): Promise<unknown> {
  const request = {
    source: boundary.source,
    locale: boundary.locale,
    ...(boundary.signal === undefined ? {} : { signal: boundary.signal }),
  };
  if (boundary.signal === undefined) {
    return boundary.compile(request);
  }
  const signal = boundary.signal;
  if (isAborted(signal)) throw new Error('aborted');
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([
      Promise.resolve(boundary.compile(request)),
      aborted,
    ]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  }
}

function snapshotCompilerResult(
  input: unknown,
): IntentCompilerResult | undefined {
  const record = plainDataRecord(input);
  if (record === undefined) return undefined;
  if (record.status === 'bypass') {
    if (
      !onlyKeys(record, ['status', 'reason']) ||
      (record.reason !== 'INTENT_NO_MATCH' &&
        record.reason !== 'INTENT_AMBIGUOUS' &&
        record.reason !== 'INTENT_COMPILER_FAILURE')
    ) {
      return undefined;
    }
    return { status: 'bypass', reason: record.reason };
  }
  if (
    record.status !== 'proposed' ||
    !onlyKeys(record, [
      'status',
      'operationId',
      'confidencePpm',
      'ambiguous',
      'candidateEvidence',
    ]) ||
    typeof record.operationId !== 'string' ||
    !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(record.operationId) ||
    typeof record.ambiguous !== 'boolean' ||
    !Number.isInteger(record.confidencePpm) ||
    (record.confidencePpm as number) < 0 ||
    (record.confidencePpm as number) > 1_000_000
  ) {
    return undefined;
  }
  const candidateEvidence = snapshotCandidateEvidence(record.candidateEvidence);
  if (candidateEvidence === null) return undefined;
  return {
    status: 'proposed',
    operationId: record.operationId,
    confidencePpm: record.confidencePpm as number,
    ambiguous: record.ambiguous,
    ...(candidateEvidence === undefined ? {} : { candidateEvidence }),
  };
}

function snapshotCandidateEvidence(
  input: unknown,
): readonly CandidateEvidence[] | undefined | null {
  if (input === undefined) return undefined;
  if (!Array.isArray(input) || input.length > 32) return null;
  const result: CandidateEvidence[] = [];
  for (const item of input) {
    const record = plainDataRecord(item);
    if (
      record === undefined ||
      !onlyKeys(record, [
        'kind',
        'providerId',
        'evidenceDigest',
        'scorePpm',
        'authoritative',
      ]) ||
      (record.kind !== 'embedding' && record.kind !== 'similarity') ||
      typeof record.providerId !== 'string' ||
      !isSha256Digest(record.evidenceDigest) ||
      !Number.isInteger(record.scorePpm) ||
      (record.scorePpm as number) < 0 ||
      (record.scorePpm as number) > 1_000_000 ||
      record.authoritative !== false
    ) {
      return null;
    }
    result.push({
      kind: record.kind,
      providerId: record.providerId,
      evidenceDigest: record.evidenceDigest,
      scorePpm: record.scorePpm as number,
      authoritative: false,
    });
  }
  return Object.freeze(result);
}

function plainDataRecord(input: unknown): Record<string, unknown> | undefined {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return undefined;
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  if (Object.getOwnPropertySymbols(input).length !== 0) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const result: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || !('value' in descriptor)) return undefined;
    result[key] = descriptor.value;
  }
  return result;
}

function onlyKeys(
  input: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(input).every((key) => allowed.includes(key));
}

function verifySourceBinding(
  source: string,
  digest: IntentSourceDigest,
  secret: Uint8Array | string | undefined,
): void {
  if (isSha256Digest(digest)) {
    if (digestIntentSource(source) !== digest) {
      throw malformed('Intent source digest does not match source');
    }
    return;
  }
  if (
    !/^hmac-sha256:intent-source:[a-f0-9]{64}$/u.test(digest) ||
    secret === undefined ||
    hmacIntentSourceDigest(secret, source) !== digest
  ) {
    throw malformed('Intent source HMAC does not match source');
  }
}

function snapshotNormalizerBinding(input: unknown): NormalizerBinding {
  const value = plainDataRecord(input);
  if (
    value === undefined ||
    !onlyKeys(value, ['id', 'version', 'artifactDigest', 'configDigest']) ||
    typeof value.id !== 'string' ||
    typeof value.version !== 'string' ||
    !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(value.id) ||
    !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u.test(value.version) ||
    !isSha256Digest(value.artifactDigest) ||
    !isSha256Digest(value.configDigest)
  ) {
    throw malformed('Intent normalizer binding is invalid');
  }
  return Object.freeze({
    id: value.id,
    version: value.version,
    artifactDigest: value.artifactDigest,
    configDigest: value.configDigest,
  });
}

function snapshotOntologyBinding(input: unknown): OntologyBinding {
  const value = plainDataRecord(input);
  if (
    value === undefined ||
    !onlyKeys(value, ['id', 'version', 'digest']) ||
    typeof value.id !== 'string' ||
    typeof value.version !== 'string' ||
    !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(value.id) ||
    !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u.test(value.version) ||
    !isSha256Digest(value.digest)
  ) {
    throw malformed('Intent ontology binding is invalid');
  }
  return Object.freeze({
    id: value.id,
    version: value.version,
    digest: value.digest,
  });
}

function isAborted(signal: AbortSignal | undefined): boolean {
  try {
    return signal?.aborted === true;
  } catch {
    return true;
  }
}

function sameOntology(left: OntologyBinding, right: OntologyBinding): boolean {
  return (
    left.id === right.id &&
    left.version === right.version &&
    left.digest === right.digest
  );
}

function malformed(message: string): IntentWitnessError {
  return new IntentWitnessError('INTENT_MALFORMED', message);
}
