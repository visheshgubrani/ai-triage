// Turns `record.ts`'s footage into the finished demo video (`pnpm demo:render`).
//
// Each output frame is drawn by compositor.html in headless Chromium (window frame, camera zoom,
// cursor, title and outro cards) and piped to ffmpeg. All timing is computed here, so a render is
// deterministic: the same footage always gives the same video. Needs ffmpeg with libx264.
//
// Output: test-results/demo/ai-triage-demo.mp4, and in docs/media: demo.gif (the README teaser),
// the README stills and social-preview.png.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Page } from "@playwright/test";

const ROOT = join(import.meta.dirname, "../..");
const IN = join(ROOT, "test-results/demo");
const MEDIA = join(ROOT, "docs/media");
const FPS = 30;

type Rect = { x: number; y: number; width: number; height: number };
type Event =
  | { type: "move"; t0: number; t1: number; from: [number, number]; to: [number, number] }
  | { type: "click"; t: number; x: number; y: number }
  | { type: "camera"; t: number; rect: Rect | null; zoom: number; duration: number }
  | { type: "cut"; t0: number; t1: number }
  | { type: "scene"; t: number; name: string }
  | { type: "url"; t: number; url: string };
type Footage = {
  start: number;
  end: number;
  viewport: { width: number; height: number };
  web: string;
  catcher: string;
  frames: { file: string; t: number }[];
};

const footage = JSON.parse(readFileSync(join(IN, "frames.json"), "utf8")) as Footage;
const events = JSON.parse(readFileSync(join(IN, "events.json"), "utf8")) as Event[];
const of = <T extends Event["type"]>(type: T) =>
  events.filter((e): e is Extract<Event, { type: T }> => e.type === type);

// ── Layout: the browser window at zoom 1, centred in 1920×1080 ──

const W = 1520;
const S0 = W / footage.viewport.width;
const H = footage.viewport.height * S0;
const BAR = 44;
const WIN = { x: (1920 - W) / 2, y: (1080 - H - BAR) / 2, w: W, h: H, bar: BAR };
/** A point in the app's CSS pixels → stage pixels. */
const toStage = (x: number, y: number): [number, number] => [WIN.x + x * S0, WIN.y + BAR + y * S0];

// ── Easing ──

const clamp01 = (p: number) => Math.min(1, Math.max(0, p));
const easeInOut = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2);
const easeOut = (p: number) => 1 - (1 - p) ** 3;
const lerp = (a: number, b: number, p: number) => a + (b - a) * p;

// ── Time: the recording minus its cuts ──

const cuts = of("cut").sort((a, b) => a.t0 - b.t0);
const cutLength = cuts.reduce((s, c) => s + (c.t1 - c.t0), 0);
const appDuration = footage.end - footage.start - cutLength;

/** Seconds into the edited app footage → recording time. */
function toRec(u: number): number {
  let r = footage.start + u;
  for (const c of cuts) {
    if (r >= c.t0) r += c.t1 - c.t0;
    else break;
  }
  return r;
}
/** Recording time → seconds into the edited footage (a time inside a cut maps to the cut). */
function toEdit(r: number): number {
  let u = r - footage.start;
  for (const c of cuts) {
    if (r >= c.t1) u -= c.t1 - c.t0;
    else if (r > c.t0) u -= r - c.t0;
  }
  return u;
}
const cutPoints = cuts.map((c) => ({ at: toEdit(c.t0), before: c.t0 - 0.001 }));

function frameAt(r: number): string {
  const fr = footage.frames;
  let lo = 0;
  let hi = fr.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((fr[mid]?.t ?? 0) <= r) lo = mid;
    else hi = mid - 1;
  }
  return pathToFileURL(join(IN, "frames", fr[lo]?.file ?? "")).href;
}

// ── Camera: eased moves between framings, in log-zoom so zooming feels even ──

