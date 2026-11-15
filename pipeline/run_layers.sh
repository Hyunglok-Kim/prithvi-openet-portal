#!/usr/bin/env bash
# Build browse tiles for a set of layers in parallel, then refresh catalog.json.
#
#   run_layers.sh clim            2016-2024 monthly climatology + annual total (native grid), then their tiles
#   run_layers.sh months 2021     monthly tiles for every month of the given year(s)
#   run_layers.sh catalog         only rebuild catalog.json
#
# Environment: ROOT (work folder: gets out/ work/ logs/, expects venv/bin/python), SRC_ROOT (dataset with
# et_30m/{YYYY}/KP_ET30m_{YYYYMM}.tif and SHA256SUMS), PAR (parallel tile jobs), THREADS (warp threads per job).
# ROOT and SRC_ROOT may also be set in an untracked local.env next to this script.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
[ -f "$HERE/local.env" ] && . "$HERE/local.env"
ROOT=${ROOT:?set ROOT to the work folder (or put it in local.env)}
SRC_ROOT=${SRC_ROOT:?set SRC_ROOT to the dataset folder (or put it in local.env)}
PAR=${PAR:-13}
THREADS=${THREADS:-6}
PY=$ROOT/venv/bin/python
OUT=$ROOT/out
WORK=$ROOT/work
mkdir -p "$OUT/monthly" "$OUT/clim" "$WORK/clim" "$ROOT/logs"

tile_jobs() {   # reads "id|src|outdir|dn_step|units|kind" lines on stdin
  xargs -P "$PAR" -I{} bash -c '
    IFS="|" read -r id src outdir step units kind <<< "{}"
    "'"$PY"'" "'"$HERE"'/build_tiles.py" --src "$src" --id "$id" \
        --out "'"$OUT"'/$outdir/KP_ET_${id#et_}.pmtiles" --stats "'"$OUT"'/$outdir/KP_ET_${id#et_}.json" \
        --dn-step "$step" --units "$units" --threads "'"$THREADS"'" --meta kind="$kind" \
        > "'"$ROOT"'/logs/tiles_$id.log" 2>&1 && echo "ok   $id" || echo "FAIL $id"'
}

case "${1:-}" in
  clim)
    "$PY" "$HERE/build_clim.py" --src-dir "$SRC_ROOT/et_30m" --out-dir "$WORK/clim" --years "${2:-2016-2024}" \
        --procs 12 2>&1 | tee "$ROOT/logs/clim.log"
    { for m in 01 02 03 04 05 06 07 08 09 10 11 12; do
        echo "clim_$m|$WORK/clim/clim_$m.tif|clim|1|mm/month|clim_month"; done
      echo "clim_annual|$WORK/clim/clim_annual.tif|clim|${ANNUAL_STEP:-6}|mm/year|clim_annual"; } | tile_jobs
    ;;
  months)
    shift
    for y in "$@"; do
      for f in "$SRC_ROOT/et_30m/$y"/KP_ET30m_"$y"??.tif; do
        ym=$(basename "$f" .tif); ym=${ym#KP_ET30m_}
        echo "et_$ym|$f|monthly|1|mm/month|monthly"
      done
    done | tile_jobs
    ;;
  catalog) ;;
  *) echo "usage: $0 clim [years] | months YEAR... | catalog" >&2; exit 2 ;;
esac

"$PY" "$HERE/make_catalog.py" --out-dir "$OUT" --src-root "$SRC_ROOT"
