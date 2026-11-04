// The checks behind `pnpm preflight`: is this installation ready to process documents? Each check
// returns a line with what's wrong and the command that fixes it. The pure parts (config
// runnability) are unit-tested; the rest talk to Postgres, storage and the api.
import { checkEnv, type LlmMode, parseModelRef, resolvePublicUrls } from "@ai-triage/core";
import {
  checkStartup,
  createDb,
  createPool,
  getActiveConfig,
  listTenants,
  liveWorkers,
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
    // The simulator answers in every mode, and needs only its address.
    if (model.startsWith("sim:")) {
      if (!env.LLM_SIMULATOR_URL) {
        return {
          detail: `${model} needs LLM_SIMULATOR_URL`,
          fix: "run `pnpm llm-sim` and set LLM_SIMULATOR_URL=http://localhost:9050/v1",
        };
      }
      continue;
    }
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

/**
 * Fixes worded for where preflight runs: a checkout (`pnpm …`) or an installation made by
 * install.sh (`./triage …`, run in the worker container).
 */
export interface Hints {
  installed: boolean;
  startInfra: string;
  startWorker: string;
  startApi: string;
  firstTenant: string;
  bucket: string;
}
export const DEV_HINTS: Hints = {
  installed: false,
  startInfra: "pnpm infra:up",
  startWorker: "pnpm dev",
  startApi: "pnpm dev",
  firstTenant: "pnpm db:seed (demo) or pnpm tenant:create",
  bucket: "pnpm infra:up creates it locally",
};
export const INSTALLED_HINTS: Hints = {
  installed: true,
  startInfra: "./triage start, then ./triage logs postgres storage",
  startWorker: "./triage start, then ./triage logs worker",
  startApi: "./triage start, then ./triage logs api",
  firstTenant: "open the setup link (./triage setup-link)",
  bucket: "create it (bundled storage: ./triage restart runs storage-init)",
};

export function checkEnvironment(env: Env, hints: Hints = DEV_HINTS): CheckResult[] {
  const out: CheckResult[] = [];
  // Installed, preflight runs in the worker container, which holds only the worker's settings; the
  // api checks its own at startup, so a healthy api (checkApi) is the proof of those.
  for (const process of hints.installed ? (["worker"] as const) : (["api", "worker"] as const)) {
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

export async function checkDatabase(
  env: Env,
  mode: LlmMode,
  cassetteDir: string,
  hints: Hints = DEV_HINTS,
): Promise<CheckResult[]> {
  if (!env.DATABASE_URL) return [];
  const out: CheckResult[] = [];
  const pool = createPool(env.DATABASE_URL);
  try {
    try {
      // Outside production this is connection, role and migrations; in production also the safety checks.
      await checkStartup(pool, env, "worker");
      out.push(ok("Postgres", "reachable, app role, migrations current"));
    } catch (err) {
      out.push(fail("Postgres", (err as Error).message, err instanceof StartupError ? undefined : hints.startInfra));
      return out;
    }
    const workers = await liveWorkers(createDb(pool), new Date());
    out.push(
      workers.length > 0
        ? ok("Workers", `${workers.length} running (${[...new Set(workers.map((w) => w.version))].join(", ")})`)
        : warn("Workers", "none has checked in for 2 minutes, so documents won't be processed", hints.startWorker),
    );
    const tenants = await listTenants(createDb(pool));
    if (tenants.length === 0) {
      out.push(warn("Tenants", "none yet", hints.firstTenant));
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

export async function checkStorage(env: Env, hints: Hints = DEV_HINTS): Promise<CheckResult[]> {
  if (!env.S3_ENDPOINT || !env.S3_BUCKET) return [];
  try {
    const storage = createStorage(storageConfigFromEnv(env as NodeJS.ProcessEnv));
    const { exists, corsOrigins } = await storage.inspectBucket();
    if (!exists) return [fail("Storage", `bucket "${storage.bucket}" doesn't exist`, hints.bucket)];
    const web = resolvePublicUrls(env).origin;
    if (!corsOrigins.includes(web)) {
      return [warn("Storage", `bucket CORS doesn't allow ${web} yet`, "start the api once: it sets the bucket's CORS")];
    }
    return [ok("Storage", `bucket "${storage.bucket}" with CORS for ${web}`)];
  } catch (err) {
    return [fail("Storage", `unreachable at ${env.S3_ENDPOINT}: ${(err as Error).message}`, hints.startInfra)];
  }
}

/** The optional OCR server (OCR_URL): reachable, and serving a model. */
export async function checkOcr(env: Env, hints: Hints = DEV_HINTS): Promise<CheckResult[]> {
  if (!env.OCR_URL) return [ok("OCR", "off (no OCR_URL): scans and photos go to the model as images")];
  try {
    const res = await fetch(`${env.OCR_URL.replace(/\/+$/, "")}/models`, { signal: AbortSignal.timeout(3000) });
    return [
      res.ok
        ? ok("OCR", `ready at ${env.OCR_URL}`)
        : warn("OCR", `${env.OCR_URL} answered ${res.status}; scans stay unverifiable until it's up`),
    ];
  } catch {
    return [
      warn(
        "OCR",
        `not reachable at ${env.OCR_URL}; scans stay unverifiable until it is`,
        hints.installed ? "./triage logs ocr ocr-model" : "start the OCR server (docs/install.md, OCR)",
      ),
    ];
  }
}

export async function checkApi(env: Env, hints: Hints = DEV_HINTS): Promise<CheckResult[]> {
  const base = env.TRIAGE_API_URL ?? `http://localhost:${env.API_PORT ?? 8787}`;
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3000) });
    return [res.ok ? ok("API", `healthy at ${base}`) : warn("API", `${base}/health answered ${res.status}`)];
  } catch {
    return [(hints.installed ? fail : warn)("API", `not running at ${base}`, hints.startApi)];
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
