import { describe, expect, it } from "vitest";
import { diffRuns } from "./diff";
import { type CallRow, classificationMetrics, costMetrics, type ResultRow, routingMetrics } from "./metrics";
import { percentile } from "./stats";
import { isSweepEligible, reliabilityTable, thresholdSweep } from "./sweep";
import { weightedPrecision } from "./weighted";

let seq = 0;
const row = (overrides: Partial<ResultRow> = {}): ResultRow => ({
  itemId: `item-${++seq}`,
  expectedCategory: "invoice",
  predictedCategory: "invoice",
  score: 0.95,
  decision: "auto",
  reasons: [],
  categoryCorrect: true,
  requiredCorrect: true,
  fullyCorrect: true,
  fieldScores: {},
  errorReason: null,
  ...overrides,
});

const call = (itemId: string, overrides: Partial<CallRow> = {}): CallRow => ({
  itemId,
  stage: "classify",
  canonical: true,
  mode: "replay",
  costUsd: 0.001,
  latencyMs: 1000,
  inputTokens: 900,
  outputTokens: 100,
  cacheReadInputTokens: 100,
  cacheCreationInputTokens: 0,
  ...overrides,
});

describe("classification", () => {
  it("puts errors in their own column and counts them wrong", () => {
    const rows = [
      row(),
      row({ predictedCategory: "contract", categoryCorrect: false, requiredCorrect: false, fullyCorrect: false }),
      row({
        predictedCategory: null,
        categoryCorrect: false,
        requiredCorrect: false,
        decision: null,
        errorReason: "cassette_missing",
      }),
      row({ expectedCategory: "other", predictedCategory: "other", decision: "review" }),
    ];
    const m = classificationMetrics(rows);
    expect(m.accuracy).toMatchObject({ k: 2, n: 4 });
    expect(m.confusion.predicted).toEqual(["contract", "invoice", "other", "error"]);
    expect(m.confusion.counts[m.confusion.expected.indexOf("invoice")]).toEqual([1, 1, 0, 1]);
    const invoice = m.perCategory.find((c) => c.category === "invoice");
    expect(invoice).toMatchObject({ support: 3, predicted: 1, precision: 1, recall: 1 / 3 });
  });
});

describe("routing", () => {
  it("measures auto-approval precision on required-field correctness, by predicted category", () => {
    const rows = [
      row(),
      row({ requiredCorrect: false, fullyCorrect: false }),
      row({ decision: "review", reasons: ["below_threshold"] }),
      row({ decision: null, errorReason: "llm_refusal", requiredCorrect: false }),
    ];
    const m = routingMetrics(rows);
    expect(m.autoPrecision).toMatchObject({ k: 1, n: 2, rate: 0.5 });
    expect(m.reviewRate).toMatchObject({ k: 2, n: 4 });
    expect(m.reasons).toEqual([
      { reason: "below_threshold", n: 1 },
      { reason: "error:llm_refusal", n: 1 },
    ]);
    expect(m.autoPrecision.lower).toBeLessThan(0.5);
  });
});

describe("cost", () => {
  it("sums every attempt, counts live spend apart, and takes latency from canonical attempts", () => {
    const a = row();
    const b = row();
    const calls = [
      call(a.itemId),
      call(a.itemId, { stage: "extract", latencyMs: 3000, costUsd: 0.004 }),
      call(b.itemId, { canonical: false, latencyMs: 9999, mode: "live", costUsd: 0.002 }),
      call(b.itemId, { mode: "live", costUsd: null }),
    ];
    const m = costMetrics([a, b], calls);
    expect(m.totalUsd).toBeCloseTo(0.007);
    expect(m.liveUsd).toBeCloseTo(0.002);
    expect(m).toMatchObject({ replay: true, calls: 4, extraAttempts: 1, unpriced: 1 });
    expect(m.latencyMs).toMatchObject({ p50: 1000, p95: 4000 });
    expect(m.byStage.map((s) => s.stage)).toEqual(["classify", "extract"]);
    expect(m.cacheHitRatio).toBeCloseTo(0.1);
  });

  it("uses nearest-rank percentiles", () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(percentile([], 50)).toBeNull();
  });
});

