import { describe, expect, it } from 'vitest';

import { analyzeSegment } from '../src/application/analyze.js';
import { simulateSegment } from '../src/application/simulate.js';
import { verifyProofEnvelope } from '../src/application/verify.js';
import { sha256 } from '../src/domain/hash.js';
import { DEFAULT_POLICY, type PolicyRule } from '../src/domain/policy.js';
import { createSegment } from '../src/domain/types.js';
import type { Codec } from '../src/ports/codec.js';
import type { ContentStore } from '../src/ports/content-store.js';
import {
  createRegistry,
  DeterministicByteTokenizer,
  makePolicy,
} from './helpers.js';

const whitespaceRules: readonly PolicyRule[] = [
  {
    match: { kinds: ['tool-result'] },
    codecs: ['identity', 'whitespace-rle'],
    allowEquivalence: ['byte-exact', 'roundtrip-exact'],
  },
  {
    match: {},
    codecs: ['identity'],
    allowEquivalence: ['byte-exact'],
  },
];

describe('protected segments', () => {
  for (const role of ['system', 'developer'] as const) {
    it(`bypasses codecs for ${role} content`, async () => {
      const segment = createSegment({
        id: `protected-${role}`,
        role,
        kind: 'prose',
        content: `protected ${role} bytes`,
      });
      const result = await simulateSegment(
        {
          registry: createRegistry(),
          tokenizer: new DeterministicByteTokenizer(),
        },
        segment,
        DEFAULT_POLICY,
      );
      expect(result).toMatchObject({
        applied: false,
        selectedCodec: 'identity',
        effectiveReference: sha256(segment.content),
      });
      expect(result.proof.decision).toMatchObject({
        status: 'bypassed',
        reasons: expect.arrayContaining(['PROTECTED_ROLE']),
      });
    });
  }

  for (const kind of ['code', 'diff', 'tool-schema', 'tool-call'] as const) {
    it(`bypasses codecs for ${kind} content`, async () => {
      const segment = createSegment({
        id: `protected-${kind}`,
        role: 'user',
        kind,
        content: '{"protected":true}',
      });
      const result = await simulateSegment(
        {
          registry: createRegistry(),
          tokenizer: new DeterministicByteTokenizer(),
        },
        segment,
        DEFAULT_POLICY,
      );
      expect(result.applied).toBe(false);
      expect(result.selectedCodec).toBe('identity');
      expect(result.proof.decision.reasons).toContain('PROTECTED_KIND');
    });
  }

  it('keeps a large protected identity path outside the codec wall-clock budget', async () => {
    const content = new Uint8Array(8 * 1024 * 1024);
    content.fill(0x41);
    const segment = createSegment({
      role: 'developer',
      kind: 'code',
      content,
    });
    const policy = makePolicy({
      limits: {
        maxInputBytes: content.byteLength,
        maxEncodedBytes: content.byteLength,
        maxDecodeBytes: content.byteLength,
        maxCodecMs: 1,
      },
    });

    const result = await simulateSegment(
      {
        registry: createRegistry(),
        tokenizer: new DeterministicByteTokenizer(),
      },
      segment,
      policy,
    );

    expect(result.selectedCodec).toBe('identity');
    expect(result.proof.decision.reasons).toEqual(
      expect.arrayContaining(['PROTECTED_ROLE', 'IDENTITY_SELECTED']),
    );
  });
});

