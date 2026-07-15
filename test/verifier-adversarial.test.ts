import { describe, expect, it } from 'vitest';

import { JsonJcsCodec, WhitespaceRleCodec } from '../src/adapters/index.js';
import {
  digestAnchorEntries,
  digestCodecDescriptor,
  verifyProofEnvelope,
} from '../src/application/verify.js';
import { sha256 } from '../src/domain/hash.js';
import { digestPolicy, type CodecPolicy } from '../src/domain/policy.js';
import {
  digestSegmentMetadata,
  finalizeProof,
  type ProofEnvelope,
} from '../src/domain/proof.js';
import { createSegment, type Segment } from '../src/domain/types.js';
import type { Codec, EncodedCandidate } from '../src/ports/codec.js';
import {
  createRegistry,
  DeterministicByteTokenizer,
  makePolicy,
} from './helpers.js';

const policy = makePolicy({
  rules: [
    {
      match: {},
      codecs: ['identity', 'whitespace-rle', 'json-jcs'],
      allowEquivalence: ['byte-exact', 'roundtrip-exact', 'typed-semantic'],
    },
  ],
  selection: { minTokenSavings: 0, minSavingsRatioPpm: 0 },
});

async function forgeShadowProof(input: {
  readonly codec: Codec;
  readonly segment: Segment;
  readonly candidate: EncodedCandidate;
  readonly policy: CodecPolicy;
}): Promise<ProofEnvelope> {
  const tokenizer = new DeterministicByteTokenizer();
  const original = await tokenizer.count(input.segment.content);
  const encoded = await tokenizer.count(input.candidate.bytes);
  const legend =
    input.policy.selection.includeDecoderLegendTokens &&
    input.codec.descriptor.decoderLegend !== undefined
      ? await tokenizer.count(input.codec.descriptor.decoderLegend)
      : { tokens: 0, reliability: 'exact' as const };
  const originalReference = sha256(input.segment.content);
  return finalizeProof({
    schema: 'semwitness.dev/proof/v1alpha1',
    segmentId: input.segment.id,
    segmentMetadataDigest: digestSegmentMetadata(input.segment),
    policyDigest: digestPolicy(input.policy),
    codec: {
      id: input.codec.descriptor.id,
      version: input.codec.descriptor.version,
      configDigest: digestCodecDescriptor(input.codec),
    },
    claim: {
      equivalence: input.codec.descriptor.equivalence,
      verifierId: 'semwitness-core',
      verifierVersion: '1',
    },
    original: {
      sha256: originalReference,
      byteLength: input.segment.content.byteLength,
      cas: originalReference,
      stored: false,
    },
    encoded: {
      sha256: sha256(input.candidate.bytes),
      byteLength: input.candidate.bytes.byteLength,
      mediaType: input.segment.mediaType,
      stored: false,
    },
    anchorManifest: {
      sha256: digestAnchorEntries([]),
      entries: [],
    },
    tokenEvidence: [
      {
        tokenizerId: tokenizer.id,
        tokenizerFingerprint: tokenizer.fingerprint,
        reliability:
          original.reliability === 'exact' &&
          encoded.reliability === 'exact' &&
          legend.reliability === 'exact'
            ? 'exact'
            : 'heuristic',
        originalTokens: original.tokens,
        encodedTokens: encoded.tokens,
        decoderOverheadTokens: legend.tokens,
      },
    ],
    decision: { status: 'bypassed', reasons: ['SHADOW_ONLY'] },
  });
}

async function verifyForged(input: {
  readonly codec: Codec;
  readonly segment: Segment;
  readonly candidate: EncodedCandidate;
}) {
  const tokenizer = new DeterministicByteTokenizer();
  return verifyProofEnvelope({
    proof: await forgeShadowProof({ ...input, policy }),
    segment: input.segment,
    encoded: input.candidate,
    policy,
    registry: createRegistry(),
    tokenizer,
  });
}

describe('independent proof eligibility verification', () => {
  it('rejects a codec attributed to an unsupported segment kind', async () => {
    const codec = new JsonJcsCodec();
    const segment = createSegment({
      role: 'tool',
      kind: 'prose',
      equivalence: 'typed-semantic',
      mediaType: 'application/json',
      content: '{"a":1}',
    });
    const candidate = await codec.encode(segment, { policy });

    await expect(
      verifyForged({ codec, segment, candidate }),
    ).resolves.toMatchObject({
      verified: false,
      reasons: expect.arrayContaining(['CODEC_NOT_APPLICABLE']),
    });
  });

  it('rejects a shadow candidate over a hard-protected role', async () => {
    const codec = new WhitespaceRleCodec();
    const segment = createSegment({
      role: 'developer',
      kind: 'tool-result',
      content: `protected${' '.repeat(256)}instruction`,
    });
    const candidate = await codec.encode(segment, { policy });

    await expect(
      verifyForged({ codec, segment, candidate }),
    ).resolves.toMatchObject({
      verified: false,
      reasons: expect.arrayContaining(['PROTECTED_ROLE']),
    });
  });

  it('rejects a mechanically reversible candidate with negative net benefit', async () => {
    const codec = new WhitespaceRleCodec();
    const segment = createSegment({
      role: 'tool',
      kind: 'tool-result',
      content: '~SWW1~',
    });
    const candidate = await codec.encode(segment, { policy });

    await expect(
      verifyForged({ codec, segment, candidate }),
    ).resolves.toMatchObject({
      verified: false,
      reasons: expect.arrayContaining(['DECODER_OVERHEAD_EXCEEDS_SAVINGS']),
    });
  });

  it('rejects bytes that the attributed deterministic encoder did not emit', async () => {
    const codec = new JsonJcsCodec();
    const segment = createSegment({
      role: 'tool',
      kind: 'json-data',
      content: '{"a":1}',
    });
    const candidate = {
      bytes: new TextEncoder().encode('{\n  "a": 1\n}'),
    };

    await expect(
      verifyForged({ codec, segment, candidate }),
    ).resolves.toMatchObject({
      verified: false,
      reasons: expect.arrayContaining(['ENCODER_MISMATCH']),
    });
  });
});
