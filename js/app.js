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
                 enlarged in the browser.

   Regions
     A region with ready-made maps has a catalog of its own. The page is pointed at one of them (the
     first region); that catalog lists the others under "regions" and each is read the same way. A
     layer — the annual mean, July 2021 — is one thing on the map however many regions hold it: a
     tile is put together from the regions it touches. The cards beside the map describe one region
     at a time: the one the map is on, or was last on (FOCUS). */
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
  CFG.nasMore = {};                              // the same for the regions after the first: nas_<region id>=/path
  for (const [k, v] of Q) if (/^nas_[a-z0-9]+$/.test(k) && /^\/[\w\-./]+$/.test(v)) CFG.nasMore[k.slice(4)] = v;
}
const EMBED = Q.get("embed") === "1";
if (EMBED) document.documentElement.classList.add("embed");
if (Q.get("hidefooter") === "1") document.body.classList.add("hide-footer");   // the page that embeds the portal draws its own logo strip
const DATA = new URL(CFG.dataBase, location.href).href;
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
const TOUCH = matchMedia("(pointer: coarse)").matches;          // a finger, not a mouse: wording only

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONL = ["January", "February", "March", "April", "May", "June", "July", "August", "September",
              "October", "November", "December"];
const TILE = 256;
/* The opening view: the whole globe, turned to the region that has our maps. The numbers are those of the
   lab's HDCA portal, so the two open alike; only the centre differs, because the maps are elsewhere.
   The globe is sized to the map box: on a phone the map is about 350 px wide and a fixed desktop zoom
   spills the globe out of it. Its diameter on screen is about 140 px × 2^zoom, so take the zoom for 80 %
   of the shorter side, never more than the desktop's 1.55.
   Those numbers hold for a globe centred on 18°N, as HDCA's is. MapLibre keeps the scale at the centre
   of a globe equal to the flat map's there, so the globe is drawn larger by 1/cos(latitude of its centre):
   centred on our 30°N it would be a tenth larger at the same zoom. That much zoom is taken off, and the
   globe is the same size on screen as HDCA's.
   With one region the globe faces that region. With several it faces the middle of them, so that each is in
   sight with its mark: the longitude halfway between the westernmost and the easternmost, the latitude as
   before, so the globe keeps its size (faceRegions, once the catalogs are read). */
const GLOBE = { center: [127.6, 30], zoom: 1.55, sizedAt: 18 };
function faceRegions() {
  if (REG.length < 2) return;
  const lons = REG.map(midLon);
  GLOBE.center = [Math.round((Math.min(...lons) + Math.max(...lons)) / 2 * 10) / 10, GLOBE.center[1]];
}
const NOPAD = { top: 0, bottom: 0, left: 0, right: 0 };
function globeView() {
  const box = document.getElementById("map"), card = document.getElementById("coverCard"), rad = Math.PI / 180;
  const w = box ? box.clientWidth || 990 : 990, h = box ? box.clientHeight || 720 : 720;
  const larger = Math.log2(Math.cos(GLOBE.sizedAt * rad) / Math.cos(GLOBE.center[1] * rad));
  let zoom = clamp(Math.log2(0.8 * Math.min(w, h) / 140), 0.6, GLOBE.zoom), left = 0;
  /* Unlike HDCA's, our map has a coverage card at its top left, with the legend below it. In a box narrower
     than about 990 px a globe in the middle would run under them, so it is moved right until it is just
     clear of the card; where even that is too wide for the box, it is sized to the part beside the card
     and set in the middle of that. The shift is camera padding: see `fly` for how later moves undo it. */
  const edge = card && card.offsetParent !== null ? card.offsetLeft + card.offsetWidth : 0;
  if (edge) {
    const free = w - edge, gap = 6, across = 140 * 2 ** zoom;
    if (across + 2 * gap <= free) left = Math.max(0, 2 * (edge + gap) + across - w);
    else { zoom = Math.max(0.6, Math.log2(0.92 * free / 140)); left = edge; }
  }
  return { center: GLOBE.center, zoom: zoom - larger, padding: { ...NOPAD, left } };
}
/* The opening. The page does not just appear. The globe comes in turning: it starts 140° to the west and
   22° to the south of where it will rest, at half its size, and sweeps east to settle on our maps, fast at
   first and slowing into place. As it slows the panels over the map come up one after another,
   the mark on the region lands, and meanwhile the cards beside the map rise in turn. Under four seconds in
   all. The lab's HDCA portal opens with the same sweep (140° from the west, growing from about half size)
   and then keeps turning slowly; ours comes to rest, because the globe has somewhere to be: facing the
   region that has our maps, with the mark on it. Skipped with reduced motion, intro=0 and view=region; the
   visitor's first drag or scroll takes over from it.
     turn, south   where the turn starts, in degrees west and south of the opening view
     back          how much zoom further out it starts
     delay         ms after the map has loaded: the loading screen has faded by then, so the whole turn is seen
     panels, mark  when the panels come up and the mark lands, as fractions of the turn's duration */
const INTRO = { turn: 140, south: 22, back: 0.8, delay: 420, duration: 3600, panels: 0.58, mark: 0.85 };
const MIN_ZOOM = 0.5;
const FIXED_RANGE = { month: [0, 180], clim: [0, 180], annual: [400, 1100] };
/* Magnitude ramp: yellow-green-blue, lightness falling monotonically (analogous hues, so it
   stays ordered for colour-blind readers and in grayscale). Always shown with its scale. */
const RAMP = ["#ffffd9", "#edf8b1", "#c7e9b4", "#7fcdbb", "#41b6c4", "#1d91c0", "#225ea8", "#253494", "#081d58"]
  .map((h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]);
const COVER_STEPS = ["#D9E8F1", "#A9CBDF", "#74A9C9", "#2E7BA8", "#1F5F85"];   // one hue, light → dark
/* Our own place names, by region id: the basemap carries none (see "Basemap without labels" in CLAUDE.md). */
const CITIES = {
  kp: [["Seoul", 126.978, 37.5665], ["Busan", 129.0756, 35.1796], ["Incheon", 126.7052, 37.4563],
    ["Daegu", 128.6014, 35.8714], ["Daejeon", 127.3845, 36.3504], ["Gwangju", 126.8526, 35.1595],
    ["Ulsan", 129.3114, 35.5384], ["Jeju", 126.5312, 33.4996], ["Gangneung", 128.8761, 37.7519],
    ["Jeonju", 127.148, 35.8242], ["Pyongyang", 125.7625, 39.0392], ["Hamhung", 127.5364, 39.9183],
    ["Chongjin", 129.7758, 41.7956], ["Wonsan", 127.4433, 39.1528], ["Sinuiju", 124.3981, 40.1006]],
  fr: [["Paris", 2.3522, 48.8566], ["Marseille", 5.3698, 43.2965], ["Lyon", 4.8357, 45.764],
    ["Toulouse", 1.4442, 43.6047], ["Nice", 7.262, 43.7102], ["Nantes", -1.5536, 47.2184],
    ["Strasbourg", 7.7521, 48.5734], ["Bordeaux", -0.5792, 44.8378], ["Lille", 3.0573, 50.6292],
    ["Rennes", -1.6778, 48.1173], ["Montpellier", 3.8767, 43.6108], ["Brest", -4.4861, 48.3904],
    ["Clermont-Ferrand", 3.087, 45.7772], ["Dijon", 5.0415, 47.322], ["Ajaccio", 8.7369, 41.9192]],
};
/* A place for the code examples of each region: a box to read and a point for a series. */
const EXAMPLES = {
  kp: { box: [127.15, 38.10, 127.45, 38.30], boxName: "the Cheorwon plain", point: [127.28, 38.20] },
  fr: { box: [1.45, 48.05, 1.80, 48.30], boxName: "the Beauce plain", point: [1.63, 48.20] },
};

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
/* The regions with ready-made maps, the first one first (addRegion says what a region holds), and the one the
   cards beside the map describe. LAYERS has every layer that some region holds, with what is common to it in
   all of them (kind, label, units, step); a region's own record of a layer — its file, its statistics — is
   in R.L. */
const REG = [];
let FOCUS = null;
const LAYERS = new Map();            // layer id → { id, kind, label, units, dn_step, ym or month }
let BG = null;                       // the background product (catalog.background), or null
const BGL = new Map();               // background layer id → record
let FINE = [];                       // areas a reduced copy keeps at the native zoom (catalog.fine), of all regions; each knows its region
const state = { mode: "annual", ym: null, climMonth: 7, scale: "fixed", opacity: 1, pick: null,
                seriesYear: null, playing: null };
const lut32 = new Uint32Array(256), lutBg = new Uint32Array(256);
let lutKey = "";
let chartModel = null;

function currentLayerId() {
  if (state.mode === "annual" && LAYERS.has("clim_annual")) return "clim_annual";
  if (state.mode === "clim") return `clim_${String(state.climMonth).padStart(2, "0")}`;
  return "et_" + state.ym.replace("-", "");
}
/* The layer on show as the region in focus holds it. Where that region has no map of it (a month that was not
   produced there), what is common to the layer, marked `missing`: the cards then say so instead of showing
   another region's numbers. */
function currentLayer() {
  const id = currentLayerId();
  return (FOCUS && FOCUS.L.get(id)) || { ...LAYERS.get(id), missing: true };
}
/* The background layer that stands behind the layer on show, when the catalog has one for it
   ("annual", or the layer's own id). No stand-ins: a July map never gets an annual background. */
function currentBg() {
  if (!BG) return null;
  const ly = currentLayer();
  return BGL.get(ly.kind === "annual" ? "bg_annual" : "bg_" + ly.id) || null;
}
function currentRange(ly) {
  if (state.scale === "fixed" || ly.missing) return FIXED_RANGE[ly.kind];
  const step = ly.kind === "annual" ? 50 : 10;
  const lo = Math.floor(ly.p02 / step) * step, hi = Math.ceil(ly.p98 / step) * step;
  return [lo, Math.max(hi, lo + step)];
}

/* ───────────────────────────── numeric tiles ───────────────────────────── */
const archives = new Map(), dnCache = new Map(), pending = new Map();
const DN_MAX = 1800;            // a tile that one region alone fills is listed twice (regionDN, getDN) and held once
/* An archive by its address. A layer's file is written in its catalog relative to that catalog — a copy
   spread over several sites writes "../other-site/monthly/x.pmtiles" — and addRegion has joined the two. */
