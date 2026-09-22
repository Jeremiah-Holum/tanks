// Tall toy obstacles on the board: wooden houses and barns, alphabet-block towers, rows of
// hardback books, tin cans, plastic building-brick walls, toy-fort walls, cardboard boxes.
//
// Every prop is built from primitive pieces that are baked (transformed, vertex-coloured)
// into one merged geometry per material, so the whole board costs ~15 draw calls whatever its
// size. Cardboard boxes are the exception: they break one cell at a time, so they are
// instanced and a broken one is scaled to nothing.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import * as TX from './textures.js';
import * as M from './models.js';

const CELL_BLOCK = 1, CELL_CRATE = 2;
const cache = {};
const once = (k, f) => cache[k] || (cache[k] = f());

// ------------------------------------------------------------------ shared materials
export const propMaterials = () => once('mats', () => {
  const stone = TX.fortStone();
  return {
    wood: new THREE.MeshPhysicalMaterial({ map: TX.woodGrain(), vertexColors: true, roughness: 0.5, clearcoat: 0.45, clearcoatRoughness: 0.35, envMapIntensity: 0.6 }),
    roof: new THREE.MeshPhysicalMaterial({ map: TX.shingles(), vertexColors: true, roughness: 0.62, clearcoat: 0.3, clearcoatRoughness: 0.45, envMapIntensity: 0.5 }),
    cover: new THREE.MeshStandardMaterial({ map: TX.clothGrain(), vertexColors: true, roughness: 0.78, envMapIntensity: 0.4 }),
    pages: new THREE.MeshStandardMaterial({ map: TX.pageEdges(), color: 0xe8dcc0, roughness: 0.92, envMapIntensity: 0.3 }),
    gold: new THREE.MeshStandardMaterial({ color: 0xd7b04a, metalness: 1, roughness: 0.32, envMapIntensity: 1.1 }),
    tin: new THREE.MeshStandardMaterial({ color: 0xc9cdd2, metalness: 1, roughness: 0.4, envMapIntensity: 1.0 }),
    label: new THREE.MeshPhysicalMaterial({ map: TX.canLabels(), roughness: 0.5, clearcoat: 0.3, clearcoatRoughness: 0.4, envMapIntensity: 0.5 }),
    plastic: new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.4, clearcoat: 0.45, clearcoatRoughness: 0.35, specularIntensity: 0.6, envMapIntensity: 0.8 }),
    lid: new THREE.MeshStandardMaterial({ color: 0xaeb2b7, metalness: 1, roughness: 0.55, envMapIntensity: 0.8 }),
    stone: new THREE.MeshStandardMaterial({ map: stone.map, normalMap: stone.normal, normalScale: new THREE.Vector2(1.1, 1.1), vertexColors: true, roughness: 0.78, envMapIntensity: 0.4 }),
    ao: new THREE.MeshBasicMaterial({ map: TX.squareAO(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, color: 0x000000 }),
  };
});

// ------------------------------------------------------------------ geometry baking
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _c = new THREE.Color();

// Normalise any geometry to non-indexed {position, normal, uv, color}.
function norm(geo) {
  let g = geo.index ? geo.toNonIndexed() : geo.clone();
  for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
  if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  g.clearGroups();
  return g;
}

// Box-projected UVs from world position (scale = texture tiles per board unit).
function worldUV(g, scale) {
  const p = g.attributes.position, n = g.attributes.normal, uv = g.attributes.uv;
  for (let k = 0; k < p.count; k++) {
    const ax = Math.abs(n.getX(k)), ay = Math.abs(n.getY(k)), az = Math.abs(n.getZ(k));
    let u, v;
    if (ay >= ax && ay >= az) { u = p.getX(k); v = p.getZ(k); }
    else if (ax >= az) { u = p.getZ(k); v = p.getY(k); }
    else { u = p.getX(k); v = p.getY(k); }
    uv.setXY(k, u * scale, v * scale);
  }
}

class Baker {
  constructor() { this.parts = {}; this.shadow = []; }
  // Shadow proxy parts: the sun's shadow map draws these cheap shapes instead of the detailed
  // props (a house's 2,000 triangles cast the same shadow as its walls, gables and roof slabs).
  sgeo(geo, { x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1 } = {}) {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    for (const k of Object.keys(g.attributes)) if (k !== 'position') g.deleteAttribute(k);
    g.clearGroups();
    _m.compose(_p.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz, 'YXZ')), _s.set(sx, sy, sz));
    g.applyMatrix4(_m);
    if (this.frame) g.applyMatrix4(this.frame);
    this.shadow.push(g);
  }
  sbox(o) { this.sgeo(G.box(), o); }
  // Add `geo` to material bucket `mat`, placed by `mtx` (local) × this.frame (the prop's frame).
  add(mat, geo, { x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1, color = 0xffffff, wuv = 0 } = {}) {
    const g = norm(geo);
    _m.compose(_p.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz, 'YXZ')), _s.set(sx, sy, sz));
    g.applyMatrix4(_m);
    if (this.frame) g.applyMatrix4(this.frame);
    if (wuv) worldUV(g, wuv);
    const n = g.attributes.position.count, col = new Float32Array(n * 3);
    _c.set(color);
    for (let k = 0; k < n; k++) { col[k * 3] = _c.r; col[k * 3 + 1] = _c.g; col[k * 3 + 2] = _c.b; }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    (this.parts[mat] || (this.parts[mat] = [])).push(g);
  }
  build(mats, group) {
    let tris = 0;
    for (const [k, list] of Object.entries(this.parts)) {
      const geo = mergeGeometries(list, false);
      for (const g of list) g.dispose();
      const mesh = new THREE.Mesh(geo, mats[k]);
      mesh.castShadow = false; mesh.receiveShadow = k !== 'ao';
      if (k === 'ao') mesh.renderOrder = 1;
      mesh.userData.own = true;
      group.add(mesh);
      tris += geo.attributes.position.count / 3;
    }
    if (this.shadow.length) {
      const sg = mergeGeometries(this.shadow, false); for (const g of this.shadow) g.dispose();
      const px = M.shadowProxy(sg); px.userData.own = true; group.add(px);
    }
    return tris;
  }
}

