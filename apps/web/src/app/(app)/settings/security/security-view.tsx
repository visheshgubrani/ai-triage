"use client";

import { useRouter } from "next/navigation";
import QRCode from "qrcode";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Button } from "@/components/button";
import { useConfirm } from "@/components/confirm-dialog";
import { LoadingBlock } from "@/components/loading";
import { FormMessage, Notice } from "@/components/notice";
import { Section } from "@/components/section";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";
import { ago } from "@/lib/format";
import { authErrorText, googleEnabled } from "@/lib/google";

type Message = { error: boolean; text: string } | null;

function Note({ message }: { message: Message }) {
  return <FormMessage message={message} className="mt-2" />;
}

/**
 * TOTP: turn on (scan, confirm a code, keep the backup codes) or off. A user with a password confirms
 * with it; a Google-only user needs to have signed in within the last few minutes instead (the api
 * refuses with `recent_sign_in_required` otherwise).
 */
function TwoFactorSection({
  enabled,
  required,
  hasPassword,
}: {
  enabled: boolean;
  required: boolean;
  hasPassword: boolean;
}) {
  const ask = useConfirm();
  const router = useRouter();
  const [setup, setSetup] = useState<{ qr: string; uri: string; backupCodes: string[] } | null>(null);
  const [message, setMessage] = useState<Message>(null);
  const passwordOf = (form: HTMLFormElement) =>
    hasPassword ? { password: String(new FormData(form).get("password")) } : {};

  async function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const { data, error } = await authClient.twoFactor.enable(passwordOf(event.currentTarget));
    if (error || !data || data.method !== "totp") {
      return setMessage({
        error: true,
        text: error ? authErrorText(error, "Couldn't start setup") : "Couldn't start setup",
      });
    }
    const qr = `data:image/svg+xml;utf8,${encodeURIComponent(await QRCode.toString(data.totpURI, { type: "svg", margin: 1 }))}`;
    setSetup({ qr, uri: data.totpURI, backupCodes: data.backupCodes });
    setMessage(null);
  }

  async function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = String(new FormData(event.currentTarget).get("code")).trim();
    const { error } = await authClient.twoFactor.verifyTotp({ code });
    if (error) return setMessage({ error: true, text: error.message ?? "That code didn't work" });
    setSetup(null);
    setMessage({ error: false, text: "Two-factor authentication is on." });
    router.refresh();
  }

  async function disable(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = passwordOf(event.currentTarget);
    if (
      !(await ask({
        title: "Turn off two-factor authentication?",
        body: "Your password alone will sign you in.",
        confirm: "Turn off",
        destructive: true,
      }))
    )
      return;
    const { error } = await authClient.twoFactor.disable(body);
    if (error) return setMessage({ error: true, text: authErrorText(error, "Couldn't turn it off") });
    setMessage({ error: false, text: "Two-factor authentication is off." });
    router.refresh();
  }

  return (
    <Section title="Two-factor authentication">
      {required && !enabled && <p className="mb-2 text-warning">Admin settings stay locked until this is on.</p>}
      {enabled ? (
        <form onSubmit={disable} className="flex flex-wrap items-center gap-2">
          <span>On: sign-in asks for a code from your authenticator app.</span>
          {hasPassword && <Input name="password" type="password" placeholder="Password" required />}
          <Button type="submit">Turn off</Button>
        </form>
      ) : setup ? (
        <div className="space-y-3">
          <p>Scan this with an authenticator app, then enter the code it shows.</p>
          {/* A data: URL (the CSP allows it), so the secret never leaves the browser; next/image adds nothing here. */}
          {/* biome-ignore lint/performance/noImgElement: a generated data: URL, not an asset to optimize */}
          <img
            src={setup.qr}
            alt="QR code for your authenticator app"
            width={180}
            height={180}
            className="rounded-lg bg-white p-2"
          />
          <details>
            <summary className="w-fit text-muted-foreground select-none hover:text-foreground">
              Can't scan? Enter the setup key
            </summary>
            <code className="break-all text-xs">{new URL(setup.uri).searchParams.get("secret")}</code>
          </details>
          <Notice tone="warning">
            <p>Backup codes, each usable once if you lose the app. They won't be shown again.</p>
            <code className="mt-2 block font-mono text-xs whitespace-pre-wrap">{setup.backupCodes.join("\n")}</code>
          </Notice>
          <form onSubmit={confirm} className="flex flex-wrap items-center gap-2">
            <Input name="code" inputMode="numeric" autoComplete="one-time-code" placeholder="123456" required />
            <Button type="submit" variant="primary">
              Confirm
            </Button>
          </form>
        </div>
      ) : (
        <form onSubmit={start} className="flex flex-wrap items-center gap-2">
          <span>Off.</span>
          {hasPassword && <Input name="password" type="password" placeholder="Password" required />}
          <Button type="submit" variant="primary">
            Set up
          </Button>
        </form>
      )}
      <Note message={message} />
    </Section>
  );
}

type SessionRow = { id: string; token: string; ipAddress?: string | null; userAgent?: string | null; createdAt: Date };

