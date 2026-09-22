// Meshes: tanks, blocks, crates, shells, mines, and the giant set-dressing props.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import * as TX from './textures.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js';

const cache = {};
const once = (k, f) => cache[k] || (cache[k] = f());

export function plastic(color, opts = {}) {
  return new THREE.MeshPhysicalMaterial({
    color, roughness: 0.32, metalness: 0.0, clearcoat: 0.9, clearcoatRoughness: 0.18,
    sheen: 0.0, envMapIntensity: 0.9, ...opts,
  });
}

// Map a rounded box's per-face UVs into a 4-slot horizontal strip so one texture carries
// a different letter on each visible face.
function stripUV(geo) {
  const n = geo.attributes.normal, uv = geo.attributes.uv;
  for (let k = 0; k < uv.count; k++) {
    const nx = n.getX(k), ny = n.getY(k), nz = n.getZ(k);
    const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
    let slot;
    if (ay >= ax && ay >= az) slot = ny > 0 ? 0 : 2;
    else if (az >= ax) slot = nz > 0 ? 1 : 3;
    else slot = nx > 0 ? 2 : 3;
    uv.setX(k, (Math.min(0.999, Math.max(0.001, uv.getX(k))) + slot) / 4);
  }
  uv.needsUpdate = true;
  return geo;
}

// ------------------------------------------------------------------ board pieces
export const blockGeo = () => once('blockGeo', () => stripUV(new RoundedBoxGeometry(0.94, 0.94, 0.94, 3, 0.07)));
export const crateGeo = () => once('crateGeo', () => new RoundedBoxGeometry(0.9, 0.82, 0.9, 2, 0.03));

export const blockMaterials = () => once('blockMats', () => [...Array(TX.BLOCK_VARIANTS)].map((_, v) =>
  new THREE.MeshPhysicalMaterial({ map: TX.blockTextureHQ(v), roughness: 0.62, clearcoat: 0.25, clearcoatRoughness: 0.5, envMapIntensity: 0.5 })));

export const crateMaterial = () => once('crateMat', () => new THREE.MeshStandardMaterial({ map: TX.cardboard(), roughness: 0.92, envMapIntensity: 0.3 }));

// ------------------------------------------------------------------ tank (die-cast toy)
// Four classes share one construction kit: every static part is baked into one merged
// geometry per (group, material) and cached per class, road wheels are instanced, and the
// link tracks are an InstancedMesh that rolls around a per-class stadium loop.

const wear = () => once('wear', () => TX.paintWear());

export function diecast(color, opts = {}) {
  const w = wear();
  return new THREE.MeshPhysicalMaterial({
    color, map: w.map, metalnessMap: w.mr, roughnessMap: w.mr, metalness: 1, roughness: 1,
    clearcoat: 0.55, clearcoatRoughness: 0.35, envMapIntensity: 1.0, ...opts,
  });
}

// Track loop: a stadium path in the tank's local (x forward, y up) plane.
export function makeTrack({ R, xf, xr, yc, z, w, N }) {
  const straight = xf - xr, arc = Math.PI * R;
  const P = straight * 2 + arc * 2;
  const at = (s) => {
    s = ((s % P) + P) % P;
    if (s < straight) return [xr + s, yc + R, 0];
    s -= straight;
    if (s < arc) { const a = Math.PI / 2 - s / R; return [xf + Math.cos(a) * R, yc + Math.sin(a) * R, a - Math.PI / 2]; }
    s -= arc;
    if (s < straight) return [xf - s, yc - R, Math.PI];
    s -= straight;
    const a = -Math.PI / 2 - s / R; return [xr + Math.cos(a) * R, yc + Math.sin(a) * R, a - Math.PI / 2];
  };
  return { P, at, N, R, yc, xf, xr, z, w, straight, arc };
}
export const TRACK = makeTrack({ R: 0.085, xf: 0.3, xr: -0.3, yc: 0.1, z: 0.25, w: 0.13, N: 36 });

const _km = new THREE.Matrix4(), _kq = new THREE.Quaternion(), _ke = new THREE.Euler(), _kp = new THREE.Vector3(), _ks = new THREE.Vector3();
class Kit {
  constructor() { this.parts = {}; }
  add(grp, mat, geo, o = {}) {
    if (mat === 'steel' || mat === 'dark') return this._add(grp, 'detail', geo, o, mat === 'dark' ? 0x0c0c0c : 0x55585e);
    if (mat === 'lamp') return this._add(grp, 'detail', geo, o, 0xfff2d0);
    if (mat === 'trim' && grp !== 'turret') mat = 'paint';
    return this._add(grp, mat, geo, o);
  }
  _add(grp, mat, geo, { x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1 } = {}, tone) {
    let g = geo.index ? geo.toNonIndexed() : geo.clone();
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    g.clearGroups();
    _km.compose(_kp.set(x, y, z), _kq.setFromEuler(_ke.set(rx, ry, rz, 'YXZ')), _ks.set(sx, sy, sz));
    g.applyMatrix4(_km);
    if (tone != null) g.userData.tone = tone;
    (this.parts[grp + ':' + mat] || (this.parts[grp + ':' + mat] = [])).push(g);
  }
  // mirrored pair across z
  pair(grp, mat, geo, o) { this.add(grp, mat, geo, o); this.add(grp, mat, geo, { ...o, z: -(o.z || 0), ry: -(o.ry || 0), rx: -(o.rx || 0) }); }
  bake() {
    const out = {};
    for (const [k, list] of Object.entries(this.parts)) {
      if (k.endsWith(':detail')) for (const g of list) {
        const c = new THREE.Color(g.userData.tone ?? 0x55585e), n = g.attributes.position.count, a = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
        g.setAttribute('color', new THREE.BufferAttribute(a, 3));
      }
      out[k] = mergeGeometries(list, false); for (const g of list) g.dispose();
    }
    return out;
  }
}

