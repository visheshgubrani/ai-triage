import { APP_VERSION } from "@ai-triage/core";
import { UserX } from "lucide-react";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { EmptyState } from "@/components/empty-state";
import { AppSidebar } from "@/components/shell/app-sidebar";
import { SystemBanners } from "@/components/shell/system-banners";
import { TopBar } from "@/components/shell/top-bar";
import { SignOutButton } from "@/components/sign-out-button";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { getSessionState, setupNeeded } from "@/lib/session";
import { parseTheme, THEME_COOKIE } from "@/lib/theme";

/** The frame of every signed-in page: sidebar, top bar, system banners, and the page's one <main>. */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const { me, noWorkspace } = await getSessionState();
  if (!me) {
    if (await setupNeeded()) redirect("/setup");
    if (!noWorkspace) {
      const path = (await headers()).get("x-pathname") ?? "/";
      redirect(path === "/" ? "/sign-in" : `/sign-in?next=${encodeURIComponent(path)}`);
    }
    return (
      <main className="flex min-h-svh items-center justify-center p-4">
        <EmptyState
          icon={UserX}
          title="You're not in a workspace yet"
          description="You're signed in, but not a member of any workspace. Ask an admin of yours for an invitation link."
          action={<SignOutButton />}
        />
      </main>
    );
  }
  const jar = await cookies();
  return (
    <SidebarProvider defaultOpen={jar.get("sidebar_state")?.value !== "false"}>
      <a
        href="#content"
        className="sr-only z-50 rounded-md bg-background px-3 py-2 text-sm focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to content
      </a>
      <AppSidebar
        email={me.user.email}
        workspace={me.tenant.name}
        role={me.role}
        version={APP_VERSION}
        theme={parseTheme(jar.get(THEME_COOKIE)?.value)}
      />
      <SidebarInset className="min-w-0">
        <TopBar isAdmin={me.role === "admin"} />
        <SystemBanners isAdmin={me.role === "admin"} />
        <main id="content" className="flex-1">
          {children}
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
