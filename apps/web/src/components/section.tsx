import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A titled card. Always a <section>: mailbox cards and their e2e locator rely on that.
 * `flush` drops the body's padding for a list whose rows run edge to edge (under a divider), and
 * `footer` is a bar along the bottom: a `SectionHint` or result on the left, the actions on the right.
 */
export function Section({
  title,
  description,
  children,
  actions,
  footer,
  flush = false,
  className,
  ...props
}: Omit<ComponentProps<"section">, "title"> & {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  flush?: boolean;
}) {
  const header = Boolean(title || actions);
  return (
    <section
      {...props}
      className={cn("mt-6 rounded-xl bg-card text-card-foreground shadow-xs ring-1 ring-foreground/8", className)}
    >
      {header && (
        <div className={cn("flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-4 pt-4", flush && "pb-3")}>
          <div className="min-w-0">
            {title && <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight">{title}</h2>}
            {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={cn("text-sm", flush ? header && "border-t" : cn("p-4", header && "pt-3"))}>{children}</div>
      {footer && (
        <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2 rounded-b-xl border-t bg-muted/40 px-4 py-2.5 text-sm">
          {footer}
        </div>
      )}
    </section>
  );
}

/** The left side of a Section footer: what the actions do, in a few words. */
export function SectionHint({ children }: { children: ReactNode }) {
  return <p className="mr-auto text-muted-foreground">{children}</p>;
}
