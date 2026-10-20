// MCP helper: apply an animation preset (.ffx) to a layer; lint an expression by letting AE evaluate it.
// RT_ARGS = { op: "apply", compId, layer (index | name | "L-xxxx"), preset (absolute .ffx path), dryRun? }
//         | { op: "lint", expression, compId?, layer?, path? (matchName path, default Position), apply?, dimensions? }
(function () {
    #include "../lib/rt_core.jsxinc"
    var args = RT.takeArgs() || {};
    function fail(msg) { return RT.stringify({ ok: false, error: msg }); }
    if (!app.project) return fail("no project is open");

    function findComp(id) { var c = RT.findItemById(Number(id)); if (!(c instanceof CompItem)) return null; return c; }
    function findLayer(comp, ref) {
        if (ref === null || ref === undefined || ref === "") return null;
        if (typeof ref === "number" || /^\d+$/.test(String(ref))) { var i = Number(ref); return (i >= 1 && i <= comp.numLayers) ? comp.layer(i) : null; }
        if (/^L-/.test(String(ref))) { try { var byId = RT.findLayerById(comp, String(ref)); if (byId) return byId; } catch (e) {} }
        var hits = [];
        for (var j = 1; j <= comp.numLayers; j++) if (comp.layer(j).name === String(ref)) hits.push(comp.layer(j));
        if (hits.length === 1) return hits[0];
        if (hits.length > 1) throw new Error("'" + ref + "' matches " + hits.length + " layers; use the layer index or L-id");
        return null;
    }
    function propByPath(layer, path) {
        var segs = RT.isArray(path) ? path : String(path).split("/"), p = layer;
        for (var i = 0; i < segs.length; i++) { var nxt = null; try { nxt = p.property(segs[i]); } catch (e) {} if (!nxt) return null; p = nxt; }
        return p;
    }
    function effectsOf(layer) {
        var out = [], fx = null; try { fx = layer.property("ADBE Effect Parade"); } catch (e) {}
        if (!fx) return out;
        for (var i = 1; i <= fx.numProperties; i++) { var e2 = fx.property(i); out.push({ index: i, name: e2.name, matchName: e2.matchName }); }
        return out;
    }
    function animatedOf(layer) {
        var out = [];
        function walk(group, prefix) {
            for (var i = 1; i <= group.numProperties; i++) {
                var p = group.property(i), path = prefix ? prefix + "/" + p.matchName : p.matchName;
                if (p.propertyType === PropertyType.PROPERTY) {
                    var rec = null;
                    try { if (p.numKeys > 0) rec = { path: path, name: p.name, keys: p.numKeys }; } catch (e) {}
                    try { if (p.expressionEnabled && p.expression) { rec = rec || { path: path, name: p.name }; rec.expression = String(p.expression).substr(0, 120); } } catch (e2) {}
                    if (rec) out.push(rec);
                } else { try { walk(p, path); } catch (e3) {} }
            }
        }
        try { walk(layer, ""); } catch (e4) {}
        return out;
    }

    if (args.op === "apply") {
        var comp = findComp(args.compId); if (!comp) return fail("comp " + args.compId + " not found");
        var layer; try { layer = findLayer(comp, args.layer); } catch (e5) { return fail(e5.message); }
        if (!layer) return fail("layer '" + args.layer + "' not found in '" + comp.name + "'");
        var f = new File(String(args.preset || ""));
        if (!f.exists) return fail("preset not found: " + f.fsName);
        var before = effectsOf(layer), beforeAnim = animatedOf(layer);
        if (args.dryRun) return RT.stringify({ ok: true, dryRun: true, plan: { action: "applyPreset", comp: comp.name, compId: comp.id, layer: layer.name, layerIndex: layer.index, preset: f.fsName }, effectsBefore: before.length });
        app.beginUndoGroup("Claude: apply preset");
        var suppressed = false; try { app.beginSuppressDialogs(); suppressed = true; } catch (e6) {}
        var err = null;
        try { layer.applyPreset(f); } catch (e7) { err = String(e7.message || e7); }
        if (suppressed) { try { app.endSuppressDialogs(false); } catch (e8) {} }
        app.endUndoGroup();
        if (err) return fail("applyPreset failed: " + err);
        var after = effectsOf(layer), afterAnim = animatedOf(layer), added = [], i, j, seen = {};
        for (i = 0; i < before.length; i++) seen[before[i].matchName + "#" + before[i].index] = true;
        for (j = 0; j < after.length; j++) if (j >= before.length) added.push(after[j]);
        var newAnim = [], known = {};
        for (i = 0; i < beforeAnim.length; i++) known[beforeAnim[i].path] = true;
        for (j = 0; j < afterAnim.length; j++) if (!known[afterAnim[j].path]) newAnim.push(afterAnim[j]);
        return RT.stringify({ ok: true, comp: comp.name, compId: comp.id, layer: layer.name, layerIndex: layer.index, preset: f.fsName, effectsAdded: added, effects: after, animatedAdded: newAnim });
    }

    if (args.op === "lint") {
        var expr = String(args.expression === undefined ? "" : args.expression);
        var target = null, tcomp = null, tlayer = null, created = null, pathUsed = args.path || "ADBE Transform Group/ADBE Position";
        if (args.compId) {
            tcomp = findComp(args.compId); if (!tcomp) return fail("comp " + args.compId + " not found");
            try { tlayer = findLayer(tcomp, args.layer); } catch (e9) { return fail(e9.message); }
            if (!tlayer) return fail("layer '" + args.layer + "' not found in '" + tcomp.name + "'");
            target = propByPath(tlayer, pathUsed); if (!target) return fail("property '" + pathUsed + "' not found on layer '" + tlayer.name + "'");
            if (!target.canSetExpression) return fail("property '" + pathUsed + "' can't hold an expression");
        } else {
            // scratch comp + null, removed afterwards; nothing in the user's project is touched
            created = app.project.items.addComp("Claude expression lint", 1920, 1080, 1, 2, 30);
            tlayer = created.layers.addNull(2);
            var dims = Number(args.dimensions) || 2;
            pathUsed = dims === 1 ? "ADBE Transform Group/ADBE Opacity" : dims === 3 ? "ADBE Transform Group/ADBE Position" : "ADBE Transform Group/ADBE Position";
            if (dims === 3) tlayer.threeDLayer = true;
            target = propByPath(tlayer, pathUsed);
        }
        var previous = "", prevEnabled = false;
        try { previous = target.expression; prevEnabled = target.expressionEnabled; } catch (e10) {}
        var setErr = null;
        try { target.expression = expr; } catch (e11) { setErr = String(e11.message || e11); }
        var errText = ""; try { errText = String(target.expressionError || ""); } catch (e12) {}
        var enabled = false; try { enabled = target.expressionEnabled; } catch (e13) {}
        var value = null; try { value = RT.roundAll(target.valueAtTime(0, false)); } catch (e14) {}
        var ok = !setErr && !errText;
        var result = { ok: true, valid: ok, expression: expr, property: pathUsed, layer: tlayer ? tlayer.name : null, comp: tcomp ? tcomp.name : "(scratch comp)", valueAtStart: value };
        if (setErr) result.error = setErr;
        if (errText) {
            // AE's message: "Expression Disabled\nError at line N in property ‘X’ ... \rSyntaxError: ..." → keep the useful parts
            var lineM = /line (\d+)/.exec(errText), msgM = /\r([^\r\n]+)\s*$/.exec(errText.replace(/[\n\t▶]+/g, "\n").replace(/\n+$/, ""));
            result.error = errText;
            if (lineM) result.line = Number(lineM[1]);
            var tail = errText.split(/\r/); if (tail.length > 1) result.message = String(tail[tail.length - 1]).replace(/[\n\t▶]+/g, " ").replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "");
        }
        if (created) { try { created.remove(); } catch (e15) {} result.applied = false; }
        else if (args.apply && ok) { result.applied = true; }
        else { try { target.expression = previous; target.expressionEnabled = prevEnabled; } catch (e16) {} result.applied = false; result.restored = true; }
        return RT.stringify(result);
    }
    return fail("unknown op " + args.op);
})();
