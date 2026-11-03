import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { EvalDeps } from "./deps";

// Invariant 7, structurally: the eval runner is built without a queue, an actions store or a
// delivery port, so no code path from an eval run reaches a webhook (docs/architecture.md §8, §10).

describe("eval runner wiring", () => {
  it("has exactly these ports", () => {
    expectTypeOf<keyof EvalDeps>().toEqualTypeOf<"pool" | "storage" | "llm" | "limits" | "llmMode" | "now">();
  });

  it("never imports what creates documents, actions or deliveries", async () => {
    const dir = import.meta.dirname;
    const sources = (await readdir(dir)).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    expect(sources).toContain("run-item.ts");
    for (const file of sources) {
      const code = await readFile(join(dir, file), "utf8");
      for (const forbidden of [
        /\bcreateAction\b/,
        /\benqueue\w*\(/,
        /QUEUES\.deliver/,
        /\bingest\w*\(/,
        /delivery\//,
      ]) {
        expect(code, `${file} must not match ${forbidden}`).not.toMatch(forbidden);
      }
    }
  });
});
