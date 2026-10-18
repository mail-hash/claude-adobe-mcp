# AE Round Trip

Export an After Effects comp to JSON, edit the JSON (by hand, or with a script or LLM), and patch it back.

| Script | What it does |
|---|---|
| `Export Comp.jsx` | Exports the active comp and every nested precomp. Tags each comp and layer with `[rtid:…]` in its comment. Writes `<name>.json` plus a baseline `<name>.rtbase.json`. |
| `Apply Changes.jsx` | Diffs the edited `<name>.json` against `<name>.rtbase.json`, duplicates the comp as `<name> v2` (v3, …), and sets **only** the properties that changed, matching layers by ID. Writes `<name>.apply-log.txt`. |
| `Rebuild Comp.jsx` | Builds new comps from the JSON into a `Rebuilt - <name>` folder. |

Keep `lib/` next to the scripts. Run them from **File › Scripts › Run Script File…**, or copy the folder into AE's `Scripts` folder. Turn on *Preferences › Scripting & Expressions › Allow Scripts to Write Files and Access Network*.

## From the terminal (osascript)

```bash
tools/ae-run.sh "Export Comp.jsx" '{"comp":"My Title","out":"/path/My Title.json"}'
```
```bash
tools/ae-run.sh "Apply Changes.jsx" '{"in":"/path/My Title.json"}'
```
```bash
tools/ae-run.sh "Rebuild Comp.jsx" '{"in":"/path/My Title.json"}'
```

The JSON argument becomes `$.global.RT_ARGS`, which also suppresses dialogs. The scripts print a JSON result. Export accepts `comp` (name), `compId`, or neither (active comp). Set `AE_APP` for a different AE version.

To check a round trip, diff two exports. Comps are matched by order and layers by ID:

```bash
python3 tools/rtdiff.py before.json after.json
```

## What's exported

- **Comp:** size, pixel aspect, duration, fps, background, work area, motion blur / shutter, renderer, comp markers.
- **Layer:** `id`, type (text/shape/null/solid/adjustment/footage/precomp/camera/light), name, comment, `parent` (ID), in/out/start/stretch, switches, blending mode, track matte (type + matte layer ID), 3D, time remap, quality, and the source (precomp ID, or a ref into `footage`).
- **Properties** (`props`): the tree under each layer, addressed by **matchName** (`mn`). Effects, masks and shape groups carry `idx`. Non-default values, keyframes and expressions are exported, plus the main Transform values.
  - Leaf: `value`, or `keys`, plus `expr` / `exprOn`. Separated position is exported as `separated: true` with X/Y/Z Position leaves.
  - Key: `t` (seconds), `v`, `inInterp`/`outInterp` (`linear`/`bezier`/`hold`), `inEase`/`outEase` (`[{speed, influence}]` per dimension), `temporalContinuous`, `temporalAutoBezier`, `inTangent`/`outTangent`, `spatialContinuous`, `spatialAutoBezier`, `roving`, `label`.
  - Text values: text, font, size, fill/stroke, justification, tracking, leading, box size… (the style of the first character).
  - Mask and shape paths: `{vertices, inTangents, outTangents, closed}` (plus mask feather data).
  - Masks also carry mode, inverted, feather falloff, color and so on. Effects and shape groups carry `enabled` and their name.
- **Footage:** file path, solid color, size, duration.

## Editing rules for Apply Changes

- Change any `value`, key `v`, or easing / interpolation / tangents. When a property keeps the same key count and times, only the edited keys are touched. Changing a key time, or adding or removing keys, rewrites that property's keys.
- Add an effect, mask or shape group by adding a node with its `mn`. You can leave out `idx`; the item is added at the end. Remove one by deleting its node. **Don't renumber `idx`**, because it identifies existing items.
- Add a layer by adding an object with no `id` (or a new one). Remove a layer by deleting it. The order of the `layers` array is the stacking order.
- Ease (`inEase`/`outEase`) only has an effect on `bezier` keys. AE ignores ease on `linear` and `hold` keys, so switch the interpolation to `bezier` as well.
- Changing `parent` keeps the JSON transform values as written (it parents "with jump").
- Precomps are duplicated as new versions only when they, or a precomp inside them, changed. Unchanged precomps stay shared.
- If the baseline file is missing, Apply diffs against the comp's current state.

## Limits

- AE won't set **hidden properties**: Material Options on 2D layers, Shadow Color under the Classic 3D renderer, a light's falloff Radius when Falloff is None, transforms on audio-only layers. Export skips the predictable ones. Any others are listed in the log under "Skipped N hidden properties". They have no visible effect.
- The change log only lists edits AE accepted. Rejected values (out of range, for example) appear under Warnings instead.
- When you change a value on a **linear** key, AE recalculates the speed of the eases around it. A diff will show those speeds changing too.

- Layer styles, puppet pins and Essential Graphics overrides aren't recreated by Rebuild; Apply can only patch layer styles that already exist. Per-character text styling isn't exported.
- Values are rounded to 6 decimal places. Key times are exact.
- Effect layer pickers store a layer index, not an ID.
