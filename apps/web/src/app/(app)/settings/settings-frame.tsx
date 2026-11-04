import type { ReactNode } from "react";
import { Page, PageHeader } from "@/components/page-header";
import { SettingsNav } from "./settings-nav";

/** Title, the settings navigation beside the page, and a readable width for its forms. */
export function SettingsFrame({
  title,
  description,
  isAdmin,
  children,
}: {
  title: string;
  description?: string;
  isAdmin: boolean;
  children: ReactNode;
}) {
  return (
    <Page>
      <div className="grid items-start gap-x-8 gap-y-4 lg:grid-cols-[13rem_minmax(0,1fr)]">
        <SettingsNav isAdmin={isAdmin} />
        <div className="min-w-0 max-w-4xl">
          <PageHeader title={title} description={description} />
          {children}
        </div>
      </div>
    </Page>
  );
}
