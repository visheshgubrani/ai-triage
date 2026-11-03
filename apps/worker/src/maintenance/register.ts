import { MAINTENANCE_CRON, QUEUES } from "@ai-triage/core";
import { createDb, type PgBoss, type Pool, pruneRateLimits } from "@ai-triage/db";

export interface MaintenanceDeps {
  pool: Pool;
  now: () => Date;
}

/** Daily housekeeping: drops rate-limit windows older than a day (the longest window is an hour). */
export async function runMaintenance(deps: MaintenanceDeps): Promise<void> {
  await pruneRateLimits(createDb(deps.pool), new Date(deps.now().getTime() - 24 * 3_600_000));
}

/** Schedules the daily job (idempotent: pg-boss keeps one schedule per queue) and subscribes to it. */
export async function registerMaintenance(boss: PgBoss, deps: MaintenanceDeps) {
  await boss.schedule(QUEUES.maintenance, MAINTENANCE_CRON, {}, { tz: "UTC" });
  await boss.work(QUEUES.maintenance, async () => {
    await runMaintenance(deps);
  });
}
