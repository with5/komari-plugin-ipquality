// plugin/lib/probe.js
// Probe scheduling and snapshot storage.
// Write path: server.cron / POST /probe -> admin:exec -> poll admin:getTaskById -> __storageDir__/snapshot.json
// Read path : memory + snapshot.json, never blocks on a node

const fs = require("fs");
const path = require("path");
const parser = require("./parser.js");

const SNAPSHOT_FILE = "snapshot.json";
const POLL_MS = 4000;
const NODE_TIMEOUT_S = 280;           // per stack, on the node
const TASK_TIMEOUT_MS = 12 * 60000;   // one batch, as seen by the plugin
const RETRY_MS = 6 * 3600e3;          // a node that just failed is not retried by the start-up check

const snapshotPath = () => path.join(typeof __storageDir__ === "string" && __storageDir__ ? __storageDir__ : ".", SNAPSHOT_FILE);
const errText = (e) => (e && e.message ? e.message : String(e));

function normalizeConfig(raw) {
  const cfg = raw || {};
  const mode = String(cfg.ip_mode !== undefined ? cfg.ip_mode : "0").trim();
  let targets = [];
  if (Array.isArray(cfg.target_nodes)) targets = cfg.target_nodes.filter(Boolean);
  else if (typeof cfg.target_nodes === "string" && cfg.target_nodes.trim()) {
    try { const a = JSON.parse(cfg.target_nodes); if (Array.isArray(a)) targets = a.filter(Boolean); } catch (_) {}
  }
  return {
    ipMode: mode === "4" || mode === "6" ? mode : "0",
    cronSpec: String(cfg.cron_spec || "0 4 * * *").trim() || "0 4 * * *",
    installDeps: cfg.install_deps === true || cfg.install_deps === "true",
    targetNodes: targets,
    // nodes checked at the same time; a run walks through all nodes in batches of this size
    maxNodes: Math.max(1, Math.min(20, Math.floor(Number(cfg.max_nodes) || 3))),
    autoProbeMissing: cfg.auto_probe_missing !== false && cfg.auto_probe_missing !== "false",
  };
}

function validateRunId(id) {
  if (typeof id !== "string" || !/^[a-zA-Z0-9-]{1,100}$/.test(id)) throw new Error("Invalid run ID");
  return id;
}

// Shell command run on the node by the Komari agent.
//  -p  privacy mode: the script must not upload the report to check.place
//  -l en, -j, -o  English, JSON, written to a private file we cat back
//  -n  do not install packages (default); -y only when the admin opted in
function buildRemoteCommand(cfg, runId) {
  validateRunId(runId);
  const stacks = cfg.ipMode === "0" ? ["4", "6"] : [cfg.ipMode];
  const dep = cfg.installDeps ? "-y" : "-n";
  const lines = [
    'export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$HOME/.local/bin:$PATH"',
    "export TERM=dumb NO_COLOR=1",
    "umask 077",
    'RUN_DIR="/tmp/km-ipq-' + runId + '"',
    'mkdir "$RUN_DIR" || { echo "Run directory already exists"; exit 1; }',
    'LOCK="/tmp/km-ipq-$(id -u).lock"',
    'if ! mkdir "$LOCK" 2>/dev/null; then echo "Another IP quality check is running"; rm -rf "$RUN_DIR"; exit 75; fi',
    "trap 'rmdir \"$LOCK\" 2>/dev/null; rm -rf \"$RUN_DIR\"' EXIT",
    'SCRIPT="$RUN_DIR/ip.sh"',
    'if ! { curl -fsSL --connect-timeout 8 -m 30 https://IP.Check.Place -o "$SCRIPT" || wget -q -T 8 https://IP.Check.Place -O "$SCRIPT"; } || [ ! -s "$SCRIPT" ]; then echo "Could not download the IPQuality script"; exit 1; fi',
    "TMO=''; command -v timeout >/dev/null 2>&1 && TMO='timeout -k 5 " + NODE_TIMEOUT_S + "'",
    "OK=''",
  ];
  stacks.forEach(function (v) {
    lines.push(
      'echo "===IPQ' + v + '==="',
      '$TMO bash "$SCRIPT" -' + v + " -j -p -l en " + dep + ' -o "$RUN_DIR/r' + v + '.json" </dev/null >"$RUN_DIR/r' + v + '.log" 2>&1; rc=$?',
      'if [ -s "$RUN_DIR/r' + v + '.json" ]; then OK=1; cat "$RUN_DIR/r' + v + '.json"; else echo "exit $rc"; tail -c 600 "$RUN_DIR/r' + v + '.log"; fi'
    );
  });
  lines.push('[ -n "$OK" ]');
  return lines.join("\n");
}

