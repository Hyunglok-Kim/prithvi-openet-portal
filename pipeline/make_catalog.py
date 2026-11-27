#!/usr/bin/env python3
"""Assemble catalog.json — the one file the portal reads to know what a region holds.

Combines the per-layer statistics written by build_tiles.py with the inventory of the
source GeoTIFFs (name, size, checksum, training-period flag), so the portal can show the
whole record even while only some months have browse tiles.

One catalog per region. The first region's catalog sits at the top of the tile set and is the one
the portal opens. Every other region has a folder of its own inside the set (<id>/, with its own
catalog.json, monthly/ and clim/); the first catalog lists those under "regions" and the portal
fetches them from there. Each catalog says which region it describes ("region": an id and the
names the page uses for it) and carries a coarse grid of where the region's maps have values
("mask"), so the page can tell a place with maps from a place that merely lies inside the
region's bounding box.

Needs: python3. With the GDAL bindings it reads the grid of the GeoTIFFs for the "source" block;
with numpy, Pillow and pmtiles it makes the mask. Without them those two parts are left out.
"""
import argparse
import glob
import io
import json
import math
import os
import re
import time

TRAIN = ("2016-01", "2024-12")          # months the model was trained on (paper: Jan 2016 - Dec 2024)
S30_FROM = "2015-12"                    # dataset README: Landsat only through 2015-11
TILE = 256


def source_grid(tif):
    """The grid of the GeoTIFFs in words and numbers, read from one of them. None without GDAL."""
    try:
        from osgeo import gdal, osr
    except ImportError:
        return None
    ds = gdal.Open(tif)
    srs = osr.SpatialReference(wkt=ds.GetProjection())
    epsg, gt = srs.GetAuthorityCode(None), ds.GetGeoTransform()
    return {"grid": f"EPSG:{epsg}, {abs(gt[1]):g} m, {ds.RasterXSize} x {ds.RasterYSize} px",
            "epsg": int(epsg) if epsg else None, "crs": srs.GetName(), "res_m": abs(gt[1]),
            "width": ds.RasterXSize, "height": ds.RasterYSize}


def tiles_at(rd, z):
    """(x, y, bytes) of every tile of zoom z in an open PMTiles archive, reading each directory once
    (asking for the tiles one by one walks the directories again for every tile)."""
    from pmtiles.tile import deserialize_directory, tileid_to_zxy, zxy_to_tileid
    h = rd.header()
    lo, hi = zxy_to_tileid(z, 0, 0), zxy_to_tileid(z + 1, 0, 0)

    def walk(offset, length):
        entries = deserialize_directory(rd.get_bytes(offset, length))
        for i, e in enumerate(entries):
            if e.tile_id >= hi:
                return
            if e.run_length == 0:                                   # a pointer to a leaf directory
                if i + 1 < len(entries) and entries[i + 1].tile_id <= lo:
                    continue                                        # all of that leaf lies below the zoom
                yield from walk(h["leaf_directory_offset"] + e.offset, e.length)
                continue
            if e.tile_id + e.run_length <= lo:
                continue
            data = rd.get_bytes(h["tile_data_offset"] + e.offset, e.length)
            for k in range(e.run_length):
                if lo <= e.tile_id + k < hi:
                    _, x, y = tileid_to_zxy(e.tile_id + k)
                    yield x, y, data
    yield from walk(h["root_offset"], h["root_length"])


