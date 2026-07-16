/* Keep provider SDK types at this edge; the host stays provider-neutral. */
import type {
  LanguageModelV4CallOptions,
  LanguageModelV4Middleware,
  LanguageModelV4ToolResultPart,
} from '@ai-sdk/provider';
import { performance } from 'node:perf_hooks';

import { toJsonValue } from '../domain/canonical-json.js';
import { compareCodeUnits } from '../domain/deterministic-order.js';
import { hashCanonical, sha256 } from '../domain/hash.js';
import {
  digestSegmentMetadata,
  recomputeProofDigest,
  type ProofEnvelope,
} from '../domain/proof.js';
import { createSegment, type Sha256Digest } from '../domain/types.js';
import {
  HOST_PREPARATION_REASON_CODES,
  isHostReasonCode,
  isSafeIdentifier,
  isSha256Digest,
  isTrustLevel,
  type HostReasonCode,
  type TextPreparationRequest,
  type TextPreparationResult,
  type TextRequestPreparer,
} from '../host/types.js';

export const AI_SDK_ADAPTER_ARTIFACT = Object.freeze({
  id: 'semwitness-ai-sdk-middleware',
  version: '1',
} as const);

export interface AiSdkDeploymentScope {
  readonly provider: string;
  readonly modelId: string;
  readonly promptContractDigest: Sha256Digest;
  readonly toolContractDigest: Sha256Digest;
}

export interface ToolResultSelector {
  /** Exact AI SDK tool names that this selector admits. */
  readonly toolNames: readonly string[];
  /** Host-owned trust classification applied to every admitted tool name. */
  readonly trust: TextPreparationRequest['trust'];
}

export interface AiSdkMiddlewareLimits {
  /** Inclusive range: 1..1,024 prompt messages. */
  readonly maxMessagesPerCall: number;
  /** Inclusive range: 1..4,096 cumulative parts in tool-role messages. */
  readonly maxToolPartsPerCall: number;
  /** Inclusive range: 1..1,024 selected text candidates. */
  readonly maxCandidatesPerCall: number;
  /** Total preparation deadline in milliseconds. Inclusive range: 10..60,000. */
  readonly preparationTimeoutMs: number;
}

export interface PreparationDecisionEvent {
  readonly id: string;
  readonly operation: 'generate' | 'stream';
  readonly messageIndex: number;
  readonly partIndex: number;
  readonly applied: boolean;
  readonly selectedCodec: TextPreparationResult['selectedCodec'];
  readonly reasons: TextPreparationResult['reasons'];
  readonly promotionDigest?: TextPreparationResult['promotionDigest'];
}

export interface SemWitnessLanguageModelMiddlewareOptions {
  readonly preparer: TextRequestPreparer;
  /** Deployment identity and prompt/tool contracts admitted by this adapter. */
  readonly scope: AiSdkDeploymentScope;
  /** Required per-call availability envelope. */
  readonly limits: AiSdkMiddlewareLimits;
  /**
   * One or more declarative allowlists. A tool name may occur in exactly one
   * selector so that its trust classification cannot be ambiguous.
   */
  readonly selectors: readonly ToolResultSelector[];
  /** Receives content-free decisions only. Observer failures are fail-open. */
  readonly onDecision?: (
    event: PreparationDecisionEvent,
  ) => void | PromiseLike<void>;
}

interface SelectorTrustPair {
  readonly toolName: string;
  readonly trust: TextPreparationRequest['trust'];
}

interface ValidatedSelectors {
  readonly pairs: readonly SelectorTrustPair[];
  readonly trustByToolName: ReadonlyMap<
    string,
    TextPreparationRequest['trust']
  >;
}

interface SelectedToolResult {
  readonly part: LanguageModelV4ToolResultPart;
  readonly output: Extract<
    LanguageModelV4ToolResultPart['output'],
    { readonly type: 'text' }
  >;
  readonly trust: TextPreparationRequest['trust'];
  readonly originalContent: string;
}

interface SelectedCandidate {
  readonly id: string;
  readonly messageIndex: number;
  readonly partIndex: number;
  readonly selected: SelectedToolResult;
}

type ToolMessage = Extract<
  LanguageModelV4CallOptions['prompt'][number],
  { readonly role: 'tool' }
>;
type ToolMessagePart = ToolMessage['content'][number];

