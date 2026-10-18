// Apply Changes.jsx — patches an edited export back into After Effects.
//
// 1. Diffs the edited JSON against the baseline written at export time ("<name>.rtbase.json");
//    without a baseline it diffs against the comp as it is now.
// 2. Duplicates the root comp as a new version ("<name> v2", "v3", ...). Nested precomps are
//    duplicated (and swapped in) only when they, or a precomp inside them, have changes.
// 3. Sets only the properties that changed, finding layers by their [rtid:...] comment tag.
//
// Headless use: $.global.RT_ARGS = { in: "/path/file.json", base: "/optional/base.json", log: "/optional/log.txt" }

(function () {
    #include "lib/rt_core.jsxinc"

    var args = RT.takeArgs();
    var headless = !!args;
    args = args || {};
    var log = [], warnings = [];
    function note(s) { log.push(s); }
    var hidden = [];
    var warn = RT.splitWarn(warnings, hidden);
    function fail(msg) { if (!headless) alert(msg, "Apply Changes"); return RT.stringify({ ok: false, error: msg }); }

    if (!app.project) return fail("No project open.");

    var inFile = args["in"] ? new File(args["in"]) : File.openDialog("Choose the edited comp JSON", "JSON:*.json");
    if (!inFile) return RT.stringify({ ok: false, error: "cancelled" });

    var edited, base = null;
    try { edited = RT.readJSON(inFile); } catch (e) { return fail(e.message); }
    if (edited.format !== RT.FORMAT) return fail("Not an AE round-trip export: " + inFile.fsName);
    var basePath = args.base || RT.basePathFor(inFile);
    if (new File(basePath).exists) {
        try { base = RT.readJSON(basePath); } catch (e) { return fail("Baseline unreadable: " + e.message); }
    }

    function byId(list) { var m = {}; for (var i = 0; i < list.length; i++) if (list[i].id) m[list[i].id] = list[i]; return m; }

    // ---- locate the source comps ----------------------------------------------------------
    var compsE = byId(edited.comps);
    var rootE = compsE[edited.root];
    if (!rootE) return fail("Root comp " + edited.root + " is missing from the JSON.");

    function locateComp(def) {
        var c = def.aeId ? RT.findItemById(def.aeId) : null;
        if (c instanceof CompItem && RT.readTag(c.comment) === def.id) return c;
        for (var i = 1; i <= app.project.numItems; i++) {
            var it = app.project.item(i);
            if (it instanceof CompItem && RT.readTag(it.comment) === def.id) return it;
        }
        return null;
    }

    var srcRoot = locateComp(base ? byId(base.comps)[base.root] || rootE : rootE);
    if (!srcRoot) return fail("Cannot find the source comp '" + rootE.name + "' (" + edited.root + ") in this project.");

    if (!base) {
        note("No baseline file found — diffing against the comp's current state.");
        app.beginUndoGroup("Apply Changes (snapshot)");
        base = RT.exportTree(srcRoot);
        app.endUndoGroup();
    }
    var compsB = byId(base.comps);
    var srcById = {};
    for (var ci = 0; ci < base.comps.length; ci++) {
        var sc = locateComp(base.comps[ci]);
        if (sc) srcById[base.comps[ci].id] = sc;
    }

    // ---- diff -----------------------------------------------------------------------------
    var ATTR_NULLABLE = { parent: true, trackMatte: true, comment: true };

    function attrVal(d, k) {
        if (RT.has(d, k)) return d[k];
        return k === "comment" ? "" : (ATTR_NULLABLE[k] ? null : undefined);
    }

    function diffLayerAttrs(e, b) {
        var out = [];
        for (var i = 0; i < RT.LAYER_ATTRS.length; i++) {
            var k = RT.LAYER_ATTRS[i];
            var ev = attrVal(e, k), bv = attrVal(b, k);
            if (ev === undefined) continue; // key deleted from JSON: leave as is
            if (!RT.equal(ev, bv)) out.push(k);
        }
        return out;
    }

    var GROUP_ATTRS = ["name", "enabled", "maskMode", "inverted", "rotoBezier", "maskMotionBlur", "maskFeatherFalloff", "color", "locked"];

    function keysSameTiming(ke, kb) {
        if (!ke || !kb || ke.length !== kb.length) return false;
        for (var i = 0; i < ke.length; i++) if (!RT.equal(ke[i].t, kb[i].t)) return false;
        return true;
    }

    // Returns a list of operations for one layer's property tree.
    function diffProps(e, b) {
        var fE = RT.flatten(e.props || []), fB = RT.flatten(b.props || []);
        var mB = {}, mE = {}, ops = [], i;
        for (i = 0; i < fB.length; i++) mB[fB[i].key] = fB[i];
        for (i = 0; i < fE.length; i++) mE[fE[i].key] = fE[i];

        for (i = 0; i < fE.length; i++) {
            var fe = fE[i], fb = mB[fe.key], ne = fe.node;
            if (!fb) { ops.push({ op: "add", f: fe }); continue; }
            var nb = fb.node;
            if (fe.isGroup) {
                var ga = {};
                var any = false;
                for (var g = 0; g < GROUP_ATTRS.length; g++) {
                    var a = GROUP_ATTRS[g];
                    if (RT.has(ne, a) && !RT.equal(ne[a], nb[a])) { ga[a] = ne[a]; any = true; }
                }
                if (any) ops.push({ op: "group", f: fe, attrs: ga });
                continue;
            }
            if (!RT.equal(ne.separated, nb.separated)) ops.push({ op: "separate", f: fe });
            var eKeys = ne.keys && ne.keys.length ? ne.keys : null, bKeys = nb.keys && nb.keys.length ? nb.keys : null;
            if (eKeys) {
                if (keysSameTiming(eKeys, bKeys)) {
                    for (var k = 0; k < eKeys.length; k++) {
                        var kc = { t: eKeys[k].t }, changed = false;
                        if (!RT.equal(eKeys[k].v, bKeys[k].v)) { kc.v = eKeys[k].v; changed = true; }
                        for (var ka = 0; ka < RT.KEY_ATTRS.length; ka++) {
                            var an = RT.KEY_ATTRS[ka];
                            if (RT.has(eKeys[k], an) && !RT.equal(eKeys[k][an], bKeys[k][an])) { kc[an] = eKeys[k][an]; changed = true; }
                        }
                        if (changed) {
                            // easing / tangents are set in pairs
                            // setting ease flips keys to bezier, so re-send the interpolation type with it
                            if (kc.inEase || kc.outEase) { kc.inEase = eKeys[k].inEase; kc.outEase = eKeys[k].outEase; kc.inInterp = eKeys[k].inInterp; kc.outInterp = eKeys[k].outInterp; }
                            if (kc.inTangent || kc.outTangent) { kc.inTangent = eKeys[k].inTangent; kc.outTangent = eKeys[k].outTangent; kc.spatialAutoBezier = eKeys[k].spatialAutoBezier; }
                            if (kc.inInterp || kc.outInterp) { kc.inInterp = eKeys[k].inInterp; kc.outInterp = eKeys[k].outInterp; }
                            ops.push({ op: "key", f: fe, k: k + 1, kc: kc, before: bKeys[k] });
                        }
                    }
                } else ops.push({ op: "keys", f: fe });
            } else if (RT.has(ne, "value") && (bKeys || !RT.equal(ne.value, nb.value))) {
                ops.push({ op: "value", f: fe, before: nb.value });
            }
            if ((ne.expr || "") !== (nb.expr || "") || (ne.expr && RT.has(ne, "exprOn") && ne.exprOn !== nb.exprOn)) {
                ops.push({ op: "expr", f: fe });
            }
        }

        // Removed indexed children (effects, masks, shape groups...) — deepest / highest index first.
        var removed = [];
        for (i = 0; i < fB.length; i++) {
            var rb = fB[i];
            if (mE[rb.key]) continue;
            var parentGone = false;
            for (var r = 0; r < removed.length; r++) if (rb.key.indexOf(removed[r].key + "/") === 0) parentGone = true;
            if (parentGone) continue;
            if (RT.has(rb.node, "idx")) removed.push(rb);
            else if (!rb.isGroup && (rb.node.keys || rb.node.expr)) warn(b.name + " / " + rb.key + ": removed from JSON — left unchanged");
        }
        removed.sort(function (x, y) {
            if (x.segs.length !== y.segs.length) return y.segs.length - x.segs.length;
            return y.segs[y.segs.length - 1].idx - x.segs[x.segs.length - 1].idx;
        });
        for (i = 0; i < removed.length; i++) ops.push({ op: "remove", f: removed[i] });
        return ops;
    }

    function layerOrder(def) { var r = []; for (var i = 0; i < def.layers.length; i++) r.push(def.layers[i].id); return r; }

    var plans = {}, changedComps = {};
    for (var cid in compsE) {
        if (!RT.has(compsE, cid)) continue;
        var cE = compsE[cid], cB = compsB[cid];
        if (!cB) { warn("Comp '" + cE.name + "' (" + cid + ") is new in the JSON — use Rebuild Comp for new comps; skipped."); continue; }
        var plan = { settings: [], markers: false, layers: [], added: [], removed: [], reorder: false };
        for (var a = 0; a < RT.COMP_ATTRS.length; a++) {
            var an = RT.COMP_ATTRS[a];
            if (RT.has(cE, an) && !RT.equal(cE[an], cB[an])) plan.settings.push(an);
        }
        if (!RT.equal(cE.markers || null, cB.markers || null)) plan.markers = true;
        var lB = byId(cB.layers), lE = byId(cE.layers);
        for (var li = 0; li < cE.layers.length; li++) {
            var le = cE.layers[li], lb = le.id ? lB[le.id] : null;
            if (!lb) { plan.added.push(le); continue; }
            var attrs = diffLayerAttrs(le, lb);
            var srcChanged = !RT.equal(le.source || null, lb.source || null);
            var ops = diffProps(le, lb);
            if (attrs.length || ops.length || srcChanged) plan.layers.push({ def: le, before: lb, attrs: attrs, ops: ops, source: srcChanged });
        }
        for (var lj = 0; lj < cB.layers.length; lj++) if (!lE[cB.layers[lj].id]) plan.removed.push(cB.layers[lj]);
        var oE = layerOrder(cE), oB = [];
        for (var lk = 0; lk < cB.layers.length; lk++) if (lE[cB.layers[lk].id]) oB.push(cB.layers[lk].id);
        var oEexisting = [];
        for (var lm = 0; lm < oE.length; lm++) if (lB[oE[lm]]) oEexisting.push(oE[lm]);
        plan.reorder = plan.added.length > 0 || !RT.equal(oEexisting, oB);
        plans[cid] = plan;
        if (plan.settings.length || plan.markers || plan.layers.length || plan.added.length || plan.removed.length || plan.reorder) changedComps[cid] = true;
    }

    if (!RT.keys(changedComps).length) {
        var msg0 = "No changes found between the JSON and its baseline — nothing to patch.";
        if (!headless) alert(msg0, "Apply Changes");
        return RT.stringify({ ok: true, changed: 0, message: msg0, warnings: warnings });
    }

    // ---- which comps need a new version ---------------------------------------------------
    var childrenOf = {};
    for (var pc in compsE) {
        if (!RT.has(compsE, pc)) continue;
        childrenOf[pc] = [];
        for (var x = 0; x < compsE[pc].layers.length; x++) {
            var s = compsE[pc].layers[x].source;
            if (s && s.type === "comp") childrenOf[pc].push(s.comp);
        }
    }
    var needMemo = {};
    function needsDup(id, stack) {
        if (RT.has(needMemo, id)) return needMemo[id];
        stack = stack || {};
        if (stack[id]) return false;
        stack[id] = true;
        var r = !!changedComps[id];
        var kids = childrenOf[id] || [];
        for (var i = 0; i < kids.length; i++) if (needsDup(kids[i], stack)) r = true;
        needMemo[id] = r;
        return r;
    }

    var feet = RT.makeFootageResolver(edited, warn);
    var dupById = {}, deferred = [], relock = [];

    function dupComp(id) {
        if (dupById[id]) return dupById[id];
        var src = srcById[id];
        if (!src) throw new Error("source comp " + id + " not found in project");
        var nc = src.duplicate();
        nc.name = RT.nextVersionName(src.name);
        dupById[id] = nc;
        note("Duplicated '" + src.name + "' → '" + nc.name + "'");
        for (var i = 1; i <= nc.numLayers; i++) {
            var L = nc.layer(i), s = null;
            try { s = L.source; } catch (e) {}
            if (!(s instanceof CompItem)) continue;
            var cid = RT.readTag(s.comment);
            if (cid && compsE[cid] && needsDup(cid)) {
                var child = dupComp(cid);
                var wasLocked = L.locked;
                if (wasLocked) L.locked = false;
                L.replaceSource(child, false);
                if (wasLocked) L.locked = true;
            }
        }
        return nc;
    }

    function compFor(id) { return dupById[id] || srcById[id] || null; }

    function fmt(v) {
        var s = RT.stringify(v).replace(/\s+/g, " ");
        return s.length > 120 ? s.substr(0, 117) + "..." : s;
    }

    function unlock(L) { if (L.locked) { L.locked = false; relock.push({ layer: L, value: true }); } }

    function patchLayer(comp, item) {
        var d = item.def, L = RT.findLayerById(comp, d.id);
        var where = comp.name + " / " + d.name;
        if (!L) { warn(where + ": layer " + d.id + " not found — skipped"); return; }
        unlock(L);
        function lookup(id) { return RT.findLayerById(comp, id); }

        if (item.source) {
            try {
                var ns = null;
                if (d.source && d.source.type === "comp") ns = compFor(d.source.comp);
                else if (d.source && d.source.footage) ns = feet.item(d.source.footage);
                if (ns) { L.replaceSource(ns, false); note(where + ": source → " + ns.name); }
                else warn(where + ": new source not found");
            } catch (e) { warn(where + " source: " + e.message); }
        }

        var order = RT.ATTR_ORDER_EARLY.concat(RT.ATTR_ORDER_LINKS, RT.ATTR_ORDER_LATE);
        for (var o = 0; o < order.length; o++) {
            var k = order[o];
            if (RT.indexOf(item.attrs, k) < 0 || k === "locked") continue;
            RT.setLayerAttr(L, k, attrVal(d, k), lookup, warn);
            note(where + ": " + k + " " + fmt(attrVal(item.before, k)) + " → " + fmt(attrVal(d, k)));
        }

        var alias = {};
        for (var i = 0; i < item.ops.length; i++) {
            var op = item.ops[i], f = op.f, n = f.node, label = where + " / " + f.key.replace(/ADBE /g, "");
            var p = null;
            try { p = RT.resolve(L, f.segs, op.op === "add", alias); } catch (e) { warn(label + ": " + e.message); continue; }
            if (!p) { warn(label + ": property not found"); continue; }
            try {
                switch (op.op) {
                    case "add":
                        if (f.isGroup) RT.applyGroupAttrs(p, n, warn);
                        else {
                            if (!RT.applyLeaf(p, n, warn)) break;
                            if (n.expr) deferred.push({ layer: L, segs: f.segs, node: n, alias: alias });
                        }
                        note(label + ": added/set");
                        break;
                    case "group":
                        RT.applyGroupAttrs(p, op.attrs, warn);
                        note(label + ": " + fmt(op.attrs));
                        break;
                    case "separate":
                        p.dimensionsSeparated = !!n.separated;
                        note(label + ": separate dimensions → " + !!n.separated);
                        break;
                    case "value":
                        if (!RT.applyLeaf(p, { mn: n.mn, value: n.value }, warn)) break;
                        note(label + ": value " + fmt(op.before) + " → " + fmt(n.value));
                        break;
                    case "keys":
                        RT.setAllKeys(p, n.keys, warn);
                        note(label + ": replaced all keyframes (" + n.keys.length + ")");
                        break;
                    case "key":
                        var ki = p.nearestKeyIndex(op.kc.t);
                        if (RT.has(op.kc, "v")) {
                            var b = (p.propertyValueType === PropertyValueType.TEXT_DOCUMENT) ? p.keyValue(ki) : null;
                            p.setValueAtKey(ki, RT.deserValue(p, op.kc.v, b));
                        }
                        RT.applyKeyAttrs(p, ki, op.kc, warn);
                        var parts = [];
                        for (var kk in op.kc) {
                            if (!RT.has(op.kc, kk) || kk === "t") continue;
                            parts.push((kk === "v" ? "value" : kk) + " " + fmt(op.before[kk]) + " → " + fmt(op.kc[kk]));
                        }
                        note(label + ": key " + ki + " @" + RT.round(op.kc.t) + "s: " + parts.join("; "));
                        break;
                    case "expr":
                        deferred.push({ layer: L, segs: f.segs, node: n, alias: alias });
                        note(label + ": expression " + (n.expr ? "set" : "cleared"));
                        break;
                    case "remove":
                        p.remove();
                        note(label + ": removed");
                        break;
                }
            } catch (e) { warn(label + " (" + op.op + "): " + e.message); }
        }
        if (RT.indexOf(item.attrs, "locked") >= 0) {
            for (var r = relock.length - 1; r >= 0; r--) if (relock[r].layer === L) relock.splice(r, 1);
            relock.push({ layer: L, value: d.locked });
            note(where + ": locked → " + d.locked);
        }
    }

    function addLayer(comp, d) {
        var L;
        try {
            L = RT.createLayer(comp, d, { compFor: compFor, footageFor: feet.item, footageDef: feet.def });
        } catch (e) { warn(comp.name + ": could not add layer '" + d.name + "': " + e.message); return; }
        function lookup(id) { return RT.findLayerById(comp, id); }
        var i;
        for (i = 0; i < RT.ATTR_ORDER_EARLY.length; i++) { var k = RT.ATTR_ORDER_EARLY[i]; if (RT.has(d, k)) RT.setLayerAttr(L, k, d[k], lookup, warn); }
        for (i = 0; i < RT.ATTR_ORDER_LINKS.length; i++) { var kl = RT.ATTR_ORDER_LINKS[i]; if (RT.has(d, kl)) RT.setLayerAttr(L, kl, d[kl], lookup, warn); }
        RT.buildProps(L, d.props || [], deferred, warn);
        for (i = 0; i < RT.ATTR_ORDER_LATE.length; i++) { var k2 = RT.ATTR_ORDER_LATE[i]; if (k2 !== "locked" && RT.has(d, k2)) RT.setLayerAttr(L, k2, d[k2], lookup, warn); }
        if (d.locked) relock.push({ layer: L, value: true });
        if (!d.id) d.id = RT.readTag(L.comment);
        note(comp.name + ": added layer '" + d.name + "' (" + d.type + ")");
    }

    function patchComp(id, comp) {
        var plan = plans[id], cE = compsE[id], i;
        for (i = 0; i < plan.settings.length; i++) {
            RT.setCompAttr(comp, plan.settings[i], cE[plan.settings[i]], warn);
            note(comp.name + ": " + plan.settings[i] + " → " + fmt(cE[plan.settings[i]]));
        }
        if (plan.markers) {
            try { RT.applyLeaf(comp.markerProperty, cE.markers || { keys: [] }, warn); if (!cE.markers) RT.removeAllKeys(comp.markerProperty); note(comp.name + ": comp markers updated"); }
            catch (e) { warn(comp.name + " markers: " + e.message); }
        }
        for (i = 0; i < plan.removed.length; i++) {
            var gone = RT.findLayerById(comp, plan.removed[i].id);
            if (gone) { gone.locked = false; gone.remove(); note(comp.name + ": removed layer '" + plan.removed[i].name + "'"); }
        }
        // Added layers first so parent / matte references to them resolve.
        for (i = 0; i < plan.added.length; i++) addLayer(comp, plan.added[i]);
        for (i = 0; i < plan.layers.length; i++) patchLayer(comp, plan.layers[i]);
        if (plan.reorder) {
            var prev = null, moved = false;
            for (i = 0; i < cE.layers.length; i++) {
                var L = cE.layers[i].id ? RT.findLayerById(comp, cE.layers[i].id) : null;
                if (!L) continue;
                if (prev && L.index !== prev.index + 1) {
                    var lk = L.locked; if (lk) L.locked = false;
                    L.moveAfter(prev); moved = true;
                    if (lk) L.locked = true;
                } else if (!prev && L.index !== 1) {
                    var lk1 = L.locked; if (lk1) L.locked = false;
                    L.moveToBeginning(); moved = true;
                    if (lk1) L.locked = true;
                }
                prev = L;
            }
            if (moved) note(comp.name + ": layer order updated");
        }
    }

    // ---- run ------------------------------------------------------------------------------
    var newRoot;
    app.beginUndoGroup("Apply Changes from JSON");
    try {
        newRoot = dupComp(edited.root);
        for (var id in dupById) {
            if (RT.has(dupById, id) && plans[id] && changedComps[id]) patchComp(id, dupById[id]);
        }
        RT.runDeferredExprs(deferred, warn);
        for (var rl = 0; rl < relock.length; rl++) {
            try { relock[rl].layer.locked = relock[rl].value; } catch (e1) {}
        }
        try { newRoot.openInViewer(); } catch (e2) {}
    } catch (err) {
        app.endUndoGroup();
        return fail("Apply failed: " + err.message + " (line " + err.line + ")");
    }
    app.endUndoGroup();

    var report = "Apply Changes — " + new Date().toString() + "\nJSON: " + inFile.fsName + "\nNew version: " + newRoot.name +
        "\n\nChanges:\n  " + log.join("\n  ") + (warnings.length ? "\n\nWarnings:\n  " + warnings.join("\n  ") : "") +
        (hidden.length ? "\n\nSkipped " + hidden.length + " hidden propert" + (hidden.length > 1 ? "ies" : "y") + " (AE does not allow setting them; no visible effect):\n  " + hidden.join("\n  ") : "") + "\n";
    var logPath = args.log || inFile.fsName.replace(/\.json$/i, "") + ".apply-log.txt";
    try { RT.writeText(logPath, report); } catch (e3) {}

    if (!headless) alert(report.length > 1500 ? report.substr(0, 1500) + "\n…\n(full log: " + logPath + ")" : report, "Apply Changes");
    var createdIds = [];
    for (var cid2 in dupById) if (RT.has(dupById, cid2)) createdIds.push(dupById[cid2].id);
    return RT.stringify({ ok: true, newComp: newRoot.name, newCompId: newRoot.id, createdCompIds: createdIds, changes: log, warnings: warnings, hiddenSkipped: hidden.length, log: logPath });
})();
