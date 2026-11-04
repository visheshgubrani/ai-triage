import { unsafeConfig } from "@ai-triage/db";
import { describe, expect, it } from "vitest";
import { ConfigureError, configure, mergeRestored, parseEnvFile, renderEnvFile } from "./configure";

let n = 0;
/** Deterministic, distinct "random" bytes, so tests can tell secrets apart. */
const random = (bytes: number) => Buffer.alloc(bytes, ++n);

describe("cli configure", () => {
  it("writes a local install on localhost with every secret generated", () => {
    const v = configure({}, {}, {}, random);
    expect(v).toMatchObject({
      PUBLIC_URL: "http://localhost:3000",
      S3_PUBLIC_ENDPOINT: "http://localhost:3001",
      APP_SITE: "http://:3000",
      COMPOSE_FILE: "compose.yaml:compose.local.yaml",
      COMPOSE_PROFILES: "bundled",
      LLM_MODE: "live",
      DEFAULT_MODEL: "claude-opus-5-5",
      OCR_BACKEND: "off",
      COMPOSE_PROJECT_NAME: "ai-triage-install",
    });
    expect(v.DATABASE_URL).toBe(`postgres://triage_app:${v.DATABASE_APP_PASSWORD}@postgres:5432/triage`);
    expect(v.ENCRYPTION_KEYS).toMatch(/^k1:[A-Za-z0-9+/]{43}=$/);
    // The app's own production checks accept it: no dev default, secrets long enough.
    const env = { ...v, NODE_ENV: "production" };
    expect(unsafeConfig(env, "api")).toEqual([]);
    expect(unsafeConfig(env, "worker")).toEqual([]);
  });

  it("moves a local install to another port, files on the next one", () => {
    expect(configure({}, { port: 4100 }, {}, random)).toMatchObject({
      PUBLIC_URL: "http://localhost:4100",
      S3_PUBLIC_ENDPOINT: "http://localhost:4101",
      APP_SITE: "http://:4100",
      FILES_PORT: "4101",
    });
    expect(() => configure({}, { port: 80 }, {}, random)).toThrow("--port");
  });

  it("sets up a server install with HTTPS and files on :8443, and needs an email for certificates", () => {
    expect(() => configure({}, { host: "triage.acme.com" }, {}, random)).toThrow(ConfigureError);
    expect(() => configure({}, { host: "https://triage.acme.com", email: "a@b.co" }, {}, random)).toThrow(
      "isn't a hostname",
    );
    const v = configure({}, { host: "Triage.Acme.com", email: "ops@acme.com", ocr: "vulkan" }, {}, random);
    expect(v).toMatchObject({
      APP_HOST: "triage.acme.com",
      APP_SITE: "triage.acme.com",
      FILES_SITE: "triage.acme.com:8443",
      PUBLIC_URL: "https://triage.acme.com",
      S3_PUBLIC_ENDPOINT: "https://triage.acme.com:8443",
      COMPOSE_FILE: "compose.yaml:compose.server.yaml:compose.ocr-vulkan.yaml",
    });
  });

  it("goes behind an existing reverse proxy: localhost ports, https public addresses, two hostnames", () => {
    const v = configure(
      {},
      { host: "triage.acme.com", upstream: { filesHost: "files.triage.acme.com" }, port: 4600 },
      {},
      random,
    );
    expect(v).toMatchObject({
      INSTALL_MODE: "upstream",
      PUBLIC_URL: "https://triage.acme.com",
      S3_PUBLIC_ENDPOINT: "https://files.triage.acme.com",
      APP_SITE: "http://:4600",
      FILES_SITE: "http://:4601",
      COMPOSE_FILE: "compose.yaml:compose.local.yaml",
    });
    // The app's own production checks accept it (https, and no Let's Encrypt email needed).
    expect(unsafeConfig({ ...v, NODE_ENV: "production" }, "api")).toEqual([]);
    // Re-running without flags keeps the mode.
    expect(configure(v, {}, {}, random)).toMatchObject({
      INSTALL_MODE: "upstream",
      FILES_HOST: "files.triage.acme.com",
    });
    expect(() => configure({}, { host: "a.acme.com", upstream: { filesHost: "a.acme.com" } }, {}, random)).toThrow(
      "must differ",
    );
    expect(() => configure({}, { upstream: { filesHost: "f.acme.com" } }, {}, random)).toThrow("--host");
  });

  it("takes provider keys from the environment and picks a matching first model", () => {
    const v = configure({}, {}, { OPENAI_API_KEY: " sk-test " }, random);
    expect(v).toMatchObject({
      OPENAI_API_KEY: "sk-test",
      DEFAULT_MODEL: "openai:gpt-6.1-terra",
      ANTHROPIC_API_KEY: "",
    });
  });

  it("re-running keeps secrets and hand-made edits, and applies only the new flags", () => {
    const first = configure({}, {}, { ANTHROPIC_API_KEY: "sk-ant" }, random);
    const edited = parseEnvFile(`${renderEnvFile(first)}GOOGLE_CLIENT_ID=abc\nCOMPOSE_PROFILES=\n`);
    const again = configure(edited, { version: "0.7.1" }, {}, random);
    for (const k of ["POSTGRES_PASSWORD", "BETTER_AUTH_SECRET", "ENCRYPTION_KEYS", "S3_SECRET_ACCESS_KEY"]) {
      expect(again[k], k).toBe(first[k]);
    }
    expect(again).toMatchObject({
      TRIAGE_VERSION: "0.7.1",
      ANTHROPIC_API_KEY: "sk-ant",
      GOOGLE_CLIENT_ID: "abc",
      // Emptied by the operator (their own Postgres and S3): stays empty.
      COMPOSE_PROFILES: "",
    });
  });

  it("a restore takes the backup's encryption keys and integrations, never its database passwords", () => {
    const old = configure({}, {}, { ANTHROPIC_API_KEY: "sk-old" }, random);
    const fresh = configure({}, {}, {}, random);
    const merged = mergeRestored(fresh, old);
    expect(merged.ENCRYPTION_KEYS).toBe(old.ENCRYPTION_KEYS);
    expect(merged.ANTHROPIC_API_KEY).toBe("sk-old");
    expect(merged.POSTGRES_PASSWORD).toBe(fresh.POSTGRES_PASSWORD);
    expect(merged.DATABASE_URL).toBe(fresh.DATABASE_URL);
  });

  it("an upgrade keeps addresses and overlays set by hand (found on a real VPS behind its own proxy)", () => {
    const installed = configure({}, { port: 4600 }, {}, random);
    const handSet = {
      ...installed,
      PUBLIC_URL: "https://triage.acme.com",
      S3_PUBLIC_ENDPOINT: "https://files.acme.com",
      COMPOSE_FILE: `${installed.COMPOSE_FILE}:compose.override.yaml`,
    };
    const upgraded = configure(handSet, { version: "0.7.1" }, {}, random);
    expect(upgraded).toMatchObject({
      TRIAGE_VERSION: "0.7.1",
      PUBLIC_URL: "https://triage.acme.com",
      S3_PUBLIC_ENDPOINT: "https://files.acme.com",
      COMPOSE_FILE: "compose.yaml:compose.local.yaml:compose.override.yaml",
    });
    // Turning OCR on keeps the override too, after the managed files.
    expect(configure(handSet, { ocr: "cpu" }, {}, random).COMPOSE_FILE).toBe(
      "compose.yaml:compose.local.yaml:compose.ocr-cpu.yaml:compose.override.yaml",
    );
    // An address flag recomputes the addresses.
    expect(configure(handSet, { port: 4700 }, {}, random).PUBLIC_URL).toBe("http://localhost:4700");
  });

  it("round-trips through the file", () => {
    const v = configure({}, { host: "triage.acme.com", email: "ops@acme.com" }, {}, random);
    expect(parseEnvFile(renderEnvFile(v))).toEqual(v);
  });
});
