/* Prithvi-OpenET-Tower data portal — single-page app, no build step.

   How the map gets its data
     catalog.json lists every month of the record and, for months that have browse tiles, one
     PMTiles file. A tile is an 8-bit PNG whose pixel is ET in whole units (DN x dn_step);
     DN 255 means no data. MapLibre asks our "etn://" protocol for tiles; we fetch the PNG by
     HTTP range request, keep the decoded numbers, and hand back a coloured bitmap. Because the
     numbers stay in memory, the cursor readout and the pixel series need no extra server.

   Two optional parts of the catalog
     background  a global ET product from somewhere else, drawn under our maps so the rest of the
                 globe is not empty. It is context, not this model's output, and every value read
                 from it is shown with its name.
     fine        small areas that a reduced copy of the tiles keeps at the native zoom. Their tiles
                 sit in a second archive per layer; everywhere else the copy's finest level is
                 enlarged in the browser. */
(() => {
"use strict";

/* ───────────────────────────── configuration ───────────────────────────── */
const CFG = Object.assign({ dataBase: "./data/", cogBase: "", requestEmail: "", requestEndpoint: "", demandFirstMonth: "2013-04",
                            demandLagMonths: 3, nasPath: "", paperStatus: "", notice: "" }, window.PORTAL_CONFIG || {});
const Q = new URLSearchParams(location.search);
{
  const d = Q.get("data");                       // same-origin absolute path only
  if (d && /^\/(?!\/)[\w\-./]*\/$/.test(d)) CFG.dataBase = d;
  const nas = Q.get("nas");                      // lab storage path, shown on the internal copy
  if (nas && /^\/[\w\-./]+$/.test(nas)) CFG.nasPath = nas;
}
const EMBED = Q.get("embed") === "1";
if (EMBED) document.documentElement.classList.add("embed");
if (Q.get("hidefooter") === "1") document.body.classList.add("hide-footer");   // the page that embeds the portal draws its own logo strip
const DATA = new URL(CFG.dataBase, location.href).href;
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONL = ["January", "February", "March", "April", "May", "June", "July", "August", "September",
              "October", "November", "December"];
const TILE = 256;
const GLOBE_ZOOM = 1.7;          // the opening view: the whole globe, turned to the region that has our maps
const GLOBE_CENTER = [127.6, 30];
const FIXED_RANGE = { month: [0, 180], clim: [0, 180], annual: [400, 1100] };
/* Magnitude ramp: yellow-green-blue, lightness falling monotonically (analogous hues, so it
   stays ordered for colour-blind readers and in grayscale). Always shown with its scale. */
const RAMP = ["#ffffd9", "#edf8b1", "#c7e9b4", "#7fcdbb", "#41b6c4", "#1d91c0", "#225ea8", "#253494", "#081d58"]
  .map((h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]);
const COVER_STEPS = ["#D9E8F1", "#A9CBDF", "#74A9C9", "#2E7BA8", "#1F5F85"];   // one hue, light → dark
const CITIES = [["Seoul", 126.978, 37.5665], ["Busan", 129.0756, 35.1796], ["Incheon", 126.7052, 37.4563],
  ["Daegu", 128.6014, 35.8714], ["Daejeon", 127.3845, 36.3504], ["Gwangju", 126.8526, 35.1595],
  ["Ulsan", 129.3114, 35.5384], ["Jeju", 126.5312, 33.4996], ["Gangneung", 128.8761, 37.7519],
  ["Jeonju", 127.148, 35.8242], ["Pyongyang", 125.7625, 39.0392], ["Hamhung", 127.5364, 39.9183],
  ["Chongjin", 129.7758, 41.7956], ["Wonsan", 127.4433, 39.1528], ["Sinuiju", 124.3981, 40.1006]];

/* ───────────────────────────── small helpers ───────────────────────────── */
const $ = (s) => document.querySelector(s);
function el(tag, attrs, kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) n.setAttribute(k, v === true ? "" : v);
  }
  for (const c of [].concat(kids == null ? [] : kids)) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
}
const svgEl = (tag, attrs) => {
  const n = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v);
  return n;
};
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const fmt = (v, d = 0) => (v == null || Number.isNaN(v) ? "—" : v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }));
const ymLabel = (ym) => `${MONL[+ym.slice(5) - 1]} ${ym.slice(0, 4)}`;
function fmtBytes(b) { return b >= 1e9 ? (b / 1e9).toFixed(2) + " GB" : (b / 1e6).toFixed(0) + " MB"; }
function fmtRes(m) { return m >= 950 ? `${(m / 1000).toFixed(m >= 9500 ? 0 : 1)} km` : `${Math.round(m / (m >= 95 ? 10 : 1)) * (m >= 95 ? 10 : 1)} m`; }
function rampRGB(t) {
  const x = clamp(t, 0, 1) * (RAMP.length - 1), i = Math.min(RAMP.length - 2, Math.floor(x)), f = x - i;
  return [0, 1, 2].map((c) => Math.round(RAMP[i][c] + (RAMP[i + 1][c] - RAMP[i][c]) * f));
}
function niceCeil(v) {
  const p = Math.pow(10, Math.floor(Math.log10(v || 1))), n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}
