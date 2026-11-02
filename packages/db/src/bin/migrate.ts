import { runMigrations } from "../migrate";
import { requireEnv } from "./env";

const { appRole } = await runMigrations({
  ownerUrl: requireEnv("DATABASE_OWNER_URL"),
  appUrl: requireEnv("DATABASE_URL"),
});
console.log(`migrations applied (app role: ${appRole})`);
