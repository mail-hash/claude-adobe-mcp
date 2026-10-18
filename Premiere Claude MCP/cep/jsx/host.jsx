/* Claude Premiere Bridge — ExtendScript host (ES3). Loaded by the panel with $.evalFile.
   Everything lives in the single namespace CPB. No built-in prototype is modified, no other global
   is created. Every function returns plain data; CPB.call() wraps it as a JSON string.
   Times: Premiere ticks are 254016000000 per second. All results carry seconds and frames. */
// $.evalFile from inside a function would make a plain `var` local to that function; bind the namespace explicitly.
$.global.CPB = (function () {
    var C = { VERSION: "1.0.0" };
    var TICKS = 254016000000;

    // ---------------------------------------------------------------- JSON (own, prototype-free)
    function isArray(v) { return Object.prototype.toString.call(v) === "[object Array]"; }
    function has(o, k) { return o !== null && o !== undefined && Object.prototype.hasOwnProperty.call(o, k); }
    function quote(s) {
        var out = '"', t = String(s);
        for (var i = 0; i < t.length; i++) {
            var c = t.charAt(i), code = t.charCodeAt(i);
            if (c === '"') out += '\\"'; else if (c === "\\") out += "\\\\";
            else if (c === "\n") out += "\\n"; else if (c === "\r") out += "\\r"; else if (c === "\t") out += "\\t";
            else if (code < 32 || code === 0x2028 || code === 0x2029) { var h = code.toString(16); while (h.length < 4) h = "0" + h; out += "\\u" + h; }
            else out += c;
        }
        return out + '"';
    }
    function stringify(v) {
        if (v === null || v === undefined) return "null";
        var t = typeof v;
        if (t === "number") return isFinite(v) ? String(v) : "null";
        if (t === "boolean") return v ? "true" : "false";
        if (t === "string") return quote(v);
        if (t === "function") return "null";
        var parts = [], i;
        if (isArray(v)) { for (i = 0; i < v.length; i++) parts.push(stringify(v[i])); return "[" + parts.join(",") + "]"; }
        for (var k in v) { if (!has(v, k)) continue; var m = v[k]; if (m === undefined || typeof m === "function") continue; parts.push(quote(k) + ":" + stringify(m)); }
        return "{" + parts.join(",") + "}";
    }
    function parse(src) {
        var i = 0, len = src.length;
        function err(m) { throw new Error("JSON parse error at " + i + ": " + m); }
        function ws() { while (i < len) { var c = src.charAt(i); if (c === " " || c === "\n" || c === "\r" || c === "\t") i++; else break; } }
        function str() {
            var out = "", c; i++;
            while (i < len) {
                c = src.charAt(i++);
                if (c === '"') return out;
                if (c === "\\") { c = src.charAt(i++); if (c === "n") out += "\n"; else if (c === "r") out += "\r"; else if (c === "t") out += "\t"; else if (c === "b") out += "\b"; else if (c === "f") out += "\f"; else if (c === "u") { out += String.fromCharCode(parseInt(src.substr(i, 4), 16)); i += 4; } else out += c; }
                else out += c;
            }
            err("unterminated string");
        }
        function num() { var m = /^-?\d+(\.\d+)?([eE][+\-]?\d+)?/.exec(src.substr(i, 64)); if (!m) err("bad number"); i += m[0].length; return parseFloat(m[0]); }
        function val() {
            ws(); var c = src.charAt(i);
            if (c === "{") { i++; var o = {}; ws(); if (src.charAt(i) === "}") { i++; return o; } while (true) { ws(); if (src.charAt(i) !== '"') err("expected key"); var k = str(); ws(); if (src.charAt(i++) !== ":") err("expected ':'"); o[k] = val(); ws(); c = src.charAt(i++); if (c === "}") return o; if (c !== ",") err("expected , or }"); } }
            if (c === "[") { i++; var a = []; ws(); if (src.charAt(i) === "]") { i++; return a; } while (true) { a.push(val()); ws(); c = src.charAt(i++); if (c === "]") return a; if (c !== ",") err("expected , or ]"); } }
            if (c === '"') return str();
            if (src.substr(i, 4) === "true") { i += 4; return true; }
            if (src.substr(i, 5) === "false") { i += 5; return false; }
            if (src.substr(i, 4) === "null") { i += 4; return null; }
            return num();
        }
        var r = val(); ws(); if (i < len) err("trailing characters"); return r;
    }
    C.stringify = stringify; C.parse = parse;

    // ---------------------------------------------------------------- helpers
    function fail(msg, extra) { var e = new Error(msg); if (extra) e.extra = extra; throw e; }
    function round(n) { return Math.round(n * 1e6) / 1e6; }
    function requireProject() { if (!app.project) fail("No project is open in Premiere Pro."); return app.project; }
    function ticksOf(t) { if (t === null || t === undefined) return null; if (typeof t === "number") return t * TICKS; if (typeof t === "string") return parseFloat(t); if (t.ticks !== undefined) return parseFloat(t.ticks); if (t.seconds !== undefined) return t.seconds * TICKS; return null; }
    function secondsOf(t) { var tk = ticksOf(t); return tk === null ? null : tk / TICKS; }
    function makeTime(seconds) { var t = new Time(); t.seconds = seconds; return t; }
    function seqFps(seq) {
        var fps = null;
        try { var st = seq.getSettings(); if (st && st.videoFrameRate && st.videoFrameRate.seconds) fps = 1 / st.videoFrameRate.seconds; } catch (e) {}
        if (!fps) { try { fps = TICKS / parseFloat(seq.timebase); } catch (e2) {} }
        return fps || 30;
    }
    function seqFrameTicks(seq) { try { return parseFloat(seq.timebase); } catch (e) { return TICKS / 30; } }
    function framesOf(t, seq) { var tk = ticksOf(t); return tk === null ? null : Math.round(tk / seqFrameTicks(seq)); }
    function tcOf(seconds, fps) {
        var drop = Math.abs(fps - 29.97) < 0.01 || Math.abs(fps - 59.94) < 0.01;
        var total = Math.round(seconds * fps), f = total % Math.round(fps), s = Math.floor(total / Math.round(fps));
        var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
        function p(n) { return (n < 10 ? "0" : "") + n; }
        var sep = drop ? ";" : ":";
        return p(h) + ":" + p(m) + ":" + p(sec) + sep + p(f);
    }
    function timeInfo(t, seq) { var s = secondsOf(t); if (s === null) return null; var o = { seconds: round(s), frames: framesOf(t, seq), ticks: String(ticksOf(t)) }; try { o.timecode = tcOf(s, seqFps(seq)); } catch (e) {} return o; }

    function walk(parent, fn) {
        for (var i = 0; i < parent.children.numItems; i++) {
            var it = parent.children[i];
            var stop = fn(it, parent);
            if (stop === true) return true;
            if (it.type === ProjectItemType.BIN) { if (walk(it, fn) === true) return true; }
        }
        return false;
    }
    function itemType(it) {
        if (it.type === ProjectItemType.BIN) return "bin";
        try { if (it.isSequence && it.isSequence()) return "sequence"; } catch (e) {}
        if (it.type === ProjectItemType.CLIP) return "clip";
        if (it.type === ProjectItemType.FILE) return "file";
        return "unknown";
    }
    function binPathOf(it) {
        var parts = [], cur = it;
        try { while (cur && cur.treePath) { break; } } catch (e) {}
        try { var tp = String(it.treePath || ""); if (tp) { parts = tp.split("\\"); if (parts.length > 2) return parts.slice(2, parts.length - 1).join("/"); return ""; } } catch (e2) {}
        return null;
    }
    function itemInfo(it, withDuration) {
        var o = { id: it.nodeId, name: it.name, type: itemType(it) };
        try { var bp = binPathOf(it); if (bp !== null) o.bin = bp; } catch (e0) {}
        if (o.type === "bin") { try { o.items = it.children.numItems; } catch (e1) {} return o; }
        try { o.mediaPath = it.getMediaPath(); } catch (e2) {}
        try { o.offline = it.isOffline(); } catch (e3) {}
        if (o.type === "sequence") {
            var s = sequenceForItem(it);
            if (s) { o.sequenceId = s.sequenceID; try { o.duration = { seconds: round(secondsOf(s.end)), frames: framesOf(s.end, s) }; } catch (e4) {} }
        } else if (withDuration !== false) {
            try {
                var ip = it.getInPoint(4), op = it.getOutPoint(4);
                if (ip && op) { var d = secondsOf(op) - secondsOf(ip); o.duration = { seconds: round(d) }; o.inPoint = round(secondsOf(ip)); o.outPoint = round(secondsOf(op)); }
            } catch (e5) {}
            try { var fi = it.getFootageInterpretation(); if (fi) { o.frameRate = round(fi.frameRate); if (o.duration && o.frameRate) o.duration.frames = Math.round(o.duration.seconds * o.frameRate); } } catch (e6) {}
            try { o.hasVideo = it.hasVideo ? it.hasVideo() : undefined; o.hasAudio = it.hasAudio ? it.hasAudio() : undefined; } catch (e7) {}
        }
        return o;
    }
    function findItem(ref) {
        var p = requireProject();
        if (ref === null || ref === undefined || ref === "") return null;
        var r = String(ref), found = null;
        walk(p.rootItem, function (it) { if (String(it.nodeId) === r) { found = it; return true; } });
        if (found) return found;
        var byName = [];
        walk(p.rootItem, function (it) { if (it.name === r) byName.push(it); });
        if (byName.length === 1) return byName[0];
        if (byName.length > 1) fail("'" + r + "' matches " + byName.length + " project items; use an id. Ids: " + (function () { var ids = []; for (var i = 0; i < byName.length; i++) ids.push(byName[i].nodeId + " (" + itemType(byName[i]) + ")"); return ids.join(", "); })());
        try { var f = new File(r); if (f.exists) { walk(p.rootItem, function (it) { try { if (it.getMediaPath && it.getMediaPath() === f.fsName) { found = it; return true; } } catch (e) {} }); if (found) return found; } } catch (e2) {}
        return null;
    }
    function requireItem(ref) { var it = findItem(ref); if (!it) fail("Project item '" + ref + "' not found (give its id from pr_list_items, or an exact unique name)."); return it; }
    function findBin(ref, create) {
        var p = requireProject();
        if (ref === null || ref === undefined || ref === "" || ref === "/") return p.rootItem;
        var r = String(ref), found = null;
        walk(p.rootItem, function (it) { if (it.type === ProjectItemType.BIN && String(it.nodeId) === r) { found = it; return true; } });
        if (found) return found;
        var cur = p.rootItem, parts = r.split("/");
        for (var i = 0; i < parts.length; i++) {
            if (!parts[i]) continue;
            var next = null;
            for (var j = 0; j < cur.children.numItems; j++) { var ch = cur.children[j]; if (ch.type === ProjectItemType.BIN && ch.name === parts[i]) { next = ch; break; } }
            if (!next) { if (!create) return null; next = cur.createBin(parts[i]); }
            cur = next;
        }
        return cur;
    }
    function sequenceForItem(it) {
        var p = requireProject();
        for (var i = 0; i < p.sequences.numSequences; i++) {
            var s = p.sequences[i];
            try { if (s.projectItem && s.projectItem.nodeId === it.nodeId) return s; } catch (e) {}
        }
        for (var k = 0; k < p.sequences.numSequences; k++) if (p.sequences[k].name === it.name) return p.sequences[k];
        return null;
    }
    function findSequence(ref) {
        var p = requireProject();
        if (ref === null || ref === undefined || ref === "" || ref === "active") {
            var a = p.activeSequence; if (!a) fail("No active sequence. Open one in the timeline or pass a sequence id/name."); return a;
        }
        var r = String(ref), i;
        for (i = 0; i < p.sequences.numSequences; i++) if (String(p.sequences[i].sequenceID) === r) return p.sequences[i];
        var byName = [];
        for (i = 0; i < p.sequences.numSequences; i++) if (p.sequences[i].name === r) byName.push(p.sequences[i]);
        if (byName.length === 1) return byName[0];
        if (byName.length > 1) fail("'" + r + "' matches " + byName.length + " sequences; use a sequence id.");
        var it = findItem(r);
        if (it && itemType(it) === "sequence") { var s2 = sequenceForItem(it); if (s2) return s2; }
        fail("Sequence '" + r + "' not found.");
    }
    function trackList(seq, type) { return (type === "audio") ? seq.audioTracks : seq.videoTracks; }
    function requireTrack(seq, type, index) {
        var list = trackList(seq, type);
        if (index < 0 || index >= list.numTracks) fail(type + " track " + index + " does not exist (sequence has " + list.numTracks + " " + type + " tracks; indices start at 0). Use pr_add_tracks.");
        return list[index];
    }
    function clipInfo(clip, seq, trackType, trackIndex, clipIndex) {
        var o = { index: clipIndex, track: trackType + " " + trackIndex, name: clip.name };
        try { o.itemId = clip.projectItem ? clip.projectItem.nodeId : null; o.itemName = clip.projectItem ? clip.projectItem.name : null; } catch (e0) {}
        try { if (clip.projectItem && clip.projectItem.getMediaPath) o.mediaPath = clip.projectItem.getMediaPath(); } catch (e00) {}
        o.start = timeInfo(clip.start, seq); o.end = timeInfo(clip.end, seq);
        o.inPoint = timeInfo(clip.inPoint, seq); o.outPoint = timeInfo(clip.outPoint, seq);
        try { o.duration = timeInfo(clip.duration, seq); } catch (e1) {}
        try { o.mediaType = clip.mediaType; } catch (e2) {}
        try { o.enabled = !clip.disabled; } catch (e3) {}
        try { o.speed = clip.getSpeed ? round(clip.getSpeed()) : undefined; } catch (e4) {}
        try { if (clip.isAdjustmentLayer && clip.isAdjustmentLayer()) o.adjustmentLayer = true; } catch (e5) {}
        try { if (clip.nodeId) o.clipId = clip.nodeId; } catch (e6) {}
        return o;
    }
    function qeSequence(seq) {
        try { app.enableQE(); } catch (e) { fail("QE DOM unavailable"); }
        function lookup() {
            var n = 0; try { n = qe.project.numSequences; } catch (e) {}
            for (var i = 0; i < n; i++) { try { var c = qe.project.getSequenceAt(i); if (c && String(c.guid) === String(seq.sequenceID)) return c; } catch (e2) {} }
            try { var a = qe.project.getActiveSequence(); if (a && String(a.guid) === String(seq.sequenceID)) return a; } catch (e3) {}
            return null;
        }
        var q = lookup();
        if (q) return q;
        try { app.project.openSequence(seq.sequenceID); } catch (e4) {}
        try { app.project.activeSequence = seq; } catch (e5) {}
        try { $.sleep(200); } catch (e6) {}
        q = lookup();
        if (!q) fail("Premiere's QE layer can't address sequence '" + seq.name + "'. Open it in the timeline and retry.");
        return q;
    }
    function snapshotIds() { var m = {}; walk(requireProject().rootItem, function (it) { m[it.nodeId] = true; }); return m; }
    function newItemsSince(before) { var out = []; walk(requireProject().rootItem, function (it) { if (!before[it.nodeId]) out.push(itemInfo(it)); }); return out; }
    // Some imports (FCP XML, Dynamic Link) add their items shortly after the call returns.
    function waitForNewItems(before, maxMs) {
        var out = newItemsSince(before), waited = 0;
        while (!out.length && waited < maxMs) { $.sleep(250); waited += 250; out = newItemsSince(before); }
        if (out.length) { $.sleep(300); out = newItemsSince(before); } // let the batch settle
        return out;
    }
    function offlineAmong(items) { var out = []; for (var i = 0; i < items.length; i++) if (items[i].offline) out.push({ id: items[i].id, name: items[i].name, mediaPath: items[i].mediaPath }); return out; }

    // ---------------------------------------------------------------- project resolution
    // Every tool accepts an optional `project` (name, file name or path). With several projects open,
    // app.project is whichever Premiere last activated, so we activate the requested one explicitly.
    function projectByRef(ref) {
        if (ref === null || ref === undefined || ref === "") return app.project || null;
        var r = String(ref), base = r.split("/").pop();
        for (var i = 0; i < app.projects.numProjects; i++) {
            var p = app.projects[i];
            if (p.path === r || p.name === r || p.name === base || p.name === r + ".prproj") return p;
        }
        return null;
    }
    function activateProject(ref) {
        if (ref === null || ref === undefined || ref === "") return requireProject();
        var p = projectByRef(ref);
        if (!p) {
            var f = new File(String(ref));
            if (!f.exists) fail("Project '" + ref + "' is not open and no file exists at that path. Open projects: " + openProjectNames().join(", "));
            if (!app.openDocument(f.fsName, true, true, true) && !(app.project && app.project.path === f.fsName)) fail("Premiere did not open " + f.fsName);
            return requireProject();
        }
        if (app.project && app.project.path === p.path) return app.project;
        app.openDocument(p.path, true, true, true); // returns false for an already-open project but activates it
        if (!app.project || app.project.path !== p.path) fail("Could not make project '" + p.name + "' active.");
        return app.project;
    }
    function openProjectNames() { var out = []; try { for (var i = 0; i < app.projects.numProjects; i++) out.push(app.projects[i].name); } catch (e) {} return out; }

    // ---------------------------------------------------------------- status & projects
    C.status = function () {
        var o = { version: app.version, build: null, projects: [], activeProject: null, activeSequence: null };
        try { o.build = app.build; } catch (e0) {}
        try { for (var i = 0; i < app.projects.numProjects; i++) { var pr = app.projects[i]; o.projects.push({ name: pr.name, path: pr.path }); } } catch (e1) {}
        if (app.project) {
            o.activeProject = { name: app.project.name, path: app.project.path };
            try { o.activeProject.sequences = app.project.sequences.numSequences; } catch (e2) {}
            try { o.activeProject.rootItems = app.project.rootItem.children.numItems; } catch (e3) {}
            var s = app.project.activeSequence;
            if (s) { o.activeSequence = { id: s.sequenceID, name: s.name, fps: round(seqFps(s)), end: timeInfo(s.end, s) }; try { var st = s.getSettings(); o.activeSequence.size = [st.videoFrameWidth, st.videoFrameHeight]; } catch (e4) {} }
        }
        try { o.qe = (function () { app.enableQE(); return typeof qe === "object"; })(); } catch (e5) { o.qe = false; }
        return o;
    };
    C.openProject = function (a) {
        if (!a.path) fail("path is required");
        var f = new File(a.path); if (!f.exists) fail("file not found: " + f.fsName);
        // (path, suppressConversionDialog, bypassLocateFileDialog, bypassWarningDialog)
        var ok = app.openDocument(f.fsName, true, true, true);
        var activePath = app.project ? app.project.path : null;
        // openDocument returns false for a project that is already open, but still makes it active.
        if (!ok && activePath !== f.fsName) fail("Premiere did not open " + f.fsName);
        return { opened: f.fsName, alreadyOpen: !ok, active: activePath };
    };
    C.newProject = function (a) {
        if (!a.path) fail("path is required");
        var p = String(a.path); if (!/\.prproj$/i.test(p)) p += ".prproj";
        var f = new File(p); if (f.exists && !a.overwrite) fail("A file already exists at " + f.fsName + " (pass overwrite: true to replace it).");
        if (!f.parent.exists) f.parent.create();
        var ok = app.newProject(f.fsName);
        if (!ok) fail("Premiere did not create " + f.fsName);
        return { created: f.fsName, active: app.project ? app.project.path : null };
    };
    C.saveProject = function () { var p = requireProject(); p.save(); return { saved: p.path }; };
    C.saveAs = function (a) {
        var p = requireProject(); if (!a.path) fail("path is required");
        var s = String(a.path); if (!/\.prproj$/i.test(s)) s += ".prproj";
        var f = new File(s); if (!f.parent.exists) f.parent.create();
        var r = p.saveAs(f.fsName);
        return { saved: app.project ? app.project.path : f.fsName, result: r };
    };
    C.closeProject = function (a) {
        var p = requireProject();
        var r = p.closeDocument(a.save ? 1 : 0, 0);
        return { closed: true, result: r, active: app.project ? app.project.path : null };
    };

    // ---------------------------------------------------------------- import
    C.importFiles = function (a) {
        var p = requireProject();
        var paths = a.paths || [], i, missing = [];
        for (i = 0; i < paths.length; i++) { var f = new File(paths[i]); if (!f.exists) missing.push(paths[i]); else paths[i] = f.fsName; }
        if (missing.length) fail("File(s) not found: " + missing.join(", "));
        if (!paths.length) fail("paths is empty");
        if (a.dryRun) return { dryRun: true, plan: { action: "importFiles", paths: paths, bin: a.bin || "/" } };
        var bin = findBin(a.bin, true);
        var before = snapshotIds();
        var ok = p.importFiles(paths, true, bin, !!a.asNumberedStills);
        var created = waitForNewItems(before, 10000); // XML / project imports can finish after importFiles returns
        var r = { imported: created, offline: offlineAmong(created), bin: bin === p.rootItem ? "/" : bin.name, importReturned: ok };
        if (!created.length) {
            var already = [];
            for (i = 0; i < paths.length; i++) { var pi = findItem(paths[i]); if (pi) already.push(itemInfo(pi)); }
            if (already.length) { r.alreadyInProject = already; }
            else if (!ok) fail("Premiere refused the import (unsupported format, or a dialog was suppressed). Nothing was added.");
            else r.warning = "Premiere accepted the call but created no project items. With its UI suppressed, an unsupported or malformed file (for example a hand-built FCP XML) fails silently; import it once by hand to see Premiere's error message.";
        }
        return r;
    };
    C.importAEComps = function (a) {
        var p = requireProject();
        if (!a.aepPath) fail("aepPath is required");
        var f = new File(a.aepPath); if (!f.exists) fail("file not found: " + f.fsName);
        if (a.dryRun) return { dryRun: true, plan: { action: "importAEComps", aep: f.fsName, comps: a.compNames || "all", bin: a.bin || "/" } };
        var bin = findBin(a.bin, true);
        var before = snapshotIds();
        var names = a.compNames || [];
        var ok;
        if (names.length) ok = p.importAEComps(f.fsName, names, bin);
        else ok = p.importAllAEComps(f.fsName, bin);
        var created = waitForNewItems(before, 15000);
        // Dynamic Link items are named "<comp>/<project>.aep".
        var notFound = [];
        for (var j = 0; j < names.length; j++) {
            var hit = false;
            for (var i = 0; i < created.length; i++) { var nm = String(created[i].name); if (nm === names[j] || nm.indexOf(names[j] + "/") === 0) hit = true; }
            if (!hit) notFound.push(names[j]);
        }
        return { imported: created, notCreated: notFound, bin: bin === p.rootItem ? "/" : bin.name, importReturned: ok,
            note: notFound.length ? "Comps not created usually mean the name doesn't match a comp in the .aep exactly, or Dynamic Link is blocked by a dialog in After Effects (Resolve Fonts, missing footage...)." : undefined };
    };

    // ---------------------------------------------------------------- listing
    C.listItems = function (a) {
        var p = requireProject();
        var bin = findBin(a.bin, false);
        if (!bin) fail("bin '" + a.bin + "' not found");
        var out = [];
        if (a.recursive === false) { for (var i = 0; i < bin.children.numItems; i++) out.push(itemInfo(bin.children[i], a.durations !== false)); }
        else walk(bin, function (it) { out.push(itemInfo(it, a.durations !== false)); });
        if (a.filter) { var f = String(a.filter).toLowerCase(), fl = []; for (var k = 0; k < out.length; k++) if (String(out[k].name).toLowerCase().indexOf(f) >= 0) fl.push(out[k]); out = fl; }
        var limit = a.limit || 500;
        return { total: out.length, items: out.slice(0, limit), truncated: out.length > limit };
    };
    C.listSequences = function () {
        var p = requireProject(), out = [], active = p.activeSequence ? p.activeSequence.sequenceID : null;
        for (var i = 0; i < p.sequences.numSequences; i++) {
            var s = p.sequences[i], o = { id: s.sequenceID, name: s.name, fps: round(seqFps(s)), end: timeInfo(s.end, s), videoTracks: s.videoTracks.numTracks, audioTracks: s.audioTracks.numTracks, active: s.sequenceID === active };
            try { var st = s.getSettings(); o.size = [st.videoFrameWidth, st.videoFrameHeight]; } catch (e) {}
            out.push(o);
        }
        return { sequences: out };
    };
    C.getSequence = function (a) {
        var s = findSequence(a.sequence), fps = seqFps(s);
        var o = { id: s.sequenceID, name: s.name, fps: round(fps), frameTicks: String(seqFrameTicks(s)), end: timeInfo(s.end, s), tracks: [] };
        try { var st = s.getSettings(); o.size = [st.videoFrameWidth, st.videoFrameHeight]; if (st.audioSampleRate && st.audioSampleRate.seconds) { o.audioSampleRate = round(1 / st.audioSampleRate.seconds); } } catch (e) {}
        try { o.inPoint = timeInfo(s.getInPointAsTime(), s); o.outPoint = timeInfo(s.getOutPointAsTime(), s); } catch (e1) {}
        function tracks(list, type) {
            for (var t = 0; t < list.numTracks; t++) {
                var tr = list[t], ti = { type: type, index: t, name: tr.name, clips: [] };
                try { ti.enabled = !tr.isMuted(); } catch (e2) {}
                try { ti.locked = tr.isLocked(); } catch (e3) {}
                ti.clipCount = tr.clips.numItems;
                if (a.clips !== false) for (var c = 0; c < tr.clips.numItems; c++) ti.clips.push(clipInfo(tr.clips[c], s, type, t, c));
                o.tracks.push(ti);
            }
        }
        tracks(s.videoTracks, "video"); tracks(s.audioTracks, "audio");
        return o;
    };

    // ---------------------------------------------------------------- editing
    function timeArg(a, secKey, frameKey, seq) {
        if (a[secKey] !== undefined && a[secKey] !== null) return Number(a[secKey]);
        if (a[frameKey] !== undefined && a[frameKey] !== null) return Number(a[frameKey]) * seqFrameTicks(seq) / TICKS;
        return null;
    }
    function clipAtStart(track, startSec, seq) {
        var best = null, bestD = null;
        for (var c = 0; c < track.clips.numItems; c++) { var d = Math.abs(secondsOf(track.clips[c].start) - startSec); if (bestD === null || d < bestD) { best = { clip: track.clips[c], index: c }; bestD = d; } }
        return best;
    }
    function clipKey(c) { var k = ""; try { k = String(c.nodeId || ""); } catch (e) {} if (!k) { try { k = String(c.start.ticks) + "|" + String(c.end.ticks) + "|" + c.name; } catch (e2) {} } return k; }
    function trackClipKeys(list) { var out = []; for (var t = 0; t < list.numTracks; t++) { var m = {}; for (var c = 0; c < list[t].clips.numItems; c++) m[clipKey(list[t].clips[c])] = true; out.push(m); } return out; }
    function newClipsOn(list, beforeKeys) {
        var out = [];
        for (var t = 0; t < list.numTracks; t++) { var was = beforeKeys[t] || {}; for (var c = 0; c < list[t].clips.numItems; c++) { var cl = list[t].clips[c]; if (!was[clipKey(cl)]) out.push({ track: t, index: c, clip: cl }); } }
        return out;
    }
    function removeEmptyAudioTracksAbove(seq, keepCount) {
        // Premiere's DOM has no track deletion; QE sometimes offers these.
        var removed = false;
        try { var q = qeSequence(seq); if (typeof q.removeEmptyAudioTracks === "function" && seq.audioTracks.numTracks > keepCount) { q.removeEmptyAudioTracks(); removed = true; } } catch (e) {}
        return removed;
    }
    C.placeClip = function (a) {
        var seq = findSequence(a.sequence);
        var item = requireItem(a.item);
        if (itemType(item) === "bin") fail("'" + item.name + "' is a bin");
        var type = a.trackType === "audio" ? "audio" : "video";
        var tIdx = Number(a.trackIndex) || 0;
        var track = requireTrack(seq, type, tIdx);
        var start = timeArg(a, "startSeconds", "startFrame", seq); if (start === null) start = 0;
        var inS = timeArg(a, "inSeconds", "inFrame", seq), outS = timeArg(a, "outSeconds", "outFrame", seq);
        var mode = String(a.mode || "overwrite");
        var plan = { action: "place", item: item.name, itemId: item.nodeId, sequence: seq.name, track: type + " " + tIdx, mode: mode, start: timeInfo(start, seq), inPoint: inS === null ? null : round(inS), outPoint: outS === null ? null : round(outS), videoOnly: !!a.videoOnly, audioOnly: !!a.audioOnly };
        if (a.dryRun) return { dryRun: true, plan: plan };
        if (inS !== null) item.setInPoint(inS, 4);
        if (outS !== null) item.setOutPoint(outS, 4);
        var vBefore = trackClipKeys(seq.videoTracks), aBefore = trackClipKeys(seq.audioTracks), aTracksBefore = seq.audioTracks.numTracks, vTracksBefore = seq.videoTracks.numTracks;
        try {
            if (mode === "insert") track.insertClip(item, makeTime(start)); else track.overwriteClip(item, makeTime(start));
        } finally {
            // Don't leave a trimmed master clip behind.
            try { if (inS !== null) item.clearInPoint(4); if (outS !== null) item.clearOutPoint(4); } catch (e1) {}
        }
        var newV = newClipsOn(seq.videoTracks, vBefore), newA = newClipsOn(seq.audioTracks, aBefore), i;
        var r = { sequence: seq.name, mode: mode, placed: [], removedLinked: [], warnings: [] };
        if (a.videoOnly) {
            for (i = newA.length - 1; i >= 0; i--) { r.removedLinked.push("audio " + newA[i].track + " " + newA[i].clip.name); newA[i].clip.remove(false, false); }
            newA = [];
            if (seq.audioTracks.numTracks > aTracksBefore) { if (removeEmptyAudioTracksAbove(seq, aTracksBefore)) r.warnings.push("Premiere added " + (seq.audioTracks.numTracks - aTracksBefore) + " audio track(s) during placement; empty ones were removed."); else r.warnings.push("Premiere added audio track(s) while placing (its audio patching created them); the DOM can't delete tracks — remove them in the UI if unwanted."); }
        }
        if (a.audioOnly) {
            for (i = newV.length - 1; i >= 0; i--) { r.removedLinked.push("video " + newV[i].track + " " + newV[i].clip.name); newV[i].clip.remove(false, false); }
            newV = [];
        }
        for (i = 0; i < newV.length; i++) r.placed.push(clipInfo(newV[i].clip, seq, "video", newV[i].track, newV[i].index));
        for (i = 0; i < newA.length; i++) r.placed.push(clipInfo(newA[i].clip, seq, "audio", newA[i].track, newA[i].index));
        if (a.targetAudioTrackIndex !== undefined && a.targetAudioTrackIndex !== null && newA.length) {
            var want = Number(a.targetAudioTrackIndex), off = [];
            for (i = 0; i < newA.length; i++) if (newA[i].track !== want) off.push("A" + (newA[i].track + 1));
            if (off.length) r.warnings.push("Audio landed on " + off.join(", ") + " instead of A" + (want + 1) + ": Premiere's API can't move clips between tracks. Use video_only and place the audio separately on audio track " + want + ".");
        }
        if (seq.videoTracks.numTracks > vTracksBefore) r.warnings.push("Premiere added " + (seq.videoTracks.numTracks - vTracksBefore) + " video track(s).");
        // Backward compatibility: first placed clip on the requested track type.
        for (i = 0; i < r.placed.length; i++) { if (r.placed[i].track.indexOf(type) === 0) { r.clip = r.placed[i]; break; } }
        if (!r.clip && r.placed.length) r.clip = r.placed[0];
        for (i = 0; i < r.placed.length; i++) { if (r.placed[i].track.indexOf("audio") === 0 && type === "video") { r.linkedAudioClip = r.placed[i]; break; } }
        if (!r.warnings.length) delete r.warnings;
        return r;
    };
    C.placeClips = function (a) {
        var list = a.clips || [];
        if (!list.length) fail("clips is empty");
        var results = [];
        for (var i = 0; i < list.length; i++) {
            var spec = list[i];
            var args = {};
            for (var k in spec) if (has(spec, k)) args[k] = spec[k];
            if (args.sequence === undefined) args.sequence = a.sequence;
            if (args.videoOnly === undefined) args.videoOnly = a.videoOnly;
            if (args.audioOnly === undefined) args.audioOnly = a.audioOnly;
            if (args.mode === undefined) args.mode = a.mode;
            args.dryRun = a.dryRun;
            try { var r = C.placeClip(args); r.index = i; results.push(r); }
            catch (e) { fail("clip " + (i + 1) + " of " + list.length + " (" + (spec.item || "?") + "): " + e.message, { completed: results }); }
        }
        return { count: results.length, dryRun: !!a.dryRun, results: results };
    };
    C.createSequence = function (a) {
        var p = requireProject();
        if (!a.name) fail("name is required");
        var from = a.fromItem ? requireItem(a.fromItem) : null;
        var bin = findBin(a.bin, true);
        if (a.dryRun) return { dryRun: true, plan: { action: "createSequence", name: a.name, fromItem: from ? from.name : null, preset: a.presetPath || null } };
        var seq = null;
        if (a.presetPath) { var pf = new File(a.presetPath); if (!pf.exists) fail("preset not found: " + pf.fsName); seq = p.newSequence(a.name, pf.fsName); }
        else if (from) { seq = p.createNewSequenceFromClips(a.name, [from], bin); if (seq && a.clear !== false) { for (var t = 0; t < seq.videoTracks.numTracks; t++) for (var c = seq.videoTracks[t].clips.numItems - 1; c >= 0; c--) seq.videoTracks[t].clips[c].remove(false, false); for (var t2 = 0; t2 < seq.audioTracks.numTracks; t2++) for (var c2 = seq.audioTracks[t2].clips.numItems - 1; c2 >= 0; c2--) seq.audioTracks[t2].clips[c2].remove(false, false); } }
        else fail("give fromItem (a clip whose settings the sequence copies) or presetPath (.sqpreset)");
        if (!seq) fail("Premiere did not create the sequence");
        return { id: seq.sequenceID, name: seq.name, fps: round(seqFps(seq)), videoTracks: seq.videoTracks.numTracks, audioTracks: seq.audioTracks.numTracks };
    };
    C.setClipEnabled = function (a) {
        var seq = findSequence(a.sequence), t = findClipArg(seq, a);
        if (a.dryRun) return { dryRun: true, plan: { action: "setClipEnabled", clip: t.clip.name, enabled: !!a.enabled } };
        t.clip.disabled = !a.enabled;
        return { clip: clipInfo(t.clip, seq, t.type, Number(a.trackIndex) || 0, t.index) };
    };
    C.moveClip = function (a) {
        var seq = findSequence(a.sequence), t = findClipArg(seq, a), clip = t.clip;
        var cur = secondsOf(clip.start), dur = secondsOf(clip.end) - cur, target;
        if (a.toFrame !== undefined && a.toFrame !== null) target = Number(a.toFrame) * seqFrameTicks(seq) / TICKS;
        else if (a.toSeconds !== undefined && a.toSeconds !== null) target = Number(a.toSeconds);
        else if (a.deltaFrames !== undefined && a.deltaFrames !== null) target = cur + Number(a.deltaFrames) * seqFrameTicks(seq) / TICKS;
        else if (a.deltaSeconds !== undefined && a.deltaSeconds !== null) target = cur + Number(a.deltaSeconds);
        else fail("give toFrame, toSeconds, deltaFrames or deltaSeconds");
        if (target < 0) target = 0;
        if (a.dryRun) return { dryRun: true, plan: { action: "moveClip", clip: clip.name, from: timeInfo(cur, seq), to: timeInfo(target, seq) } };
        var ok = false;
        try { clip.move(makeTime(target - cur)); ok = Math.abs(secondsOf(clip.start) - target) < 0.002; } catch (e) {}
        if (!ok) { try { clip.start = makeTime(target); clip.end = makeTime(target + dur); ok = Math.abs(secondsOf(clip.start) - target) < 0.002; } catch (e2) {} }
        if (!ok) fail("Premiere did not move the clip (another clip may be in the way in overwrite-free move).");
        var placed = clipAtStart(t.track, target, seq);
        return { clip: clipInfo(placed.clip, seq, t.type, Number(a.trackIndex) || 0, placed.index), movedFrom: timeInfo(cur, seq) };
    };
    C.trackOp = function (a) {
        var seq = findSequence(a.sequence);
        var type = a.trackType === "audio" ? "audio" : "video";
        var idx = Number(a.trackIndex) || 0;
        var track = requireTrack(seq, type, idx);
        var changes = {};
        if (a.name !== undefined && a.name !== null) changes.name = String(a.name);
        if (a.enabled !== undefined && a.enabled !== null) changes.enabled = !!a.enabled;
        if (a.locked !== undefined && a.locked !== null) changes.locked = !!a.locked;
        if (a.targeted !== undefined && a.targeted !== null) changes.targeted = !!a.targeted;
        if (a.dryRun) return { dryRun: true, plan: { action: "trackOp", track: type + " " + idx, changes: changes } };
        var notes = [];
        if (changes.name !== undefined) { var renamed = false; try { track.name = changes.name; renamed = track.name === changes.name; } catch (e) {} if (!renamed) { try { var q = qeSequence(seq); var qt = type === "audio" ? q.getAudioTrackAt(idx) : q.getVideoTrackAt(idx); if (qt && typeof qt.setName === "function") { qt.setName(changes.name); renamed = true; } } catch (e2) {} } if (!renamed) notes.push("Premiere's API didn't accept the rename (track names are read-only in this version)."); }
        if (changes.enabled !== undefined) track.setMute(changes.enabled ? 0 : 1);
        if (changes.locked !== undefined) track.setLocked(changes.locked ? 1 : 0);
        if (changes.targeted !== undefined) { try { track.setTargeted(changes.targeted, true); } catch (e3) { notes.push("setTargeted not available: " + e3.message); } }
        var o = { track: type + " " + idx, name: track.name };
        try { o.enabled = !track.isMuted(); } catch (e4) {}
        try { o.locked = track.isLocked(); } catch (e5) {}
        try { o.targeted = track.isTargeted(); } catch (e6) {}
        if (notes.length) o.notes = notes;
        return o;
    };
    function findClipArg(seq, a) {
        var type = a.trackType === "audio" ? "audio" : "video";
        var track = requireTrack(seq, type, Number(a.trackIndex) || 0);
        var clip = null, idx = -1;
        if (a.clipIndex !== undefined && a.clipIndex !== null) { idx = Number(a.clipIndex); if (idx < 0 || idx >= track.clips.numItems) fail("clip index " + idx + " out of range (track has " + track.clips.numItems + " clips)"); clip = track.clips[idx]; }
        else {
            var t = timeArg(a, "atSeconds", "atFrame", seq); if (t === null) fail("give clipIndex, atSeconds or atFrame");
            for (var c = 0; c < track.clips.numItems; c++) { var cl = track.clips[c]; if (secondsOf(cl.start) <= t + 1e-6 && secondsOf(cl.end) > t + 1e-6) { clip = cl; idx = c; break; } }
            if (!clip) fail("no clip on " + type + " track " + a.trackIndex + " at " + t + "s");
        }
        return { track: track, clip: clip, index: idx, type: type };
    }
    C.replaceClip = function (a) {
        var seq = findSequence(a.sequence);
        var target = findClipArg(seq, a);
        var newItem = requireItem(a.newItem);
        var clip = target.clip;
        if (a.dryRun) return { dryRun: true, plan: { action: "replaceClip", clip: clip.name, start: timeInfo(clip.start, seq), end: timeInfo(clip.end, seq), newItem: newItem.name } };
        var saved = { start: secondsOf(clip.start), end: secondsOf(clip.end), inPoint: secondsOf(clip.inPoint), outPoint: secondsOf(clip.outPoint), disabled: !!clip.disabled, name: clip.name };
        var dur = saved.end - saved.start;
        var keepIn = a.keepInPoint !== false; // keep the same source in-point when the new media allows it
        var inS = keepIn ? saved.inPoint : 0;
        var hadErr = null;
        try {
            clip.remove(false, false);
            newItem.setInPoint(inS, 4); newItem.setOutPoint(inS + dur, 4);
            target.track.overwriteClip(newItem, makeTime(saved.start));
        } catch (e) { hadErr = e; }
        finally { try { newItem.clearInPoint(4); newItem.clearOutPoint(4); } catch (e2) {} }
        if (hadErr) fail("replace failed: " + hadErr.message);
        var placed = clipAtStart(target.track, saved.start, seq);
        if (!placed) fail("replacement did not land on the track");
        try { if (Math.abs(secondsOf(placed.clip.end) - saved.end) > 0.001) placed.clip.end = makeTime(saved.end); } catch (e3) {}
        try { placed.clip.disabled = saved.disabled; } catch (e4) {}
        var info = clipInfo(placed.clip, seq, target.type, Number(a.trackIndex) || 0, placed.index);
        var r = { replaced: saved.name, "with": newItem.name, clip: info };
        if (Math.abs(info.end.seconds - saved.end) > 0.002) r.warning = "The new clip ends at " + info.end.seconds + "s instead of " + round(saved.end) + "s: the new media is shorter than the slot.";
        return r;
    };
    C.removeClips = function (a) {
        var seq = findSequence(a.sequence);
        var type = a.trackType === "audio" ? "audio" : "video";
        var track = requireTrack(seq, type, Number(a.trackIndex) || 0);
        var from = timeArg(a, "fromSeconds", "fromFrame", seq), to = timeArg(a, "toSeconds", "toFrame", seq);
        if (from === null) from = 0; if (to === null) to = secondsOf(seq.end) + 1;
        var removed = [], c;
        var victims = [];
        if (a.clipIndex !== undefined && a.clipIndex !== null) { var i0 = Number(a.clipIndex); if (i0 < 0 || i0 >= track.clips.numItems) fail("clip index out of range"); victims.push(track.clips[i0]); }
        else for (c = 0; c < track.clips.numItems; c++) {
            var cl = track.clips[c], s = secondsOf(cl.start), e = secondsOf(cl.end);
            var hit = a.overlapping ? (e > from && s < to) : (s >= from - 1e-6 && e <= to + 1e-6);
            if (hit) victims.push(cl);
        }
        if (a.dryRun) { var planned = []; for (c = 0; c < victims.length; c++) planned.push({ name: victims[c].name, start: timeInfo(victims[c].start, seq), end: timeInfo(victims[c].end, seq) }); return { dryRun: true, plan: { action: "removeClips", track: type + " " + a.trackIndex, clips: planned } }; }
        for (c = victims.length - 1; c >= 0; c--) { removed.push({ name: victims[c].name, start: round(secondsOf(victims[c].start)), end: round(secondsOf(victims[c].end)) }); victims[c].remove(!!a.ripple, !!a.ripple); }
        return { removed: removed.reverse(), remaining: track.clips.numItems };
    };
    C.setTrackEnabled = function (a) {
        var seq = findSequence(a.sequence);
        var type = a.trackType === "audio" ? "audio" : "video";
        var track = requireTrack(seq, type, Number(a.trackIndex) || 0);
        if (a.enabled !== undefined && a.enabled !== null) track.setMute(a.enabled ? 0 : 1);
        if (a.locked !== undefined && a.locked !== null) track.setLocked(a.locked ? 1 : 0);
        var o = { track: type + " " + a.trackIndex, name: track.name };
        try { o.enabled = !track.isMuted(); } catch (e) {}
        try { o.locked = track.isLocked(); } catch (e2) {}
        return o;
    };
    C.addTracks = function (a) {
        var seq = findSequence(a.sequence);
        var nv = Number(a.video) || 0, na = Number(a.audio) || 0;
        if (!nv && !na) fail("give video and/or audio counts");
        if (a.dryRun) return { dryRun: true, plan: { action: "addTracks", video: nv, audio: na } };
        var bv = seq.videoTracks.numTracks, ba = seq.audioTracks.numTracks;
        var q = qeSequence(seq);
        var ok = false, err = null;
        // (numVideo, videoIndex, numAudio, audioType [0 mono,1 stereo,2 5.1,3 adaptive], audioIndex, numSubmix, submixType, submixIndex)
        try { q.addTracks(nv, bv, na, a.audioType !== undefined ? Number(a.audioType) : 1, ba, 0, 1, 0); ok = true; } catch (e) { err = e; }
        if (!ok) { try { q.addTracks(nv, bv, na, 1, ba); ok = true; } catch (e2) { err = e2; } }
        if (!ok) fail("addTracks failed: " + (err ? err.message : "unknown"));
        return { videoTracks: { before: bv, after: seq.videoTracks.numTracks }, audioTracks: { before: ba, after: seq.audioTracks.numTracks } };
    };

    // ---------------------------------------------------------------- stills & render
    C.exportFrame = function (a) {
        var seq = findSequence(a.sequence);
        if (!a.path) fail("path is required");
        var t = timeArg(a, "seconds", "frame", seq); if (t === null) t = 0;
        var fps = seqFps(seq);
        var requested = String(a.path);
        var stem = requested.replace(/\.png$/i, "");
        var f = new File(stem + ".png"); if (!f.parent.exists) f.parent.create();
        var q = qeSequence(seq);
        if (typeof q.exportFramePNG !== "function") fail("QE exportFramePNG is not available in this Premiere");
        var beforeStamp = f.exists ? f.modified.getTime() : null;
        // Premiere appends ".png" itself; pass the stem.
        q.exportFramePNG(tcOf(t, fps), stem);
        var waited = 0;
        while (waited < 15000) { if (f.exists && f.length > 0 && (beforeStamp === null || f.modified.getTime() !== beforeStamp)) break; $.sleep(200); waited += 200; }
        if (!(f.exists && f.length > 0)) fail("Premiere did not write " + f.fsName + " (QE export failed silently; is the sequence open in a timeline?)");
        return { path: f.fsName, bytes: f.length, seconds: round(t), frame: framesOf(t, seq), timecode: tcOf(t, fps) };
    };
    C.render = function (a) {
        var seq = findSequence(a.sequence);
        if (!a.path) fail("path is required"); if (!a.presetPath) fail("presetPath (.epr) is required");
        var preset = new File(a.presetPath); if (!preset.exists) fail("preset not found: " + preset.fsName);
        if (a.dryRun) return { dryRun: true, plan: { action: "render", sequence: seq.name, preset: preset.fsName, out: a.path, mode: a.mode || "ame", range: a.range || "entire" } };
        var out = new File(a.path); if (!out.parent.exists) out.parent.create();
        var workArea = 0; // 0 entire, 1 in/out, 2 work area
        var range = String(a.range || "entire");
        if (range === "inout") workArea = 1; else if (range === "workarea") workArea = 2;
        if (a.inSeconds !== undefined || a.outSeconds !== undefined || a.inFrame !== undefined || a.outFrame !== undefined) {
            var i0 = timeArg(a, "inSeconds", "inFrame", seq), o0 = timeArg(a, "outSeconds", "outFrame", seq);
            if (i0 !== null) seq.setInPoint(i0); if (o0 !== null) seq.setOutPoint(o0);
            workArea = 1;
        }
        try { app.encoder.setSidecarXMPEnabled(0); app.encoder.setEmbeddedXMPEnabled(0); } catch (e0) {}
        if (String(a.mode || "ame") === "direct") {
            var t0 = new Date().getTime();
            var res = seq.exportAsMediaDirect(out.fsName, preset.fsName, workArea);
            var secs = (new Date().getTime() - t0) / 1000;
            var written = out.exists && out.length > 0;
            if (!written) {
                // Premiere may change the extension to match the preset; look for a sibling with the same stem.
                var sib = out.parent.getFiles(out.name.replace(/\.[^.]+$/, "") + ".*");
                for (var s = 0; s < sib.length; s++) if (sib[s] instanceof File && sib[s].length > 0) { out = sib[s]; written = true; break; }
            }
            return { mode: "direct", done: written, path: written ? out.fsName : null, bytes: written ? out.length : 0, seconds: round(secs), premiereResult: String(res) };
        }
        try { app.encoder.launchEncoder(); } catch (e1) {}
        var jobId = app.encoder.encodeSequence(seq, out.fsName, preset.fsName, workArea, a.removeOnCompletion ? 1 : 0, a.startImmediately === false ? 0 : 1);
        if (!jobId) fail("Media Encoder refused the job (is the .epr preset valid for this sequence?)");
        return { mode: "ame", jobId: String(jobId), path: out.fsName, note: "Rendering in Adobe Media Encoder; check its queue or the output file." };
    };

    // ---------------------------------------------------------------- arbitrary code
    C.runScript = function (a) {
        if (typeof a.code !== "string" && !a.file) fail("code or file is required");
        var started = new Date().getTime(), result, __log = [];
        // Helpers visible to the evaluated code:
        function log() { var parts = []; for (var i = 0; i < arguments.length; i++) parts.push(typeof arguments[i] === "string" ? arguments[i] : stringify(describe(arguments[i], 0))); __log.push(parts.join(" ")); }
        function getProject(ref) { var p = projectByRef(ref); if (!p) fail("project '" + ref + "' is not open; open: " + openProjectNames().join(", ")); return p; }
        function getSequence(projectRef, seqRef) { if (projectRef) activateProject(projectRef); return findSequence(seqRef); }
        var helpers = { log: log, getProject: getProject, getSequence: getSequence, findItem: findItem, findBin: findBin, findSequence: findSequence, qeSequence: qeSequence, makeTime: makeTime, secondsOf: secondsOf, timeInfo: timeInfo, itemInfo: itemInfo, clipInfo: clipInfo, stringify: stringify };
        try {
            if (a.file) { var f = new File(a.file); if (!f.exists) fail("file not found: " + f.fsName); result = $.evalFile(f); }
            else result = eval(a.code);
        } catch (e) {
            var err = { message: String(e.message || e), name: String(e.name || "Error") };
            try { if (e.line !== undefined) err.line = e.line; } catch (x1) {}
            try { if (e.source && e.line) { var src = String(e.source).split(/\r\n|\r|\n/), ln = Number(e.line), ctx = []; for (var q = Math.max(1, ln - 2); q <= Math.min(src.length, ln + 2); q++) ctx.push((q === ln ? "> " : "  ") + q + ": " + src[q - 1]); err.context = ctx.join("\n"); } } catch (x2) {}
            fail(err.message + (err.line !== undefined ? " (line " + err.line + ")" : ""), err);
        }
        var out = { result: describe(result, 0), ms: new Date().getTime() - started };
        if (__log.length) out.output = __log;
        return out;
    };
    function describe(v, depth) {
        if (v === null || v === undefined) return null;
        var t = typeof v;
        if (t === "string" || t === "number" || t === "boolean") return v;
        if (t === "function") return "[function]";
        if (v instanceof File || v instanceof Folder) return v.fsName;
        if (depth > 5) return "[nested too deep]";
        if (isArray(v)) { var arr = []; for (var i = 0; i < v.length && i < 2000; i++) arr.push(describe(v[i], depth + 1)); return arr; }
        var cls = ""; try { cls = v.reflect.name; } catch (e) {}
        if (cls === "Object" || cls === "") { var o = {}; for (var k in v) { if (has(v, k)) o[k] = describe(v[k], depth + 1); } return o; }
        var d = { "[type]": cls };
        try { if (v.name !== undefined) d.name = String(v.name); } catch (e1) {}
        try { if (v.nodeId !== undefined) d.id = v.nodeId; } catch (e2) {}
        try { if (v.sequenceID !== undefined) d.sequenceId = v.sequenceID; } catch (e3) {}
        try { if (v.seconds !== undefined && v.ticks !== undefined) { d.seconds = v.seconds; d.ticks = String(v.ticks); } } catch (e4) {}
        return d;
    }

    // ---------------------------------------------------------------- dispatcher
    C.call = function (payloadJson) {
        var fn = "?", res;
        try {
            var payload = parse(String(payloadJson));
            fn = payload.fn;
            if (typeof C[fn] !== "function" || fn === "call" || fn === "stringify" || fn === "parse") fail("unknown host function '" + fn + "'");
            var args = payload.args || {};
            if (args.project !== undefined && args.project !== null && args.project !== "" && fn !== "openProject" && fn !== "newProject") activateProject(args.project);
            res = C[fn](args);
            return stringify({ ok: true, result: res });
        } catch (e) {
            var out = { ok: false, error: String(e.message || e), fn: fn };
            try { if (e.extra) out.detail = e.extra; } catch (x) {}

            return stringify(out);
        }
    };
    return C;
})();
