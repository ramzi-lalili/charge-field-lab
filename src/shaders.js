/**
 * shaders.js — GLSL (ES 3.00 via three.js ShaderMaterial) kernels.
 *
 * FIELD_GLSL is the GPU twin of physics.js: same worldlines, same retardation
 * solver, same Liénard–Wiechert / Biot–Savart equations (c = 1, normalised
 * charge units). The in-app test suite renders `PROBE_FRAG` into a float
 * target and compares it with the CPU reference to float32 precision.
 *
 * Porting to Unity / Unreal: FIELD_GLSL is ~90 lines of portable math with no
 * three.js specifics. Replace `uniform vec4 uX[MAXQ]` by cbuffer / material
 * parameter arrays and `mod`/`fract` by their HLSL equivalents.
 */

export const MAXQ = 8;

export const FIELD_GLSL = /* glsl */ `
#define MAXQ ${MAXQ}
uniform int   uN;              // number of charges
uniform int   uModel;          // 0 = quasi-static (Coulomb + Biot-Savart), 1 = Lienard-Wiechert
uniform vec4  uPosQ[MAXQ];     // xyz: centre / present position, w: charge (µC)
uniform vec4  uBetaT[MAXQ];    // xyz: beta (linear), w: type 0 static 1 linear 2 circular 3 oscillation
uniform vec4  uAxisA[MAXQ];    // xyz: axis, w: radius / amplitude
uniform vec4  uE1W[MAXQ];      // xyz: e1 (orbit basis), w: omega
uniform float uPh[MAXQ];       // present phase

void wl(int i, float tau, out vec3 s, out vec3 b, out vec3 a) {
  float ty = uBetaT[i].w;
  vec3 P = uPosQ[i].xyz;
  if (ty < 0.5) { s = P; b = vec3(0.0); a = vec3(0.0); return; }
  if (ty < 1.5) { b = uBetaT[i].xyz; s = P - b * tau; a = vec3(0.0); return; }
  vec3 ax = uAxisA[i].xyz; float R = uAxisA[i].w; vec3 e1 = uE1W[i].xyz; float w = uE1W[i].w;
  float ph = uPh[i] - w * tau;
  float cs = cos(ph), sn = sin(ph);
  if (ty < 2.5) {
    vec3 e2 = cross(ax, e1);
    vec3 rad = e1 * cs + e2 * sn;
    vec3 tg = e2 * cs - e1 * sn;
    s = P + R * rad; b = (R * w) * tg; a = (-R * w * w) * rad;
  } else {
    s = P + ax * (R * sn); b = ax * (R * w * cs); a = ax * (-R * w * w * sn);
  }
}

// retardation condition  tau = |r - s(t - tau)|
float retTau(int i, vec3 r) {
  float ty = uBetaT[i].w;
  vec3 P = uPosQ[i].xyz;
  if (ty < 0.5) return length(r - P);
  if (ty < 1.5) {
    vec3 d = r - P; vec3 b = uBetaT[i].xyz;
    float g = 1.0 - dot(b, b), db = dot(d, b), dd = dot(d, d);
    float S = sqrt(db * db + g * dd);
    return db >= 0.0 ? (db + S) / g : dd / max(S - db, 1e-12);
  }
  vec3 s, b, a;
  wl(i, 0.0, s, b, a);
  float R0 = length(r - s);
  float bmax = min(uAxisA[i].w * abs(uE1W[i].w), 0.9995);
  float lo = 0.0, hi = R0 / (1.0 - bmax) + 1e-6, tau = R0;
  for (int k = 0; k < 24; k++) {
    wl(i, tau, s, b, a);
    vec3 d = r - s; float R = length(d);
    float f = tau - R;
    if (f < 0.0) lo = tau; else hi = tau;
    float fp = 1.0 - dot(d, b) / max(R, 1e-6);
    float nx = tau - f / fp;
    if (!(nx > lo && nx < hi)) nx = 0.5 * (lo + hi);
    tau = nx;
  }
  return tau;
}

struct Fld { vec3 E; vec3 B; float phi; };

Fld fieldAt(vec3 r) {
  Fld f; f.E = vec3(0.0); f.B = vec3(0.0); f.phi = 0.0;
  for (int i = 0; i < MAXQ; i++) {
    if (i >= uN) break;
    float q = uPosQ[i].w;
    vec3 s, b, a;
    if (uModel == 0) {
      wl(i, 0.0, s, b, a);
      vec3 d = r - s; float R = max(length(d), 1e-4);
      vec3 E = d * (q / (R * R * R));
      f.E += E; f.B += cross(b, E); f.phi += q / R;
    } else {
      float tau = retTau(i, r);
      wl(i, tau, s, b, a);
      vec3 d = r - s; float R = max(length(d), 1e-4);
      vec3 n = d / R;
      float kap = max(1.0 - dot(n, b), 1e-4);
      float g2 = 1.0 - dot(b, b);
      vec3 nb = n - b;
      float k3 = kap * kap * kap;
      vec3 E = q * (nb * (g2 / (k3 * R * R)) + cross(n, cross(nb, a)) / (k3 * R));
      f.E += E; f.B += cross(n, E); f.phi += q / (kap * R);
    }
  }
  return f;
}

float phiAt(vec3 r) {
  float phi = 0.0;
  for (int i = 0; i < MAXQ; i++) {
    if (i >= uN) break;
    float q = uPosQ[i].w;
    vec3 s, b, a;
    if (uModel == 0) {
      wl(i, 0.0, s, b, a);
      phi += q / max(length(r - s), 1e-4);
    } else {
      float tau = retTau(i, r);
      wl(i, tau, s, b, a);
      vec3 d = r - s; float R = max(length(d), 1e-4);
      phi += q / (max(1.0 - dot(d / R, b), 1e-4) * R);
    }
  }
  return phi;
}

float nearestCharge(vec3 r) {
  float m = 1e9;
  for (int i = 0; i < MAXQ; i++) {
    if (i >= uN) break;
    vec3 s, b, a; wl(i, 0.0, s, b, a);
    m = min(m, length(r - s));
  }
  return m;
}
`;