function createProbeManager(server, opts) {
  const pollMs = (opts && opts.pollMs) || POLL_MS;
  let mem = null, pollTimer = null, unloaded = false, dispatching = false, cronOn = false, meta = null;

  const emptySnap = () => ({ schemaVersion: 1, updatedAt: null, activeTask: null, lastTask: null, nodes: {}, lastError: null });

  function load() {
    if (mem) return mem;
    try {
      const p = snapshotPath();
      if (fs.existsSync(p)) {
        const j = JSON.parse(fs.readFileSync(p, "utf8"));
        if (j && typeof j === "object") { mem = Object.assign(emptySnap(), j); mem.nodes = mem.nodes || {}; return mem; }
      }
    } catch (e) { console.warn("[ip-quality] cannot read snapshot: " + errText(e)); }
    mem = emptySnap();
    return mem;
  }
  function save(snap) {
    mem = snap;
    try {
      const p = snapshotPath(), dir = path.dirname(p);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(p + ".tmp", JSON.stringify(snap));
      fs.renameSync(p + ".tmp", p);
    } catch (e) { console.error("[ip-quality] cannot write snapshot: " + errText(e)); }
  }
  function stopPoll() { if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; } }

  async function refreshMeta() {
    const clients = await server.call("admin:listClients");
    if (!Array.isArray(clients)) throw new Error("Invalid client list");
    const m = {};
    clients.forEach(function (c) { if (c && c.uuid) m[c.uuid] = { name: c.name || c.uuid, group: c.group || "", hidden: Boolean(c.hidden) }; });
    meta = m;
    const snap = load();
    Object.keys(snap.nodes).forEach(function (u) { if (!m[u]) delete snap.nodes[u]; });
    return m;
  }

  async function targets(cfg, requested) {
    const m = await refreshMeta();
    if (Array.isArray(requested)) return requested.filter(function (u, i, a) { return typeof u === "string" && m[u] && a.indexOf(u) === i; });
    let status = {};
    try { status = (await server.call("common:getNodesLatestStatus")) || {}; } catch (e) { console.warn("[ip-quality] cannot read node status: " + errText(e)); }
    const pool = cfg.targetNodes.length ? cfg.targetNodes : Object.keys(m);
    return pool.filter(function (u) { return m[u] && status[u] && status[u].online === true; });
  }

  const isCurrent = (task) => !unloaded && load().activeTask === task;
  const pending = (task) => task.clients.filter(function (u) { return !task.done[u]; });

  // Nodes that never produced a result first, then the one checked longest ago.
  function byPriority(uuids) {
    const nodes = load().nodes;
    const at = function (u) { const n = nodes[u]; return n && n.updatedAt ? Date.parse(n.updatedAt) : 0; };
    return uuids.slice().sort(function (x, y) { return at(x) - at(y); });
  }

  function failPending(task, error) {
    const snap = load(), now = new Date().toISOString();
    pending(task).forEach(function (u) {
      const old = snap.nodes[u] || {};
      snap.nodes[u] = Object.assign({}, old, { error: error || "Agent returned no result", attemptedAt: now });
      task.done[u] = true;
      task.failed = (task.failed || 0) + 1;
    });
  }

  function finish(task, error) {
    if (!isCurrent(task)) return;
    const snap = load(), now = new Date().toISOString();
    failPending(task, error);
    task.finished = Math.min(task.total, (task.finished || 0) + task.clients.length);
    task.finishedAt = now;
    task.error = error || (task.failed ? task.failed + " node(s) failed" : null);
    snap.lastTask = task;
    snap.activeTask = null;
    snap.updatedAt = now;
    snap.lastError = task.error;
    stopPoll();
    save(snap);
  }

  // Sends the next batch of the queue to the agents; the queue is walked a few nodes at a time
  // so a small VPS never runs several heavy checks and the whole fleet still gets covered.
  async function dispatchBatch(task) {
    const batch = task.queue.splice(0, task.batchSize);
    const runId = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 12);
    const resp = await server.call("admin:exec", { command: buildRemoteCommand(task.cfg, runId), clients: batch });
    const taskId = resp && resp.task_id ? String(resp.task_id) : "";
    if (!taskId) throw new Error("admin:exec returned no task_id");
    task.taskId = taskId;
    task.runId = runId;
    task.clients = batch;
    task.done = {};
    task.deadlineAt = new Date(Date.now() + TASK_TIMEOUT_MS).toISOString();
  }

  // The current batch is over (answered or timed out): start the next one or end the run.
  async function nextBatch(task, error) {
    if (!isCurrent(task)) return;
    failPending(task, error);
    task.finished = (task.finished || 0) + task.clients.length;
    if (!task.queue.length) { task.finished = task.total; return finish(task, null); }
    try {
      await dispatchBatch(task);
      if (!isCurrent(task)) return;
      save(load());
      poll(task);
    } catch (e) {
      task.clients = []; task.done = {};
      finish(task, errText(e));
    }
  }

  function apply(task, res) {
    const uuid = res.client;
    if (task.clients.indexOf(uuid) < 0 || task.done[uuid] || !res.finished_at) return;
    const snap = load(), raw = String(res.result || ""), parsed = parser.parseTaskOutput(raw), old = snap.nodes[uuid] || {}, now = new Date().toISOString();
    const ok = parsed.ipv4 || parsed.ipv6;
    let error = null;
    if (!ok) {
      const tail = parser.stripAnsi(raw).replace(/===IPQ[46]===/g, "").trim().slice(-300);
      error = "Exit " + res.exit_code + ": " + (tail || "empty output");
    }
    // a failed run keeps the previous good result
    snap.nodes[uuid] = ok
      ? { ipv4: parsed.ipv4, ipv6: parsed.ipv6, updatedAt: now, error: null }
      : Object.assign({}, old, { error: error, attemptedAt: now });
    task.done[uuid] = true;
    task.failed = (task.failed || 0) + (ok ? 0 : 1);
  }

  function poll(task) {
    stopPoll();
    if (!isCurrent(task)) return;
    pollTimer = setTimeout(async function () {
      pollTimer = null;
      if (!isCurrent(task)) return;
      try {
        const info = await server.call("admin:getTaskById", { task_id: task.taskId });
        if (!isCurrent(task)) return;
        if (!info || !Array.isArray(info.results)) throw new Error("Invalid task response");
        info.results.forEach(function (r) { apply(task, r); });
        task.pollError = null;
      } catch (e) { task.pollError = errText(e); }
      if (!isCurrent(task)) return;
      if (!pending(task).length) return nextBatch(task, null);
      if (Date.now() >= Date.parse(task.deadlineAt)) return nextBatch(task, "Timed out waiting for the agent");
      save(load());
      poll(task);
    }, pollMs);
  }

  // Starts a run over the given nodes, or over every eligible online node.
  async function trigger(opts) {
    if (unloaded) return { triggered: false, reason: "unloaded" };
    if (dispatching) return { triggered: false, reason: "already_running" };
    dispatching = true;
    try {
      const snap = load();
      if (snap.activeTask) return { triggered: false, reason: "already_running" };
      const cfg = normalizeConfig(await server.getConfig());
      const asked = opts && opts.clients;
      const uuids = Array.isArray(asked) ? await targets(cfg, asked) : byPriority(await targets(cfg));
      if (!uuids.length) return { triggered: false, reason: "no_online_nodes" };
      const task = { startedAt: new Date().toISOString(), reason: (opts && opts.reason) || "", cfg: { ipMode: cfg.ipMode, installDeps: cfg.installDeps }, batchSize: cfg.maxNodes,
        queue: uuids.slice(), total: uuids.length, finished: 0, failed: 0, clients: [], done: {} };
      await dispatchBatch(task);
      snap.activeTask = task;
      save(snap);
      poll(task);
      return { triggered: true, taskId: task.taskId, nodes: uuids.length, batches: Math.ceil(uuids.length / cfg.maxNodes) };
    } catch (e) {
      return { triggered: false, reason: "error", message: errText(e) };
    } finally {
      dispatching = false;
    }
  }

  // Online nodes with no result yet (and not just tried): they get checked on start-up.
  async function missingNodes(cfg) {
    const nodes = load().nodes, now = Date.now();
    const online = await targets(cfg);
    return online.filter(function (u) {
      const n = nodes[u];
      if (n && n.updatedAt) return false;
      return !(n && n.attemptedAt && now - Date.parse(n.attemptedAt) < RETRY_MS);
    });
  }

  // Registers the cron once, resumes a run that was in progress, and fills in nodes without a result.
  async function start() {
    const cfg = normalizeConfig(await server.getConfig());
    await refreshMeta().catch(function () {});
    if (!cronOn) {
      try {
        server.cron(cfg.cronSpec, async function () { if (!unloaded) await trigger({ reason: "cron" }); });
        cronOn = true;
      } catch (e) { console.error("[ip-quality] invalid cron: " + errText(e)); }
    }
    const t = load().activeTask;
    if (t) {
      if (Date.now() >= Date.parse(t.deadlineAt)) await nextBatch(t, "Interrupted by a plugin restart");
      else poll(t);
      return;
    }
    if (cfg.autoProbeMissing) {
      const list = await missingNodes(cfg).catch(function () { return []; });
      if (list.length) await trigger({ clients: byPriority(list), reason: "auto" });
    }
  }

  // Public: no hidden nodes, no error details. Admin: everything.
  function view(isAdmin) {
    const snap = load(), nodes = {};
    Object.keys(snap.nodes).forEach(function (u) {
      const m = meta && meta[u];
      if (!isAdmin && (!m || m.hidden)) return;
      const n = snap.nodes[u];
      nodes[u] = isAdmin ? n : { ipv4: n.ipv4 || null, ipv6: n.ipv6 || null, updatedAt: n.updatedAt || null };
    });
    const t = snap.activeTask;
    const progress = t ? { done: Math.min(t.total, (t.finished || 0) + Object.keys(t.done || {}).length), total: t.total } : null;
    return { updatedAt: snap.updatedAt, running: Boolean(t), progress: progress, nodes: nodes, lastError: isAdmin ? snap.lastError : null, activeTask: isAdmin ? t : null, lastTask: isAdmin ? snap.lastTask : null };
  }

  function cancel() {
    const t = load().activeTask;
    if (!t) return false;
    finish(t, "Cancelled");
    return true;
  }

  function shutdown() { unloaded = true; stopPoll(); }

  return { loadSnapshotFromDisk: load, refreshMeta: refreshMeta, start: start, trigger: trigger, cancel: cancel, view: view, shutdown: shutdown };
}

module.exports = { normalizeConfig, buildRemoteCommand, createProbeManager };
