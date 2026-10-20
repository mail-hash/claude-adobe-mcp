#!/usr/bin/env node
// Claude Premiere MCP server: stdio MCP <-> HTTP bridge panel inside Premiere Pro.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ping, callOrExplain as call, detectDialogs, detectAEDialogs, describeDialogs, dismissDialogFor, premiereProcessName, PORT } from "./bridge.js";

const run = promisify(execFile);
const FFMPEG = process.env.FFMPEG || ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "ffmpeg"];

const INSTRUCTIONS = `Tools for driving Adobe Premiere Pro (2026) through the Claude Bridge panel that runs inside Premiere.
Start with pr_status: it tells you whether Premiere and the panel are up, what project/sequence is active, and
whether a modal dialog is blocking scripting (pr_dismiss_dialog can click its buttons; nothing works until then).
Every tool takes an optional "project" (name or path) — with several projects open, always pass it; the bridge
activates that project before acting. Ids: project items have a nodeId (pr_list_items), sequences a sequenceId
(pr_list_sequences); names work when unique. Tracks: trackType ("video"|"audio") + 0-based trackIndex. Times:
frames (sequence fps) or seconds; every result carries seconds, frames, ticks and timecode.
Mutating tools accept dry_run: true and then only report what they would do. Nothing is saved unless you call
pr_save_project / pr_save_as.
Placing After Effects comps: use video_only: true (Dynamic Link comps carry silent audio that otherwise lands on
audio tracks). pr_place_clips places a whole list in one call; pr_build_from_timeline builds or patches a sequence
from a JSON timeline (importing missing media / AE comps first). pr_compare_sequences verifies a rebuild against a reference.
Versions: pr_duplicate_sequence copies a sequence as "<name> v2" before a batch of edits (the undo point); pr_remove_sequence
deletes such versions. Markers: pr_list_markers / pr_add_marker / pr_remove_markers (sequence markers). pr_sequence_range reads or
sets in/out points (work-area changes are accepted but not applied by Premiere 26.5; the result says so).
Looking at an edit: pr_review_sheet returns one labelled contact sheet of a whole sequence (evenly spaced, at clip starts or at markers) plus a
per-frame summary; pr_show_frame shows one frame. pr_detect_shots finds cuts in a media file with ffmpeg (optionally adding Shot N markers).
pr_build_from_edit takes an ordered shot list (durations, gaps, audio beds) and lays it out back to back, importing, building and adding a marker per shot.
Effects: pr_get_clip_effects / pr_add_effect / pr_set_effect_property (values or keyframes in sequence time; Premiere stores keys in
source time, the bridge converts). Transitions: pr_list_transitions / pr_add_transition / pr_remove_transitions. pr_split_clip razors,
pr_trim_clip moves clip edges keeping content in place, pr_move_clip to_track_index moves across tracks. Clip speed is not
settable through Premiere 26.5's API.
Transcript: pr_transcribe (local mlx_whisper, word timings) then pr_cut_by_transcript (fillers / words / phrases / ranges, razor + remove +
close gaps). Audio: pr_analyze_audio (LUFS, peaks, silences), pr_set_clip_volume (dB, keyframes), pr_duck_audio. Graphics:
pr_list_mogrts / pr_add_graphic / pr_get_graphic_text / pr_set_graphic_text.
Colour: pr_color_correct (Lumetri controls by name), pr_measure_color, pr_match_color. Delivery: pr_export_recipe (youtube_4k, vertical_9x16 with
Auto Reframe, prores_master, podcast_mp3…, verified with ffprobe). Start from footage: pr_rough_cut (folder → import, shots, assembly, markers).
pr_run_script runs raw ExtendScript with helpers: getProject(nameOrPath), getSequence(project, nameOrId), findItem(ref),
findBin(path, create), qeSequence(seq), makeTime(sec), timeInfo(t, seq), log(...) (collected into "output").`;

const server = new McpServer({ name: "premiere-bridge", version: "1.5.0" }, { instructions: INSTRUCTIONS });
const text = (s) => ({ content: [{ type: "text", text: typeof s === "string" ? s : JSON.stringify(s, null, 1) }] });
const fail = (e) => ({ isError: true, content: [{ type: "text", text: String(e?.message ?? e) + (e?.detail ? "\n" + JSON.stringify(e.detail, null, 1) : "") }] });
const tool = (name, def, fn) => server.registerTool(name, def, async (args) => { try { return await fn(args); } catch (e) { return fail(e); } });

const Project = z.union([z.string(), z.number()]).optional().describe("project name or .prproj path; default: the active project (pass it whenever more than one project is open)");
const Seq = z.union([z.string(), z.number()]).optional().describe("sequence id or exact name; default: active sequence");
const TrackType = z.enum(["video", "audio"]).optional().describe("default video");
const DryRun = z.boolean().optional().describe("report what would change without changing anything");

async function ffmpegPath() {
  for (const c of Array.isArray(FFMPEG) ? FFMPEG : [FFMPEG]) { try { await run(c, ["-version"], { timeout: 5000 }); return c; } catch {} }
  return null;
}
// Tile PNGs into one contact sheet with ffmpeg (returns null when ffmpeg is missing).
async function contactSheet(pngs, outPath, { cols, width = 480, labels } = {}) {
  const ff = await ffmpegPath(); if (!ff || !pngs.length) return null;
  const n = pngs.length, c = cols || Math.min(4, Math.ceil(Math.sqrt(n))), r = Math.ceil(n / c);
  const args = [];
  pngs.forEach((p) => args.push("-i", p));
  const scaled = pngs.map((_, i) => `[${i}:v]scale=${width}:-2,pad=${width}:ih+28:0:0:color=black${labels ? `,drawtext=text='${String(labels[i]).replace(/['\\]/g, " ").replace(/([:;,\[\]=%])/g, "\\$1")}':x=6:y=h-22:fontsize=16:fontcolor=white` : ""}[s${i}]`).join(";");
  const inputs = pngs.map((_, i) => `[s${i}]`).join("");
  const sum = (dim, n) => (n === 0 ? "0" : Array(n).fill(dim).join("+"));   // xstack only understands sums (w0+w0), not products
  args.push("-filter_complex", `${scaled};${inputs}xstack=inputs=${n}:layout=${pngs.map((_, i) => `${sum("w0", i % c)}_${sum("h0", Math.floor(i / c))}`).join("|")}:fill=black[out]`, "-map", "[out]", "-y", outPath);
  try { await run(ff, args, { timeout: 120000 }); return outPath; }
  catch (e) {
    // xstack is picky about uneven grids; fall back to tile (needs equal sizes, which scale gives us).
    try {
      const args2 = ["-y"]; pngs.forEach((p) => args2.push("-i", p));
      args2.push("-filter_complex", `${pngs.map((_, i) => `[${i}:v]scale=${width}:-2[s${i}]`).join(";")};${pngs.map((_, i) => `[s${i}]`).join("")}concat=n=${n}:v=1:a=0,tile=${c}x${r}[out]`, "-map", "[out]", "-frames:v", "1", outPath);
      await run(ff, args2, { timeout: 120000 }); return outPath;
    } catch (e2) { return null; }
  }
}

// ------------------------------------------------------------------ status / dialogs / project
tool("pr_status", {
  title: "Premiere status",
  description: "Premiere version, open projects, active project and sequence, whether the Claude Bridge panel is reachable and responsive, and any modal dialog currently blocking Premiere (title, text, buttons) — plus After Effects dialogs that would block Dynamic Link.",
  inputSchema: {},
  annotations: { readOnlyHint: true },
}, async () => {
  const proc = await premiereProcessName();
  const out = { premiereRunning: !!proc, app: proc, bridgePort: PORT };
  const [dlg, ae] = await Promise.all([detectDialogs(), detectAEDialogs()]);
  if (dlg.dialogs) out.modalDialogs = dlg.dialogs; else if (dlg.unavailable) out.modalDialogCheck = dlg.unavailable;
  if (ae.dialogs?.length) out.afterEffectsDialogs = ae.dialogs; else if (ae.running === false) out.afterEffects = "not running";
  try { out.panel = await ping(3000); } catch (e) { out.panel = null; out.panelError = e.message; return text(out); }
  try { Object.assign(out, await call("status", {}, { timeoutMs: 10000 })); out.responsive = true; }
  catch (e) { out.responsive = false; out.error = e.message; }
  return text(out);
});

tool("pr_dismiss_dialog", {
  title: "Dismiss a Premiere dialog",
  description: "Click a button on the modal dialog Premiere is showing (only Premiere's own dialogs; app: 'after_effects' targets After Effects' dialog instead, e.g. Resolve Fonts during Dynamic Link). Without button, picks OK/Continue/Close, else Cancel. title_contains selects among several dialogs.",
  inputSchema: { button: z.string().optional(), title_contains: z.string().optional(), app: z.enum(["premiere", "after_effects"]).optional() },
}, async ({ button, title_contains, app }) => {
  const proc = app === "after_effects" ? "After Effects" : await premiereProcessName();
  if (!proc) throw new Error("Premiere Pro is not running");
  return text(await dismissDialogFor(proc, button, { titleContains: title_contains }));
});

tool("pr_open_project", { title: "Open project", description: "Open a .prproj (conversion / locate-file / warning dialogs are bypassed) and make it active. Other open projects stay open.", inputSchema: { path: z.string() } },
  async ({ path: p }) => text(await call("openProject", { path: p }, { timeoutMs: 300000 })));
tool("pr_new_project", { title: "New project", description: "Create and open a new empty .prproj at path.", inputSchema: { path: z.string(), overwrite: z.boolean().optional() } },
  async (a) => text(await call("newProject", a, { timeoutMs: 120000 })));
tool("pr_save_project", { title: "Save project", description: "Save a project (default: active).", inputSchema: { project: Project } },
  async (a) => text(await call("saveProject", a, { timeoutMs: 300000 })));
tool("pr_save_as", { title: "Save project as", description: "Save a project to a new .prproj path.", inputSchema: { path: z.string(), project: Project } },
  async (a) => text(await call("saveAs", a, { timeoutMs: 300000 })));
tool("pr_close_project", { title: "Close project", description: "Close a project without prompting (save: true saves first).", inputSchema: { project: Project, save: z.boolean().optional() } },
  async (a) => text(await call("closeProject", a, { timeoutMs: 120000 })));

// ------------------------------------------------------------------ import
tool("pr_import_files", {
  title: "Import files",
  description: "Import media files, image sequences, or FCP XML / AAF / project files into a bin (created if missing). UI is suppressed: media that can't be found is imported offline and listed under 'offline'. A file Premiere rejects fails silently and is reported as a warning.",
  inputSchema: { paths: z.array(z.string()).min(1), bin: z.string().optional().describe("bin name or path like 'Footage/Day 1'"), as_numbered_stills: z.boolean().optional(), project: Project, dry_run: DryRun },
}, async ({ paths, bin, as_numbered_stills, project, dry_run }) => text(await call("importFiles", { paths, bin, asNumberedStills: as_numbered_stills, project, dryRun: dry_run }, { timeoutMs: 600000 })));

async function importAEComps(a) {
  const pre = await detectAEDialogs();
  if (pre.dialogs?.length) throw new Error(`After Effects is showing a dialog that will block Dynamic Link: ${describeDialogs(pre)}. Dismiss it (pr_dismiss_dialog app: "after_effects") and retry.`);
  const r = await call("importAEComps", { aepPath: a.aep_path, compNames: a.comp_names || [], bin: a.bin, project: a.project, dryRun: a.dry_run }, { timeoutMs: (a.timeout_sec ?? 600) * 1000 });
  if (r.notCreated?.length) {
    const post = await detectAEDialogs();
    if (post.dialogs?.length) r.afterEffectsDialog = post.dialogs; r.note = (r.note || "") + (post.dialogs?.length ? ` After Effects is showing: ${describeDialogs(post)}.` : "");
  }
  for (const it of r.imported || []) if (it.duration) it.duration.timecode = undefined;
  return r;
}
tool("pr_import_ae_comps", {
  title: "Import After Effects comps (Dynamic Link)",
  description: "Dynamic-Link import of After Effects compositions from an .aep in one call. comp_names: exact comp names (empty = all comps). Returns each created item with id, duration (seconds + frames) and fps; 'notCreated' lists names that produced nothing. Checks for blocking After Effects dialogs (Resolve Fonts, missing footage) before and after instead of hanging.",
  inputSchema: { aep_path: z.string(), comp_names: z.array(z.string()).optional(), bin: z.string().optional(), project: Project, dry_run: DryRun, timeout_sec: z.number().int().optional() },
}, async (a) => text(await importAEComps(a)));

// ------------------------------------------------------------------ listing
tool("pr_list_items", {
  title: "List project items",
  description: "Project items (bins, clips, sequences) with ids, type, media path, offline flag, duration and fps. Optional bin (name/path/id), name filter, recursive (default true).",
  inputSchema: { bin: z.string().optional(), filter: z.string().optional(), recursive: z.boolean().optional(), limit: z.number().int().optional(), project: Project },
  annotations: { readOnlyHint: true },
}, async (a) => text(await call("listItems", a, { timeoutMs: 120000 })));

tool("pr_list_sequences", { title: "List sequences", description: "All sequences with id, name, fps, size, length (seconds + frames + timecode), track counts, and which is active.", inputSchema: { project: Project }, annotations: { readOnlyHint: true } },
  async (a) => text(await call("listSequences", a, { timeoutMs: 60000 })));

tool("pr_get_sequence", {
  title: "Get sequence",
  description: "Tracks and clips of a sequence: for each clip its name, source item id/name/media path, start/end/in/out/duration (seconds + frames + ticks + timecode), media type, enabled. clips: false returns tracks only.",
  inputSchema: { sequence: Seq, clips: z.boolean().optional(), project: Project },
  annotations: { readOnlyHint: true },
}, async (a) => text(await call("getSequence", a, { timeoutMs: 120000 })));

tool("pr_create_sequence", {
  title: "Create sequence",
  description: "Create an empty sequence: from_item copies that clip's frame size/rate (the clip is placed then removed), or preset_path uses a .sqpreset.",
  inputSchema: { name: z.string(), from_item: z.string().optional(), preset_path: z.string().optional(), bin: z.string().optional(), project: Project, dry_run: DryRun },
}, async (a) => text(await call("createSequence", { name: a.name, fromItem: a.from_item, presetPath: a.preset_path, bin: a.bin, project: a.project, dryRun: a.dry_run }, { timeoutMs: 120000 })));

// ------------------------------------------------------------------ editing
const placeArgs = (a) => ({ item: a.item, sequence: a.sequence, trackType: a.track_type, trackIndex: a.track_index ?? 0, startFrame: a.start_frame, startSeconds: a.start_seconds, inFrame: a.in_frame, outFrame: a.out_frame, inSeconds: a.in_seconds, outSeconds: a.out_seconds, mode: a.mode, videoOnly: a.video_only, audioOnly: a.audio_only, targetAudioTrackIndex: a.target_audio_track_index });
const PlaceSpec = {
  item: z.string().describe("project item id (nodeId) or exact unique name or media path"),
  track_type: TrackType, track_index: z.number().int().optional(),
  start_frame: z.number().optional(), start_seconds: z.number().optional(),
  in_frame: z.number().optional(), out_frame: z.number().optional(), in_seconds: z.number().optional(), out_seconds: z.number().optional(),
  mode: z.enum(["overwrite", "insert"]).optional(),
  video_only: z.boolean().optional().describe("drop the clip's audio (use for Dynamic Link AE comps)"),
  audio_only: z.boolean().optional(),
  target_audio_track_index: z.number().int().optional().describe("warn if the audio lands elsewhere"),
};

tool("pr_place_clip", {
  title: "Place clip",
  description: "Put a project item on a track at start_frame (or start_seconds), optionally trimmed to in/out (frames or seconds of the source). mode overwrite (default) or insert. video_only / audio_only drop the other half of a linked clip right after placement (Dynamic Link AE comps carry silent audio: use video_only). Returns every clip the placement created (video and audio).",
  inputSchema: { ...PlaceSpec, sequence: Seq, project: Project, dry_run: DryRun },
}, async (a) => text(await call("placeClip", { ...placeArgs(a), project: a.project, dryRun: a.dry_run }, { timeoutMs: 120000 })));

tool("pr_place_clips", {
  title: "Place clips (batch)",
  description: "Place a list of clips in order in one call (later placements overwrite earlier ones). Each entry takes the same fields as pr_place_clip; sequence, mode, video_only given at the top level apply to all. Returns all placed clips; stops at the first failure and reports what was completed.",
  inputSchema: { clips: z.array(z.object(PlaceSpec)).min(1), sequence: Seq, mode: z.enum(["overwrite", "insert"]).optional(), video_only: z.boolean().optional(), audio_only: z.boolean().optional(), project: Project, dry_run: DryRun },
}, async (a) => text(await call("placeClips", { clips: a.clips.map(placeArgs), sequence: a.sequence, mode: a.mode, videoOnly: a.video_only, audioOnly: a.audio_only, project: a.project, dryRun: a.dry_run }, { timeoutMs: 600000 })));

