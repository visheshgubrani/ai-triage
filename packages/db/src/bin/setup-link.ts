import { resolvePublicUrls } from "@ai-triage/core";
import { createDb, createPool, rotateSetupToken, setupNeeded } from "../index";

// `pnpm setup-link` (in Docker: `docker compose run --rm api cli setup-link`): a fresh first-run
// setup link, for when the api's startup line has scrolled away. Any earlier link stops working.

const pool = createPool();
try {
  const db = createDb(pool);
  if (!(await setupNeeded(db))) {
    console.log("Setup is closed: a workspace exists. Create more with `pnpm tenant:create`.");
    process.exit(1);
  }
  const token = await rotateSetupToken(db, new Date());
  console.log(
    `Open this link to create the first workspace (valid 24 hours, once):\n\n  ${resolvePublicUrls(process.env).origin}/setup#${token}\n`,
  );
} finally {
  await pool.end();
}
