"use client";

import type { MailboxDetail, MailboxLabels, MailboxList, MailboxSummary } from "@ai-triage/contracts";
import Link from "next/link";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Pill, type Tone } from "@/components/badge";
import { Button } from "@/components/button";
import { useConfirm } from "@/components/confirm-dialog";
import { GoogleMark } from "@/components/google-button";
import { LoadingBlock } from "@/components/loading";
import { Notice, ResultNotice } from "@/components/notice";
import { Section, SectionHint } from "@/components/section";
import { SettingRow, SettingRows } from "@/components/settings-row";
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
      flush
      title={
        <>
          <GoogleMark />
          {mailbox.email}
        </>
      }
      description={mailbox.lastSyncedAt ? `Checked ${ago(mailbox.lastSyncedAt)}` : "Not checked yet"}
      actions={
        <Pill dot tone={STATUS_TONE[mailbox.status]}>
          {STATUS_TEXT[mailbox.status]}
        </Pill>
      }
      footer={
        <>
          {message && (
            <p role="alert" className="mr-auto text-danger">
              {message}
            </p>
          )}
          {mailbox.status === "active" && <Button onClick={() => void update({ paused: true })}>Pause</Button>}
          {mailbox.status === "paused" && <Button onClick={() => void update({ paused: false })}>Resume</Button>}
          <Button variant="ghost" className="text-muted-foreground hover:text-danger" onClick={() => void disconnect()}>
            Disconnect
          </Button>
        </>
      }
    >
      {mailbox.status === "reauth_required" && (
        <div className="px-4 pt-4">
          <Notice
            tone="warning"
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
            Google stopped accepting this mailbox's access (revoked, or a Testing-mode grant expired). Mail waits in
            Gmail until you reconnect.
          </Notice>
        </div>
      )}
      <SettingRows>
        <SettingRow label="Intake label" hint="Mail with this label is triaged.">
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
            <>
              <span className="font-medium">{mailbox.labelName}</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void loadLabels()}
                disabled={mailbox.status === "reauth_required"}
              >
                Change label
              </Button>
            </>
          )}
        </SettingRow>
        {mailbox.lastError && mailbox.status === "active" && (
          <SettingRow label="Last problem" hint={mailbox.lastError} />
        )}
      </SettingRows>
      {detail && detail.messages.length > 0 && (
        <>
          <p className="border-t px-4 pt-3 pb-1 text-xs font-medium text-muted-foreground">Recent messages</p>
          <ul className="divide-y divide-border pb-1 text-xs">
            {detail.messages.map((m) => (
              <li key={m.id} className="flex items-center justify-between gap-2 px-4 py-2">
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
        </>
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

  if (!list) return message ? <ResultNotice message={message} /> : <LoadingBlock />;
  return (
    <>
      <ResultNotice message={message} />
      <Section
        flush
        title="Connect a Gmail mailbox"
        description="Sign in to Google as the mailbox (say, ap@yourcompany.com) and allow read-only access."
        footer={
          <SectionHint>
            The app never changes, labels or deletes mail. Imported mail counts against the daily budget.
          </SectionHint>
        }
      >
        <SettingRows>
          {list.google ? (
            <SettingRow
              label="Import recent mail"
              htmlFor="backfill"
              hint="New mail always comes in within about a minute."
            >
              <form onSubmit={connect} className="flex flex-wrap items-center gap-2 md:justify-end">
                <NativeSelect id="backfill" name="backfill" defaultValue="0">
                  <option value="0">New mail only</option>
                  <option value="1">Also the last day</option>
                  <option value="3">Also the last 3 days</option>
                  <option value="7">Also the last 7 days</option>
                </NativeSelect>
                <Button type="submit" variant="primary">
                  Connect Google mailbox
                </Button>
              </form>
            </SettingRow>
          ) : (
            <SettingRow
              label="Google isn't set up"
              hint="An operator sets GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET on this instance (docs/google.md)."
            />
          )}
        </SettingRows>
      </Section>
      {list.mailboxes.map((m) => (
        <MailboxCard key={m.id} mailbox={m} onChange={load} />
      ))}
    </>
  );
}
