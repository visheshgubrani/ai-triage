import type {
  DeliveryFailure,
  DocumentSummary,
  InboxResponse,
  ProductionResponse,
  SystemStatusResponse,
} from "@ai-triage/contracts";
import { CheckCircle2, CircleAlert, CircleDollarSign, FileText, Inbox, Send, Sparkles, UserCheck } from "lucide-react";
import { cookies } from "next/headers";
import Link from "next/link";
import type { ReactNode } from "react";
import { AutoRefresh } from "@/components/auto-refresh";
import { Badge, stateOf } from "@/components/badge";
import { Button } from "@/components/button";
import { EmptyState } from "@/components/empty-state";
import { Page, PageHeader } from "@/components/page-header";
import { Section } from "@/components/section";
import { StatCard } from "@/components/stat-card";
import { api } from "@/lib/api";
import { ago } from "@/lib/format";
import { getMe } from "@/lib/session";
import { Checklist } from "./checklist";
import { DocumentsChart } from "./documents-chart";
import { pct, usd } from "./evals/ui";

export const dynamic = "force-dynamic";

const DAYS = 14;

/** One panel's data; a failed call blanks that panel, not the whole page. */
async function attempt<T>(load: () => Promise<T>): Promise<T | null> {
  try {
    return await load();
  } catch {
    return null;
  }
}

async function loadDashboard() {
  const headers = { cookie: (await cookies()).toString() };
  const [inbox, production, documents, failures, status] = await Promise.all([
    attempt(async () => {
      const res = await api.review.tasks.$get({ query: {} }, { headers });
      return res.ok ? ((await res.json()) as InboxResponse) : null;
    }),
    attempt(async () => {
      const res = await api.evals.production.$get({ query: { days: String(DAYS) } }, { headers });
      return res.ok ? ((await res.json()) as ProductionResponse) : null;
    }),
    attempt(async () => {
      const res = await api.documents.$get({ query: {} }, { headers });
      return res.ok ? ((await res.json()).documents as DocumentSummary[]) : null;
    }),
    attempt(async () => {
      const res = await api.actions.failed.$get(undefined, { headers });
      return res.ok ? ((await res.json()).failures as DeliveryFailure[]) : null;
    }),
    attempt(async () => {
      const res = await api.system.status.$get(undefined, { headers });
      return res.ok ? ((await res.json()) as SystemStatusResponse) : null;
    }),
  ]);
  return { inbox, production, documents, failures, status };
}

function AttentionRow({ href, tone, children }: { href: string; tone: "warning" | "danger"; children: ReactNode }) {
  return (
    <li>
      <Link
        href={href}
        className="-mx-2 flex items-start gap-2.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-muted"
      >
        <CircleAlert
          aria-hidden="true"
          className={`mt-0.5 size-4 shrink-0 ${tone === "danger" ? "text-danger" : "text-warning"}`}
        />
        <span>{children}</span>
      </Link>
    </li>
  );
}

