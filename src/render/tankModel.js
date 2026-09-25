// Tank models for Steel Front. The armour hull and turret are built from the same convex solids
// the sim shoots at (src/sim/armor.js → solidFaces), then dressed with running gear, tools,
// hatches, a tapered barrel and nation paint/markings.
//
//   buildTankModel(def, { paint, lod, gunIndex, number }) → {
//     group, parts: { hull, turret, gun, mantlet, trackL, trackR, wheelsL, wheelsR, yaw, body },
//     info: { exhausts, trackRear, trackFront, engine, top, recoil, muzzleLen },
//     update(state, dt), setDamage({ tracks, burning, dead, ammorack }), setOpacity(a), dispose() }
//
// One shader (MeshStandardMaterial + onBeforeCompile) draws every tank surface. Per-vertex
// attributes pick the look: aSurf = (metalness, roughness, paint mask, edge 0..1), aExt = (dirt,
// kind, wheel centre y|track pitch, wheel centre z), aSpin = 1/r for wheels that roll. Paint
// colour, camo and "charred" live in the material, so geometry is cached per (def, lod, gun) and
// shared by every instance; materials are shared per paint scheme. The only per-instance
// materials are the two running-gear clones (they carry uTravel for wheel spin and track scroll)
// and they share the compiled program.
import * as THREE from 'three';
import { buildArmor, solidFaces } from '../sim/armor.js';

const DEG = Math.PI / 180;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lin = (hex) => new THREE.Color(hex); // three converts sRGB hex → linear

// ------------------------------------------------------------------ paint schemes
export const PAINTS = {
  olive: { base: 0x4f5334 },                                   // US Olive Drab No.9
  dunkelgelb: { base: 0xa8935f },                              // RAL 7028
  dunkelgelb_camo: { base: 0xa8935f, camoA: 0x4a5431, camoB: 0x6a4330 }, // + Olivgrün / Rotbraun
  grey: { base: 0x575c5c },                                    // Panzergrau
  '4bo': { base: 0x48532f },                                   // Soviet 4BO green
  winter: { base: 0xd6d6cc },
};
const NATION_PAINT = { usa: 'olive', germany: 'dunkelgelb', ussr: '4bo' };
function resolvePaint(def, paint) {
  if (paint && typeof paint === 'object') return { base: paint.base ?? paint.color ?? 0x55583a, camoA: paint.camoA, camoB: paint.camoB };
  if (typeof paint === 'number') return { base: paint };
  if (typeof paint === 'string' && PAINTS[paint]) return PAINTS[paint];
  if (typeof paint === 'string' && paint[0] === '#') return { base: parseInt(paint.slice(1), 16) };
  let key = NATION_PAINT[def.nation] || 'olive';
  if (def.nation === 'germany' && (def.look?.camo ?? def.tier >= 5)) key = 'dunkelgelb_camo';
  if (def.nation === 'germany' && def.look?.camo === false) key = 'dunkelgelb';
  if (def.look?.paint && PAINTS[def.look.paint]) key = def.look.paint;
  return PAINTS[key];
}

// ------------------------------------------------------------------ canvas textures
let _decalTex = null, _trackTex = null;
function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function star(g, cx, cy, R, r) {
  g.beginPath();
  for (let k = 0; k < 10; k++) {
    const a = -Math.PI / 2 + k * Math.PI / 5, rr = k % 2 ? r : R;
    g.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
  }
  g.closePath();
}
// Atlas (1024×512, flipY): row 0 = four 256² emblems, row 1 = two slogans (512×128),
// rows 2/3 = digits 0-9 (64×64) white stencil / German red-outlined.
const ATLAS = {
  usStar: [0, 0, 256, 256], cross: [256, 0, 256, 256], redStar: [512, 0, 256, 256], whiteStar: [768, 0, 256, 256],
  slogan0: [0, 256, 512, 128], slogan1: [512, 256, 512, 128],
  digitW: (d) => [d * 64, 384, 64, 64], digitG: (d) => [d * 64, 448, 64, 64],
};
function atlasUV(r) { const [x, y, w, h] = r; return [x / 1024, 1 - (y + h) / 512, (x + w) / 1024, 1 - y / 512]; }
function decalTexture() {
  if (_decalTex) return _decalTex;
  const c = canvas(1024, 512), g = c.getContext('2d');
  g.clearRect(0, 0, 1024, 512);
  // US: white star in a white ring
  g.fillStyle = '#e8e6dc'; star(g, 128, 132, 100, 40); g.fill();
  g.lineWidth = 14; g.strokeStyle = '#e8e6dc'; g.beginPath(); g.arc(128, 128, 116, 0, Math.PI * 2); g.stroke();
  // German Balkenkreuz: white outline, black centre
  const X = 384, Y = 128;
  g.fillStyle = '#e9e7df';
  g.fillRect(X - 40, Y - 110, 80, 220); g.fillRect(X - 110, Y - 40, 220, 80);
  g.fillStyle = '#111';
  g.fillRect(X - 22, Y - 92, 44, 184); g.fillRect(X - 92, Y - 22, 184, 44);
  g.clearRect(X - 110, Y - 110, 70, 70); g.clearRect(X + 40, Y - 110, 70, 70); g.clearRect(X - 110, Y + 40, 70, 70); g.clearRect(X + 40, Y + 40, 70, 70);
  // Soviet red star with a thin white border
  g.fillStyle = '#e9e5da'; star(g, 640, 134, 112, 46); g.fill();
  g.fillStyle = '#b3201b'; star(g, 640, 134, 96, 39); g.fill();
  // plain white star
  g.fillStyle = '#e8e6dc'; star(g, 896, 134, 110, 44); g.fill();
  // slogans, hand painted
  g.fillStyle = '#ecebe2'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.font = 'italic bold 72px "DejaVu Sans", Arial, sans-serif';
  g.fillText('ЗА РОДИНУ!', 256, 322, 470);
  g.fillText('ВПЕРЁД!', 768, 322, 470);
  // digits
  g.font = 'bold 58px "DejaVu Sans Mono", "Courier New", monospace';
  for (let d = 0; d < 10; d++) {
    g.fillStyle = '#ecebe2'; g.fillText(String(d), d * 64 + 32, 384 + 34);
    g.lineWidth = 8; g.strokeStyle = '#efeee6'; g.strokeText(String(d), d * 64 + 32, 448 + 34);
    g.fillStyle = '#a31d18'; g.fillText(String(d), d * 64 + 32, 448 + 34);
  }
  // scuff the paint a little so markings don't look like stickers
  const id = g.getImageData(0, 0, 1024, 512), p = id.data;
  for (let i = 0; i < p.length; i += 4) if (p[i + 3] > 0 && Math.random() < 0.035) p[i + 3] = 0;
  g.putImageData(id, 0, 0);
  _decalTex = new THREE.CanvasTexture(c);
  _decalTex.colorSpace = THREE.SRGBColorSpace; _decalTex.anisotropy = 4;
  return _decalTex;
}
// Track links: 4 columns of 128 px (US rubber chevron, German steel cleat, Soviet waffle, inner
// face) × one link (128 px). Luminance doubles as a bump height.
function trackTexture() {
  if (_trackTex) return _trackTex;
  const W = 512, H = 128, c = canvas(W, H), g = c.getContext('2d');
  const rnd = (() => { let s = 7; return () => ((s = (s * 16807) % 2147483647) / 2147483647); })();
  for (let v = 0; v < 4; v++) {
    const x0 = v * 128;
    g.fillStyle = '#26231f'; g.fillRect(x0, 0, 128, H);
    if (v === 0) { // rubber blocks with a chevron
      g.fillStyle = '#1b1a19'; g.fillRect(x0 + 4, 10, 120, 108);
      g.strokeStyle = '#34322e'; g.lineWidth = 16;
      g.beginPath(); g.moveTo(x0 + 10, 90); g.lineTo(x0 + 64, 40); g.lineTo(x0 + 118, 90); g.stroke();
      g.fillStyle = '#4a4640'; g.fillRect(x0, 0, 8, H); g.fillRect(x0 + 120, 0, 8, H); // end connectors
    } else if (v === 1) { // steel link with a raised cleat and hinge lugs
      g.fillStyle = '#3a3630'; g.fillRect(x0 + 2, 8, 124, 112);
      g.fillStyle = '#5a554c'; g.fillRect(x0 + 6, 46, 116, 26);
      g.fillStyle = '#6e685e'; g.fillRect(x0 + 6, 46, 116, 6);
      g.fillStyle = '#1a1816'; g.fillRect(x0 + 6, 72, 116, 5);
      g.fillStyle = '#121110'; g.fillRect(x0 + 40, 90, 10, 22); g.fillRect(x0 + 78, 90, 10, 22);
    } else if (v === 2) { // Soviet cast "waffle" link
      g.fillStyle = '#35312b'; g.fillRect(x0 + 2, 6, 124, 116);
      g.fillStyle = '#58534a';
      for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) g.fillRect(x0 + 10 + i * 29, 16 + j * 34, 22, 26);
      g.fillStyle = '#1c1a17';
      for (let i = 0; i < 4; i++) for (let j = 0; j < 3; j++) g.fillRect(x0 + 10 + i * 29, 38 + j * 34, 22, 4);
    } else { // inner face: running surface + centre guide horn
      g.fillStyle = '#3c3831'; g.fillRect(x0, 8, 128, 112);
      g.fillStyle = '#5c574d'; g.fillRect(x0 + 52, 20, 24, 60);
      g.fillStyle = '#6d675c'; g.fillRect(x0 + 52, 20, 24, 5);
    }
    g.fillStyle = '#0e0d0c'; g.fillRect(x0, 0, 128, 5); g.fillRect(x0, H - 4, 128, 4); // link gap
    // grime
    for (let i = 0; i < 260; i++) {
      const a = rnd() * 0.18;
      g.fillStyle = rnd() < 0.5 ? `rgba(70,55,38,${a})` : `rgba(10,9,8,${a})`;
      g.fillRect(x0 + rnd() * 128, rnd() * H, 2 + rnd() * 8, 2 + rnd() * 6);
    }
  }
  _trackTex = new THREE.CanvasTexture(c);
  _trackTex.colorSpace = THREE.SRGBColorSpace; _trackTex.wrapS = THREE.ClampToEdgeWrapping; _trackTex.wrapT = THREE.RepeatWrapping;
  _trackTex.anisotropy = 8;
  return _trackTex;
}

