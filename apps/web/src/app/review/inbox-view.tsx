"use client";

import type { DeliveryFailure, InboxAge, InboxQuery, InboxResponse, RetryFailedRequest } from "@ai-triage/contracts";
import { INBOX_AGES } from "@ai-triage/contracts";
import type { ReviewTaskKind } from "@ai-triage/core";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/badge";
import { Button } from "@/components/button";
import { browserApi } from "@/lib/api";
import { readError } from "@/lib/api-error";
import { ago, isTyping } from "@/lib/format";
import { usePolling } from "@/lib/use-polling";

const POLL_MS = 5000;
type View = "open" | "failed" | "delivery";
const VIEWS: { id: View; label: string }[] = [
  { id: "open", label: "Open" },
  { id: "failed", label: "Processing failed" },
  { id: "delivery", label: "Delivery failures" },
];
const OPEN_KINDS: ReviewTaskKind[] = ["review", "audit", "unclassified"];
const KIND_LABELS: Record<ReviewTaskKind, string> = {
  review: "review",
  audit: "audit sample",
  unclassified: "unclassified",
  processing_failed: "failed",
};

type Filters = { kind?: ReviewTaskKind; category?: string; reason?: string; olderThan?: InboxAge; mine?: boolean };

function Chip({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-2.5 py-0.5 text-xs ${
        active
          ? "border-neutral-900 bg-neutral-900 text-white dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900"
          : "border-neutral-300 hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800"
      }`}
    >
      {label}
      {count !== undefined && <span className="ml-1 opacity-60">{count}</span>}
    </button>
  );
}

function FacetRow({
  title,
  counts,
  value,
  onChange,
}: {
  title: string;
  counts: Record<string, number>;
  value?: string;
  onChange: (v?: string) => void;
}) {
  const keys = Object.keys(counts).sort();
  if (keys.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="w-20 text-xs text-neutral-500">{title}</span>
      {keys.map((k) => (
        <Chip
          key={k}
          label={k}
          count={counts[k]}
          active={value === k}
          onClick={() => onChange(value === k ? undefined : k)}
        />
      ))}
    </div>
  );
}

export function InboxView({ canReview, isAdmin = false }: { canReview: boolean; isAdmin?: boolean }) {
  const router = useRouter();
  const [view, setView] = useState<View>("open");
  const [filters, setFilters] = useState<Filters>({});
  const [inbox, setInbox] = useState<InboxResponse | null>(null);
  const [failures, setFailures] = useState<DeliveryFailure[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const kind = view === "failed" ? "processing_failed" : filters.kind;
  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (view === "delivery") {
        const res = await browserApi.actions.failed.$get(undefined, { init: { signal } });
        if (!res.ok) return setError((await readError(res)).error);
        setError(null);
        setFailures((await res.json()).failures);
        return;
      }
      const query: InboxQuery = {
        kind,
        category: filters.category,
        reason: filters.reason,
        olderThan: filters.olderThan,
        mine: filters.mine ? "1" : undefined,
      };
      const res = await browserApi.review.tasks.$get({ query }, { init: { signal } });
      if (!res.ok) return setError((await readError(res)).error);
      setError(null);
      setInbox(await res.json());
    },
    [view, kind, filters],
  );
  usePolling(load, POLL_MS);

  const claimNext = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await browserApi.review["claim-next"].$post({ json: { kind, category: filters.category } });
      if (!res.ok) return setMessage((await readError(res)).error);
      const { claim } = await res.json();
      if (claim) router.push(`/review/${claim.taskId}`);
      else setMessage("Nothing left to claim with these filters.");
    } finally {
      setBusy(false);
    }
  }, [kind, filters.category, router]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "n" && canReview && view !== "delivery" && !isTyping(e) && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        void claimNext();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [claimNext, canReview, view]);

  /** Retry all: every open, unclaimed failure shown (of the selected reason, if one is picked). */
  async function retryAll() {
    const scope = filters.reason ? `failed with ${filters.reason}` : "that failed";
    if (!window.confirm(`Retry every unclaimed document ${scope}? Each one runs the pipeline again.`)) return;
    setBusy(true);
    try {
      const reason = filters.reason as RetryFailedRequest["reason"];
      const res = await browserApi.review["retry-failed"].$post({ json: { reason } });
      if (!res.ok) return setMessage((await readError(res)).error);
      const { retried, skipped } = await res.json();
      setMessage(
        `Retrying ${retried} document${retried === 1 ? "" : "s"}${skipped ? ` (${skipped} moved on before their turn)` : ""}.`,
      );
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function redeliver(actionId: string) {
    const res = await browserApi.actions[":id"].redeliver.$post({ param: { id: actionId } });
    setMessage(res.ok ? "Queued for redelivery, with the same Idempotency-Key." : (await readError(res)).error);
    await load();
  }

  const set = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));
  const counts = inbox?.counts;
  const tasks = inbox?.tasks ?? [];

  return (
    <div className="mt-6">
      <div className="flex flex-wrap items-center gap-3 border-b border-neutral-200 dark:border-neutral-800">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            onClick={() => {
              setView(v.id);
              setFilters({});
            }}
            className={`-mb-px border-b-2 px-1 pb-2 text-sm ${
              view === v.id
                ? "border-neutral-900 font-medium dark:border-neutral-100"
                : "border-transparent text-neutral-500"
            }`}
          >
            {v.label}
            {v.id === "failed" && counts?.kind.processing_failed ? (
              <span className="ml-1 text-neutral-500">{counts.kind.processing_failed}</span>
            ) : null}
            {v.id === "open" && counts ? <span className="ml-1 text-neutral-500">{counts.total}</span> : null}
          </button>
        ))}
        {isAdmin && view === "failed" && tasks.length > 0 && (
          <Button onClick={retryAll} disabled={busy} className="mb-2 ml-auto">
            Retry all{filters.reason ? ` ${filters.reason}` : ""} ({tasks.length})
          </Button>
        )}
        {canReview && view !== "delivery" && (
          <Button
            variant="primary"
            shortcut="n"
            onClick={claimNext}
            disabled={busy}
            className={`mb-2 ${isAdmin && view === "failed" && tasks.length > 0 ? "" : "ml-auto"}`}
          >
            Claim next
          </Button>
        )}
      </div>

      {view !== "delivery" && counts && (
        <div className="mt-4 space-y-2">
          {view === "open" && (
            <FacetRow
              title="Kind"
              counts={Object.fromEntries(OPEN_KINDS.filter((k) => counts.kind[k]).map((k) => [k, counts.kind[k] ?? 0]))}
              value={filters.kind}
              onChange={(v) => set({ kind: v as ReviewTaskKind | undefined })}
            />
          )}
          <FacetRow
            title="Category"
            counts={counts.category}
            value={filters.category}
            onChange={(v) => set({ category: v })}
          />
          <FacetRow title="Reason" counts={counts.reason} value={filters.reason} onChange={(v) => set({ reason: v })} />
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="w-20 text-xs text-neutral-500">Age</span>
            {INBOX_AGES.map((age) => (
              <Chip
                key={age}
                label={`older than ${age}`}
                active={filters.olderThan === age}
                onClick={() => set({ olderThan: filters.olderThan === age ? undefined : age })}
              />
            ))}
            {canReview && (
              <Chip label="claimed by me" active={!!filters.mine} onClick={() => set({ mine: !filters.mine })} />
            )}
          </div>
          <p className="text-xs text-neutral-500">Counts are over all open tasks.</p>
        </div>
      )}

      {message && <p className="mt-4 text-sm text-neutral-600 dark:text-neutral-400">{message}</p>}
      {error && (
        <p role="alert" className="mt-4 text-sm text-red-600">
          {error}
        </p>
      )}

      {view !== "delivery" && inbox && (
        <div className="mt-4 overflow-x-auto">
          {tasks.length === 0 ? (
            <p className="text-sm text-neutral-500">Nothing here. </p>
          ) : (
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase text-neutral-500">
                <tr>
                  <th className="py-2 pr-4 font-medium">Document</th>
                  <th className="py-2 pr-4 font-medium">Kind</th>
                  <th className="py-2 pr-4 font-medium">Category</th>
                  <th className="py-2 pr-4 font-medium">Score</th>
                  <th className="py-2 pr-4 font-medium">{view === "failed" ? "Error" : "Reasons"}</th>
                  <th className="py-2 pr-4 font-medium">Age</th>
                  <th className="py-2 font-medium">Claim</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-200 dark:divide-neutral-800">
                {tasks.map((t) => (
                  <tr key={t.id} className="align-top">
                    <td className="py-2 pr-4">
                      <Link href={`/review/${t.id}`} className="font-medium underline-offset-2 hover:underline">
                        {t.title ?? "(untitled)"}
                      </Link>
                      <p className="text-xs text-neutral-500">{t.source}</p>
                    </td>
                    <td className="py-2 pr-4">
                      <Badge value={KIND_LABELS[t.kind]} />
                    </td>
                    <td className="py-2 pr-4">{t.category ?? <span className="text-neutral-400">-</span>}</td>
                    <td className="py-2 pr-4 font-mono">
                      {t.score?.toFixed(2) ?? <span className="text-neutral-400">-</span>}
                    </td>
                    <td className="max-w-md py-2 pr-4 font-mono text-xs break-words text-neutral-600 dark:text-neutral-400">
                      {view === "failed" ? (t.runError ?? t.reasons.join(", ")) : t.reasons.join(", ")}
                    </td>
                    <td className="py-2 pr-4 whitespace-nowrap text-neutral-500">{ago(t.createdAt)}</td>
                    <td className="py-2 text-xs text-neutral-500">
                      {t.status === "awaiting_extraction" ? "reprocessing" : (t.claim?.email ?? "free")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {view === "delivery" && failures && (
        <div className="mt-4 overflow-x-auto">
          {failures.length === 0 ? (
            <p className="text-sm text-neutral-500">No failed deliveries.</p>
          ) : (
            <table className="w-full text-left text-sm">
              <thead className="text-xs uppercase text-neutral-500">
                <tr>
                  <th className="py-2 pr-4 font-medium">Document</th>
                  <th className="py-2 pr-4 font-medium">Category</th>
                  <th className="py-2 pr-4 font-medium">Attempts</th>
                  <th className="py-2 pr-4 font-medium">Last error</th>
                  <th className="py-2 pr-4 font-medium">Failed</th>
                  <th className="py-2 font-medium" />
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-200 dark:divide-neutral-800">
                {failures.map((f) => (
                  <tr key={f.actionId} className="align-top">
                    <td className="py-2 pr-4">
                      <Link
                        href={`/documents/${f.documentId}`}
                        className="font-medium underline-offset-2 hover:underline"
                      >
                        {f.title ?? "(untitled)"}
                      </Link>
                      <p className="font-mono text-xs text-neutral-500">Idempotency-Key {f.actionId}</p>
                    </td>
                    <td className="py-2 pr-4">{f.category}</td>
                    <td className="py-2 pr-4 font-mono">{f.attempts}</td>
                    <td className="max-w-md py-2 pr-4 font-mono text-xs break-words text-red-700 dark:text-red-400">
                      {f.lastError}
                    </td>
                    <td className="py-2 pr-4 whitespace-nowrap text-neutral-500">{ago(f.updatedAt)}</td>
                    <td className="py-2">
                      {canReview && <Button onClick={() => void redeliver(f.actionId)}>Redeliver</Button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
