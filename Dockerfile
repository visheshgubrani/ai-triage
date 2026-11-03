# One image for the app: `init` (migrations + demo seed), `api`, `worker` and `web` run it with
# different commands (compose.yaml). Workspace packages ship TypeScript source and the seeds run with
# tsx, so the image keeps the workspace and its dependencies rather than only the bundles.

# Base images are pinned by digest (Dependabot proposes updates), so a rebuild gets the same bytes.
FROM node:24-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c AS build
ENV CI=true
RUN npm install -g pnpm@12.11.2
WORKDIR /app

# Dependencies first, from the manifests alone, so a code change doesn't reinstall them.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/contracts/package.json packages/contracts/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/evals/package.json packages/evals/
COPY packages/ingest/package.json packages/ingest/
COPY packages/llm/package.json packages/llm/
COPY packages/schemas/package.json packages/schemas/
COPY packages/storage/package.json packages/storage/
COPY fixtures/package.json fixtures/
RUN pnpm install --frozen-lockfile

COPY . .
# The browser calls the API at this URL; Next inlines it at build time.
ARG NEXT_PUBLIC_API_URL=http://localhost:8787
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

FROM node:24-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c
ENV CI=true NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
# The image is installed once, at build time. pnpm would otherwise re-run an install before each
# script, which under NODE_ENV=production prunes devDependencies the seeds need (tsx).
ENV pnpm_config_verify_deps_before_run=false
RUN npm install -g pnpm@12.11.2
WORKDIR /app
# The app's files stay owned by root: the `node` user runs them but can't change them. Only Next's
# cache is writable.
COPY --from=build /app /app
RUN mkdir -p apps/web/.next/cache && chown -R node:node apps/web/.next/cache
USER node
CMD ["pnpm", "--filter", "@ai-triage/api", "start"]
