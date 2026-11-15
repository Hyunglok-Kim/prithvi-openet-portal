#!/usr/bin/env python3
"""Write tests/tile_ref.json: checksums of a few tiles read straight from the PMTiles files.

Run where the tiles are (needs pmtiles, numpy and Pillow):

    python make_tile_ref.py /path/to/workdir/out > tile_ref.json

tests/smoke.py --ref compares what the browser decodes against these numbers, pixel for pixel.
Regenerate after the tiles for these layers are rebuilt with a different method.
"""
import io
import json
import sys

import numpy as np
from PIL import Image
from pmtiles.reader import MmapSource, Reader

TILES = [("clim/KP_ET_clim_annual.pmtiles", 8, 218, 99),       # mid-zoom, central Korea
         ("monthly/KP_ET_202107.pmtiles", 12, 3492, 1586),     # native zoom, a monsoon month with gaps
         ("monthly/KP_ET_202107.pmtiles", 5, 27, 12)]          # overview, mostly sea

root, out = sys.argv[1].rstrip("/"), {}
for name, z, x, y in TILES:
    with open(f"{root}/{name}", "rb") as f:
        data = Reader(MmapSource(f)).get(z, x, y)
    a = np.array(Image.open(io.BytesIO(data)))
    out[f"{name}|{z}/{x}/{y}"] = {"sum": int(a.astype(np.int64).sum()), "n255": int((a == 255).sum()),
                                  "px": [int(a[10, 10]), int(a[128, 128]), int(a[50, 200]), int(a[255, 0])]}
print(json.dumps(out, indent=1))
