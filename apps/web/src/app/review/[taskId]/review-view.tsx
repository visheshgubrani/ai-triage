"use client";

import type { DecisionRequest, DocumentDetail, InboxTask, Issue } from "@ai-triage/contracts";
import {
  ACTIONS_BY_TASK_KIND,
  EVAL_SPLITS,
  type EvalSplit,
  HEARTBEAT_SECONDS,
  OTHER_CATEGORY,
  type ReviewAction,
} from "@ai-triage/core";
import { fieldDiff, gateFieldMarks } from "@ai-triage/core/review";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/badge";
import { Button } from "@/components/button";
import { Section } from "@/components/section";
import { browserApi } from "@/lib/api";
import { readError } from "@/lib/api-error";
import { isTyping } from "@/lib/format";
import { FieldForm } from "./field-form";
import { type EvidenceCheck, type FieldSchema, gatesOf } from "./gates";
import { History } from "./history";
import { SourcePanel } from "./source-panel";

type Values = Record<string, unknown>;
type Banner = { tone: "info" | "error"; text: string; reload?: boolean };
type Claim = { token: string; leaseExpiresAt: string };

const KIND_HELP: Record<string, string> = {
  review: "The model's extraction needs a human check before anything is sent.",
  audit: "Audit sample: the model would have auto-approved this. Your decision measures its real precision.",
  unclassified: "The model found no matching category. Reclassify it, or reject it.",
  processing_failed: "Processing failed. Retry it, or reject it.",
};

const SHORTCUTS: [string, string][] = [
  ["a  /  ⌘↵", "Approve (Save & approve when edited)"],
  ["r", "Reclassify"],
  ["x", "Reject"],
  ["t", "Retry"],
  ["n", "Skip to the next task"],
  ["?", "Show or hide shortcuts"],
  ["Esc", "Close a picker"],
];

/** Release a claim when the page goes away. Best effort: an unreleased claim simply lapses. */
function releaseOnLeave(taskId: string, claimToken: string) {
  const base = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";
  void fetch(`${base}/review/tasks/${taskId}/release`, {
    method: "POST",
    credentials: "include",
    keepalive: true,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ claimToken }),
  }).catch(() => {});
}

