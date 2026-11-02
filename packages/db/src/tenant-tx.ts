import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type pg from "pg";
import * as schema from "./schema";

/** Structurally pg-boss's `IDatabase`: pass as `boss.send(…, { db })` to enqueue inside the transaction. */
export interface QueueDb {
  executeSql(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

export type TenantDb = NodePgDatabase<typeof schema>;

export interface TenantTx {
  /** Drizzle on the transaction's client. Every query is filtered by RLS to `tenantId`. */
  db: TenantDb;
  /** The same client, shaped for pg-boss, so a stage result and its next job commit together (invariant 3). */
  queueDb: QueueDb;
  tenantId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Runs `fn` in one transaction on one pooled client with `app.tenant_id` set, which is what the RLS
 * policies read. All tenant data access goes through here. Keep `fn` short: never call Claude or
 * other slow I/O inside it (invariant 2; the app role also has a 30 s idle-in-transaction timeout).
 */
export async function withTenantTx<T>(pool: pg.Pool, tenantId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  if (!UUID.test(tenantId)) throw new TypeError(`Invalid tenant id: ${JSON.stringify(tenantId)}`);
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query("BEGIN");
    // set_config(…, true) is SET LOCAL with a bind parameter: it ends with the transaction.
    await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn({
      db: drizzle(client, { schema }),
      queueDb: { executeSql: (text, values) => client.query(text, values) },
      tenantId,
    });
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch((rollbackErr: Error) => {
      broken = rollbackErr;
    });
    throw err;
  } finally {
    // A client whose rollback failed is in an unknown state: destroy it instead of pooling it.
    client.release(broken);
  }
}
