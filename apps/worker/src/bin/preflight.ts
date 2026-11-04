import { existsSync } from "node:fs";
import { join } from "node:path";
import { getLlmMode } from "@ai-triage/core";
import { repoRoot, workerConfig } from "../config";
import {
  type CheckResult,
  checkApi,
  checkDatabase,
  checkEnvironment,
  checkOcr,
  checkStorage,
  checkVersions,
  DEV_HINTS,
  formatResults,
  INSTALLED_HINTS,
} from "../preflight";

// `pnpm preflight [--json]`: checks that this installation can process documents, and says how to
// fix what can't. Read-only. Exits 1 when anything fails (warnings don't count). `--json` prints
// `{ ready, checks }` for scripts and agents (`./triage status --json` embeds it).

const env = process.env;
// `--installed`: run by ./triage inside an installation's worker container.
const hints = process.argv.includes("--installed") ? INSTALLED_HINTS : DEV_HINTS;
const results: CheckResult[] = [...checkVersions(env)];
if (!hints.installed && !existsSync(join(repoRoot(), ".env")) && !env.DATABASE_URL) {
  results.push({ status: "fail", title: ".env", detail: "no .env and no environment", fix: "cp .env.example .env" });
}
results.push(...checkEnvironment(env, hints));
let mode: ReturnType<typeof getLlmMode> = "replay";
try {
  mode = getLlmMode(env.LLM_MODE);
} catch {
  // checkEnvironment already reported it.
}
results.push(...(await checkDatabase(env, mode, workerConfig(env).cassetteDir, hints)));
results.push(...(await checkStorage(env, hints)));
results.push(...(await checkApi(env, hints)));
results.push(...(await checkOcr(env, hints)));

// Installed, a missing provider key is set with ./triage (which reads it from the environment).
if (hints.installed) {
  for (const r of results) {
    const key = r.fix?.match(/^set ([A-Z0-9_]+) for the worker$/)?.[1];
    if (key) r.fix = `export ${key}=…, then ./triage config set ${key}`;
  }
}
const ready = !results.some((r) => r.status === "fail");
console.log(process.argv.includes("--json") ? JSON.stringify({ ready, checks: results }) : formatResults(results));
process.exit(ready ? 0 : 1);
