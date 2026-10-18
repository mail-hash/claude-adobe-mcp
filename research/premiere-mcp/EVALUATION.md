# Evaluation: three open-source "MCP server for Adobe Premiere Pro" repos

Target: Adobe Premiere Pro 2026 (v26.5.2), macOS Apple Silicon, CEPHtmlEngine 12.0.1.2 (CSXS 12), UXP plugins folder present.
Method: read-only source review on 2026-10-18. Nothing was installed, built or executed. All paths below are relative to
`/Users/christophermorris/Claude/Projects/AEImportExporttoClaude/research/premiere-mcp/`.

| | hetpatel-11 `Adobe_Premiere_Pro_MCP` | antipaster `Adobe-Premiere-Pro-MCP` | morim3 `mcp_adobe_premiere` |
|---|---|---|---|
| Last commit | 2026-10-13 (v1.2.9) | 2026-08-25 (PR #9 "fix/macos-arm64-extendscript-and-reconnect") | 2025-04-18 ("initial commit") |
| Panel | CEP (ExtendScript via `evalScript`); UXP panel shipped but non-functional | CEP (ExtendScript via `evalScript`), one `.jsx` per domain | UXP (`require('premierepro')` API, no ExtendScript) |
| Transport | File polling in a shared temp dir (`command-*.json` / `response-*.json` / heartbeat) | WebSocket, panel is client, server listens on `ws://localhost:8097` | WebSocket, panel is client, Python server listens on `ws://localhost:8765` |
| Server | Node/TS, `@modelcontextprotocol/server` v2, 283 tools (115 + 168 "expanded") | Node/TS, `@modelcontextprotocol/sdk` v1, ~170 tools | Python FastMCP, 3 umbrella tools (`manage_project`, `manage_sequence`, `manage_media`) |
| Tests | 32 Jest test files under `src/__tests__` | none | none |
| Phones home | Yes: telemetry (on by default, opt-out) + npm update check (server and panel) | Only ElevenLabs if the user configures an API key | No |
| Verdict for PPr 26 as-is | Most complete and the only one with 26.x-verified fixes, but heavy, telemetry-on, and file-polling adds latency | Cleanest bridge design; recently patched for 26.3.2 arm64; Windows-only installer; `import_media` not dialog-safe | Not usable (requires UXP Developer Tool, 2025-era UXP API, almost no tools) |

---

## 1. hetpatel-11 / `Adobe_Premiere_Pro_MCP`

### 1.1 Architecture

**Panel type.** CEP panel (`cep-plugin/`) running with Node enabled and mixed context:
`cep-plugin/CSXS/manifest.xml:22-25` -> `<CEFCommandLine><Parameter>--enable-nodejs</Parameter><Parameter>--mixed-context</Parameter>`.
Commands reach Premiere through `CSInterface.evalScript` (`cep-plugin/bridge-cep.js:668`).
A UXP panel (`uxp-plugin/`) is also shipped; see 1.7 — it cannot load.

**Transport: file polling, no sockets.** The MCP server (`src/bridge/index.ts`) writes a command file into a temp dir and waits for a response file; the panel polls the same dir every 250 ms.

- Server side, `src/bridge/index.ts:1164-1199`:
  ```ts
  const commandFile = join(this.tempDir, `command-${commandId}.json`);
  const responseFile = join(this.tempDir, `response-${commandId}.json`);
  const commandStaging = join(this.tempDir, `.tmp-${commandId}.json`);
  ...
  await fs.writeFile(commandStaging, JSON.stringify({ id: commandId, script: fullScript, timeoutMs, timestamp }));
  await fs.rename(commandStaging, commandFile);      // atomic publish
  return await this.waitForResponse(responseFile, timeoutMs);
  ```
- `waitForResponse` polls every 150 ms (`src/bridge/index.ts:1240-1276`), aborts early if the heartbeat file is stale (`BRIDGE_PANEL_ABSENT_MS`) and defaults to 60 s (`index.ts:1229`).
- Panel side, `cep-plugin/bridge-cep.js:728-737` (`startCommandPolling`, 250 ms `setInterval`, writes `bridge-heartbeat.json` each tick); `processCommandFile` at `:523-568`; response written atomically via `.part` + `renameSync` at `:517-521`.
- Temp dir: `PREMIERE_TEMP_DIR` env, default `/tmp/premiere-mcp-bridge` (`bridge-cep.js:211-217`, `scripts/install-macos.sh:26`). The MCP server falls back to a per-session `/tmp/premiere-bridge-<uuid>` when the env var is absent (`src/utils/security.ts:83-92`), which will not match the panel — the installer therefore writes `PREMIERE_TEMP_DIR` into `claude_desktop_config.json` (`install-macos.sh:101-107`).
- No host/port involved. Only outbound network is telemetry/update check (section 1.4).

**Who starts what.** The MCP client spawns `node dist/index.js` (or `premiere-pro-mcp` CLI, `src/cli.ts:58-61`). The user must open `Window > Extensions > MCP Bridge (CEP)`; the panel auto-starts polling on load (`bridge-cep.js:449-467` calls `startBridge()` in `init`). The server can also launch Premiere itself via `open -a` if it finds it under `/Applications` (`src/bridge/index.ts:962-1078`, `ensureHost` / `launchPremiere`).

**Command execution.** Every script is prefixed with a large ExtendScript "prelude" (`EXTENDSCRIPT_HELPERS`, `src/bridge/index.ts` ~lines 40-850) that defines `__mcpStringify`, `__mcpParse`, `__findSequence`, `__qeSequenceFor`, `__ticksToSeconds`, etc., then wrapped `(function(){ ... })();` (`index.ts:1138-1157`). The panel prepends its own copy of the JSON shim (`EXTENDSCRIPT_COMPAT_HELPERS`, `bridge-cep.js:11-209`) and runs `csInterface.evalScript(fullScript, cb)` (`bridge-cep.js:636-693`). Tool code is TypeScript template strings building ExtendScript (e.g. `src/tools/domains/tracks.ts:59-123`). Expanded tools (`src/tools/expanded.ts`) are one giant generated `switch` on tool name.

### 1.2 Premiere 26 compatibility signals

- CSXS: `RequiredRuntime Name="CSXS" Version="10.0"` and `Host Name="PPRO" Version="[14.0,99.9]"` (`cep-plugin/CSXS/manifest.xml:8,14`). Loads on CEP 12 (10.0 is a minimum). Manifest `Version="10.0"` at line 2.
- UXP manifest: `host.app = premierepro`, `minVersion 24.4.0`, `manifestVersion 5` (`uxp-plugin/manifest.json:5-8,22`).
- Explicit Premiere 26 handling in code:
  - `src/bridge/index.ts:373-385` `__activateSequenceForQE`: "Premiere 26: Sequence.openInTimeline is missing, and getSequenceAt throws 'Unknown error exception' for every index"; works around by `app.project.openSequence(id)` + `activeSequence =` + `$.sleep(250)`.
  - `src/bridge/index.ts:1978` "Premiere 2026 dropped getSequenceByID; iterate via __findSequence helper."
  - `src/tools/domains/tracks.ts:139` "Premiere 26 exposes no DOM trackCollection.deleteTrack".
  - `src/tools/domains/discovery.ts:460` "Premiere Pro 26.3 returns sequence.end as a plain tick string".
  - `src/tools/domains/audio.ts:309,354` calibration "empirical, Premiere Pro 2026 macOS".
  - `KNOWN_ISSUES.md:54,95,147` repeatedly says "verified live against 26.0.2"; `README.md:122` "tested on Premiere Pro 26.0".
  - `CHANGELOG.md:35-42` (1.2.7): QE enumeration broken on 26, `remove_effect*` tools deleted because "Premiere 26 has no effect-removal API".
  - `KNOWN_ISSUES.md:138-140`: the ExtendScript engine in 26 "ships no `JSON` object at all" — hence the prelude's own stringify/parse.
- `app.version` is read (`discovery.ts:347`, `expanded.ts:1151,1166`) but never gated on; no Apple Silicon / Rosetta notes anywhere.
- ExtendScript API reliance (all still present in 25/26 per their live sweeps, with caveats):
  - `app.project.importFiles(paths, suppressUI, bin, asNumberedStills)` — `media.ts:101`, `bridge/index.ts:1396+`.
  - `app.project.importAEComps` — **not used anywhere** (`grep importAEComps src` -> none).
  - `track.insertClip` / `track.overwriteClip` — `bridge/index.ts:1683-1695`, guarded: refuses insert if `insertClip` is not a function. Comment says both exist on 26.0.2.
  - `app.encoder.encodeSequence` — `export.ts:219-223`, requires an absolute `.epr` (string preset names silently fail).
  - `qeSequence.exportFramePNG/JPEG/Tiff` via QE (`export.ts:342-372`), handles the `.png.png` double-extension quirk.
  - `app.enableQE()` used in ~30 places; `qe.project.getActiveSequence()` and `getSequenceAt(i).guid` (`bridge/index.ts:360-394`).
  - `app.openDocument`, `app.newProject`, `app.project.saveAs` (`bridge/index.ts:1309-1358`).

### 1.3 Coverage of the required tool list

| Required capability | Status | Tool(s) / notes |
|---|---|---|
| Status incl. open modal detection | partial | `verify_premiere_connection` (`discovery.ts:47`), `get_premiere_state`, `ping` (8 s timeout, `expanded.ts:292`). **No modal detection**: only a heuristic — on timeout `import_media` adds a warning "Premiere may be showing a blocking modal dialog" (`media.ts:76-83`); known-dialog-prone calls are refused up-front (`bridge/index.ts:42,1406-1412` `UNSUPPORTED_MODAL_PRONE_IMPORT_EXTENSIONS`; EDL import blocked `media.ts:140`). `KNOWN_ISSUES.md:174`: "Unexpected host/OS dialogs ... cannot be globally suppressed". |
| open / save / save-as / new project | covered | `open_project`, `save_project`, `save_project_as`, `create_project` (`project.ts:21-42`, `bridge/index.ts:1293-1378`), `close_project` (expanded). |
| import files incl. FCP XML + missing media report | partial | `import_media`, `import_folder`, `import_fcp_xml` (`media.ts:88-136`, `importFiles([...], true, rootItem, false)`); `check_offline_media` / `get_offline_media` exist separately, but import does **not** return a missing-media list itself. |
| import AE comps via Dynamic Link, many per call | **missing** | no `importAEComps` anywhere. |
| list project items with ids/type/duration | covered | `list_project_items` (`discovery.ts:160-170`: `nodeId`, `type` bin/sequence/footage, `treePath`, `mediaPath`; sequence duration via `__ticksToSeconds(seq.end)`), `get_project_item_info`, `search_project_items`. |
| list sequences / get sequence with tracks + clips (frames and seconds) | partial | `list_sequences`, `get_active_sequence`, `list_sequence_tracks` (`discovery.ts:246-273`: `id: clip.nodeId`, `startTime/endTime/duration` in **seconds only**), `get_full_sequence_info` (`expanded.ts:1171-1174` via `sequenceStructure`). No frame-number output (`grep frames` only hits transitions/keyframes). |
| place clip (overwrite/insert, track type/index, start, in/out) | covered | `add_to_timeline` (`timeline.ts:12-25`: `insertMode`, `trackIndex`, `time`, `sourceInPoint/OutPoint`, `linkAudio`) and `add_to_timeline_batch` (`:27-41`, overwrite only). Track type is inferred from the item's media type (audio-only -> audio track), not a parameter. |
| replace clip keeping position/duration | covered | `replace_clip` (`timeline.ts:126-134`, impl `:859-990`: saves start/end/in/out, `remove(false,true)` + `overwriteClip` at saved start, restores in/out/end and Motion when `preserveEffects`). |
| remove clips in range | partial | `remove_from_timeline` is per clip id (`timeline.ts:43-51`, `clip.remove(isRipple, true)` at `:309`), `remove_selected_clips`, `select_clips_in_range` + `remove_selected_clips` would approximate a range. No direct "remove everything between t1 and t2". |
| set track enabled / add tracks | covered | `add_track` (QE `addTracks(...)`, `tracks.ts:55-124`), `add_tracks`, `mute_track`, `lock_track`, `toggle_track_visibility` (`tracks.ts:11-53`), `delete_track` (QE, active-sequence constraints). |
| export frame to PNG | covered | `export_frame` (`export.ts:340-372`, QE `exportFramePNG`), `capture_frame`. |
| render via AME preset to path with in/out | covered | `export_sequence` (`export.ts:200-240`, `app.encoder.encodeSequence`, requires `.epr`; `get_encoder_presets` scans AME preset folders), `add_to_render_queue`, `get_render_queue_status` (returns honest failure without AME, `KNOWN_ISSUES.md:120-132`). In/out via `set_sequence_in_out_points` + work-area args. |
| run arbitrary script | covered | `execute_extendscript` (`expanded.ts:278-284`, passed verbatim with `callerAuthored=true`), `evaluate_expression`, `execute_qe_script` is not present but `app.enableQE()` can be written inline. Note the panel `validateScript` (`bridge-cep.js:700-715`) rejects scripts containing `eval(`, `new Function(`, `require(`, `process.`, `__dirname`, `child_process`. |

Tool discovery: by default only 5 tools are advertised and the rest are reached via `search_tools` -> `invoke_tool` (`KNOWN_ISSUES.md:10`); `PREMIERE_MCP_TOOLSET=full` exposes all 283.

### 1.4 Safety: install scripts, telemetry

**`scripts/install-macos.sh`** (`:1-119`): requires Node 20+; `npm install` + `npm run build` unless `--skip-build`; `defaults write com.adobe.CSXS.12 PlayerDebugMode 1` (also `.11`, `.10`) at `:56-58`; `cp -R cep-plugin/. "$HOME/Library/Application Support/Adobe/CEP/extensions/MCPBridgeCEP/"` at `:65`; `mkdir -p /tmp/premiere-mcp-bridge`; rewrites `~/Library/Application Support/Claude/claude_desktop_config.json` adding `mcpServers["premiere-pro"] = { command: node, args: [dist/index.js], env: { PREMIERE_TEMP_DIR } }` (`:70-110`). No symlinks, no downloads, no sudo.
**`scripts/uninstall-macos.sh`**: `rm -rf` the extension dir and `/tmp/premiere-mcp-bridge`, removes the config entry, leaves PlayerDebugMode set (`:48`).
**`scripts/install-windows.ps1`**: `HKCU\Software\Adobe\CSXS.*` `PlayerDebugMode=1` (`:190-194`), copies the extension, no downloads.
**`src/cli.ts`**: `--install-cep` just shells to the above scripts (`:34-52`).

**Telemetry — ON by default, phones home.**
- Endpoint: `https://adobe-premiere-mcp-telemetry.hetkp8044.workers.dev/v1/event` (`src/utils/telemetry.ts:7-8`), POST JSON, 3 s abort (`:478-491`). Backend is the Cloudflare Worker in `telemetry/src/index.ts` writing to D1 (`:234-260`); schema in `telemetry/migrations/`.
- Events: `server_started` on every launch (`src/index.ts:223`), `tool_called` for every failure and the first success per tool per process (`telemetry.ts:389-422`).
- Payload fields (allow-listed at `telemetry.ts:102-119`): persistent `distinct_id` UUID stored at `~/.premiere-mcp-bridge/install-id` (`:439-467`), per-process `session_id`, package version, `os`, `arch`, Node version, `tool`, `success`, `duration_ms`, `error_kind`, `error_code`, `error_fields` (Zod field names), `error_detail` (error text with paths/filenames/emails stripped, 180 chars, dropped if a path remains, `:180-197`), `retry`, `status`. No tool arguments, project names or paths are sent by design; `PRIVACY.md:17-27` matches the code.
- Opt-out (`telemetry.ts:317-329`, `PRIVACY.md:31-40`): `PREMIERE_MCP_TELEMETRY=0`, or `DO_NOT_TRACK=1`, or `"telemetry": false` in `~/.premiere-mcp-bridge/config.json`, or the panel checkbox "Share anonymous usage data" (`cep-plugin/index.html:600-601`, `bridge-cep.js:841-849`). `PREMIERE_MCP_TELEMETRY=1` overrides `DO_NOT_TRACK`.
- Secondary phone-home: npm update check from the **server** (`src/utils/update-check.ts:6`, `registry.npmjs.org/adobe-premiere-pro-mcp/latest`, off with `PREMIERE_MCP_UPDATE_CHECK=0`) and from the **CEP panel itself** via Node `https.get` inside Premiere (`bridge-cep.js:303-334`, off with `"updateCheck": false` in the panel config). The panel sends `User-Agent: adobe-premiere-pro-mcp-cep/<version>`.
- `detect_silence` spawns `ffmpeg` via `child_process` (`KNOWN_ISSUES.md:26-42`). `verify_premiere_connection` runs `pgrep -f "Adobe Premiere Pro"` and may `open -a` Premiere (`bridge/index.ts:1044-1078`).
- Other: `website/` (Cloudflare Pages site) and `.github/workflows` are unrelated to runtime.

### 1.5 Code quality and robustness

- **Error handling**: consistent `{ success:false, error, status, retry, nextStep }` envelopes; distinguishes "panel absent" vs "not started" vs "timeout" vs "unparseable response" using the heartbeat (`bridge/index.ts:1260-1289`). Per-tool telemetry error classification (`telemetry.ts:246-299`).
- **Timeouts**: server default 60 s (`index.ts:1229`), panel default 45 s and honours a larger `timeoutMs` from the server (`bridge-cep.js:641-644`); heartbeat stale check avoids waiting a full minute when the panel is gone.
- **Modal dialogs**: a modal that blocks the scripting host makes `evalScript` never call back. The panel's timeout **deliberately does not release the evalScript slot** (`bridge-cep.js:658-666`: "A second evalScript while the first callback is still outstanding is what wedges CEP until Premiere restarts (GitHub issue 86)"), so after one blocked call the panel stops processing commands until the dialog is dismissed and the native callback finally fires. The server returns a timeout error to the client; subsequent calls queue behind the stuck one. Mitigation is avoidance only (section 1.3 row 1).
- **JSON serialisation**: hand-written `__mcpStringify` / `__mcpParse` installed as `JSON.stringify` / `JSON.parse` in the ExtendScript engine, **unconditionally** (`bridge-cep.js:68-72,208`; `bridge/index.ts:79-...`). This replaces globals, not prototypes. Handles control chars, U+2028/2029, `__proto__`, own-property check via saved `Object.prototype.hasOwnProperty`. Server-side `repairScriptLineTerminators` and a NUL-byte refusal (`index.ts:1114-1136`).
- **`.prototype.` assignments** (excluding Adobe's `CSInterface.js` and the panel's own `MCPPremiereBridge.prototype.*` methods): **none that mutate built-ins.** Only reads: `Object.prototype.hasOwnProperty` (`bridge-cep.js:39`, `bridge/index.ts:79`) and `Object.prototype.toString.call(...)` (`effects.ts:397-398`, `bridge/index.ts:629-630`). No `Array.prototype`/`Object.prototype` writes. Not a red flag.
- **Tests**: 32 Jest files (`src/__tests__/**`), including prelude/serialisation conformance, injection guards, generated-script syntax (acorn), NUL arguments, QE targeting, panel evalScript queue. Live sweep script `scripts/live-tool-sweep.mjs` (mutates a project; not run here).
- **Weak spots**: very large generated-ExtendScript strings (`expanded.ts` 2765 lines, one switch); file polling adds ~150-400 ms latency per call and depends on `/tmp` permissions; `validateScript` regex can reject legitimate ExtendScript containing e.g. `process.` in a string; QE addressing on 26 requires activating the target sequence (visible UI side effect, `index.ts:373-385`); `PREMIERE_TEMP_DIR` must match on both sides or nothing works.

### 1.6 Mentions of an official Adobe MCP

None. `grep -i official` only hits "official Claude Desktop MCPB bundle" (`CHANGELOG.md:238`). No reference to an Adobe-published Premiere MCP.

### 1.7 UXP bridge usability on Premiere 26

Not usable, by the author's own account (`KNOWN_ISSUES.md:90-118`, "confirmed non-functional" on 26.0.2):
- `uxp-plugin/bridge.js:11` `const { app } = require('premiere');` — the module is `premierepro`; the require throws at load.
- No `require('uxp').entrypoints.setup(...)`; manifestVersion 5 panels need it.
- It then tries `app.executeExtendScript` / `app.evalScript` (`bridge.js:152-176`) — neither exists in the UXP Premiere API; UXP cannot run ExtendScript at all, so even if it loaded, every command would fail with "ExtendScript execution not available".
- Manifest has both `permissions` and `requiredPermissions` blocks (`manifest.json:23-42`); `network.domains` lists `localhost`, `fs read/write`.
- `index.html` is CEP-style markup that UXP will not render (`KNOWN_ISSUES.md:108-111`).
- Also still has the non-atomic file-queue race (`KNOWN_ISSUES.md:115-118`).
Conclusion: ignore `uxp-plugin/`; only the CEP bridge is real.

---

## 2. antipaster / `Adobe-Premiere-Pro-MCP`

### 2.1 Architecture

**Panel type.** CEP panel, no Node (`cep/CSXS/manifest.xml` has no `CEFCommandLine`). `ScriptPath` is `./jsx/premiere.jsx` (`manifest.xml:29`), an intentionally near-empty file (`cep/jsx/premiere.jsx:1-11`, "must NEVER throw ... a failure here poisons the entire ExtendScript context"). The domain `.jsx` modules are loaded by the panel with `$.evalFile("<ext>/jsx/<mod>.jsx")` one at a time (`cep/js/main.js:136-188`), starting with `json2-polyfill`.

**Transport: WebSocket, server listens, panel connects.**
- Server: `new WebSocketServer({ port: WS_PORT })` with `WS_PORT` from `config.json`/`PPRO_MCP_PORT`, default **8097** (`src/bridge.ts:4,52`; `src/config.ts:15,42`). Rebinds every 3 s on `EADDRINUSE` so multiple Claude windows can share one Premiere (`bridge.ts:46-73`).
- Panel: `new WebSocket("ws://localhost:" + WS_PORT)` (`cep/js/main.js:7,43`), reconnect every 3 s on close/error and a 5 s watchdog (`main.js:24-32,195-201`).
- Message shape: `{ id, functionName, args[] }` -> panel builds `functionName(JSON.stringify(arg), ...)` and calls `cs.evalScript(script, cb)` (`main.js:81-107`); `executeScript` passes raw ExtendScript (`main.js:85-91`). Response `{ id, result|error }` (`main.js:120-131`).
- Server-side `callPremiere()` rejects immediately if no panel is connected and times out at **30 s** (`bridge.ts:5,83-102`).

**Who starts what.** MCP client runs `node dist/server.js` (`src/server.ts`), which starts the WS listener at import time (`server.ts:3`, `bridge.ts:73`). User opens `Window > Extensions > MCP Bridge`; the panel connects automatically.

**Command execution.** Each tool maps 1:1 to a global ExtendScript function in `cep/jsx/*.jsx` (e.g. `addClipToTimeline` in `timeline.jsx:37-55`). Results are JSON strings built by `_ok()`/`_err()` (`utils.jsx:3-11`); the panel parses them (`main.js:109-118`).

### 2.2 Premiere 26 compatibility signals

- `RequiredRuntime Name="CSXS" Version="12.0"`, `Host Name="PPRO" Version="[23.0,99.9]"`, manifest `Version="7.0"` (`cep/CSXS/manifest.xml:3,14,20`). Matches CEP 12 on Premiere 26 exactly.
- `.debug` enables remote debugging on port 8088 (`cep/.debug`).
- Explicit arm64/26 notes: `cep/jsx/premiere.jsx:7-10` "`$.fileName` is an empty string on Premiere Pro 26.3.2 (macOS arm64)"; `cep/js/main.js:153-157` "json2 ... Harmless when the host already has a native JSON (26.3.2 does)"; `json2-polyfill.jsx:1-2` "ExtendScript engines that lack a native JSON global (observed on Premiere Pro 2026 ARM64)". The last merged PR is titled "fix/macos-arm64-extendscript-and-reconnect" (git log). So it has been exercised on 26.3.x Apple Silicon by a contributor, though the README still says "Windows" only (`README.md:20-21`) and ships only `install.bat`.
- No `app.version` checks. `get_app_version` tool exists (`src/tools/scripting.ts:34-38`).
- ExtendScript APIs relied on: `app.project.importFiles(paths, false, bin, asNumberedStills)` (`project.jsx:51-53`, **suppressUI=false**), `app.project.importAEComps` / `importAllAEComps` (`project.jsx:275-287`), `track.insertClip`/`overwriteClip` (`timeline.jsx:49-53,69-73`), `app.encoder.encodeSequence(seq, out, preset, workArea, true)` + `startBatch()` (`export.jsx:18-19`), `seq.exportFramePNG(ticks, path)` on the **DOM** sequence (`export.jsx:33`) — note hetpatel found the DOM version "called a non-existent API" and moved to QE (`KNOWN_ISSUES.md:219`), so this may fail on 26; `app.enableQE()` + `qe.project.getActiveSequence()` for razor/ripple/addTracks/removeTrack (`timeline.jsx:111-131`, `sequence.jsx:192-217`), `app.openDocument`, `app.project.saveAs`, `closeDocument` (`project.jsx:16-41`). Several functions use QE `getItemAt(clipIndex)` with the DOM clip index (`timeline.jsx:287,305,323,339`) — hetpatel documents that QE items include gaps/transitions so this hits the wrong item (`KNOWN_ISSUES.md:78-88`). `getTimelineClips` reports `enabled: clip.isSelected()` (`timeline.jsx:26`), a bug.

### 2.3 Coverage of the required tool list

| Required capability | Status | Tool(s) / notes |
|---|---|---|
| Status incl. modal detection | partial | `get_connection_status` (socket only, `connection.ts:5-15`), `get_app_version`, `get_project_info`. No modal detection; a blocked `evalScript` surfaces only as the 30 s timeout. |
| open / save / save-as / new project | partial | `open_project`, `save_project`, `save_project_as`, `close_project` (`project.ts:28-42`, `project.jsx:16-41`). **No create/new project** tool. |
| import files incl. FCP XML + missing media | partial | `import_media(filePaths[], targetBinPath, importAsNumberedStills)` (`project.ts:44-54`) — generic `importFiles` so an `.xml` path imports FCP XML, but `suppressUI=false` (`project.jsx:51-53`) so Premiere **may show dialogs**. No missing-media reporting (`get_project_item_info` has `isOffline`, `project.jsx:107`). |
| import AE comps via Dynamic Link, many per call | **covered** | `import_ae_comps(aepPath, compNames[], targetBinPath)` (`project.ts:238-248`), `importAEComps`/`importAllAEComps` (`project.jsx:275-287`). Returns no item ids. |
| list project items with ids/type/duration | partial | `get_project_items(binPath, recursive)` -> `nodeId`, `type` bin/clip/file, `mediaPath`, `binPath` (`utils.jsx:86-109`); no duration. `get_project_item_info` adds in/out, frameRate, offline, proxy. |
| list sequences / get sequence with tracks + clips | partial | `get_sequences` (`sequence.jsx:3-21`, `sequenceID`, `timebase`, `end`), `get_active_sequence` (tracks with mute/lock, no clips, `:23-66`), `get_track_info` (clips start/end/duration seconds, `:219-244`), `get_timeline_clips` (all clips: track/clip index, start/end/duration/in/out **seconds only**, `timeline.jsx:3-35`). Active sequence only; no frames; clips addressed by `(trackType, trackIndex, clipIndex)` not id. |
| place clip (overwrite/insert, track type/index, start, in/out) | covered | `add_clip_to_timeline` (insert) and `overwrite_clip_to_timeline` with `trackType`, `trackIndex`, `startTime`, `inPoint`, `outPoint` (`timeline.jsx:37-75`, `item.setInPoint(sec, 4)`). Active sequence only. |
| replace clip keeping position/duration | **missing** | no replace tool; `set_clip_position`/`set_clip_in_out` + `remove_clip` + overwrite could be composed. |
| remove clips in range | partial | `remove_clip(trackType, trackIndex, clipIndex, ripple)` (`timeline.jsx:99-106`), `ripple_delete` (QE, index bug above). No range tool. |
| set track enabled / add tracks | covered | `add_tracks(videoCount, audioCount)` via QE `addVideoTrack/addAudioTrack` (`sequence.jsx:192-204`), `remove_track`, `set_track_muted`, `set_track_locked`, `solo_track`, `rename_track`. |
| export frame to PNG | covered (risky) | `export_frame(outputPath, time, format)` -> DOM `seq.exportFramePNG(ticks, path)` (`export.jsx:24-35`); format arg ignored; API existence on 26 unverified (see 2.2). |
| render via AME preset with in/out | covered | `export_sequence(outputPath, presetPath(.epr), startTime, endTime, useInOut)` (`export.ts:8-21`, `export.jsx:3-22`, sets sequence in/out then `ENCODE_IN_TO_OUT`), `export_direct`, `get_encoder_presets` (format list only). |
| run arbitrary script | covered | `execute_extendscript`, `execute_qe_script` (`scripting.ts:7-27`), passed verbatim, no validation. |

### 2.4 Safety

- `install.bat` only (`install.bat:1-106`): `reg add HKCU\Software\Adobe\CSXS.11|12 PlayerDebugMode=1` (`:6-7`); `mklink /J %APPDATA%\Adobe\CEP\extensions\com.mcp.premiere.bridge -> <repo>\cep` (junction, `:18`); copies `config.example.json`; `npm install` + `npm run build`; edits `%APPDATA%\Claude\claude_desktop_config.json` and `%USERPROFILE%\.claude.json` via PowerShell (`:46-88`). No downloads. **No macOS installer** — manual `defaults write com.adobe.CSXS.12 PlayerDebugMode 1` and a symlink/copy into `~/Library/Application Support/Adobe/CEP/extensions/` would be needed.
- No telemetry, no update check. Only outbound network: ElevenLabs TTS tools (`src/tools/ai.ts:9,40,94,192`) which require a user-supplied API key stored in `config.json` (`config.example.json`); nothing is sent unless those tools are called.
- `execute_extendscript` is unrestricted; the WS server binds all interfaces on 8097 with no auth (`bridge.ts:52`, `ws` default host) — any local process (or LAN host, if the firewall allows) could connect as a fake panel and receive/answer commands. Minor, but note it.

### 2.5 Code quality and robustness

- Clean, readable, 1:1 tool->jsx mapping; `utils.jsx` helpers `_ok/_err/_requireSequence/_findProjectItemByNodeId/_makeTime` are good reuse candidates.
- Error handling: thin. Most jsx functions do not `try/catch`; an ExtendScript exception yields the literal `"EvalScript error."` which the panel maps to `{ error }` (`main.js:109-118`) — the actual message is lost. No `success` flag on raw list returns.
- Timeouts: 30 s server-side (`bridge.ts:5`); no panel-side watchdog. A modal blocks `evalScript`; CEP queues further `evalScript` calls, so everything stalls until dismissed; nothing wedges permanently, but there is no detection.
- JSON: `json2-polyfill.jsx` is Crockford's json2. It **does** assign built-in prototypes when `toJSON` is missing: `Date.prototype.toJSON` (`:186`), `Boolean.prototype.toJSON`, `Number.prototype.toJSON`, `String.prototype.toJSON` (`:206-208`). These are the standard json2 shims (add `toJSON` only if absent) — not `Array.prototype`/`Object.prototype`, and `for..in` enumerability is unaffected for arrays/objects. Low risk, but it is a prototype mutation of built-ins, flagged as requested. No other `.prototype.` writes outside Adobe's `CSInterface.js`.
- Known-wrong code: `getTimelineClips.enabled` uses `isSelected()` (`timeline.jsx:26`); QE `getItemAt(domIndex)` mismatch (`timeline.jsx:287,305,323,339`); `exportAAF` first calls `exportAsMediaDirect` with an empty preset before the AAF export (`export.jsx:42-46`); `addAdjustmentLayer` adds a stray video track (`timeline.jsx:230`); `nestClips` is a stub (`sequence.jsx:182-190`); `importSequences` ignores `sequenceIds` (`project.jsx:58-63`).
- Tests: none.

### 2.6 Official Adobe MCP mentions

None in README or source.

---

## 3. morim3 / `mcp_adobe_premiere`

### 3.1 Architecture

- UXP plugin (`plugin/manifest.json`), `require('premierepro')` (`plugin/src/tools.ts:2`), bundled with webpack to `dist/bundle.js` (`webpack.config.js`, externals `premierepro`/`uxp`), loaded via **UXP Developer Tool** only (`README.md:16,121-128`). No ExtendScript at all; uses the modern async UXP DOM (`app.Project.getActiveProject()`, `project.importFiles`, `project.importAEComps`, `sequence.getVideoTrackCount()`, `app.TickTime.createWithSeconds` — `tools.ts:102-493`).
- Transport: panel is a WebSocket **client** to `ws://localhost:8765` (`plugin/src/index.ts:33`, `websocket_server.ts:23`); user must click "Connect" in the panel. Python server (`server/main.py:31`) starts `websockets.serve(..., "localhost", 8765)` in FastMCP's lifespan; `send_instruction` sends `{ id, action, data }` to the **last-connected** client and waits **10 s** (`server/websocket_server.py:81-130`).
- Who starts what: Claude Desktop runs `python server/main.py`; the user loads the plugin with UXP Developer Tool and presses Connect.

### 3.2 Premiere 26 compatibility signals

- `host.app premierepro`, `minVersion 25.3.0`, `manifestVersion 5`, `requiredPermissions` with `localFileSystem: request`, `network.domains` incl. `localhost` (`plugin/manifest.json:6-22`). The README targets **Premiere Pro Beta 25.3** (`README.md:15,122`). No `entrypoints.setup()` call in `index.ts` either — same class of problem hetpatel hit; the plugin may rely on the UXP Developer Tool's loader. Whether the 2025-era UXP Premiere API (e.g. `project.importAEComps`, `Project.createProject`) is unchanged in 26.5 is unverified; the typings (`plugin/types.d.ts`, 822 lines) are a snapshot from April 2025.
- No ExtendScript APIs involved, so the QE/`JSON`-missing issues do not apply.

### 3.3 Coverage

Three umbrella tools (`server/tools.py:231-315`): `manage_project` (get_active, open_project, create_project, save_project, save_project_as, close_project), `manage_sequence` (get_active, create_sequence, create_sequence_from_media, set_active_sequence, get_sequence_list, get/set_player_position), `manage_media` (import_files with `suppressUI`, import_sequences, **import_ae_comps**, **import_all_ae_comps**).
Covered: open/save/save-as/new project; import files (suppressUI available); **import AE comps (many comps per call, `tools.ts:461-493`)**; list sequences (names/ids only). Missing: status/modal detection, project item listing, sequence tracks/clips, place/replace/remove clip, tracks, export frame, render, arbitrary script. Also the FastMCP tool signatures use `**kwargs` then index `kwargs["kwargs"]` (`tools.py:257,288,315`), which is fragile with MCP clients.

### 3.4 Safety

No install scripts, no registry/defaults writes, no telemetry. `requirements.txt` pins `websockets==10.4`, `fastmcp>=0.4.1`. Manifest allows network to `https://www.adobe.com`, `*.adobeprerelease.com`, `wss://*.myplugin.com` (template leftovers, `manifest.json:16-19`), nothing in code uses them.

### 3.5 Code quality

Small, consistent `safeExecute` wrapper (`tools.ts:78-93`); no tests; 10 s timeout; no reconnect logic; `_handle_message` will `KeyError` if a response arrives after timeout (`websocket_server.py:42`). No `.prototype.` writes. README explicitly "not ready for production use" (`README.md:5`).

### 3.6 Official Adobe MCP mentions

None (links only to Adobe UXP docs, `README.md:133`).

---

## 4. Cross-cutting findings

**Official Adobe MCP for Premiere:** none of the three repos mention one.

**UXP route on Premiere 26:** hetpatel's UXP bridge is dead (wrong module, no entrypoint registration, and tries to run ExtendScript from UXP which is impossible). morim3 is the only genuine UXP implementation and shows what the UXP API offers (`importAEComps`, `importFiles(suppressUI)`, project open/save) but requires the UXP Developer Tool and has a 2025 API snapshot. For a shipping panel today, CEP + ExtendScript is the realistic path, which both hetpatel and antipaster confirm with 26.x fixes.

**ExtendScript on Premiere 26 arm64 — facts both CEP repos independently report:**
- The engine has **no native `JSON`** in some 26 builds (hetpatel `KNOWN_ISSUES.md:138`; antipaster `json2-polyfill.jsx:1-2` says missing on "2026 ARM64" while `main.js:157` says 26.3.2 has it). Ship a JSON shim regardless.
- `$.fileName` is empty on 26.3.2 arm64 (`antipaster cep/jsx/premiere.jsx:7-8`): load `.jsx` modules from the panel with absolute paths from `cs.getSystemPath(SystemPath.EXTENSION)` instead of relative `$.evalFile` from the ScriptPath file.
- A throwing `ScriptPath` file poisons the engine so every later `evalScript` returns `"EvalScript error."` (`premiere.jsx:3-5`); the engine may not be ready immediately, retry `evalScript('"hello"')` (`main.js:141-150`).
- QE: `qe.project.getSequenceAt(i)` throws on 26 and `openInTimeline` is gone; address QE sequences by activating them, and match QE items by `start.ticks`, never by DOM index (`hetpatel src/bridge/index.ts:373-420`).
- `sequence.end` can be a plain tick string on 26.3 (`discovery.ts:460`); `getSequenceByID` dropped (`index.ts:1978`); no DOM track deletion; no effect removal API.
- `exportFrame*` appends the format extension (`export.ts:364-372`); `encodeSequence` needs an absolute `.epr` path (`export.ts:219-222`).
- Never issue a second `evalScript` while one is outstanding (`bridge-cep.js:653-666`).

**Modal dialogs:** no repo detects them. Avoidance list from hetpatel: EDL import (interactive), New Sequence without `.sqpreset`, `importFiles` without `suppressUI=true`, FCP XML "Translation Results" windows, unsupported import extensions. A practical detector for our own panel would be a short `ping` evalScript with its own timeout before each real command; if it does not return, report `busy_or_modal` rather than running the command.

---

## 5. What to reuse, and recommendation

### Reusable pieces for our own CEP panel

From **antipaster** (clean, small, MIT):
- `cep/js/main.js` — the whole WebSocket client/reconnect/evalScript dispatch pattern (`:22-131`), the sequential `$.evalFile` module loader with engine-readiness retry (`:136-193`), and the watchdog (`:195-201`).
- `cep/CSXS/manifest.xml` — correct CSXS 12 / PPRO `[23.0,99.9]` manifest; `cep/.debug`.
- `cep/jsx/premiere.jsx` (never-throw ScriptPath), `cep/jsx/utils.jsx` (`_ok/_err/_requireSequence/_getClip/_findProjectItemByNodeId/_findBinByPath/_makeTime/_collectItems`).
- `cep/jsx/project.jsx:275-287` `importAEComps` (fix: pass `targetBin`, return the new items' `nodeId`s by diffing `rootItem.children` before/after, as hetpatel's `importMedia` does at `bridge/index.ts:1417-1436`).
- `cep/jsx/timeline.jsx:37-75` insert/overwrite with `setInPoint/OutPoint(sec, 4)`; `export.jsx:3-22` `encodeSequence` with in/out.
- `src/bridge.ts` — `ws` server with EADDRINUSE rebind and pending-request map (`:11-102`).
- `cep/jsx/json2-polyfill.jsx` if you accept json2's `toJSON` shims; otherwise take hetpatel's prototype-free shim below.

From **hetpatel** (MIT):
- `cep-plugin/bridge-cep.js:11-209` `EXTENDSCRIPT_COMPAT_HELPERS` — self-contained `JSON.stringify/parse` for ES3 that touches no prototypes and escapes control chars / U+2028.
- `cep-plugin/bridge-cep.js:586-698` single-flight evalScript queue with per-command timeout that never double-submits.
- `src/bridge/index.ts:355-420` `__qeSequenceLookup/__activateSequenceForQE/__qeSequenceFor/__findQeClipByDomClip` (Premiere 26 QE workarounds).
- `src/tools/domains/export.ts:330-400` QE `exportFramePNG` with the extension fix; `:100-240` `.epr` preset discovery + `encodeSequence`.
- `src/tools/domains/timeline.ts:859-990` `replace_clip` preserve-position/trim logic; `src/bridge/index.ts:1396-1500` import-with-diff to find new project items; `tracks.ts:55-124` QE `addTracks` with before/after verification and active-sequence restore.
- `src/__tests__/bridge/*` as a model for prelude/serialisation tests.
- `KNOWN_ISSUES.md` and `CHANGELOG.md` as a 26.x API behaviour log.

From **morim3**: `plugin/types.d.ts` and `tools.ts` as a reference for the UXP `premierepro` API shape should we ever build a UXP panel; nothing to reuse for CEP.

### Recommendation

- **Do not install any of them as-is for Premiere 26.5.2.**
  - *hetpatel* is the only one with documented, test-backed Premiere 26 fixes and the broadest coverage, but it (a) sends telemetry to a personal Cloudflare Worker by default and has two update-check phone-homes, including one from inside Premiere, (b) lacks `importAEComps` entirely, (c) uses file polling in `/tmp` with a mandatory shared env var, (d) is ~16k lines of generated ExtendScript that is hard to audit, and (e) needs `search_tools`/`invoke_tool` indirection by default. If someone wants a working bridge *today* with no coding, it is the one that will most likely run (install with `PREMIERE_MCP_TELEMETRY=0`, `PREMIERE_MCP_UPDATE_CHECK=0`, `"updateCheck": false` + `"telemetry": false` in `~/.premiere-mcp-bridge/config.json`, and `PREMIERE_MCP_TOOLSET=full`).
  - *antipaster* has the architecture we want (WebSocket, 1:1 jsx functions, CSXS 12 manifest, arm64 fixes) and `import_ae_comps`, but has no macOS installer, no tests, dialog-unsafe import (`suppressUI=false`), weak error propagation, several known-wrong QE index usages, and no replace/new-project/range-remove tools.
  - *morim3* is a 2025 UXP prototype requiring the UXP Developer Tool; not viable.
- **Build our own CEP panel** on antipaster's skeleton (manifest, `main.js`, `utils.jsx`, WS bridge) with hetpatel's JSON shim, single-flight evalScript queue, QE-on-26 helpers, export/replace/import-diff logic, and a `ping`-before-command busy/modal check. Expose exactly the required tool list, return times in both frames (`Math.round(seconds * fps)` from `sequence.timebase`) and seconds, and implement `importAEComps(aepPath, compNames[], bin)` returning the created `nodeId`s. Install step on macOS: `defaults write com.adobe.CSXS.12 PlayerDebugMode 1` and a copy/symlink into `~/Library/Application Support/Adobe/CEP/extensions/`.

---

## Addendum (2026-10-18): wider search

Searched GitHub/web for other Premiere MCP projects and anything official from Adobe. Cloned (read-only) into this folder:

| Repo | Last commit | Size | Notes |
|---|---|---|---|
| `leancoderkavy/premiere-pro-mcp` (npm `premiere-pro-mcp`, v1.24.1) | 2026-10-16 | 859 files, ~130k lines | Same lineage/shape as hetpatel (CEP bridge, `cep-plugin/`, telemetry tests) but heavily expanded; has a **UXP "preview bridge" for Premiere 25.6+** with a loopback WebSocket + shared-secret token and 96 capability-gated UXP tools. Too large to audit quickly; the UXP bridge is the one part worth borrowing if CEP ever goes away. Forks: dan0nchik, hoodtronik. |
| `muhwagwa0112/premiere-pro-full-mcp` (v2.0.0) | 2026-08-28 | 199 files, ~26k lines | "Fail-closed", **Windows-only**, validated on Premiere 26.3.2 with UXP/CEP/QE/UI backends. Useful as a second Premiere-26 behaviour log; code not reusable on macOS as-is. |
| `ayushozha/AdobePremiereProMCP` (+ NickCocoa fork, "1,027 / 1,060 tools") | 2026-10-05 | 367 files, ~105k lines, Go + Rust + Python + TS | Marketing-heavy; a 13k-line `premiere.jsx`. Not worth adopting. |
| `matrayu/adobe-mcp` | 2026-01-17 | 114 files | Multi-app (PS/PPro/AI/ID) via UXP plugins + socket.io proxy; Premiere coverage thin. |
| `jordanl61/premiere-pro-mcp-server` | 2025-07-08 | 12 files | Tiny, stale. |

**Official Adobe:** no Adobe-published Premiere MCP server. Adobe's "Adobe for Creativity" hosted MCP connector (announced with Anthropic, April 2026) exposes Firefly/Express/etc. tools and, per third-party write-ups, nothing that opens or edits a Premiere project. Adobe's UXP API for Premiere is still catching up with CEP (no caption tracks, no drag-drop, no `app.projects` equivalent, in/out actions don't apply to sequences; CEP support promised for at least one more major cycle after UXP 1.0).

**Relevant forum finding:** `importAEComps` / `importAllAEComps` return `true` but create nothing on Premiere 26.2.x when no target bin is passed; passing the root bin fixes it. Our `host.jsx` always passes a bin (root by default), and the Dynamic Link import was verified live on 26.5.2.

Conclusion unchanged: our own CEP 12 bridge (see `../../Premiere Claude MCP`) covers the required tools without telemetry or a 100k-line dependency.
