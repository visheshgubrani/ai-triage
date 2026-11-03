import { defineConfig, devices } from "@playwright/test";

const { WEB_URL = "http://localhost:3000" } = process.env;

// `pnpm e2e`: the demo walkthrough (docs/architecture.md §10) against a running local stack:
// `pnpm infra:up && pnpm db:migrate && pnpm db:seed`, then `pnpm dev` (replay mode).
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: WEB_URL,
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
  },
});
