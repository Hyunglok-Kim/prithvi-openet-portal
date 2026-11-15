#!/usr/bin/env python3
"""One raster (any CRS) -> 8-bit numeric Web-Mercator tile pyramid in a single PMTiles file.

Every tile is a 256 x 256 8-bit grayscale PNG that carries *values*, not colours:

    DN 0..254  ->  value = DN * dn_step      (physical units, e.g. mm/month)
    DN 255     ->  no data

The browser colours the tiles itself, so the legend range can change and the value under
the cursor is exact to one dn_step.

How the pyramid is made
  1. The source band is warped once to EPSG:3857 on the exact pixel grid of --zmax
     (bilinear, no-data aware).  z12 is ~30 m on the ground at 38 N, i.e. native resolution.
  2. Coarser levels are area averages of the valid full-resolution pixels (sum and count are
     carried down level by level, so every level is the mean of the base pixels it covers).
  3. A coarse pixel is written only when at least --min-cover of its area has data, so cloud
     gaps stay visible when zoomed out instead of being smeared over.

Statistics (mean, percentiles, valid-pixel count, histogram) are taken from the source grid,
not from the warped tiles: Web Mercator has more pixels per square kilometre toward the north,
so a plain mean over tile pixels would lean toward northern values.

Needs: python3, numpy, GDAL python bindings (osgeo), Pillow, pmtiles (pip).
"""
import argparse
import io
import json
import math
import os
import sys
import time

import numpy as np
from osgeo import gdal
from PIL import Image
from pmtiles.tile import Compression, TileType, zxy_to_tileid
from pmtiles.writer import Writer

R = 6378137.0
ORIGIN = math.pi * R            # 20037508.342789244
TILE = 256
NODATA_DN = 255
STRIP = 4096                    # rows per chunk when quantizing the big base array


def log(msg):
    print(time.strftime("%H:%M:%S"), msg, flush=True)


def tile_range(ext, z):
    """Tile index range (inclusive) covering an EPSG:3857 extent at zoom z."""
    xmin, ymin, xmax, ymax = ext
    span = 2 * ORIGIN / 2 ** z
    eps = span * 1e-9
    tx0 = int(math.floor((xmin + ORIGIN + eps) / span))
    tx1 = int(math.ceil((xmax + ORIGIN - eps) / span)) - 1
    ty0 = int(math.floor((ORIGIN - ymax + eps) / span))
    ty1 = int(math.ceil((ORIGIN - ymin - eps) / span)) - 1
    return tx0, ty0, tx1, ty1


def merc_to_lonlat(x, y):
    return math.degrees(x / R), math.degrees(math.atan(math.sinh(y / R)))