const numWord = (n) => ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"][n] || String(n);
/* Is the point inside the ring (an array of [lng, lat])? Even-odd rule. */
function inRing(ring, lng, lat) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lng < (xj - xi) * (lat - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}
async function mapLimit(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}
function lngLatToTile(lng, lat, z) {
  const n = 2 ** z, s = Math.sin(lat * Math.PI / 180);
  const x = (lng + 180) / 360 * n, y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n;
  const tx = Math.floor(x), ty = Math.floor(y);
  return { x: tx, y: ty, px: clamp(Math.floor((x - tx) * TILE), 0, TILE - 1), py: clamp(Math.floor((y - ty) * TILE), 0, TILE - 1) };
}
function download(name, text, type) {
  const a = el("a", { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
async function copyText(text, btn) {
  try { await navigator.clipboard.writeText(text); } catch {
    const t = el("textarea", { style: "position:fixed;opacity:0" }, text); document.body.append(t); t.select();
    document.execCommand("copy"); t.remove();
  }
  if (btn) { const old = btn.textContent; btn.textContent = "Copied"; setTimeout(() => { btn.textContent = old; }, 1400); }
}

/* tooltip shared by the chart and the calendar — built from DOM nodes, never innerHTML */
const tip = $("#tip");
function showTip(nodes, x, y) {
  tip.replaceChildren(...nodes); tip.hidden = false;
  const r = tip.getBoundingClientRect();
  tip.style.left = clamp(x + 14, 6, innerWidth - r.width - 6) + "px";
  tip.style.top = clamp(y - r.height - 12 < 6 ? y + 16 : y - r.height - 12, 6, innerHeight - r.height - 6) + "px";
}
const hideTip = () => { tip.hidden = true; };

/* ───────────────────────────── state ───────────────────────────── */
let CAT = null, map = null, landGeo = null, popup = null, pickMarker = null;
const L = new Map();                 // layer id → layer record
let BG = null;                       // the background product (catalog.background), or null
const BGL = new Map();               // background layer id → record
let FINE = [], FINE_ZOOM = 0, FINE_WHAT = "";      // areas a reduced copy keeps at the native zoom (catalog.fine), that zoom, and what the areas are
const state = { mode: "annual", ym: null, climMonth: 7, scale: "fixed", opacity: 1, pick: null,
                seriesYear: null, playing: null };
const lut32 = new Uint32Array(256), lutBg = new Uint32Array(256);
let lutKey = "";
let chartModel = null;

function currentLayerId() {
  if (state.mode === "annual" && L.has("clim_annual")) return "clim_annual";
  if (state.mode === "clim") return `clim_${String(state.climMonth).padStart(2, "0")}`;
  return "et_" + state.ym.replace("-", "");
}
const currentLayer = () => L.get(currentLayerId());
/* The background layer that stands behind the layer on show, when the catalog has one for it
   ("annual", or the layer's own id). No stand-ins: a July map never gets an annual background. */
function currentBg() {
  if (!BG) return null;
  const ly = currentLayer();
  return BGL.get(ly.kind === "annual" ? "bg_annual" : "bg_" + ly.id) || null;
}
function currentRange(ly) {
  if (state.scale === "fixed") return FIXED_RANGE[ly.kind];
  const step = ly.kind === "annual" ? 50 : 10;
  const lo = Math.floor(ly.p02 / step) * step, hi = Math.ceil(ly.p98 / step) * step;
  return [lo, Math.max(hi, lo + step)];
}

/* ───────────────────────────── numeric tiles ───────────────────────────── */
const archives = new Map(), dnCache = new Map(), pending = new Map();
const DN_MAX = 900;
/* A layer's file is an address relative to the catalog. A copy spread over several sites writes
   "../other-site/monthly/x.pmtiles" there, so join it properly rather than gluing strings. */
const fileURL = (rel) => new URL(rel, DATA).href;
const layerRec = (id) => L.get(id) || BGL.get(id);
function openArchive(key, rel) {
  let a = archives.get(key);
  if (!a) { a = new pmtiles.PMTiles(new pmtiles.FetchSource(fileURL(rel))); archives.set(key, a); }
  return a;
}
const archive = (id) => openArchive(id, layerRec(id).file);
/* The layer's second archive, with the native-zoom tiles of the sample areas (a reduced copy only). */
const fineArchive = (id) => (L.has(id) && L.get(id).fine ? openArchive(id + "#fine", L.get(id).fine) : null);
async function readTile(a, z, x, y) {
  const res = await a.getZxy(z, x, y);
  return res && res.data && res.data.byteLength ? decodeDN(res.data) : null;
}
/* Tiles carry numbers, so they are decoded byte for byte here and not through a canvas: Safari
   colour-manages canvas pixels and hands back values that are off by one. An 8-bit grayscale PNG is
   a zlib stream of filtered rows — the browser inflates it and we undo the row filters. */
async function decodePNG8(buf) {
  const b = new Uint8Array(buf), dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length < 45 || dv.getUint32(0) !== 0x89504e47 || dv.getUint32(4) !== 0x0d0a1a0a) throw new Error("not a PNG");
  let p = 8, w = 0, h = 0;
  const idat = [];
  while (p + 12 <= b.length) {
    const len = dv.getUint32(p), type = dv.getUint32(p + 4);
    if (type === 0x49484452) {                                    // IHDR: 8-bit, grayscale, not interlaced
      w = dv.getUint32(p + 8); h = dv.getUint32(p + 12);
      if (w !== TILE || h !== TILE || b[p + 16] !== 8 || b[p + 17] !== 0 || b[p + 20] !== 0) throw new Error("unexpected PNG layout");
    } else if (type === 0x49444154) idat.push(b.subarray(p + 8, p + 8 + len));     // IDAT
    else if (type === 0x49454e44) break;                          // IEND
    p += 12 + len;
  }
  const raw = new Uint8Array(await new Response(new Blob(idat).stream().pipeThrough(new DecompressionStream("deflate"))).arrayBuffer());
  if (!w || raw.length !== h * (w + 1)) throw new Error("unexpected PNG size");
  const out = new Uint8Array(w * h);                              // writes wrap modulo 256, as the filters require
  for (let y = 0; y < h; y++) {
    const f = raw[y * (w + 1)], src = y * (w + 1) + 1, dst = y * w, up = dst - w;
    for (let x = 0; x < w; x++) {
      const a = x ? out[dst + x - 1] : 0, u = y ? out[up + x] : 0, c = x && y ? out[up + x - 1] : 0;
      let v = raw[src + x];
      if (f === 1) v += a;
      else if (f === 2) v += u;
      else if (f === 3) v += (a + u) >> 1;
      else if (f === 4) { const q = a + u - c, pa = Math.abs(q - a), pu = Math.abs(q - u), pc = Math.abs(q - c); v += pa <= pu && pa <= pc ? a : pu <= pc ? u : c; }
      else if (f !== 0) throw new Error("unexpected PNG filter");
      out[dst + x] = v;
    }
  }
  return out;
}
/* Fallback for browsers without DecompressionStream: values can be off by one where the canvas is colour-managed. */
const cv = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(TILE, TILE) : Object.assign(document.createElement("canvas"), { width: TILE, height: TILE });
const cx = cv.getContext("2d", { willReadFrequently: true });
async function decodeViaCanvas(buf) {
  const bmp = await createImageBitmap(new Blob([buf], { type: "image/png" }), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
  cx.clearRect(0, 0, TILE, TILE); cx.drawImage(bmp, 0, 0); bmp.close();          // draw + read is synchronous: decodes cannot interleave
  const d = cx.getImageData(0, 0, TILE, TILE).data, out = new Uint8Array(TILE * TILE);
  for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = d[j];
  return out;
}
let exactDecode = typeof DecompressionStream !== "undefined";
async function decodeDN(buf) {
  if (exactDecode) {
    try { return await decodePNG8(buf); }
    catch (e) { console.warn("[tiles] exact PNG decode failed, falling back to canvas:", e.message); exactDecode = false; }
  }
  return decodeViaCanvas(buf);
}
function getDN(id, z, x, y) {
  const key = `${id}/${z}/${x}/${y}`;
  if (dnCache.has(key)) { const v = dnCache.get(key); dnCache.delete(key); dnCache.set(key, v); return Promise.resolve(v); }
  if (pending.has(key)) return pending.get(key);
  const p = (async () => {
    let dn;
    if (BGL.has(id)) dn = z <= BG.zoom.max ? await readTile(archive(id), z, x, y) : null;
    else if (z < CAT.zoom.min) dn = await coarserDN(id, z, x, y);
    else if (z > CAT.zoom.max) dn = await finerDN(id, z, x, y);
    else dn = await readTile(archive(id), z, x, y);
    dnCache.set(key, dn);
    if (dnCache.size > DN_MAX) dnCache.delete(dnCache.keys().next().value);
    return dn;
  })().finally(() => pending.delete(key));
  pending.set(key, p);
  return p;
}
/* The archives start at zoom 3; with the globe zoomed far out the map asks for zoom 0-2. Those few tiles
   are averaged here from the zoom-3 tiles, with the pipeline's own rule: a pixel is kept when a quarter of
   it has data. Without this the data would vanish from the globe just when the whole Earth is in view. */
async function coarserDN(id, z, x, y) {
  const zs = CAT.zoom.min, f = 2 ** (zs - z), b = CAT.bounds;
  const lo = lngLatToTile(b[0], b[3], zs), hi = lngLatToTile(b[2], b[1], zs);
  const sum = new Float32Array(TILE * TILE), cnt = new Uint16Array(TILE * TILE);
  let any = false;
  for (let cy = Math.max(y * f, lo.y); cy <= Math.min(y * f + f - 1, hi.y); cy++) {
    for (let cx = Math.max(x * f, lo.x); cx <= Math.min(x * f + f - 1, hi.x); cx++) {
      const dn = await getDN(id, zs, cx, cy);
      if (!dn) continue;
      any = true;
      const ox = (cx - x * f) * TILE, oy = (cy - y * f) * TILE;
      for (let py = 0; py < TILE; py++) {
        const row = Math.floor((oy + py) / f) * TILE;
        for (let px = 0; px < TILE; px++) {
          const v = dn[py * TILE + px];
          if (v === 255) continue;
          const i = row + Math.floor((ox + px) / f);
          sum[i] += v; cnt[i]++;
        }
      }
    }
  }
  if (!any) return null;
  const out = new Uint8Array(TILE * TILE).fill(255), need = Math.max(1, Math.ceil(f * f * 0.25));
  for (let i = 0; i < out.length; i++) if (cnt[i] >= need) out[i] = Math.round(sum[i] / cnt[i]);
  return out;
}
/* Above the top zoom of a reduced copy. Where the tile touches a sample area the layer's second archive
   has it, with native pixels inside the area's outline. Everywhere else the copy's finest level is
   enlarged, each cell drawn as a block — the same pixels the second archive holds outside the outlines. */
const tileBounds = (z, x, y) => {
  const n = 2 ** z, lat = (j) => Math.atan(Math.sinh(Math.PI * (1 - 2 * j / n))) * 180 / Math.PI;
  return [x / n * 360 - 180, lat(y + 1), (x + 1) / n * 360 - 180, lat(y)];
};
function tileTouchesFine(z, x, y) {
  const b = tileBounds(z, x, y);
  return FINE.some((a) => b[0] < a.bounds[2] && b[2] > a.bounds[0] && b[1] < a.bounds[3] && b[3] > a.bounds[1]);
}
async function finerDN(id, z, x, y) {
  if (z <= FINE_ZOOM && tileTouchesFine(z, x, y)) {
    const fa = fineArchive(id), dn = fa ? await readTile(fa, z, x, y) : null;
    if (dn) return dn;
  }
  const zs = CAT.zoom.max, d = z - zs, n = TILE >> d;
  const up = await getDN(id, zs, x >> d, y >> d);
  if (!up || n < 1) return null;
  const ox = (x - ((x >> d) << d)) * n, oy = (y - ((y >> d) << d)) * n, out = new Uint8Array(TILE * TILE);
  let any = false;
  for (let py = 0; py < TILE; py++) {
    const row = (oy + (py >> d)) * TILE + ox;
    for (let px = 0; px < TILE; px++) { const v = up[row + (px >> d)]; out[py * TILE + px] = v; if (v !== 255) any = true; }
  }
  return any ? out : null;
}
function fillLUT(lut, step, lo, hi) {
  for (let d = 0; d < 255; d++) {
    const [r, g, b] = rampRGB((d * step - lo) / (hi - lo));
    lut[d] = (255 << 24 | b << 16 | g << 8 | r) >>> 0;         // little-endian RGBA
  }
  lut[255] = 0;
}
function buildLUT() {
  const ly = currentLayer(), [lo, hi] = currentRange(ly), bg = currentBg();
  fillLUT(lut32, ly.dn_step, lo, hi);
  if (bg) fillLUT(lutBg, bg.dn_step, lo, hi);                    // the background follows the same colour scale
  lutKey = `${ly.id}_${lo}_${hi}`;
}
function registerProtocol() {
  maplibregl.addProtocol("etn", async (params) => {
    const m = /^etn:\/\/([^/]+)\/(\d+)\/(\d+)\/(\d+)/.exec(params.url);
    const dn = m && layerRec(m[1]) ? await getDN(m[1], +m[2], +m[3], +m[4]) : null;
    if (!dn) return { data: await createImageBitmap(new ImageData(1, 1)) };
    const img = new ImageData(TILE, TILE), px = new Uint32Array(img.data.buffer), lut = BGL.has(m[1]) ? lutBg : lut32;
    for (let i = 0; i < px.length; i++) px[i] = lut[dn[i]];
    return { data: await createImageBitmap(img) };
  });
}
const tileURL = () => `etn://${currentLayerId()}/{z}/{x}/{y}?k=${lutKey}`;
const bgTileURL = (bg) => `etn://${bg.id}/{z}/{x}/{y}?k=${lutKey}`;

/* ───────────────────────────── catalog ───────────────────────────── */
async function loadCatalog() {
  const r = await fetch(DATA + "catalog.json", { cache: "no-cache" });
  if (r.status === 401 || r.status === 403) {
    if (window.parent !== window) window.parent.postMessage({ type: "portalAuth" }, "*");
    throw new Error("Sign-in required — open this page from the lab dashboard.");
  }
  if (!r.ok) throw new Error(`Could not load the catalog (HTTP ${r.status}).`);
  CAT = await r.json();
  if (CAT.annual) L.set("clim_annual", { ...CAT.annual, kind: "annual", label: `Mean annual ET, ${CAT.record.train[0].slice(0, 4)}–${CAT.record.train[1].slice(0, 4)}` });
  for (const c of CAT.clim || []) L.set(c.id, { ...c, kind: "clim", label: `${MONL[c.month - 1]} mean, ${CAT.record.train[0].slice(0, 4)}–${CAT.record.train[1].slice(0, 4)}` });
  for (const m of CAT.months) if (m.tiles) L.set(m.tiles.id, { ...m.tiles, kind: "month", ym: m.ym, rec: m, label: ymLabel(m.ym) });
  if (CAT.background && CAT.background.layers && Object.keys(CAT.background.layers).length) {
    BG = CAT.background;
    for (const ly of Object.values(BG.layers)) BGL.set(ly.id, { ...ly, kind: "bg" });
  }
  if (CAT.fine && (CAT.fine.areas || []).length && CAT.fine.zoom > CAT.zoom.max) { FINE = CAT.fine.areas; FINE_ZOOM = CAT.fine.zoom; FINE_WHAT = CAT.fine.what || ""; }
  const built = CAT.months.filter((m) => m.tiles);
  if (!L.size) throw new Error("The catalog lists no browse tiles yet.");
  const julys = built.filter((m) => m.ym.endsWith("-07") && m.period === "train");
  state.ym = (julys[julys.length - 1] || built[built.length - 1] || {}).ym || null;
  state.seriesYear = state.ym ? state.ym.slice(0, 4) : null;
  if (!L.has("clim_annual")) state.mode = (CAT.clim || []).length ? "clim" : "month";
}
const TRAIN_YEARS = () => `${CAT.record.train[0].slice(0, 4)}–${CAT.record.train[1].slice(0, 4)}`;
function demandWindow() {
  const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - CFG.demandLagMonths);      // day 1 first: "31 May minus three months" must not roll into March
  const last = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  return { first: CFG.demandFirstMonth, last, text: `${ymLabel(CFG.demandFirstMonth)} to ${ymLabel(last)}` };
}

/* ───────────────────────────── map ───────────────────────────── */
function inBounds(lng, lat) { const b = CAT.bounds; return lng >= b[0] && lng <= b[2] && lat >= b[1] && lat <= b[3]; }
function onLand(lng, lat) {
  if (!landGeo) return true;
  const hit = (ring) => inRing(ring, lng, lat);
  for (const f of landGeo.features) {
    const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const poly of polys) if (hit(poly[0]) && !poly.slice(1).some(hit)) return true;
  }
  return false;
}
/* The finest tile the ET source can be asked for: the copy's top zoom, or the native zoom when the
   copy keeps sample areas at it (the tiles in between are then made in finerDN). */
const srcMaxZoom = () => (FINE.length ? FINE_ZOOM : CAT.zoom.max);
/* MapLibre rounds the zoom for raster sources and 256-px tiles sit one level ahead of the map zoom. */
const tileZoom = () => clamp(Math.round(map.getZoom() + 1), 0, srcMaxZoom());
/* A copy of the tiles may stop short of the native grid: a public preview on a host with size limits
   has zoom.max below zoom.native in its catalog. Everything that names a resolution asks here, so the
   page never promises 30 m where the tiles on hand are coarser. */
const fullRes = () => CAT.zoom.max >= (CAT.zoom.native || CAT.zoom.max);
const groundRes = (z, lat) => 40075016.686 * Math.cos(lat * Math.PI / 180) / (TILE * 2 ** z);
const finestRes = () => fmtRes(groundRes(CAT.zoom.max, (CAT.bounds[1] + CAT.bounds[3]) / 2));
/* A sample area is the one place where a reduced copy does go down to the native grid. What a value
   stands for therefore depends on where it was read. */
const fineAreaAt = (lng, lat) => FINE.find((a) => lng >= a.bounds[0] && lng <= a.bounds[2] && lat >= a.bounds[1] && lat <= a.bounds[3] && inRing(a.ring, lng, lat)) || null;
const topZoomAt = (lng, lat) => (fineAreaAt(lng, lat) ? FINE_ZOOM : CAT.zoom.max);      // the finest tile zoom with numbers of its own at that place
const nativeAt = (lng, lat) => topZoomAt(lng, lat) >= (CAT.zoom.native || CAT.zoom.max);
const cellNameAt = (lng, lat) => (nativeAt(lng, lat) ? "30 m pixel" : `${finestRes()} cell`);
const zRegional = () => Math.min(9.2, CAT.zoom.max - 0.3);      // map zoom of the first click-in: tile zoom 10, about 120 m
/* Outside the region with maps there is nothing finer than the background. From this map zoom on the
   page says so: where a background cell has grown to about 16 px on screen, and never before the
   coverage card has faded out (7.2), so the note has room at the top of the map. */
const outNoteZoom = (lat) => Math.max(7.3, BG ? Math.log2(40075016.686 * Math.cos(lat * Math.PI / 180) * 16 / (512 * BG.cell_km * 1000)) : 0);
/* The background fades as the view goes past its detail, so the imagery shows where there is no map. */
const ctxOpacity = (k) => ["interpolate", ["linear"], ["zoom"], 7, 0.9 * k, 9.5, 0.35 * k];

function initMap() {
  buildLUT();
  registerProtocol();
  const bg = currentBg();
  map = new maplibregl.Map({
    container: "map",
    style: {
      version: 8,
      projection: { type: "globe" },
      sky: { "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 1, 4.5, 1, 6.5, 0] },
      sources: {
        sat: { type: "raster", tileSize: 256, maxzoom: 18,
               tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
               attribution: "Imagery © Esri, Maxar, Earthstar Geographics" },
        /* The background: a global product from somewhere else, under our maps (see currentBg). */
        ...(BG ? { ctx: { type: "raster", tileSize: 256, minzoom: 0, maxzoom: BG.zoom.max,
                          tiles: [bgTileURL(bg || BGL.values().next().value)], attribution: `Background ET: ${BG.name}` } } : {}),
        et: { type: "raster", tileSize: 256, minzoom: 0, maxzoom: srcMaxZoom(), bounds: CAT.bounds,
              tiles: [tileURL()], attribution: "ET: Prithvi-OpenET-Tower, HydroAI Lab (GIST)" },
      },
      layers: [
        { id: "bg", type: "background", paint: { "background-color": "#0F1318" } },
        { id: "sat", type: "raster", source: "sat", paint: { "raster-saturation": -0.3, "raster-brightness-max": 0.92 } },
        ...(BG ? [{ id: "ctx", type: "raster", source: "ctx", layout: { visibility: bg ? "visible" : "none" },
                    paint: { "raster-opacity": ctxOpacity(1), "raster-fade-duration": 150 } }] : []),
        { id: "et", type: "raster", source: "et", paint: { "raster-opacity": 1, "raster-fade-duration": 150 } },
      ],
    },
    center: GLOBE_CENTER, zoom: GLOBE_ZOOM, minZoom: 1.2, maxZoom: srcMaxZoom() + 2.5,
    attributionControl: { compact: true }, dragRotate: false, pitchWithRotate: false, touchPitch: false,
  });
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  map.addControl(new maplibregl.ScaleControl({ unit: "metric", maxWidth: 110 }), "bottom-left");
  window.__portal = { map, state, getDN, L, dnCache, exact: () => exactDecode, zoom: CAT.zoom,          // handle for tests and debugging
                      bg: BG, fine: FINE, fineZoom: FINE_ZOOM, note: () => noteShown };

  map.on("error", (e) => console.warn("[map]", e && e.error ? e.error.message : e));
  map.on("load", () => {
    $("#boot").classList.add("out");
    setTimeout(() => $("#boot").remove(), 500);
    addMarkers();
    addFineAreas();
    loadLand();
    /* The page opens on the whole globe and stays there until the visitor moves in. A link can ask
       for the region with maps instead (view=region); if the map is not on screen yet (another tab
       is open), the fit waits until it is. */
    if (Q.get("view") === "region") { if (map.getContainer().clientWidth) fitRegion(0); else fitWhenShown = true; }
  });
  map.on("zoom", onZoom);
  map.on("move", onMove);
  map.on("mousemove", onHover);
  map.on("mouseout", () => { $("#roVal").textContent = ""; });
  map.on("click", onClick);
}
let fitWhenShown = false;
const fitRegion = (duration) => map.fitBounds([[CAT.bounds[0], CAT.bounds[1]], [CAT.bounds[2], CAT.bounds[3]]], { padding: fitPadding(), duration });
/* Room to leave for the panels over the map when a region is fitted. On a narrow map the coverage card
   would sit on the region, so the region is fitted to the right of it. */
function fitPadding() {
  const card = $("#coverCard"), narrow = map.getContainer().clientWidth < 820 && card.offsetParent !== null;
  return { top: 46, bottom: 76, left: narrow ? card.offsetLeft + card.offsetWidth + 12 : 40, right: 40 };
}
async function loadLand() {
  /* Natural Earth 1:50m land (public domain), cut at the antimeridian. A "stitched" outline such as
     world-atlas draws rings around the pole here, because MapLibre treats longitudes as planar.
     On the globe it lifts the continents a little off the imagery and fades out on the way in; it
     also answers whether a click fell on land (onLand). */
  try {
    landGeo = await (await fetch(new URL("assets/land-50m.json", location.href))).json();
    map.addSource("land", { type: "geojson", data: landGeo });
    const fade = (a) => ["interpolate", ["linear"], ["zoom"], 2.6, a, 5.2, 0];
    /* The tint goes under the background layer, so it shows only where that has no value (deserts, ice);
       the coastline goes over it. */
    map.addLayer({ id: "land", type: "fill", source: "land", paint: { "fill-color": "#F0EEE6", "fill-opacity": fade(0.17) } }, map.getLayer("ctx") ? "ctx" : "et");
    map.addLayer({ id: "land-line", type: "line", source: "land", paint: { "line-color": "#F0EEE6", "line-width": 0.7, "line-opacity": fade(0.5) } }, "et");
  } catch (e) { console.warn("[land outline]", e.message); }
}
/* The sample areas of a reduced copy: an outline each, and a tag that takes the visitor there. */
let fineTags = [];
function addFineAreas() {
  if (!FINE.length) return;
  map.addSource("fine", { type: "geojson", data: { type: "FeatureCollection",
    features: FINE.map((a) => ({ type: "Feature", properties: { id: a.id }, geometry: { type: "Polygon", coordinates: [a.ring] } })) } });
  map.addLayer({ id: "fine-casing", type: "line", source: "fine", minzoom: 5.5, paint: { "line-color": "rgba(15,19,24,.75)", "line-width": 3.6 } });
  map.addLayer({ id: "fine-line", type: "line", source: "fine", minzoom: 5.5, paint: { "line-color": "#ffffff", "line-width": 1.6 } });
  fineTags = FINE.map((a) => {
    const btn = el("button", { class: "fine-tag", title: `${a.name}: this area is shown at the native 30 m`,
      onclick: (e) => { e.stopPropagation(); goFine(a); } }, [a.name, el("small", {}, "30 m")]);       // not a click on the map underneath
    return new maplibregl.Marker({ element: el("div", {}, btn), anchor: "bottom", offset: [0, -3] }).setLngLat([a.center[0], a.bounds[3]]).addTo(map);
  });
  /* The same areas in the "Go to" list, ahead of the cities, and a line for them in the coverage card. */
  $("#jump").insertBefore(el("optgroup", { label: "30 m areas" }, FINE.map((a) => el("option", { value: "fine:" + a.id }, a.name))), $("#jumpCities"));
  $("#jump").options[0].textContent = "Go to…";
  $("#jump").setAttribute("aria-label", "Go to a 30 m area or a city");
  const row = $("#covFine");
  row.querySelector("span:last-child").replaceChildren(el("b", {}, "30 m"), ` · ${numWord(FINE.length)} sample area${FINE.length > 1 ? "s" : ""}`);
  row.hidden = false;
  onZoom();
}
function goFine(a) {
  if (popup) { popup.remove(); popup = null; }
  map.flyTo({ center: a.center, zoom: FINE_ZOOM - 0.3, duration: 1800 });
}
let cityMarkers = [], pulse = null;
function addMarkers() {
  const c = [(CAT.bounds[0] + CAT.bounds[2]) / 2 - 0.6, (CAT.bounds[1] + CAT.bounds[3]) / 2 - 0.6];      // on the region, its label to the right
  /* No position on the root: MapLibre makes a marker absolute, and overriding that turns it into a
     full-width block whose "centre" is half the map away. */
  const node = el("div", { style: "width:14px;height:14px" }, [el("div", { class: "pulse" }), el("div", { class: "pulse-label" }, "Available now")]);
  pulse = new maplibregl.Marker({ element: node, anchor: "center" }).setLngLat(c).addTo(map);
  cityMarkers = CITIES.map(([name, lng, lat]) =>
    new maplibregl.Marker({ element: el("div", {}, el("span", { class: "city" }, name)), anchor: "bottom" }).setLngLat([lng, lat]).addTo(map));
  onZoom();
}
function onZoom() {
  if (!map) return;
  const z = map.getZoom();
  if (pulse) pulse.getElement().style.display = z < 4.2 ? "" : "none";
  for (const m of cityMarkers) m.getElement().firstChild.style.opacity = z >= 5.6 && z <= 10.6 ? "1" : "0";
  /* Far out the areas are a few pixels apart, so each is a small square (its name shows on hover); the
     name tags come in once there is room for them. */
  for (const m of fineTags) { const t = m.getElement().firstChild; t.style.display = z >= 4.2 ? "" : "none"; t.classList.toggle("compact", z < 7); }
  $("#coverCard").classList.toggle("dim", z > 7.2);
  if (map.getLayer("et")) map.setPaintProperty("et", "raster-resampling", z > CAT.zoom.max - 0.4 ? "nearest" : "linear");
  onMove();
}
/* What depends on where the view is, not only on how far in: the resolution readout, the three-step
   pill and the note about what is published there. Once per frame while the map moves. */
let moveRAF = 0;
function onMove() { cancelAnimationFrame(moveRAF); moveRAF = requestAnimationFrame(updateView); }
function updateView() {
  if (!map) return;
  const z = map.getZoom(), c = map.getCenter(), ours = inBounds(c.lng, c.lat);
  const top = topZoomAt(c.lng, c.lat), zd = Math.min(tileZoom(), top), native = nativeAt(c.lng, c.lat);
  const step = zd <= 8 ? 0 : zd < top ? 1 : 2;
  $("#steps").classList.toggle("off", !ours && z >= 2.6);          // the three steps describe our maps: nothing to say elsewhere
  document.querySelectorAll("#steps span").forEach((s) => s.classList.toggle("on", ours && +s.dataset.step === step));
  if (!fullRes()) document.querySelector('#steps span[data-step="2"]').textContent = native ? "Native 30 m" : `Finest here · ${finestRes()}`;
  $("#roRes").textContent = z < 2.6 ? "Click or scroll to zoom in"
    : ours ? `${fmtRes(groundRes(zd, c.lat))} per pixel${zd === top ? (native ? " (native)" : " (finest here)") : ""}`
    : currentBg() ? `Background, ${fmt(BG.cell_km)} km cells` : "No ready-made maps here";
  updateNote();
}
/* The value under the cursor from a tile already decoded: the one on screen, else a coarser parent.
   undefined = nothing loaded there, 255 = no data. */
function dnAt(id, lng, lat, zTop) {
  for (let z = zTop; z >= 0; z--) {
    const t = lngLatToTile(lng, lat, z), dn = dnCache.get(`${id}/${z}/${t.x}/${t.y}`);
    if (dn !== undefined) return dn ? dn[t.py * TILE + t.px] : 255;
  }
  return undefined;
}
let hoverRAF = 0;
function onHover(e) {
  cancelAnimationFrame(hoverRAF);
  hoverRAF = requestAnimationFrame(() => {
    const { lng, lat } = e.lngLat, ly = currentLayer(), bg = currentBg(), out = $("#roVal");
    const d = inBounds(lng, lat) ? dnAt(ly.id, lng, lat, Math.min(srcMaxZoom(), tileZoom() + 1)) : undefined;
    if (d !== undefined && d !== 255) { out.textContent = `${fmt(d * ly.dn_step)} ${ly.units}`; return; }
    /* No value of ours there: say what the background shows, under its own name. */
    const b = bg ? dnAt(bg.id, lng, lat, Math.min(BG.zoom.max, tileZoom() + 1)) : undefined;
    out.textContent = b !== undefined && b !== 255 ? `${BG.name}: ${fmt(b * bg.dn_step)} ${bg.units}` : d === 255 ? "no data" : "";
  });
}
function onClick(e) {
  const { lng, lat } = e.lngLat, z = map.getZoom();
  if (popup) { popup.remove(); popup = null; }
  if (!inBounds(lng, lat)) {
    /* Outside the region with maps a click moves in on the place, in two steps, as far as the background
       has anything to show. There the note at the top says what is published, and the next click offers
       to request the place. */
    if (!onLand(lng, lat)) return;
    const stop = outNoteZoom(lat) + 0.2;
    if (z < 3.6) map.flyTo({ center: [lng, lat], zoom: 4.6, duration: 1400 });
    else if (z < stop - 0.4) map.flyTo({ center: [lng, lat], zoom: stop, duration: 1500 });
    else demandPopup(e.lngLat);
    return;
  }
  if (z < 8) map.flyTo({ center: [lng, lat], zoom: zRegional(), duration: 1500 });
  else if (nativeAt(lng, lat) && z < 10.8) map.flyTo({ center: [lng, lat], zoom: (CAT.zoom.native || CAT.zoom.max) - 0.3, duration: 1500 });      // on to the native grid, where the copy has it
  pickLocation(lng, lat);
}
function demandPopup(lngLat) {
  const node = el("div", { class: "pop" }, [
    el("p", {}, el("b", {}, "No ready-made maps here yet")),
    el("p", {}, `We can produce 30 m monthly ET for this place on request, for any month from ${demandWindow().text}.`),
    el("button", { class: "primary", onclick: () => { prefillRequest(lngLat.lng, lngLat.lat); showTab("request"); } }, "Request this area"),
  ]);
  popup = new maplibregl.Popup({ maxWidth: "300px" }).setLngLat(lngLat).setDOMContent(node).addTo(map);
}
/* A note at the top of the map when the view has gone past what is published at that place:
     "outside"  zoomed in on land that has no maps of ours (only the background, if any);
     "finest"   zoomed past the finest level of a reduced copy, outside its sample areas.
   It names what is on screen and where the detail is. Closing it keeps it closed until the view
   leaves that situation. */
let noteShown = null, noteOff = null;
const reviewClause = () => (CFG.paperStatus ? `While the paper is ${CFG.paperStatus}, ` : "");
const capFirst = (s) => s.charAt(0).toUpperCase() + s.slice(1);
function noteKind() {
  const z = map.getZoom(), c = map.getCenter();
  if (!inBounds(c.lng, c.lat)) return z >= outNoteZoom(c.lat) && onLand(c.lng, c.lat) ? "outside" : null;
  return !fullRes() && z >= CAT.zoom.max - 0.4 && !fineAreaAt(c.lng, c.lat) ? "finest" : null;
}
function updateNote(redraw) {
  const kind = noteKind(), box = $("#zoomNote");
  if (!kind) noteOff = null;
  const show = kind && noteOff !== kind ? kind : null;
  if (show === noteShown && !redraw) return;
  noteShown = show;
  box.hidden = !show;
  if (!show) return;
  const home = () => $("#btnHome").click();
  if (show === "outside") {
    const bg = currentBg();
    $("#znHead").textContent = "Only the Korean Peninsula has detailed maps for now";
    $("#znText").textContent = (bg ? `What you see here is the background layer (${BG.name}, about ${fmt(BG.cell_km)} km per cell), not Prithvi-OpenET-Tower. ` : "") +
      capFirst(`${reviewClause()}ready-made maps are published for the Korean Peninsula only. Other regions are produced on request.`);
    $("#znBtns").replaceChildren(
      el("button", { class: "primary small", onclick: home }, "Go to the Korean Peninsula"),
      el("button", { class: "ghost", onclick: () => { const c = map.getCenter(); prefillRequest(c.lng, c.lat); showTab("request"); } }, "Request this area"));
  } else {
    const n = FINE.length, c = map.getCenter();
    $("#znHead").textContent = `${finestRes()} is the finest level here for now`;
    $("#znText").textContent = n
      ? capFirst(`${reviewClause()}the native 30 m maps are shown only in ${fineWords()}. The full 30 m maps will be released after the paper is accepted.`)
      : `This public preview stops at about ${finestRes()} per pixel. The 30 m maps will be released after the paper is accepted.`;
    /* the nearest areas first; all of them are in the "Go to" list */
    const near = [...FINE].sort((a, b) => Math.hypot((a.center[0] - c.lng) * Math.cos(c.lat * Math.PI / 180), a.center[1] - c.lat) -
                                          Math.hypot((b.center[0] - c.lng) * Math.cos(c.lat * Math.PI / 180), b.center[1] - c.lat)).slice(0, 3);
    $("#znBtns").replaceChildren(...near.map((a) => el("button", { class: "primary small", onclick: () => goFine(a) }, `${a.name} · 30 m`)));
  }
}
/* "eight sample areas, around the paper's Korean flux-tower sites" — the catalog says what the areas are. */
const fineWords = () => `${numWord(FINE.length)} sample area${FINE.length > 1 ? "s" : ""}${FINE_WHAT ? `, ${FINE_WHAT}` : ""}`;
function syncBackground() {
  if (!map || !map.getLayer("ctx")) return;
  const bg = currentBg();
  if (bg) map.getSource("ctx").setTiles([bgTileURL(bg)]);
  map.setLayoutProperty("ctx", "visibility", bg ? "visible" : "none");
}
function applyLayer() {
  buildLUT();
  const src = map && map.getSource("et");
  if (src) src.setTiles([tileURL()]);
  syncBackground();
  renderLayerCard(); renderLegend(); renderWhen(); renderCalendar();
  if (!state.pick) renderPeninsulaSeries();
  if (map) { updateView(); updateNote(true); }                    // both name the background, which comes and goes with the layer
}

/* ───────────────────────────── layer controls ───────────────────────────── */
function builtYears() { return [...new Set(CAT.months.filter((m) => m.tiles).map((m) => m.ym.slice(0, 4)))]; }
function renderWhen() {
  const box = $("#when"); box.replaceChildren();
  document.querySelectorAll("#modeSeg button").forEach((b) => {
    b.classList.toggle("on", b.dataset.mode === state.mode);
    const ok = b.dataset.mode === "annual" ? L.has("clim_annual") : b.dataset.mode === "clim" ? (CAT.clim || []).length > 0 : builtYears().length > 0;
    b.disabled = !ok;
  });
  if (state.mode === "annual") { box.append(el("span", { class: "sub" }, `Sum of the twelve monthly means, ${TRAIN_YEARS()}`)); return; }
  let avail;
  if (state.mode === "month") {
    const y = state.ym.slice(0, 4);
    const sel = el("select", { "aria-label": "Year", onchange: (e) => {
      const have = CAT.months.filter((m) => m.tiles && m.ym.startsWith(e.target.value));
      state.ym = (have.find((m) => m.ym.slice(5) === state.ym.slice(5)) || have[0]).ym; state.seriesYear = e.target.value; stopPlay(); applyLayer();
      if (state.pick) loadPickSeries();
    } }, builtYears().map((yy) => el("option", { value: yy, selected: yy === y }, yy)));
    box.append(sel);
    avail = new Set(CAT.months.filter((m) => m.tiles && m.ym.startsWith(y)).map((m) => +m.ym.slice(5)));
  } else avail = new Set(CAT.clim.map((c) => c.month));
  const cur = state.mode === "month" ? +state.ym.slice(5) : state.climMonth;
  box.append(el("div", { class: "mon", role: "group", "aria-label": "Month" }, MON.map((name, i) =>
    el("button", { class: cur === i + 1 ? "on" : "", disabled: !avail.has(i + 1), title: MONL[i],
                   onclick: () => { stopPlay(); setMonth(i + 1); } }, name))));
  box.append(el("button", { class: "play", onclick: togglePlay, "aria-pressed": state.playing ? "true" : "false" }, state.playing ? "Pause" : "Play"));
}
function setMonth(m) {
  if (state.mode === "month") state.ym = `${state.ym.slice(0, 4)}-${String(m).padStart(2, "0")}`;
  else state.climMonth = m;
  applyLayer();
}
function stopPlay() { if (state.playing) { clearInterval(state.playing); state.playing = null; } }
function togglePlay() {
  if (state.playing) { stopPlay(); renderWhen(); return; }
  const months = state.mode === "month"
    ? CAT.months.filter((m) => m.tiles && m.ym.startsWith(state.ym.slice(0, 4))).map((m) => +m.ym.slice(5))
    : CAT.clim.map((c) => c.month);
  state.playing = setInterval(() => {
    const cur = state.mode === "month" ? +state.ym.slice(5) : state.climMonth;
    setMonth(months[(months.indexOf(cur) + 1) % months.length]);
  }, 1500);
  renderWhen();
}

/* ───────────────────────────── legend + layer card ───────────────────────────── */
function renderLegend() {
  const ly = currentLayer(), [lo, hi] = currentRange(ly);
  $("#lgTitle").textContent = `ET, ${ly.units}`;
  $("#lgBar").style.background = `linear-gradient(90deg, ${RAMP.map((c) => `rgb(${c.join(",")})`).join(",")})`;
  const mid = (lo + hi) / 2;
  $("#lgTicks").replaceChildren(el("span", {}, lo > 0 ? `≤ ${fmt(lo)}` : fmt(lo)), el("span", {}, fmt(mid)), el("span", {}, `≥ ${fmt(hi)}`));
  document.querySelectorAll("#scaleSeg button").forEach((b) => b.classList.toggle("on", b.dataset.scale === state.scale));
  const bg = currentBg(), note = $("#lgBg");
  note.hidden = !bg;
  if (bg) note.textContent = `Rest of the globe: ${BG.name}${BG.period ? `, ${BG.period} mean` : ""}, about ${fmt(BG.cell_km)} km — a background layer, not this model.`;
  drawHist(ly, lo, hi);
}
/* Distribution of the layer's pixels along the same axis as the colour bar. The histogram lives in the
   layer's sidecar .json (written by build_tiles.py) and is fetched only when the layer is shown. */
const histCache = new Map();
function layerHist(ly) {
  if (!histCache.has(ly.id)) {
    histCache.set(ly.id, fetch(fileURL(ly.file.replace(/\.pmtiles$/, ".json")))
      .then((r) => (r.ok ? r.json() : null)).then((j) => (j && j.hist_dn) || null).catch(() => null));
  }
  return histCache.get(ly.id);
}
async function drawHist(ly, lo, hi) {
  const c = $("#lgHist"), W = 240, H = 34, dpr = Math.min(2, devicePixelRatio || 1);
  const hist = await layerHist(ly);
  if (currentLayerId() !== ly.id) return;                       // a newer layer was selected meanwhile
  c.width = W * dpr; c.height = H * dpr;
  const g = c.getContext("2d"); g.scale(dpr, dpr); g.clearRect(0, 0, W, H);
  if (!hist) return;
  const cols = new Float64Array(W);
  hist.forEach((n, d) => { cols[clamp(Math.round((d * ly.dn_step - lo) / (hi - lo) * (W - 1)), 0, W - 1)] += n; });
  const top = Math.max(...cols.slice(1, W - 1), 1);              // the end columns collect everything off the scale
  g.fillStyle = "#8C8A80";
  for (let x = 0; x < W; x++) { const h = Math.min(H, cols[x] / top * (H - 2)); if (h > 0.3) g.fillRect(x, H - h, 1, h); }
}
function renderLayerCard() {
  const ly = currentLayer();
  $("#lyTitle").textContent = ly.label;
  const flag = $("#lyFlag"); flag.hidden = true;
  let sub = "";
  if (ly.kind === "annual") sub = `Sum of the twelve monthly means over ${TRAIN_YEARS()}. Gap-free wherever every calendar month was observed at least once.`;
  else if (ly.kind === "clim") sub = `Mean of the ${MONL[ly.month - 1]} maps over ${TRAIN_YEARS()}, using the years in which the pixel was observed.`;
  else {
    const r = ly.rec;
    sub = `${r.sensors === "L30" ? "Landsat only" : "Landsat and Sentinel-2"} · ${fmtBytes(r.cog_bytes)} GeoTIFF`;
    if (r.period !== "train") { flag.hidden = false; flag.textContent = `Outside the ${TRAIN_YEARS()} training period — the model is extrapolating in time.`; }
  }
  $("#lySub").textContent = sub;
  $("#lyMean").textContent = fmt(ly.mean);
  $("#lyUnit").textContent = ly.units;
  $("#lyMeanL").textContent = ly.kind === "month" ? "Mean over observed land" : "Peninsula mean";
  const cov = Math.min(100, ly.cover * 100);
  $("#lyCover").textContent = fmt(cov, cov < 99.5 ? 1 : 0);
  $("#lyCoverBar").style.width = cov + "%";
}

/* ───────────────────────────── chart (SVG) ───────────────────────────── */
function drawChart(model) {
  chartModel = model;
  const box = $("#chart"); box.replaceChildren();
  const all = model.series.flatMap((s) => s.values).filter((v) => v != null);
  if (!all.length) { box.append(el("p", { class: "chart-empty" }, model.empty || "No data at this location.")); renderSeriesTable(); return; }
  box.append(el("div", { class: "chart-legend" }, model.series.map((s) =>
    el("span", {}, [el("i", { class: "key", style: `border-color:${s.color}` }), s.name]))));
  const W = 360, H = 200, m = { l: 32, r: 44, t: 8, b: 22 }, pw = W - m.l - m.r, ph = H - m.t - m.b;
  const yMax = niceCeil(Math.max(...all) * 1.04), n = model.labels.length;
  const X = (i) => m.l + (n === 1 ? pw / 2 : pw * i / (n - 1)), Y = (v) => m.t + ph * (1 - v / yMax);
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", tabindex: "0",
    "aria-label": `${model.title}. ${model.series.map((s) => s.name).join(" and ")}, ${model.units}. Use the table below for values.` });
  for (let k = 0; k <= 4; k++) {
    const v = yMax * k / 4, y = Y(v);
    svg.append(svgEl("line", { class: k ? "gridline" : "axisline", x1: m.l, x2: W - m.r, y1: y, y2: y }));
    const t = svgEl("text", { x: m.l - 6, y: y + 3.5, "text-anchor": "end" }); t.textContent = fmt(v, yMax < 8 ? 1 : 0); svg.append(t);
  }
  model.labels.forEach((lb, i) => { const t = svgEl("text", { x: X(i), y: H - 6, "text-anchor": "middle" }); t.textContent = lb[0]; svg.append(t); });
  const ends = [];
  for (const s of model.series) {
    let d = "", pen = false, last = -1;
    s.values.forEach((v, i) => { if (v == null) { pen = false; return; } d += `${pen ? "L" : "M"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`; pen = true; last = i; });
    svg.append(svgEl("path", { d, fill: "none", stroke: s.color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));
    s.values.forEach((v, i) => {                                   // a lone point between gaps would otherwise be invisible
      if (v != null && s.values[i - 1] == null && s.values[i + 1] == null) svg.append(svgEl("circle", { cx: X(i), cy: Y(v), r: 2.5, fill: s.color }));
    });
    if (last >= 0) ends.push({ s, i: last, y: Y(s.values[last]) });
  }
  ends.sort((a, b) => a.y - b.y);
  for (let k = 1; k < ends.length; k++) if (ends[k].y - ends[k - 1].y < 12) { const mid = (ends[k].y + ends[k - 1].y) / 2; ends[k - 1].ly = mid - 6; ends[k].ly = mid + 6; }
  for (const e of ends) {
    svg.append(svgEl("circle", { cx: X(e.i), cy: e.y, r: 4, fill: e.s.color, stroke: "#fff", "stroke-width": 2 }));
    const t = svgEl("text", { class: "lbl", x: X(e.i) + 8, y: (e.ly ?? e.y) + 3.5 }); t.textContent = e.s.short || e.s.name; svg.append(t);
  }
  const cross = svgEl("line", { class: "cross", y1: m.t, y2: m.t + ph, visibility: "hidden" });
  const dots = model.series.map((s) => svgEl("circle", { r: 4, fill: s.color, stroke: "#fff", "stroke-width": 2, visibility: "hidden" }));
  svg.append(cross, ...dots);
  let cur = -1;
  const show = (i, cxp, cyp) => {
    cur = i;
    cross.setAttribute("x1", X(i)); cross.setAttribute("x2", X(i)); cross.setAttribute("visibility", "visible");
    model.series.forEach((s, k) => {
      const v = s.values[i];
      dots[k].setAttribute("visibility", v == null ? "hidden" : "visible");
      if (v != null) { dots[k].setAttribute("cx", X(i)); dots[k].setAttribute("cy", Y(v)); }
    });
    showTip([el("div", { class: "t-h" }, model.tipHead ? model.tipHead(i) : model.labels[i]),
      ...model.series.map((s) => el("div", { class: "t-r" }, [el("i", { class: "key", style: `border-color:${s.color}` }),
        el("b", {}, s.values[i] == null ? "no data" : `${fmt(s.values[i], model.digits || 0)} ${model.units}`), el("span", { class: "n" }, s.name)]))], cxp, cyp);
  };
  const hide = () => { cur = -1; cross.setAttribute("visibility", "hidden"); dots.forEach((d) => d.setAttribute("visibility", "hidden")); hideTip(); };
  svg.addEventListener("pointermove", (e) => {
    const r = svg.getBoundingClientRect(), x = (e.clientX - r.left) / r.width * W;
    show(clamp(Math.round((x - m.l) / pw * (n - 1)), 0, n - 1), e.clientX, e.clientY);
  });
  svg.addEventListener("pointerleave", hide);
  svg.addEventListener("blur", hide);
  svg.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const i = clamp((cur < 0 ? 0 : cur) + (e.key === "ArrowRight" ? 1 : -1) * (cur < 0 ? 0 : 1), 0, n - 1), r = svg.getBoundingClientRect();
    show(i, r.left + X(i) / W * r.width, r.top + r.height * 0.35);
  });
  box.append(svg);
  renderSeriesTable();
}
function renderSeriesTable() {
  const wrap = $("#srTable"), mdl = chartModel; wrap.replaceChildren();
  if (!mdl) return;
  const t = el("table", { class: "grid" }, [
    el("thead", {}, el("tr", {}, [el("th", {}, "Month"), ...mdl.series.map((s) => el("th", { class: "num" }, `${s.name} (${mdl.units})`))])),
    el("tbody", {}, mdl.labels.map((lb, i) => el("tr", {}, [el("td", {}, lb),
      ...mdl.series.map((s) => el("td", { class: "num" }, s.values[i] == null ? "no data" : fmt(s.values[i], mdl.digits || 0)))]))),
  ]);
  wrap.append(t);
}
function seriesCSV() {
  const mdl = chartModel; if (!mdl) return "";
  const rows = [["month", ...mdl.series.map((s) => `${s.name} (${mdl.units})`)].join(",")];
  mdl.labels.forEach((lb, i) => rows.push([lb, ...mdl.series.map((s) => s.values[i] == null ? "" : s.values[i])].join(",")));
  return `# ${mdl.title}\n# ${mdl.note || ""}\n` + rows.join("\n") + "\n";
}
function yearSeriesFromCatalog(year) {
  return MON.map((_, i) => { const r = CAT.months.find((m) => m.ym === `${year}-${String(i + 1).padStart(2, "0")}`); return r && r.tiles ? r.tiles.mean : null; });
}
function renderPeninsulaSeries() {
  const y = state.seriesYear, clim = MON.map((_, i) => { const c = (CAT.clim || []).find((k) => k.month === i + 1); return c ? c.mean : null; });
  const series = [];
  if (y) series.push({ name: y, short: y, color: "#2E7BA8", values: yearSeriesFromCatalog(y) });
  series.push({ name: `${TRAIN_YEARS()} mean`, short: "mean", color: "#8C8A80", values: clim });
  $("#srKicker").textContent = "Seasonal cycle"; $("#srTitle").textContent = "Peninsula mean"; $("#srReset").hidden = true;
  $("#srSub").textContent = y ? `Monthly ET averaged over the land observed in each month of ${y}, against the ${TRAIN_YEARS()} mean. Cloudy months average fewer pixels.` : "";
  drawChart({ title: "Peninsula mean monthly ET", labels: MON, units: "mm/month", digits: 1, series,
              note: "mean over land pixels with a clear-sky observation", tipHead: (i) => MONL[i] });
}

