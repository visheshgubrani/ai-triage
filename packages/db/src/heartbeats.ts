import { desc, eq, gt, lt } from "drizzle-orm";
import type { Db } from "./index";
import { workerHeartbeats } from "./schema";

/** A worker unseen for longer than this counts as gone. */
export const HEARTBEAT_STALE_MS = 2 * 60_000;

export interface WorkerInfo {
  workerId: string;
  hostname: string;
  version: string;
  llmMode: string;
  startedAt: Date;
}

export async function recordHeartbeat(db: Db, worker: WorkerInfo, now: Date): Promise<void> {
  await db
    .insert(workerHeartbeats)
    .values({ ...worker, lastSeenAt: now })
    .onConflictDoUpdate({ target: workerHeartbeats.workerId, set: { lastSeenAt: now, version: worker.version } });
}

/** Workers seen in the last two minutes, newest first. */
export async function liveWorkers(db: Db, now: Date) {
  return db
    .select()
    .from(workerHeartbeats)
    .where(gt(workerHeartbeats.lastSeenAt, new Date(now.getTime() - HEARTBEAT_STALE_MS)))
    .orderBy(desc(workerHeartbeats.lastSeenAt));
}

/** The worker stopping cleanly takes its row with it; crashed ones are pruned by maintenance. */
export async function removeHeartbeat(db: Db, workerId: string): Promise<void> {
  await db.delete(workerHeartbeats).where(eq(workerHeartbeats.workerId, workerId));
}

export async function pruneHeartbeats(db: Db, before: Date): Promise<void> {
  await db.delete(workerHeartbeats).where(lt(workerHeartbeats.lastSeenAt, before));
}