/** Colour maps + magnitude normalisation shared by all visual layers. */
export const COLOR_GLSL = /* glsl */ `
uniform int   uField;      // 0 = E, 1 = B
uniform float uPhysE;      // V/m per normalised E
uniform float uPhysB;      // T per normalised B
uniform float uLo, uHi;    // log10 range of displayed magnitude (SI)
uniform int   uCmap;       // 0 turbo, 1 viridis

vec3 turbo(float x) {
  x = clamp(x, 0.0, 1.0);
  const vec4 kR = vec4(0.13572138, 4.61539260, -42.66032258, 132.13108234);
  const vec4 kG = vec4(0.09140261, 2.19418839, 4.84296658, -14.18503333);
  const vec4 kB = vec4(0.10667330, 12.64194608, -60.58204836, 110.36276771);
  const vec2 kR2 = vec2(-152.94239396, 59.28637943);
  const vec2 kG2 = vec2(4.27729857, 2.82956604);
  const vec2 kB2 = vec2(-89.90310912, 27.34824973);
  vec4 v4 = vec4(1.0, x, x * x, x * x * x);
  vec2 v2 = v4.zw * v4.z;
  return clamp(vec3(dot(v4, kR) + dot(v2, kR2), dot(v4, kG) + dot(v2, kG2), dot(v4, kB) + dot(v2, kB2)), 0.0, 1.0);
}
vec3 viridis(float t) {
  t = clamp(t, 0.0, 1.0);
  const vec3 c0 = vec3(0.2777273272234177, 0.005407344544966578, 0.3340998053353061);
  const vec3 c1 = vec3(0.1050930431085774, 1.404613529898575, 1.384590162594685);
  const vec3 c2 = vec3(-0.3308618287255563, 0.214847559468213, 0.09509516302823659);
  const vec3 c3 = vec3(-4.634230498983486, -5.799100973351585, -19.33244095627987);
  const vec3 c4 = vec3(6.228269936347081, 14.17993336680509, 56.69055260068105);
  const vec3 c5 = vec3(4.776384997670288, -13.74514537774601, -65.35303263337234);
  const vec3 c6 = vec3(-5.435455855934631, 4.645852612178535, 26.3124352495832);
  return clamp(c0 + t * (c1 + t * (c2 + t * (c3 + t * (c4 + t * (c5 + t * c6))))), 0.0, 1.0);
}
vec3 cmap(float t) { return uCmap == 0 ? turbo(t) : viridis(t); }

vec3  selVec(Fld f)  { return uField == 0 ? f.E * uPhysE : f.B * uPhysB; }   // SI
float logMag(vec3 v) { return log(max(length(v), 1e-30)) * 0.4342944819; }   // log10 |v|
float normMag(float lg) { return clamp((lg - uLo) / max(uHi - uLo, 1e-3), 0.0, 1.0); }
`;