interface ToolMessageSnapshot {
  readonly message: Omit<ToolMessage, 'content'> & {
    readonly content: readonly ToolMessagePart[];
  };
  readonly content: readonly ToolMessagePart[];
}

interface TransformationDeadline {
  readonly expiresAt: number;
  readonly rejection: Promise<never>;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly timedOut: () => boolean;
}

interface PreparationResultSnapshot {
  readonly content: string;
  readonly applied: boolean;
  readonly selectedCodec: string;
  readonly reasons: readonly HostReasonCode[];
  readonly proof?: ProofEnvelope;
  readonly promotionDigest?: Sha256Digest;
  readonly deploymentScopeDigest?: Sha256Digest;
}

const DEPLOYMENT_SCOPE_SCHEMA =
  'semwitness.dev/ai-sdk-deployment-scope/v1alpha1' as const;
const SELECTOR_FIELDS = ['toolNames', 'trust'] as const;
const SCOPE_FIELDS = [
  'provider',
  'modelId',
  'promptContractDigest',
  'toolContractDigest',
] as const;
const LIMIT_FIELDS = [
  'maxMessagesPerCall',
  'maxToolPartsPerCall',
  'maxCandidatesPerCall',
  'preparationTimeoutMs',
] as const;
const OPTION_FIELDS = [
  'preparer',
  'scope',
  'limits',
  'selectors',
  'onDecision',
] as const;
const REQUIRED_OPTION_FIELDS = [
  'preparer',
  'scope',
  'limits',
  'selectors',
] as const;
const MAX_SELECTORS = 128;
const MAX_SELECTED_TOOL_NAMES = 1_024;
const MAX_TOOL_NAMES_PER_SELECTOR = 256;
const MAX_TOOL_NAME_LENGTH = 256;
const MAX_MESSAGES_PER_CALL = 1_024;
const MAX_TOOL_PARTS_PER_CALL = 4_096;
const MAX_CANDIDATES_PER_CALL = 1_024;
const MIN_PREPARATION_TIMEOUT_MS = 10;
const MAX_PREPARATION_TIMEOUT_MS = 60_000;
const PROVIDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,127}$/u;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,255}$/u;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+/-]{0,255}$/u;

/**
 * Binds a host promotion to one model, its prompt/tool contracts, and the
 * normalized selector/trust allowlist used by this middleware instance.
 */
export function digestAiSdkDeploymentScope(
  scope: AiSdkDeploymentScope,
  selectors: readonly ToolResultSelector[],
): Sha256Digest {
  return digestValidatedDeploymentScope(
    validateDeploymentScope(scope),
    validateSelectors(selectors).pairs,
  );
}

function digestValidatedDeploymentScope(
  scope: AiSdkDeploymentScope,
  pairs: readonly SelectorTrustPair[],
): Sha256Digest {
  return hashCanonical(
    toJsonValue({
      schema: DEPLOYMENT_SCOPE_SCHEMA,
      adapter: AI_SDK_ADAPTER_ARTIFACT,
      provider: scope.provider,
      modelId: scope.modelId,
      promptContractDigest: scope.promptContractDigest,
      toolContractDigest: scope.toolContractDigest,
      selectors: pairs,
    }),
  );
}

function validateDeploymentScope(value: unknown): AiSdkDeploymentScope {
  const scope = snapshotDataRecord(
    value,
    SCOPE_FIELDS,
    SCOPE_FIELDS,
    'Deployment scope must be a strict bounded record',
  );
  const provider = scope.provider;
  const modelId = scope.modelId;
  const promptContractDigest = scope.promptContractDigest;
  const toolContractDigest = scope.toolContractDigest;
  if (
    typeof provider !== 'string' ||
    !PROVIDER_PATTERN.test(provider) ||
    typeof modelId !== 'string' ||
    !MODEL_ID_PATTERN.test(modelId) ||
    !isSha256Digest(promptContractDigest) ||
    !isSha256Digest(toolContractDigest)
  ) {
    throw new TypeError('Deployment scope must be a strict bounded record');
  }
  return Object.freeze({
    provider,
    modelId,
    promptContractDigest,
    toolContractDigest,
  });
}

