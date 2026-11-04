// `pnpm dev:setup`: everything between a fresh clone and `pnpm dev`, safe to re-run.
// `pnpm dev:reset`: the same after wiping the local database and storage (asks first; --yes skips).
import { execSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";

const args = new Set(process.argv.slice(2));
const run = (cmd) => {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { stdio: "inherit" });
};

try {
  if (args.has("--reset")) {
    if (!args.has("--yes")) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question(
        "This deletes the local Postgres and storage volumes (all local data). Continue? [y/N] ",
      );
      rl.close();
      if (!/^y(es)?$/i.test(answer.trim())) process.exit(1);
    }
    run("docker compose down -v");
  }
  if (!existsSync(".env")) {
    copyFileSync(".env.example", ".env");
    console.log("created .env from .env.example");
  }
  run("pnpm infra:up");
  run("pnpm db:migrate");
  run("pnpm db:seed");
} catch {
  console.error("\nSetup stopped at the step above. `pnpm preflight` explains what's missing.");
  process.exit(1);
}

console.log(`
Ready. Next:
  pnpm dev           web http://localhost:3000 · api http://localhost:8787
  sign in as admin@demo.test or reviewer@demo.test, password demo-password (dev only)
  pnpm preflight     checks the installation if anything looks wrong`);