tool("pr_replace_clip", {
  title: "Replace clip",
  description: "Replace a timeline clip (by clip index on a track, or by a time it covers) with another project item, keeping its position and duration (and the same source in-point when keep_in_point is true).",
  inputSchema: {
    sequence: Seq, track_type: TrackType, track_index: z.number().int().optional(),
    clip_index: z.number().int().optional(), at_frame: z.number().optional(), at_seconds: z.number().optional(),
    new_item: z.string().describe("project item id or exact unique name"), keep_in_point: z.boolean().optional(), project: Project, dry_run: DryRun,
  },
}, async (a) => text(await call("replaceClip", { sequence: a.sequence, trackType: a.track_type, trackIndex: a.track_index ?? 0, clipIndex: a.clip_index, atFrame: a.at_frame, atSeconds: a.at_seconds, newItem: a.new_item, keepInPoint: a.keep_in_point, project: a.project, dryRun: a.dry_run }, { timeoutMs: 120000 })));

tool("pr_remove_clips", {
  title: "Remove clips",
  description: "Remove clips on a track within a time range (clips fully inside from..to; overlapping: true also removes clips that cross the range), or a single clip_index. ripple: true closes the gap.",
  inputSchema: {
    sequence: Seq, track_type: TrackType, track_index: z.number().int().optional(),
    from_frame: z.number().optional(), to_frame: z.number().optional(), from_seconds: z.number().optional(), to_seconds: z.number().optional(),
    clip_index: z.number().int().optional(), overlapping: z.boolean().optional(), ripple: z.boolean().optional(), project: Project, dry_run: DryRun,
  },
}, async (a) => text(await call("removeClips", { sequence: a.sequence, trackType: a.track_type, trackIndex: a.track_index ?? 0, fromFrame: a.from_frame, toFrame: a.to_frame, fromSeconds: a.from_seconds, toSeconds: a.to_seconds, clipIndex: a.clip_index, overlapping: a.overlapping, ripple: a.ripple, project: a.project, dryRun: a.dry_run }, { timeoutMs: 120000 })));

tool("pr_set_clip_enabled", {
  title: "Enable / disable clip",
  description: "Toggle a clip's enabled state (by clip_index or a time it covers).",
  inputSchema: { sequence: Seq, track_type: TrackType, track_index: z.number().int().optional(), clip_index: z.number().int().optional(), at_frame: z.number().optional(), at_seconds: z.number().optional(), enabled: z.boolean(), project: Project, dry_run: DryRun },
}, async (a) => text(await call("setClipEnabled", { sequence: a.sequence, trackType: a.track_type, trackIndex: a.track_index ?? 0, clipIndex: a.clip_index, atFrame: a.at_frame, atSeconds: a.at_seconds, enabled: a.enabled, project: a.project, dryRun: a.dry_run }, { timeoutMs: 60000 })));

tool("pr_move_clip", {
  title: "Move / nudge clip",
  description: "Move a clip on its track: to_frame / to_seconds (absolute) or delta_frames / delta_seconds (nudge), and/or to another track of the same type with to_track_index. Fails if Premiere refuses (e.g. another clip in the way).",
  inputSchema: { sequence: Seq, track_type: TrackType, track_index: z.number().int().optional(), clip_index: z.number().int().optional(), at_frame: z.number().optional(), at_seconds: z.number().optional(), to_frame: z.number().optional(), to_seconds: z.number().optional(), delta_frames: z.number().optional(), delta_seconds: z.number().optional(), to_track_index: z.number().int().optional().describe("move to this track (same type)"), project: Project, dry_run: DryRun },
}, async (a) => text(await call("moveClip", { sequence: a.sequence, trackType: a.track_type, trackIndex: a.track_index ?? 0, clipIndex: a.clip_index, atFrame: a.at_frame, atSeconds: a.at_seconds, toFrame: a.to_frame, toSeconds: a.to_seconds, deltaFrames: a.delta_frames, deltaSeconds: a.delta_seconds, toTrackIndex: a.to_track_index, project: a.project, dryRun: a.dry_run }, { timeoutMs: 60000 })));

tool("pr_set_track_enabled", {
  title: "Set track enabled / locked",
  description: "Turn a track's output on/off (video eye / audio mute) and/or lock it.",
  inputSchema: { sequence: Seq, track_type: TrackType, track_index: z.number().int(), enabled: z.boolean().optional(), locked: z.boolean().optional(), project: Project, dry_run: DryRun },
}, async (a) => text(await call("trackOp", { sequence: a.sequence, trackType: a.track_type, trackIndex: a.track_index, enabled: a.enabled, locked: a.locked, project: a.project, dryRun: a.dry_run }, { timeoutMs: 60000 })));

tool("pr_track", {
  title: "Track settings",
  description: "Rename, enable/disable, lock, or target (source patching destination) a track. Note: Premiere's API doesn't expose source-patching of a project item's channels; targeting selects which track receives insert/overwrite.",
  inputSchema: { sequence: Seq, track_type: TrackType, track_index: z.number().int(), name: z.string().optional(), enabled: z.boolean().optional(), locked: z.boolean().optional(), targeted: z.boolean().optional(), project: Project, dry_run: DryRun },
}, async (a) => text(await call("trackOp", { sequence: a.sequence, trackType: a.track_type, trackIndex: a.track_index, name: a.name, enabled: a.enabled, locked: a.locked, targeted: a.targeted, project: a.project, dryRun: a.dry_run }, { timeoutMs: 60000 })));

tool("pr_add_tracks", {
  title: "Add tracks",
  description: "Append video and/or audio tracks to a sequence (audio_type: 0 mono, 1 stereo (default), 2 5.1, 3 adaptive).",
  inputSchema: { sequence: Seq, video: z.number().int().optional(), audio: z.number().int().optional(), audio_type: z.number().int().optional(), project: Project, dry_run: DryRun },
}, async (a) => text(await call("addTracks", { sequence: a.sequence, video: a.video, audio: a.audio, audioType: a.audio_type, project: a.project, dryRun: a.dry_run }, { timeoutMs: 60000 })));

// ------------------------------------------------------------------ versions (duplicate / delete sequences)
tool("pr_duplicate_sequence", {
  title: "Duplicate sequence (new version)",
  description: "Copy a sequence before changing it, like After Effects' 'Comp v2': the copy is named '<name> v2' (next free vN; or give name) and the original stays the active sequence unless activate: true. Use it as the undo point before a batch of edits; pr_remove_sequence deletes versions again.",
  inputSchema: { sequence: Seq, name: z.string().optional().describe("name for the copy; default next '<name> vN'"), activate: z.boolean().optional().describe("make the copy the active sequence (default: keep the original active)"), project: Project, dry_run: DryRun },
}, async (a) => text(await call("duplicateSequence", { sequence: a.sequence, name: a.name, activate: a.activate, project: a.project, dryRun: a.dry_run }, { timeoutMs: 120000 })));

tool("pr_remove_sequence", {
  title: "Delete sequence (versions only)",
  description: "Delete a sequence from the project. Refuses anything not named '<name> vN' or '<name> Copy' (the versions these tools create) unless force: true. Media stays in the project.",
  inputSchema: { sequence: Seq, force: z.boolean().optional().describe("delete even if the name is not a version"), project: Project, dry_run: DryRun },
}, async (a) => text(await call("deleteSequence", { sequence: a.sequence, force: a.force, project: a.project, dryRun: a.dry_run }, { timeoutMs: 60000 })));

// ------------------------------------------------------------------ markers / range
const MarkerColor = z.union([z.number().int(), z.string()]).optional().describe("0-7 or green/red/purple/orange/yellow/white/blue/cyan");

tool("pr_list_markers", {
  title: "List sequence markers",
  description: "Sequence markers in time order: index, guid, name, comments, type (Comment/Chapter/Segmentation/WebLink), start/end/duration (seconds + frames + timecode), color. Optional time range and name/comment filter. (Clip markers are not covered.)",
  inputSchema: { sequence: Seq, from_frame: z.number().optional(), from_seconds: z.number().optional(), to_frame: z.number().optional(), to_seconds: z.number().optional(), filter: z.string().optional().describe("substring of name or comments"), project: Project },
  annotations: { readOnlyHint: true },
}, async (a) => text(await call("listMarkers", { sequence: a.sequence, fromFrame: a.from_frame, fromSeconds: a.from_seconds, toFrame: a.to_frame, toSeconds: a.to_seconds, filter: a.filter, project: a.project }, { timeoutMs: 60000 })));

tool("pr_add_marker", {
  title: "Add sequence marker",
  description: "Add a sequence marker at a frame/second, optionally with an end (or duration), name, comments, type (comment default, chapter, segmentation, weblink with url) and color.",
  inputSchema: {
    sequence: Seq, start_frame: z.number().optional(), start_seconds: z.number().optional(),
    end_frame: z.number().optional(), end_seconds: z.number().optional(), duration_frames: z.number().optional(), duration_seconds: z.number().optional(),
    name: z.string().optional(), comments: z.string().optional(), type: z.enum(["comment", "chapter", "segmentation", "weblink"]).optional(), url: z.string().optional(), frame_target: z.string().optional(),
    color: MarkerColor, project: Project, dry_run: DryRun,
  },
}, async (a) => text(await call("addMarker", { sequence: a.sequence, startFrame: a.start_frame, startSeconds: a.start_seconds, endFrame: a.end_frame, endSeconds: a.end_seconds, durationFrames: a.duration_frames, durationSeconds: a.duration_seconds, name: a.name, comments: a.comments, type: a.type, url: a.url, frameTarget: a.frame_target, color: a.color, project: a.project, dryRun: a.dry_run }, { timeoutMs: 60000 })));

tool("pr_remove_markers", {
  title: "Remove sequence markers",
  description: "Remove sequence markers by guid, index, time range (from/to frame or seconds), name/comment filter, or all: true. Criteria combine (AND). dry_run lists what would go.",
  inputSchema: { sequence: Seq, guids: z.array(z.string()).optional(), indexes: z.array(z.number().int()).optional(), from_frame: z.number().optional(), from_seconds: z.number().optional(), to_frame: z.number().optional(), to_seconds: z.number().optional(), filter: z.string().optional(), all: z.boolean().optional(), project: Project, dry_run: DryRun },
}, async (a) => text(await call("removeMarkers", { sequence: a.sequence, guids: a.guids, indexes: a.indexes, fromFrame: a.from_frame, fromSeconds: a.from_seconds, toFrame: a.to_frame, toSeconds: a.to_seconds, filter: a.filter, all: a.all, project: a.project, dryRun: a.dry_run }, { timeoutMs: 60000 })));

tool("pr_sequence_range", {
  title: "Sequence in/out points and work area",
  description: "Read (no arguments) or set a sequence's in/out points and work area. In/out points are what pr_render range: inout uses and set reliably. Premiere 26.5's scripting API accepts work-area changes but does not apply them; the result's notes say so when that happens, so prefer in/out points.",
  inputSchema: { sequence: Seq, in_frame: z.number().optional(), in_seconds: z.number().optional(), out_frame: z.number().optional(), out_seconds: z.number().optional(), work_area_in_frame: z.number().optional(), work_area_in_seconds: z.number().optional(), work_area_out_frame: z.number().optional(), work_area_out_seconds: z.number().optional(), work_area_enabled: z.boolean().optional(), project: Project, dry_run: DryRun },
}, async (a) => text(await call("sequenceRange", { sequence: a.sequence, inFrame: a.in_frame, inSeconds: a.in_seconds, outFrame: a.out_frame, outSeconds: a.out_seconds, workAreaInFrame: a.work_area_in_frame, workAreaInSeconds: a.work_area_in_seconds, workAreaOutFrame: a.work_area_out_frame, workAreaOutSeconds: a.work_area_out_seconds, workAreaEnabled: a.work_area_enabled, project: a.project, dryRun: a.dry_run }, { timeoutMs: 60000 })));

// ------------------------------------------------------------------ effects, transitions, split, trim
const ClipRef = { sequence: Seq, track_type: TrackType, track_index: z.number().int().optional(), clip_index: z.number().int().optional().describe("index on the track (see pr_get_sequence)"), at_frame: z.number().optional().describe("or pick the clip under this frame"), at_seconds: z.number().optional(), project: Project };
const clipRefArgs = (a) => ({ sequence: a.sequence, trackType: a.track_type, trackIndex: a.track_index ?? 0, clipIndex: a.clip_index, atFrame: a.at_frame, atSeconds: a.at_seconds, project: a.project });

tool("pr_get_clip_effects", {
  title: "Get clip effects",
  description: "Every component on a clip (Opacity, Motion, and added effects such as Lumetri Color or Gaussian Blur) with its properties: index, name, value, timeVarying and keyframes (sequence time + source time). Use the indexes/names with pr_set_effect_property. component narrows to one.",
  inputSchema: { ...ClipRef, component: z.string().optional(), keys: z.boolean().optional().describe("include keyframes (default true)") },
  annotations: { readOnlyHint: true },
}, async (a) => text(await call("getClipEffects", { ...clipRefArgs(a), component: a.component, keys: a.keys }, { timeoutMs: 60000 })));

tool("pr_list_effects", {
  title: "List available effects",
  description: "Video (default) or audio effects Premiere can add (Lumetri Color, Gaussian Blur, Crop, Warp Stabilizer…), optionally filtered.",
  inputSchema: { type: z.enum(["video", "audio"]).optional(), filter: z.string().optional() },
  annotations: { readOnlyHint: true },
}, async (a) => text(await call("listEffects", { type: a.type, filter: a.filter }, { timeoutMs: 60000 })));

tool("pr_add_effect", {
  title: "Add effect to clip",
  description: "Add a video or audio effect to a clip by name (exact, or a unique fragment; see pr_list_effects). Returns the new component with its properties so you can set them with pr_set_effect_property.",
  inputSchema: { ...ClipRef, effect: z.string(), dry_run: DryRun },
}, async (a) => text(await call("addEffect", { ...clipRefArgs(a), effect: a.effect, dryRun: a.dry_run }, { timeoutMs: 60000 })));

tool("pr_set_effect_property", {
  title: "Set effect property / keyframes",
  description: `Set a property of a clip component: value (number, [x, y] for Position/Anchor, true/false, or [r, g, b, a] for colors), or keys: [{ frame | seconds, value }] in SEQUENCE time (converted to Premiere's source-time keyframes; existing keys are replaced), or clear_keys: true. Motion Position/Anchor are 0-1 fractions of the frame; Scale and Opacity are percentages; Rotation is degrees. Note: Opacity changes read back but did not show in exported frames in Premiere 26.5 tests.`,
  inputSchema: { ...ClipRef, component: z.union([z.string(), z.number().int()]).describe("component name (Motion, Opacity, Lumetri Color…), matchName or index"), property: z.union([z.string(), z.number().int()]).describe("property name or index"), value: z.any().optional(), keys: z.array(z.object({ frame: z.number().optional(), seconds: z.number().optional(), value: z.any() })).optional(), clear_keys: z.boolean().optional(), dry_run: DryRun },
}, async (a) => text(await call("setEffectProperty", { ...clipRefArgs(a), component: a.component, property: a.property, value: a.value, keys: a.keys, clearKeys: a.clear_keys, dryRun: a.dry_run }, { timeoutMs: 60000 })));

tool("pr_list_transitions", {
  title: "List transitions",
  description: "catalog: true lists the transitions Premiere can add (Cross Dissolve, Dip to Black, Push, …; include_legacy false hides Legacy/Obsolete ones). Otherwise lists the transitions on a track of a sequence with index, name, start/end/duration.",
  inputSchema: { catalog: z.boolean().optional(), type: z.enum(["video", "audio"]).optional(), filter: z.string().optional(), include_legacy: z.boolean().optional(), sequence: Seq, track_type: TrackType, track_index: z.number().int().optional(), project: Project },
  annotations: { readOnlyHint: true },
}, async (a) => text(await call("listTransitions", { catalog: a.catalog, type: a.type, filter: a.filter, includeLegacy: a.include_legacy, sequence: a.sequence, trackType: a.track_type, trackIndex: a.track_index ?? 0, project: a.project }, { timeoutMs: 60000 })));

tool("pr_add_transition", {
  title: "Add transition",
  description: "Add a transition (default Cross Dissolve; any name from pr_list_transitions catalog) at the end (default), start or both ends of a clip, with a duration (default 1 s). Returns the track's transitions afterwards. The clip needs media handles for the transition to fit.",
  inputSchema: { ...ClipRef, transition: z.string().optional(), position: z.enum(["start", "end", "both"]).optional(), duration_seconds: z.number().optional(), duration_frames: z.number().optional(), dry_run: DryRun },
}, async (a) => text(await call("addTransition", { ...clipRefArgs(a), transition: a.transition, position: a.position, durationSeconds: a.duration_seconds, durationFrames: a.duration_frames, dryRun: a.dry_run }, { timeoutMs: 60000 })));

