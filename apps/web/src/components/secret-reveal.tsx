"use client";

import { Check, Copy } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/button";
import { Notice } from "@/components/notice";
import { cn } from "@/lib/utils";

export function CopyButton({
  value,
  label = "Copy",
  variant = "secondary",
  className,
}: {
  value: string;
  label?: string;
  variant?: "secondary" | "ghost";
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant={variant}
      className={className}
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

/** A value to copy (an address, a setup key): read-only, in a field's frame, with Copy inside it. */
export function CopyField({ value, className }: { value: string; className?: string }) {
  return (
    <div
      className={cn(
        "flex h-8 min-w-0 items-center gap-1 rounded-lg border border-input bg-muted/40 pr-0.5 pl-2.5 dark:bg-input/20",
        className,
      )}
    >
      <code className="min-w-0 flex-1 truncate text-xs" title={value}>
        {value}
      </code>
      <CopyButton value={value} variant="ghost" className="h-6" />
    </div>
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