def block_sum(a, dtype):
    """2 x 2 block sum of a 2-D array with even dimensions."""
    h, w = a.shape
    return a.reshape(h // 2, 2, w // 2, 2).sum(axis=(1, 3), dtype=dtype)


def native_histogram(band, nodata, rows=2048):
    """Histogram of the raw values of a band on its own grid (strip by strip, so memory stays small)."""
    hist = np.zeros(65536, np.int64)
    for r0 in range(0, band.YSize, rows):
        a = band.ReadAsArray(0, r0, band.XSize, min(rows, band.YSize - r0))
        hist += np.bincount(a.ravel(), minlength=65536)
    hist[nodata] = 0
    return hist


class TileSink:
    def __init__(self):
        self.tiles = []          # (tileid, png bytes)
        self.per_zoom = {}

    def emit(self, z, x0, y0, q):
        """Cut a level array (uint8 DN) into tiles; skip tiles with no data at all."""
        nty, ntx = q.shape[0] // TILE, q.shape[1] // TILE
        n = nbytes = 0
        for j in range(nty):
            row = q[j * TILE:(j + 1) * TILE]
            if row.min() == NODATA_DN:
                continue
            for i in range(ntx):
                blk = row[:, i * TILE:(i + 1) * TILE]
                if blk.min() == NODATA_DN:
                    continue
                buf = io.BytesIO()
                Image.fromarray(np.ascontiguousarray(blk), "L").save(buf, "PNG", optimize=True)
                data = buf.getvalue()
                self.tiles.append((zxy_to_tileid(z, x0 + i, y0 + j), data))
                n += 1
                nbytes += len(data)
        self.per_zoom[z] = {"tiles": n, "bytes": nbytes}
        log(f"  z{z:<2d} {n:6d} tiles  {nbytes / 1e6:8.2f} MB")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--src", required=True)
    ap.add_argument("--out", required=True, help="output .pmtiles")
    ap.add_argument("--stats", required=True, help="output .json with layer statistics")
    ap.add_argument("--id", required=True, help="layer id written to the stats/metadata")
    ap.add_argument("--band", type=int, default=1)
    ap.add_argument("--src-scale", type=float, default=0.1, help="physical value = raw * src_scale")
    ap.add_argument("--dn-step", type=float, default=1.0, help="physical units per DN")
    ap.add_argument("--units", default="mm/month")
    ap.add_argument("--zmin", type=int, default=3)
    ap.add_argument("--zmax", type=int, default=12)
    ap.add_argument("--min-cover", type=float, default=0.25)
    ap.add_argument("--resample", default="bilinear")
    ap.add_argument("--threads", type=int, default=8)
    ap.add_argument("--meta", action="append", default=[], help="extra key=value for the stats json")
    a = ap.parse_args()

    gdal.UseExceptions()
    gdal.SetConfigOption("GDAL_CACHEMAX", "4096")
    t0 = time.time()

    src = gdal.Open(a.src)
    nodata = src.GetRasterBand(a.band).GetNoDataValue()
    if nodata is None:
        sys.exit("source band has no nodata value")
    nodata = int(nodata)
    tags = src.GetMetadata() or {}
    log(f"{a.id}: {a.src}  {src.RasterXSize} x {src.RasterYSize}  nodata={nodata}")

    hist_raw = native_histogram(src.GetRasterBand(a.band), nodata)
    n_valid = int(hist_raw.sum())
    if n_valid == 0:
        sys.exit("no valid pixels")
    log(f"  native grid: {n_valid / 1e6:.1f} M valid px ({time.time() - t0:.0f}s)")

    # ---- 1. footprint in EPSG:3857, snapped to the tile grid --------------------------------
    probe = gdal.Warp("", src, format="VRT", dstSRS="EPSG:3857")
    gt = probe.GetGeoTransform()
    ext = (gt[0], gt[3] + gt[5] * probe.RasterYSize, gt[0] + gt[1] * probe.RasterXSize, gt[3])
    probe = None
    zal = max(a.zmin, a.zmax - 4)            # base grid aligned to tiles of this zoom: no padding of big arrays
    ax0, ay0, ax1, ay1 = tile_range(ext, zal)
    f = 2 ** (a.zmax - zal)
    tx0, ty0 = ax0 * f, ay0 * f
    tx1, ty1 = (ax1 + 1) * f - 1, (ay1 + 1) * f - 1
    span = 2 * ORIGIN / 2 ** a.zmax
    bounds = (tx0 * span - ORIGIN, ORIGIN - (ty1 + 1) * span, (tx1 + 1) * span - ORIGIN, ORIGIN - ty0 * span)
    W, H = (tx1 - tx0 + 1) * TILE, (ty1 - ty0 + 1) * TILE
    log(f"  z{a.zmax} grid: tiles x {tx0}..{tx1}  y {ty0}..{ty1}  ->  {W} x {H} px ({W * H / 1e6:.0f} M)")

    # ---- 2. warp one band to that grid ------------------------------------------------------
    one = f"/vsimem/one_{os.getpid()}.vrt"
    gdal.Translate(one, src, format="VRT", bandList=[a.band])
    ds = gdal.Warp("", one, format="MEM", dstSRS="EPSG:3857", outputBounds=bounds, width=W, height=H,
                   resampleAlg=a.resample, srcNodata=nodata, dstNodata=nodata,
                   outputType=gdal.GDT_UInt16, multithread=True,
                   warpOptions=[f"NUM_THREADS={a.threads}", "INIT_DEST=NO_DATA"], warpMemoryLimit=4000)
    arr = ds.GetRasterBand(1).ReadAsArray()
    ds = None
    gdal.Unlink(one)
    log(f"  warped in {time.time() - t0:.0f}s")

    # ---- 3. base level: quantize; statistics from the native-grid histogram -----------------
    k = a.src_scale / a.dn_step
    q = np.empty(arr.shape, np.uint8)
    tile_valid = 0
    for r0 in range(0, H, STRIP):
        blk = arr[r0:r0 + STRIP]
        ok = blk != nodata
        tile_valid += int(ok.sum())
        qq = np.minimum(np.rint(blk.astype(np.float32) * k), NODATA_DN - 1).astype(np.uint8)
        qq[~ok] = NODATA_DN
        q[r0:r0 + STRIP] = qq
    vals = np.arange(65536, dtype=np.float64) * a.src_scale
    cdf = np.cumsum(hist_raw) / n_valid

    def pct(p):
        return float(vals[int(np.searchsorted(cdf, p / 100.0))])

    clipped = int(hist_raw[int(math.floor((NODATA_DN - 0.5) / k)) + 1:].sum())
    stats = {
        "id": a.id, "units": a.units, "dn_step": a.dn_step, "nodata_dn": NODATA_DN,
        "valid_px": n_valid, "native_px": int(src.RasterXSize) * int(src.RasterYSize), "tile_valid_px": tile_valid,
        "mean": float((vals * hist_raw).sum() / n_valid),
        "p01": pct(1), "p02": pct(2), "p25": pct(25), "p50": pct(50), "p75": pct(75),
        "p98": pct(98), "p99": pct(99), "max": float(vals[np.nonzero(hist_raw)[0][-1]]),
        "clipped_px": clipped,
        "hist_dn": np.bincount(np.minimum(np.rint(np.arange(65536) * k), NODATA_DN - 1).astype(np.int64),
                               weights=hist_raw, minlength=256)[:255].astype(np.int64).tolist(),
    }
    log(f"  valid {n_valid / 1e6:.1f} M px  mean {stats['mean']:.1f}  p2 {stats['p02']:.0f}  "
        f"p50 {stats['p50']:.0f}  p98 {stats['p98']:.0f}  max {stats['max']:.0f} {a.units}  clipped {clipped}")

    sink = TileSink()
    sink.emit(a.zmax, tx0, ty0, q)
    del q

    # ---- 4. coarser levels: carry sum and count of valid base pixels ------------------------
    valid = arr != nodata
    arr[~valid] = 0
    s = block_sum(arr, np.uint64)
    c = block_sum(valid, np.uint32)
    del arr, valid
    z, x0, y0 = a.zmax - 1, tx0 // 2, ty0 // 2
    while True:
        full = 4 ** (a.zmax - z)
        keep = c >= max(1, int(math.ceil(a.min_cover * full)))
        mean = np.zeros(s.shape, np.float32)
        np.divide(s, c, out=mean, where=c > 0, casting="unsafe")
        q = np.full(s.shape, NODATA_DN, np.uint8)
        q[keep] = np.minimum(np.rint(mean[keep] * k), NODATA_DN - 1)
        del mean, keep
        sink.emit(z, x0, y0, q)
        del q
        if z == a.zmin:
            break
        nty, ntx = s.shape[0] // TILE, s.shape[1] // TILE
        pl = TILE if x0 % 2 else 0
        pr = TILE if (x0 + ntx) % 2 else 0
        pt = TILE if y0 % 2 else 0
        pb = TILE if (y0 + nty) % 2 else 0
        if pl or pr or pt or pb:
            s = np.pad(s, ((pt, pb), (pl, pr)))
            c = np.pad(c, ((pt, pb), (pl, pr)))
        x0, y0 = (x0 - (1 if pl else 0)) // 2, (y0 - (1 if pt else 0)) // 2
        s, c = block_sum(s, np.uint64), block_sum(c, np.uint32)
        z -= 1

    # ---- 5. write PMTiles -------------------------------------------------------------------
    sink.tiles.sort(key=lambda t: t[0])
    lon0, lat0 = merc_to_lonlat(ext[0], ext[1])
    lon1, lat1 = merc_to_lonlat(ext[2], ext[3])
    header = {
        "tile_type": TileType.PNG, "tile_compression": Compression.NONE,
        "min_zoom": a.zmin, "max_zoom": a.zmax,
        "min_lon_e7": int(lon0 * 1e7), "min_lat_e7": int(lat0 * 1e7),
        "max_lon_e7": int(lon1 * 1e7), "max_lat_e7": int(lat1 * 1e7),
        "center_zoom": 6, "center_lon_e7": int((lon0 + lon1) / 2 * 1e7),
        "center_lat_e7": int((lat0 + lat1) / 2 * 1e7),
    }
    meta = {"name": a.id, "format": "png", "type": "overlay",
            "encoding": {"kind": "numeric-8bit", "dn_step": a.dn_step, "nodata_dn": NODATA_DN, "units": a.units},
            "description": "Numeric browse tiles: value = DN * dn_step, DN 255 = no data"}
    tmp = a.out + ".part"
    with open(tmp, "wb") as fh:
        w = Writer(fh)
        for tid, data in sink.tiles:
            w.write_tile(tid, data)
        w.finalize(header, meta)
    os.replace(tmp, a.out)

    stats.update({
        "file": os.path.basename(a.out), "bytes": os.path.getsize(a.out),
        "tiles": len(sink.tiles), "per_zoom": {str(z): v for z, v in sorted(sink.per_zoom.items())},
        "zmin": a.zmin, "zmax": a.zmax, "min_cover": a.min_cover, "resample": a.resample,
        "bounds_lonlat": [round(lon0, 5), round(lat0, 5), round(lon1, 5), round(lat1, 5)],
        "src": os.path.basename(a.src),
        "src_tags": {t: tags[t] for t in ("ym", "period_flag", "sensors", "model", "created") if t in tags},
        "elapsed_s": round(time.time() - t0, 1),
    })
    for kv in a.meta:
        key, _, val = kv.partition("=")
        stats[key] = val
    with open(a.stats + ".part", "w") as fh:
        json.dump(stats, fh)
    os.replace(a.stats + ".part", a.stats)
    log(f"  done: {len(sink.tiles)} tiles, {stats['bytes'] / 1e6:.1f} MB, {stats['elapsed_s']:.0f}s -> {a.out}")


if __name__ == "__main__":
    main()
