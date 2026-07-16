import {
  parseCacheHitWitnessDocument,
  parseNormalizationWitnessDocument,
} from './schemas.js';
import type { CacheHitWitness, NormalizationWitness } from './types.js';

const parsedNormalizationWitnesses = new WeakSet<object>();
const parsedCacheHitWitnesses = new WeakSet<object>();

/**
 * Parse and brand a private, immutable normalization snapshot.
 *
 * This module is intentionally not re-exported by the package. The WeakSet
 * brand is an unforgeable runtime capability, unlike a TypeScript type or an
 * `Object.isFrozen` check supplied by an untrusted caller.
 */
export function parseInternalNormalizationWitness(
  input: unknown,
): NormalizationWitness {
  const parsed = freezeParsedSnapshot(parseNormalizationWitnessDocument(input));
  parsedNormalizationWitnesses.add(parsed);
  return parsed;
}

/** Parse and brand a private, immutable cache-hit snapshot. */
export function parseInternalCacheHitWitness(input: unknown): CacheHitWitness {
  const parsed = freezeParsedSnapshot(parseCacheHitWitnessDocument(input));
  parsedCacheHitWitnesses.add(parsed);
  return parsed;
}

export function isInternalNormalizationWitness(
  input: unknown,
): input is NormalizationWitness {
  return (
    input !== null &&
    typeof input === 'object' &&
    parsedNormalizationWitnesses.has(input)
  );
}

export function isInternalCacheHitWitness(
  input: unknown,
): input is CacheHitWitness {
  return (
    input !== null &&
    typeof input === 'object' &&
    parsedCacheHitWitnesses.has(input)
  );
}

function freezeParsedSnapshot<Value>(value: Value): Value {
  const seen = new WeakSet<object>();
  const visit = (candidate: unknown): void => {
    if (candidate === null || typeof candidate !== 'object') return;
    if (seen.has(candidate)) {
      throw new TypeError('Strict parsed witness contains aliased state');
    }
    seen.add(candidate);

    const array = Array.isArray(candidate);
    const prototype = Reflect.getPrototypeOf(candidate);
    if (
      (array && prototype !== Array.prototype) ||
      (!array && prototype !== Object.prototype && prototype !== null)
    ) {
      throw new TypeError('Strict parsed witness has a custom prototype');
    }
    if (!array && !Reflect.setPrototypeOf(candidate, null)) {
      throw new TypeError('Strict parsed witness prototype cannot be sealed');
    }

    for (const key of Reflect.ownKeys(candidate)) {
      if (typeof key !== 'string') {
        throw new TypeError('Strict parsed witness contains symbol state');
      }
      const descriptor = Reflect.getOwnPropertyDescriptor(candidate, key);
      if (array && key === 'length') {
        if (
          descriptor === undefined ||
          descriptor.enumerable ||
          !Object.hasOwn(descriptor, 'value')
        ) {
          throw new TypeError('Strict parsed witness array is malformed');
        }
        continue;
      }
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, 'value')
      ) {
        throw new TypeError('Strict parsed witness contains non-data state');
      }
      visit(descriptor.value);
    }
    Object.freeze(candidate);
  };
  visit(value);
  return value;
}
