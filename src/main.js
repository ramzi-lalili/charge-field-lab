/**
 * main.js — UI shell for Charge Field Lab. Everything physical lives in
 * physics.js / viz.js; this file only builds controls and wires them to the
 * public ChargeFieldViz API (setOptions, addCharge, updateCharge, on(...)).
 */
import { ChargeFieldViz, PRESETS, physics as P } from './viz.js';

/* ------------------------------------------------------------------ helpers */
const $ = (s, r = document) => r.querySelector(s);
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null) el.append(c.nodeType ? c : document.createTextNode(c));
  return el;
}
const get = (o, p) => p.split('.').reduce((a, k) => a?.[k], o);
const nest = (p, v) => { const ks = p.split('.'), o = {}; let c = o; ks.forEach((k, i) => { if (i === ks.length - 1) c[k] = v; else c = c[k] = {}; }); return o; };
const eng = (x) => P.fmtSI(x, '', 3).trim().replace(' ', '');
let uid = 0;

const themeNow = () => document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

/* ------------------------------------------------------------------ viewer */
let viz;
try {
  viz = new ChargeFieldViz($('#host'), { theme: themeNow() });
} catch (e) {
  console.error(e);
  $('#nogl').style.display = 'grid';
}
if (!viz) throw new Error('WebGL unavailable');
window.chargeFieldLab = { viz };

const syncers = [];
viz.on('options', (o) => syncers.forEach((f) => f(o)));

/* theme follows the page */
const applyTheme = () => viz.setOptions({ theme: themeNow() });
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
new MutationObserver(applyTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

/* ------------------------------------------------------------------ control builders */
function slider(parent, label, path, min, max, step, fmt = (v) => v, hint) {
  const id = 'c' + uid++;
  const out = h('output', { for: id });
  const inp = h('input', { type: 'range', id, min, max, step, title: hint });
  inp.addEventListener('input', () => viz.setOptions(nest(path, +inp.value)));
  syncers.push((o) => { const v = get(o, path); if (document.activeElement !== inp) inp.value = v; out.textContent = fmt(+v); });
  parent.append(h('div', { class: 'row' }, h('label', { for: id }, label), inp, out));
  return inp;
}
function toggle(parent, label, path, sub) {
  const id = 'c' + uid++;
  const inp = h('input', { type: 'checkbox', id });
  inp.addEventListener('change', () => viz.setOptions(nest(path, inp.checked)));
  syncers.push((o) => { inp.checked = !!get(o, path); });
  parent.append(h('label', { class: 'chk', for: id }, inp, h('span', {}, label), sub ? h('span', { class: 'sub' }, sub) : null));
  return inp;
}
function select(parent, label, path, opts, parse = (v) => v) {
  const id = 'c' + uid++;
  const sel = h('select', { id }, opts.map(([v, l]) => h('option', { value: v }, l)));
  sel.addEventListener('change', () => viz.setOptions(nest(path, parse(sel.value))));
  syncers.push((o) => { sel.value = String(get(o, path)); });
  parent.append(h('div', { class: 'row two' }, h('label', { for: id }, label), sel));
  return sel;
}
function seg(parent, label, path, opts, parse = (v) => v) {
  const wrap = h('div', { class: 'seg', role: 'group', 'aria-label': label });
  const btns = opts.map(([v, l]) => { const b = h('button', { type: 'button', 'data-v': v }, l); b.addEventListener('click', () => viz.setOptions(nest(path, parse(v)))); wrap.append(b); return b; });
  syncers.push((o) => btns.forEach((b) => b.setAttribute('aria-pressed', String(String(get(o, path)) === b.dataset.v))));
  parent.append(h('div', { class: 'row two' }, h('label', {}, label), wrap));
}
const group = (title, ...kids) => h('section', { class: 'group' }, h('h2', {}, title), ...kids);

/* ------------------------------------------------------------------ panes */
const panes = {};
for (const id of ['scene', 'field', 'display', 'tools', 'about']) {
  panes[id] = h('div', { class: 'pane' + (id === 'scene' ? ' on' : ''), id: 'pane-' + id, role: 'tabpanel' });
  $('#panes').append(panes[id]);
}
$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (!b) return;
  for (const t of $('#tabs').children) t.setAttribute('aria-selected', String(t === b));
  for (const [id, p] of Object.entries(panes)) p.classList.toggle('on', id === b.dataset.tab);
});

/* ---- Scene: charges ---- */
const Q_UNITS = { e: 1.602176634e-13, nC: 1e-3, 'µC': 1, mC: 1e3 };
let qUnit = 'µC';
const selCharge = () => viz.charges.find((c) => c.id === viz.selectedId);

