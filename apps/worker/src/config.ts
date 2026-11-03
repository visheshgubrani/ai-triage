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

export const workerConfig = (env: NodeJS.ProcessEnv = process.env) => ({
  cassetteDir: repoPath(env.CASSETTE_DIR, "fixtures/cassettes"),
  fixturesDir: repoPath(env.FIXTURES_DIR, "fixtures"),
  maxPdfPages: Number(env.MAX_PDF_PAGES ?? 100),
  maxFileBytes: Number(env.MAX_FILE_MB ?? 20) * 2 ** 20,
  llmConcurrency: Number(env.WORKER_LLM_CONCURRENCY ?? 4),
  webhookTimeoutMs: Number(env.WEBHOOK_TIMEOUT_MS ?? 10_000),
});
