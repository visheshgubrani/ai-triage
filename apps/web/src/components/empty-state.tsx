import type { LucideIcon } from "lucide-react";
import { Inbox } from "lucide-react";
import type { ReactNode } from "react";

/** What to show instead of an empty list or a page that can't render: what happened, and what to do. */
export function EmptyState({
  icon: Icon = Inbox,
  title,
  description,
  action,
  heading = false,
}: {
  icon?: LucideIcon;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  /** The title is the page's heading (a page that is only this state). */
  heading?: boolean;
}) {
  const Title = heading ? "h1" : "p";
  return (
    <div className="flex flex-col items-center px-4 py-10 text-center">
      <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Icon aria-hidden="true" className="size-5" />
      </span>
      <Title className="mt-3 text-sm font-medium">{title}</Title>
      {description && <p className="mt-1 max-w-md text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-4 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}
