import { createHash } from "node:crypto";
import {
  type PipelineStage,
  QUEUE_OPTIONS,
  QUEUES,
  type QueueName,
  STAGE_QUEUES,
  type StageJob,
} from "@ai-triage/core";
import type pg from "pg";
import { type ConstructorOptions, PgBoss, type SendOptions } from "pg-boss";
import { APP_GROUP_ROLE } from "./roles";
import type { TenantTx } from "./tenant-tx";

// pg-boss runs in two modes. `pnpm db:migrate` installs and upgrades its schema as the owner and
// creates every queue; the api and worker then run as the app role, which has DML and EXECUTE on
// schema `pgboss` but can't run DDL. So runtime instances must never migrate, reindex (needs
// table ownership) or persist queue stats (creates partitions). Queues stay non-partitioned
// (pg-boss's default), which keeps create_queue() to plain inserts.

const RUNTIME_OPTIONS = {
  migrate: false,
  createSchema: false,
  reindex: false,
  persistQueueStats: false,
} satisfies ConstructorOptions;

export function createBoss(connectionString: string, options: ConstructorOptions = {}): PgBoss {
  const boss = new PgBoss({ connectionString, ...options, ...RUNTIME_OPTIONS });
  return boss;
}

/** Enqueues on the tenant transaction's client, so the job exists only if the transaction commits. */
export function enqueue(boss: PgBoss, tx: TenantTx, name: QueueName, data: object, options: SendOptions = {}) {
  return boss.send(name, data, { ...options, db: tx.queueDb });
}

/**
 * Installs or upgrades the pg-boss schema as the owner, then creates every queue in QUEUES with its
 * QUEUE_OPTIONS, or updates an existing queue's options (which only affects jobs sent afterwards).
 * Dead-letter targets are created first, because a queue's `dead_letter` references them.
 */
export async function installBossSchema(ownerUrl: string): Promise<void> {
  const boss = new PgBoss({ connectionString: ownerUrl, supervise: false, schedule: false });
  boss.on("error", (err) => console.error("pg-boss install error", err));
  await boss.start();
  try {
    const names = Object.values(QUEUES) as QueueName[];
    const isTarget = (name: QueueName) => names.some((n) => QUEUE_OPTIONS[n].deadLetter === name);
    for (const name of [...names.filter(isTarget), ...names.filter((n) => !isTarget(n))]) {
      const options = QUEUE_OPTIONS[name];
      if (await boss.getQueue(name)) {
        // pg-boss fixes a queue's policy at creation and refuses it in an update.
        const { policy: _policy, ...updatable } = options;
        await boss.updateQueue(name, { ...updatable, deadLetter: options.deadLetter ?? null });
      } else {
        await boss.createQueue(name, options);
      }
    }
    // An upgrade may build indexes in the background; let it finish before stopping.
    while (boss.isBamWorking()) await new Promise((resolve) => setTimeout(resolve, 200));
  } finally {
    await boss.stop({ graceful: true });
  }
}

/** Idempotent grants on schema `pgboss` for the app role. Re-run after every install, since upgrades add objects. */
export async function grantBossSchema(ownerPool: pg.Pool): Promise<void> {
  await ownerPool.query(`
    GRANT USAGE ON SCHEMA pgboss TO ${APP_GROUP_ROLE};
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgboss TO ${APP_GROUP_ROLE};
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA pgboss TO ${APP_GROUP_ROLE};
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgboss TO ${APP_GROUP_ROLE};
    ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${APP_GROUP_ROLE};
    ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT USAGE, SELECT ON SEQUENCES TO ${APP_GROUP_ROLE};
    ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT EXECUTE ON FUNCTIONS TO ${APP_GROUP_ROLE};
  `);
}

export type { PgBoss };

/**
 * Deterministic job id for a run's stage. pg-boss inserts jobs with ON CONFLICT DO NOTHING on
 * (name, id), so sending the same stage of the same run twice creates one job (the second send
 * returns null). The guarded status update in each handler is still the real idempotency check.
 */
export function stageJobId(runId: string, stage: PipelineStage): string {
  const b = createHash("sha1").update(`ai-triage:${runId}:${stage}`).digest();
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x50; // version 5 (name-based, SHA-1)
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80; // RFC 4122 variant
  const h = b.subarray(0, 16).toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Enqueues a pipeline stage job inside the tenant transaction, with its deterministic id. */
export function enqueueStage(boss: PgBoss, tx: TenantTx, stage: PipelineStage, job: StageJob) {
  return enqueue(boss, tx, STAGE_QUEUES[stage], job, { id: stageJobId(job.runId, stage) });
}
