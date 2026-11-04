import { defineConfig, devices } from "@playwright/test";

const { WEB_URL = "http://localhost:3000", WALKTHROUGH_VIDEO } = process.env;

// `pnpm e2e`: the demo walkthroughs (docs/architecture.md §10) against a running local stack:
// `pnpm infra:up && pnpm db:migrate && pnpm db:seed`, then `pnpm dev` (replay mode).
// WALKTHROUGH_VIDEO=1 records each test as video (test-results/). The README's demo video is `pnpm demo:video`.
export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: WEB_URL,
    trace: "retain-on-failure",
    video: WALKTHROUGH_VIDEO ? { mode: "on", size: { width: 1280, height: 800 } } : "off",
    ...devices["Desktop Chrome"],
    viewport: { width: 1280, height: 800 },
    // Slowed down when recording, so the video can be followed.
    launchOptions: { slowMo: WALKTHROUGH_VIDEO ? 350 : 0 },
  },
});
