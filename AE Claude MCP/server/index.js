#!/usr/bin/env node
// AE Round Trip MCP server: lets Claude read, edit, build, render and check After Effects comps.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runScript, startJob, getJob, waitJob, listJobs, detectDialogs, describeDialogs, dismissDialog, aeAppName } from "./ae.js";
import { outline, applyOp, getLayers, findComp, findLayer } from "./edits.js";

const run = promisify(execFile);
const STATE = process.env.AE_RT_STATE || path.join(os.homedir(), "Library", "Application Support", "AE Claude Round Trip");
const EXPORTS = path.join(STATE, "exports");
const FRAMES = path.join(STATE, "frames");
const FFMPEG_CANDIDATES = [process.env.FFMPEG, "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "ffmpeg"].filter(Boolean);

const INSTRUCTIONS = `Tools for After Effects (the project open in the user's After Effects).

Round-trip editing:
1. ae_status / ae_list_comps to find the comp. 2. ae_get_comp exports it (with nested precomps) → outline + export_id;
every comp/layer gets a stable ID (C-xxxx / L-xxxx) in its AE comment. 3. ae_get_layers (summary: true for an audit of
effects, mattes, parents, expressions, key times). 4. ae_apply_edits: AE duplicates the comp as "<name> v2" and patches
only what you edited. 5. ae_render_frame / ae_save_frames to look at the result.

Building & scripting: ae_run_script runs ExtendScript with helpers in scope (str, log, findComp, findItem, ensureFolder,
ensureComp, addGroup, addGroupsInOrder, refetch, easeKeys, setKeys, fps/frame/seconds/tc). Scripts run one at a time
through a queue; background: true returns a job id for ae_job_status / ae_job_wait. In this AE build "text" + object
throws — use str() or String(). After addProperty on shape contents, re-fetch references (addGroup does).
Rendering: ae_render_comps renders a list of comps (template by name fragment, output folder + pattern) as a background
job that only touches the items it adds; ae_render_comp renders one and waits. ae_compare renders frames and measures
PSNR/SSIM against a reference movie or image sequence. ae_list_fonts_used / ae_replace_font manage fonts.
Dialogs: every call checks for AE modal dialogs first (Resolve Fonts, missing footage, script warnings) and reports
them; ae_dismiss_dialog clicks a button on AE's own dialog. Mutating tools accept dry_run: true.
Times: seconds in; results carry seconds + frames + timecode. Nothing is saved unless you call ae_save / ae_save_as.

Property paths use matchNames (or display names) joined by "/", e.g. "ADBE Transform Group/ADBE Position",
"ADBE Effect Parade/ADBE Gaussian Blur 2#1/ADBE Gaussian Blur 2-0001", or an array of segments when a name contains "/".
Values: numbers or arrays ([x, y] / [x, y, z]; colors [r, g, b, a] in 0-1). Keys: {t, v, inInterp/outInterp:
"linear"|"bezier"|"hold", inEase/outEase: [{speed, influence}] (one per dimension; one for spatial props), ...}.
Ease only takes effect on bezier keys. Text: Source Text value is {text, font, fontSize, fillColor, justification, ...}.`;

const server = new McpServer({ name: "ae-round-trip", version: "1.2.0" }, { instructions: INSTRUCTIONS });

const text = (s) => ({ content: [{ type: "text", text: typeof s === "string" ? s : JSON.stringify(s, null, 1) }] });
const fail = (e) => ({ isError: true, content: [{ type: "text", text: String(e?.message ?? e) + (e?.detail && !e.detail.errorDetail ? "\n" + JSON.stringify(e.detail, null, 1) : "") + (e?.dialogs ? "\nDialogs: " + JSON.stringify(e.dialogs) : "") }] });
const tool = (name, def, fn) => server.registerTool(name, def, async (args) => { try { return await fn(args); } catch (e) { return fail(e); } });
const DryRun = z.boolean().optional().describe("report what would change without changing anything");
const timing = (seconds, fps) => ({ seconds: Math.round(seconds * 1e6) / 1e6, frames: Math.round(seconds * fps), timecode: tcOf(seconds, fps) });
function tcOf(seconds, fps) {
  const drop = Math.abs(fps - 29.97) < 0.01 || Math.abs(fps - 59.94) < 0.01, rf = Math.round(fps);
  const total = Math.round(seconds * fps), f = total % rf, s = Math.floor(total / rf);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}${drop ? ";" : ":"}${p(f)}`;
}

async function ffmpeg() { for (const c of FFMPEG_CANDIDATES) { try { await run(c, ["-version"], { timeout: 5000 }); return c; } catch {} } return null; }
// Tile PNGs (same size after scaling) into a labelled grid.
async function contactSheet(pngs, outPath, { cols, width = 480, labels } = {}) {
  const ff = await ffmpeg(); if (!ff || !pngs.length) return null;
  const n = pngs.length, c = cols || Math.min(4, Math.ceil(Math.sqrt(n))), r = Math.ceil(n / c);
  const args = ["-y"]; pngs.forEach((p) => args.push("-i", p));
  const draw = (i) => labels ? `,drawtext=text='${String(labels[i]).replace(/[':\\%]/g, " ")}':x=6:y=h-22:fontsize=16:fontcolor=white:box=1:boxcolor=black@0.5` : "";
  const chain = pngs.map((_, i) => `[${i}:v]scale=${width}:-2,pad=${width}:ih+26:0:0:color=black${draw(i)}[s${i}]`).join(";");
  args.push("-filter_complex", `${chain};${pngs.map((_, i) => `[s${i}]`).join("")}concat=n=${n}:v=1:a=0,tile=${c}x${r}:padding=4:color=0x202020[out]`, "-map", "[out]", "-frames:v", "1", outPath);
  try { await run(ff, args, { timeout: 180000 }); return outPath; } catch (e) { return null; }
}
// Wait for AE's asynchronous saveFrameToPng output.
async function waitForFile(p, maxMs = 120000) {
  let last = -1; const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    await new Promise((res) => setTimeout(res, 250));
    const st = await fs.stat(p).catch(() => null);
    if (st && st.size > 0 && st.size === last) return st.size;
    last = st ? st.size : -1;
  }
  return 0;
}

