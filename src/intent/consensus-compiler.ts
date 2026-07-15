import { isPromise } from 'node:util/types';

import { canonicalJson, toJsonValue } from '../domain/canonical-json.js';
import { compareCodeUnits } from '../domain/deterministic-order.js';
import { hashCanonical, isSha256Digest, sha256 } from '../domain/hash.js';
import type {
  IntentCompilerRequest,
  IntentCompilerResult,
  IntentNormalizerManifest,
  IntentProposalCompiler,
} from './normalizer-types.js';
import type {
  CandidateEvidence,
  NormalizerBinding,
  OntologyBinding,
} from './types.js';
import { assertWellFormedUnicode } from './unicode.js';

const COMPILER_ID = 'consensus-intent-compiler';
const COMPILER_VERSION = '1.0.0';
const ARTIFACT_DIGEST = sha256(
  'semwitness.dev/consensus-intent-compiler/v1\0strategy:all-agree',
);
const CONFIG_SCHEMA =
  'semwitness.dev/consensus-intent-compiler-config/v1' as const;
const MIN_MEMBERS = 2;
const MAX_MEMBERS = 8;
const MAX_MEMBER_EVIDENCE = 32;

export interface ConsensusIntentCompilerPolicy {
  readonly strategy: 'all-agree';
  readonly maxCandidateEvidence: number;
}

export interface ConsensusIntentCompilerOptions {
  readonly members: readonly IntentProposalCompiler[];
  readonly policy: ConsensusIntentCompilerPolicy;
}

interface MemberSnapshot {
  readonly key: string;
  readonly manifest: IntentNormalizerManifest;
  compile(request: IntentCompilerRequest): Promise<unknown> | unknown;
}

type MemberResult =
  | {
      readonly status: 'proposed';
      readonly operationId: string;
      readonly confidencePpm: number;
      readonly ambiguous: boolean;
      readonly candidateEvidence: readonly CandidateEvidence[];
    }
  | {
      readonly status: 'bypass';
      readonly reason:
        'INTENT_NO_MATCH' | 'INTENT_AMBIGUOUS' | 'INTENT_COMPILER_FAILURE';
    }
  | { readonly status: 'failure' };

const FAILURE = Object.freeze({ status: 'failure' as const });
const ABORTED = Symbol('consensus-intent-compiler-aborted');

/**
 * Conservative candidate-generator composition. Every member must independently
 * propose the same operation. Agreement is neither semantic-equivalence proof
 * nor cache authorization; downstream policy and witness verification remain
 * authoritative.
 */
export class ConsensusIntentCompiler implements IntentProposalCompiler {
  readonly manifest: IntentNormalizerManifest;
  readonly #members: readonly MemberSnapshot[];
  readonly #policy: ConsensusIntentCompilerPolicy;

  constructor(input: ConsensusIntentCompilerOptions) {
    const options = snapshotOptions(input);
    const policy = snapshotPolicy(options.policy);
    const members = snapshotMembers(options.members);
    const ontology = members[0]?.manifest.ontology;
    if (ontology === undefined) {
      throw new TypeError('Consensus compiler members are invalid');
    }
    for (const member of members) {
      if (!sameOntology(member.manifest.ontology, ontology)) {
        throw new TypeError(
          'Consensus compiler members must share an ontology',
        );
      }
    }

    this.#members = Object.freeze(members);
    this.#policy = policy;
    this.manifest = Object.freeze({
      normalizer: Object.freeze({
        id: COMPILER_ID,
        version: COMPILER_VERSION,
        artifactDigest: ARTIFACT_DIGEST,
        configDigest: hashCanonical(
          toJsonValue({
            schema: CONFIG_SCHEMA,
            policy,
            members: members.map((member) => member.manifest),
          }),
        ),
      }),
      ontology,
    });
    Object.freeze(this);
  }

