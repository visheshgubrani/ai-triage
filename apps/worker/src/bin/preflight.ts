import { existsSync } from "node:fs";
import { join } from "node:path";
import { getLlmMode } from "@ai-triage/core";
import { repoRoot, workerConfig } from "../config";
import {
  type CheckResult,
  checkApi,
  checkDatabase,
  checkEnvironment,
  checkStorage,
  checkVersions,
  formatResults,
} from "../preflight";

// `pnpm preflight`: checks that this installation can process documents, and says how to fix what
// can't. Read-only. Exits 1 when anything fails (warnings don't count).

const env = process.env;
const results: CheckResult[] = [...checkVersions(env)];
if (!existsSync(join(repoRoot(), ".env")) && !env.DATABASE_URL) {
  results.push({ status: "fail", title: ".env", detail: "no .env and no environment", fix: "cp .env.example .env" });
}
results.push(...checkEnvironment(env));
let mode: ReturnType<typeof getLlmMode> = "replay";
try {
  mode = getLlmMode(env.LLM_MODE);
} catch {
  // checkEnvironment already reported it.
}
results.push(...(await checkDatabase(env, mode, workerConfig(env).cassetteDir)));
results.push(...(await checkStorage(env)));
results.push(...(await checkApi(env)));

console.log(formatResults(results));
process.exit(results.some((r) => r.status === "fail") ? 1 : 0);
