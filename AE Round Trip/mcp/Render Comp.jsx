// MCP helper: render a comp through the render queue.
// RT_ARGS = { compId, out, template?: "H.264 - Match Render Settings - 15 Mbps", settings?: "Best Settings",
//             start?: seconds, end?: seconds, via?: "ae"|"ame", keepItem?: bool }
// Other queued items are paused while this one renders, then restored.
(function () {
    #include "../lib/rt_core.jsxinc"
    var args = RT.takeArgs() || {};
    function fail(msg, extra) { var o = { ok: false, error: msg }; if (extra) for (var k in extra) if (RT.has(extra, k)) o[k] = extra[k]; return RT.stringify(o); }
    if (!app.project) return fail("no project is open");
    var comp = RT.findItemById(Number(args.compId));
    if (!(comp instanceof CompItem)) return fail("comp " + args.compId + " not found");
    if (!args.out) return fail("out path is required");
    var rq = app.project.renderQueue;
    if (rq.rendering) return fail("After Effects is already rendering; wait for it to finish.");

    if (args.dryRun) return RT.stringify({ ok: true, dryRun: true, plan: { comp: comp.name, out: args.out, template: args.template || "H.264 - Match Render Settings - 15 Mbps", start: args.start || 0, end: args.end || comp.duration, frames: Math.round(((typeof args.end === "number" ? args.end : comp.duration) - (args.start || 0)) * comp.frameRate), via: args.via || "ae" } });
    var outFile = new File(args.out);
    if (!outFile.parent.exists) outFile.parent.create();

    var item = null, paused = [], rqBefore = rq.numItems;
    try {
        item = rq.items.add(comp);
        if (args.settings) item.applyTemplate(args.settings);
        var om = item.outputModule(1);
        var template = args.template || "H.264 - Match Render Settings - 15 Mbps";
        var templates = om.templates, okT = false;
        for (var t = 0; t < templates.length; t++) if (templates[t] === template) okT = true;
        if (!okT) {
            var vis = []; for (var v = 0; v < templates.length; v++) if (!/^_HIDDEN/.test(templates[v])) vis.push(templates[v]);
            item.remove();
            return fail("No output module template named '" + template + "'. Available: " + vis.join(" | "));
        }
        om.applyTemplate(template);
        om.file = outFile;
        var start = (typeof args.start === "number") ? Math.max(0, args.start) : 0;
        var end = (typeof args.end === "number") ? Math.min(comp.duration, args.end) : comp.duration;
        if (end <= start) { item.remove(); return fail("end must be after start"); }
        if (typeof args.start === "number" || typeof args.end === "number") {
            item.timeSpanStart = start;
            item.timeSpanDuration = end - start;
        }
        if (String(args.via || "ae").toLowerCase() === "ame") {
            if (!rq.canQueueInAME) { item.remove(); return fail("This After Effects can't queue in Adobe Media Encoder."); }
            // Other queued items would be sent too — pause them first.
            for (var i = 1; i <= rq.numItems; i++) { var it0 = rq.item(i); if (it0 !== item && it0.status === RQItemStatus.QUEUED) { it0.render = false; paused.push(i); } }
            rq.queueInAME(true);
            for (var p0 = 0; p0 < paused.length; p0++) { try { rq.item(paused[p0]).render = true; } catch (e0) {} }
            return RT.stringify({ ok: true, via: "ame", queued: true, comp: comp.name, out: om.file.fsName, note: "Sent to Adobe Media Encoder; it renders there in the background." });
        }
        for (var j = 1; j <= rq.numItems; j++) { var it1 = rq.item(j); if (it1 !== item && it1.status === RQItemStatus.QUEUED) { it1.render = false; paused.push(j); } }
        var t0 = new Date().getTime();
        rq.render(); // blocks until done
        var secs = (new Date().getTime() - t0) / 1000;
        for (var p1 = 0; p1 < paused.length; p1++) { try { rq.item(paused[p1]).render = true; } catch (e1) {} }
        var status = RT.enumName(RQItemStatus, item.status);
        var produced = om.file;
        var exists = produced && produced.exists;
        var res = { ok: status === "DONE" && exists, via: "ae", status: status, comp: comp.name, out: produced ? produced.fsName : null, exists: !!exists, seconds: RT.round(secs), template: template, timeSpan: [RT.round(start), RT.round(end)] };
        if (exists) res.bytes = produced.length;
        try { if (item.logType !== undefined && status !== "DONE") res.hint = "Check the render log (File > Show Render Log) for the failure reason."; } catch (e2) {}
        if (!args.keepItem) { try { item.remove(); } catch (e3) {} }
        if (!res.ok && !res.error) res.error = "render ended with status " + status + (exists ? "" : " and no file was written");
        return RT.stringify(res);
    } catch (e) {
        for (var p2 = 0; p2 < paused.length; p2++) { try { rq.item(paused[p2]).render = true; } catch (e4) {} }
        try { if (item && !args.keepItem) item.remove(); } catch (e5) {}
        return fail(String(e.message || e) + (e.line ? " (line " + e.line + ")" : ""));
    }
})();
