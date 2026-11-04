"use client";

import type { DocumentDetail, EmailView } from "@ai-triage/contracts";
import { EMAIL_SOURCE_MIME } from "@ai-triage/core";
import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/badge";
import { LoadingBlock } from "@/components/loading";
import { browserApi } from "@/lib/api";
import type { EvidenceCheck } from "./gates";

type Part = DocumentDetail["parts"][number];
type Span = { field: string; start: number; end: number };

/** A part's text with its verified quotes marked. Overlapping quotes keep the first. */
function HighlightedText({ text, spans, focus }: { text: string; spans: Span[]; focus: string | null }) {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const out: React.ReactNode[] = [];
  let at = 0;
  for (const s of sorted) {
    if (s.start < at || s.end > text.length) continue;
    if (s.start > at) out.push(text.slice(at, s.start));
    out.push(
      <mark
        key={`${s.field}-${s.start}`}
        id={`evidence-${s.field}`}
        title={s.field}
        className={`rounded-sm px-0.5 ${focus === s.field ? "bg-primary text-primary-foreground" : "bg-warning-muted text-foreground"}`}
      >
        {text.slice(s.start, s.end)}
      </mark>,
    );
    at = s.end;
  }
  out.push(text.slice(at));
  return <pre className="font-sans text-sm leading-relaxed whitespace-pre-wrap break-words">{out}</pre>;
}

/**
 * An email in a sandboxed iframe: no scripts, no same-origin access, and a CSP that blocks every
 * remote load. The API has already sanitized the HTML; this is the second layer.
 */
