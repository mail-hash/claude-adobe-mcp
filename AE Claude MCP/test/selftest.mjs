// End-to-end self-test against a live After Effects. Exercises every tool through the real MCP server.
// Usage: node test/selftest.mjs [--keep] [--no-render]
// Needs: AE running (any project — it creates its own; the current project must have no unsaved changes),
// Accessibility granted to the process running this (for the dialog test). Writes under
// ~/Library/Application Support/AE Claude Round Trip/selftest/<timestamp>/.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const argv = process.argv.slice(2);
const keep = argv.includes("--keep"), noRender = argv.includes("--no-render");
const dir = path.join(os.homedir(), "Library", "Application Support", "AE Claude Round Trip", "selftest", new Date().toISOString().replace(/[:.]/g, "-"));
await fs.mkdir(dir, { recursive: true });

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
  try { const j = JSON.parse(txt); return img ? { image: img.data.length, ...j } : j; } catch { return img ? { image: img.data.length, text: txt } : txt; }
}
const results = [];
async function step(name, fn, { optional = false } = {}) {
  const t0 = Date.now();
  try { const r = await fn(); results.push({ step: name, ok: true, ms: Date.now() - t0 }); console.log(`✓ ${name} (${Date.now() - t0} ms) ${r !== undefined ? JSON.stringify(r).slice(0, 220) : ""}`); return r; }
  catch (e) { results.push({ step: name, ok: optional ? "skipped" : false, ms: Date.now() - t0, error: e.message }); console.log(`${optional ? "○" : "✗"} ${name}: ${e.message.split("\n")[0].slice(0, 300)}`); if (!optional) throw e; return null; }
}
const assert = (c, m) => { if (!c) throw new Error("assertion failed: " + m); };
const projPath = path.join(dir, "selftest.aep");