const presetNote = h('p', { class: 'note' });
const clist = h('div', { class: 'clist', role: 'group', 'aria-label': 'Charges' });
const addPos = h('button', { type: 'button', class: 'btn', onclick: () => addCharge(1) }, '+ Add positive');
const addNeg = h('button', { type: 'button', class: 'btn', onclick: () => addCharge(-1) }, '− Add negative');
function addCharge(sign) {
  const n = viz.charges.length;
  const a = (n * 2.4) % (2 * Math.PI);
  const id = viz.addCharge({ q: sign, position: [Math.cos(a) * 2.2, Math.sin(a) * 2.2, ((n % 3) - 1) * 0.8] });
  if (id == null) return toast('Maximum of 8 charges (GPU uniform limit).');
  viz.selectCharge(id);
}
function renderList() {
  clist.replaceChildren(...viz.charges.map((c, i) => {
    const b = h('button', { type: 'button', class: 'citem', 'aria-pressed': String(c.id === viz.selectedId), onclick: () => viz.selectCharge(c.id) },
      h('i', { style: `background:${c.q >= 0 ? 'var(--pos)' : 'var(--neg)'}` }),
      h('span', {}, `Charge ${i + 1}  ·  ${c.type === 'static' ? 'fixed' : c.type}`),
      h('small', {}, `${c.q >= 0 ? '+' : '−'}${(Math.abs(c.q) / Q_UNITS[qUnit]).toPrecision(3)} ${qUnit}`));
    return b;
  }));
  addPos.disabled = addNeg.disabled = viz.charges.length >= 8;
}

