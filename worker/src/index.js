/* Prithvi-OpenET-Tower portal — on-demand request receiver (Cloudflare Worker).

   The portal is a static site, so it cannot send mail by itself. This Worker takes the request
   form's JSON, checks it, and emails it to the lab through Cloudflare Email Service.

   Why it is safe to leave on the open internet:
     - the send_email binding is locked to one destination address (wrangler.toml), so the Worker
       cannot be used to send mail to anyone else;
     - only the origins listed in ALLOWED_ORIGINS (and the EXTRA_ORIGINS secret) may call it from a browser;
     - a rate limit, a size limit, a hidden "website" field and a minimum fill time stop casual bots.
   Sending to your own verified address is free on every Cloudflare plan.

   Contract (shared with js/app.js):
     POST  application/json  {name, org, email, region, bbox:{w,s,e,n}, from, to, use, website, elapsed_ms}
     200   {ok: true}
     4xx   {ok: false, error: "what to fix"}        5xx   {ok: false, error, code} */

const MAX_BODY = 8 * 1024;
const MAX_LEN = { name: 100, org: 160, email: 160, region: 160, use: 1200 };
const TRAIN = ["2016-01", "2024-12"];          // months the model was trained on
const MIN_FILL_MS = 2000;                      // nobody fills nine fields faster than this

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...headers } });

