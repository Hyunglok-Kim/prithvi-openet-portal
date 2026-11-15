# Prithvi-OpenET-Tower Data Portal — working notes

Web portal for 30 m monthly evapotranspiration (ET) maps made with Prithvi-OpenET-Tower. It opens
on a globe turned to the region that has ready-made data, zooms from a whole region down to the
native 30 m, shows on a small fixed world map where data exists, and takes requests for other
regions. `README.md` is the short introduction; this file is the detail a maintainer (human or
agent) needs before changing anything.

**Status (November 2026): prototype.** The site is not served publicly yet and the tiles and
GeoTIFFs are not published. Lab-internal operations (storage paths, how the lab hosts its preview
copy) are documented outside this repository.

## Layout

```
index.html          one page: Explore / Download / Use in code / About the data / Request a region
css/portal.css      warm-light theme shared with the lab's Hampyeong portal (ivory, terracotta, Source Serif 4 + Archivo)
js/config.js        deployment settings (data location, public GeoTIFF address, request email and endpoint)
js/app.js           the app (MapLibre GL + PMTiles + SVG charts), one IIFE, no build step
assets/             land-50m.json — Natural Earth land, cut at the antimeridian (public domain)
                    coverage-world.svg — the small world map in the coverage card (a generated file)
pipeline/           tile and catalog builders (Python + GDAL), run where the GeoTIFFs live;
                    make_coverage_map.py draws the coverage picture from the tiles
worker/             request-form backend (Cloudflare Worker): src/index.js, wrangler.toml, test.mjs
tests/smoke.py      headless-browser test (Playwright); tile_ref.json holds tile checksums to compare against
dev_server.py       local preview with HTTP Range support
```

## How the data reaches the map

```
GeoTIFF per month (any CRS, uint16 x10, band 1 = ET)
  └─ pipeline/build_tiles.py      warp to Web Mercator at the top zoom, average down to the coarsest
       └─ KP_ET_YYYYMM.pmtiles + .json    one file per month: 8-bit numeric tiles + statistics
  └─ pipeline/build_clim.py       monthly means over the training years and their annual sum (native grid)
       └─ KP_ET_clim_MM.pmtiles, KP_ET_clim_annual.pmtiles
  └─ pipeline/make_catalog.py     catalog.json — the one file the app reads first
any static host with HTTP Range support → browser
```

**Tile contract.** A tile is a 256 px 8-bit grayscale PNG holding values, not colours:
`value = DN × dn_step`, `DN 255 = no data`. `dn_step` is 1 mm/month for monthly and climatology
layers and 6 mm/year for the annual layer. The browser colours tiles itself (`etn://` protocol in
`app.js`), so the legend range can change and the cursor readout is exact to one step. Coarser
zooms are area means of the valid top-zoom pixels; a coarse pixel is kept only when at least 25 %
of it has data, so cloud gaps stay visible when zoomed out.

**Statistics come from the native grid**, not from the tiles. Web Mercator has more pixels per km²
toward the north, so a mean over tile pixels leans north (for the Korean annual layer it gave 767.5
instead of 772.4 mm/year). `build_tiles.py` reads the source band's histogram for the mean,
percentiles and the valid-pixel count. Keep it that way.

Zoom levels and what they mean on screen (MapLibre rounds the zoom for raster sources and 256 px
tiles sit one level ahead):

| Stage | Map zoom | Tile zoom | Ground size at 37°N |
|---|---|---|---|
| Overview (whole peninsula) | ≈ 4.9 | 6 | ≈ 1.9 km |
| Regional (first click) | 9.2 | 10 | ≈ 120 m |
| Native (second click) | 11.7 | 12 | ≈ 30 m |

## Building tiles

Needs Python 3 with NumPy, Pillow, the GDAL bindings (`osgeo`) and `pip install pmtiles`.

```bash
export ROOT=/path/to/workdir            # gets out/, work/, logs/; expects venv/bin/python inside
export SRC_ROOT=/path/to/dataset        # holds et_30m/{YYYY}/KP_ET30m_{YYYYMM}.tif and SHA256SUMS
PAR=16 THREADS=4 pipeline/run_layers.sh months 2013 2014 … 2026    # monthly tiles, any subset of years
PAR=13 THREADS=4 pipeline/run_layers.sh clim                       # climatology + annual, then their tiles
pipeline/run_layers.sh catalog                                     # only rebuild catalog.json
```

