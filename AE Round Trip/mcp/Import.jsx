// MCP helper: import a file. RT_ARGS = { path, as?: "footage"|"comp"|"compCropped"|"project", folder?: name|id, sequence?: bool, name? }
(function () {
    #include "../lib/rt_core.jsxinc"
    var args = RT.takeArgs() || {};
    function fail(msg) { return RT.stringify({ ok: false, error: msg }); }
    if (!app.project) return fail("no project is open");
    if (!args.path) return fail("path is required");
    var f = new File(args.path);
    if (!f.exists) return fail("file not found: " + f.fsName);
    if (args.dryRun) return RT.stringify({ ok: true, dryRun: true, plan: { op: "import", path: f.fsName, as: args.as || "footage", folder: args.folder || null, sequence: !!args.sequence } });

    function findFolder(ref) {
        if (ref === undefined || ref === null || ref === "") return null;
        var it = RT.findItemById(Number(ref));
        if (it instanceof FolderItem) return it;
        for (var i = 1; i <= app.project.numItems; i++) { var x = app.project.item(i); if (x instanceof FolderItem && x.name === String(ref)) return x; }
        return app.project.items.addFolder(String(ref));
    }
    function itemInfo(it) {
        var o = { id: it.id, name: it.name, type: it.typeName };
        try { if (it instanceof FolderItem) o.items = it.numItems; } catch (e0) {}
        try { if (it.width !== undefined) { o.width = it.width; o.height = it.height; } } catch (e1) {}
        try { if (it.duration !== undefined) o.duration = RT.round(it.duration); } catch (e2) {}
        try { if (it.frameRate !== undefined) o.frameRate = RT.round(it.frameRate); } catch (e3) {}
        try { if (it instanceof FootageItem) { o.missing = it.footageMissing; o.hasVideo = it.hasVideo; o.hasAudio = it.hasAudio; if (it.mainSource instanceof FileSource && it.mainSource.file) o.path = it.mainSource.file.fsName; } } catch (e4) {}
        try { if (it instanceof CompItem) o.layers = it.numLayers; } catch (e5) {}
        return o;
    }

    var suppressed = false;
    try { app.beginSuppressDialogs(); suppressed = true; } catch (e) {}
    try {
        var io = new ImportOptions(f);
        var as = String(args.as || "footage").toLowerCase();
        var map = { footage: ImportAsType.FOOTAGE, comp: ImportAsType.COMP, compcropped: ImportAsType.COMP_CROPPED_LAYERS, project: ImportAsType.PROJECT };
        var want = map[as];
        if (want === undefined) return fail("as must be footage, comp, compCropped or project");
        if (!io.canImportAs(want)) {
            var can = [];
            for (var k in map) if (RT.has(map, k) && io.canImportAs(map[k])) can.push(k);
            return fail("'" + f.name + "' can't be imported as " + as + ". Possible: " + (can.join(", ") || "none"));
        }
        io.importAs = want;
        if (args.sequence) { io.sequence = true; io.forceAlphabetical = true; }
        var before = {}; for (var b = 1; b <= app.project.numItems; b++) before[app.project.item(b).id] = true;
        var item = app.project.importFile(io);
        var folder = findFolder(args.folder);
        if (folder && item) { try { item.parentFolder = folder; } catch (e6) {} }
        if (args.name && item) { try { item.name = String(args.name); } catch (e7) {} }
        var created = [];
        for (var c = 1; c <= app.project.numItems; c++) { var it = app.project.item(c); if (!before[it.id]) created.push(itemInfo(it)); }
        if (suppressed) { app.endSuppressDialogs(false); suppressed = false; }
        return RT.stringify({ ok: true, item: item ? itemInfo(item) : null, created: created, folder: folder ? { id: folder.id, name: folder.name } : null });
    } catch (e) {
        if (suppressed) { try { app.endSuppressDialogs(false); } catch (e8) {} }
        return fail(String(e.message || e) + (e.line ? " (line " + e.line + ")" : ""));
    }
})();
