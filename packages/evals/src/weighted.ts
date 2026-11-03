import { wilsonLowerBound } from "./stats";

// Production audit precision (docs/architecture.md §6, §8). Each category's auto-approvals are
// audited at its own rate, so an audited item stands for 1 / audit_rate auto-approvals. The combined
// estimate weights items that way; its Wilson bound uses Kish's effective sample size, since
// unequal weights carry less information than the raw count suggests.

export interface WeightedOutcome {
  correct: boolean;
  weight: number;
}

export interface WeightedRate {
  /** Audited items. */
  n: number;
  /** Audited items judged correct (unweighted). */
  k: number;
  /** Σ w·correct / Σ w; null with no items. */
  rate: number | null;
  /** (Σw)² / Σw². */
  effectiveN: number;
  lower: number;
}

export function weightedPrecision(items: readonly WeightedOutcome[]): WeightedRate {
  const total = items.reduce((s, i) => s + i.weight, 0);
  const squares = items.reduce((s, i) => s + i.weight * i.weight, 0);
  const correct = items.reduce((s, i) => s + (i.correct ? i.weight : 0), 0);
  const p = total === 0 ? null : correct / total;
  const effectiveN = squares === 0 ? 0 : (total * total) / squares;
  return {
    n: items.length,
    k: items.filter((i) => i.correct).length,
    rate: p,
    effectiveN,
    lower: p === null ? 0 : wilsonLowerBound(Math.min(effectiveN, p * effectiveN), effectiveN),
  };
}
