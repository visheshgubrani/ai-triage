"use client";

import type { InboxResponse } from "@ai-triage/contracts";
import { ChevronsUpDown, Code, KeyRound, LogOut, Monitor, Moon, Sun } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { LogoMark } from "@/components/logo";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import { browserApi } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { THEME_COOKIE, type Theme, themeClass } from "@/lib/theme";
import { usePolling } from "@/lib/use-polling";
import { isActive, MAIN_NAV } from "./nav";

const THEME_OPTIONS: { value: Theme; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];

function applyTheme(theme: Theme) {
  // biome-ignore lint/suspicious/noDocumentCookie: a plain preference the server reads on the next request
  document.cookie = `${THEME_COOKIE}=${theme}; path=/; max-age=31536000; samesite=lax`;
  const root = document.documentElement;
  root.classList.remove("light", "dark");
  const name = themeClass(theme);
  if (name) root.classList.add(name);
}

/** How many tasks wait for a person. Polled slowly: it's a hint, and the queue page has the real list. */
function useOpenCount() {
  const [count, setCount] = useState<number | null>(null);
  usePolling(async (signal) => {
    const res = await browserApi.review.tasks.$get({ query: {} }, { init: { signal } });
    if (res.ok) setCount(((await res.json()) as InboxResponse).counts.total);
  }, 30_000);
  return count;
}

export function AppSidebar({
  email,
  workspace,
  role,
  version,
  theme: initialTheme,
}: {
  email: string;
  workspace: string;
  role: string;
  version: string;
  theme: Theme;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const { isMobile, setOpenMobile } = useSidebar();
  const [theme, setTheme] = useState(initialTheme);
  const openCount = useOpenCount();
  const closeOnMobile = () => setOpenMobile(false);

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild size="lg" tooltip="Dashboard">
              <Link href="/" onClick={closeOnMobile}>
                <LogoMark />
                <span className="grid min-w-0 flex-1 text-left leading-tight">
                  <span className="truncate text-sm font-semibold text-foreground">AI Triage</span>
                  <span className="truncate text-xs text-muted-foreground">{workspace}</span>
                </span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {MAIN_NAV.filter((item) => !item.admin || role === "admin").map((item) => (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton asChild isActive={isActive(pathname, item.href)} tooltip={item.label}>
                    <Link href={item.href} onClick={closeOnMobile}>
                      <item.icon aria-hidden="true" />
                      <span>{item.label}</span>
                    </Link>
                  </SidebarMenuButton>
                  {item.href === "/review" && !!openCount && (
                    <SidebarMenuBadge className="tabular-nums">{openCount}</SidebarMenuBadge>
                  )}
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton size="lg" className="data-[state=open]:bg-sidebar-accent">
                  <span
                    aria-hidden="true"
                    className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-xs font-semibold text-foreground uppercase"
                  >
                    {email.slice(0, 2)}
                  </span>
                  <span className="grid min-w-0 flex-1 text-left leading-tight">
                    <span className="truncate text-sm font-medium">{email}</span>
                    <span className="truncate text-xs text-muted-foreground capitalize">{role}</span>
                  </span>
                  <ChevronsUpDown aria-hidden="true" className="ml-auto size-4 text-muted-foreground" />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="min-w-56" side={isMobile ? "bottom" : "right"} align="end" sideOffset={8}>
                <DropdownMenuLabel className="font-normal">
                  <p className="truncate text-sm font-medium text-foreground">{email}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {workspace} · <span className="capitalize">{role}</span>
                  </p>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link href="/settings/security" onClick={closeOnMobile}>
                    <KeyRound aria-hidden="true" />
                    Account security
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <Sun aria-hidden="true" className="dark:hidden" />
                    <Moon aria-hidden="true" className="hidden dark:block" />
                    Theme
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    <DropdownMenuRadioGroup
                      value={theme}
                      onValueChange={(value) => {
                        setTheme(value as Theme);
                        applyTheme(value as Theme);
                      }}
                    >
                      {THEME_OPTIONS.map((t) => (
                        <DropdownMenuRadioItem key={t.value} value={t.value}>
                          <t.icon aria-hidden="true" />
                          {t.label}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuItem asChild>
                  <a href="https://github.com/visheshgubrani/ai-triage">
                    <Code aria-hidden="true" />
                    Source
                    <span className="ml-auto text-xs text-muted-foreground">{version}</span>
                  </a>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={async () => {
                    await authClient.signOut();
                    router.push("/sign-in");
                    router.refresh();
                  }}
                >
                  <LogOut aria-hidden="true" />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
