// What the api and worker check before they start serving, with errors that say how to fix the
// problem instead of a raw driver error. `pnpm preflight` runs the same checks and more.
import { EnvError } from "@ai-triage/core";
import type pg from "pg";
import journal from "../migrations/meta/_journal.json" with { type: "json" };
import { assertAppRole } from "./roles";
import { assertSafeStartup, StartupError, type StartupRole } from "./startup";

type Env = Record<string, string | undefined>;

/** Where a connection string points, without its password. */
export function describeDatabase(url: string | undefined): string {
  try {
    const u = new URL(url ?? "");
    return `${u.username || "?"}@${u.hostname}:${u.port || 5432}${u.pathname}`;
  } catch {
    return "(an unparseable DATABASE_URL)";
  }
}

/** Turns a failed first query into an instruction, or returns null for errors it doesn't know. */
export function explainDatabaseError(err: unknown, url: string | undefined): string | null {
  const e = err as { code?: string; message?: string };
  const where = describeDatabase(url);
  switch (e.code) {
    case "ECONNREFUSED":
    case "ENOTFOUND":
    case "EAI_AGAIN":
    case "ETIMEDOUT":
      return `Postgres isn't reachable at ${where} (${e.code}). Start it with \`pnpm infra:up\`, or check DATABASE_URL.`;
    case "28P01":
    case "28000":
      return (
        `Postgres refused the login ${where} (${e.message}). The app role is created by \`pnpm db:migrate\`: ` +
        "run it once (in Docker, the init service does), and check that DATABASE_URL's user and password match."
      );
    case "3D000":
      return `The database in ${where} doesn't exist. Create it, or check DATABASE_URL.`;
    default:
      return null;
  }
}

/**
 * How many migrations in this build the database hasn't applied, or null when the app role can't
 * read the list (an install that predates the grant `pnpm db:migrate` now adds).
 */
export async function pendingMigrations(pool: pg.Pool): Promise<number | null> {
  const expected = journal.entries.length;
  try {
    const { rows } = await pool.query<{ n: number }>("select count(*)::int as n from drizzle.__drizzle_migrations");
    return Math.max(0, expected - (rows[0]?.n ?? 0));
  } catch (err) {
    // 42P01: no migrations table yet; 3F000: no drizzle schema; 42501: no read access yet.
    const code = (err as { code?: string }).code;
    if (code === "42P01" || code === "3F000") return expected;
    if (code === "42501") return null;
    throw err;
  }
}

/** Connection, role, schema version, then the production safety checks (startup.ts). */
export async function checkStartup(pool: pg.Pool, env: Env, role: StartupRole): Promise<void> {
  try {
    await pool.query("select 1");
  } catch (err) {
    const explained = explainDatabaseError(err, env.DATABASE_URL);
    if (explained) throw new StartupError(explained);
    throw err;
  }
  await assertAppRole(pool);
  const pending = await pendingMigrations(pool);
  if (pending !== 0) {
    const behind =
      pending === null ? "hasn't been migrated by" : `is ${pending} migration${pending === 1 ? "" : "s"} behind`;
    throw new StartupError(
      `The database ${behind} this version of the ${role}. ` +
        "Run `pnpm db:migrate` (in Docker, the init or migrate service does it), then start again.",
    );
  }
  await assertSafeStartup(pool, env, role);
}

/** For a `.catch()` on startup: a StartupError prints as one clear message, anything else as usual. */
export function exitOnStartupError(err: unknown): never {
  if (err instanceof StartupError || err instanceof EnvError) console.error(`\n${err.message}\n`);
  else console.error(err);
  process.exit(1);
}