async function exportComp(compId) {
  await fs.mkdir(EXPORTS, { recursive: true });
  const exportId = `${compId}-${Date.now().toString(36)}`;
  const out = path.join(EXPORTS, exportId + ".json");
  await runScript("Export Comp.jsx", { compId, out });
  return { exportId, out };
}
async function loadExport(exportId) {
  if (!/^[\w-]+$/.test(exportId)) throw new Error("bad export_id");
  const file = path.join(EXPORTS, exportId + ".json");
  try { return { file, doc: JSON.parse(await fs.readFile(file, "utf8")) }; }
  catch { throw new Error(`export ${exportId} not found — run ae_get_comp again`); }
}
async function resolveCompId({ comp_id, comp_name }) {
  if (comp_id) return comp_id;
  if (!comp_name) {
    const st = await runScript("mcp/Status.jsx");
    if (!st.activeComp) throw new Error("No comp given and no comp is active in After Effects.");
    return st.activeComp.id;
  }
  const res = await runScript("mcp/List Comps.jsx", { filter: comp_name, limit: 50 });
  const exact = res.comps.filter((c) => c.name === comp_name);
  if (exact.length === 1) return exact[0].id;
  const list = (exact.length ? exact : res.comps).map((c) => `${c.id} "${c.name}" (${c.layers} layers, ${c.duration}s${c.folder ? ", in " + c.folder : ""})`);
  if (!list.length) throw new Error(`No comp named "${comp_name}".`);
  throw new Error(`"${comp_name}" is ambiguous; pass comp_id. Matches:\n${list.join("\n")}`);
}
async function compInfo(compId) {
  const r = await runScript("mcp/List Comps.jsx", { limit: 5000 });
  const c = r.comps.find((x) => x.id === compId);
  if (!c) throw new Error(`comp ${compId} not found`);
  return c;
}

// ------------------------------------------------------------------ status / dialogs / jobs
tool("ae_status", {
  title: "After Effects status",
  description: "Is After Effects running and responsive, which project is open (unsaved changes?), the active comp, render state, any open modal dialog blocking scripting (title, text, buttons), engine health, and running/queued jobs.",
  inputSchema: {},
  annotations: { readOnlyHint: true },
}, async () => {
  let app;
  try { app = await aeAppName(); } catch (e) { return text({ running: false, error: e.message }); }
  const dialogs = await detectDialogs();
  const out = { app, running: true };
  if (dialogs.dialogs) out.modalDialogs = dialogs.dialogs; else out.modalDialogCheck = dialogs.unavailable;
  const active = listJobs().filter((j) => j.status === "running" || j.status === "queued");
  if (active.length) out.jobs = active;
  if (dialogs.dialogs?.length) { out.responsive = false; out.error = `A modal dialog blocks scripting: ${describeDialogs(dialogs)}. Use ae_dismiss_dialog.`; return text(out); }
  if (active.some((j) => j.status === "running")) { out.responsive = "busy"; out.note = "A job is running in AE; status details skipped to avoid a second-script warning."; return text(out); }
  const status = await runScript("mcp/Status.jsx", {}, { timeoutSec: 20, checkDialogs: false }).catch((e) => ({ ok: false, responsive: false, error: e.message }));
  Object.assign(out, { responsive: status.ok !== false }, status);
  if (out.stringConcatWithObjects === "broken") out.engineNote = "In this AE build \"text\" + object (arrays, Error objects, AE objects) throws (the scripting engine's + runs with expression vector-math semantics). In ae_run_script use str(x) / String(x) / arr.join().";
  return text(out);
});

tool("ae_dismiss_dialog", {
  title: "Dismiss an After Effects dialog",
  description: "Click a button on the modal dialog After Effects is showing (AE's own dialogs only: Resolve Fonts, missing footage, script warnings, auto-save...). Without button, picks OK/Continue/Close, else Cancel. title_contains selects among several.",
  inputSchema: { button: z.string().optional(), title_contains: z.string().optional() },
}, async ({ button, title_contains }) => text(await dismissDialog(button, { titleContains: title_contains })));

tool("ae_job_status", { title: "Job status", description: "Status/result of a background job (ae_run_script background, ae_render_comps). Without job_id lists recent jobs.", inputSchema: { job_id: z.string().optional() }, annotations: { readOnlyHint: true } },
  async ({ job_id }) => { if (!job_id) return text(listJobs().slice(-20)); const j = getJob(job_id); if (!j) throw new Error("unknown job " + job_id); return text(j); });
tool("ae_job_wait", { title: "Wait for job", description: "Wait up to max_wait_sec (default 120) for a background job to finish and return it.", inputSchema: { job_id: z.string(), max_wait_sec: z.number().int().optional() } },
  async ({ job_id, max_wait_sec }) => text(await waitJob(job_id, max_wait_sec ?? 120)));

tool("ae_run_script", {
  title: "Run ExtendScript",
  description: "Run ExtendScript in After Effects (full DOM). Pass code or file_path. Helpers in scope: str(v) (safe string — this AE's + throws on objects), log(...) (returned as output), findComp(name), findItem(nameOrPath), ensureFolder('A/B'), ensureComp(name,w,h,dur,fps,folder), addGroup(contents, matchName, name) (addProperty + fresh reference), addGroupsInOrder(contents, [{mn,name}]) (first entry on top), refetch(group, nameOrIndex), easeKeys(prop, keys?, influence?, speed?) (right dimension count for 1D/2D/3D/colour/spatial), setKeys(prop, [[t,v],...]), fps/frame/seconds/tc(comp,...). The last expression is the result (AE objects as {[type], name, id}); errors include line + source context. Scripts run one at a time; background: true returns a job id (use ae_job_wait) for long jobs. Wrap edits in app.beginUndoGroup/endUndoGroup.",
  inputSchema: {
    code: z.string().optional().describe("ExtendScript source; its last expression is the result"),
    file_path: z.string().optional().describe("absolute path of a .jsx file to run instead of code"),
    timeout_sec: z.number().int().optional().describe("default 600"),
    background: z.boolean().optional().describe("return a job id immediately instead of waiting"),
  },
}, async ({ code, file_path, timeout_sec, background }) => {
  if (!code && !file_path) throw new Error("give code or file_path");
  if (background) { const j = startJob("mcp/Run Script.jsx", { code, file: file_path }, { timeoutSec: timeout_sec ?? 3600, label: "run_script" }); return text({ jobId: j.id, status: j.status, note: "Use ae_job_wait / ae_job_status with this id." }); }
  try { return text(await runScript("mcp/Run Script.jsx", { code, file: file_path }, { timeoutSec: timeout_sec ?? 600 })); }
  catch (e) { if (e.detail && e.detail.errorDetail) return text(e.detail); throw e; }
});

