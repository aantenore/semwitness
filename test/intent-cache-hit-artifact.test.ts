import { describe, expect, it } from 'vitest';

import { canonicalJson, toJsonValue } from '../src/domain/canonical-json.js';
import {
  MAX_CACHE_HIT_WITNESS_ARTIFACT_BYTES,
  digestCacheHitWitnessArtifact,
  parseCacheHitWitnessArtifact,
  serializeCacheHitWitnessArtifact,
  type CacheHitWitness,
  verifyCacheHitWitnessArtifact,
} from '../src/intent/index.js';
import { createQualifyingIntentPromotionFixture } from './support/intent-promotion-qualification-fixture.js';

let cachedWitness: CacheHitWitness | undefined;

function witness() {
  if (cachedWitness !== undefined) return cachedWitness;
  const candidate = createQualifyingIntentPromotionFixture().cases.find(
    (item) =>
      (item.kind === 'population-complete' ||
        item.kind === 'adversarial-complete') &&
      item.path.kind === 'candidate-bearing',
  );
  if (
    candidate === undefined ||
    (candidate.kind !== 'population-complete' &&
      candidate.kind !== 'adversarial-complete') ||
    candidate.path.kind !== 'candidate-bearing'
  ) {
    throw new TypeError('Expected a candidate-bearing fixture');
  }
  cachedWitness = candidate.path.cacheHitWitness;
  return cachedWitness;
}

describe('cache-hit witness artifacts', () => {
  it('serializes and verifies exact canonical bytes deterministically', () => {
    const expected = canonicalJson(toJsonValue(witness()));
    const serialized = serializeCacheHitWitnessArtifact(witness());

    expect(serialized).toBe(expected);
    expect(serialized.endsWith('\n')).toBe(false);
    expect(parseCacheHitWitnessArtifact(serialized)).toEqual(witness());
    expect(digestCacheHitWitnessArtifact(serialized)).toBe(
      verifyCacheHitWitnessArtifact(serialized).canonicalDigest,
    );
    expect(verifyCacheHitWitnessArtifact(serialized)).toMatchObject({
      canonical: true,
    });
    expect(verifyCacheHitWitnessArtifact(witness())).toMatchObject({
      canonical: null,
      payloadDigest: null,
    });
  });

  it('parses valid noncanonical bytes but reports their byte mismatch', () => {
    const serialized = serializeCacheHitWitnessArtifact(witness());
    const withLineFeed = `${serialized}\n`;
    const reordered = JSON.stringify(
      Object.fromEntries(Object.entries(JSON.parse(serialized)).reverse()),
    );

    expect(parseCacheHitWitnessArtifact(withLineFeed)).toEqual(witness());
    expect(verifyCacheHitWitnessArtifact(withLineFeed).canonical).toBe(false);
    expect(parseCacheHitWitnessArtifact(reordered)).toEqual(witness());
    expect(verifyCacheHitWitnessArtifact(reordered).canonical).toBe(false);
  });

  it('rejects duplicate keys, invalid UTF-8, and oversized payloads', () => {
    const serialized = serializeCacheHitWitnessArtifact(witness());
    const duplicate = serialized.replace('{"claim":', '{"claim":{},"claim":');

    expect(() => parseCacheHitWitnessArtifact(duplicate)).toThrow(
      /Cache-hit witness artifact is malformed/u,
    );
    expect(() => parseCacheHitWitnessArtifact(new Uint8Array([0xff]))).toThrow(
      /Cache-hit witness artifact is malformed/u,
    );
    expect(() =>
      parseCacheHitWitnessArtifact(
        ' '.repeat(MAX_CACHE_HIT_WITNESS_ARTIFACT_BYTES + 1),
      ),
    ).toThrow(/Cache-hit witness artifact is malformed/u);
  });
});
