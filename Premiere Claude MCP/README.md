# Premiere Pro Bridge — Claude Desktop extension + CEP panel

Lets Claude drive Adobe Premiere Pro 2026 (macOS, Apple Silicon) from a Claude Desktop chat: open/save projects, import media and FCP XML, Dynamic-Link many After Effects comps in one call, build or patch sequences from a JSON timeline, inspect and edit clips and tracks, compare sequences, grab frames, render through Media Encoder, or run raw ExtendScript.

Two parts:

| Part | Where | Role |
|---|---|---|
| **Claude Bridge panel** (`cep/`) | Premiere's CEP extensions folder | runs a localhost-only HTTP server (127.0.0.1:8098) inside Premiere and executes commands in Premiere's ExtendScript engine, one at a time, with timeouts. All host code lives in one namespace (`CPB` in `cep/jsx/host.jsx`); no built-in prototype is modified. |
| **MCP server** (`server/`, packed as `dist/Premiere Bridge.mcpb`) | Claude Desktop | stdio MCP server that talks to the panel and reads/dismisses modal dialogs through macOS Accessibility. |

## Install

1. **Panel:** `tools/install-panel.sh` copies `cep/` to `~/Library/Application Support/Adobe/CEP/extensions/com.chrismorris.claude-premiere-bridge` (CEP ignores symlinked extensions).
2. **Allow unsigned panels.** Premiere Pro 2026 ships CEP 12, so the key is `com.adobe.CSXS.12`. Run this yourself, then restart Premiere:
   ```bash
   defaults write com.adobe.CSXS.12 PlayerDebugMode 1
   ```
3. In Premiere, open a project, then **Window › Extensions › Claude Bridge**. The panel shows *Listening on 127.0.0.1:8098* and *host.jsx loaded*. Leave it open (dock it anywhere).
4. **Extension:** double-click `dist/Premiere Bridge.mcpb` → Install in Claude Desktop (if nothing happens, open it a second time). Start a new chat.
5. **System Settings › Privacy & Security › Accessibility › Claude** on — needed to read and dismiss Premiere's modal dialogs.

## Self-test

With Premiere running and the panel open:

```bash
node test/selftest.mjs            # add --no-render to skip the render step, --keep to leave projects open
node test/selftest.mjs --ae "/path/project.aep" --comp "Comp name"   # also tests a live Dynamic Link import
```

It drives the real MCP server and exercises **every tool** (30/30): two scratch projects, imports, a sequence from a clip, single and batch placement, replace / move / enable / remove, track ops, frame exports + contact sheet, a direct render, scripting helpers, explicit project resolution with two projects open, `pr_build_from_timeline` (import + create + place, then an idempotent patch), `pr_compare_sequences`, and a real modal dialog raised in Premiere that `pr_status` detects and `pr_dismiss_dialog` clicks away.

## Tools

Every tool accepts an optional `project` (name or `.prproj` path) and, where it changes something, `dry_run: true`. Times in results carry `seconds`, `frames`, `ticks` and `timecode`.

| Tool | What it does |
|---|---|
| `pr_status` | Premiere version/build, open projects, active project & sequence, panel reachable/responsive, **modal dialogs** in Premiere (and in After Effects, which block Dynamic Link) |
| `pr_dismiss_dialog` | Click a button on Premiere's (or, with `app: "after_effects"`, AE's) modal dialog; only those apps' dialogs |
| `pr_open_project` `pr_new_project` `pr_save_project` `pr_save_as` `pr_close_project` | Project files; open bypasses conversion / locate / warning dialogs and activates an already-open project |
| `pr_import_files` | Media, image sequences, FCP XML/AAF/.prproj into a bin; UI suppressed, offline media reported; silently rejected files come back as a warning |
| `pr_import_ae_comps` | `importAEComps` — many comps in one call, with per-item duration + fps; checks AE for blocking dialogs before/after instead of hanging |
| `pr_list_items` / `pr_list_sequences` / `pr_get_sequence` | Items with ids; sequences; tracks + clips (source item/media, start/end/in/out) |
| `pr_create_sequence` | Empty sequence from a clip's settings or a `.sqpreset` |
| `pr_place_clip` | overwrite / insert at a frame with in/out; `video_only` / `audio_only` drop the other half of a linked clip (use `video_only` for AE comps) |
| `pr_place_clips` | Batch placement in order, one call |
| `pr_replace_clip` / `pr_remove_clips` / `pr_set_clip_enabled` / `pr_move_clip` | Clip operations (replace keeps position + duration; remove by range or index; nudge by frames) |
| `pr_set_track_enabled` / `pr_track` / `pr_add_tracks` | Track output/lock, rename, target; append tracks |
| `pr_build_from_timeline` | Build or patch a sequence from JSON (imports missing media / AE comps first); `dry_run` reports every import/remove/place |
| `pr_compare_sequences` | Clip-by-clip diff of two sequences (any two projects): source, start/end/in/out frames, enabled |
| `pr_export_frame` / `pr_export_frames` / `pr_show_frame` | PNG(s) to disk (with contact sheet) / inline image |
| `pr_list_export_presets` / `pr_render` | Find `.epr` presets; render via Media Encoder (jobId) or `mode: direct` (waits) |
| `pr_run_script` | ExtendScript with helpers `getProject`, `getSequence(project, seq)`, `findItem`, `findBin`, `qeSequence`, `makeTime`, `timeInfo`, `log` |

