import type { LucideIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** One number and what it means. With `href` the whole card is a link. */
export function StatCard({
  label,
  value,
  detail,
  icon: Icon,
  href,
  warn = false,
  className,
}: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  icon?: LucideIcon;
  href?: string;
  /** Needs attention: the value turns amber (the label says why). */
  warn?: boolean;
  className?: string;
}) {
  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        {Icon && <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground/70" />}
      </div>
      <div className={cn("mt-1.5 text-xl font-semibold tracking-tight tabular-nums", warn && "text-warning")}>
        {value}
      </div>
      {detail && <div className="mt-0.5 text-xs text-muted-foreground tabular-nums">{detail}</div>}
    </>
  );
  const frame = cn("block rounded-xl bg-card p-4 shadow-xs ring-1 ring-foreground/8", className);
  return href ? (
    <Link href={href} className={cn(frame, "transition-colors hover:bg-muted/60")}>
      {body}
    </Link>
  ) : (
    <div className={frame}>{body}</div>
  );
}