type Cam = { cx: number; cy: number; z: number };
const HOME: Cam = { cx: 960, cy: 540, z: 1 };

function framing(rect: Rect | null, zoom: number): Cam {
  if (!rect) return HOME;
  const [x0, y0] = toStage(rect.x, rect.y);
  const w = rect.width * S0;
  const h = rect.height * S0;
  // Never so close that the target doesn't fit.
  const z = Math.max(1, Math.min(zoom, (1920 * 0.86) / w, (1080 * 0.8) / h));
  const keepInside = (c: number, half: number, lo: number, hi: number) =>
    hi - lo >= 2 * half ? Math.min(hi - half, Math.max(lo + half, c)) : (lo + hi) / 2;
  return {
    z,
    cx: keepInside(x0 + w / 2, 960 / z, WIN.x, WIN.x + WIN.w),
    cy: keepInside(y0 + h / 2, 540 / z, WIN.y, WIN.y + BAR + WIN.h),
  };
}

const moves = of("camera").sort((a, b) => a.t - b.t);
const starts: Cam[] = [];
function camAt(r: number, upTo = moves.length): Cam {
  let cam = HOME;
  for (let i = 0; i < upTo; i++) {
    const m = moves[i];
    if (!m || m.t > r) break;
    const from = starts[i] ?? HOME;
    const to = framing(m.rect, m.zoom);
    const p = easeInOut(clamp01((r - m.t) / m.duration));
    cam = {
      cx: lerp(from.cx, to.cx, p),
      cy: lerp(from.cy, to.cy, p),
      z: Math.exp(lerp(Math.log(from.z), Math.log(to.z), p)),
    };
  }
  return cam;
}
moves.forEach((m, i) => {
  starts[i] = camAt(m.t, i);
});

// ── Cursor ──

const pointerMoves = of("move").sort((a, b) => a.t0 - b.t0);
const clicks = of("click");
function cursorAt(r: number) {
  let pos = pointerMoves[0]?.from ?? [footage.viewport.width / 2, footage.viewport.height / 2];
  for (const m of pointerMoves) {
    if (m.t0 > r) break;
    const p = easeInOut(clamp01((r - m.t0) / Math.max(0.001, m.t1 - m.t0)));
    pos = [lerp(m.from[0], m.to[0], p), lerp(m.from[1], m.to[1], p)];
  }
  const [x, y] = toStage(pos[0], pos[1]);
  const press = clicks.some((c) => r >= c.t - 0.06 && r < c.t + 0.16);
  const click = clicks.find((c) => r >= c.t && r < c.t + 0.55);
  const ripple = click
    ? { x: toStage(click.x, click.y)[0], y: toStage(click.x, click.y)[1], p: easeOut((r - click.t) / 0.55) }
    : null;
  return { cursor: { x, y, scale: press ? 0.82 : 1 }, ripple };
}

// ── URL bar ──

const urls = of("url").sort((a, b) => a.t - b.t);
function urlAt(r: number): string {
  let url = urls[0]?.url ?? footage.web;
  for (const u of urls) if (u.t <= r) url = u.url;
  return url
    .replace(footage.web, "localhost:3000")
    .replace(footage.catcher, "localhost:9030")
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, (id) => `${id.slice(0, 8)}…`)
    .replace(/\/$/, "");
}

// ── The edit ──

const TITLE_OUT = 2.9; // the title starts leaving
const APP0 = 3.3; // the app footage starts playing
const OUTRO0 = APP0 + appDuration;
const TOTAL = OUTRO0 + 4.8;
const XFADE = 0.3;

const enter = (t: number, at: number, dur = 0.8): [number, number, number] => {
  const p = easeOut(clamp01((t - at) / dur));
  return [p, lerp(36, 0, p), lerp(0.96, 1, p)];
};