/** Where this account is signed in, with revoke. */
function SessionsSection() {
  const confirm = useConfirm();
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [message, setMessage] = useState<Message>(null);

  const load = useCallback(async () => {
    const [list, me] = await Promise.all([authClient.listSessions(), authClient.getSession()]);
    if (list.error) return setMessage({ error: true, text: list.error.message ?? "Couldn't list sessions" });
    setSessions((list.data ?? []) as SessionRow[]);
    setCurrent(me.data?.session.token ?? null);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function revoke(token: string) {
    const { error } = await authClient.revokeSession({ token });
    if (error) return setMessage({ error: true, text: error.message ?? "Couldn't sign it out" });
    await load();
  }

  async function revokeOthers() {
    if (!(await confirm({ title: "Sign out your other sessions?", confirm: "Sign them out", destructive: true })))
      return;
    const { error } = await authClient.revokeOtherSessions();
    if (error) return setMessage({ error: true, text: error.message ?? "Couldn't sign them out" });
    setMessage({ error: false, text: "Signed out everywhere else." });
    await load();
  }

  return (
    <Section title="Sessions" actions={<Button onClick={() => void revokeOthers()}>Sign out other sessions</Button>}>
      <ul className="divide-y divide-border">
        {sessions.map((s) => (
          <li key={s.id} className="flex items-center justify-between gap-2 py-2">
            <span className="text-xs">
              <span className="font-medium">
                {s.token === current ? "This browser" : (s.userAgent ?? "Unknown client").slice(0, 80)}
              </span>
              <span className="text-muted-foreground">
                {" "}
                · {s.ipAddress ?? "unknown address"} · signed in {ago(new Date(s.createdAt).toISOString())}
              </span>
            </span>
            {s.token !== current && <Button onClick={() => void revoke(s.token)}>Sign out</Button>}
          </li>
        ))}
      </ul>
      <Note message={message} />
    </Section>
  );
}

/** Changing the password signs out every other session. */
function PasswordSection() {
  const [message, setMessage] = useState<Message>(null);

  async function change(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const newPassword = String(data.get("new"));
    if (newPassword !== String(data.get("repeat")))
      return setMessage({ error: true, text: "The new passwords differ." });
    const { error } = await authClient.changePassword({
      currentPassword: String(data.get("current")),
      newPassword,
      revokeOtherSessions: true,
    });
    if (error) return setMessage({ error: true, text: error.message ?? "Couldn't change the password" });
    form.reset();
    setMessage({ error: false, text: "Password changed; other sessions were signed out." });
  }

  return (
    <Section title="Password">
      <form onSubmit={change} className="flex flex-wrap items-center gap-2">
        <Input name="current" type="password" placeholder="Current password" autoComplete="current-password" required />
        <Input
          name="new"
          type="password"
          placeholder="New password (12+ characters)"
          autoComplete="new-password"
          minLength={12}
          required
        />
        <Input
          name="repeat"
          type="password"
          placeholder="Repeat it"
          autoComplete="new-password"
          minLength={12}
          required
        />
        <Button type="submit">Change</Button>
      </form>
      <Note message={message} />
    </Section>
  );
}

type Account = { id: string; providerId: string };

/** How this account signs in: a password, Google, or both. Google can be linked or unlinked here. */
function SignInMethodsSection({
  accounts,
  google,
  onChange,
}: {
  accounts: Account[];
  google: boolean;
  onChange: () => Promise<void>;
}) {
  const confirm = useConfirm();
  const [message, setMessage] = useState<Message>(null);
  const linked = accounts.find((a) => a.providerId === "google");
  const hasPassword = accounts.some((a) => a.providerId === "credential");

  async function link() {
    const { error } = await authClient.linkSocial({
      provider: "google",
      callbackURL: `${window.location.origin}/settings/security`,
      errorCallbackURL: `${window.location.origin}/settings/security`,
    });
    if (error) setMessage({ error: true, text: authErrorText(error, "Couldn't start linking") });
  }

  async function unlink(accountId: string) {
    if (!(await confirm({ title: "Stop signing in with Google?", confirm: "Unlink Google", destructive: true })))
      return;
    const { error } = await authClient.unlinkAccount({ accountId });
    if (error) return setMessage({ error: true, text: authErrorText(error, "Couldn't unlink Google") });
    setMessage({ error: false, text: "Google is no longer linked." });
    await onChange();
  }

  if (!google && !linked) return null;
  return (
    <Section title="Sign-in methods">
      <ul className="divide-y divide-border">
        <li className="flex items-center justify-between gap-2 py-2">
          <span>Password</span>
          <span className="text-muted-foreground">{hasPassword ? "Set" : "None: you sign in with Google"}</span>
        </li>
        <li className="flex items-center justify-between gap-2 py-2">
          <span>Google</span>
          {linked ? (
            // Better Auth refuses to unlink the last way to sign in.
            <Button onClick={() => void unlink(linked.id)} disabled={!hasPassword}>
              Unlink
            </Button>
          ) : (
            <Button onClick={() => void link()}>Link Google account</Button>
          )}
        </li>
      </ul>
      <Note message={message} />
    </Section>
  );
}

export function SecurityView(props: { email: string; twoFactorEnabled: boolean; twoFactorRequired: boolean }) {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [google, setGoogle] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data } = await authClient.listAccounts();
    setAccounts((data ?? []) as Account[]);
  }, []);
  useEffect(() => {
    void load();
    void googleEnabled().then(setGoogle);
    // Back from linking Google with `?error=` (for example, a Google account with another email).
    const code = new URLSearchParams(window.location.search).get("error");
    if (code) setLinkError(`Google couldn't be linked (${code}).`);
  }, [load]);

  if (!accounts) return <LoadingBlock />;
  const hasPassword = accounts.some((a) => a.providerId === "credential");
  return (
    <>
      <p className="mt-2 text-sm text-muted-foreground">Signed in as {props.email}.</p>
      {linkError && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {linkError}
        </p>
      )}
      <TwoFactorSection enabled={props.twoFactorEnabled} required={props.twoFactorRequired} hasPassword={hasPassword} />
      <SignInMethodsSection accounts={accounts} google={google} onChange={load} />
      <SessionsSection />
      {hasPassword && <PasswordSection />}
    </>
  );
}