// ------------------------------------------------------------------ the tank shader
const NOISE = /* glsl */`
float tkHash(vec3 p){ p = fract(p*0.3183099 + 0.1); p *= 17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
float tkNoise(vec3 x){ vec3 i = floor(x), f = fract(x); f = f*f*(3.0-2.0*f);
  return mix(mix(mix(tkHash(i), tkHash(i+vec3(1,0,0)), f.x), mix(tkHash(i+vec3(0,1,0)), tkHash(i+vec3(1,1,0)), f.x), f.y),
             mix(mix(tkHash(i+vec3(0,0,1)), tkHash(i+vec3(1,0,1)), f.x), mix(tkHash(i+vec3(0,1,1)), tkHash(i+vec3(1,1,1)), f.x), f.y), f.z); }
float tkFbm(vec3 p){ float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++) { s += a*tkNoise(p); p = p*2.03 + 1.7; a *= 0.5; } return s/0.9375; }
`;
const VPARS = /* glsl */`
attribute vec4 aSurf; attribute vec4 aExt; attribute float aSpin; attribute vec3 aNext; attribute vec3 aNextN;
uniform float uTravel;
varying vec4 vSurf; varying vec4 vExt; varying vec3 vObj; varying vec3 vONrm; varying vec2 vTUv;
`;
const VNORMAL = /* glsl */`
vec3 objectNormal = vec3( normal );
float tkA = uTravel * aSpin, tkC = cos(tkA), tkS = sin(tkA);
if (aSpin > 0.0) objectNormal.yz = vec2(objectNormal.y*tkC - objectNormal.z*tkS, objectNormal.y*tkS + objectNormal.z*tkC);
// track link teeth: morph towards the previous link's copy by the fraction of a pitch travelled
float tkF = aSpin < 0.0 ? fract(uTravel / aExt.z) : 0.0;
if (aSpin < 0.0) objectNormal = normalize(mix(objectNormal, aNextN, tkF));
#ifdef USE_TANGENT
vec3 objectTangent = vec3( tangent.xyz );
#endif
`;
const VBEGIN = /* glsl */`
vec3 transformed = vec3( position );
if (aSpin > 0.0) { vec2 q = transformed.yz - aExt.zw; transformed.yz = aExt.zw + vec2(q.x*tkC - q.y*tkS, q.x*tkS + q.y*tkC); }
if (aSpin < 0.0) transformed = mix(position, aNext, tkF);
vSurf = aSurf; vExt = aExt; vObj = position; vONrm = normal; vTUv = uv;
`;
const FPARS = /* glsl */`
uniform vec3 uPaint, uCamoA, uCamoB, uMud, uDust, uSeed;
uniform sampler2D uDecal, uTrack;
uniform float uTravel;
varying vec4 vSurf; varying vec4 vExt; varying vec3 vObj; varying vec3 vONrm; varying vec2 vTUv;
${NOISE}`;
const FCOLOR = /* glsl */`
vec3 P = vObj;
float kind = vExt.y;
float paintM = vSurf.z, tMetal = vSurf.x, tRough = vSurf.y, tH = 0.0;
float n1 = tkFbm(P*1.1), n2 = tkNoise(P*7.0), n4 = tkNoise(P*27.0);
vec3 col = vColor.rgb;
if (paintM > 0.5) {
  vec3 pc = uPaint;
#ifdef CAMO
  float c1 = tkFbm(P*vec3(0.8,1.15,0.8) + uSeed);
  float c2 = tkFbm(P*vec3(0.95,1.3,0.95) + uSeed.zxy + vec3(11.0,5.0,7.0));
  pc = mix(pc, uCamoA, smoothstep(0.545, 0.565, c1));
  pc = mix(pc, uCamoB, smoothstep(0.565, 0.585, c2) * (1.0 - smoothstep(0.52, 0.545, c1)));
#endif
  pc *= 0.86 + 0.28*n1;
  pc *= 1.0 - 0.13*smoothstep(0.55, 0.95, tkNoise(P*vec3(16.0, 1.4, 16.0)));
  col *= pc;
}
if (kind > 0.5 && kind < 1.5) {           // markings (atlas)
  vec4 dc = texture2D(uDecal, vTUv);
  if (dc.a < 0.45) discard;
  col = dc.rgb * (0.88 + 0.16*n2); tMetal = 0.08; tRough = 0.6; paintM = 1.0;
} else if (kind > 1.5 && kind < 2.5) {    // track links
  vec4 tc = texture2D(uTrack, vec2(vTUv.x, (vTUv.y + uTravel) / vExt.z));
  col = tc.rgb * 1.15; tH = dot(tc.rgb, vec3(0.3, 0.59, 0.11)) * 3.0;
  tMetal = 0.55; tRough = 0.55 + 0.3*n2;
} else if (kind > 2.5) {                  // cast armour: pitted surface
  tH = n4*0.6 + n2*0.4;
}
// worn edges: lighter dusty paint, chips down to dark steel
float edge = vSurf.w;
float chip = paintM * smoothstep(0.88, 0.92, n4*0.5 + tkNoise(P*61.0)*0.3 + n2*0.2 + edge*0.2);
col = mix(col, col*1.28 + 0.01, paintM*edge*0.5);
col = mix(col, vec3(0.085, 0.075, 0.065), chip*0.85);
tMetal = mix(tMetal, 0.6, chip); tRough = mix(tRough, 0.5, chip);
// mud on the lower hull and running gear, dust on upward faces
float dn = tkFbm(P*vec3(2.2, 3.6, 2.2) + 9.0);
float dirt = smoothstep(0.25, 0.85, vExt.x*1.2 + (dn - 0.5)*0.9);
col = mix(col, uMud*(0.7 + 0.6*dn), dirt*0.88);
tRough = mix(tRough, 0.97, dirt); tMetal *= 1.0 - dirt*0.9;
col = mix(col, uDust, smoothstep(0.6, 0.97, normalize(vONrm).y) * 0.25 * (0.4 + dn));
#ifdef CHARRED
float cn = tkFbm(P*1.6 + 5.0);
col = mix(vec3(0.026, 0.024, 0.022), vec3(0.10, 0.045, 0.02), smoothstep(0.52, 0.85, cn)*0.85) + col*0.035;
col = mix(col, vec3(0.16, 0.155, 0.14), smoothstep(0.72, 0.92, n2)*0.35*(1.0 - dirt));
tRough = 0.93; tMetal = 0.12;
#endif
diffuseColor.rgb = col;
`;
const FBUMP = /* glsl */`
{
  float bs = kind > 1.5 && kind < 2.5 ? 0.012 : (kind > 2.5 ? 0.004 : 0.0);
  vec2 dH = vec2(dFdx(tH), dFdy(tH)) * bs;
  vec3 sp = -vViewPosition, sX = dFdx(sp), sY = dFdy(sp);
  vec3 R1 = cross(sY, normal), R2 = cross(normal, sX);
  float det = dot(sX, R1) * faceDirection;
  vec3 grad = sign(det) * (dH.x*R1 + dH.y*R2);
  if (bs > 0.0) normal = normalize(abs(det)*normal - grad);
}
`;
function attachShader(m) {
  const U = m.userData;
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U.uni);
    sh.uniforms.uTravel = U.uTravel;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\n' + VPARS)
      .replace('#include <beginnormal_vertex>', VNORMAL)
      .replace('#include <begin_vertex>', VBEGIN);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + FPARS)
      .replace('#include <color_fragment>', '#include <color_fragment>\n' + FCOLOR)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = tRough;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = tMetal;')
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + FBUMP);
  };
  m.customProgramCacheKey = () => 'steelfront-tank-1';
  return m;
}
const MATS = new Map();
// Shared material for a paint scheme (+ charred variant for wrecks).
export function tankMaterial(p, charred = false, seed = 0) {
  if (p.camoA == null) seed = 0;
  const key = `${p.base}:${p.camoA ?? ''}:${p.camoB ?? ''}:${charred ? 1 : 0}:${seed}`;
  let m = MATS.get(key);
  if (m) return m;
  m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.65, metalness: 0.15 });
  if (p.camoA != null) m.defines.CAMO = '';
  if (charred) m.defines.CHARRED = '';
  m.userData.uTravel = { value: 0 };
  m.userData.uni = {
    uPaint: { value: lin(p.base) }, uCamoA: { value: lin(p.camoA ?? p.base) }, uCamoB: { value: lin(p.camoB ?? p.base) },
    uMud: { value: lin(0x3e3528) }, uDust: { value: lin(0x9c8e74) },
    uSeed: { value: new THREE.Vector3(3.1 + (seed % 97) * 1.37, (seed % 89) * 0.71, 1.7 + (seed % 83) * 1.13) },
    uDecal: { value: decalTexture() }, uTrack: { value: trackTexture() },
  };
  attachShader(m);
  MATS.set(key, m);
  return m;
}
// Per-instance clone: same program, own uTravel (and optionally transparent for fades).
function cloneMat(base, transparent = false) {
  const ud = base.userData; base.userData = {};
  const c = base.clone();
  base.userData = ud;
  c.defines = { ...base.defines };
  c.userData = { uni: base.userData.uni, uTravel: { value: 0 } };
  attachShader(c);
  if (transparent) { c.transparent = true; c.depthWrite = true; }
  return c;
}

// ------------------------------------------------------------------ geometry builder
const WHITE = lin(0xffffff);
const ST = {
  paint: { c: WHITE, metal: 0.06, rough: 0.7, paint: 1 },
  cast: { c: WHITE, metal: 0.06, rough: 0.74, paint: 1, kind: 3 },
  steel: { c: lin(0x4a4843), metal: 0.75, rough: 0.45, paint: 0 },
  dark: { c: lin(0x1d1c1a), metal: 0.3, rough: 0.7, paint: 0 },
  rubber: { c: lin(0x1c1b1a), metal: 0.0, rough: 0.9, paint: 0 },
  wood: { c: lin(0x6e5236), metal: 0.0, rough: 0.8, paint: 0 },
  canvas: { c: lin(0x6a6548), metal: 0.0, rough: 0.95, paint: 0 },
  tarp: { c: lin(0x4c4a36), metal: 0.0, rough: 0.97, paint: 0 },
  glass: { c: lin(0x8fa2a8), metal: 0.9, rough: 0.12, paint: 0, dirt: false },
  bore: { c: lin(0x070707), metal: 0.2, rough: 0.85, paint: 0, dirt: false },
  interior: { c: lin(0xb9b6a4), metal: 0.1, rough: 0.8, paint: 0 },
  brass: { c: lin(0xa88442), metal: 0.85, rough: 0.35, paint: 0, dirt: false },
  radio: { c: lin(0x4d5244), metal: 0.2, rough: 0.6, paint: 0 },
  link: { c: lin(0x3d3934), metal: 0.5, rough: 0.6, paint: 0, dirtK: 0.4 },
  decal: { c: WHITE, metal: 0.1, rough: 0.6, paint: 0, kind: 1 },
};
const V = {
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  mul: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  norm: (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
};
const _v3 = new THREE.Vector3(), _n3 = new THREE.Vector3(), _nm = new THREE.Matrix3();

class GB {
  constructor(yOff = 0, dirtH = 1, morph = false) {
    this.P = []; this.N = []; this.C = []; this.S = []; this.E = []; this.W = []; this.U = []; this.I = [];
    this.morph = morph; this.X = []; this.Y = []; this.nx = null;
    this.yOff = yOff; this.dirtH = dirtH; this.st = ST.paint;
  }
  get count() { return this.P.length / 3; }
  v(x, y, z, nx, ny, nz, edge = 0, u = 0, w = 0) {
    const s = this.st;
    this.P.push(x, y, z); this.N.push(nx, ny, nz);
    this.C.push(s.c.r, s.c.g, s.c.b);
    this.S.push(s.metal, s.rough, s.paint, edge);
    const dirt = s.dirt === false ? 0 : clamp(1 - (y + this.yOff - 0.05) / this.dirtH, 0, 1) * (s.dirtK ?? 1);
    this.E.push(dirt, s.kind || 0, s.e2 ?? 0, s.e3 ?? 0);
    this.W.push(s.spin || 0);
    this.U.push(u, w);
    if (this.morph) { const q = this.nx; if (q) this.X.push(q[0], q[1], q[2], q[3], q[4], q[5]); else this.X.push(x, y, z, nx, ny, nz); }
    return this.count - 1;
  }
  // triangle, wound so that its face normal agrees with n
  tri(a, b, c, n) {
    if (n) {
      const P = this.P;
      const ax = P[a * 3], ay = P[a * 3 + 1], az = P[a * 3 + 2];
      const ux = P[b * 3] - ax, uy = P[b * 3 + 1] - ay, uz = P[b * 3 + 2] - az;
      const wx = P[c * 3] - ax, wy = P[c * 3 + 1] - ay, wz = P[c * 3 + 2] - az;
      const cx = uy * wz - uz * wy, cy = uz * wx - ux * wz, cz = ux * wy - uy * wx;
      if (cx * n[0] + cy * n[1] + cz * n[2] < 0) { this.I.push(a, c, b); return; }
    }
    this.I.push(a, b, c);
  }
  quad(a, b, c, d, n) { this.tri(a, b, c, n); this.tri(a, c, d, n); }
  // Append a three.js geometry transformed by m.
  geo(g, m) {
    const pos = g.attributes.position, nor = g.attributes.normal, uv = g.attributes.uv;
    const base = this.count;
    _nm.getNormalMatrix(m);
    for (let i = 0; i < pos.count; i++) {
      _v3.fromBufferAttribute(pos, i).applyMatrix4(m);
      _n3.fromBufferAttribute(nor, i).applyMatrix3(_nm).normalize();
      this.v(_v3.x, _v3.y, _v3.z, _n3.x, _n3.y, _n3.z, 0, uv ? uv.getX(i) : 0, uv ? uv.getY(i) : 0);
    }
    const flip = m.determinant() < 0;
    const idx = g.index;
    const n = idx ? idx.count : pos.count;
    for (let i = 0; i < n; i += 3) {
      const a = base + (idx ? idx.getX(i) : i), b = base + (idx ? idx.getX(i + 1) : i + 1), c = base + (idx ? idx.getX(i + 2) : i + 2);
      if (flip) this.I.push(a, c, b); else this.I.push(a, b, c);
    }
  }
  box(m, st) { if (st) this.st = st; this.geo(unitBox(), m); }
  cyl(m, st, seg = 12) { if (st) this.st = st; this.geo(unitCyl(seg), m); } // unit cylinder along +y, r=1 h=1
  // Convex polygon (CCW seen along -n). rings: bevelled rim (welded / cast look).
  plate(verts, n, e = 0.025, tilt = 0.55, rings = true) {
    const m = verts.length;
    if (m < 3) return;
    if (!rings || e <= 0) {
      const ids = verts.map((p) => this.v(p[0], p[1], p[2], n[0], n[1], n[2], 0));
      for (let k = 1; k < m - 1; k++) this.tri(ids[0], ids[k], ids[k + 1], n);
      return;
    }
    let minL = Infinity;
    for (let k = 0; k < m; k++) { const a = verts[k], b = verts[(k + 1) % m]; minL = Math.min(minL, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])); }
    e = Math.min(e, minL * 0.2);
    const r1 = inset(verts, n, e), r2 = inset(verts, n, Math.min(e * 3.5, minL * 0.4));
    const cw = windSign(verts, n);
    for (let k = 0; k < m; k++) {
      const k1 = (k + 1) % m, a = verts[k], b = verts[k1];
      const d = V.norm(V.sub(b, a));
      const out = V.mul(V.cross(d, n), cw); // outward in-plane (inward is n × d for CCW)
      const nt = V.norm(V.add(n, V.mul(out, tilt)));
      const ia = this.v(a[0], a[1], a[2], nt[0], nt[1], nt[2], 1), ib = this.v(b[0], b[1], b[2], nt[0], nt[1], nt[2], 1);
      const ja = this.v(r1[k][0], r1[k][1], r1[k][2], n[0], n[1], n[2], 0.5), jb = this.v(r1[k1][0], r1[k1][1], r1[k1][2], n[0], n[1], n[2], 0.5);
      this.quad(ia, ib, jb, ja, n);
      const ka = this.v(r2[k][0], r2[k][1], r2[k][2], n[0], n[1], n[2], 0), kb = this.v(r2[k1][0], r2[k1][1], r2[k1][2], n[0], n[1], n[2], 0);
      this.quad(ja, jb, kb, ka, n);
    }
    const ids = r2.map((p) => this.v(p[0], p[1], p[2], n[0], n[1], n[2], 0));
    for (let k = 1; k < m - 1; k++) this.tri(ids[0], ids[k], ids[k + 1], n);
  }
  // Surface of revolution about local +x: prof = [[r, x, style?], ...]; segment k uses the
  // style of point k. Normal = profile tangent rotated by −90° (walk the outline accordingly).
  lathe(prof, seg, m, phase = 0) {
    _nm.getNormalMatrix(m);
    for (let k = 0; k < prof.length - 1; k++) {
      const [r0, x0, s0] = prof[k], [r1, x1] = prof[k + 1];
      if (s0) this.st = s0;
      if (r0 < 1e-6 && r1 < 1e-6) continue;
      const dr = r1 - r0, dx = x1 - x0, L = Math.hypot(dr, dx);
      if (L < 1e-7) continue;
      const nr = -dx / L, nx = dr / L;
      const ring = [];
      for (let j = 0; j <= seg; j++) {
        const a = phase + (j / seg) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
        _n3.set(nx, nr * c, nr * s).applyMatrix3(_nm).normalize();
        const nn = [_n3.x, _n3.y, _n3.z];
        _v3.set(x0, r0 * c, r0 * s).applyMatrix4(m); const i0 = this.v(_v3.x, _v3.y, _v3.z, nn[0], nn[1], nn[2]);
        _v3.set(x1, r1 * c, r1 * s).applyMatrix4(m); const i1 = this.v(_v3.x, _v3.y, _v3.z, nn[0], nn[1], nn[2]);
        ring.push([i0, i1, nn]);
      }
      for (let j = 0; j < seg; j++) {
        const [a0, a1, na] = ring[j], [b0, b1] = ring[j + 1];
        if (r0 < 1e-6) this.tri(a0, a1, b1, na);
        else if (r1 < 1e-6) this.tri(a0, a1, b0, na);
        else this.quad(a0, b0, b1, a1, na);
      }
    }
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.N, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.C, 3));
    g.setAttribute('aSurf', new THREE.Float32BufferAttribute(this.S, 4));
    g.setAttribute('aExt', new THREE.Float32BufferAttribute(this.E, 4));
    g.setAttribute('aSpin', new THREE.Float32BufferAttribute(this.W, 1));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.U, 2));
    if (this.morph) {
      const X = new Float32Array(this.X);
      const ib = new THREE.InterleavedBuffer(X, 6);
      g.setAttribute('aNext', new THREE.InterleavedBufferAttribute(ib, 3, 0));
      g.setAttribute('aNextN', new THREE.InterleavedBufferAttribute(ib, 3, 3));
    }
    g.setIndex(this.I);
    g.computeBoundingSphere(); g.computeBoundingBox();
    return g;
  }
}
function windSign(verts, n) {
  const m = verts.length;
  const c = verts.reduce((s, p) => V.add(s, V.mul(p, 1 / m)), [0, 0, 0]);
  const a = verts[0], b = verts[1];
  return V.dot(V.cross(n, V.norm(V.sub(b, a))), V.sub(c, a)) < 0 ? -1 : 1;
}
function inset(verts, n, d) {
  const m = verts.length;
  const sgn = windSign(verts, n);
  return verts.map((v, i) => {
    const p = verts[(i + m - 1) % m], q = verts[(i + 1) % m];
    const i1 = V.mul(V.cross(n, V.norm(V.sub(v, p))), sgn), i2 = V.mul(V.cross(n, V.norm(V.sub(q, v))), sgn);
    const k = d / Math.max(0.35, 1 + V.dot(i1, i2));
    return V.add(v, V.mul(V.add(i1, i2), k));
  });
}
let _ubox = null; const _ucyl = {};
const unitBox = () => _ubox || (_ubox = new THREE.BoxGeometry(1, 1, 1));
const unitCyl = (seg) => _ucyl[seg] || (_ucyl[seg] = new THREE.CylinderGeometry(1, 1, 1, seg, 1));
const _e = new THREE.Euler(), _q = new THREE.Quaternion();
// translate · rotate(XYZ euler) · scale
function M(x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
  _e.set(rx, ry, rz); _q.setFromEuler(_e);
  return new THREE.Matrix4().compose(_v3.set(x, y, z), _q, new THREE.Vector3(sx, sy, sz));
}
// Box/cylinder whose local axes are X, Y (Z = X × Y), at pos, scaled.
function basis(pos, X, Y, sx, sy, sz) {
  const Z = V.cross(X, Y);
  const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(...X), new THREE.Vector3(...Y), new THREE.Vector3(...Z));
  m.scale(new THREE.Vector3(sx, sy, sz)); m.setPosition(pos[0], pos[1], pos[2]);
  return m;
}
// Cylinder from point a to b (radius r).
function rod(gb, a, b, r, st, seg = 8) {
  const d = V.sub(b, a), L = Math.hypot(d[0], d[1], d[2]);
  const Y = V.norm(d), X = V.norm(Math.abs(Y[1]) < 0.9 ? V.cross(Y, [0, 1, 0]) : V.cross(Y, [1, 0, 0]));
  gb.cyl(basis(V.mul(V.add(a, b), 0.5), X, Y, r, L, r), st, seg);
}

