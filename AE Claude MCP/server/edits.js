// Outline + edit operations over a round-trip export document (see AE Round Trip/README.md for the format).

const INDEXED = new Set(["ADBE Effect Parade", "ADBE Mask Parade", "ADBE Root Vectors Group", "ADBE Vectors Group",
  "ADBE Text Animators", "ADBE Text Selectors"]);

const short = (mn) => mn.replace(/^ADBE /, "");
const fmtNum = (v) => (typeof v === "number" ? +v.toFixed(3) : Array.isArray(v) ? `[${v.map(fmtNum).join(", ")}]` : JSON.stringify(v));

// ---------------------------------------------------------------- lookups

export function findComp(doc, ref) {
  if (ref === undefined || ref === null || ref === "") return doc.comps.find((c) => c.id === doc.root);
  const c = doc.comps.find((c) => c.id === ref || c.name === ref || c.aeId === Number(ref));
  if (!c) throw new Error(`comp "${ref}" is not in this export. Comps: ${doc.comps.map((c) => `${c.id} "${c.name}"`).join(", ")}`);
  return c;
}

export function findLayer(comp, ref) {
  let hits = comp.layers.filter((l) => l.id === ref);
  if (!hits.length) hits = comp.layers.filter((l) => l.name === ref);
  if (!hits.length && /^\d+$/.test(String(ref))) hits = comp.layers.filter((l) => l.index === Number(ref));
  if (!hits.length) throw new Error(`layer "${ref}" not found in "${comp.name}". Layers: ${comp.layers.map((l) => `${l.id} "${l.name}"`).join(", ")}`);
  if (hits.length > 1) throw new Error(`"${ref}" matches ${hits.length} layers in "${comp.name}"; use an id: ${hits.map((l) => l.id).join(", ")}`);
  return hits[0];
}

function splitPath(p) {
  if (Array.isArray(p)) return p;
  return String(p).split("/").map((s) => s.trim()).filter(Boolean);
}

