"use client";

import type { AuditEvent } from "@ai-triage/contracts";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/button";
import { DataTable } from "@/components/data-table";
import { Section } from "@/components/section";
import { browserApi } from "@/lib/api";
import { readError } from "@/lib/api-error";
import { ago } from "@/lib/format";

/** Security-relevant changes in this tenant, newest first (docs/security.md). */
export function AuditLogView() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (after?: string) => {
    setBusy(true);
    try {
      const res = await browserApi.settings.audit.$get({ query: after ? { cursor: after } : {} });
      if (!res.ok) return setError((await readError(res)).error);
      const page = await res.json();
      setEvents((prev) => (after ? [...prev, ...page.events] : page.events));
      setCursor(page.nextCursor);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Section title="Audit log">
      {error && (
        <p role="alert" className="text-danger">
          {error}
        </p>
      )}
      {events.length === 0 && !error ? (
        <p className="text-muted-foreground">No changes recorded yet.</p>
      ) : (
        <DataTable>
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
                <td className="whitespace-nowrap" title={e.createdAt}>
                  {ago(e.createdAt)}
                </td>
                <td title={e.ip ?? undefined}>{e.actorLabel ?? e.actorType}</td>
                <td className="font-mono">{e.action}</td>
                <td className="font-mono text-muted-foreground">
                  {e.targetId ? `${e.targetType} ${e.targetId.slice(0, 8)}` : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </DataTable>
      )}
      {cursor && (
        <div className="mt-2">
          <Button onClick={() => void load(cursor)} disabled={busy}>
            Older
          </Button>
        </div>
      )}
    </Section>
  );
}
