const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const p = require("../plugin/lib/parser.js");

const fx = (n) => fs.readFileSync(path.join(__dirname, "fixtures", n), "utf8");

test("score parses numbers, percentages and null markers", () => {
  assert.equal(p.score("12"), 12);
  assert.equal(p.score("0.47%"), 0.47);
  assert.equal(p.score("null"), null);
  assert.equal(p.score(""), null);
  assert.equal(p.score(undefined), null);
});

test("maskIP keeps masked values and masks full addresses", () => {
  assert.equal(p.maskIP("36.235.*.*"), "36.235.*.*");
  assert.equal(p.maskIP("203.0.113.9"), "203.0.*.*");
  assert.equal(p.maskIP("2001:db8:1234:5678::1"), "2001:db8:1234:*:*");
  assert.equal(p.maskIP("not an ip"), "");
});

test("a report is normalized and media results are dropped", () => {
  const r = p.normalizeReport(JSON.parse(fx("report-v4.json")));
  assert.equal(r.ip, "36.235.*.*");
  assert.equal(r.country, "TW");
  assert.equal(r.geo, "Geo-consistent");
  assert.deepEqual(r.scores, { IP2LOCATION: 0, ipapi: 0.47, IPQS: null, AbuseIPDB: 12 });
  assert.deepEqual(r.usage, { IPinfo: "ISP", AbuseIPDB: "Line ISP" });
  assert.deepEqual(r.factors.vpn, { hit: 1, total: 2, sources: ["IPinfo"] });
  assert.deepEqual(r.factors.tor, { hit: 0, total: 2, sources: [] });
  assert.equal(r.mail.Port25, true);
  assert.deepEqual(r.blacklist, { total: 439, clean: 411, marked: 28, blacklisted: 0 });
  assert.equal("Media" in r || "media" in r, false);
});

test("a full IPv6 address in the report is masked", () => {
  assert.equal(p.normalizeReport(JSON.parse(fx("report-v6-unmasked.json"))).ip, "2001:db8:1234:*:*");
});

test("task output is split by stack marker and tolerates banners and ANSI", () => {
  const raw = "===IPQ4===\n\u001b[1mbanner\u001b[0m {not json\n" + fx("report-v4.json") + "\ntrailer\n===IPQ6===\nERROR: no IPv6\n";
  const o = p.parseTaskOutput(raw);
  assert.equal(o.ipv4.asn, "3462");
  assert.equal(o.ipv6, null);
});

test("garbage yields nothing", () => {
  assert.deepEqual(p.parseTaskOutput(""), { ipv4: null, ipv6: null });
  assert.equal(p.normalizeReport({ foo: 1 }), null);
  assert.equal(p.extractJSON("no json here"), null);
});
