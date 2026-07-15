import type { Codec } from '../../ports/codec.js';

export class IdentityCodec implements Codec {
  readonly descriptor = {
    id: 'identity',
    version: '1',
    deterministic: true,
    acceptedKinds: '*',
    equivalence: 'byte-exact',
  } as const;

  async encode(segment: Parameters<Codec['encode']>[0]) {
    return {
      bytes: new Uint8Array(segment.content),
    } as const;
  }

  async decode(candidate: Parameters<Codec['decode']>[0]) {
    return new Uint8Array(candidate.bytes);
  }
}
