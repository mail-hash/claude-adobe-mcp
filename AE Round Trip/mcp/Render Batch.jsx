// MCP helper: render one or more comps through the Render Queue, touching only the items it adds.
// RT_ARGS = { items: [{ compId, out?, start?, end? }], outDir?, pattern?: "{comp}.mp4", template?: "H.264" (fragment ok),
//             settings?: "Best Settings", keepItems?: bool, dryRun?: bool }
// Other queued items are paused for the duration and restored afterwards. Blocks until the renders finish.
(function () {
    #include "../lib/rt_core.jsxinc"
    var args = RT.takeArgs() || {};
    function fail(msg, extra) { var o = { ok: false, error: msg }; if (extra) for (var k in extra) if (RT.has(extra, k)) o[k] = extra[k]; return RT.stringify(o); }
    if (!app.project) return fail("no project is open");
    var rq = app.project.renderQueue;
    if (rq.rendering) return fail("After Effects is already rendering; wait for it to finish.");
    var specs = args.items || [];
    if (!specs.length) return fail("items is empty");

    function safeName(s) { return String(s).replace(/[\/\\:*?"<>|]/g, "_"); }
    function pickTemplate(om, want) {
        var t = om.templates, exact = null, partial = [], vis = [];
        for (var i = 0; i < t.length; i++) { if (/^_HIDDEN/.test(t[i])) continue; vis.push(t[i]); if (t[i] === want) exact = t[i]; else if (want && t[i].toLowerCase().indexOf(String(want).toLowerCase()) >= 0) partial.push(t[i]); }
        if (exact) return { name: exact };
        if (partial.length === 1) return { name: partial[0] };
        if (partial.length > 1) { // prefer a "Match Render Settings" variant, then the first
            for (var p = 0; p < partial.length; p++) if (/Match Render Settings/.test(partial[p]) && /15 Mbps/.test(partial[p])) return { name: partial[p], ambiguous: partial };
            return { name: partial[0], ambiguous: partial };
        }
        return { error: "No output module template matches '" + want + "'. Available: " + vis.join(" | ") };
    }
    var template = args.template || "H.264 - Match Render Settings - 15 Mbps";
    var outDir = args.outDir ? new Folder(args.outDir) : null;
    if (outDir && !outDir.exists) outDir.create();
    var pattern = args.pattern || "{comp}";

    var plan = [], added = [], i;
    for (i = 0; i < specs.length; i++) {
        var comp = RT.findItemById(Number(specs[i].compId));
        if (!(comp instanceof CompItem)) return fail("comp " + specs[i].compId + " not found", { completed: plan });
        var out = specs[i].out;
        if (!out) {
            if (!outDir) return fail("give items[].out or outDir");
            out = outDir.fsName + "/" + pattern.replace("{comp}", safeName(comp.name)).replace("{index}", String(i + 1)).replace("{id}", String(comp.id));
        }
        var start = (typeof specs[i].start === "number") ? Math.max(0, specs[i].start) : 0;
        var end = (typeof specs[i].end === "number") ? Math.min(comp.duration, specs[i].end) : comp.duration;
        if (end <= start) return fail("item " + (i + 1) + ": end must be after start");
        plan.push({ compId: comp.id, comp: comp.name, out: out, start: start, end: end, frames: Math.round((end - start) * comp.frameRate), fps: comp.frameRate });
    }
    if (args.dryRun) return RT.stringify({ ok: true, dryRun: true, template: template, items: plan });

    var paused = [];
    try {
        for (i = 0; i < plan.length; i++) {
            var c = RT.findItemById(plan[i].compId);
            var item = rq.items.add(c);
            if (args.settings) item.applyTemplate(args.settings);
            var om = item.outputModule(1);
            var pick = pickTemplate(om, template);
            if (pick.error) { item.remove(); for (var r0 = 0; r0 < added.length; r0++) { try { added[r0].item.remove(); } catch (e) {} } return fail(pick.error); }
            om.applyTemplate(pick.name);
            var f = new File(plan[i].out); if (!f.parent.exists) f.parent.create();
            om.file = f;
            if (plan[i].start > 0 || plan[i].end < c.duration) { item.timeSpanStart = plan[i].start; item.timeSpanDuration = plan[i].end - plan[i].start; }
            added.push({ item: item, om: om, plan: plan[i], template: pick.name, ambiguous: pick.ambiguous });
        }
        for (var j = 1; j <= rq.numItems; j++) { var it = rq.item(j), mine = false; for (var m = 0; m < added.length; m++) if (added[m].item === it) mine = true; if (!mine && it.status === RQItemStatus.QUEUED) { it.render = false; paused.push(j); } }
        var t0 = new Date().getTime();
        rq.render();
        var secs = (new Date().getTime() - t0) / 1000;
        for (var p1 = 0; p1 < paused.length; p1++) { try { rq.item(paused[p1]).render = true; } catch (e1) {} }
        var results = [], allOk = true;
        for (var k = 0; k < added.length; k++) {
            var a = added[k], status = RT.enumName(RQItemStatus, a.item.status), produced = a.om.file, exists = produced && produced.exists;
            var r = { compId: a.plan.compId, comp: a.plan.comp, status: status, ok: status === "DONE" && !!exists, out: produced ? produced.fsName : null, bytes: exists ? produced.length : 0, frames: a.plan.frames, fps: RT.round(a.plan.fps), start: RT.round(a.plan.start), end: RT.round(a.plan.end), template: a.template };
            if (a.ambiguous) r.templateNote = "template fragment matched several: " + a.ambiguous.join(" | ") + " — used " + a.template;
            if (!r.ok) allOk = false;
            results.push(r);
            if (!args.keepItems) { try { a.item.remove(); } catch (e2) {} }
        }
        return RT.stringify({ ok: allOk, seconds: RT.round(secs), count: results.length, items: results, pausedOtherItems: paused.length, error: allOk ? undefined : "one or more items did not finish (see items[].status)" });
    } catch (e) {
        for (var p2 = 0; p2 < paused.length; p2++) { try { rq.item(paused[p2]).render = true; } catch (e3) {} }
        if (!args.keepItems) for (var q = 0; q < added.length; q++) { try { added[q].item.remove(); } catch (e4) {} }
        return fail(String(e.message || e) + (e.line ? " (line " + e.line + ")" : ""));
    }
})();
