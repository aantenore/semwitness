import { describe, expect, it } from 'vitest';

import {
  IdentityCodec,
  JsonJcsCodec,
  LogRepeatCodec,
  WhitespaceRleCodec,
} from '../src/adapters/index.js';
import { verifyCodecCandidate } from '../src/application/verify.js';
import { canonicalJson } from '../src/domain/canonical-json.js';
import { sha256 } from '../src/domain/hash.js';
import { DEFAULT_POLICY } from '../src/domain/policy.js';
import { parseStrictJson } from '../src/domain/strict-json.js';
import { createSegment } from '../src/domain/types.js';
import type { Codec } from '../src/ports/codec.js';
import { createLcg, decodeText, makePolicy } from './helpers.js';

const decodeContext = {
  maxOutputBytes: 2 * 1024 * 1024,
  maxDepth: 64,
  maxItems: 100_000,
} as const;

describe('deterministic reversible codecs', () => {
  it('rejects decoders that ignore the byte limit or return a malformed type', async () => {
    const source = 'A'.repeat(100);
    const segment = createSegment({
      role: 'tool',
      kind: 'tool-result',
      content: source,
    });
    const candidate = { bytes: new Uint8Array([1]) };
    const baseDescriptor = {
      version: '1',
      deterministic: true as const,
      acceptedKinds: ['tool-result'] as const,
      equivalence: 'roundtrip-exact' as const,
    };
    const oversized: Codec = {
      descriptor: { ...baseDescriptor, id: 'oversized-decoder' },
      async encode() {
        return candidate;
      },
      async decode() {
        return new TextEncoder().encode(source);
      },
    };
    const malformed: Codec = {
      descriptor: { ...baseDescriptor, id: 'malformed-decoder' },
      async encode() {
        return candidate;
      },
      async decode() {
        return 'not-bytes' as never;
      },
    };
    const policy = makePolicy({ limits: { maxDecodeBytes: 1 } });

    await expect(
      verifyCodecCandidate({ codec: oversized, segment, candidate, policy }),
    ).resolves.toEqual({ verified: false, reasons: ['DECODE_LIMIT'] });
    await expect(
      verifyCodecCandidate({ codec: malformed, segment, candidate, policy }),
    ).resolves.toEqual({ verified: false, reasons: ['CODEC_ERROR'] });
  });

  it('round-trips generated binary identity cases byte-for-byte', async () => {
    const codec = new IdentityCodec();
    const next = createLcg(0x51a7c0de);
    for (let caseIndex = 0; caseIndex < 96; caseIndex += 1) {
      const bytes = Uint8Array.from(
        { length: next() % 513 },
        () => next() & 0xff,
      );
      const segment = createSegment({
        role: 'user',
        kind: 'tool-result',
        content: bytes,
      });
      const candidate = await codec.encode(segment);
      const decoded = await codec.decode(candidate);
      expect(decoded).toEqual(bytes);
    }
  });

  it('round-trips generated whitespace runs, UTF-8 and literal markers', async () => {
    const codec = new WhitespaceRleCodec();
    const next = createLcg(0x5aceb00c);
    for (let caseIndex = 0; caseIndex < 96; caseIndex += 1) {
      let source = `case-${caseIndex}:caffè`;
      if (caseIndex % 7 === 0) {
        source += '~SWW1~';
      }
      for (let chunk = 0; chunk < 6; chunk += 1) {
        source += `${' '.repeat(12 + (next() % 80))}word-${next() % 1000}`;
        source += `${'\t'.repeat(8 + (next() % 24))}尾`;
      }
      const segment = createSegment({
        role: 'tool',
        kind: 'tool-result',
        content: source,
      });
      const candidate = await codec.encode(segment, {
        policy: DEFAULT_POLICY,
      });
      const decoded = await codec.decode(candidate, decodeContext);
      expect(decodeText(decoded)).toBe(source);
    }
  });

  it('rejects hostile whitespace expansion', async () => {
    const codec = new WhitespaceRleCodec();
    await expect(
      codec.decode(
        {
          bytes: new TextEncoder().encode('~SWW1~S999999999;'),
        },
        { maxOutputBytes: 128, maxDepth: 8, maxItems: 100 },
      ),
    ).rejects.toMatchObject({ code: 'DECODE_LIMIT' });
  });

  it('rejects excessive whitespace marker operations', async () => {
    const codec = new WhitespaceRleCodec();
    const encoded = `${'~SWW1~E;'.repeat(101)}`;

    await expect(
      codec.decode(
        { bytes: new TextEncoder().encode(encoded) },
        { maxOutputBytes: 4096, maxDepth: 8, maxItems: 100 },
      ),
    ).rejects.toMatchObject({ code: 'DECODE_LIMIT' });
  });

  it('round-trips generated repeated logs with LF, CRLF and CR endings', async () => {
    const codec = new LogRepeatCodec();
    const next = createLcg(0x10c0ffee);
    const endings = ['\n', '\r\n', '\r'] as const;
    for (let caseIndex = 0; caseIndex < 72; caseIndex += 1) {
      let source = '';
      for (let group = 0; group < 8; group += 1) {
        const ending = endings[next() % endings.length]!;
        const record = `INFO case=${caseIndex} group=${group} code=${next() % 17}${ending}`;
        source += record.repeat(3 + (next() % 9));
      }
      source += `tail-${caseIndex}`;
      const segment = createSegment({
        role: 'tool',
        kind: 'log',
        content: source,
      });
      const candidate = await codec.encode(segment, {
        policy: DEFAULT_POLICY,
      });
      const decoded = await codec.decode(candidate, decodeContext);
      expect(decodeText(decoded)).toBe(source);
    }
  });

  it('rejects source logs that collide with its marker', async () => {
    const codec = new LogRepeatCodec();
    const source = 'INFO literal=\u001eSWLR1:3:0000000000000000;\n';
    const segment = createSegment({
      role: 'tool',
      kind: 'log',
      content: source,
    });
    await expect(
      codec.encode(segment, { policy: DEFAULT_POLICY }),
    ).rejects.toMatchObject({
      code: 'FORMAT_UNSUPPORTED',
    });
  });

  it('rejects a tiny marker that expands beyond the record-operation budget', async () => {
    const codec = new LogRepeatCodec();
    const line = '\n';
    const digest = sha256(new TextEncoder().encode(line)).slice(
      'sha256:'.length,
      'sha256:'.length + 16,
    );
    const candidate = {
      bytes: new TextEncoder().encode(
        `${line}\u001eSWLR1:99999999:${digest};\n`,
      ),
    };

    await expect(
      codec.decode(candidate, {
        maxOutputBytes: 128 * 1024 * 1024,
        maxDepth: 8,
        maxItems: 100,
      }),
    ).rejects.toMatchObject({ code: 'DECODE_LIMIT' });
  });

  it('rejects newline-dense input at the record budget without an array-per-line split', async () => {
    const codec = new LogRepeatCodec();
    const segment = createSegment({
      role: 'tool',
      kind: 'log',
      content: '\n'.repeat(100_001),
    });

    await expect(
      codec.encode(segment, { policy: DEFAULT_POLICY }),
    ).rejects.toMatchObject({
      code: 'INPUT_TOO_LARGE',
    });
  });
});

