import { Buffer } from 'node:buffer';
import { performance } from 'node:perf_hooks';

import {
  canonicalJson,
  toJsonValue,
  type JsonValue,
} from '../domain/canonical-json.js';
import { isSha256Digest, sha256 } from '../domain/hash.js';
import {
  isSafeIdentifier,
  isSafeMediaType,
  SAFE_VERSION_PATTERN,
} from '../domain/types.js';
import {
  isSafeTokenizerFingerprint,
  isTokenCount,
  type TokenCount,
  type TokenizerAdapter,
} from '../ports/tokenizer.js';
import {
  digestCompactResponseContract,
  parseCompactResponseCandidate,
  parseCompactResponseContract,
} from './contract.js';
import { CompactResponseError, responseReasonFromError } from './errors.js';
import type { CompactResponseRenderer } from './renderer.js';
import type { ResponseReasonCode } from './reason-codes.js';
import type { CompactResponseContract } from './types.js';
import {
  createCompactResponseWitness,
  parseCompactResponseWitness,
  serializeCompactResponseWitness,
  type CompactResponseWitness,
} from './witness.js';
import { snapshotBoundedUint8Array } from './byte-snapshot.js';

const SAFE_LOCALE_PATTERN = /^[a-z]{2,3}(?:-[A-Z]{2})?$/u;
const MAX_REGISTERED_RENDERERS = 256;
const MAX_PREPARATION_TIMEOUT_MS = 30_000;
const TIMEOUT = Symbol('compact-response-timeout');

interface RendererSnapshot {
  readonly id: string;
  readonly version: string;
  readonly artifactDigest: `sha256:${string}`;
  readonly outputMediaType: string;
  readonly locales: readonly string[];
  readonly render: CompactResponseRenderer['render'];
}

interface TokenizerSnapshot {
  readonly id: string;
  readonly fingerprint: string;
  readonly count: TokenizerAdapter['count'];
}

export interface CompactResponseRuntimeOptions {
  readonly renderers: readonly CompactResponseRenderer[];
  readonly tokenizer?: TokenizerAdapter;
  readonly preparationTimeoutMs?: number;
}

export interface RenderCompactResponseInput {
  readonly contract: CompactResponseContract;
  readonly candidate: string | Uint8Array;
}

export type CompactResponseResult =
  | {
      readonly status: 'rendered';
      readonly output: Uint8Array;
      readonly witness: CompactResponseWitness;
    }
  | {
      readonly status: 'retry-required';
      readonly reasons: readonly ResponseReasonCode[];
    };

export interface VerifyCompactResponseInput extends RenderCompactResponseInput {
  readonly rendered: string | Uint8Array;
  readonly witness: string | Uint8Array;
}

export interface ReplayCompactResponseInput extends RenderCompactResponseInput {
  readonly witness: string | Uint8Array;
}

export interface CompactResponseVerification {
  readonly bound: boolean;
  readonly reasons: readonly ResponseReasonCode[];
}

export interface CompactResponseRuntime {
  render(input: RenderCompactResponseInput): Promise<CompactResponseResult>;
  verify(
    input: VerifyCompactResponseInput,
  ): Promise<CompactResponseVerification>;
  replay(
    input: ReplayCompactResponseInput,
  ): Promise<CompactResponseVerification>;
}

export function createCompactResponseRuntime(
  options: CompactResponseRuntimeOptions,
): CompactResponseRuntime {
  const renderers = snapshotRenderers(options.renderers);
  const tokenizer = snapshotTokenizer(options.tokenizer);
  const preparationTimeoutMs = resolvePreparationTimeout(
    options.preparationTimeoutMs,
  );

  const runtime: CompactResponseRuntime = {
    render: (input) =>
      renderWithSnapshots(input, renderers, tokenizer, preparationTimeoutMs),
    verify: (input) => verifyWithRuntime(runtime, input),
    replay: (input) => replayWithRuntime(runtime, input),
  };
  return Object.freeze(runtime);
}

export async function renderCompactResponseCandidate(
  input: RenderCompactResponseInput & {
    readonly runtime: CompactResponseRuntime;
  },
): Promise<CompactResponseResult> {
  return input.runtime.render(input);
}