function stateAt(frame: number) {
  const time = frame / FPS;
  // Title card.
  let title: [number, number, number][] | null = null;
  if (time < TITLE_OUT + 0.7) {
    const leave = easeInOut(clamp01((time - TITLE_OUT) / 0.6));
    title = [0.2, 0.4, 0.62].map((at) => {
      const [o, dy, s] = enter(time, at);
      return [o * (1 - leave), dy - 24 * leave, s * (1 + 0.05 * leave)] as [number, number, number];
    });
  }
  // The window: in after the title, out before the outro.
  const inP = easeOut(clamp01((time - (TITLE_OUT + 0.2)) / 0.9));
  const outP = easeInOut(clamp01((time - OUTRO0) / 0.8));
  const win = {
    opacity: inP * (1 - outP),
    scale: lerp(0.9, 1, inP) * lerp(1, 0.92, outP),
    dy: lerp(90, 0, inP) - 50 * outP,
  };
  // Outro card.
  const outro = time >= OUTRO0 + 0.3 ? [0.35, 0.55, 0.75, 0.95].map((at) => enter(time, OUTRO0 + at)) : null;

  const u = Math.min(Math.max(0, time - APP0), appDuration);
  const r = toRec(u);
  const cut = cutPoints.find((c) => u >= c.at && u < c.at + XFADE);
  // The background drifts on the cards and holds still behind the app.
  const bgTime = time < APP0 ? time : time < OUTRO0 ? APP0 : APP0 + (time - OUTRO0);
  return {
    time,
    bgTime,
    frame,
    title,
    outro,
    win,
    imgA: frameAt(r),
    imgB: cut ? frameAt(cut.before) : null,
    mixB: cut ? 1 - easeInOut((u - cut.at) / XFADE) : 0,
    cam: camAt(r),
    url: urlAt(r),
    ...cursorAt(r),
  };
}

// ── Render ──

function ffmpeg(args: string[]) {
  const res = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "inherit" });
  if (res.status !== 0) throw new Error(`ffmpeg ${args.join(" ")} failed`);
}

const mp4 = join(IN, "ai-triage-demo.mp4");
const RENDERED = join(IN, "render");
const option = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
// Chromium on the GPU where there is one (it falls back to software by itself).
const LAUNCH = { args: ["--ignore-gpu-blocklist", "--enable-gpu-rasterization", "--enable-zero-copy"] };
const draw = (page: Page, state: unknown) =>
  page.evaluate((s) => (window as unknown as { draw: (s: unknown) => Promise<void> }).draw(s), state);

async function compositor(viewport: { width: number; height: number }) {
  const browser = await chromium.launch(LAUNCH);
  const page = await browser.newPage({ viewport });
  await page.goto(pathToFileURL(join(import.meta.dirname, "compositor.html")).href);
  await page.evaluate(async (L) => {
    (window as unknown as { layout: (l: typeof L) => void }).layout(L);
    await document.fonts.ready;
  }, WIN);
  return { browser, page };
}

// `--at=1.5,12,40`: just those moments as PNGs (test-results/demo/at-<t>.png), to check a change quickly.
const at = option("at");
if (at) {
  const { browser, page } = await compositor({ width: 1920, height: 1080 });
  for (const t of at.split(",").map(Number)) {
    await draw(page, stateAt(Math.round(t * FPS)));
    await page.screenshot({ path: join(IN, `at-${t}.png`) });
  }
  console.log(`total ${TOTAL.toFixed(1)} s, app footage ${appDuration.toFixed(1)} s`);
  await browser.close();
  process.exit(0);
}

