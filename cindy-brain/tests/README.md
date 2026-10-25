# Cindy Brain — acceptance tests (wrangler dev)

Run the brain locally, then drive the acceptance matrix with the simulated node.

## Setup

```bash
npm install
npx wrangler d1 create cindy_memory         # put the id into wrangler.jsonc
npx wrangler r2 bucket create cindy-artifacts
npx wrangler vectorize create cindy-memory --dimensions=1024 --metric=cosine
npx wrangler queues create mem-ingest
npx wrangler d1 execute cindy_memory --file=./schema.d1.sql --local
npx wrangler secret put CINDY_NODE_BOOTSTRAP_TOKEN   # or .dev.vars for local
echo 'CINDY_NODE_BOOTSTRAP_TOKEN=devtoken' >> .dev.vars
echo 'PANEL_TOKEN=devpanel' >> .dev.vars
npx wrangler dev
```

## Matrix

All commands assume the dev server on http://localhost:8787 and use
`Authorization: Bearer devpanel` for protected routes.

| # | Test | How |
|---|------|-----|
| 1 | Streaming chat survives restart | Open two browser tabs to `/`; chat in both; restart `wrangler dev`; sessions/messages persist (DO SQLite). |
| 2 | Memory remember→search | `POST /mem/remember {"text":"I prefer pnpm","kind":"semantic"}` → wait for workflow → `POST /mem/search {"query":"package manager"}` returns it with provenance. |
| 3 | Task claim→result→review | `SCENARIO=task node tests/node-sim.mjs ws://localhost:8787 devtoken` → watch task board; review verdict lands in tasks.review_json; post-mortem row in D1 chunks (kind procedural). |
| 4 | Watchdog fires on crash | `SCENARIO=crash node tests/node-sim.mjs ...` → GET `/api/watchdog/status` shows dispatch_restart + dispatch_skipped_guard on a second tick; Telegram mocked when unconfigured. |
| 5 | Queue redelivery idempotency | POST 50 memories; wait; `SELECT COUNT(*) FROM chunks` = 50 (unique source+content_hash). |
| 6 | Pairing | Fresh DEVICE_ID → `node.pair_required` → sim auto-approves via `/api/nodes/:id/pair` → second hello ok; restart sim with same DEVICE_ID → no re-pair. |
| 7 | Shell round-trip in chat | With sim online: chat "run `uname -a` on the hands" → tool node.cmd → cmd.ack → reply stored as message. |
| 8 | Park drill | `SCENARIO=park node tests/node-sim.mjs ...` → park instruction + `park.done` in watchdog log; reconnect and confirm resync lists parked tasks. |
| 9 | Consistency | `POST /mem/compact` → response contains drift metric; sampled ids match. |
| 10 | Spend guard | Set `DAILY_TOKEN_BUDGET=1` in vars → chat → gateway falls back to FALLBACK_MODEL and logs `usedFallback`. |

The simulated node (`node-sim.mjs`) implements the full frame protocol:
hello/pair/claim/progress/result/cmd.ack/event/resync.
