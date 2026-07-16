/**
 * Exact one-sided 95% upper binomial bound for an independently sampled,
 * zero-failure experiment. Any observed failure is a hard fail for the alpha
 * contracts that use this helper, so the returned ceiling is one million ppm.
 */
export function zeroFailureUpperBound95Ppm(
  failures: number,
  trials: number,
): number | null {
  if (
    !Number.isSafeInteger(failures) ||
    !Number.isSafeInteger(trials) ||
    failures < 0 ||
    trials < 0 ||
    failures > trials
  ) {
    throw new TypeError('Binomial counts are invalid');
  }
  if (trials === 0) return null;
  if (failures > 0) return 1_000_000;
  return Math.ceil((1 - Math.pow(0.05, 1 / trials)) * 1_000_000);
}