// Unit primitives (shared; the baker clones them).
const G = {
  box: () => once('box', () => new THREE.BoxGeometry(1, 1, 1)),
  rbox: (r = 0.04) => once('rbox' + r, () => new RoundedBoxGeometry(1, 1, 1, 2, r)),
  cyl: (seg = 20) => once('cyl' + seg, () => new THREE.CylinderGeometry(1, 1, 1, seg)),
};
// A rounded box of a given size (rounding stays the same absolute size).
// Small parts get one bevel segment (a chamfer reads the same at this size); big ones two.
const rbox = (w, h, d, r = 0.03, seg = Math.max(w, h, d) < 0.4 ? 1 : 2) => new RoundedBoxGeometry(w, h, d, seg, Math.min(r, w / 2 - 1e-3, h / 2 - 1e-3, d / 2 - 1e-3));

// Seeded random per prop.
function rng(seed) { let h = (seed * 2654435761) >>> 0 || 1; return () => { h ^= h << 13; h >>>= 0; h ^= h >>> 17; h ^= h << 5; h >>>= 0; return h / 4294967296; }; }
const pick = (r, a) => a[Math.floor(r() * a.length) % a.length];

// ------------------------------------------------------------------ palettes
const WALLS = [0xf1e3c2, 0xf2d27a, 0x9cc3de, 0xa9d6b5, 0xeab3b0, 0xf4f1ea, 0xc7b5dd, 0xf4b77a];
const ROOFS = [0xb8412f, 0x3f5f9a, 0x3f7a4a, 0x6b4a33, 0x59606b, 0x8a3b5c];
const DOORS = [0xb8412f, 0x2f5d8a, 0x3f7a4a, 0x7a4a2a, 0xe0b030];
const TRIM = 0xf7f4ec;
const BOOKS = [0x8e2a25, 0x223a66, 0x2f5b3a, 0xc99a2e, 0x2a2a2c, 0x5d1f2b, 0x2d6f73, 0xb08a5a, 0xc8642a, 0x4a3b6b];
const BRICKS = [0xd6362c, 0x2a62c9, 0xf2c12e, 0x2f9a4c, 0xe6e3da, 0xf07c28];

// ------------------------------------------------------------------ builders (local frame:
// origin at the centre of the footprint on the board, x along the footprint's width W,
// z along its depth D; everything must stay inside ±W/2, ±D/2)

function window_(B, x, y, z, ry, w = 0.3, h = 0.36, shutters = null) {
  // painted window on a wall whose outward normal is +z rotated by ry
  const c = Math.cos(ry), s = Math.sin(ry);
  const at = (dx, dz) => ({ x: x + dx * c + dz * s, z: z - dx * s + dz * c });
  B.add('wood', G.box(), { ...at(0, 0.012), y, ry, sx: w + 0.06, sy: h + 0.06, sz: 0.024, color: TRIM });
  B.add('wood', G.box(), { ...at(0, 0.02), y, ry, sx: w, sy: h, sz: 0.022, color: 0x2e4a66 });
  B.add('wood', G.box(), { ...at(0, 0.03), y, ry, sx: 0.022, sy: h, sz: 0.02, color: TRIM });
  B.add('wood', G.box(), { ...at(0, 0.03), y, ry, sx: w, sy: 0.022, sz: 0.02, color: TRIM });
  B.add('wood', G.box(), { ...at(0, 0.035), y: y - h / 2 - 0.04, ry, sx: w + 0.12, sy: 0.035, sz: 0.06, color: TRIM });
  if (shutters != null) for (const sd of [-1, 1]) B.add('wood', G.box(), { ...at(sd * (w / 2 + 0.08), 0.015), y, ry, sx: 0.1, sy: h + 0.04, sz: 0.026, color: shutters });
}

