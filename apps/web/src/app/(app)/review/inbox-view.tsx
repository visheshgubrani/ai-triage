"use client";

import type { DeliveryFailure, InboxAge, InboxQuery, InboxResponse, RetryFailedRequest } from "@ai-triage/contracts";
import { INBOX_AGES } from "@ai-triage/contracts";
import type { ReviewTaskKind } from "@ai-triage/core";
import { CircleCheck, RotateCw, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Badge, Pill } from "@/components/badge";
import { Button } from "@/components/button";
import { useConfirm } from "@/components/confirm-dialog";
import { DataTable } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { FilterChip } from "@/components/filter-chip";
import { LoadingBlock } from "@/components/loading";
import { PageHeader } from "@/components/page-header";
import { Section } from "@/components/section";
import { ViewTabs } from "@/components/segmented";
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
      <span className="w-16 shrink-0 text-xs font-medium text-muted-foreground">{title}</span>
      {keys.map((k) => (
        <FilterChip
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

/** The model's confidence, as a number and a small bar. */
function ScoreBar({ score }: { score: number | null | undefined }) {
  if (score === null || score === undefined) return <span className="text-muted-foreground">-</span>;
  return (
    <span className="flex items-center gap-2">
      <span className="font-mono text-xs tabular-nums">{score.toFixed(2)}</span>
      <span aria-hidden="true" className="h-1 w-10 overflow-hidden rounded-full bg-muted">
        <span className="block h-full rounded-full bg-primary" style={{ width: `${Math.round(score * 100)}%` }} />
      </span>
    </span>
  );
}

export function InboxView({ canReview, isAdmin = false }: { canReview: boolean; isAdmin?: boolean }) {
  const confirm = useConfirm();
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
    if (
      !(await confirm({
        title: `Retry every unclaimed document ${scope}?`,
        body: "Each one runs the pipeline again.",
        confirm: "Retry all",
      }))
    )
      return;
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

  const hasFilters = Object.values(filters).some(Boolean);
  const tabCount: Record<View, number | undefined> = {
    open: counts?.total,
    failed: counts?.kind.processing_failed,
    delivery: failures?.length,
  };
  return (
    <>
      <PageHeader
        title="Review queue"
        description="Documents waiting for a person, oldest first. Claim one to decide it: your claim lasts 10 minutes and renews while the page is open."
        actions={
          <>
            {isAdmin && view === "failed" && tasks.length > 0 && (
              <Button onClick={retryAll} disabled={busy}>
                <RotateCw aria-hidden="true" />
                Retry all{filters.reason ? ` ${filters.reason}` : ""} ({tasks.length})
              </Button>
            )}
            {canReview && view !== "delivery" && (
              <Button variant="primary" shortcut="n" onClick={claimNext} disabled={busy}>
                Claim next
              </Button>
            )}
          </>
        }
      />

      <div className="mt-4">
        <ViewTabs
          label="Queue views"
          value={view}
          onChange={(id) => {
            setView(id);
            setFilters({});
          }}
          tabs={VIEWS.map((v) => ({ ...v, count: tabCount[v.id] }))}
        />
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
            <span className="w-16 shrink-0 text-xs font-medium text-muted-foreground">Age</span>
            {INBOX_AGES.map((age) => (
              <FilterChip
                key={age}
                label={`older than ${age}`}
                active={filters.olderThan === age}
                onClick={() => set({ olderThan: filters.olderThan === age ? undefined : age })}
              />
            ))}
            {canReview && (
              <FilterChip label="claimed by me" active={!!filters.mine} onClick={() => set({ mine: !filters.mine })} />
            )}
            {hasFilters && (
              <Button variant="ghost" size="xs" onClick={() => setFilters({})}>
                <X aria-hidden="true" />
                Clear filters
              </Button>
            )}
          </div>
        </div>
      )}

      {message && <p className="mt-4 text-sm text-muted-foreground">{message}</p>}
      {error && (
        <p role="alert" className="mt-4 text-sm text-danger">
          {error}
        </p>
      )}

      {view !== "delivery" && (
        <Section className="mt-4">
          {!inbox ? (
            <LoadingBlock rows={6} />
          ) : tasks.length === 0 ? (
            <EmptyState
              icon={CircleCheck}
              title={hasFilters ? "Nothing matches these filters" : "All clear"}
              description={
                hasFilters
                  ? "Clear a filter to see more of the queue."
                  : view === "failed"
                    ? "No document failed processing."
                    : "Nothing is waiting for a person right now."
              }
            />
          ) : (
            <DataTable>
              <thead>
                <tr>
                  <th>Document</th>
                  <th>Kind</th>
                  <th>Category</th>
                  <th>Score</th>
                  <th>{view === "failed" ? "Error" : "Reasons"}</th>
                  <th>Age</th>
                  <th>Claim</th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((t) => (
                  <tr key={t.id} className="cursor-pointer" onClick={() => router.push(`/review/${t.id}`)}>
                    <td className="max-w-72">
                      <Link href={`/review/${t.id}`} className="font-medium underline-offset-2 hover:underline">
                        {t.title ?? "(untitled)"}
                      </Link>
                      <p className="text-xs text-muted-foreground">{t.source}</p>
                    </td>
                    <td>
                      <Badge value={KIND_LABELS[t.kind]} />
                    </td>
                    <td>{t.category ?? <span className="text-muted-foreground">-</span>}</td>
                    <td>
                      <ScoreBar score={t.score} />
                    </td>
                    <td className="max-w-md">
                      {view === "failed" && t.runError ? (
                        <span className="font-mono text-xs break-words text-danger">{t.runError}</span>
                      ) : (
                        <span className="flex flex-wrap gap-1">
                          {t.reasons.map((r) => (
                            <Pill key={r} className="font-mono">
                              {r}
                            </Pill>
                          ))}
                        </span>
                      )}
                    </td>
                    <td className="whitespace-nowrap text-muted-foreground">{ago(t.createdAt)}</td>
                    <td className="text-xs text-muted-foreground">
                      {t.status === "awaiting_extraction" ? "reprocessing" : (t.claim?.email ?? "free")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          )}
        </Section>
      )}

      {view === "delivery" && (
        <Section className="mt-4">
          {!failures ? (
            <LoadingBlock rows={4} />
          ) : failures.length === 0 ? (
            <EmptyState
              icon={CircleCheck}
              title="No failed deliveries"
              description="Every approved document reached its webhook."
            />
          ) : (
            <DataTable>
              <thead>
                <tr>
                  <th>Document</th>
                  <th>Category</th>
                  <th>Attempts</th>
                  <th>Last error</th>
                  <th>Failed</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {failures.map((f) => (
                  <tr key={f.actionId}>
                    <td>
                      <Link
                        href={`/documents/${f.documentId}`}
                        className="font-medium underline-offset-2 hover:underline"
                      >
                        {f.title ?? "(untitled)"}
                      </Link>
                      <p className="font-mono text-xs text-muted-foreground">Idempotency-Key {f.actionId}</p>
                    </td>
                    <td>{f.category}</td>
                    <td className="tabular-nums">{f.attempts}</td>
                    <td className="max-w-md font-mono text-xs break-words text-danger">{f.lastError}</td>
                    <td className="whitespace-nowrap text-muted-foreground">{ago(f.updatedAt)}</td>
                    <td className="text-right">
                      {canReview && (
                        <Button size="sm" onClick={() => void redeliver(f.actionId)}>
                          Redeliver
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          )}
        </Section>
      )}
    </>
  );
}