// ------------------------------------------------------------------ project files
tool("ae_open_project", { title: "Open project", description: "Open an .aep. Refuses if the current project has unsaved changes unless discard_unsaved is true (never shows a save dialog).", inputSchema: { path: z.string(), discard_unsaved: z.boolean().optional(), dry_run: DryRun } },
  async ({ path: p, discard_unsaved, dry_run }) => text(await runScript("mcp/Project.jsx", { op: "open", path: p, discardUnsaved: !!discard_unsaved, dryRun: dry_run }, { timeoutSec: 600 })));
tool("ae_new_project", { title: "New project", description: "Create a new empty project, optionally saving it to path right away. Refuses if the current project has unsaved changes unless discard_unsaved is true.", inputSchema: { path: z.string().optional(), discard_unsaved: z.boolean().optional(), dry_run: DryRun } },
  async ({ path: p, discard_unsaved, dry_run }) => text(await runScript("mcp/Project.jsx", { op: "new", path: p, discardUnsaved: !!discard_unsaved, dryRun: dry_run })));
tool("ae_save", { title: "Save project", description: "Save the open project to its current file. Fails (instead of showing a dialog) if it has never been saved; use ae_save_as then.", inputSchema: { dry_run: DryRun } },
  async ({ dry_run }) => text(await runScript("mcp/Project.jsx", { op: "save", dryRun: dry_run }, { timeoutSec: 600 })));
tool("ae_save_as", { title: "Save project as", description: "Save the open project to a new .aep path (folders are created).", inputSchema: { path: z.string(), dry_run: DryRun } },
  async ({ path: p, dry_run }) => text(await runScript("mcp/Project.jsx", { op: "saveAs", path: p, dryRun: dry_run }, { timeoutSec: 600 })));
tool("ae_import", {
  title: "Import file",
  description: "Import footage, an image sequence, a Photoshop/Illustrator file as a comp, or another .aep (as: footage | comp | compCropped | project). Returns the created items with ids. Optional folder (name or id; created if missing).",
  inputSchema: { path: z.string(), as: z.enum(["footage", "comp", "compCropped", "project"]).optional(), folder: z.union([z.string(), z.number()]).optional(), sequence: z.boolean().optional().describe("import a numbered image sequence starting at this file"), name: z.string().optional(), dry_run: DryRun },
}, async (a) => text(await runScript("mcp/Import.jsx", { ...a, dryRun: a.dry_run }, { timeoutSec: 600 })));

// ------------------------------------------------------------------ rendering & stills
tool("ae_render_comp", {
  title: "Render comp (wait)",
  description: "Render one comp through the Render Queue and wait for the file (other queued items are paused and restored). template = Output Module template name, e.g. 'H.264 - Match Render Settings - 15 Mbps', 'Lossless', 'High Quality with Alpha'. via 'ame' hands off to Media Encoder. For several comps or long renders use ae_render_comps (background job).",
  inputSchema: { comp_id: z.number().int(), out_path: z.string(), template: z.string().optional(), settings_template: z.string().optional(), start: z.number().optional(), end: z.number().optional(), via: z.enum(["ae", "ame"]).optional(), timeout_sec: z.number().int().optional(), dry_run: DryRun },
}, async ({ comp_id, out_path, template, settings_template, start, end, via, timeout_sec, dry_run }) => {
  const r = await runScript("mcp/Render Comp.jsx", { compId: comp_id, out: out_path, template, settings: settings_template, start, end, via, dryRun: dry_run }, { timeoutSec: timeout_sec ?? 3600 });
  if (!r.dryRun && r.timeSpan) { const c = await compInfo(comp_id).catch(() => null); if (c) { r.frames = Math.round((r.timeSpan[1] - r.timeSpan[0]) * c.fps); r.fps = c.fps; r.start = timing(r.timeSpan[0], c.fps); r.end = timing(r.timeSpan[1], c.fps); } }
  return text(r);
});

tool("ae_render_comps", {
  title: "Render comps (background)",
  description: "Render a list of comps through the Render Queue as a background job: only the items this call adds are rendered (the user's existing queue is paused and restored, never rendered). template matches an Output Module template by name fragment ('H.264' → 'H.264 - Match Render Settings - 15 Mbps'). Output: items[].out, or out_dir + pattern with {comp} {index} {id}. Returns a job id; ae_job_wait / ae_job_status give per-item status, frame count and output path. dry_run lists the planned items and templates.",
  inputSchema: {
    items: z.array(z.object({ comp_id: z.number().int(), out: z.string().optional(), start: z.number().optional(), end: z.number().optional() })).min(1),
    out_dir: z.string().optional(), pattern: z.string().optional().describe("default '{comp}' — the template decides the extension"),
    template: z.string().optional(), settings_template: z.string().optional(), keep_items: z.boolean().optional().describe("leave the items in the render queue"),
    wait: z.boolean().optional().describe("wait for completion instead of returning a job id"), timeout_sec: z.number().int().optional(), dry_run: DryRun,
  },
}, async (a) => {
  const args = { items: a.items.map((i) => ({ compId: i.comp_id, out: i.out, start: i.start, end: i.end })), outDir: a.out_dir, pattern: a.pattern, template: a.template, settings: a.settings_template, keepItems: a.keep_items, dryRun: a.dry_run };
  if (a.dry_run) return text(await runScript("mcp/Render Batch.jsx", args, { timeoutSec: 120 }));
  const j = startJob("mcp/Render Batch.jsx", args, { timeoutSec: a.timeout_sec ?? 6 * 3600, label: `render ${a.items.length} comp(s)` });
  if (a.wait) return text(await waitJob(j.id, a.timeout_sec ?? 6 * 3600));
  return text({ jobId: j.id, status: j.status, items: a.items.length, note: "Rendering in After Effects; AE is busy until it finishes. Poll with ae_job_status or block with ae_job_wait." });
});

