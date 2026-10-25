// MemIngest Workflow: durable, idempotent memory ingestion.
// Steps: fetch/extract → chunk → embed → upsert (poll until queryable) → catalog.

import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { Env, IngestPayload, MEMORY_CONFIG, sha256Hex } from "../types";
import { embed } from "./recall";

const CHUNK_TARGET_TOKENS = 1000; // 800–1200
const CHUNK_OVERLAP = 0.15;

export class MemIngestWorkflow extends WorkflowEntrypoint<Env, unknown> {
  override async run(event: Readonly<WorkflowEvent<IngestPayload>>, step: WorkflowStep): Promise<unknown> {
    const payload = event.payload;

    const text = await step.do("fetch-text", async () => {
      if (payload.text) return payload.text;
      if (payload.r2_key) {
        const obj = await this.env.ARTIFACTS.get(payload.r2_key);
        if (!obj) throw new Error(`R2 object not found: ${payload.r2_key}`);
        return (await obj.text()).slice(0, 2_000_000);
      }
      throw new Error("payload has neither text nor r2_key");
    });

    const chunks = await step.do("chunk", async () => {
      return chunkText(text, CHUNK_TARGET_TOKENS, CHUNK_OVERLAP);
    });

    const meta = payload.meta;
    const source = payload.source_id;
    const baseId = await sha256Hex(`${source}:${text.slice(0, 4096)}`);

    const chunkCount = chunks.length;
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      const chunkId = `${source}:${baseId}:${i}`.replace(/[^a-zA-Z0-9_:.-]/g, "_").slice(0, 100);
      const contentHash = await sha256Hex(chunk);

      const existing = await this.env.DB.prepare(
        "SELECT id FROM chunks WHERE source = ? AND content_hash = ?",
      ).bind(source, contentHash).first<{ id: string }>();
      if (existing) continue;

      await step.do(`embed-upsert-${i}`, async () => {
        const vectors = await embed(this.env, [chunk]);
        const mutation = await this.env.VECTORIZE.upsert([{
          id: chunkId,
          values: vectors[0]!,
          metadata: {
            kind: meta.kind,
            source,
            session_id: meta.session_id ?? "",
            task_id: meta.task_id ?? "",
            ts: meta.ts ?? Date.now(),
            r2_key: payload.r2_key ?? "",
          },
        }]);
        if (mutation.mutationId) {
          for (let tries = 0; tries < 20; tries++) {
            const status = await (this.env.VECTORIZE as any).describeMutation?.(mutation.mutationId)
              ?? (this.env.VECTORIZE as any).getMutationStatus?.(mutation.mutationId)
              ?? { status: "completed" };
            if (status.status === "completed" || status.status === "active" || !status.status) break;
            await new Promise(r => setTimeout(r, 250));
          }
        }
        return chunkId;
      });

      await step.do(`catalog-${i}`, async () => {
        await this.env.DB.prepare(
          "INSERT OR IGNORE INTO chunks (id, kind, source, session_id, task_id, cycle_id, ts, text, r2_key, token_count, content_hash, deleted) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)",
        ).bind(
          chunkId, meta.kind, source, meta.session_id ?? null, meta.task_id ?? null,
          meta.cycle_id ?? null, meta.ts ?? Date.now(), chunk, payload.r2_key ?? null,
          Math.ceil(chunk.length / 4), contentHash,
        ).run();
        return chunkId;
      });
    }

    await step.do("finalize", async () => {
      if (payload.r2_key) {
        await this.env.DB.prepare("UPDATE artifacts SET ingested = 1 WHERE r2_key = ?")
          .bind(payload.r2_key).run();
      }
      await this.env.DB.prepare("INSERT INTO ingest_log (ts, source, status, error) VALUES (?, ?, 'done', NULL)")
        .bind(Date.now(), source).run();
      return chunkCount;
    });

    return { ok: true, chunks: chunkCount };
  }
}

// Simple token proxy: ~4 chars/token. Chunk with 15% overlap.
export function chunkText(text: string, targetTokens: number, overlap: number): string[] {
  const clean = text.trim();
  if (!clean) return [];
  const targetChars = targetTokens * 4;
  if (clean.length <= targetChars * 1.2) return [clean];
  const stride = Math.floor(targetChars * (1 - overlap));
  const out: string[] = [];
  for (let i = 0; i < clean.length; i += stride) {
    out.push(clean.slice(i, i + targetChars));
    if (i + targetChars >= clean.length) break;
  }
  return out;
}

export const EMBED_MODEL = MEMORY_CONFIG.embedModel;