/* ---------- vector arrows (instanced, field evaluated in the vertex shader) ---------- */
export const ARROW_VERT = /* glsl */ `
${FIELD_GLSL}
${COLOR_GLSL}
uniform int   uGridN;
uniform int   uGridMode;   // 0 volume, 1 slice
uniform int   uSliceAxis;
uniform float uSliceOff;
uniform float uH;          // half domain
uniform int   uLenMode;    // 0 unit, 1 log, 2 linear
uniform float uArrowScale;
varying vec3 vCol;
varying vec3 vN;

void main() {
  int id = gl_InstanceID;
  int N = uGridN;
  vec3 g;
  if (uGridMode == 0) {
    g = vec3(float(id % N), float((id / N) % N), float(id / (N * N)));
  } else {
    float i = float(id % N), j = float(id / N);
    g = uSliceAxis == 0 ? vec3(0.0, i, j) : (uSliceAxis == 1 ? vec3(i, 0.0, j) : vec3(i, j, 0.0));
  }
  float cell = 2.0 * uH / float(N);
  vec3 c = (g + 0.5) * cell - vec3(uH);
  if (uGridMode == 1) { if (uSliceAxis == 0) c.x = uSliceOff; else if (uSliceAxis == 1) c.y = uSliceOff; else c.z = uSliceOff; }
  Fld f = fieldAt(c);
  vec3 v = selVec(f);
  float lg = logMag(v);
  float t = normMag(lg);
  vec3 d = normalize(uField == 0 ? f.E : f.B);
  float L;
  if (uLenMode == 0) L = 0.85 * cell;
  else if (uLenMode == 1) L = cell * 1.15 * mix(0.2, 1.0, t);
  else L = cell * 1.15 * clamp(length(v) / pow(10.0, uHi), 0.04, 1.0);
  L *= uArrowScale;
  float thick = cell * 0.55 * uArrowScale;
  bool hide = !(length(v) > 0.0) || nearestCharge(c) < 0.18 * max(1.0, cell * 0.5) || lg < uLo - 1.5;
  vec3 u = normalize(cross(abs(d.z) < 0.99 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0), d));
  vec3 w = cross(d, u);
  mat3 Rm = mat3(d, u, w);
  vec3 p = vec3((position.x - 0.5) * L, position.y * thick, position.z * thick);
  vec3 world = c + Rm * p;
  vN = normalize(mat3(modelMatrix) * (Rm * normal));
  vCol = cmap(t);
  gl_Position = hide ? vec4(2.0, 2.0, 2.0, 1.0) : projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;
export const ARROW_FRAG = /* glsl */ `
varying vec3 vCol;
varying vec3 vN;
void main() {
  vec3 n = normalize(vN);
  vec3 l = normalize(vec3(0.4, 0.5, 0.8));
  float dif = 0.45 + 0.55 * max(dot(n, l), 0.0);
  gl_FragColor = vec4(vCol * dif, 1.0);
}
`;

/* ---------- slice plane: colour-mapped magnitude + potential contours ---------- */
export const SLICE_VERT = /* glsl */ `
varying vec3 vW;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;
export const SLICE_FRAG = /* glsl */ `
${FIELD_GLSL}
${COLOR_GLSL}
uniform float uOpacity;
uniform float uPhysPhi;
uniform int   uContours;
uniform float uContourDensity;
uniform vec3  uLineCol;
varying vec3 vW;
void main() {
  Fld f = fieldAt(vW);
  vec3 v = selVec(f);
  float lg = logMag(v);
  float t = normMag(lg);
  vec3 col = cmap(t);
  float a = uOpacity;
  if (uContours == 1) {
    float ph = f.phi * uPhysPhi;
    float s = log(max(abs(ph), 1e-30)) * 0.4342944819 * uContourDensity;
    float w = fwidth(s);
    float d = abs(fract(s - 0.5) - 0.5) / max(w, 1e-4);
    float ln = (1.0 - min(d, 1.0)) * (1.0 - smoothstep(0.2, 0.5, w));
    col = mix(col, uLineCol, ln * 0.85);
    a = max(a, ln * 0.9);
  }
  float near = nearestCharge(vW);
  a *= smoothstep(0.02, 0.12, near);
  gl_FragColor = vec4(col, a);
}
`;