tool("pr_remove_transitions", {
  title: "Remove transitions",
  description: "Remove transitions on a track: by indexes (from pr_list_transitions), the one under at_frame/at_seconds, a name filter, or all: true.",
  inputSchema: { sequence: Seq, track_type: TrackType, track_index: z.number().int().optional(), indexes: z.array(z.number().int()).optional(), at_frame: z.number().optional(), at_seconds: z.number().optional(), filter: z.string().optional(), all: z.boolean().optional(), project: Project, dry_run: DryRun },
}, async (a) => text(await call("removeTransitions", { sequence: a.sequence, trackType: a.track_type, trackIndex: a.track_index ?? 0, indexes: a.indexes, atFrame: a.at_frame, atSeconds: a.at_seconds, filter: a.filter, all: a.all, project: a.project, dryRun: a.dry_run }, { timeoutMs: 60000 })));

tool("pr_split_clip", {
  title: "Split (razor) at a time",
  description: "Razor the clip under a frame/second on one track, or every track (all_tracks: true), like pressing C and clicking. Reports per track whether a split happened.",
  inputSchema: { sequence: Seq, track_type: TrackType, track_index: z.number().int().optional(), at_frame: z.number().optional(), at_seconds: z.number().optional(), all_tracks: z.boolean().optional(), project: Project, dry_run: DryRun },
}, async (a) => text(await call("splitClip", { sequence: a.sequence, trackType: a.track_type, trackIndex: a.track_index ?? 0, atFrame: a.at_frame, atSeconds: a.at_seconds, allTracks: a.all_tracks, project: a.project, dryRun: a.dry_run }, { timeoutMs: 60000 })));

tool("pr_trim_clip", {
  title: "Trim clip edges",
  description: "Move a clip's start and/or end on the timeline (absolute frame/seconds or delta), keeping the source in/out in step so the content doesn't shift: shortening cuts off material, extending reveals more handle. Warns when Premiere clamps (no handle, or a neighbour in the way). Speed changes aren't available in Premiere 26.5's scripting API.",
  inputSchema: { ...ClipRef, start_frame: z.number().optional(), start_seconds: z.number().optional(), start_delta_frames: z.number().optional(), start_delta_seconds: z.number().optional(), end_frame: z.number().optional(), end_seconds: z.number().optional(), end_delta_frames: z.number().optional(), end_delta_seconds: z.number().optional(), dry_run: DryRun },
}, async (a) => text(await call("trimClip", { ...clipRefArgs(a), startFrame: a.start_frame, startSeconds: a.start_seconds, startDeltaFrames: a.start_delta_frames, startDeltaSeconds: a.start_delta_seconds, endFrame: a.end_frame, endSeconds: a.end_seconds, endDeltaFrames: a.end_delta_frames, endDeltaSeconds: a.end_delta_seconds, dryRun: a.dry_run }, { timeoutMs: 60000 })));

// ------------------------------------------------------------------ transcript, audio, graphics
const SUPPORT_DIR = path.join(os.homedir(), "Library", "Application Support", "Premiere Claude Bridge");
const FILLERS = ["um", "uh", "umm", "uhh", "hmm", "mm", "ah", "er", "erm", "like", "you know", "i mean", "sort of", "kind of", "basically", "actually", "literally", "right", "okay so", "so yeah"];
const DEFAULT_FILLERS = ["um", "uh", "umm", "uhh", "hmm", "er", "erm", "ah"];

async function whisperPath() {
  const cands = [process.env.MLX_WHISPER, path.join(os.homedir(), ".local", "bin", "mlx_whisper"), "/opt/homebrew/bin/mlx_whisper", "mlx_whisper"].filter(Boolean);
  for (const c of cands) { try { await run(c, ["--help"], { timeout: 20000 }); return c; } catch {} }
  return null;
}
async function resolveMediaRef(ref, project) {
  if (ref && path.isAbsolute(ref) && (await fs.stat(ref).catch(() => null))) return { mediaPath: ref, item: null };
  const items = await call("listItems", { project, durations: false, limit: 5000 }, { timeoutMs: 120000 });
  const hit = items.items.find((i) => i.id === ref) || items.items.filter((i) => normName(i.name) === normName(ref));
  const it = Array.isArray(hit) ? (hit.length === 1 ? hit[0] : null) : hit;
  if (!it) throw new Error(Array.isArray(hit) && hit.length > 1 ? `'${ref}' matches ${hit.length} project items; use an id` : `'${ref}' is not a file path or a project item`);
  if (!it.mediaPath) throw new Error(`project item '${it.name}' has no media file (a sequence? pass sequence: instead)`);
  return { mediaPath: it.mediaPath, item: it };
}
// Audio of a whole sequence: render a WAV through Premiere (direct mode) so edits, levels and ducking are included.
async function sequenceWav(sequence, project, { inSeconds, outSeconds } = {}) {
  const [preset] = await findPresets("Waveform Audio");
  if (!preset) throw new Error("No 'Waveform Audio' export preset found (Adobe Media Encoder presets missing?)");
  const dir = path.join(SUPPORT_DIR, "audio"); await fs.mkdir(dir, { recursive: true });
  const out = path.join(dir, `seq-${Date.now()}.wav`);
  const r = await call("render", { sequence, presetPath: preset, path: out, mode: "direct", inSeconds, outSeconds, range: inSeconds !== undefined ? undefined : "entire", project }, { timeoutMs: 3600000 });
  const file = r.path || out;
  if (!(await fs.stat(file).catch(() => null))) throw new Error("Premiere did not write the sequence audio: " + JSON.stringify(r).slice(0, 300));
  return { wav: file, render: r };
}
async function to16kWav(src) {
  const ff = await ffmpegPath(); if (!ff) throw new Error("ffmpeg not found (brew install ffmpeg)");
  const dir = path.join(SUPPORT_DIR, "audio"); await fs.mkdir(dir, { recursive: true });
  const out = path.join(dir, path.basename(src).replace(/\.[^.]+$/, "") + "-16k.wav");
  await run(ff, ["-y", "-loglevel", "error", "-i", src, "-vn", "-ac", "1", "-ar", "16000", out], { timeout: 600000 });
  return out;
}
const fpsFrames = (sec, fps) => Math.round(sec * fps);
const tInfo = (sec, fps) => ({ seconds: +sec.toFixed(3), frames: fpsFrames(sec, fps), timecode: tcOf(sec, fps) });

