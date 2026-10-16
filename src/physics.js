/**
 * physics.js — CPU reference implementation of the field models.
 *
 * Dependency-free (plain [x,y,z] arrays) so it runs in the browser and in Node.
 * The GLSL kernels in shaders.js implement exactly the same equations; the
 * in-app test suite compares the two (GPU/CPU parity).
 *
 * UNITS
 *   Scene length unit L        : `lengthScale` metres per scene unit (UI setting)
 *   Scene time unit            : L / c   (so c = 1 everywhere inside this file)
 *   Velocity                   : β = v / c  (dimensionless)
 *   Acceleration               : dβ/dt in units of c / L  (= 1 / scene-time)
 *   Charge                     : normalised, 1.0 == Q0 = 1 µC
 *   Field values returned here : "normalised" — multiply by `physicalScale()`
 *                                factors to obtain V/m, T and V.
 *
 * MODELS
 *   'static' (quasi-static)  : Coulomb field at the charge's *present* position
 *                              + Biot–Savart  B = β × E  (valid for β ≪ 1).
 *   'lw'                     : full Liénard–Wiechert fields at the retarded time
 *                              (Jackson 14.14). Exact for any subluminal motion,
 *                              includes the radiation (acceleration) term.
 *
 * TRAJECTORIES (analytic worldlines, so the retarded time can be solved):
 *   static       s(t') = P
 *   linear       s(t') = P + β (t' − t)         P = present position
 *   circular     s(t') = C + R (e1 cosφ + e2 sinφ),  φ = φ_now − ω (t − t')
 *   oscillation  s(t') = C + R â sinφ
 */

export const MAX_CHARGES = 8;
export const K_COULOMB = 8.9875517923e9; // N m² / C²
export const C_LIGHT = 299792458; // m / s
export const Q0 = 1e-6; // normalised charge unit [C]
export const MU0_OVER_4PI = 1e-7; // T m / A (SI, pre-2019 exact value; Δ ≈ 5e-10 rel.)

/* ---------- tiny vector helpers (arrays) ---------- */
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const len = (a) => Math.hypot(a[0], a[1], a[2]);
export const norm = (a) => {
  const l = len(a);
  return l > 0 ? mul(a, 1 / l) : [0, 0, 0];
};

/** Physical conversion factors for a given length scale (metres per scene unit). */
export function physicalScale(lengthScale = 1) {
  const phi = (K_COULOMB * Q0) / lengthScale; // V per normalised potential
  const E = phi / lengthScale; // V/m per normalised field
  return { phi, E, B: E / C_LIGHT, lengthScale };
}

/* ---------- charge construction ---------- */

let _id = 1;
/**
 * Create a charge. `q` in µC. `position` is the CENTRE of the trajectory for
 * circular / oscillation motion, and the PRESENT position for static / linear.
 */
export function createCharge(opts = {}) {
  const c = {
    id: opts.id ?? _id++,
    q: opts.q ?? 1,
    position: [...(opts.position ?? [0, 0, 0])],
    type: opts.type ?? 'static', // static | linear | circular | oscillation
    beta: [...(opts.beta ?? [0, 0, 0])], // linear: velocity / c
    axis: [...(opts.axis ?? [0, 0, 1])], // circular: normal, oscillation: direction
    amplitude: opts.amplitude ?? 1, // radius / amplitude (scene units)
    omega: opts.omega ?? 0.6, // angular frequency (rad / scene-time)
    phase0: opts.phase0 ?? 0, // initial phase offset (rad)
    phase: opts.phase0 ?? 0, // current phase (advanced by stepCharge)
  };
  prepareCharge(c);
  return c;
}

