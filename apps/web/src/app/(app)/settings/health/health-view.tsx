"use client";

import type { SystemHealthResponse } from "@ai-triage/contracts";
import { CircleCheck } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useCallback, useState } from "react";
import { Badge, Pill } from "@/components/badge";
import { LoadingBlock } from "@/components/loading";
import { FormMessage, Notice } from "@/components/notice";
import { Section, SectionHint } from "@/components/section";
import { StatCard } from "@/components/stat-card";
import { browserApi } from "@/lib/api";
import { readError } from "@/lib/api-error";
import { ago } from "@/lib/format";
import { usePolling } from "@/lib/use-polling";

const IN_FLIGHT = ["received", "parsed", "classified", "extracted"];
const money = (usd: number) => `$${usd.toFixed(2)}`;

/** A heading and what's under it, without a card around cards. */
function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-8 first:mt-6">
      <h2 className="mb-3 text-sm font-semibold tracking-tight">{title}</h2>
      {children}
    </section>
  );
}

function Stat({ label, value, warn = false }: { label: string; value: string | number; warn?: boolean }) {
  return <StatCard label={label} value={value} warn={warn} />;
}

/**
 * Is the pipeline keeping up? Documents in flight and how long the oldest has waited, open failures
 * by reason, deliveries, mailboxes, today's budget, and whether workers run and models answer.
 * Refreshes every 10 seconds. Operators get the same facts as metrics (docs/operations.md).
 */
export function HealthView() {
  const [health, setHealth] = useState<SystemHealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async (signal?: AbortSignal) => {
    const res = await browserApi.settings.health.$get(undefined, { init: { signal } });
    if (!res.ok) return setError((await readError(res)).error);
    setError(null);
    setHealth(await res.json());
  }, []);
  usePolling(load, 10_000);

  if (error) return <FormMessage message={{ error: true, text: error }} />;
  if (!health) return <LoadingBlock />;

  const inFlight = health.documents.filter((d) => IN_FLIGHT.includes(d.status));
  const waiting = inFlight.reduce((n, d) => n + d.count, 0);
  const oldest = inFlight
    .map((d) => d.oldestUpdatedAt)
    .filter((t): t is string => t !== null)
    .sort()[0];
  const stuck = oldest ? Date.now() - new Date(oldest).getTime() > 15 * 60_000 : false;
  const failures = health.openFailures.reduce((n, f) => n + f.count, 0);
  const spent = health.budget.spentUsd + health.budget.reservedUsd;

  return (
    <>
      <Group title="Pipeline">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="In progress" value={waiting} />
          <Stat label="Oldest in progress" value={oldest ? ago(oldest) : "–"} warn={stuck} />
          <Stat label="Failed, open" value={failures} warn={failures > 0} />
          <Stat label="Stalled (24 h)" value={health.last24h.stalledRuns} warn={health.last24h.stalledRuns > 0} />
        </div>
        <div className="grid items-start gap-x-4 lg:grid-cols-2">
          <Section flush title="Documents by status" className="mt-4">
            <ul className="divide-y divide-border">
              {health.documents.map((d) => (
                <li key={d.status} className="flex items-center justify-between px-4 py-2.5">
                  <Badge value={d.status} />
                  <span className="tabular-nums">{d.count}</span>
                </li>
              ))}
            </ul>
          </Section>
          <Section
            flush
            title="Open failures by reason"
            className="mt-4"
            footer={
              health.openFailures.length > 0 && (
                <SectionHint>
                  <Link href="/review" className="font-medium text-foreground underline-offset-2 hover:underline">
                    Review → Processing failed
                  </Link>{" "}
                  has Retry all, per reason.
                </SectionHint>
              )
            }
          >
            {health.openFailures.length === 0 ? (
              <p className="flex items-center gap-2 px-4 py-3 text-muted-foreground">
                <CircleCheck aria-hidden="true" className="size-4 text-success" />
                No open failures.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {health.openFailures.map((f) => (
                  <li key={f.reason} className="flex items-center justify-between px-4 py-2.5">
                    <code className="text-xs">{f.reason}</code>
                    <Pill tone="danger">{f.count}</Pill>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      </Group>

      <Group title="Delivery and intake">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Webhooks pending" value={health.delivery.pending} />
          <Stat
            label="Oldest pending"
            value={health.delivery.oldestPendingAt ? ago(health.delivery.oldestPendingAt) : "–"}
          />
          <Stat label="Delivery failures" value={health.delivery.failed} warn={health.delivery.failed > 0} />
          <Stat
            label="Mailboxes"
            value={health.mailboxes.map((m) => `${m.count} ${m.status}`).join(", ") || "none"}
            warn={health.mailboxes.some((m) => m.status === "reauth_required")}
          />
        </div>
      </Group>

      <Group title="Models and workers">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat
            label={`Budget today (${health.budget.day})`}
            value={`${money(spent)} / ${money(health.budget.capUsd)}`}
            warn={health.budget.capUsd > 0 && spent >= health.budget.capUsd}
          />
          <Stat label="Workers running" value={health.workers.length} warn={health.workers.length === 0} />
          <Stat
            label="Worker versions"
            value={[...new Set(health.workers.map((w) => `${w.version} (${w.llmMode})`))].join(", ") || "–"}
          />
          <Stat label="Models cooling down" value={health.cooldowns.length} warn={health.cooldowns.length > 0} />
        </div>
        {health.cooldowns.length > 0 && (
          <Notice tone="warning" className="mt-3">
            <ul className="space-y-0.5">
              {health.cooldowns.map((c) => (
                <li key={`${c.provider}:${c.model}`}>
                  <code className="text-xs">{c.model}</code> answered {c.reason}; calls wait until{" "}
                  {new Date(c.until).toLocaleTimeString()}.
                </li>
              ))}
            </ul>
          </Notice>
        )}
      </Group>
    </>
  );
}
