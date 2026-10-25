# Cindy Brain

A personal AI agent whose **brain lives permanently on Cloudflare Workers** and whose **hands are a disposable Ubuntu box** (a Kaggle notebook used as a VPS) that dials the brain **outbound** over WebSocket and is rebuilt every ~11 hours.

- **Brain 1 — CindyCore**: a single SQLite-backed Durable Object (Agents SDK `Agent`) owning chat, sessions, task orchestration, the node registry, the watchdog, scheduling, and all LLM calls (via AI Gateway).
- **Brain 2 — Memory**: a RAG long-term-memory service — Workers AI embeddings + Vectorize + D1 + R2, ingestion through Queues and Workflows — continuous memory that survives every restart, eviction, and disconnect.
- **Control panel**: static single-page app (`src/panel/`), dark-mode, no build step.
- **Hands kit**: `hands/bootstrap.sh`, `hands/cindy-node.mjs`, `hands/notebook.py`, `hands/kernel-metadata.json`, plus `.github/workflows/restart-kaggle.yml`.

Design invariants: the brain owns context and the hands own execution; hands death costs ≤15 min of work and zero memory; the node connects outbound only (no inbound tunnels); no event replay across reconnects (nodes resync); idempotency everywhere; everything fits Workers Free plan (no containers).

## Deploy

### 1. Create resources

```bash
npx wrangler d1 create cindy_memory                 # copy database_id into wrangler.jsonc
npx wrangler r2 bucket create cindy-artifacts
npx wrangler vectorize create cindy-memory --dimensions=1024 --metric=cosine
npx wrangler vectorize create-metadata-index cindy-memory --property=kind --type=string
npx wrangler vectorize create-metadata-index cindy-memory --property=ts --type=number
npx wrangler queues create mem-ingest
npx wrangler queues create mem-ingest-dlq           # dead-letter queue
npx wrangler d1 execute cindy_memory --file=./schema.d1.sql --remote
```

Vectorize dimensions are **frozen at creation** and must match the embedding model (`@cf/baai/bge-m3` → 1024). Create the metadata indexes on `kind` and `ts` **before the first insert**.

### 2. Secrets

```bash
npx wrangler secret put LLM_API_KEY                    # OpenAI-compatible key (AI Gateway BYOK)
npx wrangler secret put LLM_BASE_URL                   # optional; provider base URL override
npx wrangler secret put CINDY_NODE_BOOTSTRAP_TOKEN     # one-time pairing token
npx wrangler secret put GH_PAT                          # GitHub PAT with actions:write
npx wrangler secret put GH_REPO                         # e.g. user/cindy_Cloudeflare
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put R2_S3_ACCESS_KEY_ID            # S3 token for node snapshot uploads
npx wrangler secret put R2_S3_SECRET_ACCESS_KEY
npx wrangler secret put PANEL_TOKEN                    # fallback auth for /admin and /api/*
```

For local dev, mirror them in `.dev.vars` (gitignored).

### 3. Deploy + configure channels

```bash
npx wrangler deploy
```

Then set the Telegram webhook using the Bot API `setWebhook` call with
`url=https://<worker>.workers.dev/hooks/telegram` and a `secret_token`; the
webhook route verifies the `x-telegram-bot-api-secret-token` header.

Put Cloudflare Access in front of `/admin/*` (recommended) or rely on `PANEL_TOKEN`.

## Device pairing walkthrough

1. `wrangler secret put CINDY_NODE_BOOTSTRAP_TOKEN` — this token is valid **only for pairing**.
2. Start the hands (first Kaggle cycle or `node tests/node-sim.mjs`). The node sends `node.hello` with the bootstrap token.
3. CindyCore answers `node.pair_required` and notifies Telegram. The device row stores the **hash** of the bootstrap token; the device_id is minted once and kept in `state/node/device.json`.
4. Approve via the panel Pairing pane (`POST /api/nodes/:id/pair`). The node retries hello every 60 s and receives `node.hello.ok`.
5. From now on the node authenticates with the same token + device_id; reboots and reconnects never re-pair. To rotate, revoke in the `nodes` table and mint a new bootstrap token.

## First-cycle launch (Kaggle hands)

1. Edit `hands/kernel-metadata.json` (`id`, `dataset_sources` to your Kaggle user), then:
   ```bash
   kaggle kernels push -p hands
   ```
2. In Kaggle Secrets add: `CINDY_URL`, `CINDY_NODE_BOOTSTRAP_TOKEN`, `R2_S3_ACCESS_KEY_ID`, `R2_S3_SECRET_ACCESS_KEY`.
3. The notebook restores previous state from the prior cycle's output, installs tmux/Node/BrowserOS, runs `bootstrap.sh`, then serves ~10.5 h.
4. The GitHub Actions workflow `restart-kaggle.yml` (cron `23 */11 * * *` + `workflow_dispatch`, repo secret `KAGGLE_JSON_B64`) re-pushes the kernel each cycle; the watchdog dispatches it off-schedule when the node dies.

## Operational runbook

- **Restart a cycle early**: Telegram `/restart`, or panel → Node → Run watchdog tick, or `gh workflow run restart-kaggle.yml`.
- **Re-pair a device**: revoke (`UPDATE nodes SET revoked=1`), set a new `CINDY_NODE_BOOTSTRAP_TOKEN`, delete `state/node/device.json` on the hands, re-run `bootstrap.sh`.
- **Re-ingest memory from R2**: artifacts keep `r2_key`; re-enqueue `{type:"file", source_id, r2_key, meta}` to `mem-ingest` for every artifact row. Full index rebuild: create a new Vectorize index (dimensions frozen), update `wrangler.jsonc`, re-enqueue every artifact.
- **Embedding model swap** = new index + full re-ingest from R2 sources (dims are frozen per index).
- **Rotate the node token**: same as re-pair.
- **Restore drill**: kill a running hands mid-task; confirm watchdog dispatch within 15 min, `node.online` within 10 min, tasks requeued, park dirs resumed, ≤15 min of hands work lost.
- **Daily compaction**: `POST /mem/compact` (also on the daily schedule). Response includes the D1↔Vectorize drift metric; alert threshold 0.1%.

## Free-tier ops/day budget (estimates)

| Resource | Op | Free limit | Est. daily use |
|---|---|---|---|
| DO requests | chat + watchdog + ws | free-plan eligible | ~5k |
| Alarm invocations | 5-min watchdog tick | — | ~300 |
| Queue operations | mem-ingest | 1M | ~200 |
| Workflow steps | 3–5 steps × chunks | 100k | ~1k |
| Vectorize queries | recall (prompt + tools) | 10k | ~500 |
| Vectorize upserts | ingestion | 5M | ~200 |
| Workers AI | bge-m3 embeddings | neurons-based | far under free tier |
| D1 rows | catalog join | 5M read / 100k write | ~50k / ~10k |

All within Workers Free plan assumptions; Paid is a comfort tier only.

## Threat notes

Nothing sensitive lands in `/kaggle/working` beyond the node token and R2 S3 keys needed for snapshot uploads; both rotate through the re-pair procedure. Node-supplied content is always fenced in `<untrusted>` blocks in prompts and treated as data, never instructions. Shell commands run through a denylist (destruction, mining, proxy patterns); file ops are bounded to `/kaggle/working` with traversal rejection; R2 uploads are content-type and size restricted.

## Acceptance tests

See `tests/README.md` — a 10-point matrix driven against `wrangler dev` with `tests/node-sim.mjs` (full frame protocol simulator).
