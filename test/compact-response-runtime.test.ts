import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

import { describe, expect, it, vi } from 'vitest';

import type { TokenizerAdapter } from '../src/ports/tokenizer.js';
import {
  createChangeReportMarkdownRenderer,
  createCompactResponseRuntime,
  parseCompactResponseContract,
  serializeCompactResponseWitness,
  type CompactResponseRenderer,
} from '../src/response/index.js';

const contractUrl = new URL(
  '../examples/compact-response/change-report.contract.json',
  import.meta.url,
);
const candidateUrl = new URL(
  '../examples/compact-response/change-report.candidate.json',
  import.meta.url,
);

const exactTokenizer: TokenizerAdapter = Object.freeze({
  id: 'compact-response-test',
  fingerprint: 'compact-response-test:v1',
  async count(bytes: Uint8Array) {
    return { tokens: bytes.byteLength, reliability: 'exact' as const };
  },
});

async function fixture() {
  const [contractSource, candidate] = await Promise.all([
    readFile(contractUrl, 'utf8'),
    readFile(candidateUrl, 'utf8'),
  ]);
  return {
    contractSource,
    contract: parseCompactResponseContract(contractSource),
    candidate,
  };
}

function runtime(
  renderer: CompactResponseRenderer = createChangeReportMarkdownRenderer(),
  tokenizer: TokenizerAdapter | undefined = exactTokenizer,
) {
  return createCompactResponseRuntime({
    renderers: [renderer],
    ...(tokenizer === undefined ? {} : { tokenizer }),
  });
}