function openArchive(url) {
  let a = archives.get(url);
  if (!a) { a = new pmtiles.PMTiles(new pmtiles.FetchSource(url)); archives.set(url, a); }
  return a;
}
const overlaps = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];      // two [west, south, east, north] boxes
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
/* One decoded tile, kept. `make` is asked only when the tile is neither in hand nor on its way. */
function cached(key, make) {
  if (dnCache.has(key)) { const v = dnCache.get(key); dnCache.delete(key); dnCache.set(key, v); return Promise.resolve(v); }
  if (pending.has(key)) return pending.get(key);
  const p = (async () => {
    const dn = await make();
    dnCache.set(key, dn);
    if (dnCache.size > DN_MAX) dnCache.delete(dnCache.keys().next().value);
    return dn;
  })().finally(() => pending.delete(key));
  pending.set(key, p);
  return p;
}
/* A tile of a layer as one region holds it: read from that region's archive, or made from it where the map
   asks for a zoom the archive does not have (coarserDN, finerDN). */
function regionDN(R, id, z, x, y) {
  return cached(`${R.id}:${id}/${z}/${x}/${y}`, () => {
    const ly = R.L.get(id);
    if (!ly) return null;
    if (z < R.zoom.min) return coarserDN(R, id, z, x, y);
    if (z > R.zoom.max) return finerDN(R, id, z, x, y);
    return readTile(openArchive(ly.url), z, x, y);
  });
}
/* A tile of a layer as the map shows it: the background's own tile, or the tiles of the regions it touches
   laid together. From the archives' coarsest zoom on, regions that lie apart never share a tile; only the few
   tiles of the far-out globe do. The regions' tiles of one layer count in the same step (dn_step). */
function getDN(id, z, x, y) {
  return cached(`${id}/${z}/${x}/${y}`, async () => {
    if (BGL.has(id)) return z <= BG.zoom.max ? readTile(openArchive(BGL.get(id).url), z, x, y) : null;
    const b = tileBounds(z, x, y);
    const parts = (await Promise.all(REG.filter((R) => R.L.has(id) && overlaps(b, R.bounds)).map((R) => regionDN(R, id, z, x, y)))).filter(Boolean);
    if (parts.length < 2) return parts[0] || null;
    const out = parts[0].slice();
    for (const p of parts.slice(1)) for (let i = 0; i < out.length; i++) if (out[i] === 255) out[i] = p[i];
    return out;
  });
}
/* The archives start at zoom 3; with the globe zoomed far out the map asks for zoom 0-2. Those few tiles
   are averaged here from the zoom-3 tiles, with the pipeline's own rule: a pixel is kept when a quarter of
   it has data. Without this the data would vanish from the globe just when the whole Earth is in view. */
async function coarserDN(R, id, z, x, y) {
  const zs = R.zoom.min, f = 2 ** (zs - z), b = R.bounds;
  const lo = lngLatToTile(b[0], b[3], zs), hi = lngLatToTile(b[2], b[1], zs);
  const sum = new Float32Array(TILE * TILE), cnt = new Uint16Array(TILE * TILE);
  let any = false;
  for (let cy = Math.max(y * f, lo.y); cy <= Math.min(y * f + f - 1, hi.y); cy++) {
    for (let cx = Math.max(x * f, lo.x); cx <= Math.min(x * f + f - 1, hi.x); cx++) {
      const dn = await regionDN(R, id, zs, cx, cy);
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
async function finerDN(R, id, z, x, y) {
  const ly = R.L.get(id);
  if (z <= R.fineZoom && ly.fineUrl && R.fine.some((a) => overlaps(tileBounds(z, x, y), a.bounds))) {
    const dn = await readTile(openArchive(ly.fineUrl), z, x, y);      // the layer's second archive: the native-zoom tiles of the sample areas
    if (dn) return dn;
  }
  const zs = R.zoom.max, d = z - zs, n = TILE >> d;
  const up = await regionDN(R, id, zs, x >> d, y >> d);
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
    const dn = m && (LAYERS.has(m[1]) || BGL.has(m[1])) ? await getDN(m[1], +m[2], +m[3], +m[4]) : null;
    if (!dn) return { data: await createImageBitmap(new ImageData(1, 1)) };
    const img = new ImageData(TILE, TILE), px = new Uint32Array(img.data.buffer), lut = BGL.has(m[1]) ? lutBg : lut32;
    for (let i = 0; i < px.length; i++) px[i] = lut[dn[i]];
    return { data: await createImageBitmap(img) };
  });
}
const tileURL = () => `etn://${currentLayerId()}/{z}/{x}/{y}?k=${lutKey}`;
const bgTileURL = (bg) => `etn://${bg.id}/{z}/{x}/{y}?k=${lutKey}`;

/* ───────────────────────────── catalog ───────────────────────────── */
async function fetchCatalog(url) {
  const r = await fetch(url, { cache: "no-cache" });
  if (r.status === 401 || r.status === 403) {
    if (window.parent !== window) window.parent.postMessage({ type: "portalAuth" }, "*");
    throw new Error("Sign-in required — open this page from the lab dashboard.");
  }
  if (!r.ok) throw new Error(`Could not load the catalog (HTTP ${r.status}).`);
  return r.json();
}
/* The coverage mask of a catalog (run lengths along the rows, first run empty) as a grid of 0 and 1: see regionAt. */
function readMask(m) {
  if (!m || !m.runs) return null;
  const bits = new Uint8Array(m.w * m.h);
  let i = 0, v = 0;
  for (const n of m.runs) { if (v) bits.fill(1, i, i + n); i += n; v ^= 1; }
  return { zoom: m.zoom, x0: m.x0, y0: m.y0, w: m.w, h: m.h, bits };
}
/* One region, from its catalog: its names, where it is, its record, and its own record of every layer (R.L),
   with the addresses of the files. Addresses in a catalog are relative to that catalog. */
function addRegion(cat, url) {
  const info = cat.region || { id: "kp", name: "Korean Peninsula", short: "Peninsula", the: "the Korean Peninsula" };      // a catalog from before regions had names
  const train = `${cat.record.train[0].slice(0, 4)}–${cat.record.train[1].slice(0, 4)}`, at = (rel) => new URL(rel, url).href;
  const R = { id: info.id, name: info.name, short: info.short || info.name, the: info.the || info.name, cat, url, bounds: cat.bounds, zoom: cat.zoom,
              record: cat.record, months: cat.months, version: cat.version, mask: readMask(cat.mask), L: new Map(), fine: [], fineZoom: 0, fineWhat: "" };
  const put = (rec, more) => {
    const ly = { ...rec, ...more, url: at(rec.file), fineUrl: rec.fine ? at(rec.fine) : "", region: R };
    R.L.set(ly.id, ly);
    if (!LAYERS.has(ly.id)) LAYERS.set(ly.id, { id: ly.id, kind: ly.kind, label: ly.label, units: ly.units, dn_step: ly.dn_step, ym: ly.ym, month: ly.month });
  };
  if (cat.annual) put(cat.annual, { kind: "annual", label: `Mean annual ET, ${train}` });
  for (const c of cat.clim || []) put(c, { kind: "clim", label: `${MONL[c.month - 1]} mean, ${train}` });
  for (const m of cat.months) if (m.tiles) put(m.tiles, { kind: "month", ym: m.ym, rec: m, label: ymLabel(m.ym) });
  if (cat.fine && (cat.fine.areas || []).length && cat.fine.zoom > cat.zoom.max) {
    R.fine = cat.fine.areas.map((a) => ({ ...a, region: R })); R.fineZoom = cat.fine.zoom; R.fineWhat = cat.fine.what || "";
  }
  REG.push(R);
  return R;
}
/* A link may ask for a region instead of the globe: view=region (the first one) or view=<region id>. */
const viewRegion = () => { const v = Q.get("view"); return v === "region" ? REG[0] : (v && REG.find((R) => R.id === v)) || null; };
async function loadCatalog() {
  const home = DATA + "catalog.json";
  CAT = await fetchCatalog(home);
  addRegion(CAT, home);
  /* The other regions, each with a catalog of its own, listed by the first. One that cannot be read is left
     out and the page works with the rest. */
  const more = await Promise.all((CAT.regions || []).map(async (r) => {
    const url = new URL(r.catalog, home).href;
    try { return [await fetchCatalog(url), url]; } catch (e) { console.warn(`[catalog] region "${r.id}" not loaded:`, e.message); return null; }
  }));
  for (const m of more) if (m && (m[0].months || []).length) addRegion(m[0], m[1]);
  FOCUS = viewRegion() || REG[0];
  FINE = REG.flatMap((R) => R.fine);
  faceRegions();
  if (CAT.background && CAT.background.layers && Object.keys(CAT.background.layers).length) {
    BG = CAT.background;
    for (const ly of Object.values(BG.layers)) BGL.set(ly.id, { ...ly, kind: "bg", url: new URL(ly.file, home).href });
  }
  if (!LAYERS.size) throw new Error("The catalog lists no browse tiles yet.");
  const built = builtMonths(), train = CAT.record.train;
  const julys = built.filter((ym) => ym.endsWith("-07") && ym >= train[0] && ym <= train[1]);
  state.ym = julys[julys.length - 1] || built[built.length - 1] || null;
  state.seriesYear = state.ym ? state.ym.slice(0, 4) : null;
  if (!LAYERS.has("clim_annual")) state.mode = climMonths().length ? "clim" : "month";
}
/* The months, and the calendar months, that have browse tiles in some region. */
const builtMonths = () => [...LAYERS.values()].filter((l) => l.kind === "month").map((l) => l.ym).sort();
const climMonths = () => [...LAYERS.values()].filter((l) => l.kind === "clim").map((l) => l.month).sort((a, b) => a - b);
/* The regions in words: "the Korean Peninsula and France" inside a sentence, "Korean Peninsula and France" as names. */
const wordList = (a, and = "and") => (a.length < 3 ? a.join(` ${and} `) : `${a.slice(0, -1).join(", ")} ${and} ${a[a.length - 1]}`);
const theRegions = (and) => wordList(REG.map((R) => R.the), and);
const regionNames = () => wordList(REG.map((R) => R.name));
const TRAIN_YEARS = () => `${CAT.record.train[0].slice(0, 4)}–${CAT.record.train[1].slice(0, 4)}`;
function demandWindow() {
  const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - CFG.demandLagMonths);      // day 1 first: "31 May minus three months" must not roll into March
  const last = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  return { first: CFG.demandFirstMonth, last, text: `${ymLabel(CFG.demandFirstMonth)} to ${ymLabel(last)}` };
}

/* ───────────────────────────── map ───────────────────────────── */
/* The region whose maps cover a place, or null. The bounding box of a region's grid takes in a good deal of its
   neighbours (the box around France holds Belgium, Switzerland and much of northern Italy), so a catalog
   carries a coarse mask of where its maps have values, a cell of it being about 2 km. A catalog without a
   mask has only the box to go by. */