/* ───────────────────────────── pixel series ───────────────────────────── */
function pickLocation(lng, lat) {
  state.pick = { lng, lat };
  recordModel = null; $("#recordBox").hidden = true;             // the previous pixel's record must not sit under the new title
  if (!pickMarker) pickMarker = new maplibregl.Marker({ color: "#B85434", scale: 0.75 });
  pickMarker.setLngLat([lng, lat]).addTo(map);
  loadPickSeries();
}
async function loadPickSeries() {
  const { lng, lat } = state.pick, z = topZoomAt(lng, lat), t = lngLatToTile(lng, lat, z), y = state.seriesYear;
  const where = `${Math.abs(lat).toFixed(4)}°${lat >= 0 ? "N" : "S"}, ${Math.abs(lng).toFixed(4)}°${lng >= 0 ? "E" : "W"}`;
  $("#srKicker").textContent = cellNameAt(lng, lat); $("#srTitle").textContent = where; $("#srReset").hidden = false;
  $("#srSub").textContent = "Reading the monthly maps…";
  const ids = [...MON.map((_, i) => `et_${y}${String(i + 1).padStart(2, "0")}`), ...MON.map((_, i) => `clim_${String(i + 1).padStart(2, "0")}`), "clim_annual"];
  let vals;
  try {
    vals = await mapLimit(ids, 8, async (id) => {
      if (!L.has(id)) return null;
      const dn = await getDN(id, z, t.x, t.y), d = dn ? dn[t.py * TILE + t.px] : 255;
      return d === 255 ? null : d * L.get(id).dn_step;
    });
  } catch (e) { $("#srSub").textContent = "Could not read the tiles: " + e.message; return; }
  if (!state.pick || state.pick.lng !== lng || state.pick.lat !== lat) return;         // a newer click won
  const yr = vals.slice(0, 12), clim = vals.slice(12, 24), annual = vals[24];
  if (yr.every((v) => v == null) && clim.every((v) => v == null)) {
    if (onLand(lng, lat) && annual == null) demandPopup({ lng, lat });
    $("#srSub").textContent = "No estimate at this spot — it is water or outside the mapped land.";
    drawChart({ title: where, labels: MON, units: "mm/month", series: [], empty: "No data at this location." });
    $("#recordBox").hidden = true;
    return;
  }
  const nObs = yr.filter((v) => v != null).length;
  $("#srSub").textContent = `${annual == null ? "" : `Mean annual ET ${fmt(annual)} mm/year (${TRAIN_YEARS()}). `}` +
    `${nObs} of 12 months of ${y} had a clear observation here.`;
  drawChart({ title: `Monthly ET at ${where}`, labels: MON, units: "mm/month", tipHead: (i) => `${MONL[i]}`,
    note: (nativeAt(lng, lat) ? "browse-tile values" : `means over a ${finestRes()} cell of the public preview tiles`) + ", rounded to 1 mm/month; use the GeoTIFFs for analysis",
    series: [{ name: y, short: y, color: "#2E7BA8", values: yr }, { name: `${TRAIN_YEARS()} mean`, short: "mean", color: "#8C8A80", values: clim }] });
  if (!recordModel || recordModel.pick !== state.pick) loadPickRecord(where);      // a year change keeps the record already read
}

