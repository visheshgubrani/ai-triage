import { DocumentDetail } from "@ai-triage/contracts";
import { ChevronRight, FileWarning } from "lucide-react";
import { cookies } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Pill, stateOf } from "@/components/badge";
import { Button } from "@/components/button";
import { DataTable } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { Page, PageHeader } from "@/components/page-header";
import { Section } from "@/components/section";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { api } from "@/lib/api";
import { getMe } from "@/lib/session";
import { DeleteDocumentButton } from "./delete-button";

export const dynamic = "force-dynamic";

type Gates = {
  failures?: { code: string; field?: string; detail?: string }[];
  evidence?: {
    unverifiable: boolean;
    checks: {
      field: string;
      status: string;
      partIndex?: number;
      start?: number;
      end?: number;
      quote?: string;
      page?: number | null;
    }[];
  };
};

const show = (v: unknown) =>
  v === null || v === undefined ? "-" : typeof v === "object" ? JSON.stringify(v) : String(v);

export default async function DocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cookie = (await cookies()).toString();
  const res = await api.documents[":id"].$get({ param: { id } }, { headers: { cookie } });
  const status: number = res.status;
  if (status === 404) notFound();
  if (status !== 200) {
    return (
      <Page>
        <EmptyState
          icon={FileWarning}
          title="Couldn't load this document"
          description={`The API answered ${status}. Are you signed in?`}
        />
      </Page>
    );
  }
  const d = DocumentDetail.parse(await res.json());
  const me = await getMe();
  const gates = (d.extraction?.gateResults ?? {}) as Gates;
  const values = (d.extraction?.fields ?? {}) as Record<string, unknown>;
  const checks = new Map((gates.evidence?.checks ?? []).map((c) => [c.field, c]));

  return (
    <Page>
      <div className="mx-auto max-w-4xl">
        <PageHeader
          back={{ href: "/documents", label: "Documents" }}
          title={d.document.title ?? "(untitled)"}
          actions={me?.role === "admin" && <DeleteDocumentButton id={d.document.id} />}
        />
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <Badge value={stateOf(d.document)} />
          {d.mailbox ? (
            <>
              <span>Gmail · {d.mailbox.email}</span>
              {d.mailbox.gmailUrl && (
                <a
                  href={d.mailbox.gmailUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-primary underline-offset-2 hover:underline"
                >
                  Open in Gmail
                </a>
              )}
            </>
          ) : (
            <span>{d.document.source}</span>
          )}
          <span>· {d.document.mime ?? "unknown type"}</span>
        </div>

        <dl className="mt-4 grid gap-3 sm:grid-cols-3">
          {(
            [
              ["Processing", d.document.processingStatus],
              ["Review", d.document.reviewStatus],
              ["Delivery", d.document.deliveryStatus],
            ] as const
          ).map(([label, value]) => (
            <div key={label} className="rounded-xl bg-card p-3 shadow-xs ring-1 ring-foreground/8">
              <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
              <dd className="mt-1.5">
                <Badge value={value} />
              </dd>
            </div>
          ))}
        </dl>

        {d.run?.error && (
          <Section title="Run failed">
            <p className="font-mono text-xs break-words text-danger">{d.run.error}</p>
          </Section>
        )}

        {d.task && (
          <Section
            title={`Open task: ${d.task.kind}`}
            actions={
              <Button asChild size="sm" variant="primary">
                <Link href={`/review/${d.task.id}`}>Open in review</Link>
              </Button>
            }
          >
            <div className="flex flex-wrap gap-1">
              {d.task.reasons.length === 0 && <span className="text-muted-foreground">No routing reasons.</span>}
              {d.task.reasons.map((r) => (
                <Pill key={r} tone="warning" className="font-mono">
                  {r}
                </Pill>
              ))}
            </div>
          </Section>
        )}

        {d.classification && (
          <Section title="Classification">
            <p>
              <span className="font-medium">{d.classification.category}</span> · confidence{" "}
              <span className="font-mono">{d.classification.selfConfidence.toFixed(2)}</span>
            </p>
            {d.classification.rationale && <p className="mt-1 text-muted-foreground">{d.classification.rationale}</p>}
          </Section>
        )}

        {d.extraction && (
          <Section
            title="Extraction"
            description={`Revision ${d.extraction.revision} · decision ${d.extraction.decision ?? "pending"}`}
          >
            {d.extraction.decisionReasons.length > 0 && (
              <div className="mb-3 flex flex-wrap gap-1">
                {d.extraction.decisionReasons.map((r) => (
                  <Pill key={r} tone="warning" className="font-mono">
                    {r}
                  </Pill>
                ))}
              </div>
            )}
            <DataTable>
              <thead>
                <tr>
                  <th>Field</th>
                  <th>Value</th>
                  <th>Evidence</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(values).map(([field, value]) => {
                  const check = checks.get(field);
                  return (
                    <tr key={field}>
                      <td className="font-mono text-xs">{field}</td>
                      <td className="break-all">{show(value)}</td>
                      <td>
                        {check ? <Badge value={check.status} /> : <span className="text-muted-foreground">-</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </DataTable>
          </Section>
        )}

        {d.actions.length > 0 && (
          <Section title="Action (outbox)">
            {d.actions.map((a) => (
              <div key={a.id}>
                <p className="flex flex-wrap items-center gap-2">
                  <Badge value={a.status} /> <span className="font-mono text-xs">Idempotency-Key {a.id}</span>
                  <span className="text-xs text-muted-foreground">
                    · {a.attempts} attempt{a.attempts === 1 ? "" : "s"}
                    {a.lastError ? ` · last error: ${a.lastError}` : ""}
                  </span>
                </p>
                <pre className="mt-2 overflow-x-auto rounded-lg bg-muted p-3 text-xs">
                  {JSON.stringify(a.payload, null, 2)}
                </pre>
              </div>
            ))}
          </Section>
        )}

        <Section title={`Parsed parts (${d.parts.length})`}>
          {d.parts.length === 0 && <p className="text-muted-foreground">Not parsed yet.</p>}
          {d.parts.map((p) => (
            <Collapsible key={p.partIndex} className="border-t py-2 first:border-t-0 first:pt-0 last:pb-0">
              <CollapsibleTrigger className="group flex w-full cursor-pointer items-center gap-2 text-left">
                <ChevronRight
                  aria-hidden="true"
                  className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90"
                />
                <span className="min-w-0 truncate">
                  #{p.partIndex} {p.kind}
                  {p.label ? ` · ${p.label}` : ""}
                  {p.page ? ` · page ${p.page}` : ""}
                </span>
                <Badge value={p.evidenceMode} />
              </CollapsibleTrigger>
              <CollapsibleContent>
                <pre className="mt-2 max-h-80 overflow-auto rounded-lg bg-muted p-3 text-xs whitespace-pre-wrap">
                  {p.text || "(no text layer)"}
                </pre>
              </CollapsibleContent>
            </Collapsible>
          ))}
        </Section>
      </div>
    </Page>
  );
}
