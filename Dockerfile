# One image for every process (docs/deploy.md): `api`, `worker`, `web`, `migrate`, `seed-demo` and
# the CLIs, chosen by the first argument (infra/docker/entrypoint.sh). The api, worker and CLIs are
# bundled with their dependencies (tsup) and web is Next's standalone output, so the runtime stage
# holds node and those files, not the workspace or its node_modules.

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
COPY packages/mailbox/package.json packages/mailbox/
COPY packages/schemas/package.json packages/schemas/
COPY packages/storage/package.json packages/storage/
COPY packages/telemetry/package.json packages/telemetry/
COPY packages/webhooks/package.json packages/webhooks/
COPY fixtures/package.json fixtures/
RUN pnpm install --frozen-lockfile

COPY . .
# No URL is baked in: the browser calls /api on whatever origin serves the app.
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build
# sharp serves only next/image's optimizer, which is off (next.config.ts). It's the one native
# module, built for glibc, and the runtime is musl.
RUN rm -rf apps/web/.next/standalone/node_modules/.pnpm/sharp@* apps/web/.next/standalone/node_modules/.pnpm/@img+*

# The runtime holds plain JavaScript (no native modules), so it runs on the smaller Alpine image.
FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 MIGRATIONS_DIR=/app/packages/db/migrations
WORKDIR /app
# pnpm-workspace.yaml marks the root that relative paths (fixtures, cassettes) resolve from.
COPY --from=build /app/pnpm-workspace.yaml /app/package.json ./
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static apps/web/.next/static
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/worker/dist apps/worker/dist
COPY --from=build /app/packages/db/migrations packages/db/migrations
# The demo seed's documents and the recorded responses that replay mode serves.
COPY --from=build /app/fixtures/manifest.json fixtures/
COPY --from=build /app/fixtures/docs fixtures/docs
COPY --from=build /app/fixtures/cassettes fixtures/cassettes
COPY --chmod=755 infra/docker/entrypoint.sh /usr/local/bin/entrypoint
# The app's files stay owned by root: the `node` user runs them but can't change them. Only Next's
# cache is writable.
RUN mkdir -p apps/web/.next/cache && chown node:node apps/web/.next/cache
USER node
ENTRYPOINT ["entrypoint"]
CMD ["api"]
