import { readFile } from 'node:fs/promises';

import type {
  LanguageModelV4GenerateResult,
  LanguageModelV4Usage,
} from '@ai-sdk/provider';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, type FinishReason, type LanguageModelUsage } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';

import {
  CompactResponseOutputRetryRequiredError,
  createCompactResponseOutput,
  requireCompactResponseOutput,
} from '../src/ai-sdk/index.js';
import {
  createChangeReportMarkdownRenderer,
  createCompactResponseWitness,
  createCompactResponseRuntime,
  parseCompactResponseContract,
  serializeCompactResponseWitness,
  type CompactResponseContract,
} from '../src/response/index.js';

const contractUrl = new URL(
  '../examples/compact-response/change-report.contract.json',
  import.meta.url,
);
const candidateUrl = new URL(
  '../examples/compact-response/change-report.candidate.json',
  import.meta.url,
);

async function fixture() {
  const [contractSource, candidate] = await Promise.all([
    readFile(contractUrl, 'utf8'),
    readFile(candidateUrl, 'utf8'),
  ]);
  return {
    contractSource,
    candidate,
    contract: parseCompactResponseContract(contractSource),
  };
}

function runtime() {
  return createCompactResponseRuntime({
    renderers: [createChangeReportMarkdownRenderer()],
  });
}

const providerUsage: LanguageModelV4Usage = {
  inputTokens: {
    total: 120,
    noCache: 80,
    cacheRead: 40,
    cacheWrite: undefined,
  },
  outputTokens: { total: 32, text: 30, reasoning: 2 },
};

function generationResult(
  candidate: string,
  finishReason: LanguageModelV4GenerateResult['finishReason'] = {
    unified: 'stop',
    raw: 'stop',
  },
): LanguageModelV4GenerateResult {
  return {
    content: [{ type: 'text', text: candidate }],
    finishReason,
    usage: providerUsage,
    response: {
      id: 'response-compact-1',
      modelId: 'compact-model-1',
      timestamp: new Date('2026-07-19T08:00:00.000Z'),
    },
    warnings: [],
  };
}

const normalizedUsage: LanguageModelUsage = {
  inputTokens: 120,
  inputTokenDetails: {
    noCacheTokens: 80,
    cacheReadTokens: 40,
    cacheWriteTokens: undefined,
  },
  outputTokens: 32,
  outputTokenDetails: { textTokens: 30, reasoningTokens: 2 },
  totalTokens: 152,
};

function parserContext(finishReason: FinishReason = 'stop') {
  return {
    response: {
      id: 'response-compact-1',
      modelId: 'compact-model-1',
      timestamp: new Date('2026-07-19T08:00:00.000Z'),
    },
    usage: normalizedUsage,
    finishReason,
  };
}

