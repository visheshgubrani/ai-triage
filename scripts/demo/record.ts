// Records the demo video's raw footage against a running demo (`pnpm demo:record`).
//
// It drives the real app with Playwright and saves 2× frames (CDP screencast) plus a timeline of
// what happened: pointer moves, clicks, camera moves (where the renderer zooms), URLs, and the waits
// to cut. `render.ts` turns that into the finished video. Run it against a FRESH demo: it approves an
// invoice and freezes a config, so a second run on the same data finds a different story.
//
//   WEB_URL=http://localhost:3000 CATCHER_URL=http://localhost:9030 pnpm demo:record
//
// Output: test-results/demo/{frames/*.jpg,frames.json,events.json,stills/*.png}.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Locator } from "@playwright/test";

const { WEB_URL: WEB = "http://localhost:3000", CATCHER_URL: CATCHER = "http://localhost:9030" } = process.env;
const OUT = join(import.meta.dirname, "../../test-results/demo");
const VIEWPORT = { width: 1440, height: 900 };

type Rect = { x: number; y: number; width: number; height: number };
type Event =
  | { type: "move"; t0: number; t1: number; from: [number, number]; to: [number, number] }
  | { type: "click"; t: number; x: number; y: number }
  | { type: "camera"; t: number; rect: Rect | null; zoom: number; duration: number }
  | { type: "cut"; t0: number; t1: number }
  | { type: "scene"; t: number; name: string }
  | { type: "url"; t: number; url: string };

const now = () => Date.now() / 1000;
const events: Event[] = [];
let pointer: [number, number] = [VIEWPORT.width * 0.62, VIEWPORT.height * 0.7];

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, "frames"), { recursive: true });
mkdirSync(join(OUT, "stills"), { recursive: true });

// A real 2× surface: the screencast ignores emulated deviceScaleFactor, but follows a forced one.
const browser = await chromium.launch({ args: ["--force-device-scale-factor=2", "--hide-scrollbars"] });
const context = await browser.newContext({ viewport: VIEWPORT, colorScheme: "light", baseURL: WEB });
const page = await context.newPage();

// ── Helpers ──

const pause = (ms: number) => page.waitForTimeout(ms);
const easeInOut = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2);

async function box(locator: Locator): Promise<Rect> {
  await locator.waitFor({ state: "visible" });
  const b = await locator.boundingBox();
  if (!b) throw new Error(`no box for ${locator}`);
  return b;
}

/** Moves the real pointer (so hover states show) and logs the move for the drawn cursor. */
async function moveTo(x: number, y: number, ms = 650) {
  const from = pointer;
  const t0 = now();
  const steps = Math.max(2, Math.round(ms / 16));
  for (let i = 1; i <= steps; i++) {
    const p = easeInOut(i / steps);
    await page.mouse.move(from[0] + (x - from[0]) * p, from[1] + (y - from[1]) * p);
    await pause(ms / steps);
  }
  pointer = [x, y];
  events.push({ type: "move", t0, t1: now(), from, to: pointer });
}

async function hover(locator: Locator, ms?: number) {
  const b = await box(locator);
  await moveTo(b.x + b.width / 2, b.y + b.height / 2, ms);
}

async function click(locator: Locator, { clicks = 1, ms }: { clicks?: number; ms?: number } = {}) {
  await hover(locator, ms);
  await pause(120);
  events.push({ type: "click", t: now(), x: pointer[0], y: pointer[1] });
  await page.mouse.click(pointer[0], pointer[1], { clickCount: clicks, delay: 60 });
}

/** Points the camera at a region (CSS px of the viewport); null zooms back out. */
async function camera(target: Locator | Rect | null, zoom = 1.6, duration = 0.9) {
  const rect = target === null ? null : "x" in target ? target : await box(target);
  events.push({ type: "camera", t: now(), rect, zoom: rect ? zoom : 1, duration });
}

async function union(...locators: Locator[]): Promise<Rect> {
  const boxes = await Promise.all(locators.map(box));
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.width));
  const bottom = Math.max(...boxes.map((b) => b.y + b.height));
  return { x, y, width: right - x, height: bottom - y };
}

/** Anything slow or dull (loads, waits on the worker): recorded, then cut out by the renderer. */
async function cut(fn: () => Promise<unknown>) {
  const t0 = now();
  await fn();
  await pause(150);
  events.push({ type: "cut", t0, t1: now() });
}

/** Scrolls like a person with a wheel, with the pointer over the scrolled area. */
async function scrollBy(dy: number, ms = 900) {
  const steps = Math.max(4, Math.round(ms / 16));
  let done = 0;
  for (let i = 1; i <= steps; i++) {
    const target = Math.round(dy * easeInOut(i / steps));
    await page.mouse.wheel(0, target - done);
    done = target;
    await pause(ms / steps);
  }
}

async function scrollIntoView(locator: Locator, topOffset = 140, ms = 900) {
  const b = await box(locator);
  await scrollBy(b.y - topOffset, ms);
  await pause(250);
}

