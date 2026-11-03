import type { ResultRow } from "./metrics";
import { type Rate, rate, rateOf } from "./stats";

// Calibration (docs/architecture.md §8): on a calib run, how auto rate and auto-approval precision
// move with a category's threshold, and whether the score means what it says.

/**
 * Items that would auto-approve at some threshold: no error, a score, and nothing but the threshold
 * or the category's automation setting holding them back. The sweep simulates automation turned on.
 */
const SWEEPABLE = new Set(["below_threshold", "automation_off"]);
export const isSweepEligible = (row: ResultRow) =>
  !row.errorReason && row.score !== null && row.reasons.every((r) => SWEEPABLE.has(r));

export interface SweepPoint {
  threshold: number;
  /** Auto-approvals among the items predicted as this category. */
  autoRate: Rate;
  /** Correct auto-approvals (right category, every required field correct) among them. */
  precision: Rate;
}

export interface ThresholdSweep {
  category: string;
  /** Items predicted as this category. */
  n: number;
  eligible: number;
  /** The threshold the run's config used, if any. */
  current: number | null;
  /** One point per distinct eligible score (and the current threshold), ascending. */
  points: SweepPoint[];
}

export function thresholdSweep(
  rows: readonly ResultRow[],
  category: string,
  current: number | null = null,
): ThresholdSweep {
  const predicted = rows.filter((r) => r.predictedCategory === category && !r.errorReason);
  const eligible = predicted.filter(isSweepEligible);
  const thresholds = [...new Set([...eligible.map((r) => r.score ?? 0), ...(current === null ? [] : [current])])].sort(
    (a, b) => a - b,
  );
  return {
    category,
    n: predicted.length,
    eligible: eligible.length,
    current,
    points: thresholds.map((threshold) => {
      const autos = eligible.filter((r) => (r.score ?? 0) >= threshold);
      return {
        threshold,
        autoRate: rate(autos.length, predicted.length),
        precision: rateOf(autos, (r) => r.requiredCorrect),
      };
    }),
  };
}

export interface ReliabilityBucket {
  /** Inclusive lower and exclusive upper score bound (the last bucket includes 1). */
  from: number;
  to: number;
  n: number;
  categoryAccuracy: Rate;
  /** Right category and every required field correct. */
  correct: Rate;
}

export const RELIABILITY_BUCKETS = [0, 0.5, 0.7, 0.8, 0.9, 0.95, 1] as const;

/** Score bucket vs how often items in it were right: is a 0.95 really right 95% of the time? */
export function reliabilityTable(rows: readonly ResultRow[], category?: string): ReliabilityBucket[] {
  const scored = rows.filter(
    (r) => !r.errorReason && r.score !== null && (category === undefined || r.predictedCategory === category),
  );
  return RELIABILITY_BUCKETS.slice(0, -1).map((from, i) => {
    const to = RELIABILITY_BUCKETS[i + 1] ?? 1;
    const last = i === RELIABILITY_BUCKETS.length - 2;
    const inBucket = scored.filter(
      (r) => (r.score ?? 0) >= from && ((r.score ?? 0) < to || (last && (r.score ?? 0) <= to)),
    );
    return {
      from,
      to,
      n: inBucket.length,
      categoryAccuracy: rateOf(inBucket, (r) => r.categoryCorrect),
      correct: rateOf(inBucket, (r) => r.requiredCorrect),
    };
  });
}
