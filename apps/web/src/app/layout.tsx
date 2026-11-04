import { APP_VERSION } from "@ai-triage/core";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Header } from "@/components/header";
import "./globals.css";

// Every page renders per request: the CSP nonce (src/proxy.ts) is applied during rendering, and a
// statically rendered page's scripts would carry none and be blocked.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "AI Triage",
  description: "LLM triage inbox with a human approval queue and evals",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-white text-neutral-900 antialiased dark:bg-neutral-950 dark:text-neutral-100">
        <Header />
        {children}
        <footer className="mx-auto max-w-7xl px-4 py-8 text-xs text-neutral-400">
          ai-triage {APP_VERSION} ·{" "}
          <a className="underline-offset-2 hover:underline" href="https://github.com/visheshgubrani/ai-triage">
            source
          </a>
        </footer>
      </body>
    </html>
  );
}
