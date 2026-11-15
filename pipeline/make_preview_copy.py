#!/usr/bin/env python3
"""Make a lighter copy of the browse tiles for a host with size limits — a public preview.

    python pipeline/make_preview_copy.py --src /path/to/out --out /path/to/public \\
        --max-zoom 10 --volume-mb 600 --name prithvi-openet-tiles \\
        --fine pipeline/preview_fine_areas.geojson

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

--fine FILE names a few small areas that keep the native detail (a GeoJSON file of polygons with
"id" and "name" properties). For those, each layer gets a second, small archive beside the first
(X.fine.pmtiles) with the tiles above --max-zoom that touch an area. Inside an area's outline such a
tile holds the full set's pixels; outside it, the pixels are the copy's own finest level enlarged,
so nothing finer than --max-zoom leaves the areas. The catalog lists the areas under "fine" and the
portal draws their outlines and reads those archives there.

A background layer (pipeline/make_background.py) is carried over as it is, into the first folder.

Needs: python3 and pmtiles (pip); numpy and Pillow as well when --fine is given. Light work — well
under a minute on a laptop for the Korean set.
"""
import argparse
import io
import json
import math
import os
import shutil
import time
from pathlib import Path

from pmtiles.reader import MmapSource, Reader
from pmtiles.tile import deserialize_directory, tileid_to_zxy, zxy_to_tileid
from pmtiles.writer import Writer

TILE = 256
NODATA_DN = 255
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


def load_areas(path):
    """The areas of a --fine file: id, name, outline (lon/lat ring), bounding box and centre."""
    areas = []
    for f in json.loads(Path(path).read_text())["features"]:
        ring = [[round(float(lo), 5), round(float(la), 5)] for lo, la in f["geometry"]["coordinates"][0]]
        lons, lats = [p[0] for p in ring], [p[1] for p in ring]
        p = f["properties"]
        areas.append({"id": p["id"], "name": p["name"], "about": p.get("about", ""), "ring": ring,
                      "bounds": [min(lons), min(lats), max(lons), max(lats)],
                      "center": [round((min(lons) + max(lons)) / 2, 5), round((min(lats) + max(lats)) / 2, 5)]})
    return areas


