import { GeistMono } from "geist/font/mono";
import { GeistSans } from "geist/font/sans";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { ConfirmProvider } from "@/components/confirm-dialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import { parseTheme, THEME_COOKIE, themeClass } from "@/lib/theme";
import { cn } from "@/lib/utils";
import "./globals.css";

// Every page renders per request: the CSP nonce (src/proxy.ts) is applied during rendering, and a
// statically rendered page's scripts would carry none and be blocked.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { default: "AI Triage", template: "%s · AI Triage" },
  description: "LLM triage inbox with a human approval queue and evals",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  return (
    <html lang="en" className={cn(GeistSans.variable, GeistMono.variable, themeClass(theme))}>
      <body className="min-h-svh">
        <TooltipProvider>
          <ConfirmProvider>{children}</ConfirmProvider>
        </TooltipProvider>
      </body>
    </html>
  );
}