/* ───────────────────────────── full record at a pixel ─────────────────────────────
   Every month that has browse tiles, read at the native zoom: one small range request per month
   once each archive's directory is cached. Missing months (cloud, or never produced) stay gaps. */
let recordModel = null;
async function loadPickRecord(where) {
  const mine = state.pick, { lng, lat } = mine, months = CAT.months.filter((m) => m.tiles);
  const z = topZoomAt(lng, lat), t = lngLatToTile(lng, lat, z);
  recordModel = null;
  $("#recordBox").hidden = false;
  $("#chartRecord").replaceChildren(); $("#rcTable").replaceChildren();
  let done = 0;
  const say = () => { if (state.pick === mine) $("#rcSub").textContent = `Reading the monthly maps… ${done} of ${months.length}`; };
  say();
  let vals;
  try {
    vals = await mapLimit(months, 10, async (m) => {
      if (state.pick !== mine) return null;                      // a newer click won: stop asking for tiles
      const dn = await getDN(m.tiles.id, z, t.x, t.y), d = dn ? dn[t.py * TILE + t.px] : 255;
      if (++done % 8 === 0) say();
      return d === 255 ? null : d * m.tiles.dn_step;
    });
  } catch (e) { if (state.pick === mine) $("#rcSub").textContent = "Could not read the tiles: " + e.message; return; }
  if (state.pick !== mine) return;
  const n = vals.filter((v) => v != null).length;
  $("#rcSub").textContent = `${n} of ${months.length} months had a clear observation here. Shaded years lie outside the ${TRAIN_YEARS()} training period.`;
  recordModel = { pick: mine, where, months, vals };
  drawRecord();
}
function drawRecord() {
  const R = recordModel, box = $("#chartRecord"); box.replaceChildren();
  if (!R) return;
  const ymIdx = (ym) => +ym.slice(0, 4) * 12 + (+ym.slice(5) - 1);
  const i0 = ymIdx(CAT.record.first), N = ymIdx(CAT.record.last) - i0 + 1;
  const byIdx = new Array(N).fill(undefined);                     // undefined = no map for that month, null = no clear observation
  R.months.forEach((m, k) => { byIdx[ymIdx(m.ym) - i0] = { m, v: R.vals[k] }; });
  const all = R.vals.filter((v) => v != null);
  if (!all.length) { box.append(el("p", { class: "chart-empty" }, "No clear observation in any month.")); return; }
  const W = 360, H = 150, mg = { l: 32, r: 8, t: 8, b: 20 }, pw = W - mg.l - mg.r, ph = H - mg.t - mg.b;
  const yMax = niceCeil(Math.max(...all) * 1.04);
  const X = (i) => mg.l + pw * i / (N - 1), Y = (v) => mg.t + ph * (1 - v / yMax);
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", tabindex: "0",
    "aria-label": `Monthly ET at ${R.where}, ${ymLabel(CAT.record.first)} to ${ymLabel(CAT.record.last)}, mm/month. Use the table below for values.` });
  const t0 = ymIdx(CAT.record.train[0]) - i0, t1 = ymIdx(CAT.record.train[1]) - i0;
  if (t0 > 0) svg.append(svgEl("rect", { class: "band", x: X(0), y: mg.t, width: X(t0) - X(0), height: ph }));
  if (t1 < N - 1) svg.append(svgEl("rect", { class: "band", x: X(t1), y: mg.t, width: X(N - 1) - X(t1), height: ph }));
  for (let k = 0; k <= 2; k++) {
    const v = yMax * k / 2, y = Y(v);
    svg.append(svgEl("line", { class: k ? "gridline" : "axisline", x1: mg.l, x2: W - mg.r, y1: y, y2: y }));
    const tx = svgEl("text", { x: mg.l - 6, y: y + 3.5, "text-anchor": "end" }); tx.textContent = fmt(v); svg.append(tx);
  }
  for (let yy = Math.ceil(i0 / 12); yy * 12 <= i0 + N - 1; yy++) {
    if (yy % 2) continue;
    const x = X(yy * 12 - i0);
    svg.append(svgEl("line", { class: "axisline", x1: x, x2: x, y1: mg.t + ph, y2: mg.t + ph + 3 }));
    const tx = svgEl("text", { x, y: H - 5, "text-anchor": "middle" }); tx.textContent = String(yy); svg.append(tx);
  }
  let d = "", pen = false;
  const val = (i) => (byIdx[i] && byIdx[i].v != null ? byIdx[i].v : null);
  for (let i = 0; i < N; i++) {
    const v = val(i);
    if (v == null) { pen = false; continue; }
    d += `${pen ? "L" : "M"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`; pen = true;
    if (val(i - 1) == null && val(i + 1) == null) svg.append(svgEl("circle", { cx: X(i), cy: Y(v), r: 1.6, fill: "#2E7BA8" }));
  }
  svg.append(svgEl("path", { d, fill: "none", stroke: "#2E7BA8", "stroke-width": 1.5, "stroke-linejoin": "round", "stroke-linecap": "round" }));
  const cross = svgEl("line", { class: "cross", y1: mg.t, y2: mg.t + ph, visibility: "hidden" });
  const dot = svgEl("circle", { r: 3.5, fill: "#2E7BA8", stroke: "#fff", "stroke-width": 2, visibility: "hidden" });
  svg.append(cross, dot);
  let cur = -1;
  const ymOf = (i) => `${Math.floor((i0 + i) / 12)}-${String((i0 + i) % 12 + 1).padStart(2, "0")}`;
  const show = (i, cxp, cyp) => {
    cur = i;
    const e = byIdx[i], v = val(i);
    cross.setAttribute("x1", X(i)); cross.setAttribute("x2", X(i)); cross.setAttribute("visibility", "visible");
    dot.setAttribute("visibility", v == null ? "hidden" : "visible");
    if (v != null) { dot.setAttribute("cx", X(i)); dot.setAttribute("cy", Y(v)); }
    showTip([el("div", { class: "t-h" }, ymLabel(ymOf(i))),
      el("div", { class: "t-r" }, [el("i", { class: "key", style: "border-color:#2E7BA8" }),
        el("b", {}, v != null ? `${fmt(v)} mm/month` : e ? "no clear observation" : "no map for this month")]),
      e && e.m.period !== "train" ? el("div", { class: "t-h" }, "outside the training period") : ""].filter(Boolean), cxp, cyp);
  };
  const hide = () => { cur = -1; cross.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); hideTip(); };
  svg.addEventListener("pointermove", (ev) => {
    const r = svg.getBoundingClientRect(), x = (ev.clientX - r.left) / r.width * W;
    show(clamp(Math.round((x - mg.l) / pw * (N - 1)), 0, N - 1), ev.clientX, ev.clientY);
  });
  svg.addEventListener("pointerleave", hide);
  svg.addEventListener("blur", hide);
  svg.addEventListener("keydown", (ev) => {
    if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
    ev.preventDefault();
    const i = clamp(cur < 0 ? 0 : cur + (ev.key === "ArrowRight" ? 1 : -1), 0, N - 1), r = svg.getBoundingClientRect();
    show(i, r.left + X(i) / W * r.width, r.top + r.height * 0.3);
  });
  box.append(svg);
  $("#rcTable").replaceChildren(el("table", { class: "grid" }, [
    el("thead", {}, el("tr", {}, [el("th", {}, "Month"), el("th", { class: "num" }, "ET (mm/month)"), el("th", {}, "Period")])),
    el("tbody", {}, R.months.map((m, k) => el("tr", {}, [el("td", {}, m.ym), el("td", { class: "num" }, R.vals[k] == null ? "no data" : fmt(R.vals[k])),
      el("td", {}, m.period === "train" ? "training" : "extrapolated")])))]));
}
function recordCSV() {
  const R = recordModel; if (!R) return "";
  const { lng, lat } = R.pick;
  return [`# Prithvi-OpenET-Tower monthly ET at ${lat.toFixed(5)}N ${lng.toFixed(5)}E (${cellNameAt(lng, lat)}), data version ${CAT.version}`,
    "# Browse-tile values rounded to 1 mm/month and resampled to Web Mercator. Use the GeoTIFFs for analysis." +
      (nativeAt(lng, lat) ? "" : ` This public copy of the tiles stops at about ${finestRes()} per pixel: each value is the mean over such a cell.`),
    "# Empty et_mm_per_month = no clear-sky observation that month. period: train = within the model's training years.",
    "month,et_mm_per_month,period,sensors",
    ...R.months.map((m, k) => [m.ym, R.vals[k] == null ? "" : R.vals[k], m.period, m.sensors].join(","))].join("\n") + "\n";
}

