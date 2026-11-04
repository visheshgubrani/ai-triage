"use client";

import { Bot, KeyRound, type LucideIcon, Monitor, Smartphone, SquareTerminal } from "lucide-react";
import { useRouter } from "next/navigation";
import QRCode from "qrcode";
import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from "react";
import { Pill } from "@/components/badge";
import { Button } from "@/components/button";
import { useConfirm } from "@/components/confirm-dialog";
import { Field } from "@/components/field";
import { GoogleMark } from "@/components/google-button";
import { LoadingBlock } from "@/components/loading";
import { FormMessage, type Message, Notice } from "@/components/notice";
import { CopyButton, CopyField } from "@/components/secret-reveal";
import { Section } from "@/components/section";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";
import { ago } from "@/lib/format";
import { authErrorText, googleEnabled } from "@/lib/google";
import { type AgentKind, describeAgent } from "@/lib/user-agent";

/** A section's result line, inside its padding (the sections here are flush lists). */
function Note({ message }: { message: Message | null }) {
  if (!message) return null;
  return (
    <div className="border-t px-4 py-3">
      <FormMessage message={message} className="mt-0" />
    </div>
  );
}

/** The square at the start of a row: what kind of thing it is. */
function RowIcon({ children }: { children: ReactNode }) {
  return (
    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground [&_svg]:size-4">
      {children}
    </span>
  );
}

function Step({ n, title, hint, children }: { n: number; title: string; hint: string; children: ReactNode }) {
  return (
    <li className="flex flex-col gap-3 rounded-lg border p-4">
      <div className="flex gap-2.5">
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-accent text-xs font-semibold text-accent-foreground">
          {n}
        </span>
        <div>
          <p className="font-medium">{title}</p>
          <p className="mt-0.5 text-muted-foreground">{hint}</p>
        </div>
      </div>
      {children}
    </li>
  );
}

/**
 * TOTP: turn on (scan, keep the backup codes, confirm a code) or off. A user with a password
 * confirms with it, in place; a Google-only user needs to have signed in within the last few
 * minutes instead (the api refuses with `recent_sign_in_required` otherwise).
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
  const [asking, setAsking] = useState(false);
  const [setup, setSetup] = useState<{ qr: string; uri: string; backupCodes: string[] } | null>(null);
  const [message, setMessage] = useState<Message | null>(null);

  async function start(password?: string) {
    const { data, error } = await authClient.twoFactor.enable(password ? { password } : {});
    if (error || !data || data.method !== "totp") {
      return setMessage({
        error: true,
        text: error ? authErrorText(error, "Couldn't start setup") : "Couldn't start setup",
      });
    }
    const qr = `data:image/svg+xml;utf8,${encodeURIComponent(await QRCode.toString(data.totpURI, { type: "svg", margin: 1 }))}`;
    setSetup({ qr, uri: data.totpURI, backupCodes: data.backupCodes });
    setAsking(false);
    setMessage(null);
  }

  async function stop(password?: string) {
    const { error } = await authClient.twoFactor.disable(password ? { password } : {});
    if (error) return setMessage({ error: true, text: authErrorText(error, "Couldn't turn it off") });
    setAsking(false);
    setMessage({ error: false, text: "Two-factor authentication is off." });
    router.refresh();
  }

  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = String(new FormData(event.currentTarget).get("code")).trim();
    const { error } = await authClient.twoFactor.verifyTotp({ code });
    if (error) return setMessage({ error: true, text: error.message ?? "That code didn't work" });
    setSetup(null);
    setMessage({ error: false, text: "Two-factor authentication is on." });
    router.refresh();
  }

  /** With a password, the password field is the second thought; without one, a dialog is. */
  async function act() {
    if (hasPassword) return setAsking(true);
    if (!enabled) return start();
    if (
      await ask({
        title: "Turn off two-factor authentication?",
        body: "Google alone will sign you in.",
        confirm: "Turn off",
        destructive: true,
      })
    )
      await stop();
  }

  const status = enabled ? (
    <Pill tone="success" dot>
      On
    </Pill>
  ) : required ? (
    <Pill tone="warning" dot>
      Required
    </Pill>
  ) : (
    <Pill dot>Off</Pill>
  );

  return (
    <Section flush title="Two-factor authentication" actions={status}>
      {required && !enabled && (
        <div className="px-4 pt-4">
          <Notice tone="warning">Admin settings stay locked until this is on.</Notice>
        </div>
      )}
      {setup ? (
        <div className="p-4">
          <ol className="grid gap-3 lg:grid-cols-3">
            <Step
              n={1}
              title="Scan the code"
              hint="With an authenticator app such as 1Password or Google Authenticator."
            >
              {/* A data: URL (the CSP allows it), so the secret never leaves the browser; next/image adds nothing here. */}
              {/* biome-ignore lint/performance/noImgElement: a generated data: URL, not an asset to optimize */}
              <img
                src={setup.qr}
                alt="QR code for your authenticator app"
                width={160}
                height={160}
                className="rounded-lg bg-white p-2"
              />
              <Collapsible>
                <CollapsibleTrigger className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
                  Can't scan it? Enter a key instead
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <CopyField value={new URL(setup.uri).searchParams.get("secret") ?? ""} className="mt-2" />
                </CollapsibleContent>
              </Collapsible>
            </Step>
            <Step
              n={2}
              title="Save the backup codes"
              hint="Each works once if you lose your phone. They won't be shown again."
            >
              <ul className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg bg-muted px-3 py-2.5 font-mono text-xs tabular-nums">
                {setup.backupCodes.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
              <CopyButton value={setup.backupCodes.join("\n")} label="Copy codes" className="self-start" />
            </Step>
            <Step n={3} title="Enter a code" hint="The six digits your app shows now.">
              <form onSubmit={verify} className="flex gap-2">
                <Input
                  name="code"
                  aria-label="Code from your authenticator app"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="123456"
                  required
                  className="font-mono tabular-nums"
                />
                <Button type="submit" variant="primary">
                  Turn on
                </Button>
              </form>
              <Button variant="ghost" size="sm" className="self-start" onClick={() => setSetup(null)}>
                Cancel setup
              </Button>
            </Step>
          </ol>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-4">
          <RowIcon>
            <Smartphone />
          </RowIcon>
          <div className="min-w-0 flex-1 basis-56">
            <p className="font-medium">Authenticator app</p>
            <p className="text-muted-foreground">
              {enabled ? "Sign-in asks for a code from your app." : "Ask for a code from your phone at every sign-in."}
            </p>
          </div>
          {asking ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const password = String(new FormData(e.currentTarget).get("password"));
                void (enabled ? stop(password) : start(password));
              }}
              className="flex w-full flex-wrap items-center gap-2 sm:w-auto"
            >
              <Input
                name="password"
                type="password"
                aria-label="Your password"
                placeholder="Your password"
                autoComplete="current-password"
                required
                autoFocus
                className="w-full sm:w-48"
              />
              <Button variant="ghost" onClick={() => setAsking(false)}>
                Cancel
              </Button>
              <Button type="submit" variant={enabled ? "danger" : "primary"}>
                {enabled ? "Turn off" : "Continue"}
              </Button>
            </form>
          ) : enabled ? (
            <Button onClick={() => void act()}>Turn off</Button>
          ) : (
            <Button variant="primary" onClick={() => void act()}>
              Set up
            </Button>
          )}
        </div>
      )}
      <Note message={message} />
    </Section>
  );
}

