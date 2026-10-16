/**
 * gpu.tests.js — GPU/CPU parity. Evaluates the GLSL kernel (the same code that
 * draws arrows, slice, iso-surfaces and particles) at random points and
 * compares to the double-precision reference in physics.js.
 * Float32 on the GPU limits agreement to ≈1e-4 relative.
 */
import * as P from '../src/physics.js';

function lcg(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }

export function runGpuTests(viz) {
  const out = [];
  const saved = viz.getCharges();
  const run = (name, model, charges, tol) => {
    try {
      viz.setCharges(charges);
      viz.charges.forEach((c, i) => { if (charges[i].phase != null) c.phase = charges[i].phase; });
      const rnd = lcg(7);
      const pts = [];
      while (pts.length < 200) {
        const p = [(rnd() * 2 - 1) * 5, (rnd() * 2 - 1) * 5, (rnd() * 2 - 1) * 5];
        if (viz.charges.every((c) => P.len(P.sub(p, P.worldline(c, 0).s)) > 0.6)) pts.push(p);
      }
      const gpu = viz.fieldAtGPU(pts.map((p) => [...p, 1]), model);
      let wE = 0, wB = 0, wP = 0;
      pts.forEach((p, i) => {
        const cpu = P.fieldAt(viz.charges, p, model);
        wE = Math.max(wE, P.len(P.sub(gpu[i].E, cpu.E)) / (P.len(cpu.E) + 1e-9));
        wB = Math.max(wB, P.len(P.sub(gpu[i].B, cpu.B)) / (P.len(cpu.E) + 1e-9)); // B scaled by |E| (B may vanish)
        const sc = viz.charges.reduce((a, c) => a + Math.abs(c.q) / P.len(P.sub(p, P.worldline(c, 0).s)), 0); // cancellation-safe scale
        wP = Math.max(wP, Math.abs(gpu[i].phi - cpu.phi) / sc);
      });
      const ok = wE < tol && wB < tol && wP < tol;
      out.push({ name, pass: ok, detail: `worst rel.err E ${wE.toExponential(1)}, B ${wB.toExponential(1)}, φ ${wP.toExponential(1)} (tol ${tol})` });
    } catch (e) { out.push({ name, pass: false, detail: 'threw: ' + e.message }); }
  };
  run('GPU = CPU: static Coulomb + Biot–Savart (3 charges, 200 points)', 'static', [
    { q: 1, position: [1, 0, 0.5] }, { q: -2, position: [-1.5, 1, 0], type: 'linear', beta: [0.1, 0.2, 0] }, { q: 0.5, position: [0, -2, 1] }], 3e-4);
  run('GPU = CPU: Liénard–Wiechert, uniform motion β = 0.9', 'lw', [{ q: 1, type: 'linear', position: [0.3, 0, 0], beta: [0.9, 0, 0] }], 1e-3);
  run('GPU = CPU: Liénard–Wiechert, circular orbit β = 0.75', 'lw', [{ q: 1, type: 'circular', position: [0, 0, 0], amplitude: 1.5, omega: 0.5, axis: [0.2, 0.1, 1], phase: 1.7 }], 3e-3);
  run('GPU = CPU: Liénard–Wiechert, oscillating dipole', 'lw', [
    { q: 1, type: 'oscillation', position: [0, 0, 0], amplitude: 0.5, omega: 1.3, phase: 0.4 },
    { q: -1, type: 'oscillation', position: [0, 0, 0], amplitude: 0.5, omega: 1.3, phase: 0.4 + Math.PI }], 3e-3);
  viz.setCharges(saved);
  return out;
}
