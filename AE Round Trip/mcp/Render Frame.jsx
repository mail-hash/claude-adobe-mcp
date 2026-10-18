// MCP helper: render one frame of a comp to PNG. RT_ARGS = { compId, time, out }
(function () {
    #include "../lib/rt_core.jsxinc"

    var args = RT.takeArgs() || {};
    var c = RT.findItemById(args.compId);
    if (!(c instanceof CompItem)) return RT.stringify({ ok: false, error: "comp " + args.compId + " not found" });
    if (typeof c.saveFrameToPng !== "function") return RT.stringify({ ok: false, error: "this After Effects version has no saveFrameToPng" });
    var t = Math.max(0, Math.min(Number(args.time) || 0, c.duration - c.frameDuration));
    c.saveFrameToPng(t, new File(args.out));
    return RT.stringify({ ok: true, compId: c.id, name: c.name, time: RT.round(t), frame: Math.round(t * c.frameRate), timecode: RT.timecode(t, c.frameRate), fps: RT.round(c.frameRate), out: args.out });
})();
