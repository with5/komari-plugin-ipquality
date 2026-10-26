// plugin/lib/parser.js
// Turns the output of the IPQuality script (https://github.com/xykt/IPQuality, run with -j/-o *.json)
// into the compact record the plugin stores and serves. The script itself is never bundled;
// only its JSON output is read. Media-unlock results are dropped on purpose (unlock-test covers them).

const FACTORS = ["Proxy", "VPN", "Tor", "Server", "Abuser", "Robot"];
const MAIL_KEYS = ["Port25", "Gmail", "Outlook", "Yahoo", "Apple", "QQ", "MailRU", "AOL", "GMX", "MailCOM", "163", "Sohu", "Sina"];

function stripAnsi(s) {
  return String(s || "").replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
}

// The report masks the address already; mask again in case the script was run with -f.
function maskIP(ip) {
  const s = String(ip || "").trim();
  if (!s) return "";
  if (s.indexOf("*") >= 0) return s;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return s.split(".").slice(0, 2).join(".") + ".*.*";
  if (s.indexOf(":") >= 0) return s.split(":").slice(0, 3).join(":") + ":*:*";
  return "";
}

// "0.47%" -> 0.47, "null" / "" / garbage -> null
function score(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).replace("%", "").trim();
  if (!s || s === "null") return null;
  const n = Number(s);
  return isFinite(n) ? n : null;
}

const text = (v) => (v === null || v === undefined || v === "null" ? "" : String(v));

// {source: true|false|null} -> {hit, total, sources:[names that said true]}
function factor(map) {
  const sources = [];
  let total = 0;
  Object.keys(map || {}).forEach(function (k) {
    if (map[k] === true || map[k] === false) {
      total++;
      if (map[k] === true) sources.push(k);
    }
  });
  return { hit: sources.length, total: total, sources: sources };
}

// One stack's JSON object -> record, or null when it does not look like a report.
function normalizeReport(obj) {
  if (!obj || typeof obj !== "object" || !obj.Info || !obj.Head) return null;
  const info = obj.Info, scores = {}, usage = {};
  Object.keys(obj.Score || {}).forEach(function (k) { scores[k] = score(obj.Score[k]); });
  Object.keys((obj.Type && obj.Type.Usage) || {}).forEach(function (k) {
    const v = text(obj.Type.Usage[k]);
    if (v) usage[k] = v;
  });
  const factors = {};
  FACTORS.forEach(function (f) { factors[f.toLowerCase()] = factor(obj.Factor && obj.Factor[f]); });
  const mail = obj.Mail || {}, mailOut = {};
  MAIL_KEYS.forEach(function (k) { if (typeof mail[k] === "boolean") mailOut[k] = mail[k]; });
  const bl = mail.DNSBlacklist || {};
  return {
    ip: maskIP(obj.Head.IP),
    version: text(obj.Head.Version),
    checkedAt: text(obj.Head.Time),
    asn: text(info.ASN),
    org: text(info.Organization),
    country: text(info.Region && info.Region.Code),
    countryName: text(info.Region && info.Region.Name),
    registered: text(info.RegisteredRegion && info.RegisteredRegion.Code),
    city: text(info.City && info.City.Name),
    timezone: text(info.TimeZone),
    geo: text(info.Type),
    usage: usage,
    scores: scores,
    factors: factors,
    mail: mailOut,
    blacklist: { total: Number(bl.Total) || 0, clean: Number(bl.Clean) || 0, marked: Number(bl.Marked) || 0, blacklisted: Number(bl.Blacklisted) || 0 },
  };
}

// First top-level JSON object in a string (the script may print banners around it).
function extractJSON(s) {
  const t = stripAnsi(s);
  for (let i = t.indexOf("{"); i >= 0; i = t.indexOf("{", i + 1)) {
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < t.length; j++) {
      const c = t[j];
      if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        try { return JSON.parse(t.slice(i, j + 1)); } catch (_) { break; }
      }
    }
  }
  return null;
}

// Task output holds one section per stack: "===IPQ4===" / "===IPQ6===" markers followed by the JSON.
function parseTaskOutput(raw) {
  const out = { ipv4: null, ipv6: null };
  const parts = String(raw || "").split(/^===IPQ([46])===\s*$/m);
  for (let i = 1; i < parts.length; i += 2) {
    const rec = normalizeReport(extractJSON(parts[i + 1]));
    if (rec) out[parts[i] === "4" ? "ipv4" : "ipv6"] = rec;
  }
  return out;
}

module.exports = { stripAnsi, maskIP, score, normalizeReport, extractJSON, parseTaskOutput };
