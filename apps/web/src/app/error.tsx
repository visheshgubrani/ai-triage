"use client";

import { TriangleAlert } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/button";
import { EmptyState } from "@/components/empty-state";

/** Any page that failed to render: what to try, and the digest to look up in the web's log. */
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="flex min-h-[60svh] items-center justify-center p-4">
      <EmptyState
        heading
        icon={TriangleAlert}
        title="Something went wrong"
        description={
          <>
            This page couldn't load. Try again; if it keeps failing, the api may be down (an admin can check Settings →
            System health, or run <code>pnpm preflight</code>).
            {error.digest && <span className="mt-2 block font-mono text-xs">Reference: {error.digest}</span>}
          </>
        }
        action={
          <>
            <Button variant="primary" onClick={reset}>
              Try again
            </Button>
            <Button asChild>
              <Link href="/">Home</Link>
            </Button>
          </>
        }
      />
    </main>
  );
}
