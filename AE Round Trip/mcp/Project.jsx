// MCP helper: project file operations without modal dialogs.
// RT_ARGS = { op: "open"|"save"|"saveAs"|"new"|"close", path?, discardUnsaved?: bool }
(function () {
    #include "../lib/rt_core.jsxinc"
    var args = RT.takeArgs() || {};
    function info() {
        var p = app.project;
        return { project: p && p.file ? p.file.fsName : null, unsavedChanges: p ? p.dirty : false, items: p ? p.numItems : 0 };
    }
    function fail(msg) { return RT.stringify({ ok: false, error: msg, state: info() }); }
    var p = app.project;
    if (args.dryRun) return RT.stringify({ ok: true, dryRun: true, plan: { op: args.op, path: args.path || null, discardUnsaved: !!args.discardUnsaved }, state: info() });
    try {
        switch (args.op) {
            case "open": {
                if (!args.path) return fail("path is required");
                var f = new File(args.path);
                if (!f.exists) return fail("file not found: " + f.fsName);
                if (p && p.dirty && !args.discardUnsaved) return fail("The open project has unsaved changes. Save it first (ae_save), or pass discard_unsaved: true.");
                if (p) p.close(CloseOptions.DO_NOT_SAVE_CHANGES);
                var np = app.open(f);
                if (!np) return fail("After Effects did not open " + f.fsName);
                return RT.stringify({ ok: true, op: "open", state: info() });
            }
            case "save": {
                if (!p) return fail("no project is open");
                if (!p.file) return fail("The project has never been saved; use ae_save_as with a path.");
                p.save();
                return RT.stringify({ ok: true, op: "save", state: info() });
            }
            case "saveAs": {
                if (!p) return fail("no project is open");
                if (!args.path) return fail("path is required");
                var dest = new File(args.path);
                if (!/\.aep$/i.test(dest.name)) dest = new File(dest.fsName + ".aep");
                if (!dest.parent.exists) dest.parent.create();
                p.save(dest);
                return RT.stringify({ ok: true, op: "saveAs", state: info() });
            }
            case "new": {
                if (p && p.dirty && !args.discardUnsaved) return fail("The open project has unsaved changes. Save it first (ae_save), or pass discard_unsaved: true.");
                if (p) p.close(CloseOptions.DO_NOT_SAVE_CHANGES);
                var created = app.newProject();
                if (args.path) {
                    var d2 = new File(args.path);
                    if (!/\.aep$/i.test(d2.name)) d2 = new File(d2.fsName + ".aep");
                    if (!d2.parent.exists) d2.parent.create();
                    created.save(d2);
                }
                return RT.stringify({ ok: true, op: "new", state: info() });
            }
            case "close": {
                if (!p) return fail("no project is open");
                if (p.dirty && !args.discardUnsaved) return fail("The open project has unsaved changes. Save it first (ae_save), or pass discard_unsaved: true.");
                p.close(CloseOptions.DO_NOT_SAVE_CHANGES);
                return RT.stringify({ ok: true, op: "close", state: info() });
            }
            default:
                return fail("unknown op " + args.op);
        }
    } catch (e) {
        return fail(String(e.message || e) + (e.line ? " (line " + e.line + ")" : ""));
    }
})();
