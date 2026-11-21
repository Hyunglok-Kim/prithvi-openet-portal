#!/usr/bin/env bash
# Build browse tiles for a set of layers in parallel, then refresh catalog.json.
#
#   run_layers.sh clim            2016-2024 monthly climatology + annual total (native grid), then their tiles
#   run_layers.sh months 2021     monthly tiles for every month of the given year(s)
#   run_layers.sh catalog         only rebuild catalog.json
#
# Environment: ROOT (work folder: gets out/ work/ logs/, expects venv/bin/python), SRC_ROOT (dataset with
# et_30m/{YYYY}/<PREFIX>_ET30m_{YYYYMM}.tif and SHA256SUMS), PAR (parallel tile jobs), THREADS (warp threads per job).
# ROOT and SRC_ROOT may also be set in an untracked local.env next to this script.
#
# One region per run. The first region (the Korean Peninsula) needs nothing more: its tiles sit directly in
# out/. Any other region is chosen with REGION=<id>. Its settings are read from local.<id>.env next to this
# script, after local.env; its tiles go to out/<id>/, its work files to work/<id>/ and its logs to logs/<id>/.
# A region's settings file may set
#   SRC_ROOT       that region's dataset folder
#   PREFIX         how its files are named: FR for FR_ET30m_202107.tif -> FR_ET_202107.pmtiles (default KP)
#   CATALOG_ARGS   a bash array of further arguments for make_catalog.py: the region's id and names (see there)
# After a run for another region, run "run_layers.sh catalog" once without REGION as well: the first
# region's catalog is the one the portal opens, and it lists the others.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
CATALOG_ARGS=()
[ -f "$HERE/local.env" ] && . "$HERE/local.env"
REGION=${REGION:-}
if [ -n "$REGION" ]; then
  [ -f "$HERE/local.$REGION.env" ] || { echo "no settings for region '$REGION': expected $HERE/local.$REGION.env" >&2; exit 2; }
  . "$HERE/local.$REGION.env"
fi
ROOT=${ROOT:?set ROOT to the work folder (or put it in local.env)}
SRC_ROOT=${SRC_ROOT:?set SRC_ROOT to the dataset folder (or put it in local.env)}
PREFIX=${PREFIX:-KP}
PAR=${PAR:-13}
THREADS=${THREADS:-6}
PY=$ROOT/venv/bin/python
OUT=$ROOT/out${REGION:+/$REGION}
WORK=$ROOT/work${REGION:+/$REGION}
LOGS=$ROOT/logs${REGION:+/$REGION}
mkdir -p "$OUT/monthly" "$OUT/clim" "$WORK/clim" "$LOGS"

tile_jobs() {   # reads "id|src|outdir|dn_step|units|kind" lines on stdin
  xargs -P "$PAR" -I{} bash -c '
    IFS="|" read -r id src outdir step units kind <<< "{}"
    "'"$PY"'" "'"$HERE"'/build_tiles.py" --src "$src" --id "$id" \
        --out "'"$OUT"'/$outdir/'"$PREFIX"'_ET_${id#et_}.pmtiles" --stats "'"$OUT"'/$outdir/'"$PREFIX"'_ET_${id#et_}.json" \
        --dn-step "$step" --units "$units" --threads "'"$THREADS"'" --meta kind="$kind" \
        > "'"$LOGS"'/tiles_$id.log" 2>&1 && echo "ok   $id" || echo "FAIL $id"'
}

case "${1:-}" in
  clim)
    "$PY" "$HERE/build_clim.py" --src-dir "$SRC_ROOT/et_30m" --out-dir "$WORK/clim" --years "${2:-2016-2024}" \
        --prefix "${PREFIX}_ET30m_" --procs "${CLIM_PROCS:-12}" 2>&1 | tee "$LOGS/clim.log"
    { for m in 01 02 03 04 05 06 07 08 09 10 11 12; do
        echo "clim_$m|$WORK/clim/clim_$m.tif|clim|1|mm/month|clim_month"; done
      echo "clim_annual|$WORK/clim/clim_annual.tif|clim|${ANNUAL_STEP:-6}|mm/year|clim_annual"; } | tile_jobs
    ;;
  months)
    shift
    for y in "$@"; do
      for f in "$SRC_ROOT/et_30m/$y"/"${PREFIX}"_ET30m_"$y"??.tif; do
        ym=$(basename "$f" .tif); ym=${ym#"${PREFIX}"_ET30m_}
        echo "et_$ym|$f|monthly|1|mm/month|monthly"
      done
    done | tile_jobs
    ;;
  catalog) ;;
  *) echo "usage: [REGION=id] $0 clim [years] | months YEAR... | catalog" >&2; exit 2 ;;
esac

"$PY" "$HERE/make_catalog.py" --out-dir "$OUT" --src-root "$SRC_ROOT" ${CATALOG_ARGS[@]+"${CATALOG_ARGS[@]}"}
