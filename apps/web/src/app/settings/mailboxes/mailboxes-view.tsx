"use client";

import type { MailboxDetail, MailboxLabels, MailboxList, MailboxSummary } from "@ai-triage/contracts";
import Link from "next/link";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Button } from "@/components/button";
import { Section } from "@/components/section";
import { browserApi } from "@/lib/api";
import { readError } from "@/lib/api-error";
import { ago } from "@/lib/format";

const input = "rounded-md border border-neutral-300 bg-transparent px-3 py-1.5 text-sm dark:border-neutral-700";

/** Why the Google round trip didn't connect anything (`?error=` from the API's callback). */
const CALLBACK_ERRORS: Record<string, string> = {
  access_denied: "Google access was declined, so nothing was connected.",
  scope_missing:
    "Gmail access was left unticked on Google's consent screen. Connect again and allow reading the mailbox.",
  state_invalid: "That connection attempt expired or was already used. Start again.",
  no_refresh_token:
    "Google didn't grant lasting access. Remove the app at myaccount.google.com/permissions, then connect again.",
  forbidden: "Only an admin (with two-factor authentication, where required) can connect mailboxes.",
  google_off: "Google isn't set up on this instance.",
  google_error: "Google couldn't be reached or refused the connection. Try again.",
};

const STATUS_TONE: Record<MailboxSummary["status"], string> = {
  active: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  paused: "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
  reauth_required: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  disconnected: "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
};

const STATUS_TEXT: Record<MailboxSummary["status"], string> = {
  active: "syncing",
  paused: "paused",
  reauth_required: "reconnect needed",
  disconnected: "disconnected",
};

const MESSAGE_TEXT: Record<string, string> = {
  queued: "queued",
  ingested: "ingested",
  duplicate: "already ingested",
  skipped: "skipped",
  deferred: "waiting (rate limit)",
  failed: "failed",
  purged: "document deleted",
};

const REASON_TEXT: Record<string, string> = {
  not_inbound: "not incoming mail",
  deleted: "deleted before download",
  too_large: "over the size limit",
  too_many_attachments: "too many attachments",
  unreadable: "couldn't be read",
  retries_exhausted: "kept failing",
};

/** Starts the Google round trip: the API returns Google's consent URL, which the browser opens. */
async function startConnect(body: { backfillDays: number; loginHint?: string }): Promise<string | null> {
  const res = await browserApi.mailboxes.google.authorize.$post({ json: body });
  if (!res.ok) return (await readError(res)).error;
  window.location.assign((await res.json()).url);
  return null;
}

