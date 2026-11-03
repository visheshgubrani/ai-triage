import type { DocumentDetail } from "@ai-triage/contracts";
import { Badge } from "@/components/badge";
import { ago } from "@/lib/format";

/** Revisions, decisions and deliveries of the document, newest decisions first. */
export function History({ detail }: { detail: DocumentDetail }) {
  return (
    <div className="space-y-4 text-sm">
      <div>
        <h3 className="text-xs font-medium text-neutral-500">Revisions</h3>
        <ul className="mt-1 space-y-1">
          {detail.revisions.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs">r{r.revision}</span>
              <span>{r.author === "model" ? "model" : (r.authorEmail ?? "reviewer")}</span>
              <span className="text-neutral-500">{r.category}</span>
              {r.decision && <Badge value={r.decision} />}
              {r.id === detail.extraction?.id && <span className="text-xs text-neutral-500">(current)</span>}
              <span className="text-xs text-neutral-500">{ago(r.createdAt)}</span>
            </li>
          ))}
          {detail.revisions.length === 0 && <li className="text-neutral-500">None yet.</li>}
        </ul>
      </div>
      <div>
        <h3 className="text-xs font-medium text-neutral-500">Decisions</h3>
        <ul className="mt-1 space-y-1">
          {detail.decisions.map((d) => (
            <li key={d.id}>
              <Badge value={d.outcome} /> {d.reviewerEmail ?? "reviewer"} on a {d.taskKind} task{" "}
              <span className="text-xs text-neutral-500">{ago(d.createdAt)}</span>
              {d.note && <p className="text-xs text-neutral-600 dark:text-neutral-400">“{d.note}”</p>}
              {Array.isArray(d.diff) && d.diff.length > 0 && (
                <p className="font-mono text-xs text-neutral-500">
                  changed {(d.diff as { field: string }[]).map((c) => c.field).join(", ")}
                </p>
              )}
            </li>
          ))}
          {detail.decisions.length === 0 && <li className="text-neutral-500">None yet.</li>}
        </ul>
      </div>
      {detail.actions.length > 0 && (
        <div>
          <h3 className="text-xs font-medium text-neutral-500">Deliveries</h3>
          <ul className="mt-1 space-y-1">
            {detail.actions.map((a) => (
              <li key={a.id}>
                <Badge value={a.status} /> <span className="font-mono text-xs">{a.id}</span>{" "}
                <span className="text-xs text-neutral-500">
                  {a.attempts} attempt{a.attempts === 1 ? "" : "s"}
                  {a.lastError ? ` · ${a.lastError}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
