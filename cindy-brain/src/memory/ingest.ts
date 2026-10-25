// Queue consumer: starts a MEM_INGEST Workflow instance per payload.
// Idempotency: instance id = source_id + content hash.

import { Env, IngestPayload, sha256Hex } from "../types";

export async function handleQueue(
  batch: MessageBatch<IngestPayload>,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  for (const msg of batch.messages) {
    const payload = msg.body;
    try {
      const hash = await sha256Hex(JSON.stringify(payload));
      const instanceId = `${payload.source_id}:${hash}`.replace(/[^a-zA-Z0-9_:.-]/g, "_").slice(0, 60);
      await env.MEM_INGEST.create({ id: instanceId, params: payload });
      msg.ack();
    } catch (e) {
      const detail = (e as Error).message;
      console.error("ingest queue error", detail);
      try {
        await env.DB.prepare("INSERT INTO ingest_log (ts, source, status, error) VALUES (?, ?, 'queue_error', ?)")
          .bind(Date.now(), payload.source_id, detail.slice(0, 500)).run();
      } catch { /* d1 unavailable */ }
      msg.retry();
    }
  }
  void ctx;
}
