# Charge Field Lab

Interactive 3D demo of the electric and magnetic fields of point charges:
Coulomb + Biot-Savart (quasi-static) and full Lienard-Wiechert (retarded, with radiation).
Field lines, vector arrows, magnitude slice, equipotential surfaces, GPU flow tracers,
probe readouts, screenshots and WebM recording.

## Run locally

Browsers block ES modules on `file://`, so serve the folder over HTTP (internet needed once for three.js from the CDN):

    npm start                 # or: python3 -m http.server 8080
    # open http://localhost:8080

## Tests

    npm test                  # 19 analytic physics checks, Node 18+, no dependencies

In the app, Tools -> "Run all tests" also runs 4 GPU-vs-CPU parity checks.

## Layout

    index.html            UI shell and styles
    src/physics.js        CPU reference physics (no dependencies)
    src/shaders.js        GLSL kernels (same equations as physics.js)
    src/viz.js            ChargeFieldViz class: embeddable viewer API
    src/presets.js        Example scenes
    src/main.js           Controls wired to the viewer API
    tests/                Physics and GPU tests

## Embedding

    import { ChargeFieldViz } from './src/viz.js';
    const viz = new ChargeFieldViz(document.querySelector('#host'), { model: 'lw' });
    viz.addCharge({ q: 1, position: [0, 0, 1] });
    viz.on('probe', ({ E, B, phi }) => console.log(E, B, phi));

The page needs the import map from `index.html` (three@0.160.0 from jsDelivr).
For offline use run `npm i three@0.160.0` and point the import map at `node_modules/three/...`.

## Unity / Unreal

`FIELD_GLSL` in `src/shaders.js` is self-contained; port it to HLSL.
`physics.js` gives reference values for unit tests.

## Publish on GitHub Pages

Settings -> Pages -> Deploy from branch `main`, folder `/ (root)`.
