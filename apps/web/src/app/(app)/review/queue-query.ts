import { type ClaimNextRequest, INBOX_AGES, type InboxAge } from "@ai-triage/contracts";
import { REVIEW_TASK_KINDS, type ReviewTaskKind } from "@ai-triage/core";

export type QueueView = "open" | "failed" | "delivery";
export type QueueFilters = {
  kind?: ReviewTaskKind;
  category?: string;
  reason?: string;
  olderThan?: InboxAge;
  mine?: boolean;
};
/** Where a reviewer is in the queue: its view and filters, kept in the URL and carried to each task. */
export type QueueContext = { view: QueueView; filters: QueueFilters };

type SearchParams = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;
const oneOf = <T extends string>(list: readonly T[], v: string | undefined) =>
  list.includes(v as T) ? (v as T) : undefined;

export function parseQueue(params: SearchParams): QueueContext {
  return {
    view: oneOf(["open", "failed", "delivery"] as const, one(params.view)) ?? "open",
    filters: {
      kind: oneOf(REVIEW_TASK_KINDS, one(params.kind)),
      category: one(params.category),
      reason: one(params.reason),
      olderThan: oneOf(INBOX_AGES, one(params.olderThan)),
      mine: one(params.mine) === "1" || undefined,
    },
  };
}

/** Why a task page went back to the queue: a decision left nothing to claim, or a skip found nothing else. */
export type QueueEnd = "cleared" | "skipped";

/** `?view=…&category=…`, or "" for the plain queue. `end` marks a return from a task with nothing left. */
export function queueQuery({ view, filters }: QueueContext, extra: { end?: QueueEnd } = {}): string {
  const p = new URLSearchParams();
  if (view !== "open") p.set("view", view);
  for (const key of ["kind", "category", "reason", "olderThan"] as const) {
    const value = filters[key];
    if (value) p.set(key, value);
  }
  if (filters.mine) p.set("mine", "1");
  if (extra.end) p.set("end", extra.end);
  const query = p.toString();
  return query ? `?${query}` : "";
}

/** What claim-next takes in this context: the next task is the oldest free one the queue shows. */
export function claimFilter({ view, filters }: QueueContext): ClaimNextRequest {
  return {
    kind: view === "failed" ? "processing_failed" : filters.kind,
    category: filters.category,
    reason: filters.reason,
    olderThan: filters.olderThan,
  };
}