function house(B, W, D, r, barn) {
  const inset = 0.07;
  // Build with the ridge along z; swap if the footprint is wider than deep.
  const ridgeX = W > D || (W === D && r() < 0.5);
  const span = (ridgeX ? D : W) - inset * 2, len = (ridgeX ? W : D) - inset * 2;
  const prevFrame = B.frame;
  if (ridgeX) B.frame = (prevFrame ? prevFrame.clone() : new THREE.Matrix4()).multiply(new THREE.Matrix4().makeRotationY(Math.PI / 2));
  const wallC = barn ? 0xa8332a : pick(r, WALLS);
  const roofC = barn ? pick(r, [0x4b4f55, 0x5a6a52, 0x6b4a33]) : pick(r, ROOFS);
  const doorC = barn ? 0xf2efe6 : pick(r, DOORS);
  const shut = !barn && r() < 0.6 ? pick(r, [0x2f5d8a, 0x3f7a4a, 0x7a4a2a, 0xb8412f, 0x33363b]) : null;
  const wallH = barn ? 1.3 : 1.28 + Math.floor(r() * 3) * 0.13;
  const pitch = barn ? 0.95 : 0.78 + r() * 0.12;
  const rise = span / 2 * pitch;
  const hs = span / 2, hl = len / 2;
  // plinth + walls
  B.add('wood', rbox(span + 0.06, 0.08, len + 0.06, 0.02), { y: 0.04, color: barn ? 0x6b5a4a : 0x8a7e70 });
  B.add('wood', rbox(span, wallH, len, 0.035), { y: 0.08 + wallH / 2 - 0.04, color: wallC });
  B.sbox({ y: 0.04 + wallH / 2, sx: span - 0.02, sy: wallH + 0.08, sz: len - 0.02 });
  const top = 0.04 + wallH;
  // gables (triangular prisms) — extruded along z, then centred
  const gs = new THREE.Shape(); gs.moveTo(-hs, 0); gs.lineTo(hs, 0); gs.lineTo(0, rise); gs.lineTo(-hs, 0);
  const gg = new THREE.ExtrudeGeometry(gs, { depth: len, bevelEnabled: false }); gg.translate(0, 0, -hl);
  B.add('wood', gg, { y: top - 0.001, color: wallC });
  B.sgeo(gg, { y: top - 0.001 });
  gg.dispose();
  // roof slabs
  const oh = 0.11, a = Math.atan2(rise, hs), th = 0.07;
  const slabW = (hs + oh) / Math.cos(a);
  for (const sd of [-1, 1]) {
    const cx = sd * (hs + oh) / 2, cy = top + rise - (hs + oh) / 2 * Math.tan(a);
    B.add('roof', rbox(slabW, th, len + oh * 2, 0.02), { x: cx + sd * Math.sin(a) * th / 2, y: cy + Math.cos(a) * th / 2, rz: -sd * a, color: roofC, wuv: 0 });
    B.sbox({ x: cx + sd * Math.sin(a) * th / 2, y: cy + Math.cos(a) * th / 2, rz: -sd * a, sx: slabW - 0.02, sy: th - 0.01, sz: len + oh * 2 - 0.02 });
  }
  // shingle UVs: map the roof slabs along the slope (redo on the last two parts)
  const rp = B.parts.roof;
  for (const g of rp.slice(-2)) { const uv = g.attributes.uv, p = g.attributes.position; for (let k = 0; k < uv.count; k++) uv.setXY(k, uv.getX(k) * slabW * 1.4, uv.getY(k) * (len + oh * 2) * 1.4); void p; }
  B.add('roof', G.cyl(12), { y: top + rise + th * 0.7, rx: Math.PI / 2, sx: 0.05, sz: 0.05, sy: len + oh * 2 + 0.02, color: new THREE.Color(roofC).multiplyScalar(0.8).getHex() });
  // fascia boards along the eaves
  if (!barn) for (const sd of [-1, 1]) B.add('wood', G.box(), { x: sd * (hs + oh * 0.85), y: top - oh * Math.tan(a) - 0.02, sx: 0.035, sy: 0.07, sz: len + oh * 2, color: TRIM });
  // chimney (houses) / vent (barns)
  if (!barn) {
    const cx = hs * 0.45 * (r() < 0.5 ? -1 : 1), cz = hl * (0.25 + r() * 0.4) * (r() < 0.5 ? -1 : 1);
    const base = top + rise * (1 - Math.abs(cx) / hs) - 0.15;
    const ch = top + rise + 0.32 - base;
    B.add('wood', rbox(0.2, ch, 0.24, 0.015), { x: cx, y: base + ch / 2, z: cz, color: 0x9c4a36 });
    B.sbox({ x: cx, y: base + ch / 2, z: cz, sx: 0.2, sy: ch, sz: 0.24 });
    B.add('wood', rbox(0.26, 0.06, 0.3, 0.015), { x: cx, y: base + ch, z: cz, color: 0x6e3326 });
  } else {
    B.add('wood', rbox(0.3, 0.26, 0.3, 0.02), { y: top + rise + 0.15, color: TRIM });
    B.sbox({ y: top + rise + 0.15, sx: 0.3, sy: 0.26, sz: 0.3 });
    B.add('roof', G.cyl(4), { y: top + rise + 0.34, ry: Math.PI / 4, sx: 0.26, sz: 0.26, sy: 0.14, color: roofC });
  }
  // windows and a door on the eave walls; a window in each gable
  const rowsY = wallH > 1.35 ? [0.08 + wallH * 0.3, 0.08 + wallH * 0.72] : [0.08 + wallH * 0.36, 0.08 + wallH * 0.75];
  const nWin = Math.max(1, Math.floor((len - 0.2) / 0.62));
  const doorSide = r() < 0.5 ? 1 : -1, doorK = Math.floor(nWin / 2);
  for (const sd of [-1, 1]) {
    for (let k = 0; k < nWin; k++) {
      const z = -hl + (k + 0.5) * len / nWin;
      for (let rI = 0; rI < rowsY.length; rI++) {
        if (barn && rI === 0) continue;
        if (!barn && sd === doorSide && k === doorK && rI === 0) {
          // front door with a step and a brass knob
          const dh = 0.62, dy = 0.08 + dh / 2;
          B.add('wood', G.box(), { x: sd * (hs + 0.012), y: dy + 0.02, z, sx: 0.024, sy: dh + 0.07, sz: 0.4, color: TRIM });
          B.add('wood', rbox(0.03, dh, 0.32, 0.01), { x: sd * (hs + 0.02), y: dy, z, color: doorC });
          B.add('wood', G.box(), { x: sd * (hs + 0.04), y: dy, z: z + 0.1, sx: 0.03, sy: 0.03, sz: 0.03, color: 0xe0b84a });
          B.add('wood', rbox(0.14, 0.05, 0.48, 0.015), { x: sd * (hs + 0.07), y: 0.025, z, color: 0x9a9088 });
          continue;
        }
        window_(B, sd * hs, rowsY[rI], z, sd > 0 ? Math.PI / 2 : -Math.PI / 2, 0.26, 0.32, rI === 1 || !barn ? shut : null);
      }
    }
  }
  if (barn) {
    // big double door with white X bracing on one gable, hayloft door above
    const dz = hl * (r() < 0.5 ? 1 : -1), sg = Math.sign(dz), dw = Math.min(0.9, span * 0.5), dh = 0.95;
    const dy = 0.08 + dh / 2;
    B.add('wood', G.box(), { z: dz + sg * 0.014, y: dy, sx: dw + 0.08, sy: dh + 0.06, sz: 0.028, color: TRIM });
    B.add('wood', G.box(), { z: dz + sg * 0.024, y: dy - 0.01, sx: dw, sy: dh - 0.02, sz: 0.028, color: 0x8e2a22 });
    const diag = Math.atan2(dh - 0.1, dw / 2 - 0.06);
    for (const hx of [-dw / 4, dw / 4]) for (const d of [-1, 1]) B.add('wood', G.box(), { x: hx, z: dz + sg * 0.036, y: dy, rz: d * diag, sx: Math.hypot(dw / 2 - 0.06, dh - 0.1), sy: 0.04, sz: 0.02, color: TRIM });
    B.add('wood', G.box(), { z: dz + sg * 0.036, y: dy, sx: 0.035, sy: dh, sz: 0.02, color: TRIM });
    const ly = top + rise * 0.35;
    B.add('wood', G.box(), { z: dz + sg * 0.014, y: ly, sx: 0.36, sy: 0.36, sz: 0.028, color: TRIM });
    B.add('wood', G.box(), { z: dz + sg * 0.024, y: ly, sx: 0.28, sy: 0.28, sz: 0.028, color: 0x8e2a22 });
    for (const d of [-1, 1]) B.add('wood', G.box(), { z: dz + sg * 0.034, y: ly, rz: d * Math.PI / 4, sx: 0.36, sy: 0.035, sz: 0.02, color: TRIM });
    // white corner trims
    for (const cx of [-1, 1]) for (const cz of [-1, 1]) B.add('wood', G.box(), { x: cx * (hs + 0.005), z: cz * (hl + 0.005), y: 0.08 + wallH / 2, sx: 0.05, sy: wallH, sz: 0.05, color: TRIM });
  } else if (rise > 0.6) {
    for (const sd of [-1, 1]) {
      const wy = top + rise * 0.36;
      B.add('wood', G.cyl(20), { z: sd * (hl + 0.012), y: wy, rx: Math.PI / 2, sx: 0.15, sz: 0.15, sy: 0.024, color: TRIM });
      B.add('wood', G.cyl(20), { z: sd * (hl + 0.02), y: wy, rx: Math.PI / 2, sx: 0.11, sz: 0.11, sy: 0.024, color: 0x2e4a66 });
    }
  }
  // gable-end ground windows (non-barn)
  if (!barn && len > 1.5) for (const sd of [-1, 1]) {
    const n = Math.max(1, Math.floor((span - 0.3) / 0.7));
    for (let k = 0; k < n; k++) window_(B, -hs + (k + 0.5) * span / n, rowsY[0], sd * hl, sd > 0 ? 0 : Math.PI, 0.26, 0.32, shut);
  }
  B.frame = prevFrame;
  return top + rise;
}