tool("pr_transcribe", {
  title: "Transcribe (word timings)",
  description: `Speech-to-text with word timestamps, run locally with mlx_whisper (Apple silicon). Source: a sequence (its audio is rendered through Premiere, so times are sequence times and edits/levels are included), or a project item / media file (times are media times; with sequence given too, each word is also mapped to where that media sits in the sequence). Returns the text, segments, words (start/end seconds + frames + timecode), and the path of the saved transcript JSON for pr_cut_by_transcript. model: whisper-tiny/base/small/medium/large-v3 (mlx-community), default base; the first run downloads it.`,
  inputSchema: { sequence: Seq, item: z.string().optional().describe("project item id/name or media path (instead of rendering the sequence)"), language: z.string().optional().describe("ISO code, default auto"), model: z.string().optional(), in_seconds: z.number().optional(), out_seconds: z.number().optional(), max_words: z.number().int().optional().describe("words to include inline (default 400; the JSON file has all)"), project: Project },
}, async (a) => {
  const wp = await whisperPath(); if (!wp) throw new Error("mlx_whisper not found. Install it with: uv tool install mlx-whisper   (or pip install mlx-whisper), then retry.");
  let src, mode, item = null, seqInfo = null, fps = 30;
  if (a.sequence || !a.item) { seqInfo = await call("getSequence", { sequence: a.sequence, clips: !!a.item, project: a.project }, { timeoutMs: 120000 }); fps = seqInfo.fps || 30; }
  if (a.item) { const m = await resolveMediaRef(a.item, a.project); src = m.mediaPath; item = m.item; mode = "media"; if (!seqInfo) { try { const pr = await run(await ffprobePath(), ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate", "-of", "csv=p=0", src]); const [n, d] = pr.stdout.trim().split("/").map(Number); if (n && d) fps = n / d; } catch {} } }
  else { const r = await sequenceWav(a.sequence, a.project, { inSeconds: a.in_seconds, outSeconds: a.out_seconds }); src = r.wav; mode = "sequence"; }
  const wav = await to16kWav(src);
  const outDir = path.join(SUPPORT_DIR, "transcripts"); await fs.mkdir(outDir, { recursive: true });
  const model = a.model ? (a.model.includes("/") ? a.model : `mlx-community/${a.model.startsWith("whisper-") ? a.model : "whisper-" + a.model}${/-mlx$/.test(a.model) ? "" : "-mlx"}`) : "mlx-community/whisper-base-mlx";
  const args = [wav, "--model", model, "--word-timestamps", "True", "--output-format", "json", "--output-dir", outDir, "--verbose", "False"];
  if (a.language) args.push("--language", a.language);
  const t0 = Date.now();
  try { await run(wp, args, { timeout: 3600000, env: { ...process.env, PATH: `${path.join(os.homedir(), ".local", "bin")}:/opt/homebrew/bin:${process.env.PATH || ""}` }, maxBuffer: 64 * 1024 * 1024 }); }
  catch (e) { throw new Error("mlx_whisper failed: " + String(e.stderr || e.message).slice(-800)); }
  const raw = JSON.parse(await fs.readFile(path.join(outDir, path.basename(wav, ".wav") + ".json"), "utf8"));
  const offset = mode === "sequence" ? (a.in_seconds || 0) : 0;
  // map media time → sequence time via the clips that use this media
  let placements = [];
  if (mode === "media" && seqInfo?.tracks) for (const t of seqInfo.tracks) for (const c of t.clips || []) if ((item && c.itemId === item.id) || c.mediaPath === src) placements.push({ track: t.type + " " + t.index, clipIndex: c.index, start: c.start.seconds, end: c.end.seconds, inPoint: c.inPoint.seconds, outPoint: c.outPoint.seconds });
  const mapToSeq = (sec) => { for (const p of placements) if (sec >= p.inPoint - 1e-3 && sec <= p.outPoint + 1e-3) return { seconds: +(p.start + (sec - p.inPoint)).toFixed(3), track: p.track, clipIndex: p.clipIndex }; return null; };
  const words = [];
  for (const s of raw.segments || []) for (const w of s.words || []) {
    const rec = { word: String(w.word).trim(), start: tInfo(w.start + offset, fps), end: tInfo(w.end + offset, fps), probability: +Number(w.probability || 0).toFixed(2) };
    if (mode === "media") { const m = mapToSeq(w.start); if (m) rec.sequence = { start: tInfo(m.seconds, fps), end: tInfo(m.seconds + (w.end - w.start), fps), track: m.track, clipIndex: m.clipIndex }; }
    words.push(rec);
  }
  const segments = (raw.segments || []).map((s) => ({ start: tInfo(s.start + offset, fps), end: tInfo(s.end + offset, fps), text: String(s.text).trim() }));
  const transcript = { source: src, mode, sequence: seqInfo ? { id: seqInfo.id, name: seqInfo.name } : null, item: item ? { id: item.id, name: item.name } : null, fps, language: raw.language, model, placements, text: String(raw.text || "").trim(), segments, words, created: new Date().toISOString() };
  const jsonPath = path.join(outDir, `${(seqInfo?.name || item?.name || path.basename(src)).replace(/[^\w.-]+/g, "_")}-${Date.now()}.json`);
  await fs.writeFile(jsonPath, JSON.stringify(transcript, null, 1));
  const maxWords = a.max_words ?? 400;
  return text({ transcript: jsonPath, mode, fps, language: raw.language, model, seconds: +((Date.now() - t0) / 1000).toFixed(1), placements: placements.length ? placements : undefined, text: transcript.text, segments, words: words.slice(0, maxWords), wordCount: words.length, truncated: words.length > maxWords ? `showing ${maxWords} of ${words.length} words; the JSON has all` : undefined });
});

function mergeRanges(ranges, pad = 0, minGap = 0.04) {
  const rs = ranges.map((r) => ({ from: Math.max(0, r.from - pad), to: r.to + pad, labels: r.labels || [] })).sort((x, y) => x.from - y.from), out = [];
  for (const r of rs) { const last = out[out.length - 1]; if (last && r.from <= last.to + minGap) { last.to = Math.max(last.to, r.to); last.labels.push(...r.labels); } else out.push({ ...r, labels: [...r.labels] }); }
  return out;
}

tool("pr_cut_by_transcript", {
  title: "Cut by transcript",
  description: `Remove parts of a sequence based on a transcript from pr_transcribe (sequence mode): fillers: true removes um/uh/erm… (or give words: [...] to match, case-insensitive; phrases allowed), phrases: ["exact text to find"] removes every occurrence, ranges: [{from_seconds, to_seconds}] removes those spans, and word_ranges: [{from_word, to_word}] uses word indexes from the transcript. Ranges are padded (padding_ms, default 40), merged, then each span is razored on every track and removed with ripple (later material shifts left), last span first. dry_run lists the spans with their words. Markers can be added instead of cutting (mark_only: true).`,
  inputSchema: { sequence: Seq, transcript: z.string().describe("path returned by pr_transcribe"), fillers: z.boolean().optional(), words: z.array(z.string()).optional(), phrases: z.array(z.string()).optional(), ranges: z.array(z.object({ from_seconds: z.number(), to_seconds: z.number() })).optional(), word_ranges: z.array(z.object({ from_word: z.number().int(), to_word: z.number().int() })).optional(), padding_ms: z.number().optional(), min_confidence: z.number().optional().describe("skip filler matches below this probability (default 0)"), mark_only: z.boolean().optional(), project: Project, dry_run: DryRun },
}, async (a) => {
  const tr = JSON.parse(await fs.readFile(a.transcript, "utf8"));
  if (tr.mode !== "sequence") throw new Error("This transcript is in media time (item mode). Run pr_transcribe with sequence: to cut by it.");
  const seqInfo = await call("getSequence", { sequence: a.sequence, clips: false, project: a.project }, { timeoutMs: 120000 });
  const fps = seqInfo.fps || tr.fps || 30, words = tr.words || [], norm = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, "").trim();
  const spans = [];
  const matchList = [...(a.fillers ? DEFAULT_FILLERS : []), ...(a.words || [])].map(norm).filter(Boolean);
  if (matchList.length) {
    for (let i = 0; i < words.length; i++) {
      for (const m of matchList) {
        const n = m.split(/\s+/).length; if (i + n > words.length) continue;
        const phrase = words.slice(i, i + n).map((w) => norm(w.word)).join(" ");
        if (phrase === m) { const ws = words.slice(i, i + n); if (a.min_confidence && ws.some((w) => w.probability < a.min_confidence)) continue; spans.push({ from: ws[0].start.seconds, to: ws[n - 1].end.seconds, labels: [ws.map((w) => w.word).join(" ")] }); }
      }
    }
  }
  for (const p of a.phrases || []) {
    const target = norm(p).split(/\s+/), n = target.length;
    for (let i = 0; i + n <= words.length; i++) if (words.slice(i, i + n).map((w) => norm(w.word)).join(" ") === target.join(" ")) spans.push({ from: words[i].start.seconds, to: words[i + n - 1].end.seconds, labels: [p] });
  }
  for (const r of a.ranges || []) spans.push({ from: r.from_seconds, to: r.to_seconds, labels: [`${r.from_seconds}-${r.to_seconds}s`] });
  for (const r of a.word_ranges || []) { const w0 = words[r.from_word], w1 = words[r.to_word]; if (!w0 || !w1) throw new Error(`word index out of range (${words.length} words)`); spans.push({ from: w0.start.seconds, to: w1.end.seconds, labels: [words.slice(r.from_word, r.to_word + 1).map((w) => w.word).join(" ")] }); }
  if (!spans.length) return text({ spans: [], note: "nothing matched" });
  // snap every span to frame boundaries: the razor cuts on frames, and the removal must use exactly those edges
  const merged = mergeRanges(spans, (a.padding_ms ?? 40) / 1000).map((s) => { const f0 = Math.round(s.from * fps), f1 = Math.max(Math.round(s.to * fps), Math.round(s.from * fps) + 1); return { from: tInfo(f0 / fps, fps), to: tInfo(f1 / fps, fps), duration: tInfo((f1 - f0) / fps, fps), words: s.labels }; });
  const removedTotal = merged.reduce((t, s) => t + (s.to.seconds - s.from.seconds), 0);
  if (a.dry_run) return text({ dryRun: true, sequence: seqInfo.name, spans: merged, count: merged.length, removedSeconds: +removedTotal.toFixed(3) });
  if (a.mark_only) {
    const added = [];
    for (const s of merged) { const r = await call("addMarker", { sequence: seqInfo.id, startSeconds: s.from.seconds, endSeconds: s.to.seconds, name: "cut: " + s.words.join(" "), color: "red", project: a.project }, { timeoutMs: 60000 }); added.push(r.marker.start.timecode); }
    return text({ sequence: seqInfo.name, marked: added.length, spans: merged });
  }
  const results = [];
  for (const s of [...merged].reverse()) {
    await call("splitClip", { sequence: seqInfo.id, atFrame: s.from.frames, allTracks: true, project: a.project }, { timeoutMs: 60000 });
    await call("splitClip", { sequence: seqInfo.id, atFrame: s.to.frames, allTracks: true, project: a.project }, { timeoutMs: 60000 });
    const tracks = (await call("getSequence", { sequence: seqInfo.id, clips: false, project: a.project }, { timeoutMs: 60000 })).tracks;
    let removed = 0;
    // half-frame margins: only pieces strictly inside the span (the razor made their edges land on these frames)
    for (const t of tracks) { const r = await call("removeClips", { sequence: seqInfo.id, trackType: t.type, trackIndex: t.index, fromSeconds: (s.from.frames + 0.5) / fps, toSeconds: (s.to.frames - 0.5) / fps, overlapping: true, ripple: false, project: a.project }, { timeoutMs: 60000 }); removed += r.removed.length; }
    results.push({ span: s, clipsRemoved: removed });
  }
  // close the gaps: ripple-delete empty space by shifting everything after each span left (last span first keeps earlier times valid)
  const closed = [];
  for (const s of [...merged].reverse()) {
    const r = await call("closeGap", { sequence: seqInfo.id, fromFrame: s.from.frames, toFrame: s.to.frames, project: a.project }, { timeoutMs: 120000 });
    closed.push(r);
  }
  const final = await call("getSequence", { sequence: seqInfo.id, clips: false, project: a.project }, { timeoutMs: 60000 });
  return text({ sequence: final.name, spans: results.reverse(), removedSeconds: +removedTotal.toFixed(3), gapsClosed: closed.reverse(), end: final.end, note: "Transcript times are now stale for the removed spans; re-run pr_transcribe before cutting again." });
});

tool("pr_analyze_audio", {
  title: "Analyze audio",
  description: "Loudness and silence of a media file / project item, or of a whole sequence (rendered through Premiere): integrated LUFS, loudness range, true peak, mean/max volume (dBFS), and silences longer than min_silence_seconds below silence_db (default -35 dBFS, 0.5 s). Times carry frames and timecode.",
  inputSchema: { sequence: Seq, item: z.string().optional(), silence_db: z.number().optional(), min_silence_seconds: z.number().optional(), project: Project },
}, async (a) => {
  const ff = await ffmpegPath(); if (!ff) throw new Error("ffmpeg not found");
  let src, fps = 30, seqInfo = null;
  if (a.item) { src = (await resolveMediaRef(a.item, a.project)).mediaPath; try { const pr = await run(await ffprobePath(), ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate", "-of", "csv=p=0", src]); const [n, d] = pr.stdout.trim().split("/").map(Number); if (n && d) fps = n / d; } catch {} }
  else { seqInfo = await call("getSequence", { sequence: a.sequence, clips: false, project: a.project }, { timeoutMs: 120000 }); fps = seqInfo.fps || 30; src = (await sequenceWav(a.sequence, a.project)).wav; }
  const sdb = a.silence_db ?? -35, sdur = a.min_silence_seconds ?? 0.5;
  const r = await run(ff, ["-hide_banner", "-nostats", "-i", src, "-vn", "-af", `ebur128=peak=true,volumedetect,silencedetect=n=${sdb}dB:d=${sdur}`, "-f", "null", "-"], { timeout: 1800000, maxBuffer: 64 * 1024 * 1024 }).catch((e) => e);
  const log = String(r.stderr || "");
  const num = (re) => { const m = re.exec(log); return m ? Number(m[1]) : null; };
  const silences = []; const starts = [...log.matchAll(/silence_start: ([\d.]+)/g)].map((m) => Number(m[1])), ends = [...log.matchAll(/silence_end: ([\d.]+) \| silence_duration: ([\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
  starts.forEach((s, i) => { const e = ends[i]; silences.push({ start: tInfo(s, fps), end: e ? tInfo(e[0], fps) : null, duration: e ? tInfo(e[1], fps) : null }); });
  return text({ source: src, sequence: seqInfo ? seqInfo.name : undefined, fps, loudness: { integratedLufs: num(/I:\s+(-?[\d.]+) LUFS/), rangeLu: num(/LRA:\s+([\d.]+) LU/), truePeakDbtp: num(/Peak:\s+(-?[\d.]+) dBFS/), meanVolumeDb: num(/mean_volume: (-?[\d.]+) dB/), maxVolumeDb: num(/max_volume: (-?[\d.]+) dB/) }, silence: { thresholdDb: sdb, minSeconds: sdur, count: silences.length, silences }, hints: { toMinus14Lufs: num(/I:\s+(-?[\d.]+) LUFS/) !== null ? +(-14 - num(/I:\s+(-?[\d.]+) LUFS/)).toFixed(1) + " dB" : undefined } });
});

const AudioClipRef = { sequence: Seq, track_index: z.number().int().optional().describe("audio track index (default 0)"), clip_index: z.number().int().optional(), at_frame: z.number().optional(), at_seconds: z.number().optional(), project: Project };
tool("pr_set_clip_volume", {
  title: "Set clip volume (dB)",
  description: "Set an audio clip's Volume > Level in dB (0 = unity, -inf..+15), or keyframes keys: [{ frame | seconds, db }] in sequence time (fades, ducks), or clear_keys. Returns the level with keys in dB.",
  inputSchema: { ...AudioClipRef, db: z.number().optional(), keys: z.array(z.object({ frame: z.number().optional(), seconds: z.number().optional(), db: z.number() })).optional(), clear_keys: z.boolean().optional(), dry_run: DryRun },
}, async (a) => text(await call("setClipVolume", { sequence: a.sequence, trackIndex: a.track_index ?? 0, clipIndex: a.clip_index, atFrame: a.at_frame, atSeconds: a.at_seconds, db: a.db, keys: a.keys, clearKeys: a.clear_keys, project: a.project, dryRun: a.dry_run }, { timeoutMs: 60000 })));

tool("pr_duck_audio", {
  title: "Duck music under dialogue",
  description: "Lower the clips on an audio track (music) while another track (dialogue) has clips, or during given ranges: keyframes base_db → duck_db with fade_seconds ramps on every music clip that overlaps. dry_run lists the keyframes per clip.",
  inputSchema: { sequence: Seq, music_track_index: z.number().int(), under_track_index: z.number().int().optional().describe("audio track whose clips define the duck ranges"), ranges: z.array(z.object({ from_seconds: z.number(), to_seconds: z.number() })).optional(), duck_db: z.number().optional().describe("default -12"), base_db: z.number().optional().describe("default 0"), fade_seconds: z.number().optional().describe("default 0.3"), project: Project, dry_run: DryRun },
}, async (a) => {
  const seq = await call("getSequence", { sequence: a.sequence, project: a.project }, { timeoutMs: 120000 });
  const fps = seq.fps || 30, duck = a.duck_db ?? -12, base = a.base_db ?? 0, fade = a.fade_seconds ?? 0.3;
  let ranges = (a.ranges || []).map((r) => ({ from: r.from_seconds, to: r.to_seconds }));
  if (a.under_track_index !== undefined) { const t = seq.tracks.find((x) => x.type === "audio" && x.index === a.under_track_index); if (!t) throw new Error(`audio track ${a.under_track_index} not found`); ranges.push(...(t.clips || []).filter((c) => c.enabled !== false).map((c) => ({ from: c.start.seconds, to: c.end.seconds }))); }
  if (!ranges.length) throw new Error("give under_track_index or ranges");
  ranges = mergeRanges(ranges, 0, fade);
  const music = seq.tracks.find((x) => x.type === "audio" && x.index === a.music_track_index); if (!music) throw new Error(`audio track ${a.music_track_index} not found`);
  const plan = [];
  for (const c of music.clips || []) {
    const keys = [];
    for (const r of ranges) {
      if (r.to <= c.start.seconds || r.from >= c.end.seconds) continue;
      const f0 = Math.max(c.start.seconds, r.from - fade), f1 = Math.max(c.start.seconds, r.from), f2 = Math.min(c.end.seconds, r.to), f3 = Math.min(c.end.seconds, r.to + fade);
      if (f0 < f1) keys.push({ seconds: +f0.toFixed(4), db: base }); keys.push({ seconds: +f1.toFixed(4), db: duck }, { seconds: +f2.toFixed(4), db: duck }); if (f3 > f2) keys.push({ seconds: +f3.toFixed(4), db: base });
    }
    if (!keys.length) continue;
    if (keys[0].seconds > c.start.seconds + 1e-3) keys.unshift({ seconds: c.start.seconds, db: base });
    if (keys[keys.length - 1].seconds < c.end.seconds - 1e-3) keys.push({ seconds: +(c.end.seconds - 1 / fps).toFixed(4), db: base });
    plan.push({ clipIndex: c.index, clip: c.name, keys: keys.map((k) => ({ ...k, timecode: tcOf(k.seconds, fps) })) });
  }
  if (a.dry_run) return text({ dryRun: true, musicTrack: `audio ${a.music_track_index}`, ranges: ranges.map((r) => ({ from: tInfo(r.from, fps), to: tInfo(r.to, fps) })), clips: plan });
  const done = [];
  for (const p of plan) { const r = await call("setClipVolume", { sequence: seq.id, trackIndex: a.music_track_index, clipIndex: p.clipIndex, keys: p.keys.map((k) => ({ seconds: k.seconds, db: k.db })), project: a.project }, { timeoutMs: 60000 }); done.push({ clip: p.clip, keys: r.level.keys.map((k) => [k.time.timecode, k.db]) }); }
  return text({ musicTrack: `audio ${a.music_track_index}`, ranges: ranges.length, clips: done });
});

// ---- graphics (MOGRT / Essential Graphics)
async function mogrtFolders() {
  let app = "Adobe Premiere Pro 2026"; try { const st = await call("status", {}, { timeoutMs: 20000 }); if (st?.version) app = `Adobe Premiere Pro ${(/^(\d{2})/.exec(st.version) || [])[1] ? "20" + st.version.slice(0, 2) : "2026"}`; } catch {}
  return [
    { kind: "user", dir: path.join(os.homedir(), "Library", "Application Support", "Adobe", "Common", "Motion Graphics Templates") },
    { kind: "app", dir: path.join("/Applications", app, `${app}.app`, "Contents", "Essential Graphics") },
  ];
}
async function walkExt(dir, ext, depth = 0) { const out = []; let entries = []; try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return out; } for (const e of entries) { const p = path.join(dir, e.name); if (e.isDirectory()) { if (depth < 6) out.push(...(await walkExt(p, ext, depth + 1))); } else if (e.name.toLowerCase().endsWith(ext)) out.push(p); } return out; }
async function listMogrts(filter) {
  const folders = await mogrtFolders(), all = [];
  for (const f of folders) for (const p of await walkExt(f.dir, ".mogrt")) all.push({ kind: f.kind, name: path.basename(p, ".mogrt"), category: path.relative(f.dir, path.dirname(p)), path: p });
  const words = String(filter || "").toLowerCase().split(/\s+/).filter(Boolean);
  return { folders, mogrts: words.length ? all.filter((p) => words.every((w) => (p.category + "/" + p.name).toLowerCase().includes(w))) : all };
}
tool("pr_list_mogrts", {
  title: "List Motion Graphics Templates",
  description: "Motion Graphics Templates (.mogrt) available: the user's library (~/Library/Application Support/Adobe/Common/Motion Graphics Templates) and Premiere's built-in Essential Graphics (Basic Title, Basic Lower Third, …). filter matches words against folder + name.",
  inputSchema: { filter: z.string().optional(), limit: z.number().int().optional() },
  annotations: { readOnlyHint: true },
}, async ({ filter, limit }) => { const r = await listMogrts(filter); const n = limit ?? 60; return text(`${r.mogrts.length} template(s)${r.mogrts.length > n ? `, showing ${n}` : ""}\nkind\tcategory\tname\tpath\n${r.mogrts.slice(0, n).map((m) => `${m.kind}\t${m.category}\t${m.name}\t${m.path}`).join("\n")}`); });

tool("pr_add_graphic", {
  title: "Add a Motion Graphics Template",
  description: "Put a .mogrt (path, or a unique name from pr_list_mogrts) on a video track at a time, optionally with a duration and clip name; returns the clip and its editable texts (then pr_set_graphic_text). Built-in: 'Basic Title', 'Basic Lower Third'.",
  inputSchema: { sequence: Seq, mogrt: z.string(), start_frame: z.number().optional(), start_seconds: z.number().optional(), track_index: z.number().int().optional().describe("video track (default 1, above the footage)"), audio_track_index: z.number().int().optional(), duration_seconds: z.number().optional(), name: z.string().optional(), project: Project, dry_run: DryRun },
}, async (a) => {
  let p = a.mogrt;
  if (!path.isAbsolute(p) || !(await fs.stat(p).catch(() => null))) { const r = await listMogrts(a.mogrt); const exact = r.mogrts.filter((m) => m.name.toLowerCase() === a.mogrt.toLowerCase()); const pick = exact.length === 1 ? exact : exact.length > 1 && exact.some((m) => m.kind === "user") ? exact.filter((m) => m.kind === "user").slice(0, 1) : exact.length > 1 ? exact.slice(0, 1) : r.mogrts; if (pick.length !== 1) throw new Error(pick.length ? `'${a.mogrt}' matches ${pick.length} templates: ${pick.slice(0, 8).map((m) => m.name).join(", ")}. Give the path.` : `No template matches '${a.mogrt}' (see pr_list_mogrts)`); p = pick[0].path; }
  return text(await call("addGraphic", { sequence: a.sequence, path: p, startFrame: a.start_frame, startSeconds: a.start_seconds, trackIndex: a.track_index, audioTrackIndex: a.audio_track_index, duration: a.duration_seconds, name: a.name, project: a.project, dryRun: a.dry_run }, { timeoutMs: 120000 }));
});

tool("pr_get_graphic_text", {
  title: "Get graphic texts",
  description: "Editable texts of a graphic clip: Motion Graphics Template parameters (name, text, font, size) and native text layers (Source Text). Targets for pr_set_graphic_text.",
  inputSchema: { ...ClipRef },
  annotations: { readOnlyHint: true },
}, async (a) => text(await call("getGraphicText", clipRefArgs(a), { timeoutMs: 60000 })));

tool("pr_set_graphic_text", {
  title: "Set graphic text",
  description: "Change the text of a graphic clip: target is a MOGRT parameter name (e.g. 'Title'), 'text-layer:N' for a native text layer, or omitted for the first text. font (PostScript name) and font_size apply to MOGRT parameters that allow it.",
  inputSchema: { ...ClipRef, text: z.string(), target: z.union([z.string(), z.number().int()]).optional(), font: z.string().optional(), font_size: z.number().optional(), dry_run: DryRun },
}, async (a) => text(await call("setGraphicText", { ...clipRefArgs(a), text: a.text, target: a.target, font: a.font, fontSize: a.font_size, dryRun: a.dry_run }, { timeoutMs: 60000 })));

// ------------------------------------------------------------------ colour (Lumetri), export recipes, rough cut
// Lumetri Color property names repeat across sections, so each control is found as the first property with that
// name after its section header ("Basic Correction", "Creative", "Vignette").
const LUMETRI = {
  temperature: ["Basic Correction", "Temperature"], tint: ["Basic Correction", "Tint"], saturation: ["Basic Correction", "Saturation"],
  exposure: ["Basic Correction", "Exposure"], contrast: ["Basic Correction", "Contrast"], highlights: ["Basic Correction", "Highlights"],
  shadows: ["Basic Correction", "Shadows"], whites: ["Basic Correction", "Whites"], blacks: ["Basic Correction", "Blacks"],
  vibrance: ["Creative", "Vibrance"], creative_saturation: ["Creative", "Saturation"], faded_film: ["Creative", "Faded Film"], sharpen: ["Creative", "Sharpen"], look_intensity: ["Creative", "Intensity"],
  vignette_amount: ["Vignette", "Amount"], vignette_midpoint: ["Vignette", "Midpoint"], vignette_roundness: ["Vignette", "Roundness"], vignette_feather: ["Vignette", "Feather"],
};
const LUMETRI_DEFAULTS = { temperature: 0, tint: 0, saturation: 100, exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0, vibrance: 0, creative_saturation: 100, faded_film: 0, sharpen: 0, look_intensity: 100, vignette_amount: 0, vignette_midpoint: 50, vignette_roundness: 0, vignette_feather: 50 };
async function lumetriOf(ref, { create } = {}) {
  let fx = await call("getClipEffects", { ...ref, keys: false }, { timeoutMs: 60000 });
  let lum = fx.components.find((c) => c.name === "Lumetri Color");
  if (!lum && create) { await call("addEffect", { ...ref, effect: "Lumetri Color" }, { timeoutMs: 60000 }); fx = await call("getClipEffects", { ...ref, keys: false }, { timeoutMs: 60000 }); lum = fx.components.find((c) => c.name === "Lumetri Color"); }
  if (!lum) return { clip: fx.clip, lumetri: null, map: null };
  const map = {};
  for (const [key, [section, name]] of Object.entries(LUMETRI)) {
    const s = lum.properties.findIndex((p) => p.name === section); if (s < 0) continue;
    const next = lum.properties.findIndex((p, i) => i > s && ["Basic Correction", "Creative", "Curves", "Color Wheels & Match", "HSL Secondary", "Vignette", "SpeedGrade Custom"].includes(p.name));
    const idx = lum.properties.findIndex((p, i) => i > s && (next < 0 || i < next) && p.name === name);
    if (idx >= 0) map[key] = { index: idx, value: lum.properties[idx].value };
  }
  return { clip: fx.clip, lumetri: lum, map };
}
const ColorControls = { exposure: z.number().optional().describe("stops, about -5..5"), contrast: z.number().optional().describe("-100..100"), highlights: z.number().optional(), shadows: z.number().optional(), whites: z.number().optional(), blacks: z.number().optional(), temperature: z.number().optional().describe("-100 (blue) .. 100 (warm)"), tint: z.number().optional().describe("-100 (green) .. 100 (magenta)"), saturation: z.number().optional().describe("0..200, 100 = unchanged"), vibrance: z.number().optional(), creative_saturation: z.number().optional(), faded_film: z.number().optional(), sharpen: z.number().optional(), look_intensity: z.number().optional(), vignette_amount: z.number().optional().describe("-5..5"), vignette_midpoint: z.number().optional(), vignette_roundness: z.number().optional(), vignette_feather: z.number().optional() };

tool("pr_color_correct", {
  title: "Colour correct (Lumetri)",
  description: "Set Lumetri Color basic correction / creative / vignette controls on a clip by name (exposure, contrast, highlights, shadows, whites, blacks, temperature, tint, saturation, vibrance, sharpen, faded_film, vignette_*). Adds Lumetri Color if the clip has none. reset: true puts every control back to its default first. Returns the current values. Use pr_measure_color / pr_export_frame to judge the result.",
  inputSchema: { ...ClipRef, ...ColorControls, reset: z.boolean().optional(), dry_run: DryRun },
}, async (a) => {
  const ref = clipRefArgs(a);
  const wanted = Object.fromEntries(Object.keys(LUMETRI).filter((k) => a[k] !== undefined && a[k] !== null).map((k) => [k, a[k]]));
  if (a.reset) for (const k of Object.keys(LUMETRI)) if (wanted[k] === undefined) wanted[k] = LUMETRI_DEFAULTS[k];
  if (!Object.keys(wanted).length) throw new Error("give at least one control (exposure, temperature, …) or reset: true");
  if (a.dry_run) { const cur = await lumetriOf(ref); return text({ dryRun: true, clip: cur.clip.name, hasLumetri: !!cur.lumetri, set: wanted }); }
  const { clip, map } = await lumetriOf(ref, { create: true });
  const set = {};
  for (const [k, v] of Object.entries(wanted)) { if (!map[k]) { set[k] = "not found in this Lumetri version"; continue; } const r = await call("setEffectProperty", { ...ref, component: "Lumetri Color", property: map[k].index, value: v }, { timeoutMs: 60000 }); set[k] = r.property.value; }
  const after = await lumetriOf(ref);
  return text({ clip: clip.name, set, values: Object.fromEntries(Object.entries(after.map).map(([k, v]) => [k, v.value])) });
});

async function frameStats(png) {
  const ff = await ffmpegPath(); if (!ff) throw new Error("ffmpeg not found");
  const r = await run(ff, ["-hide_banner", "-i", png, "-vf", "signalstats,metadata=print:file=-", "-f", "null", "-"], { timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
  const get = (k) => { const m = new RegExp(`lavfi\\.signalstats\\.${k}=([-\\d.]+)`).exec(r.stdout + r.stderr); return m ? Number(m[1]) : null; };
  const rgb = await run(ff, ["-loglevel", "error", "-i", png, "-vf", "scale=1:1:flags=area", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { timeout: 60000, encoding: "buffer" });
  const [R, G, B] = rgb.stdout;
  return { rgb: [R, G, B], luma: { avg: get("YAVG"), min: get("YMIN"), max: get("YMAX"), low: get("YLOW"), high: get("YHIGH") }, saturation: { avg: get("SATAVG"), max: get("SATMAX") }, hue: get("HUEAVG") };
}
function avgStats(list) { const n = list.length || 1, s = (f) => list.reduce((t, x) => t + (f(x) || 0), 0) / n; return { rgb: [s((x) => x.rgb[0]), s((x) => x.rgb[1]), s((x) => x.rgb[2])].map((v) => +v.toFixed(1)), lumaAvg: +s((x) => x.luma.avg).toFixed(1), lumaLow: +s((x) => x.luma.low).toFixed(1), lumaHigh: +s((x) => x.luma.high).toFixed(1), saturationAvg: +s((x) => x.saturation.avg).toFixed(1), hueAvg: +s((x) => x.hue).toFixed(1) }; }
async function measureClip(seqId, trackIndex, clipIndex, count, project) {
  const g = await call("getSequence", { sequence: seqId, project }, { timeoutMs: 120000 });
  const fps = g.fps || 30, track = g.tracks.find((t) => t.type === "video" && t.index === trackIndex); if (!track) throw new Error(`video track ${trackIndex} not found`);
  const clip = track.clips[clipIndex]; if (!clip) throw new Error(`clip ${clipIndex} not found on video ${trackIndex}`);
  const frames = []; const n = Math.max(1, count || 3); for (let i = 0; i < n; i++) frames.push(Math.round((clip.start.seconds + (clip.end.seconds - clip.start.seconds) * (i + 1) / (n + 1)) * fps));
  const dir = path.join(SUPPORT_DIR, "color", `${Date.now()}-${trackIndex}-${clipIndex}`); await fs.mkdir(dir, { recursive: true });
  const stats = [];
  for (const f of frames) { const r = await call("exportFrame", { sequence: seqId, frame: f, path: path.join(dir, `f${f}.png`), project }, { timeoutMs: 120000 }); stats.push({ frame: f, timecode: tcOf(f / fps, fps), ...(await frameStats(r.path || path.join(dir, `f${f}.png`))) }); }
  return { clip: { name: clip.name, index: clipIndex, track: `video ${trackIndex}`, start: clip.start, end: clip.end }, fps, frames: stats, average: avgStats(stats) };
}

tool("pr_measure_color", {
  title: "Measure colour",
  description: "Colour statistics of a clip (frames sampled evenly, default 3) or of given frames: mean RGB, luma average/low/high (0-255, from ffmpeg signalstats), saturation, hue. For judging grades and for pr_match_color.",
  inputSchema: { sequence: Seq, track_index: z.number().int().optional(), clip_index: z.number().int().optional(), frames: z.array(z.number()).optional().describe("explicit sequence frames instead of a clip"), samples: z.number().int().optional(), project: Project },
  annotations: { readOnlyHint: true },
}, async (a) => {
  const g = await call("getSequence", { sequence: a.sequence, clips: false, project: a.project }, { timeoutMs: 120000 });
  if (a.frames?.length) { const dir = path.join(SUPPORT_DIR, "color", String(Date.now())); await fs.mkdir(dir, { recursive: true }); const stats = []; for (const f of a.frames) { const r = await call("exportFrame", { sequence: g.id, frame: f, path: path.join(dir, `f${f}.png`), project: a.project }, { timeoutMs: 120000 }); stats.push({ frame: f, timecode: tcOf(f / (g.fps || 30), g.fps || 30), ...(await frameStats(r.path || path.join(dir, `f${f}.png`))) }); } return text({ sequence: g.name, frames: stats, average: avgStats(stats) }); }
  if (a.clip_index === undefined) throw new Error("give clip_index (and track_index) or frames");
  return text({ sequence: g.name, ...(await measureClip(g.id, a.track_index ?? 0, a.clip_index, a.samples, a.project)) });
});

tool("pr_match_color", {
  title: "Match colour to a reference clip",
  description: "Make a target clip look like a reference clip: measures both (luma, R/B balance, G balance, saturation), estimates Lumetri exposure, temperature, tint and saturation for the target, applies them, re-measures and refines once (iterations, default 2). Returns before/after measurements and the controls set. dry_run only measures and proposes.",
  inputSchema: { sequence: Seq, reference_track_index: z.number().int().optional(), reference_clip_index: z.number().int(), target_track_index: z.number().int().optional(), target_clip_index: z.number().int(), iterations: z.number().int().optional(), match: z.array(z.enum(["exposure", "temperature", "tint", "saturation"])).optional(), samples: z.number().int().optional(), project: Project, dry_run: DryRun },
}, async (a) => {
  const g = await call("getSequence", { sequence: a.sequence, clips: false, project: a.project }, { timeoutMs: 120000 });
  const rt = a.reference_track_index ?? 0, tt = a.target_track_index ?? 0, want = new Set(a.match || ["exposure", "temperature", "tint", "saturation"]);
  const ref = await measureClip(g.id, rt, a.reference_clip_index, a.samples, a.project);
  let tgt = await measureClip(g.id, tt, a.target_clip_index, a.samples, a.project);
  const targetRef = { sequence: g.id, trackType: "video", trackIndex: tt, clipIndex: a.target_clip_index, project: a.project };
  const log2 = (x) => Math.log(x) / Math.LN2, clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const estimate = (r, t, cur) => {
    const e = {};
    if (want.has("exposure")) e.exposure = clamp((cur.exposure || 0) + log2(Math.max(1, r.lumaAvg) / Math.max(1, t.lumaAvg)) * 0.9, -5, 5);
    if (want.has("temperature")) e.temperature = clamp((cur.temperature || 0) + log2((r.rgb[0] + 1) / (r.rgb[2] + 1)) * 45 - log2((t.rgb[0] + 1) / (t.rgb[2] + 1)) * 45, -100, 100);
    if (want.has("tint")) e.tint = clamp((cur.tint || 0) - (log2((r.rgb[1] + 1) / ((r.rgb[0] + r.rgb[2]) / 2 + 1)) - log2((t.rgb[1] + 1) / ((t.rgb[0] + t.rgb[2]) / 2 + 1))) * 45, -100, 100);
    if (want.has("saturation")) e.saturation = clamp((cur.saturation || 100) * (Math.max(1, r.saturationAvg) / Math.max(1, t.saturationAvg)), 0, 200);
    return Object.fromEntries(Object.entries(e).map(([k, v]) => [k, +v.toFixed(2)]));
  };
  const first = estimate(ref.average, tgt.average, {});
  if (a.dry_run) return text({ dryRun: true, reference: ref, target: tgt, proposed: first });
  let cur = {}, history = [];
  for (let i = 0; i < (a.iterations ?? 2); i++) {
    const est = estimate(ref.average, tgt.average, cur);
    const { map } = await lumetriOf(targetRef, { create: true });
    for (const [k, v] of Object.entries(est)) if (map[k]) await call("setEffectProperty", { ...targetRef, component: "Lumetri Color", property: map[k].index, value: v }, { timeoutMs: 60000 });
    cur = est; tgt = await measureClip(g.id, tt, a.target_clip_index, a.samples, a.project);
    history.push({ iteration: i + 1, set: est, targetAfter: tgt.average });
  }
  return text({ reference: ref.average, targetBefore: history.length ? undefined : tgt.average, result: tgt.average, controls: cur, history, deltas: { luma: +(tgt.average.lumaAvg - ref.average.lumaAvg).toFixed(1), rgb: tgt.average.rgb.map((v, i) => +(v - ref.average.rgb[i]).toFixed(1)), saturation: +(tgt.average.saturationAvg - ref.average.saturationAvg).toFixed(1) } });
});

// ---- export recipes
const RECIPES = {
  youtube_4k: { preset: ["YouTube 2160p 4K"], describe: "H.264 3840x2160 for YouTube" },
  youtube_1080: { preset: ["YouTube 1080p HD"], describe: "H.264 1920x1080 for YouTube" },
  youtube_720: { preset: ["YouTube 720p HD"], describe: "H.264 1280x720" },
  match_source: { preset: ["H264 Match Source - High bitrate", "Match Source - High bitrate"], describe: "H.264 at the sequence's size and rate" },
  vertical_9x16: { reframe: [9, 16], preset: ["H264 Match Source - High bitrate", "Match Source - High bitrate"], describe: "Auto Reframe to 9:16, then H.264 match source" },
  square_1x1: { reframe: [1, 1], preset: ["H264 Match Source - High bitrate", "Match Source - High bitrate"], describe: "Auto Reframe to 1:1, then H.264 match source" },
  prores_master: { preset: ["Apple ProRes 422 HQ", "ProRes 422 HQ"], describe: "Apple ProRes 422 HQ master" },
  podcast_mp3: { preset: ["MP3 192kbps High Quality", "MP3 192"], describe: "MP3 192 kbps audio only" },
  wav: { preset: ["Waveform Audio 48kHz 16-bit", "Waveform Audio"], describe: "WAV 48 kHz 16-bit audio only" },
};
tool("pr_export_recipe", {
  title: "Export with a named recipe",
  description: `Deliverables in one call: recipe = ${Object.keys(RECIPES).join(" | ")} (list_recipes: true describes them). Vertical/square recipes first Auto Reframe the sequence into a new one. Renders in Premiere (direct mode, waits), then verifies the file with ffprobe (size, duration vs the sequence, codec) and reports mismatches. range: entire | inout.`,
  inputSchema: { sequence: Seq, recipe: z.string().optional(), out_path: z.string().optional().describe("output file; default next to the project under exports/"), range: z.enum(["entire", "inout"]).optional(), motion: z.enum(["default", "slower", "faster"]).optional().describe("Auto Reframe motion preset"), list_recipes: z.boolean().optional(), project: Project, dry_run: DryRun },
}, async (a) => {
  if (a.list_recipes || !a.recipe) return text({ recipes: Object.fromEntries(Object.entries(RECIPES).map(([k, v]) => [k, v.describe + (v.reframe ? ` (reframe ${v.reframe.join(":")})` : "")])) });
  const rc = RECIPES[a.recipe]; if (!rc) throw new Error(`unknown recipe '${a.recipe}'; use list_recipes: true`);
  let presetPath = null; for (const frag of rc.preset) { const m = await findPresets(frag); const exact = m.filter((p) => path.basename(p, ".epr").toLowerCase() === frag.toLowerCase()); if (exact.length) { presetPath = exact[0]; break; } if (m.length === 1) { presetPath = m[0]; break; } }
  if (!presetPath) throw new Error(`no export preset found for ${a.recipe} (tried ${rc.preset.join(", ")}); see pr_list_export_presets`);
  const seq = await call("getSequence", { sequence: a.sequence, clips: false, project: a.project }, { timeoutMs: 120000 });
  const st = await call("status", {}, { timeoutMs: 20000 });
  const projPath = st.activeProject?.path || os.homedir();
  const ext = /mp3/i.test(presetPath) ? ".mp3" : /Waveform/i.test(presetPath) ? ".wav" : /ProRes/i.test(presetPath) ? ".mov" : ".mp4";
  const out = a.out_path || path.join(path.dirname(projPath), "exports", `${seq.name.replace(/[^\w.-]+/g, "_")}-${a.recipe}${ext}`);
  const plan = { recipe: a.recipe, describe: rc.describe, sequence: seq.name, reframe: rc.reframe ? rc.reframe.join(":") : null, preset: presetPath, out };
  if (a.dry_run) return text({ dryRun: true, plan });
  let renderSeq = seq.id, reframed = null;
  if (rc.reframe) { const r = await call("autoReframe", { sequence: seq.id, aspectWidth: rc.reframe[0], aspectHeight: rc.reframe[1], motion: a.motion, name: `${seq.name} ${rc.reframe.join("x")}`, project: a.project }, { timeoutMs: 600000 }); renderSeq = r.sequence.id; reframed = r.sequence; }
  await fs.mkdir(path.dirname(out), { recursive: true });
  const t0 = Date.now();
  const r = await call("render", { sequence: renderSeq, presetPath, path: out, mode: "direct", range: a.range || "entire", project: a.project }, { timeoutMs: 3600000 });
  const file = r.path || out, stat = await fs.stat(file).catch(() => null);
  if (!stat) throw new Error("render produced no file: " + JSON.stringify(r).slice(0, 300));
  let probe = null; try { const pr = await run(await ffprobePath(), ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels", "-of", "json", file], { timeout: 60000 }); probe = JSON.parse(pr.stdout); } catch {}
  const v = probe?.streams?.find((s) => s.codec_type === "video"), au = probe?.streams?.find((s) => s.codec_type === "audio");
  const duration = probe ? Number(probe.format.duration) : null, expected = (reframed || seq).end?.seconds;
  const checks = [];
  if (duration !== null && expected && Math.abs(duration - expected) > 0.5 && (a.range || "entire") === "entire") checks.push(`duration ${duration.toFixed(2)} s differs from the sequence (${expected.toFixed(2)} s)`);
  if (rc.reframe && v && Math.abs(v.width / v.height - rc.reframe[0] / rc.reframe[1]) > 0.02) checks.push(`aspect ${v.width}x${v.height} is not ${rc.reframe.join(":")}`);
  if (/youtube_4k/.test(a.recipe) && v && v.height < 2160) checks.push(`height ${v.height} < 2160`);
  if (!v && !/mp3|wav/.test(a.recipe)) checks.push("no video stream");
  return text({ recipe: a.recipe, out: file, bytes: stat.size, seconds: +((Date.now() - t0) / 1000).toFixed(1), reframedSequence: reframed, video: v ? { codec: v.codec_name, size: `${v.width}x${v.height}`, fps: v.r_frame_rate } : null, audio: au ? { codec: au.codec_name, sampleRate: au.sample_rate, channels: au.channels } : null, duration, expectedDuration: expected, verified: checks.length === 0, issues: checks.length ? checks : undefined });
});

// ---- media-first rough cut
tool("pr_rough_cut", {
  title: "Rough cut from a folder of clips",
  description: `Media-first start: probe every video file in a folder (ffprobe: duration, fps, size), import them, optionally split each into shots (ffmpeg scene detection), then build a first assembly on a new sequence: the clips (or their first N shots) in filename order, each trimmed to take_seconds from the shot start (or whole), markers named after the files, and the proposal returned. dry_run returns the proposal without touching Premiere. Then refine with pr_review_sheet / pr_trim_clip / pr_cut_by_transcript.`,
  inputSchema: { folder: z.string(), sequence: z.string().describe("name of the new sequence"), take_seconds: z.number().optional().describe("seconds to keep from each shot/clip (default: whole)"), detect_shots: z.boolean().optional(), shots_per_clip: z.number().int().optional().describe("with detect_shots: max shots per clip (default 3)"), scene_threshold: z.number().optional(), extensions: z.array(z.string()).optional(), limit: z.number().int().optional(), bin: z.string().optional(), project: Project, dry_run: DryRun },
}, async (a) => {
  const exts = new Set((a.extensions || ["mp4", "mov", "mxf", "m4v", "avi", "mts", "mkv", "braw", "r3d"]).map((e) => e.toLowerCase().replace(/^\./, "")));
  const entries = (await fs.readdir(a.folder, { withFileTypes: true })).filter((e) => e.isFile() && exts.has(path.extname(e.name).slice(1).toLowerCase())).map((e) => path.join(a.folder, e.name)).sort((x, y) => x.localeCompare(y, undefined, { numeric: true }));
  if (!entries.length) throw new Error(`no video files in ${a.folder}`);
  const files = entries.slice(0, a.limit ?? 200), probe = await ffprobePath(), ff = await ffmpegPath();
  const clips = [];
  for (const f of files) {
    let dur = null, fps = null, w = null, h = null;
    try { const pr = await run(probe, ["-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height,r_frame_rate", "-of", "json", f], { timeout: 60000 }); const j = JSON.parse(pr.stdout); dur = Number(j.format.duration); const v = j.streams.find((s) => s.codec_type === "video"); if (v) { w = v.width; h = v.height; const [n, d] = String(v.r_frame_rate).split("/").map(Number); fps = n && d ? +(n / d).toFixed(3) : null; } } catch (e) { clips.push({ file: f, error: "ffprobe failed: " + e.message.split("\n")[0] }); continue; }
    const rec = { file: f, name: path.basename(f), duration: dur, fps, size: w ? `${w}x${h}` : null, shots: [] };
    if (a.detect_shots && ff) {
      const r = await run(ff, ["-nostats", "-hide_banner", "-i", f, "-vf", `select='gt(scene,${a.scene_threshold ?? 0.3})',metadata=print`, "-an", "-f", "null", "-"], { timeout: 1800000, maxBuffer: 64 * 1024 * 1024 }).catch((e) => e);
      const cuts = [...String(r.stderr || "").matchAll(/pts_time:([\d.]+)/g)].map((m) => Number(m[1])).filter((t) => t > 0.2);
      const bounds = [0, ...cuts, dur].filter((t, i, arr) => i === 0 || t - arr[i - 1] > 0.3);
      for (let i = 0; i < bounds.length - 1 && rec.shots.length < (a.shots_per_clip ?? 3); i++) rec.shots.push({ start: +bounds[i].toFixed(3), end: +bounds[i + 1].toFixed(3) });
    }
    if (!rec.shots.length) rec.shots.push({ start: 0, end: dur });
    clips.push(rec);
  }
  const shots = [];
  for (const c of clips) if (!c.error) for (const s of c.shots) { const len = s.end - s.start, take = a.take_seconds ? Math.min(a.take_seconds, len) : len; if (take <= 0) continue; shots.push({ path: c.file, name: `${c.name}${c.shots.length > 1 ? ` #${c.shots.indexOf(s) + 1}` : ""}`, in_seconds: s.start, duration_seconds: +take.toFixed(3) }); }
  const total = shots.reduce((t, s) => t + s.duration_seconds, 0);
  const proposal = { folder: a.folder, files: clips.length, shots: shots.length, totalSeconds: +total.toFixed(2), clips, edit: shots };
  if (a.dry_run) return text({ dryRun: true, ...proposal });
  const fps = clips.find((c) => c.fps)?.fps || 30;
  const seqs = await call("listSequences", { project: a.project }, { timeoutMs: 60000 });
  if (seqs.sequences.some((s) => s.name === a.sequence)) throw new Error(`sequence '${a.sequence}' already exists; pick another name`);
  // import first (so durations and the first clip's settings are known), then lay out through the edit builder
  const paths = [...new Set(shots.map((s) => s.path))];
  const imp = await call("importFiles", { paths, bin: a.bin || "Rough cut", project: a.project }, { timeoutMs: 1800000 });
  const edit = shots.map((s) => ({ path: s.path, name: s.name, in_seconds: s.in_seconds, duration_seconds: s.duration_seconds }));
  const timelineClips = [];
  let cursor = 0;
  for (const s of edit) { const inF = Math.round(s.in_seconds * fps), durF = Math.max(1, Math.round(s.duration_seconds * fps)); timelineClips.push({ path: s.path, start_frame: cursor, in_frame: inF, out_frame: inF + durF }); s.start_frame = cursor; s.end_frame = cursor + durF; cursor += durF; }
  const build = await buildFromTimeline({ timeline: { sequence: a.sequence, tracks: [{ type: "video", index: 0, clips: timelineClips }] }, bin: a.bin || "Rough cut", project: a.project, dry_run: false });
  const markers = [];
  for (const s of edit) { try { const m = await call("addMarker", { sequence: build.sequence.id, startFrame: s.start_frame, endFrame: s.end_frame, name: s.name, project: a.project }, { timeoutMs: 60000 }); markers.push(m.marker.start.timecode); } catch {} }
  return text({ sequence: build.sequence, imported: imp.imported?.length ?? 0, offline: imp.offline?.length ? imp.offline : undefined, placed: build.placed.length, markers: markers.length, totalSeconds: +total.toFixed(2), fps, edit, warnings: build.warnings?.length ? build.warnings : undefined, next: "pr_review_sheet to look at it; pr_trim_clip / pr_move_clip / pr_remove_clips to refine; pr_transcribe + pr_cut_by_transcript for dialogue." });
});

// ------------------------------------------------------------------ build / compare
function normName(s) { return String(s || "").replace(/\.[^.]+$/, "").toLowerCase(); }

async function buildFromTimeline({ timeline: tl, mode, bin, project, dry_run }) {
  if (typeof tl === "string") tl = JSON.parse(tl);
  if (!tl || !Array.isArray(tl.tracks)) throw new Error("timeline.tracks must be an array");
  const plan = { imports: [], aeImports: [], createSequence: null, removes: [], places: [], warnings: [] };
  const items = await call("listItems", { project, durations: false, limit: 5000 }, { timeoutMs: 120000 });
  const byId = new Map(), byName = new Map(), byPath = new Map();
  for (const it of items.items) { byId.set(it.id, it); if (!byName.has(normName(it.name))) byName.set(normName(it.name), it); if (it.mediaPath) byPath.set(it.mediaPath, it); }
  const resolve = (c) => {
    if (c.item && byId.has(c.item)) return byId.get(c.item);
    if (c.item && byName.has(normName(c.item))) return byName.get(normName(c.item));
    if (c.path && byPath.has(c.path)) return byPath.get(c.path);
    if (c.path && byName.has(normName(path.basename(c.path)))) return byName.get(normName(path.basename(c.path)));
    if (c.comp && byName.has(normName(c.comp))) return byName.get(normName(c.comp));
    if (c.comp) for (const [k, v] of byName) if (k.startsWith(normName(c.comp) + "/")) return v;
    return null;
  };
  // 1. imports
  const needFiles = new Set(), needComps = new Map();
  for (const t of tl.tracks) for (const c of t.clips || []) {
    if (resolve(c)) continue;
    if (c.path) needFiles.add(c.path);
    else if (c.aep && c.comp) { if (!needComps.has(c.aep)) needComps.set(c.aep, new Set()); needComps.get(c.aep).add(c.comp); }
    else plan.warnings.push(`clip "${c.item || c.comp || "?"}" is not in the project and has no path/aep to import`);
  }
  plan.imports = [...needFiles]; plan.aeImports = [...needComps].map(([aep, comps]) => ({ aep, comps: [...comps] }));
  if (!dry_run) {
    if (plan.imports.length) { const r = await call("importFiles", { paths: plan.imports, bin: bin || "Imported", project }, { timeoutMs: 600000 }); for (const it of r.imported || []) { byId.set(it.id, it); byName.set(normName(it.name), it); if (it.mediaPath) byPath.set(it.mediaPath, it); } if (r.offline?.length) plan.warnings.push(`offline after import: ${r.offline.map((o) => o.name).join(", ")}`); }
    for (const ai of plan.aeImports) { const r = await importAEComps({ aep_path: ai.aep, comp_names: ai.comps, bin: bin || "Imported", project }); for (const it of r.imported || []) { byId.set(it.id, it); byName.set(normName(it.name), it); } if (r.notCreated?.length) plan.warnings.push(`AE comps not created: ${r.notCreated.join(", ")}`); }
  }
  // 2. sequence
  let seqRef = tl.sequence;
  const seqs = await call("listSequences", { project }, { timeoutMs: 60000 });
  let seq = seqs.sequences.find((s) => s.id === seqRef || s.name === seqRef);
  if (!seq) {
    const fromSpec = tl.create_from_item ? { item: tl.create_from_item } : (tl.tracks.flatMap((t) => t.clips || [])[0] || null);
    const fromItem = fromSpec ? resolve(fromSpec) : null;
    plan.createSequence = { name: String(seqRef), fromItem: fromItem ? fromItem.name : (dry_run ? "(first clip after import)" : null) };
    if (!dry_run) {
      if (!fromItem) throw new Error("Can't create the sequence: no resolvable first clip to copy settings from (give create_from_item).");
      const created = await call("createSequence", { name: String(seqRef), fromItem: fromItem.id, project }, { timeoutMs: 120000 });
      seqRef = created.id;
      seq = { id: created.id, name: created.name, videoTracks: created.videoTracks, audioTracks: created.audioTracks };
    }
  } else seqRef = seq.id;
  // 3. diff existing clips vs desired (patch mode)
  const existing = seq && !plan.createSequence ? await call("getSequence", { sequence: seqRef, project }, { timeoutMs: 120000 }) : null;
  const places = [];
  for (const t of tl.tracks) {
    const type = t.type === "audio" ? "audio" : "video", idx = Number(t.index) || 0;
    const desired = (t.clips || []).map((c) => ({ c, it: resolve(c) }));
    const ex = existing ? (existing.tracks.find((x) => x.type === type && x.index === idx)?.clips || []) : [];
    const keep = new Set();
    if ((mode || "patch") === "patch") {
      for (const e of ex) {
        const m = desired.find((d) => d.it && (d.it.id === e.itemId) && Number(d.c.start_frame ?? Math.round(d.c.start_seconds * (seq?.fps || 30))) === e.start.frames);
        if (m) { keep.add(m); } else plan.removes.push({ track: `${type} ${idx}`, clip: e.name, start: e.start });
      }
    }
    for (const d of desired) {
      if (keep.has(d)) continue;
      if (!d.it) { if (!dry_run) plan.warnings.push(`skipped "${d.c.item || d.c.comp || d.c.path}": not found after import`); else plan.places.push({ track: `${type} ${idx}`, item: d.c.item || d.c.comp || d.c.path, start_frame: d.c.start_frame, note: "will exist after import" }); continue; }
      const spec = { item: d.it.id, track_type: type, track_index: idx, start_frame: d.c.start_frame, start_seconds: d.c.start_seconds, in_frame: d.c.in_frame, out_frame: d.c.out_frame, in_seconds: d.c.in_seconds, out_seconds: d.c.out_seconds, mode: d.c.mode, video_only: d.c.video_only ?? (d.it.type === "clip" && /\.aep$/i.test(d.it.mediaPath || "") ? true : undefined) };
      places.push(spec); plan.places.push({ track: `${type} ${idx}`, item: d.it.name, start_frame: d.c.start_frame ?? null, start_seconds: d.c.start_seconds ?? null, video_only: spec.video_only });
    }
  }
  if (dry_run) return { dryRun: true, sequence: seq ? seq.name : plan.createSequence?.name, plan };
  // 4. apply removes (clips whose start matches, by track)
  for (const r of plan.removes) { const [type, idx] = r.track.split(" "); await call("removeClips", { sequence: seqRef, trackType: type, trackIndex: Number(idx), fromFrame: r.start.frames, toFrame: r.start.frames + 1, overlapping: true, project }, { timeoutMs: 60000 }); }
  // tracks needed?
  const maxV = Math.max(-1, ...tl.tracks.filter((t) => t.type !== "audio").map((t) => Number(t.index) || 0)), maxA = Math.max(-1, ...tl.tracks.filter((t) => t.type === "audio").map((t) => Number(t.index) || 0));
  const seqInfo = await call("getSequence", { sequence: seqRef, clips: false, project }, { timeoutMs: 60000 });
  const haveV = seqInfo.tracks.filter((t) => t.type === "video").length, haveA = seqInfo.tracks.filter((t) => t.type === "audio").length;
  if (maxV + 1 > haveV || maxA + 1 > haveA) await call("addTracks", { sequence: seqRef, video: Math.max(0, maxV + 1 - haveV), audio: Math.max(0, maxA + 1 - haveA), project }, { timeoutMs: 60000 });
  const placed = places.length ? await call("placeClips", { clips: places.map(placeArgs), sequence: seqRef, project }, { timeoutMs: 600000 }) : { results: [] };
  const final = await call("getSequence", { sequence: seqRef, project }, { timeoutMs: 120000 });
  return { sequence: { id: final.id, name: final.name, fps: final.fps, end: final.end }, imported: plan.imports, aeImported: plan.aeImports, created: !!plan.createSequence, removed: plan.removes.length, placed: placed.results.map((r) => r.placed || (r.clip ? [r.clip] : [])).flat().map((c) => ({ track: c.track, name: c.name, start: c.start.frames, end: c.end.frames })), warnings: plan.warnings };
}

tool("pr_build_from_timeline", {
  title: "Build sequence from JSON timeline",
  description: `Build or patch a sequence from a JSON timeline, importing missing media and After Effects comps first.
timeline = { sequence: "name or id", create_from_item?: "item to copy settings from", tracks: [ { type: "video"|"audio", index: 0, clips: [ { item?: "id or unique name", path?: "/media/file.mov", aep?: "/x.aep", comp?: "Comp name", start_frame: 0, in_frame?, out_frame?, mode?: "overwrite"|"insert", video_only?: true } ] } ] }.
Existing clips on the listed tracks that don't match the timeline are removed (patch mode); mode "append" keeps them. dry_run reports every import/remove/place it would do.`,
  inputSchema: { timeline: z.any(), mode: z.enum(["patch", "append"]).optional(), bin: z.string().optional().describe("bin for imported media (default 'Imported')"), project: Project, dry_run: DryRun },
}, async (a) => text(await buildFromTimeline(a)));

// ------------------------------------------------------------------ edit spec (ordered shots → timeline)
const ShotRef = { item: z.string().optional().describe("project item id or unique name"), path: z.string().optional().describe("media file to import if not in the project"), aep: z.string().optional(), comp: z.string().optional().describe("After Effects comp (with aep) to Dynamic Link") };
const EditShot = z.object({
  ...ShotRef,
  name: z.string().optional().describe("label for the marker / summary (default: item name)"),
  duration_seconds: z.number().optional(), duration_frames: z.number().optional(),
  in_seconds: z.number().optional(), in_frame: z.number().optional(),
  gap_seconds: z.number().optional().describe("empty space before this shot"), gap_frames: z.number().optional(),
  track: z.number().int().optional().describe("video track index (default 0)"),
  video_only: z.boolean().optional(), marker: z.union([z.boolean(), z.string()]).optional().describe("false: no marker; string: marker name"),
  color: MarkerColor,
});
const EditAudio = z.object({ ...ShotRef, name: z.string().optional(), start_seconds: z.number().optional(), start_frame: z.number().optional(), in_seconds: z.number().optional(), in_frame: z.number().optional(), duration_seconds: z.number().optional(), duration_frames: z.number().optional(), track: z.number().int().optional().describe("audio track index (default 0)") });

tool("pr_build_from_edit", {
  title: "Build sequence from an edit list",
  description: `Higher-level than pr_build_from_timeline: an ordered list of shots, each with a duration (or its whole length), laid back to back from start_seconds (default 0), plus optional audio beds (music, VO) on audio tracks. Resolves every shot to frames at the sequence fps, imports media / AE comps that aren't in the project, builds or patches the sequence, and (markers: true, default) adds a sequence marker per shot. Returns the resolved edit (start/end per shot) and the build result; dry_run shows the resolved edit and the plan without changing anything. Shots whose duration is unknown until import need duration_seconds in dry_run.`,
  inputSchema: {
    sequence: z.string().describe("sequence name or id (created if missing, settings copied from the first shot)"),
    create_from_item: z.string().optional(),
    shots: z.array(EditShot).min(1),
    audio: z.array(EditAudio).optional(),
    start_seconds: z.number().optional(), start_frame: z.number().optional(),
    fps: z.number().optional().describe("frame rate for seconds→frames when the sequence doesn't exist yet (default: first shot's media fps, else 30)"),
    markers: z.boolean().optional().describe("add a sequence marker per shot (default true)"),
    marker_color: MarkerColor,
    mode: z.enum(["patch", "append"]).optional(), bin: z.string().optional(), project: Project, dry_run: DryRun,
  },
}, async (a) => {
  const { project, dry_run } = a;
  const warnings = [];
  // 1. project items (with durations) + sequence fps
  const items = await call("listItems", { project, durations: true, limit: 5000 }, { timeoutMs: 120000 });
  const byId = new Map(), byName = new Map(), byPath = new Map();
  const index = (it) => { byId.set(it.id, it); if (!byName.has(normName(it.name))) byName.set(normName(it.name), it); if (it.mediaPath) byPath.set(it.mediaPath, it); };
  for (const it of items.items) index(it);
  const resolve = (c) => {
    if (c.item && byId.has(c.item)) return byId.get(c.item);
    if (c.item && byName.has(normName(c.item))) return byName.get(normName(c.item));
    if (c.path && byPath.has(c.path)) return byPath.get(c.path);
    if (c.path && byName.has(normName(path.basename(c.path)))) return byName.get(normName(path.basename(c.path)));
    if (c.comp && byName.has(normName(c.comp))) return byName.get(normName(c.comp));
    if (c.comp) for (const [k, v] of byName) if (k.startsWith(normName(c.comp) + "/")) return v;
    return null;
  };
  const all = [...a.shots, ...(a.audio || [])];
  // 2. import what's missing first (real run), so durations are known
  const needFiles = [...new Set(all.filter((c) => !resolve(c) && c.path).map((c) => c.path))];
  const needComps = new Map(); for (const c of all) if (!resolve(c) && !c.path && c.aep && c.comp) { if (!needComps.has(c.aep)) needComps.set(c.aep, new Set()); needComps.get(c.aep).add(c.comp); }
  const imported = { files: needFiles, aeComps: [...needComps].map(([aep, comps]) => ({ aep, comps: [...comps] })) };
  if (!dry_run) {
    if (needFiles.length) { const r = await call("importFiles", { paths: needFiles, bin: a.bin || "Imported", project }, { timeoutMs: 600000 }); for (const it of r.imported || []) index(it); if (r.offline?.length) warnings.push(`offline after import: ${r.offline.map((o) => o.name).join(", ")}`); }
    for (const ai of imported.aeComps) { const r = await importAEComps({ aep_path: ai.aep, comp_names: ai.comps, bin: a.bin || "Imported", project }); for (const it of r.imported || []) index(it); if (r.notCreated?.length) warnings.push(`AE comps not created: ${r.notCreated.join(", ")}`); }
  }
  const seqs = await call("listSequences", { project }, { timeoutMs: 60000 });
  const seq = seqs.sequences.find((s) => s.id === a.sequence || s.name === a.sequence) || null;
  const firstIt = resolve(a.shots[0]);
  const fps = seq?.fps || a.fps || firstIt?.frameRate || 30;
  const fpsSource = seq ? "sequence" : a.fps ? "fps argument" : firstIt?.frameRate ? "first shot's media" : "default 30";
  const toF = (sec) => Math.round(sec * fps);
  const frames = (c, fKey, sKey, dflt) => c[fKey] !== undefined && c[fKey] !== null ? Number(c[fKey]) : (c[sKey] !== undefined && c[sKey] !== null ? toF(Number(c[sKey])) : dflt);
  // 3. lay the shots back to back
  let cursor = frames(a, "start_frame", "start_seconds", 0);
  const resolved = [], videoTracks = new Map(), markers = [];
  a.shots.forEach((sh, i) => {
    const it = resolve(sh);
    const label = sh.name || it?.name || sh.comp || (sh.path ? path.basename(sh.path) : sh.item) || `shot ${i + 1}`;
    cursor += frames(sh, "gap_frames", "gap_seconds", 0);
    const inF = frames(sh, "in_frame", "in_seconds", 0);
    let dur = frames(sh, "duration_frames", "duration_seconds", null);
    let note;
    if (dur === null) {
      const mediaSec = it?.duration?.seconds;
      if (mediaSec !== undefined) { dur = Math.max(0, toF(mediaSec) - inF); note = "whole clip"; }
      else { note = dry_run ? "duration unknown until import; give duration_seconds for an exact plan" : "duration unknown"; warnings.push(`shot ${i + 1} "${label}": ${note}`); }
    } else if (it?.duration?.seconds !== undefined && inF + dur > toF(it.duration.seconds) + 1) warnings.push(`shot ${i + 1} "${label}": in + duration (${inF + dur} f) exceeds the media (${toF(it.duration.seconds)} f); Premiere will clamp it`);
    const trackIdx = sh.track ?? 0;
    const clip = { item: it ? it.id : sh.item, path: it ? undefined : sh.path, aep: it ? undefined : sh.aep, comp: it ? undefined : sh.comp, start_frame: cursor, in_frame: inF, out_frame: dur !== null ? inF + dur : undefined, video_only: sh.video_only };
    if (!videoTracks.has(trackIdx)) videoTracks.set(trackIdx, []);
    videoTracks.get(trackIdx).push(clip);
    const endF = dur !== null ? cursor + dur : null;
    resolved.push({ index: i + 1, name: label, item: it?.name || null, track: `video ${trackIdx}`, start: { frames: cursor, seconds: +(cursor / fps).toFixed(6), timecode: tcOf(cursor / fps, fps) }, end: endF !== null ? { frames: endF, seconds: +(endF / fps).toFixed(6), timecode: tcOf(endF / fps, fps) } : null, duration_frames: dur, in_frame: inF, note });
    if (sh.marker !== false && (a.markers ?? true)) markers.push({ startFrame: cursor, endFrame: endF ?? undefined, name: typeof sh.marker === "string" ? sh.marker : label, color: sh.color ?? a.marker_color });
    if (dur !== null) cursor += dur;
  });
  const audioTracks = new Map();
  (a.audio || []).forEach((au, i) => {
    const it = resolve(au);
    const startF = frames(au, "start_frame", "start_seconds", 0), inF = frames(au, "in_frame", "in_seconds", 0), dur = frames(au, "duration_frames", "duration_seconds", null);
    const trackIdx = au.track ?? 0;
    if (!audioTracks.has(trackIdx)) audioTracks.set(trackIdx, []);
    audioTracks.get(trackIdx).push({ item: it ? it.id : au.item, path: it ? undefined : au.path, start_frame: startF, in_frame: inF, out_frame: dur !== null ? inF + dur : undefined });
    resolved.push({ index: `audio ${i + 1}`, name: au.name || it?.name || au.item || (au.path ? path.basename(au.path) : "?"), item: it?.name || null, track: `audio ${trackIdx}`, start: { frames: startF, seconds: +(startF / fps).toFixed(6), timecode: tcOf(startF / fps, fps) }, duration_frames: dur });
  });
  const timeline = { sequence: a.sequence, create_from_item: a.create_from_item, tracks: [
    ...[...videoTracks].map(([index, clips]) => ({ type: "video", index, clips })),
    ...[...audioTracks].map(([index, clips]) => ({ type: "audio", index, clips })),
  ] };
  // 4. build (or plan)
  const build = await buildFromTimeline({ timeline, mode: a.mode, bin: a.bin, project, dry_run });
  const out = { fps, fpsSource, totalDuration: { frames: cursor, seconds: +(cursor / fps).toFixed(6), timecode: tcOf(cursor / fps, fps) }, edit: resolved, imported, build, warnings: [...warnings, ...(build.warnings || [])] };
  if (dry_run) { out.dryRun = true; out.markersPlanned = markers.map((m) => ({ name: m.name, start_frame: m.startFrame, end_frame: m.endFrame })); return text(out); }
  // 5. markers (one per shot; existing markers with the same names are replaced)
  if (markers.length) {
    const seqRef = build.sequence.id;
    const added = [];
    for (const m of markers) {
      try { await call("removeMarkers", { sequence: seqRef, filter: m.name, fromFrame: m.startFrame, toFrame: m.startFrame, project }, { timeoutMs: 60000 }); } catch {}
      const r = await call("addMarker", { sequence: seqRef, startFrame: m.startFrame, endFrame: m.endFrame, name: m.name, color: m.color, project }, { timeoutMs: 60000 });
      added.push({ name: r.marker.name, start: r.marker.start.timecode, end: r.marker.end.timecode });
    }
    out.markers = added;
  }
  return text(out);
});

tool("pr_compare_sequences", {
  title: "Compare two sequences",
  description: "Diff two sequences clip-by-clip per track (same or different projects): names, source item/media, start/end/in/out frames. Returns mismatches, missing and extra clips. Use to verify a rebuild against a reference.",
  inputSchema: { sequence_a: Seq, project_a: Project, sequence_b: Seq, project_b: Project, tolerance_frames: z.number().int().optional().describe("default 0"), compare_names: z.boolean().optional().describe("default true") },
  annotations: { readOnlyHint: true },
}, async ({ sequence_a, project_a, sequence_b, project_b, tolerance_frames, compare_names }) => {
  const A = await call("getSequence", { sequence: sequence_a, project: project_a }, { timeoutMs: 120000 });
  const B = await call("getSequence", { sequence: sequence_b, project: project_b }, { timeoutMs: 120000 });
  const tol = tolerance_frames ?? 0, names = compare_names !== false;
  const out = { a: { name: A.name, fps: A.fps, end: A.end.frames }, b: { name: B.name, fps: B.fps, end: B.end.frames }, mismatches: [], missingInB: [], extraInB: [], matched: 0, trackDiffs: [] };
  if (Math.abs(A.fps - B.fps) > 0.001) out.trackDiffs.push(`fps differs: ${A.fps} vs ${B.fps}`);
  const key = (t) => `${t.type} ${t.index}`;
  const bTracks = new Map(B.tracks.map((t) => [key(t), t]));
  for (const ta of A.tracks) {
    const tb = bTracks.get(key(ta)); bTracks.delete(key(ta));
    if (!tb) { out.trackDiffs.push(`track ${key(ta)} missing in B (${ta.clips.length} clips)`); continue; }
    const used = new Set();
    for (const ca of ta.clips) {
      let best = null, bestD = Infinity;
      tb.clips.forEach((cb, i) => { if (used.has(i)) return; const d = Math.abs(cb.start.frames - ca.start.frames); if (d < bestD) { bestD = d; best = i; } });
      if (best === null || bestD > Math.max(tol, 0)) { out.missingInB.push({ track: key(ta), name: ca.name, start: ca.start.frames, end: ca.end.frames }); continue; }
      used.add(best); const cb = tb.clips[best]; const diffs = [];
      if (names && normName(ca.itemName || ca.name) !== normName(cb.itemName || cb.name)) diffs.push(`source ${ca.itemName || ca.name} vs ${cb.itemName || cb.name}`);
      for (const f of ["start", "end", "inPoint", "outPoint"]) if (Math.abs((ca[f]?.frames ?? 0) - (cb[f]?.frames ?? 0)) > tol) diffs.push(`${f} ${ca[f]?.frames} vs ${cb[f]?.frames}`);
      if (ca.enabled !== cb.enabled) diffs.push(`enabled ${ca.enabled} vs ${cb.enabled}`);
      if (diffs.length) out.mismatches.push({ track: key(ta), a: ca.name, b: cb.name, start: ca.start.frames, diffs }); else out.matched++;
    }
    tb.clips.forEach((cb, i) => { if (!used.has(i)) out.extraInB.push({ track: key(ta), name: cb.name, start: cb.start.frames, end: cb.end.frames }); });
  }
  for (const [k, tb] of bTracks) if (tb.clips.length) out.trackDiffs.push(`track ${k} only in B (${tb.clips.length} clips)`);
  out.identical = !out.mismatches.length && !out.missingInB.length && !out.extraInB.length && !out.trackDiffs.length;
  return text(out);
});

// ------------------------------------------------------------------ frames / render
tool("pr_export_frame", {
  title: "Export frame to PNG",
  description: "Write one frame of a sequence to a PNG file (full sequence resolution).",
  inputSchema: { sequence: Seq, frame: z.number().optional(), seconds: z.number().optional(), png_path: z.string(), project: Project },
}, async (a) => text(await call("exportFrame", { sequence: a.sequence, frame: a.frame, seconds: a.seconds, path: a.png_path, project: a.project }, { timeoutMs: 60000 })));

tool("pr_export_frames", {
  title: "Export many frames",
  description: "Export a list of frames (frames or seconds) of a sequence to PNGs in one call: out_dir + name pattern ({seq}, {frame}, {tc}). contact_sheet: true also tiles them into one labelled image (needs ffmpeg).",
  inputSchema: { sequence: Seq, frames: z.array(z.number()).optional(), seconds: z.array(z.number()).optional(), out_dir: z.string(), pattern: z.string().optional().describe("default '{seq}_f{frame}.png'"), contact_sheet: z.boolean().optional(), sheet_columns: z.number().int().optional(), project: Project },
}, async (a) => {
  const list = (a.frames || []).map((f) => ({ frame: f })).concat((a.seconds || []).map((s) => ({ seconds: s })));
  if (!list.length) throw new Error("give frames or seconds");
  await fs.mkdir(a.out_dir, { recursive: true });
  const out = [], pattern = a.pattern || "{seq}_f{frame}.png";
  for (const spec of list) {
    const tmp = path.join(a.out_dir, `.tmp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.png`);
    const r = await call("exportFrame", { sequence: a.sequence, frame: spec.frame, seconds: spec.seconds, path: tmp, project: a.project }, { timeoutMs: 60000 });
    const name = pattern.replace("{seq}", String(a.sequence ?? "sequence").replace(/[^\w.-]+/g, "_")).replace("{frame}", String(r.frame).padStart(5, "0")).replace("{tc}", r.timecode.replace(/[:;]/g, "-"));
    const dest = path.join(a.out_dir, name.endsWith(".png") ? name : name + ".png");
    await fs.rename(r.path, dest);
    out.push({ path: dest, frame: r.frame, seconds: r.seconds, timecode: r.timecode });
  }
  const res = { count: out.length, frames: out };
  if (a.contact_sheet) { const sheet = await contactSheet(out.map((o) => o.path), path.join(a.out_dir, "contact_sheet.png"), { cols: a.sheet_columns, labels: out.map((o) => `f${o.frame} ${o.timecode}`) }); res.contactSheet = sheet || "ffmpeg not found — no sheet made"; }
  return text(res);
});

tool("pr_show_frame", {
  title: "Show frame",
  description: "Export a frame of a sequence and return it inline as an image, to look at the timeline state.",
  inputSchema: { sequence: Seq, frame: z.number().optional(), seconds: z.number().optional(), max_size: z.number().int().optional(), project: Project },
  annotations: { readOnlyHint: true },
}, async (a) => {
  const dir = path.join(os.tmpdir(), "premiere-bridge-frames"); await fs.mkdir(dir, { recursive: true });
  const p = path.join(dir, `frame-${Date.now().toString(36)}.png`);
  const r = await call("exportFrame", { sequence: a.sequence, frame: a.frame, seconds: a.seconds, path: p, project: a.project }, { timeoutMs: 60000 });
  const small = p.replace(/\.png$/, "-s.png");
  await run("/usr/bin/sips", ["-Z", String(a.max_size ?? 1280), r.path, "--out", small]);
  const data = (await fs.readFile(small)).toString("base64");
  fs.rm(r.path, { force: true }).catch(() => {}); fs.rm(small, { force: true }).catch(() => {});
  return { content: [{ type: "image", data, mimeType: "image/png" }, { type: "text", text: `frame ${r.frame} (${r.seconds}s, ${r.timecode})` }] };
});

// ------------------------------------------------------------------ analysis: shot detection / review sheet
function tcOf(seconds, fps) {
  const drop = Math.abs(fps - 29.97) < 0.01 || Math.abs(fps - 59.94) < 0.01, rf = Math.round(fps);
  const total = Math.round(seconds * fps), f = total % rf, s = Math.floor(total / rf);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}${drop ? ";" : ":"}${p(f)}`;
}
const mediaTime = (seconds, fps) => ({ seconds: Math.round(seconds * 1000) / 1000, frames: Math.round(seconds * fps), timecode: tcOf(seconds, fps) });
async function ffprobePath() {
  if (process.env.FFPROBE) return process.env.FFPROBE;
  const ff = await ffmpegPath(); if (!ff) return null;
  const c = path.isAbsolute(ff) ? path.join(path.dirname(ff), "ffprobe") : "ffprobe";
  try { await run(c, ["-version"], { timeout: 5000 }); return c; } catch { return null; }
}
async function probeVideo(file) {
  const fp = await ffprobePath(); if (!fp) return { fps: null, duration: null };
  const { stdout } = await run(fp, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate,avg_frame_rate,nb_frames,width,height:format=duration", "-of", "json", file], { timeout: 60000 });
  const j = JSON.parse(stdout), st = j.streams?.[0] || {};
  const rate = (s) => { if (!s) return null; const [n, d] = String(s).split("/").map(Number); return d ? n / d : n; };
  const fps = rate(st.avg_frame_rate) || rate(st.r_frame_rate) || null;
  return { fps: fps ? Math.round(fps * 1000) / 1000 : null, duration: j.format?.duration ? Number(j.format.duration) : null, size: st.width ? [st.width, st.height] : undefined, nbFrames: st.nb_frames ? Number(st.nb_frames) : undefined };
}
// Resolve a project item (id or name) to its media path through the panel.
async function mediaPathOf(item, project) {
  const r = await call("listItems", { project, durations: false }, { timeoutMs: 120000 });
  const key = String(item);
  const hit = r.items.find((i) => String(i.id) === key) || r.items.filter((i) => i.name === key)[0] || r.items.filter((i) => String(i.name).toLowerCase() === key.toLowerCase())[0];
  if (!hit) throw new Error(`project item '${item}' not found (pr_list_items shows ids and names)`);
  if (!hit.mediaPath) throw new Error(`project item '${hit.name}' has no media path (type ${hit.type})`);
  if (hit.offline) throw new Error(`project item '${hit.name}' is offline: ${hit.mediaPath}`);
  return { path: hit.mediaPath, item: { id: hit.id, name: hit.name } };
}

tool("pr_detect_shots", {
  title: "Detect shots (scene changes)",
  description: "Find cuts in a media file with ffmpeg scene-change detection (select='gt(scene,threshold)' + showinfo, server-side; Premiere is only used to resolve a project item to its media path). Give item (project item id or name) or path. Returns cut points as seconds + frames (at the media's fps from ffprobe) + timecode, the shots between them, the ffmpeg command used and the total shot count. threshold 0-1 (default 0.3; lower finds more cuts), min_shot_seconds merges cuts closer than that to the previous kept cut, limit caps the cuts. add_markers: true adds a sequence marker per shot start ('Shot N', Shot 1 at time 0) on sequence, shifted by marker_offset_seconds / marker_offset_frame when the media sits later in the timeline (dry_run plans them instead).",
  inputSchema: {
    item: z.union([z.string(), z.number()]).optional().describe("project item id or name (resolved to its media path)"), path: z.string().optional().describe("media file path (instead of item)"),
    threshold: z.number().min(0).max(1).optional(), min_shot_seconds: z.number().min(0).optional(), limit: z.number().int().positive().optional(),
    add_markers: z.boolean().optional(), sequence: Seq, marker_color: MarkerColor, marker_offset_seconds: z.number().optional(), marker_offset_frame: z.number().optional(), marker_name: z.string().optional().describe("default 'Shot {n}'"),
    project: Project, dry_run: DryRun,
  },
}, async (a) => {
  const ff = await ffmpegPath(); if (!ff) throw new Error("ffmpeg not found (install it with Homebrew or set FFMPEG)");
  let file = a.path, item;
  if (!file) { if (a.item === undefined) throw new Error("give item or path"); ({ path: file, item } = await mediaPathOf(a.item, a.project)); }
  try { await fs.access(file); } catch { throw new Error(`media file not found: ${file}`); }
  const threshold = a.threshold ?? 0.3;
  const probe = await probeVideo(file);
  const fps = probe.fps || 30;
  const args = ["-nostats", "-hide_banner", "-i", file, "-vf", `select='gt(scene,${threshold})',metadata=print,showinfo`, "-an", "-f", "null", "-"];
  const command = [ff, ...args].map((s) => (/[\s'"]/.test(s) ? JSON.stringify(s) : s)).join(" ");
  let stderr = "";
  try { ({ stderr } = await run(ff, args, { timeout: 1800000, maxBuffer: 256 * 1024 * 1024 })); }
  catch (e) { throw new Error(`ffmpeg failed: ${(e.stderr || e.message).split("\n").filter(Boolean).slice(-3).join(" | ")}`); }
  // showinfo gives one line per selected frame; metadata=print adds the scene score for the same pts_time.
  const scores = new Map(); let lastT = null;
  for (const line of stderr.split("\n")) {
    const m = /Parsed_metadata.*pts_time:([\d.]+)/.exec(line); if (m) { lastT = m[1]; continue; }
    const s = /lavfi\.scene_score=([\d.]+)/.exec(line); if (s && lastT !== null) scores.set(lastT, Number(s[1]));
  }
  let raw = [];
  for (const line of stderr.split("\n")) { const m = /Parsed_showinfo.*\bpts_time:([\d.]+)/.exec(line); if (m) raw.push({ t: Number(m[1]), score: scores.get(m[1]) }); }
  raw.sort((x, y) => x.t - y.t);
  const minGap = a.min_shot_seconds ?? 0, cuts = []; let merged = 0, prev = 0;
  for (const c of raw) { if (c.t <= 0) continue; if (c.t - prev < minGap) { merged++; continue; } cuts.push(c); prev = c.t; }
  const dropped = a.limit && cuts.length > a.limit ? cuts.length - a.limit : 0; if (dropped) cuts.length = a.limit;
  const duration = probe.duration ?? (cuts.length ? cuts[cuts.length - 1].t : 0);
  const starts = [0, ...cuts.map((c) => c.t)];
  const shots = starts.map((s, i) => { const e = i + 1 < starts.length ? starts[i + 1] : duration; return { index: i + 1, start: mediaTime(s, fps), end: mediaTime(e, fps), duration: mediaTime(e - s, fps) }; });
  const res = { source: file, item, fps, duration: mediaTime(duration, fps), threshold, minShotSeconds: minGap, command, totalShots: shots.length, cuts: cuts.map((c) => ({ ...mediaTime(c.t, fps), score: c.score })), shots };
  if (merged) res.mergedCuts = merged; if (dropped) res.droppedByLimit = dropped;
  if (a.add_markers) {
    let offset = a.marker_offset_seconds ?? 0;
    if (a.marker_offset_frame !== undefined) { const s = await call("getSequence", { sequence: a.sequence, clips: false, project: a.project }, { timeoutMs: 60000 }); offset = a.marker_offset_frame / s.fps; }
    const tmpl = a.marker_name || "Shot {n}"; res.markers = [];
    for (const sh of shots) {
      const name = tmpl.replace("{n}", String(sh.index)), startSeconds = Math.round((offset + sh.start.seconds) * 10000) / 10000;
      const r = await call("addMarker", { sequence: a.sequence, startSeconds, name, comments: `shot ${sh.index}: ${sh.start.timecode} → ${sh.end.timecode} in ${path.basename(file)}`, color: a.marker_color, project: a.project, dryRun: a.dry_run }, { timeoutMs: 60000 });
      res.markers.push(a.dry_run ? { dryRun: true, name, start: r.plan.start } : { name: r.marker.name, guid: r.marker.guid, start: r.marker.start, color: r.marker.color });
    }
    if (a.dry_run) res.dryRun = true;
  }
  return text(res);
});

tool("pr_review_sheet", {
  title: "Review sheet (contact sheet of a sequence)",
  description: "One-call look at a whole edit: exports frames of a sequence (count evenly spaced, default 12; or at_clip_starts: true for every video clip start; or at_markers: true for every sequence marker; or explicit frames / seconds), tiles them into a labelled contact sheet (label = timecode + clip name at that time; needs ffmpeg) and returns it inline as an image plus a per-frame text summary: timecode, clip on the topmost enabled video track, markers at that time. out_path keeps the full-size sheet on disk.",
  inputSchema: {
    sequence: Seq, count: z.number().int().min(1).max(60).optional(), at_clip_starts: z.boolean().optional(), at_markers: z.boolean().optional(), frames: z.array(z.number()).optional(), seconds: z.array(z.number()).optional(),
    columns: z.number().int().positive().optional(), tile_width: z.number().int().positive().optional().describe("pixels per tile, default 480"), max_size: z.number().int().positive().optional().describe("longest side of the returned image, default 1600"),
    out_path: z.string().optional(), project: Project,
  },
  annotations: { readOnlyHint: true },
}, async (a) => {
  if (!(await ffmpegPath())) throw new Error("ffmpeg not found (install it with Homebrew or set FFMPEG)");
  const s = await call("getSequence", { sequence: a.sequence, project: a.project }, { timeoutMs: 120000 });
  const fps = s.fps, endSec = s.end.seconds;
  const video = s.tracks.filter((t) => t.type === "video");
  let times = [], mode;
  if (a.frames?.length || a.seconds?.length) { mode = "explicit"; times = (a.frames || []).map((f) => f / fps).concat(a.seconds || []); }
  else if (a.at_clip_starts) { mode = "clip starts"; for (const t of video) for (const c of t.clips) times.push(c.start.seconds); }
  else if (a.at_markers) { mode = "markers"; const m = await call("listMarkers", { sequence: a.sequence, project: a.project }, { timeoutMs: 60000 }); times = m.markers.map((x) => x.start.seconds); if (!times.length) throw new Error("the sequence has no markers"); }
  else { mode = "evenly spaced"; const n = a.count ?? 12; for (let i = 0; i < n; i++) times.push((endSec * i) / n); }
  times = [...new Set(times.map((t) => Math.round(t * fps) / fps))].filter((t) => t >= 0 && t <= endSec).sort((x, y) => x - y);
  if (!times.length) throw new Error("no frames to show (empty sequence?)");
  if (times.length > 60) throw new Error(`${times.length} frames is too many for one sheet (max 60); use count / frames to narrow`);
  const markers = (await call("listMarkers", { sequence: a.sequence, project: a.project }, { timeoutMs: 60000 }).catch(() => ({ markers: [] }))).markers;
  const half = 0.5 / fps;
  const clipAt = (t) => { let off = null; for (let i = video.length - 1; i >= 0; i--) { const c = video[i].clips.find((c) => c.start.seconds - half <= t && t < c.end.seconds - half); if (!c) continue; if (video[i].enabled !== false && c.enabled !== false) return { name: c.name, track: `V${i + 1}` }; off = off || { name: `${c.name} (disabled)`, track: `V${i + 1}` }; } return off; };
  const markersAt = (t) => markers.filter((m) => m.start.seconds - half <= t && t <= Math.max(m.end.seconds, m.start.seconds) + half).map((m) => m.name || m.comments || m.type);
  const dir = path.join(os.tmpdir(), "premiere-bridge-review", Date.now().toString(36)); await fs.mkdir(dir, { recursive: true });
  const rows = [];
  for (const [i, t] of times.entries()) {
    const r = await call("exportFrame", { sequence: a.sequence, seconds: t, path: path.join(dir, `f${String(i).padStart(3, "0")}.png`), project: a.project }, { timeoutMs: 60000 });
    const clip = clipAt(t), ms = markersAt(t);
    rows.push({ index: i + 1, seconds: r.seconds, frame: r.frame, timecode: r.timecode, clip: clip?.name ?? null, track: clip?.track, markers: ms, png: r.path });
  }
  const sheet = await contactSheet(rows.map((r) => r.png), a.out_path || path.join(dir, "sheet.png"), { cols: a.columns, width: a.tile_width ?? 480, labels: rows.map((r) => `${r.index}. ${r.timecode} ${r.clip ?? "(empty)"}`) });
  if (!sheet) throw new Error("ffmpeg could not build the contact sheet");
  const small = path.join(dir, "sheet-small.png");
  await run("/usr/bin/sips", ["-Z", String(a.max_size ?? 1600), sheet, "--out", small]);
  const data = (await fs.readFile(small)).toString("base64");
  const lines = [`${s.name}: ${rows.length} frames (${mode}), ${s.end.timecode} long, ${fps} fps${a.out_path ? `, sheet: ${sheet}` : ""}`];
  for (const r of rows) lines.push(`${String(r.index).padStart(2)}. ${r.timecode} (f${r.frame})  ${r.clip ? `${r.clip} [${r.track}]` : "(no clip)"}${r.markers.length ? `  markers: ${r.markers.join(", ")}` : ""}`);
  const gaps = rows.filter((r) => !r.clip).length; if (gaps) lines.push(`${gaps} of the sampled frames show no enabled video clip.`);
  fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  return { content: [{ type: "image", data, mimeType: "image/png" }, { type: "text", text: lines.join("\n") }] };
});

const AME_DIRS = () => [
  path.join(os.homedir(), "Documents", "Adobe", "Adobe Media Encoder"),
  path.join(os.homedir(), "Library", "Application Support", "Adobe", "Common", "AME"),
  "/Applications/Adobe Media Encoder 2026/Adobe Media Encoder 2026.app/Contents/MediaIO/systempresets",
  "/Applications/Adobe Media Encoder 2025/Adobe Media Encoder 2025.app/Contents/MediaIO/systempresets",
];
async function findPresets(filter) {
  const out = [];
  async function walk(dir, depth) {
    if (depth > 6) return;
    let ents; try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p, depth + 1);
      else if (/\.epr$/i.test(e.name) && (!filter || e.name.toLowerCase().includes(filter.toLowerCase()) || p.toLowerCase().includes(filter.toLowerCase()))) out.push(p);
    }
  }
  for (const d of AME_DIRS()) await walk(d, 0);
  return out;
}

tool("pr_list_export_presets", {
  title: "List export presets",
  description: "Find Adobe Media Encoder .epr presets (user presets first, then system presets) by name fragment, e.g. 'H.264', 'Match Source', 'ProRes'. Use a returned path as preset for pr_render.",
  inputSchema: { filter: z.string().optional(), limit: z.number().int().optional() },
  annotations: { readOnlyHint: true },
}, async ({ filter, limit }) => {
  const all = await findPresets(filter);
  const lines = all.slice(0, limit ?? 60).map((p) => path.basename(p, ".epr") + "\t" + p);
  return text(`${all.length} preset(s)${all.length > lines.length ? `, showing ${lines.length}` : ""}\n${lines.join("\n")}`);
});

tool("pr_render", {
  title: "Render sequence",
  description: "Render a sequence with an Adobe Media Encoder preset. preset: an absolute .epr path, or a name fragment that matches exactly one preset (see pr_list_export_presets). range: entire (default) | inout | workarea, or give in/out frames/seconds. mode 'ame' (default) queues the job in Media Encoder and returns a jobId right away; mode 'direct' renders inside Premiere and waits for the file.",
  inputSchema: {
    sequence: Seq, preset: z.string(), out_path: z.string(),
    range: z.enum(["entire", "inout", "workarea"]).optional(),
    in_frame: z.number().optional(), out_frame: z.number().optional(), in_seconds: z.number().optional(), out_seconds: z.number().optional(),
    mode: z.enum(["ame", "direct"]).optional(), remove_on_completion: z.boolean().optional(), timeout_sec: z.number().int().optional(), project: Project, dry_run: DryRun,
  },
}, async (a) => {
  let presetPath = a.preset;
  if (!path.isAbsolute(presetPath) || !/\.epr$/i.test(presetPath)) {
    const matches = await findPresets(a.preset);
    const exact = matches.filter((p) => path.basename(p, ".epr").toLowerCase() === a.preset.toLowerCase());
    const pick = exact.length ? exact : matches;
    if (!pick.length) throw new Error(`No .epr preset matches "${a.preset}". Use pr_list_export_presets.`);
    if (pick.length > 1 && !exact.length) throw new Error(`"${a.preset}" matches ${pick.length} presets; pass one path:\n${pick.slice(0, 15).join("\n")}`);
    presetPath = pick[0];
  }
  const r = await call("render", { sequence: a.sequence, presetPath, path: a.out_path, range: a.range, inFrame: a.in_frame, outFrame: a.out_frame, inSeconds: a.in_seconds, outSeconds: a.out_seconds, mode: a.mode, removeOnCompletion: a.remove_on_completion, project: a.project, dryRun: a.dry_run }, { timeoutMs: (a.timeout_sec ?? (a.mode === "direct" ? 3600 : 120)) * 1000 });
  return text({ preset: presetPath, ...r });
});

// ------------------------------------------------------------------ escape hatch
tool("pr_run_script", {
  title: "Run ExtendScript in Premiere",
  description: "Run arbitrary ExtendScript inside Premiere Pro. Helpers in scope: getProject(nameOrPath), getSequence(project, nameOrId), findItem(idOrName), findBin(path, create), findSequence(ref), qeSequence(seq), makeTime(sec), timeInfo(t, seq), itemInfo(item), clipInfo(clip, seq, type, trackIdx, clipIdx), log(...). The last expression's value is returned (plain data as JSON; Premiere objects as {[type], name, id}); log() lines come back as 'output'. Errors include the line number and source context. With several projects open pass project (or use getSequence(project, ...)) — app.project is whichever Premiere last activated.",
  inputSchema: { code: z.string().optional(), file_path: z.string().optional(), timeout_sec: z.number().int().optional(), project: Project },
}, async ({ code, file_path, timeout_sec, project }) => {
  if (!code && !file_path) throw new Error("give code or file_path");
  return text(await call("runScript", { code, file: file_path, project }, { timeoutMs: (timeout_sec ?? 300) * 1000 }));
});

await server.connect(new StdioServerTransport());