// Draw every frame to test-results/demo/render/, split across several browsers (drawing is the slow
// part, and each browser takes its own share of the cores). `--encode-only` reuses the last frames.
const frames = Math.round(TOTAL * FPS);
if (!process.argv.includes("--encode-only")) {
  const workers = Number(option("workers") ?? Math.max(1, Math.min(6, availableParallelism() - 4)));
  rmSync(RENDERED, { recursive: true, force: true });
  mkdirSync(RENDERED, { recursive: true });
  const began = Date.now();
  let drawn = 0;
  await Promise.all(
    Array.from({ length: workers }, async (_, k) => {
      const { browser, page } = await compositor({ width: 1920, height: 1080 });
      for (let f = Math.floor((frames * k) / workers); f < Math.floor((frames * (k + 1)) / workers); f++) {
        await draw(page, stateAt(f));
        await page.screenshot({ path: join(RENDERED, `${String(f).padStart(6, "0")}.jpg`), type: "jpeg", quality: 95 });
        if (++drawn % 300 === 0)
          console.log(`${drawn}/${frames} frames (${((Date.now() - began) / 1000).toFixed(0)} s)`);
      }
      await browser.close();
    }),
  );
  console.log(`drew ${frames} frames with ${workers} browsers in ${((Date.now() - began) / 1000).toFixed(0)} s`);
}

// Encode. `--gpu` uses VAAPI (AMD and Intel) for a fast draft; the default, x264, is smaller at the
// same quality, which matters for GitHub's 10 MB video limit.
const input = ["-framerate", String(FPS), "-i", join(RENDERED, "%06d.jpg"), "-an"];
const crf = option("crf") ?? "30";
ffmpeg(
  process.argv.includes("--gpu")
    ? [
        "-vaapi_device",
        "/dev/dri/renderD128",
        ...input,
        "-vf",
        "format=nv12,hwupload",
        "-c:v",
        "h264_vaapi",
        "-qp",
        "24",
        "-movflags",
        "+faststart",
        mp4,
      ]
    : [
        ...input,
        "-c:v",
        "libx264",
        "-preset",
        "slow",
        "-crf",
        crf,
        "-tune",
        "animation",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        mp4,
      ],
);
console.log(`${mp4}: ${TOTAL.toFixed(1)} s`);

// The social preview: the title card at GitHub's 1280×640.
const { browser, page: social } = await compositor({ width: 1280, height: 640 });
await social.evaluate(() => document.body.classList.add("social"));
await draw(social, {
  ...stateAt(Math.round(2 * FPS)),
  win: { opacity: 0, scale: 1, dy: 0 },
  time: 6,
});
await social.evaluate(() => {
  for (const id of ["b1", "b2", "b3"]) {
    const el = document.getElementById(id) as HTMLElement;
    el.style.transform = el.style.transform.replace(
      /translate\(([-\d.]+)px, ([-\d.]+)px\)/,
      (_, x, y) => `translate(${x * 0.66}px, ${y * 0.6}px)`,
    );
  }
});
await social.screenshot({ path: join(MEDIA, "social-preview.png") });
await browser.close();

// The README teaser: the review and the webhook it became, sped up a little to stay short.
const scenes = of("scene");
const sceneAt = (name: string) => APP0 + toEdit(scenes.find((s) => s.name === name)?.t ?? footage.start);
const from = sceneAt("review");
const to = sceneAt("webhook") + 4.5;
const speed = Math.max(1, (to - from) / 18);
ffmpeg([
  ...["-ss", from.toFixed(2), "-t", (to - from).toFixed(2), "-i", mp4],
  ...[
    "-vf",
    `setpts=PTS/${speed.toFixed(3)},fps=10,scale=720:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=160:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle`,
  ],
  ...["-loop", "0", join(MEDIA, "demo.gif")],
]);

// README stills: the 2× screenshots, at 1920 wide.
for (const name of ["dashboard", "review", "evals-runs", "evals-sweep", "categories"]) {
  ffmpeg(["-i", join(IN, "stills", `${name}.png`), "-vf", "scale=1920:-1:flags=lanczos", join(MEDIA, `${name}.png`)]);
}
console.log(
  `teaser ${((to - from) / speed).toFixed(1)} s at ${speed.toFixed(2)}×; stills and social preview in ${MEDIA}`,
);