export async function verifyCompactResponseWitness(
  input: VerifyCompactResponseInput & {
    readonly runtime: CompactResponseRuntime;
  },
): Promise<CompactResponseVerification> {
  return input.runtime.verify(input);
}

export async function replayCompactResponseWitness(
  input: ReplayCompactResponseInput & {
    readonly runtime: CompactResponseRuntime;
  },
): Promise<CompactResponseVerification> {
  return input.runtime.replay(input);
}

async function renderWithSnapshots(
  input: RenderCompactResponseInput,
  renderers: readonly RendererSnapshot[],
  tokenizer: TokenizerSnapshot | undefined,
  preparationTimeoutMs: number | undefined,
): Promise<CompactResponseResult> {
  const startedAt = performance.now();
  let contract: CompactResponseContract;
  try {
    contract = snapshotContract(input.contract);
  } catch (error) {
    return retry(responseReasonFromError(error, 'CONTRACT_MALFORMED'));
  }

  const renderer = resolveRenderer(renderers, contract);
  if ('reason' in renderer) return retry(renderer.reason);

  let candidate: ReturnType<typeof parseCompactResponseCandidate>;
  try {
    candidate = parseCompactResponseCandidate(input.candidate, contract);
  } catch (error) {
    return retry(responseReasonFromError(error, 'CANDIDATE_MALFORMED'));
  }

  const deadlineMs = Math.min(
    contract.limits.maxRenderMs,
    preparationTimeoutMs ?? contract.limits.maxRenderMs,
  );
  const abortController = new AbortController();
  let renderedValue: string | Uint8Array;
  try {
    const rendered = await beforeDeadline(
      () =>
        renderer.render(candidate.value, {
          locale: contract.renderer.locale,
          signal: abortController.signal,
        }),
      remainingMs(startedAt, deadlineMs),
    );
    if (rendered === TIMEOUT) {
      abortController.abort();
      return retry('RENDER_TIMEOUT');
    }
    renderedValue = rendered;
  } catch {
    abortController.abort();
    return retry('RENDER_ERROR');
  }

  const output = normalizeRenderedOutput(
    renderedValue,
    contract.limits.maxRenderedBytes,
  );
  if ('reason' in output) return retry(output.reason);
  if (remainingMs(startedAt, deadlineMs) <= 0) {
    abortController.abort();
    return retry('RENDER_TIMEOUT');
  }

  let tokenCounts:
    | {
        readonly tokenizerId: string;
        readonly tokenizerFingerprint: string;
        readonly candidate: TokenCount;
        readonly rendered: TokenCount;
      }
    | undefined;
  if (tokenizer !== undefined) {
    try {
      const counted = await beforeDeadline(
        () =>
          Promise.all([
            tokenizer.count(
              new Uint8Array(candidate.bytes),
              contract.candidate.mediaType,
            ),
            tokenizer.count(
              new Uint8Array(output.bytes),
              contract.renderer.outputMediaType,
            ),
          ]),
        remainingMs(startedAt, deadlineMs),
      );
      if (counted === TIMEOUT) {
        abortController.abort();
        return retry('RENDER_TIMEOUT');
      }
      const [candidateCount, renderedCount] = counted;
      if (!isTokenCount(candidateCount) || !isTokenCount(renderedCount)) {
        return retry('TOKENIZER_ERROR');
      }
      tokenCounts = Object.freeze({
        tokenizerId: tokenizer.id,
        tokenizerFingerprint: tokenizer.fingerprint,
        candidate: Object.freeze({ ...candidateCount }),
        rendered: Object.freeze({ ...renderedCount }),
      });
    } catch {
      return retry('TOKENIZER_ERROR');
    }
  }

  try {
    if (remainingMs(startedAt, deadlineMs) <= 0) {
      abortController.abort();
      return retry('RENDER_TIMEOUT');
    }
    const witness = createCompactResponseWitness({
      contractDigest: digestCompactResponseContract(contract),
      candidate: {
        exactDigest: sha256(candidate.bytes),
        canonicalDigest: sha256(candidate.canonicalBytes),
        byteLength: candidate.bytes.byteLength,
      },
      renderer: {
        id: renderer.id,
        version: renderer.version,
        artifactDigest: renderer.artifactDigest,
        outputMediaType: renderer.outputMediaType,
        locale: contract.renderer.locale,
      },
      rendered: {
        digest: sha256(output.bytes),
        byteLength: output.bytes.byteLength,
      },
      ...(tokenCounts === undefined ? {} : { tokenCounts }),
    });
    if (remainingMs(startedAt, deadlineMs) <= 0) {
      abortController.abort();
      return retry('RENDER_TIMEOUT');
    }
    return Object.freeze({
      status: 'rendered',
      output: new Uint8Array(output.bytes),
      witness,
    });
  } catch (error) {
    return retry(responseReasonFromError(error, 'RENDER_ERROR'));
  }
}