/* ───────────────────────────── calendar of the record ───────────────────────────── */
function renderCalendar() {
  const box = $("#cal"); box.replaceChildren(el("span"));
  MON.forEach((mn) => box.append(el("span", { class: "cal-h" }, mn[0])));
  const y0 = +CAT.record.first.slice(0, 4), y1 = +CAT.record.last.slice(0, 4), byYm = new Map(CAT.months.map((m) => [m.ym, m]));
  const cls = (c) => COVER_STEPS[clamp(Math.floor(c * 5), 0, 4)];
  for (let y = y0; y <= y1; y++) {
    const train = `${y}-01` >= CAT.record.train[0] && `${y}-12` <= CAT.record.train[1];
    box.append(el("span", { class: "cal-y" + (train ? " train" : "") }, String(y)));
    for (let mo = 1; mo <= 12; mo++) {
      const ym = `${y}-${String(mo).padStart(2, "0")}`, r = byYm.get(ym);
      let node, lines;
      if (!r) {
        node = el("span", { class: "cal-c none" });
        lines = [ymLabel(ym), ym < CAT.record.first || ym > CAT.record.last ? "outside the record" : "not produced — an input was unavailable"];
      } else if (r.tiles) {
        node = el("button", { class: "cal-c built" + (state.mode === "month" && state.ym === ym ? " sel" : ""), style: `background:${cls(r.tiles.cover)}`,
          "aria-label": `${ymLabel(ym)}, ${Math.round(r.tiles.cover * 100)}% of land observed`,
          onclick: () => { stopPlay(); state.mode = "month"; state.ym = ym; state.seriesYear = ym.slice(0, 4); applyLayer(); if (state.pick) loadPickSeries(); } });
        lines = [ymLabel(ym), `${fmt(r.tiles.cover * 100, 1)}% of land observed · mean ${fmt(r.tiles.mean)} mm/month`, r.period === "train" ? "training period" : "extrapolated in time"];
      } else {
        node = el("span", { class: "cal-c pending", tabindex: "0" });
        lines = [ymLabel(ym), `GeoTIFF ready (${fmtBytes(r.cog_bytes)}) · map tiles not built yet`, r.period === "train" ? "training period" : "extrapolated in time"];
      }
      const tipNodes = () => [el("div", { class: "t-h" }, lines[0]), ...lines.slice(1).map((s) => el("div", {}, s))];
      node.addEventListener("pointerenter", (e) => showTip(tipNodes(), e.clientX, e.clientY));
      node.addEventListener("pointerleave", hideTip);
      node.addEventListener("focus", () => { const b = node.getBoundingClientRect(); showTip(tipNodes(), b.left, b.top); });
      node.addEventListener("blur", hideTip);
      box.append(node);
    }
  }
  const nBuilt = CAT.record.with_tiles;
  $("#calSub").textContent = `${CAT.record.n} monthly GeoTIFFs from ${ymLabel(CAT.record.first)} to ${ymLabel(CAT.record.last)}. ` +
    (nBuilt < CAT.record.n ? `Map tiles exist for ${nBuilt} of them in this prototype. ` : "") + `Bold years are the model's training period.`;
  $("#calLegend").replaceChildren(
    el("span", {}, ["Land observed: ", ...COVER_STEPS.map((c) => el("i", { style: `background:${c}` })), " 0 → 100%"]),
    nBuilt < CAT.record.n ? el("span", {}, [el("i", { style: "box-shadow:inset 0 0 0 1px #D9D5C7;background:#FAF9F5" }), "tiles not built yet"]) : "",
    el("span", {}, [el("i", { style: "background:radial-gradient(circle,#D9D5C7 1.5px,transparent 2px)" }), "no map"]));
}

