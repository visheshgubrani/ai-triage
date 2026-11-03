"use client";

import { useRouter } from "next/navigation";
import QRCode from "qrcode";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { Button } from "@/components/button";
import { Section } from "@/components/section";
import { authClient } from "@/lib/auth-client";
import { ago } from "@/lib/format";

const input = "rounded-md border border-neutral-300 bg-transparent px-3 py-1.5 text-sm dark:border-neutral-700";

type Message = { error: boolean; text: string } | null;

function Note({ message }: { message: Message }) {
  if (!message) return null;
  return (
    <p
      role={message.error ? "alert" : "status"}
      className={`mt-2 ${message.error ? "text-red-600" : "text-neutral-600 dark:text-neutral-400"}`}
    >
      {message.text}
    </p>
  );
}

/** TOTP: turn on (scan, confirm a code, keep the backup codes) or off. */
function TwoFactorSection({ enabled, required }: { enabled: boolean; required: boolean }) {
  const router = useRouter();
  const [setup, setSetup] = useState<{ qr: string; uri: string; backupCodes: string[] } | null>(null);
  const [message, setMessage] = useState<Message>(null);

  async function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const password = String(new FormData(event.currentTarget).get("password"));
    const { data, error } = await authClient.twoFactor.enable({ password });
    if (error || !data || data.method !== "totp") {
      return setMessage({ error: true, text: error?.message ?? "Couldn't start setup" });
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
    const password = String(new FormData(event.currentTarget).get("password"));
    if (!window.confirm("Turn off two-factor authentication?")) return;
    const { error } = await authClient.twoFactor.disable({ password });
    if (error) return setMessage({ error: true, text: error.message ?? "Couldn't turn it off" });
    setMessage({ error: false, text: "Two-factor authentication is off." });
    router.refresh();
  }

  return (
    <Section title="Two-factor authentication">
      {required && !enabled && (
        <p className="mb-2 text-amber-700 dark:text-amber-300">Admin settings stay locked until this is on.</p>
      )}
      {enabled ? (
        <form onSubmit={disable} className="flex flex-wrap items-center gap-2">
          <span>On: sign-in asks for a code from your authenticator app.</span>
          <input name="password" type="password" placeholder="Password" required className={input} />
          <Button type="submit">Turn off</Button>
        </form>
      ) : setup ? (
        <div className="space-y-3">
          <p>Scan this with an authenticator app, then enter the code it shows.</p>
          {/* A data: URL (the CSP allows it), so the secret never leaves the browser; next/image adds nothing here. */}
          {/* biome-ignore lint/performance/noImgElement: a generated data: URL, not an asset to optimize */}
          <img src={setup.qr} alt="QR code for your authenticator app" width={180} height={180} className="bg-white" />
          <details>
            <summary className="cursor-pointer text-neutral-500">Can't scan? Enter the setup key</summary>
            <code className="break-all text-xs">{new URL(setup.uri).searchParams.get("secret")}</code>
          </details>
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950">
            <p className="text-amber-900 dark:text-amber-200">
              Backup codes, each usable once if you lose the app. They won't be shown again.
            </p>
            <code className="mt-2 block font-mono text-xs whitespace-pre-wrap">{setup.backupCodes.join("\n")}</code>
          </div>
          <form onSubmit={confirm} className="flex flex-wrap items-center gap-2">
            <input
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123456"
              required
              className={input}
            />
            <Button type="submit" variant="primary">
              Confirm
            </Button>
          </form>
        </div>
      ) : (
        <form onSubmit={start} className="flex flex-wrap items-center gap-2">
          <span>Off.</span>
          <input name="password" type="password" placeholder="Password" required className={input} />
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
    const { error } = await authClient.revokeOtherSessions();
    if (error) return setMessage({ error: true, text: error.message ?? "Couldn't sign them out" });
    setMessage({ error: false, text: "Signed out everywhere else." });
    await load();
  }

  return (
    <Section title="Sessions" actions={<Button onClick={() => void revokeOthers()}>Sign out other sessions</Button>}>
      <ul className="divide-y divide-neutral-100 dark:divide-neutral-900">
        {sessions.map((s) => (
          <li key={s.id} className="flex items-center justify-between gap-2 py-2">
            <span className="text-xs">
              <span className="font-medium">
                {s.token === current ? "This browser" : (s.userAgent ?? "Unknown client").slice(0, 80)}
              </span>
              <span className="text-neutral-500">
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
        <input
          name="current"
          type="password"
          placeholder="Current password"
          autoComplete="current-password"
          required
          className={input}
        />
        <input
          name="new"
          type="password"
          placeholder="New password (12+ characters)"
          autoComplete="new-password"
          minLength={12}
          required
          className={input}
        />
        <input
          name="repeat"
          type="password"
          placeholder="Repeat it"
          autoComplete="new-password"
          minLength={12}
          required
          className={input}
        />
        <Button type="submit">Change</Button>
      </form>
      <Note message={message} />
    </Section>
  );
}

export function SecurityView(props: { email: string; twoFactorEnabled: boolean; twoFactorRequired: boolean }) {
  return (
    <>
      <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">Signed in as {props.email}.</p>
      <TwoFactorSection enabled={props.twoFactorEnabled} required={props.twoFactorRequired} />
      <SessionsSection />
      <PasswordSection />
    </>
  );
}
