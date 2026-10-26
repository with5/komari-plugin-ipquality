const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { normalizeConfig, buildRemoteCommand, createProbeManager } = require("../plugin/lib/probe.js");

const report = fs.readFileSync(path.join(__dirname, "fixtures", "report-v4.json"), "utf8");

test("config defaults are conservative", () => {
  const c = normalizeConfig({});
  assert.deepEqual(c, { ipMode: "0", cronSpec: "0 4 * * *", installDeps: false, targetNodes: [], maxNodes: 3, autoProbeMissing: true });
  assert.equal(normalizeConfig({ ip_mode: "9" }).ipMode, "0");
  assert.equal(normalizeConfig({ max_nodes: 999 }).maxNodes, 20);
  assert.deepEqual(normalizeConfig({ target_nodes: '["a","b"]' }).targetNodes, ["a", "b"]);
});

test("the node command never uploads the report and only installs packages on opt-in", () => {
  const off = buildRemoteCommand(normalizeConfig({}), "abc-123");
  assert.match(off, / -j -p -l en -n /);
  assert.doesNotMatch(off, / -y /);
  assert.match(off, /===IPQ4===/);
  assert.match(off, /===IPQ6===/);
  assert.doesNotMatch(off, / -f /);
  assert.match(buildRemoteCommand(normalizeConfig({ install_deps: true, ip_mode: "4" }), "abc"), / -4 -j -p -l en -y /);
  assert.doesNotMatch(buildRemoteCommand(normalizeConfig({ ip_mode: "4" }), "abc"), /===IPQ6===/);
});

test("run ids are validated before they reach the shell", () => {
  assert.throws(() => buildRemoteCommand(normalizeConfig({}), 'x"; rm -rf /'), /Invalid run ID/);
});

// Every dispatched node answers with the same report; "h" is a hidden node.
function fakeServer(online = true, extra = []) {
  const calls = [];
  let sent = [];
  return {
    calls,
    getConfig: async () => ({}),
    cron: () => {},
    call: async (m, p) => {
      calls.push([m, p]);
      if (m === "admin:listClients") return [{ uuid: "a", name: "A" }, { uuid: "h", name: "H", hidden: true }, ...extra.map((u) => ({ uuid: u, name: u }))];
      if (m === "common:getNodesLatestStatus") return Object.fromEntries(["a", "h", ...extra].map((u) => [u, { online }]));
      if (m === "admin:exec") { sent = p.clients; return { task_id: "t1" }; }
      if (m === "admin:getTaskById") return { results: sent.map((client) => ({ client, finished_at: "now", exit_code: 0, result: "===IPQ4===\n" + report + "\n===IPQ6===\nexit 1\n" })) };
    },
  };
}

test("a probe runs, stores the result and hides it from the public view of hidden nodes", async () => {
  process.chdir(fs.mkdtempSync(path.join(require("node:os").tmpdir(), "ipq-")));
  const srv = fakeServer();
  const m = createProbeManager(srv, { pollMs: 5 });
  const r = await m.trigger({});
  assert.equal(r.triggered, true);
  assert.deepEqual(srv.calls.find((c) => c[0] === "admin:exec")[1].clients, ["a", "h"]);
  await new Promise((ok) => setTimeout(ok, 80));
  const v = m.view(false);
  assert.equal(v.running, false);
  assert.equal(v.nodes.a.ipv4.asn, "3462");
  assert.equal(v.nodes.a.ipv6, null);
  assert.equal(v.activeTask, null);
  assert.equal("h" in v.nodes, false);
  assert.equal("h" in m.view(true).nodes, true);
  m.shutdown();
});

test("a failed run keeps the previous result and records the error for admins only", async () => {
  process.chdir(fs.mkdtempSync(path.join(require("node:os").tmpdir(), "ipq-")));
  const srv = fakeServer();
  const m = createProbeManager(srv, { pollMs: 5 });
  await m.trigger({});
  await new Promise((ok) => setTimeout(ok, 80));
  srv.call = ((orig) => async (method, p) => (method === "admin:getTaskById" ? { results: ["a", "h"].map((client) => ({ client, finished_at: "x", exit_code: 1, result: "Could not download the IPQuality script" })) } : orig(method, p)))(srv.call);
  await m.trigger({});
  await new Promise((ok) => setTimeout(ok, 80));
  assert.equal(m.view(false).nodes.a.ipv4.asn, "3462");
  assert.match(m.view(true).nodes.a.error, /Could not download/);
  assert.equal("error" in m.view(false).nodes.a, false);
  m.shutdown();
});