describe('Compact Response AI SDK output', () => {
  it('asks the provider for draft-07 JSON and renders only the complete candidate', async () => {
    const { contract, candidate } = await fixture();
    const output = createCompactResponseOutput({
      contract,
      runtime: runtime(),
      name: 'agent_change_report',
      description:
        'Return the compact change-report fields selected by the host.',
    });
    const responseFormat = await output.responseFormat;
    expect(responseFormat).toMatchObject({
      type: 'json',
      name: 'agent_change_report',
      schema: {
        type: 'object',
        additionalProperties: false,
      },
    });

    const schema =
      responseFormat?.type === 'json' ? responseFormat.schema : undefined;
    const schemaObject = schema as {
      properties: {
        c: { items: { items: unknown; additionalItems: boolean } };
      };
    };
    expect(schemaObject.properties.c.items.items).toHaveLength(3);
    expect(schemaObject.properties.c.items.additionalItems).toBe(false);
    expect(JSON.stringify(schema)).not.toContain('prefixItems');

    const model = new MockLanguageModelV4({
      provider: 'semwitness-test',
      modelId: 'compact-model-1',
      doGenerate: generationResult(candidate),
    });
    const generated = await generateText({
      model,
      output,
      prompt: 'Produce the compact change report.',
    });
    const verified = requireCompactResponseOutput({
      read: () => generated.output,
      warnings: generated.warnings,
    });

    const markdown = new TextDecoder().decode(verified.rendered);
    expect(markdown).toContain('# Change report');
    expect(markdown).toContain('273 tests');
    expect(verified.mediaType).toBe('text/markdown');
    expect(verified.witness.billedOutputSavings).toBeNull();
    expect(verified.providerObservation).toMatchObject({
      schema: 'semwitness.dev/compact-response-ai-sdk-observation/v1alpha1',
      artifact: {
        id: 'semwitness-compact-response-output',
        version: '1',
      },
      contractDigest: verified.witness.contractDigest,
      witnessDigest: verified.witness.witnessDigest,
      finishReason: 'stop',
      response: {
        idDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        idCodeUnits: 'response-compact-1'.length,
        modelIdDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        modelIdCodeUnits: 'compact-model-1'.length,
        timestamp: '2026-07-19T08:00:00.000Z',
      },
      finalStepUsage: normalizedUsage,
      billedOutputSavings: null,
      observationDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });
    expect(model.doGenerateCalls[0]?.responseFormat).toEqual(responseFormat);

    const replay = await runtime().render({ contract, candidate });
    expect(replay.status).toBe('rendered');
    if (replay.status !== 'rendered') return;
    expect(serializeCompactResponseWitness(verified.witness)).toBe(
      serializeCompactResponseWitness(replay.witness),
    );
  });

  it('converts every bounded schema shape without widening closed tuples or objects', async () => {
    const { contractSource } = await fixture();
    const wire = JSON.parse(contractSource) as {
      candidate: { schema: Record<string, unknown> };
    };
    wire.candidate.schema = {
      type: 'object',
      properties: {
        n: { type: 'number', minimum: -1, maximum: 2 },
        i: { type: 'integer', enum: [1, 2] },
        b: { type: 'boolean', enum: [true] },
        z: { type: 'null', enum: [null] },
        a: {
          type: 'array',
          items: { type: 'string', maxLength: 4 },
          minItems: 1,
          maxItems: 2,
        },
      },
      required: ['n', 'i', 'b', 'z', 'a'],
      additionalProperties: false,
    };
    const contract = parseCompactResponseContract(JSON.stringify(wire));
    const format = await createCompactResponseOutput({
      contract,
      runtime: runtime(),
    }).responseFormat;

    expect(format).toMatchObject({
      type: 'json',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          n: { type: 'number', minimum: -1, maximum: 2 },
          i: { type: 'integer', enum: [1, 2] },
          b: { type: 'boolean', enum: [true] },
          z: { type: 'null', enum: [null] },
          a: {
            type: 'array',
            items: { type: 'string', maxLength: 4 },
            minItems: 1,
            maxItems: 2,
          },
        },
      },
    });
  });

  it('fails closed with content-free typed reasons', async () => {
    const { contract, candidate } = await fixture();
    const output = createCompactResponseOutput({
      contract,
      runtime: runtime(),
    });

    await expect(
      output.parseCompleteOutput({ text: candidate }, parserContext('length')),
    ).rejects.toEqual(
      expect.objectContaining({
        name: 'CompactResponseOutputRetryRequiredError',
        reasons: ['MODEL_FINISH_REASON_REJECTED'],
      }),
    );

    const secret = 'private-candidate-value-that-must-not-escape';
    let error: unknown;
    try {
      await output.parseCompleteOutput(
        { text: `{"s":"ok","m":"${secret}"}` },
        parserContext(),
      );
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CompactResponseOutputRetryRequiredError);
    expect(error).toMatchObject({ reasons: ['CANDIDATE_SCHEMA_MISMATCH'] });
    expect(String(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
    expect((error as Error).cause).toBeUndefined();

    const model = new MockLanguageModelV4({
      provider: 'semwitness-test',
      modelId: 'compact-model-1',
      doGenerate: generationResult(`{"s":"ok","m":"${secret}","c":[],"v":[]}`),
    });
    let generatedError: unknown;
    try {
      await generateText({
        model,
        output,
        prompt: 'Produce the compact change report.',
      });
    } catch (caught) {
      generatedError = caught;
    }
    expect(generatedError).toBeInstanceOf(
      CompactResponseOutputRetryRequiredError,
    );
    expect(generatedError).toMatchObject({
      reasons: ['CANDIDATE_SCHEMA_MISMATCH'],
    });
    expect(String(generatedError)).not.toContain(secret);
    expect(JSON.stringify(generatedError)).not.toContain(secret);
    expect((generatedError as Error).cause).toBeUndefined();

    await expect(
      output.parseCompleteOutput(
        { text: 'x'.repeat(contract.limits.maxCandidateBytes + 1) },
        parserContext(),
      ),
    ).rejects.toMatchObject({ reasons: ['CANDIDATE_LIMIT_EXCEEDED'] });
  });

  it('turns AI SDK non-stop output omission into a typed retry boundary', async () => {
    const { contract, candidate } = await fixture();
    const output = createCompactResponseOutput({
      contract,
      runtime: runtime(),
    });
    const model = new MockLanguageModelV4({
      provider: 'semwitness-test',
      modelId: 'compact-model-1',
      doGenerate: generationResult(candidate, {
        unified: 'length',
        raw: 'length',
      }),
    });
    const generated = await generateText({
      model,
      output,
      prompt: 'Produce the compact change report.',
    });

    expect(() =>
      requireCompactResponseOutput({
        read: () => generated.output,
        warnings: generated.warnings,
      }),
    ).toThrow(
      expect.objectContaining({
        name: 'CompactResponseOutputRetryRequiredError',
        reasons: ['MODEL_FINISH_REASON_REJECTED'],
      }),
    );
  });

  it('requires provider structured-output support instead of accepting schema fallback', async () => {
    const { contract, candidate } = await fixture();

    async function generate(supportsStructuredOutputs: boolean) {
      let requestBody: unknown;
      const provider = createOpenAICompatible({
        name: 'semwitness-test',
        baseURL: 'https://provider.invalid/v1',
        apiKey: 'test-key',
        supportsStructuredOutputs,
        fetch: async (_url, init) => {
          requestBody = JSON.parse(String(init?.body));
          return Response.json({
            id: 'response-compact-1',
            created: 1_784_428_800,
            model: 'compact-model-1',
            choices: [
              {
                message: { role: 'assistant', content: candidate },
                finish_reason: 'stop',
              },
            ],
            usage: {
              prompt_tokens: 120,
              completion_tokens: 32,
              total_tokens: 152,
            },
          });
        },
      });
      const result = await generateText({
        model: provider.chatModel('compact-model-1'),
        output: createCompactResponseOutput({
          contract,
          runtime: runtime(),
          name: 'agent_change_report',
          description: 'Return the compact fields selected by the host.',
        }),
        prompt: 'Produce the compact change report.',
      });
      return { requestBody, result };
    }

    const fallback = await generate(false);
    expect(fallback.requestBody).toMatchObject({
      response_format: { type: 'json_object' },
    });
    expect(() =>
      requireCompactResponseOutput({
        read: () => fallback.result.output,
        warnings: fallback.result.warnings,
      }),
    ).toThrow(
      expect.objectContaining({ reasons: ['PROVIDER_SCHEMA_UNSUPPORTED'] }),
    );

    const structured = await generate(true);
    const structuredBody = structured.requestBody as {
      response_format: {
        type: string;
        json_schema: {
          description: string;
          schema: {
            properties: {
              c: { items: { items: unknown[]; additionalItems: boolean } };
            };
          };
        };
      };
    };
    expect(structuredBody.response_format.type).toBe('json_schema');
    expect(structuredBody.response_format.json_schema.description).toBe(
      'Return the compact fields selected by the host.',
    );
    expect(
      structuredBody.response_format.json_schema.schema.properties.c.items
        .items,
    ).toHaveLength(3);
    expect(
      structuredBody.response_format.json_schema.schema.properties.c.items
        .additionalItems,
    ).toBe(false);
    expect(
      requireCompactResponseOutput({
        read: () => structured.result.output,
        warnings: structured.result.warnings,
      }).mediaType,
    ).toBe('text/markdown');
  });

  it('snapshots the contract, rejects invalid provider context and emits no partial output', async () => {
    const { contractSource, candidate } = await fixture();
    const mutable = JSON.parse(contractSource) as CompactResponseContract;
    const output = createCompactResponseOutput({
      contract: mutable,
      runtime: runtime(),
    });
    (mutable.renderer as { outputMediaType: string }).outputMediaType =
      'text/plain';

    const complete = await output.parseCompleteOutput(
      { text: candidate },
      parserContext(),
    );
    expect(complete.mediaType).toBe('text/markdown');
    expect(
      await output.parsePartialOutput({ text: candidate }),
    ).toBeUndefined();
    expect(output.createElementStreamTransform()).toBeUndefined();

    expect(() =>
      requireCompactResponseOutput({
        read: () => complete,
        warnings: [
          {
            type: 'unsupported',
            feature: 'responseFormat',
            details: 'private provider detail',
          },
        ],
      }),
    ).toThrow(
      expect.objectContaining({ reasons: ['PROVIDER_SCHEMA_UNSUPPORTED'] }),
    );

    const invalidUsage = {
      ...parserContext(),
      usage: { ...normalizedUsage, outputTokens: -1 },
    };
    await expect(
      output.parseCompleteOutput({ text: candidate }, invalidUsage),
    ).rejects.toMatchObject({ reasons: ['AI_SDK_CONTEXT_INVALID'] });
  });

  it('maps unexpected runtime failures to a bounded retry signal', async () => {
    const { contract, candidate } = await fixture();
    const output = createCompactResponseOutput({
      contract,
      runtime: {
        async render() {
          throw new Error('private runtime detail');
        },
      },
    });

    await expect(
      output.parseCompleteOutput({ text: candidate }, parserContext()),
    ).rejects.toMatchObject({ reasons: ['RENDER_ERROR'] });
  });

  it('rejects a runtime witness with a forged canonical candidate digest', async () => {
    const { contract, candidate } = await fixture();
    const legitimate = await runtime().render({ contract, candidate });
    expect(legitimate.status).toBe('rendered');
    if (legitimate.status !== 'rendered') return;
    const witness = createCompactResponseWitness({
      contractDigest: legitimate.witness.contractDigest,
      candidate: {
        ...legitimate.witness.candidate,
        canonicalDigest: `sha256:${'0'.repeat(64)}`,
      },
      renderer: legitimate.witness.renderer,
      rendered: legitimate.witness.rendered,
    });

    const output = createCompactResponseOutput({
      contract,
      runtime: {
        async render() {
          return {
            status: 'rendered',
            output: legitimate.output,
            witness,
          } as never;
        },
      },
    });
    await expect(
      output.parseCompleteOutput({ text: candidate }, parserContext()),
    ).rejects.toMatchObject({ reasons: ['WITNESS_MISMATCH'] });
  });

  it('classifies unexpected host reader errors as invalid AI SDK context', () => {
    expect(() =>
      requireCompactResponseOutput({
        read() {
          throw new Error('private host failure');
        },
        warnings: [],
      }),
    ).toThrow(expect.objectContaining({ reasons: ['AI_SDK_CONTEXT_INVALID'] }));
  });

  it('snapshots hostile runtime reasons and provider usage exactly once', async () => {
    const { contract, candidate } = await fixture();
    let reasonReads = 0;
    const hostileRetry = new Proxy(Object.create(null) as object, {
      get(_target, property) {
        if (property === 'status') return 'retry-required';
        if (property === 'reasons') {
          reasonReads += 1;
          return reasonReads === 1
            ? ['RENDER_ERROR']
            : ['private-runtime-secret'];
        }
        return undefined;
      },
    });
    const retryOutput = createCompactResponseOutput({
      contract,
      runtime: {
        async render() {
          return hostileRetry as never;
        },
      },
    });
    await expect(
      retryOutput.parseCompleteOutput({ text: candidate }, parserContext()),
    ).rejects.toMatchObject({ reasons: ['RENDER_ERROR'] });
    expect(reasonReads).toBe(1);

    let outputTokenReads = 0;
    const usage = {
      ...normalizedUsage,
      get outputTokens() {
        outputTokenReads += 1;
        return outputTokenReads === 1 ? 2 : -999;
      },
    } as LanguageModelUsage;
    const rendered = await createCompactResponseOutput({
      contract,
      runtime: runtime(),
    }).parseCompleteOutput({ text: candidate }, { ...parserContext(), usage });
    expect(rendered.providerObservation.finalStepUsage.outputTokens).toBe(2);
    expect(outputTokenReads).toBe(1);
  });

  it('digests provider-controlled identifiers instead of copying their content', async () => {
    const { contract, candidate } = await fixture();
    const secret = 'raw-candidate-in-response-id';
    const rendered = await createCompactResponseOutput({
      contract,
      runtime: runtime(),
    }).parseCompleteOutput(
      { text: candidate },
      {
        ...parserContext(),
        response: { ...parserContext().response, id: secret, modelId: secret },
      },
    );
    const serialized = JSON.stringify(rendered.providerObservation);
    expect(serialized).not.toContain(secret);
    expect(rendered.providerObservation.response.idCodeUnits).toBe(
      secret.length,
    );
    expect(rendered.providerObservation.witnessDigest).toBe(
      rendered.witness.witnessDigest,
    );
  });
});
