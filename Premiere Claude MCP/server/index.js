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
pr_run_script runs raw ExtendScript with helpers: getProject(nameOrPath), getSequence(project, nameOrId), findItem(ref),
findBin(path, create), qeSequence(seq), makeTime(sec), timeInfo(t, seq), log(...) (collected into "output").`;

const server = new McpServer({ name: "premiere-bridge", version: "1.2.0" }, { instructions: INSTRUCTIONS });
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
  description: "Move a clip on its track: to_frame / to_seconds (absolute) or delta_frames / delta_seconds (nudge). Fails if Premiere refuses (e.g. another clip in the way).",
  inputSchema: { sequence: Seq, track_type: TrackType, track_index: z.number().int().optional(), clip_index: z.number().int().optional(), at_frame: z.number().optional(), at_seconds: z.number().optional(), to_frame: z.number().optional(), to_seconds: z.number().optional(), delta_frames: z.number().optional(), delta_seconds: z.number().optional(), project: Project, dry_run: DryRun },
}, async (a) => text(await call("moveClip", { sequence: a.sequence, trackType: a.track_type, trackIndex: a.track_index ?? 0, clipIndex: a.clip_index, atFrame: a.at_frame, atSeconds: a.at_seconds, toFrame: a.to_frame, toSeconds: a.to_seconds, deltaFrames: a.delta_frames, deltaSeconds: a.delta_seconds, project: a.project, dryRun: a.dry_run }, { timeoutMs: 60000 })));

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

// ------------------------------------------------------------------ build / compare
function normName(s) { return String(s || "").replace(/\.[^.]+$/, "").toLowerCase(); }

tool("pr_build_from_timeline", {
  title: "Build sequence from JSON timeline",
  description: `Build or patch a sequence from a JSON timeline, importing missing media and After Effects comps first.
timeline = { sequence: "name or id", create_from_item?: "item to copy settings from", tracks: [ { type: "video"|"audio", index: 0, clips: [ { item?: "id or unique name", path?: "/media/file.mov", aep?: "/x.aep", comp?: "Comp name", start_frame: 0, in_frame?, out_frame?, mode?: "overwrite"|"insert", video_only?: true } ] } ] }.
Existing clips on the listed tracks that don't match the timeline are removed (patch mode); mode "append" keeps them. dry_run reports every import/remove/place it would do.`,
  inputSchema: { timeline: z.any(), mode: z.enum(["patch", "append"]).optional(), bin: z.string().optional().describe("bin for imported media (default 'Imported')"), project: Project, dry_run: DryRun },
}, async ({ timeline: tl, mode, bin, project, dry_run }) => {
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
  if (dry_run) return text({ dryRun: true, sequence: seq ? seq.name : plan.createSequence?.name, plan });
  // 4. apply removes (clips whose start matches, by track)
  for (const r of plan.removes) { const [type, idx] = r.track.split(" "); await call("removeClips", { sequence: seqRef, trackType: type, trackIndex: Number(idx), fromFrame: r.start.frames, toFrame: r.start.frames + 1, overlapping: true, project }, { timeoutMs: 60000 }); }
  // tracks needed?
  const maxV = Math.max(-1, ...tl.tracks.filter((t) => t.type !== "audio").map((t) => Number(t.index) || 0)), maxA = Math.max(-1, ...tl.tracks.filter((t) => t.type === "audio").map((t) => Number(t.index) || 0));
  const seqInfo = await call("getSequence", { sequence: seqRef, clips: false, project }, { timeoutMs: 60000 });
  const haveV = seqInfo.tracks.filter((t) => t.type === "video").length, haveA = seqInfo.tracks.filter((t) => t.type === "audio").length;
  if (maxV + 1 > haveV || maxA + 1 > haveA) await call("addTracks", { sequence: seqRef, video: Math.max(0, maxV + 1 - haveV), audio: Math.max(0, maxA + 1 - haveA), project }, { timeoutMs: 60000 });
  const placed = places.length ? await call("placeClips", { clips: places.map(placeArgs), sequence: seqRef, project }, { timeoutMs: 600000 }) : { results: [] };
  const final = await call("getSequence", { sequence: seqRef, project }, { timeoutMs: 120000 });
  return text({ sequence: { id: final.id, name: final.name, fps: final.fps, end: final.end }, imported: plan.imports, aeImported: plan.aeImports, created: !!plan.createSequence, removed: plan.removes.length, placed: placed.results.map((r) => r.placed || (r.clip ? [r.clip] : [])).flat().map((c) => ({ track: c.track, name: c.name, start: c.start.frames, end: c.end.frames })), warnings: plan.warnings });
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
