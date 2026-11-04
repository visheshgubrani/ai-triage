import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFile } from "@ai-triage/core/pipeline";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../config";
import { parseInSandbox } from "./sandbox";

const fixture = (name: string) => new Uint8Array(readFileSync(join(repoRoot(), "fixtures/docs", name)));
const limits = { maxPdfPages: 100 };
const sandbox = { timeoutMs: 30_000, maxMemoryMb: 256 };
const file = (name: string, bytes = fixture(name)) => ({
  label: name,
  bytes,
  declaredMime: null,
  storageKey: `k/${name}`,
});

describe("parse sandbox", () => {
  it.each(["con-05.pdf", "amb-con-draft.docx"])("parses %s exactly as inline parsing does", async (name) => {
    const inline = await parseFile(file(name), limits);
    expect(await parseInSandbox({ kind: "file", file: file(name), limits }, sandbox)).toEqual(inline);
  });

  it("stops a parse that runs past its time as parse_timeout", async () => {
    const task = { kind: "file" as const, file: file("con-05.pdf"), limits };
    await expect(parseInSandbox(task, { ...sandbox, timeoutMs: 1 })).rejects.toMatchObject({ reason: "parse_timeout" });
  });

  it("passes a parser's PipelineError through", async () => {
    const task = { kind: "file" as const, file: file("con-05.pdf"), limits: { maxPdfPages: 0 } };
    await expect(parseInSandbox(task, sandbox)).rejects.toMatchObject({ reason: "too_many_pages" });
  });
});
