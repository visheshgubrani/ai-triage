// The checks behind `pnpm preflight`: is this installation ready to process documents? Each check
// returns a line with what's wrong and the command that fixes it. The pure parts (config
// runnability) are unit-tested; the rest talk to Postgres, storage and the api.
import { checkEnv, type LlmMode, parseModelRef } from "@ai-triage/core";
import {
  checkStartup,
  createDb,
  createPool,
  getActiveConfig,
  listTenants,
  StartupError,
  withTenantTx,
} from "@ai-triage/db";
import { OPENAI_COMPATIBLE_ENDPOINTS, providerKeyEnv, type RecordedSet, readRecorded } from "@ai-triage/llm";
import { googleConfigFromEnv } from "@ai-triage/mailbox";
import { createStorage, storageConfigFromEnv } from "@ai-triage/storage";

type Env = Record<string, string | undefined>;

export type CheckStatus = "ok" | "warn" | "fail";
export interface CheckResult {
  status: CheckStatus;
  title: string;
  detail?: string;
  /** The command or setting that fixes it. */
  fix?: string;
}

const ok = (title: string, detail?: string): CheckResult => ({ status: "ok", title, detail });
const warn = (title: string, detail: string, fix?: string): CheckResult => ({ status: "warn", title, detail, fix });
const fail = (title: string, detail: string, fix?: string): CheckResult => ({ status: "fail", title, detail, fix });

export interface StageModel {
  model: string;
  effort: string;
}

/**
 * Why a config can't run under this LLM mode, or null if it can: replay needs a recorded set for
 * the model at the same effort, live and record need the provider's key (compat may go without).
 */
export function configBlocker(
  stages: StageModel[],
  mode: LlmMode,
  env: Env,
  recorded: Record<string, RecordedSet>,
): { detail: string; fix: string } | null {
  for (const { model, effort } of stages) {
    if (mode === "replay") {
      const set = recorded[model];
      if (!set) {
        return {
          detail: `${model} has no recorded responses, so replay mode fails every document as cassette_missing`,
          fix: "set LLM_MODE=live and the provider's key, or use a recorded model (the demo's)",
        };
      }
      if ((set.effort ?? "low") !== effort) {
        return {
          detail: `${model} was recorded at effort ${set.effort ?? "low"}, but the config uses ${effort}`,
          fix: "match the recorded effort, or set LLM_MODE=live",
        };
      }
      continue;
    }
    const { provider } = parseModelRef(model);
    const keyEnv = providerKeyEnv(provider);
    const keyRequired = provider === "anthropic" || OPENAI_COMPATIBLE_ENDPOINTS[provider].keyRequired;
    if (keyRequired && !env[keyEnv]) {
      return { detail: `${model} needs ${keyEnv}, which isn't set`, fix: `set ${keyEnv} for the worker` };
    }
    if (provider === "compat" && !env.OPENAI_COMPAT_BASE_URL) {
      return { detail: `${model} needs OPENAI_COMPAT_BASE_URL`, fix: "point OPENAI_COMPAT_BASE_URL at the server" };
    }
  }
  return null;
}

export function checkVersions(env: Env, nodeVersion = process.versions.node): CheckResult[] {
  const out: CheckResult[] = [];
  const major = Number(nodeVersion.split(".")[0]);
  out.push(
    major >= 24
      ? ok(`Node ${nodeVersion}`)
      : fail(`Node ${nodeVersion}`, "Node 24 or later is required", "install Node 24 (see .nvmrc)"),
  );
  const pnpm = /pnpm\/(\d+)/.exec(env.npm_config_user_agent ?? "")?.[1];
  if (pnpm) {
    out.push(
      Number(pnpm) >= 12
        ? ok(`pnpm ${pnpm}`)
        : fail(`pnpm ${pnpm}`, "pnpm 12 is required", "corepack enable && pnpm -v"),
    );
  }
  return out;
}

export function checkEnvironment(env: Env): CheckResult[] {
  const out: CheckResult[] = [];
  for (const process of ["api", "worker"] as const) {
    const problems = checkEnv(env, process);
    out.push(
      problems.length === 0
        ? ok(`Environment for the ${process}`)
        : fail(`Environment for the ${process}`, problems.join("\n"), "see docs/configuration.md"),
    );
  }
  try {
    const google = googleConfigFromEnv(env);
    out.push(ok("Google", google ? "configured" : "off (no GOOGLE_CLIENT_ID)"));
  } catch (err) {
    out.push(fail("Google", (err as Error).message, "set both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, or neither"));
  }
  return out;
}