describe('token overhead and net-benefit gate', () => {
  it('rejects unsafe tokenizer identity and invalid token evidence', async () => {
    const segment = createSegment({
      role: 'tool',
      kind: 'tool-result',
      content: 'bounded input',
    });
    const unsafeFingerprint = {
      id: DEFAULT_POLICY.tokenizerId,
      fingerprint: 'unsafe\nsource-like fingerprint',
      async count() {
        return { tokens: 1, reliability: 'exact' as const };
      },
    };
    const invalidCount = {
      id: DEFAULT_POLICY.tokenizerId,
      fingerprint: 'test/invalid-count:v1',
      async count() {
        return { tokens: -1, reliability: 'exact' as const };
      },
    };

    await expect(
      simulateSegment(
        { registry: createRegistry(), tokenizer: unsafeFingerprint },
        segment,
        DEFAULT_POLICY,
      ),
    ).rejects.toMatchObject({ code: 'TOKENIZER_UNAVAILABLE' });
    await expect(
      simulateSegment(
        { registry: createRegistry(), tokenizer: invalidCount },
        segment,
        DEFAULT_POLICY,
      ),
    ).rejects.toMatchObject({ code: 'TOKENIZER_ERROR' });
  });

  it('falls back when deterministic re-encoding exceeds the async deadline', async () => {
    let calls = 0;
    const hangingCodec: Codec = {
      descriptor: {
        id: 'hang-on-reencode',
        version: '1',
        deterministic: true,
        acceptedKinds: ['tool-result'],
        equivalence: 'roundtrip-exact',
      },
      async encode(segment) {
        calls += 1;
        return calls === 1
          ? { bytes: new Uint8Array(segment.content) }
          : new Promise<never>(() => undefined);
      },
      async decode(candidate) {
        return new Uint8Array(candidate.bytes);
      },
    };
    const segment = createSegment({
      role: 'tool',
      kind: 'tool-result',
      content: 'deadline-safe original',
    });
    const result = await simulateSegment(
      {
        registry: createRegistry().register(hangingCodec),
        tokenizer: new DeterministicByteTokenizer(),
      },
      segment,
      makePolicy({
        rules: [
          {
            match: { kinds: ['tool-result'] },
            codecs: ['identity', 'hang-on-reencode'],
            allowEquivalence: ['byte-exact', 'roundtrip-exact'],
          },
        ],
        limits: { maxCodecMs: 5 },
        selection: { minTokenSavings: 0, minSavingsRatioPpm: 0 },
      }),
    );

    expect(result.selectedCodec).toBe('identity');
    expect(
      result.candidates.find(
        (candidate) => candidate.codecId === 'hang-on-reencode',
      )?.reasons,
    ).toContain('CODEC_TIMEOUT');
  });

  it('rejects a codec that falsely claims byte-exact equivalence', async () => {
    const source = 'A'.repeat(100);
    const lyingCodec: Codec = {
      descriptor: {
        id: 'fake-byte-exact',
        version: '1',
        deterministic: true,
        acceptedKinds: ['tool-result'],
        equivalence: 'byte-exact',
      },
      async encode() {
        return { bytes: new Uint8Array([100]) };
      },
      async decode() {
        return new TextEncoder().encode(source);
      },
    };
    const segment = createSegment({
      role: 'tool',
      kind: 'tool-result',
      equivalence: 'byte-exact',
      content: source,
    });
    const result = await simulateSegment(
      {
        registry: createRegistry().register(lyingCodec),
        tokenizer: new DeterministicByteTokenizer(),
      },
      segment,
      makePolicy({
        rules: [
          {
            match: { kinds: ['tool-result'] },
            codecs: ['identity', 'fake-byte-exact'],
            allowEquivalence: ['byte-exact'],
          },
        ],
        selection: {
          includeDecoderLegendTokens: false,
          minTokenSavings: 1,
          minSavingsRatioPpm: 0,
        },
      }),
    );

    expect(result.selectedCodec).toBe('identity');
    expect(
      result.candidates.find(
        (candidate) => candidate.codecId === 'fake-byte-exact',
      ),
    ).toMatchObject({
      eligible: false,
      reasons: expect.arrayContaining(['ROUNDTRIP_MISMATCH']),
    });
  });

  it('does not admit a weaker codec than the segment equivalence requirement', async () => {
    const segment = createSegment({
      id: 'byte-exact-json',
      role: 'tool',
      kind: 'json-data',
      equivalence: 'byte-exact',
      content: '{\n  "b": 2,\n  "a": 1\n}',
    });
    const result = await simulateSegment(
      {
        registry: createRegistry(),
        tokenizer: new DeterministicByteTokenizer(),
      },
      segment,
      makePolicy({
        selection: { minTokenSavings: 1, minSavingsRatioPpm: 0 },
      }),
    );

    expect(result.selectedCodec).toBe('identity');
    expect(
      result.candidates.find((candidate) => candidate.codecId === 'json-jcs'),
    ).toMatchObject({
      eligible: false,
      reasons: expect.arrayContaining(['CODEC_NOT_APPLICABLE']),
    });
  });

  it('counts the decoder legend and rejects a gross saving that is a net loss', async () => {
    const segment = createSegment({
      id: 'legend-net-loss',
      role: 'tool',
      kind: 'tool-result',
      content: `prefix${' '.repeat(24)}suffix`,
    });
    const result = await simulateSegment(
      {
        registry: createRegistry(),
        tokenizer: new DeterministicByteTokenizer(),
      },
      segment,
      makePolicy({
        rules: whitespaceRules,
        selection: { minTokenSavings: 1, minSavingsRatioPpm: 0 },
      }),
    );
    const candidate = result.candidates.find(
      (item) => item.codecId === 'whitespace-rle',
    );
    expect(candidate?.decoderOverheadTokens).toBeGreaterThan(0);
    expect(candidate?.netTokenSavings).toBeLessThanOrEqual(0);
    expect(candidate?.reasons).toContain('DECODER_OVERHEAD_EXCEEDS_SAVINGS');
    expect(result.selectedCodec).toBe('identity');
  });

  it('projects a verified candidate in shadow mode when net thresholds pass', async () => {
    const segment = createSegment({
      id: 'shadow-candidate',
      role: 'tool',
      kind: 'tool-result',
      content: `prefix${' '.repeat(256)}suffix`,
    });
    const policy = makePolicy({
      rules: whitespaceRules,
      selection: {
        includeDecoderLegendTokens: false,
        minTokenSavings: 1,
        minSavingsRatioPpm: 0,
      },
    });
    const result = await simulateSegment(
      {
        registry: createRegistry(),
        tokenizer: new DeterministicByteTokenizer(),
      },
      segment,
      policy,
    );

    expect(result.selectedCodec).toBe('whitespace-rle');
    expect(result.applied).toBe(false);
    expect(result.effectiveReference).toBe(sha256(segment.content));
    expect(result.projectedReference).not.toBe(result.effectiveReference);
    expect(result.proof.decision).toMatchObject({
      status: 'bypassed',
      reasons: expect.arrayContaining(['SHADOW_ONLY']),
    });
    expect(
      result.candidates.find((item) => item.codecId === 'whitespace-rle'),
    ).toMatchObject({ eligible: true, decoderOverheadTokens: 0 });
  });

  it('enforces the absolute minimum even for a positive compression ratio', async () => {
    const segment = createSegment({
      id: 'below-absolute-gate',
      role: 'tool',
      kind: 'tool-result',
      content: `prefix${' '.repeat(256)}suffix`,
    });
    const result = await simulateSegment(
      {
        registry: createRegistry(),
        tokenizer: new DeterministicByteTokenizer(),
      },
      segment,
      makePolicy({
        rules: whitespaceRules,
        selection: {
          includeDecoderLegendTokens: false,
          minTokenSavings: 10_000,
          minSavingsRatioPpm: 0,
        },
      }),
    );
    const candidate = result.candidates.find(
      (item) => item.codecId === 'whitespace-rle',
    );
    expect(candidate?.netTokenSavings).toBeGreaterThan(0);
    expect(candidate?.reasons).toContain('BELOW_MIN_SAVINGS');
    expect(result.selectedCodec).toBe('identity');
  });
});

