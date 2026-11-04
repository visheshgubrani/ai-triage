import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { checkEnv, ENV_VARS, envVar, PLATFORM_ENV, renderConfigDoc, renderEnvExample } from "./env";

const root = join(import.meta.dirname, "../../..");
const SKIP_DIRS = new Set(["node_modules", "dist", ".next", ".turbo", "cassettes", "docs"]);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

describe("env registry", () => {
  it("names are unique", () => {
    const names = ENV_VARS.map((v) => v.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it(".env.example and docs/configuration.md are generated from it (pnpm config:docs)", () => {
    expect(readFileSync(join(root, ".env.example"), "utf8")).toBe(renderEnvExample());
    expect(readFileSync(join(root, "docs/configuration.md"), "utf8")).toBe(renderConfigDoc());
  });

  it("lists every variable the code reads", () => {
    const read = new Map<string, string>();
    const patterns = [
      /process\.env\.([A-Z][A-Z0-9_]+)/g,
      /\benv\.([A-Z][A-Z0-9_]+)/g,
      /\benv\[["']([A-Z][A-Z0-9_]+)["']\]/g,
    ];
    const destructured = /\{([^}]*)\}\s*=\s*process\.env/g;
    const dirs = ["apps", "packages", "fixtures/src", "e2e"].map((d) => join(root, d));
    for (const file of [...dirs.flatMap((d) => sourceFiles(d)), join(root, "playwright.config.ts")]) {
      const text = readFileSync(file, "utf8");
      for (const pattern of patterns) {
        for (const match of text.matchAll(pattern)) read.set(match[1] as string, relative(root, file));
      }
      for (const match of text.matchAll(destructured)) {
        // Only each entry's key: `{ API_URL: API = "…" }` reads API_URL, not API.
        for (const entry of (match[1] as string).split(",")) {
          const name = /^\s*([A-Z][A-Z0-9_]+)/.exec(entry)?.[1];
          if (name) read.set(name, relative(root, file));
        }
      }
    }
    const platform = new Set<string>(PLATFORM_ENV);
    const missing = [...read].filter(([name]) => !envVar(name) && !platform.has(name));
    expect(missing).toEqual([]);
  });

  it("compose.yaml keeps its defaults when a copied .env sets a variable to empty", () => {
    const compose = readFileSync(join(root, "compose.yaml"), "utf8");
    // `${VAR-default}` lets an empty VAR win; `${VAR:-default}` doesn't.
    expect(compose.match(/\$\{[A-Z_0-9]+-[^}]*\}/g) ?? []).toEqual([]);
    // Only the one-shot init gets the owner role.
    expect(compose.match(/DATABASE_OWNER_URL/g)?.length).toBe(1);
  });

  it("reports every problem at once", () => {
    const problems = checkEnv({ LLM_MODE: "lve", MAX_FILE_MB: "lots" }, "worker");
    expect(problems.some((p) => p.startsWith("DATABASE_URL is not set"))).toBe(true);
    expect(problems.some((p) => p.startsWith("S3_BUCKET is not set"))).toBe(true);
    expect(problems).toContain('LLM_MODE must be one of: replay, record, live (got "lve")');
    expect(problems).toContain('MAX_FILE_MB isn\'t a non-negative number (got "lots")');
  });

  it("never echoes a secret's value", () => {
    const [problem] = checkEnv({ DATABASE_URL: "not a url" }, "cli");
    expect(problem).toBe('DATABASE_URL isn\'t a URL (got "…")');
  });

  it("accepts the example file's values", () => {
    const example = Object.fromEntries(ENV_VARS.filter((v) => v.example).map((v) => [v.name, v.example]));
    for (const p of ["api", "worker", "cli"] as const) expect(checkEnv(example, p)).toEqual([]);
  });
});
