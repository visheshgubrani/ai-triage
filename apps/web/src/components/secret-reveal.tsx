"use client";

import { Check, Copy } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/button";
import { Notice } from "@/components/notice";

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      onClick={async () => {
        await navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
    >
      {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      {copied ? "Copied" : label}
    </Button>
  );
}

/** Something shown once (an API key, a signing secret, an invite link): the value and a Copy button. */
export function SecretReveal({ value, children }: { value: string; children: ReactNode }) {
  return (
    <Notice tone="warning" className="mt-3">
      <p>{children}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <code className="min-w-0 flex-1 rounded-md bg-card px-2 py-1.5 font-mono text-xs break-all ring-1 ring-foreground/10">
          {value}
        </code>
        <CopyButton value={value} />
      </div>
    </Notice>
  );
}
