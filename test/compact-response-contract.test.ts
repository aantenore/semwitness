import { describe, expect, it } from 'vitest';

import { CompactResponseError } from '../src/response/errors.js';
import {
  digestCompactResponseContract,
  parseCompactResponseCandidate,
  parseCompactResponseContract,
} from '../src/response/contract.js';
import {
  BOUNDED_JSON_SCHEMA_DIALECT,
  COMPACT_RESPONSE_CONTRACT_SCHEMA,
  type CompactResponseContract,
} from '../src/response/types.js';

interface ContractFixture {
  schema: string;
  id: string;
  version: string;
  candidate: {
    mediaType: string;
    schemaDialect: string;
    schema: unknown;
  };
  renderer: {
    id: string;
    version: string;
    artifactDigest: string;
    outputMediaType: string;
    locale: string;
  };
  limits: {
    maxCandidateBytes: number;
    maxRenderedBytes: number;
    maxDepth: number;
    maxItems: number;
    maxStringCodeUnits: number;
    maxRenderMs: number;
  };
}

function contractFixture(): ContractFixture {
  return {
    schema: COMPACT_RESPONSE_CONTRACT_SCHEMA,
    id: 'change-report',
    version: '1.0.0-alpha.1',
    candidate: {
      mediaType: 'application/json',
      schemaDialect: BOUNDED_JSON_SCHEMA_DIALECT,
      schema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['ok', 'warn'] },
          summary: { type: 'string', minLength: 1, maxLength: 32 },
          count: { type: 'integer', minimum: 0, maximum: 10 },
          ratio: { type: 'number', minimum: 0, maximum: 1 },
          tags: {
            type: 'array',
            maxItems: 2,
            items: { type: 'string', maxLength: 8 },
          },
          point: {
            type: 'array',
            prefixItems: [{ type: 'number' }, { type: 'number' }],
            items: false,
            minItems: 2,
            maxItems: 2,
          },
          flag: { type: 'boolean', enum: [true] },
          empty: { type: 'null', enum: [null] },
        },
        required: [
          'status',
          'summary',
          'count',
          'ratio',
          'tags',
          'point',
          'flag',
          'empty',
        ],
        additionalProperties: false,
      },
    },
    renderer: {
      id: 'change-report-markdown',
      version: '1',
      artifactDigest: `sha256:${'a'.repeat(64)}`,
      outputMediaType: 'text/markdown',
      locale: 'en-US',
    },
    limits: {
      maxCandidateBytes: 1024,
      maxRenderedBytes: 4096,
      maxDepth: 8,
      maxItems: 128,
      maxStringCodeUnits: 32,
      maxRenderMs: 100,
    },
  };
}

function candidateValue() {
  return {
    status: 'ok',
    summary: 'done',
    count: 2,
    ratio: 0.5,
    tags: ['core', 'test'],
    point: [1.5, 2],
    flag: true,
    empty: null,
  };
}

function parsedContract(
  mutate?: (fixture: ContractFixture) => void,
): CompactResponseContract {
  const fixture = contractFixture();
  mutate?.(fixture);
  return parseCompactResponseContract(JSON.stringify(fixture));
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error('Expected CompactResponseError');
  } catch (error) {
    expect(error).toBeInstanceOf(CompactResponseError);
    expect((error as CompactResponseError).code).toBe(code);
  }
}