  async compile(request: IntentCompilerRequest): Promise<IntentCompilerResult> {
    const boundary = snapshotRequest(request);
    if (boundary === undefined || abortState(boundary.signal) !== false) {
      return compilerFailure();
    }

    const pending = Promise.all(
      this.#members.map((member) => runMember(member, boundary)),
    );
    let completed: readonly MemberResult[] | typeof ABORTED;
    try {
      completed = await waitForMembers(pending, boundary.signal);
    } catch {
      return compilerFailure();
    }
    if (completed === ABORTED || abortState(boundary.signal) !== false) {
      return compilerFailure();
    }
    return decideConsensus(completed, this.#policy);
  }
}

function decideConsensus(
  results: readonly MemberResult[],
  policy: ConsensusIntentCompilerPolicy,
): IntentCompilerResult {
  if (results.some((result) => result.status === 'failure')) {
    return compilerFailure();
  }

  const bypasses = results.filter(
    (result): result is Extract<MemberResult, { readonly status: 'bypass' }> =>
      result.status === 'bypass',
  );
  if (bypasses.length > 0) {
    if (
      bypasses.some((result) => result.reason === 'INTENT_COMPILER_FAILURE')
    ) {
      return compilerFailure();
    }
    if (bypasses.some((result) => result.reason === 'INTENT_AMBIGUOUS')) {
      return bypass('INTENT_AMBIGUOUS');
    }
    return bypass(
      bypasses.length === results.length
        ? 'INTENT_NO_MATCH'
        : 'INTENT_AMBIGUOUS',
    );
  }

  const proposals = results as readonly Extract<
    MemberResult,
    { readonly status: 'proposed' }
  >[];
  if (proposals.some((proposal) => proposal.ambiguous)) {
    return bypass('INTENT_AMBIGUOUS');
  }
  const operationId = proposals[0]?.operationId;
  if (
    operationId === undefined ||
    proposals.some((proposal) => proposal.operationId !== operationId)
  ) {
    return bypass('INTENT_AMBIGUOUS');
  }

  const evidence = combineEvidence(proposals, policy.maxCandidateEvidence);
  if (evidence === undefined) return compilerFailure();
  const confidencePpm = Math.min(
    ...proposals.map((proposal) => proposal.confidencePpm),
  );
  return Object.freeze({
    status: 'proposed',
    operationId,
    confidencePpm,
    ambiguous: false,
    ...(evidence.length === 0 ? {} : { candidateEvidence: evidence }),
  });
}

function combineEvidence(
  proposals: readonly Extract<MemberResult, { readonly status: 'proposed' }>[],
  maximum: number,
): readonly CandidateEvidence[] | undefined {
  const byCanonicalValue = new Map<string, CandidateEvidence>();
  for (const proposal of proposals) {
    for (const evidence of proposal.candidateEvidence) {
      const key = evidenceKey(evidence);
      byCanonicalValue.set(key, evidence);
    }
  }
  const entries = [...byCanonicalValue.entries()].sort(([left], [right]) =>
    compareCodeUnits(left, right),
  );
  if (entries.length > maximum) return undefined;
  return Object.freeze(entries.map(([, evidence]) => evidence));
}

function evidenceKey(evidence: CandidateEvidence): string {
  return `${evidence.kind}\0${evidence.providerId}\0${evidence.evidenceDigest}\0${String(evidence.scorePpm).padStart(7, '0')}`;
}

async function runMember(
  member: MemberSnapshot,
  request: IntentCompilerRequest,
): Promise<MemberResult> {
  if (abortState(request.signal) !== false) return FAILURE;
  let output: unknown;
  try {
    output = member.compile(request);
    if (isPromise(output)) output = await output;
  } catch {
    return FAILURE;
  }
  if (abortState(request.signal) !== false) return FAILURE;
  return snapshotMemberResult(output) ?? FAILURE;
}

async function waitForMembers(
  pending: Promise<readonly MemberResult[]>,
  signal: AbortSignal | undefined,
): Promise<readonly MemberResult[] | typeof ABORTED> {
  if (signal === undefined) return pending;
  if (abortState(signal) !== false) return ABORTED;

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<typeof ABORTED>((resolve) => {
    onAbort = () => resolve(ABORTED);
    addAbortListener(signal, onAbort);
  });
  try {
    if (abortState(signal) !== false) return ABORTED;
    return await Promise.race([pending, aborted]);
  } finally {
    if (onAbort !== undefined) removeAbortListener(signal, onAbort);
  }
}

function snapshotMemberResult(input: unknown): MemberResult | undefined {
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
    return Object.freeze({ status: 'bypass', reason: record.reason });
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
    !Number.isInteger(record.confidencePpm) ||
    (record.confidencePpm as number) < 0 ||
    (record.confidencePpm as number) > 1_000_000 ||
    typeof record.ambiguous !== 'boolean'
  ) {
    return undefined;
  }
  const candidateEvidence = snapshotCandidateEvidence(record.candidateEvidence);
  if (candidateEvidence === undefined) return undefined;
  return Object.freeze({
    status: 'proposed',
    operationId: record.operationId,
    confidencePpm: record.confidencePpm as number,
    ambiguous: record.ambiguous,
    candidateEvidence,
  });
}

