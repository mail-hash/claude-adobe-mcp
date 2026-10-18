// Export Comp.jsx — exports the active comp and all nested precomps to JSON.
// Tags every comp and layer with a stable [rtid:...] in its comment, and writes a
// "<name>.rtbase.json" baseline next to the JSON so Apply Changes can tell what you edited.
//
// Headless use: set $.global.RT_ARGS = { comp: "<name>" | compId: <id>, out: "/path/file.json" } first.

(function () {
    #include "lib/rt_core.jsxinc"

    var args = RT.takeArgs();
    var headless = !!args;
    args = args || {};

    function fail(msg) { if (!headless) alert(msg, "Export Comp"); return RT.stringify({ ok: false, error: msg }); }

    if (!app.project) return fail("No project open.");
    var comp = null;
    if (args.compId) comp = RT.findItemById(args.compId);
    else if (args.comp) comp = RT.findCompByName(args.comp);
    else comp = app.project.activeItem;
    if (!(comp instanceof CompItem)) return fail("Select or open a composition first.");

    var outFile;
    if (args.out) outFile = new File(args.out);
    else {
        var dir = app.project.file ? app.project.file.parent.fsName : Folder.desktop.fsName;
        var safe = comp.name.replace(/[\/\\:*?"<>|]/g, "_");
        outFile = new File(dir + "/" + safe + ".json").saveDlg("Export comp to JSON", "JSON:*.json");
        if (!outFile) return RT.stringify({ ok: false, error: "cancelled" });
    }

    var doc;
    app.beginUndoGroup("Export Comp (tag layer IDs)");
    try {
        doc = RT.exportTree(comp);
    } catch (e) {
        app.endUndoGroup();
        return fail("Export failed: " + e.message + " (line " + e.line + ")");
    }
    app.endUndoGroup();

    RT.writeJSON(outFile, doc);
    RT.writeJSON(RT.basePathFor(outFile), doc);

    var nLayers = 0;
    for (var i = 0; i < doc.comps.length; i++) nLayers += doc.comps[i].layers.length;
    var summary = "Exported '" + comp.name + "': " + doc.comps.length + " comp(s), " + nLayers + " layer(s), " +
        doc.footage.length + " footage item(s)\n" + outFile.fsName;
    if (!headless) alert(summary, "Export Comp");
    return RT.stringify({ ok: true, file: outFile.fsName, base: RT.basePathFor(outFile), comps: doc.comps.length, layers: nLayers, footage: doc.footage.length });
})();
