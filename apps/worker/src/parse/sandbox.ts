// Untrusted files are parsed in a thread of their own (docs/security.md, parser limits): a PDF or
// DOCX that loops or balloons can't freeze the worker's event loop or take its memory. The thread is
// terminated after `timeoutMs` (parse_timeout) or when it passes its heap limit. Parsing code and
// output are the same as inline, so requests (and cassettes) don't change.
import { Worker } from "node:worker_threads";
import { type ParsedPart, PipelineError } from "@ai-triage/core/pipeline";
import type { ParseTask } from "./thread";

export interface SandboxOptions {
  timeoutMs: number;
  /** Heap cap of the thread. */
  maxMemoryMb: number;
}

// From source (tsx, vitest) the thread needs tsx's loader too; the bundle ships thread.js beside it.
const fromSource = import.meta.url.endsWith(".ts");
const threadUrl = new URL(fromSource ? "./thread.ts" : "./parse-thread.js", import.meta.url);

type Reply = { ok: true; parts: ParsedPart[] } | { ok: false; reason: PipelineError["reason"]; message: string };

export function parseInSandbox(task: ParseTask, options: SandboxOptions): Promise<ParsedPart[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(threadUrl, {
      workerData: task,
      execArgv: fromSource ? ["--import", "tsx"] : [],
      resourceLimits: { maxOldGenerationSizeMb: options.maxMemoryMb },
    });
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      fn();
    };
    const timer = setTimeout(
      () =>
        settle(() => reject(new PipelineError("parse_timeout", `parsing took longer than ${options.timeoutMs} ms`))),
      options.timeoutMs,
    );
    worker.once("message", (reply: Reply) =>
      settle(() => (reply.ok ? resolve(reply.parts) : reject(new PipelineError(reply.reason, reply.message)))),
    );
    worker.once("error", (err: Error & { code?: string }) =>
      settle(() =>
        reject(
          err.code === "ERR_WORKER_OUT_OF_MEMORY"
            ? new PipelineError("parse_timeout", `parsing needed more than ${options.maxMemoryMb} MB`)
            : err,
        ),
      ),
    );
    worker.once("exit", (code) =>
      settle(() => reject(new Error(`the parse thread exited (code ${code}) without an answer`))),
    );
  });
}