function snapshotCandidateEvidence(
  input: unknown,
): readonly CandidateEvidence[] | undefined {
  if (input === undefined) return Object.freeze([]);
  const values = denseArrayValues(input, 0, MAX_MEMBER_EVIDENCE);
  if (values === undefined) return undefined;
  const result: CandidateEvidence[] = [];
  for (const inputEvidence of values) {
    const evidence = plainDataRecord(inputEvidence);
    if (
      evidence === undefined ||
      !onlyKeys(evidence, [
        'kind',
        'providerId',
        'evidenceDigest',
        'scorePpm',
        'authoritative',
      ]) ||
      (evidence.kind !== 'embedding' && evidence.kind !== 'similarity') ||
      typeof evidence.providerId !== 'string' ||
      !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(evidence.providerId) ||
      !isSha256Digest(evidence.evidenceDigest) ||
      !Number.isInteger(evidence.scorePpm) ||
      (evidence.scorePpm as number) < 0 ||
      (evidence.scorePpm as number) > 1_000_000 ||
      evidence.authoritative !== false
    ) {
      return undefined;
    }
    result.push(
      Object.freeze({
        kind: evidence.kind,
        providerId: evidence.providerId,
        evidenceDigest: evidence.evidenceDigest,
        scorePpm: evidence.scorePpm as number,
        authoritative: false,
      }),
    );
  }
  return Object.freeze(result);
}

function snapshotOptions(input: unknown): {
  readonly members: unknown;
  readonly policy: unknown;
} {
  const record = plainDataRecord(input);
  if (record === undefined || !hasExactKeys(record, ['members', 'policy'])) {
    throw new TypeError('Consensus compiler options are invalid');
  }
  return { members: record.members, policy: record.policy };
}

function snapshotPolicy(input: unknown): ConsensusIntentCompilerPolicy {
  const record = plainDataRecord(input);
  if (
    record === undefined ||
    !hasExactKeys(record, ['strategy', 'maxCandidateEvidence']) ||
    record.strategy !== 'all-agree' ||
    !Number.isInteger(record.maxCandidateEvidence) ||
    (record.maxCandidateEvidence as number) < 1 ||
    (record.maxCandidateEvidence as number) > MAX_MEMBER_EVIDENCE
  ) {
    throw new TypeError('Consensus compiler policy is invalid');
  }
  return Object.freeze({
    strategy: 'all-agree',
    maxCandidateEvidence: record.maxCandidateEvidence as number,
  });
}

function snapshotMembers(input: unknown): MemberSnapshot[] {
  const values = denseArrayValues(input, MIN_MEMBERS, MAX_MEMBERS);
  if (values === undefined) {
    throw new TypeError('Consensus compiler requires two to eight members');
  }
  const members = values
    .map(snapshotMember)
    .sort((left, right) => compareCodeUnits(left.key, right.key));
  if (
    members.some(
      (member, index) => index > 0 && member.key === members[index - 1]?.key,
    )
  ) {
    throw new TypeError(
      'Consensus compiler members must have distinct manifests',
    );
  }
  return members;
}

function snapshotMember(input: unknown): MemberSnapshot {
  if (
    input === null ||
    (typeof input !== 'object' && typeof input !== 'function')
  ) {
    throw new TypeError('Consensus compiler member is invalid');
  }
  const manifestProperty = dataProperty(input, 'manifest');
  const compileProperty = dataProperty(input, 'compile');
  if (
    manifestProperty === undefined ||
    compileProperty === undefined ||
    typeof compileProperty !== 'function'
  ) {
    throw new TypeError('Consensus compiler member is invalid');
  }
  const manifest = snapshotManifest(manifestProperty);
  const key = canonicalJson(toJsonValue(manifest));
  return Object.freeze({
    key,
    manifest,
    compile: (request: IntentCompilerRequest) =>
      Reflect.apply(compileProperty, input, [request]),
  });
}

function snapshotManifest(input: unknown): IntentNormalizerManifest {
  const record = plainDataRecord(input);
  if (
    record === undefined ||
    !hasExactKeys(record, ['normalizer', 'ontology'])
  ) {
    throw new TypeError('Consensus compiler member manifest is invalid');
  }
  return Object.freeze({
    normalizer: snapshotNormalizer(record.normalizer),
    ontology: snapshotOntology(record.ontology),
  });
}

function snapshotNormalizer(input: unknown): NormalizerBinding {
  const record = plainDataRecord(input);
  if (
    record === undefined ||
    !hasExactKeys(record, [
      'id',
      'version',
      'artifactDigest',
      'configDigest',
    ]) ||
    typeof record.id !== 'string' ||
    typeof record.version !== 'string' ||
    !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(record.id) ||
    !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u.test(record.version) ||
    !isSha256Digest(record.artifactDigest) ||
    !isSha256Digest(record.configDigest)
  ) {
    throw new TypeError('Consensus compiler member normalizer is invalid');
  }
  return Object.freeze({
    id: record.id,
    version: record.version,
    artifactDigest: record.artifactDigest,
    configDigest: record.configDigest,
  });
}

