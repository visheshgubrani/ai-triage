import { HealthResponse } from "@ai-triage/contracts";
import Link from "next/link";
import { getMe } from "@/components/header";
import { SignOutButton } from "@/components/sign-out-button";
import { api } from "@/lib/api";

export const dynamic = "force-dynamic";

async function getHealth(): Promise<HealthResponse | null> {
  try {
    const res = await api.health.$get();
    return HealthResponse.parse(await res.json());
  } catch {
    return null;
  }
}

const sections = [
  { name: "Documents", detail: "Incoming documents and their routing decisions", href: "/documents" },
  {
    name: "Review queue",
    detail: "Items awaiting a human: approve, edit, reclassify, reject or retry",
    href: "/review",
  },
  { name: "Evals", detail: "Accuracy per category, cost and latency per request (phase 4)" },
] as { name: string; detail: string; href?: string }[];

export default async function Home() {
  const [health, me] = await Promise.all([getHealth(), getMe()]);
  return (
    <main className="mx-auto max-w-3xl px-4 py-16">
      <h1 className="text-3xl font-semibold tracking-tight">AI Triage</h1>
      <p className="mt-2 text-neutral-600 dark:text-neutral-400">
        Documents are classified and extracted, uncertain ones wait for a reviewer, and approvals go out as signed
        webhooks. Evals come next.
      </p>

      <section className="mt-8 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="text-sm font-medium text-neutral-500">Session</h2>
        {me ? (
          <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm">
              Signed in as <span className="font-medium">{me.user.email}</span> · tenant{" "}
              <span className="font-medium">{me.tenant.name}</span> · {me.role}
            </p>
            <SignOutButton />
          </div>
        ) : (
          <p className="mt-1 text-sm">
            <Link href="/sign-in" className="underline underline-offset-2">
              Sign in
            </Link>{" "}
            to see your tenant.
          </p>
        )}
      </section>

      <section className="mt-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="text-sm font-medium text-neutral-500">API health</h2>
        {health ? (
          <p className="mt-1 font-mono text-sm">
            status: {health.status} · db: {health.db}
          </p>
        ) : (
          <p className="mt-1 font-mono text-sm text-red-600">API unreachable</p>
        )}
      </section>

      <ul className="mt-8 grid gap-3 sm:grid-cols-3">
        {sections.map((s) => (
          <li key={s.name} className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
            {s.href ? (
              <Link href={s.href} className="font-medium underline underline-offset-2">
                {s.name}
              </Link>
            ) : (
              <p className="font-medium">{s.name}</p>
            )}
            <p className="mt-1 text-sm text-neutral-500">{s.detail}</p>
          </li>
        ))}
      </ul>
    </main>
  );
}