/* ---------- equipotential surfaces: ray-marched through the domain box ---------- */
export const ISO_VERT = /* glsl */ `
varying vec2 vNdc;
void main() { vNdc = position.xy; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
export const ISO_FRAG = /* glsl */ `
${FIELD_GLSL}
uniform mat4 uInvProj;
uniform mat4 uCamWorld;
uniform mat4 uViewProj;
uniform float uH;
uniform int   uSteps;
uniform int   uLevelN;
uniform float uLevels[8];   // signed, normalised potential
uniform float uIsoAlpha;
varying vec2 vNdc;

vec3 isoGrad(vec3 p, float h) {
  return vec3(phiAt(p + vec3(h, 0, 0)) - phiAt(p - vec3(h, 0, 0)),
              phiAt(p + vec3(0, h, 0)) - phiAt(p - vec3(0, h, 0)),
              phiAt(p + vec3(0, 0, h)) - phiAt(p - vec3(0, 0, h)));
}

void main() {
  vec4 vp = uInvProj * vec4(vNdc, 1.0, 1.0);
  vec3 dv = normalize(vp.xyz / vp.w);
  vec3 rd = normalize(mat3(uCamWorld) * dv);
  vec3 ro = uCamWorld[3].xyz;
  vec3 inv = 1.0 / rd;
  vec3 t0 = (-vec3(uH) - ro) * inv, t1 = (vec3(uH) - ro) * inv;
  vec3 tmn = min(t0, t1), tmx = max(t0, t1);
  float tn = max(max(tmn.x, tmn.y), max(tmn.z, 0.0));
  float tf = min(min(tmx.x, tmx.y), tmx.z);
  if (tf <= tn) discard;
  float dt = (tf - tn) / float(uSteps);
  float tcur = tn + dt * fract(sin(dot(vNdc, vec2(12.9898, 78.233))) * 43758.5453) ; // jitter hides banding
  vec3 pp = ro + rd * tcur;
  float fp = phiAt(pp);
  vec3 acc = vec3(0.0); float aA = 0.0; float firstT = -1.0;
  for (int k = 0; k < 160; k++) {
    if (k >= uSteps) break;
    float tn2 = tcur + dt;
    vec3 pn = ro + rd * tn2;
    float fn = phiAt(pn);
    for (int j = 0; j < 8; j++) {
      if (j >= uLevelN) break;
      float L = uLevels[j];
      if ((fp > L) != (fn > L)) {
        float u = (L - fp) / (fn - fp);
        vec3 ph = mix(pp, pn, u);
        vec3 g = isoGrad(ph, 0.01 + 0.002 * tn2);
        vec3 n = normalize(g + 1e-12);
        if (dot(n, rd) > 0.0) n = -n;
        float dif = 0.35 + 0.65 * max(dot(n, normalize(vec3(0.4, 0.5, 0.8))), 0.0);
        float fres = pow(1.0 - max(dot(n, -rd), 0.0), 2.0);
        vec3 base = L > 0.0 ? vec3(1.0, 0.36, 0.28) : vec3(0.25, 0.55, 1.0);
        vec3 c = base * dif + fres * 0.35;
        float al = clamp(uIsoAlpha + fres * 0.25, 0.0, 0.95);
        acc += (1.0 - aA) * al * c;
        aA += (1.0 - aA) * al;
        if (firstT < 0.0) firstT = mix(tcur, tn2, u);
      }
    }
    if (aA > 0.97) break;
    tcur = tn2; pp = pn; fp = fn;
  }
  if (firstT < 0.0) discard;
  vec4 clip = uViewProj * vec4(ro + rd * firstT, 1.0);
  gl_FragDepth = clamp(clip.z / clip.w * 0.5 + 0.5, 0.0, 1.0);
  gl_FragColor = vec4(acc, aA);   // premultiplied
}
`;

/* ---------- GPGPU flow tracers ---------- */
export const PART_UPDATE_FRAG = /* glsl */ `
${FIELD_GLSL}
uniform sampler2D uPos;     // xyz position, w age
uniform float uDt;
uniform float uSpeed;
uniform float uLife;
uniform float uH;
uniform float uSeed;
uniform int   uField;
varying vec2 vUv;

