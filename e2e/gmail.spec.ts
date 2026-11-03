import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";

// Gmail sync (phase 6), against the running local stack with the fake Google (`pnpm fake-google`,
// and the app pointed at it: docs/google.md, "Try it without a Google project"). An admin connects
// the demo mailbox through the OAuth round trip, mail delivered into it becomes a document within a
// poll, the document names its mailbox, and disconnecting revokes the grant at "Google".

const { API_URL: API = "http://localhost:8787", FAKE_GOOGLE_URL: FAKE = "http://localhost:9040" } = process.env;

async function signIn(page: Page, email: string) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("demo-password");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page).toHaveURL("/");
}

test("connect a Gmail mailbox, sync a message into review, disconnect", async ({ page }) => {
  test.setTimeout(180_000);
  const fake = await page.request.get(`${FAKE}/fake/state`).catch(() => null);
  test.skip(!fake?.ok(), "the fake Google isn't running (pnpm fake-google)");

  await signIn(page, "admin@demo.test");
  const list = await (await page.request.get(`${API}/mailboxes`)).json();
  test.skip(!list.google, "the app isn't pointed at the fake Google (GOOGLE_CLIENT_ID, GOOGLE_OAUTH_URL)");

  await page.goto("/settings/mailboxes");
  await page.getByRole("button", { name: "Connect Google mailbox" }).click();
  await expect(page.getByText(/Mailbox connected/)).toBeVisible();
  const card = page.locator("section", { hasText: "ap@demo-workspace.test" });
  await expect(card.getByText("syncing")).toBeVisible();

  const mailbox = (
    (await (await page.request.get(`${API}/mailboxes`)).json()).mailboxes as { id: string; email: string }[]
  ).find((m) => m.email === "ap@demo-workspace.test");
  if (!mailbox) throw new Error("the demo mailbox didn't connect");
  const documentIds = async () =>
    (
      (await (await page.request.get(`${API}/mailboxes/${mailbox.id}`)).json()).messages as {
        documentId: string | null;
      }[]
    )
      .map((m) => m.documentId)
      .filter((id): id is string => id !== null);
  const before = new Set(await documentIds());

  // A unique Message-ID, so the message isn't a duplicate of an earlier run's.
  const eml = readFileSync("fixtures/docs/sup-12.eml", "utf8").replace(
    /^Message-ID:.*$/im,
    `Message-ID: <e2e-${Date.now()}@example.com>`,
  );
  expect((await page.request.post(`${FAKE}/fake/deliver`, { data: eml })).status()).toBe(201);

  // The worker polls every minute: wait for the document this run's message became.
  let documentId: string | undefined;
  await expect(async () => {
    documentId = (await documentIds()).find((id) => !before.has(id));
    expect(documentId).toBeTruthy();
  }).toPass({ timeout: 150_000, intervals: [5_000] });
  await page.goto(`/documents/${documentId}`);
  await expect(page.getByText("Gmail · ap@demo-workspace.test")).toBeVisible();
  // The fixture has no Google trace, so synced mail can't count as authenticated: it waits for a human.
  await expect(page.getByText("sender_unauthenticated").first()).toBeVisible();

  const revokedBefore = (await (await page.request.get(`${FAKE}/fake/state`)).json()).revoked as number;
  await page.goto("/settings/mailboxes");
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .locator("section", { hasText: "ap@demo-workspace.test" })
    .getByRole("button", { name: "Disconnect" })
    .click();
  await expect(page.getByText("ap@demo-workspace.test")).toHaveCount(0);
  expect((await (await page.request.get(`${FAKE}/fake/state`)).json()).revoked).toBe(revokedBefore + 1);
});
