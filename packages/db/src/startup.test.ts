import { describe, expect, it } from "vitest";
import { DEV_ENCRYPTION_KEY } from "./crypto";
import { assertDemoSeedAllowed, DEV_DEFAULTS, unsafeConfig } from "./startup";
import { describeDatabase, explainDatabaseError } from "./startup-checks";

const safe = {
  BETTER_AUTH_SECRET: "x".repeat(44),
  PUBLIC_URL: "https://triage.example.com",
  POSTMARK_INBOUND_PASSWORD: "a-long-random-postmark-password",
  S3_SECRET_ACCESS_KEY: "a-real-secret",
  DATABASE_URL: "postgres://triage_app:s3cret-pw@db:5432/triage",
  ENCRYPTION_KEY: "cmVhbC1rZXktY2hvc2VuLWJ5LXRoZS1vcGVyYXRvciE=",
};

describe("unsafeConfig", () => {
  it("accepts an operator-chosen production environment", () => {
    expect(unsafeConfig(safe, "api")).toEqual([]);
    expect(unsafeConfig(safe, "worker")).toEqual([]);
  });

  it("flags every dev default from .env.example", () => {
    const problems = unsafeConfig(
      {
        BETTER_AUTH_SECRET: DEV_DEFAULTS.betterAuthSecret,
        PUBLIC_URL: "http://triage.example.com",
        POSTMARK_INBOUND_PASSWORD: DEV_DEFAULTS.postmarkPassword,
        ENCRYPTION_KEY: DEV_ENCRYPTION_KEY,
        S3_SECRET_ACCESS_KEY: DEV_DEFAULTS.s3SecretKey,
        DATABASE_URL: "postgres://triage_app:triage_app@localhost:5440/triage",
      },
      "api",
    );
    expect(problems).toHaveLength(6);
  });

  it("flags a short auth secret and a missing public URL", () => {
    const problems = unsafeConfig({ ...safe, BETTER_AUTH_SECRET: "short", PUBLIC_URL: undefined }, "api");
    expect(problems.join("\n")).toMatch(/BETTER_AUTH_SECRET/);
    expect(problems.join("\n")).toMatch(/PUBLIC_URL/);
  });

  it("accepts plain http only on this machine (a local install)", () => {
    for (const url of ["http://localhost:3000", "http://127.0.0.1:4200", "http://[::1]:3000"]) {
      expect(unsafeConfig({ ...safe, PUBLIC_URL: url }, "api"), url).toEqual([]);
    }
    expect(unsafeConfig({ ...safe, PUBLIC_URL: "http://localhost.example.com" }, "api").join()).toMatch(/PUBLIC_URL/);
  });

  it("still accepts the older WEB_ORIGIN as the public URL", () => {
    expect(unsafeConfig({ ...safe, PUBLIC_URL: undefined, WEB_ORIGIN: "https://triage.example.com" }, "api")).toEqual(
      [],
    );
  });

  it("requires an operator-chosen encryption key", () => {
    expect(unsafeConfig({ ...safe, ENCRYPTION_KEY: undefined }, "worker").join()).toMatch(/ENCRYPTION_KEYS/);
    expect(unsafeConfig({ ...safe, ENCRYPTION_KEY: undefined, ENCRYPTION_KEYS: "a:x,b:y" }, "api")).toEqual([]);
  });

  it("checks only storage, database and key settings for the worker", () => {
    expect(unsafeConfig({ ...safe, BETTER_AUTH_SECRET: undefined, PUBLIC_URL: undefined }, "worker")).toEqual([]);
    expect(unsafeConfig({ ...safe, S3_SECRET_ACCESS_KEY: DEV_DEFAULTS.s3SecretKey }, "worker")).toHaveLength(1);
  });

  it("leaves the Postmark check off when the endpoint is disabled", () => {
    expect(unsafeConfig({ ...safe, POSTMARK_INBOUND_PASSWORD: undefined }, "api")).toEqual([]);
  });

  it("refuses a fake Google in either process", () => {
    expect(unsafeConfig({ ...safe, GOOGLE_OAUTH_URL: "http://fake-google:9040" }, "api").join()).toMatch(/fake Google/);
    expect(unsafeConfig({ ...safe, GOOGLE_API_URL: "http://fake-google:9040" }, "worker")).toHaveLength(1);
  });
});

describe("assertDemoSeedAllowed", () => {
  it("refuses the demo seed in production unless TRIAGE_DEMO=true", () => {
    expect(() => assertDemoSeedAllowed({ NODE_ENV: "production" })).toThrow(/demo tenant/);
    expect(() => assertDemoSeedAllowed({ NODE_ENV: "production", TRIAGE_DEMO: "true" })).not.toThrow();
    expect(() => assertDemoSeedAllowed({})).not.toThrow();
  });
});

describe("explainDatabaseError", () => {
  const url = "postgres://triage_app:secret@db.internal:5440/triage";

  it("never prints the password", () => {
    expect(describeDatabase(url)).toBe("triage_app@db.internal:5440/triage");
  });

  it("points a failed login at db:migrate, which creates the app role", () => {
    const message = explainDatabaseError({ code: "28P01", message: "password authentication failed" }, url);
    expect(message).toContain("`pnpm db:migrate`");
    expect(message).not.toContain("secret");
  });

  it("leaves errors it doesn't know alone", () => {
    expect(explainDatabaseError({ code: "XX000" }, url)).toBeNull();
  });
});