function tower(B, r, n) {
  const mats = TX.BLOCK_VARIANTS;
  let y = 0;
  for (let k = 0; k < n; k++) {
    const v = Math.floor(r() * mats) % mats;
    const o = { x: (r() - 0.5) * 0.07, z: (r() - 0.5) * 0.07, y: y + 0.47, ry: Math.floor(r() * 4) * Math.PI / 2 + (r() - 0.5) * 0.22 };
    B.add('block' + v, M.blockGeo(), o);
    B.sbox({ ...o, sx: 0.93, sy: 0.93, sz: 0.93 });
    y += 0.94;
  }
  return y;
}

function books(B, W, D, r) {
  // row along x (length L), spines facing +z (or -z)
  const along = W >= D, L = Math.max(W, D);
  const prev = B.frame;
  if (!along) B.frame = (prev ? prev.clone() : new THREE.Matrix4()).multiply(new THREE.Matrix4().makeRotationY(Math.PI / 2));
  const face = r() < 0.5 ? 1 : -1;
  let x = -L / 2 + 0.05, maxH = 0;
  const end = L / 2 - 0.05;
  const b = 0.022;
  // The two end books show their whole front/back cover: give those a blind-tooled border,
  // a gilt frame and a title plate, so they read as hardbacks, not flat slabs.
  const coverArt = (xf, sgn, H, dp, zc, col) => {
    const X = xf + sgn * 0.004, dk = new THREE.Color(col).multiplyScalar(0.72).getHex();
    const zw = dp - 0.1, hh = H - 0.12;
    B.add('cover', G.box(), { x: X - sgn * 0.001, y: H / 2, z: zc, sx: 0.006, sy: hh, sz: zw, color: dk });
    for (const [yy, sy, zz, sz] of [[H / 2 + hh / 2 - 0.05, 0.014, zc, zw - 0.1], [H / 2 - hh / 2 + 0.05, 0.014, zc, zw - 0.1], [H / 2, hh - 0.1, zc + (zw - 0.1) / 2, 0.014], [H / 2, hh - 0.1, zc - (zw - 0.1) / 2, 0.014]]) {
      B.add('gold', G.box(), { x: X + sgn * 0.002, y: yy, z: zz, sx: 0.006, sy, sz });
    }
    B.add('cover', G.box(), { x: X + sgn * 0.002, y: H * 0.64, z: zc, sx: 0.006, sy: 0.22, sz: zw * 0.55, color: 0xefe4c6 });
    B.add('gold', G.box(), { x: X + sgn * 0.004, y: H * 0.64, z: zc, sx: 0.004, sy: 0.03, sz: zw * 0.4 });
  };
  let first = true;
  while (x < end - 0.12) {
    const t = Math.min(0.14 + r() * 0.17, end - x), H = 1.3 + r() * 0.45, dp = 0.74 + r() * 0.16;
    const col = pick(r, BOOKS);
    const zs = face * 0.44, zc = zs - face * dp / 2;
    const cx = x + t / 2;
    // covers, spine, page block
    B.add('cover', G.box(), { x: x + b / 2, y: H / 2, z: zc, sx: b, sy: H, sz: dp, color: col });
    B.add('cover', G.box(), { x: x + t - b / 2, y: H / 2, z: zc, sx: b, sy: H, sz: dp, color: col });
    B.add('cover', rbox(t, H, 0.04, 0.012, 1), { x: cx, y: H / 2, z: zs - face * 0.02, color: col });
    B.add('pages', G.box(), { x: cx, y: (H - 0.03) / 2 + 0.012, z: zc - face * 0.012, sx: t - b * 2, sy: H - 0.04, sz: dp - 0.05 });
    B.sbox({ x: cx, y: H / 2, z: (zs + zc - face * dp / 2) / 2, sx: t, sy: H, sz: dp + 0.03 });
    // gilt bands + a paper title label on the spine
    for (const fy of [0.1, 0.86, 0.9]) B.add('gold', G.box(), { x: cx, y: H * fy, z: zs + face * 0.002, sx: t * 0.86, sy: 0.018, sz: 0.012 });
    if (r() < 0.75) B.add('cover', G.box(), { x: cx, y: H * (0.55 + r() * 0.15), z: zs + face * 0.003, sx: t * 0.7, sy: 0.2 + r() * 0.1, sz: 0.01, color: r() < 0.5 ? 0xf0e6cc : 0x1c1c1c });
    if (first) coverArt(x, -1, H, dp, zc, col);
    if (x + t + 0.004 >= end - 0.12) coverArt(x + t, 1, H, dp, zc, col);
    first = false;
    maxH = Math.max(maxH, H);
    x += t + 0.004;
  }
  B.frame = prev;
  return maxH;
}