function validateLimits(value: unknown): AiSdkMiddlewareLimits {
  const limits = snapshotDataRecord(
    value,
    LIMIT_FIELDS,
    LIMIT_FIELDS,
    'Middleware limits must be a strict bounded data record',
  );
  const maxMessagesPerCall = limits.maxMessagesPerCall;
  const maxToolPartsPerCall = limits.maxToolPartsPerCall;
  const maxCandidatesPerCall = limits.maxCandidatesPerCall;
  const preparationTimeoutMs = limits.preparationTimeoutMs;
  if (
    !isBoundedInteger(maxMessagesPerCall, 1, MAX_MESSAGES_PER_CALL) ||
    !isBoundedInteger(maxToolPartsPerCall, 1, MAX_TOOL_PARTS_PER_CALL) ||
    !isBoundedInteger(maxCandidatesPerCall, 1, MAX_CANDIDATES_PER_CALL) ||
    !isBoundedInteger(
      preparationTimeoutMs,
      MIN_PREPARATION_TIMEOUT_MS,
      MAX_PREPARATION_TIMEOUT_MS,
    )
  ) {
    throw new TypeError(
      'Middleware limits must be a strict bounded data record',
    );
  }
  return Object.freeze({
    maxMessagesPerCall,
    maxToolPartsPerCall,
    maxCandidatesPerCall,
    preparationTimeoutMs,
  });
}

function isBoundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= minimum &&
    (value as number) <= maximum
  );
}

function validateSelectors(value: unknown): ValidatedSelectors {
  const selectorValues = snapshotDenseDataArray(
    value,
    1,
    MAX_SELECTORS,
    'At least one tool-result selector is required',
  );
  const pairs: SelectorTrustPair[] = [];
  const trustByToolName = new Map<string, TextPreparationRequest['trust']>();

  for (const selectorValue of selectorValues) {
    const selector = snapshotDataRecord(
      selectorValue,
      SELECTOR_FIELDS,
      SELECTOR_FIELDS,
      'Tool-result selectors must be strict allowlists',
    );
    const trust = selector.trust;
    const toolNames = snapshotDenseDataArray(
      selector.toolNames,
      1,
      MAX_TOOL_NAMES_PER_SELECTOR,
      'Tool-result selectors must be strict allowlists',
    );
    if (!isTrustLevel(trust)) {
      throw new TypeError('Tool-result selectors must be strict allowlists');
    }

    for (const toolName of toolNames) {
      if (
        typeof toolName !== 'string' ||
        toolName.length > MAX_TOOL_NAME_LENGTH ||
        !TOOL_NAME_PATTERN.test(toolName)
      ) {
        throw new TypeError('Selected tool names must be bounded identifiers');
      }
      if (trustByToolName.size >= MAX_SELECTED_TOOL_NAMES) {
        throw new TypeError('Too many selected tool names');
      }
      if (trustByToolName.has(toolName)) {
        throw new TypeError('A tool name may occur in only one selector');
      }
      trustByToolName.set(toolName, trust);
      pairs.push(Object.freeze({ toolName, trust }));
    }
  }

  pairs.sort((left, right) => {
    const toolOrder = compareCodeUnits(left.toolName, right.toolName);
    return toolOrder === 0
      ? compareCodeUnits(left.trust, right.trust)
      : toolOrder;
  });
  return Object.freeze({
    pairs: Object.freeze(pairs),
    trustByToolName,
  });
}

function selectTextToolResult(
  value: unknown,
  trustByToolName: ReadonlyMap<string, TextPreparationRequest['trust']>,
): SelectedToolResult | undefined {
  if (value === null || typeof value !== 'object') {
    return undefined;
  }
  const partSnapshot = { ...value } as Record<string, unknown>;
  if (partSnapshot.type !== 'tool-result') {
    return undefined;
  }
  const toolName = partSnapshot.toolName;
  const outputValue = partSnapshot.output;
  if (
    typeof toolName !== 'string' ||
    outputValue === null ||
    typeof outputValue !== 'object'
  ) {
    return undefined;
  }
  const outputSnapshot = { ...outputValue } as Record<string, unknown>;
  if (
    outputSnapshot.type !== 'text' ||
    typeof outputSnapshot.value !== 'string'
  ) {
    return undefined;
  }
  const trust = trustByToolName.get(toolName);
  if (trust === undefined) {
    return undefined;
  }
  const output = Object.freeze(outputSnapshot) as SelectedToolResult['output'];
  const part = Object.freeze({
    ...partSnapshot,
    output,
  }) as unknown as LanguageModelV4ToolResultPart;
  return Object.freeze({
    part,
    output,
    trust,
    originalContent: outputSnapshot.value,
  });
}