function regionAt(lng, lat) {
  for (const R of REG) {
    const b = R.bounds;
    if (lng < b[0] || lng > b[2] || lat < b[1] || lat > b[3]) continue;
    const m = R.mask;
    if (!m) return R;
    const n = TILE * 2 ** m.zoom, s = Math.sin(lat * Math.PI / 180);
    const i = Math.floor((lng + 180) / 360 * n) - m.x0, j = Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n) - m.y0;
    if (i >= 0 && j >= 0 && i < m.w && j < m.h && m.bits[j * m.w + i]) return R;
  }
  return null;
}
const inBounds = (lng, lat) => !!regionAt(lng, lat);
const boxRegion = (lng, lat) => REG.find((R) => lng >= R.bounds[0] && lng <= R.bounds[2] && lat >= R.bounds[1] && lat <= R.bounds[3]) || null;
const midLon = (R) => (R.bounds[0] + R.bounds[2]) / 2, midLat = (R) => (R.bounds[1] + R.bounds[3]) / 2;
/* Degrees along the Earth between two places. */
function arcDeg(lng1, lat1, lng2, lat2) {
  const r = Math.PI / 180, c = Math.sin(lat1 * r) * Math.sin(lat2 * r) + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lng1 - lng2) * r);
  return Math.acos(clamp(c, -1, 1)) / r;
}
const regionsByDistance = (lng, lat) => [...REG].sort((a, b) => arcDeg(lng, lat, midLon(a), midLat(a)) - arcDeg(lng, lat, midLon(b), midLat(b)));
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
const srcMaxZoom = () => Math.max(...REG.map((R) => (R.fine.length ? R.fineZoom : R.zoom.max)));
/* MapLibre rounds the zoom for raster sources and 256-px tiles sit one level ahead of the map zoom. */
const tileZoom = () => clamp(Math.round(map.getZoom() + 1), 0, srcMaxZoom());
/* A copy of the tiles may stop short of the native grid: a public preview on a host with size limits
   has zoom.max below zoom.native in its catalog. Everything that names a resolution asks here, so the
   page never promises 30 m where the tiles on hand are coarser. */
const nativeZoom = (R) => R.zoom.native || R.zoom.max;
const regFull = (R) => R.zoom.max >= nativeZoom(R);
const fullRes = () => REG.every(regFull);
const groundRes = (z, lat) => 40075016.686 * Math.cos(lat * Math.PI / 180) / (TILE * 2 ** z);
/* The finest level of a region's copy in words, taken at the middle of the region ("120 m"); and of all the
   regions with a reduced copy at once, for where the page speaks of the whole site ("110–120 m": a tile pixel
   of one zoom is smaller on the ground the further north the region lies). */
const finestRes = (R) => fmtRes(groundRes(R.zoom.max, midLat(R)));
function resRange(v) {
  const lo = fmtRes(Math.min(...v)), hi = fmtRes(Math.max(...v));
  return lo === hi ? lo : lo.endsWith(" m") && hi.endsWith(" m") ? `${lo.slice(0, -2)}–${hi}` : `${lo}–${hi}`;
}
const finestAll = () => resRange(REG.filter((R) => !regFull(R)).map((R) => groundRes(R.zoom.max, midLat(R))));
/* A sample area is the one place where a reduced copy does go down to the native grid. What a value
   stands for therefore depends on where it was read. */
const fineAreaAt = (lng, lat) => FINE.find((a) => lng >= a.bounds[0] && lng <= a.bounds[2] && lat >= a.bounds[1] && lat <= a.bounds[3] && inRing(a.ring, lng, lat)) || null;
const regionOr = (lng, lat) => regionAt(lng, lat) || FOCUS;     // the region a place is in; for a place in none, the one in focus
/* The finest tile zoom with numbers of its own at a place: the native zoom inside a sample area, elsewhere the
   top of that region's copy. */
function topZoomAt(lng, lat) { const a = fineAreaAt(lng, lat); return a ? a.region.fineZoom : regionOr(lng, lat).zoom.max; }
const nativeAt = (lng, lat) => topZoomAt(lng, lat) >= nativeZoom(regionOr(lng, lat));
const cellNameAt = (lng, lat) => (nativeAt(lng, lat) ? "30 m pixel" : `${finestRes(regionOr(lng, lat))} cell`);
const zRegional = (R) => Math.min(9.2, (R || FOCUS).zoom.max - 0.3);      // map zoom of the first click-in: tile zoom 10, about 120 m
/* Outside the region with maps there is nothing finer than the background. From this map zoom on the
   page says so: where a background cell has grown to about 16 px on screen, and never before the
   coverage card has faded out (7.2), so the note has room at the top of the map. */
const outNoteZoom = (lat) => Math.max(7.3, BG ? Math.log2(40075016.686 * Math.cos(lat * Math.PI / 180) * 16 / (512 * BG.cell_km * 1000)) : 0);
/* The background fades as the view goes past its detail, so the imagery shows where there is no map. */
const ctxOpacity = (k) => ["interpolate", ["linear"], ["zoom"], 7, 0.9 * k, 9.5, 0.35 * k];

/* MapLibre draws with WebGL and has no other way. Where the browser gives no WebGL context — graphics
   acceleration switched off, or lost (Chrome switches it off for the rest of the session once its graphics
   process has failed a few times, and no longer falls back to drawing in software) — there can be no map.
   The page then says so in the map's place instead of sitting on its loading screen for ever. Everything on
   it that is not the map still works: applyLayer and the others already allow for there being no map,
   because the cards are drawn before the map is made. */
function webglWorks() {
  try {
    const c = document.createElement("canvas"), gl = c.getContext("webgl2") || c.getContext("webgl");
    if (!gl) return false;
    const lose = gl.getExtension("WEBGL_lose_context");
    if (lose) lose.loseContext();                                  // hand the test context back
    return true;
  } catch (e) { return false; }
}
function noMap(on, why) {
  const root = document.documentElement;
  if (on) root.classList.remove("opening", "waiting", "opened", "arrived", "entered");      // nothing of the opening is left waiting for a map
  root.classList.toggle("nomap", on);
  $("#noMap").hidden = !on;
  const boot = $("#boot");
  if (boot) { boot.classList.add("out"); setTimeout(() => boot.remove(), 500); }
  if (on && why) console.warn("[map] not drawn:", why);
  if (!window.__portal) window.__portal = { map: null, state, zoom: CAT.zoom };      // the handle for tests, without a map
  window.__portal.noMap = on;
  sendHeight();
}
const LOST_WAIT = 6000;          // ms a lost WebGL context is given to come back before the page says the map is gone

function initMap() {
  buildLUT();
  registerProtocol();
  const bg = currentBg();
  const gv = globeView(), intro = !(REDUCED || Q.get("intro") === "0" || viewRegion());
  const start = intro ? { ...gv, center: [gv.center[0] - INTRO.turn, gv.center[1] - INTRO.south], zoom: Math.max(0, gv.zoom - INTRO.back) } : gv;
  openedHidden = !document.getElementById("map").clientWidth;      // another tab is open: the box has no size yet
  if (intro) {                                                      // the panels over the map wait for the globe (CSS)
    document.documentElement.classList.add("opening");
    setTimeout(() => document.documentElement.classList.remove("opening"), 12000);      // whatever happens to the map, they do come
    /* The turn sweeps half the Earth in about a second. Fetch the coarse tiles of our own layers for the whole
       globe now, so that the far side is already in hand when it comes round. */
    for (const z of [1, 2]) for (let x = 0; x < 2 ** z; x++) for (let y = 0; y < 2 ** z; y++) {
      if (bg) getDN(bg.id, z, x, y).catch(() => {});
      getDN(currentLayerId(), z, x, y).catch(() => {});
    }
  }
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
                          tiles: [(shownBg = bgTileURL(bg || BGL.values().next().value))], attribution: `Background ET: ${BG.name}` } } : {}),
        /* Our maps: one source for all the regions. Its box takes them all in; a tile that touches none of
           them comes back empty without anything being fetched (getDN). */
        et: { type: "raster", tileSize: 256, minzoom: 0, maxzoom: srcMaxZoom(),
              bounds: [0, 1, 2, 3].map((k) => Math[k < 2 ? "min" : "max"](...REG.map((R) => R.bounds[k]))),
              tiles: [(shownTiles = tileURL())], attribution: "ET: Prithvi-OpenET-Tower, HydroAI Lab (GIST)" },
      },
      layers: [
        { id: "bg", type: "background", paint: { "background-color": "#0F1318" } },
        { id: "sat", type: "raster", source: "sat", paint: { "raster-saturation": -0.3, "raster-brightness-max": 0.92 } },
        ...(BG ? [{ id: "ctx", type: "raster", source: "ctx", layout: { visibility: bg ? "visible" : "none" },
                    paint: { "raster-opacity": ctxOpacity(1), "raster-fade-duration": 150 } }] : []),
        { id: "et", type: "raster", source: "et", paint: { "raster-opacity": 1, "raster-fade-duration": 150 } },
      ],
    },
    center: start.center, zoom: start.zoom, minZoom: intro ? 0 : MIN_ZOOM, maxZoom: srcMaxZoom() + 2.5,      // the turn starts further out than a visitor may go
    attributionControl: { compact: true }, dragRotate: false, pitchWithRotate: false, touchPitch: false,
  });
  if (start.padding.left) map.setPadding(start.padding);          // the globe beside the coverage card, from the first frame
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  map.addControl(new maplibregl.ScaleControl({ unit: "metric", maxWidth: 110 }), "bottom-left");
  window.__portal = { map, state, getDN, dnCache, exact: () => exactDecode, zoom: CAT.zoom,          // handle for tests and debugging
                      get L() { return FOCUS.L; }, regions: REG, get focus() { return FOCUS; }, regionAt,
                      bg: BG, fine: FINE, fineZoom: Math.max(0, ...REG.map((R) => R.fineZoom)), note: () => noteShown,
                      globeView, opening: intro ? { from: start, turn: INTRO.turn, south: INTRO.south, back: INTRO.back } : null };

  map.on("error", (e) => console.warn("[map]", e && e.error ? e.error.message : e));
  /* A context lost while the page is open usually comes back within a second or two (the browser restarts
     its graphics process) and MapLibre carries on. If it has not come back after a while, the page says that
     the map is gone; if it comes back later after all, the map returns. */
  let lost = 0;
  map.on("webglcontextlost", () => { clearTimeout(lost); lost = setTimeout(() => noMap(true, "the WebGL context was lost and has not come back"), LOST_WAIT); });
  map.on("webglcontextrestored", () => { clearTimeout(lost); if (document.documentElement.classList.contains("nomap")) { noMap(false); map.resize(); } });
  map.on("load", () => {
    $("#boot").classList.add("out");
    setTimeout(() => $("#boot").remove(), 500);
    tagRoom();
    addMarkers();
    addFineAreas();
    loadLand();
    /* The page opens on the whole globe: it turns into place (see INTRO) and then stays there until the
       visitor moves in. A link can ask for a region with maps instead (view=region, or view=<its id>); if
       the map is not on screen yet (another tab is open), the fit waits until it is. */
    const vr = viewRegion();
    if (vr) { if (map.getContainer().clientWidth) fitRegion(vr, 0); else fitWhenShown = vr; }
    else if (intro) runOpening(start);
  });
  map.on("zoom", onZoom);
  map.on("move", onMove);
  map.on("movestart", (e) => { if (e.originalEvent) introRunning = false; });      // the visitor has taken over from the opening
  map.on("moveend", () => { if (flyingTo) { flyingTo = null; onMove(); } });
  map.on("mousemove", onHover);
  map.on("mouseout", () => { $("#roVal").textContent = ""; });
  map.on("click", onClick);
}
let fitWhenShown = null, openedHidden = false;
let flyingTo = null, introRunning = false;      // while the map is on its way to a region, or in its opening turn, the cards do not follow what it passes over
/* The opening sequence (see INTRO). The classes on <html> drive the CSS part: "opening" keeps the panels
   over the map and the mark out of sight, "opened" lets the panels come up, "arrived" lands the mark,
   "entered" raises the cards beside the map. All of them are taken off again at the end, so nothing replays
   when a tab is reopened or the mark is shown again.
   The turn is for the visitor to see. If the middle of the map — the middle of the globe — is on screen as
   the page opens, it starts at once, even where the lower part of the map is still below the fold (a laptop
   window on the lab site): the visitor has just come in and should see the Earth move. Otherwise the map
   starts below the fold (a short window) and the turn waits until the visitor has scrolled far enough to
   see most of the globe. On a phone-width map it always waits for that: the header fills the first screen
   there, the visitor scrolls at once, and a turn begun with a sliver of the globe in view would be over
   before they arrive. While it waits ("waiting") the panels do not wait with it — an empty dark box would
   look broken — and only the globe and the mark perform. */
