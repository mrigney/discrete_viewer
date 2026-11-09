// Discrete Viewer — application logic: model state, editing (with undo/redo), panels, save.
import { Viewer } from './viewer.js';
import { categorical, viridis, VIRIDIS_CSS, rgbToHex, SELECT_RGB, DIM_RGB, NEUTRAL_RGB, UNASSIGNED_RGB } from './colors.js';

const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const TYPED = {
  '|i1': Int8Array, '|u1': Uint8Array, '<i2': Int16Array, '<u2': Uint16Array,
  '<i4': Int32Array, '<u4': Uint32Array, '<f4': Float32Array, '<f8': Float64Array,
};
const INT_RANGE = {
  i1: [-128, 127], u1: [0, 255], i2: [-32768, 32767], u2: [0, 65535],
  i4: [-2147483648, 2147483647], u4: [0, 4294967295],
  i8: [-Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER], u8: [0, Number.MAX_SAFE_INTEGER],
};
const NAMES_KEY = '__groupNames__';
// Inline SVG icons (emoji glyphs are missing on many Linux desktops)
const svg = d => `<svg class="ico" viewBox="0 0 16 16" aria-hidden="true">${d}</svg>`;
const ICON = {
  eye: svg('<path d="M1 8s2.5-4.5 7-4.5S15 8 15 8s-2.5 4.5-7 4.5S1 8 1 8z" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="8" r="2" fill="currentColor"/>'),
  folder: svg('<path d="M1.5 3.5h4l1.5 1.5h7.5v8h-13z" fill="none" stroke="currentColor" stroke-width="1.3"/>'),
  file: svg('<path d="M3.5 1.5h6l3 3v10h-9z M9.5 1.5v3h3" fill="none" stroke="currentColor" stroke-width="1.3"/>'),
  up: svg('<path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.5"/>'),
};

const viewer = new Viewer($('#viewport'));
viewer.setBackground('#202329');
let S = null; // the open model

// =========================================================================== helpers
function fmt(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'number') {
    if (Number.isInteger(v)) return String(v);
    return String(Number(v.toPrecision(7)));
  }
  return String(v);
}
function fmtBytes(n) {
  return n > 1 << 20 ? (n / (1 << 20)).toFixed(1) + ' MB' : n > 1024 ? (n / 1024).toFixed(1) + ' kB' : n + ' B';
}
function dtypeCode(d) { return d.slice(1).replace(/^([iuf])/, '$1'); } // '<u2' -> 'u2'
function isIntDtype(d) { return d[1] === 'i' || d[1] === 'u'; }
// Variables are keyed internally by a stable id: the name in the file, or "__newN" for variables
// added this session. dispName() gives the (possibly renamed) name shown and written.
const dispName = id => S.renames[id] ?? id;
const labelsFor = id => S.labels[dispName(id)] || S.labels[id];
/** Effective value of a root variable attribute, including unsaved edits. */
function varAttr(id, name) {
  const ed = S.attrEdits['/' + id]?.[name];
  if (ed === null) return undefined;
  if (ed) return ed.dtype === 'str' ? ed.value : Number(String(ed.value).split(/[\s,]+/)[0]);
  const a = S.info.schema.vars.find(v => v.name === id)?.attrs.find(x => x.name === name);
  return a ? (Array.isArray(a.value) ? a.value[0] : a.value) : undefined;
}
const unassignedValue = id => { const u = varAttr(id, 'unassigned_value'); return u === undefined || u === '' ? undefined : Number(u); };
function label(id, value) {
  const l = labelsFor(id);
  if (l && l[String(value)] !== undefined) return l[String(value)];
  const u = unassignedValue(id);
  if (u !== undefined && u === Number(value)) return '(unassigned)';
  return undefined;
}
function withLabel(varName, value) {
  const l = label(varName, value);
  return l ? `${fmt(value)} · ${l}` : fmt(value);
}
let toastTimer;
function toast(msg, kind = '') {
  const t = $('#toast');
  t.textContent = msg; t.className = kind; t.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.style.display = 'none'), kind === 'err' ? 6000 : 2500);
}
function setMsg(m) { $('#st-msg').textContent = m || ''; }