/** Changing the password signs out every other session. */
function PasswordForm({ onDone }: { onDone: (message: Message | null) => void }) {
  const [error, setError] = useState<string | null>(null);

  async function change(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const newPassword = String(data.get("new"));
    if (newPassword !== String(data.get("repeat"))) return setError("The new passwords differ.");
    const { error } = await authClient.changePassword({
      currentPassword: String(data.get("current")),
      newPassword,
      revokeOtherSessions: true,
    });
    if (error) return setError(error.message ?? "Couldn't change the password");
    form.reset();
    onDone({ error: false, text: "Password changed; your other sessions were signed out." });
  }

  return (
    <form onSubmit={change} className="mt-4 grid max-w-sm gap-3 sm:ml-13">
      <Field label="Current password">
        <Input name="current" type="password" autoComplete="current-password" required />
      </Field>
      <Field label="New password" hint="At least 12 characters.">
        <Input name="new" type="password" autoComplete="new-password" minLength={12} required />
      </Field>
      <Field label="Repeat the new password">
        <Input name="repeat" type="password" autoComplete="new-password" minLength={12} required />
      </Field>
      <FormMessage message={error ? { error: true, text: error } : null} className="mt-0" />
      <div className="flex gap-2">
        <Button type="submit" variant="primary">
          Change password
        </Button>
        <Button variant="ghost" onClick={() => onDone(null)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

type Account = { id: string; providerId: string };

/** How this account signs in: a password (changed here), Google (linked or unlinked here), or both. */
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
  const [changing, setChanging] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
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

  return (
    <Section flush title="Sign-in methods">
      <ul className="divide-y divide-border">
        <li className="px-4 py-4">
          <Collapsible open={changing} onOpenChange={setChanging}>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
              <RowIcon>
                <KeyRound />
              </RowIcon>
              <div className="min-w-0 flex-1 basis-56">
                <p className="font-medium">Password</p>
                <p className="text-muted-foreground">{hasPassword ? "Set" : "Not set: you sign in with Google"}</p>
              </div>
              {hasPassword && !changing && (
                <CollapsibleTrigger asChild>
                  <Button onClick={() => setMessage(null)}>Change password</Button>
                </CollapsibleTrigger>
              )}
            </div>
            <CollapsibleContent>
              <PasswordForm
                onDone={(result) => {
                  setChanging(false);
                  setMessage(result);
                }}
              />
            </CollapsibleContent>
          </Collapsible>
        </li>
        {(google || linked) && (
          <li className="flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-4">
            <RowIcon>
              <GoogleMark />
            </RowIcon>
            <div className="min-w-0 flex-1 basis-56">
              <p className="font-medium">Google</p>
              <p className="text-muted-foreground">{linked ? "Linked" : "Not linked"}</p>
            </div>
            {linked ? (
              // Better Auth refuses to unlink the last way to sign in.
              <Button
                variant="ghost"
                onClick={() => void unlink(linked.id)}
                disabled={!hasPassword}
                title={hasPassword ? undefined : "Set a password first: it's your only other way in"}
              >
                Unlink
              </Button>
            ) : (
              <Button onClick={() => void link()}>Link Google account</Button>
            )}
          </li>
        )}
      </ul>
      <Note message={message} />
    </Section>
  );
}

type SessionRow = { id: string; token: string; ipAddress?: string | null; userAgent?: string | null; createdAt: Date };

const AGENT_ICONS: Record<AgentKind, LucideIcon> = {
  desktop: Monitor,
  mobile: Smartphone,
  cli: SquareTerminal,
  headless: Bot,
};

/** How many sessions show before "Show all". */
const FIRST_SESSIONS = 5;

/** Where this account is signed in, this browser first, with sign-out. */
function SessionsSection() {
  const confirm = useConfirm();
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);

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

  const sorted = [...(sessions ?? [])].sort(
    (a, b) =>
      Number(b.token === current) - Number(a.token === current) ||
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
  const others = sorted.filter((s) => s.token !== current).length;
  const shown = all ? sorted : sorted.slice(0, FIRST_SESSIONS);

  return (
    <Section
      flush
      title={
        <>
          Sessions <span className="font-normal text-muted-foreground tabular-nums">{sorted.length || ""}</span>
        </>
      }
      description="Where you're signed in. Sign out anything you don't recognize."
      actions={others > 0 && <Button onClick={() => void revokeOthers()}>Sign out other sessions</Button>}
      footer={
        sorted.length > FIRST_SESSIONS && (
          <Button variant="ghost" size="sm" className="mr-auto" onClick={() => setAll((a) => !a)}>
            {all ? "Show fewer" : `Show all ${sorted.length}`}
          </Button>
        )
      }
    >
      {sessions === null ? (
        <div className="p-4">
          <LoadingBlock />
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {shown.map((s) => {
            const agent = describeAgent(s.userAgent);
            const Icon = AGENT_ICONS[agent.kind];
            const here = s.token === current;
            return (
              <li key={s.id} className="flex items-center gap-4 px-4 py-3">
                <RowIcon>
                  <Icon />
                </RowIcon>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 font-medium" title={s.userAgent ?? undefined}>
                    {agent.label}
                    {here && (
                      <Pill tone="success" dot>
                        This browser
                      </Pill>
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {[s.ipAddress || null, `Signed in ${ago(new Date(s.createdAt).toISOString())}`]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
                {!here && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground hover:text-danger"
                    onClick={() => void revoke(s.token)}
                  >
                    Sign out
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <Note message={message} />
    </Section>
  );
}

export function SecurityView(props: {
  name: string;
  email: string;
  role: string;
  twoFactorEnabled: boolean;
  twoFactorRequired: boolean;
}) {
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

  const hasPassword = accounts?.some((a) => a.providerId === "credential") ?? false;
  const initial = (props.name || props.email).trim().charAt(0).toUpperCase();
  return (
    <>
      <Section>
        <div className="flex items-center gap-3">
          <Avatar size="lg">
            <AvatarFallback className="bg-accent font-medium text-accent-foreground">{initial}</AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <p className="truncate font-medium">{props.name || props.email}</p>
            {props.name && <p className="truncate text-muted-foreground">{props.email}</p>}
          </div>
          <Pill tone="accent" className="capitalize">
            {props.role}
          </Pill>
        </div>
      </Section>
      {linkError && (
        <Notice tone="danger" role="alert" className="mt-6">
          {linkError}
        </Notice>
      )}
      {accounts ? (
        <>
          <TwoFactorSection
            enabled={props.twoFactorEnabled}
            required={props.twoFactorRequired}
            hasPassword={hasPassword}
          />
          <SignInMethodsSection accounts={accounts} google={google} onChange={load} />
        </>
      ) : (
        <div className="mt-6">
          <LoadingBlock />
        </div>
      )}
      <SessionsSection />
    </>
  );
}