export async function checkDatabase(env: Env, mode: LlmMode, cassetteDir: string): Promise<CheckResult[]> {
  if (!env.DATABASE_URL) return [];
  const out: CheckResult[] = [];
  const pool = createPool(env.DATABASE_URL);
  try {
    try {
      // Outside production this is connection, role and migrations; in production also the safety checks.
      await checkStartup(pool, env, "worker");
      out.push(ok("Postgres", "reachable, app role, migrations current"));
    } catch (err) {
      out.push(fail("Postgres", (err as Error).message, err instanceof StartupError ? undefined : "pnpm infra:up"));
      return out;
    }
    const tenants = await listTenants(createDb(pool));
    if (tenants.length === 0) {
      out.push(warn("Tenants", "none yet", "pnpm db:seed (demo) or pnpm tenant:create"));
      return out;
    }
    if (tenants.length > 1 && !env.WORKER_TENANT_CONCURRENCY) {
      out.push(
        warn(
          "Fairness",
          `${tenants.length} tenants share the workers with no per-tenant cap, so one tenant's backlog can delay the others`,
          "set WORKER_TENANT_CONCURRENCY to about half the cluster's slots per LLM queue (docs/configuration.md)",
        ),
      );
    }
    const recorded = readRecorded(cassetteDir);
    for (const tenant of tenants) {
      const config = await withTenantTx(pool, tenant.id, (tx) => getActiveConfig(tx));
      const title = `Tenant ${tenant.slug}`;
      if (!config) {
        out.push(fail(title, "has no active pipeline config", "pnpm tenant:create builds one"));
        continue;
      }
      const blocker = configBlocker(
        [
          { model: config.classifyModel, effort: config.classifyEffort },
          { model: config.extractModel, effort: config.extractEffort },
        ],
        mode,
        env,
        recorded,
      );
      out.push(
        blocker ? fail(title, blocker.detail, blocker.fix) : ok(title, `${config.name} can run in ${mode} mode`),
      );
    }
  } finally {
    await pool.end();
  }
  return out;
}

export async function checkStorage(env: Env): Promise<CheckResult[]> {
  if (!env.S3_ENDPOINT || !env.S3_BUCKET) return [];
  try {
    const storage = createStorage(storageConfigFromEnv(env as NodeJS.ProcessEnv));
    const { exists, corsOrigins } = await storage.inspectBucket();
    if (!exists)
      return [fail("Storage", `bucket "${storage.bucket}" doesn't exist`, "pnpm infra:up creates it locally")];
    const web = env.WEB_ORIGIN ?? "http://localhost:3000";
    if (!corsOrigins.includes(web)) {
      return [warn("Storage", `bucket CORS doesn't allow ${web} yet`, "start the api once: it sets the bucket's CORS")];
    }
    return [ok("Storage", `bucket "${storage.bucket}" with CORS for ${web}`)];
  } catch (err) {
    return [fail("Storage", `unreachable at ${env.S3_ENDPOINT}: ${(err as Error).message}`, "pnpm infra:up")];
  }
}

export async function checkApi(env: Env): Promise<CheckResult[]> {
  const base = env.TRIAGE_API_URL ?? `http://localhost:${env.API_PORT ?? 8787}`;
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3000) });
    return [res.ok ? ok("API", `healthy at ${base}`) : warn("API", `${base}/health answered ${res.status}`)];
  } catch {
    return [warn("API", `not running at ${base}`, "pnpm dev")];
  }
}

const ICONS: Record<CheckStatus, string> = { ok: "✓", warn: "!", fail: "✗" };

export function formatResults(results: CheckResult[]): string {
  const lines: string[] = [];
  for (const r of results) {
    lines.push(`${ICONS[r.status]} ${r.title}${r.detail && r.status === "ok" ? `: ${r.detail}` : ""}`);
    if (r.status !== "ok") {
      for (const line of (r.detail ?? "").split("\n")) lines.push(`    ${line}`);
      if (r.fix) lines.push(`    → ${r.fix}`);
    }
  }
  const failed = results.filter((r) => r.status === "fail").length;
  const warned = results.filter((r) => r.status === "warn").length;
  lines.push("", failed ? `${failed} problem(s), ${warned} warning(s).` : `Ready (${warned} warning(s)).`);
  return lines.join("\n");
}