test("no online nodes means nothing is dispatched", async () => {
  process.chdir(fs.mkdtempSync(path.join(require("node:os").tmpdir(), "ipq-")));
  const srv = fakeServer(false);
  const m = createProbeManager(srv, { pollMs: 5 });
  assert.deepEqual(await m.trigger({}), { triggered: false, reason: "no_online_nodes" });
  assert.equal(srv.calls.some((c) => c[0] === "admin:exec"), false);
  m.shutdown();
});

const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
const tmp = () => process.chdir(fs.mkdtempSync(path.join(require("node:os").tmpdir(), "ipq-")));

test("a run covers every online node, a few at a time", async () => {
  tmp();
  const srv = fakeServer(true, ["c", "d", "e"]); // a h c d e = 5 nodes, batches of 3 + 2
  srv.getConfig = async () => ({ max_nodes: 3 });
  const m = createProbeManager(srv, { pollMs: 5 });
  const r = await m.trigger({});
  assert.equal(r.nodes, 5);
  assert.equal(r.batches, 2);
  await wait(250);
  const execs = srv.calls.filter((c) => c[0] === "admin:exec");
  assert.deepEqual(execs.map((c) => c[1].clients.length), [3, 2]);
  const v = m.view(true);
  assert.equal(v.running, false);
  assert.deepEqual(Object.keys(v.nodes).sort(), ["a", "c", "d", "e", "h"]);
  assert.equal(v.lastTask.finished, 5);
  m.shutdown();
});

test("nodes without a result go first, then the oldest", async () => {
  tmp();
  const srv = fakeServer(true, ["c"]);
  srv.getConfig = async () => ({ max_nodes: 1 });
  const m = createProbeManager(srv, { pollMs: 5 });
  const snap = m.loadSnapshotFromDisk();
  snap.nodes.a = { updatedAt: "2026-10-26T00:00:00Z", ipv4: null, ipv6: null };
  snap.nodes.h = { updatedAt: "2026-10-01T00:00:00Z", ipv4: null, ipv6: null };
  await m.trigger({});
  await wait(250);
  const order = srv.calls.filter((c) => c[0] === "admin:exec").map((c) => c[1].clients[0]);
  assert.deepEqual(order, ["c", "h", "a"]);
  m.shutdown();
});

test("start-up checks online nodes that have no result, once", async () => {
  tmp();
  const srv = fakeServer(true, ["c"]);
  const m = createProbeManager(srv, { pollMs: 5 });
  const snap = m.loadSnapshotFromDisk();
  snap.nodes.a = { updatedAt: "2026-10-26T00:00:00Z", ipv4: null, ipv6: null };
  await m.start();
  await wait(250);
  const sentTo = srv.calls.filter((c) => c[0] === "admin:exec").flatMap((c) => c[1].clients).sort();
  assert.deepEqual(sentTo, ["c", "h"]);
  m.shutdown();
});

test("start-up check can be switched off and skips nodes that just failed", async () => {
  tmp();
  const srv = fakeServer(true, []);
  srv.getConfig = async () => ({ auto_probe_missing: false });
  const m = createProbeManager(srv, { pollMs: 5 });
  await m.start();
  assert.equal(srv.calls.some((c) => c[0] === "admin:exec"), false);
  m.shutdown();
  tmp();
  const srv2 = fakeServer(true, []);
  const m2 = createProbeManager(srv2, { pollMs: 5 });
  const s2 = m2.loadSnapshotFromDisk();
  s2.nodes.a = { error: "x", attemptedAt: new Date().toISOString() };
  s2.nodes.h = { error: "x", attemptedAt: new Date().toISOString() };
  await m2.start();
  assert.equal(srv2.calls.some((c) => c[0] === "admin:exec"), false);
  m2.shutdown();
});