// primitives
const cylX = (rBack, rFront, len, seg = 16) => { const g = new THREE.CylinderGeometry(rFront, rBack, len, seg); g.rotateZ(-Math.PI / 2); return g; };
const cylZ = (r, len, seg = 16) => { const g = new THREE.CylinderGeometry(r, r, len, seg); g.rotateX(Math.PI / 2); return g; };
const cylY = (r0, r1, h, seg = 16) => new THREE.CylinderGeometry(r1, r0, h, seg);
const rb = (w, h, d, r = 0.01, s = 2) => new RoundedBoxGeometry(w, h, d, s, Math.min(r, w / 2 - 1e-4, h / 2 - 1e-4, d / 2 - 1e-4));
const bx = (w, h, d) => new THREE.BoxGeometry(w, h, d);
function profile(pts, depth, bevel = 0.014) {
  const sh = new THREE.Shape(); sh.moveTo(pts[0][0], pts[0][1]);
  for (const p of pts.slice(1)) sh.lineTo(p[0], p[1]);
  sh.lineTo(pts[0][0], pts[0][1]);
  const g = new THREE.ExtrudeGeometry(sh, { depth, bevelEnabled: true, bevelThickness: bevel * 1.2, bevelSize: bevel, bevelSegments: 3, curveSegments: 4 });
  g.translate(0, 0, -depth / 2);
  return g;
}
// A plan shape (x, z) extruded upward by h (with an optional hole ring of `wall` thickness).
function plan(pts, h, bevel = 0.01, wall = 0) {
  const sh = new THREE.Shape(); sh.moveTo(pts[0][0], -pts[0][1]);
  for (const p of pts.slice(1)) sh.lineTo(p[0], -p[1]);
  if (wall) {
    const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
    const hole = new THREE.Path();
    const inner = pts.map(([x, z]) => { const dx = x - cx, l = Math.hypot(dx, z) || 1; return [x - dx / l * wall, z - z / l * wall]; });
    hole.moveTo(inner[0][0], -inner[0][1]);
    for (const p of inner.slice(1).reverse()) hole.lineTo(p[0], -p[1]);
    sh.holes.push(hole);
  }
  const g = new THREE.ExtrudeGeometry(sh, { depth: h, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel * 0.8, bevelSegments: 2, curveSegments: 4 });
  g.rotateX(-Math.PI / 2);
  return g;
}
const sphere = (r, a = 8, b = 6) => new THREE.SphereGeometry(r, a, b);
function rivetRow(K, grp, mat, x0, x1, n, y, z, r = 0.008) { for (let k = 0; k < n; k++) K.add(grp, mat, sphere(r, 6, 4), { x: x0 + (x1 - x0) * (n > 1 ? k / (n - 1) : 0.5), y, z }); }

// Common hull furniture.
function lamps(K, x, y, z) {
  K.pair('body', 'lamp', cylX(0.018, 0.022, 0.03, 12), { x, y, z });
  K.pair('body', 'steel', cylX(0.024, 0.024, 0.01, 12), { x: x - 0.016, y, z });
}
function hooks(K, x, y, z) { K.pair('body', 'steel', new THREE.TorusGeometry(0.018, 0.006, 6, 10), { x, y, z, ry: Math.PI / 2 }); }

// ---- per-class construction. Each returns the spec; parts go into K.
function mediumParts(K) {
  const track = makeTrack({ R: 0.085, xf: 0.3, xr: -0.3, yc: 0.1, z: 0.25, w: 0.13, N: 36 });
  K.add('body', 'paint', profile([[-0.36, 0.13], [0.27, 0.13], [0.38, 0.2], [0.3, 0.3], [-0.3, 0.31], [-0.37, 0.24]], 0.36));
  for (let k = 0; k < 9; k++) { const x = -0.28 + k * 0.07; K.pair('body', 'paint', sphere(0.009, 6, 4), { x, y: 0.318, z: 0.2 }); }
  for (let k = 0; k < 5; k++) { const z = -0.16 + k * 0.08; K.add('body', 'paint', sphere(0.009, 6, 4), { x: 0.335, y: 0.27, z }); K.add('body', 'paint', sphere(0.009, 6, 4), { x: -0.335, y: 0.285, z }); }
  K.pair('body', 'paint', rb(0.82, 0.018, 0.13, 0.006), { y: 0.215, z: 0.25 });
  K.pair('body', 'paint', rb(0.16, 0.05, 0.09, 0.01), { x: -0.18, y: 0.25, z: 0.26 });
  for (let k = 0; k < 5; k++) K.add('body', 'steel', bx(0.012, 0.012, 0.22), { x: -0.3 + k * 0.03, y: 0.33 });
  // spare track shoes on the glacis
  const ga = Math.atan2(0.1, -0.08);
  for (let k = 0; k < 3; k++) K.add('body', 'steel', bx(0.034, 0.012, 0.12), { x: 0.365 - k * 0.028, y: 0.225 + k * 0.035, z: -0.07 + (k % 2) * 0.004, rz: ga - Math.PI });
  K.add('body', 'steel', cylX(0.011, 0.009, 0.09, 8), { x: 0.37, y: 0.24, z: 0.08 });
  lamps(K, 0.35, 0.29, 0.15); hooks(K, 0.38, 0.15, 0.11);
  K.pair('body', 'steel', cylX(0.026, 0.022, 0.07, 10), { x: -0.4, y: 0.22, z: 0.1 });
  // shovel + pick on the right fender
  K.add('body', 'steel', bx(0.06, 0.006, 0.045), { x: 0.2, y: 0.227, z: -0.27 });
  K.add('body', 'trim', cylX(0.006, 0.006, 0.16, 6), { x: 0.09, y: 0.228, z: -0.27 });
  // road wheels, sprocket (front), idler (rear)
  const wheels = [];
  for (let k = 0; k < 5; k++) wheels.push({ x: -0.24 + k * 0.12, y: 0.078, r: 0.058 });
  const drive = [{ x: track.xf, y: track.yc, r: 0.072 }, { x: track.xr, y: track.yc, r: 0.066, idler: true }];
  // turret: a cast, rounded shell with a mantlet
  const pts = [[0, 0.13], [0.1, 0.128], [0.16, 0.11], [0.19, 0.075], [0.2, 0.03], [0.195, 0.0], [0, 0]].map(([r, y]) => new THREE.Vector2(r, y));
  const shellG = new THREE.LatheGeometry(pts.reverse(), 36); shellG.scale(1.12, 1, 1);
  K.add('turret', 'paint', shellG);
  K.add('turret', 'steel', cylY(0.21, 0.2, 0.025, 36), { y: 0.005 });
  K.add('turret', 'paint', rb(0.07, 0.085, 0.15, 0.02, 3), { x: 0.2, y: 0.065 });
  K.add('turret', 'paint', cylY(0.06, 0.055, 0.045, 20), { x: -0.06, y: 0.15, z: 0.06 });
  K.add('turret', 'trim', cylY(0.05, 0.05, 0.012, 20), { x: -0.06, y: 0.178, z: 0.06 });
  K.add('turret', 'steel', bx(0.03, 0.025, 0.04), { x: 0.04, y: 0.14, z: -0.06 });
  K.add('turret', 'steel', cylX(0.008, 0.008, 0.12, 6), { x: 0.01, y: 0.205, z: 0.06 });
  K.add('turret', 'paint', rb(0.07, 0.07, 0.26, 0.012), { x: -0.24, y: 0.065 });
  // gun
  K.add('barrel', 'paint', cylX(0.03, 0.024, 0.42, 20), { x: 0.21 });
  K.add('barrel', 'paint', cylX(0.036, 0.036, 0.07, 18), { x: 0.25 });
  K.add('barrel', 'steel', cylX(0.03, 0.03, 0.03, 16), { x: 0.425 });
  K.add('barrel', 'dark', new THREE.CircleGeometry(0.02, 12).rotateY(Math.PI / 2), { x: 0.441 });
  return {
    track, wheels, drive, turretAt: [-0.02, 0.325], barrelAt: [0.22, 0.065], muzzle: 0.44, recoil: 0.09,
    emblem: { x: -0.02, y: 0.065, z: 0.203, rx: 0.2, size: 0.1 }, antenna: { x: -0.14, y: 0.1, z: -0.1, h: 0.4 },
    deck: [-0.3, 0.34], top: 0.52,
  };
}

