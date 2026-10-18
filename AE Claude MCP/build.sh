#!/bin/zsh
# Build "dist/AE Round Trip.mcpb": stages the ExtendScript files from ../AE Round Trip into server/ae,
# installs production dependencies and packs the bundle. Usage: ./build.sh [path/to/AE Round Trip]
set -e
HERE="${0:A:h}"
SRC="${1:-$HERE/../AE Round Trip}"
cd "$HERE"
[[ -f "$SRC/Export Comp.jsx" ]] || { echo "Round-trip scripts not found in $SRC"; exit 1; }
rm -rf server/ae && mkdir -p server/ae
cp "$SRC/Export Comp.jsx" "$SRC/Apply Changes.jsx" "$SRC/Rebuild Comp.jsx" server/ae/
cp -R "$SRC/lib" "$SRC/mcp" server/ae/
npm install --omit=dev --silent
npx --yes @anthropic-ai/mcpb@2.1.2 validate manifest.json
mkdir -p dist
npx --yes @anthropic-ai/mcpb@2.1.2 pack . "dist/AE Round Trip.mcpb"
