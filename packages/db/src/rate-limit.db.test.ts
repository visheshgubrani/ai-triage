import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createDb, createPool } from "./index";
import { hitRateLimit, pruneRateLimits } from "./rate-limit";
import { testDbUrls } from "./testing";

const pool = createPool(testDbUrls().appUrl);
const db = createDb(pool);
afterAll(() => pool.end());

describe("hitRateLimit", () => {
  it("counts atomically per bucket and window, and resets in the next window", async () => {
    const bucket = `test:${randomUUID()}`;
    const at = new Date("2026-11-03T12:00:10Z");
    const counts = await Promise.all(Array.from({ length: 10 }, () => hitRateLimit(db, bucket, 60, at)));
    expect(counts.map((c) => c.count).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(counts[0]?.resetAt).toEqual(new Date("2026-11-03T12:01:00Z"));
    expect((await hitRateLimit(db, bucket, 60, new Date("2026-11-03T12:01:00Z"))).count).toBe(1);
    expect((await hitRateLimit(db, `${bucket}:other`, 60, at)).count).toBe(1);
  });

  it("prunes old windows", async () => {
    const bucket = `test:${randomUUID()}`;
    await hitRateLimit(db, bucket, 60, new Date("2020-01-01T00:00:00Z"));
    await pruneRateLimits(db, new Date("2020-01-02T00:00:00Z"));
    expect((await hitRateLimit(db, bucket, 60, new Date("2020-01-01T00:00:30Z"))).count).toBe(1);
  });
});
