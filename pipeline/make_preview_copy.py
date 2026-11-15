#!/usr/bin/env python3
"""Make a lighter copy of the browse tiles for a host with size limits — a public preview.

    python pipeline/make_preview_copy.py --src /path/to/out --out /path/to/public \\
        --max-zoom 10 --volume-mb 600 --name prithvi-openet-tiles

Every tile up to --max-zoom is copied from each PMTiles archive into a new archive. The tile bytes
are not touched, so at those zooms the copy holds exactly the numbers of the full set. The archives
are spread over numbered folders of at most --volume-mb each (NAME-1, NAME-2, …), because a GitHub
Pages site may not exceed 1 GB: each folder becomes one repository and one site. catalog.json goes
into the first folder and points at the others with relative addresses (../NAME-2/monthly/…), which
work as long as the sites sit next to each other on one host.

In the catalog, zoom.max becomes --max-zoom and zoom.native keeps the full set's top zoom. That
pair is how the portal knows it is showing a reduced copy, and it says so wherever it names a
resolution. Statistics (means, percentiles, share of land observed) are copied unchanged: they come
from the native grid, not from the tiles.

Needs: python3 and pmtiles (pip). Light work — a few minutes on a laptop for the Korean set.
"""
import argparse
import json
import os
import time
from pathlib import Path

from pmtiles.reader import MmapSource, Reader
from pmtiles.tile import deserialize_directory, tileid_to_zxy, zxy_to_tileid
from pmtiles.writer import Writer

SIDECAR_KEEP = ("id", "units", "dn_step", "nodata_dn", "valid_px", "mean", "p01", "p02", "p25", "p50", "p75", "p98",
                "p99", "max", "hist_dn", "zmin", "bounds_lonlat")
HEADER_KEEP = ("tile_type", "tile_compression", "min_zoom", "min_lon_e7", "min_lat_e7", "max_lon_e7", "max_lat_e7",
               "center_zoom", "center_lon_e7", "center_lat_e7")


def tiles_up_to(get_bytes, header, limit):
    """(tile id, bytes) of every tile whose id is below limit, in id order. Ids grow with zoom, so
    this reads the coarse levels and never opens the directories of the fine ones."""
    def walk(offset, length):
        for e in deserialize_directory(get_bytes(offset, length)):
            if e.tile_id >= limit:
                return
            if e.run_length == 0:                                   # a pointer to a leaf directory
                yield from walk(header["leaf_directory_offset"] + e.offset, e.length)
                continue
            data = get_bytes(header["tile_data_offset"] + e.offset, e.length)
            for i in range(e.run_length):
                if e.tile_id + i < limit:
                    yield e.tile_id + i, data
    yield from walk(header["root_offset"], header["root_length"])