async function verifyWithRuntime(
  runtime: CompactResponseRuntime,
  input: VerifyCompactResponseInput,
): Promise<CompactResponseVerification> {
  let expected: CompactResponseWitness;
  let rendered: Uint8Array;
  let contract: CompactResponseContract;
  let candidate: string | Uint8Array;
  try {
    contract = snapshotContract(input.contract);
    candidate = input.candidate;
    expected = parseCompactResponseWitness(input.witness);
    rendered = snapshotUtf8(input.rendered, contract.limits.maxRenderedBytes);
  } catch (error) {
    return verificationFailure(
      responseReasonFromError(error, 'WITNESS_MALFORMED'),
    );
  }
  const replay = await runtime.render({ contract, candidate });
  if (replay.status !== 'rendered') {
    return Object.freeze({ bound: false, reasons: replay.reasons });
  }
  if (
    !equalBytes(rendered, replay.output) ||
    serializeCompactResponseWitness(expected) !==
      serializeCompactResponseWitness(replay.witness)
  ) {
    return verificationFailure('WITNESS_MISMATCH');
  }
  return Object.freeze({ bound: true, reasons: Object.freeze([]) });
}

async function replayWithRuntime(
  runtime: CompactResponseRuntime,
  input: ReplayCompactResponseInput,
): Promise<CompactResponseVerification> {
  let expected: CompactResponseWitness;
  try {
    expected = parseCompactResponseWitness(input.witness);
  } catch (error) {
    return verificationFailure(
      responseReasonFromError(error, 'WITNESS_MALFORMED'),
    );
  }
  const replay = await runtime.render(input);
  if (replay.status !== 'rendered') {
    return Object.freeze({ bound: false, reasons: replay.reasons });
  }
  if (
    serializeCompactResponseWitness(expected) !==
    serializeCompactResponseWitness(replay.witness)
  ) {
    return verificationFailure('WITNESS_MISMATCH');
  }
  return Object.freeze({ bound: true, reasons: Object.freeze([]) });
}

function snapshotContract(
  contract: CompactResponseContract,
): CompactResponseContract {
  return parseCompactResponseContract(canonicalJson(toJsonValue(contract)));
}