function EmailFrame({ email }: { email: EmailView }) {
  const doc = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<base target="_blank"><style>body{font:14px/1.5 system-ui,sans-serif;margin:12px;color:#171717;background:#fff}</style>
</head><body>${email.html}</body></html>`;
  return (
    <iframe
      title="Email"
      sandbox="allow-popups allow-popups-to-escape-sandbox"
      srcDoc={doc}
      className="h-[60vh] w-full rounded-lg border bg-white"
    />
  );
}

function EmailTab({ documentId }: { documentId: string }) {
  const [email, setEmail] = useState<EmailView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void (async () => {
      const res = await browserApi.documents[":id"].email.$get({ param: { id: documentId } });
      if (res.ok) setEmail(await res.json());
      else setError(`Could not load the email (${res.status}).`);
    })();
  }, [documentId]);
  if (error) return <p className="text-sm text-danger">{error}</p>;
  if (!email) return <LoadingBlock />;
  return (
    <div className="space-y-2">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 text-xs">
        <dt className="text-muted-foreground">From</dt>
        <dd>{email.from ?? "-"}</dd>
        <dt className="text-muted-foreground">Subject</dt>
        <dd>{email.subject ?? "-"}</dd>
        <dt className="text-muted-foreground">Date</dt>
        <dd>{email.date ?? "-"}</dd>
        {email.attachments.length > 0 && (
          <>
            <dt className="text-muted-foreground">Attachments</dt>
            <dd>{email.attachments.map((a) => a.filename).join(", ")}</dd>
          </>
        )}
      </dl>
      {email.html ? (
        <EmailFrame email={email} />
      ) : (
        <pre className="rounded-lg border p-3 font-sans text-sm whitespace-pre-wrap">{email.text}</pre>
      )}
    </div>
  );
}

/** A stored PDF or image. PDFs use the browser's own viewer; `#page=` jumps to the cited page. */
function FileTab({ documentId, fileIndex, page }: { documentId: string; fileIndex: number; page: number }) {
  const [file, setFile] = useState<{ url: string; mime: string } | null>(null);
  useEffect(() => {
    void (async () => {
      const res = await browserApi.documents[":id"].parts[":index"].file.$get({
        param: { id: documentId, index: String(fileIndex) },
      });
      if (res.ok) setFile(await res.json());
    })();
  }, [documentId, fileIndex]);
  if (!file) return <LoadingBlock />;
  if (file.mime.startsWith("image/")) {
    // biome-ignore lint/performance/noImgElement: a presigned URL from storage, not an optimizable asset
    return <img src={file.url} alt="Scanned document" className="max-h-[75vh] w-full object-contain" />;
  }
  if (file.mime === "application/pdf") {
    // Remounting on page change makes the viewer jump; a fragment change alone may not.
    return (
      <iframe
        key={page}
        title="PDF"
        src={`${file.url}#page=${page}`}
        className="h-[75vh] w-full rounded border border-border"
      />
    );
  }
  return (
    <a href={file.url} className="text-sm font-medium text-primary underline-offset-2 hover:underline">
      Download the original
    </a>
  );
}

/**
 * The source, left of the form: the extracted text with evidence highlighted, the email as sent,
 * and each stored file. Focusing a field scrolls to its quote and turns the PDF to its page.
 */
export function SourcePanel({
  detail,
  checks,
  focus,
}: {
  detail: DocumentDetail;
  checks: Map<string, EvidenceCheck>;
  focus: string | null;
}) {
  const documentId = detail.document.id;
  const files = useMemo(() => {
    const byIndex = new Map<number, { fileIndex: number; label: string; mime: string }>();
    for (const p of detail.parts) {
      if (p.fileIndex === null || byIndex.has(p.fileIndex)) continue;
      if (p.mime === "application/pdf" || p.mime.startsWith("image/")) {
        byIndex.set(p.fileIndex, { fileIndex: p.fileIndex, label: p.label ?? p.mime, mime: p.mime });
      }
    }
    return [...byIndex.values()];
  }, [detail.parts]);
  const tabs = [
    { id: "text", label: "Text" },
    ...(detail.document.mime === EMAIL_SOURCE_MIME ? [{ id: "email", label: "Email" }] : []),
    ...files.map((f) => ({ id: `file-${f.fileIndex}`, label: f.label })),
  ];
  const [tab, setTab] = useState("text");
  const [pages, setPages] = useState<Record<number, number>>({});

  const spans = useMemo(() => {
    const byPart = new Map<number, Span[]>();
    for (const c of checks.values()) {
      if (c.status !== "verified") continue;
      byPart.set(c.partIndex, [...(byPart.get(c.partIndex) ?? []), { field: c.field, start: c.start, end: c.end }]);
    }
    return byPart;
  }, [checks]);

  useEffect(() => {
    const check = focus ? checks.get(focus) : undefined;
    if (check?.status !== "verified") return;
    const part: Part | undefined = detail.parts.find((p) => p.partIndex === check.partIndex);
    if (part?.fileIndex !== null && part?.fileIndex !== undefined && part.page) {
      const fileIndex = part.fileIndex;
      setPages((p) => ({ ...p, [fileIndex]: part.page ?? 1 }));
    }
    if (tab === "text")
      document.getElementById(`evidence-${check.field}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [focus, checks, detail.parts, tab]);

  return (
    <div>
      <div role="tablist" aria-label="Source views" className="flex flex-wrap gap-1 border-b">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={`-mb-px h-8 max-w-48 truncate border-b-2 px-2 text-sm font-medium transition-colors ${tab === t.id ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="mt-3">
        {tab === "text" &&
          (detail.parts.length === 0 ? (
            <p className="text-sm text-muted-foreground">Not parsed yet.</p>
          ) : (
            <div className="space-y-4">
              {detail.parts.map((p) => (
                <div key={p.partIndex}>
                  <p className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span>
                      #{p.partIndex} {p.label ?? p.kind}
                      {p.page ? ` · page ${p.page}` : ""}
                    </span>
                    <Badge value={p.evidenceMode} />
                    {p.evidenceMode === "ocr_text" && (
                      <span>read by OCR from the scan: check figures against the original</span>
                    )}
                  </p>
                  {p.evidenceMode === "unverifiable" && !p.text.trim() ? (
                    <p className="text-sm text-muted-foreground">
                      No text layer (a scan or image). Check the original.
                    </p>
                  ) : (
                    <HighlightedText text={p.text} spans={spans.get(p.partIndex) ?? []} focus={focus} />
                  )}
                </div>
              ))}
            </div>
          ))}
        {tab === "email" && <EmailTab documentId={documentId} />}
        {files.map(
          (f) =>
            tab === `file-${f.fileIndex}` && (
              <FileTab
                key={f.fileIndex}
                documentId={documentId}
                fileIndex={f.fileIndex}
                page={pages[f.fileIndex] ?? 1}
              />
            ),
        )}
      </div>
    </div>
  );
}
