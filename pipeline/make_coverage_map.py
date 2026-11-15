#!/usr/bin/env python3
"""Draw assets/coverage-world.svg: a small fixed world map on which only the regions that have
ready-made maps are coloured. Every other land area is grey.

    python pipeline/make_coverage_map.py \\
        --region "Korean Peninsula=/path/to/out/clim/KP_ET_clim_annual.pmtiles" \\
        --out assets/coverage-world.svg

Give one --region for each area that has data, as NAME=FILE, where FILE is any PMTiles file of
that area made by build_tiles.py (the gap-free annual layer is the best choice). The outline of a
region is read from the tiles themselves — the pixels that hold a value — so the picture shows where
data exists, not a box around it. Run it again whenever a region is added, and bump the `?v=` on
the image in index.html.

The picture is deliberately not a map you can use: it is an Equal Earth world map (equal-area, so
a region's size on it is honest) without Antarctica, drawn once and shipped as a file. A region too
small to see at this size gets a ring around it.

Needs: python3, numpy, Pillow, pmtiles (pip).
"""
import argparse
import io
import json
import math
from html import escape
from pathlib import Path

import numpy as np
from PIL import Image
from pmtiles.reader import MmapSource, Reader

W = 720.0                       # width of the drawing in its own units; the page scales it
LAT_S, LAT_N = -58.0, 90.0      # no Antarctica: HLS does not cover it, so nothing can be requested there
OCEAN, LAND = "#E4E9EA", "#C4C1B6"
DATA, MARK = "#225EA8", "#B85434"     # the dark end of the map's colour ramp; the site's accent
LAND_TOL, LAND_MIN_AREA = 0.4, 0.6    # land outline: simplification tolerance and smallest island, in drawing units
FOOT_ZOOM, FOOT_MIN_PX = 5, 4.0       # a region's outline: tile zoom to read it at, smallest island in tile pixels
FOOT_TOL = 0.12                       # ... and its simplification tolerance, in drawing units
RING_BELOW, RING_MIN = 30.0, 22.0     # a region reaching less than RING_BELOW units from its centre gets a ring of at least RING_MIN
TILE = 256

# ── Equal Earth projection (Šavrič, Patterson and Jenny, 2018) ──
A1, A2, A3, A4 = 1.340264, -0.081106, 0.000893, 0.003796
M = math.sqrt(3) / 2


def equal_earth(lon, lat):
    lon, lat = np.radians(np.asarray(lon, float)), np.radians(np.asarray(lat, float))
    t = np.arcsin(M * np.sin(lat))
    t2 = t * t
    t6 = t2 * t2 * t2
    x = lon * np.cos(t) / (M * (A1 + 3 * A2 * t2 + t6 * (7 * A3 + 9 * A4 * t2)))
    y = t * (A1 + A2 * t2 + t6 * (A3 + A4 * t2))
    return x, y


X_MAX = float(equal_earth(180, 0)[0])
Y_TOP, Y_BOT = float(equal_earth(0, LAT_N)[1]), float(equal_earth(0, LAT_S)[1])
SCALE = W / (2 * X_MAX)
H = (Y_TOP - Y_BOT) * SCALE


def to_drawing(lon, lat):
    """Longitude and latitude in degrees → drawing coordinates (x right, y down), as an (n, 2) array."""
    x, y = equal_earth(lon, np.clip(lat, LAT_S, LAT_N))
    return np.column_stack(((x + X_MAX) * SCALE, (Y_TOP - y) * SCALE))


# ── geometry helpers ──
def ring_area(p):
    """Signed area of a closed ring given without the repeated last point."""
    x, y = p[:, 0], p[:, 1]
    return 0.5 * float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))


def simplify_line(p, tol):
    """Douglas-Peucker on an open line; keeps both ends."""
    keep = np.zeros(len(p), bool)
    keep[0] = keep[-1] = True
    stack = [(0, len(p) - 1)]
    while stack:
        a, b = stack.pop()
        if b <= a + 1:
            continue
        seg = p[b] - p[a]
        rel = p[a + 1:b] - p[a]
        n = math.hypot(seg[0], seg[1])
        d = np.hypot(rel[:, 0], rel[:, 1]) if n == 0 else np.abs(seg[0] * rel[:, 1] - seg[1] * rel[:, 0]) / n
        i = int(np.argmax(d))
        if d[i] > tol:
            keep[a + 1 + i] = True
            stack += [(a, a + 1 + i), (a + 1 + i, b)]
    return p[keep]


