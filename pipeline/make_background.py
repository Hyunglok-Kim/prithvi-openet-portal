#!/usr/bin/env python3
"""A coarse global field -> the portal's background layer: numeric tiles and a catalog block.

    python pipeline/make_background.py --src mod16_global_mean_monthly.npz --scale 12 \\
        --id mod16a2gf --name MOD16A2GF --layer annual --units mm/year --dn-step 10 \\
        --long "MODIS/Terra Net Evapotranspiration, gap-filled (MOD16A2GF v061), NASA LP DAAC" \\
        --period 2016-2024 --grid "0.1 degree" --cell-km 11 --doi 10.5067/MODIS/MOD16A2GF.061 \\
        --hide /path/to/out/clim/KP_ET_clim_annual.pmtiles --out /path/to/out --catalog

The portal's own maps cover one region. On the globe, the rest of the land can carry a global ET
product from somewhere else, so the visitor sees evapotranspiration everywhere and the region with
our maps in its place. That layer is context and nothing more: it is not this model's output, and
the page names it wherever it shows a value from it.

What this writes into --out:
  background/<id>_<layer>.pmtiles   numeric tiles like every other layer (value = DN x dn_step,
                                    DN 255 = no data), Web Mercator, zoom 0 to --zmax
  background/background.json        the block the catalog carries under "background"
and, with --catalog, the same block into --out/catalog.json (make_catalog.py also picks it up).

How the tiles are made
  1. The field is sampled at the pixel centres of --zmax (bilinear; a pixel has a value only when
     the grid cell it falls in has one, so values never spread into empty cells).
  2. Pixels off the land outline (--land) are dropped: a coarse cell on a coast would otherwise
     paint the sea.
  3. Our own maps (--hide, one or more PMTiles files) cut the background out under them. Near the
     sea (within three pixels of the land outline's sea) and inside the box of a region's grid, a
     pixel goes as soon as our maps touch it, and so do two more pixels around it: the outline is a
     generalised one, a coarse background cell reaches a few km out to sea, and it must not paint a
     fringe beside our coasts. On land a pixel
     goes only when our maps cover it whole, or when it lies in a hole they enclose (a lake, a cloud
     gap): across a land border or the inland edge of a box the background then reaches our maps,
     which are drawn over it. (Until 2026-11-28 the near-sea rule held everywhere, which left a strip
     of about 5 km with neither along every land border: a frame around the Carmel River box.)
  4. Coarser levels are area means, kept where a quarter of the pixel has data (the tile
     pipeline's rule).

Run it once per layer; the block keeps the layers of earlier runs. Layer keys the portal looks
for: "annual", "clim_01" ... "clim_12", "et_YYYYMM".

Needs: python3, numpy, Pillow, pmtiles (pip); rasterio only when --src is a GeoTIFF.
"""
import argparse
import io
import json
import math
import os
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from pmtiles.reader import MmapSource, Reader
from pmtiles.tile import Compression, TileType, zxy_to_tileid
from pmtiles.writer import Writer

TILE = 256
NODATA_DN = 255
MIN_COVER = 0.25
STRIP = 1024                     # rows of the top level handled at a time
Image.MAX_IMAGE_PIXELS = None    # the land mask is one large image


def log(msg):
    print(time.strftime("%H:%M:%S"), msg, flush=True)


def load_field(path):
    """(values, lon of column centres, lat of row centres), rows from north to south, NaN = no data."""
    if path.endswith(".npz"):
        d = np.load(path)
        key = "et" if "et" in d.files else next(k for k in d.files if d[k].ndim == 2)
        v, lon, lat = d[key].astype(np.float32), d["lon"].astype(np.float64), d["lat"].astype(np.float64)
    else:
        import rasterio
        with rasterio.open(path) as src:
            if src.crs and src.crs.to_epsg() != 4326:
                sys.exit("--src must be on a longitude/latitude grid (EPSG:4326)")
            v, tr = src.read(1).astype(np.float32), src.transform
            if src.nodata is not None:
                v[v == src.nodata] = np.nan
            lon = tr.c + tr.a * (np.arange(src.width) + 0.5)
            lat = tr.f + tr.e * (np.arange(src.height) + 0.5)
    if lat[0] < lat[-1]:
        v, lat = v[::-1], lat[::-1]
    dlon = (lon[-1] - lon[0]) / (lon.size - 1)
    if lon[-1] - lon[0] >= 360 - dlon / 2:            # a column repeated across the antimeridian
        keep = int(round(360 / dlon))
        v, lon = v[:, :keep], lon[:keep]
    return np.ascontiguousarray(v), lon, lat


