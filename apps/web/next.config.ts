import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript source.
  transpilePackages: ["@ai-triage/contracts", "@ai-triage/core", "@ai-triage/api", "@ai-triage/evals"],
};

export default nextConfig;
