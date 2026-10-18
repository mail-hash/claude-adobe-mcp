// MCP helper: run arbitrary ExtendScript with a helper library in scope.
// RT_ARGS = { code?: "...", file?: "/path.jsx" }
// Dialogs raised by the code are suppressed (app.beginSuppressDialogs); errors come back with line numbers.
//
// Helpers visible to the code (all local to this run; nothing is added to AE's engine or to prototypes):
//   log(...)                      collect output lines (returned as "output")
//   str(v)                        safe string of anything — use instead of "text" + value (this AE's + operator throws on objects)
//   findComp(name)                CompItem by exact name (error if missing/ambiguous)
//   findItem(nameOrPath)          any project item by name, or footage by file path
//   ensureFolder("A/B/C")         FolderItem chain, created as needed
//   ensureComp(name, w, h, dur, fps, folder?)   existing comp by name or a new one
//   addGroup(contents, matchName, name?)        addProperty + re-fetch (fresh reference); works for shape groups, fills, paths, effects
//   addGroupsInOrder(contents, [{mn, name}])    adds in list order; the first entry ends up on top; returns fresh references
//   refetch(group, nameOrIndex)                 fresh reference to a child after any structural change
//   easeKeys(prop, keys?, influence?, speed?)   bezier ease on all (or given) keys, correct dimension count for 1D/2D/3D/colour/spatial
//   setKeys(prop, [[t, v], ...])                keyframes from an array
//   fps(comp), frame(comp, seconds), seconds(comp, frame), tc(comp, seconds)
(function () {
    #include "../lib/rt_core.jsxinc"
    var args = RT.takeArgs() || {};
    var started = new Date().getTime(), __log = [];

    // ---- helpers ------------------------------------------------------------------------------
    function str(v) {
        if (v === null) return "null"; if (v === undefined) return "undefined";
        var t = typeof v;
        if (t === "string") return v; if (t === "number" || t === "boolean") return String(v);
        if (t === "function") return "[function]";
        if (v instanceof Error) { var s = (v.name ? v.name + ": " : "") + String(v.message || v.description || ""); try { if (v.line) s += " (line " + v.line + ")"; } catch (e) {} return s; }
        if (v instanceof File || v instanceof Folder) return v.fsName;
        if (RT.isArray(v)) { var parts = []; for (var i = 0; i < v.length; i++) parts.push(str(v[i])); return "[" + parts.join(", ") + "]"; }
        var cls = ""; try { cls = v.reflect.name; } catch (e2) {}
        if (cls && cls !== "Object") { var nm = ""; try { nm = v.name !== undefined ? " " + String(v.name) : ""; } catch (e3) {} return "[" + cls + nm + "]"; }
        try { return RT.stringify(v); } catch (e4) { return "[object]"; }
    }
    function log() { var parts = []; for (var i = 0; i < arguments.length; i++) parts.push(str(arguments[i])); __log.push(parts.join(" ")); }
    function findComp(name) {
        var hits = [];
        for (var i = 1; i <= app.project.numItems; i++) { var it = app.project.item(i); if (it instanceof CompItem && it.name === name) hits.push(it); }
        if (hits.length === 1) return hits[0];
        if (!hits.length) throw new Error("comp '" + name + "' not found");
        throw new Error("comp name '" + name + "' matches " + hits.length + " comps");
    }
    function findItem(ref) {
        var r = String(ref), hits = [], i, it;
        for (i = 1; i <= app.project.numItems; i++) { it = app.project.item(i); if (it.name === r) hits.push(it); }
        if (hits.length === 1) return hits[0];
        if (hits.length > 1) throw new Error("name '" + r + "' matches " + hits.length + " items");
        var f = new File(r);
        if (f.exists) for (i = 1; i <= app.project.numItems; i++) { it = app.project.item(i); try { if (it instanceof FootageItem && it.mainSource instanceof FileSource && it.mainSource.file && it.mainSource.file.fsName === f.fsName) return it; } catch (e) {} }
        throw new Error("item '" + r + "' not found");
    }
    function ensureFolder(pathStr) {
        var parts = String(pathStr).split("/"), parent = app.project.rootFolder;
        for (var p = 0; p < parts.length; p++) {
            if (!parts[p]) continue;
            var found = null;
            for (var i = 1; i <= parent.numItems; i++) { var it = parent.item(i); if (it instanceof FolderItem && it.name === parts[p]) { found = it; break; } }
            if (!found) { found = app.project.items.addFolder(parts[p]); found.parentFolder = parent; }
            parent = found;
        }
        return parent;
    }
    function ensureComp(name, w, h, dur, fr, folder) {
        try { return findComp(name); } catch (e) {}
        var c = app.project.items.addComp(name, w || 1920, h || 1080, 1, dur || 10, fr || 30);
        if (folder) c.parentFolder = (typeof folder === "string") ? ensureFolder(folder) : folder;
        return c;
    }
    function refetch(group, ref) {
        if (typeof ref === "number") return group.property(ref);
        for (var i = 1; i <= group.numProperties; i++) { var p = group.property(i); if (p.name === ref || p.matchName === ref) return p; }
        return null;
    }
    function addGroup(contents, matchName, name) {
        if (!contents.canAddProperty(matchName)) throw new Error("cannot add '" + matchName + "' to " + contents.matchName);
        var g = contents.addProperty(matchName);
        if (name) g.name = name;
        var idx = g.propertyIndex;
        return contents.property(idx); // references from addProperty go stale after further adds; hand back a fresh one
    }
    function addGroupsInOrder(contents, specs) {
        var out = [];
        for (var i = 0; i < specs.length; i++) { var s = specs[i]; addGroup(contents, s.mn || s.matchName, s.name); }
        // AE puts each newly added group at the bottom (first-added on top), so re-fetch by position.
        var base = contents.numProperties - specs.length;
        for (var j = 0; j < specs.length; j++) out.push(contents.property(base + j + 1));
        return out;
    }
    function easeDims(prop) {
        var t = prop.propertyValueType;
        if (prop.isSpatial) return 1;
        if (t === PropertyValueType.ThreeD) return 3;
        if (t === PropertyValueType.TwoD) return 2;
        return 1; // OneD, COLOR, etc.
    }
    function easeKeys(prop, keys, influence, speed) {
        if (influence === undefined || influence === null) influence = 33.333;
        if (speed === undefined || speed === null) speed = 0;
        influence = Math.max(0.1, Math.min(100, influence));
        var n = easeDims(prop), ease = [];
        for (var d = 0; d < n; d++) ease.push(new KeyframeEase(speed, influence));
        var list = keys && keys.length ? keys : (function () { var a = []; for (var k = 1; k <= prop.numKeys; k++) a.push(k); return a; })();
        for (var i = 0; i < list.length; i++) {
            var k = list[i];
            prop.setTemporalEaseAtKey(k, ease, ease);
            prop.setInterpolationTypeAtKey(k, KeyframeInterpolationType.BEZIER, KeyframeInterpolationType.BEZIER);
        }
        return list.length;
    }
    function setKeys(prop, pairs) { for (var i = 0; i < pairs.length; i++) prop.setValueAtTime(pairs[i][0], pairs[i][1]); return prop.numKeys; }
    function fps(comp) { return comp.frameRate; }
    function frame(comp, sec) { return Math.round(sec * comp.frameRate); }
    function seconds(comp, fr) { return fr / comp.frameRate; }
    function tc(comp, sec) { return RT.timecode(sec, comp.frameRate); }

    // ---- result serialization -----------------------------------------------------------------
    function describe(v, depth) {
        depth = depth || 0;
        if (v === null || v === undefined) return null;
        var t = typeof v;
        if (t === "string" || t === "number" || t === "boolean") return v;
        if (t === "function") return "[function]";
        if (v instanceof File || v instanceof Folder) return v.fsName;
        if (v instanceof Date) return v.toString();
        if (depth > 6) return "[nested too deep]";
        if (RT.isArray(v)) { var a = []; for (var i = 0; i < v.length && i < 2000; i++) a.push(describe(v[i], depth + 1)); return a; }
        var cls = ""; try { cls = v.reflect.name; } catch (e) {}
        if (cls === "Object" || cls === "") { var o = {}; for (var k in v) { if (RT.has(v, k)) o[k] = describe(v[k], depth + 1); } return o; }
        var d = { "[type]": cls };
        try { if (v.name !== undefined) d.name = String(v.name); } catch (e1) {}
        try { if (v.id !== undefined) d.id = v.id; } catch (e2) {}
        try { if (v.index !== undefined) d.index = v.index; } catch (e3) {}
        try { if (v.matchName !== undefined) d.matchName = v.matchName; } catch (e4) {}
        return d;
    }

    var result, error = null, suppressed = false;
    try { app.beginSuppressDialogs(); suppressed = true; } catch (e0) {}
    try {
        if (args.file) {
            var f = new File(args.file);
            if (!f.exists) throw new Error("file not found: " + f.fsName);
            result = $.evalFile(f);
        } else if (typeof args.code === "string") {
            result = eval(args.code);
        } else {
            throw new Error("give code or file");
        }
    } catch (e) {
        error = { message: String(e.message || e), name: String(e.name || "Error") };
        try { if (e.line !== undefined) error.line = e.line; } catch (x1) {}
        try { if (e.fileName) error.file = String(e.fileName); } catch (x2) {}
        try { if (e.source && e.line) { var src = String(e.source).split(/\r\n|\r|\n/); var ln = Number(e.line); var from = Math.max(1, ln - 2), to = Math.min(src.length, ln + 2), ctx = []; for (var q = from; q <= to; q++) ctx.push((q === ln ? "> " : "  ") + q + ": " + src[q - 1]); error.context = ctx.join("\n"); } } catch (x3) {}
    }
    if (suppressed) { try { app.endSuppressDialogs(false); } catch (e5) {} }

    var out = { ok: !error, ms: new Date().getTime() - started };
    if (error) { out.error = error.message + (error.line !== undefined ? " (line " + error.line + (error.file ? " of " + error.file : "") + ")" : ""); out.errorDetail = error; }
    else { try { out.result = describe(result); } catch (e6) { out.result = "[unserializable: " + e6.message + "]"; } }
    if (__log.length) out.output = __log;
    try { out.projectDirty = app.project ? app.project.dirty : null; } catch (e7) {}
    return RT.stringify(out);
})();
