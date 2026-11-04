import type { DocumentDetail } from "@ai-triage/contracts";
import type { ReactNode } from "react";
import { Badge } from "@/components/badge";
import { ago } from "@/lib/format";

function Timeline({ title, empty, children }: { title: string; empty?: boolean; children: ReactNode }) {
  return (
    <div>
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      {empty ? (
        <p className="mt-1 text-muted-foreground">None yet.</p>
      ) : (
        <ul className="mt-2 space-y-2.5 border-l pl-3">{children}</ul>
      )}
    </div>
  );
}

function Entry({ children }: { children: ReactNode }) {
  return (
    <li className="relative before:absolute before:top-1.5 before:-left-[calc(0.75rem+3.5px)] before:size-1.5 before:rounded-full before:bg-muted-foreground/50">
      {children}
    </li>
  );
}

/** Revisions, decisions and deliveries of the document, newest decisions first. */
export function History({ detail }: { detail: DocumentDetail }) {
  return (
    <div className="space-y-4 text-sm">
      <Timeline title="Revisions" empty={detail.revisions.length === 0}>
        {detail.revisions.map((r) => (
          <Entry key={r.id}>
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs">r{r.revision}</span>
              <span>{r.author === "model" ? "model" : (r.authorEmail ?? "reviewer")}</span>
              <span className="text-muted-foreground">{r.category}</span>
              {r.decision && <Badge value={r.decision} />}
              {r.id === detail.extraction?.id && <span className="text-xs text-muted-foreground">(current)</span>}
              <span className="text-xs text-muted-foreground">{ago(r.createdAt)}</span>
            </span>
          </Entry>
        ))}
      </Timeline>
      <Timeline title="Decisions" empty={detail.decisions.length === 0}>
        {detail.decisions.map((d) => (
          <Entry key={d.id}>
            <span className="flex flex-wrap items-center gap-2">
              <Badge value={d.outcome} /> {d.reviewerEmail ?? "reviewer"} on a {d.taskKind} task{" "}
              <span className="text-xs text-muted-foreground">{ago(d.createdAt)}</span>
            </span>
            {d.note && <p className="mt-0.5 text-xs text-muted-foreground">“{d.note}”</p>}
            {Array.isArray(d.diff) && d.diff.length > 0 && (
              <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                changed {(d.diff as { field: string }[]).map((c) => c.field).join(", ")}
              </p>
            )}
          </Entry>
        ))}
      </Timeline>
      {detail.actions.length > 0 && (
        <Timeline title="Deliveries">
          {detail.actions.map((a) => (
            <Entry key={a.id}>
              <span className="flex flex-wrap items-center gap-2">
                <Badge value={a.status} /> <span className="font-mono text-xs break-all">{a.id}</span>
              </span>
              <span className="text-xs text-muted-foreground">
                {a.attempts} attempt{a.attempts === 1 ? "" : "s"}
                {a.lastError ? ` · ${a.lastError}` : ""}
              </span>
            </Entry>
          ))}
        </Timeline>
      )}
    </div>
  );
}
