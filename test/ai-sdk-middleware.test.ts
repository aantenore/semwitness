import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
  LanguageModelV4ToolResultPart,
} from '@ai-sdk/provider';
import { wrapLanguageModel } from 'ai';
import { describe, expect, it, vi } from 'vitest';

import {
  createSemWitnessLanguageModelMiddleware,
  digestAiSdkDeploymentScope,
  type AiSdkDeploymentScope,
  type AiSdkMiddlewareLimits,
  type PreparationDecisionEvent,
  type SemWitnessLanguageModelMiddlewareOptions,
  type ToolResultSelector,
} from '../src/ai-sdk/index.js';
import { sha256 } from '../src/domain/hash.js';
import {
  digestSegmentMetadata,
  finalizeProof,
  type ProofEnvelope,
} from '../src/domain/proof.js';
import { createSegment } from '../src/domain/types.js';
import type {
  TextPreparationRequest,
  TextPreparationResult,
  TextRequestPreparer,
} from '../src/host/types.js';

const prettyJson = '{\n  "b": 2,\n  "a": 1\n}';
const canonicalJson = '{"a":1,"b":2}';
const scope = Object.freeze({
  provider: 'semwitness-test',
  modelId: 'capture',
  promptContractDigest: sha256('prompt-contract-v1'),
  toolContractDigest: sha256('tool-contract-v1'),
}) satisfies AiSdkDeploymentScope;
const defaultSelectors = Object.freeze([
  Object.freeze({
    toolNames: Object.freeze(['lookup']),
    trust: 'untrusted-external',
  }),
]) satisfies readonly ToolResultSelector[];
const defaultLimits = Object.freeze({
  maxMessagesPerCall: 64,
  maxToolPartsPerCall: 256,
  maxCandidatesPerCall: 128,
  preparationTimeoutMs: 1_000,
}) satisfies AiSdkMiddlewareLimits;
const deploymentScopeDigest = digestAiSdkDeploymentScope(
  scope,
  defaultSelectors,
);
const promotionDigest = sha256('held-out-promotion-v1');

function bypassResult(content: string): TextPreparationResult {
  return {
    content,
    applied: false,
    selectedCodec: 'identity',
    reasons: ['SIMULATION_BYPASSED'],
  };
}

function appliedResult(
  request: Pick<
    TextPreparationRequest,
    'id' | 'content' | 'trust' | 'deploymentScopeDigest'
  >,
  content = canonicalJson,
): TextPreparationResult {
  const originalBytes = new TextEncoder().encode(request.content);
  const encodedBytes = new TextEncoder().encode(content);
  const originalDigest = sha256(originalBytes);
  const proof = finalizeProof({
    schema: 'semwitness.dev/proof/v1alpha1',
    segmentId: request.id,
    segmentMetadataDigest: digestSegmentMetadata(
      createSegment({
        id: request.id,
        role: 'tool',
        kind: 'json-data',
        trust: request.trust,
        mediaType: 'application/json',
        equivalence: 'typed-semantic',
        content: originalBytes,
      }),
    ),
    policyDigest: sha256('policy-v1'),
    codec: {
      id: 'json-jcs',
      version: '1',
      configDigest: sha256('json-jcs-config-v1'),
    },
    claim: {
      equivalence: 'typed-semantic',
      verifierId: 'semwitness-core',
      verifierVersion: '1',
    },
    original: {
      sha256: originalDigest,
      byteLength: originalBytes.byteLength,
      cas: originalDigest,
      stored: true,
    },
    encoded: {
      sha256: sha256(encodedBytes),
      byteLength: encodedBytes.byteLength,
      mediaType: 'application/json',
      stored: true,
    },
    anchorManifest: {
      sha256: sha256('empty-anchor-manifest'),
      entries: [],
    },
    tokenEvidence: [
      {
        tokenizerId: 'exact-test',
        tokenizerFingerprint: 'test/exact-v1',
        reliability: 'exact',
        originalTokens: originalBytes.byteLength,
        encodedTokens: encodedBytes.byteLength,
        decoderOverheadTokens: 0,
      },
    ],
    decision: { status: 'applied', reasons: ['APPLIED'] },
  });
  return {
    content,
    applied: true,
    selectedCodec: 'json-jcs',
    reasons: ['APPLIED'],
    proof,
    promotionDigest,
    deploymentScopeDigest: request.deploymentScopeDigest,
  };
}