tool("ae_save_frame", {
  title: "Save frame to PNG",
  description: "Render one frame of a comp to a PNG file on disk (full resolution).",
  inputSchema: { comp_id: z.number().int(), time: z.number(), png_path: z.string() },
}, async ({ comp_id, time, png_path }) => {
  const out = png_path.endsWith(".png") ? png_path : png_path + ".png";
  await fs.mkdir(path.dirname(out), { recursive: true });
  const r = await runScript("mcp/Render Frame.jsx", { compId: comp_id, time, out });
  const size = await waitForFile(out);
  if (!size) throw new Error("After Effects didn't write the frame (timed out).");
  return text({ ok: true, comp: r.name, time: r.time, frame: r.frame, timecode: r.timecode, fps: r.fps, path: out, bytes: size });
});

tool("ae_save_frames", {
  title: "Save many frames",
  description: "Render a list of frames (comp_id + time seconds, or frame numbers) to PNGs in one call: out_dir + pattern with {comp} {frame} {tc} {index}. contact_sheet: true tiles them into one labelled image (needs ffmpeg). Returns seconds/frames/timecode per frame.",
  inputSchema: {
    frames: z.array(z.object({ comp_id: z.number().int(), time: z.number().optional(), frame: z.number().optional() })).min(1),
    out_dir: z.string(), pattern: z.string().optional().describe("default '{comp}_f{frame}.png'"), contact_sheet: z.boolean().optional(), sheet_columns: z.number().int().optional(),
  },
}, async ({ frames, out_dir, pattern, contact_sheet, sheet_columns }) => {
  await fs.mkdir(out_dir, { recursive: true });
  const comps = await runScript("mcp/List Comps.jsx", { limit: 5000 });
  const byId = Object.fromEntries(comps.comps.map((c) => [c.id, c]));
  const pat = pattern || "{comp}_f{frame}.png";
  const list = frames.map((f, i) => {
    const c = byId[f.comp_id]; if (!c) throw new Error(`comp ${f.comp_id} not found`);
    const t = f.time ?? (f.frame ?? 0) / c.fps, fr = Math.round(t * c.fps);
    const name = pat.replace("{comp}", c.name.replace(/[^\w.-]+/g, "_")).replace("{frame}", String(fr).padStart(5, "0")).replace("{tc}", tcOf(t, c.fps).replace(/[:;]/g, "-")).replace("{index}", String(i + 1));
    return { compId: f.comp_id, time: t, out: path.join(out_dir, name.endsWith(".png") ? name : name + ".png") };
  });
  const r = await runScript("mcp/Save Frames.jsx", { frames: list }, { timeoutSec: 1800 });
  const out = [];
  for (const f of r.frames) { const size = await waitForFile(f.out); out.push({ ...f, bytes: size, ok: size > 0 }); }
  const res = { count: out.length, frames: out };
  if (contact_sheet) { const sheet = await contactSheet(out.filter((o) => o.ok).map((o) => o.out), path.join(out_dir, "contact_sheet.png"), { cols: sheet_columns, labels: out.map((o) => `${o.comp} f${o.frame}`) }); res.contactSheet = sheet || "ffmpeg not found — no sheet made"; }
  return text(res);
});

tool("ae_render_frame", {
  title: "Render a frame (inline)",
  description: "Render one frame of a comp and return it as an image, to check edits visually.",
  inputSchema: { comp_id: z.number().int(), time: z.number().describe("seconds (comp time)"), max_size: z.number().int().optional().describe("longest side in px (default 1280)") },
  annotations: { readOnlyHint: true },
}, async ({ comp_id, time, max_size }) => {
  await fs.mkdir(FRAMES, { recursive: true });
  const out = path.join(FRAMES, `${comp_id}-${String(time).replace(".", "_")}-${Date.now().toString(36)}.png`);
  const r = await runScript("mcp/Render Frame.jsx", { compId: comp_id, time, out });
  if (!(await waitForFile(out, 60000))) throw new Error("After Effects didn't produce the frame (render timed out).");
  const small = out.replace(/\.png$/, "-s.png");
  await run("/usr/bin/sips", ["-Z", String(max_size ?? 1280), out, "--out", small]);
  const data = (await fs.readFile(small)).toString("base64");
  fs.rm(out, { force: true }).catch(() => {}); fs.rm(small, { force: true }).catch(() => {});
  return { content: [{ type: "image", data, mimeType: "image/png" }, { type: "text", text: `"${r.name}" frame ${r.frame} (${r.time}s, ${r.timecode})` }] };
});

