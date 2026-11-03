import type { ButtonHTMLAttributes } from "react";

const VARIANTS = {
  primary:
    "bg-neutral-900 text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300",
  secondary: "border border-neutral-300 hover:bg-neutral-100 dark:border-neutral-700 dark:hover:bg-neutral-800",
  danger:
    "border border-red-300 text-red-700 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950",
} as const;

export function Button({
  variant = "secondary",
  shortcut,
  className = "",
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof VARIANTS; shortcut?: string }) {
  return (
    <button
      type="button"
      {...props}
      className={`inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 ${VARIANTS[variant]} ${className}`}
    >
      {children}
      {shortcut && (
        <kbd className="rounded border border-current/30 px-1 font-mono text-[10px] opacity-70">{shortcut}</kbd>
      )}
    </button>
  );
}
