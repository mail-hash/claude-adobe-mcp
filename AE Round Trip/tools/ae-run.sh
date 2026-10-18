#!/bin/zsh
# Run one of the round-trip scripts inside After Effects via osascript and print its result.
#
#   tools/ae-run.sh "Export Comp.jsx"   '{"comp":"My Comp","out":"/path/My Comp.json"}'
#   tools/ae-run.sh "Apply Changes.jsx" '{"in":"/path/My Comp.json"}'
#   tools/ae-run.sh "Rebuild Comp.jsx"  '{"in":"/path/My Comp.json"}'
#
# The JSON argument becomes $.global.RT_ARGS, which also suppresses dialogs.
# AE_APP overrides the application name (default: Adobe After Effects 2026).
set -e
HERE="${0:A:h:h}"
SCRIPT="$1"; ARGS="${2:-{\}}"
[[ "$SCRIPT" = /* ]] || SCRIPT="$HERE/$SCRIPT"
AE_APP="${AE_APP:-Adobe After Effects 2026}"

TMP="$(mktemp -d)"
RUNNER="$TMP/runner.jsx"; OUT="$TMP/result.txt"
cat > "$RUNNER" <<EOF
(function () {
  \$.global.RT_ARGS = $ARGS;
  var r;
  try { r = \$.evalFile(File("$SCRIPT")); }
  catch (e) { r = '{"ok": false, "error": "' + String(String(e) + " (line " + e.line + ")").replace(/\\\\/g, "\\\\\\\\").replace(/"/g, '\\\\"') + '"}'; }
  try { delete \$.global.RT_ARGS; } catch (e2) {}
  var f = File("$OUT"); f.encoding = "UTF-8"; f.lineFeed = "Unix"; f.open("w"); f.write(String(r)); f.close();
})();
EOF
osascript -e "with timeout of 3600 seconds" -e "tell application \"$AE_APP\" to DoScriptFile \"$RUNNER\"" -e "end timeout" >/dev/null
cat "$OUT"; echo
rm -rf "$TMP"
