import { afterAll, describe, expect, it } from "vitest";
import { createDb, createPool } from "./index";
import { claimSetup, rotateSetupToken, SETUP_TOKEN_TTL_MS, setupNeeded } from "./setup";
import { testDbUrls } from "./testing";

const app = createPool(testDbUrls().appUrl);
const db = createDb(app);
afterAll(async () => {
  await app.query("delete from installation");
  await app.end();
});

describe("first-run setup", () => {
  it("is closed once a workspace exists (the test database has the demo tenant)", async () => {
    expect(await setupNeeded(db)).toBe(false);
  });

  it("takes the current token once, never an old, wrong or expired one", async () => {
    const now = new Date();
    const old = await rotateSetupToken(db, now);
    const token = await rotateSetupToken(db, now);
    expect(await claimSetup(db, old, now)).toBe(false);
    expect(await claimSetup(db, "not-the-token-at-all-xx", now)).toBe(false);
    expect(await claimSetup(db, token, new Date(now.getTime() + SETUP_TOKEN_TTL_MS + 1000))).toBe(false);
    expect(await claimSetup(db, token, now)).toBe(true);
    expect(await claimSetup(db, token, now)).toBe(false);
    const { rows } = await app.query("select setup_token_hash from installation");
    // Only a hash was ever stored, and it's gone once used.
    expect(rows[0]?.setup_token_hash).toBeNull();
  });
});
