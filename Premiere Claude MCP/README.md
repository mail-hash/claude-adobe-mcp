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

It drives the real MCP server and exercises **every tool** (68/68): two scratch projects, imports, a sequence from a clip, single and batch placement, replace / move / enable / remove, track ops, sequence versions (`v2` / `v3`, then deleted), markers (add, list, remove), effects (add Gaussian Blur, set a value, keyframe Scale in sequence time and check the rendered frames), transitions (add / list / remove, a centred dissolve across a cut with handle checks), razor, trim, cross-track move, clip volume in dB (checked on a rendered WAV), ducking (ranges and from a transcript), fades, waveform sync of three offset copies, B-roll moments with markers, a Basic Lower Third graphic with its text changed, a transcription of a generated speech clip, captions from it (SRT + VTT, caption track, checked on an exported frame, burned in with ffmpeg) and a filler cut that leaves the timeline contiguous, Lumetri correction measured on exported frames, a colour match, export recipes (match source, MP3, 9:16 Auto Reframe) verified with ffprobe, a rough cut from a folder, shot detection on a generated two-colour mp4 (cut found at 1 s, `Shot N` markers added and removed), in/out points, frame exports + contact sheet, review sheets (evenly spaced and at clip starts), a direct render, scripting helpers, explicit project resolution with two projects open, `pr_build_from_timeline` (import + create + place, then an idempotent patch), `pr_build_from_edit` (shot list → frames, markers, idempotent), `pr_compare_sequences`, and a real modal dialog raised in Premiere that `pr_status` detects and `pr_dismiss_dialog` clicks away.

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
| `pr_replace_clip` / `pr_remove_clips` / `pr_set_clip_enabled` / `pr_move_clip` | Clip operations (replace keeps position + duration; remove by range or index; nudge by frames; `to_track_index` moves a clip to another track) |
| `pr_set_track_enabled` / `pr_track` / `pr_add_tracks` | Track output/lock, rename, target; append tracks |
| `pr_get_clip_effects` / `pr_list_effects` / `pr_add_effect` / `pr_set_effect_property` | Clip components (Opacity, Motion, added effects) with every property, value and keyframe; the effect catalog; add an effect by name; set a value or keyframes given in **sequence** time (Premiere stores component keys in the clip's *source* time, stills at 01:00:00:00 — the bridge converts) |
| `pr_dissolve` | Transition across a cut between two adjacent clips (`clip_index` of the first, or the cut time), centred / end at cut / start at cut, with a media-handle check per side and a warning when Premiere would shorten it |
| `pr_fade` | Fade a clip in / out: Opacity keyframes 0 → 100 / 100 → 0 and, with `audio`, the matching audio clip's volume −60 → 0 dB. Opacity applies in renders but not in Premiere's frame export |
| `pr_sync_clips` | Offsets of clips relative to the first by audio cross-correlation (ffmpeg → 8 kHz mono → numpy FFT via `uv run`), with confidence; `place: true` stacks them aligned on video/audio 0, 1, 2… of a sequence |
| `pr_suggest_broll` | From a transcript: sentences longer than `min_seconds`, passages mentioning your keywords, long uninterrupted talking; keywords per moment, candidate files from a folder scored by filename words, optional yellow markers |
| `pr_list_transitions` / `pr_add_transition` / `pr_remove_transitions` | Transition catalog (`catalog: true`) or a track's transitions; add Cross Dissolve / Dip to Black / … at a clip's start, end or both with a duration; remove by index, time, name or all |
| `pr_split_clip` / `pr_trim_clip` | Razor at a time on one or all tracks; move a clip's edges (absolute or delta) with the source in/out kept in step, reporting when Premiere clamps |
| `pr_transcribe` | Local speech-to-text with word timings (mlx_whisper, Apple silicon): a sequence (audio rendered through Premiere → sequence times; `audio_tracks: [0]` solos the dialogue track for the render so a music bed doesn't make Whisper hallucinate) or a project item / file (media times, mapped to the sequence when one is given — the other transcript tools accept that mapping); saves a transcript JSON, warns when the result looks like a hallucination |
| `pr_cut_by_transcript` | Remove fillers (um/uh/…), given words or phrases, time ranges or word ranges from a sequence: spans snapped to frames, razored on every track, removed, gaps closed (ripple); `keep_tracks: ["A2"]` leaves a music bed uncut and in place while the dialogue tightens; `mark_only` adds markers instead; `dry_run` lists the spans |
| `pr_analyze_audio` | Integrated LUFS, loudness range, true peak, mean/max volume and silences of a file / item, or of a sequence (rendered through Premiere) |
| `pr_set_clip_volume` / `pr_duck_audio` | Volume > Level in dB (Premiere stores 10^((dB−15)/20)), static or keyframed in sequence time; duck a music track under a dialogue track, wherever a transcript has speech, or given ranges, with fades |
| `pr_list_mogrts` / `pr_add_graphic` / `pr_get_graphic_text` / `pr_set_graphic_text` | Motion Graphics Templates from the user library and Premiere's built-ins; add one at a time with a duration; read / set its texts (MOGRT parameters by name, native text layers as plain strings) |
| `pr_color_correct` / `pr_measure_color` / `pr_match_color` | Lumetri Color controls by name (exposure, contrast, temperature, tint, saturation, vignette…; added if missing; `reset`); colour statistics of a clip or frames (mean RGB, luma, saturation, hue via ffmpeg signalstats); match a clip's exposure / temperature / tint / saturation to a reference clip, measure, refine |
| `pr_export_recipe` | Named deliverables: `youtube_4k`, `youtube_1080`, `match_source`, `vertical_9x16` and `square_1x1` (Auto Reframe into a new sequence first), `prores_master`, `podcast_mp3`, `wav`; renders in direct mode and verifies the file with ffprobe (size, aspect, duration) |
| `pr_rough_cut` | Folder of raw clips → ffprobe, import, optional shot detection, first assembly on a new sequence (each shot trimmed to `take_seconds`) with a marker per shot; `dry_run` returns the proposal |
| `pr_make_captions` / `pr_burn_captions` | Caption cues from a transcript (sentence-aware, ≤ 32 chars × 2 lines, ≤ 5 s, pauses split) or explicit cues → `.srt` (+ `.vtt`), imported and added as a caption track (subtitle / 608 / 708 / teletext); burn an .srt into a file with ffmpeg (font, size, colour, outline, margin in pixels); Premiere's own exports already bake subtitle tracks in |
| `pr_build_from_timeline` | Build or patch a sequence from JSON (imports missing media / AE comps first); `dry_run` reports every import/remove/place |
| `pr_build_from_edit` | Ordered shot list → sequence: each shot has a duration (or its whole length), optional in point, gap, track and marker; audio beds on audio tracks; lays them back to back at the sequence fps, imports what's missing, builds/patches via the timeline builder, adds a marker per shot. `dry_run` returns the resolved edit (start/end per shot) and the plan |
| `pr_compare_sequences` | Clip-by-clip diff of two sequences (any two projects): source, start/end/in/out frames, enabled |
| `pr_duplicate_sequence` / `pr_remove_sequence` | Copy a sequence as `<name> v2` (next free `vN`) before a batch of edits, original stays active; delete such versions (refuses other names unless `force`) |
| `pr_list_markers` / `pr_add_marker` / `pr_remove_markers` | Sequence markers: list (time range / name filter), add (point or range, name, comments, comment/chapter/segmentation/weblink, color), remove by guid / index / range / filter / all |
| `pr_sequence_range` | Read or set in/out points (what `pr_render range: inout` uses). Work-area setters are accepted but not applied by Premiere 26.5; the result's `notes` say so |
| `pr_export_frame` / `pr_export_frames` / `pr_show_frame` | PNG(s) to disk (with contact sheet) / inline image |
| `pr_review_sheet` | One labelled contact sheet of a whole sequence, inline: N evenly spaced frames (default 12), or every clip start (`at_clip_starts`), or every marker (`at_markers`), or explicit frames; text summary per frame (timecode, clip on the topmost enabled video track, markers). Needs ffmpeg |
| `pr_review_page` / `pr_review_notes_to_markers` | Review round: render the sequence (youtube_720 by default) and write a local HTML page next to it — video with frame stepping, a bar of clips and existing markers, timed notes (N at the playhead, optional end, Premiere marker colours), persisted in the browser, "Save notes" downloads `review-notes-<sequence>.json`; the second tool turns that file (newest in ~/Downloads by default, or `notes_path`, or inline `notes`) into named, coloured sequence markers, `replace: true` swaps an earlier import |
| `pr_detect_shots` | ffmpeg scene-change detection on a project item (by id/name → media path) or a file: cuts as seconds + frames (media fps via ffprobe) + timecode, shots, the ffmpeg command used; `threshold`, `min_shot_seconds`, `limit`; `add_markers` adds a `Shot N` sequence marker per shot (color, timeline offset, `dry_run`) |
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
- **Audio of AE comps:** Dynamic Link items carry a silent audio stream, so a plain placement puts audio on the audio track (and Premiere may add tracks). `video_only: true` removes those audio clips right after placement. `target_audio_track_index` only warns; use `pr_move_clip to_track_index` to move the audio afterwards.
- **Work area:** `setWorkAreaInPoint/OutPoint` (DOM) and QE's `setWorkInOutPoints` return success on Premiere 26.5 but leave the work area unchanged; `pr_sequence_range` tries both, verifies, and reports it in `notes`. Sequence in/out points do work, and `pr_render range: inout` uses them.
- **Versions:** `Sequence.clone()` names the copy `<name> Copy` and makes it active; `pr_duplicate_sequence` renames it to the next `vN` and restores the active sequence. `Project.deleteSequence` works; `ProjectItem.deleteBin` on a sequence item reports success but deletes nothing.
- **Opacity:** values and keyframes apply in renders (`pr_render` / `pr_export_recipe` show a 20 % clip at 20 %), but Premiere's frame export (`exportFramePNG`) ignores the Opacity component, so `pr_export_frame`, `pr_review_sheet` and `pr_measure_color` don't show fades.
- **Effects and keyframes:** components are read and set through the DOM (`clip.components[i].properties[j]`, `setValue` / `addKey` / `setValueAtKey`); effects are added through QE (`addVideoEffect`). QE track items include gaps and transitions, so a DOM clip is matched to its QE item by start ticks, never by index. Component keyframe times are in the clip's **source** time (a still's in point is 01:00:00:00), so `pr_set_effect_property` converts sequence time → source time and reports both. Opacity: see above.
- **Waveform sync:** `pr_sync_clips` runs `server/scripts/sync_audio.py` with `uv run --with numpy` (numpy is fetched once into uv's cache; no system Python packages needed).
- **Whisper and music:** transcribing a sequence with a music bed mixed in gives a few good seconds and then one token repeated ("10, 10, 10…"): Whisper hallucinates over music. `pr_transcribe` mutes the other audio tracks during the render when `audio_tracks` is given (and restores them), and warns when a transcript looks hallucinated.
- **Transcription:** `pr_transcribe` needs `mlx_whisper` (`uv tool install mlx-whisper`); the first run downloads the model (`whisper-base` by default, ~150 MB). Sequence audio is rendered with the “Waveform Audio 48kHz 16-bit” Media Encoder preset in direct mode.
- **Audio levels:** a clip's Volume > Level is stored as 10^((dB − 15) / 20) (0 dB = 0.178, +15 dB = 1); `pr_set_clip_volume` converts. Component keyframe times are in source time like everything else.
- **Graphics:** `Sequence.importMGT(path, ticks, videoTrack, audioTrack)` adds a template; AE-based MOGRTs expose their parameters through `clip.getMGTComponent()` (text parameters are JSON with `textEditValue`), Premiere-native graphics expose `Text` components whose `Source Text` reads back as a binary blob but accepts a plain string.
- **Auto Reframe:** `sequence.autoReframeSequence(num, den, motionPreset, name, nest)` only accepts the motion preset as a string ("default" / "slower" / "faster"); integers throw. `pr_export_recipe` uses it for the vertical and square recipes.
- **Lumetri:** property names repeat across sections (Temperature, Saturation…), so `pr_color_correct` finds each control as the first property with that name after its section header (Basic Correction / Creative / Vignette).
- **Real-footage run (a 100 s 1080p talking-head piece):** transcription 5 s for 204 words, clean; no fillers in scripted narration (correct); captions 32 cues; YouTube 1080 export 10 s and verified; Lumetri measured and applied. Three bugs fixed from it: loudness read ebur128's first running value instead of the summary (now the last match), caption cues could strand a one-word tail (now break after a comma in the cue's second half), and burn-in font sizes were libass canvas units (now pixels at the video height). Also found: Premiere's exports bake a subtitle caption track into the picture, so burn only onto files without one.
- **Captions:** `Sequence.createCaptionTrack(item, startSeconds, Sequence.CAPTION_FORMAT_*)` adds a track from an imported .srt (SUBTITLE = 0, 608 = 1, 708 = 2, TELETEXT = 3). Nothing in the API lists, removes or moves caption tracks, so cuts (`pr_cut_by_transcript`, `pr_remove_clips`) don't ripple captions: finish the edit, re-run `pr_transcribe`, then `pr_make_captions`. Subtitle tracks render in exported frames and in direct exports.
- **Transition alignment:** QE `addTransition(tr, atStart, durationTimecode)` centres the transition on the cut when the neighbour has handles; the 7-argument form's 5th argument pins it: 1.0 = end at cut, 0.0 = start at cut. ExtendScript parses `dur / 2` inside a nested ternary as a regex literal; use `dur * 0.5`.
- **Clip speed:** QE `setSpeed` exists but returns wrong results in 26.5 whatever the arguments (a 200 % request gives 180 % and a 1-frame clip), so no speed tool is offered.
- **Moving across tracks:** QE `moveToTrack(trackOffset, 0, "0", false)` works (`pr_move_clip to_track_index`).
- **Not possible through Premiere's API** (so not offered): clip speed, source-patching a project item's channels, deleting tracks (removing empty audio tracks is attempted through QE), renaming tracks on versions whose `Track.name` is read-only (reported in `notes`).
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