function runOpening(start) {
  const root = document.documentElement, D = INTRO.duration;
  const atStart = () => { const c = map.getCenter(); return !map.isMoving() && Math.abs(c.lng - start.center[0]) < 0.01 && Math.abs(map.getZoom() - start.zoom) < 0.01; };
  introRunning = true;
  const finish = () => {
    introRunning = false;
    root.classList.remove("opening", "waiting", "opened", "arrived");
    /* From here on a visitor may not go further out than MIN_ZOOM. If they stopped the turn while it was
       still further out than that, the limit waits until they have come in. */
    const limit = () => { if (map.getZoom() >= MIN_ZOOM) { map.setMinZoom(MIN_ZOOM); map.off("zoomend", limit); } };
    map.on("zoomend", limit); limit();
  };
  const turn = (delay) => {
    setTimeout(() => {                                            // not if the visitor has already moved the map
      if (atStart()) map.easeTo({ ...globeView(), duration: D, easing: (t) => 1 - (1 - t ** 1.4) ** 3 });      // off the mark quickly, then a long slowing into place
    }, delay);
    setTimeout(() => root.classList.replace("opening", "opened"), delay + D * INTRO.panels);
    setTimeout(() => root.classList.add("arrived"), delay + D * INTRO.mark);
    setTimeout(finish, delay + D + 1500);
  };
  root.classList.add("entered");
  setTimeout(() => root.classList.remove("entered"), 1500);
  const low = $("#mapLow"), phone = map.getContainer().clientWidth < 560;      // the width at which the map's panels change (portal.css)
  whenInView(phone ? low : $("#mapMid"), low, () => turn(INTRO.delay), () => root.classList.replace("opening", "waiting"), () => turn(60));
}
/* Two points of the map decide when the opening runs (see runOpening). Calls `now` if `first` is on screen at
   the first look; otherwise `wait`, and `later` once `then` has come into view (they may be the same point).
   Inside a frame the browser still reports what the visitor really sees, which the page cannot measure for
   itself there. */
function whenInView(first, then, now, wait, later) {
  if (!first || !then || !("IntersectionObserver" in window)) return now();
  const seen = new Map();                                         // the latest report on each point: reports may come one at a time
  let looked = false;
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) seen.set(e.target, e.isIntersecting);
    if (!looked) {
      if (!seen.has(first)) return;                               // its first report is still to come
      looked = true;
      if (seen.get(first)) { io.disconnect(); return now(); }
      wait();
    }
    if (seen.get(then)) { io.disconnect(); later(); }
  });
  io.observe(first); io.observe(then);
}
/* The globe view may hold the middle of the map to the right of the middle of its box (camera padding, see
   globeView), and MapLibre keeps such padding for every later move. All other moves belong in the middle of
   the box: `fly` takes the padding off as it goes, and `boundsCamera` works out a fit as if it were already
   off (MapLibre would add the map's current padding to the one it is given). */
const fly = (o) => map.flyTo({ padding: NOPAD, ...o });
function boundsCamera(bounds, padding) {
  const keep = map.getPadding(), padded = keep.left || keep.right || keep.top || keep.bottom;
  if (padded) map.setPadding(NOPAD);                  // no frame is drawn between this and the line that puts it back
  const cam = map.cameraForBounds(bounds, { padding });
  if (padded) map.setPadding(keep);
  return cam;
}
function fitRegion(R, duration) {
  const box = [[R.bounds[0], R.bounds[1]], [R.bounds[2], R.bounds[3]]], pad = fitPadding();
  let cam = boundsCamera(box, pad);
  if (!cam) return;
  /* A region that is wide for the map would run under the coverage card at the map's top left. It is then
     fitted beside the card. (A narrow one, like the Korean Peninsula, stays in the middle of the map.) */
  const card = $("#coverCard"), edge = card.offsetParent !== null ? card.offsetLeft + card.offsetWidth + 12 : 0;
  if (edge > pad.left) {
    const across = (R.bounds[2] - R.bounds[0]) / 360 * 512 * 2 ** cam.zoom, w = map.getContainer().clientWidth;
    if ((w + pad.left - pad.right - across) / 2 < edge) cam = boundsCamera(box, { ...pad, left: edge }) || cam;
  }
  if (duration) fly({ ...cam, duration }); else map.jumpTo({ ...cam, padding: NOPAD });
}
/* To a region: the cards beside the map turn to it and the map fits it — taking longer over the way from
   another part of the world. Where there is no map (no WebGL), or it is out of sight, only the cards turn. */
function goRegion(R) {
  const shown = map && map.getContainer().clientWidth;
  flyingTo = shown ? R : null;                                    // first: turning the cards looks at where the map is, and it is still on the old region
  setFocus(R);
  if (!shown) return;
  const c = map.getCenter(), far = arcDeg(c.lng, c.lat, midLon(R), midLat(R)) > 25;
  fitRegion(R, far ? 2600 : 1400);
  if (!map.isMoving()) flyingTo = null;                           // nothing to wait for: the map was there already
}
/* The region the cards beside the map describe. Its numbers change; the layer on the map does not, unless the
   colour scale is stretched to the region's own range. */
function setFocus(R) {
  if (!R || R === FOCUS) return;
  FOCUS = R;
  if (state.pick && state.pick.region !== R) clearPick();          // a spot picked in another region: the series card goes with the other cards
  applyLayer();
  renderRegionUI();
}
function clearPick() {
  state.pick = null; recordModel = null; $("#recordBox").hidden = true;
  if (pickMarker) pickMarker.remove();
}
/* Room to leave for the panels over the map when a region is fitted. On a narrow map the coverage card
   would sit on the region, so the region is fitted to the right of it. */
function fitPadding() {
  const w = map.getContainer().clientWidth, card = $("#coverCard"), legend = $("#legend");
  const narrow = w < 820 && card.offsetParent !== null;
  /* On a phone the legend is most of the map's width and the readout sits under the controls: the region
     is fitted between them, not behind the legend. */
  const phone = legend.offsetWidth > w / 2;
  return { top: phone ? 96 : 46, bottom: phone ? legend.offsetHeight + 42 : 76, left: narrow ? card.offsetLeft + card.offsetWidth + 12 : 40, right: 40 };
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
    return new maplibregl.Marker({ element: el("div", {}, btn), anchor: "bottom", offset: [0, -3], opacityWhenCovered: "0" }).setLngLat([a.center[0], a.bounds[3]]).addTo(map);
  });
  /* A line for them in the coverage card (which regions, when not every region has them); they are in the
     "Go to" list as well (wire). */
  const row = $("#covFine"), held = REG.filter((R) => R.fine.length);
  row.querySelector("span:last-child").replaceChildren(el("b", {}, "30 m"), ` · ${numWord(FINE.length)} sample area${FINE.length > 1 ? "s" : ""}` +
    (held.length < REG.length ? ` (${wordList(held.map((R) => R.name))})` : ""));
  row.hidden = false;
  onZoom();
}
/* Labels on the map are placed by arithmetic, not by measuring the page: where a place is in MapLibre's world
   at zoom 0 (512 px across). Once the globe has flattened (about zoom 6) two places are their distance here
   times 2^zoom apart on screen, wherever the map has been moved to. */
const worldXY = (lng, lat) => { const s = Math.sin(lat * Math.PI / 180); return [(lng + 180) / 360 * 512, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 512]; };
const textWidth = (() => {
  let c = null;
  return (text, font) => { c = c || document.createElement("canvas").getContext("2d"); c.font = font; return c.measureText(text).width; };
})();
const TAG_H = 22, TAG_FROM = 7, TAG_BY = 9.6;      // a name tag's height in px; the zoom name tags come in at; and the zoom by which every tag is one, room or not
/* How far in the map must be before an area's name tag has room (worked out once, before the marks are
   made). Far out an area is a small square; from zoom 7 it is a tag with its name — unless a neighbour's tag
   would lie on it: the areas around Toulouse are 11 to 22 km apart, and at zoom 7 that is 25 to 50 px for
   tags some 100 px wide. Such neighbours stay squares until the map has grown enough to part their tags
   (side by side, or one above the other), and then turn into tags together. */
function tagRoom() {
  const font = `600 11.5px ${getComputedStyle(document.body).fontFamily}`;
  for (const a of FINE) { a.tagXY = worldXY(a.center[0], a.bounds[3]); a.tagW = Math.ceil(textWidth(a.name, font) + textWidth("30 m", font) + 30); a.tagZoom = TAG_FROM; }
  const close = [];                                                // pairs whose tags would touch at the zoom tags come in, with the zoom that parts them
  FINE.forEach((a, i) => FINE.slice(i + 1).forEach((b) => {
    const dx = Math.abs(a.tagXY[0] - b.tagXY[0]), dy = Math.abs(a.tagXY[1] - b.tagXY[1]);
    const z = Math.min(Math.log2(((a.tagW + b.tagW) / 2 + 6) / dx), Math.log2((TAG_H + 4) / dy), TAG_BY);
    if (z > TAG_FROM) close.push([a, b, z]);
  }));
  for (let again = true; again;) {                                 // neighbours wait for one another: a group changes at the zoom its closest pair needs
    again = false;
    for (const [a, b, z] of close) {
      const top = Math.max(a.tagZoom, b.tagZoom, z);
      if (a.tagZoom < top || b.tagZoom < top) { a.tagZoom = b.tagZoom = top; again = true; }
    }
  }
}
/* What an area's mark covers at a zoom, in screen px from its anchor's place in the world: the square far out,
   the name tag closer in (nothing below zoom 4.2, where the marks are not shown). [x0, y0, x1, y1] */