/** Recompute derived basis vectors after changing axis/etc. */
export function prepareCharge(c) {
  const a = norm(c.axis);
  c.axis = len(a) ? a : [0, 0, 1];
  const t = Math.abs(c.axis[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  c.e1 = norm(cross(t, c.axis));
  c.e2 = cross(c.axis, c.e1);
  // keep β < 1 for orbital motion
  const bmax = c.amplitude * Math.abs(c.omega);
  if ((c.type === 'circular' || c.type === 'oscillation') && bmax > 0.995) {
    c.omega = (0.995 / Math.max(c.amplitude, 1e-9)) * Math.sign(c.omega || 1);
  }
  if (c.type === 'linear') {
    const b = len(c.beta);
    if (b > 0.995) c.beta = mul(c.beta, 0.995 / b);
  }
  return c;
}

/** Maximum |β| ever reached by the charge. */
export function maxBeta(c) {
  if (c.type === 'linear') return len(c.beta);
  if (c.type === 'circular' || c.type === 'oscillation') return c.amplitude * Math.abs(c.omega);
  return 0;
}

/** Advance the charge by dt scene-time units (phase and linear drift). */
export function stepCharge(c, dt) {
  if (c.type === 'linear') c.position = add(c.position, mul(c.beta, dt));
  else if (c.type === 'circular' || c.type === 'oscillation') c.phase += c.omega * dt;
}

/**
 * Worldline sample at retarded delay τ (time t − τ).
 * Returns position s, velocity β and acceleration dβ/dt.
 */
export function worldline(c, tau) {
  switch (c.type) {
    case 'linear':
      return { s: sub(c.position, mul(c.beta, tau)), b: c.beta, a: [0, 0, 0] };
    case 'circular': {
      const ph = c.phase - c.omega * tau;
      const cs = Math.cos(ph), sn = Math.sin(ph), R = c.amplitude, w = c.omega;
      const rad = add(mul(c.e1, cs), mul(c.e2, sn));
      const tan = add(mul(c.e1, -sn), mul(c.e2, cs));
      return {
        s: add(c.position, mul(rad, R)),
        b: mul(tan, R * w),
        a: mul(rad, -R * w * w),
      };
    }
    case 'oscillation': {
      const ph = c.phase - c.omega * tau;
      const R = c.amplitude, w = c.omega;
      return {
        s: add(c.position, mul(c.axis, R * Math.sin(ph))),
        b: mul(c.axis, R * w * Math.cos(ph)),
        a: mul(c.axis, -R * w * w * Math.sin(ph)),
      };
    }
    default:
      return { s: c.position, b: [0, 0, 0], a: [0, 0, 0] };
  }
}

/**
 * Solve the retardation condition  τ = |r − s(t − τ)|  (c = 1).
 * Closed form for static/linear; bracketed (safeguarded) Newton otherwise.
 */
export function retardedDelay(c, r) {
  if (c.type === 'static') return len(sub(r, c.position));
  if (c.type === 'linear') {
    const d = sub(r, c.position);
    const b = c.beta;
    const b2 = dot(b, b), db = dot(d, b), dd = dot(d, d);
    const g = 1 - b2;
    return (db + Math.sqrt(db * db + g * dd)) / g;
  }
  const w0 = worldline(c, 0);
  const R0 = len(sub(r, w0.s));
  const bmax = Math.min(maxBeta(c), 0.9995);
  let lo = 0;
  let hi = (R0 + 1e-12) / (1 - bmax) + 1e-9;
  let tau = R0;
  for (let i = 0; i < 60; i++) {
    const w = worldline(c, tau);
    const d = sub(r, w.s);
    const R = len(d);
    const f = tau - R;
    if (f < 0) lo = tau; else hi = tau;
    if (Math.abs(f) < 1e-13 * (1 + tau)) break;
    const fp = 1 - (R > 0 ? dot(d, w.b) / R : 0);
    let next = tau - f / fp;
    if (!(next > lo && next < hi)) next = 0.5 * (lo + hi);
    tau = next;
  }
  return tau;
}

/* ---------- field kernels (normalised units) ---------- */

const EPS = 1e-6;

/** Quasi-static field of one charge at point r: Coulomb + B = β×E. */
export function fieldQuasiStatic1(c, r) {
  const w = worldline(c, 0);
  const d = sub(r, w.s);
  const R = len(d);
  if (R < EPS) return { E: [0, 0, 0], B: [0, 0, 0], phi: 0, singular: true };
  const E = mul(d, c.q / (R * R * R));
  return { E, B: cross(w.b, E), phi: c.q / R };
}

/** Full Liénard–Wiechert field of one charge at point r (present time). */
export function fieldLW1(c, r) {
  const tau = retardedDelay(c, r);
  const w = worldline(c, tau);
  const d = sub(r, w.s);
  const R = len(d);
  if (R < EPS) return { E: [0, 0, 0], B: [0, 0, 0], phi: 0, singular: true };
  const n = mul(d, 1 / R);
  const b = w.b;
  const kappa = 1 - dot(n, b);
  const g2inv = 1 - dot(b, b); // 1/γ²
  const nb = sub(n, b);
  const k3 = kappa * kappa * kappa;
  const vel = mul(nb, g2inv / (k3 * R * R));
  const rad = mul(cross(n, cross(nb, w.a)), 1 / (k3 * R));
  const E = mul(add(vel, rad), c.q);
  return { E, B: cross(n, E), phi: c.q / (kappa * R) };
}

/**
 * Total field at r.
 * @param {object[]} charges
 * @param {number[]} r   position [x,y,z]
 * @param {'static'|'lw'} model
 * @returns {{E:number[],B:number[],phi:number}} normalised units
 */
export function fieldAt(charges, r, model = 'static') {
  let E = [0, 0, 0], B = [0, 0, 0], phi = 0;
  const f = model === 'lw' ? fieldLW1 : fieldQuasiStatic1;
  for (const c of charges) {
    const o = f(c, r);
    E = add(E, o.E);
    B = add(B, o.B);
    phi += o.phi;
  }
  return { E, B, phi };
}

/** Convert normalised field values to SI. */
export function toSI(field, lengthScale = 1) {
  const s = physicalScale(lengthScale);
  return { E: mul(field.E, s.E), B: mul(field.B, s.B), phi: field.phi * s.phi };
}

/** Format a number with an SI prefix: fmtSI(0.00123,'V/m') -> "1.23 mV/m". */
export function fmtSI(x, unit = '', digits = 3) {
  if (!isFinite(x)) return '—';
  if (x === 0) return `0 ${unit}`;
  const pre = ['y', 'z', 'a', 'f', 'p', 'n', 'µ', 'm', '', 'k', 'M', 'G', 'T', 'P', 'E'];
  let e = Math.floor(Math.log10(Math.abs(x)) / 3);
  e = Math.max(-8, Math.min(6, e));
  const v = x / Math.pow(10, e * 3);
  return `${+v.toPrecision(digits)} ${pre[e + 8]}${unit}`;
}
