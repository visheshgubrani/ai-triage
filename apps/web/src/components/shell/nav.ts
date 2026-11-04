import {
  FileText,
  FlaskConical,
  Gauge,
  HeartPulse,
  Inbox,
  KeyRound,
  LayoutDashboard,
  type LucideIcon,
  Mail,
  ScrollText,
  Settings,
  Shapes,
  ShieldCheck,
  SlidersHorizontal,
  Users,
  Webhook,
} from "lucide-react";

export type NavItem = { href: string; label: string; icon: LucideIcon; admin?: boolean; group?: string };

/** The sidebar. */
export const MAIN_NAV: NavItem[] = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/review", label: "Review queue", icon: Inbox },
  { href: "/documents", label: "Documents", icon: FileText },
  { href: "/evals", label: "Evals", icon: FlaskConical },
  { href: "/settings", label: "Settings", icon: Settings, admin: true },
];

/** The settings pages' own navigation, in its groups (in order). */
export const SETTINGS_NAV: NavItem[] = [
  { href: "/settings", label: "General", icon: SlidersHorizontal, admin: true, group: "Workspace" },
  { href: "/settings/members", label: "Members", icon: Users, admin: true, group: "Workspace" },
  { href: "/settings/mailboxes", label: "Mailboxes", icon: Mail, admin: true, group: "Workspace" },
  { href: "/settings/pipeline", label: "Pipeline", icon: Gauge, admin: true, group: "Pipeline" },
  { href: "/settings/categories", label: "Categories", icon: Shapes, admin: true, group: "Pipeline" },
  { href: "/settings/webhooks", label: "Webhooks", icon: Webhook, admin: true, group: "Developers" },
  { href: "/settings/api-keys", label: "API keys", icon: KeyRound, admin: true, group: "Developers" },
  { href: "/settings/health", label: "System health", icon: HeartPulse, admin: true, group: "Monitoring" },
  { href: "/settings/audit", label: "Audit log", icon: ScrollText, admin: true, group: "Monitoring" },
  { href: "/settings/security", label: "Account security", icon: ShieldCheck, group: "Account" },
];

export const isActive = (pathname: string, href: string, exact = href === "/") =>
  exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
