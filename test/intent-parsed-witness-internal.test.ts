import { describe, expect, it } from 'vitest';

import { sha256 } from '../src/domain/hash.js';
import {
  parseNormalizationWitness,
  verifyCacheHitWitnessIntegrity,
  verifyNormalizationWitnessIntegrity,
} from '../src/intent/index.js';
import * as publicIntent from '../src/intent/index.js';
import {
  isInternalCacheHitWitness,
  isInternalNormalizationWitness,
  parseInternalCacheHitWitness,
  parseInternalNormalizationWitness,
} from '../src/intent/parsed-witness-internal.js';
import type {
  CacheHitWitness,
  NormalizationWitness,
} from '../src/intent/types.js';
import {
  createDistinctIntentPromotionFixture,
  createUnsafeHitIntentPromotionFixture,
} from './support/intent-promotion-qualification-fixture.js';

function candidateWitnesses(): {
  readonly normalization: NormalizationWitness;
  readonly cacheHit: CacheHitWitness;
} {
  const item = createUnsafeHitIntentPromotionFixture().cases[0];
  if (
    item?.kind !== 'population-complete' ||
    item.path.kind !== 'candidate-bearing'
  ) {
    throw new TypeError('Candidate fixture shape changed');
  }
  return {
    normalization: item.path.normalizationWitness,
    cacheHit: item.path.cacheHitWitness,
  };
}

function unrelatedNormalization(): NormalizationWitness {
  const item =
    createDistinctIntentPromotionFixture('candidate-bypass').cases[0];
  if (
    item?.kind !== 'adversarial-complete' ||
    item.path.kind !== 'candidate-bearing'
  ) {
    throw new TypeError('Distinct fixture shape changed');
  }
  return item.path.normalizationWitness;
}

describe('private parsed-witness capability', () => {
  it('brands only private strict snapshots and freezes them transitively', () => {
    const source = candidateWitnesses();
    const normalization = parseInternalNormalizationWitness(
      source.normalization,
    );
    const cacheHit = parseInternalCacheHitWitness(source.cacheHit);

    expect(isInternalNormalizationWitness(normalization)).toBe(true);
    expect(isInternalCacheHitWitness(cacheHit)).toBe(true);
    expect(Object.isFrozen(normalization)).toBe(true);
    expect(Object.isFrozen(normalization.assessment)).toBe(true);
    expect(Object.isFrozen(normalization.candidateEvidence)).toBe(true);
    expect(Object.getPrototypeOf(normalization)).toBeNull();
    expect(Object.getPrototypeOf(normalization.assessment)).toBeNull();
    expect(Object.isFrozen(cacheHit)).toBe(true);
    expect(Object.isFrozen(cacheHit.entry.binding.scope)).toBe(true);
    expect(Object.getPrototypeOf(cacheHit)).toBeNull();
    expect(Object.getPrototypeOf(cacheHit.entry.binding.scope)).toBeNull();
    expect(() => {
      (
        normalization.assessment as {
          confidencePpm: number;
        }
      ).confidencePpm = 0;
    }).toThrow(TypeError);

    expect(isInternalNormalizationWitness({ ...normalization })).toBe(false);
    expect(isInternalNormalizationWitness(new Proxy(normalization, {}))).toBe(
      false,
    );
    expect(isInternalCacheHitWitness({ ...cacheHit })).toBe(false);
    expect(publicIntent).not.toHaveProperty(
      'parseInternalNormalizationWitness',
    );
    expect(publicIntent).not.toHaveProperty('parseInternalCacheHitWitness');
  });

  it('still rejects forged digests, unrelated witnesses, and mutated public parses', () => {
    const source = candidateWitnesses();
    const normalization = parseInternalNormalizationWitness(
      source.normalization,
    );
    const cacheHit = parseInternalCacheHitWitness(source.cacheHit);

    const forgedNormalization = parseInternalNormalizationWitness(
      Object.freeze({
        ...source.normalization,
        witnessDigest: sha256('forged-normalization'),
      }),
    );
    expect(verifyNormalizationWitnessIntegrity(forgedNormalization)).toEqual({
      verified: false,
      reasons: ['INTENT_WITNESS_TAMPERED'],
    });

    const forgedCacheHit = parseInternalCacheHitWitness(
      Object.freeze({
        ...source.cacheHit,
        witnessDigest: sha256('forged-cache-hit'),
      }),
    );
    expect(
      verifyCacheHitWitnessIntegrity(forgedCacheHit, normalization),
    ).toMatchObject({
      verified: false,
      reasons: expect.arrayContaining(['CACHE_WITNESS_TAMPERED']),
    });
    expect(verifyCacheHitWitnessIntegrity(forgedCacheHit, null)).toEqual({
      verified: false,
      reasons: [
        'CACHE_WITNESS_TAMPERED',
        'INTENT_MALFORMED',
        'CACHE_NORMALIZATION_WITNESS_INVALID',
      ],
    });

    const unrelated = parseInternalNormalizationWitness(
      unrelatedNormalization(),
    );
    expect(verifyCacheHitWitnessIntegrity(cacheHit, unrelated)).toMatchObject({
      verified: false,
      reasons: expect.arrayContaining(['CACHE_NORMALIZATION_WITNESS_INVALID']),
    });

    const publicParsed = parseNormalizationWitness(source.normalization);
    expect(isInternalNormalizationWitness(publicParsed)).toBe(false);
    (
      publicParsed.assessment as {
        confidencePpm: number;
      }
    ).confidencePpm = 1;
    expect(verifyNormalizationWitnessIntegrity(publicParsed)).toEqual({
      verified: false,
      reasons: ['INTENT_WITNESS_TAMPERED'],
    });
  });

  it('keeps accessors, cycles, custom prototypes, and raw fields outside the capability', () => {
    const source = candidateWitnesses().normalization;
    let reads = 0;
    const accessor = structuredClone(source);
    Object.defineProperty(accessor.assessment, 'confidencePpm', {
      configurable: true,
      enumerable: true,
      get() {
        reads += 1;
        return 990_000;
      },
    });
    expect(() => parseInternalNormalizationWitness(accessor)).toThrow();
    expect(reads).toBe(0);

    const cyclic = structuredClone(source) as NormalizationWitness & {
      cycle?: unknown;
    };
    cyclic.cycle = cyclic;
    expect(() => parseInternalNormalizationWitness(cyclic)).toThrow();

    const customPrototype = structuredClone(source);
    Object.setPrototypeOf(customPrototype, { untrusted: true });
    expect(() => parseInternalNormalizationWitness(customPrototype)).toThrow();

    expect(() =>
      parseInternalNormalizationWitness({
        ...source,
        rawUtterance: 'must never enter evidence',
      }),
    ).toThrow();
  });
});
