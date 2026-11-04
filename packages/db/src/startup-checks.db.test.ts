import { afterAll, describe, expect, it } from "vitest";
import { createPool } from "./index";
import { checkStartup, pendingMigrations } from "./startup-checks";
import { testDbUrls } from "./testing";

const { appUrl } = testDbUrls();
const app = createPool(appUrl);
afterAll(() => app.end());

describe("startup checks", () => {
  it("the app role sees no pending migrations after db:migrate", async () => {
    expect(await pendingMigrations(app)).toBe(0);
  });

  it("pass for the app role outside production", async () => {
    await expect(checkStartup(app, { DATABASE_URL: appUrl }, "api")).resolves.toBeUndefined();
  });

  it("explain an unreachable database instead of throwing ECONNREFUSED", async () => {
    const url = "postgres://triage_app:x@127.0.0.1:1/triage";
    const nowhere = createPool(url);
    try {
      await expect(checkStartup(nowhere, { DATABASE_URL: url }, "worker")).rejects.toThrow(
        "Postgres isn't reachable at triage_app@127.0.0.1:1/triage (ECONNREFUSED). Start it with `pnpm infra:up`",
      );
    } finally {
      await nowhere.end();
    }
  });
});
