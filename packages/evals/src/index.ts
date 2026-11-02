/**
 * Lower bound of the Wilson score interval for a binomial proportion.
 * Shown next to every precision/rate so small samples don't look like certainty.
 */
export function wilsonLowerBound(successes: number, n: number, z = 1.96): number {
  if (n === 0) return 0;
  if (successes < 0 || successes > n) throw new RangeError("successes must be within [0, n]");
  const p = successes / n;
  const z2 = z * z;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Math.max(0, (centre - margin) / (1 + z2 / n));
}
