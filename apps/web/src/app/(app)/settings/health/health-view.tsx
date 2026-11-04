"use client";

import type { SystemHealthResponse } from "@ai-triage/contracts";
import Link from "next/link";
import { useCallback, useState } from "react";
import { DataTable } from "@/components/data-table";
import { LoadingBlock } from "@/components/loading";
import { Section } from "@/components/section";
import { StatCard } from "@/components/stat-card";
import { browserApi } from "@/lib/api";
import { readError } from "@/lib/api-error";
import { ago } from "@/lib/format";
import { usePolling } from "@/lib/use-polling";

const IN_FLIGHT = ["received", "parsed", "classified", "extracted"];
const money = (usd: number) => `$${usd.toFixed(2)}`;

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

  if (error) return <p className="text-sm text-danger">{error}</p>;
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
    <div className="space-y-8">
      <Section title="Pipeline">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="In progress" value={waiting} />
          <Stat label="Oldest in progress" value={oldest ? ago(oldest) : "–"} warn={stuck} />
          <Stat label="Failed, open" value={failures} warn={failures > 0} />
          <Stat label="Stalled (24 h)" value={health.last24h.stalledRuns} warn={health.last24h.stalledRuns > 0} />
        </div>
        <DataTable>
          <tbody>
            {health.documents.map((d) => (
              <tr key={d.status}>
                <td className="text-muted-foreground">{d.status}</td>
                <td className="tabular-nums">{d.count}</td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      </Section>

      <Section title="Open failures by reason">
        {health.openFailures.length === 0 ? (
          <p className="text-sm text-muted-foreground">None.</p>
        ) : (
          <>
            <ul className="text-sm">
              {health.openFailures.map((f) => (
                <li key={f.reason}>
                  <span className="font-mono">{f.reason}</span> · {f.count}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-sm">
              <Link href="/review" className="font-medium text-primary underline-offset-2 hover:underline">
                Review → Processing failed
              </Link>{" "}
              has Retry all, per reason.
            </p>
          </>
        )}
      </Section>

      <Section title="Delivery and intake">
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
      </Section>

      <Section title="Models and workers">
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
          <ul className="mt-3 text-sm">
            {health.cooldowns.map((c) => (
              <li key={`${c.provider}:${c.model}`}>
                <span className="font-mono">{c.model}</span> answered {c.reason}; calls wait until{" "}
                {new Date(c.until).toLocaleTimeString()}.
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
