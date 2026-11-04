export type AgentKind = "desktop" | "mobile" | "cli" | "headless";

/** Tools that call the API from a terminal or a script, by the start of their User-Agent. */
const CLIENTS: [RegExp, string][] = [
  [/^curl\//i, "curl"],
  [/^Wget\//i, "Wget"],
  [/^HTTPie\//i, "HTTPie"],
  [/^(python-requests|python-httpx|Python-urllib|aiohttp)\//i, "Python"],
  [/^(node|node-fetch|undici|axios)\b/i, "Node.js"],
  [/^Go-http-client\//i, "Go"],
  [/^PostmanRuntime\//i, "Postman"],
  [/^insomnia\//i, "Insomnia"],
];

/** Most specific first: Edge and Opera also say Chrome, and Chrome also says Safari. */
const BROWSERS: [RegExp, string][] = [
  [/Edg(e|A|iOS)?\//, "Edge"],
  [/OPR\/|Opera/, "Opera"],
  [/Firefox\/|FxiOS\//, "Firefox"],
  [/Electron\//, "Desktop app"],
  [/Chrome\/|CriOS\//, "Chrome"],
  [/Safari\//, "Safari"],
];

const SYSTEMS: [RegExp, string][] = [
  [/iPhone/, "iPhone"],
  [/iPad/, "iPad"],
  [/Android/, "Android"],
  [/CrOS/, "ChromeOS"],
  [/Windows/, "Windows"],
  [/Mac OS X|Macintosh/, "macOS"],
  [/Linux|X11/, "Linux"],
];

const first = (ua: string, table: [RegExp, string][]) => table.find(([re]) => re.test(ua))?.[1];

/**
 * "Chrome on Windows" from a User-Agent header, for a list of sign-in sessions. Names only, never
 * versions: it's for recognizing a session, not for deciding anything.
 */
export function describeAgent(ua: string | null | undefined): { label: string; kind: AgentKind } {
  if (!ua?.trim()) return { label: "Unknown device", kind: "desktop" };
  const client = first(ua, CLIENTS);
  if (client) return { label: client, kind: "cli" };
  const system = first(ua, SYSTEMS);
  if (/HeadlessChrome/.test(ua))
    return { label: system ? `Headless Chrome on ${system}` : "Headless Chrome", kind: "headless" };
  const browser = first(ua, BROWSERS);
  const kind: AgentKind = /Mobi|iPhone|iPad|Android/.test(ua) ? "mobile" : "desktop";
  if (!browser) return { label: system ?? ua.split(/[\s/]/)[0] ?? "Unknown device", kind: system ? kind : "cli" };
  return { label: system ? `${browser} on ${system}` : browser, kind };
}
