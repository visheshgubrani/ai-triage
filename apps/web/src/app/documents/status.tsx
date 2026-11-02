import type { DocumentSummary } from "@ai-triage/contracts";

const TONES: Record<string, string> = {
  done: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  delivered: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  auto: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  failed: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  pending: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  review: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
};
const NEUTRAL = "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300";

export function Badge({ value }: { value: string | null }) {
  if (!value) return <span className="text-neutral-400">-</span>;
  return <span className={`rounded px-1.5 py-0.5 font-mono text-xs ${TONES[value] ?? NEUTRAL}`}>{value}</span>;
}

/** The pipeline step a document is at, or its outcome. */
export function stateOf(d: Pick<DocumentSummary, "processingStatus" | "reviewStatus" | "deliveryStatus" | "decision">) {
  if (d.processingStatus === "failed") return "failed";
  if (d.processingStatus !== "done") return d.processingStatus;
  if (d.reviewStatus === "pending") return "review";
  if (d.decision === "auto") return "auto";
  return d.reviewStatus;
}
