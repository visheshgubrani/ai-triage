import { MAINTENANCE_CRON, QUEUES, RECONCILE_CRON, type StorageDeleteJob } from "@ai-triage/core";
import {
  createDb,
  enqueue,
  getRetentionDays,
  listExpiredDocuments,
  type PgBoss,
  type Pool,
  pruneMailboxMessages,
  pruneOAuthStates,
  pruneRateLimits,
  purgeDocument,
  recordAudit,
  SYSTEM_ACTOR,
  takeAbandonedUploads,
  withTenantTx,
} from "@ai-triage/db";
import type { Storage } from "@ai-triage/storage";
import { reconcile } from "./reconcile";

// Daily housekeeping (docs/security.md, M7): purge documents past each tenant's retention, drop
// uploads that were never completed, prune rate-limit windows, finished OAuth round trips and old
// mailbox ledger rows. Storage deletions run as
// `storage.delete` jobs, enqueued in the transaction that removed the rows.

export interface MaintenanceDeps {
  pool: Pool;
  boss: PgBoss;
  storage: Storage;
  now: () => Date;
  /** The reconciler's threshold (RECONCILE_STALL_MINUTES). */
  stallMinutes?: number;
}

const DAY_MS = 86_400_000;
/** Documents purged per transaction, so one tenant's backlog doesn't hold a long transaction. */
const PURGE_BATCH = 50;

/** Purges one tenant's finished documents older than its retention. Returns how many. */
export async function sweepRetention(deps: MaintenanceDeps, tenantId: string): Promise<number> {
  const days = await withTenantTx(deps.pool, tenantId, getRetentionDays);
  if (!days) return 0;
  const before = new Date(deps.now().getTime() - days * DAY_MS);
  let purged = 0;
  for (;;) {
    const batch = await withTenantTx(deps.pool, tenantId, async (tx) => {
      const ids = await listExpiredDocuments(tx, before, PURGE_BATCH);
      for (const id of ids) await purgeDocument(tx, deps.boss, id);
      return ids.length;
    });
    purged += batch;
    if (batch < PURGE_BATCH) break;
  }
  if (purged > 0) {
    await withTenantTx(deps.pool, tenantId, (tx) =>
      recordAudit(tx, SYSTEM_ACTOR("retention"), {
        action: "retention.swept",
        details: { purged, retentionDays: days, before: before.toISOString() },
      }),
    );
  }
  return purged;
}

/** Uploads that expired a day ago without being completed: the row, and any object left behind. */
async function dropAbandonedUploads(deps: MaintenanceDeps, tenantId: string): Promise<void> {
  await withTenantTx(deps.pool, tenantId, async (tx) => {
    const keys = await takeAbandonedUploads(tx, new Date(deps.now().getTime() - DAY_MS));
    if (keys.length > 0) {
      const job: StorageDeleteJob = { tenantId, keys, prefixes: [] };
      await enqueue(deps.boss, tx, QUEUES.storageDelete, job);
    }
  });
}

export async function runMaintenance(deps: MaintenanceDeps): Promise<void> {
  // Tenants are global (Better Auth's table); each tenant's data is read in its own context.
  const { rows } = await deps.pool.query<{ id: string }>("select id from tenants");
  for (const { id } of rows) {
    await sweepRetention(deps, id);
    await dropAbandonedUploads(deps, id);
    await withTenantTx(deps.pool, id, async (tx) => {
      await pruneOAuthStates(tx, deps.now());
      await pruneMailboxMessages(tx, deps.now());
    });
  }
  // The longest window is an hour, so a day-old window is dead.
  await pruneRateLimits(createDb(deps.pool), new Date(deps.now().getTime() - DAY_MS));
}

/** `storage.delete`: deletes objects of one tenant, refusing anything outside its key space. */
export async function deleteStorage(storage: Storage, job: StorageDeleteJob): Promise<void> {
  const own = `t/${job.tenantId}/`;
  const foreign = [...job.keys, ...job.prefixes].filter((k) => !k.startsWith(own) || k === own);
  if (foreign.length > 0)
    throw new Error(`storage.delete for tenant ${job.tenantId} names other keys: ${foreign.join(", ")}`);
  await storage.delete(job.keys);
  for (const prefix of job.prefixes) await storage.deletePrefix(prefix);
}

/** Schedules the daily job (idempotent: pg-boss keeps one schedule per queue) and subscribes both queues. */
export async function registerMaintenance(boss: PgBoss, deps: MaintenanceDeps) {
  await boss.schedule(QUEUES.maintenance, MAINTENANCE_CRON, {}, { tz: "UTC" });
  await boss.work(QUEUES.maintenance, async () => {
    await runMaintenance(deps);
  });
  await boss.work<StorageDeleteJob>(QUEUES.storageDelete, async ([job]) => {
    if (job) await deleteStorage(deps.storage, job.data);
  });
  await boss.schedule(QUEUES.reconcile, RECONCILE_CRON, {}, { tz: "UTC" });
  await boss.work(QUEUES.reconcile, async () => {
    await reconcile({ pool: deps.pool, now: deps.now, stallMinutes: deps.stallMinutes ?? 30 });
  });
}
