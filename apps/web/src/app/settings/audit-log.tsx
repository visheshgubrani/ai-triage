"use client";

import type { AuditEvent } from "@ai-triage/contracts";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/button";
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
        <p role="alert" className="text-red-600">
          {error}
        </p>
      )}
      {events.length === 0 && !error ? (
        <p className="text-neutral-500">No changes recorded yet.</p>
      ) : (
        <table className="w-full text-left text-xs">
          <thead className="text-neutral-500">
            <tr>
              <th className="py-1 pr-2 font-medium">When</th>
              <th className="py-1 pr-2 font-medium">Who</th>
              <th className="py-1 pr-2 font-medium">What</th>
              <th className="py-1 font-medium">Target</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id} className="border-t border-neutral-100 align-top dark:border-neutral-900">
                <td className="py-1 pr-2 whitespace-nowrap" title={e.createdAt}>
                  {ago(e.createdAt)}
                </td>
                <td className="py-1 pr-2" title={e.ip ?? undefined}>
                  {e.actorLabel ?? e.actorType}
                </td>
                <td className="py-1 pr-2 font-mono">{e.action}</td>
                <td className="py-1 font-mono text-neutral-500">
                  {e.targetId ? `${e.targetType} ${e.targetId.slice(0, 8)}` : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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
