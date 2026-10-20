# Claude ↔ Adobe MCP bridges

Two [MCP](https://modelcontextprotocol.io) servers, packaged as Claude Desktop extensions, that let Claude work inside **Adobe After Effects** and **Adobe Premiere Pro** on a Mac — read what's open, build and edit comps and sequences, render, and check the result — without you exporting or pasting anything.

Built against After Effects 2026 (26.5) and Premiere Pro 2026 (26.5) on Apple Silicon, by driving the real apps: every tool is exercised by a self-test that runs against a live AE / Premiere.

| Folder | What it is |
|---|---|
| [`AE Claude MCP/`](AE%20Claude%20MCP) | **After Effects Round Trip** — Claude Desktop extension (27 tools). Exports a comp tree to JSON with stable layer IDs, applies edits as a new version of the comp, runs ExtendScript with a helper library, applies animation presets and lints expressions, renders comps (batch, background jobs) and frames, compares renders against references (PSNR/SSIM), lists/replaces fonts, detects and dismisses AE's modal dialogs. |
| [`AE Round Trip/`](AE%20Round%20Trip) | The ExtendScript side of the AE extension, also usable on its own from **File › Scripts**: `Export Comp.jsx`, `Apply Changes.jsx`, `Rebuild Comp.jsx` plus the MCP helper scripts. Everything is function-scoped; no built-in prototypes are touched. |
| [`Premiere Claude MCP/`](Premiere%20Claude%20MCP) | **Premiere Pro Bridge** — a CEP 12 panel that runs a localhost-only HTTP server inside Premiere, plus the Claude Desktop extension that talks to it (57 tools): projects, imports (incl. Dynamic Link of many AE comps in one call), sequences built or patched from a JSON timeline, sequence versions (`v2`, `v3`…), markers, in/out points, effects and keyframes, transitions, razor / trim / cross-track moves, local transcription and transcript-driven cuts, audio analysis / levels / ducking, Motion Graphics Templates, clip and track operations, sequence diffing, frame export, rendering through Media Encoder, dialog detection/dismissal, raw ExtendScript. |
| [`research/premiere-mcp/EVALUATION.md`](research/premiere-mcp/EVALUATION.md) | Review of eight community Premiere MCP projects and why this one is its own CEP bridge. |

## What it does, in practice

- *"Push the camera in 200 px more at 5 s and fade the laptop screen in over the first second, then show me before/after frames."* → AE exports the comp, Claude edits the JSON, AE creates `Comp v2` with just those changes, renders both frames.
- *"Build Edit v1 from these 20 comps in Package.aep: title on V2 at frame 0, lower third at 120…"* → Premiere imports the comps via Dynamic Link, creates the sequence, places everything (video only, so silent comp audio doesn't land on audio tracks), and `pr_compare_sequences` verifies it against a reference edit frame by frame.
- *"Render all package comps as H.264 to /renders and compare each against the approved QuickTimes."* → one background render job, then PSNR/SSIM per frame with a side-by-side sheet.

## Install (short version)

1. **After Effects:** install `AE Claude MCP/dist/AE Round Trip.mcpb` in Claude Desktop (build it with `./build.sh`, or take it from the Releases page). Turn on *Preferences › Scripting & Expressions › Allow Scripts to Write Files and Access Network*.
2. **Premiere:** run `Premiere Claude MCP/tools/install-panel.sh`, enable unsigned panels for CEP 12 (`defaults write com.adobe.CSXS.12 PlayerDebugMode 1`), restart Premiere, open a project and *Window › Extensions › Claude Bridge*; install `Premiere Bridge.mcpb` in Claude Desktop.
3. Grant Claude **Automation** (After Effects) and **Accessibility** (to read and click modal dialogs) in System Settings › Privacy & Security.
4. Start a new chat. Each extension's README lists its tools and an example workflow; `node test/selftest.mjs` in each folder exercises every tool against your running app.

## Design in one paragraph

Both servers are small Node processes (MCP over stdio). After Effects is driven through `osascript … DoScriptFile`, one script at a time through a job queue, with every call checking for blocking modal dialogs first. Premiere has no scriptable entry point from outside, so a CEP panel hosts a tiny HTTP server (127.0.0.1 only) and runs ExtendScript through `evalScript` with a single-flight queue and timeouts; the MCP server is just an HTTP client. All ExtendScript lives in private namespaces, uses its own JSON serializer (Premiere's engine may lack `JSON`), and returns structured results with seconds, frames and timecode. Nothing is saved unless a tool is asked to save, and every mutating tool has `dry_run`.

## Status and limits

- Tested on macOS (Apple Silicon) with AE 26.5 and Premiere 26.5.2 only. Claude Desktop only (the browser can't reach local apps).
- Premiere's API has no way to set clip speed, set source patching, or delete tracks; those come back as warnings. UXP was deliberately not used (its API is still behind CEP for timeline work).
- AE 26.5's scripting engine evaluates `"text" + object` with expression (vector-math) semantics and throws; the helper library's `str()` routes around it.

MIT licensed. `Premiere Claude MCP/cep/js/CSInterface.js` is Adobe's CEP library, redistributed under Adobe's own license terms for it.
