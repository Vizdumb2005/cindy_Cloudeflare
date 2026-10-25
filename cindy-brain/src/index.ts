// Worker entry: routing, auth, static panel, queue consumer, workflow export.

import { Env, jsonError, jsonOk } from "./types";
import { CindyCore } from "./core/cindy-core";
import { MemIngestWorkflow } from "./memory/workflow";
import { handleQueue } from "./memory/ingest";
import { recall } from "./memory/recall";
import { runDailyCompaction } from "./memory/compact";

export { CindyCore, MemIngestWorkflow };

function coreStub(env: Env): DurableObjectStub {
  const id = env.CINDY.idFromName("core");
  return env.CINDY.get(id);
}

function authorized(req: Request, env: Env): boolean {
  // Cloudflare Access is assumed in front of /admin; PANEL_TOKEN is the fallback.
  const auth = req.headers.get("authorization");
  if (env.PANEL_TOKEN && auth === `Bearer ${env.PANEL_TOKEN}`) return true;
  if (req.headers.has("cf-access-jwt-assertion")) return true;
  return false;
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    void ctx;
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/healthz") {
      return jsonOk({ ok: true, version: env.BRAIN_VERSION, node_online: false });
    }

    const isProtected = path.startsWith("/api") || path.startsWith("/admin");
    if (isProtected && !authorized(req, env)) {
      return new Response("unauthorized", { status: 401 });
    }

    // API + hooks + websockets route into the CindyCore DO.
    if (path.startsWith("/api/") || path === "/hooks/telegram" || path.startsWith("/ws/")) {
      return coreStub(env).fetch(req);
    }

    // Memory routes handled directly (bindings live on the Worker).
    if (path === "/mem/search" && req.method === "POST") {
      const { query, kinds, k, since, task_id, session_id } = await req.json() as Record<string, any>;
      const hits = await recall(env, String(query ?? ""), { kinds, k, since, task_id, session_id });
      return jsonOk({ hits });
    }
    if (path === "/mem/remember" && req.method === "POST") {
      const { text, kind } = await req.json() as { text: string; kind?: string };
      if (!text) return jsonError("text required");
      await env.QUEUE.send({
        type: "manual", source_id: `manual:${crypto.randomUUID()}`,
        text, meta: { kind: (kind as "semantic") ?? "semantic", ts: Date.now() },
      });
      return jsonOk({ ok: true });
    }
    if (path === "/mem/forget" && req.method === "POST") {
      const { id } = await req.json() as { id: string };
      await env.DB.prepare("UPDATE chunks SET deleted = 1 WHERE id = ?").bind(id).run();
      return jsonOk({ ok: true });
    }
    if (path === "/mem/seed" && req.method === "POST") {
      const { seed } = await import("../scripts/seed");
      return jsonOk(await seed(env));
    }
    if (path === "/mem/compact" && req.method === "POST") {
      const report = await runDailyCompaction(env);
      return jsonOk(report);
    }
    if (path === "/artifacts/url" && req.method === "POST") {
      return jsonOk({ ok: true, method: "PUT", url: "/artifacts/proxy", note: "panel PUT proxy; nodes use S3 presigned with R2_S3 keys" });
    }
    if (path === "/artifacts/proxy" && req.method === "PUT") {
      const name = url.searchParams.get("name") ?? "unnamed";
      if (name.includes("..")) return jsonError("bad name");
      const body = await req.arrayBuffer();
      if (body.byteLength > 256 * 1024 * 1024) return jsonError("too large", 413);
      const key = `artifacts/${Date.now()}/${name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
      await env.ARTIFACTS.put(key, body);
      await env.DB.prepare(
        "INSERT INTO artifacts (r2_key, kind, size, sha256, uploaded_at, cycle_id, ingested) VALUES (?, 'upload', ?, NULL, ?, NULL, 0) " +
        "ON CONFLICT(r2_key) DO NOTHING",
      ).bind(key, body.byteLength, Date.now()).run();
      return jsonOk({ ok: true, r2_key: key });
    }

    if (path === "/" || path.startsWith("/admin")) {
      return env.ASSETS.fetch(req);
    }

    return new Response("not found", { status: 404 });
  },

  async queue(batch: MessageBatch<any>, env: Env, ctx: ExecutionContext): Promise<void> {
    await handleQueue(batch, env, ctx);
  },
};
