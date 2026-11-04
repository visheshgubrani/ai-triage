"use client";

import type { MailboxDetail, MailboxLabels, MailboxList, MailboxSummary } from "@ai-triage/contracts";
import Link from "next/link";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Pill, type Tone } from "@/components/badge";
import { Button } from "@/components/button";
import { useConfirm } from "@/components/confirm-dialog";
import { FormMessage, Notice } from "@/components/notice";
import { Section } from "@/components/section";
import { NativeSelect } from "@/components/ui/native-select";
import { browserApi } from "@/lib/api";
import { readError } from "@/lib/api-error";
import { ago } from "@/lib/format";

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

const STATUS_TONE: Record<MailboxSummary["status"], Tone> = {
  active: "success",
  paused: "neutral",
  reauth_required: "warning",
  disconnected: "neutral",
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
  const confirm = useConfirm();
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
      !(await confirm({
        title: `Disconnect ${mailbox.email}?`,
        body: "Its access at Google is revoked; documents already ingested stay.",
        confirm: "Disconnect",
        destructive: true,
      }))
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
        <Pill dot tone={STATUS_TONE[mailbox.status]}>
          {STATUS_TEXT[mailbox.status]}
        </Pill>
      }
    >
      {mailbox.status === "reauth_required" && (
        <Notice
          tone="warning"
          className="mb-3"
          action={
            <Button
              size="sm"
              variant="primary"
              onClick={async () => setMessage(await startConnect({ backfillDays: 0, loginHint: mailbox.email }))}
            >
              Reconnect
            </Button>
          }
        >
          Google stopped accepting this mailbox's access (revoked, or a Testing-mode grant expired). Mail waits in Gmail
          until you reconnect.
        </Notice>
      )}
      <p className="text-muted-foreground">
        Intake label <span className="font-medium">{mailbox.labelName}</span>
        {mailbox.lastSyncedAt ? ` · checked ${ago(mailbox.lastSyncedAt)}` : " · not checked yet"}
        {mailbox.lastError && mailbox.status === "active" ? ` · last problem: ${mailbox.lastError}` : ""}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {labels ? (
          <NativeSelect
            aria-label="Intake label"
            defaultValue={mailbox.labelId}
            onChange={(e) => void update({ labelId: e.target.value })}
          >
            {labels.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </NativeSelect>
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
        <p role="alert" className="mt-2 text-danger">
          {message}
        </p>
      )}
      {detail && detail.messages.length > 0 && (
        <ul className="mt-4 divide-y divide-border text-xs">
          {detail.messages.map((m) => (
            <li key={m.id} className="flex items-center justify-between gap-2 py-1.5">
              <span>
                {MESSAGE_TEXT[m.status] ?? m.status}
                {m.reason ? ` (${REASON_TEXT[m.reason] ?? m.reason})` : ""}
                <span className="text-muted-foreground"> · {ago(m.receivedAt ?? m.createdAt)}</span>
              </span>
              {m.documentId && (
                <Link
                  href={`/documents/${m.documentId}`}
                  className="font-medium text-primary underline-offset-2 hover:underline"
                >
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

  if (!list) return message ? <p className="mt-6 text-sm text-danger">{message.text}</p> : null;
  return (
    <>
      <FormMessage message={message} />
      <Section title="Connect a Gmail mailbox">
        {list.google ? (
          <form onSubmit={connect} className="flex flex-wrap items-center gap-2">
            <NativeSelect name="backfill" defaultValue="0" aria-label="Import recent mail">
              <option value="0">New mail only</option>
              <option value="1">Also import the last day</option>
              <option value="3">Also import the last 3 days</option>
              <option value="7">Also import the last 7 days</option>
            </NativeSelect>
            <Button type="submit" variant="primary">
              Connect Google mailbox
            </Button>
          </form>
        ) : (
          <p className="text-muted-foreground">
            Google isn't set up on this instance. An operator sets GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET
            (docs/google.md).
          </p>
        )}
        <p className="mt-2 text-xs text-muted-foreground">
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
