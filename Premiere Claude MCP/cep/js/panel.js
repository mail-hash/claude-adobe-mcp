/* Claude Premiere Bridge — CEP panel.
   Runs a tiny HTTP server on 127.0.0.1 (Node inside CEP) and executes commands in Premiere's
   ExtendScript engine through CSInterface.evalScript, one at a time, with timeouts.

   Endpoints (JSON):
     GET  /ping                     -> { ok, panel, host, jsxLoaded, busy, queued }
     POST /call  { fn, args, timeoutMs }    -> result of CPB.<fn>(args) from jsx/host.jsx
     POST /eval  { script, timeoutMs }      -> raw evalScript result (string, or parsed JSON)
*/
var PANEL = (function () {
  var BUILD = "claude-premiere-bridge 1.0.0";
  var DEFAULT_PORT = 8098;
  var cs = new CSInterface();
  var nodeRequire = (typeof require === "function") ? require : (window.cep_node && window.cep_node.require);
  var http = nodeRequire ? nodeRequire("http") : null;
  var fs = nodeRequire ? nodeRequire("fs") : null;
  var server = null, port = DEFAULT_PORT;
  var jsxLoaded = false, jsxError = null, hostInfo = null;

  function el(id) { return document.getElementById(id); }
  function log(msg) {
    var box = el("log"); if (!box) return;
    var t = new Date().toLocaleTimeString();
    box.textContent += "[" + t + "] " + msg + "\n";
    box.scrollTop = box.scrollHeight;
  }
  function setStatus(text, cls) { var s = el("status"); if (s) { s.textContent = text; s.className = cls; } }
  function setMeta() {
    var m = el("meta"); if (!m) return;
    m.textContent = "http://127.0.0.1:" + port + "  ·  host.jsx " + (jsxLoaded ? "loaded" : (jsxError ? "FAILED: " + jsxError : "loading…")) +
      (hostInfo ? "  ·  " + hostInfo.appName + " " + hostInfo.appVersion : "");
  }

  // ---- single-flight evalScript queue -------------------------------------------------------
  // A second evalScript while the first is still outstanding can wedge CEP until Premiere restarts,
  // so jobs run strictly one at a time, and a timed-out job never releases the slot early.
  var queue = [], busy = false;
  function evalQueued(script, timeoutMs, cb) { queue.push({ script: script, timeoutMs: timeoutMs, cb: cb }); pump(); }
  function pump() {
    if (busy || !queue.length) return;
    busy = true;
    var job = queue.shift(), settled = false;
    var timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      job.cb({ ok: false, error: "Premiere did not return within " + (job.timeoutMs / 1000) + "s. It is probably blocked by a modal dialog or a long operation; the scripting host stays busy until that finishes.", busy: true });
      // Do NOT release `busy` here: the native call is still outstanding.
    }, job.timeoutMs);
    try {
      cs.evalScript(job.script, function (result) {
        clearTimeout(timer);
        setTimeout(function () {
          if (!settled) {
            settled = true;
            if (result === "EvalScript error." || result === "EvalScript error") job.cb({ ok: false, error: "EvalScript error (the ExtendScript engine refused the script; check for a syntax error or a poisoned engine)" });
            else job.cb({ ok: true, raw: result });
          }
          busy = false;
          pump();
        }, 0);
      });
    } catch (e) {
      clearTimeout(timer);
      if (!settled) { settled = true; job.cb({ ok: false, error: "evalScript threw: " + e.message }); }
      busy = false;
      pump();
    }
  }

  // ---- host script ---------------------------------------------------------------------------
  function extPath() { return cs.getSystemPath(SystemPath.EXTENSION).replace(/\\/g, "/"); }
  function loadHost(cb) {
    jsxLoaded = false; jsxError = null; setMeta();
    var p = extPath() + "/jsx/host.jsx";
    evalQueued('"ready"', 5000, function (r) {
      if (!r.ok) { jsxError = "engine not ready"; setMeta(); log("ExtendScript engine not ready, retrying in 2s"); setTimeout(function () { loadHost(cb); }, 2000); return; }
      evalQueued('(function(){ try { $.evalFile(File(' + JSON.stringify(p) + ')); return (typeof $.global.CPB === "object") ? "ok " + $.global.CPB.VERSION : "no CPB after load"; } catch (e) { return "ERR " + e.message + " line " + e.line; } })()', 20000, function (r2) {
        if (r2.ok && /^ok /.test(r2.raw)) { jsxLoaded = true; log("host.jsx loaded (" + r2.raw.substr(3) + ")"); }
        else { jsxError = r2.ok ? r2.raw : r2.error; log("host.jsx failed: " + jsxError); }
        setMeta();
        if (cb) cb(jsxLoaded);
      });
    });
  }

  // ---- HTTP server ---------------------------------------------------------------------------
  function send(res, code, obj) {
    var body = JSON.stringify(obj);
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body), "Access-Control-Allow-Origin": "null" });
    res.end(body);
  }
  function readBody(req, cb) {
    var chunks = [], size = 0;
    req.on("data", function (c) { size += c.length; if (size > 50 * 1024 * 1024) { req.destroy(); return; } chunks.push(c); });
    req.on("end", function () { cb(Buffer.concat(chunks).toString("utf8")); });
  }
  function handle(req, res) {
    var url = req.url.split("?")[0];
    if (req.method === "GET" && url === "/ping") {
      return send(res, 200, { ok: true, panel: BUILD, host: hostInfo, jsxLoaded: jsxLoaded, jsxError: jsxError, busy: busy, queued: queue.length });
    }
    if (req.method === "POST" && url === "/reload") { loadHost(function (ok) { send(res, ok ? 200 : 500, { ok: ok, jsxError: jsxError }); }); return; }
    if (req.method !== "POST") return send(res, 404, { ok: false, error: "unknown endpoint" });
    readBody(req, function (text) {
      var body;
      try { body = JSON.parse(text || "{}"); } catch (e) { return send(res, 400, { ok: false, error: "bad JSON body" }); }
      var timeoutMs = Math.max(1000, Math.min(6 * 3600 * 1000, Number(body.timeoutMs) || 60000));
      if (url === "/eval") {
        if (typeof body.script !== "string") return send(res, 400, { ok: false, error: "script is required" });
        log("eval (" + body.script.length + " chars)");
        return evalQueued(body.script, timeoutMs, function (r) {
          if (!r.ok) return send(res, r.busy ? 503 : 500, r);
          var parsed = r.raw; try { parsed = JSON.parse(r.raw); } catch (e) {}
          send(res, 200, { ok: true, result: parsed });
        });
      }
      if (url === "/call") {
        if (!jsxLoaded) return send(res, 503, { ok: false, error: "host.jsx is not loaded in Premiere" + (jsxError ? ": " + jsxError : "") + ". Click 'Reload host script' in the Claude Bridge panel." });
        if (typeof body.fn !== "string") return send(res, 400, { ok: false, error: "fn is required" });
        log("call " + body.fn);
        var payload = JSON.stringify({ fn: body.fn, args: body.args || {} });
        var script = "CPB.call(" + JSON.stringify(payload) + ")";
        return evalQueued(script, timeoutMs, function (r) {
          if (!r.ok) return send(res, r.busy ? 503 : 500, r);
          var parsed;
          try { parsed = JSON.parse(r.raw); } catch (e) { return send(res, 500, { ok: false, error: "host returned non-JSON: " + String(r.raw).substr(0, 500) }); }
          send(res, 200, parsed);
        });
      }
      send(res, 404, { ok: false, error: "unknown endpoint " + url });
    });
  }
  function startServer() {
    if (!http) { setStatus("Node is not enabled in this panel (CEFCommandLine --enable-nodejs missing)", "bad"); return; }
    if (server) { try { server.close(); } catch (e) {} server = null; }
    try {
      var cfg = extPath() + "/port.txt";
      if (fs && fs.existsSync(cfg)) { var n = parseInt(fs.readFileSync(cfg, "utf8"), 10); if (n > 1024) port = n; }
    } catch (e) {}
    server = http.createServer(handle);
    server.on("error", function (err) {
      if (err && err.code === "EADDRINUSE") { setStatus("Port " + port + " is in use (another panel instance?)", "bad"); log("EADDRINUSE on " + port + "; retrying in 5s"); setTimeout(startServer, 5000); }
      else { setStatus("Server error: " + err.message, "bad"); log("server error " + err.message); }
    });
    server.listen(port, "127.0.0.1", function () {
      setStatus("Listening on 127.0.0.1:" + port + " — Claude can reach Premiere", "ok");
      log("HTTP server listening on " + port);
      setMeta();
    });
  }

  function init() {
    log(BUILD);
    try { var env = cs.getHostEnvironment(); hostInfo = { appName: env.appName, appVersion: env.appVersion, appId: env.appId }; } catch (e) {}
    setMeta();
    setTimeout(function () { loadHost(); }, 800);
    startServer();
    // Reload the host script if the engine lost it (e.g. after a project switch that reset the engine).
    setInterval(function () {
      if (!jsxLoaded || busy) return;
      evalQueued('(typeof $.global.CPB === "object") ? "yes" : "no"', 5000, function (r) { if (r.ok && r.raw === "no") { log("CPB missing from engine; reloading host.jsx"); loadHost(); } });
    }, 30000);
  }
  init();
  return { reloadHost: function () { loadHost(); }, restartServer: startServer, log: log };
})();
