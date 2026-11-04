"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { isActive, SETTINGS_NAV } from "@/components/shell/nav";
import { cn } from "@/lib/utils";

/** The settings pages: a column on wide screens, a scrolling row on narrow ones. */
export function SettingsNav({ isAdmin }: { isAdmin: boolean }) {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Settings pages"
      className="flex gap-1 overflow-x-auto [scrollbar-width:none] lg:sticky lg:top-16 lg:flex-col"
    >
      {SETTINGS_NAV.filter((p) => !p.admin || isAdmin).map((p) => {
        const active = isActive(pathname, p.href, p.href === "/settings");
        return (
          <Link
            key={p.href}
            href={p.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex h-8 shrink-0 items-center gap-2 rounded-lg px-2.5 text-sm font-medium whitespace-nowrap transition-colors",
              active
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            <p.icon aria-hidden="true" className="size-4" />
            {p.label}
          </Link>
        );
      })}
    </nav>
  );
}
