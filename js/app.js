/* Prithvi-OpenET-Tower data portal — single-page app, no build step.

   How the map gets its data
     catalog.json lists every month of the record and, for months that have browse tiles, one
     PMTiles file. A tile is an 8-bit PNG whose pixel is ET in whole units (DN x dn_step);
     DN 255 means no data. MapLibre asks our "etn://" protocol for tiles; we fetch the PNG by
     HTTP range request, keep the decoded numbers, and hand back a coloured bitmap. Because the
     numbers stay in memory, the cursor readout and the pixel series need no extra server. */
(() => {
"use strict";

/* ───────────────────────────── configuration ───────────────────────────── */
const CFG = Object.assign({ dataBase: "./data/", cogBase: "", requestEmail: "", requestEndpoint: "", demandFirstMonth: "2013-04",
                            demandLagMonths: 3, nasPath: "" }, window.PORTAL_CONFIG || {});
const Q = new URLSearchParams(location.search);
{
  const d = Q.get("data");                       // same-origin absolute path only
  if (d && /^\/(?!\/)[\w\-./]*\/$/.test(d)) CFG.dataBase = d;
  const nas = Q.get("nas");                      // lab storage path, shown on the internal copy
  if (nas && /^\/[\w\-./]+$/.test(nas)) CFG.nasPath = nas;
}
const EMBED = Q.get("embed") === "1";
if (EMBED) document.documentElement.classList.add("embed");
const DATA = new URL(CFG.dataBase, location.href).href;
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONL = ["January", "February", "March", "April", "May", "June", "July", "August", "September",
              "October", "November", "December"];
const TILE = 256;
const OCEAN = "#E7EBEC", LAND = "#C9C6BC", LAND_EDGE = "#B3B0A5";       // the world view: neutral water, grey land
const WORLD = [[-180, -58], [180, 80]];          // the opening view: the whole world, flat, without the polar margins
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
const state = { mode: "annual", ym: null, climMonth: 7, scale: "fixed", opacity: 1, pick: null,
                seriesYear: null, playing: null };
let lut32 = new Uint32Array(256), lutKey = "";
let chartModel = null;

function currentLayerId() {
  if (state.mode === "annual" && L.has("clim_annual")) return "clim_annual";
  if (state.mode === "clim") return `clim_${String(state.climMonth).padStart(2, "0")}`;
  return "et_" + state.ym.replace("-", "");
}
const currentLayer = () => L.get(currentLayerId());
function currentRange(ly) {
  if (state.scale === "fixed") return FIXED_RANGE[ly.kind];
  const step = ly.kind === "annual" ? 50 : 10;
  const lo = Math.floor(ly.p02 / step) * step, hi = Math.ceil(ly.p98 / step) * step;
  return [lo, Math.max(hi, lo + step)];
}

/* ───────────────────────────── numeric tiles ───────────────────────────── */
const archives = new Map(), dnCache = new Map(), pending = new Map();
const DN_MAX = 900;
function archive(id) {
  let a = archives.get(id);
  if (!a) { a = new pmtiles.PMTiles(new pmtiles.FetchSource(DATA + L.get(id).file)); archives.set(id, a); }
  return a;
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
    if (z < CAT.zoom.min) dn = await coarserDN(id, z, x, y);
    else {
      const res = await archive(id).getZxy(z, x, y);
      dn = res && res.data && res.data.byteLength ? await decodeDN(res.data) : null;
    }
    dnCache.set(key, dn);
    if (dnCache.size > DN_MAX) dnCache.delete(dnCache.keys().next().value);
    return dn;
  })().finally(() => pending.delete(key));
  pending.set(key, p);
  return p;
}
/* The archives start at zoom 3; the world view needs zoom 0-2. Those few tiles are averaged here from
   the zoom-3 tiles, with the pipeline's own rule: a pixel is kept when a quarter of it has data. */
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
function buildLUT() {
  const ly = currentLayer(), [lo, hi] = currentRange(ly);
  for (let d = 0; d < 255; d++) {
    const [r, g, b] = rampRGB((d * ly.dn_step - lo) / (hi - lo));
    lut32[d] = (255 << 24 | b << 16 | g << 8 | r) >>> 0;       // little-endian RGBA
  }
  lut32[255] = 0;
  lutKey = `${ly.id}_${lo}_${hi}`;
}
function registerProtocol() {
  maplibregl.addProtocol("etn", async (params) => {
    const m = /^etn:\/\/([^/]+)\/(\d+)\/(\d+)\/(\d+)/.exec(params.url);
    const dn = m && L.has(m[1]) ? await getDN(m[1], +m[2], +m[3], +m[4]) : null;
    if (!dn) return { data: await createImageBitmap(new ImageData(1, 1)) };
    const img = new ImageData(TILE, TILE), px = new Uint32Array(img.data.buffer);
    for (let i = 0; i < px.length; i++) px[i] = lut32[dn[i]];
    return { data: await createImageBitmap(img) };
  });
}
const tileURL = () => `etn://${currentLayerId()}/{z}/{x}/{y}?k=${lutKey}`;

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
  const inRing = (ring) => {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > lat) !== (yj > lat) && lng < (xj - xi) * (lat - yi) / (yj - yi) + xi) c = !c;
    }
    return c;
  };
  for (const f of landGeo.features) {
    const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
    for (const poly of polys) if (inRing(poly[0]) && !poly.slice(1).some(inRing)) return true;
  }
  return false;
}
/* MapLibre rounds the zoom for raster sources and 256-px tiles sit one level ahead of the map zoom. */
const tileZoom = () => clamp(Math.round(map.getZoom() + 1), 0, CAT.zoom.max);

