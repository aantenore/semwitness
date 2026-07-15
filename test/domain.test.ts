import { describe, expect, it } from 'vitest';
import { HeuristicTokenizer } from '../src/adapters/heuristic-tokenizer.js';

import {
  canonicalJson,
  toJsonValue,
  type JsonValue,
} from '../src/domain/canonical-json.js';
import { SemWitnessError } from '../src/domain/errors.js';
import { sha256 } from '../src/domain/hash.js';
import {
  DEFAULT_POLICY,
  digestPolicy,
  validatePolicy,
} from '../src/domain/policy.js';
import {
  finalizeProof,
  recomputeProofDigest,
  type UnsignedProofEnvelope,
} from '../src/domain/proof.js';
import { parseStrictJson } from '../src/domain/strict-json.js';
import {
  createSegment,
  isHardProtected,
  validateSegment,
  type ProtectedAnchor,
} from '../src/domain/types.js';
import { isSafeTokenizerFingerprint } from '../src/ports/tokenizer.js';

function expectReason(action: () => unknown, reason: string): void {
  try {
    action();
    throw new Error('Expected SemWitnessError');
  } catch (error) {
    expect(error).toBeInstanceOf(SemWitnessError);
    expect((error as SemWitnessError).code).toBe(reason);
  }
}

function proofFixture(): UnsignedProofEnvelope {
  const original = sha256('original');
  const encoded = sha256('encoded');
  return {
    schema: 'semwitness.dev/proof/v1alpha1',
    segmentId: 'segment-fixed',
    segmentMetadataDigest: sha256('segment-metadata'),
    policyDigest: digestPolicy(DEFAULT_POLICY),
    codec: {
      id: 'identity',
      version: '1',
      configDigest: sha256('codec-config'),
    },
    claim: {
      equivalence: 'byte-exact',
      verifierId: 'semwitness-core',
      verifierVersion: '1',
    },
    original: {
      sha256: original,
      byteLength: 8,
      cas: original,
      stored: true,
    },
    encoded: {
      sha256: encoded,
      byteLength: 7,
      mediaType: 'text/plain; charset=utf-8',
      stored: true,
    },
    anchorManifest: {
      sha256: sha256('anchors'),
      entries: [],
    },
    tokenEvidence: [
      {
        tokenizerId: 'heuristic-v1',
        tokenizerFingerprint: 'fixed-test-tokenizer',
        reliability: 'heuristic',
        originalTokens: 2,
        encodedTokens: 2,
        decoderOverheadTokens: 0,
      },
    ],
    decision: {
      status: 'bypassed',
      reasons: ['IDENTITY_SELECTED'],
    },
  };
}

