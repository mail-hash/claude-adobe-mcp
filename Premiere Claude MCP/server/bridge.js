// Talks to the Claude Bridge panel inside Premiere Pro (HTTP on 127.0.0.1) and reads/dismisses modal dialogs
// of Premiere and After Effects through macOS Accessibility (System Events).
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
export const PORT = Number(process.env.PR_BRIDGE_PORT) || 8098;
const HOST = "127.0.0.1";

export class BridgeError extends Error {
  constructor(message, { busy = false, offline = false, detail } = {}) { super(message); this.busy = busy; this.offline = offline; this.detail = detail; }
}

function request(method, pathname, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({ host: HOST, port: PORT, method, path: pathname, headers: data ? { "Content-Type": "application/json", "Content-Length": data.length } : {} }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json; try { json = JSON.parse(text); } catch { return reject(new BridgeError("Bridge returned non-JSON: " + text.slice(0, 300))); }
        resolve({ status: res.statusCode, json });
      });
    });
    req.setTimeout(timeoutMs, () => { req.destroy(new Error("timeout")); });
    req.on("error", (e) => {
      if (e.code === "ECONNREFUSED") return reject(new BridgeError(`The Claude Bridge panel isn't running in Premiere Pro (nothing listening on ${HOST}:${PORT}). In Premiere open Window › Extensions › Claude Bridge, then retry.`, { offline: true }));
      if (e.message === "timeout") return reject(new BridgeError(`No answer from the Premiere bridge within ${Math.round(timeoutMs / 1000)}s.`, { busy: true }));
      reject(new BridgeError("Bridge connection error: " + e.message, { offline: true }));
    });
    if (data) req.write(data);
    req.end();
  });
}

export async function ping(timeoutMs = 3000) {
  const { json } = await request("GET", "/ping", null, timeoutMs);
  return json;
}

// Call a CPB.<fn>(args) host function. Throws BridgeError with the host's message on failure.
export async function call(fn, args = {}, { timeoutMs = 60000 } = {}) {
  const { status, json } = await request("POST", "/call", { fn, args, timeoutMs }, timeoutMs + 5000);
  if (json && json.ok) return json.result;
  throw new BridgeError((json && json.error) || `bridge call ${fn} failed (HTTP ${status})`, { busy: status === 503 && !!(json && json.busy), detail: json && json.detail });
}

export async function evalScript(script, { timeoutMs = 60000 } = {}) {
  const { status, json } = await request("POST", "/eval", { script, timeoutMs }, timeoutMs + 5000);
  if (json && json.ok) return json.result;
  throw new BridgeError((json && json.error) || `eval failed (HTTP ${status})`, { busy: status === 503 });
}

// ------------------------------------------------------------------ processes & dialogs

export async function premiereProcessName() {
  try {
    const { stdout } = await run("/bin/ps", ["-axo", "comm"]);
    const m = [...stdout.matchAll(/\/(Adobe Premiere Pro [^/]+)\.app\/Contents\/MacOS\//g)].map((x) => x[1]);
    return m.sort().at(-1) || null;
  } catch { return null; }
}
export async function afterEffectsRunning() {
  try { const { stdout } = await run("/bin/ps", ["-axo", "comm"]); return /\/Contents\/MacOS\/After Effects$/m.test(stdout); } catch { return false; }
}

const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');

// Modal dialogs of a process, read through System Events (Accessibility). Premiere's normal windows are not
// exposed to Accessibility, but its modal dialogs are (subrole AXDialog), so this is reliable for the thing
// that matters. Returns { running, dialogs: [{title, text, buttons}] } or { running, unavailable }.
export async function detectDialogsFor(processName) {
  if (!processName) return { running: false, unavailable: "process not running" };
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
          set bt to ""
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
    if (s === "NOPROC") return { running: false, unavailable: "process not visible to System Events" };
    const dialogs = s.split("|||").filter(Boolean).map((d) => {
      const [title, text, buttons] = d.split("###");
      return { title: title || "", text: (text || "").trim(), buttons: (buttons || "").split("~~").filter(Boolean) };
    });
    return { running: true, dialogs };
  } catch (e) {
    const msg = String(e.stderr || e.message);
    if (/assistive access|-1719|-25211|not allowed/i.test(msg)) return { running: true, unavailable: "Accessibility permission missing: System Settings › Privacy & Security › Accessibility › enable Claude, then retry." };
    return { running: true, unavailable: "osascript: " + msg.trim().slice(0, 200) };
  }
}

export async function detectDialogs() { return detectDialogsFor(await premiereProcessName()); }
export async function detectAEDialogs() { return (await afterEffectsRunning()) ? detectDialogsFor("After Effects") : { running: false, unavailable: "After Effects is not running" }; }

export function describeDialogs(d) {
  if (!d || !d.dialogs || !d.dialogs.length) return "";
  return d.dialogs.map((x) => `"${x.title || "(untitled)"}" ${x.text ? "— " + x.text : ""} [${x.buttons.join(" | ")}]`).join("; ");
}

// Click a button on a modal dialog of the given process only (never other apps). Returns what was clicked.
export async function dismissDialogFor(processName, button, { titleContains } = {}) {
  const d = await detectDialogsFor(processName);
  if (d.unavailable) throw new Error(`Can't read ${processName}'s dialogs: ${d.unavailable}`);
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
  const after = await detectDialogsFor(processName);
  return { dismissed: true, clicked: match, dialog: { title: target.title, text: target.text }, remainingDialogs: after.dialogs || [] };
}

// Wrap a host call: on 'busy', add what dialog is blocking (Premiere's, and AE's for Dynamic Link work).
export async function callOrExplain(fn, args, opts) {
  try { return await call(fn, args, opts); }
  catch (e) {
    if (e.busy) {
      const d = await detectDialogs();
      const desc = describeDialogs(d);
      if (desc) e.message += ` A dialog is open in Premiere: ${desc}. Dismiss it (pr_dismiss_dialog) and retry.`;
      else if (d.unavailable) e.message += ` (dialog check unavailable: ${d.unavailable})`;
      if (fn === "importAEComps") { const a = await detectAEDialogs(); const ad = describeDialogs(a); if (ad) e.message += ` After Effects is showing a dialog that blocks Dynamic Link: ${ad}.`; }
    }
    throw e;
  }
}
