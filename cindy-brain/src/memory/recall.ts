// Retrieval: embed query → Vectorize query (always metadata-filtered) → D1 join → ranking.

import { Env, RecallHit, RecallOptions, MEMORY_KINDS, MemoryKind, MEMORY_CONFIG } from "../types";

const DAY_MS = 24 * 3600 * 1000;
const EPISODIC_HALF_LIFE_DAYS = 14;

export async function embed(env: Env, texts: string[]): Promise<number[][]> {
  const res = await env.AI.run(MEMORY_CONFIG.embedModel as any, { texts } as any);
  const data = res as unknown as { data?: number[][] };
  if (!data.data) throw new Error("embedding model returned no data");
  return data.data;
}

export async function recall(env: Env, query: string, opts: RecallOptions = {}): Promise<RecallHit[]> {
  const k = opts.k ?? 8;
  if (!query.trim()) return [];

  const vectors = await embed(env, [query]);
  const kinds = opts.kinds ?? [...MEMORY_KINDS];

  // Namespace safety: always filter, never query the whole index unfiltered.
  let vectorFilter: Record<string, unknown>;
  if (kinds.length === MEMORY_KINDS.length) {
    vectorFilter = { kind: { $in: [...MEMORY_KINDS] } };
  } else if (kinds.length === 1) {
    vectorFilter = { kind: kinds[0] };
  } else {
    vectorFilter = { kind: { $in: kinds } };
  }
  if (opts.since) vectorFilter = { ...vectorFilter, ts: { $gte: opts.since } };
  if (opts.until) vectorFilter = { ...vectorFilter, ts: { $lte: opts.until } };
  if (opts.task_id) vectorFilter = { ...vectorFilter, task_id: opts.task_id };
  if (opts.session_id) vectorFilter = { ...vectorFilter, session_id: opts.session_id };

  const results = await env.VECTORIZE.query(vectors[0]!, {
    topK: k,
    filter: vectorFilter as any,
    returnMetadata: "all",
  });

  if (!results.matches?.length) return [];
  const ids = results.matches.map(m => m.id);
  const placeholders = ids.map(() => "?").join(",");
  const rows = await env.DB.prepare(
    `SELECT id, kind, source, ts, text FROM chunks WHERE id IN (${placeholders}) AND deleted = 0`,
  ).bind(...ids).all<{ id: string; kind: MemoryKind; source: string | null; ts: number; text: string }>();

  const byId = new Map(rows.results.map(r => [r.id, r]));
  const hits: RecallHit[] = [];
  for (const m of results.matches) {
    const row = byId.get(m.id);
    if (!row) continue;
    const score = (m.score ?? 0) * recencyDecay(row.kind, row.ts);
    hits.push({ id: row.id, score, kind: row.kind, text: row.text, source: row.source, ts: row.ts });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, k);
}

function recencyDecay(kind: MemoryKind, ts: number): number {
  if (kind !== "episodic") return 1;
  const ageDays = (Date.now() - ts) / DAY_MS;
  return Math.pow(0.5, ageDays / EPISODIC_HALF_LIFE_DAYS);
}
