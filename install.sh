#!/bin/sh
# Install ai-triage with Docker, on this computer or on a server (docs/install.md):
#
#   curl -fsSL https://raw.githubusercontent.com/visheshgubrani/ai-triage/main/install.sh | sh
#   curl -fsSL …/install.sh | sh -s -- --host triage.example.com --email ops@example.com
#   curl -fsSL …/install.sh | sh -s -- --demo
#
# It only orchestrates: the deploy files come from the release, and `cli configure` (in the image)
# writes .env with fresh secrets. Re-running it is safe; it keeps .env and upgrades. Model keys are
# read from the environment (export ANTHROPIC_API_KEY=… first), never from arguments.
set -eu

REPO=visheshgubrani/ai-triage
IMAGE_REPO=${TRIAGE_IMAGE:-ghcr.io/$REPO}
VERSION=latest
DIR=./ai-triage
HOST=
FILES_HOST=
EMAIL=
PORT=
OCR=
DEMO=
# TRIAGE_SOURCE=<checkout>: copy the files from a local checkout instead of downloading (CI, testing).
SOURCE=${TRIAGE_SOURCE:-}

say() { printf '%s\n' "$*"; }
step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() {
  printf '\033[31merror:\033[0m %s\n' "$1" >&2
  [ -n "${2:-}" ] && printf '  fix: %s\n' "$2" >&2
  exit 1
}

usage() {
  cat <<'EOF'
usage: install.sh [options]

  (no options)        a local install on http://localhost:3000, for this computer only
  --host NAME         a server install with HTTPS on NAME (its DNS must point here)
  --email ADDRESS     Let's Encrypt account email (needed with --host)
  --files-host NAME   behind a reverse proxy you already run (nginx, Caddy, Traefik) that owns 80/443:
                      with --host, the app and its files listen on 127.0.0.1 (--port, --port + 1)
                      and the proxy serves https://HOST and https://NAME. Prints its config
  --port N            the app's port on this computer (default 3000); a local install's
                      stored files use N+1
  --ocr BACKEND       read scans and photos with PaddleOCR-VL: nvidia, vulkan (AMD and Intel
                      GPUs) or cpu; off turns it off again. Downloads about 3 GB the first time
  --demo              the demo instead: sample data and recorded model answers, no key needed
  --version X.Y.Z     the release to install (default: latest)
  --dir PATH          where to put it (default: ./ai-triage)
  --yes               never prompt (the installer itself never prompts; this keeps scripts explicit)

Model keys come from the environment: export ANTHROPIC_API_KEY (or OPENAI_API_KEY,
DEEPSEEK_API_KEY, OPENROUTER_API_KEY) before running, or set one later with
`./triage config set ANTHROPIC_API_KEY`.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="${2:?--host needs a value}"; shift 2 ;;
    --email) EMAIL="${2:?--email needs a value}"; shift 2 ;;
    --files-host) FILES_HOST="${2:?--files-host needs a value}"; shift 2 ;;
    --port) PORT="${2:?--port needs a value}"; shift 2 ;;
    --ocr) OCR="${2:?--ocr needs a value}"; shift 2 ;;
    --version) VERSION="${2:?--version needs a value}"; shift 2 ;;
    --dir) DIR="${2:?--dir needs a value}"; shift 2 ;;
    --demo) DEMO=1; shift ;;
    # Accepted for scripts that pass it: the installer never prompts.
    --yes | -y) shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown option $1" ;;
  esac
done
VERSION=${VERSION#v}

# ── Checks ──
step "Checking this machine"
command -v docker >/dev/null 2>&1 || die "Docker isn't installed" "install Docker: https://docs.docker.com/engine/install/ (Docker Desktop on macOS and Windows)"
docker info >/dev/null 2>&1 || die "Docker isn't running, or this user can't use it" "start Docker, or add yourself to the docker group: sudo usermod -aG docker \$USER (then log in again)"
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is missing" "install the compose plugin: https://docs.docker.com/compose/install/"
case "$(uname -m)" in
  x86_64 | amd64 | aarch64 | arm64) ;;
  *) die "unsupported CPU architecture $(uname -m)" "the image is built for amd64 and arm64" ;;
