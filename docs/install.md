# Install ai-triage

One command installs it with Docker, on your own computer or on a server. You don't need a git clone, Node or a build. Each running installation has:
- the app;
- a background worker;
- Postgres;
- file storage;
- Caddy as the front door, with automatic HTTPS on a server.

## What you need

- **Docker** with Compose v2. On macOS and Windows that's Docker Desktop; Windows runs it through WSL.
- **A machine:** 2 vCPU and 4 GB of RAM handle a small team's mail.
- **A model API key** from Anthropic, OpenAI, DeepSeek or OpenRouter. You can add it after installing.
- **For a server:** a DNS name pointing at it, and ports 80, 443 and 8443 open.

## 1. Install

**On this computer** (only this machine can reach it):

```bash
export ANTHROPIC_API_KEY=sk-ant-…    # or OPENAI_API_KEY, DEEPSEEK_API_KEY, OPENROUTER_API_KEY
curl -fsSL https://raw.githubusercontent.com/visheshgubrani/ai-triage/main/install.sh | sh
```

**On a server**, with HTTPS (the DNS record must already point at it):

```bash
export ANTHROPIC_API_KEY=sk-ant-…
curl -fsSL https://raw.githubusercontent.com/visheshgubrani/ai-triage/main/install.sh | sh -s -- \
  --host triage.example.com --email ops@example.com
```

**Just looking?** `… | sh -s -- --demo` runs the demo instead: sample documents, recorded model answers, and no key needed.

The installer:
1. checks Docker and the ports;
2. downloads the deploy files into `./ai-triage`;
3. writes `.env` with freshly generated secrets (mode 0600);
4. starts everything, with migrations running first.

It ends by printing a **setup link**. Re-running it is safe: it keeps `.env` and moves you to the requested version.

| Option | Does |
|---|---|
| `--host NAME --email ADDRESS` | Server install. The app is at `https://NAME`, and stored files at `https://NAME:8443`: a separate origin, so a stored file can never run as the app |
| `--port N` | Local install on another port (default 3000). Files use N+1 |
| `--version X.Y.Z` | Install a specific release (default: latest) |
| `--dir PATH` | Where to put it (default `./ai-triage`) |
| `--yes` | Never prompt |

**Where the key goes:** the key is read from your environment and written only to `.env`. It never appears in a command line, so it stays out of shell history and `ps`. No key yet? Add one at any time:

```bash
cd ai-triage && ./triage config set ANTHROPIC_API_KEY    # asks for the value without echoing it
```

## 2. Create your workspace

Open the setup link. It works once and for 24 hours; `./triage setup-link` prints a new one. Name the workspace and give the first admin's email, then set a password or sign in with Google.

The app asks admins for two-factor authentication before they can change settings. The getting-started checklist on the home page walks through the rest.

## 3. Connect your email

The simplest path works with any mail provider (Gmail, Microsoft 365, Fastmail, your own server), with no DNS changes. You forward a mailbox, such as `invoices@yourcompany.com`, to an address Postmark gives you:

1. **Create a Postmark account and a server.** The free tier covers 100 emails a month. The server's **Inbound** page shows its address, `abc123@inbound.postmarkapp.com`.
2. **Point Postmark's inbound webhook at your installation**, with the credentials from your `.env`:

   ```text
   https://postmark:<POSTMARK_INBOUND_PASSWORD>@triage.example.com/api/webhooks/postmark
   ```

   Postmark must reach it over the internet, so this needs a server install, or a tunnel for a local one.
3. **Tell the installation that address**, then rotate your workspace's address so it uses it:

   ```bash
   ./triage config set INBOUND_DOMAIN=abc123@inbound.postmarkapp.com
   ```

   In **Settings → Inbound email**, choose **Rotate**. Your address becomes `abc123+t-…@inbound.postmarkapp.com`. The random part means nobody can guess it.
4. **Forward the mailbox to that address.** In Gmail that's Settings → Forwarding; in Microsoft 365, a mail flow rule or the mailbox's forwarding setting. Documents start appearing under Documents.

**Prefer your own domain?** Point an MX record for a subdomain (`inbound.yourcompany.com`) at `inbound.postmarkapp.com`, add it as an inbound domain in Postmark, and set `INBOUND_DOMAIN=inbound.yourcompany.com`.

