// Runs the round-trip ExtendScript files inside After Effects through osascript, one job at a time,
// with a job registry (async jobs), modal-dialog detection and dialog dismissal.
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SCRIPTS = process.env.AE_RT_SCRIPTS || path.join(HERE, "ae");

export async function aeAppName() {
  if (process.env.AE_APP) return process.env.AE_APP;
  const { stdout } = await run("/bin/ps", ["-axo", "comm"]);
  const names = [...stdout.matchAll(/\/(Adobe After Effects [^/]+)\.app\/Contents\/MacOS\/After Effects$/gm)].map((m) => m[1]);
  if (!names.length) throw new Error("After Effects isn't running. Open it with your project, then try again.");
  return names.sort().at(-1); // newest if several are open
}

const jsStr = (s) => JSON.stringify(String(s));
const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');

// ------------------------------------------------------------------ dialogs
// AE's modal dialogs (Resolve Fonts, missing footage, script warnings, auto-save prompts...) are exposed to
// macOS Accessibility as windows with subrole AXDialog. Needs Accessibility permission for Claude.
export async function detectDialogs(processName = "After Effects") {
  const script = `
tell application "System Events"
  if not (exists process "${esc(processName)}") then return "NOPROC"
  set out to ""
  tell process "${esc(processName)}"
    set n to 0
    try
      set n to count of windows
    end try
    repeat with i from 1 to n
      set sr to ""
      set rl to ""
      set t to ""
      set txt to ""
      set bt to ""
      try
        set sr to subrole of window i
      end try
      try
        set rl to role of window i
      end try
      if sr is "AXDialog" or sr is "AXSystemDialog" or rl is "AXSheet" then
        try
          set t to name of window i
        end try
        try
          set txt to (value of every static text of window i) as text
        end try
        try
          repeat with b in (every button of window i)
            set bt to bt & (name of b) & "~~"
          end repeat
        end try
        set out to out & "|||" & t & "###" & txt & "###" & bt
      end if
    end repeat
  end tell
  return out
end tell`;
  try {
    const { stdout } = await run("/usr/bin/osascript", ["-e", script], { timeout: 10000 });
    const s = stdout.trim();
    if (s === "NOPROC") return { running: false, unavailable: "After Effects process not visible to System Events" };
    const dialogs = s.split("|||").filter(Boolean).map((d) => { const [title, text, buttons] = d.split("###"); return { title: title || "", text: (text || "").trim(), buttons: (buttons || "").split("~~").filter(Boolean) }; });
    return { running: true, dialogs };
  } catch (e) {
    const msg = String(e.stderr || e.message);
    if (/assistive access|-1719|-25211|not allowed/i.test(msg)) return { running: true, unavailable: "Accessibility permission missing: System Settings › Privacy & Security › Accessibility › enable Claude, then retry." };
    return { running: true, unavailable: "osascript: " + msg.trim().slice(0, 200) };
  }
}
export function describeDialogs(d) {
  if (!d || !d.dialogs || !d.dialogs.length) return "";
  return d.dialogs.map((x) => `"${x.title || "(untitled)"}"${x.text ? " — " + x.text : ""} [${x.buttons.join(" | ")}]`).join("; ");
}
// Click a button on an After Effects dialog only.
export async function dismissDialog(button, { titleContains, processName = "After Effects" } = {}) {
  const d = await detectDialogs(processName);
  if (d.unavailable) throw new Error(`Can't read After Effects' dialogs: ${d.unavailable}`);
  if (!d.dialogs.length) return { dismissed: false, reason: "no modal dialog is open" };
  const target = titleContains ? d.dialogs.find((x) => (x.title + " " + x.text).toLowerCase().includes(titleContains.toLowerCase())) : d.dialogs[0];
  if (!target) throw new Error(`No dialog matching "${titleContains}". Open: ${describeDialogs(d)}`);
  let pick = button;
  if (!pick) pick = target.buttons.find((b) => /^(ok|continue|close|done|yes)$/i.test(b)) || target.buttons.find((b) => /cancel|no|skip|don'?t/i.test(b)) || target.buttons[0];
  const match = target.buttons.find((b) => b.toLowerCase() === String(pick).toLowerCase()) || target.buttons.find((b) => b.toLowerCase().includes(String(pick).toLowerCase()));
  if (!match) throw new Error(`Dialog "${target.title || target.text.slice(0, 40)}" has no button "${pick}". Buttons: ${target.buttons.join(" | ")}`);
  const script = `
tell application "System Events"
  tell process "${esc(processName)}"
    repeat with i from 1 to (count of windows)
      set sr to ""
      try
        set sr to subrole of window i
      end try
      if sr is "AXDialog" or sr is "AXSystemDialog" then
        if exists button "${esc(match)}" of window i then
          click button "${esc(match)}" of window i
          return "clicked"
        end if
      end if
    end repeat
  end tell
end tell
return "notfound"`;
  const { stdout } = await run("/usr/bin/osascript", ["-e", script], { timeout: 10000 });
  if (stdout.trim() !== "clicked") throw new Error("The dialog changed before the button could be clicked.");
  await new Promise((r) => setTimeout(r, 400));
  const after = await detectDialogs(processName);
  return { dismissed: true, clicked: match, dialog: { title: target.title, text: target.text }, remainingDialogs: after.dialogs || [] };
}

// ------------------------------------------------------------------ job queue
// AE runs one script at a time; a second DoScriptFile while one is running raises a warning dialog in AE
// that blocks everything. All work therefore goes through this queue, and long jobs run in the background
// with a job id (see startJob / getJob / waitJob).
const jobs = new Map();
let queue = Promise.resolve();
let seq = 0;

export function listJobs() { return [...jobs.values()].map(publicJob); }
export function getJob(id) { const j = jobs.get(id); return j ? publicJob(j) : null; }
function publicJob(j) {
  const o = { id: j.id, label: j.label, script: j.script, status: j.status, queuedAt: j.queuedAt, startedAt: j.startedAt ? new Date(j.startedAt).toISOString() : null, endedAt: j.endedAt ? new Date(j.endedAt).toISOString() : null };
  if (j.startedAt) o.elapsedSec = Math.round(((j.endedAt || Date.now()) - j.startedAt) / 100) / 10;
  if (j.status === "done") o.result = j.result;
  if (j.status === "error") { o.error = j.error; if (j.detail) o.detail = j.detail; }
  if (j.dialogs?.length) o.dialogs = j.dialogs;
  return o;
}
export async function waitJob(id, maxWaitSec = 60) {
  const j = jobs.get(id); if (!j) throw new Error("unknown job " + id);
  const deadline = Date.now() + maxWaitSec * 1000;
  while ((j.status === "queued" || j.status === "running") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500));
  return publicJob(j);
}

