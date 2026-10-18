// MCP helper: fonts used by text layers; replace a font across comps.
// RT_ARGS = { op: "list"|"replace", compId?, compIds?, from?, to?, dryRun? }
(function () {
    #include "../lib/rt_core.jsxinc"
    var args = RT.takeArgs() || {};
    function fail(msg) { return RT.stringify({ ok: false, error: msg }); }
    if (!app.project) return fail("no project is open");

    function comps() {
        var out = [], i;
        if (args.compId) { var c = RT.findItemById(Number(args.compId)); if (!(c instanceof CompItem)) return fail("comp " + args.compId + " not found"); return [c]; }
        if (args.compIds && args.compIds.length) { for (i = 0; i < args.compIds.length; i++) { var c2 = RT.findItemById(Number(args.compIds[i])); if (c2 instanceof CompItem) out.push(c2); } return out; }
        for (i = 1; i <= app.project.numItems; i++) if (app.project.item(i) instanceof CompItem) out.push(app.project.item(i));
        return out;
    }
    function textDocs(layer) {
        // [{doc, keyIndex|null}] for the Source Text property
        var out = [], p = null;
        try { p = layer.property("ADBE Text Properties").property("ADBE Text Document"); } catch (e) { return out; }
        if (!p) return out;
        if (p.numKeys > 0) { for (var k = 1; k <= p.numKeys; k++) out.push({ prop: p, key: k, doc: p.keyValue(k) }); }
        else out.push({ prop: p, key: null, doc: p.value });
        return out;
    }
    var list = comps(); if (typeof list === "string") return list;

    if (args.op === "list") {
        var fonts = {}, count = 0;
        for (var i = 0; i < list.length; i++) {
            var c = list[i];
            for (var j = 1; j <= c.numLayers; j++) {
                var L = c.layer(j); if (!(L instanceof TextLayer)) continue;
                var docs = textDocs(L);
                for (var d = 0; d < docs.length; d++) {
                    var td = docs[d].doc, fnm = "", fam = "", sty = "";
                    try { fnm = td.font; } catch (e1) {} try { fam = td.fontFamily; } catch (e2) {} try { sty = td.fontStyle; } catch (e3) {}
                    if (!fonts[fnm]) fonts[fnm] = { font: fnm, family: fam, style: sty, uses: [] };
                    var text = ""; try { text = String(td.text).substr(0, 40); } catch (e4) {}
                    fonts[fnm].uses.push({ compId: c.id, comp: c.name, layerIndex: L.index, layer: L.name, keyframe: docs[d].key, text: text });
                    count++;
                }
            }
        }
        var arr = []; for (var k in fonts) if (RT.has(fonts, k)) arr.push(fonts[k]);
        var missing = [];
        try { var sf = app.fonts; if (sf && sf.missingOrSubstitutedFonts) { var ms = sf.missingOrSubstitutedFonts; for (var m = 0; m < ms.length; m++) missing.push(ms[m].postScriptName || ms[m].familyName); } } catch (e5) {}
        return RT.stringify({ ok: true, comps: list.length, textLayers: count, fonts: arr, missingOrSubstituted: missing });
    }

    if (args.op === "replace") {
        if (!args.from || !args.to) return fail("from and to are required (PostScript names, e.g. 'FuturaPT-Book')");
        var changes = [], failed = [], suppressed = false;
        if (!args.dryRun) { app.beginUndoGroup("Replace font " + args.from + " -> " + args.to); try { app.beginSuppressDialogs(); suppressed = true; } catch (e0) {} }
        for (var ci = 0; ci < list.length; ci++) {
            var cc = list[ci];
            for (var lj = 1; lj <= cc.numLayers; lj++) {
                var TL = cc.layer(lj); if (!(TL instanceof TextLayer)) continue;
                var ds = textDocs(TL);
                for (var di = 0; di < ds.length; di++) {
                    var doc = ds[di].doc, cur = ""; try { cur = doc.font; } catch (e6) {}
                    if (cur !== args.from) continue;
                    var rec = { compId: cc.id, comp: cc.name, layer: TL.name, layerIndex: TL.index, keyframe: ds[di].key, from: cur, to: args.to };
                    if (args.dryRun) { changes.push(rec); continue; }
                    try {
                        doc.font = args.to;
                        if (ds[di].key) ds[di].prop.setValueAtKey(ds[di].key, doc); else ds[di].prop.setValue(doc);
                        var after = ds[di].key ? ds[di].prop.keyValue(ds[di].key).font : ds[di].prop.value.font;
                        rec.result = after;
                        if (after !== args.to) { rec.warning = "AE substituted '" + after + "' (font not installed?)"; failed.push(rec); } else changes.push(rec);
                    } catch (e7) { rec.error = String(e7.message || e7); failed.push(rec); }
                }
            }
        }
        if (!args.dryRun) { if (suppressed) { try { app.endSuppressDialogs(false); } catch (e8) {} } app.endUndoGroup(); }
        return RT.stringify({ ok: true, dryRun: !!args.dryRun, changed: changes.length, changes: changes, failed: failed });
    }
    return fail("unknown op " + args.op);
})();
