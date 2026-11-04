import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

/** A titled card. Always a <section>: mailbox cards and their e2e locator rely on that. */
export function Section({
  title,
  description,
  children,
  actions,
  className,
  ...props
}: Omit<ComponentProps<"section">, "title"> & { title?: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <section
      {...props}
      className={cn("mt-6 rounded-xl bg-card text-card-foreground shadow-xs ring-1 ring-foreground/8", className)}
    >
      {(title || actions) && (
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-4 pt-4">
          <div className="min-w-0">
            {title && <h2 className="text-sm font-semibold tracking-tight">{title}</h2>}
            {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={cn("p-4 text-sm", (title || actions) && "pt-3")}>{children}</div>
    </section>
  );
}
