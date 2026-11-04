import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createDb, createPool } from "./index";
import { COOLDOWN_BASE_MS, COOLDOWN_MAX_MS, clearCooldown, providerState, tripCooldown } from "./provider-state";
import { testDbUrls } from "./testing";

const app = createPool(testDbUrls().appUrl);
const db = createDb(app);
afterAll(() => app.end());

const at = new Date("2026-11-04T10:00:00Z");
const after = (ms: number) => new Date(at.getTime() + ms);

describe("provider cooldown", () => {
  it("doubles with each busy answer in a row, up to the cap, and resets on success", async () => {
    const model = `test-${randomUUID()}`;
    const trip = () => tripCooldown(db, { provider: "openai", model, retryAfterMs: null, reason: "429", now: at });
    expect(await trip()).toEqual(after(COOLDOWN_BASE_MS));
    expect(await trip()).toEqual(after(2 * COOLDOWN_BASE_MS));
    expect(await trip()).toEqual(after(4 * COOLDOWN_BASE_MS));
    for (let i = 0; i < 12; i++) await trip();
    expect(await trip()).toEqual(after(COOLDOWN_MAX_MS));
    await clearCooldown(db, "openai", model);
    expect(await providerState(db, "openai", model)).toBeNull();
  });

  it("honors a longer Retry-After, and never shortens a cooldown", async () => {
    const model = `test-${randomUUID()}`;
    const trip = (retryAfterMs: number | null) =>
      tripCooldown(db, { provider: "anthropic", model, retryAfterMs, reason: "529", now: at });
    expect(await trip(60_000)).toEqual(after(60_000));
    expect(await trip(null)).toEqual(after(60_000));
    expect((await providerState(db, "anthropic", model))?.consecutiveFailures).toBe(2);
  });

  it("counts concurrent busy answers once each", async () => {
    const model = `test-${randomUUID()}`;
    await Promise.all(
      Array.from({ length: 10 }, () =>
        tripCooldown(db, { provider: "deepseek", model, retryAfterMs: null, reason: "429", now: at }),
      ),
    );
    expect((await providerState(db, "deepseek", model))?.consecutiveFailures).toBe(10);
  });
});