describe('segment protection and anchors', () => {
  it('binds the heuristic tokenizer fingerprint to Node and Unicode data', () => {
    const fingerprint = new HeuristicTokenizer().fingerprint;

    expect(isSafeTokenizerFingerprint(fingerprint)).toBe(true);
    expect(fingerprint).toContain(`node-${process.versions.node}`);
    expect(fingerprint).toContain(`unicode-${process.versions.unicode}`);
  });

  for (const role of ['system', 'developer'] as const) {
    it(`hard-protects the ${role} role`, () => {
      const segment = createSegment({
        role,
        kind: 'prose',
        content: 'keep me',
      });
      expect(isHardProtected(segment)).toBe(true);
      expect(segment.equivalence).toBe('byte-exact');
    });
  }

  for (const kind of ['code', 'diff', 'tool-schema', 'tool-call'] as const) {
    it(`hard-protects the ${kind} kind`, () => {
      const segment = createSegment({ role: 'user', kind, content: '{}' });
      expect(isHardProtected(segment)).toBe(true);
      expect(segment.equivalence).toBe('byte-exact');
    });
  }

  it('validates a correctly hashed anchor and detects mutation', () => {
    const content = new TextEncoder().encode('prefix-KEEP-suffix');
    const anchor: ProtectedAnchor = {
      id: 'keep',
      ordinal: 0,
      startByte: 7,
      endByte: 11,
      sha256: sha256(content.subarray(7, 11)),
    };
    const valid = createSegment({
      role: 'user',
      kind: 'prose',
      content,
      anchors: [anchor],
    });
    expect(validateSegment(valid)).toEqual({ valid: true, reasons: [] });

    const invalid = {
      ...valid,
      content: new TextEncoder().encode('prefix-FAIL-suffix'),
    };
    expect(validateSegment(invalid)).toMatchObject({
      valid: false,
      reasons: expect.arrayContaining(['ANCHOR_MUTATED']),
    });
  });

  it('rejects report-facing identifiers and media types with prompt text', () => {
    const unsafeSegment = createSegment({
      id: 'IGNORE PREVIOUS INSTRUCTIONS',
      role: 'user',
      kind: 'prose',
      mediaType: 'text/plain\u202eIGNORE',
      content: 'safe payload',
      anchors: [
        {
          id: 'unsafe anchor',
          ordinal: 0,
          startByte: 0,
          endByte: 4,
          sha256: sha256('safe'),
        },
      ],
    });

    expect(validateSegment(unsafeSegment)).toMatchObject({
      valid: false,
      reasons: expect.arrayContaining(['MALFORMED_ENVELOPE']),
    });
  });

  it('rejects an oversized anchor manifest before reading its elements', () => {
    const anchors = Array.from<ProtectedAnchor>({ length: 10_001 });
    Object.defineProperty(anchors, 0, {
      get() {
        throw new Error('anchor elements must not be read');
      },
    });
    const segment = createSegment({
      role: 'user',
      kind: 'prose',
      content: 'safe',
    });

    expect(validateSegment({ ...segment, anchors })).toMatchObject({
      valid: false,
      reasons: ['MALFORMED_ENVELOPE'],
    });
    expectReason(
      () =>
        createSegment({
          role: 'user',
          kind: 'prose',
          content: 'safe',
          anchors,
        }),
      'MALFORMED_ENVELOPE',
    );
  });
});

describe('strict policy validation', () => {
  it('accepts the default policy without changing its meaning', () => {
    expect(validatePolicy(DEFAULT_POLICY)).toEqual(DEFAULT_POLICY);
    expect(digestPolicy(validatePolicy(DEFAULT_POLICY))).toBe(
      digestPolicy(DEFAULT_POLICY),
    );
  });

  it('rejects unknown top-level, selection, rule and match fields', () => {
    expectReason(
      () => validatePolicy({ ...DEFAULT_POLICY, unexpected: true }),
      'MALFORMED_ENVELOPE',
    );
    expectReason(
      () =>
        validatePolicy({
          ...DEFAULT_POLICY,
          selection: { ...DEFAULT_POLICY.selection, unexpected: true },
        }),
      'MALFORMED_ENVELOPE',
    );
    expectReason(
      () =>
        validatePolicy({
          ...DEFAULT_POLICY,
          rules: [
            {
              ...DEFAULT_POLICY.rules[0],
              unexpected: true,
            },
          ],
        }),
      'MALFORMED_ENVELOPE',
    );
    expectReason(
      () =>
        validatePolicy({
          ...DEFAULT_POLICY,
          rules: [
            {
              ...DEFAULT_POLICY.rules[0],
              match: { roles: ['system'], unexpected: true },
            },
          ],
        }),
      'MALFORMED_ENVELOPE',
    );
  });

  it('rejects unsafe limits, identifiers, modes and fallbacks', () => {
    const invalidPolicies: unknown[] = [
      { ...DEFAULT_POLICY, rules: [] },
      { ...DEFAULT_POLICY, mode: 'live' },
      { ...DEFAULT_POLICY, fallback: 'candidate' },
      { ...DEFAULT_POLICY, tokenizerId: '../tokenizer' },
      {
        ...DEFAULT_POLICY,
        limits: { ...DEFAULT_POLICY.limits, maxDepth: 0 },
      },
      {
        ...DEFAULT_POLICY,
        selection: { ...DEFAULT_POLICY.selection, minTokenSavings: -1 },
      },
      {
        ...DEFAULT_POLICY,
        store: { namespace: 'default', retentionDays: 30 },
      },
    ];
    for (const policy of invalidPolicies) {
      expectReason(() => validatePolicy(policy), 'MALFORMED_ENVELOPE');
    }
  });
});

