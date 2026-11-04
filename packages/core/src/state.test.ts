import { describe, expect, it } from "vitest";
import {
  type DocumentState,
  documentState,
  PROCESSING_STATUSES,
  type ProcessingStatus,
  type ReviewStatus,
} from "./index";

describe("documentState", () => {
  const cases: [ProcessingStatus, ReviewStatus, DocumentState][] = [
    ["received", "not_required", "processing"],
    ["extracted", "not_required", "processing"],
    ["failed", "pending", "failed"],
    ["skipped", "not_required", "skipped"],
    ["done", "pending", "needs_review"],
    ["done", "approved", "approved"],
    // Auto-approved: the route stage leaves review not_required.
    ["done", "not_required", "approved"],
    ["done", "rejected", "rejected"],
  ];
  it.each(cases)("%s + %s is %s", (processingStatus, reviewStatus, state) => {
    expect(documentState({ processingStatus, reviewStatus })).toBe(state);
  });

  it("calls every unfinished status processing", () => {
    const unfinished = PROCESSING_STATUSES.filter((s) => !["done", "failed", "skipped"].includes(s));
    for (const s of unfinished)
      expect(documentState({ processingStatus: s, reviewStatus: "not_required" })).toBe("processing");
  });
});
