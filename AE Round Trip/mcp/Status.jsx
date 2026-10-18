// MCP helper: project / app status. (Modal-dialog detection happens in the MCP server, outside AE.)
(function () {
    #include "../lib/rt_core.jsxinc"
    RT.takeArgs();
    var p = app.project, a = p ? p.activeItem : null;
    var o = {
        ok: true, aeVersion: app.version,
        project: p && p.file ? p.file.fsName : null, unsavedChanges: p ? p.dirty : false,
        items: p ? p.numItems : 0,
        activeComp: a instanceof CompItem ? { id: a.id, name: a.name } : null
    };
    try { o.expressionEngine = p ? p.expressionEngine : null; } catch (e0) {}
    try { o.rendering = p ? p.renderQueue.rendering : false; o.renderQueueItems = p ? p.renderQueue.numItems : 0; } catch (e1) {}
    try { o.isWatchFolder = app.isWatchFolder; } catch (e2) {}
    try {
        // Engine health: AE's legacy ExtendScript expression engine installs vector-math operators on
        // Object.prototype in the shared scripting engine; then "str" + object throws. Report it.
        var probe = null; try { probe = "x" + {}; } catch (e3) { probe = null; }
        o.stringConcatWithObjects = probe === "x[object Object]" ? "ok" : "broken";
        var polluted = [];
        for (var k in Array.prototype) polluted.push("Array.prototype." + k);
        for (var k2 in String.prototype) polluted.push("String.prototype." + k2);
        for (var k3 in Object.prototype) polluted.push("Object.prototype." + k3);
        if (typeof Object.prototype["+"] === "function") polluted.push("Object.prototype.[+ - * /] (expression-engine operators)");
        if (polluted.length) o.engineAdditions = polluted;
    } catch (e4) {}
    return RT.stringify(o);
})();
