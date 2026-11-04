import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** A control and its label (the label wraps the control, so no id is needed), plus an optional hint. */
export function Field({
  label,
  hint,
  className,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("grid gap-1.5", className)}>
      {/* biome-ignore lint/a11y/noLabelWithoutControl: the control is `children` */}
      <label className="grid gap-1.5">
        <span className="text-sm font-medium">{label}</span>
        {children}
      </label>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** A checkbox or switch and what it does, side by side. */
export function ToggleRow({
  label,
  detail,
  control,
  className,
}: {
  label: ReactNode;
  detail?: ReactNode;
  control: ReactNode;
  className?: string;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control comes in as a prop
    <label className={cn("flex cursor-pointer items-start gap-2.5", className)}>
      <span className="mt-0.5 flex shrink-0">{control}</span>
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        {detail && <span className="block text-sm text-muted-foreground">{detail}</span>}
      </span>
    </label>
  );
}