const still = (name: string) => cut(() => page.screenshot({ path: join(OUT, "stills", `${name}.png`) }));
const scene = (name: string) => events.push({ type: "scene", t: now(), name });

async function goto(url: string, ready: Locator) {
  await cut(async () => {
    await page.goto(url);
    await ready.waitFor();
    await pause(400);
  });
}

// ── Before the camera rolls: sign in, pick the invoice ──

await page.goto("/sign-in");
await page.getByLabel("Email").fill("admin@demo.test");
await page.getByLabel("Password").fill("demo-password");
await page.getByRole("button", { name: /sign in/i }).click();
await page.waitForURL(`${WEB}/`);

type Task = { id: string; documentId: string; claim: unknown; reasons: string[] };
const inbox = await (await page.request.get(`${WEB}/api/review/tasks?kind=review&category=invoice`)).json();
const task = (inbox.tasks as Task[]).find((t) => !t.claim && t.reasons.includes("rule_failed:totals_add_up"));
if (!task) throw new Error("no free invoice whose totals don't add up: record against a fresh demo (see the header)");
const runs = (await (await page.request.get(`${WEB}/api/evals/runs`)).json()).runs as {
  id: string;
  split: string;
  status: string;
}[];
if (!runs.some((r) => r.split === "calib" && r.status === "done"))
  throw new Error("the seeded calib run isn't done yet");

await page.goto("/");
await page.getByText("Documents per day").waitFor();
await pause(1200);
await page.mouse.move(...pointer);

// ── Rolling ──

const frames: { file: string; t: number }[] = [];
const writes: Promise<void>[] = [];
const cdp = await context.newCDPSession(page);
cdp.on("Page.screencastFrame", (frame) => {
  const file = `${String(frames.length).padStart(6, "0")}.jpg`;
  frames.push({ file, t: frame.metadata.timestamp ?? now() });
  writes.push(Promise.resolve(writeFileSync(join(OUT, "frames", file), Buffer.from(frame.data, "base64"))));
  void cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {});
});
page.on("framenavigated", (f) => {
  if (f === page.mainFrame()) events.push({ type: "url", t: now(), url: f.url() });
});
await cdp.send("Page.startScreencast", { format: "jpeg", quality: 90, maxWidth: 2880, maxHeight: 1800 });
// Force a first frame even on a still page.
await page.evaluate(() => document.body.animate([{ opacity: 0.999 }, { opacity: 1 }], 200));
await pause(300);
const start = now();
events.push({ type: "url", t: start, url: page.url() });