function markBox(a, z) {
  if (z < 4.2) return null;
  const k = 2 ** z, x = a.tagXY[0] * k, y = a.tagXY[1] * k, w = z < a.tagZoom ? 12 : a.tagW;
  return [x - w / 2, y - 3 - (z < a.tagZoom ? 12 : TAG_H), x + w / 2, y - 3];
}
/* Going to a sample area means seeing its pixels. At 1–2 screen pixels per native pixel an area is hard
   to tell from the 120 m cells around it; from about 3 screen pixels on, the grid and the thin features
   (field edges, roads, streams) show. So: fill the map with the area where that gives at least 3 screen
   pixels per pixel (a large screen), otherwise go in to 3 and let the area run past the edges. */
function goFine(a) {
  if (popup) { popup.remove(); popup = null; }
  const box = map.getContainer(), wide = box.clientWidth >= 900;
  const fit = boundsCamera([[a.bounds[0], a.bounds[1]], [a.bounds[2], a.bounds[3]]],
    { top: 86, bottom: 56, left: wide ? 290 : 24, right: wide ? 40 : 24 });      // clear of the controls (the name tag sits above the outline) and, where there is room, the legend
  const zMin = a.region.fineZoom + 0.6, zMax = a.region.fineZoom + 1.5;                        // 3 to 5.7 screen px per native pixel
  if (fit && fit.zoom >= zMin) fly({ center: fit.center, zoom: Math.min(fit.zoom, zMax), duration: 1800 });
  else fly({ center: a.center, zoom: zMin, duration: 1800 });
}
/* A sample area a click was meant for: far out they are squares a few pixels wide, so a near miss counts. */
function fineNear(point) {
  const near = FINE.map((a) => { const p = map.project(a.center); return [Math.hypot(p.x - point.x, p.y - point.y), a]; }).filter(([d]) => d <= 12).sort((p, q) => p[0] - q[0]);
  return near.length ? near[0][1] : null;
}
let cityMarkers = [], pulses = [];
/* Our place names of all the regions, in one list (the "Go to" list refers to them by their place in it). */
const places = () => REG.flatMap((R) => (CITIES[R.id] || []).map(([name, lng, lat]) => ({ name, lng, lat, region: R })));
function addMarkers() {
  /* A mark on every region. Its label goes to the right — or, for a region to the east of where the globe
     faces, to the left: towards the middle of the globe, so that it stays inside the globe and the map box
     when the region is near the edge. A mark that has gone round the back of the globe is not shown.
     No position on the root: MapLibre makes a marker absolute, and overriding that turns it into a
     full-width block whose "centre" is half the map away. */
  pulses = REG.map((R) => {
    const left = midLon(R) > GLOBE.center[0] + 1;
    const node = el("div", { style: "width:14px;height:14px" }, [el("div", { class: "pulse" }), el("div", { class: "pulse-label" + (left ? " to-left" : "") }, "Available now")]);
    return new maplibregl.Marker({ element: node, anchor: "center", opacityWhenCovered: "0" }).setLngLat([midLon(R) - 0.6, midLat(R) - 0.6]).addTo(map);
  });
  const font = `500 11.5px ${getComputedStyle(document.body).fontFamily}`;
  cityMarkers = places().map((p) => ({ xy: worldXY(p.lng, p.lat), w: Math.ceil(textWidth(p.name, font)) + 4,
    m: new maplibregl.Marker({ element: el("div", {}, el("span", { class: "city" }, p.name)), anchor: "bottom", opacityWhenCovered: "0" }).setLngLat([p.lng, p.lat]).addTo(map) }));
  onZoom();
}
/* A city's name stands over its place. Where the mark of a sample area would lie on it — the square far out,
   the name tag closer in — the name moves to the lower right of its place, and where that is taken as well
   it is not shown: the areas are what the map is for, the names are there to find one's way. (Toulouse has
   three areas just west of it, one of them with its name; Rennes has one.) */
function placeCities(z) {
  const on = z >= 5.6 && z <= 10.6, k = 2 ** z, marks = on ? FINE.map((a) => markBox(a, z)).filter(Boolean) : [];
  const hit = (b) => marks.some((m) => b[0] < m[2] + 2 && m[0] - 2 < b[2] && b[1] < m[3] + 2 && m[1] - 2 < b[3]);
  for (const c of cityMarkers) {
    const span = c.m.getElement().firstChild, x = c.xy[0] * k, y = c.xy[1] * k;
    const over = on && hit([x - c.w / 2, y - 17, x + c.w / 2, y - 3]), aside = over && !hit([x + 4, y + 2, x + 8 + c.w, y + 17]);      // where the name is drawn: over its place, or to the lower right (.city.aside)
    span.classList.toggle("aside", aside);
    span.style.opacity = on && (!over || aside) ? "1" : "0";
  }
}
function onZoom() {
  if (!map) return;
  const z = map.getZoom();
  for (const p of pulses) p.getElement().style.display = z < 4.2 ? "" : "none";
  /* Far out the areas are a few pixels apart, so each is a small square (its name shows on hover); the
     name tags come in once there is room for them (tagRoom). */
  fineTags.forEach((m, i) => { const t = m.getElement().firstChild; t.style.display = z >= 4.2 ? "" : "none"; t.classList.toggle("compact", z < FINE[i].tagZoom); });
  placeCities(z);
  $("#coverCard").classList.toggle("dim", z > 7.2);
  const c = map.getCenter();
  if (map.getLayer("et")) map.setPaintProperty("et", "raster-resampling", z > regionOr(c.lng, c.lat).zoom.max - 0.4 ? "nearest" : "linear");
  onMove();
}
/* What depends on where the view is, not only on how far in: the resolution readout, the three-step
   pill and the note about what is published there. Once per frame while the map moves. */
