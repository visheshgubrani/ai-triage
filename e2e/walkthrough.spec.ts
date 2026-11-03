import { expect, type Page, test } from "@playwright/test";

// The demo walkthrough (docs/architecture.md §10), against the running local stack: open an invoice
// waiting for review, see its evidence and routing reasons, correct a field and approve that exact
// revision; a second tab still holding the old revision is refused; the signed webhook reaches the
// catcher; and a forced Redeliver arrives with the same Idempotency-Key while `actions` keeps one row.

const { API_URL: API = "http://localhost:8787", CATCHER_URL: CATCHER = "http://localhost:9030" } = process.env;

type Delivery = { idempotencyKey: string; signature: string; body: { fields?: Record<string, unknown> } };

async function signIn(page: Page, email: string) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("demo-password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/");
}

async function deliveriesOf(page: Page, actionId: string): Promise<Delivery[]> {
  const all = (await (await page.request.get(`${CATCHER}/requests`)).json()) as Delivery[];
  return all.filter((d) => d.idempotencyKey === actionId);
}

test("review an invoice, approve the corrected revision, deliver it signed, redeliver it", async ({
  page,
  context,
}) => {
  await signIn(page, "reviewer@demo.test");

  // An invoice waiting for review that nobody holds, with text evidence to highlight (not a scan).
  const inbox = await (await page.request.get(`${API}/review/tasks?kind=review&category=invoice`)).json();
  const task = (inbox.tasks as { id: string; documentId: string; claim: unknown; reasons: string[] }[]).find(
    (t) => !t.claim && !t.reasons.includes("evidence_unverifiable"),
  );
  test.skip(!task, "no free invoice review task: seed the demo (pnpm db:seed) and let the worker run");
  if (!task) return;

  await page.goto(`/review/${task.id}`);
  await expect(page.getByText(/claimed until/)).toBeVisible();
  await expect(page.locator("mark[id^='evidence-']").first()).toBeVisible();
  await expect(page.getByText("The model's extraction needs a human check")).toBeVisible();

  // A second tab on the same task, still showing revision 1.
  const stale = await context.newPage();
  await stale.goto(`/review/${task.id}`);
  await expect(stale.getByRole("button", { name: /^Approve/ })).toBeEnabled();

  // Correct a field: the edit becomes revision 2, and that revision is approved.
  const invoiceNumber = page.getByLabel("Invoice number", { exact: true });
  const corrected = `${await invoiceNumber.inputValue()}-W`;
  await invoiceNumber.fill(corrected);
  await page.getByRole("button", { name: /Save & approve/ }).click();
  await expect(page).not.toHaveURL(`/review/${task.id}`);

  // The stale tab can't approve the old revision.
  await stale.getByRole("button", { name: /^Approve/ }).click();
  await expect(stale.getByRole("main").getByRole("alert")).toContainText("Nothing was changed");

  const detail = await (await page.request.get(`${API}/documents/${task.documentId}`)).json();
  expect(detail.extraction).toMatchObject({ revision: 2, author: "user" });
  expect(detail.actions).toHaveLength(1);
  const actionId: string = detail.actions[0].id;

  // The worker delivers it to the catcher, signed, with the corrected value.
  await expect.poll(async () => (await deliveriesOf(page, actionId)).length, { timeout: 20_000 }).toBe(1);
  const [first] = await deliveriesOf(page, actionId);
  expect(first?.signature).toBe("valid");
  expect(first?.body.fields?.invoice_number).toBe(corrected);

  // A forced redelivery: same Idempotency-Key, still one action.
  // Like the browser's own fetches, a write carries the web origin (the API refuses others).
  const redeliver = await page.request.post(`${API}/actions/${actionId}/redeliver`, {
    headers: { origin: new URL(page.url()).origin },
  });
  expect(redeliver.status()).toBe(200);
  await expect.poll(async () => (await deliveriesOf(page, actionId)).length, { timeout: 20_000 }).toBe(2);
  const after = await (await page.request.get(`${API}/documents/${task.documentId}`)).json();
  expect(after.actions).toHaveLength(1);
  expect(after.actions[0]).toMatchObject({ id: actionId, status: "delivered" });
});
