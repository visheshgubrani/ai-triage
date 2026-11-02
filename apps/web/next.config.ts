import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript source.
  transpilePackages: ["@ai-triage/contracts", "@ai-triage/api"],
};

export default nextConfig;
