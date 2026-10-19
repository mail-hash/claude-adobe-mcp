// End-to-end self-test against a live Premiere Pro with the Claude Bridge panel open. Exercises every tool.
// Usage: node test/selftest.mjs [--keep] [--no-render] [--ae /path/to.aep --comp "Comp name"]
// Writes under ~/Library/Application Support/Premiere Claude Bridge/selftest/<timestamp>/ and closes its projects unless --keep.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { evalScript } from "../server/bridge.js";

const run = promisify(execFile);
const argv = process.argv.slice(2);
const keep = argv.includes("--keep"), noRender = argv.includes("--no-render");
const aeArg = argv.includes("--ae") ? argv[argv.indexOf("--ae") + 1] : null;
const compArg = argv.includes("--comp") ? argv[argv.indexOf("--comp") + 1] : null;
const dir = path.join(os.homedir(), "Library", "Application Support", "Premiere Claude Bridge", "selftest", new Date().toISOString().replace(/[:.]/g, "-"));
await fs.mkdir(dir, { recursive: true });

// Drive the real MCP server over stdio, exactly like Claude Desktop does.
const transport = new StdioClientTransport({ command: "node", args: [fileURLToPath(new URL("../server/index.js", import.meta.url))], env: { ...process.env } });
const client = new Client({ name: "selftest", version: "1" });
await client.connect(transport);
const toolNames = (await client.listTools()).tools.map((t) => t.name);
const covered = new Set();
async function tool(name, args = {}) {
  covered.add(name);
  const r = await client.callTool({ name, arguments: args });
  const txt = r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  if (r.isError) throw new Error(`${name}: ${txt}`);
  const img = r.content.find((c) => c.type === "image");
  try { return img ? { image: img.data.length, text: txt } : JSON.parse(txt); } catch { return txt; }
}

const results = [];
async function step(name, fn, { optional = false } = {}) {
  const t0 = Date.now();
  try { const r = await fn(); results.push({ step: name, ok: true, ms: Date.now() - t0 }); console.log(`✓ ${name} (${Date.now() - t0} ms) ${r !== undefined ? JSON.stringify(r).slice(0, 220) : ""}`); return r; }
  catch (e) { results.push({ step: name, ok: optional ? "skipped" : false, ms: Date.now() - t0, error: e.message }); console.log(`${optional ? "○" : "✗"} ${name}: ${e.message.split("\n")[0].slice(0, 300)}`); if (!optional) throw e; return null; }
}
const assert = (c, m) => { if (!c) throw new Error("assertion failed: " + m); };

