# Reliability

> How ai-triage behaves under real mail volume and when things break, measured. The mechanisms are in [architecture.md](architecture.md) §5 (fairness, backpressure, self-healing, timeouts); running it is in [operations.md](operations.md).

## Method

Everything here runs against the full Docker stack (`docker compose up`: Caddy, api, one worker, Postgres, RustFS) with the **simulator** (`sim:simulated`, `pnpm llm-sim`). It's an OpenAI-compatible server that answers every classify and extract request with schema-valid output built from the document text, after 300 ± 200 ms. So the pipeline, the queues, the database, delivery and the failure handling are real; only the model is fake, and nothing is spent.

**The mail** comes from the variety generator (`fixtures/src/variety`): seeded, deterministic, about 40 base shapes varied by language, charset, layout and attachment. A 1,000-message run covers about 230 distinct kinds:

- **Business mail:** invoices as plain text, HTML, PDF, DOCX, forwarded as `message/rfc822`, in reply chains and as reminders; support threads; contracts and amendments; POs, receipts, credit notes and shipping notices.
- **Noise:** newsletters, auto-replies, DSN bounces, calendar invites, read receipts.
- **Edge cases:** `winmail.dat`, zero-byte attachments, `cid:` images, a 200 KB body, malformed headers, a missing or duplicate Message-ID, emoji, Latin-1, Windows-1252 and Shift_JIS.

`pnpm load` does the rest:
1. Creates load tenants on the simulator: invoices and support requests on auto-approval with a 10% audit rate, contracts reviewed, webhooks to the catcher.
2. Sends the mail through the REST API, retrying 429s after `Retry-After` like a real client. One "noisy" tenant sends most of it.
3. Waits until every document is done and every webhook delivered.
4. Checks the invariants.

```bash
pnpm load --docs 1000 --tenants 5 --skew 0.8 --api http://localhost:3000 --webhook-url http://webhook-catcher:9030/hooks/load
pnpm load --docs 500 --sim-storm 60 --chaos "docker compose restart worker" --chaos-every 45
pnpm load --docs 300 --chaos "docker compose restart postgres" --chaos-every 40
```

**The invariants must hold in every run, or the run fails:**
- no stalled runs;
- at most one canonical model attempt per run and stage;
- at most one action per document;
- every action delivered;
- no document left in progress.

**The parse robustness test** (`fixtures/src/variety/variety.test.ts`, in CI) sends 500 generated messages through the ingestion normalizer and the parse stage's parsers. Every one must parse, quickly, into readable text.

## Results

Measured on 2026-11-04 on one machine: AMD Ryzen 5 5600G (12 threads), 14 GB RAM, Docker 29.9. One worker at the defaults (`WORKER_LLM_CONCURRENCY=4`), simulator latency 300 ± 200 ms. Latency is end to end, from the REST call to the document's final pipeline state.

| Run | Documents | Throughput | p50 | p95 | Quiet tenants' p95 vs noisy | Invariants |
|---|---|---|---|---|---|---|
| A. Paced by the API's per-key limit (120/min; 144 sends waited) | 996 of 1,000 (4 duplicates) | 154/min | 13 s | 28 s | 1.16 | all hold |
| B. Burst (`RATE_LIMIT_SCALE=100`), no per-tenant cap | 984 | 176/min | 171 s | 305 s | **1.01**: every tenant waits behind the noisy one | all hold |
| C. Burst, `WORKER_TENANT_CONCURRENCY=2` | 991 | 200/min | 115 s | 275 s | **0.45**: quiet tenants p95 111–126 s, noisy 278 s | all hold |
| D. Chaos: a 60 s storm of 50% 429s, and the worker restarted every 45 s (6×) | 494 | 108/min | 150 s | 250 s | – | all hold, **0 failures** |
| E. Chaos: Postgres restarted every 40 s | 300 | 153/min | 46 s | 66 s | – | all hold, **0 failures** |

What the runs show:

- **Correctness held everywhere.** Across about 3,000 documents, including restarts of the worker and of Postgres mid-transaction:
  - no document stalled or was lost;
  - no stage kept two canonical attempts;
  - no document got two actions;
  - every auto-approved document's webhook was delivered.

  Duplicate Message-IDs were recognized at ingestion (the 200s in A–C).
