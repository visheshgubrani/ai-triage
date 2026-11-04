import { sql } from "drizzle-orm";
import { getBudget } from "./budget";
import { liveWorkers } from "./heartbeats";
import type { Db } from "./index";
import { activeCooldowns } from "./provider-state";
import type { TenantTx } from "./tenant-tx";

// The System health page (docs/operations.md): one tenant's view of its own pipeline, plus the
// deployment facts every tenant shares (are workers running, is a model cooling down), which say
// nothing about other tenants' data.

export async function tenantHealth(tx: TenantTx, now: Date) {
  const statuses = await tx.db.execute<{ status: string; n: number; oldest: string | null }>(sql`
    select processing_status as status, count(*)::int as n,
           min(updated_at) filter (where processing_status in ('received', 'parsed', 'classified', 'extracted')) as oldest
    from documents group by processing_status`);
  const failures = await tx.db.execute<{ reason: string; n: number }>(sql`
    select reason, count(*)::int as n from review_tasks, unnest(reasons) as reason
    where kind = 'processing_failed' and status <> 'resolved' group by reason order by n desc`);
  const since = new Date(now.getTime() - 24 * 3600_000).toISOString();
  const [recent] = (
    await tx.db.execute<{ failed: number; stalled: number }>(sql`
      select count(*)::int as failed, count(*) filter (where error like 'stalled%')::int as stalled
      from processing_runs where status = 'failed' and finished_at >= ${since}::timestamptz`)
  ).rows;
  const [delivery] = (
    await tx.db.execute<{ pending: number; failed: number; oldest: string | null }>(sql`
      select count(*) filter (where status = 'pending')::int as pending,
             count(*) filter (where status = 'failed')::int as failed,
             min(created_at) filter (where status = 'pending') as oldest
      from actions`)
  ).rows;
  const mailboxes = await tx.db.execute<{ status: string; n: number }>(sql`
    select status, count(*)::int as n from mailbox_connections group by status`);
  const budget = await getBudget(tx, now);
  const iso = (v: string | null | undefined) => (v ? new Date(v).toISOString() : null);
  return {
    documents: statuses.rows.map((r) => ({ status: r.status, count: r.n, oldestUpdatedAt: iso(r.oldest) })),
    openFailures: failures.rows.map((r) => ({ reason: r.reason, count: r.n })),
    last24h: { failedRuns: recent?.failed ?? 0, stalledRuns: recent?.stalled ?? 0 },
    delivery: {
      pending: delivery?.pending ?? 0,
      failed: delivery?.failed ?? 0,
      oldestPendingAt: iso(delivery?.oldest),
    },
    mailboxes: mailboxes.rows.map((r) => ({ status: r.status, count: r.n })),
    budget,
  };
}

/** Facts about the deployment every member may see: running workers and model cooldowns. */
export async function deploymentHealth(db: Db, now: Date) {
  const workers = await liveWorkers(db, now);
  const cooling = await activeCooldowns(db, now);
  return {
    workers: workers.map((w) => ({ version: w.version, llmMode: w.llmMode, lastSeenAt: w.lastSeenAt.toISOString() })),
    cooldowns: cooling.map((c) => ({
      provider: c.provider,
      model: c.model,
      until: c.cooldownUntil.toISOString(),
      reason: c.reason,
    })),
  };
}

/** For the header: is anything stopping documents from being processed right now? */
export async function blockingProblems(tx: TenantTx, db: Db, now: Date) {
  const [workers, budget, waiting] = await Promise.all([
    liveWorkers(db, now),
    getBudget(tx, now),
    tx.db.execute<{ n: number }>(sql`
      select count(*)::int as n from review_tasks
      where kind = 'processing_failed' and status <> 'resolved' and 'budget_exhausted' = any(reasons)`),
  ]);
  return {
    workersRunning: workers.length,
    budgetExhausted: budget.capUsd > 0 && budget.spentUsd + budget.reservedUsd >= budget.capUsd,
    budgetWaiting: waiting.rows[0]?.n ?? 0,
  };
}