describe('compact response contract', () => {
  it('parses a closed immutable contract and computes a canonical digest', () => {
    const fixture = contractFixture();
    const compact = JSON.stringify(fixture);
    const pretty = JSON.stringify(fixture, null, 2);
    const parsed = parseCompactResponseContract(compact);

    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.candidate.schema)).toBe(true);
    expect(Object.isFrozen(parsed.limits)).toBe(true);
    expect(digestCompactResponseContract(compact)).toBe(
      digestCompactResponseContract(pretty),
    );
    expect(digestCompactResponseContract(parsed)).toMatch(
      /^sha256:[a-f0-9]{64}$/u,
    );
  });

  it.each([
    [
      'unknown root field',
      (value: ContractFixture) => Object.assign(value, { extra: true }),
    ],
    ['bad id', (value: ContractFixture) => (value.id = 'Not Safe')],
    [
      'bad version',
      (value: ContractFixture) => (value.version = 'bad version'),
    ],
    [
      'bad digest',
      (value: ContractFixture) => (value.renderer.artifactDigest = 'sha256:no'),
    ],
    [
      'bad output media type',
      (value: ContractFixture) =>
        (value.renderer.outputMediaType = 'text plain'),
    ],
    [
      'bad locale',
      (value: ContractFixture) => (value.renderer.locale = 'EN_us'),
    ],
    [
      'unsafe render deadline',
      (value: ContractFixture) => (value.limits.maxRenderMs = 30_001),
    ],
    [
      'unsupported candidate media type',
      (value: ContractFixture) => (value.candidate.mediaType = 'text/json'),
    ],
  ])('rejects %s', (_label, mutate) => {
    expectCode(
      () => parsedContract(mutate as (value: ContractFixture) => void),
      'CONTRACT_MALFORMED',
    );
  });

  it.each([
    { type: 'string' },
    { type: 'string', maxLength: 4, pattern: '^x$' },
    { type: 'array', items: { type: 'null' } },
    { type: 'array', maxItems: 2, items: false },
    {
      type: 'array',
      prefixItems: [{ type: 'null' }],
      items: false,
      minItems: 0,
      maxItems: 2,
    },
    {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: true,
    },
    { type: 'number', default: 0 },
    { type: 'number', anyOf: [{ type: 'number' }] },
    { $ref: '#/$defs/value' },
  ])('rejects unsupported or unbounded schema %#', (schema) => {
    expectCode(
      () => parsedContract((value) => (value.candidate.schema = schema)),
      'CONTRACT_MALFORMED',
    );
  });

  it('rejects duplicate required fields and more than 4096 schema nodes', () => {
    expectCode(
      () =>
        parsedContract((value) => {
          value.candidate.schema = {
            type: 'object',
            properties: { x: { type: 'null' } },
            required: ['x', 'x'],
            additionalProperties: false,
          };
        }),
      'CONTRACT_MALFORMED',
    );

    const properties = Object.fromEntries(
      Array.from({ length: 4096 }, (_item, index) => [
        `p${index}`,
        { type: 'null' },
      ]),
    );
    expectCode(
      () =>
        parsedContract((value) => {
          value.candidate.schema = {
            type: 'object',
            properties,
            required: [],
            additionalProperties: false,
          };
        }),
      'CONTRACT_MALFORMED',
    );
  });

  it('rejects duplicate contract keys, BOM, malformed UTF-8 and lone surrogates', () => {
    const duplicate = JSON.stringify(contractFixture()).replace(
      `"schema":"${COMPACT_RESPONSE_CONTRACT_SCHEMA}"`,
      `"schema":"${COMPACT_RESPONSE_CONTRACT_SCHEMA}","schema":"${COMPACT_RESPONSE_CONTRACT_SCHEMA}"`,
    );
    expectCode(
      () => parseCompactResponseContract(duplicate),
      'CONTRACT_MALFORMED',
    );
    expectCode(
      () =>
        parseCompactResponseContract(
          `\ufeff${JSON.stringify(contractFixture())}`,
        ),
      'CONTRACT_MALFORMED',
    );
    expectCode(
      () => parseCompactResponseContract(new Uint8Array([0xc3, 0x28])),
      'CONTRACT_MALFORMED',
    );
    expectCode(
      () =>
        parsedContract((value) => {
          value.candidate.schema = { type: 'string', enum: ['\ud800'] };
        }),
      'CONTRACT_MALFORMED',
    );
  });
});