function lightParts(K) {
  // Christie-style: four big road wheels, the track wraps the end wheels and rides on top.
  const wr = 0.064, wy = 0.082;
  const track = makeTrack({ R: wr + 0.009, xf: 0.198, xr: -0.198, yc: wy, z: 0.2, w: 0.1, N: 30 });
  K.add('body', 'paint', profile([[-0.3, 0.1], [0.23, 0.1], [0.32, 0.155], [0.26, 0.215], [-0.25, 0.222], [-0.3, 0.185]], 0.25, 0.012));
  K.pair('body', 'paint', rb(0.62, 0.014, 0.11, 0.005), { y: 0.172, z: 0.2 });
  // fender mud flaps
  K.pair('body', 'paint', bx(0.012, 0.04, 0.1), { x: 0.305, y: 0.152, z: 0.2 });
  for (let k = 0; k < 6; k++) K.pair('body', 'paint', sphere(0.007, 6, 4), { x: -0.2 + k * 0.08, y: 0.228, z: 0.12 });
  // engine deck louvres, jerrycans, exhaust
  for (let k = 0; k < 4; k++) K.add('body', 'steel', bx(0.01, 0.01, 0.16), { x: -0.24 + k * 0.026, y: 0.228 });
  K.pair('body', 'trim', rb(0.045, 0.07, 0.03, 0.006), { x: -0.29, y: 0.2, z: 0.06 });
  K.add('body', 'steel', cylX(0.018, 0.016, 0.05, 10), { x: -0.32, y: 0.17, z: -0.07 });
  K.add('body', 'steel', cylX(0.009, 0.008, 0.07, 8), { x: 0.3, y: 0.19, z: 0.06 });
  lamps(K, 0.29, 0.205, 0.1); hooks(K, 0.31, 0.12, 0.08);
  const wheels = [];
  for (let k = 0; k < 4; k++) wheels.push({ x: -0.198 + k * 0.132, y: wy, r: wr, big: true });
  // small, low turret
  const pts = [[0, 0.085], [0.08, 0.084], [0.118, 0.072], [0.138, 0.045], [0.145, 0.014], [0.14, 0.0], [0, 0]].map(([r, y]) => new THREE.Vector2(r, y));
  const shellG = new THREE.LatheGeometry(pts.reverse(), 30); shellG.scale(1.15, 1, 1);
  K.add('turret', 'paint', shellG);
  K.add('turret', 'steel', cylY(0.15, 0.145, 0.02, 30), { y: 0.004 });
  K.add('turret', 'paint', rb(0.05, 0.058, 0.1, 0.014, 3), { x: 0.155, y: 0.045 });
  K.add('turret', 'trim', cylY(0.042, 0.042, 0.012, 18), { x: -0.03, y: 0.09, z: 0.035 });
  K.add('turret', 'steel', bx(0.025, 0.02, 0.03), { x: 0.05, y: 0.09, z: -0.05 });
  K.add('barrel', 'paint', cylX(0.02, 0.016, 0.3, 16), { x: 0.15 });
  K.add('barrel', 'steel', cylX(0.02, 0.02, 0.02, 14), { x: 0.3 });
  K.add('barrel', 'dark', new THREE.CircleGeometry(0.013, 10).rotateY(Math.PI / 2), { x: 0.311 });
  return {
    track, wheels, drive: [], turretAt: [0.01, 0.222], barrelAt: [0.16, 0.045], muzzle: 0.31, recoil: 0.06,
    emblem: { x: -0.02, y: 0.045, z: 0.148, rx: 0.25, size: 0.075 }, antenna: { x: -0.08, y: 0.06, z: -0.08, h: 0.5 },
    deck: [-0.25, 0.24], top: 0.34,
  };
}