function candidateId(messageIndex: number, partIndex: number): string {
  return `ai-sdk-tool-result-m${messageIndex}-p${partIndex}`;
}

function snapshotPreparationResult(value: unknown): PreparationResultSnapshot {
  if (value === null || typeof value !== 'object') {
    throw invalidPreparationResult();
  }
  const source = value as Record<PropertyKey, unknown>;

  // Read every live top-level field exactly once before validating or using it.
  const content = Reflect.get(source, 'content');
  const applied = Reflect.get(source, 'applied');
  const selectedCodec = Reflect.get(source, 'selectedCodec');
  const reasonsValue = Reflect.get(source, 'reasons');
  const proofValue = Reflect.get(source, 'proof');
  const promotionDigest = Reflect.get(source, 'promotionDigest');
  const deploymentScopeDigest = Reflect.get(source, 'deploymentScopeDigest');

  const reasons = snapshotDenseDataArray(
    reasonsValue,
    1,
    HOST_PREPARATION_REASON_CODES.length,
    'The text preparer returned an invalid result',
  );
  if (
    typeof content !== 'string' ||
    typeof applied !== 'boolean' ||
    !isSafeIdentifier(selectedCodec) ||
    !reasons.every(isHostReasonCode) ||
    applied !== reasons.includes('APPLIED') ||
    (applied && (reasons.length !== 1 || selectedCodec === 'identity')) ||
    (promotionDigest !== undefined && !isSha256Digest(promotionDigest)) ||
    (deploymentScopeDigest !== undefined &&
      !isSha256Digest(deploymentScopeDigest))
  ) {
    throw invalidPreparationResult();
  }

  const proof =
    proofValue === undefined
      ? undefined
      : (deepFreeze(structuredClone(proofValue as object)) as ProofEnvelope);
  return Object.freeze({
    content,
    applied,
    selectedCodec,
    reasons: Object.freeze([...reasons]) as readonly HostReasonCode[],
    ...(proof === undefined ? {} : { proof }),
    ...(promotionDigest === undefined ? {} : { promotionDigest }),
    ...(deploymentScopeDigest === undefined ? {} : { deploymentScopeDigest }),
  });
}

function assertResultSemantics(
  result: PreparationResultSnapshot,
  id: string,
  originalContent: string,
  trust: TextPreparationRequest['trust'],
  deploymentScopeDigest: Sha256Digest,
): void {
  if (!result.applied) {
    if (result.content !== originalContent) {
      throw invalidPreparationResult();
    }
    return;
  }
  if (
    result.content === originalContent ||
    result.selectedCodec !== 'json-jcs' ||
    result.proof === undefined ||
    result.promotionDigest === undefined ||
    result.deploymentScopeDigest !== deploymentScopeDigest
  ) {
    throw invalidPreparationResult();
  }

  const proof = result.proof;
  const originalBytes = exactUtf8(originalContent);
  const candidateBytes = exactUtf8(result.content);
  const originalDigest = sha256(originalBytes);
  const candidateDigest = sha256(candidateBytes);
  const segmentMetadataDigest = digestSegmentMetadata(
    createSegment({
      id,
      role: 'tool',
      kind: 'json-data',
      trust,
      mediaType: 'application/json',
      equivalence: 'typed-semantic',
      content: originalBytes,
    }),
  );
  if (
    proof.schema !== 'semwitness.dev/proof/v1alpha1' ||
    proof.segmentId !== id ||
    proof.segmentMetadataDigest !== segmentMetadataDigest ||
    !isSha256Digest(proof.policyDigest) ||
    !isSha256Digest(proof.proofDigest) ||
    proof.proofDigest !== recomputeProofDigest(proof) ||
    proof.codec.id !== result.selectedCodec ||
    proof.codec.version !== '1' ||
    !isSha256Digest(proof.codec.configDigest) ||
    proof.claim.equivalence !== 'typed-semantic' ||
    proof.claim.verifierId !== 'semwitness-core' ||
    proof.claim.verifierVersion !== '1' ||
    proof.decision.status !== 'applied' ||
    !Array.isArray(proof.decision.reasons) ||
    proof.decision.reasons.length !== 1 ||
    proof.decision.reasons[0] !== 'APPLIED' ||
    proof.original.sha256 !== originalDigest ||
    proof.original.cas !== originalDigest ||
    proof.original.byteLength !== originalBytes.byteLength ||
    proof.original.stored !== true ||
    proof.encoded.sha256 !== candidateDigest ||
    proof.encoded.byteLength !== candidateBytes.byteLength ||
    proof.encoded.mediaType !== 'application/json' ||
    proof.encoded.stored !== true ||
    !isSha256Digest(proof.anchorManifest.sha256)
  ) {
    throw invalidPreparationResult();
  }
}

