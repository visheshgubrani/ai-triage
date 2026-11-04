import { CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

const TONES = {
  info: { icon: Info, frame: "border-border bg-muted/50", ink: "text-muted-foreground" },
  success: { icon: CircleCheck, frame: "border-success/25 bg-success-muted", ink: "text-success" },
  warning: { icon: TriangleAlert, frame: "border-warning/25 bg-warning-muted", ink: "text-warning" },
  danger: { icon: CircleAlert, frame: "border-danger/25 bg-danger-muted", ink: "text-danger" },
} as const;

/**
 * A callout. It has no live-region role unless given one: e2e specs (and screen readers) count on a
 * page having only the `alert`s and `status`es that really announce something.
 */
export function Notice({
  tone = "info",
  role,
  action,
  className,
  children,
}: {
  tone?: keyof typeof TONES;
  role?: "alert" | "status";
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const { icon: Icon, frame, ink } = TONES[tone];
  return (
    <div role={role} className={cn("flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm", frame, className)}>
      <Icon aria-hidden="true" className={cn("mt-0.5 size-4 shrink-0", ink)} />
      <div className="min-w-0 flex-1 break-words">{children}</div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

/** The result of an action, shown where it was taken. */
export type Message = { error: boolean; text: string };

/** The result of an action that changed what the page shows: a callout above it, not a line under a form. */
export function ResultNotice({ message, className }: { message: Message | null; className?: string }) {
  if (!message) return null;
  return (
    <Notice
      tone={message.error ? "danger" : "success"}
      role={message.error ? "alert" : "status"}
      className={cn("mt-6", className)}
    >
      {message.text}
    </Notice>
  );
}

export function FormMessage({ message, className }: { message: Message | null; className?: string }) {
  if (!message) return null;
  return (
    <p
      role={message.error ? "alert" : "status"}
      className={cn("mt-3 text-sm", message.error ? "text-danger" : "text-muted-foreground", className)}
    >
      {message.text}
    </p>
  );
}