function can(B, r) {
  const R = 0.42, H = 1.24 + r() * 0.1;
  const side = [[0, 0], [R - 0.03, 0], [R + 0.006, 0.015], [R + 0.014, 0.04], [R, 0.06], [R, 0.1], [R - 0.004, 0.11], [R, 0.12],
    [R, H - 0.12], [R - 0.004, H - 0.11], [R, H - 0.1], [R, H - 0.06], [R + 0.014, H - 0.035], [R + 0.01, H], [R - 0.025, H + 0.004], [R - 0.035, H - 0.03]];
  const lid = [[R - 0.035, H - 0.03], [0.3, H - 0.03], [0.29, H - 0.018], [0.27, H - 0.03], [0.18, H - 0.03], [0.17, H - 0.018], [0.16, H - 0.03], [0, H - 0.03]];
  const v2 = (a) => a.map(([x, y]) => new THREE.Vector2(x, y));
  const hk = H.toFixed(2);
  const body = once('canBody' + hk, () => new THREE.LatheGeometry(v2(side), 32));
  const top = once('canLid' + hk, () => new THREE.LatheGeometry(v2(lid), 32));
  const ry = r() * Math.PI * 2;
  B.add('tin', body, { ry });
  B.add('lid', top, { ry });
  const lab = new THREE.CylinderGeometry(R + 0.005, R + 0.005, H - 0.26, 32, 1, true);
  const slot = Math.floor(r() * TX.CAN_LABELS), uv = lab.attributes.uv;
  for (let k = 0; k < uv.count; k++) uv.setY(k, 1 - (slot + 1 - uv.getY(k)) / TX.CAN_LABELS);
  B.add('label', lab, { y: H / 2, ry });
  lab.dispose();
  B.sgeo(G.cyl(16), { y: H / 2, sx: R, sy: H, sz: R });
  return H;
}

function bricks(B, W, D, r) {
  // Chunky toddler bricks, 2 studs deep; two staggered courses with studs on top.
  const along = W >= D, L = Math.max(W, D);
  const prev = B.frame;
  if (!along) B.frame = (prev ? prev.clone() : new THREE.Matrix4()).multiply(new THREE.Matrix4().makeRotationY(Math.PI / 2));
  const P = 0.45, HB = 0.5, n = Math.round(L / P);
  const x0 = -n * P / 2;
  for (let course = 0; course < 2; course++) {
    let s = 0;
    const y = course * HB + HB / 2;
    const lens = [];
    if (course === 1) lens.push(1);
    let left = n - (course === 1 ? 2 : 0);
    while (left > 0) { const l = left >= 4 && r() < 0.6 ? 4 : Math.min(2, left); lens.push(l); left -= l; }
    if (course === 1) lens.push(1);
    for (const l of lens) {
      const col = pick(r, BRICKS);
      B.add('plastic', rbox(l * P - 0.012, HB - 0.008, 2 * P - 0.03, 0.025, 1), { x: x0 + (s + l / 2) * P, y, color: col });
      B.sbox({ x: x0 + (s + l / 2) * P, y, sx: l * P - 0.012, sy: HB - 0.008, sz: 2 * P - 0.03 });
      if (course === 1) for (let k = 0; k < l; k++) for (const zz of [-P / 2, P / 2]) {
        B.add('plastic', G.cyl(12), { x: x0 + (s + k + 0.5) * P, y: HB * 2 + 0.04, z: zz, sx: 0.14, sz: 0.14, sy: 0.08, color: col });
      }
      s += l;
    }
  }
  B.frame = prev;
  return HB * 2 + 0.08;
}

