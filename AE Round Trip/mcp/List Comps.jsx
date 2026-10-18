// MCP helper: list comps. RT_ARGS = { filter?: "substring", limit?: n }
(function () {
    #include "../lib/rt_core.jsxinc"

    var args = RT.takeArgs() || {};
    var f = args.filter ? String(args.filter).toLowerCase() : null, limit = args.limit || 200, out = [], total = 0;
    for (var i = 1; i <= app.project.numItems; i++) {
        var c = app.project.item(i);
        if (!(c instanceof CompItem)) continue;
        if (f && c.name.toLowerCase().indexOf(f) < 0) continue;
        total++;
        if (out.length >= limit) continue;
        var pre = 0;
        for (var j = 1; j <= c.numLayers; j++) { try { if (c.layer(j).source instanceof CompItem) pre++; } catch (e) {} }
        out.push({ id: c.id, name: c.name, folder: c.parentFolder && c.parentFolder !== app.project.rootFolder ? c.parentFolder.name : null,
            size: [c.width, c.height], fps: RT.round(c.frameRate), duration: RT.round(c.duration), layers: c.numLayers,
            precompLayers: pre, usedIn: c.usedIn.length });
    }
    return RT.stringify({ ok: true, total: total, comps: out });
})();
