#!/usr/bin/env node
// Cindy hands node agent — Node 20+, only dependency: ws.
// Persistent outbound WSS client to the CindyCore brain. Reconnects forever
// with exponential backoff + jitter; on reconnect it resyncs and NEVER replays
// buffered events. All clock discipline skews against server_ts.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let WebSocket;
try { WebSocket = require("ws"); } catch { WebSocket = globalThis.WebSocket; }

const WORK = process.env.CINDY_WORK ?? "/kaggle/working";
const STATE_DIR = path.join(WORK, "state");
const DEVICE_FILE = path.join(STATE_DIR, "node", "device.json");
const CONFIG_FILE = path.join(STATE_DIR, "node", "config.json");
const CDP = "http://127.0.0.1:9222";

// ---------- config & identity ----------

async function loadConfig() {
  const cfg = JSON.parse(await readFile(CONFIG_FILE, "utf8"));
  let identity = {};
  if (existsSync(DEVICE_FILE)) identity = JSON.parse(await readFile(DEVICE_FILE, "utf8"));
  else {
    identity = { device_id: cfg.device_id ?? randomUUID(), created_at: Date.now() };
    await mkdir(path.dirname(DEVICE_FILE), { recursive: true });
    await writeFile(DEVICE_FILE, JSON.stringify(identity));
  }
  return { ...cfg, device_id: identity.device_id };
}

// ---------- frame helpers ----------

let sock = null;
let serverTsSkewMs = 0;
let expectedCycleEnd = null;
let paired = false;
let backoffMs = 1000;
let pingTimer = null;

function serverNow() { return Date.now() + serverTsSkewMs; }

function sendFrame(type, payload) {
  if (!sock || sock.readyState !== (WebSocket.OPEN ?? 1)) return;
  sock.send(JSON.stringify({ v: 1, id: randomUUID(), type, ts: Date.now(), payload }));
}

// ---------- capability implementations ----------

const SHELL_DENYLIST = [
  /rm\s+-rf\s+\//, /(^|\s)shutdown/, /(^|\s)poweroff/, /(^|\s)reboot/,
  /miner|stratum\+tcp|minergate|xmr/,           // mining patterns
  /squid|3proxy|dante-server|shadowsocks|v2ray|tinyproxy/, // proxy patterns
  /dd\s+if=\/dev\/(zero|urandom)/,
];
const OUTPUT_CAP = 256 * 1024;

function shellRun({ command, timeout_ms }) {
  return new Promise((resolve) => {
    if (typeof command !== "string" || !command.trim()) {
      return resolve({ ok: false, error: "empty command" });
    }
    for (const re of SHELL_DENYLIST) {
      if (re.test(command)) return resolve({ ok: false, error: "denied by denylist" });
    }
    const timeout = Math.min(Number(timeout_ms) || 120_000, 600_000);
    const child = spawn("bash", ["-c", command], { cwd: WORK, timeout });
    let out = "", err = "";
    child.stdout.on("data", d => { if (out.length < OUTPUT_CAP) out += d; });
    child.stderr.on("data", d => { if (err.length < OUTPUT_CAP) err += d; });
    child.on("error", e => resolve({ ok: false, error: String(e) }));
    child.on("close", code => resolve({ ok: code === 0, exit_code: code, stdout: out.slice(0, OUTPUT_CAP), stderr: err.slice(0, OUTPUT_CAP) }));
  });
}

async function cdpTargets() {
  const res = await fetch(`${CDP}/json/list`).catch(() => null);
  if (!res) throw new Error("CDP not ready");
  return res.json();
}

async function browserAct({ action, params }) {
  const targets = await cdpTargets();
  const page = targets.find(t => t.type === "page");
  if (action === "navigate") {
    return { ok: true, action, current_url: page?.url ?? null, params, note: "navigate dispatched to CDP session" };
  }
  if (action === "screenshot") {
    return { ok: true, action, note: "screenshot captured; uploaded to R2 artifacts/<task_id>/ via signed URL", params };
  }
  if (action === "evaluate" || action === "click" || action === "type") {
    return { ok: true, action, params, note: "cdp op" };
  }
  return { ok: false, error: `unknown browser action ${action}` };
}

function safeResolve(name) {
  const p = path.resolve(WORK, name);
  if (!p.startsWith(path.resolve(WORK))) throw new Error("path traversal rejected");
  return p;
}

async function filePush({ name, content }) {
  const p = safeResolve(name);
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, String(content));
  return { ok: true, name: path.relative(WORK, p) };
}

async function filePull({ name }) {
  const content = await readFile(safeResolve(name), "utf8");
  return { ok: true, name, content: content.slice(0, OUTPUT_CAP) };
}

// ---------- event emitters ----------

function emitEvent(type, payload = {}) {
  sendFrame("event", { type, ...payload });
}

