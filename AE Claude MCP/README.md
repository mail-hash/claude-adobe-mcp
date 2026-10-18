# After Effects Round Trip — Claude Desktop extension

Lets a Claude Desktop chat read, edit, build, render and check the comps open in After Effects. Round-trip edits go into a new version of the comp (`<name> v2`, `v3`, …); the original is never changed and the project is never saved unless you ask.

## Install

1. Double-click **`dist/AE Round Trip.mcpb`** → Install in Claude Desktop (if nothing happens, open it a second time). Start a new chat.
2. After Effects: **Preferences › Scripting & Expressions › Allow Scripts to Write Files and Access Network** on.
3. macOS asks whether **Claude** may control **Adobe After Effects** the first time → Allow (System Settings › Privacy & Security › Automation).
4. **System Settings › Privacy & Security › Accessibility › Claude** on — needed to read and dismiss AE's modal dialogs.

## Self-test

```bash
node test/selftest.mjs      # --no-render skips the render steps, --keep leaves the scratch project open
```

Drives the real MCP server against your running After Effects and exercises **every tool** (24/24): a new project, a comp built through `ae_run_script` with the helper library (groups in order, eased 2D/1D/colour keys), fonts list + replace, export / audit / edit / new version, inline and saved frames with a contact sheet, a waited render, a background batch render job, `ae_compare` against the render, import, rebuild, version cleanup, save/save-as/open, and a real modal dialog that `ae_status` detects and `ae_dismiss_dialog` clicks away. Scratch files land in `~/Library/Application Support/AE Claude Round Trip/selftest/`. It leaves AE on a blank project.

## Tools

Mutating tools accept `dry_run: true`. Frame results carry `seconds`, `frames` and `timecode`.

| Tool | What it does |
|---|---|
| `ae_status` | AE running/responsive, project (unsaved?), active comp, render state, **modal dialogs**, engine health, running jobs |
| `ae_dismiss_dialog` | Click a button on AE's own modal dialog (Resolve Fonts, missing footage, script warning, auto-save…) |
| `ae_run_script` | ExtendScript with helpers in scope (below); `background: true` returns a job id. Errors carry line + source context; `log()` lines come back as `output` |
| `ae_job_status` / `ae_job_wait` | Background jobs (scripts, batch renders): status, per-item results, elapsed time |
| `ae_open_project` / `ae_new_project` / `ae_save` / `ae_save_as` / `ae_import` | Project files without dialogs; import footage / sequences / PSD-AI comps / .aep |
| `ae_render_comp` | Render one comp through the Render Queue and wait (or hand to Media Encoder) |
| `ae_render_comps` | Render a **list** of comps as a background job: template by name fragment, `out_dir` + `{comp}`/`{index}` pattern, touches only the items it adds, per-item status / frames / path |
| `ae_render_frame` / `ae_save_frame` / `ae_save_frames` | Inline image / PNG to disk / many PNGs with an optional contact sheet |
| `ae_compare` | Render frames of a comp and measure PSNR + SSIM against a reference movie or image sequence at the same times; side-by-side (comp · reference · diff) sheet |
| `ae_list_fonts_used` / `ae_replace_font` | Fonts per text layer/keyframe (+ AE's missing/substituted list); replace a font project-wide, reporting substitutions |
| `ae_list_comps` / `ae_get_comp` / `ae_get_layers` | Comps; export a comp tree → outline + `export_id`; full property JSON, or `summary: true` for an audit (in/out, parent, matte, effects + params, text, animated props with key times, expressions) |
| `ae_apply_edits` | Edit ops applied as a new version (`set_property`, `set_key`, `add_group`, `remove_group`, `set_layer`, `add_layer`, `remove_layer`, `move_layer`, `replace_layer`, `set_comp`) |
| `ae_rebuild_comp` / `ae_remove_versions` | Rebuild a comp tree from an export; delete versions these tools created (refuses anything not named ` vN` / ` (rebuilt)`) |

### `ae_run_script` helper library

Defined inside each run (nothing is added to AE's engine or to built-in prototypes):

- `str(v)` — safe string of anything. **In this AE build `"text" + object` throws** (the engine's `+` runs with expression vector-math semantics); use `str()`, `String()` or `arr.join()`.
- `log(...)` — collected into `output`.
- `findComp(name)`, `findItem(nameOrPath)`, `ensureFolder("A/B/C")`, `ensureComp(name, w, h, dur, fps, folder)`.
- `addGroup(contents, matchName, name)` — `addProperty` + a **fresh reference** (references from `addProperty` go stale after further adds).
- `addGroupsInOrder(contents, [{mn, name}])` — adds in list order; the first entry ends up on top; returns fresh references. `refetch(group, nameOrIndex)`.
- `easeKeys(prop, keys?, influence?, speed?)` — bezier ease with the right dimension count: 1D and colour → 1, 2D → 2, 3D → 3, spatial (Position) → 1.
- `setKeys(prop, [[t, v], ...])`, `fps(comp)`, `frame(comp, s)`, `seconds(comp, f)`, `tc(comp, s)`.

## Example: 20-comp package → Premiere

```
AE:  ae_list_comps { filter: "Package" }
     ae_get_layers { export_id, summary: true }          audit effects / mattes / fonts before rendering
     ae_list_fonts_used → ae_replace_font { from: "ArialMT", to: "FuturaPT-Book", dry_run: true } → apply
     ae_render_comps { items: [{comp_id}…], out_dir: "/x/renders", template: "H.264" }  → jobId
     ae_job_wait { job_id }                               per-item status, frames, paths
     ae_compare { comp_id, reference: "/x/reference/01 Title.mov" }   PSNR/SSIM per frame + sheet
Premiere (Premiere Pro Bridge): pr_build_from_timeline with { aep, comp } clips, or pr_import_ae_comps + pr_place_clips { video_only: true }
```

## Dialogs and the shared engine

Every call checks for AE modal dialogs first (and again when a call times out) and names them; a hidden *Resolve Fonts* dialog otherwise blocks scripting and Dynamic Link for as long as it sits there. Scripts are queued and run one at a time, so AE's "another script is running" warning doesn't fire; long work (`ae_render_comps`, `background: true`) runs as a job you poll.

All ExtendScript helpers are function-scoped (`#include` inside each script's IIFE); the only global AE sees is a transient `RT_ARGS` that is deleted after each run. `ae_status.engineAdditions` lists what *is* on the built-in prototypes (Adobe's CC Libraries panel adds json2 `toJSON`s and `Array.prototype.indexOf/filter/map`); the `+` operator behaviour is AE 26.5's own and present from launch.

## Limits

- Claude **desktop** app only, on the Mac running After Effects.
- AE must be idle: a running render or script blocks other calls (they wait in the queue); `ae_status` reports `busy` while a job runs.
- Round-trip format limits (`../AE Round Trip/README.md`): layer styles and puppet pins can't be created; text styling is per layer; AE won't set hidden properties.
- `ae_compare` and contact sheets need `ffmpeg` (Homebrew).

## Develop

```bash
./build.sh                         # copies ../AE Round Trip scripts into server/ae and packs dist/AE Round Trip.mcpb
node test/client.mjs ae_status
```
