#!/usr/bin/env python3
"""Assemble catalog.json — the one file the portal reads to know what exists.

Combines the per-layer statistics written by build_tiles.py with the inventory of the
source GeoTIFFs (name, size, checksum, training-period flag), so the portal can show the
whole 160-month record even while only some months have browse tiles.
"""
import argparse
import glob
import json
import os
import re
import time

TRAIN = ("2016-01", "2024-12")          # months the model was trained on (paper: Jan 2016 - Dec 2024)
S30_FROM = "2015-12"                    # dataset README: Landsat only through 2015-11


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out-dir", required=True, help="directory holding monthly/, clim/ and the result")
    ap.add_argument("--src-root", required=True, help="dataset root with et_30m/ and SHA256SUMS")
    ap.add_argument("--version", default=time.strftime("prototype-%Y-%m-%d"))
    a = ap.parse_args()

    sha = {}
    sums = os.path.join(a.src_root, "SHA256SUMS")
    if os.path.exists(sums):
        for line in open(sums):
            parts = line.split()
            if len(parts) == 2:
                sha[parts[1].lstrip("*").lstrip("./")] = parts[0]

    layers = {}
    for p in glob.glob(os.path.join(a.out_dir, "*", "*.json")):
        if os.path.basename(os.path.dirname(p)) == "background":
            continue                                   # not a layer of ours: see the end of this function
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
    for p in sorted(glob.glob(os.path.join(a.src_root, "et_30m", "*", "*.tif"))):
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

    any_layer = next(iter(layers.values()))
    cat = {
        "id": "prithvi-openet-tower-korea",
        "version": a.version,
        "generated": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "encoding": {"kind": "numeric-8bit", "nodata_dn": 255,
                     "note": "tile pixel DN * dn_step = value; DN 255 = no data"},
        "zoom": {"min": any_layer["zmin"], "max": any_layer["zmax"]},
        "bounds": any_layer["bounds_lonlat"],
        "land_px": land_px,
        "record": {"first": months[0]["ym"], "last": months[-1]["ym"], "n": len(months),
                   "train": list(TRAIN), "with_tiles": sum(1 for r in months if "tiles" in r)},
        "source": {"grid": "EPSG:5179, 30 m, 22403 x 36677 px", "format": "COG, uint16, 2 bands, scale 0.1",
                   "total_bytes": sum(r["cog_bytes"] for r in months)},
        "annual": pick(annual) if annual else None,
        "clim": [dict(pick(layers[f"clim_{m:02d}"]), month=m) for m in range(1, 13) if f"clim_{m:02d}" in layers],
        "months": months,
    }
    # a background layer for the rest of the globe, if make_background.py has made one
    block = os.path.join(a.out_dir, "background", "background.json")
    if os.path.exists(block):
        cat["background"] = json.load(open(block))
    out = os.path.join(a.out_dir, "catalog.json")
    with open(out + ".part", "w") as fh:
        json.dump(cat, fh, separators=(",", ":"))
    os.replace(out + ".part", out)
    print(f"{out}: {len(months)} months ({cat['record']['with_tiles']} with tiles), "
          f"{len(cat['clim'])} climatology months, annual={'yes' if annual else 'no'}, "
          f"{os.path.getsize(out) / 1024:.0f} KB")


if __name__ == "__main__":
    main()