function snapshotOntology(input: unknown): OntologyBinding {
  const record = plainDataRecord(input);
  if (
    record === undefined ||
    !hasExactKeys(record, ['id', 'version', 'digest']) ||
    typeof record.id !== 'string' ||
    typeof record.version !== 'string' ||
    !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(record.id) ||
    !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u.test(record.version) ||
    !isSha256Digest(record.digest)
  ) {
    throw new TypeError('Consensus compiler member ontology is invalid');
  }
  return Object.freeze({
    id: record.id,
    version: record.version,
    digest: record.digest,
  });
}

function snapshotRequest(
  input: unknown,
): Readonly<IntentCompilerRequest> | undefined {
  const record = plainDataRecord(input);
  if (
    record === undefined ||
    !onlyKeys(record, ['source', 'locale', 'signal']) ||
    typeof record.source !== 'string' ||
    typeof record.locale !== 'string' ||
    record.source.length === 0 ||
    record.source.length > 16_384 ||
    record.locale.length === 0 ||
    record.locale.length > 64 ||
    !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,4}$/u.test(record.locale) ||
    (record.signal !== undefined && abortState(record.signal) === undefined)
  ) {
    return undefined;
  }
  try {
    assertWellFormedUnicode(record.source, 'Intent source');
    assertWellFormedUnicode(record.locale, 'Intent locale');
  } catch {
    return undefined;
  }
  return Object.freeze({
    source: record.source,
    locale: record.locale,
    ...(record.signal === undefined
      ? {}
      : { signal: record.signal as AbortSignal }),
  });
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

function denseArrayValues(
  input: unknown,
  minimum: number,
  maximum: number,
): readonly unknown[] | undefined {
  if (
    !Array.isArray(input) ||
    Object.getOwnPropertySymbols(input).length !== 0
  ) {
    return undefined;
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(input, 'length');
  const length =
    lengthDescriptor !== undefined && 'value' in lengthDescriptor
      ? lengthDescriptor.value
      : undefined;
  if (
    !Number.isInteger(length) ||
    (length as number) < minimum ||
    (length as number) > maximum ||
    Object.keys(descriptors).some(
      (key) => key !== 'length' && !/^(?:0|[1-9][0-9]*)$/u.test(key),
    )
  ) {
    return undefined;
  }
  const result: unknown[] = [];
  for (let index = 0; index < (length as number); index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !('value' in descriptor)
    ) {
      return undefined;
    }
    result.push(descriptor.value);
  }
  if (Object.keys(descriptors).length !== result.length + 1) return undefined;
  return result;
}

function dataProperty(input: object, name: string): unknown | undefined {
  let current: object | null = input;
  while (current !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, name);
    if (descriptor !== undefined) {
      return 'value' in descriptor ? descriptor.value : undefined;
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  return undefined;
}

function onlyKeys(
  input: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(input).every((key) => allowed.includes(key));
}

function hasExactKeys(
  input: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  return (
    Object.keys(input).length === expected.length && onlyKeys(input, expected)
  );
}

function sameOntology(left: OntologyBinding, right: OntologyBinding): boolean {
  return (
    left.id === right.id &&
    left.version === right.version &&
    left.digest === right.digest
  );
}

function bypass(
  reason: 'INTENT_NO_MATCH' | 'INTENT_AMBIGUOUS',
): IntentCompilerResult {
  return Object.freeze({ status: 'bypass', reason });
}

function compilerFailure(): IntentCompilerResult {
  return Object.freeze({
    status: 'bypass',
    reason: 'INTENT_COMPILER_FAILURE',
  });
}

function abortState(input: unknown): boolean | undefined {
  if (input === undefined) return false;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(
      AbortSignal.prototype,
      'aborted',
    );
    if (descriptor?.get === undefined) return undefined;
    const value = Reflect.apply(descriptor.get, input, []);
    return typeof value === 'boolean' ? value : undefined;
  } catch {
    return undefined;
  }
}

function addAbortListener(signal: AbortSignal, listener: () => void): void {
  Reflect.apply(EventTarget.prototype.addEventListener, signal, [
    'abort',
    listener,
    { once: true },
  ]);
}

function removeAbortListener(signal: AbortSignal, listener: () => void): void {
  Reflect.apply(EventTarget.prototype.removeEventListener, signal, [
    'abort',
    listener,
  ]);
}
