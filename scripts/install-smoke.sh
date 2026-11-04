#!/bin/sh
# The install path end to end (CI's install-smoke job; runnable locally): install.sh from this
# checkout with a given image, then the first-run setup through the API, an API key, a document on
# the simulator, and a lookup until a person is asked to review it. Then backup, and restore into
# a second installation. Then the demo (install.sh --demo) beside a stack that holds its ports.
#
#   scripts/install-smoke.sh <image repo> <version> [--host app.localhost]
set -eu
repo=$1 version=$2
shift 2
root=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
squatter=
cleanup() {
  [ -z "$squatter" ] || kill "$squatter" 2>/dev/null || true
  for d in "$work"/*/; do (cd "$d" && docker compose down -v --remove-orphans >/dev/null 2>&1) || true; done
  rm -rf "$work"
}
trap cleanup EXIT

install() { # install <dir> [install.sh options]
  dir=$1
  shift
  TRIAGE_SOURCE=$root TRIAGE_IMAGE=$repo \
    "$root/install.sh" --yes --version "$version" --dir "$dir" "$@" | tee "$dir.log"
}

prepare() { # prepare <dir>: the simulator for this stack, before it starts
  mkdir -p "$1"
  cp "$root/.github/ci/compose.sim.yaml" "$1/compose.sim.yaml"
}

echo "== install"
a="$work/a"
prepare "$a"
install "$a" "$@" >/dev/null
cd "$a"
# The simulator, and new workspaces on it.
./triage config set "COMPOSE_FILE=$(sed -n 's/^COMPOSE_FILE=//p' .env):compose.sim.yaml" >/dev/null
./triage config set DEFAULT_MODEL=sim:simulated >/dev/null
url=$(./triage open)
curl_() { curl -fsS --retry 3 -k "$@"; }

echo "== status"
./triage status --json | tee status.json
grep -q '"ready":true' status.json

echo "== setup"
token=$(./triage setup-link | grep -Eo '/setup#[^ ]+' | cut -d'#' -f2)
curl_ -X POST "$url/api/setup" -H "origin: $url" -H 'content-type: application/json' \
  -d "{\"token\":\"$token\",\"workspaceName\":\"Smoke\",\"slug\":\"smoke\",\"adminEmail\":\"admin@smoke.test\",\"acceptWith\":\"google_or_password\"}" |
  grep -q inviteUrl

echo "== a document through the pipeline"
key=$(docker compose exec -T api entrypoint cli api-key-create --tenant smoke | grep -Eo 'tri_[A-Za-z0-9_-]+' | tail -n 1)
printf 'INVOICE\nInvoice number: INV-1\nVendor name: Northwind\nTotal: 120.00\n' >invoice.txt
id=$(curl_ -X POST "$url/api/v1/documents" -H "authorization: Bearer $key" -F file=@invoice.txt -F external_ref=SMOKE-1 |
  sed 's/.*"documentId":"\([^"]*\)".*/\1/')
state=
for _ in $(seq 1 60); do
  state=$(curl_ "$url/api/v1/documents/$id" -H "authorization: Bearer $key" | sed 's/.*"state":"\([^"]*\)".*/\1/')
  case "$state" in needs_review | approved) break ;; failed) break ;; esac
  sleep 2
done
echo "state: $state"
[ "$state" = needs_review ]

echo "== backup, and restore into a second installation"
./triage backup
backup=
for d in "$a"/backups/*; do backup=$d; done
b="$work/b"
prepare "$b"
# A second local stack beside the first: another port and project name.
mkdir -p "$b" && printf 'COMPOSE_PROJECT_NAME=ai-triage-b\n' >"$b/.env"
install "$b" --port 4300 >/dev/null
cd "$b"
./triage config set "COMPOSE_FILE=$(sed -n 's/^COMPOSE_FILE=//p' .env):compose.sim.yaml" >/dev/null
./triage restore "$backup" --yes
url=$(./triage open)
curl_ "$url/api/v1/documents?external_ref=SMOKE-1" -H "authorization: Bearer $key" | grep -q "$id"

# Once, not again for the server install.
if [ $# -eq 0 ]; then
  echo "== the demo, while another stack holds its storage port"
  if ! curl -s -o /dev/null http://127.0.0.1:9020/; then
    python3 -m http.server 9020 --bind 127.0.0.1 >/dev/null 2>&1 &
    squatter=$!
    sleep 1
  fi
  d="$work/demo"
  # A project of its own, which the installer keeps (never the repository's ai-triage).
  mkdir -p "$d" && printf 'COMPOSE_PROJECT_NAME=ai-triage-demo-smoke\n' >"$d/.env"
  TRIAGE_SOURCE=$root TRIAGE_IMAGE=$repo "$root/install.sh" --demo --version "$version" --dir "$d" --port 4500 |
    tee "$d.log"
  cd "$d"
  grep -q '^COMPOSE_PROJECT_NAME=ai-triage-demo-smoke$' .env
  grep -q 'running: http://localhost:4500$' "$d.log"
  s3=$(sed -n 's/^S3_PORT=//p' .env)
  [ "$s3" != 9020 ]
  [ "$(docker compose exec -T api printenv S3_PUBLIC_ENDPOINT)" = "http://localhost:$s3" ]
  running=$(docker compose ps --services --status running)
  for s in webhook-catcher fake-google llm-sim; do printf '%s\n' "$running" | grep -qx "$s"; done
  curl_ -o /dev/null http://localhost:4500/sign-in
  curl_ --data-binary @samples/sup-12.eml "http://localhost:$(sed -n 's/^FAKE_GOOGLE_PORT=//p' .env)/fake/deliver" >/dev/null
fi
echo "== ok"
