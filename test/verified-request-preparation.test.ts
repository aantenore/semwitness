import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamPart,
} from '@ai-sdk/provider';
import { wrapLanguageModel } from 'ai';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createSemWitnessLanguageModelMiddleware,
  digestAiSdkDeploymentScope,
  type AiSdkDeploymentScope,
  type ToolResultSelector,
} from '../src/ai-sdk/index.js';
import { createSemWitness } from '../src/composition-root.js';
import { canonicalJson, toJsonValue } from '../src/domain/canonical-json.js';
import { sha256 } from '../src/domain/hash.js';
import { digestPolicy } from '../src/domain/policy.js';
import {
  HOST_PREPARER_ARTIFACT,
  createVerifiedTextRequestPreparer,
  type HostPromotionManifest,
} from '../src/host/index.js';
import { DeterministicByteTokenizer, makePolicy } from './helpers.js';

const temporaryRoots = new Set<string>();

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'semwitness-ai-sdk-test-'));
  temporaryRoots.add(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    [...temporaryRoots].map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
  temporaryRoots.clear();
});

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

function captureModel(
  identity: Pick<AiSdkDeploymentScope, 'provider' | 'modelId'>,
  capture: { generate?: LanguageModelV4CallOptions },
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
    async doStream() {
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

describe('verified AI SDK request preparation', () => {
  it('delivers only a real host-verified candidate to the wrapped model', async () => {
    const policy = makePolicy({
      mode: 'apply-verified',
      selection: {
        includeDecoderLegendTokens: false,
        minTokenSavings: 1,
        minSavingsRatioPpm: 0,
        allowHeuristicApply: false,
      },
    });
    const tokenizer = new DeterministicByteTokenizer(
      policy.tokenizerId,
      'exact',
    );
    const core = createSemWitness({
      storeRoot: await temporaryRoot(),
      policy,
      tokenizer,
    });
    const scope = Object.freeze({
      provider: 'semwitness-integration',
      modelId: 'capture-v1',
      promptContractDigest: sha256('integration-prompt-contract-v1'),
      toolContractDigest: sha256('integration-tool-contract-v1'),
    }) satisfies AiSdkDeploymentScope;
    const selectors = Object.freeze([
      Object.freeze({
        toolNames: Object.freeze(['lookup']),
        trust: 'workspace-trusted',
      }),
    ]) satisfies readonly ToolResultSelector[];
    const deploymentScopeDigest = digestAiSdkDeploymentScope(scope, selectors);
    const promotion: HostPromotionManifest = {
      schema: 'semwitness.dev/host-promotion/v1alpha1',
      artifact: { ...HOST_PREPARER_ARTIFACT },
      policyDigest: digestPolicy(policy),
      deploymentScopeDigest,
      tokenizer: {
        id: tokenizer.id,
        fingerprint: tokenizer.fingerprint,
      },
      codecs: [{ id: 'json-jcs', version: '1' }],
      evaluation: {
        corpusDigest: sha256('integration-held-out-corpus-v1'),
        reportDigest: sha256('integration-held-out-report-v1'),
        split: 'held-out',
        unsafeAccepts: 0,
        taskQualityRegressions: 0,
        medianNetSavingsRatioPpm: 250_000,
      },
    };
    const adapter = createSemWitnessLanguageModelMiddleware({
      preparer: createVerifiedTextRequestPreparer(core, policy, promotion),
      scope,
      limits: {
        maxMessagesPerCall: 64,
        maxToolPartsPerCall: 256,
        maxCandidatesPerCall: 128,
        preparationTimeoutMs: 1_000,
      },
      selectors,
    });
    const capture: { generate?: LanguageModelV4CallOptions } = {};
    const wrapped = wrapLanguageModel({
      model: captureModel(scope, capture),
      middleware: adapter,
    });
    const original = `{
  "records": [
    { "id": 1, "state": "ready", "enabled": true },
    { "id": 2, "state": "ready", "enabled": true },
    { "id": 3, "state": "ready", "enabled": true }
  ],
  "owner": "integration-test"
}`;
    const params: LanguageModelV4CallOptions = {
      prompt: [
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'integration-call',
              toolName: 'lookup',
              output: { type: 'text', value: original },
            },
          ],
        },
      ],
    };

    await wrapped.doGenerate(params);

    const message = capture.generate?.prompt[0];
    if (message?.role !== 'tool') {
      throw new TypeError('Expected a captured tool message');
    }
    const part = message.content[0];
    if (part?.type !== 'tool-result' || part.output.type !== 'text') {
      throw new TypeError('Expected a captured text tool result');
    }
    expect(part.output.value).toBe(
      canonicalJson(toJsonValue(JSON.parse(original))),
    );
    expect(part.output.value.length).toBeLessThan(original.length);
    expect(params.prompt[0]).not.toBe(message);
  });
});