const ed = {};
const editor = h('div', { id: 'editor' });
function numInput(id, cb, extra = {}) {
  const el = h('input', { type: 'number', id, step: 'any', ...extra });
  el.addEventListener('change', () => { const v = parseFloat(el.value); if (isFinite(v)) cb(v); });
  return el;
}
function buildEditor() {
  const upd = (patch) => { const c = selCharge(); if (c) viz.updateCharge(c.id, patch); };
  ed.q = numInput('ed-q', (v) => { const c = selCharge(); if (c) upd({ q: Math.sign(v || 1) * Math.max(Math.abs(v), 1e-9) * Q_UNITS[qUnit] }); }, { min: -1e6 });
  ed.unit = h('select', { id: 'ed-unit' }, Object.keys(Q_UNITS).map((u) => h('option', { value: u }, u)));
  ed.unit.value = qUnit;
  ed.unit.addEventListener('change', () => { qUnit = ed.unit.value; renderList(); refreshEditor(true); });
  ed.sign = h('div', { class: 'seg', role: 'group', 'aria-label': 'Sign' }, ['+', '−'].map((s) => h('button', { type: 'button', onclick: () => { const c = selCharge(); if (c) upd({ q: (s === '+' ? 1 : -1) * Math.abs(c.q) }); } }, s)));
  ed.pos = [0, 1, 2].map((i) => numInput('ed-p' + i, (v) => { const c = selCharge(); if (!c) return; const p = [...c.position]; p[i] = Math.max(-viz.opts.domain, Math.min(viz.opts.domain, v)); upd({ position: p }); }));
  ed.type = h('select', { id: 'ed-type' }, [['static', 'Fixed'], ['linear', 'Uniform velocity'], ['circular', 'Circular orbit'], ['oscillation', 'Linear oscillation']].map(([v, l]) => h('option', { value: v }, l)));
  ed.type.addEventListener('change', () => {
    const c = selCharge(); if (!c) return;
    const t = ed.type.value;
    const patch = { type: t };
    if (t === 'linear' && P.len(c.beta) === 0) patch.beta = [0.2, 0, 0];
    if (t === 'circular') Object.assign(patch, { amplitude: 1.5, omega: 0.45, axis: [0, 0, 1], phase0: 0 });
    if (t === 'oscillation') Object.assign(patch, { amplitude: 0.8, omega: 1, axis: [0, 0, 1], phase0: 0 });
    if (t === 'static') patch.beta = [0, 0, 0];
    upd(patch);
  });
  ed.beta = [0, 1, 2].map((i) => numInput('ed-b' + i, (v) => { const c = selCharge(); if (!c) return; const b = [...c.beta]; b[i] = Math.max(-0.99, Math.min(0.99, v)); upd({ beta: b }); }, { min: -0.99, max: 0.99 }));
  ed.betaMag = h('output', {});
  ed.axis = h('select', { id: 'ed-axis' }, [['x', 'X'], ['y', 'Y'], ['z', 'Z']].map(([v, l]) => h('option', { value: v }, l)));
  ed.axis.addEventListener('change', () => upd({ axis: { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }[ed.axis.value] }));
  ed.amp = numInput('ed-amp', (v) => upd({ amplitude: Math.max(0.05, v) }), { min: 0.05 });
  ed.omega = numInput('ed-om', (v) => upd({ omega: v }));
  ed.phase = numInput('ed-ph', (v) => upd({ phase0: (v * Math.PI) / 180 }));
  ed.bmax = h('output', {});
  ed.linear = h('div', {},
    h('div', { class: 'row two' }, h('label', {}, 'β = v/c'), h('div', { class: 'xyz' }, ed.beta)),
    h('div', { class: 'row two' }, h('label', {}, '|β|, γ'), ed.betaMag));
  ed.orbit = h('div', {},
    h('div', { class: 'row two' }, h('label', { for: 'ed-axis' }, 'Axis'), ed.axis),
    h('div', { class: 'row two' }, h('label', { for: 'ed-amp' }, 'Radius / amp.'), ed.amp),
    h('div', { class: 'row two' }, h('label', { for: 'ed-om' }, 'ω (rad per L/c)'), ed.omega),
    h('div', { class: 'row two' }, h('label', { for: 'ed-ph' }, 'Phase (°)'), ed.phase),
    h('div', { class: 'row two' }, h('label', {}, 'β max = Rω'), ed.bmax));
  ed.del = h('button', { type: 'button', class: 'btn', onclick: () => { const c = selCharge(); if (c) viz.removeCharge(c.id); } }, 'Remove charge');
  editor.append(
    h('div', { class: 'row two' }, h('label', { for: 'ed-q' }, 'Charge'), h('div', { class: 'xyz', style: 'grid-template-columns:1fr 70px 70px' }, ed.q, ed.unit, ed.sign)),
    h('div', { class: 'row two' }, h('label', {}, 'Position'), h('div', { class: 'xyz' }, ed.pos)),
    h('div', { class: 'row two' }, h('label', { for: 'ed-type' }, 'Motion'), ed.type),
    ed.linear, ed.orbit,
    h('div', { class: 'btnrow' }, ed.del));
}
const fix = (v, n = 3) => (Math.abs(v) < 5e-4 ? '0' : String(+v.toFixed(n)));
function setVal(el, v) { if (document.activeElement !== el) el.value = v; }
function refreshEditor(force) {
  const c = selCharge();
  editor.style.display = c ? '' : 'none';
  if (!c) return;
  const w = P.worldline(c, 0);
  setVal(ed.q, +(c.q / Q_UNITS[qUnit]).toPrecision(5));
  [...ed.sign.children].forEach((b, i) => b.setAttribute('aria-pressed', String((i === 0) === (c.q >= 0))));
  const shown = c.type === 'circular' || c.type === 'oscillation' ? c.position : w.s;
  ed.pos.forEach((el, i) => setVal(el, fix(shown[i])));
  ed.type.value = c.type;
  ed.linear.style.display = c.type === 'linear' ? '' : 'none';
  ed.orbit.style.display = c.type === 'circular' || c.type === 'oscillation' ? '' : 'none';
  ed.beta.forEach((el, i) => setVal(el, fix(c.beta[i])));
  const b = P.len(c.beta);
  ed.betaMag.textContent = `${b.toFixed(3)}, γ = ${(1 / Math.sqrt(1 - b * b)).toFixed(3)}`;
  ed.axis.value = ['x', 'y', 'z'][c.axis.findIndex((x) => Math.abs(x) > 0.99)] || 'z';
  setVal(ed.amp, fix(c.amplitude));
  setVal(ed.omega, fix(c.omega));
  setVal(ed.phase, fix((c.phase0 * 180) / Math.PI, 1));
  const bm = c.amplitude * Math.abs(c.omega);
  ed.bmax.textContent = bm.toFixed(3) + (bm >= 0.99 ? '  (clamped < 1)' : '');
  ed.pos.forEach((el) => { el.disabled = false; });
}
buildEditor();
panes.scene.append(
  group('Charges', clist, h('div', { class: 'btnrow' }, addPos, addNeg), h('p', { class: 'note' }, 'Up to 8 charges. Select one here or by clicking it in the view, then edit it below or drag it.')),
  group('Selected charge', editor),
  group('Scene', presetNote));
viz.on('change', () => { renderList(); refreshEditor(); });
viz.on('select', () => { renderList(); refreshEditor(); });
viz.on('preset', (p) => { presetNote.textContent = p.description; $('#preset').value = p.id; });

