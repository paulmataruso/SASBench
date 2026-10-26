#!/usr/bin/env bash
# Builds the bundled offline basemap (web/public/basemap/north-america.json) from Natural Earth
# vector data (public domain, https://www.naturalearthdata.com). Only needed when changing the
# basemap; the generated file is committed.
#
#   scripts/build-basemap.sh                 # downloads Natural Earth v5.1.2 GeoJSON (~130 MB)
#   NE_DIR=/path/to/geojson scripts/build-basemap.sh   # reuse an existing download
#
# Requires Node.js and network access for the download and for `npx mapshaper`.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NE_VERSION="v5.1.2"
MAPSHAPER="${MAPSHAPER:-npx --yes mapshaper@0.7.98}"
OUT="$ROOT/web/public/basemap/north-america.json"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
NE_DIR="${NE_DIR:-$WORK/ne}"
mkdir -p "$NE_DIR" "$WORK/layers"

# CBRS territory: contiguous US, Alaska, Hawaii, Puerto Rico (plus neighbours for context).
BBOX="-170,15,-50,72"

for f in ne_50m_land ne_10m_land ne_10m_admin_0_boundary_lines_land ne_10m_admin_1_states_provinces_lines \
         ne_10m_lakes ne_10m_roads ne_10m_urban_areas ne_10m_populated_places_simple; do
  if [ ! -s "$NE_DIR/$f.geojson" ]; then
    echo "downloading $f"
    curl -sfL -o "$NE_DIR/$f.geojson" "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/$NE_VERSION/geojson/$f.geojson"
  fi
done

L="$WORK/layers"
# World land at low zoom, detailed land/water/lines inside the CBRS bounding box.
$MAPSHAPER "$NE_DIR/ne_50m_land.geojson" -simplify 12% keep-shapes -o "$L/land50.json" format=geojson precision=0.02
$MAPSHAPER "$NE_DIR/ne_10m_land.geojson" -clip bbox=$BBOX -simplify 12% keep-shapes -filter-slivers -o "$L/land10.json" format=geojson precision=0.002
$MAPSHAPER "$NE_DIR/ne_10m_admin_0_boundary_lines_land.geojson" -clip bbox=$BBOX -simplify 15% -filter-fields -o "$L/borders.json" format=geojson precision=0.002
$MAPSHAPER "$NE_DIR/ne_10m_admin_1_states_provinces_lines.geojson" -filter '["USA","CAN","MEX"].indexOf(ADM0_A3) > -1' \
  -clip bbox=$BBOX -simplify 12% -filter-fields -o "$L/states.json" format=geojson precision=0.002
$MAPSHAPER "$NE_DIR/ne_10m_lakes.geojson" -clip bbox=$BBOX -filter 'scalerank <= 8' -simplify 15% keep-shapes -filter-fields \
  -o "$L/lakes.json" format=geojson precision=0.002
$MAPSHAPER "$NE_DIR/ne_10m_roads.geojson" -filter 'continent == "North America" && (type == "Major Highway" || type == "Secondary Highway")' \
  -clip bbox=$BBOX -simplify 6% -each 'm = type == "Major Highway" ? 1 : 0' -dissolve m -o "$L/roads.json" format=geojson precision=0.003
$MAPSHAPER "$NE_DIR/ne_10m_urban_areas.geojson" -clip bbox=$BBOX -simplify 10% keep-shapes -filter-slivers -filter-fields \
  -o "$L/urban.json" format=geojson precision=0.002
# z = Natural Earth's suggested minimum zoom for the label, p = population.
$MAPSHAPER "$NE_DIR/ne_10m_populated_places_simple.geojson" \
  -filter '["USA","CAN","MEX","PRI"].indexOf(adm0_a3) > -1 && (pop_max >= 25000 || /capital/i.test(featurecla))' \
  -clip bbox=$BBOX -each 'z=min_zoom, p=pop_max' -filter-fields name,z,p -o "$L/places.json" format=geojson precision=0.001

node -e '
const fs = require("fs"), path = require("path");
const [dir, out, version] = process.argv.slice(1);
const layers = {};
for (const n of ["land50", "land10", "borders", "states", "lakes", "roads", "urban", "places"]) layers[n] = JSON.parse(fs.readFileSync(path.join(dir, n + ".json"), "utf8"));
fs.writeFileSync(out, JSON.stringify({ source: "Natural Earth " + version + " (public domain), naturalearthdata.com", layers }));
' "$L" "$OUT" "$NE_VERSION"
echo "wrote $OUT ($(du -h "$OUT" | cut -f1))"
