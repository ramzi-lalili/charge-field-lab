/**
 * presets.js — ready-made scenes. Charges use the same options as
 * physics.createCharge (q in µC, lengths in scene units, ω in rad per L/c).
 * `options` is merged into the viewer options; `camera` sets the view.
 */
const ring = (n, R, omega, q = 1) =>
  Array.from({ length: n }, (_, k) => ({
    q, type: 'circular', position: [0, 0, 0], axis: [0, 0, 1], amplitude: R, omega, phase0: (2 * Math.PI * k) / n,
  }));

export const PRESETS = [
  {
    id: 'dipole', name: 'Electric dipole',
    description: 'Two opposite charges. Field lines leave the + charge and end on the − charge.',
    charges: [
      { q: 1, position: [0, 0, 1.2] },
      { q: -1, position: [0, 0, -1.2] },
    ],
    options: { field: 'E', model: 'static', slice: { axis: 'y', offset: 0 }, arrows: { mode: 'slice' } },
    camera: { position: [9, -11, 6], target: [0, 0, 0] },
  },
  {
    id: 'single', name: 'Point charge',
    description: 'A single +1 µC charge. E falls as 1/r²; contours of φ are spheres.',
    charges: [{ q: 1, position: [0, 0, 0] }],
    options: { field: 'E', model: 'static', slice: { axis: 'y', offset: 0 }, arrows: { mode: 'volume', n: 9 } },
    camera: { position: [9, -11, 6], target: [0, 0, 0] },
  },
  {
    id: 'like', name: 'Like charges',
    description: 'Two equal charges repel; a saddle point sits halfway between them.',
    charges: [{ q: 1, position: [-1.6, 0, 0] }, { q: 1, position: [1.6, 0, 0] }],
    options: { field: 'E', model: 'static', slice: { axis: 'y', offset: 0 } },
    camera: { position: [0, -13, 5], target: [0, 0, 0] },
  },
  {
    id: 'quad', name: 'Linear quadrupole',
    description: 'Charges +1, −2, +1 on an axis. Field falls as 1/r⁴ on axis.',
    charges: [{ q: 1, position: [0, 0, 1.5] }, { q: -2, position: [0, 0, 0] }, { q: 1, position: [0, 0, -1.5] }],
    options: { field: 'E', model: 'static', slice: { axis: 'y', offset: 0 } },
    camera: { position: [9, -11, 5], target: [0, 0, 0] },
  },
  {
    id: 'capacitor', name: 'Plate capacitor (2×2 charges)',
    description: 'Four + charges above four − charges: nearly uniform field between the plates.',
    charges: [
      ...[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([x, y]) => ({ q: 1, position: [x, y, 1.4] })),
      ...[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([x, y]) => ({ q: -1, position: [x, y, -1.4] })),
    ],
    options: { field: 'E', model: 'static', slice: { axis: 'y', offset: 0 }, lines: { count: 16 } },
    camera: { position: [9, -10, 4], target: [0, 0, 0] },
  },
  {
    id: 'moving', name: 'Moving charge (Biot–Savart)',
    description: 'Charge at β = 0.05 along +x. B circles the velocity axis (B = β × E / c). Quasi-static model.',
    charges: [{ q: 1, type: 'linear', position: [-3, 0, 0], beta: [0.05, 0, 0] }],
    options: { field: 'B', model: 'static', timeScale: 6, slice: { axis: 'x', offset: 0 }, arrows: { mode: 'volume', n: 9 } },
    camera: { position: [4, -11, 7], target: [0, 0, 0] },
  },
  {
    id: 'relativistic', name: 'Relativistic charge (β = 0.95)',
    description: 'Liénard–Wiechert field of a uniformly moving charge: Lorentz-flattened into a pancake ⟂ velocity.',
    charges: [{ q: 1, type: 'linear', position: [-3.5, 0, 0], beta: [0.95, 0, 0] }],
    options: { field: 'E', model: 'lw', timeScale: 0.7, slice: { axis: 'y', offset: 0 }, lines: { count: 40 } },
    camera: { position: [3, -12, 6], target: [0, 0, 0] },
  },
  {
    id: 'antenna', name: 'Oscillating dipole (radiation)',
    description: 'Two opposite charges oscillating in antiphase along z. Full Liénard–Wiechert field shows outgoing radiation.',
    charges: [
      { q: 1, type: 'oscillation', position: [0, 0, 0], axis: [0, 0, 1], amplitude: 0.5, omega: 1.3, phase0: 0 },
      { q: -1, type: 'oscillation', position: [0, 0, 0], axis: [0, 0, 1], amplitude: 0.5, omega: 1.3, phase0: Math.PI },
    ],
    options: { field: 'E', model: 'lw', timeScale: 1, slice: { axis: 'y', offset: 0, contours: false }, arrows: { on: false }, lines: { on: false } },
    camera: { position: [2, -13, 5], target: [0, 0, 0] },
  },
  {
    id: 'orbit', name: 'Orbiting charge (β = 0.68)',
    description: 'A charge in circular motion radiates a spiral wave pattern (synchrotron-like). Liénard–Wiechert model.',
    charges: [{ q: 1, type: 'circular', position: [0, 0, 0], axis: [0, 0, 1], amplitude: 1.5, omega: 0.45 }],
    options: { field: 'E', model: 'lw', timeScale: 1, slice: { axis: 'z', offset: 0, contours: false }, arrows: { on: false }, lines: { on: false } },
    camera: { position: [1, -4, 14], target: [0, 0, 0] },
  },
  {
    id: 'loop', name: 'Current loop (8 orbiting charges)',
    description: 'Eight charges on a ring act as a current loop. B shows the dipole pattern of a magnetic moment.',
    charges: ring(8, 1.6, 0.3, 0.5),
    options: { field: 'B', model: 'static', timeScale: 1, slice: { axis: 'y', offset: 0 }, lines: { count: 12 } },
    camera: { position: [8, -10, 5], target: [0, 0, 0] },
  },
];
