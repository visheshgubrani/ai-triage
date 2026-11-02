// Pipeline stages and statuses. See docs/architecture.md §5 for transitions.
// Everything in this package stays pure: I/O happens through ports passed in
// by the api/worker (production) or the eval runner (which gets no action port).

export const PIPELINE_STAGES = ["parse", "classify", "extract", "route"] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export type ProcessingStatus = "received" | "parsed" | "classified" | "extracted" | "done" | "failed";
export type ReviewStatus = "not_required" | "pending" | "approved" | "rejected";
export type DeliveryStatus = "none" | "pending" | "delivered" | "failed";

export type ReviewTaskKind = "review" | "audit" | "processing_failed" | "unclassified";
export type ReviewAction = "approve" | "edit_approve" | "reclassify" | "reject" | "retry";

export const ACTIONS_BY_TASK_KIND: Record<ReviewTaskKind, readonly ReviewAction[]> = {
  processing_failed: ["retry", "reject"],
  unclassified: ["reclassify", "reject"],
  review: ["approve", "edit_approve", "reclassify", "reject"],
  audit: ["approve", "edit_approve", "reclassify", "reject"],
};
