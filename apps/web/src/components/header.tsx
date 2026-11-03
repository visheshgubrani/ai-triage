import { MeResponse } from "@ai-triage/contracts";
import { cookies } from "next/headers";
import Link from "next/link";
import { api } from "@/lib/api";
import { SignOutButton } from "./sign-out-button";

/**
 * The signed-in user, read through the API with the browser's cookie (server components only).
 * `noWorkspace`: signed in, but not a member of any tenant (yet, or any more).
 */
export async function getSessionState(): Promise<{ me: MeResponse | null; noWorkspace: boolean }> {
  const cookie = (await cookies()).toString();
  try {
    const res = await api.me.$get(undefined, { headers: { cookie } });
    // 403 comes from the tenant middleware, which the RPC types don't list.
    if (!res.ok) return { me: null, noWorkspace: (res.status as number) === 403 };
    return { me: MeResponse.parse(await res.json()), noWorkspace: false };
  } catch {
    return { me: null, noWorkspace: false };
  }
}

export async function getMe(): Promise<MeResponse | null> {
  return (await getSessionState()).me;
}

export async function Header() {
  const { me, noWorkspace } = await getSessionState();
  const links = [
    { href: "/review", label: "Review" },
    { href: "/documents", label: "Documents" },
    { href: "/evals", label: "Evals" },
    ...(me?.role === "admin" ? [{ href: "/settings", label: "Settings" }] : []),
  ];
  return (
    <header className="border-b border-neutral-200 dark:border-neutral-800">
      <nav className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 text-sm">
        <Link href="/" className="font-semibold tracking-tight">
          AI Triage
        </Link>
        {me &&
          links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="text-neutral-600 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100"
            >
              {l.label}
            </Link>
          ))}
        <span className="ml-auto flex items-center gap-3 text-neutral-500">
          {me ? (
            <>
              <span>
                {me.user.email} · {me.tenant.name} · {me.role}
              </span>
              <SignOutButton />
            </>
          ) : noWorkspace ? (
            <SignOutButton />
          ) : (
            <Link href="/sign-in" className="underline underline-offset-2">
              Sign in
            </Link>
          )}
        </span>
      </nav>
    </header>
  );
}