// ------------------------------------------------------------------ tank dimensions
function dims(def) {
  const h = def.hull, t = def.turret, tr = h.track;
  const arm = buildArmor(def);
  const pc = Object.fromEntries(arm.pieces.map((p) => [p.name, p]));
  const top = h.clr + h.H;
  const trackTop = Math.min(tr.h, top - 0.05);
  const up = pc.hullUpper.planes;
  // plane helpers (hull frame): z of the front/rear faces at height y, x of the side face
  const zOn = (p, y) => (p.d - p.n[1] * y) / p.n[2];
  const frontZ = (y) => Math.min(zOn(up[0], y), zOn(up[1], y));
  const rearZ = (y) => zOn(up[2], y);
  const sideX = (y) => (up[3].d - up[3].n[1] * y) / up[3].n[0];
  const tp = pc.turret.planes;
  const tFrontZ = (y) => zOn(tp[0], y), tRearZ = (y) => zOn(tp[1], y);
  const tSideX = (y) => (tp[2].d - tp[2].n[1] * y) / tp[2].n[0];
  return {
    h, t, tr, arm, pc, top, trackTop, fullW: h.sponson === false ? h.W : h.W + 2 * tr.w, xT: h.W / 2 + tr.w / 2, sponson: h.sponson !== false,
    noseY: h.clr + h.H * (1 - h.upper.frac), frontZ, rearZ, sideX, tFrontZ, tRearZ, tSideX,
    upperFront: up[0], turretPos: arm.turretPos, nation: def.nation,
    fixed: t.shape === 'casemate', open: t.shape === 'open' || !!t.open, cast: t.shape === 'cast',
    dirtH: Math.max(0.7, trackTop * 0.95),
  };
}

// ------------------------------------------------------------------ running gear layout
const TT = 0.075; // track thickness
function gearLayout(def, D) {
  const h = def.hull, tr = h.track, style = tr.style || 'torsion';
  const big = style === 'christie' || style === 'interleaved';
  const Lt = h.L * (tr.len ?? 0.96);
  const front = def.look?.drive ? def.look.drive === 'front' : def.nation !== 'ussr';
  const topLim = D.trackTop - 0.03;
  let R = tr.wheelR || 0.3;
  R = big ? Math.min(R, (topLim - 1.5 * TT) / 2) : Math.min(R, (topLim - TT) * 0.42);
  const Rs = clamp(big ? R * 0.8 : R * 1.15, 0.2, 0.36);
  const Ri = clamp(big ? R * 0.85 : R * 0.95, 0.18, 0.34);
  const zF = Lt / 2, zR = -Lt / 2;
  const yS = clamp(topLim - TT - Rs - 0.02, Rs + TT + 0.12, 1.3);
  const zS = front ? zF - Rs - TT : zR + Rs + TT;
  const yI = clamp(yS - (front ? 0.12 : 0.04), Ri + TT + 0.1, 2);
  const zI = front ? zR + Ri + TT : zF - Ri - TT;
  const yW = R + TT;
  const [zA, rA] = front ? [zI, Ri] : [zS, Rs], [zB, rB] = front ? [zS, Rs] : [zI, Ri];
  const zLo = zA + rA * 0.4 + R * 0.85, zHi = zB - rB * 0.4 - R * 0.85;
  const n = Math.max(2, tr.wheels || 6);
  const W = tr.w;
  const wheels = [], bogies = [], rollers = [];
  const even = (k, cnt, a, b) => (cnt === 1 ? (a + b) / 2 : a + (b - a) * k / (cnt - 1));
  const yTop = yS + Rs + TT / 2;
  const Rr = 0.1;
  if (style === 'vvss' || style === 'hvss' || style === 'leaf') {
    const nb = Math.max(1, Math.round(n / 2));
    const d = 2 * R + (style === 'leaf' ? 0.1 : 0.08);
    for (let b = 0; b < nb; b++) {
      const bc = even(b, nb, zLo + d / 2 - R * 0.1, zHi - d / 2 + R * 0.1);
      bogies.push({ z: bc, d });
      for (const s of [-1, 1]) {
        if (style === 'hvss') { wheels.push({ z: bc + s * d / 2, y: yW, r: R, x: W * 0.2, w: W * 0.34 }); wheels.push({ z: bc + s * d / 2, y: yW, r: R, x: -W * 0.2, w: W * 0.34 }); }
        else wheels.push({ z: bc + s * d / 2, y: yW, r: R, x: 0.0, w: W * (style === 'leaf' ? 0.5 : 0.56) });
      }
      if (style !== 'leaf') rollers.push({ z: bc - d * 0.18, y: yTop - TT / 2 - Rr, r: Rr, x: 0, w: W * 0.45 });
    }
    if (style === 'leaf') for (let k = 0; k < 4; k++) rollers.push({ z: even(k, 4, zLo + 0.2, zHi - 0.3), y: yTop - TT / 2 - Rr, r: Rr, x: 0, w: W * 0.45 });
  } else if (style === 'interleaved') {
    for (let k = 0; k < n; k++) {
      const z = even(k, n, zLo, zHi), outer = k % 2 === 0;
      wheels.push({ z, y: yW, r: R, x: outer ? W * 0.24 : -W * 0.12, w: W * 0.36, inner: !outer });
    }
  } else { // christie, torsion
    for (let k = 0; k < n; k++) wheels.push({ z: even(k, n, zLo, zHi), y: yW, r: R, x: 0, w: W * (style === 'christie' ? 0.7 : 0.58) });
    if (style === 'torsion') {
      const nr = Math.max(2, Math.round(n / 2));
      for (let k = 0; k < nr; k++) rollers.push({ z: even(k, nr, zLo + 0.3, zHi - 0.3), y: yTop - TT / 2 - Rr, r: Rr, x: 0, w: W * 0.4 });
    }
  }
  // Track centreline: convex hull of the wheels (offset by half the track), sagging on top.
  const circ = [[zS, yS, Rs], [zI, yI, Ri], ...wheels.map((w) => [w.z, w.y, w.r]), ...rollers.map((w) => [w.z, w.y, w.r])];
  const pts = [];
  for (const [z, y, r] of circ) for (let k = 0; k < 28; k++) { const a = k / 28 * Math.PI * 2; pts.push([z + Math.cos(a) * (r + TT / 2), y + Math.sin(a) * (r + TT / 2)]); }
  const hull = convexHull(pts);
  const loop = [];
  for (let k = 0; k < hull.length; k++) {
    const a = hull[k], b = hull[(k + 1) % hull.length];
    loop.push(a);
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (a[1] > yW && b[1] > yW && L > 0.3) {
      const sag = Math.min(0.07, 0.04 * L), m = Math.ceil(L / 0.1);
      for (let j = 1; j < m; j++) { const t = j / m; loop.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t - sag * 4 * t * (1 - t)]); }
    }
  }
  const pitch0 = style === 'christie' ? 0.17 : style === 'interleaved' ? 0.13 : 0.155;
  return {
    style, front, R, Rs, Ri, zS, yS, zI, yI, yW, wheels, bogies, rollers, loop, Lt, zLo, zHi, yTop,
    pitch: tr.pitch || pitch0, variant: def.nation === 'usa' && (style === 'vvss' || style === 'hvss') ? 0 : def.nation === 'ussr' ? 2 : 1,
  };
}
function convexHull(P) {
  const p = P.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  lo.pop(); up.pop();
  return lo.concat(up); // CCW in (z, y)
}
// Resample a polyline (closed or open) at even spacing → [[z, y, s], ...]
function resample(pts, step, closed) {
  const seg = [];
  let total = 0;
  const n = closed ? pts.length : pts.length - 1;
  for (let k = 0; k < n; k++) { const a = pts[k], b = pts[(k + 1) % pts.length]; const L = Math.hypot(b[0] - a[0], b[1] - a[1]); seg.push([a, b, total, L]); total += L; }
  const N = Math.max(closed ? 16 : 2, Math.round(total / step));
  const out = [];
  let si = 0;
  for (let k = 0; k <= N; k++) {
    const s = (k / N) * total;
    while (si < seg.length - 1 && seg[si][2] + seg[si][3] < s) si++;
    const [a, b, s0, L] = seg[si], t = L > 0 ? clamp((s - s0) / L, 0, 1) : 0;
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, s]);
  }
  return { pts: out, total };
}

// Track band along a (z,y) path, x ∈ [x0, x1]. Outer face textured (links), inner face too.
function trackBand(gb, path, closed, x0, x1, pitch, variant, side, lod) {
  const { pts, total } = resample(path, lod ? 0.4 : 0.06, closed);
  if (closed) pitch = total / Math.max(1, Math.round(total / pitch));
  gb.st = { ...ST.link, kind: 2, e2: pitch, c: WHITE, dirtK: 0.55 };
  const n = pts.length;
  const rings = [];
  for (let k = 0; k < n; k++) {
    const p = pts[k];
    const a = pts[k === 0 ? (closed ? n - 2 : 0) : k - 1], b = pts[k === n - 1 ? (closed ? 1 : n - 1) : k + 1];
    let tz = b[0] - a[0], ty = b[1] - a[1]; const l = Math.hypot(tz, ty) || 1; tz /= l; ty /= l;
    const oz = ty, oy = -tz; // outward for a CCW loop (down for a path heading +z)
    const h = TT / 2, s = p[2];
    const uo = (f) => (variant + (side > 0 ? f : 1 - f)) / 4, ui = (f) => (3 + f) / 4;
    const Po = [p[1] + oy * h, p[0] + oz * h], Pi = [p[1] - oy * h, p[0] - oz * h];
    rings.push({
      o0: gb.v(x0, Po[0], Po[1], 0, oy, oz, 0, uo(0.02), s), o1: gb.v(x1, Po[0], Po[1], 0, oy, oz, 0, uo(0.98), s),
      i0: gb.v(x0, Pi[0], Pi[1], 0, -oy, -oz, 0, ui(0.02), s), i1: gb.v(x1, Pi[0], Pi[1], 0, -oy, -oz, 0, ui(0.98), s),
      s0o: gb.v(x0, Po[0], Po[1], -1, 0, 0, 0, uo(0.01), s), s0i: gb.v(x0, Pi[0], Pi[1], -1, 0, 0, 0, uo(0.01), s),
      s1o: gb.v(x1, Po[0], Po[1], 1, 0, 0, 0, uo(0.99), s), s1i: gb.v(x1, Pi[0], Pi[1], 1, 0, 0, 0, uo(0.99), s),
      n: [0, oy, oz],
    });
  }
  for (let k = 0; k < n - 1; k++) {
    const A = rings[k], B = rings[k + 1], no = A.n, ni = [0, -A.n[1], -A.n[2]];
    gb.quad(A.o0, A.o1, B.o1, B.o0, no);
    gb.quad(A.i0, A.i1, B.i1, B.i0, ni);
    gb.quad(A.s0o, A.s0i, B.s0i, B.s0o, [-1, 0, 0]);
    gb.quad(A.s1o, A.s1i, B.s1i, B.s1o, [1, 0, 0]);
  }
}

