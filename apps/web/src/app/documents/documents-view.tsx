"use client";

import type { DocumentList, DocumentSummary } from "@ai-triage/contracts";
import Link from "next/link";
import { type FormEvent, useCallback, useState } from "react";
import { Badge, stateOf } from "@/components/badge";
import { browserApi } from "@/lib/api";
import { usePolling } from "@/lib/use-polling";

const POLL_MS = 5000;

/** Some browsers leave the type of .eml files empty; the API needs it to presign the upload. */
const mimeOf = (file: File) =>
  file.type || (file.name.toLowerCase().endsWith(".eml") ? "message/rfc822" : "application/octet-stream");

async function upload(file: File): Promise<string> {
  const created = await browserApi.uploads.$post({
    json: { filename: file.name, size: file.size, mime: mimeOf(file) },
  });
  if (!created.ok) throw new Error(((await created.json()) as unknown as { error?: string }).error ?? "upload refused");
  const { uploadId, url, headers } = await created.json();
  // Straight to storage with the presigned URL; the API never sees the bytes.
  const put = await fetch(url, { method: "PUT", headers, body: file });
  if (!put.ok) throw new Error(`storage rejected the upload (${put.status})`);
  const done = await browserApi.uploads[":id"].complete.$post({ param: { id: uploadId } });
  const body = (await done.json()) as { duplicate?: boolean; error?: string };
  if (!done.ok) throw new Error(body.error ?? "could not complete the upload");
  return body.duplicate ? `${file.name}: already ingested` : `${file.name}: uploaded`;
}

export function DocumentsView() {
  const [documents, setDocuments] = useState<DocumentSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    const res = await browserApi.documents.$get(undefined, { init: { signal } });
    const status: number = res.status;
    if (status !== 200) {
      setError(status === 401 ? "Sign in to see your documents." : `Could not load documents (${status}).`);
      return;
    }
    setError(null);
    setDocuments(((await res.json()) as DocumentList).documents);
  }, []);

  usePolling(load, POLL_MS);

  async function onUpload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = event.currentTarget.elements.namedItem("file") as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    setBusy(true);
    setMessage(null);
    try {
      setMessage(await upload(file));
      input.value = "";
      await load();
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <form
        onSubmit={onUpload}
        className="mt-6 flex flex-wrap items-center gap-3 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800"
      >
        <input
          name="file"
          type="file"
          accept=".pdf,.docx,.eml,.png,.jpg,.jpeg,.txt"
          className="text-sm file:mr-3 file:rounded-md file:border-0 file:bg-neutral-100 file:px-3 file:py-1.5 file:text-sm dark:file:bg-neutral-800"
        />
        <button
          type="submit"
          disabled={busy}
          className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
        >
          {busy ? "Uploading…" : "Upload"}
        </button>
        {message && <p className="text-sm text-neutral-600 dark:text-neutral-400">{message}</p>}
      </form>

      {error && (
        <p role="alert" className="mt-6 text-sm text-red-600">
          {error}
        </p>
      )}
      {documents && documents.length === 0 && <p className="mt-6 text-sm text-neutral-500">No documents yet.</p>}
      {documents && documents.length > 0 && (
        <div className="mt-6 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase text-neutral-500">
              <tr>
                <th className="py-2 pr-4 font-medium">Document</th>
                <th className="py-2 pr-4 font-medium">State</th>
                <th className="py-2 pr-4 font-medium">Category</th>
                <th className="py-2 pr-4 font-medium">Score</th>
                <th className="py-2 pr-4 font-medium">Reasons</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-200 dark:divide-neutral-800">
              {documents.map((d) => (
                <tr key={d.id} className="align-top">
                  <td className="py-2 pr-4">
                    <Link href={`/documents/${d.id}`} className="font-medium underline-offset-2 hover:underline">
                      {d.title ?? "(untitled)"}
                    </Link>
                    <p className="text-xs text-neutral-500">
                      {d.source} · {new Date(d.createdAt).toLocaleString()}
                    </p>
                  </td>
                  <td className="py-2 pr-4">
                    <Badge value={stateOf(d)} />
                  </td>
                  <td className="py-2 pr-4">{d.category ?? <span className="text-neutral-400">-</span>}</td>
                  <td className="py-2 pr-4 font-mono">
                    {d.score?.toFixed(2) ?? <span className="text-neutral-400">-</span>}
                  </td>
                  <td className="py-2 pr-4 font-mono text-xs text-neutral-600 dark:text-neutral-400">
                    {d.reasons.join(", ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
