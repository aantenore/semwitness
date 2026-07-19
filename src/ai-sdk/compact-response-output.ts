import type { LanguageModelV4CallOptions } from '@ai-sdk/provider';
import {
  NoOutputGeneratedError,
  type FinishReason,
  type LanguageModelUsage,
  type Output as AiSdkOutput,
} from 'ai';

import {
  canonicalJson,
  immutableJson,
  toJsonValue,
  type JsonValue,
} from '../domain/canonical-json.js';
import { hashCanonical, sha256 } from '../domain/hash.js';
import type { Sha256Digest } from '../domain/types.js';
import {
  digestCompactResponseContract,
  isResponseReasonCode,
  parseCompactResponseCandidate,
  parseCompactResponseContract,
  parseCompactResponseWitness,
  RESPONSE_REASON_CODES,
  responseReasonFromError,
  serializeCompactResponseWitness,
  type BoundedJsonSchema,
  type CompactResponseContract,
  type CompactResponseRuntime,
  type CompactResponseWitness,
  type ResponseReasonCode,
} from '../response/index.js';
import { snapshotBoundedUint8Array } from '../response/byte-snapshot.js';

type JsonResponseFormat = Extract<
  NonNullable<LanguageModelV4CallOptions['responseFormat']>,
  { readonly type: 'json' }
>;
type AiSdkJsonSchema = NonNullable<JsonResponseFormat['schema']>;

const issuedCompactResponseOutputs = new WeakSet<object>();

export const COMPACT_RESPONSE_AI_SDK_OUTPUT_ARTIFACT = Object.freeze({
  id: 'semwitness-compact-response-output',
  version: '1',
} as const);

export const COMPACT_RESPONSE_AI_SDK_OBSERVATION_SCHEMA =
  'semwitness.dev/compact-response-ai-sdk-observation/v1alpha1' as const;

export const COMPACT_RESPONSE_OUTPUT_REASON_CODES = [
  'MODEL_FINISH_REASON_REJECTED',
  'AI_SDK_CONTEXT_INVALID',
  'PROVIDER_SCHEMA_UNSUPPORTED',
] as const;

export type CompactResponseOutputReasonCode =
  ResponseReasonCode | (typeof COMPACT_RESPONSE_OUTPUT_REASON_CODES)[number];

export interface CompactResponseAiSdkObservation {
  readonly schema: typeof COMPACT_RESPONSE_AI_SDK_OBSERVATION_SCHEMA;
  readonly artifact: typeof COMPACT_RESPONSE_AI_SDK_OUTPUT_ARTIFACT;
  readonly contractDigest: Sha256Digest;
  readonly witnessDigest: Sha256Digest;
  readonly finishReason: 'stop';
  readonly response: {
    readonly idDigest: Sha256Digest;
    readonly idCodeUnits: number;
    readonly modelIdDigest: Sha256Digest;
    readonly modelIdCodeUnits: number;
    readonly timestamp: string;
  };
  readonly finalStepUsage: {
    readonly inputTokens: number | undefined;
    readonly inputTokenDetails: {
      readonly noCacheTokens: number | undefined;
      readonly cacheReadTokens: number | undefined;
      readonly cacheWriteTokens: number | undefined;
    };
    readonly outputTokens: number | undefined;
    readonly outputTokenDetails: {
      readonly textTokens: number | undefined;
      readonly reasoningTokens: number | undefined;
    };
    readonly totalTokens: number | undefined;
  };
  /** A measured generation has no paired baseline from which to infer savings. */
  readonly billedOutputSavings: null;
  /** Binds this untrusted provider observation to the exact local witness. */
  readonly observationDigest: Sha256Digest;
}

export interface CompactResponseAiSdkResult {
  /** Owned rendered bytes. The witness binds the bytes before caller mutation. */
  readonly rendered: Uint8Array;
  readonly mediaType: string;
  readonly witness: CompactResponseWitness;
  readonly providerObservation: CompactResponseAiSdkObservation;
}

export interface CompactResponseAiSdkOutputOptions {
  readonly contract: CompactResponseContract;
  readonly runtime: Pick<CompactResponseRuntime, 'render'>;
  /** Optional provider-facing structured-output name. */
  readonly name?: string;
  /** Optional provider-facing guidance; semantic instructions remain host-owned. */
  readonly description?: string;
}

/**
 * A content-free signal that the host must retry or fall back without exposing
 * the compact candidate or a partial rendering.
 */
export class CompactResponseOutputRetryRequiredError extends Error {
  readonly reasons: readonly CompactResponseOutputReasonCode[];

