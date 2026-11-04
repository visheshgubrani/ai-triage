"use client";

import type { InvitationCreated, JoinRole, MemberList, MemberRole } from "@ai-triage/contracts";
import { Mail, UserMinus } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Pill } from "@/components/badge";
import { Button } from "@/components/button";
import { useConfirm } from "@/components/confirm-dialog";
import { Field } from "@/components/field";
import { LoadingBlock } from "@/components/loading";
import { Notice } from "@/components/notice";
import { SecretReveal } from "@/components/secret-reveal";
import { Section, SectionHint } from "@/components/section";
import { SettingRow, SettingRows } from "@/components/settings-row";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { browserApi } from "@/lib/api";
import { readError } from "@/lib/api-error";
import { ago } from "@/lib/format";

const ROLES: MemberRole[] = ["admin", "reviewer", "viewer"];
const METHOD_LABELS: Record<string, string> = { credential: "Password", google: "Google" };

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
    <Section
      flush
      title="Workspace domain"
      description="People from your Google Workspace can join on their first Google sign-in."
      footer={
        message ? (
          <p role="alert" className="mr-auto text-danger">
            {message}
          </p>
        ) : (
          <SectionHint>Admins are always invited. Someone you remove doesn't rejoin by signing in.</SectionHint>
        )
      }
    >
      <SettingRows>
        {current ? (
          <SettingRow label={current.domain} hint="Verified with Google." htmlFor="join-role">
            <span className="text-muted-foreground">Joins as</span>
            <NativeSelect
              id="join-role"
              aria-label="Role people join as"
              value={current.joinRole}
              onChange={(e) => void setRole(e.target.value as JoinRole)}
            >
              <option value="viewer">viewer</option>
              <option value="reviewer">reviewer</option>
            </NativeSelect>
            <Button variant="ghost" className="text-muted-foreground hover:text-danger" onClick={() => void unlink()}>
              Unlink
            </Button>
          </SettingRow>
        ) : (
          <SettingRow
            label="No domain linked"
            hint="You sign in to a Workspace account in the domain to prove it's yours."
          >
            <form onSubmit={verify} className="flex flex-wrap items-center gap-2 md:justify-end">
              <NativeSelect name="joinRole" defaultValue="viewer" aria-label="Role people join as">
                <option value="viewer">Join as viewer</option>
                <option value="reviewer">Join as reviewer</option>
              </NativeSelect>
              <Button type="submit" variant="primary">
                Verify domain with Google
              </Button>
            </form>
          </SettingRow>
        )}
      </SettingRows>
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

  if (!list) return message ? <p className="mt-6 text-sm text-danger">{message}</p> : <LoadingBlock />;
  return (
    <>
      {message && (
        <Notice tone="danger" role="alert" className="mt-6">
          {message}
        </Notice>
      )}
      <Section
        flush
        title={
          <>
            Members <span className="font-normal text-muted-foreground tabular-nums">{list.members.length}</span>
          </>
        }
      >
        <ul className="divide-y divide-border">
          {list.members.map((m) => (
            <li key={m.userId} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
              <Avatar>
                <AvatarFallback className="bg-accent font-medium text-accent-foreground">
                  {(m.name || m.email).trim().charAt(0).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1 basis-56">
                <p className="truncate">
                  <span className="font-medium">{m.name}</span> <span className="text-muted-foreground">{m.email}</span>
                </p>
                <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
                  {m.signInMethods.map((x) => METHOD_LABELS[x] ?? x).join(" and ") || "No sign-in yet"}
                  {m.hostedDomain && <span>· Workspace {m.hostedDomain}</span>}
                  <span>· joined {ago(m.joinedAt)}</span>
                  {m.twoFactorEnabled && (
                    <Pill tone="success" className="ml-0.5 h-4 px-1.5 text-[11px]">
                      2FA
                    </Pill>
                  )}
                </p>
              </div>
              <div className="flex items-center gap-1">
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
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground hover:text-danger"
                  aria-label={`Remove ${m.email}`}
                  onClick={() => void remove(m.userId, m.email)}
                >
                  <UserMinus aria-hidden="true" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </Section>

      <Section
        title="Invite someone"
        description="Creates a link to send yourself; nothing is emailed. It works once, within seven days."
      >
        <form onSubmit={invite} className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-end">
          <Field label="Email">
            <Input name="email" type="email" placeholder="name@company.com" required />
          </Field>
          <Field label="Role">
            <NativeSelect name="role" defaultValue="reviewer" className="w-full">
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Accepts with">
            <NativeSelect
              name="acceptWith"
              defaultValue={list.google ? "google" : "google_or_password"}
              className="w-full"
            >
              {list.google && <option value="google">Google</option>}
              <option value="google_or_password">{list.google ? "Google or a password" : "A password"}</option>
            </NativeSelect>
          </Field>
          <div className="flex items-center justify-between gap-3 sm:col-span-3">
            <p className="text-xs text-muted-foreground">
              With a password, whoever opens the link can accept it, so send it privately.
            </p>
            <Button type="submit" variant="primary">
              Create link
            </Button>
          </div>
        </form>
        {created && (
          <SecretReveal value={created.link}>
            Send this link to {created.invitation.email}. It won't be shown again, and works once within seven days.
          </SecretReveal>
        )}
      </Section>

      {list.invitations.length > 0 && (
        <Section
          flush
          title={
            <>
              Pending invitations{" "}
              <span className="font-normal text-muted-foreground tabular-nums">{list.invitations.length}</span>
            </>
          }
        >
          <ul className="divide-y divide-border">
            {list.invitations.map((i) => (
              <li key={i.id} className="flex items-center gap-4 px-4 py-3">
                <Avatar>
                  <AvatarFallback>
                    <Mail aria-hidden="true" className="size-4" />
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <p className="truncate">
                    <span className="font-medium">{i.email}</span>{" "}
                    <span className="text-muted-foreground">as {i.role}</span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {i.acceptWith === "google" ? "Google" : "Google or password"} · sent {ago(i.createdAt)} · expires{" "}
                    {new Date(i.expiresAt).toLocaleDateString()}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-muted-foreground hover:text-danger"
                  onClick={() => void revoke(i.id)}
                >
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <WorkspaceDomainSection list={list} onChange={load} />
    </>
  );
}