// Cleats on the outside of every link (+ guide horns inside on steel tracks). Geometry is static;
// the shader slides each link towards the previous link's copy by fract(travel / pitch).
function trackTeeth(gb, path, x0, x1, pitch, horns) {
  const { pts, total } = resample(path, 0.02, true);
  const N = Math.max(8, Math.round(total / pitch)), p = total / N;
  const at = (s) => {
    s = ((s % total) + total) % total;
    let lo = 0, hi = pts.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (pts[m][2] <= s) lo = m; else hi = m; }
    const a = pts[lo], b = pts[hi], t = (s - a[2]) / ((b[2] - a[2]) || 1);
    let tz = b[0] - a[0], ty = b[1] - a[1]; const l = Math.hypot(tz, ty) || 1; tz /= l; ty /= l;
    return { z: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t, tz, ty };
  };
  const xm = (x0 + x1) / 2, w = x1 - x0;
  const boxes = (k) => {
    const f = at(k * p), Oz = f.ty, Oy = -f.tz; // outward = (ty, −tz) in (z, y)
    const res = [];
    const mk = (cx, off, sx, sAlong, sOut) => {
      const c = [cx, f.y + Oy * off, f.z + Oz * off];
      const ax = [[1, 0, 0], [0, f.ty, f.tz], [0, Oy, Oz]], hs = [sx / 2, sAlong / 2, sOut / 2];
      for (let a = 0; a < 3; a++) for (const sg of [-1, 1]) {
        const n = ax[a].map((v) => v * sg), u = ax[(a + 1) % 3], v = ax[(a + 2) % 3], hu = hs[(a + 1) % 3], hv = hs[(a + 2) % 3];
        const fc = V.add(c, V.mul(n, hs[a]));
        res.push({ n, q: [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([i, j]) => V.add(fc, V.add(V.mul(u, i * hu), V.mul(v, j * hv)))) });
      }
    };
    mk(xm, TT / 2 + 0.012, w * 0.92, p * 0.3, 0.03);
    if (horns) mk(xm, -TT / 2 - 0.03, Math.min(0.1, w * 0.25), p * 0.42, 0.065);
    return res;
  };
  const all = []; for (let k = 0; k < N; k++) all.push(boxes(k));
  for (let k = 0; k < N; k++) {
    const cur = all[k], prev = all[(k + N - 1) % N];
    cur.forEach((face, fi) => {
      const pf = prev[fi];
      const ids = face.q.map((q, j) => { gb.nx = [...pf.q[j], ...pf.n]; return gb.v(q[0], q[1], q[2], face.n[0], face.n[1], face.n[2]); });
      gb.quad(ids[0], ids[1], ids[2], ids[3], face.n);
    });
  }
  gb.nx = null;
}

// ------------------------------------------------------------------ wheels
const spinSt = (st, y, z, r) => ({ ...st, spin: 1 / r, e2: y, e3: z });
// A road wheel (rubber tyre on a dished disc), sprocket, idler or return roller, spinning about
// the hull x axis at (y, z). side = +1 (left, outer face +x) / −1.
function wheel(gb, kind, xc, y, z, R, w, side, lod, nation) {
  const m = M(xc, y, z, 0, 0, 0, side, 1, 1);
  const o = w / 2;
  const P = spinSt(ST.paint, y, z, R), S = spinSt(ST.steel, y, z, R), Rb = spinSt(ST.rubber, y, z, R), Dk = spinSt(ST.dark, y, z, R);
  const seg = lod ? 7 : kind === 'roller' ? 10 : 18;
  if (lod) { gb.lathe([[0, o, P], [R, o, Rb], [R, -o, null]], seg, m); return; }
  if (kind === 'road' || kind === 'roller') {
    gb.lathe([
      [0, o + 0.045, S], [R * 0.11, o + 0.045, S], [R * 0.14, o + 0.012, P], [R * 0.46, o - 0.025, P], [R * 0.72, o - 0.012, P],
      [R * 0.8, o, Rb], [R * 0.95, o, Rb], [R, o - 0.025, Rb], [R, -o + 0.025, Rb], [R * 0.95, -o, Rb], [R * 0.8, -o, null],
    ], seg, m);
    if (kind === 'road' && R > 0.3) { // lightening holes / bolt ring on big wheels
      gb.st = Dk;
      const nh = nation === 'ussr' ? 6 : 8, rh = nation === 'ussr' ? R * 0.12 : R * 0.035;
      for (let k = 0; k < nh; k++) {
        const a = k / nh * Math.PI * 2, rr = nation === 'ussr' ? R * 0.5 : R * 0.2;
        gb.geo(unitCyl(8), M(xc + side * (o - 0.012), y + Math.cos(a) * rr, z + Math.sin(a) * rr, 0, 0, Math.PI / 2, rh, 0.012, rh));
      }
    }
  } else if (kind === 'sprocket') {
    gb.lathe([
      [0, o + 0.07, S], [R * 0.13, o + 0.07, S], [R * 0.17, o + 0.03, P], [R * 0.55, o + 0.0, P], [R * 0.7, o - 0.02, P],
      [R * 0.8, o - 0.02, S], [R * 0.86, o - 0.02, S], [R * 0.86, -o, null],
    ], seg, m);
    const nt = Math.round(R * 40);
    gb.st = S;
    for (let k = 0; k < nt; k++) {
      const a = k / nt * Math.PI * 2;
      for (const s of [-1, 1]) gb.geo(unitBox(), M(xc + s * w * 0.28, y + Math.cos(a) * R * 0.95, z + Math.sin(a) * R * 0.95, -a, 0, 0, w * 0.3, 0.14, 0.085));
    }
  } else { // idler: steel spoked disc, no tyre
    gb.lathe([
      [0, o + 0.05, S], [R * 0.12, o + 0.05, S], [R * 0.15, o + 0.01, P], [R * 0.6, o - 0.03, P], [R * 0.82, o - 0.01, P],
      [R * 0.86, o, S], [R, o - 0.02, S], [R, -o + 0.02, S], [R * 0.86, -o, null],
    ], seg, m);
  }
}