  constructor(reasons: readonly CompactResponseOutputReasonCode[]) {
    super('Compact response output requires a host retry');
    this.name = 'CompactResponseOutputRetryRequiredError';
    this.reasons = Object.freeze([...reasons]);
  }
}

export interface CompactResponseOutputRequirement {
  readonly read: () => CompactResponseAiSdkResult;
  readonly warnings: readonly unknown[] | undefined;
}

/**
 * AI SDK does not invoke an Output parser when `generateText` finishes for a
 * reason other than `stop`. Call this at the host boundary before using the
 * output so that an absent value becomes the same bounded retry signal.
 */
export function requireCompactResponseOutput(
  requirement: CompactResponseOutputRequirement,
): CompactResponseAiSdkResult {
  let value: CompactResponseAiSdkResult;
  try {
    if (requirement === null || typeof requirement !== 'object') {
      throw new TypeError('Compact Response output reader is invalid');
    }
    const read: unknown = Reflect.get(requirement, 'read');
    const warnings: unknown = Reflect.get(requirement, 'warnings');
    if (typeof read !== 'function') {
      throw new TypeError('Compact Response output reader is invalid');
    }
    assertProviderSchemaWarnings(warnings);
    value = Reflect.apply(read, requirement, []);
  } catch (error) {
    if (error instanceof CompactResponseOutputRetryRequiredError) throw error;
    if (NoOutputGeneratedError.isInstance(error)) {
      throw retryRequired(['MODEL_FINISH_REASON_REJECTED']);
    }
    throw retryRequired(['AI_SDK_CONTEXT_INVALID']);
  }
  if (
    value === null ||
    typeof value !== 'object' ||
    !issuedCompactResponseOutputs.has(value)
  ) {
    throw retryRequired(['AI_SDK_CONTEXT_INVALID']);
  }
  return value;
}

function assertProviderSchemaWarnings(warnings: unknown): void {
  try {
    if (warnings === undefined) return;
    if (!Array.isArray(warnings)) {
      throw new TypeError('Invalid AI SDK warnings');
    }
    const length: unknown = Reflect.getOwnPropertyDescriptor(
      warnings,
      'length',
    )?.value;
    if (
      typeof length !== 'number' ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > 256
    ) {
      throw new TypeError('Invalid AI SDK warnings');
    }
    for (let index = 0; index < length; index += 1) {
      const descriptor = Reflect.getOwnPropertyDescriptor(
        warnings,
        String(index),
      );
      const warning = descriptor?.value;
      if (
        descriptor === undefined ||
        !Object.hasOwn(descriptor, 'value') ||
        warning === null ||
        typeof warning !== 'object'
      ) {
        throw new TypeError('Invalid AI SDK warning');
      }
      const type: unknown = Reflect.get(warning, 'type');
      const feature: unknown = Reflect.get(warning, 'feature');
      if (
        feature === 'responseFormat' &&
        (type === 'unsupported' || type === 'compatibility')
      ) {
        throw retryRequired(['PROVIDER_SCHEMA_UNSUPPORTED']);
      }
    }
  } catch (error) {
    if (error instanceof CompactResponseOutputRetryRequiredError) throw error;
    throw retryRequired(['AI_SDK_CONTEXT_INVALID']);
  }
}

/**
 * Creates a non-streaming-first AI SDK Output specification. The provider is
 * asked for the contract's compact JSON shape; only the complete candidate is
 * rendered and returned through `result.output`.
 *
 * AI SDK also exposes raw provider content through result, callback, telemetry,
 * message, and stream surfaces. Compact Response authority applies only to the
 * value returned through the mandatory `requireCompactResponseOutput` boundary.
 */
