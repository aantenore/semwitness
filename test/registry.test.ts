import { describe, expect, it } from 'vitest';

import { CodecRegistry } from '../src/application/codec-registry.js';
import type { Codec } from '../src/ports/codec.js';

function codec(id: string, version: string): Codec {
  return {
    descriptor: {
      id,
      version,
      deterministic: true,
      acceptedKinds: '*',
      equivalence: 'byte-exact',
    },
    async encode(segment) {
      return { bytes: new Uint8Array(segment.content) };
    },
    async decode(candidate) {
      return new Uint8Array(candidate.bytes);
    },
  };
}

describe('codec registry determinism', () => {
  it('uses code-unit ordering rather than locale ordering', () => {
    const registry = new CodecRegistry()
      .register(codec('a_', '1'))
      .register(codec('a-', '1'))
      .register(codec('a.', '1'));

    expect(registry.list().map((item) => item.descriptor.id)).toEqual([
      'a-',
      'a.',
      'a_',
    ]);
  });

  it('never guesses a latest version when policy names only an ID', () => {
    const registry = new CodecRegistry()
      .register(codec('ambiguous', '2'))
      .register(codec('ambiguous', '10'));

    expect(registry.resolve('ambiguous')).toBeUndefined();
    expect(registry.resolve('ambiguous', '2')?.descriptor.version).toBe('2');
    expect(registry.resolve('ambiguous', '10')?.descriptor.version).toBe('10');
    expect(registry.list().map((item) => item.descriptor.version)).toEqual([
      '10',
      '2',
    ]);
  });

  it('rejects malformed descriptors before they can collide in the registry', () => {
    const registry = new CodecRegistry();

    expect(() => registry.register(codec('contains@separator', '1'))).toThrow();
    expect(() =>
      registry.register(codec('valid-id', 'contains@separator')),
    ).toThrow();
  });
});