// Queue a script; returns the job record at once. `script` is relative to SCRIPTS.
export function startJob(script, args = {}, { timeoutSec = 1800, label, checkDialogs = true } = {}) {
  const id = `job-${Date.now().toString(36)}-${(++seq).toString(36)}`;
  const j = { id, label: label || script.replace(/\.jsx$/, ""), script, status: "queued", queuedAt: new Date().toISOString() };
  jobs.set(id, j);
  if (jobs.size > 200) { for (const k of [...jobs.keys()].slice(0, jobs.size - 200)) if (!["queued", "running"].includes(jobs.get(k).status)) jobs.delete(k); }
  j.promise = queue.then(() => execute(j, args, { timeoutSec, checkDialogs }));
  queue = j.promise.catch(() => {});
  return j;
}

// Queue a script and wait for its result (throws on failure).
export async function runScript(script, args = {}, opts = {}) {
  const j = startJob(script, args, opts);
  await j.promise;
  if (j.status === "error") { const err = new Error(j.error); if (j.detail) err.detail = j.detail; if (j.dialogs) err.dialogs = j.dialogs; throw err; }
  return j.result;
}

async function execute(j, args, { timeoutSec, checkDialogs }) {
  j.status = "running"; j.startedAt = Date.now();
  try {
    const app = await aeAppName();
    if (checkDialogs) {
      const d = await detectDialogs();
      if (d.dialogs?.length) { j.dialogs = d.dialogs; throw new Error(`After Effects is showing a modal dialog that blocks scripting: ${describeDialogs(d)}. Dismiss it (ae_dismiss_dialog) and retry.`); }
    }
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ae-rt-"));
    const runner = path.join(dir, "runner.jsx");
    const out = path.join(dir, "result.txt");
    const scriptPath = path.join(SCRIPTS, j.script);
    await fs.access(scriptPath);
    // Function-scoped runner: nothing is left behind in AE's shared ExtendScript engine.
    await fs.writeFile(runner, `(function () {
  $.global.RT_ARGS = ${JSON.stringify(args)};
  var r;
  try { r = $.evalFile(File(${jsStr(scriptPath)})); }
  catch (e) { r = '{"ok": false, "error": "' + String(String(e.message || e) + " (line " + e.line + ")").replace(/\\\\/g, "\\\\\\\\").replace(/"/g, '\\\\"') + '"}'; }
  try { delete $.global.RT_ARGS; } catch (e2) {}
  var f = File(${jsStr(out)}); f.encoding = "UTF-8"; f.lineFeed = "Unix"; f.open("w"); f.write(String(r)); f.close();
})();
`);
    try {
      await osascriptWait(["-e", `with timeout of ${timeoutSec} seconds`, "-e", `tell application ${JSON.stringify(app)} to DoScriptFile ${JSON.stringify(runner)}`, "-e", "end timeout"], (timeoutSec + 30) * 1000);
    } catch (e) {
      const msg = String(e.stderr || e.message);
      if (e.killed || /timed out|-1712/.test(msg)) {
        const d = await detectDialogs();
        if (d.dialogs?.length) { j.dialogs = d.dialogs; throw new Error(`After Effects did not answer within ${timeoutSec}s. A dialog is open in After Effects: ${describeDialogs(d)}. Dismiss it (ae_dismiss_dialog) and retry.`); }
        throw new Error(`After Effects did not answer within ${timeoutSec}s — it is busy (rendering, or another script is running).${d.unavailable ? ` (dialog check unavailable: ${d.unavailable})` : ""}`);
      }
      if (/-1743|not allowed|Not authorized/i.test(msg)) throw new Error("macOS blocked Claude from controlling After Effects. Allow it in System Settings › Privacy & Security › Automation (Claude → " + app + ").");
      throw new Error("osascript failed: " + msg.trim());
    }
    let text;
    try { text = await fs.readFile(out, "utf8"); }
    catch {
      const d = await detectDialogs();
      if (d.dialogs?.length) { j.dialogs = d.dialogs; throw new Error(`The script did not run: After Effects is showing a dialog: ${describeDialogs(d)}. Dismiss it (ae_dismiss_dialog) and retry.`); }
      throw new Error("After Effects returned nothing. Check that Preferences › Scripting & Expressions › 'Allow Scripts to Write Files and Access Network' is on, and that no dialog is open in AE.");
    } finally { fs.rm(dir, { recursive: true, force: true }).catch(() => {}); }
    let res;
    try { res = JSON.parse(text); } catch { throw new Error("Unexpected output from " + j.script + ": " + text.slice(0, 500)); }
    if (res && res.ok === false) { j.detail = res; throw new Error(res.error || "script failed"); }
    j.result = res; j.status = "done";
  } catch (e) {
    j.status = "error"; j.error = e.message;
    if (e.detail) j.detail = e.detail;
  } finally { j.endedAt = Date.now(); }
}

// osascript with a hard timeout (spawn, so long renders aren't cut off by execFile's buffer limits).
function osascriptWait(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/osascript", args);
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d; });
    const timer = setTimeout(() => { child.kill("SIGKILL"); const e = new Error("timed out"); e.killed = true; e.stderr = stderr; reject(e); }, timeoutMs);
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => { clearTimeout(timer); if (code === 0) resolve(); else { const e = new Error("osascript exit " + code); e.stderr = stderr; reject(e); } });
  });
}
