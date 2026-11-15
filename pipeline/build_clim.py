#!/usr/bin/env python3
"""Monthly climatology and annual total from the monthly ET maps (native grid, no resampling).

  clim_MM.tif      mean of the valid values of calendar month MM over --years   (raw units, x10 mm/month)
  clim_MM_n.tif    how many years contributed to each pixel
  clim_annual.tif  sum of the 12 monthly means, only where all 12 exist         (raw units, x10 mm/year)

Same definition as the dataset README ("annual ET = sum of the 2016-2024 monthly climatology").
One worker per calendar month; each holds ~9 GB.
"""
import argparse
import json
import os
import sys
import time
from multiprocessing import Pool

import numpy as np
from osgeo import gdal

NODATA = 65535
GTIFF_OPTS = ["TILED=YES", "BLOCKXSIZE=512", "BLOCKYSIZE=512", "COMPRESS=ZSTD", "PREDICTOR=2", "BIGTIFF=IF_SAFER"]


def log(msg):
    print(time.strftime("%H:%M:%S"), msg, flush=True)


def write_tif(path, arr, ref, nodata, gdal_type, tags):
    drv = gdal.GetDriverByName("GTiff")
    tmp = path + ".part.tif"
    ds = drv.Create(tmp, arr.shape[1], arr.shape[0], 1, gdal_type, GTIFF_OPTS)
    ds.SetGeoTransform(ref["gt"])
    ds.SetProjection(ref["prj"])
    b = ds.GetRasterBand(1)
    if nodata is not None:
        b.SetNoDataValue(nodata)
    b.WriteArray(arr)
    ds.SetMetadata(tags)
    ds.FlushCache()
    ds = None
    os.replace(tmp, path)


def month_clim(job):
    src_dir, out_dir, years, m, min_years, prefix = job
    gdal.UseExceptions()
    gdal.SetConfigOption("GDAL_CACHEMAX", "2048")
    t0 = time.time()
    s = c = ref = None
    used = []
    for y in years:
        p = os.path.join(src_dir, str(y), f"{prefix}{y}{m:02d}.tif")
        if not os.path.exists(p):
            continue
        ds = gdal.Open(p)
        a = ds.GetRasterBand(1).ReadAsArray()
        if s is None:
            s = np.zeros(a.shape, np.uint32)
            c = np.zeros(a.shape, np.uint8)
            ref = {"gt": ds.GetGeoTransform(), "prj": ds.GetProjection()}
        ds = None
        v = a != NODATA
        np.add(s, a, out=s, where=v)
        c += v
        used.append(y)
        del a, v
    ok = c >= min_years
    out = np.full(s.shape, NODATA, np.uint16)
    out[ok] = np.rint(s[ok] / c[ok])
    tags = {"layer": f"clim_{m:02d}", "years": ",".join(map(str, used)), "min_years": str(min_years),
            "scale_factor": "0.1", "units": "mm month-1",
            "definition": "mean of valid monthly values over the listed years"}
    write_tif(os.path.join(out_dir, f"clim_{m:02d}.tif"), out, ref, NODATA, gdal.GDT_UInt16, tags)
    write_tif(os.path.join(out_dir, f"clim_{m:02d}_n.tif"), c, ref, None, gdal.GDT_Byte, tags)
    n = int(ok.sum())
    mean = float(out[ok].mean()) * 0.1 if n else float("nan")
    log(f"clim {m:02d}: {len(used)} years, {n / 1e6:.1f} M px, mean {mean:.1f} mm/month, {time.time() - t0:.0f}s")
    return {"month": m, "years": used, "valid_px": n, "mean": mean}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--src-dir", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--years", default="2016-2024")
    ap.add_argument("--min-years", type=int, default=1)
    ap.add_argument("--prefix", default="KP_ET30m_")
    ap.add_argument("--procs", type=int, default=12)
    a = ap.parse_args()
    y0, y1 = map(int, a.years.split("-"))
    years = list(range(y0, y1 + 1))
    os.makedirs(a.out_dir, exist_ok=True)
    gdal.UseExceptions()

    jobs = [(a.src_dir, a.out_dir, years, m, a.min_years, a.prefix) for m in range(1, 13)]
    with Pool(a.procs) as pool:
        res = pool.map(month_clim, jobs)

    log("annual total ...")
    tot = allok = ref = None
    for m in range(1, 13):
        ds = gdal.Open(os.path.join(a.out_dir, f"clim_{m:02d}.tif"))
        arr = ds.GetRasterBand(1).ReadAsArray()
        if tot is None:
            tot = np.zeros(arr.shape, np.uint32)
            allok = np.ones(arr.shape, bool)
            ref = {"gt": ds.GetGeoTransform(), "prj": ds.GetProjection()}
        ds = None
        v = arr != NODATA
        np.add(tot, arr, out=tot, where=v)
        allok &= v
    if int(tot[allok].max()) >= NODATA:
        sys.exit("annual total overflows uint16")
    out = np.full(tot.shape, NODATA, np.uint16)
    out[allok] = tot[allok]
    tags = {"layer": "clim_annual", "years": a.years, "min_years": str(a.min_years), "scale_factor": "0.1",
            "units": "mm year-1", "definition": "sum of the 12 monthly climatology means; only where all 12 exist"}
    write_tif(os.path.join(a.out_dir, "clim_annual.tif"), out, ref, NODATA, gdal.GDT_UInt16, tags)
    v = out[allok].astype(np.float64) * 0.1
    q = np.percentile(v[::97], [1, 5, 50, 95, 99, 99.9, 99.99])
    summary = {"months": res, "annual": {"valid_px": int(allok.sum()), "mean": float(v.mean()),
               "p01": q[0], "p05": q[1], "p50": q[2], "p95": q[3], "p99": q[4], "p99.9": q[5],
               "p99.99": q[6], "max": float(v.max())}}
    with open(os.path.join(a.out_dir, "clim_summary.json"), "w") as fh:
        json.dump(summary, fh, indent=1)
    log("annual: %(valid_px)d px, mean %(mean).1f, p5 %(p05).0f, p50 %(p50).0f, p95 %(p95).0f, "
        "p99.9 %(p99.9).0f, max %(max).0f mm/year" % summary["annual"])


if __name__ == "__main__":
    main()