let moveRAF = 0;
function onMove() { cancelAnimationFrame(moveRAF); moveRAF = requestAnimationFrame(updateView); }
function updateView() {
  if (!map) return;
  /* The region the view is on: the one whose maps are under the middle of the map — or, while a whole region
     is in view, the one whose box the middle is in. A wide region is fitted beside the coverage card, and the
     middle of the map is then off its coast (for France, in the Bay of Biscay). */
  const z = map.getZoom(), c = map.getCenter(), R = regionAt(c.lng, c.lat) || (z < 7 ? boxRegion(c.lng, c.lat) : null), ours = !!R;
  if (R && !flyingTo && !introRunning) setFocus(R);                // the cards beside the map follow the map
  const top = topZoomAt(c.lng, c.lat), zd = Math.min(tileZoom(), top), native = nativeAt(c.lng, c.lat);
  const step = zd <= 8 ? 0 : zd < top ? 1 : 2;
  $("#steps").classList.toggle("off", !ours && z >= 2.6);          // the three steps describe our maps: nothing to say elsewhere
  document.querySelectorAll("#steps span").forEach((s) => s.classList.toggle("on", ours && +s.dataset.step === step));
  if (!fullRes()) document.querySelector('#steps span[data-step="2"]').textContent = native ? "Native 30 m" : `Finest here · ${finestRes(R || FOCUS)}`;
  /* The ground size of a pixel on screen. At the native zoom a tile pixel may be a little smaller than the grid
     the maps were made on (further north it is); the maps are no finer than that grid. */
  const size = ours ? fmtRes(zd === top && native ? Math.max(groundRes(zd, c.lat), (R.cat.source || {}).res_m || 0) : groundRes(zd, c.lat)) : "";
  $("#roRes").textContent = z < 2.6 ? (TOUCH ? "Tap or pinch to zoom in" : "Click or scroll to zoom in")
    : ours ? `${size} per pixel${zd === top ? (native ? " (native)" : " (finest here)") : (R.fine.length && native && zd >= R.zoom.max ? " · zoom in for 30 m" : "")}`
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
  const { lng, lat } = e.lngLat, z = map.getZoom(), R = regionAt(lng, lat);
  if (popup) { popup.remove(); popup = null; }
  if (!R) {
    /* Outside the region with maps a click moves in on the place, in two steps, as far as the background
       has anything to show. There the note at the top says what is published, and the next click offers
       to request the place. */
    if (!onLand(lng, lat)) return;
    const stop = outNoteZoom(lat) + 0.2;
    if (z < 3.6) fly({ center: [lng, lat], zoom: 4.6, duration: 1400 });
    else if (z < stop - 0.4) fly({ center: [lng, lat], zoom: stop, duration: 1500 });
    else demandPopup(e.lngLat);
    return;
  }
  /* A sample area of a reduced copy: a click on its square (or just beside it) far out, or inside its
     outline at the regional view, goes to the area itself. No spot is picked: the click was for the area. */
  const area = z < 4.2 ? null : z < 8 ? fineNear(e.point) : z < R.fineZoom + 0.5 ? fineAreaAt(lng, lat) : null;      // below 4.2 the squares are not shown
  if (area && z < 10.8) { goFine(area); return; }
  if (z < 8) fly({ center: [lng, lat], zoom: zRegional(R), duration: 1500 });
  else if (nativeAt(lng, lat) && z < 10.8) fly({ center: [lng, lat], zoom: nativeZoom(R) - 0.3, duration: 1500 });      // on to the native grid, where the copy has it
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
let noteShown = null, noteOff = null, noteSaid = "";
const reviewClause = () => (CFG.paperStatus ? `While the paper is ${CFG.paperStatus}, ` : "");
const capFirst = (s) => s.charAt(0).toUpperCase() + s.slice(1);
function noteKind() {
  const z = map.getZoom(), c = map.getCenter(), R = regionAt(c.lng, c.lat);
  if (!R) return z >= outNoteZoom(c.lat) && onLand(c.lng, c.lat) ? "outside" : null;
  return !regFull(R) && z >= R.zoom.max - 0.4 && !fineAreaAt(c.lng, c.lat) ? "finest" : null;
}
/* The areas of a region nearest to a place, nearest first. */
const fineNearest = (R, lng, lat, n) => [...R.fine].sort((a, b) => Math.hypot((a.center[0] - lng) * Math.cos(lat * Math.PI / 180), a.center[1] - lat) -
                                                                  Math.hypot((b.center[0] - lng) * Math.cos(lat * Math.PI / 180), b.center[1] - lat)).slice(0, n);
function updateNote(redraw) {
  const kind = noteKind(), box = $("#zoomNote");
  if (!kind) noteOff = null;
  const show = kind && noteOff !== kind ? kind : null, c = map.getCenter();
  /* what the note is about: the nearest region for "outside"; the region and its nearest areas for "finest". The
     view can move a long way inside one situation, and the note then has to follow. */
  const said = !show ? "" : show === "outside" ? regionsByDistance(c.lng, c.lat)[0].id
    : ((R) => `${R.id}:${fineNearest(R, c.lng, c.lat, 3).map((a) => a.id)}`)(regionOr(c.lng, c.lat));
  if (show === noteShown && said === noteSaid && !redraw) return;
  noteShown = show; noteSaid = said;
  box.hidden = !show;
  if (!show) return;
  if (show === "outside") {
    const bg = currentBg(), many = REG.length > 1;
    $("#znHead").textContent = `Only ${theRegions()} ${many ? "have" : "has"} detailed maps for now`;
    $("#znText").textContent = (bg ? `What you see here is the background layer (${BG.name}, about ${fmt(BG.cell_km)} km per cell), not Prithvi-OpenET-Tower. ` : "") +
      capFirst(`${reviewClause()}ready-made maps are published for ${theRegions()} only. Other regions are produced on request.`);
    /* One button, to the nearest region. A button for each made the note a line taller, and it then covered
       the "Request this area" button of the popup that a click on the place opens. */
    $("#znBtns").replaceChildren(
      ...regionsByDistance(c.lng, c.lat).slice(0, 1).map((R) => el("button", { class: "primary small", onclick: () => goRegion(R) }, `Go to ${R.the}`)),
      el("button", { class: "ghost", onclick: () => { const p = map.getCenter(); prefillRequest(p.lng, p.lat); showTab("request"); } }, "Request this area"));
  } else {
    const n = FINE.length, R = regionOr(c.lng, c.lat), own = R.fine.length;
    $("#znHead").textContent = `${finestRes(R)} is the finest level here for now`;
    /* the areas of the region the view is on, in that region's own words; a region that has none hears where they are */
    const where = own ? `${numWord(own)} sample area${own > 1 ? "s" : ""}${R.fineWhat ? `, ${R.fineWhat}` : ""}` : fineWords("sample area");
    $("#znText").textContent = n
      ? capFirst(`${reviewClause()}the native 30 m maps${own && REG.length > 1 ? ` of ${R.the}` : ""} are shown only in ${where}. The full 30 m maps will be released after the paper is accepted.`)
      : `This public preview stops at about ${finestRes(R)} per pixel. The 30 m maps will be released after the paper is accepted.`;
    /* the nearest areas of this region first (all of them are in the "Go to" list); a region that has none
       points to the nearest region that has */
    const near = fineNearest(R, c.lng, c.lat, 3);
    const other = near.length ? null : regionsByDistance(c.lng, c.lat).find((k) => k.fine.length);
    $("#znBtns").replaceChildren(...near.map((a) => el("button", { class: "primary small", onclick: () => goFine(a) }, `${a.name} · 30 m`)),
      ...(other ? [el("button", { class: "primary small", onclick: () => goRegion(other) }, `30 m sample areas · ${other.name}`)] : []));
  }
}
/* The sample areas of the whole site in words, region by region — a catalog says what its region's areas are:
   "eight small areas around the paper's Korean flux-tower sites and eleven around the paper's French
   flux-tower sites", with the areas' names after each when asked for. */
function fineWords(noun, names) {
  const held = REG.filter((R) => R.fine.length);
  return wordList(held.map((R, i) => {
    const n = R.fine.length;
    return numWord(n) + (i ? "" : ` ${noun}${n > 1 ? "s" : ""}`) + (R.fineWhat ? ` ${R.fineWhat}` : held.length > 1 ? ` in ${R.the}` : "") +
      (names ? ` (${wordList(R.fine.map((a) => a.name))})` : "");
  }));
}
let shownTiles = "", shownBg = "";      // what the two sources were last given: asking again for the same tiles would only make the map blink
function syncBackground() {
  if (!map || !map.getLayer("ctx")) return;
  const bg = currentBg(), url = bg ? bgTileURL(bg) : "";
  if (bg && url !== shownBg) { map.getSource("ctx").setTiles([url]); shownBg = url; }
  map.setLayoutProperty("ctx", "visibility", bg ? "visible" : "none");
}
function applyLayer() {
  buildLUT();
  const src = map && map.getSource("et"), url = tileURL();
  if (src && url !== shownTiles) { src.setTiles([url]); shownTiles = url; }
  syncBackground();
  renderLayerCard(); renderLegend(); renderWhen(); renderCalendar();
  if (!state.pick) renderRegionSeries();
  if (map) { updateView(); updateNote(true); }                    // both name the background, which comes and goes with the layer
}

/* ───────────────────────────── layer controls ───────────────────────────── */
function builtYears() { return [...new Set(builtMonths().map((ym) => ym.slice(0, 4)))]; }
function renderWhen() {
  const box = $("#when"); box.replaceChildren();
  document.querySelectorAll("#modeSeg button").forEach((b) => {
    b.classList.toggle("on", b.dataset.mode === state.mode);
    const ok = b.dataset.mode === "annual" ? LAYERS.has("clim_annual") : b.dataset.mode === "clim" ? climMonths().length > 0 : builtYears().length > 0;
    b.disabled = !ok;
  });
  if (state.mode === "annual") { box.append(el("span", { class: "sub" }, `Sum of the twelve monthly means, ${TRAIN_YEARS()}`)); return; }
  let avail;
  if (state.mode === "month") {
    const y = state.ym.slice(0, 4);
    const sel = el("select", { "aria-label": "Year", onchange: (e) => {
      const have = builtMonths().filter((ym) => ym.startsWith(e.target.value));
      state.ym = have.find((ym) => ym.slice(5) === state.ym.slice(5)) || have[0]; state.seriesYear = e.target.value; stopPlay(); applyLayer();
      if (state.pick) loadPickSeries();
    } }, builtYears().map((yy) => el("option", { value: yy, selected: yy === y }, yy)));
    box.append(sel);
    avail = new Set(builtMonths().filter((ym) => ym.startsWith(y)).map((ym) => +ym.slice(5)));
  } else avail = new Set(climMonths());
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
    ? builtMonths().filter((ym) => ym.startsWith(state.ym.slice(0, 4))).map((ym) => +ym.slice(5))
    : climMonths();
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
/* Distribution of the layer's pixels in the region in focus, along the same axis as the colour bar. The
   histogram lives in the layer's sidecar .json (written by build_tiles.py) and is fetched only when the layer
   is shown. */
const histCache = new Map();
function layerHist(ly) {
  if (!ly.url) return Promise.resolve(null);                    // the region in focus has no map of this layer
  if (!histCache.has(ly.url)) {
    histCache.set(ly.url, fetch(ly.url.replace(/\.pmtiles$/, ".json"))
      .then((r) => (r.ok ? r.json() : null)).then((j) => (j && j.hist_dn) || null).catch(() => null));
  }
  return histCache.get(ly.url);
}
async function drawHist(ly, lo, hi) {
  const c = $("#lgHist"), W = 240, H = 34, dpr = Math.min(2, devicePixelRatio || 1);
  const hist = await layerHist(ly), now = currentLayer();
  if (now.id !== ly.id || now.url !== ly.url) return;           // a newer layer, or another region, was chosen meanwhile
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
  $("#lyKicker").textContent = REG.length > 1 ? `On the map · ${FOCUS.name}` : "On the map";
  $("#lyTitle").textContent = ly.label;
  const flag = $("#lyFlag"); flag.hidden = true;
  let sub = "";
  if (ly.missing) sub = `There is no map of this layer for ${FOCUS.the}.`;
  else if (ly.kind === "annual") sub = `Sum of the twelve monthly means over ${TRAIN_YEARS()}. Gap-free wherever every calendar month was observed at least once.`;
  else if (ly.kind === "clim") sub = `Mean of the ${MONL[ly.month - 1]} maps over ${TRAIN_YEARS()}, using the years in which the pixel was observed.`;
  else {
    const r = ly.rec;
    sub = `${r.sensors === "L30" ? "Landsat only" : "Landsat and Sentinel-2"} · ${fmtBytes(r.cog_bytes)} GeoTIFF`;
    if (r.period !== "train") { flag.hidden = false; flag.textContent = `Outside the ${TRAIN_YEARS()} training period — the model is extrapolating in time.`; }
  }
  $("#lySub").textContent = sub;
  $("#lyMean").textContent = fmt(ly.mean);
  $("#lyUnit").textContent = ly.units;
  $("#lyMeanL").textContent = ly.kind === "month" ? "Mean over observed land" : `${FOCUS.short} mean`;
  const cov = ly.missing ? NaN : Math.min(100, ly.cover * 100);
  $("#lyCover").textContent = fmt(cov, cov < 99.5 ? 1 : 0);
  $("#lyCoverBar").style.width = (cov || 0) + "%";
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
function yearSeriesFromCatalog(R, year) {
  return MON.map((_, i) => { const r = R.months.find((m) => m.ym === `${year}-${String(i + 1).padStart(2, "0")}`); return r && r.tiles ? r.tiles.mean : null; });
}
/* The seasonal cycle of the region in focus, from its catalog: the chosen year against the training-period mean. */
function renderRegionSeries() {
  const R = FOCUS, y = state.seriesYear, clim = MON.map((_, i) => { const c = (R.cat.clim || []).find((k) => k.month === i + 1); return c ? c.mean : null; });
  const series = [];
  if (y) series.push({ name: y, short: y, color: "#2E7BA8", values: yearSeriesFromCatalog(R, y) });
  series.push({ name: `${TRAIN_YEARS()} mean`, short: "mean", color: "#8C8A80", values: clim });
  $("#srKicker").textContent = "Seasonal cycle"; $("#srTitle").textContent = `${R.short} mean`; $("#srReset").hidden = true;
  $("#srSub").textContent = y ? `Monthly ET averaged over the land observed in each month of ${y}, against the ${TRAIN_YEARS()} mean. Cloudy months average fewer pixels.` : "";
  drawChart({ title: `${R.short} mean monthly ET`, labels: MON, units: "mm/month", digits: 1, series,
              note: "mean over land pixels with a clear-sky observation", tipHead: (i) => MONL[i] });
}

/* ───────────────────────────── pixel series ───────────────────────────── */
function pickLocation(lng, lat) {
  state.pick = { lng, lat, region: regionOr(lng, lat) };
  recordModel = null; $("#recordBox").hidden = true;             // the previous pixel's record must not sit under the new title
  if (!pickMarker) pickMarker = new maplibregl.Marker({ color: "#B85434", scale: 0.75 });
  pickMarker.setLngLat([lng, lat]).addTo(map);
  loadPickSeries();
}
async function loadPickSeries() {
  const { lng, lat, region: R } = state.pick, z = topZoomAt(lng, lat), t = lngLatToTile(lng, lat, z), y = state.seriesYear;
  const where = `${Math.abs(lat).toFixed(4)}°${lat >= 0 ? "N" : "S"}, ${Math.abs(lng).toFixed(4)}°${lng >= 0 ? "E" : "W"}`;
  $("#srKicker").textContent = cellNameAt(lng, lat); $("#srTitle").textContent = where; $("#srReset").hidden = false;
  $("#srReset").textContent = `← ${FOCUS.short} mean`;
  $("#srSub").textContent = "Reading the monthly maps…";
  const ids = [...MON.map((_, i) => `et_${y}${String(i + 1).padStart(2, "0")}`), ...MON.map((_, i) => `clim_${String(i + 1).padStart(2, "0")}`), "clim_annual"];
  let vals;
  try {
    vals = await mapLimit(ids, 8, async (id) => {
      if (!R.L.has(id)) return null;
      const dn = await getDN(id, z, t.x, t.y), d = dn ? dn[t.py * TILE + t.px] : 255;
      return d === 255 ? null : d * R.L.get(id).dn_step;
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
    note: (nativeAt(lng, lat) ? "browse-tile values" : `means over a ${finestRes(R)} cell of the public preview tiles`) + ", rounded to 1 mm/month; use the GeoTIFFs for analysis",
    series: [{ name: y, short: y, color: "#2E7BA8", values: yr }, { name: `${TRAIN_YEARS()} mean`, short: "mean", color: "#8C8A80", values: clim }] });
  if (!recordModel || recordModel.pick !== state.pick) loadPickRecord(where);      // a year change keeps the record already read
}

/* ───────────────────────────── full record at a pixel ─────────────────────────────
   Every month that has browse tiles, read at the native zoom: one small range request per month
   once each archive's directory is cached. Missing months (cloud, or never produced) stay gaps. */
let recordModel = null;
async function loadPickRecord(where) {
  const mine = state.pick, { lng, lat } = mine, months = mine.region.months.filter((m) => m.tiles);
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
  const REC = R.pick.region.record;                               // the record of the region the spot is in
  const ymIdx = (ym) => +ym.slice(0, 4) * 12 + (+ym.slice(5) - 1);
  const i0 = ymIdx(REC.first), N = ymIdx(REC.last) - i0 + 1;
  const byIdx = new Array(N).fill(undefined);                     // undefined = no map for that month, null = no clear observation
  R.months.forEach((m, k) => { byIdx[ymIdx(m.ym) - i0] = { m, v: R.vals[k] }; });
  const all = R.vals.filter((v) => v != null);
  if (!all.length) { box.append(el("p", { class: "chart-empty" }, "No clear observation in any month.")); return; }
  const W = 360, H = 150, mg = { l: 32, r: 8, t: 8, b: 20 }, pw = W - mg.l - mg.r, ph = H - mg.t - mg.b;
  const yMax = niceCeil(Math.max(...all) * 1.04);
  const X = (i) => mg.l + pw * i / (N - 1), Y = (v) => mg.t + ph * (1 - v / yMax);
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", tabindex: "0",
    "aria-label": `Monthly ET at ${R.where}, ${ymLabel(REC.first)} to ${ymLabel(REC.last)}, mm/month. Use the table below for values.` });
  const t0 = ymIdx(REC.train[0]) - i0, t1 = ymIdx(REC.train[1]) - i0;
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
  return [`# Prithvi-OpenET-Tower monthly ET at ${Math.abs(lat).toFixed(5)}${lat >= 0 ? "N" : "S"} ${Math.abs(lng).toFixed(5)}${lng >= 0 ? "E" : "W"} (${cellNameAt(lng, lat)}), ` +
      `${REG.length > 1 ? `${R.pick.region.name}, ` : ""}data version ${R.pick.region.version}`,
    "# Browse-tile values rounded to 1 mm/month and resampled to Web Mercator. Use the GeoTIFFs for analysis." +
      (nativeAt(lng, lat) ? "" : ` This public copy of the tiles stops at about ${finestRes(R.pick.region)} per pixel: each value is the mean over such a cell.`),
    "# Empty et_mm_per_month = no clear-sky observation that month. period: train = within the model's training years.",
    "month,et_mm_per_month,period,sensors",
    ...R.months.map((m, k) => [m.ym, R.vals[k] == null ? "" : R.vals[k], m.period, m.sensors].join(","))].join("\n") + "\n";
}

/* ───────────────────────────── calendar of the record ───────────────────────────── */
function renderCalendar() {
  const box = $("#cal"); box.replaceChildren(el("span"));
  MON.forEach((mn) => box.append(el("span", { class: "cal-h" }, mn[0])));
  const REC = FOCUS.record;                                       // the record of the region in focus
  const y0 = +REC.first.slice(0, 4), y1 = +REC.last.slice(0, 4), byYm = new Map(FOCUS.months.map((m) => [m.ym, m]));
  const cls = (c) => COVER_STEPS[clamp(Math.floor(c * 5), 0, 4)];
  for (let y = y0; y <= y1; y++) {
    const train = `${y}-01` >= REC.train[0] && `${y}-12` <= REC.train[1];
    box.append(el("span", { class: "cal-y" + (train ? " train" : "") }, String(y)));
    for (let mo = 1; mo <= 12; mo++) {
      const ym = `${y}-${String(mo).padStart(2, "0")}`, r = byYm.get(ym);
      let node, lines;
      if (!r) {
        node = el("span", { class: "cal-c none" });
        lines = [ymLabel(ym), ym < REC.first || ym > REC.last ? "outside the record" : "not produced — an input was unavailable"];
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
  const nBuilt = REC.with_tiles;
  $("#calSub").textContent = `${REC.n} monthly GeoTIFFs${REG.length > 1 ? ` of ${FOCUS.the}` : ""} from ${ymLabel(REC.first)} to ${ymLabel(REC.last)}. ` +
    (nBuilt < REC.n ? `Map tiles exist for ${nBuilt} of them in this prototype. ` : "") + `Bold years are the model's training period.`;
  $("#calLegend").replaceChildren(
    el("span", {}, ["Land observed: ", ...COVER_STEPS.map((c) => el("i", { style: `background:${c}` })), " 0 → 100%"]),
    nBuilt < REC.n ? el("span", {}, [el("i", { style: "box-shadow:inset 0 0 0 1px #D9D5C7;background:#FAF9F5" }), "tiles not built yet"]) : "",
    el("span", {}, [el("i", { style: "background:radial-gradient(circle,#D9D5C7 1.5px,transparent 2px)" }), "no map"]));
}

/* ───────────────────────────── download + code ───────────────────────────── */
/* Where a region's GeoTIFFs are: a public address (cogBase in js/config.js — one address for the first region,
   or one per region id), or on the lab's internal copy the storage path its page was given (nas, nas_<id>). */
const cogOf = (R) => (CFG.cogBase && typeof CFG.cogBase === "object" ? CFG.cogBase[R.id] || "" : R === REG[0] ? CFG.cogBase : "").replace(/\/$/, "");
const nasOf = (R) => (R === REG[0] ? CFG.nasPath : CFG.nasMore[R.id] || "").replace(/\/$/, "");
const fileAddress = (R, rel) => (cogOf(R) ? cogOf(R) + "/" + rel : nasOf(R) ? nasOf(R) + "/" + rel : rel);
/* The grid of a region's GeoTIFFs in words, from its catalog: "EPSG:5179 (Korea 2000 / Unified CS), 30 m, 22,403 × 36,677 pixels". */
function gridWords(R) {
  const s = R.cat.source || {};
  return s.epsg && s.width ? `EPSG:${s.epsg}${s.crs ? ` (${s.crs})` : ""}, ${fmt(s.res_m)} m, ${fmt(s.width)} × ${fmt(s.height)} pixels`
    : R === REG[0] ? "" : s.grid || "";      // a catalog from before the grid was read from the files: for the first region the page's own words stand
}
const epsgOf = (R) => { const s = R.cat.source || {}; return s.epsg || +(/EPSG:(\d+)/.exec(s.grid || "") || [])[1] || 0; };
/* The Download tab lists the files of one region: the one in focus, which its own list can change. */
function renderDownload() {
  const R = FOCUS, cog = cogOf(R), nas = nasOf(R);
  const notice = $("#dlNotice"); notice.replaceChildren();
  if (cog) notice.append("Files download directly from the links below.");
  else {
    notice.append(el("b", {}, "Public download links are not open yet. "), "They will be added here after the paper is accepted.");
    if (nas) notice.append(el("br"), "Lab members: the files are on the lab storage under ", el("code", {}, nas + "/et_30m/"), ".");
  }
  $("#dlLead").textContent = `One Cloud-Optimized GeoTIFF per month${REG.length > 1 ? " and region" : ""}. Each file holds the whole of ${R.the} at 30 m and can be read in part over HTTP, so you rarely need the full archive.`;
  const grid = gridWords(R);
  if (grid) $("#dlGrid").textContent = grid;
  const years = [...new Set(R.months.map((m) => m.ym.slice(0, 4)))], sel = $("#dlYear");
  sel.replaceChildren(el("option", { value: "" }, "All years"), ...years.map((y) => el("option", { value: y }, y)));
  const body = $("#dlTable tbody");
  const draw = () => {
    const rows = R.months.filter((m) => !sel.value || m.ym.startsWith(sel.value));
    body.replaceChildren(...rows.map((m) => {
      const name = m.cog.split("/").pop();
      return el("tr", {}, [el("td", {}, ymLabel(m.ym)),
        el("td", { class: "mono" }, cog ? el("a", { href: fileAddress(R, m.cog) }, name) : name),
        el("td", { class: "num" }, fmtBytes(m.cog_bytes)),
        el("td", {}, el("span", { class: "pill" + (m.period === "train" ? "" : " ex") }, m.period === "train" ? "training period" : "extrapolated")),
        el("td", {}, m.sensors === "L30" ? "Landsat" : "Landsat + Sentinel-2"),
        el("td", {}, m.tiles ? "yes" : "—"),
        el("td", { class: "mono", title: m.sha256 }, m.sha256 ? m.sha256.slice(0, 12) + "…" : "—")]);
    }));
    $("#dlTotal").textContent = `${rows.length} files · ${fmtBytes(rows.reduce((a, m) => a + m.cog_bytes, 0))}`;
  };
  sel.onchange = draw; draw();
  const picked = () => R.months.filter((m) => !sel.value || m.ym.startsWith(sel.value));
  $("#dlCopy").onclick = (e) => copyText(picked().map((m) => fileAddress(R, m.cog)).join("\n"), e.currentTarget);
  $("#dlSums").onclick = () => download("SHA256SUMS.txt", picked().filter((m) => m.sha256).map((m) => `${m.sha256}  ${m.cog}`).join("\n") + "\n", "text/plain");
}
/* The examples of the Code tab are written for one region: the one in focus, which its own list can change. */
function renderCode() {
  const R = FOCUS, base = cogOf(R) || nasOf(R) || "https://<address announced at publication>";
  const stem = R.months[0].cog.split("/").pop().replace(/\d{6}\.tif$/, "");      // how the region's files are named: "KP_ET30m_"
  const ex = EXAMPLES[R.id] || { box: [midLon(R) - 0.15, midLat(R) - 0.1, midLon(R) + 0.15, midLat(R) + 0.1], boxName: `in ${R.the}`, point: [midLon(R), midLat(R)] };
  const two = (v) => v.toFixed(2), epsg = epsgOf(R);
  $("#codePy").textContent =
`import rasterio
from rasterio.warp import transform_bounds
from rasterio.windows import from_bounds

src_path = "${base}/et_30m/2021/${stem}202107.tif"        # July 2021
west, south, east, north = ${ex.box.map(two).join(", ")}      # lon/lat box: ${ex.boxName}

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
lon, lat = ${ex.point.map(two).join(", ")}
months = [f"{y}{m:02d}" for y in range(2016, 2025) for m in range(1, 13)]

xy, series = None, {}
for ym in months:
    with rasterio.open(f"{base}/{ym[:4]}/${stem}{ym}.tif") as src:
        if xy is None:                                        # the grid is ${epsg ? `EPSG:${epsg}` : "a projected one"}, not lon/lat
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
    : "Longitude and latitude in degrees. Tip: on the map, zoom in on a place that has no ready-made maps and choose “Request this area”.";
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
  $("#abDemand").textContent = `Only ${theRegions()} ${REG.length > 1 ? "are" : "is"} ready to browse and download. For any other land area covered by HLS, we produce the maps on request for any month from ${win.text}. Use the “Request a region” tab.`;
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
    if (fitWhenShown) { const R = fitWhenShown; fitWhenShown = null; fitRegion(R, 0); }
    else if (openedHidden) { map.stop(); map.jumpTo(globeView()); }      // the globe was sized before its box had a size
    openedHidden = false;
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
  /* The "Go to" list: the regions (when there are several), the sample areas of a reduced copy, and our place
     names region by region. The list snaps back to its prompt once a choice is made. */
  const many = REG.length > 1, spots = places(), jump = $("#jump");
  if (many) jump.append(el("optgroup", { label: "Regions" }, REG.map((R) => el("option", { value: "region:" + R.id }, R.name))));
  for (const R of REG) if (R.fine.length) jump.append(el("optgroup", { label: many ? `30 m areas · ${R.name}` : "30 m areas" }, R.fine.map((a) => el("option", { value: "fine:" + FINE.indexOf(a) }, a.name))));
  for (const R of REG) {
    const own = spots.map((p, i) => [p, i]).filter(([p]) => p.region === R);
    if (own.length) jump.append(el("optgroup", { label: many ? `Cities · ${R.name}` : "Cities" }, own.map(([p, i]) => el("option", { value: "city:" + i }, p.name))));
  }
  if (many || FINE.length) { jump.options[0].textContent = "Go to…"; jump.setAttribute("aria-label", `Go to a ${many ? "region, a " : ""}${FINE.length ? "30 m area or a " : ""}city`); }
  jump.onchange = (e) => {
    const [kind, k] = e.target.value.split(":"), p = spots[+k];
    if (kind === "region") goRegion(REG.find((R) => R.id === k));
    else if (kind === "fine") goFine(FINE[+k]);
    else if (kind === "city" && p) fly({ center: [p.lng, p.lat], zoom: zRegional(p.region), duration: 1600 });      // regional view around the city
    e.target.value = "";
  };
  /* A button over the map for every region (the first one's is in the page already), the same choice above the
     cards beside the map, and in the lists of the Download and Code tabs. */
  const home = $("#btnHome");
  home.textContent = REG[0].short; home.title = `Fit ${REG[0].the}`; home.classList.add("region-btn");
  home.onclick = () => goRegion(REG[0]);
  REG.slice(1).reduce((after, R) => { const b = el("button", { class: "mbtn region-btn more-region", title: `Fit ${R.the}`, onclick: () => goRegion(R) }, R.short); after.after(b); return b; }, home);
  if (many) {
    document.documentElement.classList.add("multi");
    $("#regionSeg").replaceChildren(...REG.map((R) => el("button", { "data-region": R.id, title: `The cards describe ${R.the}; the map goes there`, onclick: () => goRegion(R) }, R.name)));
    $("#regionBar").hidden = false;
    for (const q of ["#dlRegion", "#codeRegion"]) {
      const s = $(q);
      s.replaceChildren(...REG.map((R) => el("option", { value: R.id }, R.name)));
      s.onchange = () => setFocus(REG.find((R) => R.id === s.value));      // the lists and the examples only: the map stays where it is
      s.closest("[hidden]").hidden = false;
    }
  }
  $("#btnGlobe").onclick = () => map.flyTo({ ...globeView(), duration: 1800 });
  $("#srReset").onclick = () => { clearPick(); renderRegionSeries(); };
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
  const fine = finestAll(), n = FINE.length;
  const low = REG.filter((R) => !regFull(R)), one = low.length === 1;      // the regions whose copy is a reduced one
  document.querySelector('#steps span[data-step="2"]').textContent = `Finest here · ${finestRes(FOCUS)}`;
  $("#hint").textContent = `Click ${theRegions("or")}: the map zooms in to about ${fine} per pixel, the finest level of this public preview, and the panel on the right shows the monthly series at that spot.` +
    (n ? ` ${capFirst(fineWords("small area"))} ${n > 1 ? "go" : "goes"} on to the native 30 m; ${n > 1 ? "they are" : "it is"} outlined on the map and listed under “Go to”.` : "") +
    " The 30 m maps themselves are the GeoTIFFs.";
  $("#rcHead").textContent = "Full record at this spot";
  $("#tilesZoom").textContent = `zoom ${low[0].zoom.min}–${low[0].zoom.max} on this public copy, about ${fine} per pixel at best` +
    (n ? `, plus zoom ${Math.max(...REG.map((R) => R.fineZoom))} (30 m) inside ${numWord(n)} small area${n > 1 ? "s" : ""}` : "") + `; the full set goes to zoom ${nativeZoom(low[0])}, 30 m`;
  const badge = $("#previewBadge");
  badge.textContent = n ? `Public preview · ${fine}, and 30 m in ${numWord(n)} area${n > 1 ? "s" : ""}` : `Public preview · maps shown down to ${fine}`; badge.hidden = false;
  const li = $("#abPreview");
  li.replaceChildren(el("b", {}, "This site shows a reduced copy."), ` The maps on this page stop at about ${fine} per pixel` +
    (one ? "" : ` (${wordList(low.map((R) => `${finestRes(R)} in ${R.the}`))})`) + `, and a value read at a clicked spot is the mean over ${one ? `a ${fine} cell` : "one such cell"}.` +
    (n ? ` ${capFirst(fineWords("small area", true))} ${n > 1 ? "keep" : "keeps"} the native 30 m.` : "") + " The 30 m maps are the GeoTIFFs.");
  li.hidden = false;
}
/* What the page says about its regions: their names wherever the page lists what is ready, and the parts of
   its text that are about one region only, which show when that region is there. */
function applyRegionWording() {
  const many = REG.length > 1, names = REG.map((R) => R.name);
  $("#factRegions").textContent = names.join(" · ");
  $("#covRegions").textContent = names.join(", ");
  $("#covMap").alt = `World map. ${regionNames()} ${many ? "are" : "is"} coloured and ringed; all other land is grey.`;
  $("#abRegions").textContent = theRegions();
  $("#glCoverage").textContent = `${regionNames()}; other regions on request`;
  for (const n of document.querySelectorAll("[data-for-region]")) n.hidden = !REG.some((R) => R.id === n.dataset.forRegion);
  if (fullRes() && (many || REG[0].id !== "kp")) $("#hint").textContent = `Click ${theRegions("or")}: the map zooms in two steps, from the coarse overview to a regional view (about ${resRange(REG.map((R) => groundRes(10, midLat(R))))} per pixel) and then to the native 30 m, and the panel on the right shows the monthly series at that pixel.`;
}
/* Everything outside the cards that follows the region in focus: the choice above the cards, the lists of the
   Download and Code tabs and what those tabs show. (The cards themselves are applyLayer's.) */
function renderRegionUI() {
  document.querySelectorAll("#regionSeg button").forEach((b) => { const on = b.dataset.region === FOCUS.id; b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on)); });
  for (const q of ["#dlRegion", "#codeRegion"]) $(q).value = FOCUS.id;
  $("#srReset").textContent = `← ${FOCUS.short} mean`;
  renderDownload(); renderCode();
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
    ` Outside ${theRegions()} the map shows ${BG.long || BG.name}${BG.period ? `, the ${BG.period} mean` : ""}${BG.grid ? ` on a ${BG.grid} grid` : ""} (about ${fmt(BG.cell_km)} km).` +
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
  /* the record as the page's header gives it: from the earliest first month to the latest last month of the regions */
  const r0 = REG.map((R) => R.record.first).sort()[0], r1 = REG.map((R) => R.record.last).sort().pop();
  const first = ymLabel(r0), last = ymLabel(r1);
  $("#factRecord").textContent = `${MON[+r0.slice(5) - 1]} ${r0.slice(0, 4)} – ${MON[+r1.slice(5) - 1]} ${r1.slice(0, 4)}`;
  $("#abRecord").textContent = `${first} to ${last}`;
  $("#glRecord").textContent = `${first} – ${last}`;
  $("#abMail").textContent = CFG.requestEmail; $("#abMail").href = "mailto:" + CFG.requestEmail;
  $("#footVer").textContent = REG.length > 1 ? `Data versions: ${REG.map((R) => `${R.name} ${R.version}`).join(" · ")}` : `Data version ${CAT.version}`;
  applyRegionWording();
  if (CFG.paperStatus) $("#abPaper").textContent = `Manuscript ${CFG.paperStatus}.`;
  if (CFG.notice && !CFG.nasPath) applyNotice();                   // not on the lab's internal copy, which is no preview and says so itself
  if (!fullRes()) applyPreviewWording();
  if (BG) applyBackgroundWording();
  wire(); initRequest(); renderRegionUI();
  renderLayerCard(); renderLegend(); renderWhen(); renderCalendar(); renderRegionSeries();
  if (!webglWorks()) noMap(true, "the browser gives no WebGL context");
  else { try { initMap(); } catch (e) { noMap(true, e.message); } }
  const tab = Q.get("tab"); if (tab && document.getElementById("tab-" + tab)) showTab(tab);
  sendHeight();
}
main();
})();
