import {
  createDb,
  type Pool,
  reconcileAction,
  reconcileDocument,
  reconcileEvalRun,
  type StaleKind,
  staleWork,
  withTenantTx,
} from "@ai-triage/db";
import { log } from "../observe";

// `system.reconcile`, every five minutes (docs/architecture.md §5, self-healing): candidates older
// than `stallMinutes`, each checked against pg-boss in its tenant's transaction. Only work no job
// will ever pick up is failed, so it shows in Processing failed, Delivery failures or the evals page.

export interface ReconcileDeps {
  pool: Pool;
  now: () => Date;
  /** How long work may sit unchanged before it's checked (at least 15 minutes). */
  stallMinutes: number;
}

export async function reconcile(deps: ReconcileDeps): Promise<Record<StaleKind, number>> {
  const now = deps.now();
  // Past the longest legitimate wait: a stage's expiry plus its retry backoff.
  const before = new Date(now.getTime() - Math.max(15, deps.stallMinutes) * 60_000);
  const failed: Record<StaleKind, number> = { document: 0, action: 0, eval_run: 0 };
  for (const work of await staleWork(createDb(deps.pool), before)) {
    const changed = await withTenantTx(deps.pool, work.tenantId, (tx) => {
      if (work.kind === "document") return reconcileDocument(tx, work.id);
      if (work.kind === "action") return reconcileAction(tx, work.id);
      return reconcileEvalRun(tx, work.id, now);
    });
    if (changed) failed[work.kind]++;
  }
  const total = failed.document + failed.action + failed.eval_run;
  if (total > 0) log.warn("reconcile marked stalled work failed", failed);
  return failed;
}