/* ---- Field pane ---- */
const modelNote = h('p', { class: 'note' });
const unitNote = h('p', { class: 'note' });
const LEN = [[1e-9, '1 nm'], [1e-6, '1 µm'], [1e-3, '1 mm'], [1e-2, '1 cm'], [1, '1 m'], [1e3, '1 km']];
panes.field.append(
  (() => { const g = group('Field and model'); seg(g, 'Field', 'field', [['E', 'Electric E'], ['B', 'Magnetic B']]);
    select(g, 'Model', 'model', [['static', 'Quasi-static (Coulomb + Biot–Savart)'], ['lw', 'Liénard–Wiechert (retarded)']]);
    g.append(modelNote); return g; })(),
  (() => { const g = group('Playback');
    slider(g, 'Time scale', 'timeScale', 0.05, 8, 0.05, (v) => v.toFixed(2) + '×', 'Scene time (L/c) simulated per real second');
    g.append(h('div', { class: 'btnrow' }, h('button', { type: 'button', class: 'btn', onclick: () => viz.resetTime() }, 'Reset time'),
      h('button', { type: 'button', class: 'btn', onclick: () => (viz.opts.playing ? viz.pause() : viz.play()) }, 'Play / pause')));
    return g; })(),
  (() => { const g = group('Units and scale');
    select(g, 'Length of 1 scene unit', 'lengthScale', LEN.map(([v, l]) => [v, l]), (v) => +v);
    g.append(unitNote, h('p', { class: 'note' }, 'Charge units (e, nC, µC, mC) are chosen in the Scene tab. Fields are reported in V/m, T and V.'));
    return g; })(),
  (() => { const g = group('Colour mapping');
    select(g, 'Colour map', 'colormap', [['turbo', 'Turbo'], ['viridis', 'Viridis']]);
    toggle(g, 'Auto range', 'range.auto');
    slider(g, 'Low (log₁₀)', 'range.lo', -12, 24, 0.1, (v) => '10^' + v.toFixed(1));
    slider(g, 'High (log₁₀)', 'range.hi', -12, 24, 0.1, (v) => '10^' + v.toFixed(1));
    g.append(h('p', { class: 'note' }, 'Colour encodes log₁₀ of the field magnitude in SI units. Adjusting a slider switches auto range off.'));
    return g; })());
['range.lo', 'range.hi'].forEach((p) => $('#pane-field').querySelectorAll('input[type=range]').forEach((el) => el.addEventListener('input', () => { if (viz.opts.range.auto) viz.setOptions({ range: { auto: false } }); })));
syncers.push((o) => {
  modelNote.innerHTML = o.model === 'lw'
    ? '<b>Exact for subluminal point charges.</b> Solves the retarded time per point and adds the acceleration (radiation) term. Lines and surfaces are snapshots of the instantaneous field.'
    : '<b>Valid for β ≪ 1.</b> Coulomb field at each charge’s present position; B = β × E / c from the instantaneous velocity.';
  const t = o.lengthScale / P.C_LIGHT;
  unitNote.innerHTML = `Scene time unit L/c = <b>${P.fmtSI(t, 's', 3)}</b>. Velocities are β = v/c; ω is in rad per L/c.`;
  $('#fieldSeg').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === o.field)));
  $('#playBtn').textContent = o.playing ? 'Pause' : 'Play';
});

