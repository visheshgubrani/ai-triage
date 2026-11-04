"use client";

import { ChartColumn, Database, FlaskConical, GitBranch, Search } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Fragment, useEffect, useMemo, useState } from "react";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Kbd } from "@/components/ui/kbd";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { MAIN_NAV, SETTINGS_NAV } from "./nav";

const LABELS: Record<string, string> = {
  review: "Review queue",
  documents: "Documents",
  evals: "Evals",
  datasets: "Datasets",
  configs: "Configs",
  production: "Production",
  diff: "Compare runs",
  ...Object.fromEntries(SETTINGS_NAV.map((p) => [p.href.split("/").pop() as string, p.label])),
  settings: "Settings",
};

/** `/evals/runs/<id>` → Evals › Run. Segments that are no page of their own ("runs") are skipped. */
function crumbsOf(pathname: string) {
  const segments = pathname.split("/").filter(Boolean);
  const crumbs: { href: string; label: string }[] = [];
  segments.forEach((segment, i) => {
    if (segment === "runs") return;
    const parent = segments[i - 1];
    const label = LABELS[segment] ?? (parent === "runs" ? "Run" : parent === "review" ? "Task" : "Details");
    crumbs.push({ href: `/${segments.slice(0, i + 1).join("/")}`, label });
  });
  return crumbs;
}

const EVALS_PAGES = [
  { href: "/evals", label: "Eval runs", icon: FlaskConical },
  { href: "/evals/datasets", label: "Eval datasets", icon: Database },
  { href: "/evals/configs", label: "Eval configs", icon: GitBranch },
  { href: "/evals/production", label: "Production metrics", icon: ChartColumn },
];

function CommandPalette({ isAdmin }: { isAdmin: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const groups = useMemo(() => {
    const allowed = <T extends { admin?: boolean }>(items: T[]) => items.filter((i) => !i.admin || isAdmin);
    return [
      { heading: "Go to", items: allowed(MAIN_NAV) },
      { heading: "Evals", items: EVALS_PAGES },
      {
        heading: "Settings",
        items: allowed(SETTINGS_NAV).map((i) => ({
          ...i,
          label: i.href === "/settings" ? "General settings" : i.label,
        })),
      },
    ];
  }, [isAdmin]);

  const go = (href: string) => {
    setOpen(false);
    router.push(href);
  };

  return (
    <>
      <Button variant="outline" size="sm" className="gap-2 text-muted-foreground" onClick={() => setOpen(true)}>
        <Search aria-hidden="true" />
        <span className="hidden sm:inline">Search</span>
        <Kbd className="hidden sm:inline-flex">⌘K</Kbd>
        <span className="sr-only sm:hidden">Search</span>
      </Button>
      <CommandDialog open={open} onOpenChange={setOpen} title="Search" description="Jump to a page">
        <Command>
          <CommandInput placeholder="Where to?" />
          <CommandList>
            <CommandEmpty>No page matches.</CommandEmpty>
            {groups.map((g) => (
              <CommandGroup key={g.heading} heading={g.heading}>
                {g.items.map((item) => (
                  <CommandItem key={item.href} value={item.label} onSelect={() => go(item.href)}>
                    <item.icon aria-hidden="true" />
                    {item.label}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </CommandDialog>
    </>
  );
}

export function TopBar({ isAdmin }: { isAdmin: boolean }) {
  const pathname = usePathname();
  const crumbs = crumbsOf(pathname);
  return (
    <div className="sticky top-0 z-20 flex h-12 shrink-0 items-center gap-2 border-b bg-background/85 px-3 backdrop-blur md:px-4">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-4" />
      <Breadcrumb className="min-w-0 flex-1">
        <BreadcrumbList className="flex-nowrap">
          {crumbs.length === 0 && (
            <BreadcrumbItem>
              <BreadcrumbPage>Dashboard</BreadcrumbPage>
            </BreadcrumbItem>
          )}
          {crumbs.map((c, i) => (
            <Fragment key={c.href}>
              {i > 0 && <BreadcrumbSeparator />}
              <BreadcrumbItem className="min-w-0">
                {i === crumbs.length - 1 ? (
                  <BreadcrumbPage className="truncate">{c.label}</BreadcrumbPage>
                ) : (
                  <BreadcrumbLink asChild>
                    <Link href={c.href}>{c.label}</Link>
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
            </Fragment>
          ))}
        </BreadcrumbList>
      </Breadcrumb>
      <CommandPalette isAdmin={isAdmin} />
    </div>
  );
}
