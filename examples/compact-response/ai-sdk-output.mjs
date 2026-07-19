import { readFile } from 'node:fs/promises';

import { generateText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import {
  createCompactResponseOutput,
  requireCompactResponseOutput,
} from 'semwitness/ai-sdk';
import {
  createChangeReportMarkdownRenderer,
  createCompactResponseRuntime,
  parseCompactResponseContract,
} from 'semwitness/response';

const [contractSource, candidate] = await Promise.all([
  readFile(new URL('./change-report.contract.json', import.meta.url), 'utf8'),
  readFile(new URL('./change-report.candidate.json', import.meta.url), 'utf8'),
]);

const contract = parseCompactResponseContract(contractSource);
const output = createCompactResponseOutput({
  contract,
  runtime: createCompactResponseRuntime({
    renderers: [createChangeReportMarkdownRenderer()],
  }),
  name: 'agent_change_report',
  description:
    'Return s=status, m=summary, c=changes, v=verification, and w=warnings.',
});

// This deterministic model keeps the example offline. Replace it with any AI
// SDK v4 provider model. Qualify structured-schema support for the exact live
// provider/model before replacing this offline fixture.
const model = new MockLanguageModelV4({
  provider: 'offline-example',
  modelId: 'compact-response-fixture',
  doGenerate: {
    content: [{ type: 'text', text: candidate }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: {
      inputTokens: {
        total: 96,
        noCache: 96,
        cacheRead: undefined,
        cacheWrite: undefined,
      },
      outputTokens: { total: 42, text: 42, reasoning: undefined },
    },
    response: {
      id: 'offline-compact-response',
      modelId: 'compact-response-fixture',
      timestamp: new Date('2026-07-19T00:00:00.000Z'),
    },
    warnings: [],
  },
});

const result = await generateText({
  model,
  output,
  prompt: 'Summarize the completed engineering change using the bound fields.',
});
const verified = requireCompactResponseOutput({
  read: () => result.output,
  warnings: result.warnings,
});

// Only the required output has passed the bound local renderer. Do not publish
// any other result, callback, telemetry, message, or stream surface: AI SDK can
// retain the provider's compact JSON separately.
process.stdout.write(new TextDecoder().decode(verified.rendered));
process.stderr.write(
  `${JSON.stringify(verified.providerObservation, null, 2)}\n`,
);