**Gmail or Google Workspace:**
- Instead of forwarding, the app can read a labeled Gmail mailbox directly (**Settings → Mailboxes**).
- That needs a Google OAuth client; see [google.md](google.md). Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` with `./triage config set`.
- Register these redirect URIs:
  - `https://<host>/api/auth/callback/google`
  - `https://<host>/api/integrations/google/callback`

## 4. Send the results somewhere

Approved documents are POSTed to your webhook, signed and delivered at least once.
1. Set its URL in **Settings → Webhook**.
2. Press **Send test event**.
3. Verify signatures as [api.md](api.md) shows.

Other systems can also send documents with the REST API and look up what happened to each one. Create a key in **Settings → API keys**.

## Running it

From the install directory:

| Command | Does |
|---|---|
| `./triage status` | Containers, then the installation's own checks (`--json` for scripts) |
| `./triage logs [service]` | Follow the logs (api, worker, web, caddy, postgres) |
| `./triage config set KEY[=VALUE]` | Change a setting in `.env`, then restart what reads it |
| `./triage backup` | The database, stored files and `.env` into `backups/<time>/` |
| `./triage restore <dir>` | Replace this installation's data with a backup, here or on a new machine |
| `./triage upgrade [--version X]` | Back up, pull, migrate, restart |
| `./triage stop` / `start` | Stop or start everything |
| `./triage uninstall [--purge]` | Remove the containers, and with `--purge` the data too |
| `./triage cli <command>` | One of the image's commands, such as `tenant-create --name Acme --slug acme --admin you@acme.com` (another workspace) or `api-key-create --tenant acme` |

**Backups hold your secrets.**
- `.env` holds the encryption keys that protect webhook secrets and mailbox tokens, so a backup is useless without it. Each backup includes a copy; keep backups private.
- Copy them off the machine on a schedule, for example a nightly `./triage backup` from cron, then rsync `backups/` elsewhere.
- **Moving to a new machine:**
  1. Install there.
  2. Copy a backup directory over.
  3. Run `./triage restore <dir>`.

  It takes the backup's keys and integrations, and keeps the new machine's own database passwords.

**Every setting** is in `.env`, described in [configuration.md](configuration.md). For example:
- `WORKER_LLM_CONCURRENCY`: model calls in parallel.
- `WORKER_TENANT_CONCURRENCY`: fairness, for several workspaces.
- `METRICS_TOKEN`: Prometheus at `/api/metrics`.

Health checks, metrics, alerts and runbooks are in [operations.md](operations.md). The security checklist is in [security.md](security.md).

**Your own Postgres or S3.** Remove `COMPOSE_PROFILES=bundled` from `.env` and set:
- `DATABASE_OWNER_URL`: a role that can create roles; migrations use it.
- `DATABASE_URL`: the app role, which migrations create with that password. Use a direct connection, not a transaction pooler.
- `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`. The api sets the bucket's CORS rule at startup; turn on server-side encryption on the bucket.

`./triage backup` covers bundled services only; back up your own where they run.

## If an AI agent is installing this

An agent can do the whole install without prompts. Give it these instructions:

1. **Never put an API key in the chat or on a command line.** Ask the person to export it in the shell the agent uses, for example `export ANTHROPIC_API_KEY=…`. The installer reads it from there.
2. **Run the install non-interactively:**
   - local: `curl -fsSL https://raw.githubusercontent.com/visheshgubrani/ai-triage/main/install.sh | sh -s -- --yes`
   - server: add `--host <name> --email <address>`
   - if port 3000 is taken, add `--port <n>`.
3. **Check readiness:** run `cd ai-triage && ./triage status --json` until it prints `"ready": true`. Each failing check has a `fix`.
4. **Hand the setup link to the person:** the installer's last line, or `./triage setup-link`. It creates the first admin, so the person should open it, not the agent.
5. **Use exit codes:** each step fails with a non-zero exit code and a one-line `fix:`, so the agent can stop and report instead of guessing.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "port 3000 is in use" | Add `--port 4000` |
| A server install can't get a certificate | The DNS record must point at this machine, and ports 80 and 443 must be reachable from the internet. `./triage logs caddy` shows Let's Encrypt's answer |
| Documents fail | Check `./triage status`. "model blocked" means no key for the workspace's model: set one, or pick another model in Settings → Pipeline |
| Anything else | See [troubleshooting.md](troubleshooting.md) |