describe("threshold sweep", () => {
  it("only sweeps items that nothing but the threshold or automation held back", () => {
    expect(isSweepEligible(row({ decision: "review", reasons: ["below_threshold"] }))).toBe(true);
    expect(isSweepEligible(row({ decision: "review", reasons: ["automation_off"] }))).toBe(true);
    expect(isSweepEligible(row({ decision: "review", reasons: ["below_threshold", "required_missing:total"] }))).toBe(
      false,
    );
    expect(isSweepEligible(row({ errorReason: "llm_refusal" }))).toBe(false);
  });

  it("trades auto rate against precision", () => {
    const rows = [
      row({ score: 0.99 }),
      row({ score: 0.97 }),
      row({ score: 0.9, decision: "review", reasons: ["below_threshold"], requiredCorrect: false }),
      row({ score: 0.8, decision: "review", reasons: ["uncertain:total"] }),
      row({ predictedCategory: "contract", score: 0.99 }),
    ];
    const sweep = thresholdSweep(rows, "invoice", 0.95);
    expect(sweep).toMatchObject({ n: 4, eligible: 3, current: 0.95 });
    expect(sweep.points.map((p) => p.threshold)).toEqual([0.9, 0.95, 0.97, 0.99]);
    expect(sweep.points[0]).toMatchObject({ autoRate: { k: 3, n: 4 }, precision: { k: 2, n: 3 } });
    expect(sweep.points[1]).toMatchObject({ autoRate: { k: 2, n: 4 }, precision: { k: 2, n: 2 } });
  });

  it("buckets scores for the reliability table", () => {
    const table = reliabilityTable([
      row({ score: 1 }),
      row({ score: 0.95, categoryCorrect: false }),
      row({ score: 0.3 }),
    ]);
    expect(table.at(-1)).toMatchObject({ from: 0.95, to: 1, n: 2, categoryAccuracy: { k: 1, n: 2 } });
    expect(table[0]).toMatchObject({ n: 1 });
  });
});

describe("diffRuns", () => {
  it("lists regressions first, matched by item", () => {
    const same = row();
    const fixed = row({ categoryCorrect: false, requiredCorrect: false, predictedCategory: "contract" });
    const broken = row();
    const a = [same, fixed, broken, row()];
    const b = [
      same,
      { ...fixed, categoryCorrect: true, requiredCorrect: true, predictedCategory: "invoice" },
      { ...broken, requiredCorrect: false, fullyCorrect: false },
    ];
    const diff = diffRuns(a, b);
    expect(diff).toMatchObject({ shared: 3, onlyA: 1, onlyB: 0, regressions: 1, improvements: 1 });
    expect(diff.changes[0]).toMatchObject({ itemId: broken.itemId, kind: "regression" });
    expect(diff.changes[0]?.notes[0]).toBe("now a wrong auto-approval");
    expect(diff.changes[1]?.notes).toContain("category contract → invoice");
  });
});

describe("weightedPrecision", () => {
  it("weights each audited item by 1 / audit rate, with Kish's effective n", () => {
    // Invoices audited at 10% (each stands for 10 auto-approvals), contracts at 50%.
    const items = [
      { correct: true, weight: 10 },
      { correct: true, weight: 10 },
      { correct: false, weight: 2 },
      { correct: true, weight: 2 },
    ];
    const w = weightedPrecision(items);
    expect(w.rate).toBeCloseTo(22 / 24);
    expect(w.effectiveN).toBeCloseTo(24 ** 2 / 208);
    expect(w.lower).toBeLessThan(w.rate ?? 0);
    expect(weightedPrecision([])).toMatchObject({ n: 0, rate: null, lower: 0 });
  });
});
