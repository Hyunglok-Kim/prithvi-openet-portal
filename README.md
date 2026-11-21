# Prithvi-OpenET-Tower data portal

A web portal for 30 m monthly evapotranspiration (ET) maps made with Prithvi-OpenET-Tower, a
geospatial foundation model (Prithvi-EO-2.0) trained to reproduce OpenET from Harmonized Landsat and
Sentinel-2 reflectance and adapted to flux-tower observations. HydroAI Lab, Gwangju Institute of
Science and Technology.

**Live:** https://hyunglok-kim.github.io/prithvi-openet-portal/ — also embedded at
https://hydroai.net/data#et.

**Status: public preview.** The paper on this dataset is under review. Two regions have ready-made
maps: the Korean Peninsula and France (the mainland and Corsica), both from April 2013 onward. The
public site shows the maps down to about 120 m per pixel (a reduced copy of the browse tiles), and
at the native 30 m in nineteen small areas around the paper's flux-tower sites, eight on the Korean
Peninsula and eleven in France. The full 30 m
maps and the GeoTIFFs will be released after the paper is accepted. The model code is at
[Prithvi_OpenET_code_public](https://github.com/Hyunglok-Kim/Prithvi_OpenET_code_public).

## What it does

- Opens on the whole globe, which sweeps round and settles facing the regions with ready-made maps
  (the Korean Peninsula and France), each with its mark, sized to the map on any screen. The rest
  of the land carries a background layer from another product (MOD16A2GF, NASA), named wherever a
  value from it appears: it is context, not this model's output. A small fixed world map shows
  where our data exists; all other land can be requested.
- A region is one click away (a button over the map, the list beside it), and the cards beside the
  map — the mean, the seasonal cycle, the record — describe the region the map is on.
- Click to zoom from the overview (about 2 km per pixel) to 120 m. Where the tiles on hand reach
  it — the full set, or the sample areas of the public copy — a second click goes on to the native
  30 m. Past what is published at a place, a note at the top of the map says so.
- Three layers: mean annual ET, the mean seasonal cycle, and any single month. Months outside the
  model's 2016–2024 training period are flagged.
- Click a pixel for its monthly series, its full record, and a CSV.
- Lists the monthly GeoTIFFs of each region with checksums, and shows how to read them in Python
  and QGIS.
- Takes requests for other regions: any land area with HLS observations.
- The map needs WebGL. In a browser that does not provide it, the page says so where the map would
  be and what to do about it; the cards, the other tabs and the request form still work.

## How it works

The site is static: one HTML page, one script, no build step. The map does not show pictures of the
data. Each month is one [PMTiles](https://docs.protomaps.com/pmtiles/) file of 8-bit numeric tiles
(pixel value × step = mm of ET), read over HTTP Range requests and coloured in the browser with
[MapLibre GL JS](https://maplibre.org/). That keeps the legend adjustable and the cursor readout
exact, and it needs nothing but a file host.

```
index.html, css/, js/     the portal
assets/                   land outline (Natural Earth, public domain) and the coverage picture
pipeline/                 GeoTIFF → numeric tile pyramid + catalog (Python, GDAL); coverage picture,
                          background layer, reduced public copy
worker/                   request-form backend (Cloudflare Worker)
tests/                    headless-browser smoke test (Playwright)
```

`CLAUDE.md` has the details: the tile contract, how to build tiles, how to run and test, how to
deploy the request backend, and the rules the design must keep.

## Try it locally

You need a folder of tiles built with `pipeline/` (a `catalog.json` plus the `.pmtiles` files; a
further region sits in a folder of its own inside it).

```bash
pip install uvicorn starlette
python dev_server.py --data /path/to/tiles      # then open http://127.0.0.1:8791/?data=/data/
```

Without `?data=` the page reads the public copy of the tiles, so opening `index.html` through any
web server shows the live data.

## Credits

Map rendering: MapLibre GL JS. Tile archive format: PMTiles (Protomaps). Land outline: Natural
Earth. Satellite imagery: Esri World Imagery. Background layer outside the regions with maps:
MOD16A2GF v061 (MODIS/Terra Net Evapotranspiration, gap-filled; NASA LP DAAC,
doi:10.5067/MODIS/MOD16A2GF.061). Inputs to the maps: HLS v2.0 (NASA), MERRA-2 (NASA
GMAO), OpenET, Prithvi-EO-2.0 (IBM and NASA), FLUXNET, Copernicus GLO-30, MERIT Hydro, SoilGrids
2.0, CGIAR Global Aridity Index.

Contact: HydroAI Lab — hyunglokkim@gist.ac.kr
