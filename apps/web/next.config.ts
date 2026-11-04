import { join } from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript source.
  transpilePackages: ["@ai-triage/contracts", "@ai-triage/core", "@ai-triage/api", "@ai-triage/evals"],
  poweredByHeader: false,
  // The Docker image runs `.next/standalone` (a server plus only the files it needs), traced from
  // the repo root because workspace packages live outside apps/web.
  output: "standalone",
  outputFileTracingRoot: join(import.meta.dirname, "../.."),
  // No next/image: images are presigned storage URLs or data: URLs. So sharp (a native module, and
  // Next's only one) is never loaded, and the Dockerfile drops it from the standalone output.
  images: { unoptimized: true },
  // `pnpm dev` only: the browser calls /api on this origin, and the dev server forwards it to the
  // api. Containers put Caddy in front instead (it routes /api straight to the api), because Next's
  // proxy caps bodies at 10 MB, times out after 30 s and can't vouch for X-Forwarded-For.
  async rewrites() {
    if (process.env.NODE_ENV === "production") return [];
    const api = process.env.API_INTERNAL_URL ?? "http://localhost:8787";
    return [{ source: "/api/:path*", destination: `${api}/api/:path*` }];
  },
  // Static security headers on every response; the CSP is per request (src/proxy.ts). HSTS belongs
  // to the TLS terminator in front of the app (docs/security.md, production checklist).
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
