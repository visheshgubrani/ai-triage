"use client";

import type { DocumentList, DocumentListQuery, DocumentSummary } from "@ai-triage/contracts";
import { DOCUMENT_SOURCES } from "@ai-triage/core";
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

/** The list's views: everything, or one processing outcome. `skipped` is what intake filters held back. */
const STATUS_VIEWS: { label: string; status?: DocumentListQuery["status"] }[] = [
  { label: "All" },
  { label: "Received", status: "received" },
  { label: "Done", status: "done" },
  { label: "Failed", status: "failed" },
  { label: "Skipped", status: "skipped" },
];

export function DocumentsView({ canUpload }: { canUpload: boolean }) {
  const [documents, setDocuments] = useState<DocumentSummary[] | null>(null);
  const [more, setMore] = useState<{ docs: DocumentSummary[]; next: string | null }>({ docs: [], next: null });
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [filters, setFilters] = useState<Omit<DocumentListQuery, "before">>({});
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const fetchPage = useCallback(
    async (before: string | undefined, signal?: AbortSignal): Promise<DocumentList | null> => {
      const res = await browserApi.documents.$get({ query: { ...filters, before } }, { init: { signal } });
      const status: number = res.status;
      if (status !== 200) {
        setError(status === 401 ? "Sign in to see your documents." : `Could not load documents (${status}).`);
        return null;
      }
      setError(null);
      return (await res.json()) as DocumentList;
    },
    [filters],
  );

  // The first page refreshes on a timer; pages loaded with "Load more" stay as they were.
  const load = useCallback(
    async (signal?: AbortSignal) => {
      const page = await fetchPage(undefined, signal);
      if (!page) return;
      setDocuments(page.documents);
      setNextBefore(page.nextBefore);
    },
    [fetchPage],
  );
  usePolling(load, POLL_MS);

  const set = (patch: Partial<typeof filters>) => {
    setMore({ docs: [], next: null });
    setFilters((f) => ({ ...f, ...patch }));
  };

  async function loadMore() {
    const page = await fetchPage(more.next ?? nextBefore ?? undefined);
    if (page) setMore((m) => ({ docs: [...m.docs, ...page.documents], next: page.nextBefore }));
  }

  async function processAnyway(id: string) {
    const res = await browserApi.documents[":id"].process.$post({ param: { id } });
    setMessage(
      res.ok ? "Processing it now: the pipeline runs on it as on any other document." : "It isn't skipped any more.",
    );
    await load();
  }

  const shown = documents ? [...documents, ...more.docs] : null;
  const hasMore = (more.docs.length > 0 ? more.next : nextBefore) !== null;

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
      {canUpload && (
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
        </form>
      )}

      <div className="mt-6 flex flex-wrap items-center gap-2 text-sm">
        {STATUS_VIEWS.map((v) => (
          <button
            key={v.label}
            type="button"
            onClick={() => set({ status: v.status })}
            className={`rounded-full border px-2.5 py-0.5 text-xs ${
              filters.status === v.status
                ? "border-neutral-900 bg-neutral-900 text-white dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900"
                : "border-neutral-300 text-neutral-600 dark:border-neutral-700 dark:text-neutral-400"
            }`}
          >
            {v.label}
          </button>
        ))}
        <select
          aria-label="Source"
          value={filters.source ?? ""}
          onChange={(e) => set({ source: (e.target.value || undefined) as DocumentListQuery["source"] })}
          className="rounded-md border border-neutral-300 bg-transparent px-2 py-0.5 text-xs dark:border-neutral-700"
        >
          <option value="">Any source</option>
          {DOCUMENT_SOURCES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            set({ q: search.trim() || undefined });
          }}
        >
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search titles"
            className="w-48 rounded-md border border-neutral-300 bg-transparent px-2 py-0.5 text-xs dark:border-neutral-700"
          />
        </form>
      </div>
      {filters.status === "skipped" && (
        <p className="mt-2 text-xs text-neutral-500">
          Auto-replies, bounces and (when on) bulk mail end here before any model call. Settings → Intake filters
          chooses which; Process anyway runs one through the pipeline.
        </p>
      )}
      {message && <p className="mt-3 text-sm text-neutral-600 dark:text-neutral-400">{message}</p>}

      {error && (
        <p role="alert" className="mt-6 text-sm text-red-600">
          {error}
        </p>
      )}
      {shown && shown.length === 0 && (
        <p className="mt-6 text-sm text-neutral-500">
          {Object.values(filters).some(Boolean)
            ? "No documents match."
            : "No documents yet: upload one above, or connect intake in Settings."}
        </p>
      )}
      {shown && shown.length > 0 && (
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
              {shown.map((d) => (
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
                    {d.processingStatus === "skipped" && canUpload && (
                      <button
                        type="button"
                        onClick={() => processAnyway(d.id)}
                        className="ml-2 font-sans text-neutral-900 underline underline-offset-2 dark:text-neutral-100"
                      >
                        Process anyway
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {hasMore && (
            <button type="button" onClick={loadMore} className="mt-3 text-sm underline underline-offset-2">
              Load more
            </button>
          )}
        </div>
      )}
    </>
  );
}