- **Fairness works as a cap.**
  - **Without a cap (B):** a 785-document burst from one tenant makes everyone wait as long as it does.
  - **With the cap at half the slots (C):** the four quiet tenants finish their documents in about 2 minutes at p95, while the noisy tenant's backlog drains behind them, and total throughput rises.
  - **Fetch speed:** pg-boss's capped fetch still takes 19–20 ms per fetch with 50,000 jobs queued for one capped tenant, and it hands out the quiet tenant's job first.
- **A busy provider is absorbed.** In the 429 storm (D) the first busy answer cooled the model down for the worker. Jobs gave their slots back without calling or spending, and processing resumed when the storm ended; no document failed. A storm longer than about an hour would fail documents as `provider_unavailable`, ready for Retry all.
- **Restarts cost time, not documents.**
  - A worker restart drains its jobs for up to 25 s; an aborted model call retries elsewhere.
  - A Postgres restart drops every connection. In-flight jobs fail and retry with backoff, and the pools replace their connections.
  - The visible cost is a pause of about a minute in the run's progress.
- **Throughput scales with model slots.**
  - One worker at the defaults holds 4 classify and 4 extract calls at once, so with a 300 ms model it moves about 175–200 documents a minute.
  - A real model is 5–20× slower per call, so plan on `replicas × WORKER_LLM_CONCURRENCY` slots for your volume.
  - The daily budget, not the queue, is usually the first limit.

## Bugs these runs found (fixed)

- **The queue sampler's SQL** put `FILTER` outside its aggregate. It failed every 15 seconds, and because sampling shared the heartbeat's error handling, the worker's `/health` went stale too. Sampling now runs apart from the heartbeat, and a test runs the sampler against Postgres.
- **A Postgres restart crashed the worker.** A connection that died while checked out emitted an `error` event that nothing listened to. `withTenantTx` now listens for the checkout's duration, and the pool logs dropped idle connections.
- **The simulator misread documents**: written dates, "Total due:", "Subtotal" taken for the total. So no document auto-approved, and delivery went untested. Its answers now follow the documents closely enough that about 9% auto-approve.

## Knobs

| Setting | Effect |
|---|---|
| `WORKER_LLM_CONCURRENCY` × worker replicas | Model calls in flight per LLM stage: the main throughput lever |
| `WORKER_TENANT_CONCURRENCY` | Per-tenant cap per queue, across workers. About half the cluster's slots per LLM queue once there's more than one tenant |
| `RATE_LIMIT_SCALE` | The API's request limits (the REST API allows 120/min per key at 1) |
| `DB_POOL_MAX` | The app pool per process. Watch `triage_db_pool_connections{state="waiting"}` |
| `RECONCILE_STALL_MINUTES` | How soon work with no job left is failed visibly (default 30) |
| `PARSE_TIMEOUT_MS`, `PARSE_MAX_MEMORY_MB` | Bounds of the parse sandbox |

## OCR (optional, PaddleOCR-VL 1.6 on llama.cpp)

Measured on 2026-11-04 on this machine: 12 cores, 15 GB, Radeon RX 6600. Each page is one full-page 910×1287 scan from `fixtures/docs` (an invoice and a contract), with the `OCR:` prompt at temperature 0:

| Backend | Time per page (uncached) | Memory | Text |
|---|---|---|---|
| CPU (`llama.cpp:server`) | 27–29 s | 1.2 GB | Every labeled field right, on both pages |
| Vulkan (`server-vulkan`, default flash attention) | 8–10 s | 0.4 GB host | Identical to CPU |
| Vulkan with `-fa off` | 12–13 s | | Identical |

Getting the page image out of a scanned PDF (`unpdf` `extractImages`) took 63 ms. On the installed stack (`install.sh --ocr vulkan`), the scanned invoice went through parse, OCR, classify and extract in 15 s. OCR takes 9.9 s of that, and the simulator, a text-only model, read it.

PaddleOCR's layout stage wasn't needed for this: the model reads whole pages in reading order, tables as `|` rows. llama.cpp serves the same model on CUDA too; that backend wasn't measured here.