tool("ae_compare", {
  title: "Compare comp against reference",
  description: "Render frames of a comp and compare them with a reference movie (any ffmpeg-readable file) or an image sequence folder at the same times. Returns per-frame PSNR (dB) and SSIM, flags frames under the thresholds, and writes a side-by-side sheet (comp | reference | diff) plus an inline preview. times: seconds (default: 8 evenly spaced frames). reference_offset shifts reference time (seconds).",
  inputSchema: {
    comp_id: z.number().int(), reference: z.string().describe("movie file, or a folder of numbered PNG/JPG frames"),
    times: z.array(z.number()).optional(), count: z.number().int().optional().describe("evenly spaced frames when times is omitted (default 8)"),
    reference_offset: z.number().optional(), reference_fps: z.number().optional().describe("for image sequences; default comp fps"),
    out_dir: z.string().optional(), psnr_min: z.number().optional().describe("default 35"), ssim_min: z.number().optional().describe("default 0.95"),
  },
}, async (a) => {
  const ff = await ffmpeg(); if (!ff) throw new Error("ffmpeg is required for ae_compare (brew install ffmpeg)");
  const c = await compInfo(a.comp_id);
  const dir = a.out_dir || path.join(STATE, "compare", `${c.name.replace(/[^\w.-]+/g, "_")}-${Date.now().toString(36)}`);
  await fs.mkdir(dir, { recursive: true });
  const n = a.count ?? 8;
  const times = a.times?.length ? a.times : Array.from({ length: n }, (_, i) => Math.min(c.duration - 1 / c.fps, (i + 0.5) * c.duration / n));
  const frames = times.map((t, i) => ({ compId: a.comp_id, time: t, out: path.join(dir, `comp_${String(i).padStart(3, "0")}.png`) }));
  const saved = await runScript("mcp/Save Frames.jsx", { frames }, { timeoutSec: 1800 });
  for (const f of saved.frames) if (!(await waitForFile(f.out))) throw new Error("AE did not write " + f.out);
  const refStat = await fs.stat(a.reference).catch(() => null);
  if (!refStat) throw new Error("reference not found: " + a.reference);
  let refFiles = null;
  if (refStat.isDirectory()) refFiles = (await fs.readdir(a.reference)).filter((f) => /\.(png|jpe?g|tiff?)$/i.test(f)).sort().map((f) => path.join(a.reference, f));
  const psnrMin = a.psnr_min ?? 35, ssimMin = a.ssim_min ?? 0.95, rows = [];
  for (let i = 0; i < saved.frames.length; i++) {
    const f = saved.frames[i], t = f.time + (a.reference_offset || 0);
    const refPng = path.join(dir, `ref_${String(i).padStart(3, "0")}.png`);
    if (refFiles) { const idx = Math.min(refFiles.length - 1, Math.max(0, Math.round(t * (a.reference_fps || c.fps)))); await run(ff, ["-y", "-i", refFiles[idx], refPng], { timeout: 60000 }); }
    else await run(ff, ["-y", "-ss", String(Math.max(0, t)), "-i", a.reference, "-frames:v", "1", refPng], { timeout: 120000 });
    // AE's PNGs carry straight alpha with the comp background colour in RGB (as a render shows it), so compare RGB only.
    const FLAT = "[0:v]format=rgb24[A0];[1:v]format=rgb24[B0];[A0][B0]scale2ref[A2][B]";
    const psnrOut = await run(ff, ["-hide_banner", "-i", f.out, "-i", refPng, "-filter_complex", FLAT + ";[A2][B]psnr", "-f", "null", "-"], { timeout: 60000 }).catch((e) => ({ stderr: e.stderr || "" }));
    const ssimOut = await run(ff, ["-hide_banner", "-i", f.out, "-i", refPng, "-filter_complex", FLAT + ";[A2][B]ssim", "-f", "null", "-"], { timeout: 60000 }).catch((e) => ({ stderr: e.stderr || "" }));
    const psnr = /average:(inf|[\d.]+)/.exec(psnrOut.stderr)?.[1], ssim = /All:([\d.]+)/.exec(ssimOut.stderr)?.[1];
    const psnrV = psnr === "inf" ? 99 : parseFloat(psnr), ssimV = parseFloat(ssim);
    const pair = path.join(dir, `pair_${String(i).padStart(3, "0")}.png`);
    await run(ff, ["-y", "-i", f.out, "-i", refPng, "-filter_complex", FLAT + ";[A2]scale=640:-2[a];[B]scale=640:-2[b];[a]split[a1][a2];[b]split[b1][b2];[a2][b2]blend=all_mode=difference,eq=contrast=3[d];[a1][b1][d]hstack=inputs=3[out]", "-map", "[out]", pair], { timeout: 60000 }).catch(() => {});
    rows.push({ index: i, ...timing(f.time, c.fps), referenceTime: Math.round(t * 1000) / 1000, psnr: isFinite(psnrV) ? Math.round(psnrV * 100) / 100 : null, ssim: isFinite(ssimV) ? Math.round(ssimV * 10000) / 10000 : null, pass: isFinite(psnrV) && isFinite(ssimV) && psnrV >= psnrMin && ssimV >= ssimMin, compFrame: f.out, refFrame: refPng, pair });
  }
  const sheet = await contactSheet(rows.map((r) => r.pair), path.join(dir, "comparison_sheet.png"), { cols: 1, width: 1440, labels: rows.map((r) => `f${r.frames} ${r.timecode}  PSNR ${r.psnr} dB  SSIM ${r.ssim}  ${r.pass ? "PASS" : "FAIL"}`) });
  const summary = { comp: c.name, reference: a.reference, frames: rows.length, passed: rows.filter((r) => r.pass).length, minPsnr: Math.min(...rows.map((r) => r.psnr ?? 0)), minSsim: Math.min(...rows.map((r) => r.ssim ?? 0)), thresholds: { psnr: psnrMin, ssim: ssimMin }, sheet, dir, rows: rows.map(({ compFrame, refFrame, pair, ...rest }) => rest) };
  const content = [{ type: "text", text: JSON.stringify(summary, null, 1) }];
  if (sheet) { const small = sheet.replace(/\.png$/, "-s.png"); await run("/usr/bin/sips", ["-Z", "1400", sheet, "--out", small]).catch(() => {}); try { content.unshift({ type: "image", data: (await fs.readFile(small)).toString("base64"), mimeType: "image/png" }); } catch {} }
  return { content };
});

// ------------------------------------------------------------------ fonts
tool("ae_list_fonts_used", { title: "Fonts used", description: "Fonts used by text layers (per keyframe) in one comp or the whole project, with where each is used, and AE's missing/substituted font list.", inputSchema: { comp_id: z.number().int().optional() }, annotations: { readOnlyHint: true } },
  async ({ comp_id }) => text(await runScript("mcp/Fonts.jsx", { op: "list", compId: comp_id }, { timeoutSec: 600 })));
tool("ae_replace_font", { title: "Replace font", description: "Replace a font (PostScript name, e.g. 'Roboto-Bold' → 'FuturaPT-Book') on every text layer/keyframe that uses it, across the project or given comps. Reports each change and any substitution AE made (font not installed). dry_run lists the changes.", inputSchema: { from: z.string(), to: z.string(), comp_ids: z.array(z.number().int()).optional(), dry_run: DryRun } },
  async ({ from, to, comp_ids, dry_run }) => text(await runScript("mcp/Fonts.jsx", { op: "replace", from, to, compIds: comp_ids, dryRun: dry_run }, { timeoutSec: 1800 })));

