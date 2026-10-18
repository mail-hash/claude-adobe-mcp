// MCP helper: remove comps a previous Apply / Rebuild created, plus null solids they leave unused.
// RT_ARGS = { ids: [compId, ...], folderIds?: [...] }. Only removes items whose names mark them as
// round-trip output (" vN" or " (rebuilt)") so a wrong id can't delete the user's own work.
(function () {
    #include "../lib/rt_core.jsxinc"

    var args = RT.takeArgs() || {}, removed = [], refused = [], minId = 1e12;
    if (args.dryRun) { var planned = []; for (var d = 0; d < (args.ids || []).length; d++) { var cd = RT.findItemById(args.ids[d]); if (cd) planned.push({ id: cd.id, name: cd.name, wouldRemove: (cd instanceof CompItem) && /( v\d+| \(rebuilt\))$/.test(cd.name) }); } return RT.stringify({ ok: true, dryRun: true, plan: planned }); }
    app.beginUndoGroup("Remove round-trip versions");
    var ids = args.ids || [];
    for (var i = 0; i < ids.length; i++) {
        var c = RT.findItemById(ids[i]);
        if (!c) continue;
        if (!(c instanceof CompItem) || !/( v\d+| \(rebuilt\))$/.test(c.name)) { refused.push(c.name); continue; }
        minId = Math.min(minId, c.id); removed.push(c.name); c.remove();
    }
    var fids = args.folderIds || [];
    for (var k = 0; k < fids.length; k++) {
        var f = RT.findItemById(fids[k]);
        if (f instanceof FolderItem && /^Rebuilt - /.test(f.name) && f.numItems === 0) { removed.push(f.name + "/"); f.remove(); }
    }
    for (var j = app.project.numItems; j >= 1; j--) {
        var s = app.project.item(j);
        if (s.id > minId && s instanceof FootageItem && s.mainSource instanceof SolidSource && s.usedIn.length === 0) { removed.push(s.name); s.remove(); }
    }
    app.endUndoGroup();
    return RT.stringify({ ok: true, removed: removed, refused: refused });
})();