export function createCompactResponseOutput(
  options: CompactResponseAiSdkOutputOptions,
): AiSdkOutput.Output<CompactResponseAiSdkResult, never, never> {
  const snapshot = snapshotOptions(options);
  const responseFormat = Object.freeze({
    type: 'json' as const,
    schema: boundedSchemaToDraft7(snapshot.contract.candidate.schema),
    ...(snapshot.name === undefined ? {} : { name: snapshot.name }),
    ...(snapshot.description === undefined
      ? {}
      : { description: snapshot.description }),
  });

  return Object.freeze({
    name: COMPACT_RESPONSE_AI_SDK_OUTPUT_ARTIFACT.id,
    responseFormat: Promise.resolve(responseFormat),
    async parseCompleteOutput(
      { text }: { readonly text: string },
      context: {
        readonly response: {
          readonly id: string;
          readonly modelId: string;
          readonly timestamp: Date;
        };
        readonly usage: LanguageModelUsage;
        readonly finishReason: FinishReason;
      },
    ) {
      if (context.finishReason !== 'stop') {
        throw retryRequired(['MODEL_FINISH_REASON_REJECTED']);
      }

      let rendered: unknown;
      try {
        rendered = await Reflect.apply(snapshot.render, snapshot.runtime, [
          { contract: snapshot.contract, candidate: text },
        ]);
      } catch {
        throw retryRequired(['RENDER_ERROR']);
      }

      try {
        const result = snapshotRuntimeResult(rendered, snapshot.contract, text);
        if (result.status === 'retry-required') {
          throw retryRequired(result.reasons);
        }
        const providerObservation = snapshotObservation(
          {
            response: context.response,
            usage: context.usage,
            finishReason: 'stop',
          },
          snapshot.contractDigest,
          result.witness.witnessDigest,
        );
        const output = Object.freeze({
          rendered: result.output,
          mediaType: snapshot.contract.renderer.outputMediaType,
          witness: result.witness,
          providerObservation,
        });
        issuedCompactResponseOutputs.add(output);
        return output;
      } catch (error) {
        if (error instanceof CompactResponseOutputRetryRequiredError) {
          throw error;
        }
        throw retryRequired(['RENDER_ERROR']);
      }
    },
    async parsePartialOutput() {
      return undefined;
    },
    createElementStreamTransform() {
      return undefined;
    },
  });
}

interface OptionsSnapshot {
  readonly contract: CompactResponseContract;
  readonly contractDigest: Sha256Digest;
  readonly runtime: object;
  readonly render: CompactResponseRuntime['render'];
  readonly name?: string;
  readonly description?: string;
}

function snapshotOptions(
  options: CompactResponseAiSdkOutputOptions,
): OptionsSnapshot {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('Compact Response AI SDK options are invalid');
  }

  const contract = parseCompactResponseContract(
    canonicalJson(toJsonValue(options.contract)),
  );
  const runtime = options.runtime;
  const render =
    runtime !== null && typeof runtime === 'object'
      ? Reflect.get(runtime, 'render')
      : undefined;
  if (typeof render !== 'function') {
    throw new TypeError('Compact Response AI SDK runtime is invalid');
  }

  return Object.freeze({
    contract,
    contractDigest: digestCompactResponseContract(contract),
    runtime,
    render: render as CompactResponseRuntime['render'],
    ...(options.name === undefined
      ? {}
      : { name: boundedGuidance(options.name, 'name', 128) }),
    ...(options.description === undefined
      ? {}
      : {
          description: boundedGuidance(
            options.description,
            'description',
            2_048,
          ),
        }),
  });
}

function boundedGuidance(
  value: unknown,
  field: string,
  maximumCodeUnits: number,
): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maximumCodeUnits ||
    value.trim() !== value ||
    !isWellFormedUnicode(value)
  ) {
    throw new TypeError(`Compact Response AI SDK ${field} is invalid`);
  }
  return value;
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

function boundedSchemaToDraft7(schema: BoundedJsonSchema): AiSdkJsonSchema {
  const converted = convertSchemaNode(schema);
  return immutableJson(toJsonValue(converted)) as AiSdkJsonSchema;
}

function convertSchemaNode(schema: BoundedJsonSchema): JsonValue {
  switch (schema.type) {
    case 'null':
    case 'boolean':
      return {
        type: schema.type,
        ...(schema.enum === undefined ? {} : { enum: [...schema.enum] }),
      };
    case 'number':
    case 'integer':
      return {
        type: schema.type,
        ...(schema.enum === undefined ? {} : { enum: [...schema.enum] }),
        ...(schema.minimum === undefined ? {} : { minimum: schema.minimum }),
        ...(schema.maximum === undefined ? {} : { maximum: schema.maximum }),
      };
    case 'string':
      return {
        type: 'string',
        ...(schema.enum === undefined ? {} : { enum: [...schema.enum] }),
        ...(schema.minLength === undefined
          ? {}
          : { minLength: schema.minLength }),
        ...(schema.maxLength === undefined
          ? {}
          : { maxLength: schema.maxLength }),
      };
    case 'array':
      if ('prefixItems' in schema) {
        return {
          type: 'array',
          items: schema.prefixItems.map(convertSchemaNode),
          additionalItems: false,
          minItems: schema.minItems,
          maxItems: schema.maxItems,
        };
      }
      return {
        type: 'array',
        items: convertSchemaNode(schema.items),
        ...(schema.minItems === undefined ? {} : { minItems: schema.minItems }),
        maxItems: schema.maxItems,
      };
    case 'object': {
      const properties: Record<string, JsonValue> = Object.create(
        null,
      ) as Record<string, JsonValue>;
      for (const key of Object.keys(schema.properties).sort()) {
        properties[key] = convertSchemaNode(schema.properties[key]!);
      }
      return {
        type: 'object',
        properties,
        required: [...schema.required],
        additionalProperties: false,
      };
    }
  }
}

