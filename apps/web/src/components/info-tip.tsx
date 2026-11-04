"use client";

import { Info } from "lucide-react";
import type { ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** Reference detail that would crowd the page (header names, formats), behind a small icon. */
export function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground/70 transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <Info aria-hidden="true" className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="block font-normal">{children}</TooltipContent>
    </Tooltip>
  );
}
