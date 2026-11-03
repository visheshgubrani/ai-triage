import { type Decision, type LlmCallMode, type LlmStage, OTHER_CATEGORY } from "@ai-triage/core";
import type { FieldScores } from "./grade";
import { mean, percentile, type Rate, rate, rateOf } from "./stats";

// Run metrics (docs/architecture.md §8), computed from stored results and llm_calls rows. Every rate
// carries n and its Wilson lower bound. Errors count as wrong and as review (production would send
// them to a human as processing_failed).

/** One eval_results row, as the metrics read it. */
export interface ResultRow {
  itemId: string;
  expectedCategory: string;
  /** null when the run failed before classification finished. */
  predictedCategory: string | null;
  score: number | null;
  decision: Decision | null;
  reasons: readonly string[];
  categoryCorrect: boolean;
  requiredCorrect: boolean;
  fullyCorrect: boolean;
  fieldScores: FieldScores | null;
  errorReason: string | null;
}

/** One llm_calls row of an eval run (every attempt, not only canonical ones). */
export interface CallRow {
  itemId: string;
  stage: LlmStage;
  canonical: boolean;
  mode: LlmCallMode;
  /** null when the model had no price. */
  costUsd: number | null;
  latencyMs: number | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

/** The label a confusion matrix puts on a result: its predicted category, or `error`. */
export const ERROR_LABEL = "error";
export const predictedLabel = (row: ResultRow) => row.predictedCategory ?? ERROR_LABEL;
const isAuto = (row: ResultRow) => row.decision === "auto";

export interface CategoryScores {
  category: string;
  /** Items labeled with this category. */
  support: number;
  /** Items predicted as this category. */
  predicted: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
}

export interface ClassificationMetrics {
  accuracy: Rate;
  perCategory: CategoryScores[];
  /** counts[i][j]: items labeled `expected[i]` and predicted `predicted[j]`. */
  confusion: { expected: string[]; predicted: string[]; counts: number[][] };
}

const sortLabels = (labels: Iterable<string>) =>
  [...new Set(labels)].sort((a, b) => {
    const rank = (l: string) => (l === ERROR_LABEL ? 2 : l === OTHER_CATEGORY ? 1 : 0);
    return rank(a) - rank(b) || a.localeCompare(b);
  });

export function classificationMetrics(rows: readonly ResultRow[]): ClassificationMetrics {
  const expected = sortLabels(rows.map((r) => r.expectedCategory));
  const predicted = sortLabels(rows.map(predictedLabel));
  const counts = expected.map((e) =>
    predicted.map((p) => rows.filter((r) => r.expectedCategory === e && predictedLabel(r) === p).length),
  );
  const perCategory = sortLabels([...expected, ...predicted.filter((p) => p !== ERROR_LABEL)]).map((category) => {
    const support = rows.filter((r) => r.expectedCategory === category).length;
    const predictedAs = rows.filter((r) => predictedLabel(r) === category).length;
    const tp = rows.filter((r) => r.expectedCategory === category && predictedLabel(r) === category).length;
    const precision = predictedAs === 0 ? null : tp / predictedAs;
    const recall = support === 0 ? null : tp / support;
    const f1 =
      precision === null || recall === null || precision + recall === 0
        ? null
        : (2 * precision * recall) / (precision + recall);
    return { category, support, predicted: predictedAs, precision, recall, f1 };
  });
  return { accuracy: rateOf(rows, (r) => r.categoryCorrect), perCategory, confusion: { expected, predicted, counts } };
}

export interface FieldAccuracy {
  category: string;
  field: string;
  required: boolean;
  comparator: string;
  /** Labels that state a value (the rest expect null). */
  stated: number;
  correct: Rate;
  meanScore: number | null;
}

export interface ExtractionMetrics {
  /** Per field, over items whose category was predicted right and that were extracted without error. */
  perField: FieldAccuracy[];
  /** Over all items: right category and every required field correct. */
  requiredCorrect: Rate;
  /** Over all items: right category and every field correct. */
  fullyCorrect: Rate;
}

export function extractionMetrics(rows: readonly ResultRow[]): ExtractionMetrics {
  const graded = rows.filter((r) => r.categoryCorrect && !r.errorReason && r.fieldScores);
  const perField: FieldAccuracy[] = [];
  for (const category of sortLabels(graded.map((r) => r.expectedCategory))) {
    const ofCategory = graded.filter((r) => r.expectedCategory === category);
    const fields = [...new Set(ofCategory.flatMap((r) => Object.keys(r.fieldScores ?? {})))];
    for (const field of fields) {
      const scores = ofCategory.flatMap((r) => (r.fieldScores?.[field] ? [r.fieldScores[field]] : []));
      const first = scores[0];
      if (!first) continue;
      perField.push({
        category,
        field,
        required: first.required,
        comparator: first.comparator,
        stated: scores.filter((s) => s.stated).length,
        correct: rateOf(scores, (s) => s.correct),
        meanScore: mean(scores.map((s) => s.score)),
      });
    }
  }
  return {
    perField,
    requiredCorrect: rateOf(rows, (r) => r.requiredCorrect),
    fullyCorrect: rateOf(rows, (r) => r.fullyCorrect),
  };
}

export interface CategoryRouting {
  /** The predicted category (`error` for items that failed before classification). */
  category: string;
  n: number;
  autoRate: Rate;
  /** Correct auto-approvals (right category, every required field correct) among auto-approvals. */
  autoPrecision: Rate;
}

export interface RoutingMetrics {
  reviewRate: Rate;
  autoRate: Rate;
  autoPrecision: Rate;
  perCategory: CategoryRouting[];
  /** How often each gate or route reason (prefix before `:`) sent an item to review. */
  reasons: { reason: string; n: number }[];
}

export function routingMetrics(rows: readonly ResultRow[]): RoutingMetrics {
  const autos = rows.filter(isAuto);
  const perCategory = sortLabels(rows.map(predictedLabel)).map((category) => {
    const ofCategory = rows.filter((r) => predictedLabel(r) === category);
    const categoryAutos = ofCategory.filter(isAuto);
    return {
      category,
      n: ofCategory.length,
      autoRate: rate(categoryAutos.length, ofCategory.length),
      autoPrecision: rateOf(categoryAutos, (r) => r.requiredCorrect),
    };
  });
  const reasonCounts = new Map<string, number>();
  for (const row of rows) {
    if (isAuto(row)) continue;
    const reasons = row.errorReason ? [`error:${row.errorReason}`] : row.reasons;
    for (const reason of new Set(reasons.map((r) => (r.startsWith("error:") ? r : (r.split(":")[0] ?? r))))) {
      reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
    }
  }
  return {
    reviewRate: rateOf(rows, (r) => !isAuto(r)),
    autoRate: rate(autos.length, rows.length),
    autoPrecision: rateOf(autos, (r) => r.requiredCorrect),
    perCategory,
    reasons: [...reasonCounts]
      .map(([reason, n]) => ({ reason, n }))
      .sort((a, b) => b.n - a.n || a.reason.localeCompare(b.reason)),
  };
}

export interface Distribution {
  mean: number | null;
  p50: number | null;
  p95: number | null;
}

const distribution = (values: readonly number[]): Distribution => ({
  mean: mean(values),
  p50: percentile(values, 50),
  p95: percentile(values, 95),
});

const cacheHitRatio = (calls: readonly CallRow[]) => {
  const read = calls.reduce((s, c) => s + c.cacheReadInputTokens, 0);
  const total = calls.reduce((s, c) => s + c.inputTokens + c.cacheReadInputTokens + c.cacheCreationInputTokens, 0);
  return total === 0 ? null : read / total;
};

export interface StageCost {
  stage: LlmStage;
  /** Every attempt, including retries. */
  calls: number;
  costUsd: number;
  /** Canonical attempts only. */
  latencyMs: Distribution;
  cacheHitRatio: number | null;
}

export interface CostMetrics {
  /** Every attempt of the run: equals the sum of its llm_calls rows. */
  totalUsd: number;
  /** Only `mode = live` attempts: what was actually spent. */
  liveUsd: number;
  /** Any attempt was served from a cassette: costs are as recorded, latencies are recorded live latencies. */
  replay: boolean;
  calls: number;
  /** Attempts that are not canonical (retries, or repeats after a crash). */
  extraAttempts: number;
  /** Attempts with no price for their model (counted as $0). */
  unpriced: number;
  /** Cost of each item, all attempts, over every item (an item that made no call costs $0). */
  perItemUsd: Distribution;
  /** End-to-end model latency per item: the sum of its canonical attempts. */
  latencyMs: Distribution;
  cacheHitRatio: number | null;
  byStage: StageCost[];
}

export function costMetrics(rows: readonly ResultRow[], calls: readonly CallRow[]): CostMetrics {
  const cost = (cs: readonly CallRow[]) => cs.reduce((s, c) => s + (c.costUsd ?? 0), 0);
  const canonical = calls.filter((c) => c.canonical);
  const latencies = rows.flatMap((r) => {
    const own = canonical.filter((c) => c.itemId === r.itemId && c.latencyMs !== null);
    return own.length === 0 ? [] : [own.reduce((s, c) => s + (c.latencyMs ?? 0), 0)];
  });
  const stages = [...new Set(calls.map((c) => c.stage))].sort((a, b) =>
    a === "classify" ? -1 : b === "classify" ? 1 : 0,
  );
  return {
    totalUsd: cost(calls),
    liveUsd: cost(calls.filter((c) => c.mode === "live")),
    replay: calls.some((c) => c.mode === "replay"),
    calls: calls.length,
    extraAttempts: calls.length - canonical.length,
    unpriced: calls.filter((c) => c.costUsd === null).length,
    perItemUsd: distribution(rows.map((r) => cost(calls.filter((c) => c.itemId === r.itemId)))),
    latencyMs: distribution(latencies),
    cacheHitRatio: cacheHitRatio(calls),
    byStage: stages.map((stage) => {
      const ofStage = calls.filter((c) => c.stage === stage);
      return {
        stage,
        calls: ofStage.length,
        costUsd: cost(ofStage),
        latencyMs: distribution(
          ofStage.filter((c) => c.canonical && c.latencyMs !== null).map((c) => c.latencyMs ?? 0),
        ),
        cacheHitRatio: cacheHitRatio(ofStage),
      };
    }),
  };
}

/** The headline numbers of a run, cached in eval_runs.aggregates when it finishes. */
export interface RunSummary {
  n: number;
  errors: number;
  accuracy: Rate;
  requiredCorrect: Rate;
  autoRate: Rate;
  autoPrecision: Rate;
  totalUsd: number;
  liveUsd: number;
  perItemUsd: number | null;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  replay: boolean;
}

export interface RunMetrics {
  summary: RunSummary;
  classification: ClassificationMetrics;
  extraction: ExtractionMetrics;
  routing: RoutingMetrics;
  cost: CostMetrics;
}

export function runMetrics(rows: readonly ResultRow[], calls: readonly CallRow[]): RunMetrics {
  const classification = classificationMetrics(rows);
  const extraction = extractionMetrics(rows);
  const routing = routingMetrics(rows);
  const cost = costMetrics(rows, calls);
  return {
    summary: {
      n: rows.length,
      errors: rows.filter((r) => r.errorReason).length,
      accuracy: classification.accuracy,
      requiredCorrect: extraction.requiredCorrect,
      autoRate: routing.autoRate,
      autoPrecision: routing.autoPrecision,
      totalUsd: cost.totalUsd,
      liveUsd: cost.liveUsd,
      perItemUsd: cost.perItemUsd.mean,
      latencyP50Ms: cost.latencyMs.p50,
      latencyP95Ms: cost.latencyMs.p95,
      replay: cost.replay,
    },
    classification,
    extraction,
    routing,
    cost,
  };
}
