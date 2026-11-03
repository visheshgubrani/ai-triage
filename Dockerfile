# One image for the app: `init` (migrations + demo seed), `api`, `worker` and `web` run it with
# different commands (compose.yaml). Workspace packages ship TypeScript source and the seeds run with
# tsx, so the image keeps the workspace and its dependencies rather than only the bundles.

FROM node:24-slim AS build
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

FROM node:24-slim
ENV CI=true NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
RUN npm install -g pnpm@12.11.2
WORKDIR /app
COPY --from=build --chown=node:node /app /app
USER node
CMD ["pnpm", "--filter", "@ai-triage/api", "start"]
