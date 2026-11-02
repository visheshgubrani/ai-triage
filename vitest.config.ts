import { existsSync } from "node:fs";
import { defineConfig } from "vitest/config";

// DB tests read DATABASE_OWNER_URL / DATABASE_URL to build a scratch database.
if (existsSync(".env")) process.loadEnvFile(".env");

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts", "fixtures/src/**/*.test.ts"],
          exclude: ["**/*.db.test.ts", "**/node_modules/**"],
        },
      },
      {
        // Needs Postgres (`pnpm infra:up`). The global setup recreates the `triage_test` database,
        // runs the full migration and seed, and provides its URLs to tests via inject("dbUrls").
        test: {
          name: "db",
          include: ["packages/*/src/**/*.db.test.ts", "apps/*/src/**/*.db.test.ts", "fixtures/src/**/*.db.test.ts"],
          globalSetup: ["packages/db/test/global-setup.ts"],
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