esac
command -v curl >/dev/null 2>&1 || [ -n "$SOURCE" ] || die "curl is needed to download the files" "install curl"

# A port in use? (Best effort: ss or lsof, when present.)
port_busy() {
  if command -v ss >/dev/null 2>&1; then ss -ltn 2>/dev/null | awk '{print $4}' | grep -q "[:.]$1\$"
  elif command -v lsof >/dev/null 2>&1; then lsof -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
  else
    [ -n "${PORTS_UNCHECKED:-}" ] || say "warning: neither ss nor lsof is here, so ports weren't checked"
    PORTS_UNCHECKED=1
    return 1
  fi
}
already_ours() { [ -f "$DIR/.env" ] && (cd "$DIR" && docker compose ps -q caddy 2>/dev/null | grep -q .); }
env_get() { sed -n "s/^$1=//p" "${2:-.env}" 2>/dev/null | tail -n 1; }

if [ -n "$DEMO" ]; then
  [ -z "$HOST" ] || die "--demo runs on this computer only" "drop --host, or drop --demo for a real install"
  # The demo's host ports. The app's comes from --port (or the last run); each of the others is its
  # default or the first free one 100, 200, … above it, so another stack on this machine keeps its own.
  # A re-run keeps what the first run chose (.env).
  web=${PORT:-$(env_get WEB_PORT "$DIR/.env")}
  web=${web:-3000}
  case "$web" in
    *[!0-9]* | "") die "--port must be a number" ;;
  esac
  if [ "$web" -lt 1024 ] || [ "$web" -gt 65535 ]; then die "--port must be between 1024 and 65535"; fi
  demo_ports=
  moved=
  if already_ours; then
    for name in S3_PORT S3_CONSOLE_PORT CATCHER_PORT FAKE_GOOGLE_PORT SIM_PORT POSTGRES_PORT; do
      demo_ports="$demo_ports $name=$(env_get "$name" "$DIR/.env")"
    done
  else
    port_busy "$web" && die "port $web is in use" "run again with --port <another port>, such as --port 4000"
    for pair in S3_PORT:9020 S3_CONSOLE_PORT:9021 CATCHER_PORT:9030 FAKE_GOOGLE_PORT:9040 SIM_PORT:9050 POSTGRES_PORT:5440; do
      name=${pair%%:*}
      default=${pair#*:}
      p=$(env_get "$name" "$DIR/.env")
      p=${p:-$default}
      while port_busy "$p" || [ "$p" = "$web" ]; do
        p=$((p + 100))
        [ "$p" -le 65535 ] || die "no free port for $name" "free a port near $default, then run this again"
      done
      [ "$p" = "$default" ] || moved="$moved $default→$p"
      demo_ports="$demo_ports $name=$p"
    done
  fi
elif [ -n "$FILES_HOST" ]; then
  [ -n "$HOST" ] || die "--files-host goes with --host (the app's public hostname)" "add --host triage.example.com"
  p=${PORT:-3000}
  for q in "$p" "$((p + 1))"; do
    port_busy "$q" && ! already_ours && die "port $q is in use" "run again with --port <another port>, such as --port 4600"
  done
elif [ -n "$HOST" ]; then
  [ -n "$EMAIL" ] || die "--host needs --email (Let's Encrypt sends certificate notices there)" "add --email you@example.com"
  for p in 80 443 8443; do
    port_busy "$p" && ! already_ours && die "port $p is in use" "a server install needs 80, 443 and 8443 free (stop the web server that uses them)"
  done
  if command -v getent >/dev/null 2>&1 && ! getent hosts "$HOST" >/dev/null 2>&1; then
    say "warning: $HOST doesn't resolve yet. Point its DNS (an A or AAAA record) at this server;"
    say "         HTTPS certificates are issued once it does."
  fi
else
  p=${PORT:-3000}
  if port_busy "$p" && ! already_ours; then
    die "port $p is in use" "run again with --port <another port>, such as --port 4000"
  fi
  if port_busy "$((p + 1))" && ! already_ours; then
    die "port $((p + 1)) is in use (stored files use the port after the app's)" "run again with --port <another port>"
  fi
fi
case "$OCR" in
  "" | off | cpu) ;;
  vulkan)
    [ -e /dev/dri ] || die "--ocr vulkan needs a GPU at /dev/dri" "install the GPU's drivers (Mesa for AMD and Intel), or use --ocr cpu"
    ;;
  nvidia)
    docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -q nvidia ||
      die "--ocr nvidia needs the NVIDIA Container Toolkit" "install it: https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html, or use --ocr cpu"
    ;;
  *) die "--ocr must be nvidia, vulkan, cpu or off" ;;