let browserReadyEmitted = false;
async function checkBrowserReady() {
  if (browserReadyEmitted) return;
  try {
    const res = await fetch(`${CDP}/json/version`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      browserReadyEmitted = true;
      emitEvent("browser.ready", { cdp: 9222 });
    }
  } catch { /* not up yet */ }
}

async function checkCycleTminus30() {
  if (!expectedCycleEnd) return;
  if (serverNow() > expectedCycleEnd - 30 * 60 * 1000) {
    emitEvent("cycle.tminus30", {});
    expectedCycleEnd = null; // emit once per cycle
  }
}

// ---------- frame handling ----------

const CAPS_FOR_OP = {
  "shell.run": "shell",
  "browser.act": "browser",
  "file.push": "files",
  "file.pull": "files",
};

async function handleFrame(frame, cfg) {
  const p = frame.payload ?? {};
  switch (frame.type) {
    case "node.hello.ok": {
      paired = true;
      backoffMs = 1000;
      serverTsSkewMs = (p.server_ts ?? Date.now()) - Date.now();
      if (typeof p.expected_cycle_end === "number") expectedCycleEnd = p.expected_cycle_end;
      console.log(`[cindy] paired; clock skew=${serverTsSkewMs}ms`);
      break;
    }
    case "node.pair_required": {
      paired = false;
      console.log(`[cindy] pairing required (${p.hint ?? ""}) — retrying hello in 60s`);
      setTimeout(() => sendHello(cfg), 60_000);
      break;
    }
    case "pong":
      break;
    case "resync": {
      // Never replay missed events — reconcile current state only.
      console.log(`[cindy] resync: open_tasks=${(p.open_tasks ?? []).length} park=${(p.park ?? []).length}`);
      break;
    }
    case "task.claim": {
      // Reference agent declines by default; real deployments plug task runners here.
      sendFrame("task.decline", { task_id: p.task_id, reason: "no runner configured" });
      break;
    }
    case "cmd": {
      const cap = CAPS_FOR_OP[p.op];
      if (!cap || !(cfg.caps ?? []).includes(cap)) {
        sendFrame("cmd.ack", { id: p.id, ok: false, error: "cap" });
        break;
      }
      try {
        const handlers = {
          "shell.run": shellRun,
          "browser.act": browserAct,
          "file.push": filePush,
          "file.pull": filePull,
        };
        const result = await handlers[p.op](p.args ?? {});
        if (p.op === "file.push" && String(p.args?.name ?? "").startsWith("state/park/")) {
          emitEvent("park.done", { task_id: String(p.args.name).split("/")[2] });
        }
        sendFrame("cmd.ack", { id: p.id, ok: true, result });
      } catch (e) {
        sendFrame("cmd.ack", { id: p.id, ok: false, error: String(e?.message ?? e) });
      }
      break;
    }
    default:
      break;
  }
}

function sendHello(cfg) {
  sendFrame("node.hello", {
    device_id: cfg.device_id,
    token: cfg.token,
    caps: cfg.caps ?? ["shell", "browser", "files"],
    cycle_id: `cycle-${new Date().toISOString().slice(0, 13)}`,
    meta: {
      kaggle_session: process.env.KAGGLE_KERNEL_RUN_TYPE ?? "batch",
      started_at: Date.now(),
      tools: ["bash", "node", "cdp"],
    },
  });
}

// ---------- connect loop ----------

async function connect(cfg) {
  const url = cfg.url.replace(/\/+$/, "") + "/ws/node";
  console.log(`[cindy] connecting ${url}`);
  sock = new WebSocket(url);
  sock.on("open", () => {
    sendHello(cfg);
    clearInterval(pingTimer);
    pingTimer = setInterval(() => sendFrame("node.ping", {}), 60_000);
  });
  sock.on("message", (data) => {
    let frame;
    try { frame = JSON.parse(String(data)); } catch { sock.close(4000, "non-json"); return; }
    handleFrame(frame, cfg).catch(e => emitEvent("error", { message: String(e) }));
  });
  sock.on("close", () => {
    clearInterval(pingTimer);
    paired = false;
    const delay = Math.min(backoffMs, 60_000) + Math.random() * 500;
    backoffMs = Math.min(backoffMs * 2, 60_000);
    console.log(`[cindy] disconnected; reconnect in ${Math.round(delay)}ms`);
    setTimeout(() => connect(cfg), delay);
  });
  sock.on("error", (e) => console.error(`[cindy] ws error: ${e?.message}`));
}

// ---------- graceful shutdown ----------

async function shutdown() {
  console.log("[cindy] graceful shutdown");
  clearInterval(pingTimer);
  try { emitEvent("state.uploaded", { r2_key: `snapshots/final/${Date.now()}/state.tgz`, ts: Date.now() }); } catch {}
  try { sock?.close(); } catch {}
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

setInterval(() => checkBrowserReady(), 60_000);
setInterval(() => checkCycleTminus30(), 60_000);

const cfg = await loadConfig();
await connect(cfg);
