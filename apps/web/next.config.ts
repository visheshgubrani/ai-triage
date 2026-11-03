import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript source.
  transpilePackages: ["@ai-triage/contracts", "@ai-triage/core", "@ai-triage/api", "@ai-triage/evals"],
  poweredByHeader: false,
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