function snapshotObservation(
  context: {
    readonly response: {
      readonly id: string;
      readonly modelId: string;
      readonly timestamp: Date;
    };
    readonly usage: LanguageModelUsage;
    readonly finishReason: 'stop';
  },
  contractDigest: Sha256Digest,
  witnessDigest: Sha256Digest,
): CompactResponseAiSdkObservation {
  try {
    const { response, usage } = context;
    const id: unknown = response.id;
    const modelId: unknown = response.modelId;
    const timestamp: unknown = response.timestamp;
    const inputTokens: unknown = usage.inputTokens;
    const inputTokenDetails: unknown = usage.inputTokenDetails;
    const outputTokens: unknown = usage.outputTokens;
    const outputTokenDetails: unknown = usage.outputTokenDetails;
    const totalTokens: unknown = usage.totalTokens;
    if (
      inputTokenDetails === null ||
      typeof inputTokenDetails !== 'object' ||
      outputTokenDetails === null ||
      typeof outputTokenDetails !== 'object'
    ) {
      throw new TypeError('Invalid provider usage');
    }
    const noCacheTokens: unknown = Reflect.get(
      inputTokenDetails,
      'noCacheTokens',
    );
    const cacheReadTokens: unknown = Reflect.get(
      inputTokenDetails,
      'cacheReadTokens',
    );
    const cacheWriteTokens: unknown = Reflect.get(
      inputTokenDetails,
      'cacheWriteTokens',
    );
    const textTokens: unknown = Reflect.get(outputTokenDetails, 'textTokens');
    const reasoningTokens: unknown = Reflect.get(
      outputTokenDetails,
      'reasoningTokens',
    );
    const timestampMs =
      timestamp instanceof Date
        ? Reflect.apply(Date.prototype.getTime, timestamp, [])
        : Number.NaN;
    if (
      typeof id !== 'string' ||
      id.length < 1 ||
      id.length > 1_024 ||
      !isWellFormedUnicode(id) ||
      typeof modelId !== 'string' ||
      modelId.length < 1 ||
      modelId.length > 1_024 ||
      !isWellFormedUnicode(modelId) ||
      !Number.isFinite(timestampMs)
    ) {
      throw new TypeError('Invalid response metadata');
    }

    const safeInputTokens = snapshotTokenCount(inputTokens);
    const safeNoCacheTokens = snapshotTokenCount(noCacheTokens);
    const safeCacheReadTokens = snapshotTokenCount(cacheReadTokens);
    const safeCacheWriteTokens = snapshotTokenCount(cacheWriteTokens);
    const safeOutputTokens = snapshotTokenCount(outputTokens);
    const safeTextTokens = snapshotTokenCount(textTokens);
    const safeReasoningTokens = snapshotTokenCount(reasoningTokens);
    const safeTotalTokens = snapshotTokenCount(totalTokens);

    const unsigned = Object.freeze({
      schema: COMPACT_RESPONSE_AI_SDK_OBSERVATION_SCHEMA,
      artifact: COMPACT_RESPONSE_AI_SDK_OUTPUT_ARTIFACT,
      contractDigest,
      witnessDigest,
      finishReason: 'stop',
      response: Object.freeze({
        idDigest: sha256(id),
        idCodeUnits: id.length,
        modelIdDigest: sha256(modelId),
        modelIdCodeUnits: modelId.length,
        timestamp: new Date(timestampMs).toISOString(),
      }),
      finalStepUsage: Object.freeze({
        inputTokens: safeInputTokens,
        inputTokenDetails: Object.freeze({
          noCacheTokens: safeNoCacheTokens,
          cacheReadTokens: safeCacheReadTokens,
          cacheWriteTokens: safeCacheWriteTokens,
        }),
        outputTokens: safeOutputTokens,
        outputTokenDetails: Object.freeze({
          textTokens: safeTextTokens,
          reasoningTokens: safeReasoningTokens,
        }),
        totalTokens: safeTotalTokens,
      }),
      billedOutputSavings: null,
    });
    return Object.freeze({
      ...unsigned,
      observationDigest: hashCanonical(toJsonValue(unsigned)),
    });
  } catch {
    throw retryRequired(['AI_SDK_CONTEXT_INVALID']);
  }
}