function heavyParts(K) {
  const track = makeTrack({ R: 0.09, xf: 0.34, xr: -0.34, yc: 0.105, z: 0.27, w: 0.15, N: 44 });
  K.add('body', 'paint', profile([[-0.38, 0.13], [0.33, 0.13], [0.4, 0.2], [0.39, 0.345], [-0.37, 0.35], [-0.4, 0.21]], 0.36, 0.012));
  // superstructure over the tracks: the boxy look
  K.pair('body', 'paint', rb(0.76, 0.135, 0.16, 0.012), { y: 0.28, z: 0.265 });
  // side skirts: four bolted panels a side
  for (let k = 0; k < 4; k++) {
    const x = -0.285 + k * 0.19;
    K.pair('body', 'paint', rb(0.182, 0.11, 0.012, 0.004), { x, y: 0.165, z: 0.356, rx: 0.03 * ((k % 2) - 0.5) });
    for (let b = 0; b < 3; b++) K.pair('body', 'steel', sphere(0.006, 6, 4), { x: x - 0.06 + b * 0.06, y: 0.208, z: 0.364 });
  }
  // front plate: visor, ball MG, spare track shoes
  K.add('body', 'dark', bx(0.012, 0.022, 0.1), { x: 0.396, y: 0.3, z: -0.1 });
  K.add('body', 'paint', sphere(0.03, 12, 8), { x: 0.39, y: 0.29, z: 0.11 });
  K.add('body', 'steel', cylX(0.01, 0.009, 0.07, 8), { x: 0.425, y: 0.29, z: 0.11 });
  for (let k = 0; k < 5; k++) K.add('body', 'steel', bx(0.014, 0.035, 0.1), { x: 0.37, y: 0.17, z: -0.2 + k * 0.1, rz: -0.8 });
  lamps(K, 0.36, 0.365, 0.22); hooks(K, 0.39, 0.15, 0.14);
  // deck bolts, fan covers, tow cables, vertical exhausts
  for (const z of [0.17, -0.17]) rivetRow(K, 'body', 'steel', -0.34, 0.34, 10, 0.352, z, 0.007);
  K.pair('body', 'steel', cylY(0.07, 0.07, 0.012, 20), { x: -0.24, y: 0.353, z: 0.1 });
  K.pair('body', 'dark', cylY(0.055, 0.055, 0.014, 20), { x: -0.24, y: 0.354, z: 0.1 });
  K.pair('body', 'steel', cylX(0.009, 0.009, 0.56, 6), { x: 0.0, y: 0.357, z: 0.325 });
  K.pair('body', 'steel', new THREE.TorusGeometry(0.02, 0.006, 6, 10), { x: 0.29, y: 0.357, z: 0.325, rx: Math.PI / 2 });
  K.pair('body', 'steel', cylY(0.022, 0.02, 0.12, 12), { x: -0.39, y: 0.37, z: 0.11 });
  K.pair('body', 'paint', rb(0.05, 0.1, 0.06, 0.008), { x: -0.402, y: 0.33, z: 0.11 });
  const wheels = [];
  for (let k = 0; k < 6; k++) wheels.push({ x: -0.26 + k * 0.104, y: 0.08, r: 0.062 });
  const drive = [{ x: track.xf, y: track.yc + 0.01, r: 0.078 }, { x: track.xr, y: track.yc, r: 0.072, idler: true }];
  // big welded turret
  const tp = [[0.2, -0.15], [0.2, 0.15], [0.08, 0.21], [-0.18, 0.21], [-0.26, 0.13], [-0.26, -0.13], [-0.18, -0.21], [0.08, -0.21]];
  K.add('turret', 'paint', plan(tp, 0.15, 0.014));
  K.add('turret', 'steel', cylY(0.23, 0.22, 0.03, 36), { y: 0.006 });
  K.add('turret', 'paint', rb(0.09, 0.13, 0.26, 0.02, 3), { x: 0.235, y: 0.085 });
  K.add('turret', 'paint', cylY(0.058, 0.055, 0.06, 20), { x: -0.14, y: 0.19, z: 0.11 });
  K.add('turret', 'trim', cylY(0.05, 0.05, 0.012, 20), { x: -0.14, y: 0.224, z: 0.11 });
  for (let k = 0; k < 6; k++) { const a = k / 6 * Math.PI * 2; K.add('turret', 'dark', bx(0.012, 0.014, 0.02), { x: -0.14 + Math.cos(a) * 0.058, y: 0.2, z: 0.11 + Math.sin(a) * 0.058, ry: -a }); }
  K.add('turret', 'trim', rb(0.1, 0.012, 0.085, 0.004), { x: -0.02, y: 0.182, z: -0.1 });
  for (let k = 0; k < 3; k++) K.pair('turret', 'steel', cylX(0.011, 0.011, 0.045, 8), { x: 0.13, y: 0.11 + k * 0.022, z: 0.2, ry: -0.5 });
  K.add('turret', 'paint', rb(0.09, 0.1, 0.3, 0.012), { x: -0.3, y: 0.085 });
  for (let k = 0; k < 3; k++) K.pair('turret', 'steel', bx(0.034, 0.075, 0.012), { x: 0.02 + k * 0.042, y: 0.08, z: 0.218 });
  K.add('barrel', 'paint', cylX(0.036, 0.029, 0.56, 22), { x: 0.28 });
  K.add('barrel', 'steel', cylX(0.036, 0.036, 0.1, 16), { x: 0.585 });
  K.add('barrel', 'steel', cylX(0.052, 0.052, 0.026, 18), { x: 0.556 });
  K.add('barrel', 'steel', cylX(0.052, 0.052, 0.026, 18), { x: 0.614 });
  K.add('barrel', 'dark', new THREE.CircleGeometry(0.024, 12).rotateY(Math.PI / 2), { x: 0.636 });
  return {
    track, wheels, drive, turretAt: [-0.03, 0.35], barrelAt: [0.27, 0.085], muzzle: 0.63, recoil: 0.1,
    emblem: { x: -0.12, y: 0.085, z: 0.222, rx: 0, size: 0.1 }, antenna: { x: -0.22, y: 0.16, z: -0.12, h: 0.36 },
    deck: [-0.3, 0.37], top: 0.6,
  };
}

function tdParts(K) {
  const track = makeTrack({ R: 0.08, xf: 0.31, xr: -0.31, yc: 0.095, z: 0.26, w: 0.13, N: 38 });
  // lower hull between the tracks, then a low sloped superstructure over the tracks
  K.add('body', 'paint', profile([[-0.36, 0.12], [0.3, 0.12], [0.4, 0.18], [0.37, 0.21], [-0.35, 0.215], [-0.38, 0.18]], 0.34, 0.012));
  const sup = [
    [0.4, 0.2, 0.33], [0.4, 0.2, -0.33], [-0.38, 0.2, 0.33], [-0.38, 0.2, -0.33],
    [0.17, 0.3, 0.22], [0.17, 0.3, -0.22], [-0.31, 0.3, 0.22], [-0.31, 0.3, -0.22],
  ].map(([x, y, z]) => new THREE.Vector3(x, y, z));
  K.add('body', 'paint', new ConvexGeometry(sup));
  // grousers (spare track grips) along the sloped sides, headlamp guards, tools, a rear box
  for (let k = 0; k < 6; k++) K.pair('body', 'steel', bx(0.03, 0.01, 0.07), { x: -0.25 + k * 0.08, y: 0.255, z: 0.285, rx: -0.78 });
  lamps(K, 0.36, 0.245, 0.2); hooks(K, 0.395, 0.15, 0.12);
  K.pair('body', 'steel', new THREE.TorusGeometry(0.028, 0.004, 5, 10, Math.PI), { x: 0.37, y: 0.245, z: 0.2, ry: Math.PI / 2 });
  K.add('body', 'trim', rb(0.12, 0.06, 0.4, 0.01), { x: -0.37, y: 0.26 });
  K.add('body', 'steel', cylX(0.007, 0.007, 0.26, 6), { x: -0.05, y: 0.305, z: 0.15 });
  for (let k = 0; k < 4; k++) K.add('body', 'steel', bx(0.012, 0.01, 0.2), { x: -0.27 + k * 0.03, y: 0.302 });
  const wheels = [];
  for (let k = 0; k < 5; k++) wheels.push({ x: -0.24 + k * 0.12, y: 0.075, r: 0.056 });
  const drive = [{ x: track.xf, y: track.yc + 0.01, r: 0.068 }, { x: track.xr, y: track.yc, r: 0.062, idler: true }];
  // open-topped turret: thin armour walls, a dark floor, a rear counterweight bustle
  const tp = [[0.15, -0.12], [0.15, 0.12], [0.03, 0.19], [-0.15, 0.17], [-0.18, 0], [-0.15, -0.17], [0.03, -0.19]];
  K.add('turret', 'paint', plan(tp, 0.1, 0.006, 0.018));
  K.add('turret', 'dark', plan(tp.map(([x, z]) => [x * 0.9, z * 0.9]), 0.012, 0), { y: 0.015 });
  K.add('turret', 'steel', cylY(0.2, 0.19, 0.022, 30), { y: 0.004 });
  K.add('turret', 'paint', rb(0.1, 0.075, 0.26, 0.012), { x: -0.22, y: 0.045 });
  K.add('turret', 'steel', cylY(0.006, 0.006, 0.1, 6), { x: -0.12, y: 0.15, z: 0.1 });
  K.add('turret', 'steel', cylX(0.009, 0.008, 0.13, 8), { x: -0.08, y: 0.2, z: 0.1 });
  K.add('turret', 'paint', rb(0.07, 0.09, 0.14, 0.018, 3), { x: 0.165, y: 0.055 });
  K.add('barrel', 'paint', cylX(0.028, 0.021, 0.64, 20), { x: 0.32 });
  K.add('barrel', 'paint', cylX(0.03, 0.03, 0.05, 16), { x: 0.36 });
  K.add('barrel', 'steel', cylX(0.04, 0.04, 0.05, 16), { x: 0.655 });
  K.add('barrel', 'dark', bx(0.02, 0.012, 0.084), { x: 0.655 });
  K.add('barrel', 'dark', new THREE.CircleGeometry(0.018, 12).rotateY(Math.PI / 2), { x: 0.681 });
  return {
    track, wheels, drive, turretAt: [-0.05, 0.3], barrelAt: [0.19, 0.055], muzzle: 0.68, recoil: 0.11,
    emblem: { x: -0.07, y: 0.055, z: 0.183, rx: 0, ry: 0.11, size: 0.08 }, antenna: { x: -0.2, y: 0.07, z: -0.14, h: 0.4 },
    deck: [-0.3, 0.31], top: 0.42,
  };
}

