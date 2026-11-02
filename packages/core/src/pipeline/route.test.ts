import { describe, expect, it } from "vitest";
import { auditDraw, type RouteInput, route } from "./route";

const base: RouteInput = {
  gateReasons: [],
  score: 0.95,
  policy: { threshold: 0.9, automation: "auto_when_confident", auditRate: 0.1 },
  trigger: "ingest",
  auditDraw: 0.5,
  action: { documentId: "d", extractionId: "e", category: "invoice", values: { total: 5, po_number: null } },
};

describe("route", () => {
  it("auto-approves when every condition holds, with a proposed action that drops nulls", () => {
    expect(route(base)).toEqual({
      decision: "auto",
      audit: false,
      reasons: [],
      proposedAction: {
        type: "webhook",
        event: "document.approved",
        document_id: "d",
        extraction_id: "e",
        category: "invoice",
        fields: { total: 5 },
      },
    });
  });

  it.each([
    [{ gateReasons: ["required_missing:total"] }, ["required_missing:total"]],
    [{ score: 0.89 }, ["below_threshold"]],
    [{ score: null }, ["no_score"]],
    [{ policy: { ...base.policy, automation: "review_all" as const } }, ["automation_off"]],
    [{ trigger: "reclassify" as const, score: 0.99 }, ["reclassify_run"]],
  ])("sends to review: %o", (override, reasons) => {
    expect(route({ ...base, ...override })).toMatchObject({ decision: "review", audit: false, reasons });
  });

  it("holds an auto decision for audit when the draw falls below the audit rate", () => {
    expect(route({ ...base, auditDraw: 0.05 })).toMatchObject({
      decision: "auto",
      audit: true,
      reasons: ["audit_sample"],
    });
    expect(route({ ...base, auditDraw: 0.05, policy: { ...base.policy, auditRate: 0 } }).audit).toBe(false);
  });

  it("draws audits deterministically per document and run, uniformly in [0, 1)", () => {
    expect(auditDraw("d", "r")).toBe(auditDraw("d", "r"));
    const draws = Array.from({ length: 2000 }, (_, i) => auditDraw("doc", `run-${i}`));
    expect(Math.min(...draws)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...draws)).toBeLessThan(1);
    const share = draws.filter((d) => d < 0.1).length / draws.length;
    expect(share).toBeGreaterThan(0.07);
    expect(share).toBeLessThan(0.13);
  });
});