def sample(v, lon, lat, lons, lats):
    """Bilinear sample of v at every (lat, lon) pair of the two 1-D arrays. NaN where the nearest
    cell is empty or the point lies outside the grid."""
    ny, nx = v.shape
    dlon, dlat = (lon[-1] - lon[0]) / (nx - 1), (lat[-1] - lat[0]) / (ny - 1)
    wrap = abs(nx * dlon - 360) < dlon / 2
    fx, fy = (lons - lon[0]) / dlon, (lats - lat[0]) / dlat
    x0, y0 = np.floor(fx).astype(np.int64), np.floor(fy).astype(np.int64)
    tx, ty = (fx - x0).astype(np.float32), (fy - y0).astype(np.float32)

    def col(i):
        return i % nx if wrap else np.clip(i, 0, nx - 1)

    def row(j):
        return np.clip(j, 0, ny - 1)

    num = np.zeros((lats.size, lons.size), np.float32)
    den = np.zeros_like(num)
    for jj, wy in ((row(y0), 1 - ty), (row(y0 + 1), ty)):
        for ii, wx in ((col(x0), 1 - tx), (col(x0 + 1), tx)):
            vv = v[np.ix_(jj, ii)]
            ok = np.isfinite(vv)
            w = np.outer(wy, wx)
            num += np.where(ok, vv, 0) * w
            den += ok * w
    near = v[np.ix_(row(np.rint(fy).astype(np.int64)), col(np.rint(fx).astype(np.int64)))]
    inside = ((fy >= -0.5) & (fy <= ny - 0.5))[:, None] & (np.ones(lons.size, bool) if wrap else (fx >= -0.5) & (fx <= nx - 0.5))[None, :]
    ok = np.isfinite(near) & (den > 0) & inside
    out = np.full(num.shape, np.nan, np.float32)
    out[ok] = num[ok] / den[ok]
    return out


def land_mask(path, n):
    """n x n image of the Web-Mercator world, 1 on land. Outlines must be cut at the antimeridian."""
    def xy(ring):
        out = []
        for lo, la in ring:
            la = max(-85.0511, min(85.0511, la))
            out.append(((lo + 180) / 360 * n, (1 - math.asinh(math.tan(math.radians(la))) / math.pi) / 2 * n))
        return out

    img = Image.new("L", (n, n), 0)
    draw = ImageDraw.Draw(img)
    for f in json.loads(Path(path).read_text())["features"]:
        g = f["geometry"]
        for poly in ([g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]):
            if len(poly[0]) >= 3:
                draw.polygon(xy(poly[0]), fill=1)
            for hole in poly[1:]:
                if len(hole) >= 3:
                    draw.polygon(xy(hole), fill=0)
    return np.asarray(img, np.uint8)


def grow(m, r):
    """m with every True pixel grown by r pixels (a square of 2r+1), on a window around the True part."""
    if not r or not m.any():
        return m.copy()
    rows, cols = np.flatnonzero(m.any(axis=1)), np.flatnonzero(m.any(axis=0))
    r0, r1 = max(0, rows[0] - r), min(m.shape[0], rows[-1] + 1 + r)
    c0, c1 = max(0, cols[0] - r), min(m.shape[1], cols[-1] + 1 + r)
    win = m[r0:r1, c0:c1]
    pad = np.pad(win, r)
    grown = np.zeros_like(win)
    for dy in range(2 * r + 1):
        for dx in range(2 * r + 1):
            grown |= pad[dy:dy + win.shape[0], dx:dx + win.shape[1]]
    out = m.copy()
    out[r0:r1, c0:c1] = grown
    return out