// test media: two small PNGs
async function png(name, rgb) { const ppm = path.join(dir, name + ".ppm"), out = path.join(dir, name + ".png"); await fs.writeFile(ppm, Buffer.concat([Buffer.from("P6\n320 180\n255\n"), Buffer.alloc(320 * 180 * 3).fill(Buffer.from(rgb))])); await run("/usr/bin/sips", ["-s", "format", "png", ppm, "--out", out]); return out; }
const red = await png("red", [220, 40, 40]), blue = await png("blue", [40, 80, 220]);
// two-colour mp4 with one guaranteed cut at 1 s (for pr_detect_shots); skipped when ffmpeg is missing
let ffmpegBin = null; for (const c of [process.env.FFMPEG, "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "ffmpeg"].filter(Boolean)) { try { await run(c, ["-version"]); ffmpegBin = c; break; } catch {} }
const cutClip = path.join(dir, "cut.mp4");
if (ffmpegBin) await run(ffmpegBin, ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=320x180:r=30:d=1", "-f", "lavfi", "-i", "color=c=blue:s=320x180:r=30:d=1", "-filter_complex", "[0][1]concat=n=2:v=1:a=0", "-pix_fmt", "yuv420p", cutClip]);
const projA = path.join(dir, "selftest-A.prproj"), projB = path.join(dir, "selftest-B.prproj");

try {
  const st = await step("pr_status", () => tool("pr_status"));
  assert(st.panel && st.panel.jsxLoaded, "panel not reachable / host.jsx not loaded");
  assert(st.responsive, "Premiere not responsive: " + st.error);
  if (st.modalDialogs?.length) throw new Error("Premiere has a dialog open: " + JSON.stringify(st.modalDialogs));

  await step("pr_new_project A", () => tool("pr_new_project", { path: projA }));
  await step("pr_import_files dry_run", async () => { const r = await tool("pr_import_files", { paths: [red], bin: "Selftest", dry_run: true }); assert(r.dryRun && r.plan.paths.length === 1, "dry run plan"); return r.plan; });
  const imp = await step("pr_import_files", () => tool("pr_import_files", { paths: ffmpegBin ? [red, blue, cutClip] : [red, blue], bin: "Selftest", project: projA }));
  const cutItem = imp.imported.find((i) => i.name === "cut.mp4");
  const redItem = imp.imported.find((i) => i.name === "red.png"), blueItem = imp.imported.find((i) => i.name === "blue.png");
  assert(redItem && blueItem, "both PNGs imported");
  await step("pr_import_files warns on rejected file", async () => { await fs.writeFile(path.join(dir, "bogus.xml"), "<xmeml version='5'><sequence><name>x</name></sequence></xmeml>"); const r = await tool("pr_import_files", { paths: [path.join(dir, "bogus.xml")], bin: "Selftest", project: projA }); assert(r.warning || r.imported.length, "warning or items"); return r.warning ? "warned" : "imported"; });
  await step("pr_list_items", async () => { const r = await tool("pr_list_items", { filter: "png", project: projA }); assert(r.items.some((i) => i.id === redItem.id), "red listed"); return r.total; });

  const seq = await step("pr_create_sequence", () => tool("pr_create_sequence", { name: "Selftest sequence", from_item: redItem.id, project: projA }));
  await step("pr_list_sequences", async () => { const r = await tool("pr_list_sequences", { project: projA }); assert(r.sequences.some((s) => s.id === seq.id), "sequence listed"); assert(r.sequences[0].end.timecode, "timecode present"); return r.sequences.length; });
  await step("pr_place_clip dry_run", async () => { const r = await tool("pr_place_clip", { item: redItem.id, sequence: seq.id, start_frame: 30, dry_run: true, project: projA }); assert(r.dryRun && r.plan.start.frames === 30, "plan frames"); return r.plan.start; });
  const placed = await step("pr_place_clip @30 video_only", () => tool("pr_place_clip", { item: redItem.id, sequence: seq.id, track_index: 0, start_frame: 30, video_only: true, project: projA }));
  assert(placed.clip.start.frames === 30 && placed.clip.start.timecode, "placed at frame 30 with timecode");
  const batch = await step("pr_place_clips batch", () => tool("pr_place_clips", { sequence: seq.id, project: projA, clips: [
    { item: blueItem.id, track_index: 0, start_frame: 200, in_frame: 10, out_frame: 40 },
    { item: redItem.id, track_index: 0, start_frame: 300, in_frame: 0, out_frame: 60 },
  ] }));
  assert(batch.count === 2, "two placed");
  await step("pr_get_sequence", async () => { const r = await tool("pr_get_sequence", { sequence: seq.id, project: projA }); const v1 = r.tracks.find((t) => t.type === "video" && t.index === 0); assert(v1.clips.length === 3, "3 clips on V1, got " + v1.clips.length); assert(v1.clips[0].start.frames === 30 && v1.clips[1].start.frames === 200 && v1.clips[1].inPoint.frames === 10, "positions"); assert(v1.clips[0].mediaPath, "mediaPath present"); return v1.clips.map((c) => [c.name, c.start.frames, c.end.frames]); });
  await step("pr_replace_clip", async () => { const r = await tool("pr_replace_clip", { sequence: seq.id, track_index: 0, clip_index: 1, new_item: redItem.id, project: projA }); assert(r.clip.start.frames === 200 && r.clip.end.frames === 230, "position kept"); return [r.replaced, r.with]; });
  await step("pr_set_clip_enabled", async () => { const r = await tool("pr_set_clip_enabled", { sequence: seq.id, track_index: 0, clip_index: 1, enabled: false, project: projA }); assert(r.clip.enabled === false, "disabled"); return r.clip.enabled; });
  await step("pr_move_clip nudge +5", async () => { const r = await tool("pr_move_clip", { sequence: seq.id, track_index: 0, clip_index: 2, delta_frames: 5, project: projA }); assert(r.clip.start.frames === 305, "moved to 305, got " + r.clip.start.frames); return r.clip.start.frames; });
  await step("pr_move_clip dry_run", async () => { const r = await tool("pr_move_clip", { sequence: seq.id, track_index: 0, clip_index: 2, to_frame: 400, dry_run: true, project: projA }); assert(r.dryRun && r.plan.to.frames === 400, "plan"); return r.plan.to.frames; });
  await step("pr_remove_clips range", async () => { const r = await tool("pr_remove_clips", { sequence: seq.id, track_index: 0, from_frame: 300, to_frame: 400, project: projA }); assert(r.removed.length === 1 && r.remaining === 2, "one removed"); return r.removed; });
  await step("pr_add_tracks", async () => { const r = await tool("pr_add_tracks", { sequence: seq.id, video: 1, audio: 1, project: projA }); assert(r.videoTracks.after === r.videoTracks.before + 1, "video track added"); return r; });
  await step("pr_set_track_enabled", async () => { const r = await tool("pr_set_track_enabled", { sequence: seq.id, track_index: 1, enabled: false, locked: true, project: projA }); assert(r.enabled === false && r.locked === true, "flags"); return r; });
  // versions, markers, range
  await step("pr_duplicate_sequence dry_run", async () => { const r = await tool("pr_duplicate_sequence", { sequence: seq.id, dry_run: true, project: projA }); assert(r.dryRun && r.plan.name === "Selftest sequence v2", "plan name v2, got " + r.plan.name); return r.plan.name; });
  const v2 = await step("pr_duplicate_sequence → v2 (original stays active)", async () => { const r = await tool("pr_duplicate_sequence", { sequence: seq.id, project: projA }); assert(r.sequence.name === "Selftest sequence v2" && r.sequence.id !== seq.id, "copy named v2"); assert(r.sequence.clips === 2, "copy has the 2 clips, got " + r.sequence.clips); assert(r.active === "Selftest sequence", "original still active, got " + r.active); return r.sequence; });
  await step("pr_duplicate_sequence → v3", async () => { const r = await tool("pr_duplicate_sequence", { sequence: seq.id, project: projA }); assert(r.sequence.name === "Selftest sequence v3", "next free version"); return r.sequence.name; });
  await step("pr_add_marker range chapter", async () => { const r = await tool("pr_add_marker", { sequence: seq.id, start_frame: 60, duration_frames: 30, name: "Intro", comments: "first beat", type: "chapter", color: "orange", project: projA }); assert(r.marker.start.frames === 60 && r.marker.end.frames === 90, "range 60-90"); assert(r.marker.type === "Chapter" && r.marker.color === "orange", "type + color"); return [r.marker.name, r.marker.start.timecode, r.marker.end.timecode]; });
  await step("pr_add_marker point", async () => { const r = await tool("pr_add_marker", { sequence: seq.id, start_seconds: 0.5, name: "Early", project: projA }); assert(r.marker.start.frames === 15 && r.total === 2, "point marker at 15"); return r.marker.start.frames; });
  await step("pr_list_markers (ordered, filtered)", async () => { const r = await tool("pr_list_markers", { sequence: seq.id, project: projA }); assert(r.total === 2 && r.markers[0].name === "Early" && r.markers[1].name === "Intro", "time order"); const f = await tool("pr_list_markers", { sequence: seq.id, filter: "beat", project: projA }); assert(f.markers.length === 1 && f.markers[0].name === "Intro", "filter by comments"); return r.markers.map((m) => [m.name, m.start.frames]); });
  await step("pr_remove_markers range + all", async () => { const d = await tool("pr_remove_markers", { sequence: seq.id, filter: "intro", dry_run: true, project: projA }); assert(d.dryRun && d.plan.markers.length === 1, "dry plan"); const r = await tool("pr_remove_markers", { sequence: seq.id, from_seconds: 0, to_seconds: 1, project: projA }); assert(r.removed.length === 1 && r.removed[0].name === "Early" && r.remaining === 1, "range removed Early"); const all = await tool("pr_remove_markers", { sequence: seq.id, all: true, project: projA }); assert(all.remaining === 0, "all removed"); return "removed 2"; });
  await step("pr_detect_shots by item (dry-run markers)", async () => { assert(cutItem, "cut.mp4 imported"); const r = await tool("pr_detect_shots", { item: cutItem.id, add_markers: true, sequence: seq.id, dry_run: true, project: projA }); assert(r.fps === 30 && r.cuts.length === 1 && r.cuts[0].frames === 30 && r.cuts[0].timecode === "00:00:01:00", "one cut at frame 30, got " + JSON.stringify(r.cuts)); assert(r.totalShots === 2 && r.shots[1].start.seconds === 1 && /select='gt\(scene,0\.3\)'/.test(r.command), "2 shots + command"); assert(r.dryRun && r.markers.length === 2 && r.markers[1].start.frames === 30, "dry-run marker plan"); return { cuts: r.cuts.map((c) => c.timecode), command: r.command.slice(0, 60) }; }, { optional: !ffmpegBin });
  await step("pr_detect_shots by path + add_markers", async () => { const r = await tool("pr_detect_shots", { path: cutClip, threshold: 0.2, add_markers: true, sequence: seq.id, marker_color: "cyan", marker_offset_frame: 60, project: projA }); assert(r.markers.length === 2 && r.markers[0].name === "Shot 1" && r.markers[1].name === "Shot 2" && r.markers[1].start.frames === 90 && r.markers[1].color === "cyan", "markers Shot 1/2 offset by 60 frames, got " + JSON.stringify(r.markers)); const l = await tool("pr_list_markers", { sequence: seq.id, filter: "Shot", project: projA }); assert(l.markers.length === 2, "markers listed"); const rm = await tool("pr_remove_markers", { sequence: seq.id, all: true, project: projA }); assert(rm.remaining === 0, "cleaned up"); return r.markers.map((m) => [m.name, m.start.timecode]); }, { optional: !ffmpegBin });
  await step("pr_sequence_range set in/out", async () => { const r = await tool("pr_sequence_range", { sequence: seq.id, in_frame: 30, out_frame: 120, project: projA }); assert(r.range.inPoint.frames === 30 && r.range.outPoint.frames === 120, "in/out set"); const g = await tool("pr_sequence_range", { sequence: seq.id, project: projA }); assert(g.range.inPoint.frames === 30 && g.range.workArea, "read back"); return [g.range.inPoint.timecode, g.range.outPoint.timecode]; });
  await step("pr_sequence_range work area reports whether it applied", async () => { const r = await tool("pr_sequence_range", { sequence: seq.id, work_area_in_frame: 30, work_area_out_frame: 120, work_area_enabled: true, project: projA }); const applied = r.range.workArea.inPoint.frames === 30 && r.range.workArea.outPoint.frames === 120; assert(applied || (r.notes && r.notes.length), "either applied or explained"); return applied ? "applied" : "not applied (reported)"; });
  await step("pr_remove_sequence refuses non-versions", async () => { try { await tool("pr_remove_sequence", { sequence: seq.id, project: projA }); throw new Error("not refused"); } catch (e) { assert(/not a version/.test(e.message), "refusal message: " + e.message); return "refused"; } });
  await step("pr_remove_sequence v3 + v2", async () => { const a = await tool("pr_remove_sequence", { sequence: "Selftest sequence v3", project: projA }); const b = await tool("pr_remove_sequence", { sequence: v2.id, project: projA }); assert(a.deleted.name === "Selftest sequence v3" && b.deleted.name === "Selftest sequence v2", "both deleted"); const l = await tool("pr_list_sequences", { project: projA }); assert(l.sequences.length === 1, "one sequence left, got " + l.sequences.length); return b.remaining; });

  await step("pr_track rename/target", async () => { const r = await tool("pr_track", { sequence: seq.id, track_index: 1, name: "Graphics", targeted: true, locked: false, project: projA }); return { name: r.name, targeted: r.targeted, notes: r.notes }; });

  const frames = await step("pr_export_frames + contact sheet", async () => { const r = await tool("pr_export_frames", { sequence: seq.id, frames: [35, 215, 500], out_dir: path.join(dir, "frames"), contact_sheet: true, project: projA }); assert(r.count === 3, "3 frames"); for (const f of r.frames) assert((await fs.stat(f.path)).size > 0, "frame file " + f.path); return { sheet: r.contactSheet }; });
  await step("pr_export_frame", async () => { const r = await tool("pr_export_frame", { sequence: seq.id, frame: 40, png_path: path.join(dir, "frame40.png"), project: projA }); assert(r.bytes > 0 && r.timecode, "png written"); return r.timecode; });
  await step("pr_show_frame", async () => { const r = await tool("pr_show_frame", { sequence: seq.id, frame: 35, max_size: 240, project: projA }); assert(r.image > 1000, "inline image"); return r.text; });
  await step("pr_review_sheet evenly spaced", async () => { const r = await tool("pr_review_sheet", { sequence: seq.id, count: 4, max_size: 640, project: projA }); assert(r.image > 1000, "inline image"); const rows = r.text.split("\n").slice(1); assert(/4 frames \(evenly spaced\)/.test(r.text) && rows.length >= 4 && /^ 1\. 00:00:00[:;]00 \(f0\)/.test(rows[0]), "summary rows: " + r.text); return r.text.split("\n")[0]; }, { optional: !ffmpegBin });
  await step("pr_review_sheet at_clip_starts", async () => { const r = await tool("pr_review_sheet", { sequence: seq.id, at_clip_starts: true, max_size: 640, project: projA }); assert(r.image > 1000, "inline image"); const rows = r.text.split("\n").slice(1).filter((l) => /^\s*\d+\./.test(l)); assert(rows.length === 2 && /00:00:01[:;]00 \(f30\)\s+red\.png \[V1\]/.test(rows[0]) && /f200/.test(rows[1]), "two clip starts with names: " + r.text); return rows; }, { optional: !ffmpegBin });
  await step("pr_list_export_presets", async () => { const r = await tool("pr_list_export_presets", { filter: "Match Source - High", limit: 3 }); assert(/preset/.test(r), "presets listed"); return r.split("\n")[0]; });
  await step("pr_render direct 1s", async () => { const r = await tool("pr_render", { sequence: seq.id, preset: "H264 Match Source - High bitrate", out_path: path.join(dir, "render.mp4"), in_frame: 0, out_frame: 30, mode: "direct", project: projA }); assert(r.done && r.bytes > 1000, "rendered"); return { bytes: r.bytes, seconds: r.seconds }; }, { optional: noRender });
  await step("pr_render dry_run", async () => { const r = await tool("pr_render", { sequence: seq.id, preset: "H264 Match Source - High bitrate", out_path: path.join(dir, "x.mp4"), dry_run: true, project: projA }); assert(r.dryRun, "dry"); return r.plan.mode; });

  await step("pr_run_script helpers + output", async () => { const r = await tool("pr_run_script", { code: `var s = getSequence(${JSON.stringify(projA)}, ${JSON.stringify(seq.id)}); log("clips on V1:", s.videoTracks[0].clips.numItems); ({ name: s.name, project: getProject(${JSON.stringify(projA)}).name })`, project: projA }); assert(r.result.name === "Selftest sequence" && r.output && r.output.length === 1, "helpers"); return r.output; });
  await step("pr_run_script error with line", async () => { try { await tool("pr_run_script", { code: "var a = 1;\nnoSuchThing.x;", project: projA }); throw new Error("no error raised"); } catch (e) { assert(/line 2/.test(e.message), "line number in error: " + e.message); return "line 2 reported"; } });
  await step("pr_save_project", () => tool("pr_save_project", { project: projA }));

  // second project: explicit project resolution
  await step("pr_new_project B", () => tool("pr_new_project", { path: projB }));
  await step("project param resolves A while B is active", async () => { const r = await tool("pr_get_sequence", { sequence: seq.id, clips: false, project: projA }); assert(r.name === "Selftest sequence", "resolved A's sequence"); const s = await tool("pr_status"); return { activeAfter: s.activeProject.name, resolved: r.name }; });
  await step("pr_import_files into B", async () => { const r = await tool("pr_import_files", { paths: [blue], project: projB }); assert(r.imported.length === 1, "imported into B"); return r.imported[0].name; });

  // build from timeline into B (creates the sequence, imports red via path), then compare with A
  const tlB = { sequence: "Rebuilt", tracks: [{ type: "video", index: 0, clips: [{ path: red, start_frame: 30 }, { path: red, start_frame: 200, in_frame: 10, out_frame: 40 }] }] };
  await step("pr_build_from_timeline dry_run", async () => { const r = await tool("pr_build_from_timeline", { timeline: tlB, project: projB, dry_run: true }); assert(r.dryRun && r.plan.imports.length === 1 && r.plan.createSequence, "plan: import + create"); return r.plan; });
  const built = await step("pr_build_from_timeline", async () => { const r = await tool("pr_build_from_timeline", { timeline: tlB, project: projB }); assert(r.created && r.placed.length === 2, "built 2 clips"); return r; });
  await step("pr_build_from_timeline patch (no changes)", async () => { const r = await tool("pr_build_from_timeline", { timeline: tlB, project: projB, dry_run: true }); assert(r.plan.places.length === 0 && r.plan.removes.length === 0, "nothing to change, got " + JSON.stringify(r.plan)); return "idempotent"; });
  await step("pr_compare_sequences A vs B (expect diffs)", async () => { const r = await tool("pr_compare_sequences", { sequence_a: seq.id, project_a: projA, sequence_b: built.sequence.id, project_b: projB }); assert(!r.identical && r.matched >= 1, "found differences but matched the first clip"); return { matched: r.matched, mismatches: r.mismatches.length, missingInB: r.missingInB.length, extraInB: r.extraInB.length }; });
  await step("pr_compare_sequences self (identical)", async () => { const r = await tool("pr_compare_sequences", { sequence_a: built.sequence.id, project_a: projB, sequence_b: built.sequence.id, project_b: projB }); assert(r.identical, "identical"); return r.matched; });

  // dialogs: raise a real modal alert in Premiere (blocks scripting), detect it, dismiss it
  await step("pr_status sees a modal dialog + pr_dismiss_dialog", async () => {
    const pending = evalScript('alert("Claude Bridge self-test dialog"); "dismissed"', { timeoutMs: 40000 }).catch((e) => ({ error: e.message }));
    // Poll: the alert can take a moment to appear, and on some setups something closes it within a few seconds.
    let s = null;
    for (let i = 0; i < 20 && !(s?.modalDialogs?.length); i++) { await new Promise((r) => setTimeout(r, 300)); s = await tool("pr_status"); }
    assert(s.modalDialogs && s.modalDialogs.length === 1 && /self-test dialog/.test(s.modalDialogs[0].text), "dialog detected: " + JSON.stringify(s.modalDialogs));
    const d = await tool("pr_dismiss_dialog", { button: "OK" });
    const r = await pending; assert(r === "dismissed", "script resumed after dismiss: " + JSON.stringify(r));
    assert(d.dismissed || /no modal dialog/.test(d.reason || ""), "dismissed (or already gone): " + JSON.stringify(d));
    return { text: s.modalDialogs[0].text, buttons: s.modalDialogs[0].buttons, dismissedBy: d.dismissed ? "pr_dismiss_dialog" : "already closed" };
  });

  if (aeArg && compArg) await step("pr_import_ae_comps", async () => { const r = await tool("pr_import_ae_comps", { aep_path: aeArg, comp_names: [compArg], bin: "AE", project: projA }); assert(r.imported.length === 1 && r.notCreated.length === 0, "comp imported"); assert(r.imported[0].duration && r.imported[0].frameRate, "duration + fps"); return r.imported[0]; });
  else await step("pr_import_ae_comps dry_run", async () => { const r = await tool("pr_import_ae_comps", { aep_path: projA, comp_names: ["x"], dry_run: true, project: projA }); assert(r.dryRun, "dry"); return "dry run only (pass --ae/--comp for a live Dynamic Link test)"; });

  await step("pr_save_as B copy", () => tool("pr_save_as", { path: path.join(dir, "selftest-B-copy.prproj"), project: projB }));
  await step("pr_open_project (already open → activates)", async () => { const r = await tool("pr_open_project", { path: projA }); assert(r.active === projA, "A active"); return r.alreadyOpen ? "activated" : "opened"; });
  if (!keep) { await step("pr_close_project B copy", () => tool("pr_close_project", { project: path.join(dir, "selftest-B-copy.prproj"), save: false })); await step("pr_close_project A", () => tool("pr_close_project", { project: projA, save: false })); }

  const notCovered = toolNames.filter((t) => !covered.has(t));
  console.log(`\nALL PASSED (${results.filter((r) => r.ok === true).length} steps${results.some((r) => r.ok === "skipped") ? `, ${results.filter((r) => r.ok === "skipped").length} skipped` : ""}). Tools exercised: ${covered.size}/${toolNames.length}${notCovered.length ? " — not covered: " + notCovered.join(", ") : ""}.\nScratch files: ${dir}${keep ? " (projects left open)" : ""}`);
} catch (e) {
  console.log(`\nFAILED at step "${results.at(-1)?.step}": ${e.message}`);
  process.exitCode = 1;
} finally {
  await fs.writeFile(path.join(dir, "results.json"), JSON.stringify(results, null, 1));
  await client.close();
}
