import type { DocumentSummary } from "@ai-triage/contracts";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type Tone = "success" | "warning" | "danger" | "info" | "accent" | "neutral";

const TONE_CLASS: Record<Tone, string> = {
  success: "bg-success-muted text-success",
  warning: "bg-warning-muted text-warning",
  danger: "bg-danger-muted text-danger",
  info: "bg-info-muted text-info",
  accent: "bg-accent text-accent-foreground",
  neutral: "bg-muted text-muted-foreground",
};

/** A small status pill. Colour is never alone: the text says the same thing. */
export function Pill({
  tone = "neutral",
  dot = false,
  className,
  title,
  children,
}: {
  tone?: Tone;
  dot?: boolean;
  className?: string;
  title?: string;
  children: ReactNode;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex h-5 w-fit items-center gap-1.5 rounded-full px-2 text-xs font-medium whitespace-nowrap",
        TONE_CLASS[tone],
        className,
      )}
    >
      {dot && <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-current" />}
      {children}
    </span>
  );
}

const TONES: Record<string, Tone> = {
  done: "success",
  delivered: "success",
  auto: "success",
  approved: "success",
  edited: "success",
  verified: "success",
  failed: "danger",
  rejected: "danger",
  not_found: "danger",
  pending: "warning",
  review: "warning",
  "audit sample": "warning",
  audit: "warning",
  unclassified: "warning",
  received: "info",
  parsing: "info",
  parsed: "info",
  classifying: "info",
  classified: "info",
  extracting: "info",
  extracted: "info",
  running: "info",
  queued: "info",
};

export function Badge({ value }: { value: string | null }) {
  if (!value) return <span className="text-muted-foreground">-</span>;
  return (
    <Pill dot tone={TONES[value] ?? "neutral"}>
      {value}
    </Pill>
  );
}

/** The pipeline step a document is at, or its outcome. */
export function stateOf(d: Pick<DocumentSummary, "processingStatus" | "reviewStatus" | "deliveryStatus" | "decision">) {
  if (d.processingStatus === "failed") return "failed";
  if (d.processingStatus !== "done") return d.processingStatus;
  if (d.reviewStatus === "pending") return "review";
  if (d.decision === "auto") return "auto";
  return d.reviewStatus;
}
