// plugin/script.js
// Komari plugin: IP quality (ip-quality). Runs the IPQuality script on the nodes through the
// Komari agent, keeps a compact snapshot and serves it to themes and pages.

const server = require("server");
const probeLib = require("./lib/probe.js");

let mgr = null;
let startTimer = null;

function sendJSON(res, code, payload) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

function isAdministrator(req) {
  const ctx = req && req.context;
  return Boolean(ctx && (ctx.role === "admin" || (ctx.principal && Array.isArray(ctx.principal.roles) && ctx.principal.roles.indexOf("admin") >= 0)));
}

function load() {
  mgr = probeLib.createProbeManager(server);
  mgr.loadSnapshotFromDisk();

  // Public read path. Hidden nodes and error details are removed for non-admins.
  server.route("GET", "/api/plugin/ip-quality/snapshot", async (req, res) => {
    try { await mgr.refreshMeta(); }
    catch (e) { return sendJSON(res, 503, { status: "error", message: "Unable to verify node visibility" }); }
    sendJSON(res, 200, { status: "success", data: mgr.view(isAdministrator(req)) });
  });

  // Admin write path: start a check (optionally for some nodes) or cancel the running one.
  server.route("POST", "/api/plugin/ip-quality/probe", async (req, res) => {
    if (!isAdministrator(req)) return sendJSON(res, 403, { status: "error", message: "Administrator role required" });
    let body = {};
    if (req && req.body) {
      try { body = JSON.parse(req.body); } catch (_) { return sendJSON(res, 400, { status: "error", message: "Invalid JSON body" }); }
      if (!body || typeof body !== "object" || Array.isArray(body)) return sendJSON(res, 400, { status: "error", message: "Expected an object" });
    }
    if (body.cancel) return sendJSON(res, 200, { status: "success", data: { cancelled: mgr.cancel() } });
    if (body.clients !== undefined && (!Array.isArray(body.clients) || body.clients.some((u) => typeof u !== "string"))) {
      return sendJSON(res, 400, { status: "error", message: "clients must be an array of node UUIDs" });
    }
    const r = await mgr.trigger({ clients: body.clients, reason: "manual" });
    sendJSON(res, r.triggered || r.reason === "already_running" ? 200 : 503, { status: r.triggered || r.reason === "already_running" ? "success" : "error", message: r.message || r.reason, data: r });
  });

  server.registerRPC("ipQuality:getSnapshot", () => mgr.view(true));

  startTimer = setTimeout(async () => {
    if (!mgr) return;
    try { await mgr.start(); } catch (e) { console.warn("[ip-quality] startup error: " + (e && e.message ? e.message : e)); }
  }, 800);

  console.info("[ip-quality] plugin loaded");
}

function unload() {
  if (startTimer) { clearTimeout(startTimer); startTimer = null; }
  if (mgr) { mgr.shutdown(); mgr = null; }
  console.info("[ip-quality] plugin unloaded");
}
