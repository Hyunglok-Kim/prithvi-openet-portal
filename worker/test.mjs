// Unit tests for the request Worker. No Cloudflare account or wrangler needed:
//   node --test portal/worker/test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import worker, { compose, requestWindow, validate } from "./src/index.js";

const NOW = new Date("2026-11-15T07:00:00Z");
const ORIGIN = "https://hydroai.net";
const good = () => ({ name: "Ada Lovelace", org: "Example University", email: "ada@example.org", region: "Mekong Delta, Vietnam",
  bbox: { w: 105.2, s: 9.4, e: 106.4, n: 10.6 }, from: "2019-01", to: "2020-12", use: "Irrigation study.\nTwo seasons.", website: "", elapsed_ms: 15000 });

function env(over = {}) {
  const sent = [];
  return { sent, ALLOWED_ORIGINS: `${ORIGIN},https://pages.example`, EXTRA_ORIGINS: "http://intranet.example:8787", MAIL_TO: "hyunglokkim@gist.ac.kr", MAIL_FROM: "requests@hydroai.net",
    FIRST_MONTH: "2013-04", LAG_MONTHS: "3",
    EMAIL: { send: async (m) => { sent.push(m); return { messageId: "m1" }; } },
    LIMITER: { limit: async () => ({ success: true }) }, ...over };
}
const post = (body, headers = {}) => new Request("https://requests.example/", { method: "POST",
  headers: { "Content-Type": "application/json", Origin: ORIGIN, "CF-Connecting-IP": "203.0.113.7", ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body) });

test("request window ends LAG_MONTHS before today", () => {
  assert.deepEqual(requestWindow({ FIRST_MONTH: "2013-04", LAG_MONTHS: "3" }, NOW), { first: "2013-04", last: "2026-08" });
  assert.equal(requestWindow({ LAG_MONTHS: "3" }, new Date("2026-05-31T12:00:00Z")).last, "2026-02");      // not "March" by day overflow
  assert.equal(requestWindow({ LAG_MONTHS: "3" }, new Date("2026-02-10T00:00:00Z")).last, "2025-11");      // across a year boundary
});

test("a good request is accepted and described correctly", () => {
  const v = validate(good(), env(), NOW);
  assert.ok(v.clean, JSON.stringify(v));
  assert.equal(v.clean.months, 24);
  assert.equal(v.clean.outside, 0);
  assert.ok(v.clean.km2 > 17000 && v.clean.km2 < 18000, String(v.clean.km2));
  assert.equal(v.clean.tiles, 2);
  const m = compose(v.clean, { origin: ORIGIN, country: "VN", at: "2026-11-15T07:00:00.000Z" });
  assert.equal(m.subject, "[Prithvi-OpenET-Tower] On-demand request: Mekong Delta, Vietnam");
  for (const s of ["Name: Ada Lovelace", "Email: ada@example.org", "Bounding box (W, S, E, N): 105.2, 9.4, 106.4, 10.6",
    "Period: 2019-01 to 2020-12 (24 months)", "Irrigation study.\nTwo seasons.", "Sent from https://hydroai.net (VN)"]) assert.ok(m.text.includes(s), s);
});

test("months outside the training period are counted", () => {
  const v = validate({ ...good(), from: "2015-07", to: "2016-06" }, env(), NOW);
  assert.equal(v.clean.months, 12);
  assert.equal(v.clean.outside, 6);
  assert.ok(compose(v.clean).text.includes("(12 months, 6 outside the 2016-2024 training period)"));
});

test("things a person can fix come back as errors", () => {
  const bad = (over, re) => { const v = validate({ ...good(), ...over }, env(), NOW); assert.match(v.error || "", re, JSON.stringify(over)); };
  bad({ name: "  " }, /every field/);
  bad({ use: "" }, /every field/);
  bad({ email: "ada@example" }, /email/);
  bad({ email: "ada@exa mple.org" }, /email/);
  bad({ email: "a@b.org, c@d.org" }, /email/);
  bad({ bbox: { w: 106.4, s: 9.4, e: 105.2, n: 10.6 } }, /West < East/);
  bad({ bbox: { w: 105.2, s: 9.4, e: 106.4, n: 95 } }, /West < East/);
  bad({ bbox: { w: "", s: 9.4, e: 106.4, n: 10.6 } }, /West < East/);
  bad({ bbox: null }, /West < East/);
  bad({ from: "2019-1" }, /YYYY-MM/);
  bad({ from: "2019-13" }, /YYYY-MM/);
  bad({ from: "2021-01", to: "2020-12" }, /first month is after/);
  bad({ from: "2012-12" }, /between 2013-04 and 2026-08/);
  bad({ to: "2026-09" }, /between 2013-04 and 2026-08/);
  assert.match(validate(null, env(), NOW).error, /not understood/);
  assert.match(validate([1], env(), NOW).error, /not understood/);
});

