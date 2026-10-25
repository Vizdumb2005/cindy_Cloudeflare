// Cindy Brain control panel — plain JS, no build step.
const $ = (s, el = document) => el.querySelector(s);
const token = localStorage.getItem("cindy_panel_token") ?? "";
async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(opts.headers || {}) },
  });
  if (res.status === 401) { const t = prompt("Panel token?"); if (t) { localStorage.setItem("cindy_panel_token", t); location.reload(); } throw new Error("unauthorized"); }
  return res.json();
}

// --- pane switching ---
document.querySelectorAll("nav button").forEach(b => b.addEventListener("click", () => {
  document.querySelectorAll("nav button").forEach(x => x.classList.remove("active"));
  document.querySelectorAll(".pane").forEach(x => x.classList.remove("active"));
  b.classList.add("active");
  $("#" + b.dataset.pane).classList.add("active");
  ({ tasks: loadTasks, node: loadNode, memory: loadMemory, skills: loadSkills, watchdog: loadWatchdog, pairing: loadPairing }[b.dataset.pane] || (() => {}))();
}));

// --- chat ---
let sessionId = null;
async function loadSessions() {
  const data = await api("/api/sessions");
  const list = $("#session-list");
  list.innerHTML = "";
  for (const s of data || []) {
    const el = document.createElement("div");
    el.className = "session" + (s.id === sessionId ? " active" : "");
    el.textContent = s.title || s.id.slice(0, 8);
    el.onclick = async () => { sessionId = s.id; await loadSessions(); await loadMessages(); };
    list.appendChild(el);
  }
}
async function loadMessages() {
  const data = await api("/api/messages?session_id=" + encodeURIComponent(sessionId || ""));
  const log = $("#chat-log");
  log.innerHTML = "";
  for (const m of data || []) {
    const el = document.createElement("div");
    el.className = "msg " + m.role;
    el.textContent = (m.role === "user" ? "You: " : "Cindy: ") + m.content;
    log.appendChild(el);
  }
  log.scrollTop = log.scrollHeight;
}
$("#chat-form").addEventListener("submit", async e => {
  e.preventDefault();
  const text = $("#chat-input").value.trim();
  if (!text) return;
  $("#chat-input").value = "";
  const log = $("#chat-log");
  const el = document.createElement("div");
  el.className = "msg user";
  el.textContent = "You: " + text;
  log.appendChild(el);
  const res = await api("/api/chat", { method: "POST", body: JSON.stringify({ session_id: sessionId, message: text }) });
  sessionId = res.session_id;
  const r = document.createElement("div");
  r.className = "msg assistant";
  r.textContent = "Cindy: " + (res.reply ?? "(error)");
  log.appendChild(r);
  log.scrollTop = log.scrollHeight;
  loadSessions();
});

// --- tasks ---
async function loadTasks() {
  const tasks = (await api("/api/tasks")) || [];
  const cols = ["queued", "claimed", "running", "done", "failed", "cancelled"];
  const pane = $("#tasks");
  pane.innerHTML = '<div class="board">' + cols.map(c => `<div class="col"><h3>${c}</h3><div data-col="${c}"></div></div>`).join("") + "</div>";
  for (const t of tasks) {
    const el = document.createElement("div");
    el.className = "task";
    el.innerHTML = `<b>${t.title || t.id}</b> <span class="badge">${t.status}</span>` +
      (t.review_json ? `<div><small>review: ${JSON.stringify(JSON.parse(t.review_json).note || "")}</small></div>` : "") +
      `<div class="actions">${["queued","failed","cancelled"].includes(t.status) ? `<button onclick="act('${t.id}','retry')">retry</button>` : ""}` +
      `${["claimed","running","queued"].includes(t.status) ? `<button class="ghost" onclick="act('${t.id}','cancel')">cancel</button>` : ""}</div>`;
    pane.querySelector(`[data-col="${t.status}"]`).appendChild(el);
  }
}
window.act = async (id, action) => { await api(`/api/tasks/${id}/action`, { method: "POST", body: JSON.stringify({ action }) }); loadTasks(); };

