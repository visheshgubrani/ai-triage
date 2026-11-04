import type pg from "pg";
import { StartupError } from "./startup";

/** Session limits of the app role (ensureAppRole). */
export const APP_STATEMENT_TIMEOUT = "60s";
export const APP_LOCK_TIMEOUT = "15s";

/** NOLOGIN group role that migrations grant to. The login role from DATABASE_URL is a member. */
export const APP_GROUP_ROLE = "app_rw";

/**
 * Creates or updates the login role named in `appUrl` (the runtime DATABASE_URL) and makes it a
 * member of `app_rw`. Runs as the owner before migrations. Idempotent: re-running syncs the password.
 *
 * The role is deliberately weak: no superuser, no BYPASSRLS, so every query it runs is subject to RLS.
 * `idle_in_transaction_session_timeout` backs invariant 2: a transaction held open across a slow
 * call gets killed instead of holding locks.
 */
export async function ensureAppRole(ownerPool: pg.Pool, appUrl: string): Promise<string> {
  const { username, password } = new URL(appUrl);
  const role = decodeURIComponent(username);
  if (!role || !password) throw new Error("DATABASE_URL must include a username and password for the app role");

  const client = await ownerPool.connect();
  try {
    const owner = (await client.query<{ u: string }>("select current_user as u")).rows[0]?.u;
    if (owner === role) throw new Error(`DATABASE_URL uses the owner role "${role}"; it must name a separate app role`);

    // DDL can't take bind parameters, so quote with the driver's escaping helpers.
    const ident = client.escapeIdentifier(role);
    const secret = client.escapeLiteral(decodeURIComponent(password));
    await client.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${APP_GROUP_ROLE}') THEN
        CREATE ROLE ${APP_GROUP_ROLE} NOLOGIN NOBYPASSRLS;
      END IF;
    END $$`);
    const exists = await client.query("select 1 from pg_roles where rolname = $1", [role]);
    const verb = exists.rowCount ? "ALTER" : "CREATE";
    await client.query(
      `${verb} ROLE ${ident} LOGIN PASSWORD ${secret} NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS INHERIT`,
    );
    // Bounds for every app session (docs/architecture.md §5, short transactions): no transaction
    // sits idle, no statement runs away, no lock wait hangs a request. The few long reads (metrics)
    // raise statement_timeout with SET LOCAL.
    await client.query(`ALTER ROLE ${ident} SET idle_in_transaction_session_timeout = '30s'`);
    await client.query(`ALTER ROLE ${ident} SET statement_timeout = '${APP_STATEMENT_TIMEOUT}'`);
    await client.query(`ALTER ROLE ${ident} SET lock_timeout = '${APP_LOCK_TIMEOUT}'`);
    await client.query(`GRANT ${APP_GROUP_ROLE} TO ${ident}`);
    return role;
  } finally {
    client.release();
  }
}

/**
 * Refuses to run the app as a role that would silently bypass RLS (superuser or BYPASSRLS).
 * Called at api/worker startup.
 */
export async function assertAppRole(pool: pg.Pool): Promise<void> {
  const { rows } = await pool.query<{ role: string; bypass: boolean }>(
    "select current_user as role, (rolsuper or rolbypassrls) as bypass from pg_roles where rolname = current_user",
  );
  const row = rows[0];
  if (!row || row.bypass) {
    throw new StartupError(
      `Database role "${row?.role}" bypasses row-level security. Point DATABASE_URL at the app role ` +
        "(see .env.example) and run `pnpm db:migrate` to create it.",
    );
  }
}
