"use client";

import type { DocumentList, DocumentListQuery, DocumentSummary } from "@ai-triage/contracts";
import { DOCUMENT_SOURCES } from "@ai-triage/core";
import { FileText, Search, UploadCloud } from "lucide-react";
import Link from "next/link";
import { type DragEvent, type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { Badge, stateOf } from "@/components/badge";
import { Button } from "@/components/button";
import { DataTable } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { LoadingBlock } from "@/components/loading";
import { ReasonPill } from "@/components/reason-pill";
import { Section } from "@/components/section";
import { Segmented } from "@/components/segmented";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { browserApi } from "@/lib/api";
import { usePolling } from "@/lib/use-polling";
import { cn } from "@/lib/utils";

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
  const fileInput = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

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

  // Typing searches after a short pause (Enter searches at once), so the list never looks stale.
  useEffect(() => {
    const q = search.trim() || undefined;
    if (q === filters.q) return;
    const timer = setTimeout(() => {
      setMore({ docs: [], next: null });
      setFilters((f) => ({ ...f, q }));
    }, 300);
    return () => clearTimeout(timer);
  }, [search, filters.q]);

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
    const input = fileInput.current;
    const file = input?.files?.[0];
    if (!input || !file) return;
    setBusy(true);
    setMessage(null);
    try {
      setMessage(await upload(file));
      input.value = "";
      setFileName(null);
      await load();
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function onDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDragging(false);
    const input = fileInput.current;
    if (!input || event.dataTransfer.files.length === 0) return;
    input.files = event.dataTransfer.files;
    setFileName(event.dataTransfer.files[0]?.name ?? null);
  }

  return (
    <>
      {canUpload && (
        <form onSubmit={onUpload} className="mt-4 flex flex-wrap items-stretch gap-3">
          <label
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={cn(
              "flex min-w-64 flex-1 cursor-pointer items-center gap-3 rounded-xl border border-dashed bg-card px-4 py-3 text-sm transition-colors hover:bg-muted/60 has-focus-visible:ring-3 has-focus-visible:ring-ring/50",
              dragging && "border-primary bg-accent",
            )}
          >
            <UploadCloud aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 truncate">
              {fileName ?? (
                <>
                  <span className="font-medium">Choose a file</span>
                  <span className="text-muted-foreground"> or drop it here · PDF, DOCX, EML, PNG, JPG, TXT</span>
                </>
              )}
            </span>
            <input
              ref={fileInput}
              name="file"
              type="file"
              accept=".pdf,.docx,.eml,.png,.jpg,.jpeg,.txt"
              className="sr-only"
              onChange={(e) => setFileName(e.target.files?.[0]?.name ?? null)}
            />
          </label>
          <Button type="submit" variant="primary" disabled={busy} className="h-auto min-h-8 self-stretch px-4">
            {busy ? "Uploading…" : "Upload"}
          </Button>
        </form>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Segmented
          label="Status"
          value={filters.status}
          onChange={(status) => set({ status })}
          options={STATUS_VIEWS.map((v) => ({ value: v.status, label: v.label }))}
        />
        <NativeSelect
          aria-label="Source"
          value={filters.source ?? ""}
          onChange={(e) => set({ source: (e.target.value || undefined) as DocumentListQuery["source"] })}
        >
          <option value="">Any source</option>
          {DOCUMENT_SOURCES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </NativeSelect>
        <form
          className="relative"
          onSubmit={(e) => {
            e.preventDefault();
            set({ q: search.trim() || undefined });
          }}
        >
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search titles"
            aria-label="Search titles"
            className="w-56 pl-8"
          />
        </form>
      </div>
      {filters.status === "skipped" && (
        <p className="mt-2 text-xs text-muted-foreground">
          Auto-replies, bounces and (when on) bulk mail end here before any model call. Settings → General chooses
          which; Process anyway runs one through the pipeline.
        </p>
      )}
      {message && <p className="mt-3 text-sm text-muted-foreground">{message}</p>}
      {error && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {error}
        </p>
      )}

      <Section className="mt-4">
        {!shown && !error ? (
          <LoadingBlock rows={6} />
        ) : shown && shown.length === 0 ? (
          <EmptyState
            icon={FileText}
            title={Object.values(filters).some(Boolean) ? "No documents match" : "No documents yet"}
            description={
              Object.values(filters).some(Boolean)
                ? "Try another status, source or search."
                : "Upload one above, or connect intake in Settings."
            }
          />
        ) : (
          shown && (
            <>
              <DataTable>
                <thead>
                  <tr>
                    <th>Document</th>
                    <th>State</th>
                    <th>Category</th>
                    <th>Score</th>
                    <th>Reasons</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((d) => (
                    <tr key={d.id}>
                      <td className="max-w-96">
                        <Link href={`/documents/${d.id}`} className="font-medium underline-offset-2 hover:underline">
                          {d.title ?? "(untitled)"}
                        </Link>
                        <p className="text-xs text-muted-foreground">
                          {d.source} · {new Date(d.createdAt).toLocaleString()}
                        </p>
                      </td>
                      <td>
                        <Badge value={stateOf(d)} />
                      </td>
                      <td>{d.category ?? <span className="text-muted-foreground">-</span>}</td>
                      <td className="font-mono text-xs">
                        {d.score?.toFixed(2) ?? <span className="text-muted-foreground">-</span>}
                      </td>
                      <td>
                        <span className="flex flex-wrap items-center gap-1">
                          {d.reasons.map((r) => (
                            <ReasonPill key={r} reason={r} />
                          ))}
                          {d.processingStatus === "skipped" && canUpload && (
                            <Button size="xs" onClick={() => processAnyway(d.id)}>
                              Process anyway
                            </Button>
                          )}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </DataTable>
              {hasMore && (
                <div className="mt-3 flex justify-center">
                  <Button onClick={loadMore}>Load more</Button>
                </div>
              )}
            </>
          )
        )}
      </Section>
    </>
  );
}
