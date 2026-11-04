import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// Fairness rests on every tenant job carrying its tenant as its pg-boss group (boss.ts), so jobs
// are sent only through boss.ts's helpers.
const root = join(import.meta.dirname, "../../..");

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === ".next") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

describe("job sends", () => {
  it("go through packages/db/src/boss.ts only", () => {
    const direct = [join(root, "apps"), join(root, "packages")]
      .flatMap((dir) => sources(dir))
      .filter((file) => !file.endsWith(join("packages", "db", "src", "boss.ts")))
      .filter((file) =>
        readFileSync(file, "utf8")
          .split("\n")
          .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
          .some((line) => /\bboss\.(send|insert|sendAfter|sendThrottled|sendDebounced)\(/.test(line)),
      )
      .map((file) => relative(root, file));
    expect(direct).toEqual([]);
  });
});