/* ───────────────────────────── download + code ───────────────────────────── */
const fileAddress = (rel) => (CFG.cogBase ? CFG.cogBase.replace(/\/$/, "") + "/" + rel : CFG.nasPath ? CFG.nasPath.replace(/\/$/, "") + "/" + rel : rel);
function renderDownload() {
  const notice = $("#dlNotice"); notice.replaceChildren();
  if (CFG.cogBase) notice.append("Files download directly from the links below.");
  else {
    notice.append(el("b", {}, "Public download links are not open yet. "), "They will be added here after the paper is accepted.");
    if (CFG.nasPath) notice.append(el("br"), "Lab members: the files are on the lab storage under ", el("code", {}, CFG.nasPath + "/et_30m/"), ".");
  }
  const years = [...new Set(CAT.months.map((m) => m.ym.slice(0, 4)))], sel = $("#dlYear");
  sel.replaceChildren(el("option", { value: "" }, "All years"), ...years.map((y) => el("option", { value: y }, y)));
  const body = $("#dlTable tbody");
  const draw = () => {
    const rows = CAT.months.filter((m) => !sel.value || m.ym.startsWith(sel.value));
    body.replaceChildren(...rows.map((m) => {
      const name = m.cog.split("/").pop();
      return el("tr", {}, [el("td", {}, ymLabel(m.ym)),
        el("td", { class: "mono" }, CFG.cogBase ? el("a", { href: fileAddress(m.cog) }, name) : name),
        el("td", { class: "num" }, fmtBytes(m.cog_bytes)),
        el("td", {}, el("span", { class: "pill" + (m.period === "train" ? "" : " ex") }, m.period === "train" ? "training period" : "extrapolated")),
        el("td", {}, m.sensors === "L30" ? "Landsat" : "Landsat + Sentinel-2"),
        el("td", {}, m.tiles ? "yes" : "—"),
        el("td", { class: "mono", title: m.sha256 }, m.sha256 ? m.sha256.slice(0, 12) + "…" : "—")]);
    }));
    $("#dlTotal").textContent = `${rows.length} files · ${fmtBytes(rows.reduce((a, m) => a + m.cog_bytes, 0))}`;
  };
  sel.onchange = draw; draw();
  const picked = () => CAT.months.filter((m) => !sel.value || m.ym.startsWith(sel.value));
  $("#dlCopy").onclick = (e) => copyText(picked().map((m) => fileAddress(m.cog)).join("\n"), e.currentTarget);
  $("#dlSums").onclick = () => download("SHA256SUMS.txt", picked().filter((m) => m.sha256).map((m) => `${m.sha256}  ${m.cog}`).join("\n") + "\n", "text/plain");
}
function renderCode() {
  const base = CFG.cogBase ? CFG.cogBase.replace(/\/$/, "") : CFG.nasPath ? CFG.nasPath.replace(/\/$/, "") : "https://<address announced at publication>";
  $("#codePy").textContent =
`import rasterio
from rasterio.warp import transform_bounds
from rasterio.windows import from_bounds

src_path = "${base}/et_30m/2021/KP_ET30m_202107.tif"        # July 2021
west, south, east, north = 127.15, 38.10, 127.45, 38.30      # lon/lat box: the Cheorwon plain

with rasterio.open(src_path) as src:
    box = transform_bounds("EPSG:4326", src.crs, west, south, east, north)
    win = from_bounds(*box, transform=src.transform)
    et = src.read(1, window=win, masked=True) * 0.1          # mm/month
    spread = src.read(2, window=win, masked=True) * 0.1      # disagreement among the nine models
    print(src.tags().get("period_flag"), float(et.mean()), int(et.count()), "valid pixels")`;
  $("#codeTs").textContent =
`import rasterio
from rasterio.warp import transform

base = "${base}/et_30m"
lon, lat = 127.28, 38.20
months = [f"{y}{m:02d}" for y in range(2016, 2025) for m in range(1, 13)]

xy, series = None, {}
for ym in months:
    with rasterio.open(f"{base}/{ym[:4]}/KP_ET30m_{ym}.tif") as src:
        if xy is None:                                        # the grid is EPSG:5179, not lon/lat
            xs, ys = transform("EPSG:4326", src.crs, [lon], [lat])
            xy = (xs[0], ys[0])
        v = next(src.sample([xy], indexes=1))[0]
        series[ym] = None if v == src.nodata else v * 0.1     # mm/month; None = no clear observation`;
  document.querySelectorAll(".copy").forEach((b) => { b.onclick = () => copyText($("#" + b.dataset.copy).textContent, b); });
}

