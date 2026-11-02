import { DEMO_USERS, runSeed } from "../seed";
import { requireEnv } from "./env";

await runSeed({ ownerUrl: requireEnv("DATABASE_OWNER_URL"), appUrl: requireEnv("DATABASE_URL") });
console.log(`seeded model prices and the demo tenant (users: ${DEMO_USERS.map((u) => u.email).join(", ")})`);