`ROOT` and `SRC_ROOT` can also sit in an untracked `local.env` next to `run_layers.sh`.

- One month of the Korean Peninsula (22,403 × 36,677 px) takes about 3 minutes and 12 GB of memory;
  16 at a time finished all 160 months in 36 minutes. The climatology step takes 4 minutes plus 4
  for its tiles.
- Output lands in `out/monthly/`, `out/clim/`, `out/catalog.json`; the native-grid climatology
  GeoTIFFs stay in `work/clim/`. A month's file is 19–144 MB (most are 80–135 MB). The Korean set is
  17.6 GB: 16.2 GB monthly (981,615 tiles) plus 1.4 GB for the climatology layers.
- When copying tiles to a host, copy `catalog.json` last: the app lists whatever the catalog names.

## The coverage picture

The coverage card on the map holds a small world map that is a picture, not a map: an `<img>` of
`assets/coverage-world.svg`. Land is grey, regions with ready-made data are coloured, and a region
too small to see at that size gets a ring. It answers "where does data exist?" for the whole Earth
at once, which a globe cannot do, and nothing in it reacts to the pointer.

```bash
python pipeline/make_coverage_map.py \
    --region "Korean Peninsula=/path/to/out/clim/KP_ET_clim_annual.pmtiles"     # needs numpy, Pillow, pmtiles
```

- One `--region NAME=FILE` per region with data. The outline is read from the tiles (the pixels
  that hold a value, at zoom 5), so the picture shows the data's own footprint, not a box.
- Equal Earth projection (equal-area, so sizes are honest), no Antarctica (HLS does not cover it).
- After regenerating: bump the `?v=` on the `<img>` in `index.html`, and update its `alt` text and
  the key under it if the list of regions changed. The smoke test checks that the mark sits where
  the region is on the Earth.

## Running it

```bash
python dev_server.py --data /path/to/tiles          # http://127.0.0.1:8791/  (needs uvicorn + starlette)
python tests/smoke.py --base http://127.0.0.1:8791/ --shots /tmp/shots --ref tests/tile_ref.json
python tests/smoke.py --browser webkit --base http://127.0.0.1:8791/ --shots /tmp/shots-safari --ref tests/tile_ref.json
node --test worker/test.mjs
```

`python -m http.server` will not do: PMTiles needs HTTP Range requests. When a copy sits behind a
session cookie, pass it to the smoke test as `SMOKE_COOKIE="name=value"`.

URL parameters the app understands: `embed=1` (fixed map height, reports its height to the parent
frame), `data=/path/` (same-origin tile location), `nas=/path` (a storage path to show in Download
and Code when there are no public links), `intro=0` (skip the fly-in from the globe),
`tab=download|code|about|request`. Bump the `?v=` on the script and style tags in `index.html` when
you change them.

## Request backend (Cloudflare Worker)

A static page cannot send mail, so the "Request a region" form needs something on the internet to
receive it. `worker/` is that: a Cloudflare Worker that checks the form and emails it to the lab
through Cloudflare Email Service. Mail to your own verified address is free on every plan. Until
`requestEndpoint` is filled in (`js/config.js`), the form opens an email draft instead.

To turn it on:

1. Cloudflare dashboard → Compute → Email Service → Email Routing → Destination addresses: add the
   address in `MAIL_TO` and click the link in the verification mail.
2. Onboard the sending domain (Email Routing, or Email Sending on a paid plan) so mail from
   `MAIL_FROM` is accepted.
3. `cd worker && npx wrangler login`, then `npx wrangler deploy`.
4. Origins that should not appear in this repository (an intranet preview, for instance) go into the
   secret `EXTRA_ORIGINS`: `npx wrangler secret put EXTRA_ORIGINS` (comma-separated).
5. Put the address `wrangler deploy` prints into `js/config.js` as `requestEndpoint`, bump the `?v=`,
   and send one real request to see the mail arrive.

What the Worker enforces: the mail binding can send to one address only; browsers may call it only
from `ALLOWED_ORIGINS` plus `EXTRA_ORIGINS`; five submissions a minute per network address; 8 KB at
most; a hidden `website` field and a two-second minimum fill time catch simple bots, which get a
quiet 200. The requester's address becomes the mail's reply-to. If abuse appears, add Cloudflare
Turnstile to the form and verify the token in the Worker.