/* ───────────────────────────── on-demand request ───────────────────────────── */
const fld = (k) => $("#rqForm").elements.namedItem(k);      // never form.name — that is the form's own property
function prefillRequest(lng, lat) {
  const r = (v) => Math.round(v * 100) / 100;
  fld("w").value = r(clamp(lng - 0.5, -180, 180)); fld("e").value = r(clamp(lng + 0.5, -180, 180));
  fld("s").value = r(clamp(lat - 0.5, -90, 90)); fld("n").value = r(clamp(lat + 0.5, -90, 90));
  updateArea();
}
function boxInfo() {
  const w = +fld("w").value, e = +fld("e").value, s = +fld("s").value, n = +fld("n").value;
  if (["w", "e", "s", "n"].some((k) => fld(k).value === "") || !(e > w) || !(n > s)) return null;
  const km2 = (e - w) * 111.32 * Math.cos((s + n) / 2 * Math.PI / 180) * (n - s) * 110.57;
  return { w, e, s, n, km2, tiles: Math.max(1, Math.ceil(km2 / (109.8 * 109.8))) };
}
function updateArea() {
  const b = boxInfo(), out = $("#rqArea");
  out.textContent = b ? `About ${fmt(b.km2 < 100 ? b.km2 : Math.round(b.km2 / 100) * 100)} km² — roughly ${fmt(b.tiles)} HLS tile${b.tiles > 1 ? "s" : ""}, ${fmt(Math.round(b.km2 / 0.0009 / 1e6))} million 30 m pixels per month.`
    : "Longitude and latitude in degrees. Tip: on the map, zoom in on a place outside Korea and choose “Request this area”.";
}
function requestText() {
  const b = boxInfo(), v = (k) => fld(k).value.trim();
  if (["name", "org", "email", "region", "from", "to", "use"].some((k) => !v(k))) return { error: "Please fill in every field." };
  if (!fld("email").checkValidity()) return { error: "That email address does not look right." };
  if (!b) return { error: "The box needs West < East and South < North." };
  const win = demandWindow();
  const from = v("from"), to = v("to"), isYm = (x) => /^\d{4}-(0[1-9]|1[0-2])$/.test(x);
  if (!isYm(from) || !isYm(to)) return { error: "Write the months as YYYY-MM, for example 2019-05." };   // browsers without a month picker show a plain text box
  if (from > to) return { error: "The first month is after the last month." };
  if (from < win.first || to > win.last) return { error: `The period has to fall between ${ymLabel(win.first)} and ${ymLabel(win.last)}.` };
  const months = (+to.slice(0, 4) - +from.slice(0, 4)) * 12 + (+to.slice(5) - +from.slice(5)) + 1;
  const body = [
    "Prithvi-OpenET-Tower — on-demand request", "",
    `Name: ${v("name")}`, `Affiliation: ${v("org")}`, `Email: ${v("email")}`, "",
    `Region: ${v("region")}`,
    `Bounding box (W, S, E, N): ${b.w}, ${b.s}, ${b.e}, ${b.n}`,
    `Approximate area: ${fmt(Math.round(b.km2))} km2 (about ${b.tiles} HLS tile${b.tiles > 1 ? "s" : ""})`,
    `Period: ${from} to ${to} (${months} month${months > 1 ? "s" : ""})`, "",
    "Intended use:", v("use"), "",
    "Sent from the Prithvi-OpenET-Tower data portal.",
  ].join("\n");
  return { subject: `[Prithvi-OpenET-Tower] On-demand request: ${v("region")}`, body,
           data: { name: v("name"), org: v("org"), email: v("email"), region: v("region"), bbox: { w: b.w, s: b.s, e: b.e, n: b.n }, from, to, use: v("use") } };
}
function initRequest() {
  const win = demandWindow(), f = $("#rqForm");
  $("#rqLead").textContent = "Prithvi-OpenET-Tower runs on inputs that exist worldwide, so the same 30 m monthly ET can be produced for other regions. Tell us where and when.";
  $("#rqWindow").textContent = `Any month from ${win.text} — the most recent months wait for the input data to arrive.`;
  $("#abDemand").textContent = `Only the Korean Peninsula is ready to browse and download. For any other land area covered by HLS, we produce the maps on request for any month from ${win.text}. Use the “Request a region” tab.`;
  /* Two ways out. With a request endpoint (the Worker in worker/) the form is posted and arrives as an
     email; without one the page can only open a draft in the visitor's own mail program. */
  const viaEndpoint = /^https:\/\/|^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(CFG.requestEndpoint);
  const HOW = viaEndpoint
    ? `The form goes to the HydroAI Lab (${CFG.requestEmail}) by email; this page keeps nothing. We reply by email about feasibility and timing.`
    : `The button opens a draft in your mail program, addressed to ${CFG.requestEmail}. Nothing is sent or stored by this page. We reply by email about feasibility and timing.`;
  $("#rqHow").textContent = HOW;
  $("#rqSend").textContent = viaEndpoint ? "Send request" : "Open the email draft";
  $("#rqMail").hidden = !viaEndpoint;
  for (const k of ["from", "to"]) { fld(k).min = win.first; fld(k).max = win.last; }
  for (const k of ["w", "s", "e", "n"]) fld(k).addEventListener("input", updateArea);
  const fail = (msg) => { const e = $("#rqError"); e.textContent = msg; e.hidden = !msg; };
  const done = (msg) => { const e = $("#rqDone"); e.textContent = msg; e.hidden = !msg; };
  const openDraft = (t) => {
    location.href = `mailto:${CFG.requestEmail}?subject=${encodeURIComponent(t.subject)}&body=${encodeURIComponent(t.body)}`;
    $("#rqHow").textContent = `Your mail program should now show the draft. If nothing opened, use “Copy the request text” and send it to ${CFG.requestEmail}.`;
  };
  let firstTouch = 0;                       // when the visitor first touched the form: the Worker drops instant submissions
  f.addEventListener("focusin", () => { if (!firstTouch) firstTouch = performance.now(); });
  f.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const t = requestText();
    if (t.error) return fail(t.error);
    fail(""); done("");
    if (!viaEndpoint) return openDraft(t);
    const btn = $("#rqSend");
    btn.disabled = true; btn.textContent = "Sending…";
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 20000);
    try {
      const r = await fetch(CFG.requestEndpoint, { method: "POST", headers: { "Content-Type": "application/json" }, signal: ctl.signal,
        body: JSON.stringify({ ...t.data, website: fld("website").value, elapsed_ms: firstTouch ? Math.round(performance.now() - firstTouch) : 0 }) });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.ok) {
        done(`Request sent. We will reply to ${t.data.email} about feasibility and timing.`);
        f.reset(); updateArea(); firstTouch = 0; $("#rqHow").textContent = HOW;
      } else {
        const fixable = r.status === 400 || r.status === 413 || r.status === 429;      // the server's message says what to change
        fail((j.error || `The request could not be sent (HTTP ${r.status}).`) + (fixable ? "" : " You can use the email draft instead."));
      }
    } catch {
      fail("The request could not be sent — no answer from the server. You can use the email draft instead.");
    } finally {
      clearTimeout(timer); btn.disabled = false; btn.textContent = "Send request";
    }
  });
  $("#rqMail").onclick = () => { const t = requestText(); if (t.error) return fail(t.error); fail(""); openDraft(t); };
  $("#rqCopy").onclick = (ev) => { const t = requestText(); if (t.error) return fail(t.error); fail(""); copyText(`To: ${CFG.requestEmail}\nSubject: ${t.subject}\n\n${t.body}`, ev.currentTarget); };
  $("#btnRequestHere").onclick = () => showTab("request");
}