def coverage_mask(out_dir, files, zoom, read_zoom):
    """Where the region's maps have values, as a grid of zoom-`zoom` Web-Mercator pixels (about 2 km).

    A cell is set when any pixel of the climatology layers has a value inside it at `read_zoom`
    (about 120 m), so small islands count, and the grid is then grown by one cell: a spot it calls
    empty has no map within a couple of kilometres. Stored as run lengths along the rows, first
    run empty. None when numpy, Pillow or pmtiles are missing, or there is nothing to read."""
    try:
        import numpy as np
        from PIL import Image
        from pmtiles.reader import MmapSource, Reader
    except ImportError:
        return None
    cells, zr = {}, None
    for rel in files:
        with open(os.path.join(out_dir, rel), "rb") as f:
            rd = Reader(MmapSource(f))
            h = rd.header()
            z = max(zoom, min(read_zoom, h["max_zoom"]))
            if z < h["min_zoom"] or (zr is not None and z != zr):
                continue                                            # every layer is read at the same zoom
            zr = z
            k = 2 ** (zr - zoom)
            sub = TILE // k                                         # cells of the mask along one tile of zr
            for x, y, data in tiles_at(rd, zr):
                a = (np.asarray(Image.open(io.BytesIO(data))) != 255).reshape(sub, k, sub, k).any(axis=(1, 3))
                if a.any():
                    cells[(x, y)] = cells[(x, y)] | a if (x, y) in cells else a
    if not cells:
        return None
    sub = next(iter(cells.values())).shape[0]
    xs, ys = [x for x, _ in cells], [y for _, y in cells]
    tx0, ty0 = min(xs), min(ys)
    grid = np.zeros(((max(ys) - ty0 + 1) * sub + 2, (max(xs) - tx0 + 1) * sub + 2), bool)      # one spare cell all round to grow into
    for (x, y), a in cells.items():
        grid[1 + (y - ty0) * sub:1 + (y - ty0 + 1) * sub, 1 + (x - tx0) * sub:1 + (x - tx0 + 1) * sub] = a
    pad = np.pad(grid, 1)
    grown = np.zeros_like(grid)
    for dy in range(3):
        for dx in range(3):
            grown |= pad[dy:dy + grid.shape[0], dx:dx + grid.shape[1]]
    rows, cols = np.flatnonzero(grown.any(axis=1)), np.flatnonzero(grown.any(axis=0))
    r0, r1, c0, c1 = rows[0], rows[-1] + 1, cols[0], cols[-1] + 1
    m = grown[r0:r1, c0:c1]
    flat = m.ravel().astype(np.int8)
    edges = np.flatnonzero(np.diff(flat)) + 1
    runs = np.diff(np.concatenate(([0], edges, [flat.size]))).tolist()
    if flat[0]:
        runs.insert(0, 0)                                           # the first run is always an empty one
    return {"zoom": zoom, "x0": int(tx0 * sub - 1 + c0), "y0": int(ty0 * sub - 1 + r0), "w": int(m.shape[1]), "h": int(m.shape[0]),
            "cells": int(m.sum()), "runs": runs,
            "note": f"1 = a climatology layer has a value there at zoom {zr}, grown by one cell; "
                    f"cell (i, j) is Web-Mercator pixel (x0 + i, y0 + j) of zoom {zoom}; run lengths along the rows, first run empty"}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--out-dir", required=True, help="the region's folder: holds monthly/, clim/ and the result")
    ap.add_argument("--src-root", required=True, help="dataset root with et_30m/ and SHA256SUMS")
    ap.add_argument("--version", default="", help="name of this data version (default: the existing catalog's, else today's date)")
    ap.add_argument("--catalog-id", default="prithvi-openet-tower-korea")
    ap.add_argument("--region-id", default="kp", help="short id of the region; also its folder inside the tile set")
    ap.add_argument("--region-name", default="Korean Peninsula", help="the region's name as a title")
    ap.add_argument("--region-short", default="Peninsula", help="the name on its button and in front of 'mean'")
    ap.add_argument("--region-the", default="the Korean Peninsula", help="the name inside a sentence")
    ap.add_argument("--clim-period", default="",
                    help="first,last month (YYYY-MM,YYYY-MM) that the climatology and annual layers are made of, "
                         "when that is not the training period (a region with one year of maps, say)")
    ap.add_argument("--region-kind", default="", help="'request' for a region made on someone's request")
    ap.add_argument("--mask-zoom", type=int, default=6, help="zoom of the coverage mask's cells (6 is about 2 km); -1 for none")
    a = ap.parse_args()

    sha = {}
    sums = os.path.join(a.src_root, "SHA256SUMS")
    if os.path.exists(sums):
        for line in open(sums):
            parts = line.split()
            if len(parts) == 2:
                sha[parts[1].lstrip("*").lstrip("./")] = parts[0]

    layers = {}
    for p in glob.glob(os.path.join(a.out_dir, "monthly", "*.json")) + glob.glob(os.path.join(a.out_dir, "clim", "*.json")):
        s = json.load(open(p))
        s["file"] = os.path.relpath(os.path.join(os.path.dirname(p), s["file"]), a.out_dir)
        layers[s["id"]] = s

    annual = layers.get("clim_annual")
    land_px = annual["valid_px"] if annual else max(v["valid_px"] for v in layers.values())

    def pick(s):
        # the histogram stays in the layer's sidecar .json; the portal fetches it when the layer is shown
        keep = ("id", "file", "bytes", "tiles", "units", "dn_step", "mean", "p02", "p25", "p50", "p75",
                "p98", "p99", "max", "valid_px")
        d = {k: s[k] for k in keep if k in s}
        d["cover"] = round(s["valid_px"] / land_px, 4)
        for k in ("mean", "p02", "p25", "p50", "p75", "p98", "p99", "max"):
            d[k] = round(d[k], 1)
        return d

    months = []
    tifs = sorted(glob.glob(os.path.join(a.src_root, "et_30m", "*", "*.tif")))
    for p in tifs:
        m = re.search(r"_(\d{4})(\d{2})\.tif$", p)
        if not m:
            continue
        ym = f"{m.group(1)}-{m.group(2)}"
        rel = os.path.relpath(p, a.src_root)
        rec = {"ym": ym, "cog": rel, "cog_bytes": os.path.getsize(p), "sha256": sha.get(rel, ""),
               "period": "train" if TRAIN[0] <= ym <= TRAIN[1] else "extrapolated",
               "sensors": "L30+S30" if ym >= S30_FROM else "L30"}
        s = layers.get("et_" + ym.replace("-", ""))
        if s:
            rec["tiles"] = pick(s)
            tag = s.get("src_tags", {})
            if tag.get("period_flag"):
                rec["period_tag"] = tag["period_flag"]
            if tag.get("sensors"):
                rec["sensors"] = tag["sensors"]
        months.append(rec)

    out = os.path.join(a.out_dir, "catalog.json")
    version = a.version
    if not version and os.path.exists(out):                    # the same data under a rewritten catalog keeps its name
        try:
            version = json.load(open(out)).get("version", "")
        except ValueError:
            version = ""
    # the months the climatology and the annual layer are made of, when they are not the training period
    clim_period = [x.strip() for x in a.clim_period.split(",")] if a.clim_period else None
    if clim_period and (len(clim_period) != 2 or not all(re.fullmatch(r"\d{4}-\d{2}", x) for x in clim_period)):
        raise SystemExit("--clim-period wants YYYY-MM,YYYY-MM")
    source = (source_grid(tifs[0]) if tifs else None) or {"grid": ""}
    source.update({"format": "COG, uint16, 2 bands, scale 0.1", "total_bytes": sum(r["cog_bytes"] for r in months)})
    any_layer = next(iter(layers.values()))
    cat = {
        "id": a.catalog_id,
        "region": dict({"id": a.region_id, "name": a.region_name, "short": a.region_short, "the": a.region_the},
                       **({"kind": a.region_kind} if a.region_kind else {})),
        "version": version or time.strftime("prototype-%Y-%m-%d"),
        "generated": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "encoding": {"kind": "numeric-8bit", "nodata_dn": 255,
                     "note": "tile pixel DN * dn_step = value; DN 255 = no data"},
        "zoom": {"min": any_layer["zmin"], "max": any_layer["zmax"]},
        "bounds": any_layer["bounds_lonlat"],
        "land_px": land_px,
        "record": dict({"first": months[0]["ym"], "last": months[-1]["ym"], "n": len(months),
                        "train": list(TRAIN), "with_tiles": sum(1 for r in months if "tiles" in r)},
                       **({"clim": clim_period} if clim_period else {})),
        "source": source,
        "annual": pick(annual) if annual else None,
        "clim": [dict(pick(layers[f"clim_{m:02d}"]), month=m) for m in range(1, 13) if f"clim_{m:02d}" in layers],
        "months": months,
    }
    clim_files = [v["file"] for k, v in sorted(layers.items()) if k.startswith("clim_")]
    mask = coverage_mask(a.out_dir, clim_files, a.mask_zoom, 10) if a.mask_zoom >= 0 and clim_files else None
    if mask:
        cat["mask"] = mask
    # the other regions of the tile set: each has a folder with a catalog of its own inside this one
    subs = []
    for p in sorted(glob.glob(os.path.join(a.out_dir, "*", "catalog.json"))):
        try:
            sub = json.load(open(p))
        except ValueError:
            continue
        subs.append({"id": (sub.get("region") or {}).get("id") or os.path.basename(os.path.dirname(p)),
                     "catalog": os.path.relpath(p, a.out_dir),
                     "request": (sub.get("region") or {}).get("kind") == "request"})
    # regions made on request come after the others, so that buttons and lists name the large regions first
    subs = [{"id": s_["id"], "catalog": s_["catalog"]} for s_ in sorted(subs, key=lambda s_: s_["request"])]
    if subs:
        cat["regions"] = subs
    # a background layer for the rest of the globe, if make_background.py has made one
    block = os.path.join(a.out_dir, "background", "background.json")
    if os.path.exists(block):
        cat["background"] = json.load(open(block))
    with open(out + ".part", "w") as fh:
        json.dump(cat, fh, separators=(",", ":"))
    os.replace(out + ".part", out)
    print(f"{out}: {a.region_name}, {len(months)} months ({cat['record']['with_tiles']} with tiles), "
          f"{len(cat['clim'])} climatology months, annual={'yes' if annual else 'no'}, "
          f"mask={'%d x %d cells' % (mask['w'], mask['h']) if mask else 'no'}, "
          f"other regions={[s['id'] for s in subs] or 'none'}, {os.path.getsize(out) / 1024:.0f} KB")


if __name__ == "__main__":
    main()