/* ---- Display pane ---- */
panes.display.append(
  (() => { const g = group('Field lines'); toggle(g, 'Show field lines', 'lines.on');
    slider(g, 'Line density', 'lines.count', 4, 120, 1, (v) => v + '');
    toggle(g, 'Density ∝ |q|', 'lines.byCharge'); toggle(g, 'Animate direction', 'lines.flow');
    select(g, 'Line colour', 'lines.color', [['solid', 'Solid'], ['magnitude', 'By magnitude']]);
    slider(g, 'Opacity', 'lines.alpha', 0.1, 1, 0.05, (v) => v.toFixed(2)); return g; })(),
  (() => { const g = group('Vector arrows'); toggle(g, 'Show arrows', 'arrows.on');
    seg(g, 'Layout', 'arrows.mode', [['slice', 'On slice'], ['volume', '3D grid']]);
    slider(g, 'Resolution', 'arrows.n', 4, 28, 1, (v) => v + '');
    seg(g, 'Length', 'arrows.length', [['unit', 'Unit'], ['log', 'Log'], ['linear', 'Linear']]);
    slider(g, 'Scale', 'arrows.scale', 0.4, 2, 0.05, (v) => v.toFixed(2)); return g; })(),
  (() => { const g = group('Magnitude slice'); toggle(g, 'Show slice', 'slice.on');
    seg(g, 'Normal', 'slice.axis', [['x', 'X'], ['y', 'Y'], ['z', 'Z']]);
    slider(g, 'Offset', 'slice.offset', -6, 6, 0.1, (v) => v.toFixed(1));
    slider(g, 'Opacity', 'slice.opacity', 0.1, 1, 0.05, (v) => v.toFixed(2));
    toggle(g, 'Potential contours (log φ)', 'slice.contours');
    slider(g, 'Contour density', 'slice.density', 0.5, 6, 0.1, (v) => v.toFixed(1)); return g; })(),
  (() => { const g = group('Equipotential surfaces'); toggle(g, 'Show surfaces', 'iso.on');
    slider(g, 'Levels', 'iso.levels', 1, 4, 1, (v) => v + '');
    slider(g, 'Level scale', 'iso.scale', 0.25, 4, 0.05, (v) => '×' + v.toFixed(2));
    slider(g, 'Opacity', 'iso.opacity', 0.1, 0.9, 0.05, (v) => v.toFixed(2));
    g.append(h('p', { class: 'note' }, 'Ray-marched on the GPU, red for φ > 0 and blue for φ < 0. Levels double from φ = q<sub>max</sub> / 4 (normalised).'.replace('<sub>max</sub>', 'max'))); return g; })(),
  (() => { const g = group('Flow tracers'); toggle(g, 'Show tracers', 'particles.on');
    select(g, 'Count', 'particles.size', [[64, '4 096'], [128, '16 384'], [192, '36 864'], [256, '65 536']], (v) => +v);
    slider(g, 'Speed', 'particles.speed', 0.2, 6, 0.1, (v) => v.toFixed(1));
    slider(g, 'Lifetime', 'particles.life', 1, 12, 0.5, (v) => v.toFixed(1) + ' s');
    slider(g, 'Streak', 'particles.streak', 0.05, 0.8, 0.01, (v) => v.toFixed(2));
    g.append(h('p', { class: 'note' }, 'GPU particles advected along the field (RK2). Speed is constant; colour shows magnitude.')); return g; })(),
  (() => { const g = group('View'); toggle(g, 'Axes', 'view.axes'); toggle(g, 'Grid', 'view.grid');
    toggle(g, 'Charge labels', 'view.labels'); toggle(g, 'Probe measurements', 'view.measure');
    slider(g, 'Domain half-size', 'domain', 3, 12, 0.5, (v) => v.toFixed(1)); return g; })(),
  (() => { const g = group('Performance');
    select(g, 'Quality', 'quality', [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']]);
    toggle(g, 'Adaptive level of detail', 'autoLOD');
    g.append(h('p', { class: 'note', id: 'perfNote' }, '')); return g; })());

/* ---- Tools pane ---- */
const testPane = {};
let mu10 = 0, muSign = 1, v0 = 0.15;
panes.tools.append(
  (() => { const g = group('Probe'); toggle(g, 'Show probe', 'probe.on'); toggle(g, 'Follow cursor', 'probe.follow');
    g.append(h('p', { class: 'note' }, 'Drag the white ◆ in the view, or enable Follow cursor to read the field under the pointer (on the slice plane when visible). Values appear bottom-left.'));
    return g; })(),
  (() => {
    const g = group('Test charges');
    const muOut = h('output'), vOut = h('output');
    const mu = h('input', { type: 'range', id: 'tp-mu', min: -2, max: 2, step: 0.1, value: 0 });
    const vv = h('input', { type: 'range', id: 'tp-v', min: 0.02, max: 0.9, step: 0.01, value: 0.15 });
    const upd = () => { mu10 = +mu.value; v0 = +vv.value; muOut.textContent = (10 ** mu10).toPrecision(2); vOut.textContent = v0.toFixed(2); };
    mu.addEventListener('input', upd); vv.addEventListener('input', upd); upd();
    const sg = h('div', { class: 'seg' }, [['+', 1], ['−', -1]].map(([l, s]) => h('button', { type: 'button', 'aria-pressed': String(s === 1), onclick: (e) => { muSign = s; [...e.currentTarget.parentNode.children].forEach((b) => b.setAttribute('aria-pressed', String(b === e.currentTarget))); } }, l)));
    g.append(
      h('div', { class: 'row two' }, h('label', {}, 'Sign'), sg),
      h('div', { class: 'row' }, h('label', { for: 'tp-mu' }, 'q/m (scaled)'), mu, muOut),
      h('div', { class: 'row' }, h('label', { for: 'tp-v' }, 'Initial β'), vv, vOut),
      h('div', { class: 'btnrow' },
        h('button', { type: 'button', class: 'btn', onclick: () => viz.launchTestParticles({ count: 6, mu: muSign * 10 ** mu10, speed: v0 }) }, 'Launch 6 from probe'),
        h('button', { type: 'button', class: 'btn', onclick: () => viz.clearTestParticles() }, 'Clear')),
      h('p', { class: 'note' }, 'Relativistic Lorentz-force particles (Boris pusher) respond to E and B of the current model. Trails show the orbit.'));
    return g;
  })(),
  (() => {
    const g = group('Export');
    let shotScale = 1;
    const sg = h('div', { class: 'seg' }, [['1×', 1], ['2×', 2]].map(([l, s]) => h('button', { type: 'button', 'aria-pressed': String(s === 1), onclick: (e) => { shotScale = s; [...e.currentTarget.parentNode.children].forEach((b) => b.setAttribute('aria-pressed', String(b === e.currentTarget))); } }, l)));
    g.append(
      h('div', { class: 'row two' }, h('label', {}, 'Screenshot size'), sg),
      h('div', { class: 'btnrow' },
        h('button', { type: 'button', class: 'btn', onclick: () => doShot(shotScale) }, 'Save PNG'),
        h('button', { type: 'button', class: 'btn', onclick: toggleRec }, 'Record / stop (WebM)')),
      h('div', { class: 'btnrow' },
        h('button', { type: 'button', class: 'btn', onclick: saveScene }, 'Save scene JSON'),
        h('button', { type: 'button', class: 'btn', onclick: () => $('#sceneFile').click() }, 'Load scene JSON'),
        h('input', { type: 'file', id: 'sceneFile', accept: 'application/json,.json', style: 'display:none', onchange: loadScene })),
      h('p', { class: 'note' }, 'Screenshots include the measurement labels. The viewer asks you to confirm each save.'));
    return g;
  })(),
  (() => {
    const g = group('Verification');
    testPane.out = h('div', {});
    testPane.sum = h('p', { class: 'note' }, 'Compares the field kernels with closed-form results (Coulomb, Gauss, Biot–Savart, Heaviside, Larmor, Maxwell’s equations) and the GPU shaders with the CPU reference.');
    g.append(testPane.sum, h('div', { class: 'btnrow' }, h('button', { type: 'button', class: 'btn primary', id: 'runTests', onclick: runTests }, 'Run all tests')), testPane.out);
    return g;
  })());

async function runTests() {
  const btn = $('#runTests');
  btn.disabled = true; btn.textContent = 'Running…';
  testPane.out.replaceChildren();
  await new Promise((r) => setTimeout(r, 30));
  const res = [];
  try {
    const { runPhysicsTests } = await import('../tests/physics.tests.js');
    res.push(...runPhysicsTests());
  } catch (e) { res.push({ name: 'Physics suite', pass: false, detail: String(e) }); }
  try {
    if (!viz.floatRT) res.push({ name: 'GPU parity', pass: false, detail: 'EXT_color_buffer_float is not available in this browser: skipped.' });
    else { const { runGpuTests } = await import('../tests/gpu.tests.js'); res.push(...runGpuTests(viz)); }
  } catch (e) { res.push({ name: 'GPU parity suite', pass: false, detail: String(e) }); }
  const ok = res.filter((r) => r.pass).length;
  testPane.sum.innerHTML = `<b class="${ok === res.length ? 'pass' : 'fail'}">${ok} / ${res.length} passed</b>`;
  testPane.out.append(h('table', { class: 'tbl' }, h('tbody', {}, res.map((r, i) => h('tr', {}, h('td', { class: r.pass ? 'pass' : 'fail' }, r.pass ? 'PASS' : 'FAIL'), h('td', {}, r.name, h('span', { class: 'd' }, r.detail)))))));
  window.__testResults = res;
  btn.disabled = false; btn.textContent = 'Run all tests';
}

/* ---- Docs pane ---- */
panes.about.innerHTML = `<div class="doc">
<h3>Controls</h3>
<ul>
<li><b>Drag</b> a charge or the ◆ probe to move it; fields recompute every frame. <b>Shift</b>-drag keeps the height (moves in the XY plane).</li>
<li><b>Drag empty space</b> to orbit, <b>right-drag</b> to pan, <b>wheel</b> to zoom. <b>Double-click</b> adds a charge (Shift for negative), <b>Delete</b> removes the selected one, <b>Space</b> plays or pauses.</li>
</ul>
<h3>Physics</h3>
<p>Units: scene length L (set in Field), time in L/c, β = v/c, charges in µC. Fields are returned in V/m, T and V.</p>
<div class="eq">Quasi-static   E = k q r̂ / r²     B = β × E / c     φ = k q / r
Liénard–Wiechert (retarded, n̂ = (r − s)/R, κ = 1 − n̂·β)
  E = k q [ (n̂ − β) / (γ² κ³ R²)  +  n̂ × ((n̂ − β) × β̇) / (c κ³ R) ]
  B = n̂ × E / c        φ = k q / (κ R)</div>
<p>The retarded time solves τ = |r − s(t − τ)|: closed form for uniform motion, bracketed Newton iteration for circular and oscillating worldlines (24 iterations on the GPU, 60 on the CPU). Field lines are RK4 integrations; for B they close around the velocity axis. Equipotentials are found by ray marching with linear root refinement.</p>
<h3>Embedding API</h3>
<pre>&lt;script type="importmap"&gt;{"imports":{
  "three":"https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js",
  "three/addons/":"https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/"}}&lt;/script&gt;
&lt;script type="module"&gt;
import { ChargeFieldViz } from './src/viz.js';
const viz = new ChargeFieldViz(document.querySelector('#host'),
  { field: 'E', model: 'lw', quality: 'high' });
const a = viz.addCharge({ q: 1, position: [0, 0, 1] });
viz.addCharge({ q: -1, type: 'circular', amplitude: 1.5, omega: 0.4 });
viz.setOptions({ iso: { on: true }, slice: { axis: 'x' } });
viz.on('probe', ({ E, B, phi }) =&gt; console.log(E, B, phi));
const f = viz.fieldAt([2, 0, 0]);          // CPU, SI units
const png = await viz.screenshot({ scale: 2 });
&lt;/script&gt;</pre>
<table>
<tr><td>addCharge(o)</td><td>→ id. q [µC], position, type: static | linear | circular | oscillation, beta, axis, amplitude, omega, phase0</td></tr>
<tr><td>updateCharge(id, patch)</td><td>change any charge field live</td></tr>
<tr><td>removeCharge(id), setCharges(list), getCharges()</td><td>scene management (max 8)</td></tr>
<tr><td>setOptions(patch), getOptions()</td><td>deep-merge viewer options (field, model, arrows, lines, slice, iso, particles, view, probe, quality…)</td></tr>
<tr><td>loadPreset(id)</td><td>${PRESETS.map((p) => p.id).join(', ')}</td></tr>
<tr><td>fieldAt(point)</td><td>double-precision CPU field {E, B, phi, Emag, Bmag}</td></tr>
<tr><td>fieldAtGPU(points)</td><td>evaluates the GLSL kernel (float32), for validation</td></tr>
<tr><td>play(), pause(), resetTime()</td><td>time control</td></tr>
<tr><td>screenshot({scale}), startRecording(), stopRecording()</td><td>Blob output (PNG, WebM)</td></tr>
<tr><td>launchTestParticles(o)</td><td>Boris-pushed Lorentz particles</td></tr>
<tr><td>on(evt, fn)</td><td>change, select, options, probe, range, preset, frame, recording</td></tr>
</table>
<h3>Run and build</h3>
<pre>npm install            # three.js (only for local tests)
node tests/run.mjs     # physics tests, no browser needed
npx serve .            # any static server, then open index.html</pre>
<p>There is no bundling step: the page loads ES modules and three.js from a CDN through an import map. For an offline build, point the import map at <code>node_modules/three</code> or bundle with esbuild.</p>
<h3>Porting to Unity or Unreal</h3>
<p><code>FIELD_GLSL</code> in <code>src/shaders.js</code> is self-contained: worldlines, retarded-time solver and the field sum. Copy it into an HLSL include (replace the uniform arrays with a structured buffer or material arrays), then evaluate it in an instanced-arrow vertex shader, a slice-plane pixel shader and a compute shader for tracers. <code>physics.js</code> provides the reference values for unit tests on that side.</p>
<h3>Limits</h3>
<ul>
<li>Trajectories are analytic (fixed, uniform, circular, oscillating) so the retarded time is solvable. Dragging relocates the whole worldline. Uniformly moving charges wrap at the domain edge, which causes a brief field discontinuity.</li>
<li>Field lines are CPU-traced and follow the instantaneous field; the refresh rate adapts to their cost.</li>
</ul></div>`;

/* ------------------------------------------------------------------ header + overlays */
const sel = $('#preset');
PRESETS.forEach((p) => sel.append(h('option', { value: p.id }, p.name)));
sel.addEventListener('change', () => viz.loadPreset(sel.value));
$('#fieldSeg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) viz.setOptions({ field: b.dataset.v }); });
$('#playBtn').addEventListener('click', () => (viz.opts.playing ? viz.pause() : viz.play()));
$('#shotBtn').addEventListener('click', () => doShot(1));
$('#recBtn').addEventListener('click', toggleRec);
addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !/INPUT|SELECT|TEXTAREA|BUTTON/.test(e.target.tagName)) { e.preventDefault(); viz.opts.playing ? viz.pause() : viz.play(); }
});