const CLASS_PARTS = { light: lightParts, medium: mediumParts, heavy: heavyParts, td: tdParts };
export const TANK_CLASSES = Object.keys(CLASS_PARTS);
const classKit = (cls) => once('kit:' + cls, () => { const K = new Kit(); const spec = CLASS_PARTS[cls](K); return { spec, geos: K.bake() }; });

// Road wheel (rubber tyre + painted hub with bolts) and toothed sprocket, unit radius.
// Road wheel: rubber tyre + painted hub with bolts, one geometry; vertex colour picks rubber
// (near black) or paint (white × the tank's paint colour).
const wheelGeo = () => once('wheelU', () => {
  const tint = (g, c) => { const n = g.index ? g.toNonIndexed() : g; for (const k of Object.keys(n.attributes)) if (!['position', 'normal', 'uv'].includes(k)) n.deleteAttribute(k); const a = new Float32Array(n.attributes.position.count * 3).fill(c); n.setAttribute('color', new THREE.BufferAttribute(a, 3)); return n; };
  const parts = [tint(cylZ(1, 1, 22), 0.035), tint(cylZ(0.74, 1.06, 18), 1), tint(cylZ(0.3, 1.14, 10), 0.6)];
  for (let k = 0; k < 6; k++) { const a = k / 6 * Math.PI * 2; const b = bx(0.14, 0.14, 1.12); b.translate(Math.cos(a) * 0.5, Math.sin(a) * 0.5, 0); parts.push(tint(b, 0.5)); }
  return mergeGeometries(parts);
});
const sprocketGeo = () => once('sprU', () => {
  const parts = [cylZ(0.8, 1.0, 16)];
  for (let k = 0; k < 10; k++) { const a = k / 10 * Math.PI * 2; const b = bx(0.24, 0.3, 0.9); b.rotateZ(a); b.translate(Math.cos(a) * 0.9, Math.sin(a) * 0.9, 0); parts.push(b); }
  return mergeGeometries(parts.map((g) => { const n = g.index ? g.toNonIndexed() : g; for (const k of Object.keys(n.attributes)) if (!['position', 'normal', 'uv'].includes(k)) n.deleteAttribute(k); return n; }));
});

