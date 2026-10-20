/* Claude Premiere Bridge — ExtendScript host (ES3). Loaded by the panel with $.evalFile.
   Everything lives in the single namespace CPB. No built-in prototype is modified, no other global
   is created. Every function returns plain data; CPB.call() wraps it as a JSON string.
   Times: Premiere ticks are 254016000000 per second. All results carry seconds and frames. */
// $.evalFile from inside a function would make a plain `var` local to that function; bind the namespace explicitly.
$.global.CPB = (function () {
    var C = { VERSION: "1.3.0" };
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
        else if (a.toTrackIndex !== undefined && a.toTrackIndex !== null) target = cur;
        else fail("give toFrame, toSeconds, deltaFrames, deltaSeconds or toTrackIndex");
        if (target < 0) target = 0;
        var toTrack = (a.toTrackIndex !== undefined && a.toTrackIndex !== null) ? Number(a.toTrackIndex) : null;
        if (a.dryRun) return { dryRun: true, plan: { action: "moveClip", clip: clip.name, from: timeInfo(cur, seq), to: timeInfo(target, seq), toTrack: toTrack === null ? undefined : t.type + " " + toTrack } };
        if (toTrack !== null && toTrack !== (Number(a.trackIndex) || 0)) {
            var dest = trackList(seq, t.type); if (toTrack < 0 || toTrack >= dest.numTracks) fail("track " + toTrack + " doesn't exist (" + dest.numTracks + " " + t.type + " tracks)");
            var qi = qeItemFor(seq, t.type, Number(a.trackIndex) || 0, clip);
            var moved = false; try { moved = !!qi.item.moveToTrack(toTrack - (Number(a.trackIndex) || 0), 0, "0", false); } catch (eMT) { fail("moveToTrack failed: " + eMT.message); }
            var onDest = clipAtStart(dest[toTrack], cur, seq);
            if (!moved || !onDest || Math.abs(secondsOf(onDest.clip.start) - cur) > 0.002) fail("Premiere did not move the clip to " + t.type + " track " + toTrack + " (locked track, or another clip in the way?)");
            t = { track: dest[toTrack], clip: onDest.clip, index: onDest.index, type: t.type }; clip = t.clip; a.trackIndex = toTrack;
            if (target === cur) return { clip: clipInfo(clip, seq, t.type, toTrack, t.index), movedFrom: timeInfo(cur, seq), movedToTrack: t.type + " " + toTrack };
        }
        var ok = false;
        try { clip.move(makeTime(target - cur)); ok = Math.abs(secondsOf(clip.start) - target) < 0.002; } catch (e) {}
        if (!ok) { try { clip.start = makeTime(target); clip.end = makeTime(target + dur); ok = Math.abs(secondsOf(clip.start) - target) < 0.002; } catch (e2) {} }
        if (!ok) fail("Premiere did not move the clip (another clip may be in the way in overwrite-free move).");
        var placed = clipAtStart(t.track, target, seq);
        var res = { clip: clipInfo(placed.clip, seq, t.type, Number(a.trackIndex) || 0, placed.index), movedFrom: timeInfo(cur, seq) };
        if (toTrack !== null) res.movedToTrack = t.type + " " + toTrack;
        return res;
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

    // ---------------------------------------------------------------- versions (duplicate / delete sequences)
    function versionName(base) {
        var p = requireProject(), m = /^(.*) v(\d+)$/.exec(base), root = m ? m[1] : base, n = 1, i;
        for (i = 0; i < p.sequences.numSequences; i++) { var mm = /^(.*) v(\d+)$/.exec(p.sequences[i].name); if (mm && mm[1] === root && Number(mm[2]) > n) n = Number(mm[2]); }
        return root + " v" + (n + 1);
    }
    function seqNamed(name) { var p = requireProject(); for (var i = 0; i < p.sequences.numSequences; i++) if (p.sequences[i].name === name) return p.sequences[i]; return null; }
    function seqSummary(seq) { var o = { id: seq.sequenceID, name: seq.name, fps: round(seqFps(seq)), end: timeInfo(seq.end, seq), videoTracks: seq.videoTracks.numTracks, audioTracks: seq.audioTracks.numTracks, clips: 0 }; try { for (var t = 0; t < seq.videoTracks.numTracks; t++) o.clips += seq.videoTracks[t].clips.numItems; for (var u = 0; u < seq.audioTracks.numTracks; u++) o.clips += seq.audioTracks[u].clips.numItems; } catch (e) {} return o; }
    // sequence.clone() names the copy "<name> Copy" and makes it active; rename it and restore the active sequence.
    C.duplicateSequence = function (a) {
        var p = requireProject(), seq = findSequence(a.sequence);
        var name = a.name ? String(a.name) : versionName(seq.name);
        if (seqNamed(name)) fail("A sequence named '" + name + "' already exists.");
        if (a.dryRun) return { dryRun: true, plan: { action: "duplicateSequence", source: { id: seq.sequenceID, name: seq.name }, name: name, activate: !!a.activate } };
        var wasActive = null; try { wasActive = p.activeSequence; } catch (e0) {}
        var before = {}; for (var i = 0; i < p.sequences.numSequences; i++) before[p.sequences[i].sequenceID] = true;
        var ok = false; try { ok = seq.clone(); } catch (e1) { fail("clone failed: " + e1.message); }
        var copy = null;
        for (var j = 0; j < p.sequences.numSequences; j++) if (!before[p.sequences[j].sequenceID]) copy = p.sequences[j];
        if (!copy) fail("Premiere reported " + ok + " from clone() but no new sequence appeared.");
        try { copy.name = name; } catch (e2) {}
        var notes = [];
        if (copy.name !== name) notes.push("Premiere kept the name '" + copy.name + "'");
        if (!a.activate && wasActive) { try { p.activeSequence = wasActive; } catch (e3) { notes.push("could not restore the active sequence"); } }
        var out = { sequence: seqSummary(copy), source: { id: seq.sequenceID, name: seq.name }, active: p.activeSequence ? p.activeSequence.name : null };
        if (notes.length) out.notes = notes;
        return out;
    };
    C.deleteSequence = function (a) {
        var p = requireProject(), seq = findSequence(a.sequence);
        var versioned = /^.* v\d+$/.test(seq.name) || /^.* Copy( Copy)*$/.test(seq.name);
        if (!versioned && !a.force) fail("'" + seq.name + "' is not a version these tools create (' vN' or ' Copy'); pass force: true to delete it anyway.");
        var info = seqSummary(seq);
        if (a.dryRun) return { dryRun: true, plan: { action: "deleteSequence", sequence: info } };
        var ok = false; try { ok = p.deleteSequence(seq); } catch (e) { fail("deleteSequence failed: " + e.message); }
        if (!ok) fail("Premiere refused to delete '" + info.name + "'.");
        return { deleted: info, remaining: p.sequences.numSequences };
    };

    // ---------------------------------------------------------------- markers (sequence markers)
    var MARKER_COLORS = ["green", "red", "purple", "orange", "yellow", "white", "blue", "cyan"];
    function markerInfo(m, seq, index) {
        var o = { index: index, guid: null, name: "", comments: "", type: null };
        try { o.guid = m.guid; } catch (e0) {}
        try { o.name = m.name; } catch (e1) {}
        try { o.comments = m.comments; } catch (e2) {}
        try { o.type = m.type; } catch (e3) {}
        o.start = timeInfo(m.start, seq); o.end = timeInfo(m.end, seq);
        try { o.duration = timeInfo(secondsOf(m.end) - secondsOf(m.start), seq); } catch (e4) {}
        try { var ci = m.getColorByIndex(); o.colorIndex = ci; o.color = MARKER_COLORS[ci] || String(ci); } catch (e5) {}
        try { if (o.type === "WebLink") { o.url = m.getWebLinkURL(); o.frameTarget = m.getWebLinkFrameTarget(); } } catch (e6) {}
        return o;
    }
    function allMarkers(seq) { var out = [], ms = seq.markers, n = 0; try { n = ms.numMarkers; } catch (e) {} for (var i = 0; i < n; i++) { try { out.push(ms[i]); } catch (e2) {} } return out; }
    function colorIndexArg(c) {
        if (c === undefined || c === null) return null;
        if (typeof c === "number") return c;
        var s = String(c).toLowerCase(); for (var i = 0; i < MARKER_COLORS.length; i++) if (MARKER_COLORS[i] === s) return i;
        if (/^\d+$/.test(s)) return Number(s);
        fail("unknown marker color '" + c + "' (use 0-7 or " + MARKER_COLORS.join("/") + ")");
    }
    C.listMarkers = function (a) {
        var seq = findSequence(a.sequence), ms = allMarkers(seq), out = [];
        var from = timeArg(a, "fromSeconds", "fromFrame", seq), to = timeArg(a, "toSeconds", "toFrame", seq);
        for (var i = 0; i < ms.length; i++) {
            var info = markerInfo(ms[i], seq, i);
            if (from !== null && info.start.seconds < from - 1e-6) continue;
            if (to !== null && info.start.seconds > to + 1e-6) continue;
            if (a.filter && String(info.name + " " + info.comments).toLowerCase().indexOf(String(a.filter).toLowerCase()) < 0) continue;
            out.push(info);
        }
        return { sequence: { id: seq.sequenceID, name: seq.name }, total: ms.length, markers: out };
    };
    C.addMarker = function (a) {
        var seq = findSequence(a.sequence);
        var start = timeArg(a, "startSeconds", "startFrame", seq); if (start === null) fail("give startSeconds or startFrame");
        var end = timeArg(a, "endSeconds", "endFrame", seq);
        var dur = timeArg(a, "durationSeconds", "durationFrames", seq);
        if (end === null && dur !== null) end = start + dur;
        if (end !== null && end < start) fail("end is before start");
        var type = a.type ? String(a.type).toLowerCase() : "comment", ci = colorIndexArg(a.color);
        if (a.dryRun) return { dryRun: true, plan: { action: "addMarker", name: a.name || "", start: timeInfo(start, seq), end: timeInfo(end === null ? start : end, seq), type: type, color: ci === null ? null : (MARKER_COLORS[ci] || ci) } };
        var m = seq.markers.createMarker(start);
        if (!m) fail("Premiere did not create the marker");
        if (a.name !== undefined && a.name !== null) m.name = String(a.name);
        if (a.comments !== undefined && a.comments !== null) m.comments = String(a.comments);
        if (end !== null) { try { m.end = end; } catch (e1) {} }   // numbers in seconds; Time objects / strings throw in 26.5
        var notes = [];
        try {
            if (type === "chapter") m.setTypeAsChapter();
            else if (type === "segmentation") m.setTypeAsSegmentation();
            else if (type === "weblink" || type === "web_link") m.setTypeAsWebLink(String(a.url || ""), String(a.frameTarget || ""));
            else m.setTypeAsComment();
        } catch (e2) { notes.push("type not set: " + e2.message); }
        if (ci !== null) { try { m.setColorByIndex(ci); } catch (e3) { notes.push("color not set: " + e3.message); } }
        var ms = allMarkers(seq), idx = -1; for (var i = 0; i < ms.length; i++) { try { if (ms[i].guid === m.guid) idx = i; } catch (e4) {} }
        var out = { marker: markerInfo(m, seq, idx), total: ms.length };
        if (notes.length) out.notes = notes;
        return out;
    };
    C.removeMarkers = function (a) {
        var seq = findSequence(a.sequence), ms = allMarkers(seq), victims = [], i;
        var from = timeArg(a, "fromSeconds", "fromFrame", seq), to = timeArg(a, "toSeconds", "toFrame", seq);
        var guids = {}, hasGuids = false; if (a.guids && a.guids.length) { hasGuids = true; for (i = 0; i < a.guids.length; i++) guids[String(a.guids[i])] = true; }
        var idxs = {}, hasIdx = false; if (a.indexes && a.indexes.length) { hasIdx = true; for (i = 0; i < a.indexes.length; i++) idxs[Number(a.indexes[i])] = true; }
        if (!a.all && !hasGuids && !hasIdx && from === null && to === null && !a.filter) fail("give guids, indexes, a time range (fromFrame/toFrame), a name filter, or all: true");
        for (i = 0; i < ms.length; i++) {
            var info = markerInfo(ms[i], seq, i), hit = true;
            if (hasGuids && !guids[String(info.guid)]) hit = false;
            if (hasIdx && !idxs[i]) hit = false;
            if (from !== null && info.start.seconds < from - 1e-6) hit = false;
            if (to !== null && info.start.seconds > to + 1e-6) hit = false;
            if (a.filter && String(info.name + " " + info.comments).toLowerCase().indexOf(String(a.filter).toLowerCase()) < 0) hit = false;
            if (hit) victims.push({ marker: ms[i], info: info });
        }
        var planned = []; for (i = 0; i < victims.length; i++) planned.push(victims[i].info);
        if (a.dryRun) return { dryRun: true, plan: { action: "removeMarkers", markers: planned } };
        for (i = victims.length - 1; i >= 0; i--) { try { seq.markers.deleteMarker(victims[i].marker); } catch (e) { fail("deleteMarker failed on '" + victims[i].info.name + "': " + e.message); } }
        return { removed: planned, remaining: seq.markers.numMarkers };
    };

    // ---------------------------------------------------------------- sequence range (in/out points, work area)
    function rangeInfo(seq) {
        var o = {};
        try { o.inPoint = timeInfo(seq.getInPointAsTime(), seq); o.outPoint = timeInfo(seq.getOutPointAsTime(), seq); } catch (e0) {}
        try { o.workArea = { enabled: !!seq.isWorkAreaEnabled(), inPoint: timeInfo(seq.getWorkAreaInPointAsTime(), seq), outPoint: timeInfo(seq.getWorkAreaOutPointAsTime(), seq) }; } catch (e1) {}
        o.end = timeInfo(seq.end, seq);
        return o;
    }
    C.sequenceRange = function (a) {
        var seq = findSequence(a.sequence);
        var inS = timeArg(a, "inSeconds", "inFrame", seq), outS = timeArg(a, "outSeconds", "outFrame", seq);
        var waIn = timeArg(a, "workAreaInSeconds", "workAreaInFrame", seq), waOut = timeArg(a, "workAreaOutSeconds", "workAreaOutFrame", seq);
        var wantsSet = inS !== null || outS !== null || waIn !== null || waOut !== null || (a.workAreaEnabled !== undefined && a.workAreaEnabled !== null);
        if (!wantsSet) return { sequence: { id: seq.sequenceID, name: seq.name }, range: rangeInfo(seq) };
        if (a.dryRun) return { dryRun: true, plan: { action: "sequenceRange", inPoint: inS === null ? null : timeInfo(inS, seq), outPoint: outS === null ? null : timeInfo(outS, seq), workAreaIn: waIn === null ? null : timeInfo(waIn, seq), workAreaOut: waOut === null ? null : timeInfo(waOut, seq), workAreaEnabled: a.workAreaEnabled === undefined ? null : !!a.workAreaEnabled } };
        var notes = [];
        if (inS !== null) { try { seq.setInPoint(inS); } catch (e0) { notes.push("setInPoint: " + e0.message); } }
        if (outS !== null) { try { seq.setOutPoint(outS); } catch (e1) { notes.push("setOutPoint: " + e1.message); } }
        if (a.workAreaEnabled !== undefined && a.workAreaEnabled !== null) { try { seq.setWorkAreaEnabled(!!a.workAreaEnabled); } catch (e2) { notes.push("setWorkAreaEnabled: " + e2.message); } }
        if (waIn !== null || waOut !== null) {
            // Premiere 26.5 accepts these calls (DOM and QE) but leaves the work area unchanged; try both, then verify.
            try { if (waOut !== null) seq.setWorkAreaOutPoint(waOut); if (waIn !== null) seq.setWorkAreaInPoint(waIn); } catch (e3) {}
            var gotIn = secondsOf(seq.getWorkAreaInPointAsTime()), gotOut = secondsOf(seq.getWorkAreaOutPointAsTime());
            var okIn = waIn === null || Math.abs(gotIn - waIn) < 0.002, okOut = waOut === null || Math.abs(gotOut - waOut) < 0.002;
            if (!okIn || !okOut) {
                try { var q = qeSequence(seq); q.setWorkInOutPoints(tcOf(waIn === null ? gotIn : waIn, seqFps(seq)), tcOf(waOut === null ? gotOut : waOut, seqFps(seq))); } catch (e4) {}
                gotIn = secondsOf(seq.getWorkAreaInPointAsTime()); gotOut = secondsOf(seq.getWorkAreaOutPointAsTime());
                okIn = waIn === null || Math.abs(gotIn - waIn) < 0.002; okOut = waOut === null || Math.abs(gotOut - waOut) < 0.002;
            }
            if (!okIn || !okOut) notes.push("Premiere's scripting API accepted the work-area change but did not apply it (known in 26.5); set the in/out points instead and render with range: inout.");
        }
        var out = { sequence: { id: seq.sequenceID, name: seq.name }, range: rangeInfo(seq) };
        if (notes.length) out.notes = notes;
        return out;
    };

    // ---------------------------------------------------------------- effects (clip components), via DOM + QE
    // QE track items include gaps and transitions, so a DOM clip is matched to its QE item by start ticks, never by index.
    function qeItemFor(seq, type, trackIndex, clip) {
        var q = qeSequence(seq);
        var qt = type === "audio" ? q.getAudioTrackAt(trackIndex) : q.getVideoTrackAt(trackIndex);
        if (!qt) fail("QE can't address " + type + " track " + trackIndex);
        var want = String(clip.start.ticks), tc = tcOf(secondsOf(clip.start), seqFps(seq));
        for (var i = 0; i < qt.numItems; i++) { var it = qt.getItemAt(i); try { if (it.type === "Clip" && String(it.start.ticks) === want) return { track: qt, item: it }; } catch (e) {} }
        for (var j = 0; j < qt.numItems; j++) { var it2 = qt.getItemAt(j); try { if (it2.type === "Clip" && String(it2.start.timecode) === tc) return { track: qt, item: it2 }; } catch (e2) {} }
        fail("QE can't find clip '" + clip.name + "' at " + tc + " on " + type + " track " + trackIndex);
    }
    // Component keyframe times are in the clip's SOURCE time (stills start at 01:00:00:00), not sequence time.
    function clipSpeedFactor(clip) { var sp = 1; try { sp = clip.getSpeed(); } catch (e) {} if (!sp) return 1; return sp > 10 ? sp / 100 : sp; }
    function srcTime(clip, seqSeconds) { return secondsOf(clip.inPoint) + (seqSeconds - secondsOf(clip.start)) * clipSpeedFactor(clip); }
    function seqTimeOf(clip, srcSeconds) { return secondsOf(clip.start) + (srcSeconds - secondsOf(clip.inPoint)) / clipSpeedFactor(clip); }
    function propValue(pr) { var v = null; try { v = pr.getValue(); } catch (e) { try { v = pr.getColorValue(); } catch (e2) { v = null; } } return v; }
    function componentInfo(comp, index, clip, seq, withKeys) {
        var o = { index: index, name: comp.displayName, matchName: comp.matchName, properties: [] };
        for (var p = 0; p < comp.properties.numItems; p++) {
            var pr = comp.properties[p], pi = { index: p, name: pr.displayName, value: propValue(pr) };
            try { pi.timeVarying = pr.isTimeVarying(); } catch (e) {}
            if (pi.timeVarying && withKeys !== false) {
                pi.keys = [];
                try { var ks = pr.getKeys(); if (ks) for (var k = 0; k < ks.length; k++) { var kt = secondsOf(ks[k]); pi.keys.push({ time: timeInfo(seqTimeOf(clip, kt), seq), sourceSeconds: round(kt), value: pr.getValueAtKey(ks[k]) }); } } catch (e2) {}
            }
            o.properties.push(pi);
        }
        return o;
    }
    function findComponent(clip, ref) {
        if (ref === undefined || ref === null || ref === "") fail("give component (name, matchName or index)");
        if (typeof ref === "number" || /^\d+$/.test(String(ref))) { var i = Number(ref); if (i < 0 || i >= clip.components.numItems) fail("component index " + i + " out of range (clip has " + clip.components.numItems + ")"); return { comp: clip.components[i], index: i }; }
        var r = String(ref).toLowerCase(), hits = [], c;
        for (c = 0; c < clip.components.numItems; c++) { var comp = clip.components[c]; if (String(comp.displayName).toLowerCase() === r || String(comp.matchName).toLowerCase() === r) hits.push({ comp: comp, index: c }); }
        if (!hits.length) for (c = 0; c < clip.components.numItems; c++) { var comp2 = clip.components[c]; if (String(comp2.displayName).toLowerCase().indexOf(r) >= 0) hits.push({ comp: comp2, index: c }); }
        if (hits.length === 1) return hits[0];
        if (hits.length > 1) fail("'" + ref + "' matches " + hits.length + " components; use the index from pr_get_clip_effects");
        fail("component '" + ref + "' not found on clip '" + clip.name + "'");
    }
    function findProperty(comp, ref) {
        if (ref === undefined || ref === null || ref === "") fail("give property (name or index)");
        if (typeof ref === "number" || /^\d+$/.test(String(ref))) { var i = Number(ref); if (i < 0 || i >= comp.properties.numItems) fail("property index " + i + " out of range"); return { prop: comp.properties[i], index: i }; }
        var r = String(ref).toLowerCase(), hits = [], p;
        for (p = 0; p < comp.properties.numItems; p++) if (String(comp.properties[p].displayName).toLowerCase() === r) hits.push({ prop: comp.properties[p], index: p });
        if (!hits.length) for (p = 0; p < comp.properties.numItems; p++) if (String(comp.properties[p].displayName).toLowerCase().indexOf(r) >= 0) hits.push({ prop: comp.properties[p], index: p });
        if (hits.length === 1) return hits[0];
        if (hits.length > 1) fail("'" + ref + "' matches " + hits.length + " properties of " + comp.displayName + "; use the index");
        fail("property '" + ref + "' not found on " + comp.displayName);
    }
    function effectCatalog(type) { try { app.enableQE(); } catch (e) { fail("QE DOM unavailable"); } var list = type === "audio" ? qe.project.getAudioEffectList() : qe.project.getVideoEffectList(); var out = []; for (var i = 0; i < list.length; i++) out.push(String(list[i])); return out; }
    function pickByName(list, ref, what) {
        var r = String(ref), hits = [], i, seen = {};
        for (i = 0; i < list.length; i++) if (list[i] === r) return list[i];
        for (i = 0; i < list.length; i++) if (list[i].toLowerCase() === r.toLowerCase() && !seen[list[i]]) { hits.push(list[i]); seen[list[i]] = true; }
        if (!hits.length) for (i = 0; i < list.length; i++) if (list[i].toLowerCase().indexOf(r.toLowerCase()) >= 0 && !seen[list[i]]) { hits.push(list[i]); seen[list[i]] = true; }
        if (hits.length === 1) return hits[0];
        if (hits.length > 1) fail("'" + ref + "' matches " + hits.length + " " + what + ": " + hits.slice(0, 8).join(", ") + (hits.length > 8 ? ", …" : ""));
        fail(what + " '" + ref + "' not found");
    }
    C.getClipEffects = function (a) {
        var seq = findSequence(a.sequence), t = findClipArg(seq, a);
        var out = { clip: clipInfo(t.clip, seq, t.type, Number(a.trackIndex) || 0, t.index), components: [] };
        for (var c = 0; c < t.clip.components.numItems; c++) {
            var comp = t.clip.components[c];
            if (a.component !== undefined && a.component !== null && a.component !== "") { var want = String(a.component).toLowerCase(); if (String(comp.displayName).toLowerCase().indexOf(want) < 0 && String(comp.matchName).toLowerCase() !== want && String(c) !== want) continue; }
            out.components.push(componentInfo(comp, c, t.clip, seq, a.keys !== false));
        }
        return out;
    };
    C.listEffects = function (a) {
        var all = effectCatalog(a.type), out = [], f = a.filter ? String(a.filter).toLowerCase() : null, seen = {};
        for (var i = 0; i < all.length; i++) { if (seen[all[i]]) continue; seen[all[i]] = true; if (!f || all[i].toLowerCase().indexOf(f) >= 0) out.push(all[i]); }
        return { type: a.type === "audio" ? "audio" : "video", total: all.length, effects: out };
    };
    C.addEffect = function (a) {
        var seq = findSequence(a.sequence), t = findClipArg(seq, a);
        if (!a.effect) fail("effect name is required (see pr_list_effects)");
        var name = pickByName(effectCatalog(t.type), a.effect, t.type + " effects");
        var fx = t.type === "audio" ? qe.project.getAudioEffectByName(name) : qe.project.getVideoEffectByName(name);
        if (!fx) fail("QE returned no effect object for '" + name + "'");
        if (a.dryRun) return { dryRun: true, plan: { action: "addEffect", clip: t.clip.name, effect: name } };
        var before = t.clip.components.numItems;
        var qi = qeItemFor(seq, t.type, Number(a.trackIndex) || 0, t.clip);
        var ok = t.type === "audio" ? qi.item.addAudioEffect(fx) : qi.item.addVideoEffect(fx);
        var comps = [];
        for (var c = 0; c < t.clip.components.numItems; c++) comps.push({ index: c, name: t.clip.components[c].displayName, matchName: t.clip.components[c].matchName });
        if (!ok || comps.length === before) fail("Premiere did not add '" + name + "' to '" + t.clip.name + "' (some effects don't apply to this clip type)");
        var last = comps[comps.length - 1];
        return { clip: t.clip.name, effect: name, added: comps.slice(before), components: comps, component: componentInfo(t.clip.components[last.index], last.index, t.clip, seq, false) };
    };
    C.setEffectProperty = function (a) {
        var seq = findSequence(a.sequence), t = findClipArg(seq, a), clip = t.clip;
        var fc = findComponent(clip, a.component), fp = findProperty(fc.comp, a.property), pr = fp.prop;
        var before = propValue(pr), i;
        function keyTime(k) { var sec = timeArg(k, "seconds", "frame", seq); if (sec === null) fail("each key needs frame or seconds (sequence time)"); return sec; }
        var keys = (a.keys && a.keys.length) ? a.keys : null;
        var plan = { action: "setEffectProperty", clip: clip.name, component: fc.comp.displayName, property: pr.displayName, before: before };
        if (a.value !== undefined && a.value !== null) plan.value = a.value;
        if (keys) { plan.keys = []; for (i = 0; i < keys.length; i++) plan.keys.push({ time: timeInfo(keyTime(keys[i]), seq), sourceSeconds: round(srcTime(clip, keyTime(keys[i]))), value: keys[i].value }); }
        if (a.clearKeys) plan.clearKeys = true;
        if (!keys && !a.clearKeys && (a.value === undefined || a.value === null)) fail("give value, keys, or clearKeys");
        if (a.dryRun) return { dryRun: true, plan: plan };
        if (a.clearKeys || keys) { try { if (pr.isTimeVarying()) { var ks = pr.getKeys(); if (ks) for (var r = ks.length - 1; r >= 0; r--) pr.removeKey(ks[r]); } } catch (e1) {} }
        if (a.clearKeys && !keys) { try { pr.setTimeVarying(false); } catch (e2) {} }
        if (a.value !== undefined && a.value !== null && !keys) {
            try { if (pr.isTimeVarying()) pr.setTimeVarying(false); } catch (e3) {}
            var isColor = false; try { isColor = (before === null || before === undefined) && isArray(a.value) && a.value.length >= 3; } catch (e4) {}
            if (isColor) pr.setColorValue(a.value[0], a.value[1], a.value[2], a.value.length > 3 ? a.value[3] : 255, true); else pr.setValue(a.value, true);
        }
        if (keys) {
            var supported = true; try { supported = pr.areKeyframesSupported(); } catch (e5) {}
            if (!supported) fail("'" + pr.displayName + "' doesn't support keyframes");
            pr.setTimeVarying(true);
            for (i = 0; i < keys.length; i++) { var tt = makeTime(srcTime(clip, keyTime(keys[i]))); pr.addKey(tt); pr.setValueAtKey(tt, keys[i].value, true); }
        }
        var info = componentInfo(fc.comp, fc.index, clip, seq, true);
        var out = { clip: clip.name, component: fc.comp.displayName, property: info.properties[fp.index], before: before };
        if (/Opacity/.test(String(fc.comp.matchName))) out.note = "Opacity values read back but did not change exported frames in Premiere 26.5 tests; verify in the Program Monitor.";
        return out;
    };

    // ---------------------------------------------------------------- transitions (QE adds, DOM lists/removes)
    function transitionsOf(track, seq) {
        var out = [], n = 0; try { n = track.transitions.numItems; } catch (e) {}
        for (var i = 0; i < n; i++) {
            var tr = track.transitions[i], o = { index: i };
            try { o.name = tr.name; } catch (e1) {} try { o.nodeId = tr.nodeId; } catch (e2) {}
            try { o.start = timeInfo(tr.start, seq); o.end = timeInfo(tr.end, seq); o.duration = timeInfo(secondsOf(tr.end) - secondsOf(tr.start), seq); } catch (e3) {}
            out.push(o);
        }
        return out;
    }
    function transitionCatalog(type) { try { app.enableQE(); } catch (e) { fail("QE DOM unavailable"); } var list = type === "audio" ? qe.project.getAudioTransitionList() : qe.project.getVideoTransitionList(); var out = []; for (var i = 0; i < list.length; i++) out.push(String(list[i])); return out; }
    C.listTransitions = function (a) {
        if (a.catalog) {
            var all = transitionCatalog(a.type), out = [], f = a.filter ? String(a.filter).toLowerCase() : null, seen = {};
            for (var i = 0; i < all.length; i++) { if (seen[all[i]]) continue; seen[all[i]] = true; if (a.includeLegacy === false && /Legacy|Obsolete/.test(all[i])) continue; if (!f || all[i].toLowerCase().indexOf(f) >= 0) out.push(all[i]); }
            return { type: a.type === "audio" ? "audio" : "video", total: all.length, transitions: out };
        }
        var seq = findSequence(a.sequence), type = a.trackType === "audio" ? "audio" : "video", idx = Number(a.trackIndex) || 0;
        var track = requireTrack(seq, type, idx);
        return { track: type + " " + idx, transitions: transitionsOf(track, seq) };
    };
    C.addTransition = function (a) {
        var seq = findSequence(a.sequence), t = findClipArg(seq, a), idx = Number(a.trackIndex) || 0;
        var name = pickByName(transitionCatalog(t.type), a.transition || "Cross Dissolve", t.type + " transitions");
        var tr = t.type === "audio" ? qe.project.getAudioTransitionByName(name) : qe.project.getVideoTransitionByName(name);
        if (!tr) fail("QE returned no transition object for '" + name + "'");
        var dur = timeArg(a, "durationSeconds", "durationFrames", seq); if (dur === null) dur = 1;
        var pos = a.position === "start" || a.position === "both" ? a.position : "end";
        var tc = tcOf(dur, seqFps(seq));
        if (a.dryRun) return { dryRun: true, plan: { action: "addTransition", clip: t.clip.name, transition: name, position: pos, duration: timeInfo(dur, seq) } };
        var before = transitionsOf(t.track, seq).length;
        var qi = qeItemFor(seq, t.type, idx, t.clip), results = [];
        if (pos === "start" || pos === "both") results.push({ at: "start", ok: !!qi.item.addTransition(tr, true, tc) });
        if (pos === "end" || pos === "both") results.push({ at: "end", ok: !!qi.item.addTransition(tr, false, tc) });
        var after = transitionsOf(t.track, seq);
        if (after.length === before) fail("Premiere did not add '" + name + "' (a transition needs handles on the clip; check in/out points)");
        return { clip: t.clip.name, transition: name, position: pos, duration: timeInfo(dur, seq), added: after.length - before, transitions: after };
    };
    C.removeTransitions = function (a) {
        var seq = findSequence(a.sequence), type = a.trackType === "audio" ? "audio" : "video", idx = Number(a.trackIndex) || 0;
        var track = requireTrack(seq, type, idx), list = transitionsOf(track, seq), victims = [], i;
        var at = timeArg(a, "atSeconds", "atFrame", seq);
        var idxs = {}, hasIdx = false; if (a.indexes && a.indexes.length) { hasIdx = true; for (i = 0; i < a.indexes.length; i++) idxs[Number(a.indexes[i])] = true; }
        if (!a.all && !hasIdx && at === null && !a.filter) fail("give indexes, atFrame/atSeconds, a name filter, or all: true");
        for (i = 0; i < list.length; i++) {
            var tr = list[i], hit = true;
            if (hasIdx && !idxs[i]) hit = false;
            if (at !== null && !(tr.start && tr.start.seconds <= at + 1e-6 && tr.end.seconds >= at - 1e-6)) hit = false;
            if (a.filter && String(tr.name || "").toLowerCase().indexOf(String(a.filter).toLowerCase()) < 0) hit = false;
            if (hit) victims.push(tr);
        }
        if (a.dryRun) return { dryRun: true, plan: { action: "removeTransitions", track: type + " " + idx, transitions: victims } };
        for (i = victims.length - 1; i >= 0; i--) {
            var obj = track.transitions[victims[i].index], ok = false;
            try { obj.remove(false, false); ok = true; } catch (e1) { try { obj.remove(); ok = true; } catch (e2) {} }
            if (!ok) fail("Premiere refused to remove transition '" + victims[i].name + "' at " + (victims[i].start ? victims[i].start.timecode : "?"));
        }
        return { removed: victims, remaining: transitionsOf(track, seq) };
    };

    // ---------------------------------------------------------------- split / trim (razor via QE, trims via DOM)
    C.splitClip = function (a) {
        var seq = findSequence(a.sequence), at = timeArg(a, "atSeconds", "atFrame", seq);
        if (at === null) fail("give atFrame or atSeconds");
        var tc = tcOf(at, seqFps(seq)), targets = [], i;
        if (a.allTracks) { for (i = 0; i < seq.videoTracks.numTracks; i++) targets.push({ type: "video", index: i }); for (i = 0; i < seq.audioTracks.numTracks; i++) targets.push({ type: "audio", index: i }); }
        else targets.push({ type: a.trackType === "audio" ? "audio" : "video", index: Number(a.trackIndex) || 0 });
        if (a.dryRun) return { dryRun: true, plan: { action: "splitClip", at: timeInfo(at, seq), timecode: tc, tracks: targets } };
        var q = qeSequence(seq), out = [];
        for (i = 0; i < targets.length; i++) {
            var tg = targets[i], track = trackList(seq, tg.type)[tg.index], before = track.clips.numItems, ok = false, err = null;
            var hasClip = false; for (var c = 0; c < track.clips.numItems; c++) { var cl = track.clips[c]; if (secondsOf(cl.start) < at - 1e-6 && secondsOf(cl.end) > at + 1e-6) hasClip = true; }
            if (!hasClip) { out.push({ track: tg.type + " " + tg.index, split: false, note: "no clip spans that time" }); continue; }
            try { var qt = tg.type === "audio" ? q.getAudioTrackAt(tg.index) : q.getVideoTrackAt(tg.index); ok = !!qt.razor(tc); } catch (e) { err = e.message; }
            out.push({ track: tg.type + " " + tg.index, split: ok && track.clips.numItems > before, clipsBefore: before, clipsAfter: track.clips.numItems, error: err || undefined });
        }
        return { at: timeInfo(at, seq), timecode: tc, tracks: out };
    };
    C.trimClip = function (a) {
        var seq = findSequence(a.sequence), t = findClipArg(seq, a), clip = t.clip;
        var s0 = secondsOf(clip.start), e0 = secondsOf(clip.end), i0 = secondsOf(clip.inPoint), o0 = secondsOf(clip.outPoint), sp = clipSpeedFactor(clip);
        var ns = timeArg(a, "startSeconds", "startFrame", seq), ne = timeArg(a, "endSeconds", "endFrame", seq);
        var ds = timeArg(a, "startDeltaSeconds", "startDeltaFrames", seq), de = timeArg(a, "endDeltaSeconds", "endDeltaFrames", seq);
        if (ns === null && ds !== null) ns = s0 + ds; if (ne === null && de !== null) ne = e0 + de;
        if (ns === null && ne === null) fail("give startFrame/startSeconds/startDeltaFrames and/or endFrame/endSeconds/endDeltaFrames");
        if (ns === null) ns = s0; if (ne === null) ne = e0;
        if (ne - ns < 1e-6) fail("end must be after start");
        var ni = i0 + (ns - s0) * sp, no = o0 + (ne - e0) * sp;
        if (ni < 0) fail("start trim would need media before the source's first frame (in point " + round(ni) + "s)");
        var plan = { action: "trimClip", clip: clip.name, before: { start: timeInfo(s0, seq), end: timeInfo(e0, seq), inPoint: timeInfo(i0, seq), outPoint: timeInfo(o0, seq) }, after: { start: timeInfo(ns, seq), end: timeInfo(ne, seq), inPoint: timeInfo(ni, seq), outPoint: timeInfo(no, seq) } };
        if (a.dryRun) return { dryRun: true, plan: plan };
        // extending needs the source range first, shortening needs the timeline range first
        if (ne > e0) { clip.outPoint = makeTime(no); clip.end = makeTime(ne); } else if (ne < e0) { clip.end = makeTime(ne); clip.outPoint = makeTime(no); }
        if (ns < s0) { clip.inPoint = makeTime(ni); clip.start = makeTime(ns); } else if (ns > s0) { clip.start = makeTime(ns); clip.inPoint = makeTime(ni); }
        var warnings = [];
        if (Math.abs(secondsOf(clip.start) - ns) > 0.002 || Math.abs(secondsOf(clip.end) - ne) > 0.002) warnings.push("Premiere clamped the timeline range (another clip in the way, or no media handle)");
        if (Math.abs(secondsOf(clip.inPoint) - ni) > 0.002 || Math.abs(secondsOf(clip.outPoint) - no) > 0.002) warnings.push("Premiere clamped the source range (not enough media)");
        var placed = clipAtStart(t.track, secondsOf(clip.start), seq);
        var out = { clip: clipInfo(placed.clip, seq, t.type, Number(a.trackIndex) || 0, placed.index), before: plan.before };
        if (warnings.length) out.warnings = warnings;
        return out;
    };

    // ---------------------------------------------------------------- audio levels (Volume > Level; Premiere stores 10^((dB-15)/20))
    function dbToLevel(db) { return Math.pow(10, (db - 15) / 20); }
    function levelToDb(v) { return v <= 0 ? -Infinity : 20 * Math.log(v) / Math.LN10 + 15; }
    function levelProp(clip) {
        for (var c = 0; c < clip.components.numItems; c++) {
            var comp = clip.components[c];
            if (!/Volume/i.test(String(comp.displayName)) && !/Volume/i.test(String(comp.matchName))) continue;
            for (var p = 0; p < comp.properties.numItems; p++) if (/^Level$/i.test(String(comp.properties[p].displayName))) return { comp: comp, prop: comp.properties[p], compIndex: c, propIndex: p };
        }
        return null;
    }
    C.setClipVolume = function (a) {
        a.trackType = "audio";
        var seq = findSequence(a.sequence), t = findClipArg(seq, a), clip = t.clip;
        var lp = levelProp(clip); if (!lp) fail("clip '" + clip.name + "' has no Volume > Level (not an audio clip?)");
        var before = lp.prop.getValue(), beforeDb = round(levelToDb(before));
        var keys = (a.keys && a.keys.length) ? a.keys : null, i;
        function keyTime(k) { var sec = timeArg(k, "seconds", "frame", seq); if (sec === null) fail("each key needs frame or seconds (sequence time)"); return sec; }
        var plan = { action: "setClipVolume", clip: clip.name, track: "audio " + (Number(a.trackIndex) || 0), beforeDb: beforeDb };
        if (a.db !== undefined && a.db !== null) plan.db = Number(a.db);
        if (keys) { plan.keys = []; for (i = 0; i < keys.length; i++) plan.keys.push({ time: timeInfo(keyTime(keys[i]), seq), db: Number(keys[i].db) }); }
        if (a.clearKeys) plan.clearKeys = true;
        if (!keys && !a.clearKeys && (a.db === undefined || a.db === null)) fail("give db, keys, or clearKeys");
        if (a.dryRun) return { dryRun: true, plan: plan };
        if (a.clearKeys || keys) { try { if (lp.prop.isTimeVarying()) { var ks = lp.prop.getKeys(); if (ks) for (var r = ks.length - 1; r >= 0; r--) lp.prop.removeKey(ks[r]); } } catch (e1) {} }
        if (a.clearKeys && !keys) { try { lp.prop.setTimeVarying(false); } catch (e2) {} }
        if (a.db !== undefined && a.db !== null && !keys) { try { if (lp.prop.isTimeVarying()) lp.prop.setTimeVarying(false); } catch (e3) {} lp.prop.setValue(dbToLevel(Number(a.db)), true); }
        if (keys) {
            lp.prop.setTimeVarying(true);
            for (i = 0; i < keys.length; i++) { var tt = makeTime(srcTime(clip, keyTime(keys[i]))); lp.prop.addKey(tt); lp.prop.setValueAtKey(tt, dbToLevel(Number(keys[i].db)), true); }
        }
        var info = componentInfo(lp.comp, lp.compIndex, clip, seq, true).properties[lp.propIndex];
        info.db = round(levelToDb(info.value));
        if (info.keys) for (i = 0; i < info.keys.length; i++) info.keys[i].db = round(levelToDb(info.keys[i].value));
        return { clip: clip.name, track: "audio " + (Number(a.trackIndex) || 0), level: info, beforeDb: beforeDb };
    };

    // ---------------------------------------------------------------- graphics (native Text components + AE Motion Graphics Templates)
    function parseMaybeJSON(s) { try { if (typeof s === "string" && /^\s*\{/.test(s)) return C.parse(s); } catch (e) {} return null; }
    function graphicTexts(clip) {
        var out = [], c, p;
        var m = null; try { m = clip.getMGTComponent(); } catch (e0) {}
        if (m) {
            for (p = 0; p < m.properties.numItems; p++) {
                var pr = m.properties[p], v = null; try { v = pr.getValue(); } catch (e1) {}
                var j = parseMaybeJSON(v);
                if (j && j.textEditValue !== undefined) out.push({ kind: "mogrt", param: pr.displayName, paramIndex: p, text: j.textEditValue, font: j.fontEditValue, fontSize: j.fontSizeEditValue });
                else if (pr.displayName) out.push({ kind: "mogrt-param", param: pr.displayName, paramIndex: p, value: (typeof v === "string" && v.length > 80) ? v.substr(0, 80) + "…" : v });
            }
        }
        for (c = 0; c < clip.components.numItems; c++) {
            var comp = clip.components[c]; if (String(comp.matchName) !== "AE.ADBE Text") continue;
            var st = null; for (p = 0; p < comp.properties.numItems; p++) if (/Source Text/i.test(String(comp.properties[p].displayName))) st = { prop: comp.properties[p], index: p };
            if (!st) continue;
            var tv = null; try { tv = st.prop.getValue(); } catch (e2) {}
            var txt = typeof tv === "string" ? tv : String(tv);
            if (txt.length <= 2 && txt.charCodeAt(0) > 255) txt = "(binary text document; set it with pr_set_graphic_text to read it back as plain text)";
            out.push({ kind: "text-layer", componentIndex: c, propertyIndex: st.index, text: txt });
        }
        return out;
    }
    C.getGraphicText = function (a) {
        var seq = findSequence(a.sequence), t = findClipArg(seq, a);
        var isMGT = false; try { isMGT = t.clip.isMGT(); } catch (e) {}
        return { clip: clipInfo(t.clip, seq, t.type, Number(a.trackIndex) || 0, t.index), isGraphic: isMGT, texts: graphicTexts(t.clip) };
    };
    C.setGraphicText = function (a) {
        var seq = findSequence(a.sequence), t = findClipArg(seq, a), clip = t.clip;
        var texts = graphicTexts(clip), targets = [], i;
        if (!a.text && a.text !== "") fail("text is required");
        var sel = a.target; // param name / "text-layer:N" / index into texts / undefined → first text
        for (i = 0; i < texts.length; i++) {
            var x = texts[i];
            if (x.kind === "mogrt-param") continue;
            if (sel === undefined || sel === null || sel === "") { targets.push(x); break; }
            if (typeof sel === "number" && i === sel) targets.push(x);
            else if (x.kind === "mogrt" && String(x.param).toLowerCase() === String(sel).toLowerCase()) targets.push(x);
            else if (x.kind === "text-layer" && (String(sel) === "text-layer:" + x.componentIndex || String(sel) === String(x.componentIndex))) targets.push(x);
        }
        if (!targets.length) fail(texts.length ? "no text target matches '" + sel + "'; targets: " + (function () { var n = []; for (var k = 0; k < texts.length; k++) if (texts[k].kind !== "mogrt-param") n.push(texts[k].kind === "mogrt" ? texts[k].param : "text-layer:" + texts[k].componentIndex); return n.join(", "); })() : "clip '" + clip.name + "' has no editable text");
        if (a.dryRun) return { dryRun: true, plan: { action: "setGraphicText", clip: clip.name, targets: targets, text: a.text } };
        var done = [];
        for (i = 0; i < targets.length; i++) {
            var tg = targets[i];
            if (tg.kind === "mogrt") {
                var m = clip.getMGTComponent(), pr = m.properties[tg.paramIndex], j = parseMaybeJSON(pr.getValue());
                j.textEditValue = String(a.text);
                if (j.fontTextRunLength && j.fontTextRunLength.length === 1) j.fontTextRunLength = [String(a.text).length];
                if (a.font) { j.fontEditValue = [String(a.font)]; }
                if (a.fontSize) { j.fontSizeEditValue = [Number(a.fontSize)]; }
                pr.setValue(C.stringify(j), true);
                var back = parseMaybeJSON(pr.getValue());
                done.push({ target: tg.param, text: back ? back.textEditValue : null, ok: !!back && back.textEditValue === String(a.text) });
            } else {
                var comp = clip.components[tg.componentIndex], sp = comp.properties[tg.propertyIndex];
                sp.setValue(String(a.text), true);
                var v2 = String(sp.getValue());
                done.push({ target: "text-layer:" + tg.componentIndex, text: v2, ok: v2 === String(a.text) });
            }
        }
        return { clip: clip.name, set: done };
    };
    C.addGraphic = function (a) {
        var seq = findSequence(a.sequence);
        var f = new File(String(a.path || "")); if (!f.exists) fail("MOGRT not found: " + f.fsName);
        var at = timeArg(a, "startSeconds", "startFrame", seq); if (at === null) at = 0;
        var vIdx = a.trackIndex !== undefined && a.trackIndex !== null ? Number(a.trackIndex) : 1, aIdx = a.audioTrackIndex !== undefined && a.audioTrackIndex !== null ? Number(a.audioTrackIndex) : 0;
        if (vIdx >= seq.videoTracks.numTracks) fail("video track " + vIdx + " doesn't exist (" + seq.videoTracks.numTracks + " tracks); add one with pr_add_tracks");
        if (a.dryRun) return { dryRun: true, plan: { action: "addGraphic", mogrt: f.fsName, start: timeInfo(at, seq), track: "video " + vIdx } };
        var track = seq.videoTracks[vIdx], before = track.clips.numItems;
        var r = null; try { r = seq.importMGT(f.fsName, String(Math.round(at * TICKS)), vIdx, aIdx); } catch (e) { fail("importMGT failed: " + e.message); }
        var waited = 0; while (track.clips.numItems === before && waited < 5000) { $.sleep(250); waited += 250; }
        if (track.clips.numItems === before) fail("Premiere did not add the graphic (importMGT returned " + String(r) + ")");
        var placed = clipAtStart(track, at, seq), clip = placed.clip;
        if (a.name) { try { clip.name = String(a.name); } catch (e2) {} }
        var out = { clip: clipInfo(clip, seq, "video", vIdx, placed.index), texts: graphicTexts(clip) };
        if (a.duration !== undefined && a.duration !== null) {
            var dur = Number(a.duration), ne = at + dur;
            try { if (ne > secondsOf(clip.end)) { clip.outPoint = makeTime(secondsOf(clip.inPoint) + dur); clip.end = makeTime(ne); } else { clip.end = makeTime(ne); clip.outPoint = makeTime(secondsOf(clip.inPoint) + dur); } out.clip = clipInfo(clip, seq, "video", vIdx, placed.index); } catch (e3) { out.warning = "duration not applied: " + e3.message; }
        }
        return out;
    };

    // ---------------------------------------------------------------- close a gap on every track (ripple left)
    C.closeGap = function (a) {
        var seq = findSequence(a.sequence);
        var from = timeArg(a, "fromSeconds", "fromFrame", seq), to = timeArg(a, "toSeconds", "toFrame", seq);
        if (from === null || to === null || to <= from) fail("give fromSeconds/toSeconds (to > from)");
        var shift = to - from, moved = 0, blocked = [], t, i, lists = [["video", seq.videoTracks], ["audio", seq.audioTracks]];
        // anything still inside the gap blocks the ripple
        for (t = 0; t < lists.length; t++) for (i = 0; i < lists[t][1].numTracks; i++) { var tr = lists[t][1][i]; for (var c = 0; c < tr.clips.numItems; c++) { var cl = tr.clips[c]; if (secondsOf(cl.end) > from + 0.002 && secondsOf(cl.start) < to - 0.002) blocked.push({ track: lists[t][0] + " " + i, clip: cl.name, start: timeInfo(cl.start, seq), end: timeInfo(cl.end, seq) }); } }
        if (blocked.length) fail("clips still occupy the gap; remove or split them first", { blocked: blocked });
        if (a.dryRun) return { dryRun: true, plan: { action: "closeGap", from: timeInfo(from, seq), to: timeInfo(to, seq), shift: timeInfo(shift, seq) } };
        for (t = 0; t < lists.length; t++) for (i = 0; i < lists[t][1].numTracks; i++) {
            var track = lists[t][1][i], later = [];
            for (var k = 0; k < track.clips.numItems; k++) if (secondsOf(track.clips[k].start) >= to - 0.002) later.push(track.clips[k]);
            later.sort(function (x, y) { return secondsOf(x.start) - secondsOf(y.start); });
            for (var m = 0; m < later.length; m++) { var clip = later[m], want = secondsOf(clip.start) - shift; try { clip.move(makeTime(-shift)); } catch (e) {} if (Math.abs(secondsOf(clip.start) - want) > 0.002) { try { var dur = secondsOf(clip.end) - secondsOf(clip.start); clip.start = makeTime(want); clip.end = makeTime(want + dur); } catch (e2) {} } if (Math.abs(secondsOf(clip.start) - want) <= 0.002) moved++; else blocked.push({ track: lists[t][0] + " " + i, clip: clip.name, wanted: timeInfo(want, seq), at: timeInfo(clip.start, seq) }); }
        }
        var out = { from: timeInfo(from, seq), to: timeInfo(to, seq), shift: timeInfo(shift, seq), clipsMoved: moved, end: timeInfo(seq.end, seq) };
        if (blocked.length) out.notMoved = blocked;
        return out;
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