def simplify_ring(p, tol):
    """Douglas-Peucker on a closed ring (no repeated last point): split it at its two farthest-apart points."""
    if len(p) < 4:
        return p
    far = int(np.argmax(np.hypot(*(p - p[0]).T)))
    if far == 0:
        return p[:1]
    a = simplify_line(p[:far + 1], tol)
    b = simplify_line(np.vstack((p[far:], p[:1])), tol)
    return np.vstack((a[:-1], b[:-1]))


def num(v):
    """An integer number of tenths as the shortest SVG number: 25 → 2.5, 5 → .5, -5 → -.5, 30 → 3."""
    v = int(v)
    if v % 10 == 0:
        return str(v // 10)
    s = f"{v / 10:.1f}"
    return s[1:] if s.startswith("0.") else "-" + s[2:] if s.startswith("-0.") else s


def path_d(rings):
    """SVG path data, one decimal, relative moves. Deltas are taken between rounded points, so nothing drifts."""
    out = []
    for r in rings:
        q = np.round(r * 10).astype(int)
        q = q[np.r_[True, np.any(q[1:] != q[:-1], axis=1)]]          # points that rounded onto each other
        if len(q) > 1 and np.all(q[0] == q[-1]):
            q = q[:-1]
        if len(q) < 3:
            continue
        out.append(f"M{num(q[0, 0])} {num(q[0, 1])}l" + " ".join(f"{num(dx)} {num(dy)}" for dx, dy in np.diff(q, axis=0)) + "z")
    return "".join(out)


# ── land ──
def land_rings(path):
    geo = json.loads(Path(path).read_text())
    rings, n_in, n_out = [], 0, 0
    for f in geo["features"]:
        g = f["geometry"]
        polys = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
        for poly in polys:
            ext = np.asarray(poly[0], float)
            if ext[:, 1].max() < LAT_S:                      # Antarctica and the islands around it
                continue
            for k, ring in enumerate(poly):
                ll = np.asarray(ring, float)
                if len(ll) > 1 and np.all(ll[0] == ll[-1]):
                    ll = ll[:-1]
                p = to_drawing(ll[:, 0], ll[:, 1])
                n_in += len(p)
                if abs(ring_area(p)) < LAND_MIN_AREA:
                    if k == 0:
                        break                                 # an island too small to see: skip its holes as well
                    continue
                p = simplify_ring(p, LAND_TOL)
                if len(p) >= 3:
                    rings.append(p)
                    n_out += len(p)
    return rings, n_in, n_out


# ── footprint of a region, from its tiles ──
def tile_xy(lon, lat, z):
    n = 2 ** z
    s = math.sin(math.radians(lat))
    return (lon + 180) / 360 * n, (0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)) * n


def read_mask(pm_path):
    """Boolean mosaic of "this pixel holds a value" at a coarse zoom, with the zoom and the tile origin."""
    with open(pm_path, "rb") as f:
        rd = Reader(MmapSource(f))
        h = rd.header()
        z = min(max(h["min_zoom"], FOOT_ZOOM), h["max_zoom"])
        w, s, e, n = (h[k] / 1e7 for k in ("min_lon_e7", "min_lat_e7", "max_lon_e7", "max_lat_e7"))
        x0, y0 = (int(math.floor(v)) for v in tile_xy(w, n, z))
        x1, y1 = (int(math.floor(v)) for v in tile_xy(e, s, z))
        x1, y1 = min(x1, 2 ** z - 1), min(y1, 2 ** z - 1)
        mask = np.zeros(((y1 - y0 + 1) * TILE, (x1 - x0 + 1) * TILE), bool)
        for ty in range(y0, y1 + 1):
            for tx in range(x0, x1 + 1):
                data = rd.get(z, tx, ty)
                if not data:
                    continue
                a = np.array(Image.open(io.BytesIO(data)))
                mask[(ty - y0) * TILE:(ty - y0 + 1) * TILE, (tx - x0) * TILE:(tx - x0 + 1) * TILE] = a != 255
    return mask, z, x0, y0


def trace(mask):
    """Outlines of the True cells as closed rings of cell-corner coordinates (x, y)."""
    m = np.pad(mask, 1)
    nxt = {}
    for r, c in zip(*np.nonzero(mask)):
        r, c = int(r), int(c)
        if not m[r, c + 1]:
            nxt.setdefault((c, r), []).append((c + 1, r))                 # top side, walking east
        if not m[r + 1, c + 2]:
            nxt.setdefault((c + 1, r), []).append((c + 1, r + 1))         # right side, walking south
        if not m[r + 2, c + 1]:
            nxt.setdefault((c + 1, r + 1), []).append((c, r + 1))         # bottom side, walking west
        if not m[r + 1, c]:
            nxt.setdefault((c, r + 1), []).append((c, r))                 # left side, walking north
    rings = []
    while nxt:
        start = next(iter(nxt))
        ring, v = [start], start
        while True:
            ends = nxt[v]
            w = ends.pop()
            if not ends:
                del nxt[v]
            if w == start:
                break
            ring.append(w)
            v = w
        rings.append(np.asarray(ring, float))
    return rings