def copy_archive(src, dst, zmax):
    """Write dst with the tiles of src up to zmax. Returns (bytes, tiles, per-zoom counts, source top zoom)."""
    per_zoom = {}
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_suffix(dst.suffix + ".part")
    with open(src, "rb") as f, open(tmp, "wb") as out:
        rd = Reader(MmapSource(f))
        h = rd.header()
        w = Writer(out)
        n = 0
        for tid, data in tiles_up_to(rd.get_bytes, h, zxy_to_tileid(zmax + 1, 0, 0)):
            w.write_tile(tid, data)
            z = tileid_to_zxy(tid)[0]
            pz = per_zoom.setdefault(str(z), {"tiles": 0, "bytes": 0})
            pz["tiles"] += 1
            pz["bytes"] += len(data)
            n += 1
        meta = dict(rd.metadata())
        meta["copy"] = f"zoom {h['min_zoom']}-{min(zmax, h['max_zoom'])} of a set that goes to zoom {h['max_zoom']}"
        header = {k: h[k] for k in HEADER_KEEP}
        header["max_zoom"] = min(zmax, h["max_zoom"])
        w.finalize(header, meta)
    os.replace(tmp, dst)
    return dst.stat().st_size, n, per_zoom, h["max_zoom"]


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--src", required=True, help="the full set: folder with catalog.json, monthly/ and clim/")
    ap.add_argument("--out", required=True, help="parent folder for the numbered copies")
    ap.add_argument("--max-zoom", type=int, default=10)
    ap.add_argument("--volume-mb", type=float, default=600, help="largest size of one folder (one site)")
    ap.add_argument("--name", default="prithvi-openet-tiles", help="folders are NAME-1, NAME-2, …")
    ap.add_argument("--portal", default="https://github.com/Hyunglok-Kim/prithvi-openet-portal", help="address written into the folders' README")
    a = ap.parse_args()
    src, out, t0 = Path(a.src), Path(a.out), time.time()
    cat = json.loads((src / "catalog.json").read_text())

    # every layer record of the catalog, in the order they are stored: climatology first, then the months
    records = ([cat["annual"]] if cat.get("annual") else []) + list(cat.get("clim", [])) + [m["tiles"] for m in cat["months"] if m.get("tiles")]
    budget, vol, used, sizes = a.volume_mb * 1e6, 1, 0, {}
    for rec in records:
        side = json.loads((src / rec["file"]).with_suffix(".json").read_text())
        est = sum(v["bytes"] for z, v in side["per_zoom"].items() if int(z) <= a.max_zoom) + 60_000      # plus directory and statistics
        if used and used + est > budget:
            vol, used = vol + 1, 0
        used += est
        rec["_vol"], rec["_side"] = vol, side
    names = [f"{a.name}-{k}" for k in range(1, vol + 1)]

    native = 0
    for i, rec in enumerate(records):
        rel, folder = rec["file"], out / names[rec["_vol"] - 1]
        size, n, per_zoom, top = copy_archive(src / rel, folder / rel, a.max_zoom)
        native = max(native, top)
        side = {k: rec["_side"][k] for k in SIDECAR_KEEP if k in rec["_side"]}
        side.update({"file": Path(rel).name, "bytes": size, "tiles": n, "per_zoom": per_zoom, "zmax": min(a.max_zoom, top)})
        (folder / rel).with_suffix(".json").write_text(json.dumps(side))
        sizes[rec["_vol"]] = sizes.get(rec["_vol"], 0) + size + len(json.dumps(side))
        rec.update({"file": rel if rec["_vol"] == 1 else f"../{names[rec['_vol'] - 1]}/{rel}", "bytes": size, "tiles": n})
        del rec["_vol"], rec["_side"]
        if (i + 1) % 25 == 0 or i + 1 == len(records):
            print(f"  {i + 1}/{len(records)} archives  [{time.time() - t0:.0f} s]", flush=True)

    cat["zoom"] = {"min": cat["zoom"]["min"], "max": min(a.max_zoom, native), "native": native}
    cat["copy"] = {"kind": "preview", "of_version": cat["version"], "made": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "sites": names}
    (out / names[0] / "catalog.json").write_text(json.dumps(cat, separators=(",", ":")))

    first, last = cat["record"]["first"], cat["record"]["last"]
    for k, name in enumerate(names, 1):
        folder = out / name
        (folder / ".nojekyll").write_text("")
        (folder / "README.md").write_text(
            f"# Prithvi-OpenET-Tower browse tiles — public preview, part {k} of {len(names)}\n\n"
            f"Numeric map tiles for the [Prithvi-OpenET-Tower data portal]({a.portal}): 30 m monthly\n"
            f"evapotranspiration of the Korean Peninsula, {first} to {last}, reduced to zoom {cat['zoom']['min']}–{cat['zoom']['max']}\n"
            f"so that it fits on GitHub Pages. The full set goes to zoom {native} (30 m).\n\n"
            "One PMTiles file per month (`monthly/`) and per climatology layer (`clim/`). A tile is an 8-bit\n"
            "grayscale PNG that holds values, not colours: `value = DN × dn_step`, `DN 255 = no data`.\n"
            "These tiles are for looking, not for analysis — they are resampled to Web Mercator, averaged and\n"
            "rounded. Use the GeoTIFFs for any calculation; they will be released with the paper.\n\n"
            f"Made by `pipeline/make_preview_copy.py` of the portal repository from data version `{cat['version']}`.\n"
            "Do not edit by hand: rebuild and replace.\n\n"
            "HydroAI Lab, Gwangju Institute of Science and Technology — hyunglokkim@gist.ac.kr\n")
        (folder / "index.html").write_text(
            '<!DOCTYPE html><html lang="en"><meta charset="utf-8"><title>Prithvi-OpenET-Tower browse tiles</title>'
            '<meta name="robots" content="noindex">'
            f'<p style="font:16px/1.5 system-ui;margin:3em auto;max-width:34em;padding:0 1em">Map tiles for the '
            f'<a href="{a.portal}">Prithvi-OpenET-Tower data portal</a>. There is nothing to browse here.</p></html>\n')
        print(f"  {name}: {sizes.get(k, 0) / 1e6:.0f} MB")
    print(f"zoom {cat['zoom']['min']}–{cat['zoom']['max']} of {native}, {len(records)} archives in {len(names)} folder(s), "
          f"{sum(sizes.values()) / 1e9:.2f} GB, {time.time() - t0:.0f} s → {out}")


if __name__ == "__main__":
    main()