function snapshotRenderers(
  input: readonly CompactResponseRenderer[],
): readonly RendererSnapshot[] {
  let inputLength: number;
  try {
    if (!Array.isArray(input)) throw new TypeError('Registry must be an array');
    inputLength = input.length;
  } catch (error) {
    throw new CompactResponseError(
      'RENDERER_NOT_REGISTERED',
      'Renderer registry is empty or exceeds its limit',
      error,
    );
  }
  if (
    !Number.isSafeInteger(inputLength) ||
    inputLength < 1 ||
    inputLength > MAX_REGISTERED_RENDERERS
  ) {
    throw new CompactResponseError(
      'RENDERER_NOT_REGISTERED',
      'Renderer registry is empty or exceeds its limit',
    );
  }

  const seen = new Set<string>();
  const renderers: RendererSnapshot[] = [];
  for (let index = 0; index < inputLength; index += 1) {
    let id: unknown;
    let version: unknown;
    let artifactDigest: unknown;
    let outputMediaType: unknown;
    let locales: readonly string[];
    let render: unknown;
    try {
      if (!Object.hasOwn(input, index)) {
        throw new TypeError('Renderer registry cannot contain holes');
      }
      const renderer = input[index]!;
      id = renderer.id;
      version = renderer.version;
      artifactDigest = renderer.artifactDigest;
      outputMediaType = renderer.outputMediaType;
      const localeSource = renderer.locales;
      render = renderer.render;
      if (!Array.isArray(localeSource)) {
        throw new TypeError('Renderer locales must be an array');
      }
      const localeCount = localeSource.length;
      if (
        !Number.isSafeInteger(localeCount) ||
        localeCount < 1 ||
        localeCount > 64
      ) {
        throw new TypeError('Renderer locales exceed their limit');
      }
      const localeSeen = new Set<string>();
      const localeSnapshot: string[] = [];
      for (let localeIndex = 0; localeIndex < localeCount; localeIndex += 1) {
        if (!Object.hasOwn(localeSource, localeIndex)) {
          throw new TypeError('Renderer locales cannot contain holes');
        }
        const locale: unknown = localeSource[localeIndex];
        if (
          typeof locale !== 'string' ||
          !SAFE_LOCALE_PATTERN.test(locale) ||
          localeSeen.has(locale)
        ) {
          throw new TypeError('Renderer locale is malformed or duplicated');
        }
        localeSeen.add(locale);
        localeSnapshot[localeIndex] = locale;
      }
      locales = Object.freeze(localeSnapshot);
    } catch (error) {
      throw new CompactResponseError(
        'RENDERER_BINDING_MISMATCH',
        'Renderer registration cannot be snapshotted',
        error,
      );
    }
    if (
      !isSafeIdentifier(id) ||
      typeof version !== 'string' ||
      !SAFE_VERSION_PATTERN.test(version) ||
      !isSha256Digest(artifactDigest) ||
      !isSafeMediaType(outputMediaType) ||
      typeof render !== 'function'
    ) {
      throw new CompactResponseError(
        'RENDERER_BINDING_MISMATCH',
        'Renderer registration is malformed or ambiguous',
      );
    }
    const key = `${id}\0${version}`;
    if (seen.has(key)) {
      throw new CompactResponseError(
        'RENDERER_BINDING_MISMATCH',
        'Renderer registration is malformed or ambiguous',
      );
    }
    seen.add(key);
    const renderFunction = render as CompactResponseRenderer['render'];
    renderers[index] = Object.freeze({
      id,
      version,
      artifactDigest,
      outputMediaType,
      locales,
      render: (
        candidate: JsonValue,
        context: Parameters<typeof renderFunction>[1],
      ) =>
        Reflect.apply(renderFunction, undefined, [
          candidate,
          context,
        ]) as ReturnType<typeof renderFunction>,
    });
  }
  return Object.freeze(renderers);
}

function snapshotTokenizer(
  tokenizer: TokenizerAdapter | undefined,
): TokenizerSnapshot | undefined {
  if (tokenizer === undefined) return undefined;
  let id: unknown;
  let fingerprint: unknown;
  let count: unknown;
  try {
    id = tokenizer.id;
    fingerprint = tokenizer.fingerprint;
    count = tokenizer.count;
  } catch (error) {
    throw new CompactResponseError(
      'TOKENIZER_ERROR',
      'Tokenizer registration cannot be snapshotted',
      error,
    );
  }
  if (
    !isSafeIdentifier(id) ||
    !isSafeTokenizerFingerprint(fingerprint) ||
    typeof count !== 'function'
  ) {
    throw new CompactResponseError(
      'TOKENIZER_ERROR',
      'Tokenizer registration is malformed',
    );
  }
  const countFunction = count as TokenizerAdapter['count'];
  return Object.freeze({
    id,
    fingerprint,
    count: (bytes: Uint8Array, mediaType: string) =>
      Reflect.apply(countFunction, tokenizer, [bytes, mediaType]) as ReturnType<
        typeof countFunction
      >,
  });
}

function resolveRenderer(
  renderers: readonly RendererSnapshot[],
  contract: CompactResponseContract,
): RendererSnapshot | { readonly reason: ResponseReasonCode } {
  const sameId = renderers.filter(
    (renderer) => renderer.id === contract.renderer.id,
  );
  if (sameId.length === 0) {
    return { reason: 'RENDERER_NOT_REGISTERED' };
  }
  const version = sameId.find(
    (renderer) => renderer.version === contract.renderer.version,
  );
  if (
    version === undefined ||
    version.artifactDigest !== contract.renderer.artifactDigest ||
    version.outputMediaType !== contract.renderer.outputMediaType ||
    !version.locales.includes(contract.renderer.locale)
  ) {
    return { reason: 'RENDERER_BINDING_MISMATCH' };
  }
  return version;
}