export function buildTank(type, { emblem = 'ring', colorOverride = null } = {}) {
  const cls = CLASS_PARTS[type.cls] ? type.cls : 'medium';
  const { spec, geos } = classKit(cls);
  const color = colorOverride ?? type.color;
  const mats = {
    paint: diecast(color),
    trim: diecast(type.trim),
    steel: new THREE.MeshStandardMaterial({ color: 0x55585e, metalness: 0.9, roughness: 0.42 }),
    rubber: new THREE.MeshStandardMaterial({ color: 0x1c1d1f, roughness: 0.8, metalness: 0.2 }),
    link: new THREE.MeshStandardMaterial({ color: 0x3a3a3c, metalness: 0.85, roughness: 0.5 }),
    detail: new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.85, roughness: 0.45 }),
    lamp: new THREE.MeshStandardMaterial({ color: 0xfff4d6, emissive: 0xffe0a0, emissiveIntensity: 0.35, roughness: 0.15, metalness: 0.3 }),
  };
  const root = new THREE.Group();
  const body = new THREE.Group(); root.add(body);
  const turret = new THREE.Group(); turret.position.set(spec.turretAt[0], spec.turretAt[1], 0); root.add(turret);
  const barrel = new THREE.Group(); barrel.position.set(spec.barrelAt[0], spec.barrelAt[1], 0); turret.add(barrel);
  const groups = { body, turret, barrel };
  for (const [k, g] of Object.entries(geos)) {
    const [grp, mat] = k.split(':');
    const m = new THREE.Mesh(g, mats[mat]);
    m.castShadow = mat === 'paint' || (mat === 'detail' && grp === 'body'); m.receiveShadow = true;
    groups[grp].add(m);
  }
  // wheels: instanced tyres + hubs (+ sprockets), spun in updateTracks
  const T = spec.track;
  const wheelList = [];
  for (const side of [1, -1]) {
    for (const w of spec.wheels) wheelList.push({ ...w, z: side * T.z, side });
    for (const w of spec.drive) wheelList.push({ ...w, z: side * T.z, side, sprocket: !w.idler });
  }
  const road = wheelList.filter((w) => !w.sprocket), spr = wheelList.filter((w) => w.sprocket);
  mats.wheel = diecast(color, { vertexColors: true });
  const tyres = new THREE.InstancedMesh(wheelGeo(), mats.wheel, road.length);
  const hubs = null;
  const sprockets = spr.length ? new THREE.InstancedMesh(sprocketGeo(), mats.steel, spr.length) : null;
  const bound = new THREE.Sphere(new THREE.Vector3(0, 0.1, 0), 0.9);
  for (const im of [tyres, sprockets]) if (im) { im.castShadow = true; im.receiveShadow = true; im.instanceMatrix.setUsage(THREE.DynamicDrawUsage); im.boundingSphere = bound; body.add(im); }
  const links = new THREE.InstancedMesh(once('link:' + cls, () => new THREE.BoxGeometry(T.P / T.N * 0.82, 0.018, T.w)), mats.link, T.N * 2);
  links.castShadow = true; links.receiveShadow = true; links.instanceMatrix.setUsage(THREE.DynamicDrawUsage); links.boundingSphere = new THREE.Sphere(new THREE.Vector3(0.2, 0.05, 0), 1.3);
  body.add(links);
  // emblem decals on the turret sides
  const E = spec.emblem;
  const emblemMat = new THREE.MeshStandardMaterial({ map: TX.emblem(emblem, '#f2efe6'), transparent: true, roughness: 0.5, polygonOffset: true, polygonOffsetFactor: -2, depthWrite: false });
  const emGeo = once('emGeo:' + cls, () => {
    const parts = [1, -1].map((side) => {
      const p = new THREE.PlaneGeometry(E.size, E.size);
      p.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(E.x, E.y, side * E.z), new THREE.Quaternion().setFromEuler(new THREE.Euler(side * -E.rx, (side > 0 ? 0 : Math.PI) + side * (E.ry || 0), 0, 'YXZ')), new THREE.Vector3(1, 1, 1)));
      return p;
    });
    return mergeGeometries(parts);
  });
  const emMesh = new THREE.Mesh(emGeo, emblemMat); turret.add(emMesh);
  const emblems = [emMesh];
  // antenna + pennant
  const A = spec.antenna;
  const ant = new THREE.Mesh(once('ant:' + A.h, () => { const g = new THREE.CylinderGeometry(0.004, 0.006, A.h, 5); g.translate(0, A.h / 2, 0); return g; }), mats.steel);
  ant.position.set(A.x, A.y, A.z); turret.add(ant);
  const flagMat = new THREE.MeshStandardMaterial({ color: type.trim === 0x0b4f4d ? 0x1fb5b0 : color, side: THREE.DoubleSide, roughness: 0.85 });
  const flag = new THREE.Mesh(once('flag2', () => { const g = new THREE.PlaneGeometry(0.12, 0.07, 6, 1); g.translate(-0.06, 0, 0); return g; }), flagMat);
  flag.position.set(0, A.h - 0.04, 0); ant.add(flag);
  // barrel tip marker (muzzle flash origin)
  const tip = new THREE.Object3D(); tip.position.x = spec.muzzle; barrel.add(tip);
  ant.castShadow = true; flag.castShadow = true;
  root.scale.setScalar(type.scale || 1);
  root.userData = {
    cls, spec, body, turret, barrel, tip, ant, flag, emblems, links, tyres, hubs, sprockets, road, spr, track: T,
    barrelX: spec.barrelAt[0], phaseL: 0, phaseR: 0, brokenL: false, brokenR: false,
    mats: [mats.paint, mats.trim, mats.steel, mats.rubber, mats.link, mats.detail, mats.lamp, mats.wheel, emblemMat, flagMat],
    paint: mats.paint, wheelMat: mats.wheel, trimMat: mats.trim, steelMat: mats.steel, detailMat: mats.detail, emblemMat, flagMat,
  };
  updateTracks(root, 0);
  return root;
}

const _m4 = new THREE.Matrix4(), _q4 = new THREE.Quaternion(), _q5 = new THREE.Quaternion(), _p4 = new THREE.Vector3(), _s4 = new THREE.Vector3(1, 1, 1), _z = new THREE.Vector3(0, 0, 1), _yax = new THREE.Vector3(0, 1, 0);
// Roll the links around the loop and spin the wheels. `left`/`right` are distances travelled.
// A broken side (ud.brokenL / ud.brokenR) stops rolling: its links fall off the top run and
// lie on the ground in front of and behind the tank, and its wheels stop.
export function updateTracks(root, left, right = left) {
  const ud = root.userData, T = ud.track;
  if (!ud.brokenL) ud.phaseL += left;
  if (!ud.brokenR) ud.phaseR += right;
  let n = 0;
  const gap = T.P / T.N;
  for (const [side, ph, broken] of [[1, ud.phaseL, ud.brokenL], [-1, ud.phaseR, ud.brokenR]]) {
    for (let k = 0; k < T.N; k++) {
      const s0 = k / T.N * T.P + ph;
      let [x, y, a] = T.at(s0);
      let zz = side * T.z, yaw = 0;
      if (broken) {
        // thrown: the top run slides off the front and lies on the ground in a lazy curl out
        // to the side; the rear wrap sags onto the ground behind.
        const s = ((s0 % T.P) + T.P) % T.P, bot0 = T.straight + T.arc, bot1 = bot0 + T.straight;
        if (s < bot0) {
          const d = bot0 - s, phi = Math.min(1.9, d * 2.6);
          const lx = Math.sin(phi) / 2.6, lz = (1 - Math.cos(phi)) / 2.6 + Math.max(0, d * 2.6 - 1.9) / 2.6;
          x = T.xf + T.R * 0.5 + lx * 0.9; zz = side * (T.z + 0.02 + lz * 0.8); y = 0.009; a = 0; yaw = -side * phi;
        } else if (s >= bot1) {
          const d = s - bot1;
          x = T.xr - T.R * 0.3 - d * 0.9; y = 0.009; a = 0; zz = side * (T.z + d * 0.25); yaw = side * d * 1.2;
        }
      }
      _q4.setFromAxisAngle(_z, a);
      if (yaw) _q4.premultiply(_q5.setFromAxisAngle(_yax, yaw));
      _m4.compose(_p4.set(x, y, zz), _q4, _s4);
      ud.links.setMatrixAt(n++, _m4);
    }
  }
  ud.links.instanceMatrix.needsUpdate = true;
  const spin = (list, im) => {
    if (!im) return;
    list.forEach((w, k) => {
      const ph = w.side > 0 ? ud.phaseL : ud.phaseR;
      _q4.setFromAxisAngle(_z, -ph / w.r);
      _m4.compose(_p4.set(w.x, w.y, w.z + w.side * 0.004), _q4, _s4.set(w.r, w.r, T.w * (w.big ? 0.95 : 0.85)));
      im.setMatrixAt(k, _m4);
    });
    im.instanceMatrix.needsUpdate = true;
  };
  spin(ud.road, ud.tyres); spin(ud.spr, ud.sprockets);
  _s4.set(1, 1, 1);
}

