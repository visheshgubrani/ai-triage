"use client";

import type { InvitationCreated, JoinRole, MemberList, MemberRole } from "@ai-triage/contracts";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Button } from "@/components/button";
import { useConfirm } from "@/components/confirm-dialog";
import { SecretReveal } from "@/components/secret-reveal";
import { Section } from "@/components/section";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { browserApi } from "@/lib/api";
import { readError } from "@/lib/api-error";
import { ago } from "@/lib/format";

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
  const confirm = useConfirm();
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
    if (
      !(await confirm({
        title: `Stop letting people from ${current?.domain} join?`,
        body: "Current members stay.",
        confirm: "Unlink domain",
        destructive: true,
      }))
    )
      return;
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
          <NativeSelect
            aria-label="Role people join as"
            value={current.joinRole}
            onChange={(e) => void setRole(e.target.value as JoinRole)}
          >
            <option value="viewer">viewer</option>
            <option value="reviewer">reviewer</option>
          </NativeSelect>
          <Button variant="danger" onClick={() => void unlink()}>
            Unlink
          </Button>
        </div>
      ) : (
        <form onSubmit={verify} className="flex flex-wrap items-center gap-2">
          <span>Let people from your Google Workspace join as</span>
          <NativeSelect name="joinRole" defaultValue="viewer" aria-label="Role people join as">
            <option value="viewer">viewer</option>
            <option value="reviewer">reviewer</option>
          </NativeSelect>
          <Button type="submit" variant="primary">
            Verify domain with Google
          </Button>
        </form>
      )}
      <p className="mt-2 text-xs text-muted-foreground">
        You sign in to a Google Workspace account in the domain to prove it's yours. Admins are always invited. Someone
        you remove doesn't rejoin by signing in again.
      </p>
      {message && (
        <p role="alert" className="mt-2 text-danger">
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
  const confirm = useConfirm();
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
    if (
      !(await confirm({
        title: `Remove ${email}?`,
        body: "They lose access at once.",
        confirm: "Remove member",
        destructive: true,
      }))
    )
      return;
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
    if (
      !(await confirm({
        title: "Revoke this invitation?",
        body: "Its link stops working.",
        confirm: "Revoke",
        destructive: true,
      }))
    )
      return;
    const res = await browserApi.members.invitations[":id"].revoke.$post({ param: { id } });
    if (!res.ok) setMessage((await readError(res)).error);
    await load();
  }

  if (!list) return message ? <p className="mt-6 text-sm text-danger">{message}</p> : null;
  return (
    <>
      {message && (
        <p role="alert" className="mt-4 text-sm text-danger">
          {message}
        </p>
      )}
      <Section title={`Members (${list.members.length})`}>
        <ul className="divide-y divide-border">
          {list.members.map((m) => (
            <li key={m.userId} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span>
                <span className="font-medium">{m.name}</span> <span className="text-muted-foreground">{m.email}</span>
                <span className="block text-xs text-muted-foreground">
                  Signs in with {m.signInMethods.map((x) => METHOD_LABELS[x] ?? x).join(" and ") || "nothing yet"}
                  {m.twoFactorEnabled ? " · 2FA on" : ""}
                  {m.hostedDomain ? ` · Workspace ${m.hostedDomain}` : ""} · joined {ago(m.joinedAt)}
                </span>
              </span>
              <span className="flex items-center gap-2">
                <NativeSelect
                  aria-label={`Role of ${m.email}`}
                  value={m.role}
                  onChange={(e) => void changeRole(m.userId, e.target.value as MemberRole)}
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </NativeSelect>
                <Button size="sm" variant="danger" onClick={() => void remove(m.userId, m.email)}>
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
          <Input name="email" type="email" placeholder="name@company.com" required className="w-64" />
          <NativeSelect name="role" defaultValue="reviewer" aria-label="Role">
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </NativeSelect>
          <NativeSelect
            name="acceptWith"
            defaultValue={list.google ? "google" : "google_or_password"}
            aria-label="How they accept"
          >
            {list.google && <option value="google">Accepts with Google</option>}
            <option value="google_or_password">
              {list.google ? "Google or a password" : "Accepts with a password"}
            </option>
          </NativeSelect>
          <Button type="submit" variant="primary">
            Create link
          </Button>
        </form>
        <p className="mt-2 text-xs text-muted-foreground">
          With Google, the link only works for that Google account. With a password, whoever opens the link can accept
          it, so send it privately.
        </p>
        {created && (
          <SecretReveal value={created.link}>
            Send this link to {created.invitation.email}. It won't be shown again, and works once within seven days.
          </SecretReveal>
        )}
        {list.invitations.length > 0 && (
          <ul className="mt-4 divide-y divide-border">
            {list.invitations.map((i) => (
              <li key={i.id} className="flex items-center justify-between gap-2 py-2">
                <span>
                  {i.email} <span className="text-muted-foreground">· {i.role}</span>
                  <span className="block text-xs text-muted-foreground">
                    {i.acceptWith === "google" ? "Google" : "Google or password"} · sent {ago(i.createdAt)} · expires{" "}
                    {new Date(i.expiresAt).toLocaleDateString()}
                  </span>
                </span>
                <Button size="sm" onClick={() => void revoke(i.id)}>
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}
