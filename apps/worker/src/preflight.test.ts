import { describe, expect, it } from "vitest";
import { checkVersions, configBlocker } from "./preflight";

const recorded = { "openai:gpt-6.1-terra": { recordedAt: "2026-11-03", fixtures: 60, liveCalls: 112, spentUsd: 0.18 } };
const terra = [{ model: "openai:gpt-6.1-terra", effort: "low" }];
const opus = [{ model: "claude-opus-5-5", effort: "low" }];

describe("configBlocker", () => {
  it("replay runs a recorded model at its recorded effort", () => {
    expect(configBlocker(terra, "replay", {}, recorded)).toBeNull();
    expect(
      configBlocker([{ model: "openai:gpt-6.1-terra", effort: "high" }], "replay", {}, recorded)?.detail,
    ).toContain("recorded at effort low");
  });

  it("replay can't run an unrecorded model (a new tenant's Opus default)", () => {
    expect(configBlocker(opus, "replay", {}, recorded)?.detail).toContain("cassette_missing");
  });

  it("live needs the provider's key, except for compat", () => {
    expect(configBlocker(opus, "live", {}, recorded)?.fix).toBe("set ANTHROPIC_API_KEY for the worker");
    expect(configBlocker(opus, "live", { ANTHROPIC_API_KEY: "k" }, recorded)).toBeNull();
    const local = [{ model: "compat:qwen3", effort: "none" }];
    expect(configBlocker(local, "live", { OPENAI_COMPAT_BASE_URL: "http://localhost:11434/v1" }, recorded)).toBeNull();
  });
});

describe("checkVersions", () => {
  it("fails Node below 24 and old pnpm", () => {
    const results = checkVersions({ npm_config_user_agent: "pnpm/9.1.0 npm/? node/v22" }, "22.4.0");
    expect(results.map((r) => r.status)).toEqual(["fail", "fail"]);
  });
});