float h11(float n) { return fract(sin(n) * 43758.5453123); }
vec3 rnd3(vec2 uv, float s) {
  float n = dot(uv, vec2(127.1, 311.7)) + s * 17.17;
  return vec3(h11(n), h11(n + 1.31), h11(n + 2.77));
}
vec3 dirAt(vec3 p) {
  Fld f = fieldAt(p);
  vec3 v = uField == 0 ? f.E : f.B;
  float l = length(v);
  return l > 0.0 ? v / l : vec3(0.0);
}
vec3 respawn(vec2 uv) {
  vec3 r = rnd3(uv, uSeed);
  int k = int(floor(r.x * float(max(uN, 1))));
  vec3 sp = vec3(0.0); float q = 1.0;
  for (int i = 0; i < MAXQ; i++) { if (i == k) { vec3 s, b, a; wl(i, 0.0, s, b, a); sp = s; q = uPosQ[i].w; } }
  vec3 r2 = rnd3(uv + 3.7, uSeed + 5.0);
  float cz = r2.x * 2.0 - 1.0, ph = r2.y * 6.2831853;
  vec3 dir = vec3(sqrt(1.0 - cz * cz) * cos(ph), sqrt(1.0 - cz * cz) * sin(ph), cz);
  if (uField == 0 && q > 0.0) return sp + dir * 0.22;
  vec3 r3 = rnd3(uv + 9.1, uSeed + 11.0);
  return (r3 * 2.0 - 1.0) * uH * 0.9;
}
void main() {
  vec4 s = texture2D(uPos, vUv);
  vec3 p = s.xyz; float age = s.w + uDt;
  bool dead = age > uLife || any(greaterThan(abs(p), vec3(uH))) || nearestCharge(p) < 0.12 || s.w < 0.0;
  if (dead) {
    float stagger = h11(dot(vUv, vec2(41.3, 17.9)) + uSeed) * uLife;
    p = respawn(vUv);
    age = (s.w < 0.0) ? stagger : 0.0;
  } else {
    float h = uSpeed * uDt;
    vec3 k1 = dirAt(p);
    vec3 k2 = dirAt(p + 0.5 * h * k1);
    p += h * k2;
  }
  gl_FragColor = vec4(p, age);
}
`;
export const PART_VERT = /* glsl */ `
${FIELD_GLSL}
${COLOR_GLSL}
uniform sampler2D uPos;
uniform float uLife;
uniform float uStreak;
uniform float uPx;
attribute vec3 aRef;       // xy: uv in texture, z: 0 head / 1 tail
varying vec4 vC;
void main() {
  vec4 s = texture2D(uPos, aRef.xy);
  vec3 p = s.xyz;
  Fld f = fieldAt(p);
  vec3 v = uField == 0 ? f.E : f.B;
  float l = length(v);
  vec3 d = l > 0.0 ? v / l : vec3(0.0);
  float t = normMag(logMag(selVec(f)));
  vec3 pos = p - d * uStreak * aRef.z;
  float fade = sin(3.14159265 * clamp(s.w / uLife, 0.0, 1.0));
  vC = vec4(cmap(t), fade * mix(0.9, 0.1, aRef.z));
  gl_Position = (s.w < 0.0) ? vec4(2.0, 2.0, 2.0, 1.0) : projectionMatrix * viewMatrix * vec4(pos, 1.0);
}
`;
export const PART_FRAG = /* glsl */ `
varying vec4 vC;
void main() { gl_FragColor = vC; }
`;

/* ---------- field lines (CPU-traced, animated dashes on the GPU) ---------- */
export const LINE_VERT = /* glsl */ `
attribute float aMag;   // normalised 0..1 colour coordinate
attribute float aS;     // arc length
uniform int uCmap;
uniform float uTime;
uniform float uFlow;
varying vec3 vCol;
varying float vS;
vec3 turbo2(float x) {
  x = clamp(x, 0.0, 1.0);
  const vec4 kR = vec4(0.13572138, 4.61539260, -42.66032258, 132.13108234);
  const vec4 kG = vec4(0.09140261, 2.19418839, 4.84296658, -14.18503333);
  const vec4 kB = vec4(0.10667330, 12.64194608, -60.58204836, 110.36276771);
  const vec2 kR2 = vec2(-152.94239396, 59.28637943);
  const vec2 kG2 = vec2(4.27729857, 2.82956604);
  const vec2 kB2 = vec2(-89.90310912, 27.34824973);
  vec4 v4 = vec4(1.0, x, x * x, x * x * x);
  vec2 v2 = v4.zw * v4.z;
  return clamp(vec3(dot(v4, kR) + dot(v2, kR2), dot(v4, kG) + dot(v2, kG2), dot(v4, kB) + dot(v2, kB2)), 0.0, 1.0);
}
vec3 vir2(float t) {
  t = clamp(t, 0.0, 1.0);
  const vec3 c0 = vec3(0.2777273272234177, 0.005407344544966578, 0.3340998053353061);
  const vec3 c1 = vec3(0.1050930431085774, 1.404613529898575, 1.384590162594685);
  const vec3 c2 = vec3(-0.3308618287255563, 0.214847559468213, 0.09509516302823659);
  const vec3 c3 = vec3(-4.634230498983486, -5.799100973351585, -19.33244095627987);
  const vec3 c4 = vec3(6.228269936347081, 14.17993336680509, 56.69055260068105);
  const vec3 c5 = vec3(4.776384997670288, -13.74514537774601, -65.35303263337234);
  const vec3 c6 = vec3(-5.435455855934631, 4.645852612178535, 26.3124352495832);
  return clamp(c0 + t * (c1 + t * (c2 + t * (c3 + t * (c4 + t * (c5 + t * c6))))), 0.0, 1.0);
}
void main() {
  vCol = uCmap == 0 ? turbo2(aMag) : vir2(aMag);
  vS = aS;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
export const LINE_FRAG = /* glsl */ `
uniform float uTime;
uniform float uFlow;
uniform float uLineAlpha;
uniform float uSolid;
uniform vec3 uSolidCol;
varying vec3 vCol;
varying float vS;
void main() {
  float dash = uFlow > 0.5 ? 0.5 + 0.5 * smoothstep(0.0, 0.6, fract(vS * 1.6 - uTime * 0.7)) : 1.0;
  gl_FragColor = vec4(uSolid > 0.5 ? uSolidCol : vCol, uLineAlpha * dash);
}
`;

/* ---------- probe pass used by GPU/CPU parity tests and fieldAtGPU() ---------- */
export const PROBE_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
export const PROBE_FRAG = /* glsl */ `
${FIELD_GLSL}
uniform sampler2D uPts;
uniform int uWhich;   // 0: E.xyz + phi in w, 1: B.xyz
varying vec2 vUv;
void main() {
  vec3 r = texture2D(uPts, vUv).xyz;
  Fld f = fieldAt(r);
  gl_FragColor = uWhich == 0 ? vec4(f.E, f.phi) : vec4(f.B, 0.0);
}
`;
