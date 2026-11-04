"use client";

import type { SystemStatusResponse } from "@ai-triage/contracts";
import { TriangleAlert } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useState } from "react";
import { browserApi } from "@/lib/api";
import { usePolling } from "@/lib/use-polling";

/** What stops documents from being processed right now, on every page. */
export function SystemBanners({ isAdmin }: { isAdmin: boolean }) {
  const [status, setStatus] = useState<SystemStatusResponse | null>(null);
  usePolling(async (signal) => {
    const res = await browserApi.system.status.$get(undefined, { init: { signal } });
    if (res.ok) setStatus(await res.json());
  }, 30_000);
  if (!status) return null;
  return (
    <>
      {status.workersRunning === 0 && (
        <Banner>
          No worker is running, so documents won't be processed. Start one: <code>pnpm dev</code> locally, or check the
          worker container (docs/troubleshooting.md).
        </Banner>
      )}
      {status.budgetExhausted && (
        <Banner>
          Today's LLM budget is used up
          {status.budgetWaiting > 0
            ? `: ${status.budgetWaiting} document${status.budgetWaiting === 1 ? " waits" : "s wait"} for a retry`
            : ""}
          .{" "}
          {isAdmin ? (
            <Link href="/settings#budget" className="font-medium underline underline-offset-2">
              Raise the budget
            </Link>
          ) : (
            "An admin can raise it."
          )}
        </Banner>
      )}
    </>
  );
}

function Banner({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 border-b border-warning/25 bg-warning-muted px-4 py-2 text-sm md:px-6">
      <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
      <p className="min-w-0">{children}</p>
    </div>
  );
}
