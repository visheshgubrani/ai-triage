import type { ReactNode } from "react";

export function Section({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="mt-6 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-neutral-500">{title}</h2>
        {actions}
      </div>
      <div className="mt-2 text-sm">{children}</div>
    </section>
  );
}
