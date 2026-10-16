/**
 * viz.js — ChargeFieldViz: embeddable WebGL2 / three.js viewer for point-charge
 * electromagnetic fields.
 *
 *   import { ChargeFieldViz } from './viz.js';
 *   const viz = new ChargeFieldViz(document.getElementById('host'), { field: 'E' });
 *   viz.addCharge({ q: 1, position: [0, 0, 1] });
 *   viz.on('probe', (r) => console.log(r.E, r.B, r.phi));
 *
 * Coordinate system: right-handed, +Z up. See physics.js for units.
 *
 * Rendering layers (all fields are evaluated on the GPU, per pixel / per vertex):
 *   arrows     instanced arrow mesh, field evaluated in the vertex shader
 *   slice      colour-mapped |F| on a movable plane + potential contours
 *   iso        ray-marched equipotential surfaces (depth-correct, translucent)
 *   particles  GPGPU flow tracers (ping-pong float textures)
 *   lines      field lines traced on the CPU (RK4), animated dashes on the GPU
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import * as P from './physics.js';
import * as S from './shaders.js';
import { PRESETS } from './presets.js';

export const DEFAULT_OPTIONS = {
  field: 'E', // 'E' | 'B'
  model: 'static', // 'static' (Coulomb + Biot–Savart) | 'lw' (Liénard–Wiechert)
  lengthScale: 1, // metres per scene unit
  domain: 6, // half-size of the cubic domain (scene units)
  timeScale: 1, // simulated scene-time per real second
  playing: true,
  colormap: 'turbo', // 'turbo' | 'viridis'
  range: { auto: true, lo: -1, hi: 3 }, // log10 of |F| in SI (V/m or T)
  quality: 'medium', // 'low' | 'medium' | 'high'
  autoLOD: true,
  arrows: { on: true, mode: 'slice', n: 14, length: 'log', scale: 1 }, // mode: slice|volume; length: unit|log|linear
  lines: { on: true, count: 28, byCharge: true, flow: true, alpha: 0.95, color: 'solid' }, // color: solid | magnitude
  slice: { on: true, axis: 'y', offset: 0, opacity: 0.8, contours: true, density: 2 },
  iso: { on: false, levels: 3, scale: 1, opacity: 0.35 },
  particles: { on: false, size: 128, speed: 1.6, life: 5, streak: 0.22 },
  view: { axes: true, grid: true, labels: true, measure: true },
  probe: { on: true, follow: false },
  theme: 'dark',
};

const QUALITY = {
  low: { pr: 0.75, isoSteps: 40, lineSteps: 220 },
  medium: { pr: 1, isoSteps: 72, lineSteps: 340 },
  high: { pr: 2, isoSteps: 120, lineSteps: 480 },
};
const TYPE_ID = { static: 0, linear: 1, circular: 2, oscillation: 3 };
const COL_POS = new THREE.Color('#ff5a4d');
const COL_NEG = new THREE.Color('#4d8dff');
const MAX_SEG = 260000;

const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
function deepMerge(t, s) {
  for (const k of Object.keys(s)) {
    if (isObj(s[k]) && isObj(t[k])) deepMerge(t[k], s[k]);
    else t[k] = Array.isArray(s[k]) ? [...s[k]] : s[k];
  }
  return t;
}
const clone = (o) => JSON.parse(JSON.stringify(o));
const v3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);

export class ChargeFieldViz {
  /**
   * @param {HTMLElement} container  element to fill with the canvas (made position:relative)
   * @param {object} [options]       see DEFAULT_OPTIONS
   */
  constructor(container, options = {}) {
    this.container = container;
    if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
    this.opts = deepMerge(clone(DEFAULT_OPTIONS), options);
    this.charges = [];
    this.selectedId = null;
    this.simTime = 0;
    this._listeners = {};
    this._dirty = { lines: true, range: true, geom: true };
    this._last = performance.now();
    this._frameMs = 16;
    this._frames = 0;
    this.lod = 1;
    this._nextLines = 0;
    this._lineCost = 5;
    this._probeAcc = 0;
    this._testParticles = [];
    this._recorder = null;
    this._disposed = false;
    this.stats = { fps: 0, lod: 1, lineMs: 0, segs: 0 };

    this._initRenderer();
    this._initUniforms();
    this._initScene();
    this._initInteraction();
    this._applyTheme();
    this.resize();
    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(container);
    this._raf = requestAnimationFrame((t) => this._frame(t));
  }

  /* ================================================================== public API */

  on(evt, fn) { (this._listeners[evt] ||= new Set()).add(fn); return () => this._listeners[evt].delete(fn); }
  _emit(evt, data) { this._listeners[evt]?.forEach((f) => { try { f(data); } catch (e) { console.error(e); } }); }

  /** Add a charge; returns its id. Max 8 charges (GPU uniform limit). */
  addCharge(o = {}) {
    if (this.charges.length >= S.MAXQ) return null;
    const c = P.createCharge(o);
    this.charges.push(c);
    this._makeChargeVisual(c);
    this._changed();
    return c.id;
  }
  removeCharge(id) {
    const i = this.charges.findIndex((c) => c.id === id);
    if (i < 0) return false;
    this.charges.splice(i, 1);
    const v = this._cv.get(id);
    if (v) { this.chargeGroup.remove(v.group); v.group.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); }); this._cv.delete(id); }
    if (this.selectedId === id) this.selectCharge(this.charges[0]?.id ?? null);
    this._changed();
    return true;
  }
  /** Patch fields of a charge: q, position, type, beta, axis, amplitude, omega, phase0. */
  updateCharge(id, patch) {
    const c = this.charges.find((x) => x.id === id);
    if (!c) return false;
    Object.assign(c, clone(patch));
    if ('phase0' in patch) c.phase = patch.phase0;
    P.prepareCharge(c);
    this._refreshChargeVisual(c, true);
    this._changed();
    return true;
  }
  getCharges() {
    return this.charges.map((c) => ({ id: c.id, q: c.q, position: [...c.position], type: c.type, beta: [...c.beta], axis: [...c.axis], amplitude: c.amplitude, omega: c.omega, phase0: c.phase0 }));
  }
  setCharges(list) {
    [...this.charges].forEach((c) => this.removeCharge(c.id));
    list.slice(0, S.MAXQ).forEach((o) => this.addCharge(o));
    this.selectCharge(this.charges[0]?.id ?? null);
    this.simTime = 0;
  }
  clearCharges() { this.setCharges([]); }
  selectCharge(id) {
    this.selectedId = id;
    this._emit('select', id);
    this._dirty.geom = true;
  }
  /** Deep-merge viewer options, e.g. setOptions({ field: 'B', slice: { axis: 'x' } }). */
  setOptions(patch) {
    const prev = clone(this.opts);
    deepMerge(this.opts, patch);
    const o = this.opts;
    if (patch.theme) this._applyTheme();
    if (patch.quality || patch.autoLOD !== undefined) this._applyPixelRatio(true);
    if (patch.particles && (patch.particles.size !== prev.particles.size)) this._buildParticles();
    if (patch.arrows || patch.domain || patch.slice) this._dirty.geom = true;
    if (patch.field || patch.model || patch.lengthScale || patch.domain || patch.range) this._dirty.range = true;
    this._dirty.lines = true;
    if (patch.domain) this._buildStatic();
    this._emit('options', clone(o));
  }
  getOptions() { return clone(this.opts); }
  loadPreset(id) {
    const p = PRESETS.find((x) => x.id === id);
    if (!p) return false;
    const keep = { theme: this.opts.theme, quality: this.opts.quality, autoLOD: this.opts.autoLOD, colormap: this.opts.colormap, view: this.opts.view };
    const fresh = deepMerge(deepMerge(clone(DEFAULT_OPTIONS), keep), clone(p.options || {}));
    fresh.range.auto = true;
    this.opts = fresh;
    this.setCharges(p.charges);
    this._clearTestParticles();
    if (p.camera) { this.camera.position.copy(v3(p.camera.position).multiplyScalar(1.3)); this.controls.target.copy(v3(p.camera.target)); this.controls.update(); }
    this._buildStatic();
    this._buildParticles();
    this._dirty = { lines: true, range: true, geom: true };
    this._emit('options', clone(this.opts));
    this._emit('preset', p);
    return true;
  }
  play() { this.opts.playing = true; this._emit('options', clone(this.opts)); }
  pause() { this.opts.playing = false; this._emit('options', clone(this.opts)); }
  resetTime() { this.simTime = 0; this.charges.forEach((c) => { c.phase = c.phase0; }); this._changed(); }
  setProbe(pos) { this.probe.position.copy(v3(pos)); this._probeAcc = 1; this._dirty.geom = true; }
  getProbe() { return this.probe.position.toArray(); }

  /**
   * CPU reference field at a point (scene units).
   * @returns {{E:number[],B:number[],phi:number,Emag:number,Bmag:number}} SI units (V/m, T, V)
   */
  fieldAt(point, { model = this.opts.model } = {}) {
    const f = P.toSI(P.fieldAt(this.charges, point, model), this.opts.lengthScale);
    return { ...f, Emag: P.len(f.E), Bmag: P.len(f.B) };
  }

  /** Evaluate the GPU kernel at points; returns normalised-unit fields (same as physics.js). */
  fieldAtGPU(points, model = this.opts.model) {
    const W = points.length;
    if (!this._probeRT || this._probeRT.width < W) {
      this._probeRT?.dispose();
      this._probeRT = new THREE.WebGLRenderTarget(Math.max(W, 64), 1, { type: THREE.FloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false });
    }
    const data = new Float32Array(this._probeRT.width * 4);
    points.forEach((p, i) => data.set(p, i * 4));
    const tex = new THREE.DataTexture(data, this._probeRT.width, 1, THREE.RGBAFormat, THREE.FloatType);
    tex.needsUpdate = true;
    const prevModel = this.U.uModel.value;
    this.U.uModel.value = model === 'lw' ? 1 : 0;
    this._uploadCharges();
    const mat = this._probeMat;
    mat.uniforms.uPts.value = tex;
    const out = [];
    const buf = [new Float32Array(this._probeRT.width * 4), new Float32Array(this._probeRT.width * 4)];
    for (let w = 0; w < 2; w++) {
      mat.uniforms.uWhich.value = w;
      this._renderQuad(mat, this._probeRT);
      this.renderer.readRenderTargetPixels(this._probeRT, 0, 0, this._probeRT.width, 1, buf[w]);
    }
    for (let i = 0; i < W; i++) out.push({ E: [buf[0][i * 4], buf[0][i * 4 + 1], buf[0][i * 4 + 2]], phi: buf[0][i * 4 + 3], B: [buf[1][i * 4], buf[1][i * 4 + 1], buf[1][i * 4 + 2]] });
    tex.dispose();
    this.U.uModel.value = prevModel;
    this._uploadCharges();
    return out;
  }

  /** PNG screenshot including measurement labels. scale: 1 = canvas size, 2 = double. */
  screenshot({ scale = 1 } = {}) {
    const r = this.renderer, el = r.domElement;
    const prevPR = r.getPixelRatio();
    const w = this.container.clientWidth, h = this.container.clientHeight;
    r.setPixelRatio(Math.min(prevPR * scale, 3));
    r.setSize(w, h, false);
    this._renderOnce();
    const out = document.createElement('canvas');
    out.width = el.width; out.height = el.height;
    const g = out.getContext('2d');
    g.drawImage(el, 0, 0);
    const k = out.width / w;
    g.font = `${Math.round(12 * k)}px ui-monospace, Menlo, Consolas, monospace`;
    g.textBaseline = 'middle';
    for (const L of this._labelList) {
      const tw = g.measureText(L.text).width, pad = 5 * k, hh = 18 * k;
      g.fillStyle = 'rgba(10,14,20,0.72)';
      g.beginPath(); g.roundRect(L.x * k - tw / 2 - pad, L.y * k - hh / 2, tw + 2 * pad, hh, 4 * k); g.fill();
      g.fillStyle = L.color || '#e8eef7';
      g.textAlign = 'center';
      g.fillText(L.text, L.x * k, L.y * k + 1);
    }
    r.setPixelRatio(prevPR);
    r.setSize(w, h, false);
    return new Promise((res) => out.toBlob((b) => res(b), 'image/png'));
  }

  /** Start recording the canvas to WebM. Returns false if unsupported. */
  startRecording({ fps = 30, bitrate = 8e6 } = {}) {
    if (this._recorder || typeof MediaRecorder === 'undefined') return false;
    const stream = this.renderer.domElement.captureStream(fps);
    const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
    if (!mime) return false;
    const chunks = [];
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitrate });
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    this._recorder = { rec, chunks };
    rec.start(250);
    this._emit('recording', true);
    return true;
  }
  stopRecording() {
    if (!this._recorder) return Promise.resolve(null);
    const { rec, chunks } = this._recorder;
    return new Promise((res) => {
      rec.onstop = () => { this._recorder = null; this._emit('recording', false); res(new Blob(chunks, { type: 'video/webm' })); };
      rec.stop();
    });
  }
  get recording() { return !!this._recorder; }

  /** Launch Lorentz-force test particles (Boris pusher) from `position` (default: probe). */
  launchTestParticles({ count = 6, position = this.probe.position.toArray(), speed = 0.15, mu = 1, spread = 0.6 } = {}) {
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2;
      const dir = P.norm([Math.cos(a) * spread, Math.sin(a) * spread, 1 - spread]);
      const g = new THREE.BufferGeometry();
      const N = 500;
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
      g.setDrawRange(0, 0);
      const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: mu >= 0 ? 0xffb347 : 0x62e6d0, transparent: true, opacity: 0.95 }));
      line.frustumCulled = false;
      this.testGroup.add(line);
      const g0 = 1 / Math.sqrt(1 - speed * speed);
      this._testParticles.push({ p: [...position], u: P.mul(dir, speed * g0), mu, n: 0, N, line, age: 0 });
    }
    if (this._testParticles.length > 40) this._testParticles.splice(0, this._testParticles.length - 40).forEach((t) => this._disposeTP(t));
  }
  clearTestParticles() { this._clearTestParticles(); }

  dispose() {
    this._disposed = true;
    cancelAnimationFrame(this._raf);
    this._ro.disconnect();
    this.controls.dispose();
    this._clearTestParticles();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this._labelRoot.remove();
  }

  /* ================================================================== init */

  _initRenderer() {
    const r = (this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' }));
    r.domElement.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;outline:none';
    r.domElement.tabIndex = 0;
    this.container.appendChild(r.domElement);
    this.gl2 = r.capabilities.isWebGL2;
    this.floatRT = r.extensions.has('EXT_color_buffer_float');
    this._labelRoot = document.createElement('div');
    this._labelRoot.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden';
    this.container.appendChild(this._labelRoot);
    this._labelPool = [];
    this._labelList = [];
    this._basePR = Math.min(window.devicePixelRatio || 1, QUALITY[this.opts.quality].pr);
    r.setPixelRatio(this._basePR);
  }

  _initUniforms() {
    const arr4 = () => Array.from({ length: S.MAXQ }, () => new THREE.Vector4());
    const U = (this.U = {
      uN: { value: 0 }, uModel: { value: 0 },
      uPosQ: { value: arr4() }, uBetaT: { value: arr4() }, uAxisA: { value: arr4() }, uE1W: { value: arr4() },
      uPh: { value: new Array(S.MAXQ).fill(0) },
      uField: { value: 0 }, uPhysE: { value: 1 }, uPhysB: { value: 1 }, uPhysPhi: { value: 1 },
      uLo: { value: -1 }, uHi: { value: 3 }, uCmap: { value: 0 },
      uH: { value: this.opts.domain },
    });
    this._shared = U;
  }

  _mat(vertexShader, fragmentShader, extra = {}, params = {}) {
    return new THREE.ShaderMaterial({ vertexShader, fragmentShader, uniforms: { ...this._shared, ...extra }, ...params });
  }

  _initScene() {
    const o = this.opts;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.05, 400);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(9, -11, 6);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.09;
    this.controls.maxDistance = 80;
    this.controls.minDistance = 1.5;

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const dl = new THREE.DirectionalLight(0xffffff, 1.4);
    dl.position.set(4, -6, 9);
    this.scene.add(dl);

    this.staticGroup = new THREE.Group();
    this.scene.add(this.staticGroup);
    this.chargeGroup = new THREE.Group();
    this.scene.add(this.chargeGroup);
    this.testGroup = new THREE.Group();
    this.scene.add(this.testGroup);
    this._cv = new Map();

    // ---- arrows
    const prof = [new THREE.Vector2(0, 0), new THREE.Vector2(0.1, 0), new THREE.Vector2(0.1, 0.6), new THREE.Vector2(0.28, 0.6), new THREE.Vector2(0, 1)];
    const base = new THREE.LatheGeometry(prof, 10);
    base.rotateZ(-Math.PI / 2);
    this._arrowGeo = new THREE.InstancedBufferGeometry();
    this._arrowGeo.copy(base);
    this._arrowMat = this._mat(S.ARROW_VERT, S.ARROW_FRAG, {
      uGridN: { value: 12 }, uGridMode: { value: 1 }, uSliceAxis: { value: 1 }, uSliceOff: { value: 0 },
      uLenMode: { value: 1 }, uArrowScale: { value: 1 },
    });
    this.arrows = new THREE.Mesh(this._arrowGeo, this._arrowMat);
    this.arrows.frustumCulled = false;
    this.scene.add(this.arrows);

    // ---- slice
    this._sliceMat = this._mat(S.SLICE_VERT, S.SLICE_FRAG, {
      uOpacity: { value: 0.8 }, uContours: { value: 1 }, uContourDensity: { value: 2 }, uLineCol: { value: new THREE.Vector3(1, 1, 1) },
    }, { transparent: true, depthWrite: false, side: THREE.DoubleSide, extensions: { derivatives: true } });
    this.slice = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._sliceMat);
    this.slice.renderOrder = 2;
    this.slice.frustumCulled = false;
    this.scene.add(this.slice);

    // ---- iso surfaces (full-screen ray-march)
    this._isoMat = this._mat(S.ISO_VERT, S.ISO_FRAG, {
      uInvProj: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() }, uViewProj: { value: new THREE.Matrix4() },
      uSteps: { value: 72 }, uLevelN: { value: 0 }, uLevels: { value: new Array(8).fill(0) }, uIsoAlpha: { value: 0.35 },
    }, { transparent: true, depthWrite: false, depthTest: true, premultipliedAlpha: true });
    this.iso = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this._isoMat);
    this.iso.frustumCulled = false;
    this.iso.renderOrder = 5;
    this.scene.add(this.iso);

    // ---- field lines
    const lg = (this._lineGeo = new THREE.BufferGeometry());
    lg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX_SEG * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage));
    lg.setAttribute('aMag', new THREE.BufferAttribute(new Float32Array(MAX_SEG * 2), 1).setUsage(THREE.DynamicDrawUsage));
    lg.setAttribute('aS', new THREE.BufferAttribute(new Float32Array(MAX_SEG * 2), 1).setUsage(THREE.DynamicDrawUsage));
    lg.setDrawRange(0, 0);
    this._lineMat = this._mat(S.LINE_VERT, S.LINE_FRAG, { uTime: { value: 0 }, uFlow: { value: 1 }, uLineAlpha: { value: 0.9 }, uSolid: { value: 1 }, uSolidCol: { value: new THREE.Vector3(1, 1, 1) } }, { transparent: true, depthWrite: false });
    this.lines = new THREE.LineSegments(lg, this._lineMat);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 3;
    this.scene.add(this.lines);

    // ---- probe
    this.probe = new THREE.Mesh(new THREE.OctahedronGeometry(0.13), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    this.probe.position.set(2.6, 0, 0.8);
    this.probe.userData.isProbe = true;
    this.scene.add(this.probe);
    this._probeE = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 1, 0xffd23f, 0.3, 0.16);
    this._probeB = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(), 1, 0x3fe0ff, 0.3, 0.16);
    this.scene.add(this._probeE, this._probeB);
    const mg = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(1, 0, 0)]);
    this._measure = new THREE.Line(mg, new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 0.18, gapSize: 0.12, transparent: true, opacity: 0.7 }));
    this.scene.add(this._measure);

    // ---- helper quads
    this._quadScene = new THREE.Scene();
    this._quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this._quad.frustumCulled = false;
    this._quadScene.add(this._quad);
    this._probeMat = this._mat(S.PROBE_VERT, S.PROBE_FRAG, { uPts: { value: null }, uWhich: { value: 0 } });

    this._buildStatic();
    this._buildParticles();
  }

  _buildStatic() {
    const H = this.opts.domain;
    const g = this.staticGroup;
    g.traverse((x) => { x.geometry?.dispose?.(); x.material?.dispose?.(); });
    g.clear();
    this._gridCols = { box: new THREE.LineBasicMaterial({ color: 0x5a6b82, transparent: true, opacity: 0.5 }) };
    const box = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(2 * H, 2 * H, 2 * H)), this._gridCols.box);
    box.name = 'box';
    g.add(box);
    const grid = new THREE.GridHelper(2 * H, Math.round(H * 2), 0x6b7c93, 0x3a4658);
    grid.rotation.x = Math.PI / 2;
    grid.position.z = -H;
    grid.material.transparent = true; grid.material.opacity = 0.55;
    grid.name = 'grid';
    g.add(grid);
    const ax = new THREE.BufferGeometry();
    const L = H * 1.08;
    ax.setAttribute('position', new THREE.Float32BufferAttribute([-L, 0, 0, L, 0, 0, 0, -L, 0, 0, L, 0, 0, 0, -L, 0, 0, L], 3));
    ax.setAttribute('color', new THREE.Float32BufferAttribute([0.9, 0.3, 0.3, 0.9, 0.3, 0.3, 0.35, 0.8, 0.4, 0.35, 0.8, 0.4, 0.4, 0.55, 1, 0.4, 0.55, 1], 3));
    const axes = new THREE.LineSegments(ax, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85 }));
    axes.name = 'axes';
    g.add(axes);
    this.U.uH.value = H;
    this._applyTheme();
  }

  _buildParticles() {
    if (this._pGroup) { this.scene.remove(this._pGroup); this._pGroup.traverse((x) => { x.geometry?.dispose?.(); x.material?.dispose?.(); }); }
    this._pRT?.forEach((t) => t.dispose());
    const n = this.opts.particles.size;
    this._pN = n;
    const mk = () => new THREE.WebGLRenderTarget(n, n, { type: THREE.FloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false });
    this._pRT = [mk(), mk()];
    this._pIdx = 0;
    // initial state: age = -1 -> "unborn", gets staggered respawn
    const init = new Float32Array(n * n * 4);
    for (let i = 0; i < n * n; i++) init[i * 4 + 3] = -1;
    const t = new THREE.DataTexture(init, n, n, THREE.RGBAFormat, THREE.FloatType);
    t.needsUpdate = true;
    this._pInit = t;
    this._pFirst = true;
    this._pUpdate = this._mat(S.PROBE_VERT, S.PART_UPDATE_FRAG, {
      uPos: { value: t }, uDt: { value: 0.016 }, uSpeed: { value: 1.5 }, uLife: { value: 5 }, uSeed: { value: 0 },
    });
    const count = n * n;
    const ref = new Float32Array(count * 2 * 3), pos = new Float32Array(count * 2 * 3);
    for (let i = 0; i < count; i++) {
      const u = ((i % n) + 0.5) / n, v = (Math.floor(i / n) + 0.5) / n;
      ref.set([u, v, 0, u, v, 1], i * 6);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aRef', new THREE.BufferAttribute(ref, 3));
    this._pMat = this._mat(S.PART_VERT, S.PART_FRAG, { uPos: { value: null }, uLife: { value: 5 }, uStreak: { value: 0.2 }, uPx: { value: 1 } }, { transparent: true, depthWrite: false });
    this._pLines = new THREE.LineSegments(geo, this._pMat);
    this._pLines.frustumCulled = false;
    this._pLines.renderOrder = 4;
    this._pGroup = new THREE.Group();
    this._pGroup.add(this._pLines);
    this.scene.add(this._pGroup);
  }

  /* ================================================================== charges / visuals */

  _chargeRadius(c) { return 0.13 + 0.08 * Math.cbrt(Math.abs(c.q)); }

  _makeChargeVisual(c) {
    const grp = new THREE.Group();
    const col = c.q >= 0 ? COL_POS : COL_NEG;
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(1, 36, 24), new THREE.MeshPhongMaterial({ color: col, shininess: 70, emissive: col.clone().multiplyScalar(0.25) }));
    sphere.userData.chargeId = c.id;
    const ringM = new THREE.Mesh(new THREE.TorusGeometry(1, 0.055, 8, 48), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 }));
    ringM.visible = false;
    const arrow = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 1, 0xffffff, 0.25, 0.14);
    arrow.visible = false;
    const path = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xaab8cc, transparent: true, opacity: 0.45 }));
    path.visible = false;
    grp.add(sphere, ringM, arrow);
    this.chargeGroup.add(grp, path);
    grp.userData.path = path;
    this._cv.set(c.id, { group: grp, sphere, ring: ringM, arrow, path });
    this._refreshChargeVisual(c, true);
  }

  _refreshChargeVisual(c, rebuild) {
    const v = this._cv.get(c.id);
    if (!v) return;
    const col = c.q >= 0 ? COL_POS : COL_NEG;
    v.sphere.material.color.copy(col);
    v.sphere.material.emissive.copy(col).multiplyScalar(0.25);
    const r = this._chargeRadius(c);
    v.sphere.scale.setScalar(r);
    v.ring.scale.setScalar(r * 1.6);
    if (rebuild) {
      const pts = [];
      if (c.type === 'circular') for (let i = 0; i <= 96; i++) { const a = (i / 96) * Math.PI * 2; pts.push(v3(P.add(c.position, P.add(P.mul(c.e1, Math.cos(a) * c.amplitude), P.mul(c.e2, Math.sin(a) * c.amplitude))))); }
      else if (c.type === 'oscillation') pts.push(v3(P.add(c.position, P.mul(c.axis, -c.amplitude))), v3(P.add(c.position, P.mul(c.axis, c.amplitude))));
      v.path.geometry.dispose();
      v.path.geometry = new THREE.BufferGeometry().setFromPoints(pts);
      v.path.visible = pts.length > 0;
    }
  }

  _changed() {
    this._dirty.lines = true;
    this._dirty.range = true;
    this._dirty.geom = true;
    this._emit('change', this.getCharges());
  }

  _uploadCharges() {
    const U = this.U, n = Math.min(this.charges.length, S.MAXQ);
    U.uN.value = n;
    for (let i = 0; i < n; i++) {
      const c = this.charges[i];
      U.uPosQ.value[i].set(c.position[0], c.position[1], c.position[2], c.q);
      U.uBetaT.value[i].set(c.beta[0], c.beta[1], c.beta[2], TYPE_ID[c.type]);
      U.uAxisA.value[i].set(c.axis[0], c.axis[1], c.axis[2], c.amplitude);
      U.uE1W.value[i].set(c.e1[0], c.e1[1], c.e1[2], c.omega);
      U.uPh.value[i] = c.phase;
    }
  }

  /* ================================================================== interaction */

  _initInteraction() {
    const el = this.renderer.domElement;
    this._ray = new THREE.Raycaster();
    this._ndc = new THREE.Vector2();
    this._drag = null;
    const setNdc = (e) => {
      const b = el.getBoundingClientRect();
      this._ndc.set(((e.clientX - b.left) / b.width) * 2 - 1, -((e.clientY - b.top) / b.height) * 2 + 1);
      this._ray.setFromCamera(this._ndc, this.camera);
    };
    this._setNdc = setNdc;
    const pickTargets = () => [...this.charges.map((c) => this._cv.get(c.id)?.sphere), this.probe].filter(Boolean);
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      setNdc(e);
      const hit = this._ray.intersectObjects(pickTargets(), false)[0];
      if (!hit) return;
      const obj = hit.object;
      const isProbe = !!obj.userData.isProbe;
      let target, offset = new THREE.Vector3();
      if (isProbe) { target = this.probe.position; }
      else {
        const c = this.charges.find((x) => x.id === obj.userData.chargeId);
        this.selectCharge(c.id);
        const cur = obj.parent.position.clone();
        target = c;
        offset.copy(cur).sub(v3(c.position));
      }
      const normal = this.camera.getWorldDirection(new THREE.Vector3());
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, hit.point);
      this._drag = { isProbe, target, plane, offset, grab: hit.point.clone(), startPos: isProbe ? this.probe.position.clone() : v3(target.position) };
      this.controls.enabled = false;
      el.setPointerCapture(e.pointerId);
      el.style.cursor = 'grabbing';
    });
    el.addEventListener('pointermove', (e) => {
      setNdc(e);
      if (this._drag) {
        const d = this._drag;
        const p = new THREE.Vector3();
        if (e.shiftKey) d.plane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 0, 1), d.grab);
        if (!this._ray.ray.intersectPlane(d.plane, p)) return;
        const delta = p.clone().sub(d.grab);
        const H = this.opts.domain;
        const np = d.startPos.clone().add(delta);
        np.clampScalar(-H, H);
        if (d.isProbe) { this.probe.position.copy(np); this._probeAcc = 1; }
        else { d.target.position = [np.x, np.y, np.z]; this._changed(); this._refreshChargeVisual(d.target, true); }
        return;
      }
      if (this.opts.probe.follow) this._followProbe();
      const hit = this._ray.intersectObjects(pickTargets(), false)[0];
      el.style.cursor = hit ? 'grab' : this.opts.probe.follow ? 'crosshair' : 'default';
    });
    const end = (e) => {
      if (!this._drag) return;
      this._drag = null;
      this.controls.enabled = true;
      el.style.cursor = 'default';
      try { el.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      this._dirty.range = true;
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('dblclick', (e) => {
      setNdc(e);
      if (this._ray.intersectObjects(pickTargets(), false)[0]) return;
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(this.camera.getWorldDirection(new THREE.Vector3()), this.controls.target);
      const p = new THREE.Vector3();
      if (!this._ray.ray.intersectPlane(plane, p)) return;
      p.clampScalar(-this.opts.domain, this.opts.domain);
      const id = this.addCharge({ q: e.shiftKey ? -1 : 1, position: p.toArray() });
      if (id != null) this.selectCharge(id);
    });
    el.addEventListener('keydown', (e) => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedId != null) { this.removeCharge(this.selectedId); e.preventDefault(); }
    });
  }

  _followProbe() {
    const o = this.opts;
    let plane;
    if (o.slice.on) {
      const n = o.slice.axis === 'x' ? [1, 0, 0] : o.slice.axis === 'y' ? [0, 1, 0] : [0, 0, 1];
      plane = new THREE.Plane(v3(n), -o.slice.offset);
    } else plane = new THREE.Plane().setFromNormalAndCoplanarPoint(this.camera.getWorldDirection(new THREE.Vector3()), this.controls.target);
    const p = new THREE.Vector3();
    if (this._ray.ray.intersectPlane(plane, p)) {
      p.clampScalar(-o.domain, o.domain);
      this.probe.position.copy(p);
      this._probeAcc = 1;
    }
  }

  /* ================================================================== theme / size */

  _applyTheme() {
    const dark = this.opts.theme !== 'light';
    this.scene.background = new THREE.Color(dark ? 0x0b0f16 : 0xe9edf3);
    const g = this.staticGroup;
    g.getObjectByName('box')?.material.color.set(dark ? 0x5a6b82 : 0x7d8aa0);
    const grid = g.getObjectByName('grid');
    if (grid) {
      const cols = dark ? [0x6b7c93, 0x2d3847] : [0x8c98ab, 0xc3cbd8];
      const c = grid.geometry.attributes.color;
      const a = new THREE.Color(cols[0]), b = new THREE.Color(cols[1]);
      const n = Math.round(this.opts.domain * 2);
      for (let i = 0; i < c.count; i++) {
        const seg = Math.floor(i / 2) % (n + 1);
        const centre = seg === n / 2;
        const col = centre ? a : b;
        c.setXYZ(i, col.r, col.g, col.b);
      }
      c.needsUpdate = true;
    }
    this._sliceMat.uniforms.uLineCol.value.set(...(dark ? [1, 1, 1] : [0.05, 0.08, 0.12]));
    this._probeLabelColor = dark ? '#ffffff' : '#0b0f16';
    this.probe.material.color.set(dark ? 0xffffff : 0x111827);
    this._measure.material.color.set(dark ? 0xffffff : 0x111827);
    this._lineMat.uniforms.uLineAlpha.value = this.opts.lines.alpha;
    this._lineMat.uniforms.uSolidCol.value.set(...(dark ? [0.96, 0.97, 1] : [0.08, 0.1, 0.16]));
  }

  resize() {
    const w = Math.max(this.container.clientWidth, 1), h = Math.max(this.container.clientHeight, 1);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  _applyPixelRatio(force) {
    const q = QUALITY[this.opts.quality];
    this._basePR = Math.min(window.devicePixelRatio || 1, q.pr);
    const pr = this._basePR * (this.opts.autoLOD ? 0.55 + 0.45 * this.lod : 1);
    if (force || Math.abs(pr - this.renderer.getPixelRatio()) > 0.06) { this.renderer.setPixelRatio(pr); this.resize(); }
  }

  /* ================================================================== frame loop */

  _frame(now) {
    if (this._disposed) return;
    this._raf = requestAnimationFrame((t) => this._frame(t));
    const dtReal = Math.min((now - this._last) / 1000, 0.1);
    this._last = now;
    this._frames++;
    this._frameMs = this._frameMs * 0.92 + dtReal * 1000 * 0.08;
    this.stats.fps = 1000 / Math.max(this._frameMs, 1);
    this._autoLod();
    const o = this.opts;
    let moving = false;
    if (o.playing && dtReal > 0) {
      const dt = dtReal * o.timeScale;
      this.simTime += dt;
      for (const c of this.charges) {
        if (c.type !== 'static' && (c.type !== 'linear' || P.len(c.beta) > 0)) moving = true;
        P.stepCharge(c, dt);
        if (c.type === 'linear') {
          const lim = o.domain * 1.25;
          for (let k = 0; k < 3; k++) if (Math.abs(c.position[k]) > lim) c.position[k] -= 2 * Math.sign(c.position[k]) * lim;
        }
        if (c.type === 'circular' || c.type === 'oscillation') c.phase %= 4 * Math.PI * 1000;
      }
    } else moving = this.charges.some((c) => c.type !== 'static') && o.playing;
    this._uploadCharges();
    this._syncUniforms();
    this._syncVisuals(moving);
    this.controls.update();
    this._stepParticles(dtReal);
    this._stepTestParticles(dtReal * o.timeScale);
    this._updateProbe(dtReal);
    this._lineMat.uniforms.uTime.value = now / 1000;
    this._renderOnce();
    this._updateLabels();
    this._emit('frame', this.stats);
  }

  _autoLod() {
    if (!this.opts.autoLOD || this._frames < 40 || this._frames % 20) { this.stats.lod = this.lod; return; }
    if (this._frameMs > 27 && this.lod > 0.35) this.lod = Math.max(0.35, this.lod * 0.88);
    else if (this._frameMs < 15 && this.lod < 1) this.lod = Math.min(1, this.lod * 1.06);
    this.stats.lod = this.lod;
    this._applyPixelRatio(false);
  }

  _syncUniforms() {
    const o = this.opts, U = this.U;
    const s = P.physicalScale(o.lengthScale);
    U.uModel.value = o.model === 'lw' ? 1 : 0;
    U.uField.value = o.field === 'B' ? 1 : 0;
    U.uPhysE.value = s.E; U.uPhysB.value = s.B; U.uPhysPhi.value = s.phi;
    U.uCmap.value = o.colormap === 'viridis' ? 1 : 0;
    U.uH.value = o.domain;
    U.uLo.value = o.range.lo; U.uHi.value = o.range.hi;
  }

  _syncVisuals(moving) {
    const o = this.opts, H = o.domain;
    // arrows
    const a = o.arrows;
    this.arrows.visible = a.on;
    const am = this._arrowMat.uniforms;
    am.uGridN.value = a.n;
    am.uGridMode.value = a.mode === 'volume' ? 0 : 1;
    am.uSliceAxis.value = { x: 0, y: 1, z: 2 }[o.slice.axis];
    am.uSliceOff.value = o.slice.offset;
    am.uLenMode.value = { unit: 0, log: 1, linear: 2 }[a.length];
    am.uArrowScale.value = a.scale;
    this._arrowGeo.instanceCount = a.mode === 'volume' ? a.n ** 3 : a.n * a.n;
    // slice
    const sl = o.slice;
    this.slice.visible = sl.on;
    this.slice.scale.setScalar(H);
    this.slice.rotation.set(0, 0, 0);
    this.slice.position.set(0, 0, 0);
    if (sl.axis === 'x') { this.slice.rotation.y = Math.PI / 2; this.slice.position.x = sl.offset; }
    else if (sl.axis === 'y') { this.slice.rotation.x = Math.PI / 2; this.slice.position.y = sl.offset; }
    else this.slice.position.z = sl.offset;
    const sm = this._sliceMat.uniforms;
    sm.uOpacity.value = sl.opacity;
    sm.uContours.value = sl.contours ? 1 : 0;
    sm.uContourDensity.value = sl.density;
    // iso
    const iso = o.iso;
    this.iso.visible = iso.on && this.charges.length > 0;
    if (this.iso.visible) {
      const im = this._isoMat.uniforms;
      const qmax = Math.max(...this.charges.map((c) => Math.abs(c.q)), 1e-6);
      const base = (qmax / 2) * iso.scale;
      const hasNeg = this.charges.some((c) => c.q < 0), hasPos = this.charges.some((c) => c.q > 0);
      const per = Math.min(iso.levels, hasNeg && hasPos ? 4 : 8);
      const lv = [];
      for (let j = 0; j < per; j++) {
        const m = base * Math.pow(2, j - 1);
        if (hasPos) lv.push(m);
        if (hasNeg) lv.push(-m);
      }
      lv.length = Math.min(lv.length, 8);
      lv.forEach((v, i) => { im.uLevels.value[i] = v; });
      im.uLevelN.value = lv.length;
      this._isoLevelsNorm = lv;
      im.uSteps.value = Math.max(24, Math.round(QUALITY[o.quality].isoSteps * (o.autoLOD ? this.lod : 1)));
      im.uIsoAlpha.value = iso.opacity;
      im.uInvProj.value.copy(this.camera.projectionMatrixInverse);
      im.uCamWorld.value.copy(this.camera.matrixWorld);
      im.uViewProj.value.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    }
    // view helpers
    this.staticGroup.getObjectByName('grid').visible = o.view.grid;
    this.staticGroup.getObjectByName('axes').visible = o.view.axes;
    // particles
    this._pGroup.visible = o.particles.on && this.floatRT;
    this._pMat.uniforms.uLife.value = o.particles.life;
    this._pMat.uniforms.uStreak.value = o.particles.streak;
    this._pLines.geometry.setDrawRange(0, Math.floor(this._pN * this._pN * (o.autoLOD ? Math.max(this.lod, 0.4) : 1)) * 2);
    // range / lines
    if (this._dirty.range && !this._drag) this._autoRange();
    else if (this._dirty.range && this._frames % 6 === 0) this._autoRange();
    const now = performance.now();
    const wantLines = o.lines.on && (this._dirty.lines || (moving && o.playing));
    if (wantLines && now >= this._nextLines) {
      const t0 = performance.now();
      this._buildLines();
      this._lineCost = performance.now() - t0;
      this.stats.lineMs = this._lineCost;
      this._nextLines = now + Math.max(40, this._lineCost * 3.5);
      this._dirty.lines = false;
    }
    this.lines.visible = o.lines.on;
    this._lineMat.uniforms.uFlow.value = o.lines.flow ? 1 : 0;
    this._lineMat.uniforms.uSolid.value = o.lines.color === 'solid' ? 1 : 0;
    this._lineMat.uniforms.uLineAlpha.value = o.lines.alpha;
    // charges
    for (const c of this.charges) {
      const v = this._cv.get(c.id);
      if (!v) continue;
      const w = P.worldline(c, 0);
      v.group.position.set(w.s[0], w.s[1], w.s[2]);
      const sel = c.id === this.selectedId;
      v.ring.visible = sel;
      if (sel) v.ring.quaternion.copy(this.camera.quaternion);
      const sp = P.len(w.b);
      v.arrow.visible = sp > 1e-4;
      if (sp > 1e-4) { v.arrow.position.set(0, 0, 0); v.arrow.setDirection(v3(P.norm(w.b))); v.arrow.setLength(this._chargeRadius(c) + 0.5 + 1.4 * sp, 0.25, 0.14); }
      v.path.visible = c.type === 'circular' || c.type === 'oscillation';
      v.path.position.set(0, 0, 0);
    }
    this._dirty.geom = false;
  }

  _renderOnce() {
    this.renderer.render(this.scene, this.camera);
  }

  _renderQuad(material, target) {
    this._quad.material = material;
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(target);
    this.renderer.render(this._quadScene, this._quadCam);
    this.renderer.setRenderTarget(prev);
  }

  /* ================================================================== particles (GPGPU) */

  _stepParticles(dt) {
    const o = this.opts.particles;
    if (!o.on || !this.floatRT) return;
    const u = this._pUpdate.uniforms;
    u.uDt.value = Math.min(dt, 0.05);
    u.uSpeed.value = o.speed;
    u.uLife.value = o.life;
    u.uSeed.value = (this._frames * 0.6180339) % 100;
    u.uPos.value = this._pFirst ? this._pInit : this._pRT[this._pIdx].texture;
    this._pFirst = false;
    const dst = 1 - this._pIdx;
    this._renderQuad(this._pUpdate, this._pRT[dst]);
    this._pIdx = dst;
    this._pMat.uniforms.uPos.value = this._pRT[dst].texture;
  }

  /* ================================================================== field range */

  _autoRange() {
    const o = this.opts;
    this._dirty.range = false;
    if (!o.range.auto) return;
    const H = o.domain, n = 9, vals = [];
    const rx = [];
    for (let i = 0; i < n; i++) rx.push(((i + 0.5) / n * 2 - 1) * H);
    const near = (p) => this.charges.some((c) => P.len(P.sub(p, P.worldline(c, 0).s)) < 0.45);
    const kind = o.field;
    const sc = P.physicalScale(o.lengthScale);
    for (const x of rx) for (const y of rx) for (const z of rx) {
      const p = [x, y, z];
      if (near(p)) continue;
      const f = P.fieldAt(this.charges, p, o.model);
      const m = P.len(kind === 'E' ? f.E : f.B) * (kind === 'E' ? sc.E : sc.B);
      if (m > 0 && isFinite(m)) vals.push(Math.log10(m));
    }
    this.fieldIsZero = vals.length < 8;
    if (this.fieldIsZero) { this._emit('range', { zero: true }); return; }
    vals.sort((a, b) => a - b);
    const hi = vals[Math.floor(vals.length * 0.985)], lo = Math.max(vals[Math.floor(vals.length * 0.03)], hi - 5);
    // include region close to charges: bump hi a little
    o.range.hi = +(hi + 0.6).toFixed(2);
    o.range.lo = +Math.min(lo, hi - 0.8).toFixed(2);
    this._emit('range', { lo: o.range.lo, hi: o.range.hi, zero: false });
  }

  /* ================================================================== CPU field lines */

  _buildLines() {
    const o = this.opts, H = o.domain, ch = this.charges;
    const pos = this._lineGeo.attributes.position.array, mag = this._lineGeo.attributes.aMag.array, arc = this._lineGeo.attributes.aS.array;
    let nv = 0;
    const model = o.model, kind = o.field;
    const sc = P.physicalScale(o.lengthScale);
    const phys = kind === 'E' ? sc.E : sc.B;
    const lod = o.autoLOD ? Math.max(this.lod, 0.45) : 1;
    const maxSteps = QUALITY[o.quality].lineSteps;
    const lo = o.range.lo, hi = o.range.hi;
    const present = ch.map((c) => P.worldline(c, 0).s);
    const dist = (p) => { let m = 1e9, k = -1; for (let i = 0; i < present.length; i++) { const d = P.len(P.sub(p, present[i])); if (d < m) { m = d; k = i; } } return [m, k]; };

    const trace = (p0, sign, isB, originIdx) => {
      const pts = [p0], ms = [];
      let p = p0, s = 0, ended = 'max';
      const dirAt = (q) => {
        const f = P.fieldAt(ch, q, model), v = isB ? f.B : f.E, l = P.len(v);
        return l > 0 && isFinite(l) ? { d: P.mul(v, sign / l), l } : null;
      };
      const arcs = [0];
      for (let i = 0; i < maxSteps; i++) {
        const [dn] = dist(p);
        const h = Math.min(0.3, Math.max(0.035, 0.2 * dn)) * (isB ? 0.8 : 1);
        const k1 = dirAt(p); if (!k1) { ended = 'null'; break; }
        const k2 = dirAt(P.add(p, P.mul(k1.d, h / 2))); if (!k2) { ended = 'null'; break; }
        const k3 = dirAt(P.add(p, P.mul(k2.d, h / 2))); if (!k3) { ended = 'null'; break; }
        const k4 = dirAt(P.add(p, P.mul(k3.d, h))); if (!k4) { ended = 'null'; break; }
        const step = P.mul(P.add(P.add(k1.d, P.mul(k2.d, 2)), P.add(P.mul(k3.d, 2), k4.d)), h / 6);
        const q = P.add(p, step);
        ms.push(Math.min(1, Math.max(0, (Math.log10(Math.max(k1.l * phys, 1e-30)) - lo) / Math.max(hi - lo, 1e-3))));
        p = q; s += h; pts.push(p); arcs.push(s);
        if (Math.abs(p[0]) > H || Math.abs(p[1]) > H || Math.abs(p[2]) > H) { ended = 'box'; break; }
        if (!isB) {
          const [d2, k] = dist(p);
          if (i > 3 && d2 < 0.1 + 0.3 * h) { ended = 'sink:' + k; break; }
        } else if (i > 12 && P.len(P.sub(p, p0)) < h * 0.9) { ended = 'closed'; break; }
      }
      ms.push(ms[ms.length - 1] ?? 0);
      return { pts, ms, arcs, ended };
    };

    const emit = (L) => {
      for (let i = 0; i < L.pts.length - 1 && nv + 2 <= MAX_SEG * 2; i++) {
        const a = L.pts[i], b = L.pts[i + 1];
        pos[nv * 3] = a[0]; pos[nv * 3 + 1] = a[1]; pos[nv * 3 + 2] = a[2];
        mag[nv] = L.ms[i]; arc[nv] = L.arcs[i]; nv++;
        pos[nv * 3] = b[0]; pos[nv * 3 + 1] = b[1]; pos[nv * 3 + 2] = b[2];
        mag[nv] = L.ms[Math.min(i + 1, L.ms.length - 1)]; arc[nv] = L.arcs[i + 1]; nv++;
      }
    };

    const qmax = Math.max(...ch.map((c) => Math.abs(c.q)), 1e-9);
    const ga = Math.PI * (3 - Math.sqrt(5));
    const budget = Math.max(4, Math.round(o.lines.count * lod));
    if (kind === 'E') {
      ch.forEach((c, ci) => {
        const n = Math.max(4, Math.round(o.lines.byCharge ? (budget * Math.abs(c.q)) / qmax : budget));
        const s0 = present[ci];
        for (let i = 0; i < n; i++) {
          const z = 1 - (2 * (i + 0.5)) / n, r = Math.sqrt(1 - z * z), th = ga * i;
          const seed = P.add(s0, P.mul([Math.cos(th) * r, Math.sin(th) * r, z], 0.14));
          const sign = c.q >= 0 ? 1 : -1;
          const L = trace(seed, sign, false, ci);
          if (sign < 0 && L.ended.startsWith('sink:') && ch[+L.ended.slice(5)]?.q > 0) continue; // duplicate of a + line
          emit(L);
        }
      });
    } else {
      ch.forEach((c, ci) => {
        const w = P.worldline(c, 0);
        const sp = P.len(w.b);
        if (sp < 1e-5) return;
        const ax = P.norm(w.b);
        const t = Math.abs(ax[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
        const u = P.norm(P.cross(t, ax));
        const rings = Math.max(3, Math.round(budget / 4));
        for (let r = 0; r < rings; r++) {
          const rho = 0.35 * Math.pow(1.45, r);
          for (const zf of [0, 0.7, -0.7]) {
            const seed = P.add(present[ci], P.add(P.mul(u, rho), P.mul(ax, zf * rho)));
            if (Math.abs(seed[0]) > H || Math.abs(seed[1]) > H || Math.abs(seed[2]) > H) continue;
            const L = trace(seed, 1, true, ci);
            emit(L);
            if (L.ended !== 'closed') { const L2 = trace(seed, -1, true, ci); emit(L2); }
          }
        }
      });
    }
    this._lineGeo.setDrawRange(0, nv);
    ['position', 'aMag', 'aS'].forEach((k) => { this._lineGeo.attributes[k].needsUpdate = true; });
    this.stats.segs = nv / 2;
  }

  /* ================================================================== test particles (Boris) */

  _stepTestParticles(dt) {
    if (!this._testParticles.length || !this.opts.playing) return;
    const H = this.opts.domain, model = this.opts.model;
    const sub = 6, h = Math.min(dt, 0.05) / sub;
    for (const t of [...this._testParticles]) {
      for (let k = 0; k < sub; k++) {
        const f = P.fieldAt(this.charges, t.p, model);
        const half = P.mul(f.E, (t.mu * h) / 2);
        let um = P.add(t.u, half);
        const gm = Math.sqrt(1 + P.dot(um, um));
        const tv = P.mul(f.B, (t.mu * h) / (2 * gm));
        const sv = P.mul(tv, 2 / (1 + P.dot(tv, tv)));
        const up = P.add(um, P.cross(um, tv));
        um = P.add(um, P.cross(up, sv));
        t.u = P.add(um, half);
        const g = Math.sqrt(1 + P.dot(t.u, t.u));
        t.p = P.add(t.p, P.mul(t.u, h / g));
      }
      t.age += dt;
      const a = t.line.geometry.attributes.position;
      if (t.n < t.N) { a.setXYZ(t.n, t.p[0], t.p[1], t.p[2]); t.n++; }
      else { a.array.copyWithin(0, 3); a.setXYZ(t.N - 1, t.p[0], t.p[1], t.p[2]); }
      a.needsUpdate = true;
      t.line.geometry.setDrawRange(0, t.n);
      const out = Math.max(...t.p.map(Math.abs)) > H * 1.2 || !isFinite(t.p[0]);
      if (out || t.age > 60) { this._testParticles.splice(this._testParticles.indexOf(t), 1); this._disposeTP(t); }
    }
  }
  _disposeTP(t) { this.testGroup.remove(t.line); t.line.geometry.dispose(); t.line.material.dispose(); }
  _clearTestParticles() { this._testParticles.forEach((t) => this._disposeTP(t)); this._testParticles = []; }

  /* ================================================================== probe, labels */

  _updateProbe(dt) {
    const o = this.opts;
    this.probe.visible = o.probe.on;
    this._probeE.visible = this._probeB.visible = o.probe.on;
    this._measure.visible = o.probe.on && o.view.measure && this.charges.length > 0;
    if (!o.probe.on) return;
    this._probeAcc += dt;
    if (this._probeAcc < 0.05 && !this._dirty.geom) return;
    this._probeAcc = 0;
    const p = this.probe.position.toArray();
    const f = this.fieldAt(p);
    const res = { position: p, E: f.E, B: f.B, phi: f.phi, Emag: f.Emag, Bmag: f.Bmag };
    // nearest / selected charge for the measurement overlay
    let best = null;
    for (const c of this.charges) {
      const s = P.worldline(c, 0).s, d = P.len(P.sub(p, s));
      if (!best || d < best.d || c.id === this.selectedId) if (!best || best.id !== this.selectedId) best = { id: c.id, d, s, q: c.q };
    }
    res.nearest = best ? { id: best.id, distance: best.d * o.lengthScale, q: best.q } : null;
    this._probeRes = res;
    this._measureTarget = best;
    const place = (arrow, vec, mx) => {
      const m = P.len(vec);
      arrow.visible = m > 0 && o.probe.on;
      if (m > 0) { arrow.position.copy(this.probe.position); arrow.setDirection(v3(P.norm(vec))); arrow.setLength(0.9, 0.28, 0.15); }
    };
    place(this._probeE, f.E);
    place(this._probeB, f.B);
    if (best) {
      const g = this._measure.geometry.attributes.position;
      g.setXYZ(0, p[0], p[1], p[2]); g.setXYZ(1, best.s[0], best.s[1], best.s[2]); g.needsUpdate = true;
      this._measure.computeLineDistances();
    }
    this._emit('probe', res);
  }

  _label(i, x, y, text, color) {
    this._labelList.push({ x, y, text, color });
  }

  _updateLabels() {
    const o = this.opts;
    const w = this.container.clientWidth, h = this.container.clientHeight;
    const list = (this._labelList = []);
    const proj = (p) => { const v = v3(p).project(this.camera); return v.z < 1 && v.z > -1 ? [(v.x * 0.5 + 0.5) * w, (-v.y * 0.5 + 0.5) * h] : null; };
    if (o.view.labels) {
      for (const c of this.charges) {
        const s = P.worldline(c, 0).s, xy = proj([s[0], s[1], s[2] + this._chargeRadius(c) + 0.25]);
        if (xy) this._label(0, xy[0], xy[1] - 6, `${c.q >= 0 ? '+' : '−'}${Math.abs(c.q).toPrecision(3)} µC`, c.q >= 0 ? '#ff9a90' : '#8db8ff');
      }
    }
    if (o.probe.on && this._probeRes && o.view.measure) {
      const r = this._probeRes, xy = proj(r.position);
      if (xy) {
        const E = P.fmtSI(r.Emag, 'V/m', 3), phi = P.fmtSI(r.phi, 'V', 3);
        this._label(1, xy[0], xy[1] + 22, o.field === 'E' ? `|E| ${E}` : `|B| ${P.fmtSI(r.Bmag, 'T', 3)}`, '#ffffff');
        this._label(2, xy[0], xy[1] + 42, `φ ${phi}`, '#ffffff');
      }
      if (this._measureTarget) {
        const m = this._measureTarget, mid = P.mul(P.add(r.position, m.s), 0.5), xm = proj(mid);
        if (xm) this._label(3, xm[0], xm[1] - 10, `d = ${P.fmtSI(m.d * o.lengthScale, 'm', 3)}`, '#ffd23f');
      }
    }
    // sync DOM pool
    while (this._labelPool.length < list.length) {
      const d = document.createElement('div');
      d.style.cssText = 'position:absolute;transform:translate(-50%,-50%);font:12px ui-monospace,Menlo,Consolas,monospace;padding:2px 6px;border-radius:4px;background:rgba(10,14,20,.72);white-space:nowrap;will-change:left,top';
      this._labelRoot.appendChild(d);
      this._labelPool.push(d);
    }
    this._labelPool.forEach((d, i) => {
      const L = list[i];
      if (!L) { d.style.display = 'none'; return; }
      d.style.display = 'block'; d.style.left = L.x.toFixed(1) + 'px'; d.style.top = L.y.toFixed(1) + 'px';
      d.textContent = L.text; d.style.color = L.color || '#e8eef7';
    });
  }
}

export { PRESETS, P as physics };