function snapshotTokenCount(value: unknown): number | undefined {
  if (
    value !== undefined &&
    (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
  ) {
    throw new TypeError('Invalid provider usage');
  }
  return value;
}

type RuntimeResultSnapshot =
  | {
      readonly status: 'rendered';
      readonly output: Uint8Array;
      readonly witness: CompactResponseWitness;
    }
  | {
      readonly status: 'retry-required';
      readonly reasons: readonly ResponseReasonCode[];
    };

function snapshotRuntimeResult(
  value: unknown,
  contract: CompactResponseContract,
  candidate: string,
): RuntimeResultSnapshot {
  try {
    if (value === null || typeof value !== 'object') {
      throw new TypeError('Invalid runtime result');
    }
    const status = Reflect.get(value, 'status');
    if (status === 'rendered') {
      const outputSource: unknown = Reflect.get(value, 'output');
      const witnessSource: unknown = Reflect.get(value, 'witness');
      const output = snapshotBoundedUint8Array(
        outputSource,
        contract.limits.maxRenderedBytes,
      );
      if (output.status === 'too-large') {
        throw retryRequired(['RENDER_OUTPUT_TOO_LARGE']);
      }
      if (output.status !== 'ok') {
        throw new TypeError('Invalid runtime output');
      }
      let witness: CompactResponseWitness;
      try {
        witness = parseCompactResponseWitness(
          serializeCompactResponseWitness(
            witnessSource as CompactResponseWitness,
          ),
        );
      } catch (error) {
        throw retryRequired([
          responseReasonFromError(error, 'WITNESS_MALFORMED'),
        ]);
      }
      let parsedCandidate;
      try {
        parsedCandidate = parseCompactResponseCandidate(candidate, contract);
      } catch (error) {
        throw retryRequired([
          responseReasonFromError(error, 'CANDIDATE_MALFORMED'),
        ]);
      }
      if (
        witness.contractDigest !== digestCompactResponseContract(contract) ||
        witness.candidate.exactDigest !== sha256(parsedCandidate.bytes) ||
        witness.candidate.canonicalDigest !==
          sha256(parsedCandidate.canonicalBytes) ||
        witness.candidate.byteLength !== parsedCandidate.bytes.byteLength ||
        witness.renderer.id !== contract.renderer.id ||
        witness.renderer.version !== contract.renderer.version ||
        witness.renderer.artifactDigest !== contract.renderer.artifactDigest ||
        witness.renderer.outputMediaType !==
          contract.renderer.outputMediaType ||
        witness.renderer.locale !== contract.renderer.locale ||
        witness.rendered.digest !== sha256(output.bytes) ||
        witness.rendered.byteLength !== output.bytes.byteLength
      ) {
        throw retryRequired(['WITNESS_MISMATCH']);
      }
      return Object.freeze({
        status: 'rendered',
        output: output.bytes,
        witness,
      });
    }
    if (status !== 'retry-required') {
      throw new TypeError('Invalid runtime status');
    }
    const reasonsSource: unknown = Reflect.get(value, 'reasons');
    if (!Array.isArray(reasonsSource)) {
      throw new TypeError('Invalid runtime reasons');
    }
    const lengthDescriptor = Reflect.getOwnPropertyDescriptor(
      reasonsSource,
      'length',
    );
    const length: unknown = lengthDescriptor?.value;
    if (
      typeof length !== 'number' ||
      !Number.isSafeInteger(length) ||
      length < 1 ||
      length > RESPONSE_REASON_CODES.length
    ) {
      throw new TypeError('Invalid runtime reasons');
    }
    const reasons: ResponseReasonCode[] = [];
    const seen = new Set<ResponseReasonCode>();
    for (let index = 0; index < length; index += 1) {
      const descriptor = Reflect.getOwnPropertyDescriptor(
        reasonsSource,
        String(index),
      );
      const reason = descriptor?.value;
      if (
        descriptor === undefined ||
        !Object.hasOwn(descriptor, 'value') ||
        !isResponseReasonCode(reason) ||
        seen.has(reason)
      ) {
        throw new TypeError('Invalid runtime reasons');
      }
      seen.add(reason);
      reasons.push(reason);
    }
    return Object.freeze({
      status: 'retry-required',
      reasons: Object.freeze(reasons),
    });
  } catch (error) {
    if (error instanceof CompactResponseOutputRetryRequiredError) throw error;
    throw retryRequired(['RENDER_ERROR']);
  }
}

function retryRequired(
  reasons: readonly CompactResponseOutputReasonCode[],
): CompactResponseOutputRetryRequiredError {
  return new CompactResponseOutputRetryRequiredError(reasons);
}
