import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  CompactResponseError,
  createChangeReportMarkdownRenderer,
  createCompactResponseRuntime,
  parseCompactResponseContract,
  parseCompactResponseWitness,
  serializeCompactResponseWitness,
} from '../src/response/index.js';

const contractUrl = new URL(
  '../examples/compact-response/change-report.contract.json',
  import.meta.url,
);
const candidateUrl = new URL(
  '../examples/compact-response/change-report.candidate.json',
  import.meta.url,
);

async function renderedFixture() {
  const [contractSource, candidate] = await Promise.all([
    readFile(contractUrl, 'utf8'),
    readFile(candidateUrl, 'utf8'),
  ]);
  const contract = parseCompactResponseContract(contractSource);
  const runtime = createCompactResponseRuntime({
    renderers: [createChangeReportMarkdownRenderer()],
  });
  const rendered = await runtime.render({ contract, candidate });
  if (rendered.status !== 'rendered') throw new TypeError('fixture failed');
  return { runtime, contract, candidate, rendered };
}

describe('compact response witness', () => {
  it('parses only exact canonical witness bytes', async () => {
    const { rendered } = await renderedFixture();
    const wire = serializeCompactResponseWitness(rendered.witness);

    expect(parseCompactResponseWitness(wire)).toEqual(rendered.witness);
    expect(() => parseCompactResponseWitness(`${wire}\n`)).toThrowError(
      expect.objectContaining<Partial<CompactResponseError>>({
        code: 'WITNESS_MALFORMED',
      }),
    );
  });

  it('binds the exact candidate bytes, canonical payload and output', async () => {
    const { runtime, contract, candidate, rendered } = await renderedFixture();
    const witness = serializeCompactResponseWitness(rendered.witness);

    await expect(
      runtime.verify({
        contract,
        candidate,
        rendered: rendered.output,
        witness,
      }),
    ).resolves.toEqual({ bound: true, reasons: [] });
    await expect(
      runtime.replay({ contract, candidate, witness }),
    ).resolves.toEqual({ bound: true, reasons: [] });

    const semanticallySame = JSON.stringify(JSON.parse(candidate));
    expect(semanticallySame).not.toBe(candidate);
    await expect(
      runtime.replay({ contract, candidate: semanticallySame, witness }),
    ).resolves.toEqual({ bound: false, reasons: ['WITNESS_MISMATCH'] });

    const output = new Uint8Array(rendered.output);
    const last = output.byteLength - 1;
    output[last] = output[last]! ^ 1;
    await expect(
      runtime.verify({ contract, candidate, rendered: output, witness }),
    ).resolves.toEqual({ bound: false, reasons: ['WITNESS_MISMATCH'] });
  });

  it('rejects witness field tampering and never includes private content', async () => {
    const { rendered } = await renderedFixture();
    const wire = serializeCompactResponseWitness(rendered.witness);
    const tampered = JSON.parse(wire) as {
      candidate: { byteLength: number };
      privateSentinel?: string;
    };
    tampered.candidate.byteLength += 1;
    expect(() =>
      parseCompactResponseWitness(JSON.stringify(tampered)),
    ).toThrowError(
      expect.objectContaining<Partial<CompactResponseError>>({
        code: 'WITNESS_MALFORMED',
      }),
    );

    const sentinel = 'PRIVATE_RESPONSE_SENTINEL_53c2b292';
    const base64 = Buffer.from(sentinel).toString('base64');
    expect(wire).not.toContain(sentinel);
    expect(wire).not.toContain(base64);
  });
});
