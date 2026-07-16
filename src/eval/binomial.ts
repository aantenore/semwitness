/**
 * Conservative ppm ceiling for the exact Clopper-Pearson one-sided 95% upper
 * bound when an independently sampled Bernoulli experiment observes zero
 * failures. An observed failure returns the alpha contract's hard-fail sentinel
 * rather than a general non-zero-failure confidence interval.
 */
export function zeroFailureGateUpperBound95Ppm(
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
  return Math.ceil(-Math.expm1(Math.log(0.05) / trials) * 1_000_000);
}
