import { describe, expect, it } from 'vitest';

import { zeroFailureGateUpperBound95Ppm } from '../src/eval/binomial.js';

describe('zero-failure binomial gate', () => {
  it('matches the predeclared plan and response boundaries', () => {
    expect(zeroFailureGateUpperBound95Ppm(0, 0)).toBeNull();
    expect(zeroFailureGateUpperBound95Ppm(0, 2_994)).toBe(1_001);
    expect(zeroFailureGateUpperBound95Ppm(0, 2_995)).toBe(1_000);
    expect(zeroFailureGateUpperBound95Ppm(0, 29_955)).toBe(101);
    expect(zeroFailureGateUpperBound95Ppm(0, 29_956)).toBe(100);
  });

  it('uses a hard-fail sentinel after any observed failure', () => {
    expect(zeroFailureGateUpperBound95Ppm(1, 29_956)).toBe(1_000_000);
  });

  it('remains stable for the full safe-integer trial domain', () => {
    expect(zeroFailureGateUpperBound95Ppm(0, 1)).toBe(950_000);
    expect(zeroFailureGateUpperBound95Ppm(0, Number.MAX_SAFE_INTEGER)).toBe(1);
  });

  it.each([
    [-1, 1],
    [0, -1],
    [2, 1],
    [0.5, 1],
    [0, Number.MAX_SAFE_INTEGER + 1],
  ])('rejects invalid counts (%s, %s)', (failures, trials) => {
    expect(() => zeroFailureGateUpperBound95Ppm(failures, trials)).toThrowError(
      'Binomial counts are invalid',
    );
  });
});
