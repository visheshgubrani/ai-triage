import type { Rate } from "./stats";
import type { WeightedRate } from "./weighted";

// The shape of the evals page's Production tab (computed in SQL by @ai-triage/db's productionMetrics).

export interface ProductionMetrics {
  /** Any call in the window was served from a cassette: costs are recorded, not spent. */
  replay: boolean;
  spend: { calls: number; recordedUsd: number; liveUsd: number };
  /** Per UTC day and category (`unclassified` for runs that never got one). */
  costByDay: { day: string; category: string; documents: number; calls: number; costUsd: number; liveUsd: number }[];
  /** Canonical attempts only (the latency a document actually waited for). */
  latencyByStage: { stage: string; n: number; p50Ms: number | null; p95Ms: number | null }[];
  /** Every attempt of every run of a document, per document. */
  costPerDocument: { n: number; meanUsd: number | null; p50Usd: number | null; p95Usd: number | null };
  routing: {
    category: string;
    /** Model extractions that got a routing decision. */
    routed: number;
    /** Auto-approved and not held for audit. */
    auto: number;
    audited: number;
    review: number;
    reviewRate: Rate;
  }[];
  reviewRate: Rate;
  /** Documents classified `other` and runs that failed, which went to a human outside routing. */
  unclassified: number;
  failed: number;
  /** Approvals where the reviewer changed a value first. */
  corrections: { category: string; correctionRate: Rate }[];
  correctionRate: Rate;
  /**
   * Audited auto-approvals judged correct: approved without reclassifying and without editing a
   * required field (§6). Per category, and combined with each item weighted by 1 / audit rate.
   */
  audit: { category: string; auditRate: number | null; precision: Rate }[];
  auditPrecision: WeightedRate;
}
