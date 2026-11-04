import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

/** The repository root (the directory holding pnpm-workspace.yaml), found from the working directory. */
export function repoRoot(from = process.cwd()): string {
  let dir = resolve(from);
  while (!existsSync(join(dir, "pnpm-workspace.yaml"))) {
    const parent = dirname(dir);
    if (parent === dir) return resolve(from);
    dir = parent;
  }
  return dir;
}

/** An env path, resolved against the repo root when relative (pnpm runs scripts from package dirs). */
export const repoPath = (value: string | undefined, fallback: string) => {
  const path = value || fallback;
  return isAbsolute(path) ? path : join(repoRoot(), path);
};

/**
 * pg-boss work options for a per-tenant cap: at most `cap` jobs of one tenant run at once in this
 * queue, across every worker (the group is the tenant, set by enqueue()). No cap: none.
 */
export const tenantCap = (cap: number | null) => (cap ? { groupConcurrency: cap } : {});

/** A numeric setting; unset or empty (compose passes `${X:-}` as "") means the default. */
const num = (value: string | undefined, fallback: number) => (value?.trim() ? Number(value) : fallback);

export const workerConfig = (env: NodeJS.ProcessEnv = process.env) => ({
  cassetteDir: repoPath(env.CASSETTE_DIR, "fixtures/cassettes"),
  fixturesDir: repoPath(env.FIXTURES_DIR, "fixtures"),
  maxPdfPages: num(env.MAX_PDF_PAGES, 100),
  maxFileBytes: num(env.MAX_FILE_MB, 20) * 2 ** 20,
  llmConcurrency: num(env.WORKER_LLM_CONCURRENCY, 4),
  evalConcurrency: num(env.WORKER_EVAL_CONCURRENCY, 2),
  webhookTimeoutMs: num(env.WEBHOOK_TIMEOUT_MS, 10_000),
  mailboxConcurrency: num(env.WORKER_MAILBOX_CONCURRENCY, 4),
  mailboxSyncBatch: num(env.MAILBOX_SYNC_BATCH, 200),
  shutdownGraceMs: num(env.WORKER_SHUTDOWN_GRACE_MS, 25_000),
  // Off unless set: a single-company install has no one to be fair to.
  tenantConcurrency: Number(env.WORKER_TENANT_CONCURRENCY) || null,
  tenantEvalConcurrency: Number(env.WORKER_TENANT_EVAL_CONCURRENCY) || null,
  parseTimeoutMs: num(env.PARSE_TIMEOUT_MS, 60_000),
  reconcileStallMinutes: num(env.RECONCILE_STALL_MINUTES, 30),
  httpPort: num(env.WORKER_HTTP_PORT, 9100),
  parseMaxMemoryMb: num(env.PARSE_MAX_MEMORY_MB, 512),
  // Optional OCR for scans and photos (core/pipeline/ocr.ts); null when OCR_URL is unset.
  ocr: env.OCR_URL
    ? {
        url: env.OCR_URL,
        timeoutMs: num(env.OCR_TIMEOUT_MS, 120_000),
        maxPages: num(env.OCR_MAX_PAGES, 20),
      }
    : null,
  // The api's inbound email limit (postmarkPerTenant, 500 an hour), shared by Gmail sync.
  inboundPerHour: Math.ceil(500 * (Number(env.RATE_LIMIT_SCALE) > 0 ? Number(env.RATE_LIMIT_SCALE) : 1)),
});