describe('canonical JSON codec', () => {
  it('rejects a mechanically valid candidate for an unsupported segment kind', async () => {
    const codec = new JsonJcsCodec();
    const segment = createSegment({
      role: 'tool',
      kind: 'prose',
      equivalence: 'typed-semantic',
      mediaType: 'application/json',
      content: '{ "valid": true }',
    });
    const candidate = await codec.encode(segment, { policy: DEFAULT_POLICY });

    await expect(
      verifyCodecCandidate({
        codec,
        segment,
        candidate,
        policy: DEFAULT_POLICY,
      }),
    ).resolves.toEqual({
      verified: false,
      reasons: ['CODEC_NOT_APPLICABLE'],
    });
  });

  it('preserves typed equivalence while removing formatting and key-order variance', async () => {
    const codec = new JsonJcsCodec();
    const source = `{
      "z": 3,
      "nested": { "second": 2, "first": 1 },
      "list": [true, null, "value"]
    }`;
    const segment = createSegment({
      role: 'tool',
      kind: 'json-data',
      content: source,
    });
    const candidate = await codec.encode(segment, { policy: DEFAULT_POLICY });
    expect(decodeText(candidate.bytes)).toBe(
      '{"list":[true,null,"value"],"nested":{"first":1,"second":2},"z":3}',
    );
    const verification = await verifyCodecCandidate({
      codec,
      segment,
      candidate,
      policy: DEFAULT_POLICY,
    });
    expect(verification).toEqual({ verified: true, reasons: [] });
    expect(canonicalJson(parseStrictJson(decodeText(candidate.bytes)))).toBe(
      canonicalJson(parseStrictJson(source)),
    );
  });

  it('detects a typed value change even when the candidate remains valid JSON', async () => {
    const codec = new JsonJcsCodec();
    const segment = createSegment({
      role: 'tool',
      kind: 'json-data',
      content: '{"allowed":true,"count":7}',
    });
    const verification = await verifyCodecCandidate({
      codec,
      segment,
      candidate: {
        bytes: new TextEncoder().encode('{"allowed":false,"count":7}'),
      },
      policy: DEFAULT_POLICY,
    });
    expect(verification).toMatchObject({
      verified: false,
      reasons: expect.arrayContaining(['ENCODER_MISMATCH']),
    });
  });

  it('rejects duplicate keys, unsafe integers and excessive depth at encode time', async () => {
    const codec = new JsonJcsCodec();
    const policy = makePolicy({ limits: { maxDepth: 2 } });
    for (const source of [
      '{"duplicate":1,"duplicate":2}',
      '{"unsafe":9007199254740992}',
      '{"deep":[[[0]]]}',
    ]) {
      const segment = createSegment({
        role: 'tool',
        kind: 'json-data',
        content: source,
      });
      await expect(codec.encode(segment, { policy })).rejects.toMatchObject({
        code: 'FORMAT_UNSUPPORTED',
      });
    }
  });
});
