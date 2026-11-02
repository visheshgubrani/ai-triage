import { QUEUES, type QueueName } from "@ai-triage/core";
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

/** Installs or upgrades the pg-boss schema as the owner and creates every queue in QUEUES. */
export async function installBossSchema(ownerUrl: string): Promise<void> {
  const boss = new PgBoss({ connectionString: ownerUrl, supervise: false, schedule: false });
  boss.on("error", (err) => console.error("pg-boss install error", err));
  await boss.start();
  try {
    for (const name of Object.values(QUEUES)) {
      if (!(await boss.getQueue(name))) await boss.createQueue(name);
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