function MailboxCard({ mailbox, onChange }: { mailbox: MailboxSummary; onChange: () => Promise<void> }) {
  const [detail, setDetail] = useState<MailboxDetail | null>(null);
  const [labels, setLabels] = useState<MailboxLabels["labels"] | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await browserApi.mailboxes[":id"].$get({ param: { id: mailbox.id } });
    if (res.ok) setDetail(await res.json());
  }, [mailbox.id]);
  useEffect(() => {
    void load();
  }, [load]);

  async function loadLabels() {
    const res = await browserApi.mailboxes[":id"].labels.$get({ param: { id: mailbox.id } });
    if (!res.ok) return setMessage((await readError(res)).error);
    setLabels((await res.json()).labels);
  }

  async function update(json: { labelId?: string; paused?: boolean }) {
    const res = await browserApi.mailboxes[":id"].$patch({ param: { id: mailbox.id }, json });
    if (!res.ok) return setMessage((await readError(res)).error);
    setMessage(null);
    setLabels(null);
    await onChange();
  }

  async function disconnect() {
    if (
      !window.confirm(`Disconnect ${mailbox.email}? Its access at Google is revoked; documents already ingested stay.`)
    )
      return;
    const res = await browserApi.mailboxes[":id"].$delete({ param: { id: mailbox.id } });
    if (!res.ok) return setMessage((await readError(res)).error);
    await onChange();
  }

  return (
    <Section
      title={mailbox.email}
      actions={
        <span className={`rounded px-1.5 py-0.5 text-xs ${STATUS_TONE[mailbox.status]}`}>
          {STATUS_TEXT[mailbox.status]}
        </span>
      }
    >
      {mailbox.status === "reauth_required" && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950">
          <span className="text-amber-900 dark:text-amber-200">
            Google stopped accepting this mailbox's access (revoked, or a Testing-mode grant expired). Mail waits in
            Gmail until you reconnect.
          </span>
          <Button
            variant="primary"
            onClick={async () => setMessage(await startConnect({ backfillDays: 0, loginHint: mailbox.email }))}
          >
            Reconnect
          </Button>
        </div>
      )}
      <p className="text-neutral-600 dark:text-neutral-400">
        Intake label <span className="font-medium">{mailbox.labelName}</span>
        {mailbox.lastSyncedAt ? ` · checked ${ago(mailbox.lastSyncedAt)}` : " · not checked yet"}
        {mailbox.lastError && mailbox.status === "active" ? ` · last problem: ${mailbox.lastError}` : ""}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {labels ? (
          <select
            aria-label="Intake label"
            defaultValue={mailbox.labelId}
            onChange={(e) => void update({ labelId: e.target.value })}
            className={input}
          >
            {labels.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        ) : (
          <Button onClick={() => void loadLabels()} disabled={mailbox.status === "reauth_required"}>
            Change label
          </Button>
        )}
        {mailbox.status === "active" && <Button onClick={() => void update({ paused: true })}>Pause</Button>}
        {mailbox.status === "paused" && <Button onClick={() => void update({ paused: false })}>Resume</Button>}
        <Button variant="danger" onClick={() => void disconnect()}>
          Disconnect
        </Button>
      </div>
      {message && (
        <p role="alert" className="mt-2 text-red-600">
          {message}
        </p>
      )}
      {detail && detail.messages.length > 0 && (
        <ul className="mt-4 divide-y divide-neutral-100 text-xs dark:divide-neutral-900">
          {detail.messages.map((m) => (
            <li key={m.id} className="flex items-center justify-between gap-2 py-1.5">
              <span>
                {MESSAGE_TEXT[m.status] ?? m.status}
                {m.reason ? ` (${REASON_TEXT[m.reason] ?? m.reason})` : ""}
                <span className="text-neutral-500"> · {ago(m.receivedAt ?? m.createdAt)}</span>
              </span>
              {m.documentId && (
                <Link href={`/documents/${m.documentId}`} className="underline">
                  Open document
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

/**
 * Gmail mailboxes synced into this workspace. New mail in the intake label shows up within about a
 * minute; the app only reads (docs/google.md).
 */
export function MailboxesView() {
  const [list, setList] = useState<MailboxList | null>(null);
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    const res = await browserApi.mailboxes.$get();
    if (!res.ok) return setMessage({ error: true, text: (await readError(res)).error });
    setList(await res.json());
  }, []);
  useEffect(() => {
    // Back from Google: `?connected=<id>` or `?error=<code>`. Shown once, then dropped from the URL.
    const params = new URLSearchParams(window.location.search);
    const error = params.get("error");
    if (error) setMessage({ error: true, text: CALLBACK_ERRORS[error] ?? `Connecting failed (${error}).` });
    else if (params.get("connected"))
      setMessage({ error: false, text: "Mailbox connected. New mail shows up within about a minute." });
    if (error || params.get("connected")) window.history.replaceState(null, "", "/settings/mailboxes");
    void load();
  }, [load]);

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const backfillDays = Number(new FormData(event.currentTarget).get("backfill"));
    const problem = await startConnect({ backfillDays });
    if (problem) setMessage({ error: true, text: problem });
  }

  if (!list) return message ? <p className="mt-6 text-sm text-red-600">{message.text}</p> : null;
  return (
    <>
      {message && (
        <p
          role={message.error ? "alert" : "status"}
          className={`mt-4 text-sm ${message.error ? "text-red-600" : "text-green-700"}`}
        >
          {message.text}
        </p>
      )}
      <Section title="Connect a Gmail mailbox">
        {list.google ? (
          <form onSubmit={connect} className="flex flex-wrap items-center gap-2">
            <select name="backfill" defaultValue="0" aria-label="Import recent mail" className={input}>
              <option value="0">New mail only</option>
              <option value="1">Also import the last day</option>
              <option value="3">Also import the last 3 days</option>
              <option value="7">Also import the last 7 days</option>
            </select>
            <Button type="submit" variant="primary">
              Connect Google mailbox
            </Button>
          </form>
        ) : (
          <p className="text-neutral-600 dark:text-neutral-400">
            Google isn't set up on this instance. An operator sets GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET
            (docs/google.md).
          </p>
        )}
        <p className="mt-2 text-xs text-neutral-500">
          You sign in to Google as the mailbox (for example ap@yourcompany.com) and allow read-only access. The app
          never changes, labels or deletes mail. Imported mail counts against the daily model budget.
        </p>
      </Section>
      {list.mailboxes.map((m) => (
        <MailboxCard key={m.id} mailbox={m} onChange={load} />
      ))}
    </>
  );
}