## Going public

1. Put the tiles and the GeoTIFFs somewhere public with HTTP Range and CORS for `GET` (an object
   store such as Cloudflare R2 has no egress fee). Archive the GeoTIFFs with a DOI as well.
2. In `js/config.js` set `dataBase` to the tile address and `cogBase` to the GeoTIFF address. The
   Download tab then shows direct links and the code examples use them.
3. Enable GitHub Pages for this repository (the tiles do not go in the repo; Pages has a 1 GB limit).
4. Embed it the way the Hampyeong portal is embedded:
   `<iframe src="https://<pages address>/index.html?embed=1" width="100%" height="1500" style="border:0"></iframe>`.
   The app posts `{type: "portalHeight", height}` to its parent for auto-height.
5. Remove `<meta name="robots" content="noindex">` from `index.html`, update the citation in the
   About tab, and add the Pages origin to the Worker's `ALLOWED_ORIGINS`.

## Rules that must survive any redesign

- **Only model output.** This repository and the tile store hold the model's maps and nothing
  derived from flux-tower records, which are not ours to redistribute.
- **Flag extrapolation.** The model was trained on 2016–2024; months outside are marked in the layer
  card, the record calendar, the pixel chart, the Download table and the CSV.
- **Never hide gaps.** A regional mean is a mean over observed pixels, so it is always shown next
  to the share of land observed. The default layer is the gap-free annual climatology.
- **30 m is the grid, not the accuracy**, and regions without flux towers are unvalidated. Both
  statements stay in the About tab.
- **Basemap without labels.** Satellite imagery plus our own city names; public label layers bring
  place-name disputes with them.
- **The globe is the main view; coverage is a fixed picture.** A flat, interactive grey world map
  was tried as the main view and rejected (November 2026). The map stays a globe, and "where data
  exists" is the small image in the coverage card.
- **The request endpoint is never taken from the page address.** A link must not be able to
  redirect what people type; it is set in `js/config.js` only.

## Gotchas already paid for

- **Never read tile values back from a canvas.** Safari colour-manages canvas pixels and returned
  values off by one (the tile sums were 0.1 % low) even with `colorSpaceConversion: "none"`. The
  app inflates the PNG itself (`DecompressionStream`) and undoes the row filters (`decodePNG8`);
  the canvas path remains only as a fallback for old browsers. The smoke test compares three
  tiles byte for byte against the pipeline's numbers (`--ref`) — run it with `--browser webkit` too.
- **Raster tile zoom is rounded**, not floored (`RasterTileSource.roundZoom`). Anything that
  guesses which tile is on screen (cursor readout, resolution label) must use
  `Math.round(map.getZoom() + 1)` for 256 px tiles.
- **Land outlines must be cut at the antimeridian.** The usual `world-atlas` TopoJSON is stitched
  for d3 and draws rings around the pole in MapLibre. The files in `assets/` are the planar-safe ones.
- **MapLibre rewrites a marker element's own opacity on the globe.** Fade an inner element instead.
- **Never set `position` on a marker's root element.** MapLibre makes it absolute; overriding that
  turns the marker into a full-width block whose "centre" is half the map away.
- **`form.name` is the form's own property.** Read fields with `form.elements.namedItem("name")`.
- **The archives start at zoom 3 but the globe asks for less.** Zoomed all the way out the map wants
  zoom-2 tiles. `coarserDN` averages them in the browser from zoom 3, with the pipeline's 25 % rule;
  without it the data vanishes from the globe just when the whole Earth is in view.
- **Panels over the map follow the map's width, not the window's.** In the two-column layout a
  1,100 px window leaves a 650 px map. A container query on `.mapwrap` drops the opacity slider and
  the resolution pill there, and `fitPadding()` fits the region to the right of the coverage card.
- **A full-record click costs one small request per month** (160) once each archive's directory is
  cached. If that feels slow on public hosting, build a per-pixel time-series store instead of
  reading 160 archives.

## Not done yet

- Province and county means (click a region for its series without reading pixels).
- The between-fold spread (band 2) as a selectable layer.
- Favicon, Korean UI text, and a dark theme.
