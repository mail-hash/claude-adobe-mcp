// Rebuild Comp.jsx — builds brand-new comps (root + nested precomps) from an export JSON.
// Everything goes into a project folder "Rebuilt - <root name>". Footage is reused from the
// project when it still exists, re-imported from its path otherwise, or replaced by a placeholder.
// Layers keep their [rtid:...] IDs; the rebuilt comps get new comp IDs.
//
// Headless use: $.global.RT_ARGS = { in: "/path/file.json", log: "/optional/log.txt" }

(function () {
    #include "lib/rt_core.jsxinc"

    var args = RT.takeArgs();
    var headless = !!args;
    args = args || {};
    var log = [], warnings = [];
    function note(s) { log.push(s); }
    var hidden = [];
    var warn = RT.splitWarn(warnings, hidden);
    function fail(msg) { if (!headless) alert(msg, "Rebuild Comp"); return RT.stringify({ ok: false, error: msg }); }

    if (!app.project) app.newProject();
    var inFile = args["in"] ? new File(args["in"]) : File.openDialog("Choose a comp JSON to rebuild", "JSON:*.json");
    if (!inFile) return RT.stringify({ ok: false, error: "cancelled" });

    var doc;
    try { doc = RT.readJSON(inFile); } catch (e) { return fail(e.message); }
    if (doc.format !== RT.FORMAT) return fail("Not an AE round-trip export: " + inFile.fsName);

    var defs = {};
    for (var i = 0; i < doc.comps.length; i++) defs[doc.comps[i].id] = doc.comps[i];
    if (!defs[doc.root]) return fail("Root comp " + doc.root + " is missing from the JSON.");

    var feet = RT.makeFootageResolver(doc, warn);
    var built = {}, building = {}, deferred = [], seenCompIds = {}, folder;

    function compFor(id) { return built[id] || null; }

    function buildComp(id) {
        if (built[id]) return built[id];
        var d = defs[id];
        if (!d) throw new Error("comp " + id + " is referenced but not in the JSON");
        if (building[id]) throw new Error("precomp cycle at " + d.name);
        building[id] = true;

        // Children first.
        for (var i = 0; i < d.layers.length; i++) {
            var s = d.layers[i].source;
            if (s && s.type === "comp") buildComp(s.comp);
        }

        var comp = app.project.items.addComp(d.name + " (rebuilt)", d.width, d.height, d.pixelAspect || 1, d.duration, d.frameRate);
        comp.parentFolder = folder;
        RT.ensureId(comp, "C", seenCompIds);
        var skip = { width: 1, height: 1, pixelAspect: 1, duration: 1, frameRate: 1 };
        for (var a = 0; a < RT.COMP_ATTRS.length; a++) {
            var an = RT.COMP_ATTRS[a];
            if (!skip[an] && RT.has(d, an)) RT.setCompAttr(comp, an, d[an], warn);
        }
        if (d.markers) { try { RT.applyLeaf(comp.markerProperty, d.markers, warn); } catch (e) { warn(comp.name + " markers: " + e.message); } }

        // Create bottom-up so each new layer lands on top and the final order matches the JSON.
        var created = [];
        for (var j = d.layers.length - 1; j >= 0; j--) {
            var ld = d.layers[j];
            try { created[j] = RT.createLayer(comp, ld, { compFor: compFor, footageFor: feet.item, footageDef: feet.def }); }
            catch (e) { warn(comp.name + ": layer '" + ld.name + "': " + e.message); created[j] = null; }
        }
        function lookup(lid) { return RT.findLayerById(comp, lid); }
        function eachLayer(fn) { for (var k = 0; k < d.layers.length; k++) if (created[k]) fn(created[k], d.layers[k]); }
        function attrs(list) {
            return function (L, ld) {
                for (var n = 0; n < list.length; n++) if (list[n] !== "locked" && RT.has(ld, list[n])) RT.setLayerAttr(L, list[n], ld[list[n]], lookup, warn);
            };
        }
        eachLayer(attrs(RT.ATTR_ORDER_EARLY));
        eachLayer(attrs(RT.ATTR_ORDER_LINKS));
        eachLayer(function (L, ld) { RT.buildProps(L, ld.props || [], deferred, warn); });
        eachLayer(attrs(RT.ATTR_ORDER_LATE));
        built[id] = comp;
        note("Built '" + comp.name + "' (" + d.layers.length + " layers)");
        return comp;
    }

    var root;
    app.beginUndoGroup("Rebuild Comp from JSON");
    try {
        folder = app.project.items.addFolder("Rebuilt - " + defs[doc.root].name);
        root = buildComp(doc.root);
        RT.runDeferredExprs(deferred, warn);
        // Lock last, after expressions are in.
        for (var cid in built) {
            if (!RT.has(built, cid)) continue;
            var d = defs[cid], comp = built[cid];
            for (var k = 0; k < d.layers.length; k++) {
                if (!d.layers[k].locked) continue;
                var L = RT.findLayerById(comp, d.layers[k].id);
                if (L) L.locked = true;
            }
        }
        try { root.openInViewer(); } catch (e2) {}
    } catch (err) {
        app.endUndoGroup();
        return fail("Rebuild failed: " + err.message + " (line " + err.line + ")");
    }
    app.endUndoGroup();

    var report = "Rebuild Comp — " + new Date().toString() + "\nJSON: " + inFile.fsName + "\n\n  " + log.join("\n  ") +
        (warnings.length ? "\n\nWarnings:\n  " + warnings.join("\n  ") : "") +
        (hidden.length ? "\n\nSkipped " + hidden.length + " hidden propert" + (hidden.length > 1 ? "ies" : "y") + " (AE does not allow setting them; no visible effect):\n  " + hidden.join("\n  ") : "") + "\n";
    var logPath = args.log || inFile.fsName.replace(/\.json$/i, "") + ".rebuild-log.txt";
    try { RT.writeText(logPath, report); } catch (e3) {}
    if (!headless) alert(report.length > 1500 ? report.substr(0, 1500) + "\n…\n(full log: " + logPath + ")" : report, "Rebuild Comp");
    var createdIds = [];
    for (var bid in built) if (RT.has(built, bid)) createdIds.push(built[bid].id);
    return RT.stringify({ ok: true, newComp: root.name, newCompId: root.id, createdCompIds: createdIds, folderId: folder.id, built: log, warnings: warnings, hiddenSkipped: hidden.length, log: logPath });
})();
