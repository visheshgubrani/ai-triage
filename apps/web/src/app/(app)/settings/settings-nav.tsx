"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { isActive, SETTINGS_NAV } from "@/components/shell/nav";
import { cn } from "@/lib/utils";

/** The settings pages in their groups: a column on wide screens, one scrolling row on narrow ones. */
export function SettingsNav({ isAdmin }: { isAdmin: boolean }) {
  const pathname = usePathname();
  const pages = SETTINGS_NAV.filter((p) => !p.admin || isAdmin);
  const groups = [...new Set(pages.map((p) => p.group))];
  return (
    <nav
      aria-label="Settings pages"
      className="flex gap-1 overflow-x-auto [scrollbar-width:none] lg:sticky lg:top-16 lg:flex-col lg:gap-5"
    >
      {groups.map((group) => (
        <div key={group} className="flex shrink-0 gap-1 lg:flex-col lg:gap-0.5">
          <p className="hidden px-2.5 pb-1 text-xs font-medium text-muted-foreground/80 lg:block">{group}</p>
          {pages
            .filter((p) => p.group === group)
            .map((p) => {
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
        </div>
      ))}
    </nav>
  );
}
