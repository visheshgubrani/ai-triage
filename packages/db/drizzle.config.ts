import { defineConfig } from "drizzle-kit";

process.loadEnvFile?.("../../.env");

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  dbCredentials: {
    // drizzle-kit needs the owner; the runtime DATABASE_URL role can't run DDL.
    url: process.env.DATABASE_OWNER_URL ?? "",
  },
});
