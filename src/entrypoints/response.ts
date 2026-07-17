import type { Command } from 'commander';

import { HeuristicTokenizer } from '../adapters/heuristic-tokenizer.js';
import { canonicalJson, toJsonValue } from '../domain/canonical-json.js';
import { COMPACT_RESPONSE_LIMIT_CAPS } from '../response/schema.js';
import {
  MAX_COMPACT_RESPONSE_CONTRACT_BYTES,
  createChangeReportMarkdownRenderer,
  createCompactResponseRuntime,
  digestCompactResponseContract,
  parseCompactResponseContract,
  serializeCompactResponseWitness,
} from '../response/index.js';
import {
  readBoundedRegularFile,
  readInputBytes,
  writeNewPrivateFile,
} from './io.js';

const MAX_COMPACT_RESPONSE_WITNESS_BYTES = 64 * 1024;

export function addCompactResponseCommands(
  program: Command,
  setVerdictExitCode: (code: number) => void,
): void {
  const response = program
    .command('response')
    .description(
      'Render and verify schema-bound compact model output with local content-free witnesses.',
    );

  const contract = response
    .command('contract')
    .description('Inspect strict Compact Response contracts.');

  contract
    .command('inspect')
    .description(
      'Validate one contract and emit a content-free binding receipt.',
    )
    .requiredOption(
      '--contract <file>',
      'Strict Compact Response contract JSON',
    )
    .option('--json', 'Emit stable JSON (default)')
    .action(async (options: { contract: string }) => {
      const parsed = await loadContract(options.contract);
      const renderer = createChangeReportMarkdownRenderer();
      writeJson({
        schema: 'semwitness.dev/compact-response-contract-inspection/v1alpha1',
        valid: true,
        contractId: parsed.id,
        contractVersion: parsed.version,
        contractDigest: digestCompactResponseContract(parsed),
        candidateMediaType: parsed.candidate.mediaType,
        renderer: parsed.renderer,
        rendererAvailable:
          parsed.renderer.id === renderer.id &&
          parsed.renderer.version === renderer.version &&
          parsed.renderer.artifactDigest === renderer.artifactDigest &&
          parsed.renderer.outputMediaType === renderer.outputMediaType &&
          renderer.locales.includes(parsed.renderer.locale),
        limits: parsed.limits,
        billedOutputSavings: null,
        universalSemanticEquivalence: false,
      });
    });

  response
    .command('render')
    .description(
      'Render one strict candidate into a new private file and emit its exact witness on stdout.',
    )
    .requiredOption(
      '--contract <file>',
      'Strict Compact Response contract JSON',
    )
    .requiredOption(
      '--candidate <file|->',
      'Strict candidate JSON file, or bounded stdin',
    )
    .requiredOption(
      '--out <file>',
      'New rendered output file; existing files are refused',
    )
    .option('--json', 'Emit the exact canonical witness (default)')
    .action(
      async (options: { contract: string; candidate: string; out: string }) => {
        const parsed = await loadContract(options.contract);
        const candidate = await readInputBytes(
          options.candidate,
          COMPACT_RESPONSE_LIMIT_CAPS.maxCandidateBytes,
        );
        const result = await defaultRuntime().render({
          contract: parsed,
          candidate,
        });
        if (result.status !== 'rendered') {
          writeJson({
            schema: 'semwitness.dev/compact-response-render-result/v1alpha1',
            status: result.status,
            reasons: result.reasons,
            outputWritten: false,
            billedOutputSavings: null,
          });
          setVerdictExitCode(2);
          return;
        }
        await writeNewPrivateFile(options.out, result.output);
        process.stdout.write(serializeCompactResponseWitness(result.witness));
      },
    );

  response
    .command('verify')
    .description(
      'Rerender and bind exact contract, candidate, output, witness, renderer and tokenizer evidence.',
    )
    .requiredOption(
      '--contract <file>',
      'Strict Compact Response contract JSON',
    )
    .requiredOption(
      '--candidate <file|->',
      'Exact candidate JSON file, or bounded stdin',
    )
    .requiredOption('--rendered <file>', 'Exact rendered output file')
    .requiredOption(
      '--witness <file>',
      'Exact canonical Compact Response witness',
    )
    .option('--json', 'Emit stable JSON (default)')
    .action(
      async (options: {
        contract: string;
        candidate: string;
        rendered: string;
        witness: string;
      }) => {
        const parsed = await loadContract(options.contract);
        const [candidate, rendered, witness] = await Promise.all([
          readInputBytes(
            options.candidate,
            COMPACT_RESPONSE_LIMIT_CAPS.maxCandidateBytes,
          ),
          readBoundedRegularFile(
            options.rendered,
            COMPACT_RESPONSE_LIMIT_CAPS.maxRenderedBytes,
          ),
          readBoundedRegularFile(
            options.witness,
            MAX_COMPACT_RESPONSE_WITNESS_BYTES,
          ),
        ]);
        const verification = await defaultRuntime().verify({
          contract: parsed,
          candidate,
          rendered,
          witness,
        });
        writeVerification(parsed, verification);
        if (!verification.bound) setVerdictExitCode(2);
      },
    );

  response
    .command('replay')
    .description(
      'Rerender a candidate and compare the complete deterministic witness without writing output.',
    )
    .requiredOption(
      '--contract <file>',
      'Strict Compact Response contract JSON',
    )
    .requiredOption(
      '--candidate <file|->',
      'Exact candidate JSON file, or bounded stdin',
    )
    .requiredOption(
      '--witness <file>',
      'Exact canonical Compact Response witness',
    )
    .option('--json', 'Emit stable JSON (default)')
    .action(
      async (options: {
        contract: string;
        candidate: string;
        witness: string;
      }) => {
        const parsed = await loadContract(options.contract);
        const [candidate, witness] = await Promise.all([
          readInputBytes(
            options.candidate,
            COMPACT_RESPONSE_LIMIT_CAPS.maxCandidateBytes,
          ),
          readBoundedRegularFile(
            options.witness,
            MAX_COMPACT_RESPONSE_WITNESS_BYTES,
          ),
        ]);
        const verification = await defaultRuntime().replay({
          contract: parsed,
          candidate,
          witness,
        });
        writeVerification(parsed, verification);
        if (!verification.bound) setVerdictExitCode(2);
      },
    );
}

async function loadContract(path: string) {
  return parseCompactResponseContract(
    await readBoundedRegularFile(path, MAX_COMPACT_RESPONSE_CONTRACT_BYTES),
  );
}

function defaultRuntime() {
  return createCompactResponseRuntime({
    renderers: [createChangeReportMarkdownRenderer()],
    tokenizer: new HeuristicTokenizer(),
  });
}

function writeVerification(
  contract: ReturnType<typeof parseCompactResponseContract>,
  verification: {
    readonly bound: boolean;
    readonly reasons: readonly string[];
  },
): void {
  writeJson({
    schema: 'semwitness.dev/compact-response-verification/v1alpha1',
    contractDigest: digestCompactResponseContract(contract),
    authentication: 'none',
    servingAuthority: 'none',
    billedOutputSavings: null,
    universalSemanticEquivalence: false,
    ...verification,
  });
}

function writeJson(value: unknown): void {
  process.stdout.write(`${canonicalJson(toJsonValue(value))}\n`);
}
