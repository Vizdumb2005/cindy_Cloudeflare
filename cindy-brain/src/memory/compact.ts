// Daily compaction + D1↔Vectorize consistency check.
// Triggered by the daily schedule (CindyCore alarm) or the panel.

import { Env, MEMORY_KINDS, MemoryKind, sha256Hex } from "../types";
import { embed } from "./recall";

const DAY_MS = 24 * 3600 * 1000;
const EPISODIC_MAX_AGE_DAYS = 30;
const DEDUPE_SIMILARITY = 0.97;

export interface CompactionReport {
  deduped: number;
  compacted: number;
  drift: number;
  alert: boolean;
}

export async function runDailyCompaction(env: Env): Promise<CompactionReport> {
  const deduped = await dedupeSemantic(env);
  const compacted = await compactEpisodic(env);
  const drift = await consistencyCheck(env);
  return { deduped, compacted, drift, alert: drift > 0.001 };
}

async function dedupeSemantic(env: Env): Promise<number> {
  const rows = await env.DB.prepare(
    "SELECT id, text FROM chunks WHERE kind = 'semantic' AND deleted = 0 ORDER BY ts ASC LIMIT 500",
  ).all<{ id: string; text: string }>();
  if (rows.results.length < 2) return 0;

  const vectors = await embed(env, rows.results.map(r => r.text));
  let merged = 0;
  const seen: { id: string; vec: number[] }[] = [];
  for (let i = 0; i < rows.results.length; i++) {
    const vec = vectors[i]!;
    const dup = seen.find(s => cosine(s.vec, vec) > DEDUPE_SIMILARITY);
    if (dup) {
      await env.DB.prepare("UPDATE chunks SET deleted = 1 WHERE id = ?").bind(rows.results[i]!.id).run();
      try { await env.VECTORIZE.deleteByIds([rows.results[i]!.id]); } catch { /* index drift tolerated */ }
      merged++;
    } else {
      seen.push({ id: rows.results[i]!.id, vec });
    }
  }
  return merged;
}

async function compactEpisodic(env: Env): Promise<number> {
  const cutoff = Date.now() - EPISODIC_MAX_AGE_DAYS * DAY_MS;
  const rows = await env.DB.prepare(
    "SELECT id, text, ts FROM chunks WHERE kind = 'episodic' AND deleted = 0 AND ts < ? ORDER BY ts ASC LIMIT 200",
  ).bind(cutoff).all<{ id: string; text: string; ts: number }>();
  if (!rows.results.length) return 0;

  // Weekly clustering: one summary vector per ISO-week cluster.
  const clusters = new Map<string, typeof rows.results>();
  for (const r of rows.results) {
    const d = new Date(r.ts);
    const jan1 = Date.UTC(d.getUTCFullYear(), 0, 1);
    const week = Math.ceil(((r.ts - jan1) / DAY_MS + 1) / 7);
    const key = `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
    const arr = clusters.get(key) ?? [];
    arr.push(r);
    clusters.set(key, arr);
  }
  let compacted = 0;
  for (const [week, items] of clusters) {
    const summaryText = `[weekly summary ${week}] ` + items.map(i => i.text.slice(0, 400)).join(" | ").slice(0, 8000);
    const vectors = await embed(env, [summaryText]);
    const summaryId = `episodic-summary:${week}`;
    await env.VECTORIZE.upsert([{
      id: summaryId,
      values: vectors[0]!,
      metadata: { kind: "episodic", source: `compaction:${week}`, session_id: "", task_id: "", ts: items[items.length - 1]!.ts, r2_key: "" },
    }]);
    await env.DB.prepare(
      "INSERT OR REPLACE INTO chunks (id, kind, source, ts, text, content_hash, deleted) VALUES (?, 'episodic', ?, ?, ?, ?, 0)",
    ).bind(summaryId, `compaction:${week}`, items[items.length - 1]!.ts, summaryText, await sha256Hex(summaryText)).run();
    for (const it of items) {
      await env.DB.prepare("UPDATE chunks SET deleted = 1 WHERE id = ?").bind(it.id).run();
      try { await env.VECTORIZE.deleteByIds([it.id]); } catch { /* tolerate */ }
      compacted++;
    }
  }
  return compacted;
}

// Compare D1 vs Vectorize counts on sampled ids; log drift; alert if > 0.1%.
export async function consistencyCheck(env: Env): Promise<number> {
  const d1Count = await env.DB.prepare("SELECT COUNT(*) c FROM chunks WHERE deleted = 0").first<{ c: number }>();
  const indexInfo = await env.VECTORIZE.describe();
  const d1 = d1Count?.c ?? 0;
  const vec = indexInfo.vectorCount ?? 0;
  const denom = Math.max(d1, vec, 1);
  const drift = Math.abs(d1 - vec) / denom;

  const sample = await env.DB.prepare(
    "SELECT id FROM chunks WHERE deleted = 0 ORDER BY RANDOM() LIMIT 25",
  ).all<{ id: string }>();
  let missing = 0;
  if (sample.results.length) {
    const found = await env.VECTORIZE.getByIds(sample.results.map(r => r.id));
    missing = sample.results.length - (found?.length ?? 0);
  }
  console.log(`compaction: consistency d1=${d1} vectorize=${vec} drift=${drift.toFixed(5)} sampled_missing=${missing}`);
  return drift;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

export const ALL_KINDS: readonly MemoryKind[] = MEMORY_KINDS;
