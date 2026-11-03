import { DEMO_USERS, runSeed } from "../seed";
import { assertDemoSeedAllowed } from "../startup";
import { requireEnv } from "./env";

assertDemoSeedAllowed(process.env);

const { DEMO_WEBHOOK_URL: url, DEMO_WEBHOOK_SECRET: secret } = process.env;
await runSeed(
  { ownerUrl: requireEnv("DATABASE_OWNER_URL"), appUrl: requireEnv("DATABASE_URL") },
  { webhook: url && secret ? { url, secret } : undefined },
);
console.log(`seeded model prices and the demo tenant (users: ${DEMO_USERS.map((u) => u.email).join(", ")})`);
