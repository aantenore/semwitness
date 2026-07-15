import { compareCodeUnits } from '../domain/deterministic-order.js';
import { SemWitnessError } from '../domain/errors.js';
import {
  SAFE_IDENTIFIER_PATTERN,
  SAFE_VERSION_PATTERN,
  isEquivalenceLevel,
  isSegmentKind,
} from '../domain/types.js';
import type { Codec } from '../ports/codec.js';

export class CodecRegistry {
  readonly #codecs = new Map<string, Codec>();

  register(codec: Codec): this {
    validateDescriptor(codec);
    const key = codecKey(codec.descriptor.id, codec.descriptor.version);
    if (this.#codecs.has(key)) {
      throw new SemWitnessError(
        'MALFORMED_ENVELOPE',
        `Codec ${key} is already registered`,
      );
    }
    this.#codecs.set(key, codec);
    return this;
  }

  resolve(id: string, version?: string): Codec | undefined {
    if (version !== undefined) {
      return this.#codecs.get(codecKey(id, version));
    }
    const matches = [...this.#codecs.values()].filter(
      (codec) => codec.descriptor.id === id,
    );
    return matches.length === 1 ? matches[0] : undefined;
  }

  list(): readonly Codec[] {
    return [...this.#codecs.values()].sort((left, right) => {
      const id = compareCodeUnits(left.descriptor.id, right.descriptor.id);
      return id === 0
        ? compareCodeUnits(left.descriptor.version, right.descriptor.version)
        : id;
    });
  }
}

function codecKey(id: string, version: string): string {
  return JSON.stringify([id, version]);
}

function validateDescriptor(codec: Codec): void {
  const descriptor = codec?.descriptor;
  const validKinds =
    descriptor?.acceptedKinds === '*' ||
    (Array.isArray(descriptor?.acceptedKinds) &&
      descriptor.acceptedKinds.length > 0 &&
      descriptor.acceptedKinds.every(isSegmentKind));
  if (
    descriptor === undefined ||
    !SAFE_IDENTIFIER_PATTERN.test(descriptor.id) ||
    !SAFE_VERSION_PATTERN.test(descriptor.version) ||
    descriptor.deterministic !== true ||
    !validKinds ||
    !isEquivalenceLevel(descriptor.equivalence) ||
    (descriptor.decoderLegend !== undefined &&
      !(descriptor.decoderLegend instanceof Uint8Array))
  ) {
    throw new SemWitnessError(
      'MALFORMED_ENVELOPE',
      'Codec descriptor is invalid',
    );
  }
}
