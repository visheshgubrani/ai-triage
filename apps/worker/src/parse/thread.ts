// The parse sandbox's thread (./sandbox.ts): runs core's pure parsers on bytes the worker already
// fetched, and posts the parts back. A PipelineError crosses as its reason and message.
import { parentPort, workerData } from "node:worker_threads";
import {
  type ParseLimits,
  PipelineError,
  parseEmail,
  parseFile,
  pdfPageImages,
  type StoredEmail,
} from "@ai-triage/core/pipeline";

export type ParseTask =
  | { kind: "email"; email: StoredEmail; blobs: Map<string, Uint8Array>; limits: ParseLimits }
  | {
      kind: "file";
      file: { label: string | null; bytes: Uint8Array; declaredMime: string | null; storageKey: string };
      limits: ParseLimits;
    }
  // A scanned PDF's page images, for OCR: decoding them is parsing untrusted bytes too.
  | { kind: "pageImages"; bytes: Uint8Array; pages: number[] };

const task = workerData as ParseTask;
try {
  const result =
    task.kind === "email"
      ? await parseEmail(task.email, task.blobs, task.limits)
      : task.kind === "file"
        ? await parseFile(task.file, task.limits)
        : await pdfPageImages(task.bytes, task.pages);
  parentPort?.postMessage({ ok: true, result });
} catch (err) {
  parentPort?.postMessage(
    err instanceof PipelineError
      ? { ok: false, reason: err.reason, message: err.message }
      : { ok: false, reason: "parse_error", message: (err as Error).message ?? String(err) },
  );
}
