import { expect, test } from "@playwright/test";

// A workspace's own document type end to end, on the simulator: accept the invite, add a category
// from a starter in Settings → Categories, upload a document of that type, review it (its fields in
// the definition's order) and approve it, and the frozen payload carries the custom fields.
//
// It needs a fresh workspace on the simulator, so the demo's recorded answers stay as they are:
//   DEFAULT_MODEL=sim:simulated pnpm tenant:create --name E2E --slug e2e --admin e2e-admin@e2e.test \
//     --accept-with google_or_password    (a password: with Google configured the default is Google only)
// (in Docker: docker compose exec -e DEFAULT_MODEL=sim:simulated api entrypoint cli tenant-create …),
// then E2E_INVITE_URL=<the printed link> pnpm e2e. CI's e2e job does both.

const { WEB_URL: WEB = "http://localhost:3000", E2E_INVITE_URL: INVITE } = process.env;
const API = `${WEB}/api`;
// A test-only password for the throwaway workspace this spec's invite creates.
const PASSWORD = "e2e-categories-password";

test("a custom category from a starter: classify, extract in field order, review, approve", async ({ page }) => {
  test.skip(!INVITE, "set E2E_INVITE_URL to a fresh workspace's invite link (see the comment above)");
  if (!INVITE) return;
  page.on("dialog", (d) => void d.accept());

  // The first admin joins with a password.
  await page.goto(INVITE);
  await page.getByLabel("Your name").fill("E2E Admin");
  await page.getByLabel(/^Password/).fill(PASSWORD);
  await page.getByLabel("Repeat it").fill(PASSWORD);
  await page.getByRole("button", { name: "Join" }).click();
  await expect(page).toHaveURL(`${WEB}/`);

  // Add Receipt from the starters.
  await page.goto("/settings/categories");
  await page.getByRole("button", { name: "Receipt" }).click();
  await page.getByRole("button", { name: "Save and activate" }).click();
  await expect(page.getByRole("status")).toContainText("Saved receipt v1");
  await expect(page.getByText("custom v1")).toBeVisible();

  // Upload a receipt.
  await page.goto("/documents");
  await page.locator("input[name=file]").setInputFiles({
    name: "receipt.txt",
    mimeType: "text/plain",
    buffer: Buffer.from(
      `RECEIPT\nPayment received, thank you.\nMerchant name: Blue Bottle Coffee\nPurchase date: 2026-10-03\nTotal: 12.50\nPayment method: card\nRef ${Date.now()}\n`,
    ),
  });
  await page.getByRole("button", { name: "Upload" }).click();
  await expect(page.getByText("receipt.txt: uploaded")).toBeVisible();

  // The worker classifies it as the new category, and a person reviews it (every category is on
  // review_all after a category change).
  type Task = { id: string; documentId: string };
  const firstTask = async (): Promise<Task | null> => {
    const res = await (await page.request.get(`${API}/review/tasks?category=receipt`)).json();
    return (res.tasks as Task[])[0] ?? null;
  };
  await expect.poll(firstTask, { timeout: 60_000 }).not.toBeNull();
  const task = (await firstTask()) as Task;

  // The review form lists the definition's fields, in its order.
  const detail = await (await page.request.get(`${API}/documents/${task.documentId}`)).json();
  expect(Object.keys(detail.schema.properties)).toEqual([
    "merchant_name",
    "purchase_date",
    "currency",
    "total",
    "tax",
    "payment_method",
  ]);
  await page.goto(`/review/${task.id}`);
  await expect(page.getByText(/claimed until/)).toBeVisible();
  await expect(page.getByLabel("Merchant name", { exact: true })).toHaveValue("Blue Bottle Coffee");

  await page.getByRole("button", { name: /^Approve/ }).click();
  await expect(page).not.toHaveURL(`/review/${task.id}`);

  // The approval froze a payload with the custom category and its fields.
  const after = await (await page.request.get(`${API}/documents/${task.documentId}`)).json();
  expect(after.actions).toHaveLength(1);
  expect(after.actions[0].payload).toMatchObject({
    event: "document.approved",
    category: "receipt",
    fields: { merchant_name: "Blue Bottle Coffee", total: 12.5 },
  });
});
