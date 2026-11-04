import Link from "next/link";
import type { ReactNode } from "react";
import { getMe } from "@/components/header";

const PAGES = [
  { href: "/settings", label: "Settings" },
  { href: "/settings/pipeline", label: "Pipeline" },
  { href: "/settings/members", label: "Members" },
  { href: "/settings/mailboxes", label: "Mailboxes" },
  { href: "/settings/health", label: "System health" },
] as const;

/**
 * The frame of the admin settings pages: their navigation, then the page only for an admin who has
 * 2FA where the deployment requires it (the API enforces both; this only explains them).
 */
export async function AdminSettings({
  title,
  current,
  children,
}: {
  title: string;
  current: string;
  children: ReactNode;
}) {
  const me = await getMe();
  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {me && (
          <nav className="flex gap-4 text-sm">
            {me.role === "admin" &&
              PAGES.filter((p) => p.href !== current).map((p) => (
                <Link key={p.href} href={p.href} className="underline">
                  {p.label}
                </Link>
              ))}
            <Link href="/settings/security" className="underline">
              Your account security
            </Link>
          </nav>
        )}
      </div>
      {me?.role !== "admin" ? (
        <p className="mt-6 text-sm text-red-600">Only a tenant admin can change settings.</p>
      ) : me.twoFactorRequired ? (
        <p className="mt-6 text-sm text-amber-700 dark:text-amber-300">
          Admin settings need two-factor authentication.{" "}
          <Link href="/settings/security" className="underline">
            Turn it on
          </Link>{" "}
          to continue.
        </p>
      ) : (
        children
      )}
    </main>
  );
}