export default async function Dashboard() {
  const me = await getMe();
  if (!me) return null;
  const { inbox, production, documents, failures, status } = await loadDashboard();

  const failedTasks = inbox?.counts.kind.processing_failed ?? 0;
  const openReviews = inbox ? inbox.counts.total - failedTasks : null;
  const routed = production?.routing.reduce((sum, r) => sum + r.routed, 0) ?? 0;
  const auto = production?.routing.reduce((sum, r) => sum + r.auto, 0) ?? 0;
  const processed = production?.costByDay.reduce((sum, d) => sum + d.documents, 0) ?? null;
  const review = production?.reviewRate;
  const attention = failedTasks > 0 || !!failures?.length || !!status?.budgetExhausted;

  return (
    <Page>
      <AutoRefresh ms={30_000} />
      <PageHeader
        title="Dashboard"
        description={`What's happening in ${me.tenant.name}, over the last ${DAYS} days.`}
        actions={
          <Button asChild variant="primary">
            <Link href="/review">Open the queue</Link>
          </Button>
        }
      />

      <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
        <StatCard
          label="Waiting for review"
          value={openReviews ?? "-"}
          detail="Open tasks now"
          icon={Inbox}
          href="/review"
        />
        <StatCard
          label="Documents"
          value={processed ?? "-"}
          detail={`Processed in ${DAYS} days`}
          icon={FileText}
          href="/documents"
        />
        <StatCard
          label="Auto-approved"
          value={routed ? pct(auto / routed) : "-"}
          detail={routed ? `${auto} of ${routed} routed` : "Nothing routed yet"}
          icon={Sparkles}
        />
        <StatCard
          label="Sent to a person"
          value={review && review.n > 0 ? pct(review.rate) : "-"}
          detail={review && review.n > 0 ? `${review.k}/${review.n} ≥${pct(review.lower)}` : "Nothing routed yet"}
          icon={UserCheck}
        />
        <StatCard
          label="LLM spend"
          value={production ? usd(production.spend.liveUsd) : "-"}
          detail={
            production?.replay
              ? `Replay: ${usd(production.spend.recordedUsd)} as recorded`
              : `${production?.spend.calls ?? 0} model calls`
          }
          icon={CircleDollarSign}
          href="/evals/production"
        />
        <StatCard
          label="Delivery failures"
          value={failures?.length ?? "-"}
          detail="Webhooks that gave up"
          icon={Send}
          warn={!!failures?.length}
          href="/review"
        />
      </div>

      <div className="mt-4 grid items-start gap-4 lg:grid-cols-3">
        <div className="min-w-0 lg:col-span-2">
          <Section className="mt-0" title="Documents per day" description="By category, from the pipeline's own runs.">
            {production ? (
              <DocumentsChart rows={production.costByDay} since={production.since} until={production.until} />
            ) : (
              <EmptyState title="Couldn't load the numbers" description="Try reloading the page." />
            )}
          </Section>
          <Section
            title="Recent documents"
            actions={
              <Button asChild size="sm" variant="ghost">
                <Link href="/documents">View all</Link>
              </Button>
            }
          >
            {documents?.length ? (
              <ul className="-my-1 divide-y">
                {documents.slice(0, 6).map((d) => (
                  <li key={d.id} className="flex items-center justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <Link
                        href={`/documents/${d.id}`}
                        className="block truncate font-medium underline-offset-2 hover:underline"
                      >
                        {d.title ?? "(untitled)"}
                      </Link>
                      <p className="truncate text-xs text-muted-foreground">
                        {d.category ?? d.source} · {ago(d.createdAt)}
                      </p>
                    </div>
                    <Badge value={stateOf(d)} />
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState
                icon={FileText}
                title="No documents yet"
                description="Upload one, or connect intake in Settings."
                action={
                  <Button asChild>
                    <Link href="/documents">Go to Documents</Link>
                  </Button>
                }
              />
            )}
          </Section>
        </div>

        <div className="min-w-0 space-y-4">
          {me.role === "admin" && <Checklist />}
          <Section className="mt-0" title="Needs attention">
            {attention ? (
              <ul className="space-y-0.5">
                {failedTasks > 0 && (
                  <AttentionRow href="/review" tone="danger">
                    {failedTasks} document{failedTasks === 1 ? "" : "s"} failed processing
                  </AttentionRow>
                )}
                {!!failures?.length && (
                  <AttentionRow href="/review" tone="danger">
                    {failures.length} webhook deliver{failures.length === 1 ? "y" : "ies"} failed
                  </AttentionRow>
                )}
                {status?.budgetExhausted && (
                  <AttentionRow href={me.role === "admin" ? "/settings#budget" : "/"} tone="warning">
                    Today's LLM budget is used up
                  </AttentionRow>
                )}
              </ul>
            ) : (
              <p className="flex items-center gap-2 text-muted-foreground">
                <CheckCircle2 aria-hidden="true" className="size-4 text-success" />
                Nothing needs you right now.
              </p>
            )}
          </Section>
        </div>
      </div>
    </Page>
  );
}