/* ───────────────────────────── tabs, embed, wiring ───────────────────────────── */
function showTab(name) {
  document.querySelectorAll(".tab").forEach((t) => { const on = t.dataset.tab === name; t.classList.toggle("on", on); t.setAttribute("aria-selected", on); });
  document.querySelectorAll(".tabpane").forEach((p) => { const on = p.id === "tab-" + name; p.hidden = !on; p.classList.toggle("on", on); });
  if (name === "explore" && map) {
    map.resize();
    if (fitWhenShown) { fitWhenShown = false; fitRegion(0); }
  }
  hideTip(); sendHeight();
}
function sendHeight() {
  if (window.parent === window) return;
  /* The page's own height, not scrollHeight: inside a frame that starts tall, scrollHeight is never
     less than the frame, so the frame could only grow and the page would end in a blank stretch. */
  const h = Math.ceil(document.body.getBoundingClientRect().height);
  window.parent.postMessage({ type: "portalHeight", height: h }, "*");
}
function wire() {
  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => showTab(t.dataset.tab)));
  document.querySelectorAll("#modeSeg button").forEach((b) => b.addEventListener("click", () => { stopPlay(); state.mode = b.dataset.mode; applyLayer(); }));
  document.querySelectorAll("#scaleSeg button").forEach((b) => b.addEventListener("click", () => { state.scale = b.dataset.scale; applyLayer(); }));
  $("#opacity").addEventListener("input", (e) => {
    map.setPaintProperty("et", "raster-opacity", e.target.value / 100);
    if (map.getLayer("ctx")) map.setPaintProperty("ctx", "raster-opacity", ctxOpacity(e.target.value / 100));
  });
  $("#znClose").onclick = () => { noteOff = noteShown; updateNote(); };
  $("#jump").append(el("optgroup", { label: "Cities", id: "jumpCities" }, CITIES.map(([name], i) => el("option", { value: i }, name))));
  $("#jump").onchange = (e) => {                                   // regional view around the city, or a sample area; the list snaps back to its prompt
    const v = e.target.value, area = v.startsWith("fine:") ? FINE.find((a) => a.id === v.slice(5)) : null, c = area ? null : CITIES[+v];
    if (area) goFine(area);
    else if (v !== "" && c) map.flyTo({ center: [c[1], c[2]], zoom: zRegional(), duration: 1600 });
    e.target.value = "";
  };
  $("#btnHome").onclick = () => fitRegion(1400);
  $("#btnGlobe").onclick = () => map.flyTo({ center: GLOBE_CENTER, zoom: GLOBE_ZOOM, duration: 1800 });
  $("#srReset").onclick = () => { state.pick = null; recordModel = null; $("#recordBox").hidden = true; if (pickMarker) pickMarker.remove(); renderPeninsulaSeries(); };
  $("#rcTableBtn").onclick = (e) => { const t = $("#rcTable"); t.hidden = !t.hidden; e.currentTarget.textContent = t.hidden ? "Show table" : "Hide table"; e.currentTarget.setAttribute("aria-expanded", String(!t.hidden)); sendHeight(); };
  $("#rcCsv").onclick = () => download("prithvi_openet_pixel_record.csv", recordCSV(), "text/csv");
  $("#srTableBtn").onclick = (e) => { const t = $("#srTable"); t.hidden = !t.hidden; e.currentTarget.textContent = t.hidden ? "Show table" : "Hide table"; e.currentTarget.setAttribute("aria-expanded", String(!t.hidden)); sendHeight(); };
  $("#srCsv").onclick = () => download("prithvi_openet_series.csv", seriesCSV(), "text/csv");
  /* In-page links of the About tab: inside an auto-height frame the frame itself never scrolls, so
     ask the browser to bring the heading into view (it scrolls whichever ancestor can). */
  document.querySelectorAll(".toc a").forEach((lnk) => lnk.addEventListener("click", (e) => {
    const target = document.getElementById(lnk.getAttribute("href").slice(1));
    if (!target) return;
    e.preventDefault();
    target.scrollIntoView({ behavior: REDUCED ? "auto" : "smooth", block: "start" });
  }));
  addEventListener("resize", sendHeight);
  if (window.ResizeObserver) new ResizeObserver(sendHeight).observe(document.body);
}
/* Wording for a reduced copy of the tiles (see fullRes). The page's own text describes the full set;
   this replaces every sentence that would promise more than the tiles on hand can show. */
function applyPreviewWording() {
  const fine = finestRes(), n = FINE.length, list = FINE.map((a) => a.name), names = n > 1 ? `${list.slice(0, -1).join(", ")} and ${list[n - 1]}` : list.join("");
  const areas = `${numWord(n)} small area${n > 1 ? "s" : ""}${FINE_WHAT ? ` ${FINE_WHAT}` : ""}`;      // "eight small areas around the paper's Korean flux-tower sites"
  document.querySelector('#steps span[data-step="2"]').textContent = `Finest here · ${fine}`;
  $("#hint").textContent = `Click the Korean Peninsula: the map zooms in to about ${fine} per pixel, the finest level of this public preview, and the panel on the right shows the monthly series at that spot.` +
    (n ? ` ${capFirst(areas)} ${n > 1 ? "go" : "goes"} on to the native 30 m; ${n > 1 ? "they are" : "it is"} outlined on the map and listed under “Go to”.` : "") +
    " The 30 m maps themselves are the GeoTIFFs.";
  $("#rcHead").textContent = "Full record at this spot";
  $("#tilesZoom").textContent = `zoom ${CAT.zoom.min}–${CAT.zoom.max} on this public copy, about ${fine} per pixel at best` +
    (n ? `, plus zoom ${FINE_ZOOM} (30 m) inside ${numWord(n)} small area${n > 1 ? "s" : ""}` : "") + `; the full set goes to zoom ${CAT.zoom.native}, 30 m`;
  const badge = $("#previewBadge");
  badge.textContent = n ? `Public preview · ${fine}, and 30 m in ${numWord(n)} area${n > 1 ? "s" : ""}` : `Public preview · maps shown down to ${fine}`; badge.hidden = false;
  const li = $("#abPreview");
  li.replaceChildren(el("b", {}, "This site shows a reduced copy."), ` The maps on this page stop at about ${fine} per pixel, and a value read at a clicked spot is the mean over a ${fine} cell.` +
    (n ? ` ${capFirst(areas)} (${names}) ${n > 1 ? "keep" : "keeps"} the native 30 m.` : "") + " The 30 m maps are the GeoTIFFs.");
  li.hidden = false;
}
/* A line at the very top of the page: where the paper stands and when the data will be released
   (js/config.js `notice`). Empty it at publication and the line is gone. */
function applyNotice() {
  $("#pageNotice").textContent = CFG.notice;
  $("#pageNotice").hidden = false;
  document.body.classList.add("has-notice");
}
/* Where the catalog has a background layer, the About tab says what it is and credits it. */
function applyBackgroundWording() {
  const only = Object.keys(BG.layers).length === 1 && BG.layers.annual;
  const li = $("#abBg");
  li.replaceChildren(el("b", {}, "The rest of the globe is a background layer."),
    ` Outside the Korean Peninsula the map shows ${BG.long || BG.name}${BG.period ? `, the ${BG.period} mean` : ""}${BG.grid ? ` on a ${BG.grid} grid` : ""} (about ${fmt(BG.cell_km)} km).` +
    " It is a different product, there to give the globe its context: Prithvi-OpenET-Tower has not been run for those places, and no value from the background is part of this dataset." +
    (only ? " It is shown with the annual-mean layer only." : ""));
  li.hidden = false;
  $("#abCredits").append(` Background layer: ${BG.long || BG.name}${BG.doi ? ` (doi:${BG.doi})` : ""}.`);
}
async function main() {
  try {
    await loadCatalog();
  } catch (e) {
    $("#bootMsg").textContent = e.message; document.querySelector(".boot-mark").style.display = "none";
    return;
  }
  const first = ymLabel(CAT.record.first), last = ymLabel(CAT.record.last);
  $("#factRecord").textContent = `${MON[+CAT.record.first.slice(5) - 1]} ${CAT.record.first.slice(0, 4)} – ${MON[+CAT.record.last.slice(5) - 1]} ${CAT.record.last.slice(0, 4)}`;
  $("#abRecord").textContent = `${first} to ${last}`;
  $("#glRecord").textContent = `${first} – ${last}`;
  $("#abMail").textContent = CFG.requestEmail; $("#abMail").href = "mailto:" + CFG.requestEmail;
  $("#footVer").textContent = `Data version ${CAT.version}`;
  if (CFG.paperStatus) $("#abPaper").textContent = `Manuscript ${CFG.paperStatus}.`;
  if (CFG.notice && !CFG.nasPath) applyNotice();                   // not on the lab's internal copy, which is no preview and says so itself
  if (!fullRes()) applyPreviewWording();
  if (BG) applyBackgroundWording();
  wire(); initRequest(); renderDownload(); renderCode();
  renderLayerCard(); renderLegend(); renderWhen(); renderCalendar(); renderPeninsulaSeries();
  initMap();
  const tab = Q.get("tab"); if (tab && document.getElementById("tab-" + tab)) showTab(tab);
  sendHeight();
}
main();
})();
