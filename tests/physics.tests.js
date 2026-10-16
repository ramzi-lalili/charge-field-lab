/**
 * physics.tests.js — validation of the field models against analytic results.
 * Shared by `node tests/run.mjs` and the in-app “Run tests” button.
 * Each test returns {name, pass, detail}.
 */
import * as P from '../src/physics.js';

const rel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-300);
const vrel = (a, b) => P.len(P.sub(a, b)) / Math.max(P.len(b), 1e-300);

function fibSphere(n) {
  const out = [];
  const ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n, r = Math.sqrt(1 - y * y), th = ga * i;
    out.push([Math.cos(th) * r, y, Math.sin(th) * r]);
  }
  return out;
}

const T = [];
const test = (name, fn) => {
  try {
    const r = fn();
    T.push({ name, pass: r.ok, detail: r.detail });
  } catch (e) {
    T.push({ name, pass: false, detail: 'threw: ' + e.message });
  }
};
const fmt = (x) => (x < 1e-3 && x !== 0 ? x.toExponential(2) : x.toPrecision(4));

export function runPhysicsTests() {
  T.length = 0;
  const k = P.K_COULOMB * P.Q0;

  test('Coulomb: |E| = kq/r² (1 µC, r = 3 m → 998.6 V/m)', () => {
    const c = P.createCharge({ q: 1, position: [0, 0, 0] });
    const f = P.toSI(P.fieldAt([c], [3, 0, 0], 'static'), 1);
    const exp = k / 9;
    const e = rel(P.len(f.E), exp);
    return { ok: e < 1e-12 && f.E[0] > 0, detail: `got ${fmt(P.len(f.E))} V/m, exp ${fmt(exp)} (rel.err ${fmt(e)})` };
  });

  test('Potential: φ = kq/r (1 µC at 2 m → 4.494 kV)', () => {
    const c = P.createCharge({ q: 1 });
    const f = P.toSI(P.fieldAt([c], [0, 2, 0], 'static'), 1);
    const e = rel(f.phi, k / 2);
    return { ok: e < 1e-12, detail: `got ${fmt(f.phi)} V, exp ${fmt(k / 2)} (rel.err ${fmt(e)})` };
  });

  test('Sign: negative charge reverses E and φ', () => {
    const c = P.createCharge({ q: -2 });
    const f = P.fieldAt([c], [1, 1, 0], 'static');
    return { ok: f.E[0] < 0 && f.E[1] < 0 && f.phi < 0, detail: `E=(${f.E.map(fmt)}) φ=${fmt(f.phi)}` };
  });

  test('Scale: E ∝ 1/L² and φ ∝ 1/L when scene unit changes', () => {
    const c = P.createCharge({ q: 1 });
    const a = P.toSI(P.fieldAt([c], [1, 0, 0]), 1), b = P.toSI(P.fieldAt([c], [1, 0, 0]), 1e-3);
    const e1 = rel(b.E[0] / a.E[0], 1e6), e2 = rel(b.phi / a.phi, 1e3);
    return { ok: e1 < 1e-12 && e2 < 1e-12, detail: `E ratio err ${fmt(e1)}, φ ratio err ${fmt(e2)}` };
  });

  test('Dipole on axis: E = kq[1/(z−a)² − 1/(z+a)²]', () => {
    const a = 0.5, z = 3;
    const cs = [P.createCharge({ q: 1, position: [0, 0, a] }), P.createCharge({ q: -1, position: [0, 0, -a] })];
    const f = P.toSI(P.fieldAt(cs, [0, 0, z]), 1);
    const exp = k * (1 / (z - a) ** 2 - 1 / (z + a) ** 2);
    const e = rel(f.E[2], exp);
    return { ok: e < 1e-12, detail: `got ${fmt(f.E[2])}, exp ${fmt(exp)} (rel.err ${fmt(e)})` };
  });

  test("Gauss's law: flux through sphere = q/ε₀ (enclosed) and 0 (outside)", () => {
    const eps0 = 1 / (4 * Math.PI * P.K_COULOMB);
    const pts = fibSphere(4000);
    const flux = (centre, R, cs) => {
      let s = 0;
      for (const n of pts) {
        const r = P.add(centre, P.mul(n, R));
        s += P.dot(P.toSI(P.fieldAt(cs, r), 1).E, n);
      }
      return (s * 4 * Math.PI * R * R) / pts.length;
    };
    const c1 = P.createCharge({ q: 2, position: [0.4, -0.2, 0.3] });
    const inside = flux([0, 0, 0], 2, [c1]);
    const expIn = (2 * P.Q0) / eps0;
    const c2 = P.createCharge({ q: 2, position: [5, 0, 0] });
    const outside = flux([0, 0, 0], 2, [c2]);
    const e = rel(inside, expIn);
    return { ok: e < 2e-3 && Math.abs(outside) / expIn < 2e-3, detail: `inside ${fmt(inside)} vs ${fmt(expIn)} (err ${fmt(e)}); outside/q ε₀ = ${fmt(outside / expIn)}` };
  });

  test('Static: E = −∇φ (central differences, 3 charges)', () => {
    const cs = [
      P.createCharge({ q: 1, position: [1, 0, 0] }),
      P.createCharge({ q: -2, position: [-1, 0.5, 0] }),
      P.createCharge({ q: 0.5, position: [0, -1, 1] }),
    ];
    const r = [0.3, 0.2, -0.4], h = 1e-5;
    const g = [0, 1, 2].map((i) => {
      const a = [...r], b = [...r];
      a[i] += h; b[i] -= h;
      return -(P.fieldAt(cs, a).phi - P.fieldAt(cs, b).phi) / (2 * h);
    });
    const e = vrel(g, P.fieldAt(cs, r).E);
    return { ok: e < 1e-8, detail: `|−∇φ − E|/|E| = ${fmt(e)}` };
  });

  test('Superposition: LW(A+B) = LW(A) + LW(B)', () => {
    const A = P.createCharge({ q: 1, type: 'circular', position: [0, 0, 0], amplitude: 1, omega: 0.5, phase0: 0.3 });
    A.phase = 1.1;
    const B = P.createCharge({ q: -1.5, type: 'linear', position: [1, 1, 0], beta: [0.3, 0, 0.1] });
    const r = [2.2, -1.3, 0.7];
    const s = P.fieldAt([A, B], r, 'lw'), a = P.fieldAt([A], r, 'lw'), b = P.fieldAt([B], r, 'lw');
    const e = Math.max(vrel(s.E, P.add(a.E, b.E)), vrel(s.B, P.add(a.B, b.B)));
    return { ok: e < 1e-12, detail: `max rel.diff ${fmt(e)}` };
  });

  test('Retardation: τ = |r − s(t−τ)| to 1e-9 on a β = 0.8 orbit (200 points)', () => {
    const c = P.createCharge({ q: 1, type: 'circular', amplitude: 1, omega: 0.8 });
    c.phase = 0.7;
    let worst = 0;
    for (let i = 0; i < 200; i++) {
      const r = [Math.sin(i * 12.9898) * 6, Math.sin(i * 78.233) * 6, Math.sin(i * 37.719) * 6];
      const tau = P.retardedDelay(c, r);
      const res = Math.abs(tau - P.len(P.sub(r, P.worldline(c, tau).s)));
      worst = Math.max(worst, res);
    }
    return { ok: worst < 1e-9, detail: `worst residual ${fmt(worst)}` };
  });

  test('LW, uniform motion β = 0.6 → Heaviside field E = q(1−β²)R / [R³(1−β²sin²θ)^{3/2}]', () => {
    const beta = [0.6, 0, 0];
    const c = P.createCharge({ q: 1.3, type: 'linear', position: [0.5, 0.2, -0.1], beta });
    let worst = 0;
    for (const r of [[3, 1, 0.5], [-2, 2, 1], [0.5, 3, 0], [4, -1, 2]]) {
      const R = P.sub(r, c.position), Rl = P.len(R);
      const sin2 = 1 - P.dot(R, beta) ** 2 / (P.dot(beta, beta) * Rl * Rl);
      const g = 1 - P.dot(beta, beta);
      const exp = P.mul(R, (1.3 * g) / (Rl ** 3 * (1 - P.dot(beta, beta) * sin2) ** 1.5));
      const f = P.fieldAt([c], r, 'lw');
      worst = Math.max(worst, vrel(f.E, exp));
    }
    return { ok: worst < 1e-12, detail: `worst rel.err ${fmt(worst)}` };
  });

  test('LW, uniform motion: B = β × E exactly', () => {
    const c = P.createCharge({ q: 1, type: 'linear', position: [0, 0, 0], beta: [0.2, 0.5, -0.3] });
    const f = P.fieldAt([c], [2, 1, 1.5], 'lw');
    const e = vrel(f.B, P.cross(c.beta, f.E));
    return { ok: e < 1e-12, detail: `rel.err ${fmt(e)}` };
  });

  test('LW → Coulomb as β → 0', () => {
    const c = P.createCharge({ q: 1, type: 'linear', position: [0, 0, 0], beta: [1e-5, 0, 0] });
    const r = [1.5, 2, -1];
    const e = vrel(P.fieldAt([c], r, 'lw').E, P.fieldAt([c], r, 'static').E);
    return { ok: e < 1e-4, detail: `rel.diff ${fmt(e)}` };
  });

  test('Biot–Savart (SI): B = μ₀/4π · q v / r² (1 µC, v = 0.01c, r = 2 m)', () => {
    const c = P.createCharge({ q: 1, type: 'linear', position: [0, 0, 0], beta: [0.01, 0, 0] });
    const f = P.toSI(P.fieldAt([c], [0, 2, 0], 'static'), 1);
    const exp = P.MU0_OVER_4PI * 1e-6 * 0.01 * P.C_LIGHT / 4;
    const e = rel(P.len(f.B), exp);
    return { ok: e < 1e-3 && Math.abs(f.B[2]) > 0, detail: `got ${fmt(P.len(f.B))} T, exp ${fmt(exp)} (rel.err ${fmt(e)}; k/c² vs μ₀/4π)` };
  });

  test('Biot–Savart direction: B ∥ v × r̂ (right-hand rule)', () => {
    const c = P.createCharge({ q: 1, type: 'linear', position: [0, 0, 0], beta: [0.1, 0, 0] });
    const f = P.fieldAt([c], [0, 1, 0], 'static'); // x̂ × ŷ = +ẑ
    return { ok: f.B[2] > 0 && Math.abs(f.B[0]) < 1e-15 && Math.abs(f.B[1]) < 1e-15, detail: `B=(${f.B.map(fmt)})` };
  });

  test('LW radiation: far-zone amplitude |E⊥| = q ω² A sinθ / R (dipole, R = 200)', () => {
    const A = 0.1, w = 0.5, R = 200;
    const c = P.createCharge({ q: 1, type: 'oscillation', position: [0, 0, 0], axis: [0, 0, 1], amplitude: A, omega: w });
    let peak = 0;
    for (let i = 0; i < 64; i++) {
      c.phase = (i / 64) * 2 * Math.PI;
      peak = Math.max(peak, Math.abs(P.fieldAt([c], [R, 0, 0], 'lw').E[2]));
    }
    const exp = (A * w * w) / R;
    const e = rel(peak, exp);
    return { ok: e < 0.03, detail: `peak ${fmt(peak)}, Larmor-field ${fmt(exp)} (rel.err ${fmt(e)})` };
  });

  test('LW radiation: transverse (E ⊥ n̂ , |B| = |E|) in the far zone (R = 3·10⁴ ≫ λ)', () => {
    const c = P.createCharge({ q: 1, type: 'oscillation', amplitude: 0.1, omega: 0.5 });
    c.phase = 0.9;
    const r = P.mul(P.norm([1, 0.4, 0.5]), 30000);
    const f = P.fieldAt([c], r, 'lw');
    const radial = Math.abs(P.dot(f.E, P.norm(r))) / P.len(f.E);
    const eb = rel(P.len(f.B), P.len(f.E));
    return { ok: radial < 5e-3 && eb < 5e-3, detail: `E·n̂/|E| = ${fmt(radial)}, |B|/|E|−1 = ${fmt(eb)}` };
  });

  test('LW: ∇·E = 0 and ∇·B = 0 away from an orbiting charge (β = 0.7)', () => {
    const c = P.createCharge({ q: 1, type: 'circular', amplitude: 1, omega: 0.7 });
    c.phase = 0.4;
    const r = [2.1, -1.4, 0.9], h = 1e-4;
    let dE = 0, dB = 0, ref = 0;
    for (let i = 0; i < 3; i++) {
      const a = [...r], b = [...r];
      a[i] += h; b[i] -= h;
      const fa = P.fieldAt([c], a, 'lw'), fb = P.fieldAt([c], b, 'lw');
      dE += (fa.E[i] - fb.E[i]) / (2 * h);
      dB += (fa.B[i] - fb.B[i]) / (2 * h);
    }
    ref = P.len(P.fieldAt([c], r, 'lw').E);
    return { ok: Math.abs(dE) / ref < 1e-6 && Math.abs(dB) / ref < 1e-6, detail: `∇·E/|E| = ${fmt(dE / ref)}, ∇·B/|E| = ${fmt(dB / ref)}` };
  });

  test('LW: Faraday ∇×E = −∂B/∂t on an accelerating charge (β = 0.7 orbit)', () => {
    const base = P.createCharge({ q: 1, type: 'circular', amplitude: 1, omega: 0.7 });
    base.phase = 0.4;
    const r = [2.1, -1.4, 0.9], h = 1e-4, dt = 1e-4;
    const E = (rr) => P.fieldAt([base], rr, 'lw').E;
    const curl = [0, 0, 0];
    const d = (comp, axis) => {
      const a = [...r], b = [...r];
      a[axis] += h; b[axis] -= h;
      return (E(a)[comp] - E(b)[comp]) / (2 * h);
    };
    curl[0] = d(2, 1) - d(1, 2);
    curl[1] = d(0, 2) - d(2, 0);
    curl[2] = d(1, 0) - d(0, 1);
    const adv = (s) => { const c = { ...base, phase: base.phase + s * base.omega * dt }; return P.fieldAt([c], r, 'lw').B; };
    const dBdt = P.mul(P.sub(adv(1), adv(-1)), 1 / (2 * dt));
    const e = vrel(curl, P.mul(dBdt, -1));
    return { ok: e < 1e-5, detail: `|∇×E + ∂B/∂t| / |∂B/∂t| = ${fmt(e)}` };
  });

  test('LW: Ampère–Maxwell ∇×B = ∂E/∂t on the same orbit', () => {
    const base = P.createCharge({ q: 1, type: 'circular', amplitude: 1, omega: 0.7 });
    base.phase = 1.3;
    const r = [-1.8, 1.2, 0.6], h = 1e-4, dt = 1e-4;
    const B = (rr) => P.fieldAt([base], rr, 'lw').B;
    const d = (comp, axis) => {
      const a = [...r], b = [...r];
      a[axis] += h; b[axis] -= h;
      return (B(a)[comp] - B(b)[comp]) / (2 * h);
    };
    const curl = [d(2, 1) - d(1, 2), d(0, 2) - d(2, 0), d(1, 0) - d(0, 1)];
    const adv = (s) => { const c = { ...base, phase: base.phase + s * base.omega * dt }; return P.fieldAt([c], r, 'lw').E; };
    const dEdt = P.mul(P.sub(adv(1), adv(-1)), 1 / (2 * dt));
    const e = vrel(curl, dEdt);
    return { ok: e < 1e-5, detail: `|∇×B − ∂E/∂t| / |∂E/∂t| = ${fmt(e)}` };
  });

  return T.slice();
}