// ------------------------------------------------------------------ presets & expressions
async function presetFolders() {
  let app = "Adobe After Effects 2026";
  try { app = await aeAppName(); } catch {}
  const year = (/\d{4}/.exec(app) || ["2026"])[0];
  return [
    { kind: "user", dir: path.join(os.homedir(), "Documents", "Adobe", `After Effects ${year}`, "User Presets") },
    { kind: "app", dir: path.join("/Applications", app, "Presets") },
  ];
}
async function walkFfx(dir, depth = 0) {
  const out = [];
  let entries = [];
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (depth < 8) out.push(...(await walkFfx(p, depth + 1))); }
    else if (/\.ffx$/i.test(e.name)) out.push(p);
  }
  return out;
}
async function listPresets(filter) {
  const folders = await presetFolders(), all = [];
  for (const f of folders) for (const p of await walkFfx(f.dir)) all.push({ kind: f.kind, name: path.basename(p, ".ffx"), category: path.relative(f.dir, path.dirname(p)), path: p });
  const words = String(filter || "").toLowerCase().split(/\s+/).filter(Boolean);
  return { folders, presets: words.length ? all.filter((p) => { const hay = (p.category + "/" + p.name).toLowerCase(); return words.every((w) => hay.includes(w)); }) : all };
}

tool("ae_list_presets", {
  title: "List animation presets",
  description: "Animation presets (.ffx) available to After Effects: the user's User Presets folder first, then the app's Presets folder (Text, Transitions, Behaviors, Shapes, Adobe Express…). filter matches words against category + name, e.g. 'wiggle', 'text in', 'transitions dissolve'. Returns the path to pass to ae_apply_preset.",
  inputSchema: { filter: z.string().optional(), limit: z.number().int().optional() },
  annotations: { readOnlyHint: true },
}, async ({ filter, limit }) => {
  const r = await listPresets(filter);
  const n = limit ?? 60, rows = r.presets.slice(0, n).map((p) => `${p.kind}\t${p.category}\t${p.name}\t${p.path}`);
  return text(`${r.presets.length} preset(s)${r.presets.length > n ? `, showing ${n}` : ""} (folders: ${r.folders.map((f) => f.dir).join(" ; ")})\nkind\tcategory\tname\tpath\n${rows.join("\n")}`);
});

tool("ae_apply_preset", {
  title: "Apply animation preset",
  description: "Apply an animation preset (.ffx) to a layer, like dragging it from Effects & Presets: preset is an absolute path from ae_list_presets or a name fragment that matches exactly one preset. Reports the effects and animated/expression properties the preset added. Applies to the comp in place (not a new version); use ae_apply_edits afterwards for a versioned change, or dry_run first.",
  inputSchema: { comp_id: z.number().int(), layer: z.union([z.number().int(), z.string()]).describe("layer index (1 = top), exact name, or L-id from an export"), preset: z.string(), dry_run: DryRun },
}, async ({ comp_id, layer, preset, dry_run }) => {
  let presetPath = preset;
  if (!path.isAbsolute(preset) || !(await fs.stat(preset).catch(() => null))) {
    const r = await listPresets(preset);
    const exact = r.presets.filter((p) => p.name.toLowerCase() === preset.toLowerCase());
    const pick = exact.length === 1 ? exact : r.presets;
    if (pick.length !== 1) throw new Error(pick.length ? `'${preset}' matches ${pick.length} presets: ${pick.slice(0, 8).map((p) => p.category + "/" + p.name).join(", ")}${pick.length > 8 ? ", …" : ""}. Give the path.` : `No preset matches '${preset}'. Use ae_list_presets.`);
    presetPath = pick[0].path;
  }
  return text(await runScript("mcp/Presets.jsx", { op: "apply", compId: comp_id, layer, preset: presetPath, dryRun: dry_run }, { timeoutSec: 120 }));
});

tool("ae_lint_expression", {
  title: "Lint expression",
  description: "Check an expression by letting After Effects evaluate it. Without a target it runs on a scratch null's Position (dimensions: 1 for a 1D property like Opacity) in a temporary comp that is removed afterwards. With comp_id + layer + path it is tested on that property: the previous expression is restored unless apply: true (then it stays when valid). Returns valid, AE's error text with the line number when invalid, and the value at time 0.",
  inputSchema: { expression: z.string(), comp_id: z.number().int().optional(), layer: z.union([z.number().int(), z.string()]).optional(), path: z.string().optional().describe("property matchName path, default ADBE Transform Group/ADBE Position"), apply: z.boolean().optional(), dimensions: z.number().int().optional().describe("scratch property dimensions when no target: 1, 2 (default) or 3") },
}, async ({ expression, comp_id, layer, path: ppath, apply, dimensions }) => text(await runScript("mcp/Presets.jsx", { op: "lint", expression, compId: comp_id, layer, path: ppath, apply, dimensions }, { timeoutSec: 120 })));

// ------------------------------------------------------------------ round trip
tool("ae_list_comps", {
  title: "List comps",
  description: "List compositions in the open project (id, name, size, fps, duration, layer count, folder). Use filter to narrow by name.",
  inputSchema: { filter: z.string().optional().describe("case-insensitive name substring"), limit: z.number().int().optional() },
  annotations: { readOnlyHint: true },
}, async ({ filter, limit }) => {
  const r = await runScript("mcp/List Comps.jsx", { filter, limit: limit ?? 100 });
  const lines = r.comps.map((c) => `${c.id}\t"${c.name}"\t${c.size.join("x")}\t${c.fps}fps\t${c.duration}s (${Math.round(c.duration * c.fps)} f)\t${c.layers} layers${c.precompLayers ? ` (${c.precompLayers} precomp)` : ""}${c.folder ? `\tfolder: ${c.folder}` : ""}`);
  return text(`${r.total} comp(s)${r.total > r.comps.length ? `, showing ${r.comps.length}` : ""}\nid\tname\tsize\tfps\tduration\tlayers\n${lines.join("\n")}`);
});