function refinalizeProof(proof: ProofEnvelope): ProofEnvelope {
  const { proofDigest: _proofDigest, ...unsigned } = proof;
  return finalizeProof(unsigned);
}

function preparer(
  implementation: (
    request: TextPreparationRequest,
  ) => Promise<TextPreparationResult>,
): TextRequestPreparer {
  return { prepare: vi.fn(implementation) };
}

function selector(
  toolNames: readonly string[] = ['lookup'],
  trust: ToolResultSelector['trust'] = 'untrusted-external',
): ToolResultSelector {
  return { toolNames, trust };
}

function middleware(
  textPreparer: TextRequestPreparer,
  overrides: Partial<SemWitnessLanguageModelMiddlewareOptions> = {},
) {
  return createSemWitnessLanguageModelMiddleware({
    preparer: textPreparer,
    scope,
    limits: defaultLimits,
    selectors: defaultSelectors,
    ...overrides,
  });
}

function generateResult(): LanguageModelV4GenerateResult {
  return {
    content: [{ type: 'text', text: 'ok' }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: {
      inputTokens: {
        total: undefined,
        noCache: undefined,
        cacheRead: undefined,
        cacheWrite: undefined,
      },
      outputTokens: {
        total: undefined,
        text: undefined,
        reasoning: undefined,
      },
    },
    warnings: [],
  };
}

function createModel(
  capture: {
    generate?: LanguageModelV4CallOptions;
    stream?: LanguageModelV4CallOptions;
  },
  identity: { readonly provider: string; readonly modelId: string } = scope,
): LanguageModelV4 {
  return {
    specificationVersion: 'v4',
    provider: identity.provider,
    modelId: identity.modelId,
    supportedUrls: {},
    async doGenerate(options) {
      capture.generate = options;
      return generateResult();
    },
    async doStream(options) {
      capture.stream = options;
      return {
        stream: new ReadableStream<LanguageModelV4StreamPart>({
          start(controller) {
            controller.close();
          },
        }),
      };
    },
  };
}

function toolParams(
  values: readonly string[] = [prettyJson],
  toolName = 'lookup',
): LanguageModelV4CallOptions {
  return {
    prompt: [
      {
        role: 'tool',
        content: values.map((value, index) => ({
          type: 'tool-result' as const,
          toolCallId: `call-${index}`,
          toolName,
          output: { type: 'text' as const, value },
        })),
      },
    ],
  };
}

function requireTextToolResult(
  params: { readonly prompt: LanguageModelV4CallOptions['prompt'] },
  messageIndex: number,
  partIndex: number,
): LanguageModelV4ToolResultPart & {
  readonly output: { readonly type: 'text'; readonly value: string };
} {
  const message = params.prompt[messageIndex];
  if (message?.role !== 'tool') {
    throw new TypeError('Expected a tool message');
  }
  const part = message.content[partIndex];
  if (part?.type !== 'tool-result' || part.output.type !== 'text') {
    throw new TypeError('Expected a textual tool result');
  }
  return part as LanguageModelV4ToolResultPart & {
    readonly output: { readonly type: 'text'; readonly value: string };
  };
}

describe('AI SDK deployment scope', () => {
  it('is deterministic across selector grouping and order, but binds changes', () => {
    const first = [
      selector(['zeta', 'alpha'], 'workspace-trusted'),
      selector(['middle']),
    ];
    const reordered = [
      selector(['middle']),
      selector(['alpha', 'zeta'], 'workspace-trusted'),
    ];

    expect(digestAiSdkDeploymentScope(scope, first)).toBe(
      digestAiSdkDeploymentScope(scope, reordered),
    );
    expect(digestAiSdkDeploymentScope(scope, first)).not.toBe(
      digestAiSdkDeploymentScope(scope, [
        selector(['zeta', 'alpha'], 'host-trusted'),
        selector(['middle']),
      ]),
    );
    expect(digestAiSdkDeploymentScope(scope, first)).not.toBe(
      digestAiSdkDeploymentScope(
        { ...scope, modelId: 'different-model' },
        first,
      ),
    );
  });

  it('requires strict, bounded scope, options, and selectors', () => {
    const identity = preparer(async (request) => bypassResult(request.content));
    expect(() =>
      createSemWitnessLanguageModelMiddleware({
        preparer: identity,
        limits: defaultLimits,
        selectors: defaultSelectors,
      } as unknown as SemWitnessLanguageModelMiddlewareOptions),
    ).toThrow(/options/iu);
    expect(() =>
      createSemWitnessLanguageModelMiddleware({
        preparer: identity,
        scope,
        selectors: defaultSelectors,
      } as unknown as SemWitnessLanguageModelMiddlewareOptions),
    ).toThrow(/options/iu);
    expect(() =>
      middleware(identity, { selectors: [selector(), selector()] }),
    ).toThrow(/only one selector/iu);
    expect(() =>
      middleware(identity, {
        selectors: [
          {
            toolNames: ['lookup'],
            trust: 'untrusted-external',
            automatic: true,
          } as unknown as ToolResultSelector,
        ],
      }),
    ).toThrow(/strict allowlists/iu);
    expect(() =>
      middleware(identity, {
        scope: { ...scope, modelId: 'contains whitespace' },
      }),
    ).toThrow(/scope/iu);
    expect(() =>
      middleware(identity, {
        selectors: Array.from({ length: 129 }, (_, index) =>
          selector([`tool-${index}`]),
        ),
      }),
    ).toThrow(/selector/iu);

    for (const limits of [
      { ...defaultLimits, maxMessagesPerCall: 1_025 },
      { ...defaultLimits, maxToolPartsPerCall: 4_097 },
      { ...defaultLimits, maxCandidatesPerCall: 1_025 },
      { ...defaultLimits, preparationTimeoutMs: 9 },
      { ...defaultLimits, preparationTimeoutMs: 60_001 },
      { ...defaultLimits, hidden: true },
    ]) {
      expect(() => middleware(identity, { limits })).toThrow(/limits/iu);
    }

    let getterReads = 0;
    const accessorLimits = { ...defaultLimits };
    Object.defineProperty(accessorLimits, 'preparationTimeoutMs', {
      enumerable: true,
      configurable: true,
      get() {
        getterReads += 1;
        return defaultLimits.preparationTimeoutMs;
      },
    });
    expect(() => middleware(identity, { limits: accessorLimits })).toThrow(
      /limits/iu,
    );
    expect(getterReads).toBe(0);
  });
});

describe('createSemWitnessLanguageModelMiddleware', () => {
  it('delivers verified canonical JSON to the wrapped model with copy-on-write', async () => {
    const prepare = vi.fn<TextRequestPreparer['prepare']>(async (request) =>
      appliedResult(request),
    );
    const adapter = middleware({ prepare });
    const capture: { generate?: LanguageModelV4CallOptions } = {};
    const wrapped = wrapLanguageModel({
      model: createModel(capture),
      middleware: adapter,
    });
    const providerOptions = { test: { trace: 'preserve' } };
    const outputProviderOptions = { test: { cache: 'preserve' } };
    const partProviderOptions = { test: { part: 'preserve' } };
    const originalOutput = {
      type: 'text' as const,
      value: prettyJson,
      providerOptions: outputProviderOptions,
    };
    const originalPart = {
      type: 'tool-result' as const,
      toolCallId: 'call-1',
      toolName: 'lookup',
      output: originalOutput,
      providerOptions: partProviderOptions,
    };
    const originalToolMessage = {
      role: 'tool' as const,
      content: [originalPart],
    };
    const prompt: LanguageModelV4CallOptions['prompt'] = [
      { role: 'system', content: 'do not change' },
      originalToolMessage,
    ];
    const params: LanguageModelV4CallOptions = {
      prompt,
      temperature: 0.25,
      providerOptions,
    };
    Object.freeze(originalOutput);
    Object.freeze(originalPart);
    Object.freeze(originalToolMessage.content);
    Object.freeze(originalToolMessage);
    Object.freeze(prompt);
    Object.freeze(params);

    await wrapped.doGenerate(params);

    const downstream = capture.generate!;
    const downstreamPart = requireTextToolResult(downstream, 1, 0);
    expect(downstreamPart.output.value).toBe(canonicalJson);
    expect(downstreamPart.output.value.length).toBeLessThan(prettyJson.length);
    expect(prepare).toHaveBeenCalledWith({
      id: 'ai-sdk-tool-result-m1-p0',
      role: 'tool',
      kind: 'json-data',
      trust: 'untrusted-external',
      mediaType: 'application/json',
      equivalence: 'typed-semantic',
      deploymentScopeDigest,
      content: prettyJson,
    });
    expect(downstream).not.toBe(params);
    expect(downstream.prompt[0]).toBe(prompt[0]);
    expect(downstream.prompt[1]).not.toBe(originalToolMessage);
    expect(downstreamPart).not.toBe(originalPart);
    expect(downstreamPart.providerOptions).toBe(partProviderOptions);
    expect(downstreamPart.output.providerOptions).toBe(outputProviderOptions);
    expect(downstream.providerOptions).toBe(providerOptions);
    expect(originalOutput.value).toBe(prettyJson);
  });

  it('considers only selected textual tool results in tool-role messages', async () => {
    const prepare = vi.fn<TextRequestPreparer['prepare']>(async (request) =>
      appliedResult(request),
    );
    const adapter = middleware({ prepare });
    const selectedText = {
      type: 'tool-result' as const,
      toolCallId: 'selected',
      toolName: 'lookup',
      output: { type: 'text' as const, value: prettyJson },
    };
    const unselectedText = {
      ...selectedText,
      toolCallId: 'unselected',
      toolName: 'other',
    };
    const jsonOutput = {
      ...selectedText,
      toolCallId: 'json',
      output: { type: 'json' as const, value: { a: 1 } },
    };
    const params: LanguageModelV4CallOptions = {
      prompt: [
        { role: 'assistant', content: [selectedText] },
        {
          role: 'tool',
          content: [selectedText, unselectedText, jsonOutput],
        },
      ],
    };

    const transformed = await adapter.transformParams!({
      type: 'generate',
      params,
      model: createModel({}),
    });

    expect(prepare).toHaveBeenCalledTimes(1);
    expect(requireTextToolResult(transformed, 1, 0).output.value).toBe(
      canonicalJson,
    );
    expect(transformed.prompt[0]).toBe(params.prompt[0]);
    const toolMessage = transformed.prompt[1];
    if (toolMessage?.role !== 'tool') {
      throw new TypeError('Expected tool message');
    }
    expect(toolMessage.content[1]).toBe(unselectedText);
    expect(toolMessage.content[2]).toBe(jsonOutput);
  });

  it('returns the exact request for bypasses and emits content-free decisions', async () => {
    const sentinel = 'SENTINEL_PRIVATE_SOURCE_9257';
    const events: PreparationDecisionEvent[] = [];
    const adapter = middleware(
      preparer(async (request) => bypassResult(request.content)),
      {
        onDecision(event) {
          events.push(event);
        },
      },
    );
    const params = toolParams([sentinel]);

    const transformed = await adapter.transformParams!({
      type: 'generate',
      params,
      model: createModel({}),
    });

    expect(transformed).toBe(params);
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain(sentinel);
    expect(Object.isFrozen(events[0])).toBe(true);
    expect(Object.isFrozen(events[0]!.reasons)).toBe(true);
    expect(events[0]).toMatchObject({
      id: 'ai-sdk-tool-result-m0-p0',
      operation: 'generate',
      applied: false,
      selectedCodec: 'identity',
      reasons: ['SIMULATION_BYPASSED'],
    });
  });

  it('does not prepare on selector or runtime model mismatch', async () => {
    const prepare = vi.fn<TextRequestPreparer['prepare']>(async (request) =>
      appliedResult(request),
    );
    const adapter = middleware({ prepare });
    const unselected = toolParams([prettyJson], 'other');
    const modelMismatch = toolParams();

    expect(
      await adapter.transformParams!({
        type: 'generate',
        params: unselected,
        model: createModel({}),
      }),
    ).toBe(unselected);
    expect(
      await adapter.transformParams!({
        type: 'generate',
        params: modelMismatch,
        model: createModel({}, { ...scope, modelId: 'other-model' }),
      }),
    ).toBe(modelMismatch);
    expect(prepare).not.toHaveBeenCalled();
  });

  it('fails atomically before preparation when any scan limit overflows', async () => {
    const oneToolMessage = toolParams();
    const cases: readonly {
      readonly params: LanguageModelV4CallOptions;
      readonly limits: AiSdkMiddlewareLimits;
    }[] = [
      {
        params: {
          prompt: [
            oneToolMessage.prompt[0]!,
            { role: 'system', content: 'second message' },
          ],
        },
        limits: { ...defaultLimits, maxMessagesPerCall: 1 },
      },
      {
        params: toolParams([prettyJson, prettyJson]),
        limits: { ...defaultLimits, maxToolPartsPerCall: 1 },
      },
      {
        params: toolParams([prettyJson, prettyJson]),
        limits: {
          ...defaultLimits,
          maxToolPartsPerCall: 2,
          maxCandidatesPerCall: 1,
        },
      },
    ];

    for (const testCase of cases) {
      const prepare = vi.fn<TextRequestPreparer['prepare']>(async (request) =>
        appliedResult(request),
      );
      const events: PreparationDecisionEvent[] = [];
      const adapter = middleware(
        { prepare },
        {
          limits: testCase.limits,
          onDecision(event) {
            events.push(event);
          },
        },
      );

      const transformed = await adapter.transformParams!({
        type: 'generate',
        params: testCase.params,
        model: createModel({}),
      });

      expect(transformed).toBe(testCase.params);
      expect(prepare).not.toHaveBeenCalled();
      expect(events).toEqual([]);
    }
  });

  it('fails open within the deadline when a preparer never settles', async () => {
    const events: PreparationDecisionEvent[] = [];
    const prepare = vi.fn<TextRequestPreparer['prepare']>(
      async () => new Promise<TextPreparationResult>(() => {}),
    );
    const adapter = middleware(
      { prepare },
      {
        limits: { ...defaultLimits, preparationTimeoutMs: 20 },
        onDecision(event) {
          events.push(event);
        },
      },
    );
    const params = toolParams();
    const capture: { generate?: LanguageModelV4CallOptions } = {};
    const wrapped = wrapLanguageModel({
      model: createModel(capture),
      middleware: adapter,
    });
    const startedAt = Date.now();

    await wrapped.doGenerate(params);

    expect(capture.generate).toBe(params);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(events).toEqual([]);
  });

  it('ignores a result that resolves after the total deadline', async () => {
    let capturedRequest: TextPreparationRequest | undefined;
    let resolveLate!: (result: TextPreparationResult) => void;
    const lateResult = new Promise<TextPreparationResult>((resolve) => {
      resolveLate = resolve;
    });
    const events: PreparationDecisionEvent[] = [];
    const adapter = middleware(
      preparer((request) => {
        capturedRequest = request;
        return lateResult;
      }),
      {
        limits: { ...defaultLimits, preparationTimeoutMs: 20 },
        onDecision(event) {
          events.push(event);
        },
      },
    );
    const params = toolParams();

    const transformed = await adapter.transformParams!({
      type: 'generate',
      params,
      model: createModel({}),
    });
    expect(transformed).toBe(params);
    expect(events).toEqual([]);

    if (capturedRequest === undefined) {
      throw new TypeError('Expected the timed-out request to be captured');
    }
    resolveLate(appliedResult(capturedRequest));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual([]);
  });

  it('rolls back an applied candidate when a later candidate times out', async () => {
    let rejectLate!: (reason: unknown) => void;
    const lateRejection = new Promise<TextPreparationResult>(
      (_resolve, reject) => {
        rejectLate = reject;
      },
    );
    const prepare = vi.fn<TextRequestPreparer['prepare']>((request) =>
      request.id.endsWith('p0')
        ? Promise.resolve(appliedResult(request))
        : lateRejection,
    );
    const events: PreparationDecisionEvent[] = [];
    const adapter = middleware(
      { prepare },
      {
        limits: { ...defaultLimits, preparationTimeoutMs: 20 },
        onDecision(event) {
          events.push(event);
        },
      },
    );
    const params = toolParams([prettyJson, prettyJson]);

    const transformed = await adapter.transformParams!({
      type: 'generate',
      params,
      model: createModel({}),
    });

    expect(transformed).toBe(params);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(events).toEqual([]);
    expect(requireTextToolResult(params, 0, 0).output.value).toBe(prettyJson);

    rejectLate(new Error('late host rejection'));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual([]);
  });

  it('rolls back all candidates and all events on any preparation failure', async () => {
    const prepare = vi.fn<TextRequestPreparer['prepare']>(async (request) => {
      if (request.id.endsWith('p1')) {
        throw new Error('preparer unavailable');
      }
      return appliedResult(request);
    });
    const events: PreparationDecisionEvent[] = [];
    const adapter = middleware(
      { prepare },
      {
        onDecision(event) {
          events.push(event);
        },
      },
    );
    const params = toolParams([prettyJson, prettyJson]);

    const transformed = await adapter.transformParams!({
      type: 'generate',
      params,
      model: createModel({}),
    });

    expect(transformed).toBe(params);
    expect(requireTextToolResult(params, 0, 0).output.value).toBe(prettyJson);
    expect(events).toEqual([]);
  });

  it('rejects applied results without complete independently verifiable evidence', async () => {
    const events: PreparationDecisionEvent[] = [];
    const fakeApplied: TextPreparationResult = {
      content: canonicalJson,
      applied: true,
      selectedCodec: 'json-jcs',
      reasons: ['APPLIED'],
      promotionDigest,
      deploymentScopeDigest,
    };
    const adapter = middleware(
      preparer(async () => fakeApplied),
      {
        onDecision(event) {
          events.push(event);
        },
      },
    );
    const params = toolParams();

    const transformed = await adapter.transformParams!({
      type: 'generate',
      params,
      model: createModel({}),
    });

    expect(transformed).toBe(params);
    expect(events).toEqual([]);
  });

  it('binds proof metadata, digest, scope, and encoded bytes atomically', async () => {
    const params = toolParams();
    const mutations = [
      (valid: TextPreparationResult): TextPreparationResult => ({
        ...valid,
        deploymentScopeDigest: sha256('wrong-scope'),
      }),
      (valid: TextPreparationResult): TextPreparationResult => ({
        ...valid,
        proof: refinalizeProof({
          ...valid.proof!,
          segmentMetadataDigest: sha256('other'),
        }),
      }),
      (valid: TextPreparationResult): TextPreparationResult => ({
        ...valid,
        proof: refinalizeProof({
          ...valid.proof!,
          encoded: { ...valid.proof!.encoded, byteLength: 1 },
        }),
      }),
    ];

    for (const mutate of mutations) {
      const adapter = middleware(
        preparer(async (request) => mutate(appliedResult(request))),
      );
      const transformed = await adapter.transformParams!({
        type: 'generate',
        params,
        model: createModel({}),
      });
      expect(transformed).toBe(params);
    }
  });

  it('snapshots getter-backed preparer evidence exactly once before use', async () => {
    const reads = new Map<PropertyKey, number>();
    const adapter = middleware(
      preparer(async (request) => {
        const valid = appliedResult(request);
        const getterBacked = Object.create(null) as Record<
          PropertyKey,
          unknown
        >;
        for (const key of [
          'content',
          'applied',
          'selectedCodec',
          'reasons',
          'proof',
          'promotionDigest',
          'deploymentScopeDigest',
        ] as const) {
          Object.defineProperty(getterBacked, key, {
            enumerable: true,
            configurable: true,
            get() {
              const count = (reads.get(key) ?? 0) + 1;
              reads.set(key, count);
              if (count !== 1) {
                throw new Error(`TOCTOU reread: ${key}`);
              }
              return valid[key];
            },
          });
        }
        return new Proxy(getterBacked, {
          get(target, property, receiver) {
            return Reflect.get(target, property, receiver);
          },
        }) as unknown as TextPreparationResult;
      }),
    );
    const params = toolParams();

    const transformed = await adapter.transformParams!({
      type: 'generate',
      params,
      model: createModel({}),
    });

    expect(requireTextToolResult(transformed, 0, 0).output.value).toBe(
      canonicalJson,
    );
    expect([...reads.values()]).toEqual([1, 1, 1, 1, 1, 1, 1]);
  });

  it('snapshots selected output before await and never rereads its getter', async () => {
    let valueReads = 0;
    let releasePreparation!: () => void;
    const preparationStarted = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    const output = {
      type: 'text' as const,
      get value() {
        valueReads += 1;
        if (valueReads !== 1) {
          throw new Error('live output reread after await');
        }
        return prettyJson;
      },
    };
    const params: LanguageModelV4CallOptions = {
      prompt: [
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'getter-output',
              toolName: 'lookup',
              output,
            },
          ],
        },
      ],
    };
    const adapter = middleware(
      preparer(async (request) => {
        await preparationStarted;
        return appliedResult(request);
      }),
    );

    const pending = adapter.transformParams!({
      type: 'generate',
      params,
      model: createModel({}),
    });
    releasePreparation();
    const transformed = await pending;

    expect(valueReads).toBe(1);
    expect(requireTextToolResult(transformed, 0, 0).output.value).toBe(
      canonicalJson,
    );
  });

  it('snapshots every candidate before awaiting preparation of the first', async () => {
    let reportFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      reportFirstStarted = resolve;
    });
    let releaseFirst!: () => void;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const preparedContents: string[] = [];
    const secondOutput = {
      type: 'text' as const,
      value: prettyJson,
    };
    const params: LanguageModelV4CallOptions = {
      prompt: [
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'first',
              toolName: 'lookup',
              output: { type: 'text', value: prettyJson },
            },
            {
              type: 'tool-result',
              toolCallId: 'second',
              toolName: 'lookup',
              output: secondOutput,
            },
          ],
        },
      ],
    };
    const adapter = middleware(
      preparer(async (request) => {
        preparedContents.push(request.content);
        if (request.id.endsWith('p0')) {
          reportFirstStarted();
          await firstCanFinish;
          return appliedResult(request);
        }
        return bypassResult(request.content);
      }),
    );

    const pending = adapter.transformParams!({
      type: 'generate',
      params,
      model: createModel({}),
    });
    await firstStarted;
    secondOutput.value = '{"mutated":"after-first-await"}';
    releaseFirst();
    const transformed = await pending;

    expect(preparedContents).toEqual([prettyJson, prettyJson]);
    expect(requireTextToolResult(transformed, 0, 0).output.value).toBe(
      canonicalJson,
    );
    expect(requireTextToolResult(transformed, 0, 1).output.value).toBe(
      prettyJson,
    );
  });

  it('invokes observers in order without awaiting never-settled or rejected promises', async () => {
    const observed: string[] = [];
    const adapter = middleware(
      preparer(async (request) => appliedResult(request)),
      {
        onDecision(event) {
          observed.push(event.id);
          return event.partIndex === 0
            ? new Promise<void>(() => {})
            : Promise.reject(new Error('observer unavailable'));
        },
      },
    );
    const params = toolParams([prettyJson, prettyJson]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), 100);
    });

    const outcome = await Promise.race([
      adapter.transformParams!({
        type: 'generate',
        params,
        model: createModel({}),
      }),
      timeout,
    ]);
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    await Promise.resolve();

    expect(outcome).not.toBe('timeout');
    expect(observed).toEqual([
      'ai-sdk-tool-result-m0-p0',
      'ai-sdk-tool-result-m0-p1',
    ]);
  });

  it('uses the same verified path for streaming', async () => {
    const adapter = middleware(
      preparer(async (request) => appliedResult(request)),
    );
    const capture: { stream?: LanguageModelV4CallOptions } = {};
    const wrapped = wrapLanguageModel({
      model: createModel(capture),
      middleware: adapter,
    });

    await wrapped.doStream(toolParams());

    expect(requireTextToolResult(capture.stream!, 0, 0).output.value).toBe(
      canonicalJson,
    );
  });
});
