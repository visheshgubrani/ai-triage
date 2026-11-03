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
      </body>
    </html>
  );
}