describe('compact response candidate', () => {
  it('copies exact bytes and returns canonical bytes plus deep-frozen JSON', () => {
    const contract = parsedContract();
    const text = `${JSON.stringify(candidateValue(), null, 2)}\n`;
    const source = new TextEncoder().encode(text);
    const result = parseCompactResponseCandidate(source, contract);
    source.fill(0);

    expect(new TextDecoder().decode(result.bytes)).toBe(text);
    expect(new TextDecoder().decode(result.canonicalBytes)).toBe(
      '{"count":2,"empty":null,"flag":true,"point":[1.5,2],"ratio":0.5,"status":"ok","summary":"done","tags":["core","test"]}',
    );
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.value)).toBe(true);
    const record = result.value as Readonly<Record<string, unknown>>;
    expect(Object.getPrototypeOf(record)).toBeNull();
    expect(Object.isFrozen(record.tags)).toBe(true);
  });

  it.each([
    '{"status":"ok","status":"warn"}',
    '{"unsafe":9007199254740992}',
    '{"value":"\\ud800"}',
    '{} trailing',
    '\ufeff{}',
  ])('rejects malformed candidate JSON without exposing it: %s', (source) => {
    expectCode(
      () => parseCompactResponseCandidate(source, parsedContract()),
      'CANDIDATE_MALFORMED',
    );
  });

  it('rejects malformed UTF-8 candidate bytes', () => {
    expectCode(
      () =>
        parseCompactResponseCandidate(
          new Uint8Array([0x22, 0xc3, 0x28, 0x22]),
          parsedContract(),
        ),
      'CANDIDATE_MALFORMED',
    );
  });

  it('enforces byte, depth, item and string global limits', () => {
    const byteBound = parsedContract(
      (value) => (value.limits.maxCandidateBytes = 2),
    );
    expectCode(
      () => parseCompactResponseCandidate('"x"', byteBound),
      'CANDIDATE_LIMIT_EXCEEDED',
    );

    const bounded = parsedContract((value) => {
      value.limits.maxDepth = 2;
      value.limits.maxItems = 32;
    });
    expectCode(
      () =>
        parseCompactResponseCandidate(
          JSON.stringify({ ...candidateValue(), extra: [[[0]]] }),
          bounded,
        ),
      'CANDIDATE_LIMIT_EXCEEDED',
    );
    expectCode(
      () =>
        parseCompactResponseCandidate(
          JSON.stringify({ ...candidateValue(), extra: Array(40).fill(null) }),
          bounded,
        ),
      'CANDIDATE_LIMIT_EXCEEDED',
    );
    expectCode(
      () =>
        parseCompactResponseCandidate(
          JSON.stringify({ ...candidateValue(), extra: 'x'.repeat(33) }),
          bounded,
        ),
      'CANDIDATE_LIMIT_EXCEEDED',
    );
  });

  it('does not trust typed-array byteLength or iterator overrides', () => {
    const text = JSON.stringify(candidateValue());
    const oversized = new TextEncoder().encode(text);
    Object.defineProperty(oversized, 'byteLength', { value: 1 });
    const byteBound = parsedContract(
      (value) => (value.limits.maxCandidateBytes = text.length - 1),
    );
    expectCode(
      () => parseCompactResponseCandidate(oversized, byteBound),
      'CANDIDATE_LIMIT_EXCEEDED',
    );

    const valid = new TextEncoder().encode(text);
    Object.defineProperty(valid, Symbol.iterator, {
      value() {
        throw new Error('caller-controlled iterator must not run');
      },
    });
    expect(
      parseCompactResponseCandidate(valid, parsedContract()).value,
    ).toEqual(candidateValue());
  });

  it.each([
    { ...candidateValue(), extra: true },
    { ...candidateValue(), status: 'invalid' },
    { ...candidateValue(), summary: '' },
    { ...candidateValue(), count: 1.5 },
    { ...candidateValue(), ratio: 2 },
    { ...candidateValue(), tags: ['one', 'two', 'three'] },
    { ...candidateValue(), point: [1] },
    { ...candidateValue(), point: [1, 'two'] },
    { ...candidateValue(), flag: false },
    (() => {
      const { summary: _summary, ...rest } = candidateValue();
      return rest;
    })(),
  ])('rejects candidate schema mismatch %#', (candidate) => {
    expectCode(
      () =>
        parseCompactResponseCandidate(
          JSON.stringify(candidate),
          parsedContract(),
        ),
      'CANDIDATE_SCHEMA_MISMATCH',
    );
  });

  it('rejects a forged contract even when it is structurally similar', () => {
    const parsed = parsedContract();
    const forged = structuredClone(parsed) as CompactResponseContract;
    expectCode(
      () => parseCompactResponseCandidate('{}', forged),
      'CONTRACT_MALFORMED',
    );
  });
});