// Walk `path` under a layer's props. Segments are matchNames or display names, optionally "#idx".
// With create, missing nodes are added (groups for inner segments, a leaf for the last one).
export function findNode(layer, pathArg, { create = false, leaf = true } = {}) {
  const segs = splitPath(pathArg);
  if (!segs.length) throw new Error("empty property path");
  let list = (layer.props ||= []), parentIndexed = false, node = null;
  for (let i = 0; i < segs.length; i++) {
    const m = /^(.*?)(?:#(\d+))?$/.exec(segs[i]);
    const key = m[1], idx = m[2] ? Number(m[2]) : null;
    node = list.find((n) => (n.mn === key || n.name === key) && (idx === null || n.idx === idx)) || null;
    if (!node) {
      if (!create) throw new Error(`no property "${segs.slice(0, i + 1).join("/")}" on layer "${layer.name}" (available here: ${list.map((n) => n.mn + (n.idx ? "#" + n.idx : "")).join(", ") || "none"})`);
      const last = i === segs.length - 1;
      node = { mn: key };
      if (idx !== null && parentIndexed) node.idx = idx;
      if (!last || !leaf) { node.props = []; if (INDEXED.has(key)) node.indexed = true; }
      list.push(node);
    }
    if (i < segs.length - 1) {
      if (!node.props) throw new Error(`"${segs.slice(0, i + 1).join("/")}" is a property, not a group`);
      parentIndexed = node.indexed === true || INDEXED.has(node.mn);
      list = node.props;
    }
  }
  return node;
}

// ---------------------------------------------------------------- outline

function walkLeaves(nodes, trail, fn) {
  for (const n of nodes || []) {
    const label = n.name || short(n.mn);
    const seg = n.mn + (n.idx ? "#" + n.idx : "");
    if (n.props) walkLeaves(n.props, [...trail, { label, seg, node: n }], fn);
    else fn(n, [...trail, { label, seg, node: n }]);
  }
}

function layerSummary(L, compsById) {
  const parts = [];
  if (L.source?.type === "comp") parts.push(`-> ${L.source.comp} "${compsById[L.source.comp]?.name ?? "?"}"`);
  const flags = ["threeD", "timeRemap", "adjustment", "guide", "collapse", "motionBlur", "shy", "locked", "solo"].filter((k) => L[k] === true);
  if (L.enabled === false) flags.push("video off");
  if (L.blendingMode && L.blendingMode !== "NORMAL") flags.push("blend:" + L.blendingMode);
  if (L.trackMatte) flags.push(`matte:${L.trackMatte.type}${L.trackMatte.layer ? "<-" + L.trackMatte.layer : ""}`);
  if (flags.length) parts.push(flags.join(" "));
  if (L.parent) parts.push("parent " + L.parent);
  parts.push(`in ${fmtNum(L.inPoint)} out ${fmtNum(L.outPoint)}`);
  const anim = [], fx = [];
  let masks = 0;
  for (const g of L.props || []) {
    if (g.mn === "ADBE Effect Parade") for (const e of g.props || []) fx.push(`${e.name || short(e.mn)}${e.enabled === false ? " (off)" : ""}`);
    if (g.mn === "ADBE Mask Parade") masks = (g.props || []).length;
  }
  let text = null;
  walkLeaves(L.props, [], (n, trail) => {
    if (n.mn === "ADBE Text Document" && n.value) text = n.value.text;
    const p = trail.map((t) => t.label).join(" > ");
    if (n.keys) anim.push(`${p} (${n.keys.length}k)`);
    if (n.expr) anim.push(`${p} [expr]`);
  });
  if (text !== null) parts.push(`text "${text.length > 60 ? text.slice(0, 57) + "..." : text}"`.replace(/\r|\n/g, "⏎"));
  if (fx.length) parts.push("fx: " + fx.join(", "));
  if (masks) parts.push(masks + " mask" + (masks > 1 ? "s" : ""));
  if (anim.length) parts.push("animated: " + anim.join("; "));
  return `  ${String(L.index).padStart(2)} ${L.id} ${L.type} "${L.name}" | ${parts.join(" | ")}`;
}

export function outline(doc, exportId) {
  const byId = Object.fromEntries(doc.comps.map((c) => [c.id, c]));
  const lines = [`export_id: ${exportId}`, `project: ${doc.project ?? "(unsaved)"}`, ""];
  for (const c of doc.comps) {
    lines.push(`COMP ${c.id} "${c.name}"${c.id === doc.root ? " (root)" : ""} — ae id ${c.aeId}, ${c.width}x${c.height}, ${fmtNum(c.frameRate)} fps, ${fmtNum(c.duration)}s, ${c.layers.length} layers${c.markers ? `, ${c.markers.keys?.length ?? 0} comp markers` : ""}`);
    for (const L of c.layers) lines.push(layerSummary(L, byId));
    lines.push("");
  }
  if (doc.footage?.length) {
    lines.push("FOOTAGE");
    for (const f of doc.footage) lines.push(`  ${f.id} ${f.kind} "${f.name}"${f.missing ? " (MISSING)" : ""}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------- edits

const KEY_FIELDS = ["inInterp", "outInterp", "inEase", "outEase", "temporalContinuous", "temporalAutoBezier",
  "inTangent", "outTangent", "spatialContinuous", "spatialAutoBezier", "roving", "label"];

function layerRefToId(comp, ref) {
  if (ref === null || ref === undefined || ref === "") return null;
  return findLayer(comp, ref).id;
}

// Apply one edit operation to `doc` in place. Returns a one-line description.
export function applyOp(doc, op) {
  const comp = findComp(doc, op.comp);
  const where = `"${comp.name}"`;
  const P = Array.isArray(op.path) ? op.path.join(" > ") : op.path;
  switch (op.op) {
    case "set_property": {
      const L = findLayer(comp, op.layer);
      const n = findNode(L, op.path, { create: true });
      if (n.props) throw new Error(`"${op.path}" is a group; give a property path`);
      if ("keys" in op) { n.keys = op.keys; delete n.value; delete n.separated; }
      if ("value" in op) { n.value = op.value; delete n.keys; }
      if ("expr" in op) { if (op.expr) n.expr = op.expr; else { delete n.expr; delete n.exprOn; } }
      if ("exprOn" in op) n.exprOn = op.exprOn;
      if ("separated" in op) n.separated = op.separated;
      return `${where} / ${L.name} / ${P}: set ${["value", "keys", "expr", "exprOn", "separated"].filter((k) => k in op).join(", ")}`;
    }
    case "set_key": {
      const L = findLayer(comp, op.layer);
      const n = findNode(L, op.path, { create: true });
      if (n.props) throw new Error(`"${op.path}" is a group; give a property path`);
      if (!n.keys) {
        if (op.remove) throw new Error(`"${op.path}" has no keyframes`);
        n.keys = [];
        delete n.value;
      }
      const t = Number(op.time);
      const i = n.keys.findIndex((k) => Math.abs(k.t - t) < 1e-3);
      if (op.remove) {
        if (i < 0) throw new Error(`no key at ${t}s on ${op.path} (keys at ${n.keys.map((k) => fmtNum(k.t)).join(", ")})`);
        n.keys.splice(i, 1);
        return `${where} / ${L.name} / ${P}: removed key @${t}s`;
      }
      let k = i >= 0 ? n.keys[i] : null;
      if (!k) {
        if (!("value" in op)) throw new Error(`no key at ${t}s on ${op.path}; give a value to add one (keys at ${n.keys.map((k) => fmtNum(k.t)).join(", ")})`);
        k = { t };
        n.keys.push(k);
        n.keys.sort((a, b) => a.t - b.t);
      }
      if ("value" in op) k.v = op.value;
      if ("newTime" in op) { k.t = Number(op.newTime); n.keys.sort((a, b) => a.t - b.t); }
      for (const f of KEY_FIELDS) if (f in op) k[f] = op[f];
      return `${where} / ${L.name} / ${P}: ${i >= 0 ? "updated" : "added"} key @${t}s`;
    }
    case "add_group": {
      const L = findLayer(comp, op.layer);
      const parent = findNode(L, op.parent, { create: true, leaf: false });
      if (!parent.props) throw new Error(`"${op.parent}" is not a group`);
      parent.indexed ||= INDEXED.has(parent.mn);
      const g = { mn: op.matchName, props: op.props || [] };
      if (op.name) g.name = op.name;
      if ("enabled" in op) g.enabled = op.enabled;
      parent.props.push(g); // no idx: Apply appends it at the end
      return `${where} / ${L.name}: add ${op.matchName} under ${op.parent}`;
    }
    case "remove_group": {
      const L = findLayer(comp, op.layer);
      const segs = splitPath(op.path);
      const parent = segs.length > 1 ? findNode(L, segs.slice(0, -1), { leaf: false }) : { props: L.props };
      const target = findNode(L, segs, { leaf: false });
      if (target.idx === undefined) throw new Error(`"${op.path}" isn't a removable item (only effects, masks, shape groups, text animators…)`);
      parent.props.splice(parent.props.indexOf(target), 1);
      return `${where} / ${L.name}: removed ${P}`;
    }
    case "set_layer": {
      const L = findLayer(comp, op.layer);
      const a = { ...op.attrs };
      if ("parent" in a) a.parent = layerRefToId(comp, a.parent);
      if (a.trackMatte?.layer) a.trackMatte = { ...a.trackMatte, layer: layerRefToId(comp, a.trackMatte.layer) };
      for (const k of ["id", "index", "type", "props", "source"]) if (k in a) throw new Error(`set_layer can't change "${k}"`);
      Object.assign(L, a);
      return `${where} / ${L.name}: set ${Object.keys(a).join(", ")}`;
    }
    case "replace_layer": {
      const L = findLayer(comp, op.layer.id);
      comp.layers[comp.layers.indexOf(L)] = op.layer;
      return `${where} / ${op.layer.name}: replaced layer JSON`;
    }
    case "add_layer": {
      const nl = { ...op.layer };
      delete nl.id; // a new ID is assigned in AE
      if (!nl.type) throw new Error("add_layer needs layer.type (null, solid, text, shape, camera, light, precomp, footage)");
      if (nl.parent) nl.parent = layerRefToId(comp, nl.parent);
      const pos = op.index ? Math.max(0, Math.min(comp.layers.length, op.index - 1)) : 0;
      comp.layers.splice(pos, 0, nl);
      return `${where}: add ${nl.type} layer "${nl.name ?? ""}" at position ${pos + 1}`;
    }
    case "remove_layer": {
      const L = findLayer(comp, op.layer);
      comp.layers.splice(comp.layers.indexOf(L), 1);
      return `${where}: remove layer "${L.name}"`;
    }
    case "move_layer": {
      const L = findLayer(comp, op.layer);
      comp.layers.splice(comp.layers.indexOf(L), 1);
      const pos = Math.max(0, Math.min(comp.layers.length, (op.index || 1) - 1));
      comp.layers.splice(pos, 0, L);
      return `${where}: move "${L.name}" to position ${pos + 1}`;
    }
    case "set_comp": {
      const a = { ...op.attrs };
      for (const k of ["id", "aeId", "name", "layers"]) if (k in a) throw new Error(`set_comp can't change "${k}"`);
      Object.assign(comp, a);
      return `${where}: set ${Object.keys(a).join(", ")}`;
    }
    default:
      throw new Error(`unknown op "${op.op}"`);
  }
}

// Return selected layers (full JSON), optionally trimmed to some property paths.
export function getLayers(doc, compRef, layerRefs, paths) {
  const comp = findComp(doc, compRef);
  const layers = (layerRefs?.length ? layerRefs.map((r) => findLayer(comp, r)) : comp.layers);
  if (!paths?.length) return { comp: comp.id, layers };
  return {
    comp: comp.id,
    layers: layers.map((L) => {
      const props = {};
      for (const p of paths) { try { props[p] = findNode(L, p); } catch (e) { props[p] = { error: e.message }; } }
      return { id: L.id, name: L.name, props };
    }),
  };
}