function exactUtf8(value: string): Uint8Array {
  const bytes = new TextEncoder().encode(value);
  if (new TextDecoder('utf-8', { fatal: true }).decode(bytes) !== value) {
    throw invalidPreparationResult();
  }
  return bytes;
}

function decisionEvent(
  id: string,
  operation: 'generate' | 'stream',
  messageIndex: number,
  partIndex: number,
  result: PreparationResultSnapshot,
): PreparationDecisionEvent {
  return Object.freeze({
    id,
    operation,
    messageIndex,
    partIndex,
    applied: result.applied,
    selectedCodec: result.selectedCodec,
    reasons: result.reasons,
    ...(result.promotionDigest === undefined
      ? {}
      : { promotionDigest: result.promotionDigest }),
  });
}

async function transformPrompt(
  params: LanguageModelV4CallOptions,
  operation: 'generate' | 'stream',
  preparer: TextRequestPreparer,
  trustByToolName: ReadonlyMap<string, TextPreparationRequest['trust']>,
  deploymentScopeDigest: Sha256Digest,
  limits: AiSdkMiddlewareLimits,
  onDecision: SemWitnessLanguageModelMiddlewareOptions['onDecision'],
): Promise<LanguageModelV4CallOptions> {
  let paramsSnapshot: LanguageModelV4CallOptions;
  const decisions: PreparationDecisionEvent[] = [];
  const deadline = createTransformationDeadline(limits.preparationTimeoutMs);

  try {
    paramsSnapshot = { ...params };
    const promptSnapshot = snapshotRuntimeArray(
      paramsSnapshot.prompt,
      limits.maxMessagesPerCall,
    ) as readonly LanguageModelV4CallOptions['prompt'][number][];
    const candidates: SelectedCandidate[] = [];
    const toolMessages = new Map<number, ToolMessageSnapshot>();
    let toolPartCount = 0;

    // Snapshot every selected candidate synchronously before the first await.
    for (
      let messageIndex = 0;
      messageIndex < promptSnapshot.length;
      messageIndex += 1
    ) {
      const liveMessage = promptSnapshot[messageIndex]!;
      const message = { ...liveMessage };
      if (message.role !== 'tool') {
        continue;
      }
      const contentSnapshot = [
        ...snapshotRuntimeArray(
          message.content,
          limits.maxToolPartsPerCall - toolPartCount,
        ),
      ] as ToolMessagePart[];
      toolPartCount += contentSnapshot.length;
      const candidateOffset = candidates.length;

      for (
        let partIndex = 0;
        partIndex < contentSnapshot.length;
        partIndex += 1
      ) {
        const selected = selectTextToolResult(
          contentSnapshot[partIndex],
          trustByToolName,
        );
        if (selected === undefined) {
          continue;
        }
        if (candidates.length >= limits.maxCandidatesPerCall) {
          throw availabilityLimitExceeded();
        }
        const id = candidateId(messageIndex, partIndex);
        contentSnapshot[partIndex] = selected.part;
        candidates.push(
          Object.freeze({ id, messageIndex, partIndex, selected }),
        );
      }
      if (candidates.length > candidateOffset) {
        const frozenContent = Object.freeze([...contentSnapshot]);
        toolMessages.set(
          messageIndex,
          Object.freeze({
            message: Object.freeze({
              ...message,
              content: frozenContent,
            }),
            content: frozenContent,
          }),
        );
      }
    }
    assertWithinDeadline(deadline);

    const transformedContentByMessage = new Map<
      number,
      ToolMessage['content']
    >();
    for (const candidate of candidates) {
      const { id, messageIndex, partIndex, selected } = candidate;
      assertWithinDeadline(deadline);
      const preparation = Promise.resolve(
        preparer.prepare({
          id,
          role: 'tool',
          kind: 'json-data',
          trust: selected.trust,
          mediaType: 'application/json',
          equivalence: 'typed-semantic',
          deploymentScopeDigest,
          content: selected.originalContent,
        }),
      );
      const liveResult = await Promise.race([preparation, deadline.rejection]);
      assertWithinDeadline(deadline);
      const result = snapshotPreparationResult(liveResult);
      assertResultSemantics(
        result,
        id,
        selected.originalContent,
        selected.trust,
        deploymentScopeDigest,
      );
      assertWithinDeadline(deadline);

      decisions.push(
        decisionEvent(id, operation, messageIndex, partIndex, result),
      );
      if (!result.applied) {
        continue;
      }

      let transformedContent = transformedContentByMessage.get(messageIndex);
      if (transformedContent === undefined) {
        const toolMessage = toolMessages.get(messageIndex);
        if (toolMessage === undefined) {
          throw invalidPreparationResult();
        }
        transformedContent = [...toolMessage.content];
        transformedContentByMessage.set(messageIndex, transformedContent);
      }
      transformedContent[partIndex] = {
        ...selected.part,
        output: {
          ...selected.output,
          value: result.content,
        },
      };
    }

    if (transformedContentByMessage.size === 0) {
      assertWithinDeadline(deadline);
      notifyDetached(decisions, onDecision);
      return params;
    }
    const transformedPrompt = [...promptSnapshot];
    for (const [messageIndex, content] of transformedContentByMessage) {
      const toolMessage = toolMessages.get(messageIndex);
      if (toolMessage === undefined) {
        throw invalidPreparationResult();
      }
      transformedPrompt[messageIndex] = {
        ...toolMessage.message,
        content,
      };
    }
    const transformedParams = { ...paramsSnapshot, prompt: transformedPrompt };
    assertWithinDeadline(deadline);
    notifyDetached(decisions, onDecision);
    return transformedParams;
  } catch {
    return params;
  } finally {
    clearTimeout(deadline.timer);
  }
}