// Knocked out: char the paint, droop the gun, throw both tracks, knock the turret askew.
export function wreckTank(root, seed = Math.random()) {
  const ud = root.userData;
  if (ud.wrecked) return;
  ud.wrecked = true;
  const char = new THREE.Color(0x1c1714);
  for (const m of [ud.paint, ud.trimMat, ud.wheelMat]) { m.color.lerp(char, 0.93); m.clearcoat = 0.05; m.metalness = 0.4; m.roughnessMap = null; m.roughness = 0.85; m.needsUpdate = true; }
  ud.steelMat.color.set(0x2a2624); ud.steelMat.roughness = 0.8;
  ud.detailMat.color.set(0x5a504a); ud.detailMat.roughness = 0.85;
  ud.emblemMat.opacity = 0.18;
  ud.flag.visible = false;
  ud.ant.rotation.z = 0.9 + seed * 0.5;
  ud.brokenL = ud.brokenR = true;
  const r = (seed * 9301 + 49297) % 1;
  ud.turret.rotation.y += (r - 0.5) * 1.4;
  ud.turret.rotation.z = (seed - 0.5) * 0.3;
  ud.turret.rotation.x = (r - 0.5) * 0.25;
  ud.turret.position.y += 0.015;
  ud.barrel.rotation.z = -0.1 - seed * 0.08;
  ud.barrel.position.x = ud.barrelX;
  updateTracks(root, 0);
}

// ------------------------------------------------------------------ shells & mines
export const shellGeo = () => once('shellGeo', () => { const g = new THREE.CapsuleGeometry(0.055, 0.12, 6, 12); g.rotateZ(Math.PI / 2); return g; });
export const rocketGeo = () => once('rocketGeo', () => { const g = new THREE.CapsuleGeometry(0.05, 0.22, 6, 12); g.rotateZ(Math.PI / 2); return g; });
export const shellMat = () => once('shellMat', () => new THREE.MeshStandardMaterial({ color: 0xd8b25a, metalness: 0.85, roughness: 0.25, emissive: 0x3a2600, emissiveIntensity: 0.4 }));
export const rocketMat = () => once('rocketMat', () => new THREE.MeshStandardMaterial({ color: 0xe9ecef, metalness: 0.4, roughness: 0.3, emissive: 0xff5a1f, emissiveIntensity: 0.25 }));

export function buildMine() {
  const g = new THREE.Group();
  const base = new THREE.Mesh(once('mineBase', () => new THREE.CylinderGeometry(0.22, 0.24, 0.05, 28)), new THREE.MeshStandardMaterial({ color: 0x2b2b2b, roughness: 0.5, metalness: 0.5 }));
  base.position.y = 0.025; g.add(base);
  const dome = new THREE.Mesh(once('mineDome', () => { const d = new THREE.SphereGeometry(0.19, 28, 12, 0, Math.PI * 2, 0, Math.PI / 2); d.scale(1, 0.55, 1); return d; }), plastic(0xf2c230));
  dome.position.y = 0.05; g.add(dome);
  // hazard stripes as small dark boxes around the dome skirt
  for (let k = 0; k < 6; k++) {
    const s = new THREE.Mesh(once('mineStripe', () => new THREE.BoxGeometry(0.05, 0.03, 0.12)), new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.6 }));
    const a = (k / 6) * Math.PI * 2;
    s.position.set(Math.cos(a) * 0.17, 0.075, Math.sin(a) * 0.17); s.rotation.y = -a;
    g.add(s);
  }
  const lamp = new THREE.Mesh(once('mineLamp', () => new THREE.SphereGeometry(0.045, 16, 10)), new THREE.MeshStandardMaterial({ color: 0x550000, emissive: 0xff1a0a, emissiveIntensity: 0, roughness: 0.2 }));
  lamp.position.y = 0.16; g.add(lamp);
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  g.userData.lamp = lamp; g.userData.dome = dome;
  return g;
}

// ------------------------------------------------------------------ set dressing (giant desk things)
export function pencil(color = 0xf2c230) {
  const g = new THREE.Group();
  const L = 14;
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, L, 6), plastic(color, { clearcoat: 0.6, roughness: 0.4 }));
  body.rotation.z = Math.PI / 2; g.add(body);
  const wood = new THREE.Mesh(new THREE.ConeGeometry(0.42, 1.6, 6, 1, true), new THREE.MeshStandardMaterial({ color: 0xe8c79a, roughness: 0.8, side: THREE.DoubleSide }));
  wood.rotation.z = -Math.PI / 2; wood.position.x = L / 2 + 0.8; g.add(wood);
  const lead = new THREE.Mesh(new THREE.ConeGeometry(0.15, 0.55, 12), new THREE.MeshStandardMaterial({ color: 0x2a2a2e, roughness: 0.3, metalness: 0.5 }));
  lead.rotation.z = -Math.PI / 2; lead.position.x = L / 2 + 1.33; g.add(lead);
  const ferrule = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.9, 24), new THREE.MeshStandardMaterial({ color: 0xc9ccd1, metalness: 1, roughness: 0.25 }));
  ferrule.rotation.z = Math.PI / 2; ferrule.position.x = -L / 2 - 0.45; g.add(ferrule);
  const eraser = new THREE.Mesh(new RoundedBoxGeometry(1.0, 0.86, 0.86, 3, 0.2), new THREE.MeshStandardMaterial({ color: 0xf28fa8, roughness: 0.9 }));
  eraser.position.x = -L / 2 - 1.3; g.add(eraser);
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

export function crayon(color) {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.55 });
  const paper = new THREE.MeshStandardMaterial({ color: new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.15), roughness: 0.9 });
  const b = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 6, 24), paper); b.rotation.z = Math.PI / 2; g.add(b);
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.505, 0.505, 0.25, 24), new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.8 }));
  band.rotation.z = Math.PI / 2; band.position.x = 2.2; g.add(band);
  const band2 = band.clone(); band2.position.x = -2.2; g.add(band2);
  const bare = new THREE.Mesh(new THREE.CylinderGeometry(0.48, 0.48, 0.8, 24), mat); bare.rotation.z = Math.PI / 2; bare.position.x = 3.4; g.add(bare);
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.48, 0.9, 24), mat); tip.rotation.z = -Math.PI / 2; tip.position.x = 4.25; g.add(tip);
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

