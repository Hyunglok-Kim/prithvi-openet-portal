# Prithvi-OpenET-Tower Data Portal — working notes

Web portal for 30 m monthly evapotranspiration (ET) maps made with Prithvi-OpenET-Tower. It opens
on the whole globe, which turns into place facing the regions that have ready-made maps (today the
Korean Peninsula and France); the rest of the land carries a named background layer from another
global ET product. It zooms from a whole region down to the native 30 m, says at the top of the map
when the view has gone past what is published at a place, shows on a small fixed world map where
data exists, and takes requests for other regions.
`README.md` is the short introduction; this file is the detail a maintainer (human or agent) needs
before changing anything.

**Status (November 2026): public preview.** The portal is live on GitHub Pages
(https://hyunglok-kim.github.io/prithvi-openet-portal/) and embedded on https://hydroai.net/data#et.
Two regions have maps: the Korean Peninsula (since 2026-11-15) and France, the mainland and Corsica
(since 2026-11-21). The public site reads a **reduced copy** of the browse tiles — zoom 3–10, about
120 m, plus the native 30 m inside eight small areas around the paper's Korean flux-tower sites —
from tile repositories on GitHub Pages (three for the Korean Peninsula, seven for France), because
GitHub Pages cannot hold the full sets (17.6 GB and 49.8 GB) and because the full 30 m maps are
released after the paper is accepted; the full sets are served only inside the lab. A line at
the top of the page says so. The GeoTIFFs are not published. The
request backend (`worker/`) is deployed and connected. Lab-internal operations (storage paths, how
the lab hosts its own copy) are documented outside this repository.

## Layout

```
index.html          one page: Explore / Download / Use in code / About the data / Request a region
css/portal.css      warm-light theme shared with the lab's Hampyeong portal (ivory, terracotta, Source Serif 4 + Archivo)
js/config.js        deployment settings (data location, public GeoTIFF address, request email and endpoint)
js/app.js           the app (MapLibre GL + PMTiles + SVG charts), one IIFE, no build step
assets/             land-50m.json — Natural Earth land, cut at the antimeridian (public domain)
                    coverage-world.svg — the small world map in the coverage card (a generated file)
                    logos/ — the two marks in the logo strip at the bottom
pipeline/           tile and catalog builders (Python + GDAL), run where the GeoTIFFs live, one region per run;
                    make_coverage_map.py draws the coverage picture from the tiles;
                    make_background.py turns a coarse global field into the background layer;
                    make_preview_copy.py makes the reduced copy of the tiles that the public site reads,
                    preview_fine_areas.geojson names the areas that copy keeps at 30 m
worker/             request-form backend (Cloudflare Worker): src/index.js, wrangler.toml, test.mjs
tests/smoke.py      headless-browser test (Playwright); tile_ref.json holds tile checksums to compare against
dev_server.py       local preview with HTTP Range support
```

## How the data reaches the map

```
for each region: GeoTIFF per month (any CRS, uint16 x10, band 1 = ET)
  └─ pipeline/build_tiles.py      warp to Web Mercator at the top zoom, average down to the coarsest
       └─ KP_ET_YYYYMM.pmtiles + .json    one file per month: 8-bit numeric tiles + statistics
  └─ pipeline/build_clim.py       monthly means over the training years and their annual sum (native grid)
       └─ KP_ET_clim_MM.pmtiles, KP_ET_clim_annual.pmtiles
  └─ pipeline/make_catalog.py     the region's catalog.json: its layers, its record, a mask of where its maps are
a coarse global ET field from another product (optional)
  └─ pipeline/make_background.py  background/<id>_<layer>.pmtiles + the first catalog's "background" block
any static host with HTTP Range support → browser
```

## Regions

A region is one stretch of land with ready-made maps, made from one set of GeoTIFFs on one grid.
Today: `kp`, the Korean Peninsula (EPSG:5179, files `KP_…`), and `fr`, France (EPSG:2154, files
`FR_…`). Everything about a region is in **its own catalog**, and nothing in the app names one.

- **Where things are.** The first region's tiles sit at the top of the tile set (`catalog.json`,
  `monthly/`, `clim/`, and the background). Every other region has a folder inside it, named by
  its id, with the same three (`fr/catalog.json`, `fr/monthly/`, `fr/clim/`). The first catalog
  lists the others under `regions` (`[{"id": "fr", "catalog": "fr/catalog.json"}]`;
  `make_catalog.py` finds them by itself), and the app, which is pointed at the first catalog only
  (`dataBase`), fetches them from there. Addresses in a catalog are relative to that catalog. In
  the public copy the regions are in different repositories, and the list says so (see "The reduced
  public copy"). A catalog that cannot be read is left out and the page works with the rest.
- **What a catalog says about its region.** `region`: an id and three names — `name` as a title
  ("Korean Peninsula"), `short` for its button and in front of "mean" ("Peninsula"), `the` inside a
  sentence ("the Korean Peninsula"). `bounds`: the box of its grid. `mask`: a coarse grid (about
  2 km a cell, run lengths) of where its maps have values. The box of a grid takes in a good deal
  of the neighbours — the box around France holds Belgium, Switzerland and much of northern Italy —
  so whether a place "has maps" is asked of the mask (`regionAt` in `app.js`), never of the box. A
  click, the cursor readout, the notes and the cards all go by it.
- **One layer, several regions.** "The annual mean" or "July 2021" is one layer on the map and one
  choice in the controls, whatever regions hold it. A tile is put together from the regions it
  touches (`getDN` → `regionDN`); from zoom 3 on, regions that lie apart never share a tile, so
  that only matters for the few tiles of the far-out globe. The regions' tiles of one layer must
  count in the same step (`dn_step`: 1 mm/month, and 6 mm/year for the annual layer — keep
  `ANNUAL_STEP` the same for every region). A layer that one region lacks is simply empty there,
  and the cards say "no map of this layer" for that region.
- **The cards describe one region at a time.** The mean, the share of land observed, the
  histogram in the legend, the seasonal cycle, the record calendar, the Download list and the code
  examples are one region's: the region in focus (`FOCUS`). The focus follows the map — the region
  the middle of the map is on — and stays with the last one over open sea or the far-out globe.
  A visitor changes it by going there: a button over the map for every region, the same choice
  above the cards ("Region"), the "Go to" list; the lists in the Download and Code tabs change the
  focus without moving the map. `view=<id>` in the address opens on a region.
- **The globe faces all of them.** See "The opening globe".

To add a region: build its tiles and catalog (`REGION=<id>`, "Building tiles"), rebuild the first
catalog so that it lists the new one, re-make the background with one more `--hide` (it must not
show under the new maps), re-make the coverage picture with one more `--region`, make and publish
the region's reduced copy and link it from the first one, and add its place names (`CITIES`) and a
place for the code examples (`EXAMPLES`) in `app.js`. Then read the About tab: sentences about one
region carry `data-for-region` and show only when that region is there.

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
| Globe (the opening view) | ≈ 1.4 (0.9 on a phone) | 2 | ≈ 31 km |
| Overview (whole peninsula) | ≈ 4.9 | 6 | ≈ 1.9 km |
| Regional (first click) | 9.2 | 10 | ≈ 120 m |
| Native (second click) | 11.7 | 12 | ≈ 30 m |

A tile pixel of one zoom is smaller on the ground the further north it lies. In the middle of France
(46°N) zoom 10 is about 105 m and zoom 12 about 26 m, finer than the 30 m grid the maps were made
on. So the finest level of a reduced copy has a region's own name ("120 m" on the peninsula, "110 m"
in France: `finestRes(R)`), the page says "110–120 m" where it speaks of the whole site
(`finestAll()`), and at the native zoom the readout never says less than the grid's 30 m.

