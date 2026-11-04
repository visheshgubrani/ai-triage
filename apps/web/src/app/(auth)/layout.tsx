import type { ReactNode } from "react";
import { LogoMark } from "@/components/logo";

/** Sign-in, first-run setup and invitations: a card in the middle of the page, no navigation. */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-6 p-4 py-10">
      <div className="flex items-center gap-2.5 text-base font-semibold tracking-tight">
        <LogoMark />
        AI Triage
      </div>
      <div className="w-full max-w-md rounded-xl bg-card p-6 text-card-foreground shadow-sm ring-1 ring-foreground/8">
        {children}
      </div>
    </main>
  );
}
