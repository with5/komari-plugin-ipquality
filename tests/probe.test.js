const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { normalizeConfig, buildRemoteCommand, createProbeManager } = require("../plugin/lib/probe.js");

const report = fs.readFileSync(path.join(__dirname, "fixtures", "report-v4.json"), "utf8");

test("config defaults are conservative", () => {
  const c = normalizeConfig({});
  assert.deepEqual(c, { ipMode: "0", cronSpec: "0 4 * * *", installDeps: false, targetNodes: [], maxNodes: 3 });
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
function fakeServer(online = true) {
  const calls = [];
  let sent = [];
  return {
    calls,
    getConfig: async () => ({}),
    cron: () => {},
    call: async (m, p) => {
      calls.push([m, p]);
      if (m === "admin:listClients") return [{ uuid: "a", name: "A" }, { uuid: "h", name: "H", hidden: true }];
      if (m === "common:getNodesLatestStatus") return { a: { online }, h: { online } };
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
