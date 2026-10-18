#!/bin/zsh
# Build dist/Premiere Bridge.mcpb (the Claude Desktop extension). The CEP panel is installed separately by tools/install-panel.sh.
set -e
cd "${0:A:h}"
npm install --omit=dev --silent
npx --yes @anthropic-ai/mcpb@2.1.2 validate manifest.json
mkdir -p dist
npx --yes @anthropic-ai/mcpb@2.1.2 pack . "dist/Premiere Bridge.mcpb" | tail -4