export function mug() {
  const g = new THREE.Group();
  const pts = [];
  for (let k = 0; k <= 20; k++) { const t = k / 20; pts.push(new THREE.Vector2(2.2 + Math.sin(t * Math.PI) * 0.12, t * 5)); }
  pts.push(new THREE.Vector2(2.0, 5)); pts.push(new THREE.Vector2(2.0, 0.4)); pts.push(new THREE.Vector2(0, 0.4));
  const mat = new THREE.MeshPhysicalMaterial({ color: 0xe9e4da, roughness: 0.18, clearcoat: 1, clearcoatRoughness: 0.05 });
  const body = new THREE.Mesh(new THREE.LatheGeometry(pts, 48), mat); g.add(body);
  const bottom = new THREE.Mesh(new THREE.CircleGeometry(2.2, 48), mat); bottom.rotation.x = Math.PI / 2; g.add(bottom);
  const handle = new THREE.Mesh(new THREE.TorusGeometry(1.1, 0.28, 16, 32, Math.PI * 1.2), mat);
  handle.position.set(2.2, 2.6, 0); handle.rotation.z = -Math.PI * 0.6; g.add(handle);
  const coffee = new THREE.Mesh(new THREE.CircleGeometry(2.0, 48), new THREE.MeshPhysicalMaterial({ color: 0x2a140a, roughness: 0.05, clearcoat: 1 }));
  coffee.rotation.x = -Math.PI / 2; coffee.position.y = 4.4; g.add(coffee);
  const band = new THREE.Mesh(new THREE.CylinderGeometry(2.26, 2.26, 0.7, 48, 1, true), new THREE.MeshStandardMaterial({ color: 0x2c6fd6, roughness: 0.3 }));
  band.position.y = 3.6; g.add(band);
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

export function brick(color, w = 4, d = 2) {
  const g = new THREE.Group();
  const U = 0.8;
  const mat = plastic(color, { roughness: 0.25, clearcoat: 1 });
  const b = new THREE.Mesh(new RoundedBoxGeometry(w * U, U * 1.2, d * U, 3, 0.05), mat); b.position.y = U * 0.6; g.add(b);
  const stud = new THREE.CylinderGeometry(U * 0.3, U * 0.3, U * 0.2, 24);
  for (let i = 0; i < w; i++) for (let j = 0; j < d; j++) {
    const s = new THREE.Mesh(stud, mat); s.position.set((i - (w - 1) / 2) * U, U * 1.3, (j - (d - 1) / 2) * U); g.add(s);
  }
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

export function toySoldier() {
  const g = new THREE.Group();
  const mat = plastic(0x3f6b3a, { roughness: 0.5, clearcoat: 0.2 });
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 0.15, 24), mat); base.position.y = 0.075; g.add(base);
  const legs = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.3, 1.4, 12), mat); legs.position.y = 0.85; g.add(legs);
  const torso = new THREE.Mesh(new RoundedBoxGeometry(0.75, 1.1, 0.45, 2, 0.12), mat); torso.position.y = 2.0; g.add(torso);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.26, 16, 12), mat); head.position.y = 2.8; g.add(head);
  const helm = new THREE.Mesh(new THREE.SphereGeometry(0.32, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), mat); helm.position.y = 2.85; g.add(helm);
  const rifle = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 1.4), mat); rifle.position.set(0.4, 2.2, 0.3); rifle.rotation.x = -0.6; g.add(rifle);
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

// ------------------------------------------------------------------ bedroom furniture (giant, far)
export function bed() {
  const g = new THREE.Group();
  const wood = new THREE.MeshStandardMaterial({ color: 0x8a5a36, roughness: 0.6 });
  const frame = new THREE.Mesh(new RoundedBoxGeometry(20, 4, 40, 3, 0.4), wood); frame.position.y = 2; g.add(frame);
  const mat = new THREE.Mesh(new RoundedBoxGeometry(19, 4, 39, 4, 1.5), new THREE.MeshStandardMaterial({ color: 0xf1ede4, roughness: 0.9 })); mat.position.y = 6; g.add(mat);
  const quilt = new THREE.Mesh(new RoundedBoxGeometry(20.5, 1.5, 28, 4, 0.7), new THREE.MeshStandardMaterial({ color: 0x3a64a8, roughness: 0.95 })); quilt.position.set(0, 8.2, 5); g.add(quilt);
  const pillow = new THREE.Mesh(new RoundedBoxGeometry(12, 2.4, 6, 4, 1.1), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 })); pillow.position.set(0, 9, -15); g.add(pillow);
  const head = new THREE.Mesh(new RoundedBoxGeometry(21, 16, 1.5, 3, 0.5), wood); head.position.set(0, 8, -20); g.add(head);
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

export function bookshelf() {
  const g = new THREE.Group();
  const wood = new THREE.MeshStandardMaterial({ color: 0xe9dcc6, roughness: 0.55 });
  const W = 16, H = 26, D = 5;
  const side = new RoundedBoxGeometry(0.8, H, D, 2, 0.2);
  for (const x of [-W / 2, W / 2]) { const m = new THREE.Mesh(side, wood); m.position.set(x, H / 2, 0); g.add(m); }
  const back = new THREE.Mesh(new THREE.BoxGeometry(W, H, 0.3), wood); back.position.set(0, H / 2, -D / 2); g.add(back);
  const cols = [0xc0392b, 0x2e86c1, 0xf4d03f, 0x27ae60, 0x8e44ad, 0xe67e22, 0x34495e, 0xecf0f1];
  let h = 3;
  const r = () => { h = (h * 16807) % 2147483647; return h / 2147483647; };
  for (let s = 0; s < 4; s++) {
    const y = 0.5 + s * 6.4;
    const shelf = new THREE.Mesh(new THREE.BoxGeometry(W, 0.6, D), wood); shelf.position.set(0, y, 0); g.add(shelf);
    let x = -W / 2 + 0.6;
    while (x < W / 2 - 1.5) {
      const bw = 0.5 + r() * 0.9, bh = 3.2 + r() * 2.2;
      if (r() < 0.12) { x += 1.2; continue; }
      const book = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, D * 0.8), new THREE.MeshStandardMaterial({ color: cols[Math.floor(r() * cols.length)], roughness: 0.7 }));
      book.position.set(x + bw / 2, y + 0.3 + bh / 2, 0.2); book.rotation.z = (r() - 0.5) * 0.05;
      g.add(book); x += bw + 0.05;
    }
  }
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

export function toyChest() {
  const g = new THREE.Group();
  const paintM = new THREE.MeshStandardMaterial({ color: 0xb03a2e, roughness: 0.5 });
  const trim = new THREE.MeshStandardMaterial({ color: 0xf4d03f, roughness: 0.4, metalness: 0.2 });
  const box = new THREE.Mesh(new RoundedBoxGeometry(14, 8, 8, 3, 0.4), paintM); box.position.y = 4; g.add(box);
  const lid = new THREE.Mesh(new RoundedBoxGeometry(14.4, 1.2, 8.4, 3, 0.4), trim); lid.position.y = 8.4; g.add(lid);
  for (const x of [-5, 5]) { const band = new THREE.Mesh(new THREE.BoxGeometry(0.8, 8.2, 8.3), trim); band.position.set(x, 4, 0); g.add(band); }
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}