The page opens on the globe (next section) and stays there until the visitor moves in. A click on
the region with maps goes to the regional view and then, where the tiles on hand reach it, to the
native one. A click on land anywhere else moves in on that place in two steps (map zoom 4.6, then
about 7.5), as far as the background has anything to show; the next click there offers to request
the place.

## The opening globe

The view the page opens on is set up like the lab's HDCA portal, so the two globes are the same size
on every screen (`GLOBE` and `globeView()` in `app.js`); only the centre differs, because our maps
are elsewhere. With one region the globe faces that region (127.6°E, 30°N for the Korean Peninsula,
the view the page opened on until France was added). With several it faces the middle of them, so
that each is in sight with its mark: the longitude halfway between the westernmost and the
easternmost region, the latitude unchanged, so the globe keeps its size (`faceRegions()`). For the
Korean Peninsula and France that is 65.4°E, 30°N: Eurasia from end to end, each region about 51°
from the middle of the globe. How the page gets there (`INTRO`, `runOpening()`) is the same kind of opening as
HDCA's — a sweep from 140° to the west, growing from about half size — which the lab head asked for
on both portals ("more dynamic on entering from the data card"). One difference is deliberate:
HDCA's globe keeps turning slowly afterwards, ours comes to rest, because it has somewhere to be —
facing the region that has our maps, with the mark on it.

- **Sized to the map box.** The globe is about 140 px × 2^zoom across, so the zoom is the one for
  80 % of the box's shorter side, never more than 1.55. A fixed desktop zoom spilled the globe out
  of a phone-width map (about 350 px). The "Globe" button returns to the same view.
- **Same size as HDCA's on screen.** Those numbers hold for a globe centred on 18°N. MapLibre keeps
  the scale at the centre of a globe equal to the flat map's there, so the globe is drawn larger
  by 1/cos(latitude of its centre). Ours is centred on 30°N, so log2(cos 18° / cos 30°) = 0.135
  of zoom is taken off. Measured on screen, the two portals' globes then agree to a pixel (408 px
  in a 718 px embedded box, 295 px on a 390 px phone).
- **Beside the coverage card.** HDCA's map has no card at its top left; ours does, with the legend
  under it. In a box narrower than about 990 px a globe in the middle would run under them (half of
  it at a 1,100 px window), so it is moved right until it is just clear of the card, and where
  even that is too wide it is sized to the part of the box beside the card. The shift is MapLibre
  camera padding, which stays set for every later move; so all other camera calls go through `fly`
  (takes the padding off as it goes) and `boundsCamera` (works out a fit as if it were off).
- **The opening.** The globe comes in turning: it starts 140° to the west and 22° to the south (over
  West Africa for a globe that rests on Korea; over the Caribbean for one that rests on the middle
  of Eurasia) at half its size, and sweeps east to settle in 3.6 s, off the mark quickly and then
  slowing for a long time. As it slows the panels over the map come up one after another, then the
  marks land on the regions; the cards beside the map rise in turn from the start. The numbers are in `INTRO`; the CSS part is driven by classes on `<html>`
  (`opening`, `opened`, `arrived`, `entered`), all taken off again at the end. The coarse tiles of
  our layers for the whole globe are fetched before the turn starts, so the far side is in hand
  when it comes round. There is no fly-in to the peninsula: the turn ends on the whole globe.
- **It runs on entry wherever the globe can be seen, and otherwise waits to be seen.** Two points
  of the map decide (`whenInView`; inside the lab site's frame the browser still reports what the
  visitor really sees). If the middle of the map (`#mapMid`, the middle of the globe) is on screen
  as the page opens, the turn starts at once — also in a laptop window on the lab site, where the
  lower part of the map is still below the fold and under the site's logo strip: the visitor has
  just clicked the dataset card and should see the Earth move. If it is not (a short window), the
  turn waits until a point two thirds of the way down the map (`#mapLow`) has been scrolled into
  view, when most of the opening globe is on screen. A phone-width map (under 560 px) always waits
  for that lower point: the header fills the first screen there, the visitor scrolls at once, and
  a turn begun with a sliver of the globe in view would be over before they arrive. While it waits
  the panels are already there — an empty dark box would look broken — and only the globe and the
  mark perform (`waiting`). How tall a window must be for the turn to run on entry depends on what
  sits above the map on the lab site. Until 2026-11-17 the map started 360 px down the page and
  windows of about 720 px or more got the turn on entry. The data-use line added above the map
  that day (`.use-strip`; one line at 1512 px width or more, two lines below that) moved the
  map's middle to 770 px in wide windows, 796 px at 1366–1440 px and 834 px at 1280 px, so a
  13-inch laptop window now waits for a scroll. Anything else put above the map moves it further:
  measure on the lab site after such a change. The smoke test's laptop check takes its window
  from the page's geometry and passes either way.
