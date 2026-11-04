"use client";

import Link from "next/link";

/** Any page that failed to render: what to try, and the digest to look up in the web's log. */
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="mx-auto max-w-xl px-4 py-16">
      <h1 className="text-2xl font-semibold tracking-tight">Something went wrong</h1>
      <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
        This page couldn't load. Try again; if it keeps failing, the api may be down (an admin can check Settings →
        System health, or run <code>pnpm preflight</code>).
      </p>
      {error.digest && <p className="mt-2 font-mono text-xs text-neutral-500">Reference: {error.digest}</p>}
      <div className="mt-6 flex gap-4 text-sm">
        <button type="button" onClick={reset} className="underline underline-offset-2">
          Try again
        </button>
        <Link href="/" className="underline underline-offset-2">
          Home
        </Link>
      </div>
    </main>
  );
}