describe('compact response runtime', () => {
  it('renders a compact change report with deterministic content-free evidence', async () => {
    const { contract, candidate } = await fixture();
    const first = await runtime().render({ contract, candidate });
    const second = await runtime().render({ contract, candidate });

    expect(first.status).toBe('rendered');
    expect(second.status).toBe('rendered');
    if (first.status !== 'rendered' || second.status !== 'rendered') return;
    const markdown = new TextDecoder().decode(first.output);
    expect(markdown).toContain('# Change report');
    expect(markdown).toContain('Status: Completed');
    expect(markdown).toContain('273 tests');
    expect(serializeCompactResponseWitness(first.witness)).toBe(
      serializeCompactResponseWitness(second.witness),
    );
    expect(first.witness.billedOutputSavings).toBeNull();
    expect(first.witness.universalSemanticEquivalence).toBe(false);
    expect(first.witness.localTokenProjection?.benefitProjected).toBe(true);
    expect(serializeCompactResponseWitness(first.witness)).not.toContain(
      'Implemented proof-bound project lineage',
    );
  });

  it('never invokes the renderer for a schema-invalid candidate', async () => {
    const { contract } = await fixture();
    const base = createChangeReportMarkdownRenderer();
    const render = vi.fn(base.render);
    const result = await runtime({ ...base, render }).render({
      contract,
      candidate: '{"s":"ok","m":"safe","c":[],"v":[],"w":[],"x":1}',
    });

    expect(result).toEqual({
      status: 'retry-required',
      reasons: ['CANDIDATE_SCHEMA_MISMATCH'],
    });
    expect(render).not.toHaveBeenCalled();
  });

  it('fails closed on missing, version-skewed and digest-skewed renderers', async () => {
    const { contractSource, contract, candidate } = await fixture();
    const base = createChangeReportMarkdownRenderer();
    const missing = createCompactResponseRuntime({
      renderers: [{ ...base, id: 'different-renderer' }],
    });
    expect(await missing.render({ contract, candidate })).toEqual({
      status: 'retry-required',
      reasons: ['RENDERER_NOT_REGISTERED'],
    });

    const versionSkew = runtime({ ...base, version: '2' });
    expect(await versionSkew.render({ contract, candidate })).toEqual({
      status: 'retry-required',
      reasons: ['RENDERER_BINDING_MISMATCH'],
    });

    const wire = JSON.parse(contractSource) as {
      renderer: { artifactDigest: string };
    };
    wire.renderer.artifactDigest = `sha256:${'0'.repeat(64)}`;
    const digestSkew = parseCompactResponseContract(JSON.stringify(wire));
    expect(
      await runtime(base).render({ contract: digestSkew, candidate }),
    ).toEqual({
      status: 'retry-required',
      reasons: ['RENDERER_BINDING_MISMATCH'],
    });
  });

  it('returns no output for throw, timeout, invalid UTF-8 or expansion', async () => {
    const { contractSource, contract, candidate } = await fixture();
    const base = createChangeReportMarkdownRenderer();
    expect(
      await runtime({
        ...base,
        render: () => {
          throw new Error('private renderer failure');
        },
      }).render({ contract, candidate }),
    ).toEqual({ status: 'retry-required', reasons: ['RENDER_ERROR'] });

    const timeoutWire = JSON.parse(contractSource) as {
      limits: { maxRenderMs: number };
    };
    timeoutWire.limits.maxRenderMs = 10;
    expect(
      await runtime({
        ...base,
        render: () => new Promise<string>(() => undefined),
      }).render({
        contract: parseCompactResponseContract(JSON.stringify(timeoutWire)),
        candidate,
      }),
    ).toEqual({ status: 'retry-required', reasons: ['RENDER_TIMEOUT'] });

    expect(
      await runtime({ ...base, render: () => new Uint8Array([0xff]) }).render({
        contract,
        candidate,
      }),
    ).toEqual({
      status: 'retry-required',
      reasons: ['RENDER_OUTPUT_INVALID'],
    });

    expect(
      await runtime({
        ...base,
        render: () => new Proxy(new Uint8Array([0x78]), {}),
      }).render({ contract, candidate }),
    ).toEqual({
      status: 'retry-required',
      reasons: ['RENDER_OUTPUT_INVALID'],
    });

    expect(
      await runtime({
        ...base,
        render: () => 'x'.repeat(contract.limits.maxRenderedBytes + 1),
      }).render({ contract, candidate }),
    ).toEqual({
      status: 'retry-required',
      reasons: ['RENDER_OUTPUT_TOO_LARGE'],
    });

    const oversizedBytes = new Uint8Array(contract.limits.maxRenderedBytes + 1);
    oversizedBytes.fill(0x78);
    Object.defineProperty(oversizedBytes, 'byteLength', { value: 1 });
    expect(
      await runtime({
        ...base,
        render: () => oversizedBytes,
      }).render({ contract, candidate }),
    ).toEqual({
      status: 'retry-required',
      reasons: ['RENDER_OUTPUT_TOO_LARGE'],
    });

    const validBytes = new TextEncoder().encode('safe output');
    Object.defineProperty(validBytes, Symbol.iterator, {
      value() {
        throw new Error('caller-controlled iterator must not run');
      },
    });
    await expect(
      runtime({ ...base, render: () => validBytes }).render({
        contract,
        candidate,
      }),
    ).resolves.toMatchObject({ status: 'rendered' });
  });

  it('snapshots candidate bytes before asynchronous rendering', async () => {
    const { contract, candidate } = await fixture();
    const source = new TextEncoder().encode(candidate);
    const pending = runtime().render({ contract, candidate: source });
    source.fill(0x20);
    const result = await pending;

    expect(result.status).toBe('rendered');
    if (result.status !== 'rendered') return;
    expect(new TextDecoder().decode(result.output)).toContain(
      'Implemented proof\\-bound project lineage',
    );
  });

  it('escapes Markdown and reports a non-beneficial local projection honestly', async () => {
    const { contract } = await fixture();
    const candidate = JSON.stringify({
      s: 'warn',
      m: '<script>\n# heading',
      c: [['M', 'src/`odd`.ts', '*bold*']],
      v: [],
      w: ['[link](javascript:bad)'],
    });
    const rendered = await runtime().render({ contract, candidate });
    expect(rendered.status).toBe('rendered');
    if (rendered.status !== 'rendered') return;
    const markdown = new TextDecoder().decode(rendered.output);
    expect(markdown).not.toContain('<script>');
    expect(markdown).toContain('\\<script\\>');
    expect(markdown).toContain('\\# heading');
    expect(markdown).toContain('\\*bold\\*');

    const base = createChangeReportMarkdownRenderer();
    const shorter = await runtime({ ...base, render: () => 'x' }).render({
      contract,
      candidate,
    });
    expect(shorter.status).toBe('rendered');
    if (shorter.status !== 'rendered') return;
    expect(shorter.witness.localTokenProjection).toMatchObject({
      projectedAvoidedModelTokens: 0,
      projectedSavingsRatioPpm: 0,
      benefitProjected: false,
    });
  });

  it('snapshots registration fields once and rejects duplicate or throwing registrations', async () => {
    const base = createChangeReportMarkdownRenderer();
    expect(() =>
      createCompactResponseRuntime({ renderers: [base, base] }),
    ).toThrowError(
      expect.objectContaining({ code: 'RENDERER_BINDING_MISMATCH' }),
    );

    const throwing = new Proxy(base, {
      get(target, property, receiver) {
        if (property === 'id') throw new Error('private getter failure');
        return Reflect.get(target, property, receiver);
      },
    });
    expect(() =>
      createCompactResponseRuntime({ renderers: [throwing] }),
    ).toThrowError(
      expect.objectContaining({ code: 'RENDERER_BINDING_MISMATCH' }),
    );

    const { contractSource, candidate } = await fixture();
    let idReads = 0;
    const unstable = new Proxy(
      { ...base },
      {
        get(target, property, receiver) {
          if (property === 'id') {
            idReads += 1;
            return idReads === 1 ? 'decoy-renderer' : target.id;
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );
    const decoyWire = JSON.parse(contractSource) as {
      renderer: { id: string };
    };
    decoyWire.renderer.id = 'decoy-renderer';
    const decoyContract = parseCompactResponseContract(
      JSON.stringify(decoyWire),
    );
    const snapshotted = createCompactResponseRuntime({
      renderers: [base, unstable],
    });
    await expect(
      snapshotted.render({ contract: decoyContract, candidate }),
    ).resolves.toMatchObject({ status: 'rendered' });
    expect(idReads).toBe(1);

    const registry = [base];
    Object.defineProperty(registry, 'map', {
      value() {
        throw new Error('caller-controlled map must not run');
      },
    });
    await expect(
      createCompactResponseRuntime({ renderers: registry }).render({
        contract: parseCompactResponseContract(contractSource),
        candidate,
      }),
    ).resolves.toMatchObject({ status: 'rendered' });

    const locales = ['en'];
    Object.defineProperty(locales, Symbol.iterator, {
      value() {
        throw new Error('caller-controlled locale iterator must not run');
      },
    });
    await expect(
      createCompactResponseRuntime({
        renderers: [{ ...base, locales }],
      }).render({
        contract: parseCompactResponseContract(contractSource),
        candidate,
      }),
    ).resolves.toMatchObject({ status: 'rendered' });
  });

  it('does not start renderer or tokenizer work after the total deadline', async () => {
    const { contractSource, candidate } = await fixture();
    const base = createChangeReportMarkdownRenderer();
    const largeWire = JSON.parse(contractSource) as {
      candidate: { schema: unknown };
      limits: {
        maxCandidateBytes: number;
        maxStringCodeUnits: number;
        maxRenderMs: number;
      };
    };
    largeWire.candidate.schema = {
      type: 'string',
      minLength: 1,
      maxLength: 1024 * 1024,
    };
    largeWire.limits.maxCandidateBytes = 1024 * 1024 + 16;
    largeWire.limits.maxStringCodeUnits = 1024 * 1024;
    largeWire.limits.maxRenderMs = 1;
    const render = vi.fn(base.render);
    const expiredBeforeRender = await createCompactResponseRuntime({
      renderers: [{ ...base, render }],
      preparationTimeoutMs: 1,
    }).render({
      contract: parseCompactResponseContract(JSON.stringify(largeWire)),
      candidate: JSON.stringify('x'.repeat(1024 * 1024)),
    });
    expect(expiredBeforeRender).toEqual({
      status: 'retry-required',
      reasons: ['RENDER_TIMEOUT'],
    });
    expect(render).not.toHaveBeenCalled();

    const timeoutWire = JSON.parse(contractSource) as {
      limits: { maxRenderMs: number };
    };
    timeoutWire.limits.maxRenderMs = 1;
    const tokenizerCount = vi.fn(exactTokenizer.count);
    const slowRenderer = vi.fn(() => {
      const startedAt = performance.now();
      let spins = 0;
      while (performance.now() - startedAt < 8) spins += 1;
      return `safe output ${spins}`;
    });
    const expiredAfterRender = await createCompactResponseRuntime({
      renderers: [{ ...base, render: slowRenderer }],
      tokenizer: { ...exactTokenizer, count: tokenizerCount },
      preparationTimeoutMs: 1,
    }).render({
      contract: parseCompactResponseContract(JSON.stringify(timeoutWire)),
      candidate,
    });
    expect(expiredAfterRender).toEqual({
      status: 'retry-required',
      reasons: ['RENDER_TIMEOUT'],
    });
    expect(slowRenderer).toHaveBeenCalledOnce();
    expect(tokenizerCount).not.toHaveBeenCalled();
  });

  it('does not start the rendered token count after the first count exhausts the deadline', async () => {
    const { contractSource, candidate } = await fixture();
    const timeoutWire = JSON.parse(contractSource) as {
      limits: { maxRenderMs: number };
    };
    timeoutWire.limits.maxRenderMs = 100;
    const count = vi.fn(async (bytes: Uint8Array) => {
      const startedAt = performance.now();
      let spins = 0;
      while (performance.now() - startedAt < 150) spins += 1;
      return {
        tokens: bytes.byteLength + spins - spins,
        reliability: 'exact' as const,
      };
    });
    const result = await createCompactResponseRuntime({
      renderers: [createChangeReportMarkdownRenderer()],
      tokenizer: {
        id: exactTokenizer.id,
        fingerprint: exactTokenizer.fingerprint,
        count,
      },
      preparationTimeoutMs: 100,
    }).render({
      contract: parseCompactResponseContract(JSON.stringify(timeoutWire)),
      candidate,
    });

    expect(result).toEqual({
      status: 'retry-required',
      reasons: ['RENDER_TIMEOUT'],
    });
    expect(count).toHaveBeenCalledOnce();
  });
});
