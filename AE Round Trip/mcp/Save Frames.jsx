// MCP helper: save several frames to PNG. RT_ARGS = { frames: [{ compId, time, out }] }
// saveFrameToPng writes asynchronously; the MCP server waits for the files.
(function () {
    #include "../lib/rt_core.jsxinc"
    var args = RT.takeArgs() || {};
    var list = args.frames || [], out = [];
    if (!list.length) return RT.stringify({ ok: false, error: "frames is empty" });
    for (var i = 0; i < list.length; i++) {
        var c = RT.findItemById(Number(list[i].compId));
        if (!(c instanceof CompItem)) return RT.stringify({ ok: false, error: "comp " + list[i].compId + " not found", completed: out });
        if (typeof c.saveFrameToPng !== "function") return RT.stringify({ ok: false, error: "this After Effects version has no saveFrameToPng" });
        var t = Math.max(0, Math.min(Number(list[i].time) || 0, c.duration - c.frameDuration));
        var f = new File(list[i].out); if (!f.parent.exists) f.parent.create();
        c.saveFrameToPng(t, f);
        out.push({ compId: c.id, comp: c.name, time: RT.round(t), frame: Math.round(t * c.frameRate), timecode: RT.timecode(t, c.frameRate), out: f.fsName });
    }
    return RT.stringify({ ok: true, frames: out });
})();