/* One line, no control characters: these values end up in mail headers (subject, reply-to). */
const line = (v, max) => String(v ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
/* Free text: keep line breaks, drop other control characters. */
const para = (v, max) => String(v ?? "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, " ").trim().slice(0, max);
const isYm = (s) => /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
const ymIndex = (s) => +s.slice(0, 4) * 12 + (+s.slice(5) - 1);

export function requestWindow(env, now = new Date()) {
  const lag = Number.parseInt(env.LAG_MONTHS ?? "3", 10) || 0;
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - lag, 1));
  return { first: env.FIRST_MONTH || "2013-04", last: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}` };
}

/* Returns {drop: true} for bot-like submissions (answered with a quiet 200),
   {error} for something the person can fix, or {clean} with the checked values. */
export function validate(p, env = {}, now = new Date()) {
  if (!p || typeof p !== "object" || Array.isArray(p)) return { error: "The request was not understood." };
  if (String(p.website ?? "").trim() !== "") return { drop: true };
  if (!(Number(p.elapsed_ms) >= MIN_FILL_MS)) return { drop: true };

  const c = { name: line(p.name, MAX_LEN.name), org: line(p.org, MAX_LEN.org), email: line(p.email, MAX_LEN.email),
              region: line(p.region, MAX_LEN.region), use: para(p.use, MAX_LEN.use), from: line(p.from, 7), to: line(p.to, 7) };
  for (const k of ["name", "org", "email", "region", "use", "from", "to"]) if (!c[k]) return { error: "Please fill in every field." };
  if (!/^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:".]{2,}$/.test(c.email)) return { error: "That email address does not look right." };

  const b = p.bbox || {};
  const [w, s, e, n] = ["w", "s", "e", "n"].map((k) => (b[k] === "" || b[k] == null ? NaN : Number(b[k])));
  if (![w, s, e, n].every(Number.isFinite) || w < -180 || e > 180 || s < -90 || n > 90 || !(e > w) || !(n > s)) {
    return { error: "The box needs West < East and South < North, in degrees." };
  }
  if (!isYm(c.from) || !isYm(c.to)) return { error: "Write the months as YYYY-MM, for example 2019-05." };
  if (c.from > c.to) return { error: "The first month is after the last month." };
  const win = requestWindow(env, now);
  if (c.from < win.first || c.to > win.last) return { error: `The period has to fall between ${win.first} and ${win.last}.` };

  const km2 = (e - w) * 111.32 * Math.cos(((s + n) / 2) * Math.PI / 180) * (n - s) * 110.57;
  const months = ymIndex(c.to) - ymIndex(c.from) + 1;
  let outside = 0;
  for (let i = ymIndex(c.from); i <= ymIndex(c.to); i++) if (i < ymIndex(TRAIN[0]) || i > ymIndex(TRAIN[1])) outside++;
  c.bbox = { w, s, e, n };
  c.km2 = Math.round(km2);
  c.tiles = Math.max(1, Math.ceil(km2 / (109.8 * 109.8)));       // an HLS tile is 109.8 km on a side
  c.months = months;
  c.outside = outside;
  return { clean: c };
}

export function compose(c, meta = {}) {
  const b = c.bbox;
  const text = [
    "Prithvi-OpenET-Tower — on-demand request", "",
    `Name: ${c.name}`, `Affiliation: ${c.org}`, `Email: ${c.email}`, "",
    `Region: ${c.region}`,
    `Bounding box (W, S, E, N): ${b.w}, ${b.s}, ${b.e}, ${b.n}`,
    `Approximate area: ${c.km2.toLocaleString("en-US")} km2 (about ${c.tiles} HLS tile${c.tiles > 1 ? "s" : ""})`,
    `Period: ${c.from} to ${c.to} (${c.months} month${c.months > 1 ? "s" : ""}` +
      (c.outside ? `, ${c.outside} outside the ${TRAIN[0].slice(0, 4)}-${TRAIN[1].slice(0, 4)} training period)` : ")"), "",
    "Intended use:", c.use, "",
    "--",
    `Sent from ${meta.origin || "the portal"}${meta.country ? ` (${meta.country})` : ""} at ${meta.at || new Date().toISOString()}.`,
    "Reply to this message to answer the requester.",
  ].join("\n");
  return { subject: `[Prithvi-OpenET-Tower] On-demand request: ${c.region}`, text };
}

function cors(request, env) {
  const origin = request.headers.get("Origin") || "";
  /* ALLOWED_ORIGINS lives in wrangler.toml; EXTRA_ORIGINS is a secret for origins that should not be
     written down in a public repository (an intranet preview, for instance). */
  const allowed = `${env.ALLOWED_ORIGINS || ""},${env.EXTRA_ORIGINS || ""}`.split(",").map((s) => s.trim()).filter(Boolean);
  const ok = origin !== "" && allowed.includes(origin);
  return { ok, origin, headers: ok ? { "Access-Control-Allow-Origin": origin, "Vary": "Origin" } : { "Vary": "Origin" } };
}

export default {
  async fetch(request, env) {
    const co = cors(request, env);
    if (request.method === "OPTIONS") {
      if (!co.ok) return new Response(null, { status: 403, headers: co.headers });
      return new Response(null, { status: 204, headers: { ...co.headers, "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "86400" } });
    }
    if (request.method !== "POST") return json(405, { ok: false, error: "This address only accepts the portal's request form." }, { Allow: "POST, OPTIONS" });
    if (!co.ok) return json(403, { ok: false, error: "This form can only be sent from the portal." }, co.headers);

    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    if (env.LIMITER) {
      const { success } = await env.LIMITER.limit({ key: ip });
      if (!success) return json(429, { ok: false, error: "Too many requests from this network. Please try again in a minute." }, co.headers);
    }

    const raw = await request.text();
    if (raw.length > MAX_BODY) return json(413, { ok: false, error: "The request is too long." }, co.headers);
    let payload;
    try { payload = JSON.parse(raw); } catch { return json(400, { ok: false, error: "The request was not understood." }, co.headers); }

    const v = validate(payload, env);
    if (v.drop) return json(200, { ok: true }, co.headers);            // do not tell a bot it was caught
    if (v.error) return json(400, { ok: false, error: v.error }, co.headers);

    const mail = compose(v.clean, { origin: co.origin, country: request.cf && request.cf.country, at: new Date().toISOString() });
    try {
      await env.EMAIL.send({
        to: env.MAIL_TO,
        from: { email: env.MAIL_FROM, name: "Prithvi-OpenET portal" },
        replyTo: { email: v.clean.email, name: v.clean.name },
        subject: mail.subject,
        text: mail.text,
      });
    } catch (e) {
      console.error("send failed:", e && e.code, e && e.message);
      return json(502, { ok: false, error: "The request could not be delivered.", code: (e && e.code) || "E_UNKNOWN" }, co.headers);
    }
    return json(200, { ok: true }, co.headers);
  },
};