esac
[ -z "$OCR" ] || [ -z "$DEMO" ] || die "--ocr doesn't apply to the demo"
say "Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null), $(docker compose version --short), $(uname -m): ok"

# ── Files ──
# The deploy files and the image come from the same release: `latest` means the latest release
# (main only before the first one exists, or with TRIAGE_SOURCE).
if [ "$VERSION" = latest ] && [ -z "$SOURCE" ]; then
  tag=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null |
    sed -n 's/.*"tag_name": *"v\{0,1\}\([^"]*\)".*/\1/p' | head -n 1 || true)
  [ -n "$tag" ] && VERSION=$tag
fi
ref=main
[ "$VERSION" = latest ] || ref="v$VERSION"
fetch() { # fetch <repo path> <destination>
  mkdir -p "$(dirname "$2")"
  if [ -n "$SOURCE" ]; then
    cp "$SOURCE/$1" "$2"
  else
    curl -fsSL "https://raw.githubusercontent.com/$REPO/$ref/$1" -o "$2" ||
      die "couldn't download $1 (release $ref)" "check the version, or your connection to github.com"
  fi
}

mkdir -p "$DIR"
cd "$DIR"
DIR=$(pwd)
image="$IMAGE_REPO:$VERSION"

if [ -n "$DEMO" ]; then
  step "Downloading the demo into $DIR"
  fetch compose.yaml compose.yaml
  fetch infra/caddy/Caddyfile.demo infra/caddy/Caddyfile.demo
  fetch infra/webhook-catcher/catcher.mjs infra/webhook-catcher/catcher.mjs
  fetch fixtures/docs/sup-12.eml samples/sup-12.eml
  # .env keeps the demo's project and ports, so `docker compose` run here later finds the same stack.
  # Its own project: the repository's `ai-triage` is a dev stack's, with its containers and data.
  env_set() {
    touch .env
    grep -v "^$1=" .env >.env.tmp || true
    printf '%s=%s\n' "$1" "$2" >>.env.tmp
    mv .env.tmp .env
  }
  [ -n "$(env_get COMPOSE_PROJECT_NAME)" ] || env_set COMPOSE_PROJECT_NAME ai-triage-demo
  env_set TRIAGE_VERSION "$VERSION"
  [ -z "${TRIAGE_IMAGE:-}" ] || env_set TRIAGE_IMAGE "$TRIAGE_IMAGE"
  env_set WEB_PORT "$web"
  for kv in $demo_ports; do env_set "${kv%%=*}" "${kv#*=}"; done
  [ -z "$moved" ] || say "Ports already in use elsewhere, so the demo moved:$moved"
  step "Starting the demo (the first start pulls about 350 MB)"
  docker compose up -d --wait api worker web caddy webhook-catcher fake-google llm-sim
  say ""
  say "The demo is running: http://localhost:$web"
  say "  Sign in as admin@demo.test (or reviewer@demo.test) with the password demo-password."
  say "  Approvals are delivered, signed, to the webhook catcher: http://localhost:$(env_get CATCHER_PORT)"
  say "  Gmail is faked: connect it in Settings → Mailboxes, then deliver a message into it with"
  say "    curl --data-binary @$DIR/samples/sup-12.eml http://localhost:$(env_get FAKE_GOOGLE_PORT)/fake/deliver"
  say "  Stop it with: cd $DIR && docker compose down    (add -v to delete its data)"
  exit 0
fi

step "Downloading the deploy files into $DIR"
for f in compose.yaml compose.local.yaml compose.server.yaml Caddyfile triage; do fetch "deploy/$f" "$f"; done
for b in nvidia vulkan cpu; do fetch "deploy/compose.ocr-$b.yaml" "compose.ocr-$b.yaml"; done
chmod +x triage

if [ "$VERSION" != latest ] && docker image inspect "$image" >/dev/null 2>&1; then
  say "Using $image (already here)"