// ------------------------------------------------------------------ static details
function fenders(gb, D, G, lod) {
  const { tr, trackTop, xT } = D;
  gb.st = ST.paint;
  if (!D.sponson) { // exposed tracks: full-length track guards on brackets, bent down at both ends
    const y = Math.max(trackTop, G.yTop + TT + 0.04), z0 = -G.Lt / 2 - 0.02, z1 = G.Lt / 2 + 0.04, w = tr.w + 0.06;
    for (const side of [1, -1]) {
      const x = side * (xT + 0.01);
      gb.st = ST.paint;
      gb.box(M(x, y + 0.008, (z0 + z1) / 2, 0, 0, 0, w, 0.016, z1 - z0));
      gb.box(M(x + side * w / 2, y - 0.02, (z0 + z1) / 2, 0, 0, 0, 0.014, 0.06, z1 - z0)); // rolled outer lip
      gb.box(M(x, y - 0.07, z1 + 0.07, -1.0, 0, 0, w, 0.014, 0.2));
      gb.box(M(x, y - 0.06, z0 - 0.06, 1.0, 0, 0, w, 0.014, 0.18));
      if (!lod) {
        gb.st = ST.steel;
        const nb = 4;
        for (let k = 0; k < nb; k++) { const z = z0 + (z1 - z0) * (k + 0.5) / nb; gb.box(M(side * (D.h.W / 2 + 0.05), y - 0.05, z, 0, 0, side * 0.5, 0.1, 0.1, 0.04)); }
        // stowage on the guards: a box on the left, tools on the right
        gb.st = ST.paint; if (side > 0) gb.box(M(x, y + 0.13, z0 + (z1 - z0) * 0.3, 0, 0, 0, tr.w * 0.8, 0.24, 0.5));
        else { gb.st = ST.wood; gb.cyl(M(x, y + 0.035, (z0 + z1) / 2 - 0.2, Math.PI / 2, 0, 0, 0.018, 1.0, 0.018), null, 6); gb.st = ST.steel; gb.box(M(x, y + 0.03, (z0 + z1) / 2 + 0.4, 0, 0, 0, 0.16, 0.012, 0.22)); }
      }
    }
    return;
  }
  for (const side of [1, -1]) {
    const x = side * xT, w = tr.w + 0.05;
    const zf = D.frontZ(trackTop + 0.01), zEnd = G.Lt / 2 + 0.06;
    if (zEnd > zf + 0.05) {
      gb.box(M(x, trackTop + 0.008, (zf + zEnd) / 2, 0, 0, 0, w, 0.016, zEnd - zf));
      gb.box(M(x, trackTop - 0.05, zEnd + 0.06, -0.9, 0, 0, w, 0.014, 0.16));
    }
    const zr = D.rearZ(trackTop + 0.01), zRe = -G.Lt / 2 - 0.04;
    if (zRe < zr - 0.05) gb.box(M(x, trackTop + 0.008, (zr + zRe) / 2, 0, 0, 0, w, 0.016, zr - zRe));
  }
}
function skirts(gb, D, G) {
  const { trackTop, fullW } = D;
  const y0 = G.yW + G.R * 0.35, y1 = trackTop + 0.02, z0 = -G.Lt / 2 + 0.35, z1 = G.Lt / 2 - 0.5;
  const np = Math.max(3, Math.round((z1 - z0) / 1.0)), pw = (z1 - z0) / np;
  for (const side of [1, -1]) {
    const x = side * (fullW / 2 + 0.05);
    gb.st = ST.paint;
    for (let k = 0; k < np; k++) gb.box(M(x, (y0 + y1) / 2, z0 + pw * (k + 0.5), 0, 0, 0, 0.012, y1 - y0, pw - 0.03));
    gb.st = ST.steel;
    gb.box(M(x - side * 0.03, y1 - 0.02, (z0 + z1) / 2, 0, 0, 0, 0.05, 0.03, z1 - z0));
  }
}
function link(gb, pos, X, Y, len, w) {
  gb.st = ST.link; gb.box(basis(pos, X, Y, w * 0.9, 0.035, len * 0.9));
  gb.st = ST.steel; gb.box(basis(V.add(pos, V.mul(Y, 0.025)), X, Y, w * 0.25, 0.025, len * 0.8));
}
function spareLinks(gb, D) {
  const { h, nation, top, noseY } = D;
  const pf = D.upperFront, n = pf.n;
  if (nation === 'usa' || nation === 'germany') {
    // a row of links across the upper front plate (German: across the nose)
    const y = nation === 'usa' ? noseY + (top - noseY) * 0.28 : noseY + (top - noseY) * 0.12;
    const z = D.frontZ(y), cnt = nation === 'usa' ? 5 : 7, w = D.tr.w * 0.9, gap = nation === 'usa' ? 0.18 : 0.17;
    const up = V.norm(V.cross([1, 0, 0], n));
    for (let k = 0; k < cnt; k++) {
      const x = (k - (cnt - 1) / 2) * gap;
      link(gb, V.add([x, y, z], V.mul(n, 0.03)), up, n, w, 0.16);
    }
  } else if (nation === 'ussr') {
    for (const side of [1, -1]) {
      const y = top - 0.28, x = D.sideX(y) * side;
      const nx = [side * D.pc.hullUpper.planes[3].n[0], D.pc.hullUpper.planes[3].n[1], 0];
      for (let k = 0; k < 3; k++) link(gb, V.add([x, y, h.L * 0.3 + k * 0.17], V.mul(nx, 0.03)), [0, 0, 1], nx, D.tr.w * 0.85, 0.16);
    }
  }
}
function headlight(gb, x, y, z) {
  gb.st = ST.paint; gb.lathe([[0.095, 0.05], [0.095, 0.03], [0.085, -0.08], [0, -0.08]], 12, M(x, y, z, 0, -Math.PI / 2, 0));
  gb.st = ST.glass; gb.lathe([[0, 0.058], [0.04, 0.056], [0.085, 0.05]], 12, M(x, y, z, 0, -Math.PI / 2, 0));
  gb.st = ST.steel; gb.box(M(x, y - 0.1, z - 0.05, 0, 0, 0, 0.03, 0.12, 0.03));
}
function hullDetails(gb, D, G, def, info) {
  const { h, nation, top, noseY, trackTop, fullW } = D;
  const W = h.W, pf = D.upperFront, n = pf.n;
  const zRoofF = D.frontZ(top), zRoofR = D.rearZ(top), halfTop = D.sideX(top);
  const onFront = (x, frac, out = 0) => { const y = noseY + (top - noseY) * frac; return [x, y, D.frontZ(y) + out]; };
  const sloped = h.upper.a >= 35;
  const look = def.look || {};
  const crew = def.crew || [];
  // --- driver & bow gunner: hatches / visor / MG ball
  const drvX = -W * 0.28, mgX = W * 0.28;
  if (sloped && nation === 'ussr') {
    // driver hatch on the glacis with two periscopes
    const p = onFront(drvX, 0.55, 0.02), up = V.norm(V.cross([1, 0, 0], n));
    gb.st = ST.paint; gb.box(basis(p, [1, 0, 0], n, 0.5, 0.05, 0.55));
    gb.st = ST.dark; for (const s of [-1, 1]) gb.box(basis(V.add(V.add(p, V.mul(n, 0.05)), V.mul(up, 0.12)), [1, 0, 0], n, 0.1, 0.05, 0.05).multiply(M(s * 1.4, 0, 0)));
  } else if (!sloped) {
    const p = onFront(drvX, 0.62, 0.03);
    gb.st = ST.paint; gb.box(M(p[0], p[1], p[2], 0, 0, 0, 0.32, 0.12, 0.06));
    gb.st = ST.dark; gb.box(M(p[0], p[1], p[2] + 0.032, 0, 0, 0, 0.2, 0.025, 0.01));
  }
  if (zRoofF - zRoofR > 1.2 && D.turretPos[2] + D.t.L * 0.5 < zRoofF - 0.35) {
    for (const x of [drvX, mgX]) {
      gb.st = ST.paint; gb.lathe([[0, 0.035], [0.24, 0.035], [0.26, 0]], 14, M(x, top, zRoofF - 0.42, 0, 0, Math.PI / 2));
      gb.st = ST.dark; gb.box(M(x, top + 0.05, zRoofF - 0.15, 0, 0, 0, 0.16, 0.08, 0.1));
      gb.st = ST.glass; gb.box(M(x, top + 0.05, zRoofF - 0.098, 0, 0, 0, 0.12, 0.045, 0.004));
    }
  }
  if (crew.includes('radioman')) {
    const p = onFront(mgX, sloped ? 0.5 : 0.55);
    gb.st = ST.cast; gb.lathe([[0, 0.1], [0.07, 0.085], [0.11, 0.03], [0.12, -0.02]], 12, M(p[0], p[1], p[2], 0, -Math.PI / 2, 0));
    gb.st = ST.dark; gb.cyl(M(p[0], p[1], p[2] + 0.22, Math.PI / 2, 0, 0, 0.018, 0.3, 0.018), null, 6);
  }
  // --- T-28 style machine-gun turrets, M3 Lee style sponson gun
  if (look.miniTurrets) {
    for (const s of [1, -1].slice(0, look.miniTurrets)) {
      const x = s * W * 0.3, z = zRoofF - 0.55;
      gb.st = ST.paint; gb.lathe([[0, 0.5], [0.3, 0.5], [0.36, 0.42], [0.38, 0]], 14, M(x, top, z, 0, 0, Math.PI / 2));
      gb.st = ST.dark; gb.cyl(M(x, top + 0.25, z + 0.55, Math.PI / 2, 0, 0, 0.025, 0.4, 0.025), null, 6);
    }
  }
  if (look.sponsonGun) {
    const y = top - 0.38, x = -(halfTop - 0.28), z = D.frontZ(y) - 0.25;
    gb.st = ST.cast;
    gb.lathe([[0, 0.3], [0.3, 0.28], [0.36, 0.1], [0.36, -0.35]], 14, M(x, y, z, 0, -Math.PI / 2, 0));
    gb.st = ST.paint; gb.lathe([[0.045, 2.3], [0.055, 2.3], [0.07, 0.6], [0.1, 0.55], [0.1, 0.2], [0, 0.2]], 10, M(x, y, z, 0, -Math.PI / 2, 0));
  }
  // --- headlights
  const lights = nation === 'usa' ? [1, -1] : [1];
  for (const s of lights) {
    const x = s * (nation === 'usa' ? W * 0.42 : D.xT);
    const y = nation === 'usa' ? noseY + 0.12 : trackTop + 0.12;
    const z = nation === 'usa' ? D.frontZ(y) + 0.1 : Math.min(D.frontZ(trackTop + 0.1) + 0.12, G.Lt / 2 - 0.05);
    headlight(gb, x, y, z);
  }
  // --- tow hooks front and rear
  gb.st = ST.steel;
  for (const s of [1, -1]) {
    gb.box(M(s * W * 0.35, h.clr + 0.12, D.frontZ(h.clr + 0.12) + 0.06, 0, 0, 0, 0.06, 0.12, 0.14));
    gb.box(M(s * W * 0.35, h.clr + 0.2, D.rearZ(h.clr + 0.2) - 0.06, 0, 0, 0, 0.06, 0.12, 0.14));
  }
  // --- engine deck: two louvred grilles and an access hatch
  const deckL = Math.min(1.5, (zRoofF - zRoofR) * 0.33), zc = zRoofR + deckL / 2 + 0.08;
  if ((h.engine ?? 'rear') === 'rear' && deckL > 0.5) {
    for (const s of [1, -1]) {
      const gx = s * halfTop * 0.5, gw = halfTop * 0.62;
      gb.st = ST.dark; gb.box(M(gx, top + 0.01, zc, 0, 0, 0, gw, 0.02, deckL * 0.85));
      gb.st = ST.paint;
      const ns = 7;
      for (let k = 0; k < ns; k++) gb.box(M(gx, top + 0.03, zc - deckL * 0.4 + deckL * 0.8 * k / (ns - 1), 0.5, 0, 0, gw * 0.96, 0.012, 0.07));
    }
    gb.st = ST.paint; gb.box(M(0, top + 0.012, zc, 0, 0, 0, halfTop * 0.3, 0.025, deckL * 0.8));
    info.engine = [0, top + 0.1, zc];
  } else info.engine = [0, top + 0.1, zRoofF - 0.8];
  // --- tools and tow cable on the sponsons
  const toolsX = halfTop - 0.14, zt = (zRoofR + zRoofF) / 2 - 0.25;
  if (halfTop > W / 2 + 0.1 || fullW > 2.6) {
    // left: shovel + pick; right: crowbar + axe
    gb.st = ST.wood; gb.cyl(M(toolsX, top + 0.03, zt, Math.PI / 2, 0, 0, 0.018, 1.0, 0.018), null, 6);
    gb.st = ST.steel; gb.box(M(toolsX, top + 0.025, zt + 0.6, 0, 0, 0, 0.18, 0.012, 0.24));
    gb.st = ST.wood; gb.cyl(M(toolsX - 0.14, top + 0.03, zt - 0.2, Math.PI / 2, 0, 0, 0.02, 0.85, 0.02), null, 6);
    gb.st = ST.steel; gb.box(M(toolsX - 0.14, top + 0.03, zt - 0.62, 0, 0, 0, 0.5, 0.035, 0.035));
    gb.st = ST.steel; gb.cyl(M(-toolsX, top + 0.025, zt, Math.PI / 2, 0, 0, 0.016, 1.3, 0.016), null, 6);
    gb.st = ST.wood; gb.cyl(M(-toolsX + 0.12, top + 0.03, zt + 0.1, Math.PI / 2, 0, 0, 0.018, 0.75, 0.018), null, 6);
    gb.st = ST.steel; gb.box(M(-toolsX + 0.12, top + 0.03, zt + 0.5, 0, 0, 0, 0.14, 0.03, 0.08));
    // tow cable along the right side
    gb.st = ST.steel;
    const zc0 = zRoofR + 0.3, zc1 = zRoofF - 0.4, xc = -(halfTop - 0.33);
    if (zc1 - zc0 > 1) { gb.cyl(M(xc, top + 0.025, (zc0 + zc1) / 2, Math.PI / 2, 0, 0, 0.02, zc1 - zc0, 0.02), null, 6); gb.cyl(M(xc + 0.06, top + 0.025, (zc0 + zc1) / 2, Math.PI / 2, 0, 0, 0.02, zc1 - zc0, 0.02), null, 6); }
  }
  // --- exhausts, rear equipment
  const ex = [];
  if (nation === 'germany') {
    for (const s of [1, -1]) {
      const y = h.clr + h.H * 0.55, z = D.rearZ(y) - 0.13, x = s * W * 0.3;
      gb.st = ST.dark; gb.cyl(M(x, y, z, 0, 0, 0, 0.1, 0.5, 0.1), null, 10);
      gb.st = ST.steel; gb.cyl(M(x, y + 0.3, z, 0, 0, 0, 0.04, 0.2, 0.04), null, 6);
      gb.st = ST.paint; gb.box(M(x, y, z - 0.1, 0, 0, 0, 0.24, 0.5, 0.012));
      ex.push([x, y + 0.42, z]);
    }
    if (look.stowage !== false) { gb.st = ST.paint; gb.box(M(0, h.clr + h.H * 0.7, D.rearZ(h.clr + h.H * 0.7) - 0.1, 0, 0, 0, W * 0.25, 0.28, 0.2)); }
  } else if (nation === 'ussr') {
    for (const s of [1, -1]) {
      const y = h.clr + h.H * 0.45, x = s * W * 0.3, z = D.rearZ(y);
      gb.st = ST.paint; gb.cyl(M(x, y, z - 0.03, Math.PI / 2 - 0.6, 0, 0, 0.1, 0.12, 0.1), null, 10);
      gb.st = ST.dark; gb.cyl(M(x, y - 0.02, z - 0.07, Math.PI / 2 - 0.6, 0, 0, 0.06, 0.12, 0.06), null, 8);
      ex.push([x, y - 0.05, z - 0.12]);
    }
    const y = h.clr + h.H * 0.62, z = D.rearZ(y);
    gb.st = ST.paint; gb.lathe([[0, 0.04], [0.32, 0.04], [0.34, 0]], 16, basis([0, y, z], [1, 0, 0], V.norm(V.mul(D.pc.hullUpper.planes[2].n, 1)), 1, 1, 1).multiply(M(0, 0, 0, 0, 0, Math.PI / 2)));
    // external fuel drums on the rear sides
    if (look.stowage !== false) for (const s of [1, -1]) for (const zz of [-0.2, -0.36]) {
      const yy = top - 0.24, xx = s * (D.sideX(yy) + 0.2);
      gb.st = ST.paint; gb.cyl(M(xx, yy, h.L * zz, Math.PI / 2, 0, 0, 0.17, 0.6, 0.17), null, 12);
      gb.st = ST.dark; gb.cyl(M(xx, yy, h.L * zz, Math.PI / 2, 0, 0, 0.175, 0.03, 0.175), null, 12);
    }
  } else {
    // US: exhaust deflector under the rear, stowage rack with bedrolls
    const y = h.clr + 0.25, z = D.rearZ(y) - 0.1;
    gb.st = ST.paint; gb.box(M(0, y, z, -0.3, 0, 0, W * 0.8, 0.35, 0.02));
    ex.push([W * 0.25, y - 0.1, z - 0.1], [-W * 0.25, y - 0.1, z - 0.1]);
    if (look.stowage !== false) {
      const yr = top - 0.05, zr = D.rearZ(yr) - 0.12;
      gb.st = ST.steel; gb.box(M(0, yr, zr, 0, 0, 0, fullW * 0.8, 0.04, 0.03));
      gb.st = ST.tarp; gb.cyl(M(0.35, yr + 0.12, zr + 0.05, 0, 0, Math.PI / 2, 0.14, 1.0, 0.14), null, 10);
      gb.st = ST.canvas; gb.cyl(M(-0.5, yr + 0.1, zr + 0.02, 0, 0, Math.PI / 2, 0.12, 0.7, 0.12), null, 10);
    }
  }
  info.exhausts = ex;
  // --- antenna mount on the hull (Germany)
  if (nation === 'germany') { gb.st = ST.steel; gb.cyl(M(-halfTop + 0.2, top + 0.75, zRoofR + 0.25, 0, 0, 0, 0.007, 1.5, 0.007), null, 4); }
}

// Bogie / spring hardware that doesn't spin (in the running-gear mesh).
function suspension(gb, G, xs, side, lod) {
  if (lod) return;
  const { style, R, yW, bogies, yTop } = G;
  gb.st = ST.paint;
  for (const b of bogies) {
    const x = xs * side;
    if (style === 'vvss') {
      // bracket rising between the wheel pair, volute springs, arms to the hubs, roller post, skid
      gb.box(M(x, yW + R * 0.85, b.z, 0, 0, 0, 0.22, R * 1.1, b.d * 0.34));
      gb.box(M(x, yW + R * 1.35, b.z - b.d * 0.05, 0, 0, 0, 0.24, R * 0.25, b.d * 0.62));
      gb.st = ST.steel; for (const s of [-1, 1]) gb.cyl(M(x + side * 0.05, yW + R * 0.55, b.z + s * b.d * 0.12, 0, 0, 0, 0.055, R * 0.7, 0.055), null, 8);
      gb.st = ST.paint; for (const s of [-1, 1]) gb.box(M(x + side * 0.09, yW + R * 0.25, b.z + s * b.d * 0.28, s * 0.6, 0, 0, 0.06, 0.09, b.d * 0.42));
      gb.box(M(x, (yW + R * 1.4 + yTop) / 2 - 0.06, b.z - b.d * 0.18, 0, 0, 0, 0.09, Math.max(0.05, yTop - yW - R * 1.4 - 0.1), 0.12));
    } else if (style === 'hvss') {
      gb.box(M(x - side * 0.1, yW + R * 0.5, b.z, 0, 0, 0, 0.12, R * 0.7, b.d * 0.5));
      gb.st = ST.steel; gb.cyl(M(x, yW + R * 0.9, b.z, Math.PI / 2, 0, 0, 0.06, b.d * 0.7, 0.06), null, 8);
      gb.st = ST.paint; gb.box(M(x, (yW + R + yTop) / 2 - 0.05, b.z - b.d * 0.18, 0, 0, 0, 0.08, Math.max(0.05, yTop - yW - R - 0.12), 0.1));
    } else if (style === 'leaf') {
      gb.box(M(x - side * 0.03, yW + R * 0.2, b.z, 0, 0, 0, 0.1, 0.16, b.d * 0.3));
      gb.st = ST.steel; gb.box(M(x - side * 0.03, yW + R * 0.95, b.z, 0, 0, 0, 0.12, 0.06, b.d * 0.9));
      gb.st = ST.paint; for (const s of [-1, 1]) gb.box(M(x - side * 0.03, yW + R * 0.55, b.z + s * b.d * 0.3, s * 0.9, 0, 0, 0.08, 0.06, b.d * 0.35));
    }
    gb.st = ST.paint;
  }
  if (style === 'torsion' || style === 'christie') {
    // short swing arms visible behind the wheels
    gb.st = ST.paint;
    for (const w of G.wheels) gb.box(M(side * (xs - 0.12), yW + 0.06, w.z + 0.14, 0.4, 0, 0, 0.08, 0.1, 0.34));
  }
}

