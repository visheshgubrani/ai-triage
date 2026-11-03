"use client";

import type { InvitationCreated, JoinRole, MemberList, MemberRole } from "@ai-triage/contracts";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Button } from "@/components/button";
import { Section } from "@/components/section";
import { browserApi } from "@/lib/api";
import { readError } from "@/lib/api-error";
import { ago } from "@/lib/format";

const input = "rounded-md border border-neutral-300 bg-transparent px-3 py-1.5 text-sm dark:border-neutral-700";
const ROLES: MemberRole[] = ["admin", "reviewer", "viewer"];
const METHOD_LABELS: Record<string, string> = { credential: "password", google: "Google" };

/** Back from Google's domain check: `?domain=` or `?error=` (routes/mailboxes.ts, verifyWorkspaceDomain). */
const DOMAIN_ERRORS: Record<string, string> = {
  not_workspace_account: "That Google account isn't a Google Workspace account, so it proves no domain.",
  domain_taken: "That domain is already linked to another workspace on this instance.",
  access_denied: "Google sign-in was cancelled.",
  state_invalid: "That attempt expired or was already used. Try again.",
  google_error: "Google couldn't be reached. Try again.",
};

/**
 * Anyone with a Google Workspace account in the domain may join on their first Google sign-in, as
 * a viewer or reviewer. Linking a domain takes signing in to a Google account in it.
 */
function WorkspaceDomainSection({ list, onChange }: { list: MemberList; onChange: () => Promise<void> }) {
  const [message, setMessage] = useState<string | null>(null);
  const current = list.workspaceDomain;

  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const joinRole = String(new FormData(event.currentTarget).get("joinRole")) as JoinRole;
    const res = await browserApi.members["workspace-domain"].verify.$post({ json: { joinRole } });
    if (!res.ok) return setMessage((await readError(res)).error);
    window.location.assign((await res.json()).url);
  }

  async function setRole(joinRole: JoinRole) {
    const res = await browserApi.members["workspace-domain"].$patch({ json: { joinRole } });
    if (!res.ok) setMessage((await readError(res)).error);
    await onChange();
  }

  async function unlink() {
    if (!window.confirm(`Stop letting people from ${current?.domain} join? Current members stay.`)) return;
    const res = await browserApi.members["workspace-domain"].$delete();
    if (!res.ok) setMessage((await readError(res)).error);
    await onChange();
  }

  if (!list.google && !current) return null;
  return (
    <Section title="Workspace domain">
      {current ? (
        <div className="flex flex-wrap items-center gap-2">
          <span>
            New people from <span className="font-medium">{current.domain}</span> join on their first Google sign-in as
          </span>
          <select
            aria-label="Role people join as"
            value={current.joinRole}
            onChange={(e) => void setRole(e.target.value as JoinRole)}
            className={input}
          >
            <option value="viewer">viewer</option>
            <option value="reviewer">reviewer</option>
          </select>
          <Button variant="danger" onClick={() => void unlink()}>
            Unlink
          </Button>
        </div>
      ) : (
        <form onSubmit={verify} className="flex flex-wrap items-center gap-2">
          <span>Let people from your Google Workspace join as</span>
          <select name="joinRole" defaultValue="viewer" aria-label="Role people join as" className={input}>
            <option value="viewer">viewer</option>
            <option value="reviewer">reviewer</option>
          </select>
          <Button type="submit" variant="primary">
            Verify domain with Google
          </Button>
        </form>
      )}
      <p className="mt-2 text-xs text-neutral-500">
        You sign in to a Google Workspace account in the domain to prove it's yours. Admins are always invited. Someone
        you remove doesn't rejoin by signing in again.
      </p>
      {message && (
        <p role="alert" className="mt-2 text-red-600">
          {message}
        </p>
      )}
    </Section>
  );
}

/**
 * Who belongs to this workspace, and invitations to it. An invitation is a link to copy (nothing
 * is emailed), shown once; it works for seven days, once.
 */