tool("ae_get_comp", {
  title: "Export a comp",
  description: "Export a comp and all its nested precomps, returning an outline (every comp and layer with IDs, types, parents, effects, masks and what's animated) and an export_id for ae_get_layers / ae_apply_edits. Tags layers with IDs in their comments. Give comp_id or an exact comp_name; with neither, uses the active comp.",
  inputSchema: { comp_id: z.number().int().optional(), comp_name: z.string().optional() },
}, async (a) => {
  const compId = await resolveCompId(a);
  const { exportId, out } = await exportComp(compId);
  const doc = JSON.parse(await fs.readFile(out, "utf8"));
  return text(outline(doc, exportId));
});

// Compact audit of a layer: effects (non-default params), matte, parent, expressions, key times.
function layerAudit(L, comp, byId) {
  const fps = comp.frameRate || 30;
  const a = { id: L.id, index: L.index, name: L.name, type: L.type, in: timing(L.inPoint, fps), out: timing(L.outPoint, fps), enabled: L.enabled };
  if (L.parent) a.parent = { id: L.parent, name: byId[L.parent]?.name };
  if (L.trackMatte) a.trackMatte = { type: L.trackMatte.type, layer: L.trackMatte.layer, layerName: byId[L.trackMatte.layer]?.name };
  if (L.blendingMode && L.blendingMode !== "NORMAL") a.blendingMode = L.blendingMode;
  if (L.threeD) a.threeD = true;
  if (L.source?.type === "comp") a.precomp = L.source.comp;
  const effects = [], animated = [], expressions = [];
  const walk = (nodes, trail, inEffect) => {
    for (const n of nodes || []) {
      const label = n.name || n.mn.replace(/^ADBE /, "");
      if (n.props) {
        if (n.mn === "ADBE Effect Parade") { for (const e of n.props) { const params = []; (function leafs(ns) { for (const x of ns || []) { if (x.props) leafs(x.props); else if ("value" in x || x.keys) params.push({ name: x.name, value: x.keys ? `${x.keys.length} keys` : x.value, expr: x.expr }); } })(e.props); effects.push({ name: e.name, matchName: e.mn, enabled: e.enabled !== false, params }); } continue; }
        walk(n.props, [...trail, label], inEffect);
      } else {
        const p = [...trail, label].join(" > ");
        if (n.keys) animated.push({ property: p, keys: n.keys.map((k) => ({ ...timing(k.t, fps), interp: k.outInterp })) });
        if (n.expr) expressions.push({ property: p, expression: n.expr, enabled: n.exprOn !== false });
      }
    }
  };
  walk(L.props, [], false);
  if (L.type === "text") { const td = (function find(ns) { for (const x of ns || []) { if (x.mn === "ADBE Text Document") return x; if (x.props) { const r = find(x.props); if (r) return r; } } })(L.props); if (td) a.text = td.value ? { text: td.value.text, font: td.value.font, fontSize: td.value.fontSize, fillColor: td.value.fillColor } : { keyframes: td.keys?.length }; }
  if (effects.length) a.effects = effects;
  if (animated.length) a.animated = animated;
  if (expressions.length) a.expressions = expressions;
  return a;
}

tool("ae_get_layers", {
  title: "Get layer details",
  description: "Layers of an export. Default: full property JSON (values, keyframes with easing, expressions, effects, masks, shape contents, text), optionally only some property paths. summary: true returns a compact audit per layer instead: in/out (frames + timecode), parent, track matte, blending, precomp, effects with their non-default parameters, text settings, animated properties with key times, expressions.",
  inputSchema: {
    export_id: z.string(),
    comp: z.string().optional().describe("comp ID (C-...) or name inside the export; default: root"),
    layers: z.array(z.string()).optional().describe("layer IDs or names; default: all layers in the comp"),
    paths: z.array(z.string()).optional().describe('only these property paths, e.g. "ADBE Transform Group/ADBE Position"'),
    summary: z.boolean().optional(),
  },
  annotations: { readOnlyHint: true },
}, async ({ export_id, comp, layers, paths, summary }) => {
  const { doc } = await loadExport(export_id);
  if (summary) {
    const c = findComp(doc, comp);
    const byId = Object.fromEntries(c.layers.map((l) => [l.id, l]));
    const list = layers?.length ? layers.map((r) => findLayer(c, r)) : c.layers;
    return text({ comp: c.name, fps: c.frameRate, duration: timing(c.duration, c.frameRate), layers: list.map((L) => layerAudit(L, c, byId)) });
  }
  const r = getLayers(doc, comp, layers, paths);
  const s = JSON.stringify(r, null, 1);
  return text(s.length > 120000 ? s.slice(0, 120000) + "\n…(truncated — ask for fewer layers, use paths, or summary: true)" : s);
});

const Op = z.object({
  op: z.enum(["set_property", "set_key", "add_group", "remove_group", "set_layer", "add_layer", "remove_layer", "move_layer", "replace_layer", "set_comp"]),
  comp: z.string().optional().describe("comp ID (C-...) or name in the export; default: root comp"),
  layer: z.any().optional().describe("layer ID or name; for add_layer / replace_layer, the layer object"),
  path: z.union([z.string(), z.array(z.string())]).optional().describe('property path (set_property, set_key, remove_group): "A/B/C", or ["A","B","C"] when a name contains "/" (e.g. "Hue/Saturation")'),
  value: z.any().optional(),
  keys: z.array(z.any()).optional().describe("set_property: replace all keyframes"),
  expr: z.string().optional().describe("set_property: expression ('' removes it)"),
  exprOn: z.boolean().optional(),
  separated: z.boolean().optional(),
  time: z.number().optional().describe("set_key: key time in seconds (matched within 1ms; adds a key if none)"),
  newTime: z.number().optional(),
  remove: z.boolean().optional().describe("set_key: delete the key at time"),
  inInterp: z.enum(["linear", "bezier", "hold"]).optional(),
  outInterp: z.enum(["linear", "bezier", "hold"]).optional(),
  inEase: z.array(z.object({ speed: z.number(), influence: z.number() })).optional(),
  outEase: z.array(z.object({ speed: z.number(), influence: z.number() })).optional(),
  temporalAutoBezier: z.boolean().optional(),
  temporalContinuous: z.boolean().optional(),
  spatialAutoBezier: z.boolean().optional(),
  spatialContinuous: z.boolean().optional(),
  inTangent: z.array(z.number()).optional(),
  outTangent: z.array(z.number()).optional(),
  roving: z.boolean().optional(),
  label: z.number().int().optional(),
  parent: z.union([z.string(), z.array(z.string())]).optional().describe("add_group: parent group path, e.g. 'ADBE Effect Parade' or 'ADBE Root Vectors Group/ADBE Vector Group#1/ADBE Vectors Group'"),
  matchName: z.string().optional().describe("add_group: matchName of the effect / mask / shape item to add"),
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  props: z.array(z.any()).optional().describe("add_group: child nodes, e.g. [{mn:'ADBE Gaussian Blur 2-0001', value:20}]"),
  attrs: z.record(z.any()).optional().describe("set_layer / set_comp: attributes, e.g. {inPoint:1, parent:'L-...', blendingMode:'SCREEN'} or {duration:20}"),
  index: z.number().int().optional().describe("add_layer / move_layer: 1-based position (1 = top)"),
}).passthrough();