// ------------------------------------------------------------------ turret details
// Commander's cupola = armor.cupola's octagonal prism (drawn down a little further so it meets a
// rounded cast roof), a dark vision-slit band and a hatch lid.
function cupola(gb, D, lod) {
  const cup = D.arm.cupola;
  if (!cup) return;
  const H = D.t.H, [cx, , cz] = cup.c, r = cup.r, hc = cup.h;
  const planes = cup.planes.map((p) => (p.plate === 'cupola.floor' ? { ...p, d: -(H - 0.22) } : p));
  gb.st = D.cast ? ST.cast : ST.paint;
  const faces = solidFaces(planes);
  for (const f of faces) if (f.plane.n[1] > -0.5) gb.plate(f.verts, f.plane.n, lod ? 0 : 0.015, 0.6, !lod);
  if (lod) return;
  gb.st = ST.dark; // vision slits
  for (const f of faces) {
    const n = f.plane.n;
    if (Math.abs(n[1]) > 0.5) continue;
    const t = [-n[2], 0, n[0]], half = r * Math.tan(Math.PI / 8) * 0.8, c = [cx + n[0] * (r + 0.003), H + hc * 0.55, cz + n[2] * (r + 0.003)];
    const P = (a, b) => V.add(c, V.add(V.mul(t, a * half), [0, b * 0.025, 0]));
    const ids = [P(-1, -1), P(1, -1), P(1, 1), P(-1, 1)].map((p) => gb.v(p[0], p[1], p[2], n[0], n[1], n[2]));
    gb.quad(ids[0], ids[1], ids[2], ids[3], n);
  }
  gb.st = ST.paint; // hatch lid
  gb.lathe([[0, 0.03], [r * 0.78, 0.03], [r * 0.82, 0]], 16, M(cx, H + hc, cz, 0, 0, Math.PI / 2));
  gb.st = ST.steel; gb.box(M(cx, H + hc + 0.03, cz - r * 0.75, 0, 0, 0, 0.14, 0.05, 0.06));
}
function turretDetails(gb, D, def) {
  const { t, nation } = D;
  const H = t.H, zo = t.zOff || 0;
  const roofY = H;
  const look = def.look || {};
  const cupSide = D.arm.cupola ? Math.sign(D.arm.cupola.c[0]) : look.cupola === 'right' ? -1 : look.cupola === 'center' ? 0 : look.cupola === 'left' ? 1 : nation === 'usa' ? -1 : 1;
  const Wr = D.tSideX(H) * 2, zF = D.tFrontZ(H), zR = D.tRearZ(H);
  const Lr = zF - zR;
  if (D.open) return;
  // --- commander's cupola: drawn from the armour's cupola solid (a weak-spot hitbox)
  const cup = D.arm.cupola;
  if (cup) {
    const [cx, , cz] = cup.c, r = cup.r, hc = cup.h;
    cupola(gb, D, 0);
    if (nation === 'usa') { // vision blocks around the ring + .50 cal on a pintle
      gb.st = ST.dark;
      for (let k = 0; k < 6; k++) { const a = k / 6 * Math.PI * 2; gb.box(M(cx + Math.cos(a) * r * 0.72, roofY + hc + 0.035, cz + Math.sin(a) * r * 0.72, 0, -a, 0, 0.07, 0.07, 0.09)); }
      const mx = cx - Math.sign(cx || 1) * 0.02, mz = cz - r - 0.12;
      gb.st = ST.steel; gb.cyl(M(mx, roofY + 0.25, mz, 0, 0, 0, 0.025, 0.5, 0.025), null, 6);
      gb.st = ST.dark; gb.box(M(mx, roofY + 0.52, mz + 0.1, 0, 0, 0, 0.1, 0.12, 0.42));
      gb.cyl(M(mx, roofY + 0.54, mz + 0.85, Math.PI / 2, 0, 0, 0.022, 1.05, 0.022), null, 6);
      gb.st = ST.paint; gb.box(M(mx + 0.1, roofY + 0.48, mz + 0.05, 0, 0, 0, 0.1, 0.14, 0.2));
    } else if (nation === 'ussr') {
      gb.st = ST.dark; gb.box(M(cx, roofY + hc + 0.07, cz + r * 0.3, 0, 0, 0, 0.12, 0.1, 0.14));
    }
  }
  // --- loader hatch + periscopes
  const hx = -cupSide * Wr * 0.22 || Wr * 0.22;
  gb.st = ST.paint;
  if (nation === 'ussr' || nation === 'usa') gb.lathe([[0, 0.03], [0.26, 0.03], [0.28, 0]], 14, M(hx, roofY, zR + Lr * 0.42, 0, 0, Math.PI / 2));
  else gb.box(M(hx, roofY + 0.015, zR + Lr * 0.38, 0, 0, 0, 0.5, 0.03, 0.55));
  for (const [x, z] of [[hx, zR + Lr * 0.65], [-hx * 0.35, zF - Lr * 0.12]]) {
    gb.st = ST.paint; gb.box(M(x, roofY + 0.05, z, 0, 0, 0, 0.15, 0.1, 0.18));
    gb.st = ST.glass; gb.box(M(x, roofY + 0.06, z + 0.092, 0, 0, 0, 0.12, 0.05, 0.004));
  }
  // --- ventilator / lifting hooks
  gb.st = ST.paint;
  gb.cyl(M(0, roofY + 0.04, zR + Lr * 0.62, 0, 0, 0, 0.1, 0.08, 0.1), null, 10);
  gb.cyl(M(0, roofY + 0.09, zR + Lr * 0.62, 0, 0, 0, 0.14, 0.03, 0.14), null, 10);
  if (D.fixed) return;
  // --- nation-specific: German bustle box + smoke dischargers, Soviet handrails, US antenna
  if (nation === 'germany') {
    if (look.stowage !== false && t.shape !== 'cast') {
      const y = H * 0.55, z = D.tRearZ(y);
      gb.st = ST.paint; gb.box(M(0, y, z - 0.2, 0, 0, 0, Math.min(Wr * 0.85, 1.4), H * 0.5, 0.4));
      gb.st = ST.steel; gb.box(M(0, y + H * 0.25 + 0.01, z - 0.2, 0, 0, 0, Math.min(Wr * 0.85, 1.4) * 0.9, 0.015, 0.36));
    }
    for (const s of [1, -1]) {
      const y = H * 0.72, x = s * (D.tSideX(y) + 0.02), z = D.tFrontZ(y) - 0.35;
      for (let k = 0; k < 3; k++) {
        gb.st = ST.paint; gb.cyl(M(x + s * 0.06, y + (k - 1) * 0.02, z - k * 0.12, 0.5, 0, -s * 0.6, 0.045, 0.24, 0.045), null, 8);
      }
    }
  } else if (nation === 'ussr') {
    for (const s of [1, -1]) {
      const y = H * 0.55, x = s * (D.tSideX(y) + 0.06), z0 = zo - t.L * 0.25, z1 = zo + t.L * 0.12;
      gb.st = ST.paint; gb.cyl(M(x, y, (z0 + z1) / 2, Math.PI / 2, 0, 0, 0.015, z1 - z0, 0.015), null, 6);
      for (const z of [z0, z1]) gb.cyl(M(x - s * 0.03, y, z, 0, 0, Math.PI / 2, 0.012, 0.07, 0.012), null, 4);
    }
    gb.st = ST.steel; gb.cyl(M(-cupSide * Wr * 0.35, H + 0.75, zR + 0.4, 0, 0, 0, 0.007, 1.5, 0.007), null, 4);
  } else {
    gb.st = ST.steel; gb.cyl(M(-cupSide * Wr * 0.3, H + 0.8, zR + 0.2, 0, 0, 0, 0.007, 1.6, 0.007), null, 4);
  }
}

// Cast turret: loft the solid's horizontal sections with rounded corners (Minkowski rounding of
// the inset section) and a rounded top edge. Stays inside the armour solid (the hitbox).
function castLoft(gb, planes, H, zc, r, rt, M_ = 36) {
  const hp = planes.filter((p) => Math.abs(p.n[1]) < 0.999);
  const section = (y, inset) => {
    let poly = [[-20, -20], [20, -20], [20, 20], [-20, 20]];
    for (const p of hp) {
      let a = p.n[0], b = p.n[2], c = p.d - p.n[1] * y; const l = Math.hypot(a, b); a /= l; b /= l; c = c / l - inset;
      const out = [];
      for (let k = 0; k < poly.length; k++) {
        const P = poly[k], Q = poly[(k + 1) % poly.length];
        const fp = a * P[0] + b * P[1] - c, fq = a * Q[0] + b * Q[1] - c;
        if (fp <= 0) out.push(P);
        if ((fp < 0) !== (fq < 0)) { const t = fp / (fp - fq); out.push([P[0] + (Q[0] - P[0]) * t, P[1] + (Q[1] - P[1]) * t]); }
      }
      poly = out;
      if (poly.length < 3) return null;
    }
    return poly;
  };
  const dist = (poly, x, z) => { // distance from a point to a convex polygon (0 inside)
    let inside = true, best = Infinity;
    for (let k = 0; k < poly.length; k++) {
      const P = poly[k], Q = poly[(k + 1) % poly.length], ex = Q[0] - P[0], ez = Q[1] - P[1];
      if ((x - P[0]) * ez - (z - P[1]) * ex > 0) inside = false; // CCW polygon in (x, z)? handled by both signs below
      const t = clamp(((x - P[0]) * ex + (z - P[1]) * ez) / (ex * ex + ez * ez || 1), 0, 1);
      best = Math.min(best, Math.hypot(x - P[0] - ex * t, z - P[1] - ez * t));
    }
    return best;
  };
  const inPoly = (poly, x, z) => { let s0 = 0; for (let k = 0; k < poly.length; k++) { const P = poly[k], Q = poly[(k + 1) % poly.length]; const c = (Q[0] - P[0]) * (z - P[1]) - (Q[1] - P[1]) * (x - P[0]); if (c !== 0) { if (s0 === 0) s0 = Math.sign(c); else if (Math.sign(c) !== s0) return false; } } return true; };
  const levels = [];
  const rows = [[0, 0], [(H - rt) * 0.5, 0], [H - rt, 0]];
  for (let j = 1; j <= 4; j++) { const f = (j / 4) * Math.PI / 2; rows.push([H - rt + rt * Math.sin(f), rt * (1 - Math.cos(f))]); }
  for (const [y, e] of rows) {
    let rr = r, poly = section(y, r + e);
    while (!poly && rr > 0.01) { rr *= 0.6; poly = section(y, rr + e); }
    if (!poly) continue;
    const ring = [];
    for (let k = 0; k < M_; k++) {
      const a = (k / M_) * Math.PI * 2, ux = Math.sin(a), uz = Math.cos(a);
      let lo = 0, hi = 12;
      for (let it = 0; it < 22; it++) { const m = (lo + hi) / 2, x = ux * m, z = zc + uz * m; if (inPoly(poly, x, z) || dist(poly, x, z) <= rr) lo = m; else hi = m; }
      ring.push([ux * lo, y, zc + uz * lo]);
    }
    levels.push({ ring, y, edge: e > 0 ? 0.3 : 0 });
  }
  const nL = levels.length, idx = [];
  for (let i = 0; i < nL; i++) {
    const row = [];
    for (let k = 0; k < M_; k++) {
      const p = levels[i].ring[k];
      const pa = levels[i].ring[(k + 1) % M_], pb = levels[i].ring[(k + M_ - 1) % M_];
      const qa = levels[Math.min(nL - 1, i + 1)].ring[k], qb = levels[Math.max(0, i - 1)].ring[k];
      let n = V.norm(V.cross(V.sub(qa, qb), V.sub(pa, pb)));
      if (V.dot(n, [p[0], 0, p[2] - zc]) < 0 && n[1] < 0.99) n = V.mul(n, -1);
      if (i === nL - 1) n = V.norm(V.add(n, [0, 0.6, 0]));
      row.push(gb.v(p[0], p[1], p[2], n[0], n[1], n[2], levels[i].edge));
    }
    idx.push(row);
  }
  for (let i = 0; i < nL - 1; i++) for (let k = 0; k < M_; k++) {
    const a = idx[i][k], b = idx[i][(k + 1) % M_], c = idx[i + 1][(k + 1) % M_], d = idx[i + 1][k];
    const p = levels[i].ring[k];
    gb.quad(a, b, c, d, V.norm([p[0], 0.2, p[2] - zc]));
  }
  const top = levels[nL - 1];
  const cId = gb.v(0, top.y, zc, 0, 1, 0, 0);
  const tIds = top.ring.map((p) => gb.v(p[0], p[1], p[2], 0, 1, 0, 0));
  for (let k = 0; k < M_; k++) gb.tri(cId, tIds[k], tIds[(k + 1) % M_], [0, 1, 0]);
}