let toastT;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2600);
}

async function saveFile(blob, filename) {
  try {
    const dl = await window.claude?.use?.('downloads');
    if (dl) { await dl.save({ filename, data: blob }); toast('Saved ' + filename); return; }
  } catch (e) {
    if (e?.code === 'declined') return toast('Save cancelled');
    console.warn('downloads capability failed, using fallback', e);
  }
  const a = h('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast('Downloading ' + filename);
}
async function doShot(scale) {
  const b = await viz.screenshot({ scale });
  if (b) saveFile(b, `charge-field-${Date.now()}.png`);
}
async function toggleRec() {
  if (viz.recording) {
    const b = await viz.stopRecording();
    if (b) saveFile(b, `charge-field-${Date.now()}.webm`);
  } else if (!viz.startRecording()) toast('Video recording is not supported in this browser.');
  else toast('Recording… press Record again to stop');
}
viz.on('recording', (on) => { const b = $('#recBtn'); b.textContent = on ? '■ Stop' : 'Record'; b.classList.toggle('rec', on); });

function sceneJSON() { const o = viz.getOptions(); delete o.theme; return JSON.stringify({ format: 'charge-field-lab/1', options: o, charges: viz.getCharges() }, null, 2); }
function saveScene() { saveFile(new Blob([sceneJSON()], { type: 'application/json' }), 'charge-scene.json'); }
async function loadScene(e) {
  const f = e.target.files[0]; if (!f) return;
  try {
    const d = JSON.parse(await f.text());
    if (!Array.isArray(d.charges)) throw new Error('no charges array');
    const { range, ...rest } = d.options || {};
    viz.setCharges(d.charges);
    viz.setOptions(rest);
    toast('Scene loaded');
  } catch (err) { toast('Could not read scene: ' + err.message); }
  e.target.value = '';
}

/* legend */
const TURBO = (x) => { x = Math.min(1, Math.max(0, x)); const k = { r: [0.13572138, 4.6153926, -42.66032258, 132.13108234, -152.94239396, 59.28637943], g: [0.09140261, 2.19418839, 4.84296658, -14.18503333, 4.27729857, 2.82956604], b: [0.1066733, 12.64194608, -60.58204836, 110.36276771, -89.90310912, 27.34824973] };
  const p = (c) => { let s = 0, t = 1; for (const a of c) { s += a * t; t *= x; } return Math.round(255 * Math.min(1, Math.max(0, s))); };
  return `rgb(${p(k.r)},${p(k.g)},${p(k.b)})`; };
const VIR = (t) => { const c = [[0.2777273272, 0.1050930431, -0.3308618287, -4.634230499, 6.228269936, 4.776384998, -5.435455856], [0.005407344545, 1.4046135299, 0.2148475595, -5.799100973, 14.17993337, -13.74514538, 4.645852612], [0.3340998053, 1.384590163, 0.09509516303, -19.33244096, 56.69055260, -65.35303263, 26.31243525]];
  return `rgb(${c.map((k) => { let s = 0, p = 1; for (const a of k) { s += a * p; p *= t; } return Math.round(255 * Math.min(1, Math.max(0, s))); }).join(',')})`; };
function renderLegend() {
  const o = viz.opts, f = o.colormap === 'viridis' ? VIR : TURBO;
  const stops = Array.from({ length: 12 }, (_, i) => f(i / 11)).join(',');
  const unit = o.field === 'E' ? 'V/m' : 'T';
  $('#legend').innerHTML = `<div class="ttl">|${o.field}| · log scale</div><div class="bar-grad" style="background:linear-gradient(90deg,${stops})"></div><div class="ticks"><span>${P.fmtSI(10 ** o.range.lo, unit, 2)}</span><span>${P.fmtSI(10 ** ((o.range.lo + o.range.hi) / 2), unit, 2)}</span><span>${P.fmtSI(10 ** o.range.hi, unit, 2)}</span></div>`;
}
viz.on('options', renderLegend);
viz.on('range', renderLegend);

/* probe card */
viz.on('probe', (r) => {
  const o = viz.opts, v = (a) => `[${a.map(eng).join(', ')}]`;
  $('#probecard').innerHTML = `<h3><span>Probe</span><span>${r.position.map((x) => x.toFixed(2)).join(', ')} L</span></h3><dl>
  <dt class="vec">E</dt><dd class="vec">${v(r.E)} V/m</dd><dt>|E|</dt><dd>${P.fmtSI(r.Emag, 'V/m', 3)}</dd>
  <dt class="vec">B</dt><dd class="vec">${v(r.B)} T</dd><dt>|B|</dt><dd>${P.fmtSI(r.Bmag, 'T', 3)}</dd>
  <dt>φ</dt><dd>${P.fmtSI(r.phi, 'V', 3)}</dd>
  ${r.nearest ? `<dt>nearest charge</dt><dd>${P.fmtSI(r.nearest.distance, 'm', 3)}</dd>` : ''}</dl>`;
});
$('#probecard').style.display = '';
viz.on('options', (o) => { $('#probecard').style.display = o.probe.on ? '' : 'none'; });

/* status line */
let fc = 0;
viz.on('frame', (s) => {
  if (++fc % 12) return;
  const o = viz.opts, n = viz.charges.length;
  let extra = '';
  if (viz.fieldIsZero) extra = o.field === 'B' ? ' · B = 0: no charge is moving' : ' · field is zero';
  $('#statline').textContent = `${s.fps.toFixed(0)} fps · LOD ${(s.lod * 100).toFixed(0)}% · ${n} charge${n === 1 ? '' : 's'} · ${o.model === 'lw' ? 'retarded' : 'quasi-static'}${extra}`;
  const pn = $('#perfNote'); if (pn) pn.textContent = `Lines: ${s.segs | 0} segments, ${s.lineMs.toFixed(1)} ms per rebuild. Adaptive LOD scales render resolution, line count, tracer count and iso-surface steps.`;
});

/* ------------------------------------------------------------------ start */
viz.loadPreset('dipole');
renderList(); refreshEditor(); renderLegend();
syncers.forEach((f) => f(viz.getOptions()));