## Example: build a Premiere sequence from After Effects comps

```
1. pr_status                                   → Premiere + panel up, no dialogs (also shows AE dialogs)
2. pr_import_ae_comps { aep_path: "/x/Package.aep", comp_names: ["01 Title", "02 Lower third", ...], bin: "AE" }
     → items with ids, duration (frames) and fps; "notCreated" lists names that didn't import
3. pr_create_sequence { name: "Edit v1", from_item: "<id of 01 Title>" }      (or reuse an existing sequence)
4. pr_place_clips { sequence: "Edit v1", video_only: true, clips: [
       { item: "01 Title",       track_index: 1, start_frame: 0 },
       { item: "02 Lower third", track_index: 1, start_frame: 120, in_frame: 0, out_frame: 90 }, ... ] }
   — or do 2–4 in one call: pr_build_from_timeline { timeline: { sequence: "Edit v1", tracks: [ { type: "video", index: 1,
       clips: [ { aep: "/x/Package.aep", comp: "01 Title", start_frame: 0 }, ... ] } ] }, dry_run: true } then without dry_run.
5. pr_compare_sequences { sequence_a: "Edit v1", sequence_b: "Reference edit" }   → mismatches by frame
6. pr_export_frames { sequence: "Edit v1", frames: [0, 60, 120], out_dir: "/x/check", contact_sheet: true }
7. pr_render { sequence: "Edit v1", preset: "H264 Match Source - High bitrate", out_path: "/x/Edit v1.mp4" }
8. pr_save_project
```

## Design notes

- **Why CEP, not UXP:** Premiere 26's UXP `premierepro` API is still incomplete for timeline editing and needs the UXP Developer Tool for unsigned plugins. CEP 12 + ExtendScript covers everything above (see `../research/premiere-mcp/EVALUATION.md` for the comparison of community servers; this bridge borrows antipaster's panel skeleton and hetpatel's Premiere-26 API findings).
- **Premiere 26 quirks handled:** `qe.project.getSequenceAt()` throws for some indices (guarded, guid-matched, active-sequence fallback); QE `exportFramePNG` appends `.png` itself; `encodeSequence` needs an absolute `.epr`; `$.fileName` is empty in panels (host.jsx loaded from an absolute path); the engine may lack `JSON` (own serializer); `openDocument` returns false for an already-open project but activates it; `importAEComps` must be given a target bin (it silently does nothing otherwise).
- **Active project:** with several projects open `app.project` is whichever Premiere last activated. Every tool's `project` parameter activates the named project first; in `pr_run_script` use `getSequence(project, seq)`.
- **Audio of AE comps:** Dynamic Link items carry a silent audio stream, so a plain placement puts audio on the audio track (and Premiere may add tracks). `video_only: true` removes those audio clips right after placement. Premiere's API cannot move a clip to another track, so `target_audio_track_index` can only warn.
- **Not possible through Premiere's API** (so not offered): source-patching a project item's channels, deleting tracks (removing empty audio tracks is attempted through QE), renaming tracks on versions whose `Track.name` is read-only (reported in `notes`).
- **Dialogs:** Premiere's normal windows are invisible to Accessibility, but its modal dialogs are exposed (subrole `AXDialog`), so detection and button clicks are reliable once Accessibility is granted.
- **Nothing is saved implicitly.** Only `pr_save_project` / `pr_save_as` write the project.
- Port: `cep/port.txt` (panel) and the extension's *Bridge port* setting (server) must match if you change it from 8098.

## Develop

```bash
./build.sh                                    # rebuild dist/Premiere Bridge.mcpb (server only; the panel is installed by tools/install-panel.sh)
node test/client.mjs pr_status
node test/client.mjs pr_run_script '{"code":"app.version"}'
```

After editing `cep/`, run `tools/install-panel.sh` again, then reload the panel (click *Reload host script* for `host.jsx` changes; right-click › Reload Extension, or restart Premiere, for `panel.js` changes).
