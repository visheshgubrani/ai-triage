import type { ReactNode } from "react";
import { InfoTip } from "@/components/info-tip";
import { cn } from "@/lib/utils";

/** Rows of settings in a `flush` Section: divided, running the full width of the card. */
export function SettingRows({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("divide-y divide-border", className)}>{children}</div>;
}

/**
 * One setting: what it is on the left, its control on the right (stacked on narrow screens).
 * `htmlFor` makes the label name the control; `info` is reference detail behind an icon.
 */
export function SettingRow({
  label,
  hint,
  info,
  htmlFor,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  info?: ReactNode;
  htmlFor?: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "grid gap-x-8 gap-y-2.5 px-4 py-3.5 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] md:items-center",
        className,
      )}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 font-medium">
          {htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <span>{label}</span>}
          {info && (
            <InfoTip label={`About ${typeof label === "string" ? label.toLowerCase() : "this"}`}>{info}</InfoTip>
          )}
        </div>
        {hint && <p className="mt-0.5 text-muted-foreground">{hint}</p>}
      </div>
      {children && <div className="flex min-w-0 flex-wrap items-center gap-2 md:justify-end">{children}</div>}
    </div>
  );
}