describe('proof determinism and tamper detection', () => {
  it('returns a self-verifying identity proof after a CAS verification fault', async () => {
    const failingStore: ContentStore = {
      async put(bytes) {
        return sha256(bytes);
      },
      async get() {
        throw Object.assign(new Error('missing'), { code: 'CAS_MISS' });
      },
      async has() {
        return false;
      },
    };
    const registry = createRegistry();
    const tokenizer = new DeterministicByteTokenizer();
    const segment = createSegment({
      role: 'tool',
      kind: 'tool-result',
      content: `prefix${' '.repeat(256)}suffix`,
    });
    const policy = makePolicy({
      rules: whitespaceRules,
      selection: {
        includeDecoderLegendTokens: false,
        minTokenSavings: 1,
        minSavingsRatioPpm: 0,
      },
    });
    const simulation = await simulateSegment(
      { registry, tokenizer, store: failingStore },
      segment,
      policy,
    );

    expect(simulation.selectedCodec).toBe('identity');
    expect(simulation.projectedStored).toBe(false);
    expect(simulation.proof.original.stored).toBe(false);
    expect(simulation.proof.encoded.stored).toBe(false);
    expect(simulation.proof.decision.reasons).toEqual(
      expect.arrayContaining([
        'CAS_MISS',
        'FALLBACK_ORIGINAL',
        'IDENTITY_SELECTED',
      ]),
    );
    await expect(
      verifyProofEnvelope({
        proof: simulation.proof,
        segment,
        encoded: { bytes: new Uint8Array(segment.content) },
        policy,
        registry,
        tokenizer,
      }),
    ).resolves.toEqual({ verified: true, reasons: [] });
  });

  it('emits identical proof evidence for identical inputs and dependencies', async () => {
    const segment = createSegment({
      id: 'deterministic-simulation',
      role: 'tool',
      kind: 'tool-result',
      content: `prefix${' '.repeat(256)}suffix`,
    });
    const dependencies = {
      registry: createRegistry(),
      tokenizer: new DeterministicByteTokenizer(),
    };
    const policy = makePolicy({
      rules: whitespaceRules,
      selection: {
        includeDecoderLegendTokens: false,
        minTokenSavings: 1,
        minSavingsRatioPpm: 0,
      },
    });
    const first = await simulateSegment(dependencies, segment, policy);
    const second = await simulateSegment(dependencies, segment, policy);
    expect(first.proof).toEqual(second.proof);
    expect(first.proof.proofDigest).toBe(second.proof.proofDigest);
  });

  it('verifies an identity proof and rejects proof, policy and payload tampering', async () => {
    const registry = createRegistry();
    const tokenizer = new DeterministicByteTokenizer();
    const segment = createSegment({
      id: 'tamper-target',
      role: 'developer',
      kind: 'instruction',
      content: 'Never weaken this invariant.',
    });
    const simulation = await simulateSegment(
      { registry, tokenizer },
      segment,
      DEFAULT_POLICY,
    );
    const encoded = {
      bytes: new Uint8Array(segment.content),
    };
    await expect(
      verifyProofEnvelope({
        proof: simulation.proof,
        segment,
        encoded,
        policy: DEFAULT_POLICY,
        registry,
        tokenizer,
      }),
    ).resolves.toEqual({ verified: true, reasons: [] });

    const tamperedProof = {
      ...simulation.proof,
      encoded: {
        ...simulation.proof.encoded,
        byteLength: simulation.proof.encoded.byteLength + 1,
      },
    };
    const proofResult = await verifyProofEnvelope({
      proof: tamperedProof,
      segment,
      encoded,
      policy: DEFAULT_POLICY,
      registry,
      tokenizer,
    });
    expect(proofResult.reasons).toEqual(
      expect.arrayContaining([
        'PROOF_DIGEST_MISMATCH',
        'ENCODED_HASH_MISMATCH',
      ]),
    );

    const policyResult = await verifyProofEnvelope({
      proof: simulation.proof,
      segment,
      encoded,
      policy: makePolicy({ selection: { minTokenSavings: 99 } }),
      registry,
      tokenizer,
    });
    expect(policyResult.reasons).toContain('POLICY_DIGEST_MISMATCH');

    const payloadResult = await verifyProofEnvelope({
      proof: simulation.proof,
      segment,
      encoded: {
        bytes: new TextEncoder().encode('tampered candidate'),
      },
      policy: DEFAULT_POLICY,
      registry,
      tokenizer,
    });
    expect(payloadResult.reasons).toEqual(
      expect.arrayContaining(['ENCODED_HASH_MISMATCH', 'ROUNDTRIP_MISMATCH']),
    );

    const relabeledResult = await verifyProofEnvelope({
      proof: simulation.proof,
      segment: {
        ...segment,
        role: 'user',
        trust: 'untrusted-external',
      },
      encoded,
      policy: DEFAULT_POLICY,
      registry,
      tokenizer,
    });
    expect(relabeledResult.reasons).toContain('MALFORMED_ENVELOPE');
  });
});