function normalizeRenderedOutput(
  value: string | Uint8Array,
  maximumBytes: number,
): { readonly bytes: Uint8Array } | { readonly reason: ResponseReasonCode } {
  try {
    let bytes: Uint8Array;
    if (typeof value === 'string') {
      if (value.length === 0) return { reason: 'RENDER_OUTPUT_INVALID' };
      if (value.length > maximumBytes) {
        return { reason: 'RENDER_OUTPUT_TOO_LARGE' };
      }
      if (!isWellFormedUnicode(value)) {
        return { reason: 'RENDER_OUTPUT_INVALID' };
      }
      const byteLength = Buffer.byteLength(value, 'utf8');
      if (byteLength === 0) return { reason: 'RENDER_OUTPUT_INVALID' };
      if (byteLength > maximumBytes) {
        return { reason: 'RENDER_OUTPUT_TOO_LARGE' };
      }
      bytes = new TextEncoder().encode(value);
    } else {
      const snapshot = snapshotBoundedUint8Array(value, maximumBytes);
      if (snapshot.status === 'too-large') {
        return { reason: 'RENDER_OUTPUT_TOO_LARGE' };
      }
      if (snapshot.status === 'invalid') {
        return { reason: 'RENDER_OUTPUT_INVALID' };
      }
      if (snapshot.bytes.byteLength === 0) {
        return { reason: 'RENDER_OUTPUT_INVALID' };
      }
      bytes = snapshot.bytes;
    }
    if (bytes.byteLength === 0) return { reason: 'RENDER_OUTPUT_INVALID' };
    if (bytes.byteLength > maximumBytes) {
      return { reason: 'RENDER_OUTPUT_TOO_LARGE' };
    }
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { bytes };
  } catch {
    return { reason: 'RENDER_OUTPUT_INVALID' };
  }
}

function snapshotUtf8(
  value: string | Uint8Array,
  maximumBytes: number,
): Uint8Array {
  const normalized = normalizeRenderedOutput(value, maximumBytes);
  if ('reason' in normalized) {
    throw new CompactResponseError(
      'WITNESS_MISMATCH',
      'Rendered output is invalid',
    );
  }
  return normalized.bytes;
}

function resolvePreparationTimeout(
  value: number | undefined,
): number | undefined {
  if (value === undefined) return undefined;
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_PREPARATION_TIMEOUT_MS
  ) {
    throw new CompactResponseError(
      'CONTRACT_MALFORMED',
      'Preparation timeout is invalid',
    );
  }
  return value;
}

function remainingMs(startedAt: number, limitMs: number): number {
  return Math.max(0, limitMs - (performance.now() - startedAt));
}

async function beforeDeadline<Value>(
  task: () => Value | PromiseLike<Value>,
  timeoutMs: number,
): Promise<Value | typeof TIMEOUT> {
  if (timeoutMs <= 0) return TIMEOUT;
  const deadline = performance.now() + timeoutMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    let result: Value | typeof TIMEOUT;
    try {
      result = await Promise.race([
        Promise.resolve().then(task),
        new Promise<typeof TIMEOUT>((resolve) => {
          timer = setTimeout(() => resolve(TIMEOUT), timeoutMs);
        }),
      ]);
    } catch (error) {
      if (performance.now() >= deadline) return TIMEOUT;
      throw error;
    }
    if (result !== TIMEOUT && performance.now() >= deadline) return TIMEOUT;
    return result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function retry(
  ...reasons: readonly ResponseReasonCode[]
): CompactResponseResult {
  return Object.freeze({
    status: 'retry-required',
    reasons: Object.freeze([...new Set(reasons)].slice(0, 8)),
  });
}

function verificationFailure(
  reason: ResponseReasonCode,
): CompactResponseVerification {
  return Object.freeze({
    bound: false,
    reasons: Object.freeze([reason]),
  });
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}
