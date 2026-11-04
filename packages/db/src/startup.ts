import type pg from "pg";
import { DEV_ENCRYPTION_KEY } from "./crypto";

// Startup safety (docs/security.md). In production the api and worker refuse to start on the
// dev defaults from .env.example and compose.yaml, unless TRIAGE_DEMO=true says the instance is
// the local demo, in which case they start with a loud warning instead.

/** Values that ship in .env.example and compose.yaml. Anything else counts as operator-chosen. */
export const DEV_DEFAULTS = {
  betterAuthSecret: "dev-only-secret-change-me-0123456789abcdef",
  postmarkPassword: "dev-only-postmark-password",
  s3SecretKey: "triage-secret",
  databasePasswords: ["triage", "triage_app"],
} as const;

export type StartupRole = "api" | "worker";
type Env = Record<string, string | undefined>;

/** A startup failure whose message is the whole story: printed without a stack trace. */
export class StartupError extends Error {
  override name = "StartupError";
}

export const isDemo = (env: Env) => env.TRIAGE_DEMO === "true";
export const isProduction = (env: Env) => env.NODE_ENV === "production";

const isHttps = (url: string | undefined) => {
  try {
    return url !== undefined && new URL(url).protocol === "https:";
  } catch {
    return false;
  }
};

function databasePassword(url: string | undefined): string | null {
  try {
    return url ? decodeURIComponent(new URL(url).password) : null;
  } catch {
    return null;
  }
}

/** What's unsafe about this environment for a production instance (empty: nothing). Pure. */
export function unsafeConfig(env: Env, role: StartupRole): string[] {
  const problems: string[] = [];
  if (role === "api") {
    const secret = env.BETTER_AUTH_SECRET ?? "";
    if (secret === DEV_DEFAULTS.betterAuthSecret || secret.length < 32) {
      problems.push("BETTER_AUTH_SECRET is the dev default or shorter than 32 characters");
    }
    const publicUrl = env.PUBLIC_URL || env.WEB_ORIGIN;
    if (!isHttps(publicUrl)) problems.push("PUBLIC_URL is not an https:// origin");
    const postmark = env.POSTMARK_INBOUND_PASSWORD;
    if (
      postmark !== undefined &&
      postmark !== "" &&
      (postmark === DEV_DEFAULTS.postmarkPassword || postmark.length < 16)
    ) {
      problems.push("POSTMARK_INBOUND_PASSWORD is the dev default or shorter than 16 characters");
    }
  }
  const encryptionKey = env.ENCRYPTION_KEYS ?? env.ENCRYPTION_KEY;
  if (!encryptionKey) problems.push("ENCRYPTION_KEYS (or ENCRYPTION_KEY) is not set");
  else if (encryptionKey.includes(DEV_ENCRYPTION_KEY)) problems.push("the encryption key is the published dev key");
  if (env.S3_SECRET_ACCESS_KEY === DEV_DEFAULTS.s3SecretKey) problems.push("S3_SECRET_ACCESS_KEY is the dev default");
  if (env.GOOGLE_OAUTH_URL || env.GOOGLE_TOKEN_URL || env.GOOGLE_API_URL) {
    problems.push("GOOGLE_OAUTH_URL / GOOGLE_TOKEN_URL / GOOGLE_API_URL point Google at a fake Google");
  }
  const dbPassword = databasePassword(env.DATABASE_URL);
  if (dbPassword !== null && (DEV_DEFAULTS.databasePasswords as readonly string[]).includes(dbPassword)) {
    problems.push("DATABASE_URL uses the dev default password");
  }
  return problems;
}

/** True when any demo user (seeded with a published password) exists. */
export async function hasDemoUsers(pool: pg.Pool): Promise<boolean> {
  const { rows } = await pool.query<{ found: boolean }>(
    "select exists (select 1 from users where email like '%@demo.test') as found",
  );
  return rows[0]?.found ?? false;
}

/**
 * Refuses to start a production api or worker on dev defaults. Outside production it does nothing;
 * with TRIAGE_DEMO=true it warns instead of refusing.
 */
export async function assertSafeStartup(pool: pg.Pool, env: Env, role: StartupRole): Promise<void> {
  if (!isProduction(env)) return;
  const problems = unsafeConfig(env, role);
  if (await hasDemoUsers(pool)) problems.push("demo users (@demo.test, published password) exist");
  if (problems.length === 0) return;
  const list = problems.map((p) => `  - ${p}`).join("\n");
  if (isDemo(env)) {
    console.warn(`\n*** TRIAGE_DEMO=true: running with demo defaults. Never expose this instance. ***\n${list}\n`);
    return;
  }
  throw new StartupError(
    `Refusing to start in production with unsafe settings:\n${list}\n` +
      "Fix them (see the production checklist in docs/security.md), or set TRIAGE_DEMO=true for a local demo.",
  );
}

/** The demo seed publishes its users' password, so production refuses it unless TRIAGE_DEMO=true. */
export function assertDemoSeedAllowed(env: Env): void {
  if (isProduction(env) && !isDemo(env)) {
    throw new StartupError(
      "Refusing to seed the demo tenant in production (its users have a published password). " +
        "Set TRIAGE_DEMO=true for a local demo; `pnpm db:migrate` already seeds model prices.",
    );
  }
}