def world_px(lon, lat, z):
    """Position in the Web-Mercator pixel grid of zoom z."""
    n = TILE * 2 ** z
    return (lon + 180) / 360 * n, (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n


def fine_tiles(rd, areas, zbase, ztop):
    """Tiles above zbase that touch an area, as (tile id, PNG bytes) in id order. Inside the outlines
    they hold the archive's own pixels; outside, the zbase pixels enlarged."""
    import numpy as np
    from PIL import Image, ImageDraw

    out = []
    for z in range(zbase + 1, ztop + 1):
        k = 2 ** (z - zbase)
        sub = TILE // k
        wanted = set()
        for ar in areas:
            w, s, e, n = ar["bounds"]
            x0, y0 = (int(v // TILE) for v in world_px(w, n, z))
            x1, y1 = (int(v // TILE) for v in world_px(e, s, z))
            wanted.update((x, y) for y in range(y0, y1 + 1) for x in range(x0, x1 + 1))
        for x, y in sorted(wanted):
            data = rd.get(z, x, y)
            if not data:
                continue                                        # nothing there at all: the enlarged coarse tile is empty too
            mask = Image.new("L", (TILE, TILE), 0)
            draw = ImageDraw.Draw(mask)
            for ar in areas:
                draw.polygon([(px - x * TILE, py - y * TILE) for px, py in (world_px(lo, la, z) for lo, la in ar["ring"])], fill=1)
            inside = np.asarray(mask, bool)
            if not inside.any():
                continue
            up = rd.get(zbase, x // k, y // k)
            if up:
                c = np.asarray(Image.open(io.BytesIO(up)))
                ox, oy = (x % k) * sub, (y % k) * sub
                coarse = np.repeat(np.repeat(c[oy:oy + sub, ox:ox + sub], k, axis=0), k, axis=1)
            else:
                coarse = np.full((TILE, TILE), NODATA_DN, np.uint8)
            tile = np.where(inside, np.asarray(Image.open(io.BytesIO(data))), coarse).astype(np.uint8)
            buf = io.BytesIO()
            Image.fromarray(np.ascontiguousarray(tile), "L").save(buf, "PNG", optimize=True)
            out.append((zxy_to_tileid(z, x, y), buf.getvalue()))
    return sorted(out)


def copy_archive(src, dst, zmax, areas=None):
    """Write dst with the tiles of src up to zmax and, when areas are given, dst's .fine twin.
    Returns (bytes, tiles, per-zoom counts, source top zoom, fine bytes, fine tiles)."""
    per_zoom = {}
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_suffix(dst.suffix + ".part")
    fine_dst, fine_size, fine_n = dst.with_suffix(".fine.pmtiles"), 0, 0
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

        fine = fine_tiles(rd, areas, zmax, h["max_zoom"]) if areas and h["max_zoom"] > zmax else []
        if fine:
            ftmp = fine_dst.with_suffix(".pmtiles.part")
            with open(ftmp, "wb") as fo:
                fw = Writer(fo)
                for tid, data in fine:
                    fw.write_tile(tid, data)
                fmeta = dict(rd.metadata())
                fmeta["copy"] = (f"zoom {zmax + 1}-{h['max_zoom']} for {len(areas)} small area(s) only; outside their outlines "
                                 f"the pixels are zoom {zmax} enlarged")
                fheader = {k: h[k] for k in HEADER_KEEP}
                fheader.update({"min_zoom": zmax + 1, "max_zoom": h["max_zoom"]})
                fw.finalize(fheader, fmeta)
            os.replace(ftmp, fine_dst)
            fine_size, fine_n = fine_dst.stat().st_size, len(fine)
    os.replace(tmp, dst)
    if not fine and fine_dst.exists():
        fine_dst.unlink()                                           # left over from an earlier run with other areas
    return dst.stat().st_size, n, per_zoom, h["max_zoom"], fine_size, fine_n


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--src", required=True, help="the full set: folder with catalog.json, monthly/ and clim/")
    ap.add_argument("--out", required=True, help="parent folder for the numbered copies")
    ap.add_argument("--max-zoom", type=int, default=10)
    ap.add_argument("--volume-mb", type=float, default=600, help="largest size of one folder (one site)")
    ap.add_argument("--name", default="prithvi-openet-tiles", help="folders are NAME-1, NAME-2, …")
    ap.add_argument("--fine", default="", help="GeoJSON of small areas that keep the native detail")
    ap.add_argument("--portal", default="https://github.com/Hyunglok-Kim/prithvi-openet-portal", help="address written into the folders' README")
    a = ap.parse_args()
    src, out, t0 = Path(a.src), Path(a.out), time.time()
    cat = json.loads((src / "catalog.json").read_text())
    areas = load_areas(a.fine) if a.fine else []

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

    native, fine_bytes, fine_count, fine_layers = 0, 0, 0, 0
    for i, rec in enumerate(records):
        rel, folder = rec["file"], out / names[rec["_vol"] - 1]
        size, n, per_zoom, top, fsize, fn = copy_archive(src / rel, folder / rel, a.max_zoom, areas)
        native = max(native, top)
        side = {k: rec["_side"][k] for k in SIDECAR_KEEP if k in rec["_side"]}
        side.update({"file": Path(rel).name, "bytes": size, "tiles": n, "per_zoom": per_zoom, "zmax": min(a.max_zoom, top)})
        (folder / rel).with_suffix(".json").write_text(json.dumps(side))
        sizes[rec["_vol"]] = sizes.get(rec["_vol"], 0) + size + fsize + len(json.dumps(side))
        prefix = "" if rec["_vol"] == 1 else f"../{names[rec['_vol'] - 1]}/"
        rec.update({"file": prefix + rel, "bytes": size, "tiles": n})
        rec.pop("fine", None)
        if fn:
            rec["fine"] = prefix + str(Path(rel).with_suffix(".fine.pmtiles"))
            fine_bytes, fine_count, fine_layers = fine_bytes + fsize, fine_count + fn, fine_layers + 1
        del rec["_vol"], rec["_side"]
        if (i + 1) % 25 == 0 or i + 1 == len(records):
            print(f"  {i + 1}/{len(records)} archives  [{time.time() - t0:.0f} s]", flush=True)

    cat["zoom"] = {"min": cat["zoom"]["min"], "max": min(a.max_zoom, native), "native": native}
    cat["copy"] = {"kind": "preview", "of_version": cat["version"], "made": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "sites": names}
    cat.pop("fine", None)
    if fine_count:
        cat["fine"] = {"zoom": native, "areas": areas}

    # the background layer travels as it is, in the first folder
    block_file = src / "background" / "background.json"
    bg = cat.get("background") or (json.loads(block_file.read_text()) if block_file.exists() else None)
    if bg:
        for ly in bg["layers"].values():
            (out / names[0] / ly["file"]).parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(src / ly["file"], out / names[0] / ly["file"])
            sizes[1] = sizes.get(1, 0) + ly["bytes"]
        cat["background"] = bg
    (out / names[0] / "catalog.json").write_text(json.dumps(cat, separators=(",", ":")))

    first, last = cat["record"]["first"], cat["record"]["last"]
    fine_words = (f"{len(areas)} small area{'s' if len(areas) > 1 else ''} ({', '.join(ar['name'] for ar in areas)}) keep the native "
                  f"zoom {native} in the `*.fine.pmtiles` files; outside their outlines those tiles repeat zoom {cat['zoom']['max']}.\n"
                  if fine_count else "")
    for k, name in enumerate(names, 1):
        folder = out / name
        (folder / ".nojekyll").write_text("")
        bg_words = (f"\n`background/` holds a different product, {bg['name']} ({bg['long']}), as a coarse backdrop for the rest of the\n"
                    "globe. It is not Prithvi-OpenET-Tower output.\n" if bg and k == 1 else "")
        (folder / "README.md").write_text(
            f"# Prithvi-OpenET-Tower browse tiles — public preview, part {k} of {len(names)}\n\n"
            f"Numeric map tiles for the [Prithvi-OpenET-Tower data portal]({a.portal}): 30 m monthly\n"
            f"evapotranspiration of the Korean Peninsula, {first} to {last}, reduced to zoom {cat['zoom']['min']}–{cat['zoom']['max']}\n"
            f"so that it fits on GitHub Pages. The full set goes to zoom {native} (30 m).\n{fine_words}\n"
            "One PMTiles file per month (`monthly/`) and per climatology layer (`clim/`). A tile is an 8-bit\n"
            "grayscale PNG that holds values, not colours: `value = DN × dn_step`, `DN 255 = no data`.\n"
            "These tiles are for looking, not for analysis — they are resampled to Web Mercator, averaged and\n"
            f"rounded. Use the GeoTIFFs for any calculation; they will be released with the paper.\n{bg_words}\n"
            f"Made by `pipeline/make_preview_copy.py` of the portal repository from data version `{cat['version']}`.\n"
            "Do not edit by hand: rebuild and replace.\n\n"
            "HydroAI Lab, Gwangju Institute of Science and Technology — hyunglokkim@gist.ac.kr\n")
        (folder / "index.html").write_text(
            '<!DOCTYPE html><html lang="en"><meta charset="utf-8"><title>Prithvi-OpenET-Tower browse tiles</title>'
            '<meta name="robots" content="noindex">'
            f'<p style="font:16px/1.5 system-ui;margin:3em auto;max-width:34em;padding:0 1em">Map tiles for the '
            f'<a href="{a.portal}">Prithvi-OpenET-Tower data portal</a>. There is nothing to browse here.</p></html>\n')
        print(f"  {name}: {sizes.get(k, 0) / 1e6:.0f} MB")
    if fine_count:
        print(f"native detail kept in {len(areas)} area(s): {fine_count} tiles in {fine_layers} archives, {fine_bytes / 1e6:.1f} MB")
    if bg:
        print(f"background layer carried over: {bg['name']}, {sum(ly['bytes'] for ly in bg['layers'].values()) / 1e6:.1f} MB")
    print(f"zoom {cat['zoom']['min']}–{cat['zoom']['max']} of {native}, {len(records)} archives in {len(names)} folder(s), "
          f"{sum(sizes.values()) / 1e9:.2f} GB, {time.time() - t0:.0f} s → {out}")


if __name__ == "__main__":
    main()
