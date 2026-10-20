// MCP helper: Essential Graphics controls and Motion Graphics Template (.mogrt) export.
// RT_ARGS = { op: "list", compId }
//         | { op: "add", compId, layer, path, name? }            (property path = matchNames joined by "/")
//         | { op: "name", compId, name }
//         | { op: "export", compId, folder, name?, overwrite? }  (AE writes <name>.mogrt INSIDE the folder it is given)
(function () {
    #include "../lib/rt_core.jsxinc"
    var args = RT.takeArgs() || {};
    function fail(msg) { return RT.stringify({ ok: false, error: msg }); }
    if (!app.project) return fail("no project is open");
    function findComp(id) { var c = RT.findItemById(Number(id)); return (c instanceof CompItem) ? c : null; }
    function findLayer(comp, ref) {
        if (ref === null || ref === undefined || ref === "") return null;
        if (typeof ref === "number" || /^\d+$/.test(String(ref))) { var i = Number(ref); return (i >= 1 && i <= comp.numLayers) ? comp.layer(i) : null; }
        if (/^L-/.test(String(ref))) { try { var byId = RT.findLayerById(comp, String(ref)); if (byId) return byId; } catch (e) {} }
        var hits = []; for (var j = 1; j <= comp.numLayers; j++) if (comp.layer(j).name === String(ref)) hits.push(comp.layer(j));
        if (hits.length > 1) throw new Error("'" + ref + "' matches " + hits.length + " layers; use the index or L-id");
        return hits[0] || null;
    }
    function propByPath(layer, path) { var segs = RT.isArray(path) ? path : String(path).split("/"), p = layer; for (var i = 0; i < segs.length; i++) { var nxt = null; try { nxt = p.property(segs[i]); } catch (e) {} if (!nxt) return null; p = nxt; } return p; }
    function controls(comp) {
        var out = [], n = 0; try { n = comp.motionGraphicsTemplateControllerCount; } catch (e) {}
        for (var i = 1; i <= n; i++) { var nm = null; try { nm = comp.getMotionGraphicsTemplateControllerName(i); } catch (e2) {} out.push({ index: i, name: nm }); }
        return out;
    }
    var comp = findComp(args.compId); if (!comp) return fail("comp " + args.compId + " not found");
    var tname = null; try { tname = comp.motionGraphicsTemplateName; } catch (e0) {}

    if (args.op === "list") return RT.stringify({ ok: true, comp: comp.name, compId: comp.id, templateName: tname, controls: controls(comp) });

    if (args.op === "name") {
        if (!args.name) return fail("name is required");
        try { comp.motionGraphicsTemplateName = String(args.name); } catch (e1) { return fail("could not set the template name: " + e1.message); }
        return RT.stringify({ ok: true, comp: comp.name, templateName: comp.motionGraphicsTemplateName });
    }

    if (args.op === "add") {
        var layer; try { layer = findLayer(comp, args.layer); } catch (e2) { return fail(e2.message); }
        if (!layer) return fail("layer '" + args.layer + "' not found in '" + comp.name + "'");
        var prop = propByPath(layer, args.path); if (!prop) return fail("property '" + args.path + "' not found on layer '" + layer.name + "'");
        var can = false; try { can = prop.canAddToMotionGraphicsTemplate(comp); } catch (e3) { return fail("canAddToMotionGraphicsTemplate: " + e3.message); }
        if (!can) return fail("'" + prop.name + "' can't be an Essential Graphics control (unsupported type, or already added)");
        var before = controls(comp).length, ok = false;
        try { ok = args.name ? prop.addToMotionGraphicsTemplateAs(comp, String(args.name)) : prop.addToMotionGraphicsTemplate(comp); } catch (e4) { return fail("addToMotionGraphicsTemplate: " + e4.message); }
        var after = controls(comp);
        return RT.stringify({ ok: true, added: ok && after.length > before, control: after.length > before ? after[after.length - 1] : null, controls: after });
    }

    if (args.op === "export") {
        if (!app.project.file) return fail("the project must be saved first (AE opens a Save As sheet otherwise): use ae_save_as, then retry");
        var folder = new Folder(String(args.folder || "")); if (!folder.exists) folder.create();
        if (!folder.exists) return fail("folder not found / not creatable: " + folder.fsName);
        var base = args.name ? String(args.name) : (tname || comp.name);
        try { if (tname !== base) comp.motionGraphicsTemplateName = base; } catch (e5) {}
        // AE treats the given path as a directory and writes "<templateName>.mogrt" inside it
        var target = new File(folder.fsName + "/" + base + ".mogrt");
        if (target.exists) { if (!args.overwrite) return fail("'" + target.fsName + "' already exists (overwrite: true replaces it)"); if (!target.remove()) return fail("could not delete the existing " + target.fsName); }
        var r = false, err = null;
        var suppressed = false; try { app.beginSuppressDialogs(); suppressed = true; } catch (e6) {}
        try { r = comp.exportAsMotionGraphicsTemplate(false, folder.fsName); } catch (e7) { err = String(e7.message || e7); }
        if (suppressed) { try { app.endSuppressDialogs(false); } catch (e8) {} }
        if (err) return fail("exportAsMotionGraphicsTemplate: " + err);
        var written = target.exists ? target : null;
        if (!written) { // AE sometimes nests a folder of the same name
            var nested = new File(folder.fsName + "/" + base + ".mogrt/" + base + ".mogrt"); if (nested.exists) written = nested;
        }
        if (!written) return fail("AE reported " + r + " but no .mogrt appeared in " + folder.fsName);
        // the comp reference can go stale after the export; re-find it for the summary
        var again = findComp(args.compId), summary = { ok: true, path: written.fsName };
        try { summary.bytes = written.length; } catch (e9) {}
        try { summary.comp = again ? again.name : comp.name; } catch (e10) {}
        try { summary.templateName = again ? again.motionGraphicsTemplateName : base; } catch (e11) { summary.templateName = base; }
        try { summary.controls = again ? controls(again) : []; } catch (e12) {}
        return RT.stringify(summary);
    }
    return fail("unknown op " + args.op);
})();
