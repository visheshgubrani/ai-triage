import { type Rate, rate, type WeightedRate, weightedPrecision } from "@ai-triage/evals";
import { sql } from "drizzle-orm";
import type { TenantTx } from "./tenant-tx";

// The evals page's Production tab (docs/architecture.md §8): what the live pipeline cost, how fast
// it was, how much went to people, and how often audited auto-approvals were right. Aggregated in
// SQL over a time window; replayed calls are labeled, and "live" spend counts only mode = 'live'.

export interface ProductionWindow {
  since: Date;
  until: Date;
}

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

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export async function productionMetrics(tx: TenantTx, window: ProductionWindow): Promise<ProductionMetrics> {
  const since = window.since.toISOString();
  const until = window.until.toISOString();
  const inWindow = (column: string) =>
    sql`${sql.raw(column)} >= ${since}::timestamptz and ${sql.raw(column)} < ${until}::timestamptz`;
  const calls = sql`
    with calls as (
      select c.*, r.document_id, coalesce(cl.category, r.forced_category, 'unclassified') as category
      from llm_calls c
      join processing_runs r on r.id = c.processing_run_id
      left join classifications cl on cl.run_id = r.id
      where ${inWindow("c.created_at")}
    )`;

  const [spend] = (
    await tx.db.execute(sql`${calls}
      select count(*)::int as calls, coalesce(sum(cost_usd), 0) as recorded,
             coalesce(sum(cost_usd) filter (where mode = 'live'), 0) as live, coalesce(bool_or(mode = 'replay'), false) as replay
      from calls`)
  ).rows as { calls: number; recorded: string; live: string; replay: boolean }[];

  const costByDay = (
    await tx.db.execute(sql`${calls}
      select to_char(created_at at time zone 'UTC', 'YYYY-MM-DD') as day, category,
             count(distinct document_id)::int as documents, count(*)::int as calls,
             coalesce(sum(cost_usd), 0) as cost, coalesce(sum(cost_usd) filter (where mode = 'live'), 0) as live
      from calls group by 1, 2 order by 1, 2`)
  ).rows as { day: string; category: string; documents: number; calls: number; cost: string; live: string }[];

  const latency = (
    await tx.db.execute(sql`${calls}
      select stage, count(latency_ms) filter (where canonical)::int as n,
             percentile_disc(0.5) within group (order by latency_ms) filter (where canonical) as p50,
             percentile_disc(0.95) within group (order by latency_ms) filter (where canonical) as p95
      from calls group by stage order by stage`)
  ).rows as { stage: string; n: number; p50: number | null; p95: number | null }[];

  const [perDocument] = (
    await tx.db.execute(sql`${calls}
      select count(*)::int as n, avg(cost) as mean,
             percentile_disc(0.5) within group (order by cost) as p50,
             percentile_disc(0.95) within group (order by cost) as p95
      from (select document_id, sum(coalesce(cost_usd, 0)) as cost from calls group by document_id) d`)
  ).rows as { n: number; mean: string | null; p50: string | null; p95: string | null }[];

  const routing = (
    await tx.db.execute(sql`
      select category, count(*)::int as routed,
             count(*) filter (where decision = 'auto' and not ('audit_sample' = any(decision_reasons)))::int as auto,
             count(*) filter (where 'audit_sample' = any(decision_reasons))::int as audited,
             count(*) filter (where decision = 'review')::int as review
      from extractions
      where author = 'model' and decision is not null and ${inWindow("created_at")}
      group by category order by category`)
  ).rows as { category: string; routed: number; auto: number; audited: number; review: number }[];

  const [outside] = (
    await tx.db.execute(sql`
      select (select count(*)::int from classifications where category = 'other' and ${inWindow("created_at")}) as unclassified,
             (select count(*)::int from processing_runs where status = 'failed' and ${inWindow("created_at")}) as failed`)
  ).rows as { unclassified: number; failed: number }[];

  const corrections = (
    await tx.db.execute(sql`
      select x.category, count(*)::int as approvals, count(*) filter (where d.outcome = 'edit_approve')::int as corrected
      from review_decisions d join extractions x on x.id = d.extraction_id
      where d.outcome in ('approve', 'edit_approve') and ${inWindow("d.created_at")}
      group by x.category order by x.category`)
  ).rows as { category: string; approvals: number; corrected: number }[];

  // The first decision on each audit task is its verdict (a reclassify reopens it as a review task).
  // A user revision has no run; its parent (the model's revision) says which config, so which audit rate.
  const audits = (
    await tx.db.execute(sql`
      select distinct on (d.review_task_id) x.category, cc.audit_rate,
             (d.outcome = 'approve' or (d.outcome = 'edit_approve' and not exists (
                select 1 from jsonb_array_elements(coalesce(d.diff, '[]'::jsonb)) ch
                where coalesce(sv.json_schema -> 'required', '[]'::jsonb) ? (ch ->> 'field')))) as correct
      from review_decisions d
      join extractions x on x.id = d.extraction_id
      left join extractions px on px.id = x.parent_id
      join category_schema_versions sv on sv.id = x.schema_version_id
      left join processing_runs r on r.id = coalesce(x.run_id, px.run_id)
      left join pipeline_config_categories cc on cc.config_id = r.config_id and cc.category = x.category
      where d.task_kind = 'audit' and ${inWindow("d.created_at")}
      order by d.review_task_id, d.created_at`)
  ).rows as { category: string; audit_rate: string | null; correct: boolean }[];

  const auditCategories = [...new Set(audits.map((a) => a.category))].sort();
  const sum = (rows: { [k: string]: unknown }[], key: string) => rows.reduce((s, r) => s + Number(r[key] ?? 0), 0);
  return {
    replay: spend?.replay ?? false,
    spend: { calls: spend?.calls ?? 0, recordedUsd: Number(spend?.recorded ?? 0), liveUsd: Number(spend?.live ?? 0) },
    costByDay: costByDay.map((r) => ({ ...r, costUsd: Number(r.cost), liveUsd: Number(r.live) })),
    latencyByStage: latency.map((r) => ({ stage: r.stage, n: r.n, p50Ms: num(r.p50), p95Ms: num(r.p95) })),
    costPerDocument: {
      n: perDocument?.n ?? 0,
      meanUsd: num(perDocument?.mean),
      p50Usd: num(perDocument?.p50),
      p95Usd: num(perDocument?.p95),
    },
    routing: routing.map((r) => ({ ...r, reviewRate: rate(r.review, r.routed) })),
    reviewRate: rate(sum(routing, "review"), sum(routing, "routed")),
    unclassified: outside?.unclassified ?? 0,
    failed: outside?.failed ?? 0,
    corrections: corrections.map((r) => ({ category: r.category, correctionRate: rate(r.corrected, r.approvals) })),
    correctionRate: rate(sum(corrections, "corrected"), sum(corrections, "approvals")),
    audit: auditCategories.map((category) => {
      const ofCategory = audits.filter((a) => a.category === category);
      return {
        category,
        auditRate: num(ofCategory[0]?.audit_rate),
        precision: rate(ofCategory.filter((a) => a.correct).length, ofCategory.length),
      };
    }),
    // An item whose audit rate is unknown (or 0) counts once.
    auditPrecision: weightedPrecision(
      audits.map((a) => ({ correct: a.correct, weight: Number(a.audit_rate) > 0 ? 1 / Number(a.audit_rate) : 1 })),
    ),
  };
}