function createTransformationDeadline(
  timeoutMs: number,
): TransformationDeadline {
  let expired = false;
  let timer!: ReturnType<typeof setTimeout>;
  const expiresAt = performance.now() + timeoutMs;
  const rejection = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      expired = true;
      reject(availabilityLimitExceeded());
    }, timeoutMs);
  });
  return Object.freeze({
    expiresAt,
    rejection,
    timer,
    timedOut: () => expired,
  });
}

function assertWithinDeadline(deadline: TransformationDeadline): void {
  if (deadline.timedOut() || performance.now() >= deadline.expiresAt) {
    throw availabilityLimitExceeded();
  }
}

function snapshotRuntimeArray(
  value: unknown,
  maximumLength: number,
): readonly unknown[] {
  if (!Array.isArray(value) || maximumLength < 0) {
    throw availabilityLimitExceeded();
  }
  const length = Reflect.get(value, 'length');
  if (
    !Number.isSafeInteger(length) ||
    (length as number) < 0 ||
    (length as number) > maximumLength
  ) {
    throw availabilityLimitExceeded();
  }
  const snapshot: unknown[] = [];
  for (let index = 0; index < (length as number); index += 1) {
    snapshot.push(Reflect.get(value, String(index)));
  }
  return Object.freeze(snapshot);
}

function availabilityLimitExceeded(): TypeError {
  return new TypeError('AI SDK middleware availability limit exceeded');
}

function notifyDetached(
  decisions: readonly PreparationDecisionEvent[],
  onDecision: SemWitnessLanguageModelMiddlewareOptions['onDecision'],
): void {
  if (onDecision === undefined) {
    return;
  }
  for (const event of decisions) {
    try {
      void Promise.resolve(onDecision(event)).catch(() => {});
    } catch {
      // Observability must not change or prevent the provider request.
    }
  }
}

function snapshotDataRecord(
  value: unknown,
  allowedFields: readonly string[],
  requiredFields: readonly string[],
  message: string,
): Readonly<Record<string, unknown>> {
  const prototype =
    value !== null && typeof value === 'object'
      ? Reflect.getPrototypeOf(value)
      : undefined;
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (prototype !== Object.prototype && prototype !== null)
  ) {
    throw new TypeError(message);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.some(
      (key) => typeof key !== 'string' || !allowedFields.includes(key),
    ) ||
    requiredFields.some((field) => !ownKeys.includes(field))
  ) {
    throw new TypeError(message);
  }

  const snapshot: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const field of ownKeys as string[]) {
    snapshot[field] = dataDescriptorValue(value, field, true, message);
  }
  return Object.freeze(snapshot);
}

