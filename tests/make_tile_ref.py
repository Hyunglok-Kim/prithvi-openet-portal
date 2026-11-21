#!/usr/bin/env python3
"""Write tests/tile_ref.json: checksums of a few tiles read straight from the PMTiles files.

Run where the full tile set is (needs pmtiles, numpy and Pillow):

    python make_tile_ref.py /path/to/workdir/out > tile_ref.json

tests/smoke.py --ref compares what the browser decodes against these numbers, pixel for pixel.
Regenerate after the tiles for these layers are rebuilt with a different method.

Two kinds of entry:
  "file|z/x/y"                 a whole tile: sum, count of no-data pixels, four fixed pixels
  "file|z/x/y|row,col,h,w"     a window of a native-zoom tile, placed inside one of the areas that
                               the public preview keeps at 30 m. A reduced copy holds that tile only
                               in part (outside the area's outline its pixels are coarser), so the
                               check is on the window, where the numbers must be the full set's.
"""
import io
import json
import math
import os
import sys

import numpy as np
from PIL import Image
from pmtiles.reader import MmapSource, Reader

TILES = [("clim/KP_ET_clim_annual.pmtiles", 8, 218, 99),       # mid-zoom, central Korea
         ("monthly/KP_ET_202107.pmtiles", 12, 3492, 1586),     # native zoom, a monsoon month with gaps
         ("monthly/KP_ET_202107.pmtiles", 5, 27, 12),          # overview, mostly sea
         # a second region, in its folder inside the set (left out when the set has none): the test then also
         # shows that a tile is read from the region it lies in
         ("fr/clim/FR_ET_clim_annual.pmtiles", 8, 129, 90),    # mid-zoom, central France
         ("fr/monthly/FR_ET_202107.pmtiles", 10, 519, 361),    # the finest level of a reduced copy, the Massif Central
         ("fr/monthly/FR_ET_202107.pmtiles", 5, 16, 11)]       # overview: most of France in one tile
WINDOWS = [("clim/KP_ET_clim_annual.pmtiles", 12, 127.24966, 38.20140),     # the middle of the Cheorwon area
           ("monthly/KP_ET_202107.pmtiles", 12, 126.35914, 36.50566)]       # the middle of the Anmyeon area
WIN = 32                                                       # window size, px (about 1 km: well inside a 6.7 km area)


def read(root, name, z, x, y):
    with open(f"{root}/{name}", "rb") as f:
        data = Reader(MmapSource(f)).get(z, x, y)
    return np.array(Image.open(io.BytesIO(data)))


root, out = sys.argv[1].rstrip("/"), {}
for name, z, x, y in TILES:
    if not os.path.exists(f"{root}/{name}"):
        continue
    a = read(root, name, z, x, y)
    out[f"{name}|{z}/{x}/{y}"] = {"sum": int(a.astype(np.int64).sum()), "n255": int((a == 255).sum()),
                                  "px": [int(a[10, 10]), int(a[128, 128]), int(a[50, 200]), int(a[255, 0])]}
for name, z, lon, lat in WINDOWS:
    n = 256 * 2 ** z
    px, py = (lon + 180) / 360 * n, (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n
    x, y = int(px // 256), int(py // 256)
    c0 = min(256 - WIN, max(0, int(px) - x * 256 - WIN // 2))
    r0 = min(256 - WIN, max(0, int(py) - y * 256 - WIN // 2))
    w = read(root, name, z, x, y)[r0:r0 + WIN, c0:c0 + WIN]
    out[f"{name}|{z}/{x}/{y}|{r0},{c0},{WIN},{WIN}"] = {"sum": int(w.astype(np.int64).sum()), "n255": int((w == 255).sum())}
print(json.dumps(out, indent=1))