def fill_holes(m):
    """m plus every pixel not in m that cannot reach the edge of m's box through pixels not in m
    (4-connected): the holes m encloses. numpy only (no scipy on the server)."""
    if not m.any():
        return m.copy()
    rows, cols = np.flatnonzero(m.any(axis=1)), np.flatnonzero(m.any(axis=0))
    r0, r1, c0, c1 = rows[0], rows[-1] + 1, cols[0], cols[-1] + 1
    win = np.pad(m[r0:r1, c0:c1], 1)                       # a free ring all round: the outside starts there
    free = ~win
    out = np.zeros_like(win)
    out[0, :] = out[-1, :] = True
    out[:, 0] = out[:, -1] = True
    out &= free
    while True:
        nxt = out.copy()
        nxt[1:, :] |= out[:-1, :]
        nxt[:-1, :] |= out[1:, :]
        nxt[:, 1:] |= out[:, :-1]
        nxt[:, :-1] |= out[:, 1:]
        nxt &= free
        if (nxt == out).all():
            break
        out = nxt
    res = m.copy()
    res[r0:r1, c0:c1] = ~out[1:-1, 1:-1]
    return res


def product_mask(paths, z, n, land, finer=2, margin=2, sea_px=3):
    """Pixels of zoom z where the background must not show, for our maps in `paths` (see step 3 of the
    module's notes). The archives are read `finer` levels below z: a pixel is touched when any part of
    it has a value and covered when every part has one. One region (archive) at a time: its holes are
    its own, and the margin near the sea stays inside the box of its grid (the archive's bounds), since
    a fringe can only lie beside its own coast; outside the box the background is as anywhere else."""
    hide = np.zeros((n, n), bool)
    for p in paths:
        with open(p, "rb") as f:
            rd = Reader(MmapSource(f))
            h = rd.header()
            if not h["min_zoom"] <= z <= h["max_zoom"]:
                sys.exit(f"--hide {p}: no tiles at zoom {z} (it has {h['min_zoom']}-{h['max_zoom']})")
            zr = min(z + finer, h["max_zoom"])
            k = 2 ** (zr - z)                                      # tiles of zr per tile of z, and px per px

            def fx(lon_e7):                                        # 0..1 across the world, west to east
                return (lon_e7 / 1e7 + 180) / 360

            def fy(lat_e7):                                        # 0..1 down the world, north to south
                la = math.radians(max(-85.0511, min(85.0511, lat_e7 / 1e7)))
                return (1 - math.asinh(math.tan(la)) / math.pi) / 2

            hi, sub = 2 ** zr - 1, TILE // k                       # tiles of zr, and pixels of z per tile of zr
            ty0, ty1 = max(0, int(fy(h["max_lat_e7"]) * 2 ** zr)), min(hi, int(fy(h["min_lat_e7"]) * 2 ** zr))
            tx0, tx1 = max(0, int(fx(h["min_lon_e7"]) * 2 ** zr)), min(hi, int(fx(h["max_lon_e7"]) * 2 ** zr))
            # the window: those tiles, with room for the margin round them; and the box of the region's grid in it
            pad = margin + sea_px + 1
            r0, r1, c0, c1 = max(0, ty0 * sub - pad), min(n, (ty1 + 1) * sub + pad), max(0, tx0 * sub - pad), min(n, (tx1 + 1) * sub + pad)
            by0, by1 = int(fy(h["max_lat_e7"]) * n), int(fy(h["min_lat_e7"]) * n)
            bx0, bx1 = int(fx(h["min_lon_e7"]) * n), int(fx(h["max_lon_e7"]) * n)
            touched = np.zeros((r1 - r0, c1 - c0), bool)
            covered = np.zeros_like(touched)
            for y in range(ty0, ty1 + 1):
                for x in range(tx0, tx1 + 1):
                    data = rd.get(zr, x, y)
                    if data:
                        a = (np.asarray(Image.open(io.BytesIO(data))) != NODATA_DN).reshape(sub, k, sub, k)
                        ys, xs = slice(y * sub - r0, (y + 1) * sub - r0), slice(x * sub - c0, (x + 1) * sub - c0)
                        touched[ys, xs] |= a.any(axis=(1, 3))
                        covered[ys, xs] |= a.all(axis=(1, 3))
        if not touched.any():
            continue
        # near the sea, inside the box: as soon as our maps touch a pixel, and a margin round it
        near_sea = grow(land[r0:r1, c0:c1] == 0, sea_px)
        in_box = np.zeros_like(touched)
        in_box[by0 - r0:by1 + 1 - r0, bx0 - c0:bx1 + 1 - c0] = True
        win = grow(touched, margin) & near_sea & in_box
        # on land: what our maps cover whole, and the holes they enclose
        win |= fill_holes(covered)
        hide[r0:r1, c0:c1] |= win
    return hide