function snapshotDenseDataArray(
  value: unknown,
  minimumLength: number,
  maximumLength: number,
  message: string,
): readonly unknown[] {
  const prototype = Array.isArray(value)
    ? Reflect.getPrototypeOf(value)
    : undefined;
  if (!Array.isArray(value) || prototype !== Array.prototype) {
    throw new TypeError(message);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== 'string')) {
    throw new TypeError(message);
  }
  const length = dataDescriptorValue(value, 'length', false, message);
  if (
    !Number.isSafeInteger(length) ||
    (length as number) < minimumLength ||
    (length as number) > maximumLength ||
    ownKeys.length !== (length as number) + 1
  ) {
    throw new TypeError(message);
  }

  const snapshot: unknown[] = [];
  for (let index = 0; index < (length as number); index += 1) {
    const field = String(index);
    if (!ownKeys.includes(field)) {
      throw new TypeError(message);
    }
    snapshot.push(dataDescriptorValue(value, field, true, message));
  }
  if (!ownKeys.includes('length')) {
    throw new TypeError(message);
  }
  return Object.freeze(snapshot);
}

function dataDescriptorValue(
  value: object,
  field: PropertyKey,
  enumerable: boolean,
  message: string,
): unknown {
  const descriptor = Reflect.getOwnPropertyDescriptor(value, field);
  if (
    descriptor === undefined ||
    descriptor.enumerable !== enumerable ||
    !Object.hasOwn(descriptor, 'value') ||
    Object.hasOwn(descriptor, 'get') ||
    Object.hasOwn(descriptor, 'set')
  ) {
    throw new TypeError(message);
  }
  return descriptor.value;
}

function deepFreeze(value: object, seen = new Set<object>()): object {
  if (seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (
      descriptor !== undefined &&
      Object.hasOwn(descriptor, 'value') &&
      descriptor.value !== null &&
      typeof descriptor.value === 'object'
    ) {
      deepFreeze(descriptor.value as object, seen);
    }
  }
  return Object.freeze(value);
}

function invalidPreparationResult(): TypeError {
  return new TypeError('The text preparer returned an invalid result');
}

/**
 * Creates a fail-open AI SDK v4 middleware that prepares only explicitly
 * selected textual tool results. All provider calls and response handling stay
 * owned by the wrapped model.
 */
export function createSemWitnessLanguageModelMiddleware(
  options: SemWitnessLanguageModelMiddlewareOptions,
): LanguageModelV4Middleware {
  const snapshot = snapshotDataRecord(
    options,
    OPTION_FIELDS,
    REQUIRED_OPTION_FIELDS,
    'Invalid SemWitness middleware options',
  );
  const preparerValue = snapshot.preparer;
  const prepare =
    preparerValue !== null && typeof preparerValue === 'object'
      ? Reflect.get(preparerValue, 'prepare')
      : undefined;
  const onDecision = snapshot.onDecision;
  if (
    typeof prepare !== 'function' ||
    (onDecision !== undefined && typeof onDecision !== 'function')
  ) {
    throw new TypeError('Invalid SemWitness middleware options');
  }

  const validatedSelectors = validateSelectors(snapshot.selectors);
  const scope = validateDeploymentScope(snapshot.scope);
  const limits = validateLimits(snapshot.limits);
  const deploymentScopeDigest = digestValidatedDeploymentScope(
    scope,
    validatedSelectors.pairs,
  );
  const preparer: TextRequestPreparer = Object.freeze({
    prepare: (request: TextPreparationRequest) =>
      Reflect.apply(prepare, preparerValue, [
        request,
      ]) as Promise<TextPreparationResult>,
  });

  return Object.freeze({
    specificationVersion: 'v4',
    async transformParams({ type, params, model }) {
      try {
        const provider = model.provider;
        const modelId = model.modelId;
        if (provider !== scope.provider || modelId !== scope.modelId) {
          return params;
        }
      } catch {
        return params;
      }
      return transformPrompt(
        params,
        type,
        preparer,
        validatedSelectors.trustByToolName,
        deploymentScopeDigest,
        limits,
        onDecision as SemWitnessLanguageModelMiddlewareOptions['onDecision'],
      );
    },
  });
}