async function apiJson(url, body) {
  const r = await fetch(url, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) { const e = new Error(j.error || r.statusText); e.data = j; e.status = r.status; throw e; }
  return j;
}
async function apiBin(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error((await r.json()).error);
  if ((r.headers.get('Content-Type') || '').startsWith('application/json')) return { json: await r.json() };
  return {
    buf: await r.arrayBuffer(), dtype: r.headers.get('X-Dtype'), origDtype: r.headers.get('X-Orig-Dtype'),
    shape: JSON.parse(r.headers.get('X-Shape') || '[]'),
  };
}
async function fetchVar(name) {
  const r = await apiBin('/api/var?name=' + encodeURIComponent('/' + name));
  if (r.json) return { strings: r.json.strings };
  const T = TYPED[r.dtype];
  if (!T) throw new Error(`unsupported dtype ${r.dtype} for ${name}`);
  return { arr: new T(r.buf), dtype: r.dtype, origDtype: r.origDtype, shape: r.shape };
}
function toB64(typed) {
  const u8 = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
function sameArray(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// =========================================================================== loading
async function openPath(path) {
  if (S && isDirty() && !confirm('Discard unsaved changes?')) return;
  try {
    setMsg('Opening…');
    const info = await apiJson('/api/open', { path });
    await loadModel(info);
  } catch (e) { toast(e.message, 'err'); setMsg(''); }
}

async function loadModel(info, keepView = false) {
  const m = info.mapping;
  const prev = S;
  S = {
    info, path: info.path, mapping: m, labels: info.labels || {},
    vars: {}, orig: {}, elemVars: m.elemVars || [], groupVars: m.groupVars || [],
    names: [], origNames: [], namesVirtual: !m.groupNames, groupsVirtual: !m.groupId,
    undo: [], redo: [], attrEdits: {}, adj: null, legend: null,
    newVars: {}, deleted: new Set(), deletedPos: {}, renames: {}, newCounter: 0,
    colorBy: prev?.colorBy || 'group',
  };
  document.title = 'Discrete Viewer — ' + info.path.split(/[\\/]/).pop();
  $('#st-file').textContent = info.path;
  $('#st-file').title = info.path;

  if (!m.conn) {
    viewer.clearMesh();
    S.nElem = 0;
    $('#empty').style.display = 'flex';
    $('#empty h2').textContent = 'No renderable geometry';
    $('#empty p').textContent = (m.warnings || []).join(' ') + ' The Schema tab still lets you inspect and edit attributes.';
    renderSchema(); setTab('schema'); updateToolbar(); setMsg('');
    return;
  }
  $('#empty').style.display = 'none';

  setMsg('Loading geometry…');
  const [pos, con] = await Promise.all([apiBin('/api/geometry?part=positions'), apiBin('/api/geometry?part=elements')]);
  S.positions = new Float32Array(pos.buf);
  S.conn = new Uint32Array(con.buf);
  S.k = con.shape[1];
  S.nVerts = S.positions.length / 3;
  S.nElem = con.shape[0];

  setMsg('Loading properties…');
  const toLoad = [...S.elemVars.map(n => [n, 'elem']), ...S.groupVars.map(n => [n, 'group'])];
  if (m.groupId) toLoad.push([m.groupId, 'gid']);
  if (m.groupNames) toLoad.push([m.groupNames, 'names']);
  const loaded = await Promise.all(toLoad.map(([n]) => fetchVar(n)));
  toLoad.forEach(([name, scope], i) => {
    const d = loaded[i];
    if (scope === 'names') { S.names = d.strings.slice(); S.origNames = d.strings.slice(); return; }
    S.vars[name] = { name, scope, arr: d.arr, dtype: d.dtype, origDtype: d.origDtype || d.dtype };
    S.orig[name] = d.arr.slice();
  });
  S.gid = m.groupId ? S.vars[m.groupId] : { name: null, scope: 'gid', arr: new Uint8Array(S.nElem), dtype: '|u1', origDtype: '|u1' };

  let nG = S.names.length;
  if (S.namesVirtual) {
    let mx = 0;
    for (const g of S.gid.arr) if (g > mx) mx = g;
    nG = Math.max(mx + 1, ...S.groupVars.map(n => S.vars[n].arr.length), 1);
    S.names = Array.from({ length: nG }, (_, g) => S.groupsVirtual ? '(all elements)' : `Group ${g}`);
  }
  S.nGroups = nG;

  buildRenderMesh();
  S.visible = new Uint8Array(S.nElem).fill(1);
  S.sel = new Uint8Array(S.nElem);
  S.selCount = 0;
  if (keepView && prev && prev.nElem === S.nElem) {
    S.visible.set(prev.visible); S.sel.set(prev.sel);
  }
  recountGroups();
  viewer.setMesh(S.positions, S.renderTris, S.triElem, S.nElem);
  viewer.setVisibility(S.visible);
  populateColorBy();
  refreshColors(true);
  renderGroupTable();
  renderSelection();
  renderSchema();
  updateToolbar();
  updateCounts();
  setMsg(m.warnings?.length ? m.warnings.join(' ') : '');
}

function buildRenderMesh() {
  const { conn, k, nElem, nVerts, positions } = S;
  const valid = v => v < nVerts;
  const tris = [], te = [];
  const pushTri = (a, b, c, e) => {
    if (!valid(a) || !valid(b) || !valid(c) || a === b || b === c || a === c) return;
    tris.push(a, b, c); te.push(e);
  };
  for (let e = 0; e < nElem; e++) {
    const o = e * k;
    pushTri(conn[o], conn[o + 1], conn[o + 2], e);
    if (k === 4) pushTri(conn[o], conn[o + 2], conn[o + 3], e);
  }
  S.renderTris = Uint32Array.from(tris);
  S.triElem = Uint32Array.from(te);
  // element centroids
  const c = new Float32Array(nElem * 3);
  for (let e = 0; e < nElem; e++) {
    let n = 0, x = 0, y = 0, z = 0;
    for (let j = 0; j < k; j++) {
      const v = conn[e * k + j];
      if (!valid(v)) continue;
      x += positions[v * 3]; y += positions[v * 3 + 1]; z += positions[v * 3 + 2]; n++;
    }
    if (n) { c[e * 3] = x / n; c[e * 3 + 1] = y / n; c[e * 3 + 2] = z / n; }
  }
  S.centroids = c;
}

/** CSR lists of elements per group (S.gOff, S.gList) */
function recountGroups() {
  const nG = S.nGroups, g = S.gid.arr, E = S.nElem;
  const cnt = new Uint32Array(nG + 1);
  for (let e = 0; e < E; e++) if (g[e] < nG) cnt[g[e] + 1]++;
  for (let i = 0; i < nG; i++) cnt[i + 1] += cnt[i];
  const list = new Uint32Array(cnt[nG]), fill = cnt.slice(0, nG);
  for (let e = 0; e < E; e++) if (g[e] < nG) list[fill[g[e]]++] = e;
  S.gOff = cnt; S.gList = list;
}
const groupElems = g => S.gList.subarray(S.gOff[g], S.gOff[g + 1]);
const groupName = g => (g < S.names.length ? S.names[g] : `#${g}`);

// =========================================================================== colouring
function populateColorBy() {
  const sel = $('#sel-colorby');
  let h = '';
  if (!S.groupsVirtual) h += `<option value="group">Group</option>`;
  if (S.elemVars.length) h += `<optgroup label="Per element">${S.elemVars.map(n => `<option value="e:${esc(n)}">${esc(dispName(n))}</option>`).join('')}</optgroup>`;
  if (S.groupVars.length) h += `<optgroup label="Per group">${S.groupVars.map(n => `<option value="g:${esc(n)}">${esc(dispName(n))}</option>`).join('')}</optgroup>`;
  h += `<option value="none">Uniform</option>`;
  sel.innerHTML = h;
  if (![...sel.options].some(o => o.value === S.colorBy)) S.colorBy = sel.options[0].value;
  sel.value = S.colorBy;
}

/** value accessor for the current colour mode */
function colorSource() {
  const mode = S.colorBy, gid = S.gid.arr;
  if (mode === 'group') return { title: 'Group', varName: null, isInt: true, get: e => gid[e], isGroup: true };
  if (mode.startsWith('e:')) {
    const v = S.vars[mode.slice(2)];
    return { title: dispName(v.name), varName: v.name, isInt: isIntDtype(v.origDtype), get: e => v.arr[e] };
  }
  if (mode.startsWith('g:')) {
    const v = S.vars[mode.slice(2)];
    return { title: `${dispName(v.name)} (per group)`, varName: v.name, isInt: isIntDtype(v.origDtype), get: e => v.arr[gid[e]] };
  }
  return null;
}

/** Recompute base colours (if data/mode changed) then overlay the selection. */
function refreshColors(recomputeBase = true) {
  if (!S || !S.nElem) return;
  const E = S.nElem;
  if (recomputeBase || !S.baseRGB) {
    const base = S.baseRGB = new Uint8Array(E * 3);
    const src = colorSource();
    S.legend = null;
    if (!src) {
      for (let e = 0; e < E; e++) base.set(NEUTRAL_RGB, e * 3);
    } else {
      // categorical if integer with modest number of distinct values
      const counts = new Map();
      let mn = Infinity, mx = -Infinity;
      for (let e = 0; e < E; e++) {
        const v = src.get(e);
        if (v < mn) mn = v; if (v > mx) mx = v;
        if (counts.size <= 256) counts.set(v, (counts.get(v) || 0) + 1);
      }
      if (src.isInt && counts.size <= 256) {
        const vals = [...counts.keys()].sort((a, b) => a - b);
        const cmap = new Map();
        const un = src.isGroup ? undefined : unassignedValue(src.varName);
        let ci = 0;
        vals.forEach(v => cmap.set(v, src.isGroup ? categorical(v) : v === un ? UNASSIGNED_RGB : categorical(ci++)));
        for (let e = 0; e < E; e++) base.set(cmap.get(src.get(e)), e * 3);
        S.legend = {
          type: 'cat', title: src.title, src,
          items: (src.isGroup ? [...Array(S.nGroups).keys()].filter(g => counts.has(g)) : vals).map(v => ({
            value: v, color: cmap.get(v), count: counts.get(v),
            text: src.isGroup ? `${v}: ${groupName(v)}` : withLabel(src.varName, v),
          })),
        };
      } else {
        const span = mx - mn || 1;
        for (let e = 0; e < E; e++) base.set(viridis((src.get(e) - mn) / span), e * 3);
        S.legend = { type: 'cont', title: src.title, min: mn, max: mx };
      }
    }
    renderLegend();
  }
  const rgb = S.baseRGB.slice();
  if (S.selCount) {
    const sel = S.sel, [sr, sg, sb] = SELECT_RGB, [dr, dg, db] = DIM_RGB;
    for (let e = 0; e < E; e++) {
      const o = e * 3;
      if (sel[e]) {
        rgb[o] = rgb[o] * 0.25 + sr * 0.75; rgb[o + 1] = rgb[o + 1] * 0.25 + sg * 0.75; rgb[o + 2] = rgb[o + 2] * 0.25 + sb * 0.75;
      } else {
        rgb[o] = rgb[o] * 0.55 + dr * 0.45; rgb[o + 1] = rgb[o + 1] * 0.55 + dg * 0.45; rgb[o + 2] = rgb[o + 2] * 0.55 + db * 0.45;
      }
    }
  }
  viewer.setElementColors(rgb);
}

function renderLegend() {
  const L = S.legend, el = $('#legend');
  if (!L) { el.style.display = 'none'; return; }
  el.style.display = 'block';
  if (L.type === 'cont') {
    el.innerHTML = `<h5>${esc(L.title)}</h5><div class="bar" style="background:${VIRIDIS_CSS}"></div>
      <div class="rng"><span>${fmt(L.min)}</span><span>${fmt((L.min + L.max) / 2)}</span><span>${fmt(L.max)}</span></div>`;
    return;
  }
  el.innerHTML = `<h5>${esc(L.title)} <span style="font-weight:400">— click to select</span></h5>` + L.items.map((it, i) =>
    `<div class="li" data-i="${i}"><span class="swatch" style="background:${rgbToHex(it.color)}"></span>${esc(it.text)}<span class="cnt">${it.count.toLocaleString()}</span></div>`).join('');
}
$('#legend').addEventListener('click', ev => {
  const li = ev.target.closest('.li');
  if (!li || !S.legend) return;
  const it = S.legend.items[+li.dataset.i], src = S.legend.src;
  const idx = [];
  for (let e = 0; e < S.nElem; e++) if (src.get(e) === it.value && S.visible[e]) idx.push(e);
  select(idx, modeFromEvent(ev));
});

// =========================================================================== selection
function modeFromEvent(ev) { return ev.shiftKey ? 'add' : (ev.ctrlKey || ev.metaKey) ? 'remove' : 'replace'; }

function select(indices, mode = 'replace') {
  if (!S || !S.nElem) return;
  if (mode === 'replace') S.sel.fill(0);
  const v = mode === 'remove' ? 0 : 1;
  for (const e of indices) S.sel[e] = v;
  selectionChanged();
}
function selectionChanged() {
  let n = 0;
  for (let e = 0; e < S.nElem; e++) n += S.sel[e];
  S.selCount = n;
  const b = $('#sel-badge');
  b.textContent = n.toLocaleString(); b.classList.toggle('on', n > 0);
  refreshColors(false);
  updateGroupRowStates();
  renderSelection();
  updateCounts();
}
function selectedIndices() {
  const out = new Uint32Array(S.selCount);
  for (let e = 0, j = 0; e < S.nElem; e++) if (S.sel[e]) out[j++] = e;
  return out;
}
function selectAll() { const idx = []; for (let e = 0; e < S.nElem; e++) if (S.visible[e]) idx.push(e); select(idx); }
function invertSelection() { for (let e = 0; e < S.nElem; e++) S.sel[e] = S.visible[e] && !S.sel[e] ? 1 : 0; selectionChanged(); }

/** Vertex adjacency (vertices welded by exact position) for connected-part selection. */
function buildAdjacency() {
  const { positions, conn, k, nElem, nVerts } = S;
  const u = new Uint32Array(positions.buffer, positions.byteOffset, positions.length);
  const canon = new Uint32Array(nVerts), map = new Map();
  let n = 0;
  for (let v = 0; v < nVerts; v++) {
    const key = u[v * 3] + ',' + u[v * 3 + 1] + ',' + u[v * 3 + 2];
    let id = map.get(key);
    if (id === undefined) { id = n++; map.set(key, id); }
    canon[v] = id;
  }
  const off = new Uint32Array(n + 1);
  for (let i = 0; i < nElem * k; i++) if (conn[i] < nVerts) off[canon[conn[i]] + 1]++;
  for (let i = 0; i < n; i++) off[i + 1] += off[i];
  const list = new Uint32Array(off[n]), fill = off.slice(0, n);
  for (let i = 0; i < nElem * k; i++) if (conn[i] < nVerts) list[fill[canon[conn[i]]]++] = (i / k) | 0;
  S.adj = { canon, off, list };
}
function connectedFrom(seeds) {
  if (!S.adj) buildAdjacency();
  const { canon, off, list } = S.adj, { conn, k, nVerts, visible } = S;
  const seen = new Uint8Array(S.nElem), queue = new Uint32Array(S.nElem);
  let qh = 0, qt = 0;
  for (const s of seeds) if (!seen[s]) { seen[s] = 1; queue[qt++] = s; }
  while (qh < qt) {
    const e = queue[qh++];
    for (let j = 0; j < k; j++) {
      const v = conn[e * k + j];
      if (v >= nVerts) continue;
      const c = canon[v];
      for (let p = off[c]; p < off[c + 1]; p++) {
        const f = list[p];
        if (!seen[f] && visible[f]) { seen[f] = 1; queue[qt++] = f; }
      }
    }
  }
  return queue.subarray(0, qt);
}
function expandPick(e) {
  const mode = $('#sel-pick').value;
  if (mode === 'connected') return connectedFrom([e]);
  if (mode === 'group') return Array.from(groupElems(S.gid.arr[e])).filter(f => S.visible[f]);
  return [e];
}

// =========================================================================== visibility
function setVisible(fn) {
  for (let e = 0; e < S.nElem; e++) S.visible[e] = fn(e) ? 1 : 0;
  // hidden elements drop out of the selection
  for (let e = 0; e < S.nElem; e++) if (!S.visible[e]) S.sel[e] = 0;
  viewer.setVisibility(S.visible);
  selectionChanged();
  renderGroupTable();
}
const hideSelected = () => S?.selCount && setVisible(e => S.visible[e] && !S.sel[e]);
const isolateSelected = () => S?.selCount && setVisible(e => S.sel[e]);
const showAll = () => S?.nElem && setVisible(() => true);

function frameSelection() {
  if (!S?.nElem) return;
  const useSel = S.selCount > 0;
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  const { conn, k, positions, nVerts } = S;
  for (let e = 0; e < S.nElem; e++) {
    if (useSel ? !S.sel[e] : !S.visible[e]) continue;
    for (let j = 0; j < k; j++) {
      const v = conn[e * k + j];
      if (v >= nVerts) continue;
      for (let a = 0; a < 3; a++) {
        const p = positions[v * 3 + a];
        if (p < mn[a]) mn[a] = p; if (p > mx[a]) mx[a] = p;
      }
    }
  }
  if (mn[0] === Infinity) return;
  viewer.frameBox({
    isEmpty: () => false,
    getCenter: t => t.set((mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, (mn[2] + mx[2]) / 2),
    getSize: t => t.set(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]),
  });
}

// =========================================================================== edits + undo
function exec(cmd) {
  cmd.do();
  S.undo.push(cmd);
  S.redo = [];
  afterEdit(cmd);
}
function undo() { if (!S?.undo.length) return; const c = S.undo.pop(); c.undo(); S.redo.push(c); afterEdit(c); toast('Undo: ' + c.label); }
function redo() { if (!S?.redo.length) return; const c = S.redo.pop(); c.do(); S.undo.push(c); afterEdit(c); toast('Redo: ' + c.label); }

function afterEdit(cmd) {
  if (cmd.touches?.has('gid') || cmd.touches?.has('groups')) recountGroups();
  // attribute edits can change what's displayed too (unassigned_value), so refresh everything
  populateColorBy();
  refreshColors(true);
  renderGroupTable();
  renderSelection();
  renderSchema();
  updateToolbar();
  updateCounts();
}

function parseValue(raw, v) {
  const s = String(raw).trim();
  if (s === '') throw new Error('empty value');
  let num = Number(s);
  const vn = S.vars[v.name] ? dispName(v.name) : v.name;
  if (Number.isNaN(num) && labelsFor(v.name)) {
    const hit = Object.entries(labelsFor(v.name)).find(([, l]) => l.toLowerCase() === s.toLowerCase());
    if (hit) num = Number(hit[0]);
  }
  if (Number.isNaN(num) && s.toLowerCase() === '(unassigned)' && unassignedValue(v.name) !== undefined) num = unassignedValue(v.name);
  if (!Number.isFinite(num)) throw new Error(`"${s}" is not a number`);
  if (isIntDtype(v.origDtype)) {
    if (!Number.isInteger(num)) throw new Error(`${vn} is an integer variable`);
    const [lo, hi] = INT_RANGE[dtypeCode(v.origDtype)] || [-Infinity, Infinity];
    if (num < lo || num > hi) throw new Error(`${num} out of range for ${vn} (${dtypeCode(v.origDtype)}: ${lo}…${hi})`);
  }
  return num;
}

function cmdSetElems(varName, indices, value, labelText) {
  const v = S.vars[varName] || (S.gid.name === varName ? S.gid : null);
  const idx = Uint32Array.from(indices);
  let old = null;
  return {
    label: labelText || `${dispName(varName)} = ${fmt(value)} on ${idx.length.toLocaleString()} element(s)`,
    touches: new Set(v.scope === 'gid' ? ['gid'] : ['elem']),
    do() {
      const a = v.arr;
      if (!old) { old = new a.constructor(idx.length); for (let i = 0; i < idx.length; i++) old[i] = a[idx[i]]; }
      for (let i = 0; i < idx.length; i++) a[idx[i]] = value;
    },
    undo() { const a = v.arr; for (let i = 0; i < idx.length; i++) a[idx[i]] = old[i]; },
  };
}
function cmdSetGroup(key, g, value) {
  let old;
  if (key === NAMES_KEY) {
    return {
      label: `rename group ${g} → "${value}"`, touches: new Set(['names']),
      do() { old = S.names[g]; S.names[g] = value; }, undo() { S.names[g] = old; },
    };
  }
  const v = S.vars[key];
  return {
    label: `${dispName(key)}[${groupName(g)}] = ${fmt(value)}`, touches: new Set(['group']),
    do() { old = v.arr[g]; v.arr[g] = value; }, undo() { v.arr[g] = old; },
  };
}
function cmdAddGroup(name, template) {
  return {
    label: `add group "${name}"`, touches: new Set(['groups']),
    do() {
      for (const n of S.groupVars) {
        const a = S.vars[n].arr, b = new a.constructor(a.length + 1);
        b.set(a); b[a.length] = template >= 0 && template < a.length ? a[template] : 0;
        S.vars[n].arr = b;
      }
      S.names.push(name); S.nGroups++;
    },
    undo() {
      for (const n of S.groupVars) S.vars[n].arr = S.vars[n].arr.slice(0, -1);
      S.names.pop(); S.nGroups--;
    },
  };
}
function macro(label, cmds) {
  const touches = new Set(cmds.flatMap(c => [...(c.touches || [])]));
  return {
    label, touches,
    do() { cmds.forEach(c => c.do()); }, undo() { [...cmds].reverse().forEach(c => c.undo()); },
  };
}
function cmdAttr(objPath, name, next) {
  // next: {value, dtype} | null (delete) | undefined (revert to file value)
  let prev;
  return {
    label: `${next === null ? 'delete' : 'set'} attribute ${objPath === '/' ? '' : objPath}@${name}`, touches: new Set(['attrs']),
    do() {
      prev = S.attrEdits[objPath]?.[name];
      setAttrEdit(objPath, name, next);
    },
    undo() { setAttrEdit(objPath, name, prev); },
  };
}
function setAttrEdit(obj, name, val) {
  if (val === undefined) {
    if (S.attrEdits[obj]) { delete S.attrEdits[obj][name]; if (!Object.keys(S.attrEdits[obj]).length) delete S.attrEdits[obj]; }
  } else (S.attrEdits[obj] ||= {})[name] = val;
}

// ---- structural edits: add / delete / rename root variables
/** spec: {scope: 'group'|'elem', dtype, arr, name, attrs: {attr: {value, dtype}}} */
function cmdAddVar(spec) {
  const id = `__new${++S.newCounter}`;
  return {
    label: `add variable "${spec.name}"`, touches: new Set(['struct']), id,
    do() {
      S.vars[id] = { name: id, scope: spec.scope, arr: spec.arr, dtype: spec.dtype, origDtype: spec.dtype, isNew: true };
      S.newVars[id] = { scope: spec.scope };
      S.renames[id] = spec.name;
      (spec.scope === 'group' ? S.groupVars : S.elemVars).push(id);
      for (const [k, v] of Object.entries(spec.attrs)) setAttrEdit('/' + id, k, v);
    },
    undo() {
      const list = spec.scope === 'group' ? S.groupVars : S.elemVars;
      list.splice(list.indexOf(id), 1);
      delete S.vars[id]; delete S.newVars[id]; delete S.renames[id]; delete S.attrEdits['/' + id];
    },
  };
}
function cmdDeleteVar(id, restore = false) {
  const flip = (del) => {
    if (del) {
      S.deleted.add(id);
      for (const list of [S.groupVars, S.elemVars]) {
        const i = list.indexOf(id);
        if (i >= 0) { S.deletedPos[id] = { list, i }; list.splice(i, 1); }
      }
    } else {
      S.deleted.delete(id);
      const p = S.deletedPos[id];
      if (p) { p.list.splice(Math.min(p.i, p.list.length), 0, id); delete S.deletedPos[id]; }
    }
  };
  return {
    label: `${restore ? 'restore' : 'delete'} variable "${dispName(id)}"`, touches: new Set(['struct']),
    do() { flip(!restore); }, undo() { flip(restore); },
  };
}
function cmdRenameVar(id, newName) {
  let prev;
  return {
    label: `rename variable "${dispName(id)}" → "${newName}"`, touches: new Set(['struct']),
    do() { prev = S.renames[id]; if (newName === id) delete S.renames[id]; else S.renames[id] = newName; },
    undo() { if (prev === undefined) delete S.renames[id]; else S.renames[id] = prev; },
  };
}
/** Names a root variable would have on save, excluding `exceptId`. */
function finalVarNames(exceptId) {
  const names = new Set();
  for (const v of S.info.schema.vars) if (v.name !== exceptId && !S.deleted.has(v.name)) names.add(dispName(v.name));
  for (const id of Object.keys(S.newVars)) if (id !== exceptId && !S.deleted.has(id)) names.add(dispName(id));
  return names;
}
function checkVarName(name, exceptId) {
  if (!/^[A-Za-z_][A-Za-z0-9_.@+-]*$/.test(name)) throw new Error(`"${name}" is not a valid netCDF variable name (letters, digits, _ . @ + -; must not start with a digit)`);
  if (finalVarNames(exceptId).has(name)) throw new Error(`a variable named "${name}" already exists`);
}
const STRUCTURAL_ROLES = ['vertex coordinates', 'connectivity', 'element → group', 'group names'];
const isStructural = id => STRUCTURAL_ROLES.some(r => varRole(id).startsWith(r));

const NEW_VAR_DTYPES = [
  ['<u2', 'uint16'], ['|u1', 'uint8'], ['<i2', 'int16'], ['<u4', 'uint32'], ['<i4', 'int32'], ['<f4', 'float32'], ['<f8', 'float64'],
];
async function addVariableDialog() {
  if (!S?.nElem) return toast('Open a model with geometry first', 'err');
  const scopes = [];
  if (S.mapping.groupDim && !S.groupsVirtual) scopes.push({ value: 'group', text: `Per group (${S.mapping.groupDim}, ${S.nGroups})` });
  scopes.push({ value: 'elem', text: `Per element (${S.mapping.elemDim}, ${S.nElem.toLocaleString()})` });
  const sources = [{ value: '', text: 'Constant value (below)' },
    ...S.groupVars.map(n => ({ value: n, text: `Copy of ${dispName(n)} (per group)` })),
    ...S.elemVars.map(n => ({ value: n, text: `Copy of ${dispName(n)} (per element)` }))];
  const r = await promptDialog('Add variable', [
    { key: 'name', label: 'Name', placeholder: 'e.g. surfaceMaterial' },
    { key: 'scope', label: 'Applies to', type: 'select', value: scopes[0].value, options: scopes },
    { key: 'dtype', label: 'Data type', type: 'select', value: '<u2', options: NEW_VAR_DTYPES.map(([value, text]) => ({ value, text })) },
    { key: 'src', label: 'Initial values', type: 'select', value: '', options: sources },
    { key: 'value', label: 'Constant value', value: '0' },
    { key: 'unassigned', label: 'Value meaning "unassigned" (stored as attribute unassigned_value; blank = none)', value: '0' },
    { key: 'long_name', label: 'Description (long_name attribute, optional)', value: '' },
  ]);
  if (!r) return;
  try {
    const name = r.name.trim();
    checkVarName(name);
    const fake = { name, origDtype: r.dtype };
    const n = r.scope === 'group' ? S.nGroups : S.nElem;
    const arr = new TYPED[r.dtype](n);
    if (r.src) {
      const srcVar = S.vars[r.src];
      if (srcVar.scope !== r.scope) throw new Error(`${dispName(r.src)} is ${srcVar.scope === 'group' ? 'per group' : 'per element'}; pick a source with the same scope`);
      for (let i = 0; i < n; i++) arr[i] = parseValue(srcVar.arr[i], fake);
    } else {
      arr.fill(parseValue(r.value, fake));
    }
    const attrs = {};
    if (r.long_name.trim()) attrs.long_name = { value: r.long_name.trim(), dtype: 'str' };
    if (r.unassigned.trim() !== '') attrs.unassigned_value = { value: String(parseValue(r.unassigned, fake)), dtype: r.dtype };
    exec(cmdAddVar({ scope: r.scope, dtype: r.dtype, arr, name, attrs }));
    toast(`Added ${name} — edit it in the Groups${r.scope === 'elem' ? ' / Selection' : ''} tab`, 'ok');
  } catch (e) { toast(e.message, 'err'); }
}

function dirtyVars() {
  const out = [];
  for (const [name, v] of Object.entries(S.vars)) {
    if (v.isNew || S.deleted.has(name)) continue;
    if (!sameArray(v.arr, S.orig[name])) out.push(name);
  }
  if (!S.namesVirtual && !sameArray(S.names, S.origNames)) out.push(NAMES_KEY);
  return out;
}
function structuralChanges() {
  const added = Object.keys(S.newVars).filter(id => !S.deleted.has(id));
  const deleted = [...S.deleted].filter(id => !S.newVars[id]);
  const renamed = Object.keys(S.renames).filter(id => !S.newVars[id] && !S.deleted.has(id));
  return { added, deleted, renamed, count: added.length + deleted.length + renamed.length };
}
/** Attribute edits that will actually be written (drops edits on deleted variables). */
function liveAttrEdits() {
  const out = {};
  for (const [obj, e] of Object.entries(S.attrEdits)) {
    const id = obj.replace(/^\//, '');
    if (S.deleted.has(id)) continue;
    out[obj] = e;
  }
  return out;
}
function isDirty() {
  return S && (dirtyVars().length > 0 || Object.keys(liveAttrEdits()).length > 0 || structuralChanges().count > 0);
}

/** Assign to the selection, with support for "new group" on the groupId variable. */
async function assignToSelection(varName, rawValue) {
  if (!S.selCount) return toast('Nothing selected', 'err');
  const idx = selectedIndices();
  try {
    if (S.gid.name === varName) {
      if (rawValue === '__new__') {
        const tmpl = mostCommonGroup(idx);
        const r = await promptDialog('New group from selection', [
          { key: 'name', label: 'Group name', value: `${groupName(tmpl)} (copy)` },
          { key: 'tmpl', label: 'Copy per-group properties from', type: 'select', value: String(tmpl), options: groupOptions() },
        ]);
        if (!r || !r.name.trim()) return;
        const g = S.nGroups;
        const [lo, hi] = INT_RANGE[dtypeCode(S.gid.origDtype)];
        if (g > hi) return toast(`groupId (${dtypeCode(S.gid.origDtype)}) cannot hold ${g} groups`, 'err');
        exec(macro(`move ${idx.length.toLocaleString()} element(s) to new group "${r.name.trim()}"`,
          [cmdAddGroup(r.name.trim(), +r.tmpl), cmdSetElems(varName, idx, g)]));
        return;
      }
      const g = +rawValue;
      exec(cmdSetElems(varName, idx, g, `move ${idx.length.toLocaleString()} element(s) to group "${groupName(g)}"`));
      return;
    }
    const v = S.vars[varName];
    exec(cmdSetElems(varName, idx, parseValue(rawValue, v)));
  } catch (e) { toast(e.message, 'err'); }
}
function mostCommonGroup(idx) {
  const c = new Map(); let best = 0, bn = -1;
  for (const e of idx) { const g = S.gid.arr[e]; const n = (c.get(g) || 0) + 1; c.set(g, n); if (n > bn) { bn = n; best = g; } }
  return best;
}
const groupOptions = () => S.names.map((n, g) => ({ value: String(g), text: `${g}: ${n}` }));

// =========================================================================== group table
function perGroupStats(arr) {
  const nG = S.nGroups, mn = new Float64Array(nG).fill(Infinity), mx = new Float64Array(nG).fill(-Infinity);
  const g = S.gid.arr;
  for (let e = 0; e < S.nElem; e++) {
    const gi = g[e], v = arr[e];
    if (gi >= nG) continue;
    if (v < mn[gi]) mn[gi] = v; if (v > mx[gi]) mx[gi] = v;
  }
  return { mn, mx };
}
function renderGroupTable() {
  const t = $('#group-table');
  if (!S || !S.nElem) { t.innerHTML = ''; return; }
  const keep = document.activeElement?.dataset?.key;
  const nG = S.nGroups, g = S.gid.arr;
  const visCount = new Uint32Array(nG);
  for (let e = 0; e < S.nElem; e++) if (S.visible[e] && g[e] < nG) visCount[g[e]]++;
  const eStats = S.elemVars.map(n => perGroupStats(S.vars[n].arr));
  const dirtyNames = new Set(S.namesVirtual ? [] : S.names.map((n, i) => (n !== S.origNames[i] ? i : -1)));

  let h = `<thead><tr><th></th><th></th><th>#</th><th>Name</th>`;
  h += S.groupVars.map(n => {
    const u = unassignedValue(n);
    let warn = '';
    if (u !== undefined) {
      let c = 0;
      for (let gi = 0; gi < nG; gi++) if (S.gOff[gi + 1] > S.gOff[gi] && S.vars[n].arr[gi] === u) c++;
      if (c) warn = ` <span class="warn-count" title="${c} group(s) with elements still unassigned (${dispName(n)} = ${u})">${c} unassigned</span>`;
    }
    return `<th title="per-group variable">${esc(dispName(n))}${S.vars[n].isNew ? ' <span class="new-tag">new</span>' : ''}${warn}</th>`;
  }).join('');
  h += S.elemVars.map(n => `<th class="ev" title="per-element variable — editing applies to all elements of the group">${esc(dispName(n))}</th>`).join('');
  h += `<th style="text-align:right">elements</th></tr></thead><tbody>`;
  for (let gi = 0; gi < nG; gi++) {
    const cnt = S.gOff[gi + 1] - S.gOff[gi];
    const eyeCls = cnt === 0 ? '' : visCount[gi] === 0 ? 'off' : visCount[gi] < cnt ? 'partial' : '';
    h += `<tr data-g="${gi}" class="${visCount[gi] === 0 && cnt ? 'hidden-grp' : ''}">`;
    h += `<td><button class="eye ${eyeCls}" data-act="eye" title="show / hide">${ICON.eye}</button></td>`;
    h += `<td><span class="swatch" style="background:${rgbToHex(categorical(gi))}"></span></td>`;
    h += `<td class="num">${gi}</td>`;
    h += `<td><input class="name ${dirtyNames.has(gi) ? 'dirty' : ''}" data-key="n:${gi}" value="${esc(S.names[gi])}" ${S.namesVirtual ? 'disabled' : ''}></td>`;
    for (const n of S.groupVars) {
      const v = S.vars[n], val = v.arr[gi], d = v.isNew || val !== S.orig[n][gi];
      const l = label(n, val);
      const un = val === unassignedValue(n);
      h += `<td><input data-key="g:${esc(n)}:${gi}" value="${fmt(val)}" class="${d ? 'dirty' : ''} ${un ? 'unassigned' : ''}" title="${l ? esc(l) : ''}" style="width:${Math.max(5, fmt(val).length + 2)}ch"></td>`;
    }
    S.elemVars.forEach((n, j) => {
      const { mn, mx } = eStats[j];
      if (!cnt) { h += `<td></td>`; return; }
      const uniform = mn[gi] === mx[gi];
      const txt = uniform ? fmt(mn[gi]) : '';
      const ph = uniform ? '' : `${fmt(mn[gi])}…${fmt(mx[gi])}`;
      h += `<td><input data-key="e:${esc(n)}:${gi}" value="${txt}" placeholder="${ph}" class="${uniform ? '' : 'mixed'}" title="${uniform ? esc(withLabel(n, mn[gi])) : 'mixed: ' + ph}" style="width:${Math.max(6, (txt || ph).length + 2)}ch"></td>`;
    });
    h += `<td class="num">${cnt.toLocaleString()}</td></tr>`;
  }
  h += '</tbody>';
  t.innerHTML = h;
  updateGroupRowStates();
  if (keep) { const el = t.querySelector(`[data-key="${CSS.escape(keep)}"]`); if (el) el.focus(); }
  if (!$('#group-footer')) {
    const f = document.createElement('div');
    f.id = 'group-footer'; f.className = 'group-footer';
    f.innerHTML = `<button data-act="new-group" title="Add an empty group (assign elements to it from the Selection tab)">＋ New empty group</button>
      <button data-act="new-var" title="Add a new per-group or per-element variable (e.g. a surface material)">＋ New property</button>
      <button data-act="show-all">Show all</button><button data-act="sel-all">Select all</button>`;
    t.closest('.tab').appendChild(f);
    f.addEventListener('click', async ev => {
      const a = ev.target.dataset.act;
      if (a === 'show-all') showAll();
      if (a === 'sel-all') selectAll();
      if (a === 'new-var') addVariableDialog();
      if (a === 'new-group') {
        if (S.groupsVirtual) return toast('This file has no group variable', 'err');
        const r = await promptDialog('New empty group', [
          { key: 'name', label: 'Group name', value: `Group ${S.nGroups}` },
          { key: 'tmpl', label: 'Copy per-group properties from', type: 'select', value: '0', options: groupOptions() },
        ]);
        if (r && r.name.trim()) exec(cmdAddGroup(r.name.trim(), +r.tmpl));
      }
    });
  }
  $('#group-footer').style.display = S.groupsVirtual ? 'none' : 'flex';
}
function updateGroupRowStates() {
  if (!S?.nElem) return;
  const nG = S.nGroups, cnt = new Uint32Array(nG), g = S.gid.arr;
  if (S.selCount) for (let e = 0; e < S.nElem; e++) if (S.sel[e] && g[e] < nG) cnt[g[e]]++;
  for (const tr of document.querySelectorAll('#group-table tbody tr')) {
    const gi = +tr.dataset.g, tot = S.gOff[gi + 1] - S.gOff[gi];
    tr.classList.toggle('sel-all', cnt[gi] > 0 && cnt[gi] === tot);
    tr.classList.toggle('sel-some', cnt[gi] > 0 && cnt[gi] < tot);
  }
}
$('#group-table').addEventListener('click', ev => {
  const tr = ev.target.closest('tbody tr');
  if (!tr) return;
  const g = +tr.dataset.g;
  if (ev.target.dataset.act === 'eye') {
    const els = groupElems(g);
    const anyVis = els.some(e => S.visible[e]);
    const target = anyVis && els.every(e => S.visible[e]) ? 0 : 1;
    const inG = new Uint8Array(S.nElem); for (const e of els) inG[e] = 1;
    setVisible(e => (inG[e] ? target : S.visible[e]));
    return;
  }
  if (ev.target.tagName === 'INPUT') return;
  select(Array.from(groupElems(g)).filter(e => S.visible[e]), modeFromEvent(ev));
});
$('#group-table').addEventListener('change', ev => {
  const key = ev.target.dataset.key;
  if (!key) return;
  const [kind, ...rest] = key.split(':');
  const g = +rest.pop(), name = rest.join(':');
  const val = ev.target.value;
  try {
    if (kind === 'n') {
      if (!val.trim()) throw new Error('group name cannot be empty');
      exec(cmdSetGroup(NAMES_KEY, g, val));
    } else if (kind === 'g') {
      exec(cmdSetGroup(name, g, parseValue(val, S.vars[name])));
    } else if (kind === 'e') {
      if (val.trim() === '') { renderGroupTable(); return; }
      exec(cmdSetElems(name, groupElems(g), parseValue(val, S.vars[name]), `${name} = ${val} on group "${groupName(g)}"`));
    }
  } catch (e) { toast(e.message, 'err'); renderGroupTable(); }
});

// =========================================================================== selection panel
function renderSelection() {
  const p = $('#selection-panel');
  if (!S || !S.nElem) { p.innerHTML = ''; return; }
  const n = S.selCount;
  let h = `<div class="sel-head"><span class="big">${n.toLocaleString()}</span> of ${S.nElem.toLocaleString()} elements selected</div>
    <div class="sel-tools">
      <button data-act="all" title="A">Select all</button><button data-act="none" title="Esc">None</button>
      <button data-act="invert" title="Ctrl+I">Invert</button><button data-act="grow" title="L — add everything connected to the selection">Grow to connected</button>
      <button data-act="frame" title="F">Frame</button><button data-act="hide" title="H">Hide</button><button data-act="isolate" title="I">Isolate</button>
    </div>`;
  if (!n) {
    h += `<div class="hint">Click in the viewport to pick (Shift = add, Ctrl = remove). Use <b>Pick</b> in the toolbar to pick whole connected parts or groups, <b>Box</b> (B) for rectangle selection, or click legend entries / group rows to select by value.</div>`;
    p.innerHTML = h; return;
  }
  const idx = selectedIndices();
  // assign card
  h += `<div class="card"><h4>Assign to selection</h4>`;
  if (!S.groupsVirtual && S.gid.name) {
    const gc = new Map();
    for (const e of idx) gc.set(S.gid.arr[e], (gc.get(S.gid.arr[e]) || 0) + 1);
    const cur = gc.size === 1 ? `all in "${esc(groupName([...gc.keys()][0]))}"` : `spread over ${gc.size} groups`;
    h += `<div class="sel-row"><span class="vname" title="${esc(S.gid.name)}">group</span>
      <select data-var="${esc(S.gid.name)}">${S.names.map((nm, g) => `<option value="${g}">${g}: ${esc(nm)}</option>`).join('')}<option value="__new__">＋ New group…</option></select>
      <button data-apply="${esc(S.gid.name)}">Apply</button><span class="cur">${cur}</span></div>`;
  }
  for (const name of S.elemVars) {
    const a = S.vars[name].arr;
    let mn = Infinity, mx = -Infinity;
    const distinct = new Set();
    for (const e of idx) { const v = a[e]; if (v < mn) mn = v; if (v > mx) mx = v; if (distinct.size < 50) distinct.add(v); }
    const cur = mn === mx ? `currently ${esc(withLabel(name, mn))}` :
      `mixed: ${fmt(mn)} … ${fmt(mx)} (${distinct.size >= 50 ? '50+' : distinct.size} distinct)`;
    const labels = labelsFor(name);
    h += `<div class="sel-row"><span class="vname" title="${esc(dispName(name))} (${dtypeCode(S.vars[name].origDtype)})">${esc(dispName(name))}</span>
      <input data-var="${esc(name)}" placeholder="${mn === mx ? fmt(mn) : 'value'}" ${labels ? `list="dl-${esc(name)}"` : ''}>
      <button data-apply="${esc(name)}">Apply</button><span class="cur">${cur}</span></div>`;
    if (labels) h += `<datalist id="dl-${esc(name)}">${Object.entries(labels).map(([k, l]) => `<option value="${esc(k)}">${esc(l)}</option>`).join('')}</datalist>`;
  }
  h += `</div>`;

  // breakdown by group
  if (!S.groupsVirtual) {
    const gc = new Map();
    for (const e of idx) gc.set(S.gid.arr[e], (gc.get(S.gid.arr[e]) || 0) + 1);
    h += `<div class="card"><h4>By group <span style="text-transform:none;font-weight:400">— click to keep only that group</span></h4><div class="breakdown"><table>`;
    for (const [g, c] of [...gc.entries()].sort((a, b) => b[1] - a[1])) {
      h += `<tr data-g="${g}"><td><span class="swatch" style="background:${rgbToHex(categorical(g))}"></span></td><td>${g}: ${esc(groupName(g))}</td><td class="num">${c.toLocaleString()} / ${(S.gOff[g + 1] - S.gOff[g]).toLocaleString()}</td></tr>`;
    }
    h += `</table></div></div>`;
  }

  // single element details
  if (n === 1) h += `<div class="card"><h4>Element ${idx[0]}</h4>${describeElement(idx[0]).map(([k, v]) => `<div class="kv">${esc(k)}: <b>${esc(v)}</b></div>`).join('')}</div>`;
  p.innerHTML = h;
  const gsel = p.querySelector(`select[data-var]`);
  if (gsel) gsel.value = String(mostCommonGroup(idx));
}
$('#selection-panel').addEventListener('click', ev => {
  const act = ev.target.dataset.act;
  if (act) return ({
    all: selectAll, none: () => select([]), invert: invertSelection, frame: frameSelection,
    hide: hideSelected, isolate: isolateSelected, grow: () => select(connectedFrom(selectedIndices()), 'add'),
  })[act]?.();
  const ap = ev.target.dataset.apply;
  if (ap !== undefined) {
    const inp = $('#selection-panel').querySelector(`[data-var="${CSS.escape(ap)}"]`);
    if (inp.tagName === 'INPUT' && inp.value.trim() === '') return toast('Enter a value first', 'err');
    assignToSelection(ap, inp.value);
    return;
  }
  const tr = ev.target.closest('.breakdown tr');
  if (tr) {
    const g = +tr.dataset.g;
    for (let e = 0; e < S.nElem; e++) if (S.sel[e] && S.gid.arr[e] !== g) S.sel[e] = 0;
    selectionChanged();
  }
});
$('#selection-panel').addEventListener('keydown', ev => {
  if (ev.key === 'Enter' && ev.target.dataset.var) { ev.preventDefault(); ev.target.nextElementSibling.click(); }
});

function describeElement(e) {
  const out = [['index', String(e)]];
  if (!S.groupsVirtual) out.push(['group', `${S.gid.arr[e]}: ${groupName(S.gid.arr[e])}`]);
  for (const n of S.elemVars) out.push([dispName(n), withLabel(n, S.vars[n].arr[e])]);
  if (!S.groupsVirtual) for (const n of S.groupVars) out.push([`${dispName(n)} (group)`, withLabel(n, S.vars[n].arr[S.gid.arr[e]])]);
  const nodes = [];
  for (let j = 0; j < S.k; j++) { const v = S.conn[S.k * e + j]; if (v < S.nVerts) nodes.push(v); }
  out.push(['nodes', nodes.join(', ')]);
  out.push(['centroid', [0, 1, 2].map(a => fmt(S.centroids[e * 3 + a])).join(', ')]);
  return out;
}

// =========================================================================== schema panel
function attrValueString(v) { return Array.isArray(v) ? v.map(fmt).join(', ') : fmt(v); }
function renderAttrs(objPath, attrs) {
  const edits = S.attrEdits[objPath] || {};
  const rows = [];
  const names = new Set();
  for (const a of attrs) {
    names.add(a.name);
    const ed = edits[a.name];
    if (ed === null) continue; // deleted
    const val = ed ? ed.value : attrValueString(a.value);
    rows.push(attrRow(objPath, a.name, val, a.dtype, !!ed, attrValueString(a.value)));
  }
  for (const [name, ed] of Object.entries(edits)) if (!names.has(name) && ed) rows.push(attrRow(objPath, name, ed.value, ed.dtype, true, null));
  rows.push(`<div class="attr-row"><span></span><span><button data-addattr="${esc(objPath)}">＋ attribute</button></span></div>`);
  return rows.join('');
}
function attrRow(obj, name, val, dtype, dirty, origStr) {
  const dt = dtype === 'str' ? 'str' : dtypeCode(dtype || 'str');
  return `<div class="attr-row"><span class="an" title="${esc(name)}">@${esc(name)}</span>
    <input data-obj="${esc(obj)}" data-attr="${esc(name)}" data-dtype="${esc(dtype)}" data-orig="${origStr === null ? '' : esc(origStr)}" data-new="${origStr === null ? 1 : 0}" value="${esc(val)}" class="${dirty ? 'dirty' : ''}">
    <span class="at">${esc(dt)}</span><button data-delattr="${esc(name)}" data-obj="${esc(obj)}" title="delete attribute">×</button></div>`;
}
function renderGroupSchema(g, open) {
  const isRoot = g.path === '/';
  let h = `<details ${open ? 'open' : ''}><summary><span class="sch-kind grp">group</span>${esc(isRoot ? '/ (root)' : g.name)}</summary>`;
  h += `<details open><summary><span class="sch-kind att">attrs</span>${isRoot ? 'Global attributes' : 'Group attributes'} <span class="sch-meta">${g.attrs.length}</span></summary>${renderAttrs(g.path, g.attrs)}</details>`;
  if (g.dims.length) {
    h += `<details open><summary><span class="sch-kind dim">dims</span>Dimensions <span class="sch-meta">${g.dims.length}</span></summary>`;
    h += g.dims.map(d => {
      const live = isRoot && S.mapping.groupDim === d.name && S.nGroups !== d.size ? ` → ${S.nGroups} (edited)` : '';
      return `<div class="kv" style="margin-left:14px">${esc(d.name)} = <b>${d.size.toLocaleString()}${live}</b>${d.unlimited ? ' (unlimited)' : ''}</div>`;
    }).join('');
    h += `</details>`;
  }
  let vars = g.vars;
  if (isRoot) {
    vars = vars.concat(Object.keys(S.newVars).filter(id => !S.deleted.has(id)).map(id => {
      const nv = S.vars[id], dim = nv.scope === 'group' ? S.mapping.groupDim : S.mapping.elemDim;
      return { name: id, path: '/' + id, dtype: (NEW_VAR_DTYPES.find(d => d[0] === nv.dtype) || [, nv.dtype])[1], dims: [dim], shape: [nv.arr.length], attrs: [], isNew: true };
    }));
  }
  h += `<details open><summary><span class="sch-kind var">vars</span>Variables <span class="sch-meta">${vars.length}</span></summary>`;
  for (const v of vars) {
    const role = isRoot ? varRole(v.name) : '';
    const del = isRoot && S.deleted.has(v.name);
    const dirty = isRoot && !v.isNew && (S.vars[v.name] ? !sameArray(S.vars[v.name].arr, S.orig[v.name]) : (v.name === S.mapping.groupNames && !sameArray(S.names, S.origNames)));
    const shown = isRoot ? dispName(v.name) : v.name;
    const renamed = isRoot && !v.isNew && shown !== v.name;
    let tags = '';
    if (v.isNew) tags += ' <span class="new-tag">new</span>';
    if (renamed) tags += ` <span style="color:var(--warn)">(was ${esc(v.name)})</span>`;
    if (dirty) tags += ' <span style="color:var(--warn)">● edited</span>';
    if (del) tags += ' <span style="color:var(--err)">deleted</span>';
    h += `<details class="${del ? 'sch-del' : ''}"><summary><span class="sch-kind var">var</span>${esc(shown)} <span class="sch-meta">${esc(v.dtype)}(${v.dims.map(esc).join(', ')})</span>${role ? ` <span class="sch-meta" style="color:#9fc6ff">${role}</span>` : ''}${tags}</summary><div class="var-body">`;
    if (del) {
      h += `<div class="var-actions"><button data-restorevar="${esc(v.name)}">Restore</button></div></div></details>`;
      continue;
    }
    if (isRoot && !isStructural(v.name)) {
      h += `<div class="var-actions"><button data-renamevar="${esc(v.name)}">Rename…</button><button data-delvar="${esc(v.name)}">Delete</button></div>`;
    }
    h += `<div class="kv">shape: <b>${v.shape.join(' × ') || 'scalar'}</b></div>`;
    if (v.stats) h += `<div class="kv">range in file: <b>${fmt(v.stats.min)} … ${fmt(v.stats.max)}</b>${v.stats.nunique !== undefined ? ` · distinct: <b>${v.stats.nunique}</b>` : ''}</div>`;
    if (v.compression && Object.keys(v.compression).length) h += `<div class="kv">compression: <b>${esc(JSON.stringify(v.compression))}</b></div>`;
    if (v.chunking) h += `<div class="kv">storage: <b>${esc(Array.isArray(v.chunking) ? 'chunks ' + v.chunking.join('×') : v.chunking)}</b></div>`;
    h += renderAttrs(v.path, v.attrs);
    h += `<div><button data-preview="${esc(v.path)}" data-name="${esc(v.name)}" data-root="${isRoot ? 1 : 0}">Preview values</button></div><div class="preview" hidden></div></div></details>`;
  }
  if (isRoot && S.nElem) h += `<div class="var-actions" style="margin-left:14px"><button data-addvar="1" title="Add a per-group or per-element variable">＋ variable</button></div>`;
  h += `</details>`;
  for (const sg of g.groups) h += renderGroupSchema(sg, false);
  return h + `</details>`;
}
function varRole(name) {
  const m = S.mapping;
  if (m.coords?.includes(name) || m.xyz === name) return 'vertex coordinates';
  if (m.conn === name) return `connectivity (${m.nodesPerElement} nodes, start ${m.startIndex})`;
  if (m.groupId === name) return 'element → group';
  if (m.groupNames === name) return 'group names';
  if (m.elemVars.includes(name)) return 'per element';
  if (m.groupVars.includes(name)) return 'per group';
  return '';
}
function renderSchema() {
  const p = $('#schema-panel');
  if (!S) { p.innerHTML = ''; return; }
  const openState = [...p.querySelectorAll('details')].map(d => d.open);
  const i = S.info, m = i.mapping;
  let h = `<div class="card file-card"><h4>File</h4>
    <div class="kv">path: <b>${esc(i.path)}</b></div>
    <div class="kv">format: <b>${esc(i.format)}</b> · size: <b>${fmtBytes(i.size)}</b></div>
    ${S.nElem ? `<div class="kv">model: <b>${S.nVerts.toLocaleString()}</b> vertices · <b>${S.nElem.toLocaleString()}</b> elements (${S.k}-node) · <b>${S.nGroups}</b> groups</div>` : ''}
    ${(m.warnings || []).map(w => `<div class="kv mapping-warn">⚠ ${esc(w)}</div>`).join('')}
    ${Object.keys(S.labels).length ? `<div class="kv">value labels loaded for: <b>${Object.keys(S.labels).map(esc).join(', ')}</b></div>` : ''}
  </div>`;
  h += renderGroupSchema(i.schema, true);
  p.innerHTML = h;
  const ds = p.querySelectorAll('details');
  if (openState.length === ds.length) ds.forEach((d, k) => (d.open = openState[k]));
}
$('#schema-panel').addEventListener('change', ev => {
  const t = ev.target;
  if (!t.dataset.attr) return;
  const obj = t.dataset.obj, name = t.dataset.attr, dtype = t.dataset.dtype;
  const val = t.value;
  if (dtype !== 'str' && dtype !== 'bytes') {
    const parts = val.replace(/,/g, ' ').trim().split(/\s+/);
    if (!val.trim() || parts.some(x => !Number.isFinite(Number(x)))) { toast(`@${name} needs numeric value(s)`, 'err'); renderSchema(); return; }
  }
  const next = t.dataset.new === '0' && val === t.dataset.orig ? undefined : { value: val, dtype };
  exec(cmdAttr(obj, name, next));
});
$('#schema-panel').addEventListener('click', async ev => {
  const t = ev.target;
  if (t.dataset.addvar) return addVariableDialog();
  if (t.dataset.delvar) {
    const id = t.dataset.delvar;
    if (!S.vars[id]?.isNew && !confirm(`Delete variable "${dispName(id)}" from the file on next save? (Undo with Ctrl+Z.)`)) return;
    return exec(cmdDeleteVar(id));
  }
  if (t.dataset.restorevar) return exec(cmdDeleteVar(t.dataset.restorevar, true));
  if (t.dataset.renamevar) {
    const id = t.dataset.renamevar;
    const r = await promptDialog(`Rename variable "${dispName(id)}"`, [{ key: 'name', label: 'New name', value: dispName(id) }]);
    if (!r || r.name.trim() === dispName(id)) return;
    try { checkVarName(r.name.trim(), id); exec(cmdRenameVar(id, r.name.trim())); } catch (e) { toast(e.message, 'err'); }
    return;
  }
  if (t.dataset.delattr !== undefined) {
    const obj = t.dataset.obj, name = t.dataset.delattr;
    const isNew = !findAttr(obj, name);
    exec(cmdAttr(obj, name, isNew ? undefined : null));
  } else if (t.dataset.addattr !== undefined) {
    const r = await promptDialog('Add attribute', [
      { key: 'name', label: 'Name' },
      { key: 'dtype', label: 'Type', type: 'select', value: 'str', options: [
        ['str', 'string'], ['<f8', 'float64'], ['<f4', 'float32'], ['<i4', 'int32'], ['<i2', 'int16'], ['|u1', 'uint8'], ['<u2', 'uint16'], ['<u4', 'uint32'],
      ].map(([value, text]) => ({ value, text })) },
      { key: 'value', label: 'Value (comma-separate numbers for an array)' },
    ]);
    if (!r || !r.name.trim()) return;
    if (r.dtype !== 'str' && !r.value.replace(/,/g, ' ').trim().split(/\s+/).every(x => x && Number.isFinite(Number(x)))) return toast('numeric value required', 'err');
    exec(cmdAttr(t.dataset.addattr, r.name.trim(), { value: r.value, dtype: r.dtype }));
  } else if (t.dataset.preview !== undefined) {
    const box = t.parentElement.nextElementSibling;
    if (!box.hidden) { box.hidden = true; return; }
    box.hidden = false;
    const name = t.dataset.name, isRoot = t.dataset.root === '1';
    if (isRoot && (S.vars[name] || name === S.mapping.groupNames)) {
      const arr = S.vars[name] ? S.vars[name].arr : S.names;
      const n = Math.min(arr.length, 500);
      box.textContent = `(current in-memory values, ${n} of ${arr.length.toLocaleString()})\n` +
        Array.from({ length: n }, (_, i) => `${String(i).padStart(7)}  ${fmt(arr[i])}`).join('\n');
      return;
    }
    box.textContent = 'loading…';
    try {
      const r = await apiJson(`/api/preview?name=${encodeURIComponent(t.dataset.preview)}&count=500`);
      const vals = Array.isArray(r.values) ? r.values : [r.values];
      box.textContent = `(${r.stop - r.start} of ${r.total.toLocaleString()})\n` +
        vals.map((v, i) => `${String(r.start + i).padStart(7)}  ${Array.isArray(v) ? v.map(fmt).join(', ') : fmt(v)}`).join('\n');
    } catch (e) { box.textContent = e.message; }
  }
});
function findAttr(objPath, name) {
  const walk = g => {
    if (g.path === objPath) return g.attrs.find(a => a.name === name);
    for (const v of g.vars) if (v.path === objPath) return v.attrs.find(a => a.name === name);
    for (const sg of g.groups) { const r = walk(sg); if (r) return r; }
    return null;
  };
  return walk(S.info.schema);
}

// =========================================================================== save
function buildSavePayload() {
  const vars = {};
  const dv = dirtyVars();
  const existingGroupVars = S.groupVars.filter(n => !S.vars[n].isNew);
  const groupsResized = S.nGroups !== S.origNames.length && !S.namesVirtual ||
    existingGroupVars.some(n => S.vars[n].arr.length !== S.orig[n].length);
  const names = new Set(dv);
  if (groupsResized) { existingGroupVars.forEach(n => names.add(n)); if (!S.namesVirtual) names.add(NAMES_KEY); }
  for (const n of names) {
    if (n === NAMES_KEY) vars['/' + S.mapping.groupNames] = { strings: S.names };
    else vars['/' + n] = { b64: toB64(S.vars[n].arr), dtype: S.vars[n].dtype };
  }
  const st = structuralChanges();
  const newVars = {};
  for (const id of st.added) {
    const v = S.vars[id];
    newVars['/' + id] = {
      name: dispName(id), dims: [v.scope === 'group' ? S.mapping.groupDim : S.mapping.elemDim],
      dtype: v.dtype, b64: toB64(v.arr),
    };
  }
  const renames = {};
  for (const id of st.renamed) renames['/' + id] = S.renames[id];
  return { vars, attrs: liveAttrEdits(), newVars, deleted: st.deleted.map(id => '/' + id), renames };
}
/** Warnings for variables that declare an unassigned_value and still contain it. */
function unassignedWarnings() {
  const out = [];
  for (const n of S.groupVars) {
    const u = unassignedValue(n);
    if (u === undefined) continue;
    let c = 0, tot = 0;
    for (let g = 0; g < S.nGroups; g++) if (S.gOff[g + 1] > S.gOff[g]) { tot++; if (S.vars[n].arr[g] === u) c++; }
    if (c) out.push(`${dispName(n)}: ${c} of ${tot} non-empty groups unassigned`);
  }
  for (const n of S.elemVars) {
    const u = unassignedValue(n);
    if (u === undefined) continue;
    let c = 0;
    for (const v of S.vars[n].arr) if (v === u) c++;
    if (c) out.push(`${dispName(n)}: ${c.toLocaleString()} of ${S.nElem.toLocaleString()} elements unassigned`);
  }
  return out;
}
function saveSummary() {
  const dv = dirtyVars().map(n => (n === NAMES_KEY ? S.mapping.groupNames : n));
  const st = structuralChanges();
  const na = Object.entries(liveAttrEdits()).filter(([o]) => !S.newVars[o.slice(1)])
    .reduce((s, [, o]) => s + Object.keys(o).length, 0);
  const parts = [];
  if (st.added.length) parts.push(`New variables: <b>${st.added.map(id => `${esc(dispName(id))} (${S.vars[id].scope === 'group' ? 'per group' : 'per element'}, ${dtypeCode(S.vars[id].dtype)})`).join(', ')}</b>`);
  if (st.deleted.length) parts.push(`Deleted variables: <b>${st.deleted.map(esc).join(', ')}</b>`);
  if (st.renamed.length) parts.push(`Renamed: <b>${st.renamed.map(id => `${esc(id)} → ${esc(S.renames[id])}`).join(', ')}</b>`);
  if (dv.length) parts.push(`Variables changed: <b>${dv.map(n => esc(dispName(n))).join(', ')}</b>`);
  if (na) parts.push(`Attribute edits: <b>${na}</b>`);
  if (S.mapping.groupDim && S.nGroups !== S.origNames.length && !S.namesVirtual) parts.push(`Dimension <b>${esc(S.mapping.groupDim)}</b>: ${S.origNames.length} → ${S.nGroups}`);
  if (S.undo.length) parts.push(`${S.undo.length} edit(s) this session (latest: ${esc(S.undo.at(-1).label)})`);
  for (const w of unassignedWarnings()) parts.push(`<span style="color:var(--warn)">⚠ ${esc(w)}</span>`);
  return parts.join('<br>') || 'No changes — this will write an identical copy.';
}
async function doSave(path, overwrite, backup) {
  setMsg('Saving…');
  try {
    const r = await apiJson('/api/save', { path, overwrite, backup, ...buildSavePayload() });
    toast(`Saved ${r.path}${r.backup ? ' (backup: ' + r.backup.split(/[\\/]/).pop() + ')' : ''}`, 'ok');
    const info = await apiJson('/api/schema');
    // keep camera, visibility and selection
    const view = { pos: viewer.camera.position.clone(), tgt: viewer.controls.target.clone() };
    await loadModel(info, true);
    viewer.camera.position.copy(view.pos); viewer.controls.target.copy(view.tgt); viewer.controls.update();
    selectionChanged();
    setMsg('Saved.');
    return true;
  } catch (e) {
    if (e.status === 409 && e.data?.exists) {
      if (confirm(`${path} already exists. Replace it?`)) return doSave(path, true, backup);
      setMsg(''); return false;
    }
    toast('Save failed: ' + e.message, 'err'); setMsg('');
    return false;
  }
}
function openSaveDialog(asNew) {
  if (!S) return;
  const d = $('#dlg-save');
  $('#save-title').textContent = asNew ? 'Save as' : 'Save (overwrite)';
  const p = S.path;
  $('#save-path').value = asNew ? p.replace(/(\.nc4?|\.cdf|\.netcdf)?$/i, m => '_edited' + (m || '.nc')) : p;
  $('#save-path').disabled = !asNew;
  try { $('#save-backup').checked = localStorage.getItem('dv-backup') !== '0'; } catch { /* ignore */ }
  $('#save-summary').innerHTML = saveSummary();
  d.returnValue = '';
  d.showModal();
  d.onclose = () => {
    if (d.returnValue !== 'go') return;
    const backup = $('#save-backup').checked;
    try { localStorage.setItem('dv-backup', backup ? '1' : '0'); } catch { /* ignore */ }
    const target = $('#save-path').value.trim();
    doSave(target, !asNew || target === S.path, backup);
  };
}

// =========================================================================== dialogs
function promptDialog(title, fields) {
  return new Promise(resolve => {
    const d = $('#dlg-prompt');
    $('#prompt-title').textContent = title;
    $('#prompt-body').innerHTML = fields.map(f => `<label>${esc(f.label)}</label>` + (f.type === 'select'
      ? `<select data-k="${f.key}">${f.options.map(o => `<option value="${esc(o.value)}" ${o.value === f.value ? 'selected' : ''}>${esc(o.text)}</option>`).join('')}</select>`
      : `<input type="text" data-k="${f.key}" value="${esc(f.value ?? '')}" placeholder="${esc(f.placeholder ?? '')}">`)).join('');
    d.returnValue = '';
    d.showModal();
    const first = d.querySelector('[data-k]'); first?.focus(); first?.select?.();
    d.onclose = () => {
      if (d.returnValue !== 'ok') return resolve(null);
      const out = {};
      d.querySelectorAll('[data-k]').forEach(el => (out[el.dataset.k] = el.value));
      resolve(out);
    };
  });
}
async function openDialog(dir) {
  const d = $('#dlg-open');
  try {
    const r = await apiJson('/api/files' + (dir ? '?dir=' + encodeURIComponent(dir) : ''));
    $('#open-dir').textContent = r.dir;
    const list = $('#open-list');
    // full paths come from the server so separators are right on every OS
    list.innerHTML = `<li class="dir" data-dir="${esc(r.parent)}"><span>${ICON.up} ..</span></li>` + r.entries.map(e => e.dir
      ? `<li class="dir" data-dir="${esc(e.path)}"><span>${ICON.folder} ${esc(e.name)}</span></li>`
      : `<li data-file="${esc(e.path)}"><span>${ICON.file} ${esc(e.name)}</span><span class="sz">${fmtBytes(e.size)}</span></li>`).join('');
    if (!d.open) { $('#open-path').value = ''; d.returnValue = ''; d.showModal(); }
  } catch (e) { toast(e.message, 'err'); }
}
$('#open-list').addEventListener('click', ev => {
  const li = ev.target.closest('li');
  if (!li) return;
  if (li.dataset.dir) openDialog(li.dataset.dir);
  else { $('#dlg-open').close(); openPath(li.dataset.file); }
});
$('#dlg-open').addEventListener('close', () => {
  if ($('#dlg-open').returnValue === 'go' && $('#open-path').value.trim()) openPath($('#open-path').value.trim().replace(/^"|"$/g, ''));
});

// =========================================================================== toolbar / status
function updateToolbar() {
  const has = !!S;
  $('#btn-save').disabled = !has || !isDirty();
  $('#btn-saveas').disabled = !has;
  $('#btn-undo').disabled = !S?.undo.length;
  $('#btn-redo').disabled = !S?.redo.length;
  $('#btn-undo').title = S?.undo.length ? `Undo: ${S.undo.at(-1).label} (Ctrl+Z)` : 'Undo (Ctrl+Z)';
  $('#btn-redo').title = S?.redo.length ? `Redo: ${S.redo.at(-1).label} (Ctrl+Y)` : 'Redo (Ctrl+Y)';
  const dirty = has && isDirty();
  $('#st-dirty').textContent = dirty ? '● unsaved changes' : '';
}
function updateCounts() {
  if (!S?.nElem) { $('#st-counts').textContent = ''; return; }
  let vis = 0; for (let e = 0; e < S.nElem; e++) vis += S.visible[e];
  $('#st-counts').textContent = `${S.nVerts.toLocaleString()} verts · ${S.nElem.toLocaleString()} elements · ${S.nGroups} groups · ${vis.toLocaleString()} shown · ${S.selCount.toLocaleString()} selected`;
}
function setTab(name) {
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.id === 'tab-' + name));
}
$('#tabs').addEventListener('click', ev => { const b = ev.target.closest('button'); if (b) setTab(b.dataset.tab); });

$('#btn-open').onclick = $('#btn-open2').onclick = () => openDialog();
$('#btn-save').onclick = () => openSaveDialog(false);
$('#btn-saveas').onclick = () => openSaveDialog(true);
$('#btn-undo').onclick = undo;
$('#btn-redo').onclick = redo;
$('#sel-colorby').onchange = ev => { S.colorBy = ev.target.value; refreshColors(true); };
$('#btn-hide').onclick = hideSelected;
$('#btn-isolate').onclick = isolateSelected;
$('#btn-showall').onclick = showAll;
$('#btn-frame').onclick = frameSelection;
$('#btn-wire').onclick = ev => { const on = ev.target.classList.toggle('on'); viewer.setWireframe(on); };
$('#btn-grid').onclick = ev => { const on = ev.target.classList.toggle('on'); viewer.setGridVisible(on); };
$('#sel-view').onchange = ev => { if (ev.target.value) viewer.setView(ev.target.value); ev.target.value = ''; };
$('#btn-shot').onclick = () => {
  const a = document.createElement('a');
  a.href = viewer.screenshot();
  a.download = (S?.path.split(/[\\/]/).pop().replace(/\.[^.]+$/, '') || 'view') + '.png';
  a.click();
};
let boxMode = false;
function setBoxMode(on) {
  boxMode = on;
  $('#btn-box').classList.toggle('on', on);
  $('#viewport').classList.toggle('box-mode', on);
  viewer.controls.mouseButtons.LEFT = on ? null : 0; // 0 = THREE.MOUSE.ROTATE
}
$('#btn-box').onclick = () => setBoxMode(!boxMode);

// side panel resize
$('#side-resizer').addEventListener('pointerdown', ev => {
  const startX = ev.clientX, startW = $('#side').offsetWidth;
  const move = e => document.documentElement.style.setProperty('--side-w', Math.max(280, startW + e.clientX - startX) + 'px');
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
});

// =========================================================================== viewport interaction
const canvas = viewer.canvas;
let down = null, hoverRAF = 0, hoverPos = null;
const rel = ev => { const r = canvas.getBoundingClientRect(); return [ev.clientX - r.left, ev.clientY - r.top]; };

canvas.addEventListener('pointerdown', ev => {
  if (!S?.nElem) return;
  const [x, y] = rel(ev);
  down = { x, y, button: ev.button, box: boxMode && ev.button === 0 };
  $('#hoverinfo').style.display = 'none';
});
canvas.addEventListener('pointermove', ev => {
  if (!S?.nElem) return;
  const [x, y] = rel(ev);
  if (down?.box) {
    const b = $('#boxsel');
    Object.assign(b.style, {
      display: 'block', left: Math.min(x, down.x) + 'px', top: Math.min(y, down.y) + 'px',
      width: Math.abs(x - down.x) + 'px', height: Math.abs(y - down.y) + 'px',
    });
    return;
  }
  if (ev.buttons) return;
  hoverPos = [x, y];
  if (!hoverRAF) hoverRAF = requestAnimationFrame(doHover);
});
canvas.addEventListener('pointerleave', () => { $('#hoverinfo').style.display = 'none'; hoverPos = null; });
window.addEventListener('pointerup', ev => {
  if (!down || !S?.nElem) { down = null; return; }
  const [x, y] = rel(ev);
  const moved = Math.hypot(x - down.x, y - down.y);
  const mode = modeFromEvent(ev);
  if (down.box && moved > 3) {
    $('#boxsel').style.display = 'none';
    const hits = $('#chk-visonly').checked
      ? viewer.pickRectVisible(down.x, down.y, x, y)
      : viewer.pickRectThrough(down.x, down.y, x, y, S.centroids, S.visible);
    select(hits, mode);
  } else if (down.button === 0 && moved <= 3 && ev.target === canvas) {
    $('#boxsel').style.display = 'none';
    const e = viewer.pickAt(x, y);
    if (e >= 0) select(expandPick(e), mode);
    else if (mode === 'replace') select([]);
  }
  down = null;
});
function doHover() {
  hoverRAF = 0;
  if (!hoverPos || down) return;
  const e = viewer.pickAt(...hoverPos);
  const box = $('#hoverinfo');
  if (e < 0) { box.style.display = 'none'; return; }
  box.innerHTML = describeElement(e).filter(([k]) => k !== 'nodes' && k !== 'centroid')
    .map(([k, v]) => `<div><span class="k">${esc(k)}</span> ${esc(v)}</div>`).join('');
  box.style.display = 'block';
}

// =========================================================================== keyboard
window.addEventListener('keydown', ev => {
  const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName);
  const ctrl = ev.ctrlKey || ev.metaKey, k = ev.key.toLowerCase();
  if (ctrl && k === 's') { ev.preventDefault(); if (S) openSaveDialog(ev.shiftKey || !isDirty() ? true : false); return; }
  if (ctrl && k === 'o') { ev.preventDefault(); openDialog(); return; }
  if (document.querySelector('dialog[open]')) return;
  // Ctrl+Z/Y go to the app's undo unless the focused field holds uncommitted typing
  const a = document.activeElement;
  const pending = typing && a.tagName === 'INPUT' && a.value !== a.defaultValue;
  if (ctrl && (k === 'z' || k === 'y') && !pending) {
    ev.preventDefault();
    if (k === 'y' || ev.shiftKey) redo(); else undo();
    return;
  }
  if (typing) return;
  if (!S?.nElem) return;
  if (ctrl && k === 'i') { ev.preventDefault(); invertSelection(); return; }
  if (ctrl || ev.altKey && k !== 'h') return;
  switch (k) {
    case 'escape': select([]); break;
    case 'a': selectAll(); break;
    case 'h': ev.altKey ? showAll() : hideSelected(); break;
    case 'i': isolateSelected(); break;
    case 'f': frameSelection(); break;
    case 'b': setBoxMode(!boxMode); break;
    case 'w': $('#btn-wire').click(); break;
    case 'l': if (S.selCount) select(connectedFrom(selectedIndices()), 'add'); break;
    case '1': $('#sel-pick').value = 'element'; break;
    case '2': $('#sel-pick').value = 'connected'; break;
    case '3': $('#sel-pick').value = 'group'; break;
    default: return;
  }
  ev.preventDefault();
});
window.addEventListener('beforeunload', ev => { if (isDirty()) { ev.preventDefault(); ev.returnValue = ''; } });

// =========================================================================== boot
(async () => {
  try {
    const st = await apiJson('/api/state');
    if (st.path) { await loadModel(await apiJson('/api/schema')); }
    else openDialog();
  } catch (e) { toast(e.message, 'err'); openDialog(); }
})();