function fortWall(B, W, D, r, endL, endR) {
  const along = W >= D, L = Math.max(W, D);
  const prev = B.frame;
  if (!along) B.frame = (prev ? prev.clone() : new THREE.Matrix4()).multiply(new THREE.Matrix4().makeRotationY(Math.PI / 2));
  const T = 0.8, H = 1.12, col = 0xb9b4a8;
  B.add('stone', rbox(L - 0.04, H, T, 0.03), { y: H / 2, color: col, wuv: 1 });
  B.sbox({ y: H / 2, sx: L - 0.04, sy: H, sz: T });
  B.add('stone', rbox(L, 0.08, T + 0.06, 0.02), { y: H - 0.02, color: 0xa8a397, wuv: 1 });
  // merlons across the top
  const step = 0.5, nM = Math.max(1, Math.floor(L / step));
  for (let k = 0; k < nM; k++) {
    const x = -L / 2 + (k + 0.5) * L / nM;
    if (k % 2 === 0 || nM < 2) { B.add('stone', rbox(L / nM * 0.95, 0.28, T + 0.02, 0.02, 1), { x, y: H + 0.12, color: col, wuv: 1 }); B.sbox({ x, y: H + 0.12, sx: L / nM * 0.95, sy: 0.28, sz: T }); }
  }
  // arrow slits
  for (let k = 0; k < Math.floor(L); k++) for (const sd of [-1, 1]) B.add('wood', G.box(), { x: -L / 2 + k + 0.5, y: H * 0.55, z: sd * (T / 2 + 0.003), sx: 0.06, sy: 0.26, sz: 0.01, color: 0x1a1816 });
  // corner towers on the free ends
  for (const [e, on] of [[-1, endL], [1, endR]]) {
    if (!on || L < 2) continue;
    const x = e * (L / 2 - 0.47);
    B.add('stone', rbox(0.92, 1.62, 0.92, 0.03), { x, y: 0.81, color: 0xc4bfb2, wuv: 1 });
    B.sbox({ x, y: 0.81, sx: 0.92, sy: 1.62, sz: 0.92 });
    for (const cx of [-1, 1]) for (const cz of [-1, 1]) { B.add('stone', rbox(0.26, 0.26, 0.26, 0.02, 1), { x: x + cx * 0.33, z: cz * 0.33, y: 1.75, color: 0xc4bfb2, wuv: 1 }); B.sbox({ x: x + cx * 0.33, z: cz * 0.33, y: 1.75, sx: 0.26, sy: 0.26, sz: 0.26 }); }
  }
  B.frame = prev;
  return H + 0.26;
}