try {
  // Dashboard: what came in, what was automated.
  scene("dashboard");
  await still("dashboard");
  await pause(700);
  await camera(page.getByText("Waiting for review").locator("xpath=ancestor::div[contains(@class,'grid')][1]"), 1.5);
  await moveTo(760, 300, 900);
  await pause(1500);
  await camera(null);
  await click(page.getByRole("link", { name: /Review queue/ }).first());
  await page.getByRole("heading", { name: "Review queue" }).waitFor();
  await pause(600);

  // The queue: everything waits with its reason. Filter to the invoice whose totals don't add up.
  scene("queue");
  const reasonRow = page.getByText("Reason", { exact: true }).first().locator("xpath=..");
  await camera(reasonRow, 1.7);
  await pause(900);
  const checkFailed = page.getByRole("button", { name: /Check failed/ }).first();
  await click(checkFailed);
  await pause(1000);
  await camera(null);
  const row = page.getByText("IIP-5622.pdf", { exact: true });
  await page
    .getByRole("row")
    .nth(2)
    .waitFor({ state: "detached" })
    .catch(() => {});
  await pause(300);
  await click(row);
  await page.getByText(/claimed until/).waitFor();
  await pause(700);

  // The task: the failed check, the quotes it rests on, a fix, and an approval of that exact revision.
  scene("review");
  await still("review");
  await camera(
    await union(page.getByText(/Check failed: Totals add up/).first(), page.getByText("Subtotal plus tax")),
    1.6,
  );
  await hover(page.getByText("Subtotal plus tax"), 800);
  await pause(1700);
  const totals = await union(page.getByText(/^Subtotal: /), page.getByText(/^Total due: /));
  // Up to the line items above them, so the sums can be read.
  await camera({ x: totals.x, y: totals.y - 70, width: totals.width + 260, height: totals.height + 70 }, 2);
  await hover(page.getByText(/^Total due: /), 800);
  await pause(1800);
  await camera(null);
  await moveTo(1130, 640, 600);
  const total = page.getByLabel("Total", { exact: true });
  await scrollIntoView(total, 380, 1100);
  await camera(await union(page.getByText("Tax", { exact: true }).first(), total), 1.9);
  await pause(500);
  await click(total);
  await page.keyboard.press("End");
  for (let i = 0; i < 7; i++) await page.keyboard.press("Backspace", { delay: 40 }).then(() => pause(45));
  await pause(200);
  await page.keyboard.type("7899.98", { delay: 110 });
  if ((await total.inputValue()) !== "7899.98") throw new Error(`the total reads ${await total.inputValue()}`);
  await pause(900);
  // A focused number input under the pointer would take the wheel as +1/-1 steps.
  await total.blur();
  await camera(null);
  await moveTo(560, 520, 600);
  await scrollBy(-2000, 1000);
  await pause(300);
  const approve = page.getByRole("button", { name: /Save & approve/ });
  await camera(approve, 1.8);
  await pause(500);
  await click(approve);
  await pause(600);
  await camera(null, 1, 0.5);
  await pause(500);

  // The signed webhook the approval became.
  scene("webhook");
  await cut(async () => {
    const detail = await (await page.request.get(`${WEB}/api/documents/${task.documentId}`)).json();
    const actionId: string = detail.actions[0].id;
    for (let i = 0; i < 60; i++) {
      const all = (await (await page.request.get(`${CATCHER}/requests`)).json()) as { idempotencyKey: string }[];
      if (all.some((d) => d.idempotencyKey === actionId)) break;
      await pause(500);
    }
  });
  await goto(CATCHER, page.getByText("signature").first());
  const firstDelivery = page.locator("header").first();
  await camera(firstDelivery, 1.9);
  await moveTo(...centerOf(await box(firstDelivery.getByText("valid"))), 900);
  await pause(1600);
  await camera(page.getByText(/"total": 7899.98/).first(), 2.2);
  await pause(1700);
  await camera(null);
  await pause(300);

  // Evals: auto-approval is earned on labeled data, then frozen.
  scene("evals");
  await goto(`${WEB}/evals`, page.getByText("Headline: test-split results"));
  await still("evals-runs");
  await camera(page.getByText("Headline: test-split results").locator("xpath=ancestor::section[1]"), 1.45);
  await moveTo(820, 330, 900);
  await pause(1800);
  await camera(null);
  const calibRow = page.getByRole("row", { name: /calib/ }).first();
  await click(calibRow.getByRole("link").first());
  await page.getByText("Category accuracy").waitFor({ timeout: 60_000 });
  await pause(900);
  const freezeHeading = page.getByText("Freeze", { exact: true }).first();
  await moveTo(900, 600, 500);
  await scrollIntoView(freezeHeading, 90, 1400);
  await still("evals-sweep");
  const sweep = page.getByRole("img", { name: /Threshold sweep for invoice/ });
  await camera(sweep.locator("xpath=.."), 1.7);
  await hover(sweep, 900);
  await pause(2000);
  const freeze = page.getByRole("button", { name: "Freeze", exact: true });
  await camera(await union(freeze, page.getByLabel("Name of the frozen version")), 1.9);
  await pause(400);
  await click(freeze);
  await page.getByText(/Frozen as v\d+/).waitFor();
  await pause(1500);
  await camera(null);
  await pause(300);

  // Your own document types, from a starter.
  scene("categories");
  await click(page.getByRole("link", { name: "Settings" }).first());
  await page.getByRole("link", { name: "Categories" }).first().waitFor();
  await click(page.getByRole("link", { name: "Categories" }).first());
  await page.getByText("Active categories").waitFor();
  await pause(600);
  await still("categories");
  await camera(page.getByText("Active categories").locator("xpath=ancestor::section[1]"), 1.3);
  await pause(1600);
  await camera(null);
  const receipt = page.getByRole("button", { name: /Receipt/ }).first();
  await moveTo(900, 640, 500);
  await scrollIntoView(receipt, 300, 1000);
  await click(receipt);
  await page.getByText("New from Receipt").waitFor();
  await pause(700);
  await camera(page.getByText("Details", { exact: true }).locator("xpath=ancestor::section[1]"), 1.3);
  await pause(1600);
  await camera(null);
  await moveTo(980, 640, 500);
  const fields = page.getByText("What to extract, in the order reviewers see it.");
  await scrollIntoView(fields, 110, 1200);
  await camera(await union(fields, page.locator("input[value='total']").first()), 1.35);
  await hover(page.locator("input[value='purchase_date']").first(), 900).catch(() => {});
  await pause(1800);
  await camera(null);
  await hover(page.getByRole("button", { name: "Save and activate" }), 900);
  await pause(1400);
  scene("end");
} catch (err) {
  await page.screenshot({ path: join(OUT, "failure.png") });
  await browser.close();
  throw err;
}

await cdp.send("Page.stopScreencast");
await Promise.all(writes);
const end = now();
await browser.close();

writeFileSync(
  join(OUT, "frames.json"),
  JSON.stringify({ start, end, viewport: VIEWPORT, web: WEB, catcher: CATCHER, frames }, null, 1),
);
writeFileSync(join(OUT, "events.json"), JSON.stringify(events, null, 1));
console.log(`recorded ${frames.length} frames over ${(end - start).toFixed(1)} s into ${OUT}`);

function centerOf(b: Rect): [number, number] {
  return [b.x + b.width / 2, b.y + b.height / 2];
}
