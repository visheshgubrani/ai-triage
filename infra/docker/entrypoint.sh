#!/bin/sh
# The image's one entrypoint (docs/deploy.md): `api`, `worker`, `web`, `migrate`, `seed-demo` or
# `cli <name> [args]`, each exec'ing node directly so signals reach it (compose adds init: true).
set -eu
cd /app
bin=apps/worker/dist/bin
case "${1:-}" in
  api) exec node apps/api/dist/index.js ;;
  worker) exec node apps/worker/dist/index.js ;;
  # Docker sets HOSTNAME to the container id; Next's standalone server listens on it.
  web) HOSTNAME=0.0.0.0 PORT="${WEB_PORT:-3000}" exec node apps/web/server.js ;;
  migrate) exec node "$bin/migrate.js" ;;
  # The local demo's init: migrations, then the demo tenant, its documents and its eval runs.
  seed-demo)
    node "$bin/migrate.js"
    node "$bin/seed.js"
    node "$bin/seed-documents.js"
    exec node "$bin/seed-evals.js"
    ;;
  cli)
    shift
    name="${1:-}"
    if [ -z "$name" ] || [ ! -f "$bin/$name.js" ]; then
      echo "usage: cli <command> [args]. Commands:" >&2
      ls "$bin" | sed -n 's/\.js$//p' | sed 's/^/  /' >&2
      exit 2
    fi
    shift
    exec node "$bin/$name.js" "$@"
    ;;
  *)
    echo "usage: api | worker | web | migrate | seed-demo | cli <command> [args]" >&2
    exit 2
    ;;
esac
