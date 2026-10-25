#!/usr/bin/env node
// tests/node-sim.mjs — simulated Cindy hands node for acceptance tests.
// Usage: node tests/node-sim.mjs <CINDY_URL> <BOOTSTRAP_TOKEN> [--auto-approve <PANEL_TOKEN>]
// Scenarios (env SCENARIO): pair | task | crash | park | all (default: all sequential)

import { randomUUID } from "node:crypto";

const url = (process.argv[2] ?? "ws://localhost:8787").replace(/\/+$/, "");
const token = process.argv[3] ?? process.env.CINDY_NODE_BOOTSTRAP_TOKEN ?? "";
const panelToken = process.env.PANEL_TOKEN ?? "";
const SCENARIO = process.env.SCENARIO ?? "all";
const DEVICE_ID = process.env.DEVICE_ID ?? `sim-${randomUUID().slice(0, 8)}`;

const openWs = () => new WebSocket(`${url}/ws/node`);
let sock;
let expectedCycleEnd = null;

function sendFrame(type, payload) {
  sock.send(JSON.stringify({ v: 1, id: randomUUID(), type, ts: Date.now(), payload }));
}

async function api(path, opts = {}) {
  return fetch(`${url.replace("ws", "http")}${path}`, {
    ...opts,
    headers: { "content-type": "application/json", ...(panelToken ? { authorization: `Bearer ${panelToken}` } : {}) },
  });
}

async function approvePairing() {
  const res = await api(`/api/nodes/${DEVICE_ID}/pair`, { method: "POST" });
  console.log("[sim] pair approval:", res.status);
}

async function hello() {
  sendFrame("node.hello", {
    device_id: DEVICE_ID,
    token,
    caps: ["shell", "browser", "files"],
    cycle_id: "sim-cycle-1",
    meta: { kaggle_session: "sim", started_at: Date.now(), tools: ["sim"] },
  });
}

async function runTaskFlow() {
  // create a task via API, wait for task.claim, emit progress + result
  const created = await (await api("/api/tasks", {
    method: "POST",
    body: JSON.stringify({
      title: "sim: report uname",
      goal: "run uname -a and report the kernel version",
      steps: ["run uname -a", "extract kernel version"],
      acceptance: ["output contains a kernel version string"],
      estimated_minutes: 5,
      requires_caps: ["shell"],
    }),
  })).json();
  console.log("[sim] task created:", created.id);
  // The brain offers the task via task.claim; handler below acks it.
}

const frames = {
  onClaim(payload) {
    console.log("[sim] claimed task:", payload.task_id);
    sendFrame("task.progress", { task_id: payload.task_id, step: 1, note: "running uname", artifacts: [] });
    setTimeout(() => {
      sendFrame("task.result", {
        task_id: payload.task_id,
        status: "done",
        output: "Linux kaggle 5.15 x86_64 GNU/Linux",
        artifact_keys: [],
        idempotency_key: `sim-result:${payload.task_id}`,
      });
    }, 500);
  },
  onCmd(payload) {
    if (payload.op === "shell.run") {
      sendFrame("cmd.ack", { id: payload.id, ok: true, result: { ok: true, stdout: "Linux kaggle 5.15 x86_64\n" } });
    } else if (payload.op === "file.push" && String(payload.args?.name ?? "").startsWith("state/park/")) {
      sendFrame("cmd.ack", { id: payload.id, ok: true, result: { ok: true } });
      sendFrame("event", { type: "park.done", task_id: String(payload.args.name).split("/")[2] });
    } else {
      sendFrame("cmd.ack", { id: payload.id, ok: true, result: { ok: true, note: "sim" } });
    }
  },
};

async function main() {
  sock = openWs();
  sock.on("open", async () => {
    console.log("[sim] connected, hello as", DEVICE_ID);
    hello();
  });
  sock.on("message", async (raw) => {
    const f = JSON.parse(String(raw));
    const p = f.payload ?? {};
    switch (f.type) {
      case "node.hello.ok":
        console.log("[sim] PAIRED ✓  resync open_tasks:", (p.open_tasks ?? []).length);
        expectedCycleEnd = p.expected_cycle_end;
        if (SCENARIO === "all" || SCENARIO === "task") await runTaskFlow();
        if (SCENARIO === "crash") {
          console.log("[sim] crashing without notice…");
          process.exit(1);
        }
        if (SCENARIO === "park") {
          sendFrame("event", { type: "cycle.tminus30", ts: Date.now() });
        }
        break;
      case "resync":
        // reconnect path: reconcile; simulate resume-from-park for parked tasks
        for (const t of p.open_tasks ?? []) {
          console.log("[sim] resync sees task", t.id, t.status);
        }
        break;
      case "node.pair_required":
        console.log("[sim] pair_required — approving via panel API");
        await approvePairing();
        setTimeout(hello, 1000);
        break;
      case "task.claim":
        frames.onClaim(p);
        break;
      case "cmd":
        frames.onCmd(p);
        break;
      default:
        break;
    }
  });
  sock.on("close", () => console.log("[sim] closed"));
}

main();