describe('report privacy', () => {
  it('rejects codec metadata as an uncounted side channel', async () => {
    const secret = 'SUPER_SECRET_CODEC_METADATA';
    const codec: Codec = {
      descriptor: {
        id: 'side-channel',
        version: '1',
        deterministic: true,
        acceptedKinds: ['tool-result'],
        equivalence: 'roundtrip-exact',
      },
      async encode() {
        return {
          bytes: new Uint8Array([1]),
          metadata: { original: secret },
        } as never;
      },
      async decode(candidate) {
        const metadata = (
          candidate as unknown as { metadata?: { original?: string } }
        ).metadata;
        return new TextEncoder().encode(metadata?.original ?? 'missing');
      },
    };
    const registry = createRegistry().register(codec);
    const segment = createSegment({
      role: 'tool',
      kind: 'tool-result',
      content: secret,
    });
    const result = await simulateSegment(
      { registry, tokenizer: new DeterministicByteTokenizer() },
      segment,
      makePolicy({
        rules: [
          {
            match: { kinds: ['tool-result'] },
            codecs: ['identity', 'side-channel'],
            allowEquivalence: ['byte-exact', 'roundtrip-exact'],
          },
        ],
        selection: {
          includeDecoderLegendTokens: false,
          minTokenSavings: 1,
          minSavingsRatioPpm: 0,
        },
      }),
    );

    expect(result.selectedCodec).toBe('identity');
    expect(
      result.candidates.find(
        (candidate) => candidate.codecId === 'side-channel',
      ),
    ).toMatchObject({
      eligible: false,
      reasons: expect.arrayContaining(['CODEC_ERROR']),
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it('keeps source bytes out of analysis and simulation reports', async () => {
    const secret = 'SW_PRIVATE_SENTINEL_4f390d37';
    const segment = createSegment({
      id: 'privacy-report',
      role: 'tool',
      kind: 'tool-result',
      content: `${secret}${' '.repeat(256)}${secret}`,
    });
    const policy = makePolicy({
      rules: whitespaceRules,
      selection: {
        includeDecoderLegendTokens: false,
        minTokenSavings: 1,
        minSavingsRatioPpm: 0,
      },
    });
    const dependencies = {
      registry: createRegistry(),
      tokenizer: new DeterministicByteTokenizer(),
    };
    const simulation = await simulateSegment(dependencies, segment, policy);
    const analysis = await analyzeSegment(dependencies, segment, policy);

    for (const report of [simulation, analysis]) {
      const serialized = JSON.stringify(report);
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toMatch(
        /"(?:content|bytes|originalText|encodedText)"\s*:/u,
      );
    }
  });
});
