# Prithvi-OpenET-Tower data portal

A web portal for 30 m monthly evapotranspiration (ET) maps made with Prithvi-OpenET-Tower, a
geospatial foundation model (Prithvi-EO-2.0) trained to reproduce OpenET from Harmonized Landsat and
Sentinel-2 reflectance and adapted to flux-tower observations. HydroAI Lab, Gwangju Institute of
Science and Technology.

**Live:** https://hyunglok-kim.github.io/prithvi-openet-portal/ — also embedded at
https://hydroai.net/data#et.

**Status: public preview.** The public site shows the maps down to about 120 m per pixel (a reduced
copy of the browse tiles; GitHub Pages cannot hold the full set). The 30 m GeoTIFFs will be
released with the paper. The model code is at
[Prithvi_OpenET_code_public](https://github.com/Hyunglok-Kim/Prithvi_OpenET_code_public).

## What it does

- Opens on a globe turned to the region with ready-made maps (the Korean Peninsula, April 2013
  onward). A small fixed world map beside it shows where data exists; all other land is grey and
  can be requested.
- Click to zoom from the overview (about 2 km per pixel) to 120 m. Where the full tile set is
  served, a second click goes on to the native 30 m.
- Three layers: mean annual ET, the mean seasonal cycle, and any single month. Months outside the
  model's 2016–2024 training period are flagged.
- Click a pixel for its monthly series, its full record, and a CSV.
- Lists the monthly GeoTIFFs with checksums, and shows how to read them in Python and QGIS.
- Takes requests for other regions: any land area with HLS observations.

## How it works

The site is static: one HTML page, one script, no build step. The map does not show pictures of the
data. Each month is one [PMTiles](https://docs.protomaps.com/pmtiles/) file of 8-bit numeric tiles
(pixel value × step = mm of ET), read over HTTP Range requests and coloured in the browser with
[MapLibre GL JS](https://maplibre.org/). That keeps the legend adjustable and the cursor readout
exact, and it needs nothing but a file host.

```
index.html, css/, js/     the portal
assets/                   land outline (Natural Earth, public domain) and the coverage picture
pipeline/                 GeoTIFF → numeric tile pyramid + catalog (Python, GDAL); coverage picture
worker/                   request-form backend (Cloudflare Worker)
tests/                    headless-browser smoke test (Playwright)
```

`CLAUDE.md` has the details: the tile contract, how to build tiles, how to run and test, how to
deploy the request backend, and the rules the design must keep.

## Try it locally

You need a folder of tiles built with `pipeline/` (a `catalog.json` plus the `.pmtiles` files).

```bash
pip install uvicorn starlette
python dev_server.py --data /path/to/tiles      # then open http://127.0.0.1:8791/?data=/data/
```

Without `?data=` the page reads the public copy of the tiles, so opening `index.html` through any
web server shows the live data.

## Credits

Map rendering: MapLibre GL JS. Tile archive format: PMTiles (Protomaps). Land outline: Natural
Earth. Background imagery: Esri World Imagery. Inputs to the maps: HLS v2.0 (NASA), MERRA-2 (NASA
GMAO), OpenET, Prithvi-EO-2.0 (IBM and NASA), FLUXNET, Copernicus GLO-30, MERIT Hydro, SoilGrids
2.0, CGIAR Global Aridity Index.

Contact: HydroAI Lab — hyunglokkim@gist.ac.kr