try {
  const st = await step("ae_status", () => tool("ae_status"));
  assert(st.running && st.responsive === true, "AE not responsive: " + (st.error || ""));
  if (st.modalDialogs?.length) throw new Error("AE has a dialog open: " + JSON.stringify(st.modalDialogs));

  await step("ae_new_project dry_run", async () => { const r = await tool("ae_new_project", { path: projPath, dry_run: true }); assert(r.dryRun, "dry"); return r.plan.op; });
  await step("ae_new_project", () => tool("ae_new_project", { path: projPath, discard_unsaved: true }));

  // Build a comp with the helper library: text + shape layers, eased keys, groups in order.
  const built = await step("ae_run_script builds a comp (helpers)", async () => {
    const r = await tool("ae_run_script", { code: `
      app.beginUndoGroup("selftest build");
      var fld = ensureFolder("Selftest/Comps");
      var c = ensureComp("Selftest Comp", 640, 360, 4, 30, fld);
      c.bgColor = [0.1, 0.1, 0.12];
      var t = c.layers.addText("Hello"); t.name = "Title";
      var sh = c.layers.addShape(); sh.name = "Badge";
      var contents = sh.property("ADBE Root Vectors Group");
      var groups = addGroupsInOrder(contents, [{ mn: "ADBE Vector Group", name: "Top group" }, { mn: "ADBE Vector Group", name: "Bottom group" }]);
      var inner = groups[0].property("ADBE Vectors Group");
      var rect = addGroup(inner, "ADBE Vector Shape - Rect", "Box"); rect.property("ADBE Vector Rect Size").setValue([300, 120]);
      var fill = addGroup(inner, "ADBE Vector Graphic - Fill", "Fill"); fill.property("ADBE Vector Fill Color").setValue([0.9, 0.3, 0.2, 1]);
      var pos = sh.property("ADBE Transform Group").property("ADBE Position");
      setKeys(pos, [[0, [120, 180]], [2, [520, 180]]]);
      var eased = easeKeys(pos, null, 75);
      var op = t.property("ADBE Transform Group").property("ADBE Opacity");
      setKeys(op, [[0, 0], [1, 100]]); easeKeys(op);
      var col = fill.property("ADBE Vector Fill Color"); setKeys(col, [[0, [0.9, 0.3, 0.2, 1]], [3, [0.2, 0.6, 0.9, 1]]]); easeKeys(col, null, 50);
      log("built", c.name, "layers:", c.numLayers, "eased position keys:", eased, "groups order:", [contents.property(1).name, contents.property(2).name]);
      log("str test:", str([1, 2]), str(new Error("boom")));
      app.endUndoGroup();
      ({ compId: c.id, name: c.name, layers: c.numLayers, topGroup: contents.property(1).name, fps: fps(c), f30: frame(c, 1), tc: tc(c, 1.5) })` });
    assert(r.ok && r.result.layers === 2 && r.result.topGroup === "Top group" && r.result.f30 === 30 && r.result.tc === "00:00:01:15", "build result " + JSON.stringify(r.result));
    assert(r.output && r.output.length === 2 && /\[1, 2\]/.test(r.output[1]), "log/str output: " + JSON.stringify(r.output));
    return r.result;
  });
  const compId = built.compId;
  await step("ae_run_script error has line + context", async () => { const r = await tool("ae_run_script", { code: "var a = 1;\nnoSuchFn();" }); assert(r.ok === false && r.errorDetail.line === 2 && /noSuchFn/.test(r.errorDetail.context), "error detail " + JSON.stringify(r.errorDetail)); return r.error; });
  await step("ae_run_script background + ae_job_wait", async () => { const j = await tool("ae_run_script", { code: "$.sleep(1500); app.project.numItems", background: true }); assert(j.jobId, "job id"); const w = await tool("ae_job_wait", { job_id: j.jobId, max_wait_sec: 60 }); assert(w.status === "done" && typeof w.result.result === "number", "job done " + JSON.stringify(w).slice(0, 200)); const s = await tool("ae_job_status", { job_id: j.jobId }); assert(s.status === "done", "status"); const all = await tool("ae_job_status"); assert(Array.isArray(all) && all.length >= 2, "job list"); return { elapsed: w.elapsedSec, jobs: all.length }; });

  await step("ae_list_comps", async () => { const r = await tool("ae_list_comps", { filter: "Selftest" }); assert(/Selftest Comp/.test(r) && /\(120 f\)/.test(r), "listed with frames"); return r.split("\n")[0]; });
  const fonts = await step("ae_list_fonts_used", async () => { const r = await tool("ae_list_fonts_used", { comp_id: compId }); assert(r.fonts.length === 1 && r.fonts[0].uses[0].layer === "Title", "one font on Title"); return r.fonts[0].font; });
  await step("ae_replace_font dry_run + apply", async () => { const d = await tool("ae_replace_font", { from: fonts, to: "Helvetica-Bold", comp_ids: [compId], dry_run: true }); assert(d.dryRun && d.changed === 1, "dry run lists 1"); const r = await tool("ae_replace_font", { from: fonts, to: "Helvetica-Bold", comp_ids: [compId] }); assert(r.changed === 1 && r.changes[0].result === "Helvetica-Bold", "replaced: " + JSON.stringify(r)); return r.changes[0].result; });

  const presetPath = await step("ae_list_presets", async () => { const r = await tool("ae_list_presets", { filter: "wiggle", limit: 5 }); assert(/preset\(s\)/.test(r) && /\.ffx/.test(r), "presets listed"); const row = r.split("\n").find((l) => /\.ffx$/.test(l)); return row.split("\t").at(-1); });
  await step("ae_apply_preset dry_run + apply", async () => { const d = await tool("ae_apply_preset", { comp_id: compId, layer: "Badge", preset: presetPath, dry_run: true }); assert(d.dryRun && d.plan.layer === "Badge", "dry plan"); const r = await tool("ae_apply_preset", { comp_id: compId, layer: "Badge", preset: presetPath }); assert(r.ok && (r.effectsAdded.length > 0 || r.animatedAdded.length > 0), "preset added something: " + JSON.stringify(r).slice(0, 300)); return { effects: r.effectsAdded.map((e) => e.name), animated: r.animatedAdded.map((a) => a.name) }; });
  await step("ae_apply_preset ambiguous name is refused", async () => { try { await tool("ae_apply_preset", { comp_id: compId, layer: "Badge", preset: "in" }); throw new Error("not refused"); } catch (e) { assert(/matches \d+ presets|No preset/.test(e.message), "refusal: " + e.message); return "refused"; } });
  await step("ae_lint_expression valid (scratch)", async () => { const r = await tool("ae_lint_expression", { expression: "wiggle(2, 30)" }); assert(r.valid === true && Array.isArray(r.valueAtStart) && r.applied === false, "valid wiggle " + JSON.stringify(r)); return r.valueAtStart; });
  await step("ae_lint_expression invalid reports line", async () => { const r = await tool("ae_lint_expression", { expression: "var a = 1;\nwiggle(2, 30", dimensions: 1 }); assert(r.valid === false && r.line === 2 && /SyntaxError/.test(r.message || r.error), "error with line " + JSON.stringify(r)); return r.message; });
  await step("ae_lint_expression on a real property restores it", async () => { const r = await tool("ae_lint_expression", { expression: "thisComp.layer('nope').transform.opacity", comp_id: compId, layer: "Badge", path: "ADBE Transform Group/ADBE Opacity" }); assert(r.valid === false && r.restored === true && /nope/.test(r.error), "missing layer error + restored " + JSON.stringify(r)); const a = await tool("ae_lint_expression", { expression: "100", comp_id: compId, layer: "Badge", path: "ADBE Transform Group/ADBE Opacity", apply: true }); assert(a.valid && a.applied === true, "applied"); return { restored: r.restored, applied: a.applied }; });

  const outline = await step("ae_get_comp", async () => { const r = await tool("ae_get_comp", { comp_id: compId }); assert(/export_id: /.test(r) && /L-/.test(r), "outline"); return /export_id: (\S+)/.exec(r)[1]; });
  await step("ae_get_layers summary", async () => { const r = await tool("ae_get_layers", { export_id: outline, summary: true }); const badge = r.layers.find((l) => l.name === "Badge"); assert(badge.animated.some((a) => /Position/.test(a.property) && a.keys.length === 2 && a.keys[1].frames === 60 && a.keys[1].timecode === "00:00:02:00"), "animated keys with timecode " + JSON.stringify(badge.animated)); assert(r.layers.find((l) => l.name === "Title").text.font === "Helvetica-Bold", "text font in summary"); return badge.animated.map((a) => a.property); });
  await step("ae_get_layers full", async () => { const r = await tool("ae_get_layers", { export_id: outline, layers: ["Badge"], paths: ["ADBE Transform Group/ADBE Position"] }); const keys = r.layers[0].props["ADBE Transform Group/ADBE Position"].keys; assert(keys.length === 2 && keys[0].outInterp === "bezier" && Math.abs(keys[0].outEase[0].influence - 75) < 0.01, "eased keys exported " + JSON.stringify(keys[0])); return keys[0].outEase; });
  await step("ae_apply_edits dry_run", async () => { const r = await tool("ae_apply_edits", { export_id: outline, dry_run: true, edits: [{ op: "set_key", layer: "Badge", path: "ADBE Transform Group/ADBE Position", time: 2, value: [400, 180] }] }); assert(/dry run/.test(r), "dry"); return "ok"; });
  const applied = await step("ae_apply_edits", async () => { const r = await tool("ae_apply_edits", { export_id: outline, edits: [{ op: "set_key", layer: "Badge", path: "ADBE Transform Group/ADBE Position", time: 2, value: [400, 180] }, { op: "set_layer", layer: "Title", attrs: { name: "Title v2" } }] }); const id = Number(/comp id (\d+)/.exec(r)[1]); assert(id && /Title v2/.test(r), "v2 created"); return { v2: id, created: [...r.matchAll(/Created comps: ([\d, ]+)/g)].map((m) => m[1])[0] }; });
  const v2 = applied.v2;
  await step("ae_render_frame inline", async () => { const r = await tool("ae_render_frame", { comp_id: v2, time: 1, max_size: 320 }); assert(r.image > 1000 && /frame 30/.test(r.text), "image + frame"); return r.text; });
  await step("ae_save_frame", async () => { const r = await tool("ae_save_frame", { comp_id: compId, time: 1, png_path: path.join(dir, "frame30.png") }); assert(r.bytes > 0 && r.frame === 30 && r.timecode === "00:00:01:00", "frame saved"); return r.timecode; });
  await step("ae_save_frames + contact sheet", async () => { const r = await tool("ae_save_frames", { frames: [{ comp_id: compId, time: 0.5 }, { comp_id: compId, frame: 60 }, { comp_id: v2, frame: 60 }], out_dir: path.join(dir, "frames"), contact_sheet: true }); assert(r.count === 3 && r.frames.every((f) => f.ok) && r.frames[1].frame === 60, "3 frames"); return { sheet: r.contactSheet }; });

  const rendered = await step("ae_render_comp (wait, 1s H.264)", async () => { const r = await tool("ae_render_comp", { comp_id: compId, out_path: path.join(dir, "render.mp4"), template: "H.264 - Match Render Settings - 15 Mbps", start: 0, end: 1 }); assert(r.ok && r.exists && r.frames === 30, "rendered 30 frames " + JSON.stringify(r)); return { bytes: r.bytes, frames: r.frames, tc: r.end.timecode }; }, { optional: noRender });
  await step("ae_render_comps dry_run", async () => { const r = await tool("ae_render_comps", { items: [{ comp_id: compId }, { comp_id: v2, end: 1 }], out_dir: path.join(dir, "batch"), template: "H.264", dry_run: true }); assert(r.dryRun && r.items.length === 2 && /H.264/.test(r.template), "plan"); return r.items.map((i) => i.frames); });
  await step("ae_render_comps background job", async () => { const j = await tool("ae_render_comps", { items: [{ comp_id: compId, end: 0.5 }, { comp_id: v2, end: 0.5 }], out_dir: path.join(dir, "batch"), template: "H.264", pattern: "{index}_{comp}" }); assert(j.jobId, "job id"); const w = await tool("ae_job_wait", { job_id: j.jobId, max_wait_sec: 600 }); assert(w.status === "done" && w.result.items.length === 2 && w.result.items.every((i) => i.ok && i.frames === 15), "batch done " + JSON.stringify(w).slice(0, 300)); return w.result.items.map((i) => [path.basename(i.out), i.status, i.frames]); }, { optional: noRender });
  if (rendered) await step("ae_compare comp vs its own render", async () => { const r = await tool("ae_compare", { comp_id: compId, reference: path.join(dir, "render.mp4"), times: [0.2, 0.5, 0.9], psnr_min: 30 }); assert(r.frames === 3 && r.passed === 3 && r.minPsnr > 30, "compare " + JSON.stringify(r.rows)); return { minPsnr: r.minPsnr, minSsim: r.minSsim, sheet: !!r.sheet, image: r.image > 0 }; }, { optional: noRender });

  await step("ae_import dry_run + import PNG", async () => { const d = await tool("ae_import", { path: path.join(dir, "frame30.png"), folder: "Selftest/Footage", dry_run: true }); assert(d.dryRun, "dry"); const r = await tool("ae_import", { path: path.join(dir, "frame30.png"), folder: "Selftest/Footage" }); assert(r.item && r.item.width === 640, "imported png"); return r.item.name; });
  await step("ae_rebuild_comp dry_run + rebuild", async () => { const d = await tool("ae_rebuild_comp", { export_id: outline, dry_run: true }); assert(d.dryRun && d.wouldBuild.length === 1, "dry"); const r = await tool("ae_rebuild_comp", { export_id: outline }); assert(r.newCompId, "rebuilt"); return { newComp: r.newComp, warnings: r.warnings?.length || 0, rebuiltIds: r.createdCompIds, folderId: r.folderId }; });
  const rb = results.at(-1);
  await step("ae_remove_versions dry_run + remove", async () => { const last = await tool("ae_list_comps", { filter: "rebuilt" }); const ids = [...last.matchAll(/^(\d+)\t/gm)].map((m) => Number(m[1])); const d = await tool("ae_remove_versions", { comp_ids: [...ids, compId], dry_run: true }); assert(d.dryRun && d.plan.some((p) => p.wouldRemove === false), "refuses original in dry run"); const r = await tool("ae_remove_versions", { comp_ids: [...ids, v2] }); assert(/Removed: /.test(r) && !/Refused/.test(r), "removed versions"); return r.split("\n")[0]; });

  await step("ae_save_as + ae_save", async () => { const a = await tool("ae_save_as", { path: path.join(dir, "selftest-copy.aep") }); assert(/selftest-copy\.aep$/.test(a.state.project), "saved as"); const s = await tool("ae_save"); assert(s.ok && s.state.unsavedChanges === false, "saved"); return a.state.project; });
  await step("ae_open_project (reopen)", async () => { const r = await tool("ae_open_project", { path: projPath }); assert(/selftest\.aep$/.test(r.state.project), "reopened"); return r.state.items; });

  // Dialog: raise a real modal alert in AE through a background job, detect it, dismiss it.
  await step("ae_status detects dialog + ae_dismiss_dialog", async () => {
    const j = await tool("ae_run_script", { code: 'alert("AE Round Trip self-test dialog"); "dismissed"', background: true });
    let seen = null;
    for (let i = 0; i < 20 && !seen; i++) { await new Promise((r) => setTimeout(r, 1000)); const s = await tool("ae_status"); if (s.modalDialogs?.length) seen = s.modalDialogs; }
    assert(seen && /self-test dialog/.test(seen[0].text), "dialog detected: " + JSON.stringify(seen));
    const d = await tool("ae_dismiss_dialog", { button: "OK" }); assert(d.dismissed, "dismissed");
    const w = await tool("ae_job_wait", { job_id: j.jobId, max_wait_sec: 60 }); assert(w.status === "done" && w.result.result === "dismissed", "job finished after dismiss: " + JSON.stringify(w).slice(0, 200));
    return { text: seen[0].text, buttons: seen[0].buttons };
  });

  if (!keep) await step("ae_new_project (leave AE on a blank project)", () => tool("ae_new_project", { discard_unsaved: true }));
  const notCovered = toolNames.filter((t) => !covered.has(t));
  console.log(`\nALL PASSED (${results.filter((r) => r.ok === true).length} steps${results.some((r) => r.ok === "skipped") ? `, ${results.filter((r) => r.ok === "skipped").length} skipped` : ""}). Tools exercised: ${covered.size}/${toolNames.length}${notCovered.length ? " — not covered: " + notCovered.join(", ") : ""}.\nScratch files: ${dir}`);
} catch (e) {
  console.log(`\nFAILED at step "${results.at(-1)?.step}": ${e.message}`);
  process.exitCode = 1;
} finally {
  await fs.writeFile(path.join(dir, "results.json"), JSON.stringify(results, null, 1));
  await client.close();
}