def region_shape(pm_path):
    """Outline rings of a region in drawing coordinates, its centre (mean of the pixels with data) and its reach from there."""
    mask, z, x0, y0 = read_mask(pm_path)
    if not mask.any():
        raise SystemExit(f"{pm_path}: no pixel with a value at zoom {z}")
    n = TILE * 2 ** z

    def pixels_to_drawing(px, py):                                         # pixel coordinates in the mosaic → drawing
        gx, gy = np.asarray(px, float) + x0 * TILE, np.asarray(py, float) + y0 * TILE
        return to_drawing(gx / n * 360 - 180, np.degrees(np.arctan(np.sinh(math.pi * (1 - 2 * gy / n)))))

    rings = []
    for ring in trace(mask):
        if abs(ring_area(ring)) < FOOT_MIN_PX:
            continue
        ring = simplify_ring(pixels_to_drawing(ring[:, 0], ring[:, 1]), FOOT_TOL)
        if len(ring) >= 3:
            rings.append(ring)
    if not rings:
        raise SystemExit(f"{pm_path}: the region is smaller than {FOOT_MIN_PX:.0f} pixels at zoom {z}")
    rows, cols = np.nonzero(mask)
    centre = pixels_to_drawing([cols.mean() + 0.5], [rows.mean() + 0.5])[0]
    reach = float(np.hypot(*(np.vstack(rings) - centre).T).max())
    return rings, centre, reach, int(mask.sum()), z


def main():
    here = Path(__file__).resolve().parent.parent
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--region", action="append", required=True, metavar="NAME=FILE", help="a region with data and one of its PMTiles files; repeat for more regions")
    ap.add_argument("--land", default=str(here / "assets" / "land-50m.json"), help="land outline, GeoJSON cut at the antimeridian")
    ap.add_argument("--out", default=str(here / "assets" / "coverage-world.svg"))
    a = ap.parse_args()

    land, n_in, n_out = land_rings(a.land)
    lat = np.linspace(LAT_N, LAT_S, 75)
    frame = np.vstack((to_drawing(np.full_like(lat, -180), lat), to_drawing(np.full_like(lat, 180), lat[::-1])))

    names, groups = [], []
    for spec in a.region:
        name, _, pm = spec.partition("=")
        if not name or not pm:
            raise SystemExit(f"--region needs NAME=FILE, got {spec!r}")
        rings, c, reach, px, z = region_shape(pm)
        names.append(name)
        g = [f'<g data-region="{escape(name, quote=True)}">']
        small = reach < RING_BELOW
        r = max(reach * 1.25, RING_MIN)
        if small:
            g.append(f'<circle cx="{c[0]:.1f}" cy="{c[1]:.1f}" r="{r:.1f}" fill="{MARK}" fill-opacity=".16"/>')
        g.append(f'<path fill="{DATA}" fill-rule="evenodd" d="{path_d(rings)}"/>')
        if small:
            g.append(f'<circle cx="{c[0]:.1f}" cy="{c[1]:.1f}" r="{r:.1f}" fill="none" stroke="{MARK}" stroke-width="3"/>')
        g.append("</g>")
        groups.append("".join(g))
        print(f"{name}: {px} pixels with data at zoom {z}, {len(rings)} outline(s), centre {c[0]:.1f}, {c[1]:.1f}, "
              f"reach {reach:.1f} units{f' → ring of {r:.1f}' if small else ''}")

    listed = escape(names[0] if len(names) == 1 else ", ".join(names[:-1]) + " and " + names[-1])
    svg = "\n".join([
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W:.0f} {H:.1f}" width="{W:.0f}" height="{H:.0f}" role="img">',
        f"<title>Where 30 m ET maps are ready: {listed}</title>",
        f"<desc>World map in the Equal Earth projection, without Antarctica. Regions with ready-made maps are coloured ({listed}); "
        "all other land is grey. Made by pipeline/make_coverage_map.py; land outline from Natural Earth.</desc>",
        f'<path fill="{OCEAN}" d="{path_d([frame])}"/>',
        f'<path fill="{LAND}" fill-rule="evenodd" d="{path_d(land)}"/>',
        *groups,
        "</svg>", ""])
    Path(a.out).write_text(svg, encoding="utf-8")
    print(f"land: {n_in} → {n_out} points in {len(land)} rings · drawing {W:.0f} × {H:.1f} · wrote {a.out} ({len(svg) / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
