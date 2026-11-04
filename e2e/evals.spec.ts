import { expect, type Page, test } from "@playwright/test";

// The evals walkthrough (docs/architecture.md §8, §10), against the running local stack in replay:
// the seeded runs show n and Wilson bounds with a Replay badge; a new dev run finishes; the seeded
// calib run's sweep feeds Freeze; the frozen version runs on test; its cost adds up; two test runs
// diff; and "Add to eval set" on an approval reports the fixture already in the set.

// The API is the web origin's /api (Caddy in Docker, the Next rewrite in `pnpm dev`).
const { WEB_URL: WEB = "http://localhost:3000" } = process.env;
const { API_URL: API = `${WEB}/api` } = process.env;

type Run = { id: string; split: string; status: string; config: { frozen: boolean } };

async function signIn(page: Page, email: string) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("demo-password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/");
}

const runs = async (page: Page): Promise<Run[]> => (await (await page.request.get(`${API}/evals/runs`)).json()).runs;

/** Waits on a run page until the run is done and its summary tiles are shown. */
async function untilDone(page: Page) {
  await expect(page.getByText("Category accuracy")).toBeVisible({ timeout: 60_000 });
}

test("evals: runs, calibration, Freeze, test, diff", async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page, "admin@demo.test");

  const seeded = await runs(page);
  const calib = seeded.find((r) => r.split === "calib" && r.status === "done");
  test.skip(!calib, "no finished calib run: seed the demo (pnpm db:seed) and let the worker run");
  if (!calib) return;

  // The run list: every rate with k/n and a lower bound, replayed figures labeled.
  await page.goto("/evals");
  await expect(page.getByRole("heading", { name: "Evals" })).toBeVisible();
  await expect(page.getByText("Replay").first()).toBeVisible();
  await expect(page.getByText(/\d+\/\d+ ≥\d+%/).first()).toBeVisible();

  // Test is refused for an unfrozen config, in the form and by the API.
  await page.getByLabel("Split").selectOption("test");
  await page.getByLabel("Config").selectOption({ label: "v1 Demo config (active)" });
  await expect(page.getByRole("button", { name: /^Run/ })).toBeDisabled();
  const datasetId: string = (await (await page.request.get(`${API}/evals/datasets`)).json()).datasets[0].id;
  const configs = (await (await page.request.get(`${API}/configs`)).json()).configs as {
    id: string;
    active: boolean;
  }[];
  const refused = await page.request.post(`${API}/evals/runs`, {
    headers: { origin: new URL(page.url()).origin },
    data: { datasetId, split: "test", configId: configs.find((c) => c.active)?.id },
  });
  expect(refused.status()).toBe(422);
  expect((await refused.json()).code).toBe("config_not_frozen");

  // A new dev run on the active config finishes in replay.
  await page.getByLabel("Split").selectOption("dev");
  await page.getByRole("button", { name: /^Run/ }).click();
  await expect(page).toHaveURL(/\/evals\/runs\//);
  await untilDone(page);
  await expect(page.getByRole("heading", { name: /dev run/ })).toBeVisible();

  // The seeded calib run: sweep and reliability, then Freeze and run the frozen version on test.
  await page.goto(`/evals/runs/${calib.id}`);
  await untilDone(page);
  await expect(page.getByText("Reliability: does the score mean what it says?")).toBeVisible();
  await expect(page.getByRole("img", { name: /Threshold sweep for invoice/ })).toBeVisible();
  await page.getByLabel("Name of the frozen version").fill(`Calibrated ${Date.now()}`);
  await page.getByRole("button", { name: "Freeze", exact: true }).click();
  await expect(page.getByText(/Frozen as v\d+/)).toBeVisible();
  await page.getByRole("button", { name: "Run it on test" }).click();
  await expect(page).not.toHaveURL(new RegExp(calib.id));
  await untilDone(page);
  await expect(page.getByRole("heading", { name: /test run/ })).toContainText("frozen");
  await expect(page.getByText("Auto-approval precision").first()).toBeVisible();

  // The run's cost is the sum of its items' costs (each item: every attempt it made).
  const testRunId = page.url().split("/").pop() ?? "";
  const detail = await (await page.request.get(`${API}/evals/runs/${testRunId}`)).json();
  const itemsTotal = (detail.results as { costUsd: number }[]).reduce((s, r) => s + r.costUsd, 0);
  expect(detail.metrics.cost.totalUsd).toBeCloseTo(itemsTotal, 6);
  expect(detail.metrics.cost.replay).toBe(true);
  expect(detail.metrics.cost.liveUsd).toBe(0);

  // Diff this test run against an earlier one on the same split.
  const earlier = (await runs(page)).find((r) => r.split === "test" && r.status === "done" && r.id !== testRunId);
  if (earlier) {
    await page.goto(`/evals/diff?a=${earlier.id}&b=${testRunId}`);
    await expect(page.getByRole("heading", { name: "Run A vs run B" })).toBeVisible();
    await expect(page.getByText(/items in both runs/)).toBeVisible();
  }
});

test("Add to eval set reports a document whose content is already labeled", async ({ page }) => {
  await signIn(page, "reviewer@demo.test");
  const inbox = await (await page.request.get(`${API}/review/tasks?kind=review`)).json();
  const task = (inbox.tasks as { id: string; claim: unknown }[]).find((t) => !t.claim);
  test.skip(!task, "no free review task: seed the demo (pnpm db:seed) and let the worker run");
  if (!task) return;

  await page.goto(`/review/${task.id}`);
  await expect(page.getByText(/claimed until/)).toBeVisible();
  const toggle = page.getByLabel("Add to eval set");
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await page.getByLabel("Eval split").selectOption("calib");
  const decided = page.waitForResponse((r) => r.url().includes(`/review/tasks/${task.id}/decisions`));
  await page.getByRole("button", { name: /^Approve/ }).click();
  const response = await decided;
  // The demo documents are the seeded fixtures, so their content is already in the Main dataset.
  if (response.status() === 200) {
    expect((await response.json()).evalItem).toMatchObject({ duplicate: true });
  } else {
    // A revision whose values don't match the schema can't become a label (nothing is written).
    expect((await response.json()).code).toBe("invalid_fields");
  }
});
