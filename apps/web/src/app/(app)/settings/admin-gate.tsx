import { ShieldAlert, ShieldX } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "@/components/button";
import { EmptyState } from "@/components/empty-state";
import { getMe } from "@/lib/session";
import { SettingsFrame } from "./settings-frame";

const DESCRIPTIONS: Record<string, string> = {
  "/settings": "Where mail comes in, and what this workspace may spend and keep.",
  "/settings/members": "Who can see and decide documents here.",
  "/settings/mailboxes": "Google mailboxes this workspace reads documents from.",
  "/settings/pipeline": "The models that classify and extract, and how each category is routed.",
  "/settings/categories": "The document types the pipeline sorts into, and the fields it extracts.",
  "/settings/webhooks": "Where approved documents go, signed.",
  "/settings/api-keys": "Keys for the REST API: send documents in, and read them back.",
  "/settings/health": "This workspace's pipeline right now, and the deployment it shares.",
  "/settings/audit": "Security-relevant changes in this workspace, newest first.",
};

/**
 * The frame of the admin settings pages: their navigation, then the page only for an admin who has
 * 2FA where the deployment requires it (the API enforces both; this only explains them).
 */
export async function AdminSettings({
  title,
  current,
  children,
}: {
  title: string;
  current: string;
  children: ReactNode;
}) {
  const me = await getMe();
  return (
    <SettingsFrame title={title} description={DESCRIPTIONS[current]} isAdmin={me?.role === "admin"}>
      {me?.role !== "admin" ? (
        <EmptyState icon={ShieldX} title="Only a workspace admin can change settings" />
      ) : me.twoFactorRequired ? (
        <EmptyState
          icon={ShieldAlert}
          title="Admin settings need two-factor authentication"
          action={
            <Button asChild variant="primary">
              <Link href="/settings/security">Turn it on</Link>
            </Button>
          }
        />
      ) : (
        children
      )}
    </SettingsFrame>
  );
}
