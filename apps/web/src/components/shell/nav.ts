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
  Settings,
  Shapes,
  SlidersHorizontal,
  Users,
} from "lucide-react";

export type NavItem = { href: string; label: string; icon: LucideIcon; admin?: boolean };

/** The sidebar. */
export const MAIN_NAV: NavItem[] = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/review", label: "Review queue", icon: Inbox },
  { href: "/documents", label: "Documents", icon: FileText },
  { href: "/evals", label: "Evals", icon: FlaskConical },
  { href: "/settings", label: "Settings", icon: Settings, admin: true },
];

/** The settings pages' own navigation. */
export const SETTINGS_NAV: NavItem[] = [
  { href: "/settings", label: "General", icon: SlidersHorizontal, admin: true },
  { href: "/settings/pipeline", label: "Pipeline", icon: Gauge, admin: true },
  { href: "/settings/categories", label: "Categories", icon: Shapes, admin: true },
  { href: "/settings/members", label: "Members", icon: Users, admin: true },
  { href: "/settings/mailboxes", label: "Mailboxes", icon: Mail, admin: true },
  { href: "/settings/health", label: "System health", icon: HeartPulse, admin: true },
  { href: "/settings/security", label: "Account security", icon: KeyRound },
];

export const isActive = (pathname: string, href: string, exact = href === "/") =>
  exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
