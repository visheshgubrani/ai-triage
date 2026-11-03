import { DocumentDetail } from "@ai-triage/contracts";
import { cookies } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, stateOf } from "@/components/badge";
import { Section } from "@/components/section";
import { api } from "@/lib/api";

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
      <main className="mx-auto max-w-4xl px-4 py-12">
        <p className="text-sm text-red-600">Could not load this document ({status}). Are you signed in?</p>
      </main>
    );
  }
  const d = DocumentDetail.parse(await res.json());
  const gates = (d.extraction?.gateResults ?? {}) as Gates;
  const values = (d.extraction?.fields ?? {}) as Record<string, unknown>;
  const checks = new Map((gates.evidence?.checks ?? []).map((c) => [c.field, c]));

  return (
    <main className="mx-auto max-w-4xl px-4 py-12">
      <p className="text-sm">
        <Link href="/documents" className="text-neutral-500 underline-offset-2 hover:underline">
          Documents
        </Link>
      </p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">{d.document.title ?? "(untitled)"}</h1>
      <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-neutral-600 dark:text-neutral-400">
        <Badge value={stateOf(d.document)} /> {d.document.source} · {d.document.mime ?? "unknown type"} · processing{" "}
        <Badge value={d.document.processingStatus} /> review <Badge value={d.document.reviewStatus} /> delivery{" "}
        <Badge value={d.document.deliveryStatus} />
      </p>

      {d.run?.error && (
        <Section title="Run failed">
          <p className="font-mono text-xs text-red-600">{d.run.error}</p>
        </Section>
      )}

      {d.task && (
        <Section
          title={`Open task: ${d.task.kind}`}
          actions={
            <Link href={`/review/${d.task.id}`} className="text-sm font-medium underline underline-offset-2">
              Open in review
            </Link>
          }
        >
          <p className="font-mono text-xs">{d.task.reasons.join(", ") || "-"}</p>
        </Section>
      )}

      {d.classification && (
        <Section title="Classification">
          <p>
            <span className="font-medium">{d.classification.category}</span> · confidence{" "}
            <span className="font-mono">{d.classification.selfConfidence.toFixed(2)}</span>
          </p>
          {d.classification.rationale && (
            <p className="mt-1 text-neutral-600 dark:text-neutral-400">{d.classification.rationale}</p>
          )}
        </Section>
      )}

      {d.extraction && (
        <Section
          title={`Extraction (revision ${d.extraction.revision}) · decision ${d.extraction.decision ?? "pending"}`}
        >
          {d.extraction.decisionReasons.length > 0 && (
            <p className="mb-3 font-mono text-xs text-amber-700 dark:text-amber-400">
              {d.extraction.decisionReasons.join(", ")}
            </p>
          )}
          <table className="w-full text-left">
            <thead className="text-xs uppercase text-neutral-500">
              <tr>
                <th className="py-1 pr-4 font-medium">Field</th>
                <th className="py-1 pr-4 font-medium">Value</th>
                <th className="py-1 font-medium">Evidence</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-200 dark:divide-neutral-800">
              {Object.entries(values).map(([field, value]) => {
                const check = checks.get(field);
                return (
                  <tr key={field} className="align-top">
                    <td className="py-1 pr-4 font-mono text-xs">{field}</td>
                    <td className="py-1 pr-4 break-all">{show(value)}</td>
                    <td className="py-1">
                      {check ? <Badge value={check.status} /> : <span className="text-neutral-400">-</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Section>
      )}

      {d.actions.length > 0 && (
        <Section title="Action (outbox)">
          {d.actions.map((a) => (
            <div key={a.id}>
              <p>
                <Badge value={a.status} /> <span className="font-mono text-xs">Idempotency-Key {a.id}</span>{" "}
                <span className="text-xs text-neutral-500">
                  · {a.attempts} attempt{a.attempts === 1 ? "" : "s"}
                  {a.lastError ? ` · last error: ${a.lastError}` : ""}
                </span>
              </p>
              <pre className="mt-2 overflow-x-auto rounded bg-neutral-50 p-2 text-xs dark:bg-neutral-900">
                {JSON.stringify(a.payload, null, 2)}
              </pre>
            </div>
          ))}
        </Section>
      )}

      <Section title={`Parsed parts (${d.parts.length})`}>
        {d.parts.length === 0 && <p className="text-neutral-500">Not parsed yet.</p>}
        {d.parts.map((p) => (
          <details
            key={p.partIndex}
            className="border-t border-neutral-200 py-2 first:border-t-0 dark:border-neutral-800"
          >
            <summary className="cursor-pointer">
              #{p.partIndex} {p.kind}
              {p.label ? ` · ${p.label}` : ""}
              {p.page ? ` · page ${p.page}` : ""} · <Badge value={p.evidenceMode} />
            </summary>
            <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded bg-neutral-50 p-2 text-xs dark:bg-neutral-900">
              {p.text || "(no text layer)"}
            </pre>
          </details>
        ))}
      </Section>
    </main>
  );
}