tool("ae_apply_edits", {
  title: "Apply edits",
  description: `Apply edits to an exported comp. After Effects duplicates the comp (and only the precomps that change) as a new version and patches just the edited properties. Returns the new comp id, a change log, and warnings for anything AE refused. Ops:
- set_property {layer, path, value | keys | expr}
- set_key {layer, path, time, value?, newTime?, remove?, inInterp/outInterp, inEase/outEase, ...}
- add_group {layer, parent, matchName, name?, props?} (effects, masks, shape items, text animators)
- remove_group {layer, path} (path ends in "#n", e.g. "ADBE Effect Parade/ADBE Fill#1")
- set_layer {layer, attrs} (name, inPoint, outPoint, startTime, parent, enabled, blendingMode, threeD, trackMatte {type, layer}, label, ...)
- add_layer {layer: {type, name, parent?, inPoint?, outPoint?, props?, source?}, index?} / remove_layer {layer} / move_layer {layer, index}
- replace_layer {layer: full layer JSON from ae_get_layers, keeping its id}
- set_comp {attrs} (duration, frameRate, bgColor, workAreaStart, ...)
Every op may name a comp (precomp ID or name in the export); default is the root comp. dry_run validates the edits and lists them without touching AE.`,
  inputSchema: { export_id: z.string(), edits: z.array(Op).min(1), dry_run: DryRun },
}, async ({ export_id, edits, dry_run }) => {
  const { file, doc } = await loadExport(export_id);
  const notes = edits.map((op, i) => { try { return applyOp(doc, op); } catch (e) { throw new Error(`edit ${i + 1} (${op.op}): ${e.message}`); } });
  if (dry_run) return text("Edits are valid (dry run, nothing changed):\n- " + notes.join("\n- "));
  const n = (await fs.readdir(EXPORTS)).filter((f) => f.startsWith(export_id + ".edit")).length + 1;
  const editFile = path.join(EXPORTS, `${export_id}.edit${n}.json`);
  await fs.writeFile(editFile, JSON.stringify(doc, null, 1));
  const r = await runScript("Apply Changes.jsx", { in: editFile, base: file, log: editFile.replace(/\.json$/, ".log.txt") });
  if (!r.newComp) return text(r.message || "No changes.");
  return text([
    `New version: "${r.newComp}" (comp id ${r.newCompId}). Original untouched; project not saved.`,
    `Created comps: ${(r.createdCompIds || []).join(", ")}`,
    "", "Changes applied:", ...r.changes.map((c) => "- " + c),
    ...(r.warnings?.length ? ["", "Warnings (not applied):", ...r.warnings.map((w) => "- " + w)] : []),
    ...(r.hiddenSkipped ? ["", `${r.hiddenSkipped} hidden propert${r.hiddenSkipped > 1 ? "ies" : "y"} skipped (AE won't set them; no visible effect).`] : []),
    "", `To keep editing the new version, call ae_get_comp with comp_id ${r.newCompId}.`,
  ].join("\n"));
});

tool("ae_rebuild_comp", {
  title: "Rebuild comp from export",
  description: "Build brand-new copies of an exported comp tree from its JSON, in a 'Rebuilt - <name>' folder. Mainly for checking that an export is complete. dry_run lists the comps and layers it would build.",
  inputSchema: { export_id: z.string(), dry_run: DryRun },
}, async ({ export_id, dry_run }) => {
  const { file, doc } = await loadExport(export_id);
  if (dry_run) return text({ dryRun: true, wouldBuild: doc.comps.map((c) => ({ comp: c.name + " (rebuilt)", layers: c.layers.length })), footage: doc.footage.map((f) => ({ name: f.name, kind: f.kind, missing: f.missing })) });
  const r = await runScript("Rebuild Comp.jsx", { in: file, log: file.replace(/\.json$/, ".rebuild-log.txt") });
  return text({ newComp: r.newComp, newCompId: r.newCompId, createdCompIds: r.createdCompIds, folderId: r.folderId, warnings: r.warnings, hiddenSkipped: r.hiddenSkipped });
});

tool("ae_remove_versions", {
  title: "Remove versions",
  description: "Delete comps created by ae_apply_edits or ae_rebuild_comp (pass their createdCompIds; for a rebuild also its folderId). Refuses any comp whose name doesn't end in ' vN' or ' (rebuilt)'. Undoable in AE with Edit › Undo.",
  inputSchema: { comp_ids: z.array(z.number().int()).min(1), folder_ids: z.array(z.number().int()).optional(), dry_run: DryRun },
  annotations: { destructiveHint: true },
}, async ({ comp_ids, folder_ids, dry_run }) => {
  const r = await runScript("mcp/Remove Comps.jsx", { ids: comp_ids, folderIds: folder_ids || [], dryRun: dry_run });
  if (r.dryRun) return text(r);
  return text(`Removed: ${r.removed.join(", ") || "nothing"}${r.refused.length ? `\nRefused (not round-trip versions): ${r.refused.join(", ")}` : ""}`);
});

await server.connect(new StdioServerTransport());