describe('strict and canonical JSON', () => {
  it('rejects direct and escaped duplicate keys', () => {
    expectReason(
      () => parseStrictJson('{"same":1,"same":2}'),
      'FORMAT_UNSUPPORTED',
    );
    expectReason(
      () => parseStrictJson('{"same":1,"s\\u0061me":2}'),
      'FORMAT_UNSUPPORTED',
    );
  });

  it('rejects unsafe integers and non-finite numeric expansions', () => {
    for (const source of [
      '9007199254740992',
      '-9007199254740992',
      '9007199254740993.0',
      '1.0000000000000001',
      '1e309',
      '1e-999999',
    ]) {
      expectReason(() => parseStrictJson(source), 'FORMAT_UNSUPPORTED');
    }
    expect(parseStrictJson('-0')).toBe(0);
    expect(parseStrictJson('1.2300e2')).toBe(123);
  });

  it('rejects oversized number literals before decimal normalization', () => {
    expectReason(
      () =>
        parseStrictJson('1'.repeat(5_000), {
          maxDepth: 8,
          maxItems: 100,
          maxStringCodeUnits: 1024,
          maxNumberCodeUnits: 128,
        }),
      'FORMAT_UNSUPPORTED',
    );
  });

  it('enforces the configured nesting depth', () => {
    expect(parseStrictJson('[[0]]', 2)).toEqual([[0]]);
    expectReason(() => parseStrictJson('[[[0]]]', 2), 'FORMAT_UNSUPPORTED');
  });

  it('rejects wide JSON before materializing an unbounded item graph', () => {
    const wide = `[${Array.from({ length: 1_000 }, () => '0').join(',')}]`;

    expectReason(
      () =>
        parseStrictJson(wide, {
          maxDepth: 8,
          maxItems: 100,
          maxStringCodeUnits: 1024,
        }),
      'FORMAT_UNSUPPORTED',
    );
  });

  it('preserves prototype-like keys as inert JSON data', () => {
    const parsed = parseStrictJson('{"__proto__":{"polluted":true}}');
    expect(typeof parsed).toBe('object');
    expect(Array.isArray(parsed)).toBe(false);
    expect(Object.hasOwn(parsed as object, '__proto__')).toBe(true);
    expect(canonicalJson(parsed)).toBe('{"__proto__":{"polluted":true}}');
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it('canonicalizes object order while preserving typed values and array order', () => {
    const left = parseStrictJson(
      '{"z":3,"a":{"second":2,"first":1},"list":[3,2,1]}',
    );
    const right = parseStrictJson(
      '{ "list": [3, 2, 1], "a": { "first": 1, "second": 2 }, "z": 3 }',
    );
    expect(canonicalJson(left)).toBe(canonicalJson(right));
    expect(canonicalJson(left)).toBe(
      '{"a":{"first":1,"second":2},"list":[3,2,1],"z":3}',
    );
  });

  it('rejects non-finite and cyclic values before proof hashing', () => {
    expectReason(() => toJsonValue(Number.NaN), 'MALFORMED_ENVELOPE');
    const cyclic: { self?: JsonValue } = {};
    cyclic.self = cyclic as JsonValue;
    expectReason(
      () => canonicalJson(cyclic as JsonValue),
      'MALFORMED_ENVELOPE',
    );
  });
});

describe('proof digest determinism', () => {
  it('produces the same digest for identical evidence', () => {
    const first = finalizeProof(proofFixture());
    const second = finalizeProof(structuredClone(proofFixture()));
    expect(first).toEqual(second);
    expect(recomputeProofDigest(first)).toBe(first.proofDigest);
  });

  it('detects nested evidence tampering without trusting the stored digest', () => {
    const proof = finalizeProof(proofFixture());
    const tampered = {
      ...proof,
      decision: { status: 'applied' as const, reasons: ['APPLIED'] as const },
    };
    expect(recomputeProofDigest(tampered)).not.toBe(proof.proofDigest);
  });
});