export function ReviewView({ taskId, canReview }: { taskId: string; canReview: boolean }) {
  const router = useRouter();
  const [task, setTask] = useState<InboxTask | null>(null);
  const [detail, setDetail] = useState<DocumentDetail | null>(null);
  const [claim, setClaim] = useState<Claim | null>(null);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [values, setValues] = useState<Values>({});
  const [issues, setIssues] = useState<Issue[]>([]);
  const [busy, setBusy] = useState(false);
  const [picker, setPicker] = useState<"reclassify" | "reject" | null>(null);
  const [category, setCategory] = useState("");
  const [note, setNote] = useState("");
  // "Add to eval set": unset follows the edit (on for edits, off for plain approvals) until toggled.
  const [addToEval, setAddToEval] = useState<boolean | null>(null);
  const [evalSplit, setEvalSplit] = useState<EvalSplit>("dev");
  const [focus, setFocus] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  const [missing, setMissing] = useState(false);
  // Read by the unmount cleanup, which must not release a claim the decision already consumed.
  const held = useRef<Claim | null>(null);
  held.current = claim;

  const load = useCallback(async () => {
    setBanner(null);
    setIssues([]);
    setPicker(null);
    setAddToEval(null);
    const taskRes = await browserApi.review.tasks[":id"].$get({ param: { id: taskId } });
    if (taskRes.status === 404) return setMissing(true);
    if (!taskRes.ok) return setBanner({ tone: "error", text: (await readError(taskRes)).error });
    const t = (await taskRes.json()) as InboxTask;
    setTask(t);
    const docRes = await browserApi.documents[":id"].$get({ param: { id: t.documentId } });
    if (!docRes.ok) return setBanner({ tone: "error", text: (await readError(docRes)).error });
    const d = (await docRes.json()) as DocumentDetail;
    setDetail(d);
    setValues((d.extraction?.fields ?? {}) as Values);

    if (t.status === "resolved") return setBanner({ tone: "info", text: "This task has been decided." });
    if (t.status === "awaiting_extraction") {
      return setBanner({
        tone: "info",
        text: "Reprocessing after a reclassify. It returns to the queue when done.",
        reload: true,
      });
    }
    if (!canReview) return setBanner({ tone: "info", text: "You have view access: decisions need the reviewer role." });
    const claimRes = await browserApi.review.tasks[":id"].claim.$post({ param: { id: taskId } });
    if (claimRes.ok) {
      const c = await claimRes.json();
      setClaim({ token: c.claimToken, leaseExpiresAt: c.leaseExpiresAt });
    } else {
      const err = await readError(claimRes);
      const until = err.details?.leaseExpiresAt
        ? ` until ${new Date(String(err.details.leaseExpiresAt)).toLocaleTimeString()}`
        : "";
      setClaim(null);
      setBanner({ tone: "info", text: `${err.error}${until} You can look, but not decide.`, reload: true });
    }
  }, [taskId, canReview]);

  useEffect(() => {
    void load();
  }, [load]);

  // Keep the lease while the page is visible; a hidden tab lets it lapse, so a stale tab can't decide.
  useEffect(() => {
    if (!claim) return;
    const beat = async () => {
      if (document.visibilityState !== "visible") return;
      const res = await browserApi.review.tasks[":id"].heartbeat.$post({
        param: { id: taskId },
        json: { claimToken: claim.token },
      });
      if (res.ok) return;
      setClaim(null);
      setBanner({ tone: "error", text: `${(await readError(res)).error} Reload to claim it again.`, reload: true });
    };
    const timer = setInterval(() => void beat(), HEARTBEAT_SECONDS * 1000);
    const onVisible = () => void beat();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [claim, taskId]);

  useEffect(
    () => () => {
      if (held.current) releaseOnLeave(taskId, held.current.token);
    },
    [taskId],
  );

  // Opening a picker puts the cursor in it, so the keyboard flow is r → choose → Enter.
  useEffect(() => {
    if (picker) document.getElementById(picker === "reclassify" ? "reclassify-category" : "reject-note")?.focus();
  }, [picker]);

  const original = (detail?.extraction?.fields ?? {}) as Values;
  const dirty = useMemo(() => fieldDiff(original, values).length > 0, [original, values]);
  const allowed: readonly ReviewAction[] = task ? ACTIONS_BY_TASK_KIND[task.kind] : [];
  const can = (a: ReviewAction) => !!claim && allowed.includes(a) && !busy;
  const gates = gatesOf(detail?.extraction?.gateResults);
  const evidence = gatesOf(detail?.modelGateResults).evidence;
  const checks = useMemo(
    () => new Map<string, EvidenceCheck>((evidence?.checks ?? []).map((c) => [c.field, c])),
    [evidence],
  );
  const marks = useMemo(
    () => gateFieldMarks({ failures: gates.failures, validationIssues: issues }),
    [gates.failures, issues],
  );
  const currentCategory = detail?.extraction?.category ?? detail?.classification?.category ?? null;
  const targets = (detail?.categories ?? []).filter((c) => c !== currentCategory && c !== OTHER_CATEGORY);

  /** After a decision (or a skip), claim the next task, or go back to the queue when there's none. */
  const next = useCallback(async () => {
    const res = await browserApi.review["claim-next"].$post({ json: {} });
    const body = res.ok ? await res.json() : null;
    router.push(body?.claim ? `/review/${body.claim.taskId}` : "/review");
  }, [router]);

  const decide = useCallback(
    async (body: DecisionRequest) => {
      setBusy(true);
      setIssues([]);
      try {
        const res = await browserApi.review.tasks[":id"].decisions.$post({ param: { id: taskId }, json: body });
        if (res.ok) {
          held.current = null;
          setClaim(null);
          await next();
          return;
        }
        const err = await readError(res);
        const status: number = res.status;
        if (err.code === "invalid_fields") {
          setIssues(err.issues ?? []);
          setBanner({ tone: "error", text: "Some fields don't match the schema; they're marked below." });
        } else if (status === 409) {
          setClaim(null);
          setBanner({ tone: "error", text: `${err.error} Nothing was changed.`, reload: true });
        } else {
          setBanner({ tone: "error", text: err.error });
        }
      } finally {
        setBusy(false);
      }
    },
    [taskId, next],
  );

  const approve = useCallback(() => {
    if (!claim || !detail?.extraction) return;
    const base = {
      claimToken: claim.token,
      extractionId: detail.extraction.id,
      ...((addToEval ?? dirty) ? { addToEvalSet: { split: evalSplit } } : {}),
    };
    void decide(dirty ? { action: "edit_approve", ...base, fields: values } : { action: "approve", ...base });
  }, [claim, detail, dirty, values, decide, addToEval, evalSplit]);

  const skip = useCallback(async () => {
    // Claim the next task before releasing this one, so the queue can't hand this one straight back.
    const res = await browserApi.review["claim-next"].$post({ json: {} });
    const body = res.ok ? await res.json() : null;
    if (claim) {
      await browserApi.review.tasks[":id"].release.$post({ param: { id: taskId }, json: { claimToken: claim.token } });
      held.current = null;
    }
    router.push(body?.claim ? `/review/${body.claim.taskId}` : "/review");
  }, [claim, taskId, router]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        if (can("approve")) {
          e.preventDefault();
          approve();
        }
        return;
      }
      if (e.key === "Escape") return setPicker(null);
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      const run: Record<string, () => void> = {
        a: () => can("approve") && approve(),
        r: () => can("reclassify") && setPicker("reclassify"),
        x: () => can("reject") && setPicker("reject"),
        t: () => can("retry") && claim && void decide({ action: "retry", claimToken: claim.token }),
        n: () => void skip(),
        "?": () => setHelp((h) => !h),
      };
      const handler = run[e.key];
      if (handler) {
        e.preventDefault();
        handler();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (missing) {
    return <p className="mt-6 text-sm text-neutral-500">This task doesn't exist, or belongs to another tenant.</p>;
  }
  if (!detail || !task) return <p className="mt-6 text-sm text-neutral-500">{banner?.text ?? "Loading…"}</p>;

  const schema = (detail.schema ?? null) as FieldSchema | null;
  const readOnly = !claim || !allowed.includes("edit_approve");
  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-xl font-semibold tracking-tight">
          {detail.document.title ?? "(untitled)"}{" "}
          <Link
            href={`/documents/${detail.document.id}`}
            className="text-sm font-normal text-neutral-500 underline-offset-2 hover:underline"
          >
            details
          </Link>
        </h1>
        <p className="flex flex-wrap items-center gap-2 text-sm text-neutral-600 dark:text-neutral-400">
          <Badge value={task.kind === "audit" ? "audit sample" : task.kind} />
          {currentCategory && <span>{currentCategory}</span>}
          {detail.classification && (
            <span className="font-mono">score {detail.classification.selfConfidence.toFixed(2)}</span>
          )}
          {claim && <span>claimed until {new Date(claim.leaseExpiresAt).toLocaleTimeString()}</span>}
        </p>
      </div>
      <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">{KIND_HELP[task.kind]}</p>
      {task.reasons.length > 0 && (
        <p className="mt-1 font-mono text-xs text-amber-700 dark:text-amber-400">{task.reasons.join(", ")}</p>
      )}

      {banner && (
        <div
          role={banner.tone === "error" ? "alert" : "status"}
          className={`mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm ${
            banner.tone === "error"
              ? "border-red-300 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
              : "border-neutral-300 bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900"
          }`}
        >
          <span>{banner.text}</span>
          {banner.reload && (
            <Button onClick={() => void load()} className="py-1">
              Reload
            </Button>
          )}
        </div>
      )}

      <div className="mt-4 grid gap-6 lg:grid-cols-2">
        <div className="lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:self-start lg:overflow-y-auto">
          <SourcePanel detail={detail} checks={checks} focus={focus} />
        </div>

        <div>
          <div className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-neutral-200 bg-white/90 py-2 backdrop-blur dark:border-neutral-800 dark:bg-neutral-950/90">
            {allowed.includes("approve") && (
              <Button variant="primary" shortcut="a" disabled={!can("approve")} onClick={approve}>
                {dirty ? "Save & approve" : "Approve"}
              </Button>
            )}
            {allowed.includes("approve") && (
              <span className="flex items-center gap-1.5 text-xs text-neutral-600 dark:text-neutral-400">
                <label
                  className="flex items-center gap-1"
                  title="Keep this document, with the values you approve, as a labeled eval example"
                >
                  <input
                    type="checkbox"
                    checked={addToEval ?? dirty}
                    onChange={(e) => setAddToEval(e.target.checked)}
                  />
                  Add to eval set
                </label>
                <select
                  aria-label="Eval split"
                  value={evalSplit}
                  onChange={(e) => setEvalSplit(e.target.value as EvalSplit)}
                  disabled={!(addToEval ?? dirty)}
                  className="rounded border border-neutral-300 bg-transparent px-1 py-0.5 dark:border-neutral-700"
                >
                  {EVAL_SPLITS.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </span>
            )}
            {allowed.includes("retry") && (
              <Button
                variant="primary"
                shortcut="t"
                disabled={!can("retry")}
                onClick={() => claim && void decide({ action: "retry", claimToken: claim.token })}
              >
                Retry
              </Button>
            )}
            {allowed.includes("reclassify") && (
              <Button shortcut="r" disabled={!can("reclassify")} onClick={() => setPicker("reclassify")}>
                Reclassify
              </Button>
            )}
            {allowed.includes("reject") && (
              <Button variant="danger" shortcut="x" disabled={!can("reject")} onClick={() => setPicker("reject")}>
                Reject
              </Button>
            )}
            <Button shortcut="n" onClick={() => void skip()} disabled={busy} className="ml-auto">
              Skip
            </Button>
            <Button onClick={() => setHelp((h) => !h)} aria-label="Keyboard shortcuts">
              ?
            </Button>
          </div>

          {picker === "reclassify" && claim && (
            <form
              className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-neutral-200 p-3 text-sm dark:border-neutral-800"
              onSubmit={(e) => {
                e.preventDefault();
                if (category) void decide({ action: "reclassify", claimToken: claim.token, category });
              }}
            >
              <label htmlFor="reclassify-category">Reclassify as</label>
              <select
                id="reclassify-category"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="rounded-md border border-neutral-300 bg-transparent px-2 py-1 dark:border-neutral-700"
              >
                <option value="">choose…</option>
                {targets.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
              <Button type="submit" variant="primary" disabled={!category || busy}>
                Reclassify
              </Button>
              <span className="text-xs text-neutral-500">The model re-extracts, then it comes back for review.</span>
            </form>
          )}
          {picker === "reject" && claim && (
            <form
              className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-neutral-200 p-3 text-sm dark:border-neutral-800"
              onSubmit={(e) => {
                e.preventDefault();
                void decide({ action: "reject", claimToken: claim.token, note: note || undefined });
              }}
            >
              <label htmlFor="reject-note">Reject</label>
              <input
                id="reject-note"
                placeholder="Optional note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                className="min-w-48 flex-1 rounded-md border border-neutral-300 bg-transparent px-2 py-1 dark:border-neutral-700"
              />
              <Button type="submit" variant="danger" disabled={busy}>
                Reject
              </Button>
              <span className="text-xs text-neutral-500">Final: nothing is sent for a rejected document.</span>
            </form>
          )}
          {help && (
            <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-md border border-neutral-200 p-3 text-xs dark:border-neutral-800">
              {SHORTCUTS.map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="font-mono">{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          )}

          {detail.run?.error && task.kind === "processing_failed" && (
            <Section title="Run failed">
              <p className="font-mono text-xs break-words text-red-600">{detail.run.error}</p>
            </Section>
          )}
          {(marks.document.length > 0 || (gates.rules ?? []).some((r) => !r.passed)) && (
            <Section title="Checks">
              <ul className="list-disc space-y-1 pl-5 text-amber-800 dark:text-amber-300">
                {marks.document.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            </Section>
          )}
          {schema && detail.extraction ? (
            <Section
              title={`Extraction · revision ${detail.extraction.revision} (${detail.extraction.author})${dirty ? " · edited" : ""}`}
            >
              <FieldForm
                schema={schema}
                values={values}
                onChange={setValues}
                readOnly={readOnly}
                marks={marks}
                checks={checks}
                focus={focus}
                onFocus={setFocus}
              />
            </Section>
          ) : (
            task.kind !== "processing_failed" && (
              <Section title="Extraction">
                <p className="text-neutral-500">No extraction: reclassify to a category to extract it.</p>
              </Section>
            )
          )}
          {detail.classification?.rationale && (
            <Section title="Model's rationale">
              <p className="text-neutral-600 dark:text-neutral-400">{detail.classification.rationale}</p>
            </Section>
          )}
          <Section title="History">
            <History detail={detail} />
          </Section>
        </div>
      </div>
    </div>
  );
}
