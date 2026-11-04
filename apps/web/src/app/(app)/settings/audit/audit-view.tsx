"use client";

import type { AuditEvent } from "@ai-triage/contracts";
import { ScrollText } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/button";
import { DataTable } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { LoadingBlock } from "@/components/loading";
import { FormMessage } from "@/components/notice";
import { Section, SectionHint } from "@/components/section";
import { browserApi } from "@/lib/api";
import { readError } from "@/lib/api-error";
import { ago } from "@/lib/format";

/** Security-relevant changes in this tenant, newest first (docs/security.md). */
export function AuditLogView() {
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (after?: string) => {
    setBusy(true);
    try {
      const res = await browserApi.settings.audit.$get({ query: after ? { cursor: after } : {} });
      if (!res.ok) return setError((await readError(res)).error);
      const page = await res.json();
      setEvents((prev) => (after && prev ? [...prev, ...page.events] : page.events));
      setCursor(page.nextCursor);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!events) return error ? <FormMessage message={{ error: true, text: error }} /> : <LoadingBlock rows={6} />;

  return (
    <Section
      footer={
        events.length > 0 && (
          <>
            <SectionHint>
              {events.length} {events.length === 1 ? "event" : "events"}
              {cursor ? " so far" : ""}
            </SectionHint>
            {cursor && (
              <Button size="sm" onClick={() => void load(cursor)} disabled={busy}>
                Load older
              </Button>
            )}
          </>
        )
      }
    >
      <FormMessage message={error ? { error: true, text: error } : null} className="mt-0 mb-3" />
      {events.length === 0 ? (
        <EmptyState icon={ScrollText} title="No changes recorded yet" />
      ) : (
        <DataTable className="-mt-1">
          <thead>
            <tr>
              <th>When</th>
              <th>Who</th>
              <th>What</th>
              <th>Target</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id}>
                <td className="whitespace-nowrap text-muted-foreground" title={new Date(e.createdAt).toLocaleString()}>
                  {ago(e.createdAt)}
                </td>
                <td title={e.ip ?? undefined}>{e.actorLabel ?? e.actorType}</td>
                <td>
                  <code className="rounded-md bg-muted px-1.5 py-0.5 text-xs">{e.action}</code>
                </td>
                <td className="font-mono text-xs text-muted-foreground">
                  {e.targetId ? `${e.targetType} ${e.targetId.slice(0, 8)}` : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
    </Section>
  );
}
