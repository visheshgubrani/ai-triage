/**
 * Lower bound of the Wilson score interval for a binomial proportion.
 * Shown next to every precision/rate so small samples don't look like certainty.
 * Accepts non-integer counts, for a weighted rate with its effective sample size.
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

/** A rate as every eval number is shown: k of n, the point estimate, and its 95% Wilson lower bound. */
export interface Rate {
  k: number;
  n: number;
  /** null when n is 0. */
  rate: number | null;
  lower: number;
}

export const rate = (k: number, n: number): Rate => ({
  k,
  n,
  rate: n === 0 ? null : k / n,
  lower: wilsonLowerBound(k, n),
});

/** Counts the items matching `predicate` among `items`, as a Rate. */
export const rateOf = <T>(items: readonly T[], predicate: (item: T) => boolean): Rate =>
  rate(items.filter(predicate).length, items.length);

export function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Nearest-rank percentile (p in 0..100): always one of the observed values. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] ?? null;
}