function initMap() {
  buildLUT();
  registerProtocol();
  map = new maplibregl.Map({
    container: "map",
    style: {
      version: 8,
      sources: {
        /* Imagery is context for looking closely, so it only starts once the view is regional (tile zoom 5,
           map zoom 3.5). The world view stays a plain coverage map: grey land, colour where data exists. */
        sat: { type: "raster", tileSize: 256, minzoom: 5, maxzoom: 18,
               tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
               attribution: "Imagery © Esri, Maxar, Earthstar Geographics" },
        et: { type: "raster", tileSize: 256, minzoom: 0, maxzoom: CAT.zoom.max, bounds: CAT.bounds,
              tiles: [tileURL()], attribution: "ET: Prithvi-OpenET-Tower, HydroAI Lab (GIST)" },
      },
      layers: [
        { id: "bg", type: "background", paint: { "background-color": OCEAN } },
        { id: "sat", type: "raster", source: "sat", paint: { "raster-saturation": -0.3, "raster-brightness-max": 0.92,
            "raster-opacity": ["interpolate", ["linear"], ["zoom"], 3.5, 0, 4.6, 1] } },
        { id: "et", type: "raster", source: "et", paint: { "raster-opacity": 1, "raster-fade-duration": 150 } },
      ],
    },
    center: [10, 28], zoom: 0.8, minZoom: -1, maxZoom: 14.5,
    attributionControl: { compact: true }, dragRotate: false, pitchWithRotate: false, touchPitch: false,
  });
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  map.addControl(new maplibregl.ScaleControl({ unit: "metric", maxWidth: 110 }), "bottom-left");
  window.__portal = { map, state, getDN, L, dnCache, exact: () => exactDecode };          // handle for tests and debugging

  map.on("error", (e) => console.warn("[map]", e && e.error ? e.error.message : e));
  map.on("load", () => {
    $("#boot").classList.add("out");
    setTimeout(() => $("#boot").remove(), 500);
    addMarkers();
    loadLand();
    const pad = { top: 46, bottom: 76, left: 40, right: 40 };
    const b = [[CAT.bounds[0], CAT.bounds[1]], [CAT.bounds[2], CAT.bounds[3]]];
    /* Open on the whole world — grey except where data exists — then move in to that region. */
    if (Q.get("intro") === "0" || REDUCED) map.fitBounds(b, { padding: pad, duration: 0 });
    else { map.fitBounds(WORLD, { duration: 0 }); setTimeout(() => map.fitBounds(b, { padding: pad, duration: 2800 }), 1500); }
  });
  map.on("zoom", onZoom);
  map.on("mousemove", onHover);
  map.on("mouseout", () => { $("#roVal").textContent = ""; });
  map.on("click", onClick);
}
async function loadLand() {
  /* Natural Earth 1:50m land (public domain), cut at the antimeridian. A "stitched" outline such as
     world-atlas draws bands across the map here, because MapLibre treats longitudes as planar.
     It sits under the imagery, so it shows only in the world view, before the imagery fades in. */
  try {
    landGeo = await (await fetch(new URL("assets/land-50m.json", location.href))).json();
    map.addSource("land", { type: "geojson", data: landGeo, tolerance: 0.2 });
    map.addLayer({ id: "land", type: "fill", source: "land", paint: { "fill-color": LAND } }, "sat");
    map.addLayer({ id: "land-line", type: "line", source: "land", paint: { "line-color": LAND_EDGE, "line-width": 0.5 } }, "sat");
  } catch (e) { console.warn("[land outline]", e.message); }
}
let cityMarkers = [], pulse = null;
function addMarkers() {
  const c = [(CAT.bounds[0] + CAT.bounds[2]) / 2 - 2.6, (CAT.bounds[1] + CAT.bounds[3]) / 2 - 0.4];      // just west of the peninsula, label to its left
  /* No position on the root: MapLibre makes a marker absolute, and overriding that turns it into a
     full-width block whose "centre" is half the map away. */
  const node = el("div", { style: "width:14px;height:14px" }, [el("div", { class: "pulse" }), el("div", { class: "pulse-label" }, "Korean Peninsula · available now")]);
  pulse = new maplibregl.Marker({ element: node, anchor: "center" }).setLngLat(c).addTo(map);
  cityMarkers = CITIES.map(([name, lng, lat]) =>
    new maplibregl.Marker({ element: el("div", {}, el("span", { class: "city" }, name)), anchor: "bottom" }).setLngLat([lng, lat]).addTo(map));
  onZoom();
}
function onZoom() {
  if (!map) return;
  const z = map.getZoom(), zc = tileZoom();
  if (pulse) pulse.getElement().style.display = z < 4.2 ? "" : "none";
  for (const m of cityMarkers) m.getElement().firstChild.style.opacity = z >= 5.6 && z <= 10.6 ? "1" : "0";
  $("#coverCard").classList.toggle("dim", z > 7.2);
  const res = 40075016.686 * Math.cos(map.getCenter().lat * Math.PI / 180) / (TILE * 2 ** zc);
  const step = zc <= 8 ? 0 : zc < CAT.zoom.max ? 1 : 2;
  document.querySelectorAll("#steps span").forEach((s) => s.classList.toggle("on", +s.dataset.step === step));
  $("#roRes").textContent = z < 2.6 ? "World view — zoom in to see the data" : `${fmtRes(res)} per pixel${zc === CAT.zoom.max ? " (native)" : ""}`;
  if (map.getLayer("et")) map.setPaintProperty("et", "raster-resampling", z > CAT.zoom.max - 0.4 ? "nearest" : "linear");
}
let hoverRAF = 0;
function onHover(e) {
  cancelAnimationFrame(hoverRAF);
  hoverRAF = requestAnimationFrame(() => {
    const { lng, lat } = e.lngLat, ly = currentLayer(), out = $("#roVal");
    if (!inBounds(lng, lat)) { out.textContent = ""; return; }
    for (let z = Math.min(CAT.zoom.max, tileZoom() + 1); z >= 0; z--) {   // the tile on screen, else a coarser parent already loaded
      const t = lngLatToTile(lng, lat, z), dn = dnCache.get(`${ly.id}/${z}/${t.x}/${t.y}`);
      if (dn === undefined) continue;
      const d = dn ? dn[t.py * TILE + t.px] : 255;
      out.textContent = d === 255 ? "no data" : `${fmt(d * ly.dn_step)} ${ly.units}`;
      return;
    }
    out.textContent = "";
  });
}
function onClick(e) {
  const { lng, lat } = e.lngLat;
  if (popup) { popup.remove(); popup = null; }
  if (!inBounds(lng, lat)) { if (onLand(lng, lat)) demandPopup(e.lngLat); return; }
  const z = map.getZoom();
  if (z < 8) map.flyTo({ center: [lng, lat], zoom: 9.2, duration: 1500 });
  else if (z < 10.8) map.flyTo({ center: [lng, lat], zoom: 11.7, duration: 1500 });
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
function applyLayer() {
  buildLUT();
  const src = map && map.getSource("et");
  if (src) src.setTiles([tileURL()]);
  renderLayerCard(); renderLegend(); renderWhen(); renderCalendar();
  if (!state.pick) renderPeninsulaSeries();
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
  drawHist(ly, lo, hi);
}
/* Distribution of the layer's pixels along the same axis as the colour bar. The histogram lives in the
   layer's sidecar .json (written by build_tiles.py) and is fetched only when the layer is shown. */
const histCache = new Map();
function layerHist(ly) {
  if (!histCache.has(ly.id)) {
    histCache.set(ly.id, fetch(DATA + ly.file.replace(/\.pmtiles$/, ".json"))
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
  const { lng, lat } = state.pick, z = CAT.zoom.max, t = lngLatToTile(lng, lat, z), y = state.seriesYear;
  const where = `${Math.abs(lat).toFixed(4)}°${lat >= 0 ? "N" : "S"}, ${Math.abs(lng).toFixed(4)}°${lng >= 0 ? "E" : "W"}`;
  $("#srKicker").textContent = "30 m pixel"; $("#srTitle").textContent = where; $("#srReset").hidden = false;
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
    note: "browse-tile values, rounded to 1 mm/month; use the GeoTIFFs for analysis",
    series: [{ name: y, short: y, color: "#2E7BA8", values: yr }, { name: `${TRAIN_YEARS()} mean`, short: "mean", color: "#8C8A80", values: clim }] });
  if (!recordModel || recordModel.pick !== state.pick) loadPickRecord(where);      // a year change keeps the record already read
}

/* ───────────────────────────── full record at a pixel ─────────────────────────────
   Every month that has browse tiles, read at the native zoom: one small range request per month
   once each archive's directory is cached. Missing months (cloud, or never produced) stay gaps. */
let recordModel = null;
async function loadPickRecord(where) {
  const mine = state.pick, { lng, lat } = mine, months = CAT.months.filter((m) => m.tiles);
  const z = CAT.zoom.max, t = lngLatToTile(lng, lat, z);
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
  return [`# Prithvi-OpenET-Tower monthly ET at ${lat.toFixed(5)}N ${lng.toFixed(5)}E (30 m pixel), data version ${CAT.version}`,
    "# Browse-tile values rounded to 1 mm/month and resampled to Web Mercator. Use the GeoTIFFs for analysis.",
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
    notice.append(el("b", {}, "Public download links are not open yet. "), "They will be added here when the paper is published.");
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
    : "Longitude and latitude in degrees. Tip: click anywhere outside Korea on the map, then “Request this area”.";
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
  if (name === "explore" && map) map.resize();
  hideTip(); sendHeight();
}
function sendHeight() {
  if (window.parent === window) return;
  const h = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
  window.parent.postMessage({ type: "portalHeight", height: h }, "*");
}
function wire() {
  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => showTab(t.dataset.tab)));
  document.querySelectorAll("#modeSeg button").forEach((b) => b.addEventListener("click", () => { stopPlay(); state.mode = b.dataset.mode; applyLayer(); }));
  document.querySelectorAll("#scaleSeg button").forEach((b) => b.addEventListener("click", () => { state.scale = b.dataset.scale; applyLayer(); }));
  $("#opacity").addEventListener("input", (e) => map.setPaintProperty("et", "raster-opacity", e.target.value / 100));
  $("#jump").append(...CITIES.map(([name], i) => el("option", { value: i }, name)));
  $("#jump").onchange = (e) => {                                   // regional view around the city; the list snaps back to its prompt
    const c = CITIES[+e.target.value];
    if (e.target.value !== "" && c) map.flyTo({ center: [c[1], c[2]], zoom: 9.2, duration: 1600 });
    e.target.value = "";
  };
  $("#btnHome").onclick = () => map.fitBounds([[CAT.bounds[0], CAT.bounds[1]], [CAT.bounds[2], CAT.bounds[3]]], { padding: { top: 46, bottom: 76, left: 40, right: 40 }, duration: 1400 });
  $("#btnWorld").onclick = () => map.fitBounds(WORLD, { duration: 1800 });
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
  wire(); initRequest(); renderDownload(); renderCode();
  renderLayerCard(); renderLegend(); renderWhen(); renderCalendar(); renderPeninsulaSeries();
  initMap();
  const tab = Q.get("tab"); if (tab && document.getElementById("tab-" + tab)) showTab(tab);
  sendHeight();
}
main();
})();