export function MembersView() {
  const [list, setList] = useState<MemberList | null>(null);
  const [created, setCreated] = useState<InvitationCreated | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await browserApi.members.$get();
    if (!res.ok) return setMessage((await readError(res)).error);
    setList(await res.json());
  }, []);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const error = params.get("error");
    if (error) setMessage(DOMAIN_ERRORS[error] ?? `Linking the domain failed (${error}).`);
    if (error || params.get("domain")) window.history.replaceState(null, "", "/settings/members");
    void load();
  }, [load]);

  async function changeRole(userId: string, role: MemberRole) {
    const res = await browserApi.members[":userId"].$patch({ param: { userId }, json: { role } });
    if (!res.ok) setMessage((await readError(res)).error);
    await load();
  }

  async function remove(userId: string, email: string) {
    if (!window.confirm(`Remove ${email}? They lose access at once.`)) return;
    const res = await browserApi.members[":userId"].$delete({ param: { userId } });
    if (!res.ok) setMessage((await readError(res)).error);
    await load();
  }

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const res = await browserApi.members.invitations.$post({
      json: {
        email: String(data.get("email")),
        role: String(data.get("role")) as MemberRole,
        acceptWith: data.get("acceptWith") === "google" ? "google" : "google_or_password",
      },
    });
    if (!res.ok) return setMessage((await readError(res)).error);
    setCreated(await res.json());
    setMessage(null);
    form.reset();
    await load();
  }

  async function revoke(id: string) {
    const res = await browserApi.members.invitations[":id"].revoke.$post({ param: { id } });
    if (!res.ok) setMessage((await readError(res)).error);
    await load();
  }

  if (!list) return message ? <p className="mt-6 text-sm text-red-600">{message}</p> : null;
  return (
    <>
      {message && (
        <p role="alert" className="mt-4 text-sm text-red-600">
          {message}
        </p>
      )}
      <Section title={`Members (${list.members.length})`}>
        <ul className="divide-y divide-neutral-100 dark:divide-neutral-900">
          {list.members.map((m) => (
            <li key={m.userId} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span>
                <span className="font-medium">{m.name}</span> <span className="text-neutral-500">{m.email}</span>
                <span className="block text-xs text-neutral-500">
                  Signs in with {m.signInMethods.map((x) => METHOD_LABELS[x] ?? x).join(" and ") || "nothing yet"}
                  {m.twoFactorEnabled ? " · 2FA on" : ""}
                  {m.hostedDomain ? ` · Workspace ${m.hostedDomain}` : ""} · joined {ago(m.joinedAt)}
                </span>
              </span>
              <span className="flex items-center gap-2">
                <select
                  aria-label={`Role of ${m.email}`}
                  value={m.role}
                  onChange={(e) => void changeRole(m.userId, e.target.value as MemberRole)}
                  className={input}
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
                <Button variant="danger" onClick={() => void remove(m.userId, m.email)}>
                  Remove
                </Button>
              </span>
            </li>
          ))}
        </ul>
      </Section>

      <WorkspaceDomainSection list={list} onChange={load} />

      <Section title="Invite someone">
        <form onSubmit={invite} className="flex flex-wrap items-center gap-2">
          <input name="email" type="email" placeholder="name@company.com" required className={input} />
          <select name="role" defaultValue="reviewer" aria-label="Role" className={input}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <select
            name="acceptWith"
            defaultValue={list.google ? "google" : "google_or_password"}
            aria-label="How they accept"
            className={input}
          >
            {list.google && <option value="google">Accepts with Google</option>}
            <option value="google_or_password">
              {list.google ? "Google or a password" : "Accepts with a password"}
            </option>
          </select>
          <Button type="submit" variant="primary">
            Create link
          </Button>
        </form>
        <p className="mt-2 text-xs text-neutral-500">
          With Google, the link only works for that Google account. With a password, whoever opens the link can accept
          it, so send it privately.
        </p>
        {created && (
          <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950">
            <p className="text-amber-900 dark:text-amber-200">
              Send this link to {created.invitation.email}. It won't be shown again, and works once within seven days.
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <code className="rounded bg-white px-2 py-1 font-mono text-xs break-all dark:bg-neutral-900">
                {created.link}
              </code>
              <Button onClick={() => void navigator.clipboard.writeText(created.link)}>Copy</Button>
            </div>
          </div>
        )}
        {list.invitations.length > 0 && (
          <ul className="mt-4 divide-y divide-neutral-100 dark:divide-neutral-900">
            {list.invitations.map((i) => (
              <li key={i.id} className="flex items-center justify-between gap-2 py-2">
                <span>
                  {i.email} <span className="text-neutral-500">· {i.role}</span>
                  <span className="block text-xs text-neutral-500">
                    {i.acceptWith === "google" ? "Google" : "Google or password"} · sent {ago(i.createdAt)} · expires{" "}
                    {new Date(i.expiresAt).toLocaleDateString()}
                  </span>
                </span>
                <Button onClick={() => void revoke(i.id)}>Revoke</Button>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}
