#!/bin/zsh
# Install (copy) the Claude Bridge CEP panel into Premiere's user extensions folder.
# Does NOT change PlayerDebugMode: unsigned panels need it, and that's a setting you run yourself:
#     defaults write com.adobe.CSXS.12 PlayerDebugMode 1
# Premiere Pro 2026 uses CEP 12 (CSXS.12). Restart Premiere after installing or changing the setting.
set -e
SRC="${0:A:h:h}/cep"
DEST="$HOME/Library/Application Support/Adobe/CEP/extensions/com.chrismorris.claude-premiere-bridge"
mkdir -p "$(dirname "$DEST")"
if [[ -L "$DEST" || -e "$DEST" ]]; then rm -rf "$DEST"; fi
cp -R "$SRC" "$DEST"
echo "Installed: $DEST -> $SRC"
MODE="$(defaults read com.adobe.CSXS.12 PlayerDebugMode 2>/dev/null || echo unset)"
echo "com.adobe.CSXS.12 PlayerDebugMode = $MODE"
if [[ "$MODE" != "1" ]]; then
  echo
  echo "Unsigned panels are disabled. Run this yourself, then restart Premiere Pro:"
  echo "    defaults write com.adobe.CSXS.12 PlayerDebugMode 1"
fi
echo "Then in Premiere: Window > Extensions > Claude Bridge."