// Soft contact shadow under a footprint: a 9-slice quad using the square AO texture.
function aoQuad(B, W, D, f = 0.34, m = 0.05) {
  const hw = W / 2 - m, hd = D / 2 - m;
  const xs = [-hw - f, -hw + 0.12, hw - 0.12, hw + f], zs = [-hd - f, -hd + 0.12, hd - 0.12, hd + f], us = [0, 0.2, 0.8, 1];
  const pos = [], uv = [], nrm = [];
  for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) {
    const q = [[a, b], [a + 1, b + 1], [a + 1, b], [a, b], [a, b + 1], [a + 1, b + 1]];
    for (const [ia, ib] of q) { pos.push(xs[ia], 0.003, zs[ib]); uv.push(us[ia], us[ib]); nrm.push(0, 1, 0); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  B.add('ao', g);
  g.dispose();
}

// ------------------------------------------------------------------ the board's props
// Returns { group, crates: {mesh, ao, byCell: Map(cell -> [instance ids])}, height: Float32Array,
//           surface: Uint8Array (SURF_*) per cell, tris }
export const SURF = { NONE: 0, WOOD: 1, PAPER: 2, METAL: 3, PLASTIC: 4, STONE: 5, CARD: 6 };
const SURF_OF = { house: SURF.WOOD, tower: SURF.WOOD, books: SURF.PAPER, can: SURF.METAL, bricks: SURF.PLASTIC, wall: SURF.STONE, hedge: SURF.CARD, crates: SURF.CARD };

// A foam hedge clump: a soft rounded block, lumpy (position-seeded, so seams stay closed).
const hedgeGeo = () => once('hedgeGeo', () => {
  const g = new RoundedBoxGeometry(1, 1, 1, 4, 0.28);
  const p = g.attributes.position, n = g.attributes.normal, v = new THREE.Vector3();
  const lump = (x, y, z) => Math.sin(x * 17.3 + y * 5.1) * Math.sin(z * 15.7 - x * 3.3) * Math.sin(y * 13.9 + z * 7.7);
  for (let k = 0; k < p.count; k++) {
    v.set(p.getX(k), p.getY(k), p.getZ(k));
    const d = lump(v.x, v.y, v.z) * 0.035 + 0.01;
    const l = v.length() || 1;
    p.setXYZ(k, v.x + v.x / l * d, v.y + v.y / l * d, v.z + v.z / l * d);
  }
  void n; // keep the analytic normals: the lumps are small and the flock bump does the rest
  return g;
});
const hedgeMat = () => once('hedgeMat', () => { const t = TX.hedgeFlock(); return new THREE.MeshStandardMaterial({ map: t, bumpMap: t, bumpScale: 2.5, roughness: 0.95, envMapIntensity: 0.25 }); });

export function buildProps(world, OX, OZ) {
  const grid = world.grid, C = world.cols, R = world.rows;
  const mats = propMaterials();
  const bm = M.blockMaterials();
  const allMats = { ...mats };
  bm.forEach((m, v) => { allMats['block' + v] = m; });
  const group = new THREE.Group();
  const B = new Baker();
  const owned = new Int32Array(C * R).fill(-1);
  const height = new Float32Array(C * R), surface = new Uint8Array(C * R);
  const props = world.props || [];
  // A prop renders as itself only if every cell of its footprint is still the right solid
  // (versus spawn pads can carve cells out of a generated prop); otherwise its cells fall back
  // to leftovers.
  props.forEach((p, k) => {
    const want = p.kind === 'hedge' || p.kind === 'crates' ? CELL_CRATE : CELL_BLOCK;
    for (let j = p.j; j < p.j + p.h; j++) for (let i = p.i; i < p.i + p.w; i++) {
      if (i < 0 || j < 0 || i >= C || j >= R || grid[j * C + i] !== want) return;
    }
    for (let j = p.j; j < p.j + p.h; j++) for (let i = p.i; i < p.i + p.w; i++) if (owned[j * C + i] < 0) owned[j * C + i] = k;
  });
  const setCells = (p, h, s) => { for (let j = p.j; j < p.j + p.h; j++) for (let i = p.i; i < p.i + p.w; i++) { height[j * C + i] = h; surface[j * C + i] = s; } };
  const wallCells = new Set();
  props.forEach((p) => { if (p.kind === 'wall') for (let j = p.j; j < p.j + p.h; j++) for (let i = p.i; i < p.i + p.w; i++) wallCells.add(j * C + i); });
  props.forEach((p, k) => {
    if (p.kind === 'hedge' || p.kind === 'crates') return;
    let mine = true;
    for (let j = p.j; j < p.j + p.h && mine; j++) for (let i = p.i; i < p.i + p.w; i++) if (owned[j * C + i] !== k) { mine = false; break; }
    if (!mine) return;
    const r = rng(p.v * 7919 + p.i * 131 + p.j * 17 + 1);
    const cx = p.i + p.w / 2 - OX, cz = p.j + p.h / 2 - OZ;
    B.frame = new THREE.Matrix4().compose(_p.set(cx, 0, cz), _q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.mirror ? Math.PI : 0), _s.set(1, 1, 1));
    let h = 1;
    switch (p.kind) {
      case 'house': h = house(B, p.w, p.h, r, !!p.barn); break;
      case 'tower': h = tower(B, r, r() < 0.3 ? 2 : 3); break;
      case 'books': h = books(B, p.w, p.h, r); break;
      case 'can': h = can(B, r); break;
      case 'bricks': h = bricks(B, p.w, p.h, r); break;
      case 'wall': {
        const along = p.w >= p.h;
        const e0 = along ? [p.i - 1, p.j] : [p.i, p.j - 1], e1 = along ? [p.i + p.w, p.j] : [p.i, p.j + p.h];
        const free = ([i, j]) => !wallCells.has(j * C + i);
        let endL = free(e0), endR = free(e1);
        // local -x is e0 unless the frame turns it round (vertical runs, mirrored props)
        if (!along !== !!p.mirror) [endL, endR] = [endR, endL];
        h = fortWall(B, p.w, p.h, r, endL, endR); break;
      }
      default: h = tower(B, r, 2);
    }
    B.frame = new THREE.Matrix4().makeTranslation(cx, 0, cz);
    aoQuad(B, p.w, p.h, p.kind === 'house' ? 0.42 : 0.34);
    setCells(p, h, SURF_OF[p.kind] || SURF.WOOD);
  });
  // leftover blocks: 1-3 block stacks
  for (let j = 0; j < R; j++) for (let i = 0; i < C; i++) {
    const c = grid[j * C + i];
    if (c !== CELL_BLOCK || owned[j * C + i] >= 0) continue;
    const r = rng(i * 92821 + j * 689287 + (world.levelIndex || 0) * 7 + 3);
    const cx = i + 0.5 - OX, cz = j + 0.5 - OZ;
    B.frame = new THREE.Matrix4().makeTranslation(cx, 0, cz);
    const n = 1 + Math.floor(r() * 3);
    const h = tower(B, r, n);
    aoQuad(B, 1, 1);
    height[j * C + i] = h; surface[j * C + i] = SURF.WOOD;
  }
  B.frame = null;
  const tris = B.build(allMats, group);
  // cardboard boxes and foam hedges (instanced so each cell can break on its own)
  const crateCells = [];
  for (let j = 0; j < R; j++) for (let i = 0; i < C; i++) if (grid[j * C + i] === CELL_CRATE) crateCells.push([i, j]);
  const hedgeCell = new Set();
  props.forEach((p) => { if (p.kind === 'hedge') for (let j = p.j; j < p.j + p.h; j++) for (let i = p.i; i < p.i + p.w; i++) hedgeCell.add(j * C + i); });
  const boxes = [], bushes = [];
  for (const [i, j] of crateCells) {
    const r = rng(i * 7349 + j * 1571 + 11);
    const cx = i + 0.5 - OX, cz = j + 0.5 - OZ, cell = j * C + i;
    if (hedgeCell.has(cell)) {
      // a clipped hedge: one main clump filling the cell, sometimes a smaller lump on top
      const h0 = 0.78 + r() * 0.14;
      // (slightly wider than the cell, so a row of cells reads as one continuous hedgerow)
      bushes.push({ cell, x: cx + (r() - 0.5) * 0.03, y: h0 / 2, z: cz + (r() - 0.5) * 0.03, sx: 1.08 + r() * 0.05, sy: h0, sz: 1.08 + r() * 0.05, ry: Math.floor(r() * 4) * Math.PI / 2 });
      let h = h0;
      if (r() < 0.25) { const h1 = 0.16 + r() * 0.08; bushes.push({ cell, x: cx + (r() - 0.5) * 0.16, y: h0 + h1 / 2 - 0.08, z: cz + (r() - 0.5) * 0.16, sx: 0.62 + r() * 0.2, sy: h1 + 0.1, sz: 0.62 + r() * 0.2, ry: r() * 6 }); h += h1 - 0.08; }
      height[cell] = h; surface[cell] = SURF.CARD;
      continue;
    }
    const h0 = 0.74 + r() * 0.1, w0 = 0.84 + r() * 0.06;
    boxes.push({ cell, x: cx + (r() - 0.5) * 0.04, y: h0 / 2, z: cz + (r() - 0.5) * 0.04, sx: w0, sy: h0, sz: 0.82 + r() * 0.08, ry: Math.floor(r() * 4) * Math.PI / 2 + (r() - 0.5) * 0.1 });
    let h = h0;
    if (r() < 0.5) {
      const h1 = 0.5 + r() * 0.16, w1 = 0.56 + r() * 0.18;
      boxes.push({ cell, x: cx + (r() - 0.5) * 0.12, y: h0 + h1 / 2, z: cz + (r() - 0.5) * 0.12, sx: w1, sy: h1, sz: 0.54 + r() * 0.2, ry: (r() - 0.5) * 0.9 });
      h += h1;
    }
    height[cell] = h; surface[cell] = SURF.CARD;
  }
  const crateMesh = new THREE.InstancedMesh(M.crateGeo(), M.crateMaterial(), Math.max(1, boxes.length));
  const crateAO = new THREE.InstancedMesh(once('aoUnit', () => new THREE.PlaneGeometry(1.5, 1.5).rotateX(-Math.PI / 2)), mats.ao, Math.max(1, crateCells.length));
  const byCell = new Map();
  boxes.forEach((b, k) => {
    _m.compose(_p.set(b.x, b.y, b.z), _q.setFromEuler(_e.set(0, b.ry, 0)), _s.set(b.sx / 0.9, b.sy / 0.82, b.sz / 0.9));
    crateMesh.setMatrixAt(k, _m);
    const e = byCell.get(b.cell) || { boxes: [], ao: -1 }; e.boxes.push(k); byCell.set(b.cell, e);
  });
  crateCells.forEach(([i, j], k) => {
    _m.makeTranslation(i + 0.5 - OX, 0.004, j + 0.5 - OZ);
    crateAO.setMatrixAt(k, _m);
    const e = byCell.get(j * C + i) || { boxes: [], ao: -1 }; e.ao = k; byCell.set(j * C + i, e);
  });
  crateMesh.count = boxes.length; crateAO.count = crateCells.length;
  const hedgeMesh = new THREE.InstancedMesh(hedgeGeo(), hedgeMat(), Math.max(1, bushes.length));
  bushes.forEach((b, k) => {
    _m.compose(_p.set(b.x, b.y, b.z), _q.setFromEuler(_e.set(0, b.ry, 0)), _s.set(b.sx, b.sy, b.sz));
    hedgeMesh.setMatrixAt(k, _m);
    const e = byCell.get(b.cell) || { boxes: [], bushes: [], ao: -1 }; (e.bushes || (e.bushes = [])).push(k); byCell.set(b.cell, e);
  });
  hedgeMesh.count = bushes.length; hedgeMesh.receiveShadow = true; hedgeMesh.userData.own = true;
  const hedgeSh = new THREE.InstancedMesh(once('hedgeBox', () => new THREE.BoxGeometry(0.9, 0.9, 0.9)), M.proxyMat(), Math.max(1, bushes.length));
  hedgeSh.instanceMatrix = hedgeMesh.instanceMatrix; hedgeSh.count = bushes.length; M.makeShadowOnly(hedgeSh);
  group.add(hedgeMesh, hedgeSh);
  crateMesh.castShadow = false; crateMesh.receiveShadow = true; crateAO.renderOrder = 1;
  crateMesh.userData.own = true; crateAO.userData.own = true;
  // shadow proxy: plain boxes sharing the crates' instance matrices (a broken crate vanishes from both)
  const crateSh = new THREE.InstancedMesh(once('crateBox', () => new THREE.BoxGeometry(0.88, 0.8, 0.88)), crateMesh.material, Math.max(1, boxes.length));
  crateSh.instanceMatrix = crateMesh.instanceMatrix; crateSh.count = boxes.length;
  crateSh.material = M.proxyMat(); M.makeShadowOnly(crateSh);
  group.add(crateMesh, crateAO, crateSh);
  return { group, crates: { mesh: crateMesh, ao: crateAO, hedges: hedgeMesh, byCell }, height, surface, tris: tris + boxes.length * 200 };
}

const _zero = new THREE.Matrix4().makeScale(0, 0, 0);
export function breakCrate(crates, cell) {
  const e = crates.byCell.get(cell);
  if (!e) return false;
  for (const k of e.boxes) crates.mesh.setMatrixAt(k, _zero);
  if (e.bushes) { for (const k of e.bushes) crates.hedges.setMatrixAt(k, _zero); crates.hedges.instanceMatrix.needsUpdate = true; }
  if (e.ao >= 0) crates.ao.setMatrixAt(e.ao, _zero);
  crates.mesh.instanceMatrix.needsUpdate = true; crates.ao.instanceMatrix.needsUpdate = true;
  crates.byCell.delete(cell);
  return true;
}