// Open-topped turret: inner walls, floor and a rim instead of a roof.
function openTurret(gb, faces, D, cal) {
  const H = D.t.H;
  gb.st = ST.interior;
  for (const f of faces) {
    const n = f.plane.n, pl = f.plane.plate;
    if (pl === 'turret.floor' || pl === 'turret.open') continue;
    const inner = f.verts.map((v) => V.sub(v, V.mul(n, 0.03)));
    gb.plate(inner.slice().reverse(), V.mul(n, -1), 0, 0, false);
    gb.st = ST.paint;
    const top = f.verts.map((v, i) => [v, inner[i]]).filter(([v]) => Math.abs(v[1] - H) < 1e-3);
    if (top.length === 2) {
      const ids = [gb.v(...top[0][0], 0, 1, 0, 1), gb.v(...top[1][0], 0, 1, 0, 1), gb.v(...top[1][1], 0, 1, 0, 1), gb.v(...top[0][1], 0, 1, 0, 1)];
      gb.quad(ids[0], ids[1], ids[2], ids[3], [0, 1, 0]);
    }
    gb.st = ST.interior;
  }
  const roof = faces.find((f) => f.plane.plate === 'turret.open');
  if (roof) gb.plate(roof.verts.map((v) => [v[0] * 0.95, 0.1, v[2] * 0.95 + (D.t.zOff || 0) * 0.05]), [0, 1, 0], 0, 0, false);
  // crew-less fighting compartment: ammo racks along the walls, radio on the rear wall, seats
  const zF = D.tFrontZ(0.4), zR = D.tRearZ(0.4), rs = clamp(cal / 2000 * 1.3, 0.02, 0.07);
  for (const s of [1, -1]) {
    const x = s * (D.tSideX(0.35) - 0.03 - 0.12), z0 = zR + 0.25, z1 = Math.max(z0 + 0.3, zF - 0.55);
    gb.st = ST.interior; gb.box(M(x, 0.33, (z0 + z1) / 2, 0, 0, 0, 0.22, 0.46, z1 - z0));
    gb.st = ST.brass;
    const n = Math.max(2, Math.floor((z1 - z0) / (rs * 2.6)));
    for (let k = 0; k < n; k++) gb.cyl(M(x, 0.6, z0 + (z1 - z0) * (k + 0.5) / n, 0, 0, 0, rs, 0.12, rs), null, 8);
  }
  gb.st = ST.radio; gb.box(M(D.tSideX(0.6) * 0.35, 0.62, zR + 0.2, 0, 0, 0, 0.42, 0.3, 0.24));
  gb.st = ST.dark; for (let k = 0; k < 3; k++) gb.cyl(M(D.tSideX(0.6) * 0.35 - 0.12 + k * 0.12, 0.66, zR + 0.325, Math.PI / 2, 0, 0, 0.025, 0.01, 0.025), null, 8);
  gb.st = ST.dark; gb.box(M(-D.tSideX(0.3) * 0.4, 0.4, zR + 0.55, 0, 0, 0, 0.3, 0.06, 0.3));
  gb.box(M(-D.tSideX(0.3) * 0.4, 0.6, zR + 0.4, -0.2, 0, 0, 0.3, 0.35, 0.05));
}

// ------------------------------------------------------------------ markings
function faceBasis(f) {
  const n = f.plane.n;
  let up = V.sub([0, 1, 0], V.mul(n, n[1]));
  if (Math.hypot(...up) < 0.2) up = V.sub([0, 0, 1], V.mul(n, n[2]));
  up = V.norm(up);
  const right = V.cross(up, n);
  const c = f.verts.reduce((s, p) => V.add(s, V.mul(p, 1 / f.verts.length)), [0, 0, 0]);
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const p of f.verts) { const d = V.sub(p, c), u = V.dot(d, right), v = V.dot(d, up); u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
  return { n, up, right, c, u0, u1, v0, v1 };
}
// Quad on face f: centre at fractions (fu, fv) of the face's extent, size (w, h) metres.
function stick(gb, f, fu, fv, w, h, rect) {
  const B = faceBasis(f);
  const maxH = (B.v1 - B.v0) * 0.8;
  if (h > maxH) { w *= maxH / h; h = maxH; }
  if (w > (B.u1 - B.u0) * 0.9) { h *= (B.u1 - B.u0) * 0.9 / w; w = (B.u1 - B.u0) * 0.9; }
  const cu = B.u0 + w / 2 + (B.u1 - B.u0 - w) * fu, cv = B.v0 + h / 2 + (B.v1 - B.v0 - h) * fv;
  const c = V.add(V.add(B.c, V.mul(B.right, cu)), V.add(V.mul(B.up, cv), V.mul(B.n, 0.004)));
  const [a0, b0, a1, b1] = atlasUV(rect);
  const P = (su, sv) => V.add(c, V.add(V.mul(B.right, su * w / 2), V.mul(B.up, sv * h / 2)));
  gb.st = ST.decal;
  const n = B.n;
  const ids = [[-1, -1, a0, b0], [1, -1, a1, b0], [1, 1, a1, b1], [-1, 1, a0, b1]].map(([su, sv, u, v]) => gb.v(...P(su, sv), n[0], n[1], n[2], 0, u, v));
  gb.quad(ids[0], ids[1], ids[2], ids[3], n);
}
const sideFaces = (faces, plate) => [1, -1].map((s) => faces.filter((f) => f.plane.plate === plate && f.plane.n[0] * s > 0.5).sort((a, b) => area(b) - area(a))[0]).filter(Boolean);
function area(f) { let a = [0, 0, 0]; const v = f.verts; for (let k = 1; k < v.length - 1; k++) a = V.add(a, V.cross(V.sub(v[k], v[0]), V.sub(v[k + 1], v[0]))); return Math.hypot(...a) / 2; }
function hullMarkings(gb, upperFaces, D) {
  const sides = sideFaces(upperFaces, 'hull.side.upper');
  for (const f of sides) {
    const left = f.plane.n[0] > 0, fwd = (x) => (left ? 1 - x : x); // u runs rear→front on the right side
    if (D.nation === 'usa') stick(gb, f, fwd(0.62), 0.5, 0.55, 0.55, ATLAS.usStar);
    else if (D.nation === 'germany') stick(gb, f, fwd(0.35), 0.5, 0.45, 0.45, ATLAS.cross);
    else stick(gb, f, fwd(0.3), 0.5, 1.4, 0.35, left ? ATLAS.slogan0 : ATLAS.slogan1);
  }
  if (D.nation === 'germany') {
    const rear = upperFaces.find((f) => f.plane.plate === 'hull.rear');
    if (rear) stick(gb, rear, 0.5, 0.75, 0.35, 0.35, ATLAS.cross);
  }
  if (D.nation === 'usa') { // star on the glacis
    const fr = upperFaces.find((f) => f.plane.plate === 'hull.front.upper');
    if (fr) stick(gb, fr, 0.5, 0.72, 0.45, 0.45, ATLAS.usStar);
  }
}
function turretMarkings(gb, faces, D) {
  if (D.nation === 'ussr') for (const f of sideFaces(faces, 'turret.side')) stick(gb, f, f.plane.n[0] > 0 ? 0.8 : 0.2, 0.55, 0.36, 0.36, ATLAS.redStar);
  if (D.nation === 'usa' && D.fixed) for (const f of sideFaces(faces, 'turret.side')) stick(gb, f, 0.5, 0.5, 0.4, 0.4, ATLAS.usStar);
}
function numberMesh(faces, D, number, yOff) {
  const gb = new GB(yOff, D.dirtH);
  const digits = String(number).slice(0, 3).split('').map(Number);
  const german = D.nation === 'germany';
  for (const f of sideFaces(faces, 'turret.side')) {
    const B = faceBasis(f), left = f.plane.n[0] > 0;
    const hgt = Math.min(0.24, (B.v1 - B.v0) * 0.55), wd = hgt * 0.72;
    const tw = wd * digits.length;
    // Soviet/US: number towards the rear; German: centred
    const fu = D.nation === 'ussr' ? (left ? 0.25 : 0.75) : 0.5;
    const cu = B.u0 + tw / 2 + (B.u1 - B.u0 - tw) * fu, cv = (B.v0 + B.v1) / 2 + (B.v1 - B.v0) * 0.05;
    digits.forEach((d, i) => {
      const r = german ? ATLAS.digitG(d) : ATLAS.digitW(d);
      const [a0, b0, a1, b1] = atlasUV(r);
      const cx = cu - tw / 2 + wd * (i + 0.5);
      const c = V.add(V.add(B.c, V.mul(B.right, cx)), V.add(V.mul(B.up, cv), V.mul(B.n, 0.005)));
      const P = (su, sv) => V.add(c, V.add(V.mul(B.right, su * wd / 2), V.mul(B.up, sv * hgt / 2)));
      gb.st = ST.decal;
      const n = B.n;
      const ids = [[-1, -1, a0, b0], [1, -1, a1, b0], [1, 1, a1, b1], [-1, 1, a0, b1]].map(([su, sv, u, v]) => gb.v(...P(su, sv), n[0], n[1], n[2], 0, u, v));
      gb.quad(ids[0], ids[1], ids[2], ids[3], n);
    });
  }
  return gb.count ? gb.build() : null;
}

// ------------------------------------------------------------------ gun
function barrel(gb, gun, nation, lod) {
  const cal = gun.cal || 75, len = gun.len || 3;
  const rb = cal / 2000, rm = rb * 1.5 + 0.014, rt = rb * 1.85 + 0.02, rs = rb * 2.3 + 0.03;
  const sl = clamp(len * 0.22, 0.35, 1.2);
  const m = M(0, 0, 0, 0, -Math.PI / 2, 0); // lathe axis x → +z
  const seg = lod ? 6 : 16;
  if (lod) { gb.lathe([[rb, len, ST.paint], [rm, len], [rt, sl], [rs, sl], [rs, -0.1], [0, -0.1]], seg, m); return; }
  const brake = !!gun.muzzleBrake, bl = brake ? clamp(cal / 1000 * 4.6, 0.3, 0.6) : 0;
  const le = len - bl;
  const prof = [[rb, le - 0.35, ST.bore], [rb, le, ST.paint]];
  if (!brake && nation !== 'germany') prof.push([rm * 1.12, le], [rm * 1.12, le - 0.1], [rm, le - 0.16]); else prof.push([rm, le]);
  if (gun.evacuator) { const ze = le * 0.72; prof.push([rm * 1.02, ze + 0.25], [rm * 1.55, ze + 0.18], [rm * 1.55, ze - 0.12], [rt, ze - 0.2]); }
  prof.push([rt, sl + 0.03], [rs, sl], [rs, -0.12], [0, -0.12]);
  gb.lathe(prof, seg, m);
  if (brake) {
    const rB = rb * 3.0 + 0.02, a = le, b = len;
    gb.lathe([[rb * 1.05, b, ST.paint], [rB, b], [rB, b - bl * 0.32], [rm, b - bl * 0.32]], seg, m);
    gb.lathe([[rb, b - bl * 0.36, ST.bore], [rb, b, null]], seg, m);
    gb.lathe([[rm, b - bl * 0.62, ST.paint], [rB, b - bl * 0.62], [rB, a + 0.02], [rm, a]], seg, m);
    gb.st = ST.paint;
    for (const s of [1, -1]) gb.box(M(0, s * rB * 0.72, (a + b) / 2, 0, 0, 0, rB * 1.0, rB * 0.5, bl));
    gb.st = ST.dark; gb.cyl(M(0, 0, b - bl * 0.47, Math.PI / 2, 0, 0, rm * 0.95, bl * 0.3, rm * 0.95), null, 10);
  }
}