test("bot-like submissions are dropped quietly", () => {
  assert.deepEqual(validate({ ...good(), website: "http://spam.example" }, env(), NOW), { drop: true });
  assert.deepEqual(validate({ ...good(), elapsed_ms: 300 }, env(), NOW), { drop: true });
  const { elapsed_ms, ...noTimer } = good();
  assert.deepEqual(validate(noTimer, env(), NOW), { drop: true });
});

test("control characters cannot reach the mail headers", () => {
  const v = validate({ ...good(), region: "Delta\r\nBcc: victim@example.org", name: "Ada\u0000\tLovelace" }, env(), NOW);
  assert.equal(v.clean.region, "Delta Bcc: victim@example.org");
  assert.equal(v.clean.name, "Ada Lovelace");
  assert.ok(!/[\r\n]/.test(compose(v.clean).subject));
  assert.equal(validate({ ...good(), use: "x".repeat(5000) }, env(), NOW).clean.use.length, 1200);
});

test("POST from the portal sends one mail to the lab, with the requester as reply-to", async () => {
  const e = env();
  const r = await worker.fetch(post(good()), e);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
  assert.equal(r.headers.get("Access-Control-Allow-Origin"), ORIGIN);
  assert.equal(e.sent.length, 1);
  const m = e.sent[0];
  assert.equal(m.to, "hyunglokkim@gist.ac.kr");
  assert.deepEqual(m.from, { email: "requests@hydroai.net", name: "Prithvi-OpenET portal" });
  assert.deepEqual(m.replyTo, { email: "ada@example.org", name: "Ada Lovelace" });
  assert.match(m.subject, /^\[Prithvi-OpenET-Tower\] On-demand request: Mekong Delta, Vietnam$/);
  assert.ok(m.text.includes("Affiliation: Example University"));
});

test("other origins, methods and oversized or broken bodies are refused without sending", async () => {
  const e = env();
  assert.equal((await worker.fetch(post(good(), { Origin: "https://evil.example" }), e)).status, 403);
  const noOrigin = new Request("https://requests.example/", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(good()) });
  assert.equal((await worker.fetch(noOrigin, e)).status, 403);
  assert.equal((await worker.fetch(new Request("https://requests.example/"), e)).status, 405);
  assert.equal((await worker.fetch(post("{not json"), e)).status, 400);
  assert.equal((await worker.fetch(post({ ...good(), use: "x".repeat(9000) }), e)).status, 413);
  const bad = await worker.fetch(post({ ...good(), email: "nope" }), e);
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /email/);
  assert.equal(e.sent.length, 0);
});

test("preflight answers only allowed origins", async () => {
  const pre = (origin) => new Request("https://requests.example/", { method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "POST" } });
  const ok = await worker.fetch(pre("https://pages.example"), env());
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get("Access-Control-Allow-Origin"), "https://pages.example");
  const extra = await worker.fetch(pre("http://intranet.example:8787"), env());          // from the EXTRA_ORIGINS secret
  assert.equal(extra.status, 204);
  assert.equal(extra.headers.get("Access-Control-Allow-Origin"), "http://intranet.example:8787");
  assert.equal((await worker.fetch(pre("http://intranet.example:8787"), env({ EXTRA_ORIGINS: undefined }))).status, 403);
  assert.match(ok.headers.get("Access-Control-Allow-Methods"), /POST/);
  const no = await worker.fetch(pre("https://evil.example"), env());
  assert.equal(no.status, 403);
  assert.equal(no.headers.get("Access-Control-Allow-Origin"), null);
});

test("honeypot and too-fast submissions get a 200 but no mail", async () => {
  const e = env();
  assert.equal((await worker.fetch(post({ ...good(), website: "x" }), e)).status, 200);
  assert.equal((await worker.fetch(post({ ...good(), elapsed_ms: 10 }), e)).status, 200);
  assert.equal(e.sent.length, 0);
});

test("rate limit and delivery failure are reported", async () => {
  const limited = await worker.fetch(post(good()), env({ LIMITER: { limit: async () => ({ success: false }) } }));
  assert.equal(limited.status, 429);
  const failing = env({ EMAIL: { send: async () => { const err = new Error("not verified"); err.code = "E_SENDER_NOT_VERIFIED"; throw err; } } });
  const r = await worker.fetch(post(good()), failing);
  assert.equal(r.status, 502);
  const body = await r.json();
  assert.equal(body.ok, false);
  assert.equal(body.code, "E_SENDER_NOT_VERIFIED");
  assert.match(body.error, /could not be delivered/);
});
