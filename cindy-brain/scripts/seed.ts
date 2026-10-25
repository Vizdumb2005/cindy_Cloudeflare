// scripts/seed.ts — 3 demo tasks + 5 demo memories.
// Run against a dev server: npx wrangler dev, then
//   curl -H "Authorization: Bearer $PANEL_TOKEN" http://localhost:8787/mem/seed
// or import seedEnv from a Workers context.

import { Env, IngestPayload, TaskSpec, uuid } from "../src/types";

const DEMO_TASKS: TaskSpec[] = [
  {
    title: "Survey repo health",
    goal: "Clone the primary repo on the hands, run tests, summarize failures.",
    steps: ["git clone", "npm ci", "npm test", "write summary"],
    acceptance: ["summary lists failing tests with root causes"],
    estimated_minutes: 30,
    requires_caps: ["shell"],
  },
  {
    title: "Screenshot landing page",
    goal: "Navigate to the marketing site and capture a full-page screenshot.",
    steps: ["open browser", "navigate", "screenshot"],
    acceptance: ["screenshot artifact exists in R2"],
    estimated_minutes: 10,
    requires_caps: ["browser"],
  },
  {
    title: "Back up dotfiles",
    goal: "Tar the home directory config files and push to R2.",
    steps: ["tar czf", "upload via signed URL"],
    acceptance: ["snapshot tarball in cindy-artifacts"],
    estimated_minutes: 15,
    requires_caps: ["shell", "files"],
  },
];

const DEMO_MEMORIES: { text: string; kind: IngestPayload["meta"]["kind"] }[] = [
  { text: "The owner prefers pnpm over npm for all JavaScript projects.", kind: "semantic" },
  { text: "The hands node runs on Kaggle CPU instances rebuilt every 11 hours.", kind: "semantic" },
  { text: "Deployment target is Cloudflare Workers with a singleton CindyCore Durable Object.", kind: "semantic" },
  { text: "Discussed the watchdog design: 15-minute staleness, 20-minute dispatch guard.", kind: "episodic" },
  { text: "How to restart the hands: GitHub Actions dispatches restart-kaggle.yml which pushes the kernel.", kind: "procedural" },
];

export async function seed(env: Env): Promise<{ tasks: number; memories: number }> {
  // tasks → CindyCore via env.CINDY
  let tasks = 0;
  for (const spec of DEMO_TASKS) {
    const stub = env.CINDY.get(env.CINDY.idFromName("core"));
    await stub.fetch("https://internal/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${env.PANEL_TOKEN ?? ""}` },
      body: JSON.stringify(spec),
    });
    tasks++;
  }
  // memories → queue
  let memories = 0;
  for (const m of DEMO_MEMORIES) {
    await env.QUEUE.send({
      type: "manual", source_id: `seed:${uuid()}`,
      text: m.text, meta: { kind: m.kind, ts: Date.now() },
    } satisfies IngestPayload);
    memories++;
  }
  return { tasks, memories };
}

// CLI usage with wrangler dev remote-ish env is not possible directly;
// the panel route /mem/seed calls seed(env).
export default seed;