// ------------------------------------------------------------------ build + cache
const CACHE = new WeakMap();
function buildGeometry(def, lod, gunIndex) {
  let byDef = CACHE.get(def);
  if (!byDef) CACHE.set(def, (byDef = new Map()));
  const key = lod + ':' + gunIndex;
  if (byDef.has(key)) return byDef.get(key);
  const D = dims(def), G = gearLayout(def, D);
  const info = { exhausts: [], engine: [0, D.top, 0] };
  const hullGb = new GB(0, D.dirtH);
  const e = lod ? 0 : 0.028, rings = !lod;
  // armour solids
  const upperFaces = solidFaces(D.pc.hullUpper.planes);
  hullGb.st = ST.paint;
  for (const f of solidFaces(D.pc.hullLower.planes)) { if (f.plane.n[1] > 0.99) continue; hullGb.plate(f.verts, f.plane.n, e, 0.55, rings); }
  for (const f of upperFaces) hullGb.plate(f.verts, f.plane.n, e, 0.55, rings);
  fenders(hullGb, D, G, lod);
  if (def.look?.skirts) skirts(hullGb, D, G);
  if (!lod) { spareLinks(hullGb, D); hullDetails(hullGb, D, G, def, info); }
  else {
    info.engine = [0, D.top + 0.1, D.rearZ(D.top) + 0.8];
    info.exhausts = [[D.h.W * 0.3, D.h.clr + D.h.H * 0.5, D.rearZ(D.h.clr + D.h.H * 0.5) - 0.1]];
  }
  hullMarkings(hullGb, upperFaces, D);
  // running gear per side
  const sides = {};
  for (const side of [1, -1]) {
    const tg = lod ? hullGb : new GB(0, D.dirtH, true), wg = lod ? hullGb : new GB(0, D.dirtH);
    const xs = D.xT, x0 = side > 0 ? xs - D.tr.w / 2 : -xs - D.tr.w / 2, x1 = x0 + D.tr.w;
    trackBand(tg, G.loop, true, x0, x1, G.pitch, G.variant, side, lod);
    if (!lod) {
      const { total } = resample(G.loop, 0.05, true), pitch = total / Math.max(1, Math.round(total / G.pitch));
      tg.st = { ...ST.link, c: lin(0x46413a), spin: -1, e2: pitch, dirtK: 0.5 };
      trackTeeth(tg, G.loop, x0, x1, pitch, G.variant !== 0);
    }
    for (const w of G.wheels) {
      if (lod && G.style === 'hvss' && w.x < 0) continue; // twin wheels → one wide wheel far away
      if (lod && G.style === 'hvss') wheel(wg, 'road', side * xs, w.y, w.z, w.r, D.tr.w * 0.75, side, lod, D.nation);
      else wheel(wg, 'road', side * (xs + w.x), w.y, w.z, w.r, w.w, side, lod, D.nation);
    }
    wheel(wg, 'sprocket', side * xs, G.yS, G.zS, G.Rs, D.tr.w * 0.8, side, lod, D.nation);
    wheel(wg, 'idler', side * xs, G.yI, G.zI, G.Ri, D.tr.w * 0.6, side, lod, D.nation);
    if (!lod) for (const r of G.rollers) wheel(wg, 'roller', side * (xs + r.x), r.y, r.z, r.r, r.w, side, lod, D.nation);
    suspension(wg, G, xs, side, lod);
    if (!lod) {
      // broken track: the run lies flat on the ground ahead of the tank, a stub hangs off the sprocket
      const bg = new GB(0, D.dirtH);
      const z0 = G.zLo - G.R, z1 = G.Lt / 2 + 2.6;
      trackBand(bg, [[z0, TT / 2], [z1, TT / 2]], false, side > 0 ? xs - D.tr.w / 2 : -xs - D.tr.w / 2, side > 0 ? xs + D.tr.w / 2 : -xs + D.tr.w / 2, G.pitch, G.variant, side, 0);
      const zb = G.front ? G.zS : G.zI, yb = G.front ? G.yS : G.yI, rb = G.front ? G.Rs : G.Ri;
      trackBand(bg, [[zb + rb * 0.3, yb + rb + TT / 2], [zb - rb * 0.6, yb + rb * 0.8], [zb - rb * 1.2, yb - rb * 0.2], [zb - rb * 1.1, yb - rb * 1.6]], false,
        side > 0 ? xs - D.tr.w / 2 : -xs - D.tr.w / 2, side > 0 ? xs + D.tr.w / 2 : -xs + D.tr.w / 2, G.pitch, G.variant, side, 0);
      sides[side] = { track: tg.build(), wheels: wg.build(), broken: bg.build() };
    }
  }
  // turret (turret frame)
  const yT = D.turretPos[1];
  const turGb = new GB(yT, D.dirtH);
  const tFaces = solidFaces(D.pc.turret.planes);
  turGb.st = D.cast ? ST.cast : ST.paint;
  const te = lod ? 0 : D.cast ? 0.09 : 0.03, tilt = D.cast ? 1.0 : 0.55;
  if (D.cast && !lod) castLoft(turGb, D.pc.turret.planes, D.t.H, D.t.zOff || 0, Math.min(D.t.W, D.t.L) * 0.2, D.t.H * 0.3);
  else for (const f of tFaces) {
    const pl = f.plane.plate;
    if (pl === 'turret.floor' || (D.open && pl === 'turret.open')) continue;
    turGb.plate(f.verts, f.plane.n, te, tilt, rings);
  }
  const gunDef = (def.guns ? def.guns[gunIndex] || def.guns[0] : def.gun) || { cal: 75, len: 3 };
  if (D.open && !lod) openTurret(turGb, tFaces, D, gunDef.cal);
  if (!lod) turretDetails(turGb, D, def);
  else cupola(turGb, D, 1);
  turretMarkings(turGb, tFaces, D);
  // mantlet (yaws with the gun, doesn't pitch — it's the hitbox)
  let mantlet = null;
  if (D.pc.mantlet) {
    const mg = new GB(yT, D.dirtH);
    mg.st = D.cast ? ST.cast : ST.paint;
    for (const f of solidFaces(D.pc.mantlet.planes)) mg.plate(f.verts, f.plane.n, lod ? 0 : D.cast ? 0.06 : 0.03, 0.8, rings);
    mantlet = mg.build();
  }
  // gun (pitches about the pivot; recoils along −z)
  const gun = (def.guns ? def.guns[gunIndex] || def.guns[0] : def.gun) || { cal: 75, len: 3 };
  const piv = D.arm.gun.pivot;
  const gg = new GB(yT + piv[1], D.dirtH);
  barrel(gg, gun, D.nation, lod);
  if (!lod && D.open) { // breech block and recoil cylinders, visible from above
    const rb = gun.cal / 2000;
    gg.st = ST.steel; gg.box(M(0, 0, -0.5, 0, 0, 0, rb * 7 + 0.08, rb * 6 + 0.08, 0.7));
    gg.st = ST.paint; for (const s of [1, -1]) gg.cyl(M(s * (rb * 2.5 + 0.05), rb * 2 + 0.03, -0.2, Math.PI / 2, 0, 0, 0.04, 0.7, 0.04), null, 8);
    gg.st = ST.steel; gg.box(M(rb * 5 + 0.1, -0.05, -0.55, 0, 0, 0, 0.04, 0.3, 0.3));
  }
  if (!lod) { // collar that pitches with the gun inside the mantlet
    const rc = clamp(gun.cal / 2000 * 3.2 + 0.05, 0.1, 0.24);
    gg.st = D.cast ? ST.cast : ST.paint;
    gg.lathe([[0, 0.16], [rc * 0.8, 0.16], [rc, 0.08], [rc, -0.2]], 14, M(0, 0, 0, 0, -Math.PI / 2, 0));
  }
  const out = {
    D, G, info: { ...info, top: D.top, trackRear: -G.Lt / 2, trackFront: G.Lt / 2, xT: D.xT, muzzleLen: gun.len, cal: gun.cal, recoil: clamp(gun.cal / 1000 * 5, 0.22, 0.6) },
    hull: hullGb.build(), sides, turret: turGb.build(), mantlet, gun: gg.build(), tFaces,
  };
  byDef.set(key, out);
  return out;
}

// Triangle count of a model group (for notes / budgets).
export function triCount(obj) {
  let n = 0;
  obj.traverse((o) => { if (o.isMesh && o.visible) { const g = o.geometry; n += (g.index ? g.index.count : g.attributes.position.count) / 3; } });
  return n;
}

let _numCache = new Map();
export function buildTankModel(def, opts = {}) {
  const lod = opts.lod === 'low' || opts.lod === 1 || opts.lod === 'far' ? 1 : 0;
  const gunIndex = opts.gunIndex || 0;
  const G = buildGeometry(def, lod, gunIndex);
  const D = G.D;
  const paint = resolvePaint(def, opts.paint);
  let seed = 7; for (const ch of def.id) seed = (seed * 31 + ch.charCodeAt(0)) % 9973;
  const base = tankMaterial(paint, false, seed), charred = tankMaterial(paint, true, seed);
  const group = new THREE.Group(); group.name = 'tank:' + def.id;
  const body = new THREE.Group(); group.add(body);
  const mk = (geo, mat, parent, name) => { const m = new THREE.Mesh(geo, mat); m.name = name; m.castShadow = true; m.receiveShadow = true; parent.add(m); return m; };
  const hull = mk(G.hull, base, body, 'hull');
  const runMats = { 1: lod ? base : cloneMat(base), '-1': lod ? base : cloneMat(base) };
  const parts = { hull, body, trackL: null, trackR: null, wheelsL: null, wheelsR: null };
  const broken = {};
  if (!lod) for (const side of [1, -1]) {
    const S = G.sides[side], sg = new THREE.Group(); sg.name = side > 0 ? 'sideL' : 'sideR'; group.add(sg);
    const tr = mk(S.track, runMats[side], sg, 'track'), wh = mk(S.wheels, runMats[side], sg, 'wheels');
    const br = mk(S.broken, base, sg, 'brokenTrack'); br.visible = false;
    broken[side] = br;
    if (side > 0) { parts.trackL = tr; parts.wheelsL = wh; } else { parts.trackR = tr; parts.wheelsR = wh; }
  }
  const base3 = new THREE.Group(); base3.name = 'turretBase';
  base3.position.fromArray(D.turretPos); body.add(base3);
  const yaw = new THREE.Group(); yaw.name = 'yaw'; base3.add(yaw);
  const turret = mk(G.turret, base, D.fixed ? base3 : yaw, 'turret');
  let numbers = null;
  let num = opts.number ?? def.look?.number;
  if (num === true) { let hsh = 7; for (const ch of def.id) hsh = (hsh * 31 + ch.charCodeAt(0)) % 997; num = 100 + (hsh * 7) % 900; }
  if (!lod && num != null && num !== false) {
    const k = def.id + ':' + num;
    let ng = _numCache.get(k);
    if (ng === undefined) { ng = numberMesh(G.tFaces, D, num, D.turretPos[1]); _numCache.set(k, ng); }
    if (ng) numbers = mk(ng, base, turret, 'numbers');
  }
  const mantlet = G.mantlet ? mk(G.mantlet, base, yaw, 'mantlet') : null;
  const pivot = new THREE.Group(); pivot.name = 'gunPivot'; pivot.position.fromArray(D.arm.gun.pivot); yaw.add(pivot);
  const gun = mk(G.gun, base, pivot, 'gun');
  Object.assign(parts, { turret: D.fixed ? yaw : yaw, turretMesh: turret, mantlet, gun: pivot, gunMesh: gun, yaw, turretBase: base3, numbers });
  const meshes = []; group.traverse((o) => o.isMesh && meshes.push(o));
  const liveMat = new Map(meshes.map((m) => [m, m.material]));

  const st = { travelL: 0, travelR: 0, dead: false, tracks: [false, false], burning: false, fly: null, opacity: 1, fadeMats: null };
  const hw = D.xT;
  const model = {
    group, parts, def, lod, info: G.info,
    update(s = {}, dt = 0) {
      yaw.rotation.y = s.turretYaw || 0;
      pivot.rotation.x = -(s.gunPitch || 0);
      gun.position.z = -(s.recoil || 0);
      body.rotation.set(-(s.bodyPitch || 0), 0, s.bodyRoll || 0);
      body.position.y = s.bodyY || 0;
      if (!st.dead && dt > 0) {
        const v = s.speed || 0, w = s.yawRate || 0;
        if (!st.tracks[0]) st.travelL = (st.travelL + (v - w * hw) * dt) % 1000;
        if (!st.tracks[1]) st.travelR = (st.travelR + (v + w * hw) * dt) % 1000;
        if (!lod) { runMats[1].userData.uTravel.value = st.travelL; runMats[-1].userData.uTravel.value = st.travelR; }
      }
      if (st.fly) flyTurret(dt);
    },
    setDamage(d = {}) {
      if (d.tracks != null && !lod) {
        const t = Array.isArray(d.tracks) ? d.tracks : typeof d.tracks === 'object' ? [!!d.tracks.L, !!d.tracks.R] : [!!d.tracks, !!d.tracks];
        st.tracks = t;
        parts.trackL.visible = !t[0]; broken[1].visible = t[0];
        parts.trackR.visible = !t[1]; broken[-1].visible = t[1];
      }
      if (d.burning != null) st.burning = !!d.burning;
      if (d.dead && !st.dead) {
        st.dead = true;
        for (const m of meshes) { liveMat.set(m, charred); m.material = charred; }
        st.opacity = 1; st.fadeMats = null;
        if (d.ammorack && !D.fixed) startFly(d.seed ?? Math.random());
      } else if (d.dead === false && st.dead) {
        st.dead = false;
        for (const m of meshes) { const mat = m === parts.trackL || m === parts.wheelsL ? runMats[1] : m === parts.trackR || m === parts.wheelsR ? runMats[-1] : base; liveMat.set(m, mat); m.material = mat; }
        base3.position.fromArray(D.turretPos); base3.rotation.set(0, 0, 0); st.fly = null;
      }
    },
    // 0..1; below 1 swaps to per-instance transparent clones (same program)
    setOpacity(a) {
      if (a >= 0.999) {
        if (st.fadeMats) { for (const m of meshes) m.material = liveMat.get(m); st.fadeMats = null; }
        return;
      }
      if (!st.fadeMats) {
        st.fadeMats = new Map();
        for (const m of meshes) {
          const src = liveMat.get(m);
          let c = st.fadeMats.get(src);
          if (!c) { c = cloneMat(src, true); c.userData.uTravel = src.userData.uTravel; attachShader(c); st.fadeMats.set(src, c); }
          m.material = c;
        }
      }
      for (const c of st.fadeMats.values()) c.opacity = a;
    },
    get state() { return st; },
    dispose() {
      if (!lod) { runMats[1].dispose(); runMats[-1].dispose(); }
      if (st.fadeMats) for (const c of st.fadeMats.values()) c.dispose();
      group.removeFromParent();
    },
  };
  // Ammo rack: the turret is thrown up and lands beside the hull.
  function startFly(seed) {
    const r = (k) => { const x = Math.sin(seed * 9301 + k * 49297) * 43758.5453; return x - Math.floor(x); };
    const side = r(1) < 0.5 ? 1 : -1;
    const ang = (r(2) - 0.5) * 1.6;
    const dist = 3.5 + r(3) * 3;
    st.fly = {
      t: 0, p: new THREE.Vector3().fromArray(D.turretPos),
      v: new THREE.Vector3(Math.cos(ang) * side * dist / 1.9, 9 + r(4) * 3, Math.sin(ang) * dist / 1.9),
      w: new THREE.Vector3((r(5) - 0.5) * 6, (r(6) - 0.5) * 5, side * (2 + r(7) * 2)),
      rest: new THREE.Euler((r(8) - 0.5) * 0.5, r(9) * 6.28, side * (r(10) < 0.5 ? 1.35 : 2.9)), done: false,
    };
    base3.removeFromParent(); group.add(base3);
  }
  function flyTurret(dt) {
    const f = st.fly;
    if (f.done || dt <= 0) return;
    f.t += dt;
    f.v.y -= 9.81 * dt;
    f.p.addScaledVector(f.v, dt);
    const restY = D.t.W * 0.3;
    if (f.p.y <= restY && f.v.y < 0) {
      f.p.y = restY; f.done = true;
      base3.rotation.copy(f.rest);
    } else {
      base3.rotation.x += f.w.x * dt; base3.rotation.y += f.w.y * dt; base3.rotation.z += f.w.z * dt;
    }
    base3.position.copy(f.p);
  }
  model.update({}, 0);
  return model;
}

// For debugging / notes: tri counts by LOD without making meshes.
export function modelStats(def, gunIndex = 0) {
  const out = {};
  for (const lod of [0, 1]) {
    const g = buildGeometry(def, lod, gunIndex);
    let n = 0;
    const add = (geo) => { if (geo) n += geo.index.count / 3; };
    add(g.hull); add(g.turret); add(g.mantlet); add(g.gun);
    for (const s of Object.values(g.sides)) { add(s.track); add(s.wheels); }
    out[lod ? 'far' : 'near'] = Math.round(n);
  }
  return out;
}