def block_sum(a, dtype):
    h, w = a.shape
    return a.reshape(h // 2, 2, w // 2, 2).sum(axis=(1, 3), dtype=dtype)


def cut_tiles(z, q, tiles, per_zoom):
    n = nbytes = 0
    for j in range(q.shape[0] // TILE):
        rows = q[j * TILE:(j + 1) * TILE]
        if rows.min() == NODATA_DN:
            continue
        for i in range(q.shape[1] // TILE):
            blk = rows[:, i * TILE:(i + 1) * TILE]
            if blk.min() == NODATA_DN:
                continue
            buf = io.BytesIO()
            Image.fromarray(np.ascontiguousarray(blk), "L").save(buf, "PNG", optimize=True)
            tiles.append((zxy_to_tileid(z, i, j), buf.getvalue()))
            n += 1
            nbytes += len(buf.getvalue())
    per_zoom[str(z)] = {"tiles": n, "bytes": nbytes}
    log(f"  z{z:<2d} {n:5d} tiles  {nbytes / 1e6:7.2f} MB")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--src", required=True, help=".npz with et/lon/lat, or a lon/lat GeoTIFF")
    ap.add_argument("--scale", type=float, default=1.0, help="multiply the source values (12: mean monthly -> annual)")
    ap.add_argument("--out", required=True, help="the tile set's folder (holds catalog.json)")
    ap.add_argument("--id", required=True, help="short id of the product, e.g. mod16a2gf")
    ap.add_argument("--name", required=True, help="the name shown on the page, e.g. MOD16A2GF")
    ap.add_argument("--long", default="", help="full name and provider, for the About text")
    ap.add_argument("--period", default="", help="years the field covers, e.g. 2016-2024")
    ap.add_argument("--grid", default="", help="the source grid in words, e.g. '0.1 degree'")
    ap.add_argument("--cell-km", type=float, required=True, help="size of a source cell on the ground, km")
    ap.add_argument("--doi", default="")
    ap.add_argument("--layer", default="annual", help="which of the portal's layers this stands behind")
    ap.add_argument("--units", default="mm/year")
    ap.add_argument("--dn-step", type=float, default=10.0)
    ap.add_argument("--zmax", type=int, default=6)
    ap.add_argument("--land", default=str(Path(__file__).resolve().parent.parent / "assets" / "land-50m.json"))
    ap.add_argument("--hide", action="append", default=[], help="PMTiles of our own maps: no background where they have data")
    ap.add_argument("--catalog", action="store_true", help="also write the block into --out/catalog.json")
    a = ap.parse_args()
    t0 = time.time()

    v, lon, lat = load_field(a.src)
    v *= a.scale
    log(f"{a.src}: {v.shape[1]} x {v.shape[0]} cells, {np.isfinite(v).mean() * 100:.0f}% with a value, "
        f"lon {lon[0]:.2f}..{lon[-1]:.2f}, lat {lat[-1]:.2f}..{lat[0]:.2f}")

    n = TILE * 2 ** a.zmax
    lons = (np.arange(n) + 0.5) / n * 360 - 180
    lats = np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * (np.arange(n) + 0.5) / n))))
    land = land_mask(a.land, n)
    log(f"  land outline drawn at zoom {a.zmax} ({n} px across)")
    hide = product_mask(a.hide, a.zmax, n, land) if a.hide else None
    if hide is not None:
        log(f"  cut out under our maps: {int(hide.sum())} px ({time.time() - t0:.0f} s)")

    q = np.full((n, n), NODATA_DN, np.uint8)
    clipped = 0
    for r0 in range(0, n, STRIP):
        if lats[r0] < lat[-1] - 1 or lats[min(n, r0 + STRIP) - 1] > lat[0] + 1:
            continue                                               # the strip lies outside the field
        s = sample(v, lon, lat, lons, lats[r0:r0 + STRIP])
        ok = np.isfinite(s) & (land[r0:r0 + STRIP] == 1)
        if hide is not None:
            ok &= ~hide[r0:r0 + STRIP]
        dn = np.rint(s[ok] / a.dn_step)
        clipped += int((dn > NODATA_DN - 1).sum())
        q[r0:r0 + STRIP][ok] = np.clip(dn, 0, NODATA_DN - 1)
    del land, hide
    valid = q != NODATA_DN
    log(f"  sampled: {valid.mean() * 100:.1f}% of the map has a value, {clipped} px above the top of the scale ({time.time() - t0:.0f} s)")

    tiles, per_zoom = [], {}
    cut_tiles(a.zmax, q, tiles, per_zoom)
    s, c = block_sum(np.where(valid, q, 0), np.uint32), block_sum(valid, np.uint32)
    del q, valid
    for z in range(a.zmax - 1, -1, -1):
        keep = c >= max(1, math.ceil(MIN_COVER * 4 ** (a.zmax - z)))
        lvl = np.full(s.shape, NODATA_DN, np.uint8)
        lvl[keep] = np.minimum(np.rint(s[keep] / c[keep]), NODATA_DN - 1)
        cut_tiles(z, lvl, tiles, per_zoom)
        if z:
            s, c = block_sum(s, np.uint32), block_sum(c, np.uint32)

    out = Path(a.out)
    rel = f"background/{a.id}_{a.layer}.pmtiles"
    (out / "background").mkdir(parents=True, exist_ok=True)
    tiles.sort(key=lambda t: t[0])
    header = {"tile_type": TileType.PNG, "tile_compression": Compression.NONE, "min_zoom": 0, "max_zoom": a.zmax,
              "min_lon_e7": int(-180 * 1e7), "min_lat_e7": int(max(-85.0511, lat[-1]) * 1e7),
              "max_lon_e7": int(180 * 1e7), "max_lat_e7": int(min(85.0511, lat[0]) * 1e7),
              "center_zoom": 1, "center_lon_e7": 0, "center_lat_e7": 0}
    meta = {"name": f"{a.id}_{a.layer}", "format": "png", "type": "overlay",
            "encoding": {"kind": "numeric-8bit", "dn_step": a.dn_step, "nodata_dn": NODATA_DN, "units": a.units},
            "description": f"Background layer ({a.name}): value = DN * dn_step, DN 255 = no data. Not Prithvi-OpenET-Tower output."}
    tmp = out / (rel + ".part")
    with open(tmp, "wb") as fh:
        w = Writer(fh)
        for tid, data in tiles:
            w.write_tile(tid, data)
        w.finalize(header, meta)
    os.replace(tmp, out / rel)

    block_path = out / "background" / "background.json"
    block = json.loads(block_path.read_text()) if block_path.exists() else {}
    if block.get("id") != a.id:
        block = {}                                               # another product: start again
    block.update({"id": a.id, "name": a.name, "long": a.long, "period": a.period, "grid": a.grid, "cell_km": a.cell_km,
                  "doi": a.doi, "zoom": {"min": 0, "max": a.zmax}, "made": time.strftime("%Y-%m-%dT%H:%M:%S%z")})
    block.setdefault("layers", {})[a.layer] = {
        "id": f"bg_{a.layer}", "file": rel, "units": a.units, "dn_step": a.dn_step, "bytes": (out / rel).stat().st_size,
        "tiles": len(tiles), "per_zoom": per_zoom, "source": Path(a.src).name}
    block_path.write_text(json.dumps(block, indent=1))
    if a.catalog:
        cat_path = out / "catalog.json"
        cat = json.loads(cat_path.read_text())
        cat["background"] = block
        tmp = cat_path.with_suffix(".json.part")
        tmp.write_text(json.dumps(cat, separators=(",", ":")))
        os.replace(tmp, cat_path)
        log(f"  block written into {cat_path}")
    log(f"done: {len(tiles)} tiles, {(out / rel).stat().st_size / 1e6:.1f} MB, {time.time() - t0:.0f} s -> {out / rel}")


if __name__ == "__main__":
    main()