// --- node card ---
async function loadNode() {
  const s = await api("/api/watchdog/status");
  const n = (await api("/api/nodes")) || [];
  $("#node").innerHTML = `<div class="card">
    <h2>Hands node <span class="badge ${s.node}">${s.node}</span></h2>
    ${n.map(x => `<p><b>${x.device_id.slice(0, 8)}</b> — paired:${x.paired} status:${x.status} cycle:${x.cycle_id ?? "—"} last_seen:${x.last_seen ? new Date(x.last_seen).toLocaleString() : "—"}</p>`).join("") || "<p>No devices registered.</p>"}
    <p>watchdog paused: ${s.paused ? "yes" : "no"} · last dispatch: ${s.last_dispatch ? new Date(s.last_dispatch).toLocaleString() : "never"}</p>
    <button class="ghost" onclick="api('/api/watchdog/tick').then(loadNode)">Run watchdog tick</button>
  </div>`;
}

// --- memory ---
async function loadMemory() {
  $("#memory").innerHTML = `<div class="card">
    <h2>Memory</h2>
    <form id="mem-search"><input type="text" name="q" placeholder="Search memory…" /> <button>Search</button></form>
    <div>${["semantic","episodic","procedural","artifact","working"].map(k => `<span class="chip" data-kind="${k}">${k}</span>`).join("")}</div>
    <div id="mem-results"></div>
    <form id="mem-add"><input type="text" name="text" placeholder="Remember something…" /><button>Remember</button></form>
  </div>`;
  $("#mem-search").addEventListener("submit", async e => {
    e.preventDefault();
    const kinds = [...document.querySelectorAll(".chip.active")].map(c => c.dataset.kind);
    const q = e.target.q.value;
    const data = await api("/mem/search", { method: "POST", body: JSON.stringify({ query: q, kinds: kinds.length ? kinds : undefined }) });
    $("#mem-results").innerHTML = (data.hits || []).map(h =>
      `<div class="hit"><b>[${h.kind}]</b> ${h.text}<br /><small>from: ${h.source ?? "?"} · ${new Date(h.ts).toLocaleString()} · score ${h.score.toFixed(2)} · <a href="#" onclick="forget('${h.id}')">forget</a></small></div>`).join("") || "<p>no hits</p>";
  });
  document.querySelectorAll(".chip").forEach(c => c.addEventListener("click", () => c.classList.toggle("active")));
  $("#mem-add").addEventListener("submit", async e => {
    e.preventDefault();
    await api("/mem/remember", { method: "POST", body: JSON.stringify({ text: e.target.text.value, kind: "semantic" }) });
    e.target.text.value = "";
  });
}
window.forget = async id => { await api("/mem/forget", { method: "POST", body: JSON.stringify({ id }) }); };

// --- skills ---
async function loadSkills() {
  $("#skills").innerHTML = `<div class="card"><h2>Skills</h2><p>Skills are markdown files under <code>skills/</code> in the cindy-artifacts R2 bucket. They are created automatically when a task post-mortem looks like a reusable how-to, and can be edited with any S3 client using the R2 token keys.</p><button class="ghost" onclick="loadSkills()">Refresh</button></div>`;
}

// --- watchdog ---
async function loadWatchdog() {
  const s = await api("/api/watchdog/status");
  $("#watchdog").innerHTML = `<div class="card">
    <h2>Watchdog <span class="badge ${s.paused ? "offline" : "online"}">${s.paused ? "paused" : "active"}</span></h2>
    <button onclick="togglePause()">${s.paused ? "Resume" : "Pause"}</button>
  </div><div class="card">${(s.log || []).map(l => `<div class="log-line">${new Date(l.ts).toISOString()} ${l.event} ${l.detail_json || ""}</div>`).join("") || "no events"}</div>`;
}
window.togglePause = async () => { await api("/api/pause", { method: "POST" }); loadWatchdog(); };

// --- pairing ---
async function loadPairing() {
  const n = (await api("/api/nodes")) || [];
  $("#pairing").innerHTML = `<div class="card"><h2>Pairing queue</h2>` +
    (n.map(x => `<p><b>${x.device_id.slice(0, 8)}</b> paired:${x.paired} status:${x.status} ${!x.paired ? `<button onclick="pair('${x.device_id}')">Approve</button>` : ""}</p>`).join("") || "<p>No pending devices.</p>") + "</div>";
}
window.pair = async id => { await api(`/api/nodes/${id}/pair`, { method: "POST" }); loadPairing(); };

// --- live updates over panel WS ---
const ws = new WebSocket(location.origin.replace("http", "ws") + "/ws/panel");
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.type === "chat.done") loadSessions();
  if (m.type?.startsWith("task.")) { const active = document.querySelector("nav button.active")?.dataset.pane; if (active === "tasks") loadTasks(); }
  if (m.type === "watchdog_log") { const active = document.querySelector("nav button.active")?.dataset.pane; if (active === "watchdog") loadWatchdog(); }
};

loadSessions();