else
  step "Pulling $image"
  docker pull --quiet "$image" >/dev/null || die "couldn't pull $image" "check the version (--version), or your connection to ghcr.io"
fi

step "Writing .env"
set -- --dir /work --version "$VERSION"
if [ -n "$FILES_HOST" ]; then
  set -- "$@" --host "$HOST" --files-host "$FILES_HOST"
elif [ -n "$HOST" ]; then
  set -- "$@" --host "$HOST" --email "$EMAIL"
fi
[ -n "$PORT" ] && set -- "$@" --port "$PORT"
[ -n "$OCR" ] && set -- "$@" --ocr "$OCR"
docker run --rm -v "$DIR:/work" --user "$(id -u):$(id -g)" \
  -e ANTHROPIC_API_KEY -e OPENAI_API_KEY -e DEEPSEEK_API_KEY -e OPENROUTER_API_KEY \
  "$image" cli configure "$@"
if [ -n "${TRIAGE_IMAGE:-}" ]; then
  grep -q '^TRIAGE_IMAGE=' .env || printf 'TRIAGE_IMAGE=%s\n' "$TRIAGE_IMAGE" >>.env
fi

if grep -q '^OCR_BACKEND=\(nvidia\|vulkan\|cpu\)' .env; then
  step "Starting, with OCR (the first start downloads the OCR model, about 1.8 GB)"
else
  step "Starting (migrations run first)"
fi
./triage start >/dev/null

url=$(./triage open)
if [ -n "$FILES_HOST" ]; then
  app_port=$(sed -n 's/^APP_PORT=//p' .env)
  say ""
  say "Point your reverse proxy at it (both hostnames need DNS to this server). For Caddy:"
  say ""
  say "  $HOST {"
  say "      reverse_proxy 127.0.0.1:$app_port"
  say "  }"
  say "  $FILES_HOST {"
  say "      request_body { max_size 100MB }"
  say "      reverse_proxy 127.0.0.1:$((app_port + 1))"
  say "  }"
  say ""
  say "  For nginx: two server blocks, proxy_pass http://127.0.0.1:$app_port and :$((app_port + 1)), with"
  say "  proxy_set_header Host \$host, X-Forwarded-For \$proxy_add_x_forwarded_for, X-Forwarded-Proto \$scheme,"
  say "  and client_max_body_size 100m. Keep the Host header: stored files are signed for it."
elif [ -n "$HOST" ]; then
  # Caddy gets the certificate on the first request; give it a minute.
  ok=
  for _ in $(seq 1 30); do
    if curl -fsS -o /dev/null --max-time 5 "$url/api/health" 2>/dev/null; then ok=1; break; fi
    sleep 2
  done
  if [ -z "$ok" ]; then
    say ""
    say "warning: $url doesn't answer over HTTPS yet. The app is running, but the certificate"
    say "  isn't issued: $HOST must resolve to this server, and ports 80 and 443 must be open to"
    say "  the internet (cloud firewalls too)."
    say "  fix: fix DNS or the firewall, then ./triage logs caddy shows Let's Encrypt's answer"
  fi
fi
setup_out=$(./triage setup-link 2>&1 || true)
link=$(printf '%s\n' "$setup_out" | grep -Eo 'https?://[^ ]+/setup#[^ ]+' | tail -n 1 || true)
say ""
say "ai-triage is running at $url"
if ! grep -Eq '^(ANTHROPIC|OPENAI|DEEPSEEK|OPENROUTER)_API_KEY=.+' .env; then
  say ""
  say "  No model key yet, so documents can't be processed. Add one:"
  say "    cd $DIR && ./triage config set ANTHROPIC_API_KEY"
fi
say ""
say "  Manage it from $DIR with ./triage (status, logs, backup, upgrade, …)."
say "  Next: connect your email and a webhook (docs/install.md)."
if [ -n "$link" ]; then
  say ""
  say "Create your workspace (this link works once):"
  say "$link"
elif printf '%s' "$setup_out" | grep -q "Setup is closed"; then
  say ""
  say "This installation already has a workspace: sign in at $url"
else
  say ""
  say "Couldn't get a setup link: $setup_out"
  say "  fix: ./triage setup-link (and ./triage logs api if it fails again)"
fi