- **A mark on every region** ("Available now"), shown while the globe is far out. Its label
  stands to the right of the mark — or to the left, for a region east of where the globe faces:
  towards the middle of the globe, so that it stays inside the globe and the map box when the
  region is near the edge (on a phone the two labels then sit side by side between the marks). A
  mark that has gone round the back of the globe is not shown (`opacityWhenCovered: "0"`; MapLibre
  would otherwise leave it there at a fifth of its strength).
- **Off switches.** Reduced motion, `intro=0` and `view=region` (or `view=<region id>`) open at
  rest. The visitor's first drag or scroll takes over from the turn.
- `minZoom` is 0.5, as on HDCA (a phone's globe view is below zoom 1); during the turn it is 0,
  because the turn starts further out than a visitor may go.
- **On a phone-width map** (container query, 560 px): the readout sits under the controls, because
  none of its texts fits beside the legend; the legend drops its histogram and so ends below the
  globe instead of covering it; `fitPadding()` fits the peninsula between the readout and the
  legend. The map keeps its plain height there (the adjustments for the logo strip and the notice
  apply from 761 px up), which is HDCA's height.

## The background layer

Our maps cover a few regions, so on the globe the rest of the land would be empty. The catalog can
carry a `background`: a global ET product from somewhere else, drawn under our maps on the same
colour scale. Today it is MOD16A2GF (MODIS, NASA LP DAAC; open data), the 2016–2024 mean on a 0.1°
grid, and it stands behind the annual-mean layer only.

```bash
python pipeline/make_background.py --src mod16_global_mean_monthly.npz --scale 12 \
    --id mod16a2gf --name MOD16A2GF --layer annual --units mm/year --dn-step 10 \
    --long "MODIS/Terra Net Evapotranspiration, gap-filled (MOD16A2GF v061), NASA LP DAAC" \
    --period "2016–2024" --grid "0.1°" --cell-km 11 --doi 10.5067/MODIS/MOD16A2GF.061 \
    --hide /path/to/out/clim/KP_ET_clim_annual.pmtiles --hide /path/to/out/fr/clim/FR_ET_clim_annual.pmtiles \
    --out /path/to/out --catalog
```

- `--src` is a lon/lat grid (`.npz` with `et`, `lon`, `lat`, or a GeoTIFF); `--scale 12` turns a
  mean monthly field into mm per year. Needs numpy, Pillow, pmtiles; about 20 seconds; 10.6 MB.
- The tiles follow the tile contract (zoom 0–6). Pixels off the land outline are dropped, and so
  are pixels that our own maps touch plus a margin of two pixels (`--hide`, once for every region):
  the background must never show through or beside the real thing. Across a land border that
  leaves a strip of about 5 km with neither. **When a region is added, the background is re-made
  with its annual layer hidden as well**, and it goes out together with that region's maps: an
  old background under new maps shows through their gaps, a new background without the maps
  leaves the region blank.
- The script writes `background/background.json`, the block that `make_catalog.py` puts into the
  catalog under `background` (`--catalog` writes it into an existing catalog straight away), and
  `make_preview_copy.py` carries the layer into the reduced copy. One run per layer; the block
  keeps earlier layers. Keys the app looks for: `annual`, `clim_01`…`clim_12`, `et_YYYYMM`. A layer
  without a counterpart is shown without a background — never with a stand-in.
- **It is context, not data of ours, and the page says so wherever a value from it appears**: a
  line in the legend, the product's name in front of the cursor readout ("MOD16A2GF: 680 mm/year"),
  the resolution readout ("Background, 11 km cells"), the note at the top of the map, a paragraph
  and a credit in the About tab. Clicking it gives no series. It fades as the view goes past its
  detail, so the imagery shows where there is no map.
- To use another product, run the script with another `--id`; the block starts again. Check the
  product's terms first: the layer is redistributed from a public site.

## The notes about what is published

When the view has gone past what is published at a place, a note appears at the top of the map
(`updateNote` in `app.js`):

- **outside** — zoomed in (map zoom 7.3 or more) on land without maps of ours: only the Korean
  Peninsula and France have detailed maps for now, what is on screen is the background, other
  regions are produced on request; buttons go to the nearest region and to the request form,
  filled in for the place (one region only: a button for each made the note a line taller, and it
  then covered the button of the request popup that the next click opens). "Without maps of ours" goes by the regions' masks, so the note also
  comes up in Geneva or Milan, which lie inside the box of France's grid.
- **finest** — zoomed past the finest level of a reduced copy, outside its sample areas: 120 m
  (110 m in France) is the finest level here for now, the native 30 m is shown only in the sample
  areas (a catalog's `fine.what` says what they are); buttons go to the three nearest of that
  region. A region without sample areas — France today — gets one button, to the region that has
  them.

`paperStatus` in `js/config.js` ("under review") supplies the clause "While the paper is …" and the
status in the citation. Empty it at publication. The sentences are written so that each is true as
it stands: they say what is published, not that more exists somewhere.

**The line at the top of the page.** `notice` in `js/config.js` is one sentence shown above
everything, on every tab: the paper is under review, the data will be released after it is
accepted, and what is on the page is a preview. Empty it and the line is gone. The lab's internal
copy (opened with `nas=`) does not show it: that copy is not a preview and says so itself.

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

That builds the first region. Any other is one more run with `REGION=<id>`, its settings in an
untracked `local.<id>.env` next to the script (read after `local.env`):

```bash
# local.fr.env
SRC_ROOT=/path/to/france-dataset        # holds et_30m/{YYYY}/FR_ET30m_{YYYYMM}.tif and SHA256SUMS
PREFIX=FR                               # how its files are named (default KP)
CATALOG_ARGS=(--catalog-id prithvi-openet-tower-france --region-id fr --region-name France --region-short France --region-the France)
```

```bash
REGION=fr PAR=24 THREADS=4 pipeline/run_layers.sh months 2013 2014 … 2026    # → out/fr/monthly/, logs in logs/fr/
REGION=fr PAR=13 THREADS=4 pipeline/run_layers.sh clim                       # → work/fr/clim/, out/fr/clim/, out/fr/catalog.json
pipeline/run_layers.sh catalog                                               # the first catalog again: it lists the regions
```

- One month of the Korean Peninsula (22,403 × 36,677 px) takes about 3 minutes and 12 GB of memory;
  16 at a time finished all 160 months in 36 minutes. The climatology step takes 4 minutes plus 4
  for its tiles. One month of France (38,140 × 35,466 px; 49,152 × 45,056 px on the zoom-12 grid)
  takes 5 to 19 minutes (10 on average) and up to 17 GB; all 160 months took 82 minutes, started 16 at a time
  and widened to 28, and the climatology step 22 (5 for the climatology, 17 for its tiles).
- `xargs` takes `SIGUSR1` to run one more job at a time and `SIGUSR2` for one fewer, so a run that
  turns out to have room can be widened without starting again. Send them one by one with a second
  between: signals that arrive together count as one.
- Output lands in `out/monthly/`, `out/clim/`, `out/catalog.json`; the native-grid climatology
  GeoTIFFs stay in `work/clim/`. A month's file is 19–144 MB (most are 80–135 MB). The Korean set is
  17.6 GB: 16.2 GB monthly (981,615 tiles) plus 1.4 GB for the climatology layers. The French set
  is 49.8 GB: 46.0 GB monthly (2,666,565 tiles; a month's file is 54–534 MB) plus 3.9 GB for the
  climatology layers.
- `make_catalog.py` keeps the version name of the catalog it replaces unless `--version` is given
  (the data are the same under a rewritten catalog), reads the grid of the GeoTIFFs for the
  `source` block, and makes the region's mask from its climatology layers at zoom 10: a cell is
  set when any pixel in it has a value, and the grid is grown by one cell, so that a small island
  counts and a spot the mask calls empty has no map within a couple of kilometres.
- When copying tiles to a host, copy `catalog.json` last: the app lists whatever the catalog names.

## The coverage picture

The coverage card on the map holds a small world map that is a picture, not a map: an `<img>` of
`assets/coverage-world.svg`. Land is grey, regions with ready-made data are coloured, and a region
too small to see at that size gets a ring. It answers "where does data exist?" for the whole Earth
at once, which a globe cannot do, and nothing in it reacts to the pointer.

```bash
python pipeline/make_coverage_map.py \
    --region "Korean Peninsula=/path/to/out/clim/KP_ET_clim_annual.pmtiles" \
    --region "France=/path/to/out/fr/clim/FR_ET_clim_annual.pmtiles"            # needs numpy, Pillow, pmtiles
```

- One `--region NAME=FILE` per region with data. The outline is read from the tiles (the pixels
  that hold a value, at zoom 5), so the picture shows the data's own footprint, not a box.
- Equal Earth projection (equal-area, so sizes are honest), no Antarctica (HLS does not cover it).
- After regenerating: bump the `?v=` on the `<img>` in `index.html`. Its `alt` text and the key
  under it are written by the app from the catalogs; the names given to `--region` must be the
  catalogs' region names, because the smoke test looks for them in the picture, the key and the
  header. It also checks that the first mark sits where the region is on the Earth.

## The reduced public copy

GitHub Pages serves a site of at most 1 GB and files under 100 MB; the full tile sets are 17.6 GB
and 49.8 GB, and the full 30 m maps are released after the paper is accepted, not before. Until
then the public site reads a copy cut off at zoom 10, with the native zoom kept in a few small
areas. One run per region:

```bash
python pipeline/make_preview_copy.py --src /path/to/out --out /path/to/public \
    --max-zoom 10 --volume-mb 600 --name prithvi-openet-tiles \
    --fine pipeline/preview_fine_areas.geojson \
    --link fr=../prithvi-openet-tiles-fr-1/catalog.json      # needs pmtiles, numpy, Pillow; about two minutes
python pipeline/make_preview_copy.py --src /path/to/out/fr --out /path/to/public \
    --max-zoom 10 --volume-mb 900 --name prithvi-openet-tiles-fr
```

- Tile bytes are copied untouched, so at zoom 3–10 the copy holds exactly the full set's numbers.
  Zoom 10 is about 120 m; a value there is the mean of the valid 30 m pixels in the cell.
- The Korean copy is 1.76 GB, spread over three folders of 530–630 MB. Each folder is one
  repository with Pages on: `prithvi-openet-tiles-1` (catalog, climatology, first months, the
  background layer), `-2`, `-3`. The catalog addresses the other two as
  `../prithvi-openet-tiles-2/monthly/…`, which works because the sites are neighbours on one
  host. `js/config.js` `dataBase` points at the first.
- The French copy is 4.98 GB in seven folders of 390–780 MB, `prithvi-openet-tiles-fr-1` to
  `-7` (France is two and a half times the land, and a zoom-10 tile is smaller on the ground
  at its latitude; a month is 7–48 MB). The first holds that region's catalog. The Korean
  copy's catalog lists it (`--link`: the address of the other region's catalog as seen from the
  first folder), and that is the only tie between the two copies: either can be rebuilt without
  the other. A region left without a `--link` is left out of the copy's list, so a public catalog
  never points at a catalog that is not there.
- **The order of going public matters when a region is added**: first the new region's
  repositories (nothing reads them yet), then the portal app that knows about regions (with the
  old first catalog it simply shows one region), and last the first region's new catalog and
  background, which switch the new region on. The other way round, visitors get the new
  background, which is cut out under the new region, from an app that does not yet draw it.
- The catalog of a reduced copy has `zoom.max` (10) below `zoom.native` (12). The app reads that
  pair (`fullRes()` in `app.js`) and changes every sentence that names a resolution: the badge by
  the layer buttons, the third step of the resolution pill, the readout, the hint under the map,
  "120 m cell" instead of "30 m pixel" on the series, the CSV header, the About and Code text. A
  catalog without `zoom.native` is a full set and the page then goes down to 30 m.
- **Sample areas (`--fine`).** `preview_fine_areas.geojson` holds the outlines of the areas that
  keep the native zoom: the eight Korean flux-tower sites of the paper's tower network, each the
  6.72 km input chip around one site (Cheorwon, Anmyeon, Paju, Hongcheon, Pyeongchang, Samcheok,
  Yeoju, Wando; the first two are also the Korean scenes the paper shows as maps). Its `what` is a
  few words on what the areas are, which the app puts into its sentences. For those areas, every
  layer gets a second small archive beside the first, `X.fine.pmtiles`, with the zoom 11–12 tiles
  that touch an area (7,376 tiles, 60 MB in all, about 7 MB an area). Inside an outline a tile
  holds the full set's pixels; outside it, the copy's own zoom-10 cells enlarged — so nothing
  finer than 120 m leaves the outlines. The catalog lists the areas under `fine` and each layer
  names its archive under `fine`. In the app the ET source then goes to zoom 12: tiles that touch
  an area come from the second archive, all others are made in the browser by enlarging zoom 10
  (`finerDN`), which gives the same pixels. What a value stands for depends on where it was read
  (`nativeAt`, `cellNameAt`): a 30 m pixel inside an area, a 120 m cell anywhere else. On the map
  an area is an outline with a name tag; far out, where the tags would pile up, each is a small
  square, explained by a line in the coverage card. The areas are also in the "Go to" list. Only
  the maps are shown: nothing from the tower records, and no tower positions.
- **Going to a sample area shows its pixels** (`goFine`): the tag, the "Go to" list, the note's
  buttons, a click on or just beside a square, or a click inside the outline at the regional view
  all fill the map with the area, at 3 screen pixels per native pixel or more (map zoom 12.6 to
  13.5; on a small map the area runs past the edges). At the regional view the readout over an
  area reads "120 m per pixel · zoom in for 30 m".
- Adding the sample areas, the background or a link to another region does not change the 173
  archives and their sidecars (the copy is deterministic), so a repository only gains or changes
  its small files.
- After rebuilding tiles: run the script again into the same parent folder, then commit and push
  each of the folders. Pages redeploys in a minute or two. A new folder is a new repository:
  `gh repo create <owner>/<name> --public`, push, then switch Pages on for `main`, root
  (`gh api -X POST repos/<owner>/<name>/pages -f "source[branch]=main" -f "source[path]=/"`).
- To serve the full set publicly later, put it on a host with HTTP Range and CORS (Cloudflare R2
  and Hugging Face datasets were both checked) and point `dataBase` there. Nothing else changes.

## Running it

```bash
python dev_server.py --data /path/to/tiles          # serves the tiles at /data/  (needs uvicorn + starlette)
#   → http://127.0.0.1:8791/?data=/data/            # without ?data= the page reads the public copy
python tests/smoke.py --base "http://127.0.0.1:8791/?data=/data/" --shots /tmp/shots --ref tests/tile_ref.json
python tests/smoke.py --browser webkit --base "http://127.0.0.1:8791/?data=/data/" --shots /tmp/shots-safari --ref tests/tile_ref.json
python tests/smoke.py --base https://hyunglok-kim.github.io/prithvi-openet-portal/ --shots /tmp/shots-public --ref tests/tile_ref.json
node --test worker/test.mjs
```

To preview a reduced copy before pushing it, serve its parent folder and name the first part:
`python dev_server.py --data /path/to/public` → `…/?data=/data/prithvi-openet-tiles-1/`.
The smoke test adapts to what it finds: with a full set it expects the second click to reach the
native 30 m; with a reduced copy it expects the page to say so, to stop at the finest level and to
bring up the note; with sample areas it expects 30 m there, holding the full set's numbers
(`tile_ref.json` has a window inside each area); with a background it expects every value read
from it to carry the product's name; with several regions it expects each to be named in the
header, the coverage card and its picture, to have its mark in sight on the resting globe, and,
for every region after the first, that its button fits it, the cards turn to it, a value of ours
is under the cursor, a click gives the series of the spot, the mask and not the bounding box
decides what is the region's, and the Download and Code tabs list its files and examples
(`tile_ref.json` has three tiles of France for the same byte-for-byte comparison). It also checks the opening (where the turn starts, that it
ends on the globe view with the panels and the mark in place and none of its classes left), and
in a phone-sized window that the globe fits its box, that the readout is clear of the legend, that
"Peninsula" shows the region above the legend, and that the turn waits until the map is scrolled
into view; and, in a window that ends between the two points the opening looks at, that it runs at
once without a scroll. Last, it takes WebGL away (a page whose canvases give no WebGL context) and
expects the message in the map's place with the rest of the page working, and it loses the map's
context on a running page and expects the message after a few seconds and the map back when the
context returns.

The test draws in software (Chromium with SwiftShader; Firefox does the same by itself), so it does
not depend on the machine's graphics card. Headless WebKit uses the real one: on a machine whose
graphics card is busy with other work it loses its contexts ("WebGL: context lost", the first
screen times out), and so does every other map page there. That failure is the machine, not the
page; check that another map site opens in the same browser before looking for a bug.

`python -m http.server` will not do: PMTiles needs HTTP Range requests. When a copy sits behind a
session cookie, pass it to the smoke test as `SMOKE_COOKIE="name=value"`.

URL parameters the app understands: `embed=1` (fixed map height, reports its height to the parent
frame), `hidefooter=1` (no logo strip: the page that embeds the portal draws its own),
`data=/path/` (same-origin tile location), `nas=/path` (a storage path to show in Download and
Code when there are no public links; `nas_<region id>=/path` for the regions after the first),
`intro=0` (the globe opens at rest, without the opening), `view=region` (open on the first region
instead of the globe; `view=<region id>` for any one of them),
`tab=download|code|about|request`. Bump the `?v=` on the script and style tags in `index.html`
when you change them.

## Request backend (Cloudflare Worker)

A static page cannot send mail, so the "Request a region" form needs something on the internet to
receive it. `worker/` is that: a Cloudflare Worker that checks the form and emails it to the lab
through Cloudflare Email Service. Mail to your own verified address is free on every plan. It is
deployed (November 2026) and `requestEndpoint` in `js/config.js` points at it; with that setting
empty, the form opens an email draft instead.

To set it up on an account (as it was done, on the free plan):

1. Cloudflare dashboard → Compute → Email Service → Email Routing → the domain → Destination
   addresses: add the address in `MAIL_TO` and click the link in the verification mail. Until the
   status reads Verified, every send fails with `E_RECIPIENT_NOT_ALLOWED`.
2. Same place → Settings → DNS records → Add missing records. This puts three MX records, an SPF
   and a DKIM record on the domain, and it is what allows mail from an address on that domain
   (`MAIL_FROM`). On a paid Workers plan, Email Sending → Onboard Domain is the alternative.
3. `cd worker && npm install`, `npx wrangler login` once, then `npx wrangler deploy`. The first
   Worker of an account answers over HTTPS only after a few minutes (TLS errors until then).
4. Origins that should not appear in this repository (an intranet preview, for instance) go into the
   secret `EXTRA_ORIGINS`: `npx wrangler secret put EXTRA_ORIGINS` (comma-separated). Secrets
   survive later deploys.
5. Put the address `wrangler deploy` prints into `js/config.js` as `requestEndpoint`, bump the `?v=`,
   and send one real request through the form to see the mail arrive.

To check a deployment without sending mail: a `GET` answers 405, a `POST` from an origin that is not
listed answers 403, and a `POST` with the `website` field filled answers a quiet 200.

What the Worker enforces: the mail binding can send to one address only; browsers may call it only
from `ALLOWED_ORIGINS` plus `EXTRA_ORIGINS`; five submissions a minute per network address; 8 KB at
most; a hidden `website` field and a two-second minimum fill time catch simple bots, which get a
quiet 200. The requester's address becomes the mail's reply-to. If abuse appears, add Cloudflare
Turnstile to the form and verify the token in the Worker.

## Public release (November 2026) and what is left

Done: this repository has Pages on (`main`, root) and `noindex` is gone; the reduced tile copy is
in three Pages repositories (see above); the Worker accepts the Pages origin.

**hydroai.net.** The Data page is one HTML Embed (Webflow) whose hash routing shows one panel per
dataset card. The ET panel (`#et`) holds
`<iframe data-src="https://hyunglok-kim.github.io/prithvi-openet-portal/index.html?embed=1&hidefooter=1" …>`
and a logo bar; the page's `message` listener sizes the frame from the portal's `portalHeight`
posts. To edit it again: Webflow Designer → Pages → Data → Navigator → Code Embed → "Edit code
embed". The editor is CodeMirror, so copy the text out, patch it, and paste it back.

The page has an entrance of its own (since 2026-11-16): on a click on a dataset card the panel
fades in, and the frame stays hidden behind a breathing globe mark ("Opening the portal") until
its `load` event, then fades up. That usually happens just as our opening starts, so the visitor
sees the mark, then the globe sweeping in. The frame is hidden with `opacity`, which the opening's
view check does not see: if a slow resource ever held the frame's `load` back for long, the turn
would begin unseen.

That embed is one block shared by every dataset on the page (the hub cards, the panels of the
other portals, the routing script), and other people edit it for their own panels. A copy of its
text is kept in the HDCA portal's repository (`embed/hydroai-data-page.html`). **Start every edit
from the editor's current text, never from a saved copy without comparing the two first**: a copy
made before somebody else's edit silently undoes that edit when it is pasted. It nearly happened in
November 2026 — a copy of the page taken before this panel was added would have put the old static
ET panel back. After an edit, check every card on the live page, not only your own.

**The hub card (since 2026-11-17).** On that page's hub each dataset card opens with a short
silent loop and lists key facts and what the portal offers. Ours says "30 m, monthly",
"April 2013 – August 2026, 160 monthly maps per region", "Korean Peninsula and France now; any
other land area on request" and "Paper under review. Until it is accepted the maps are shown down
to about 120 m, and at 30 m in eight sample areas". **Those words repeat this portal's own
numbers: when the record, the regions, the sample areas or the paper's status change, change the
card too** (France was added to it on 2026-11-21, the day its maps went up).

Its loop (`et-v3`, since France went up) opens on the globe with ET over all land, comes down on
France, goes across to the Korean Peninsula and into the Pyeongchang sample area at 30 m, in mean
annual ET. The loop before it (`et-v2`) went from the globe straight to the peninsula. That shape
is the lab head's word of 2026-11-17: the first version showed only our own maps on the globe
(the background layer switched off) and went into Anmyeon; "show the map with global ET laid on
it first, and Pyeongchang for the 30 m part". The loop is drawn as this portal draws it, from the public copy
of the tiles, so outside the Korean Peninsula its colours are the background layer — another
product. The card names it on the picture in its first caption ("Global background: MODIS ET
(MOD16A2GF)", shown while the globe is in view — three times in `et-v3` — and on the still
picture). Keep that caption whenever the card is re-worded or the loop re-timed: it is the rule
"the background is never passed off as ours" applied to a picture. A region's caption starts when
the region fills the frame, not while the globe with the background is still most of the picture. **In pictures of this dataset the lab head wants the global ET on the
globe, named — not the globe left bare.** The pictures and the scripts that make them are in the
HDCA portal's repository (`embed/media/`, `embed/tools/` with a README; `cap_et_v3.py` draws this
loop from a local preview of this portal on the public copy of both regions). **An old loop's
files are not ours alone to remove**: the reel on the lab site's home page plays loops from that
folder (`et-v2` until its own entry was changed), so ask the home-page session first.

For a few hours the picture also carried a credit line at its top ("Background ET: MOD16A2GF
(NASA) · Imagery © Esri, Maxar, Earthstar Geographics"), which kept the name on screen through
the whole loop. The lab head had the credit lines taken off every card that evening ("지금 모든
섹션카드 background ET: ~, imagery @Esri, 이거 지워"). So from about 3.7 to 7 s of the loop the
neighbouring countries show the background with no name on the picture, and the page no longer
credits the Esri imagery that the loops are drawn over. Both were put to the lab head, with the
option of one small line under the card grid; that is theirs to decide. Do not put text back on
the pictures without their word.

Left:
1. **The full 30 m tiles in public**, at publication. Needs a host with HTTP Range and CORS (see
   "The reduced public copy"). Then `dataBase` in `js/config.js`; the notes about the finest level
   and the sample areas go away by themselves, because a full set has neither.
2. **The GeoTIFFs.** Public address with a DOI, then `cogBase` in `js/config.js`: the Download tab
   shows direct links and the code examples use them.
3. **At publication:** empty `paperStatus` and `notice` in `js/config.js` and write the reference
   into the citation in the About tab; a licence for this repository. Also the card on
   hydroai.net/data: its Status line, and its loop if the public copy of the tiles changes (see
   "The hub card").
4. **Other regions.** The app takes any number of regions (see "Regions" for the steps). France was
   the second (2026-11-21). The buttons over the map and the resting view of the globe were laid
   out for two: with a third, look again at the room over the map (`.region-btn`, the container
   rules in `portal.css`) and at whether one view of the globe can still hold every mark.
5. **Sample areas in France.** The public copy has none there: which areas go public at 30 m is the
   lab head's decision (see the rules below), and it was asked when France went up. If they are to
   be the paper's French flux-tower sites, as in Korea, the outlines go into a `--fine` file for
   that region and its copy is rebuilt.

## Rules that must survive any redesign

- **Only model output is published as ours.** This repository and the tile store hold the model's
  maps and nothing derived from flux-tower records, which are not ours to redistribute. The one
  thing in the tile store that is not the model's is the background layer, and that is the next
  rule.
- **The background is never passed off as ours.** It is another product, shown for context, named
  wherever a value from it appears, hidden wherever our maps are, and never offered as data. The
  notes on the map say what is published; they do not suggest that maps exist where none do.
- **Ahead of the paper, 30 m only in the sample areas.** A public copy of the tiles holds nothing
  finer than zoom 10 (about 120 m; about 105 m in France) outside the outlines in
  `pipeline/preview_fine_areas.geojson` — today the paper's eight Korean flux-tower sites, and
  none in France. The sample-area tiles are built so that this is true
  pixel by pixel; keep it that way. Which areas go in is the lab head's decision, not a
  convenience.
- **Flag extrapolation.** The model was trained on 2016–2024; months outside are marked in the layer
  card, the record calendar, the pixel chart, the Download table and the CSV.
- **Never hide gaps.** A regional mean is a mean over observed pixels, so it is always shown next
  to the share of land observed. The default layer is the gap-free annual climatology.
- **A number beside the map belongs to one region, and says which.** The cards never mix regions:
  a mean, a share of land observed, a histogram and a calendar are the region in focus's, named in
  the card ("On the map · France", "France mean"). Where that region has no map of the layer on
  show the card says so; it does not fall back on another region's numbers.
- **A region is its maps, not the box around them.** What counts as "ours" at a place — for a
  click, the readout, the notes, the cards — is decided by the region's mask.
- **30 m is the grid, not the accuracy**, and regions without flux towers are unvalidated. Both
  statements stay in the About tab.
- **Never promise 30 m where the tiles on hand are coarser.** A reduced copy says what its finest
  level is, everywhere a resolution is named (`fullRes()`); a value read from it is called a cell
  mean, not a pixel.
- **Basemap without labels.** Satellite imagery plus our own city names; public label layers bring
  place-name disputes with them.
- **The globe is the main view; coverage is a fixed picture.** A flat, interactive grey world map
  was tried as the main view and rejected (November 2026). The map stays a globe, and "where data
  exists" is the small image in the coverage card.
- **The page opens on the whole globe.** The only motion of its own is the opening, which ends on
  the globe. An automatic fly-in to the peninsula was tried and dropped (November 2026): the first
  thing a visitor sees is the Earth. **Every region with maps is in sight there, with its mark.**
  (With two regions the globe therefore faces the middle of them and no longer one of them; that
  was put to the lab head when France went up.)
- **The opening leaves nothing behind.** Its classes come off `<html>` when it is done and its
  animations fill backwards only. Otherwise the cards rise again each time a tab is reopened, and a
  panel that fades for another reason (the coverage card's `.dim`) is stuck at the animation's end.
- **The opening globe is never cut by its box.** Check 390 px (a phone, embedded and on its own),
  1440 px and 2048 px or more (the lab head's display) before calling a layout change done.
- **The opening is judged where visitors meet it: on the lab site, after a click on the dataset
  card.** Look at it inside that page's frame, at a laptop height (about 800 px) as well as on a
  large screen, not only at the portal's own address in a tall window.
- **Never leave a visitor on the loading screen.** The map needs WebGL and cannot be drawn without
  it. Where the browser gives no context (`webglWorks()`), or the map fails to start, or its context
  is lost and has not come back after `LOST_WAIT`, `noMap()` puts a message where the map would be
  — what is wrong and what to do about it — and takes the loading screen away. The cards, the
  layer buttons and the other tabs go on working without the map; keep it so (`applyLayer` and the
  rest already allow for `map` being undefined, because the cards are drawn before the map is
  made).
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
- **The archives start at zoom 3 but the globe asks for less.** The opening globe (map zoom about
  1.4) already wants zoom-2 tiles. `coarserDN` averages them in the browser from zoom 3, with the
  pipeline's 25 % rule; without it the data vanishes from the globe just when the whole Earth is in
  view.
- **Report the page's own height to the embedding page, not `scrollHeight`.** Inside a frame that
  starts 3,000 px tall (hydroai.net), `scrollHeight` is never less than the frame, so the frame only
  ever grew and the page ended in a blank stretch. `sendHeight()` measures the body's box.
- **Panels over the map follow the map's width, not the window's.** In the two-column layout a
  1,100 px window leaves a 650 px map. A container query on `.mapwrap` drops the opacity slider and
  the resolution pill there, and `fitPadding()` fits the region to the right of the coverage card.
- **A full-record click costs one small request per month** (160) once each archive's directory is
  cached. If that feels slow on public hosting, build a per-pixel time-series store instead of
  reading 160 archives.
- **A button inside a map marker must stop its click.** Marker elements sit inside the map's canvas
  container, so a click on one also reaches the map as a click on that spot (`stopPropagation` in
  the sample-area tags).
- **Do not fit the map while it is hidden.** With another tab open the map is 0 px wide and
  `fitBounds` gives nonsense; `view=region` waits until the Explore tab is shown.
- **The land outline runs out to sea.** Natural Earth 1:50m is generalised, by up to a few km on
  the Korean east coast. Masking the background with it alone left a coloured fringe along our own
  coast, hence the margin around our maps in `make_background.py`.
- **A 30 m area looked like 120 m.** Landing on an area at map zoom 11.7 puts 1.6 screen pixels
  on each native pixel. At that size the pixel grid cannot be seen and the thin features (field
  edges, roads, streams) are a pixel or two wide, so the area was hard to tell from the 120 m
  cells around it, on a large high-density screen most of all. The tiles were right (they were
  compared with the native grid); the view was too far out. Hence `goFine` goes in to at least
  3 screen pixels per native pixel.
- **The globe's size on screen depends on where it is centred.** At the same zoom a globe centred
  on 30°N is 1.1 times as wide as one centred on 18°N (1/cos of the centre's latitude). Copying
  another portal's zoom is not copying its size; `globeView()` corrects for it.
- **Camera padding stays set.** `easeTo`/`flyTo`/`jumpTo` with `padding` move the globe sideways,
  and MapLibre keeps that padding for every later move; `cameraForBounds` adds it to the padding it
  is given. Hence `fly` and `boundsCamera`. Without them the peninsula fit and the 30 m areas come
  out off-centre after a visit to the globe view on a narrower window.
- **A transition beats an animation.** The coverage card has `transition: opacity` for its `.dim`.
  When the class that hid it during the opening came off, that transition ran first and the
  animation then took over from a lower opacity: a flicker. `transition: none` while it rises.
- **"The site does not open."** In November 2026 the page stayed on "Loading the catalog…" in the
  lab head's Chrome, the day after a change, and it looked as if the change had broken it. The
  servers and the page were fine. Chrome's graphics process had been killed three times in a few
  minutes the evening before (the machine's graphics card was overloaded), after which Chrome
  keeps graphics acceleration off until it is restarted — and current Chrome does not draw WebGL in
  software instead. `new maplibregl.Map` then throws, and the loading screen was only ever taken
  away by the map's `load` event. Hence the check before the map is made and the message. To tell
  this case from a broken site: in the browser that fails,
  `document.createElement("canvas").getContext("webgl")` is `null`, while a fresh browser opens
  the page.
- **The opening did not run on a laptop.** It first waited for a point two thirds of the way down
  the map to be on screen. At the portal's own address that is always so; inside the lab site's
  frame the map starts 360 px down the page, and in a window under about 800 px tall the page
  just sat there with a small still globe until the visitor scrolled. Hence the two points: the
  middle of the map decides on entry, the lower point only after a wait.
- **A click from the globe went straight into a 30 m area.** "A click beside a square is meant for
  the area" applied below zoom 4.2 too, where the squares are not shown and the whole peninsula is
  a few pixels wide. It applies only where the squares are on screen.
- **`tileZoom()` is capped at the source's top zoom, not the copy's.** With sample areas the source
  goes to zoom 12 while most of the map is zoom-10 cells enlarged; what the numbers stand for at a
  place is `topZoomAt()`, and every label asks that.

- **A box is not a region.** The first build treated a place as "ours" when it lay inside the
  bounding box of the grid. For the Korean Peninsula the box holds a little of China and Russia
  and nobody noticed; the box of France's grid holds Belgium, Switzerland, half of northern Italy
  and Catalonia, where the page would have kept quiet about showing the background. Hence the
  mask in the catalog and `regionAt`.
- **`setTiles` with the same address still reloads the tiles.** The map blinks. When only the
  region in focus changes, the layer on the map is the same; `applyLayer` and `syncBackground`
  remember what the sources were last given and leave them alone unless it changed (it does when
  the colour scale is stretched to the region's own range).
- **The cards must not follow the map while it is on its way somewhere.** A flight from one region
  to another starts over the old one, and the opening turn passes over whatever lies on its way;
  with the cards following every frame they flipped back and forth. `flyingTo` and `introRunning`
  hold them until the move is over (or the visitor takes the map).
- **Asking a PMTiles archive for tiles one by one is slow in Python.** `Reader.get` walks the
  directories again for every tile: the first mask builder took three minutes for the peninsula.
  `tiles_at` in `make_catalog.py` walks them once (2.5 s).
- **A marker behind the globe is still drawn**, at a fifth of its strength, unless it is made with
  `opacityWhenCovered: "0"`. With one region facing the visitor nobody saw it; with two, turning
  the globe leaves the other's mark hanging in space.
- **A button per region needs room.** Two region buttons, the "Go to" list, "Globe" and the
  opacity slider are 505 px wide; the coverage card ends 284 px from the left. Container rules
  drop the slider below an 850 px map and the region buttons below 700 px, where the "Go to"
  list (which starts with the regions) and the choice above the cards do their work.
- **A wide region runs under the coverage card.** Fitting France in the middle of the map put
  Brittany behind the card. `fitRegion` fits a region beside the card when it would otherwise
  reach under it; a narrow one (the peninsula) stays in the middle as before.

## Not done yet

- Province and county means (click a region for its series without reading pixels).
- The between-fold spread (band 2) as a selectable layer.
- Favicon, Korean UI text, and a dark theme.
