// Map props. Two BatchedMeshes carry almost everything (so props cost ~2 draw calls + 2 shadow
// draws): `veg` (trees, conifers, bushes, hedges and the forests outside the map; foliage cards
// with an alpha-tested atlas, near/far LOD swapped by distance, wind sway) and `solid`
// (buildings, walls, fences, rocks, haystacks, bridges, traps...; one texture atlas with
// fract() tiling). Visual footprints follow sim/map/objects.js objectParts / foliagePart.
// Breaking: trees and fences topple (animated about their base), crushed walls / sheds /
// sandbags / haystacks turn into rubble or flatten, destroyed buildings become rubble piles.
import * as THREE from 'three';
import { foliageAtlas, FOL_CELL, buildingAtlas, ATLAS, TILE_M } from './textures.js';
import { patchFarShadow } from './terrain.js';

function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// ================================================================== vegetation geometry
// Built in metres at a nominal size, then normalised to the unit box the instance matrix
// scales back up: x,z ∈ [-1,1] (crown half-width), y ∈ [0,1] (total height).
class VB {
  constructor() { this.p = []; this.n = []; this.uv = []; this.c = []; this.w = []; this.i = []; }
  vert(p, n, u, v, ao, wind) {
    this.p.push(p.x, p.y, p.z); this.n.push(n.x, n.y, n.z); this.uv.push(u, v); this.c.push(ao, ao, ao); this.w.push(wind);
    return this.p.length / 3 - 1;
  }
  // quad centred at c with half-axes U, V on atlas cell k. nf(p) → normal, af(p, u) → ao, wf(p, u) → wind
  card(c, U, V, k, nf, af, wf, flipU = false) {
    const [u0, v0, du, dv] = FOL_CELL(k);
    const P = [c.clone().sub(U).sub(V), c.clone().add(U).sub(V), c.clone().add(U).add(V), c.clone().sub(U).add(V)];
    const UV = [[0, 0], [1, 0], [1, 1], [0, 1]];
    const b = this.p.length / 3;
    P.forEach((p, j) => { const uu = flipU ? 1 - UV[j][0] : UV[j][0]; this.vert(p, nf(p), u0 + du * (0.02 + 0.96 * uu), v0 + dv * (0.02 + 0.96 * UV[j][1]), af(p, uu), wf(p, uu)); });
    this.i.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  // tapered tube p0→p1, bark cell k, uv v in metres / vRep
  tube(p0, p1, r0, r1, sides, k, ao0, ao1, w0, w1, vRep = 2.5) {
    const [u0, v0, du, dv] = FOL_CELL(k);
    const d = p1.clone().sub(p0), L = d.length(); d.normalize();
    const a = Math.abs(d.y) < 0.9 ? V3(0, 1, 0) : V3(1, 0, 0);
    const X = a.clone().cross(d).normalize(), Y = d.clone().cross(X).normalize();
    const segs = Math.max(1, Math.ceil(L / vRep));
    for (let s = 0; s < segs; s++) {
      const t0 = s / segs, t1 = (s + 1) / segs, b = this.p.length / 3;
      for (const [t, tv] of [[t0, 0], [t1, Math.min(1, (t1 - t0) * L / vRep)]]) {
        const r = r0 + (r1 - r0) * t, c = p0.clone().addScaledVector(d, L * t);
        for (let j = 0; j <= sides; j++) {
          const ang = (j / sides) * Math.PI * 2, n = X.clone().multiplyScalar(Math.cos(ang)).addScaledVector(Y, Math.sin(ang));
          this.vert(c.clone().addScaledVector(n, r), n, u0 + du * (j / sides), v0 + dv * (0.01 + 0.98 * tv), ao0 + (ao1 - ao0) * t, w0 + (w1 - w0) * t);
        }
      }
      for (let j = 0; j < sides; j++) { const a0 = b + j, b0 = b + j + 1, a1 = a0 + sides + 1, b1 = b0 + sides + 1; this.i.push(a0, b0, b1, a0, b1, a1); }
    }
  }
  // closed low-poly blob (dense foliage core so bushes and hedges aren't see-through)
  blob(c, R, k, ao, wind, detail = 1) {
    const g = new THREE.IcosahedronGeometry(1, detail);
    const [u0, v0, du, dv] = FOL_CELL(k);
    const pos = g.attributes.position, b = this.p.length / 3;
    for (let j = 0; j < pos.count; j++) {
      const n = V3(pos.getX(j), pos.getY(j), pos.getZ(j)).normalize();
      const p = V3(c.x + n.x * R.x, c.y + n.y * R.y, c.z + n.z * R.z);
      this.vert(p, n, u0 + du * (0.35 + 0.3 * (n.x * 0.5 + 0.5)), v0 + dv * (0.35 + 0.3 * (n.z * 0.5 + 0.5)), ao * (0.8 + 0.2 * n.y), wind);
    }
    const idx = g.index ? g.index.array : [...Array(pos.count).keys()];
    for (let j = 0; j < idx.length; j++) this.i.push(b + idx[j]);
    g.dispose();
  }
  geometry(R, H, Rz = R) {
    const g = new THREE.BufferGeometry();
    const p = new Float32Array(this.p), n = new Float32Array(this.n);
    for (let j = 0; j < p.length; j += 3) {
      p[j] /= R; p[j + 1] /= H; p[j + 2] /= Rz;
      n[j] *= R; n[j + 1] *= H; n[j + 2] *= Rz; const l = Math.hypot(n[j], n[j + 1], n[j + 2]) || 1; n[j] /= l; n[j + 1] /= l; n[j + 2] /= l;
    }
    g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setAttribute('aWind', new THREE.Float32BufferAttribute(this.w, 1));
    g.setIndex(this.i);
    return g;
  }
}

// random unit vector
const rdir = (r) => { const z = r() * 2 - 1, a = r() * Math.PI * 2, s = Math.sqrt(1 - z * z); return V3(s * Math.cos(a), z, s * Math.sin(a)); };
// orthonormal half-axes of a card facing n, size w×h, rolled by roll
function cardAxes(n, w, h, roll) {
  const a = Math.abs(n.y) < 0.95 ? V3(0, 1, 0) : V3(1, 0, 0);
  const U = a.clone().cross(n).normalize(), Vv = n.clone().cross(U).normalize();
  const c = Math.cos(roll), s = Math.sin(roll);
  return [U.clone().multiplyScalar(c).addScaledVector(Vv, s).multiplyScalar(w), Vv.clone().multiplyScalar(c).addScaledVector(U, -s).multiplyScalar(h)];
}

// Broadleaf tree. spec: { R, H, crown0 (fraction), lobes, cards, size, cell, bark, trunkR, bare, narrow }
function broadleaf(seed, spec, far) {
  const r = rng(seed), vb = new VB(), { R, H } = spec;
  const cy = H * (spec.crown0 + 1) / 2, sy = H * (1 - spec.crown0) / 2; // crown ellipsoid (centre, semi-height)
  const C = V3(0, cy, 0), semi = V3(R, sy, R);
  const wf = (p) => Math.pow(Math.max(0, p.y) / H, 1.5);
  const crownN = (p) => V3((p.x - C.x) / semi.x, (p.y - C.y) / semi.y * 0.8 + 0.25, (p.z - C.z) / semi.z).normalize();
  const crownAO = (p) => { const d = Math.hypot((p.x - C.x) / semi.x, (p.y - C.y) / semi.y, (p.z - C.z) / semi.z); return (0.42 + 0.58 * sstep(0.15, 1.0, d)) * (0.72 + 0.28 * (p.y - (cy - sy)) / (2 * sy)); };
  // trunk and main branches
  const lean = V3((r() - 0.5) * 0.4, 0, (r() - 0.5) * 0.4);
  const top = V3(lean.x, H * (spec.bare ? 0.75 : 0.62), lean.z);
  vb.tube(V3(0, -0.8, 0), top, spec.trunkR, spec.trunkR * 0.45, far ? 4 : 7, spec.bark, 0.55, 0.75, 0, wf(top));
  if (!far) {
    const nb = spec.bare ? 9 : 5;
    for (let b = 0; b < nb; b++) {
      const a = (b / nb) * Math.PI * 2 + r() * 0.8, y0 = H * (spec.crown0 * 0.9 + r() * 0.2);
      const p0 = V3(lean.x * y0 / H, y0, lean.z * y0 / H);
      const len = R * (0.6 + r() * 0.45), up = spec.narrow ? 1.6 : 0.7 + r() * 0.5;
      const p1 = p0.clone().add(V3(Math.cos(a) * len, len * up, Math.sin(a) * len));
      vb.tube(p0, p1, spec.trunkR * 0.42, spec.trunkR * 0.12, 5, spec.bark, 0.5, 0.7, wf(p0), wf(p1));
      if (spec.bare) { // twigs for winter trees
        const p2 = p1.clone().add(V3(Math.cos(a + 0.7) * len * 0.5, len * 0.4, Math.sin(a + 0.7) * len * 0.5));
        vb.tube(p1, p2, spec.trunkR * 0.12, spec.trunkR * 0.04, 4, spec.bark, 0.6, 0.8, wf(p1), wf(p2));
      }
    }
  }
  // foliage
  if (far) {
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI + r() * 0.3, n = V3(Math.cos(a), 0, Math.sin(a));
      vb.card(C, V3(-n.z, 0, n.x).multiplyScalar(R * 1.05), V3(0, sy * 1.05, 0), spec.cell, crownN, () => 0.8, wf);
    }
    for (const [h, s] of [[0.45, 0.9], [0.1, 1.0]]) vb.card(C.clone().add(V3(0, sy * h, 0)), V3(R * s, 0, 0), V3(0, 0, R * s), spec.cell, () => V3(0, 1, 0), () => 0.9, wf);
  } else {
    const lobes = [];
    for (let k = 0; k < spec.lobes; k++) {
      const d = rdir(r); d.y = Math.abs(d.y) * 0.8 - 0.1;
      const lp = V3(d.x * semi.x * 0.5, cy + d.y * semi.y * 0.55, d.z * semi.z * 0.5);
      lobes.push({ p: lp, r: Math.min(R, sy) * (0.5 + r() * 0.2) });
    }
    lobes.push({ p: V3(0, cy + sy * 0.35, 0), r: Math.min(R, sy) * 0.6 });
    for (const L of lobes) {
      for (let k = 0; k < spec.cards; k++) {
        const d = rdir(r);
        const outward = L.p.clone().sub(C); outward.y *= 0.5;
        if (outward.lengthSq() > 0.01 && d.dot(outward) < 0 && r() < 0.6) d.negate();
        const p = L.p.clone().addScaledVector(d, L.r * (0.55 + r() * 0.5));
        // clamp inside the crown ellipsoid (the camo volume)
        const q = V3((p.x - C.x) / semi.x, (p.y - C.y) / semi.y, (p.z - C.z) / semi.z), ql = q.length();
        if (ql > 0.92) p.set(C.x + q.x / ql * 0.92 * semi.x, C.y + q.y / ql * 0.92 * semi.y, C.z + q.z / ql * 0.92 * semi.z);
        const s = spec.size * (0.75 + r() * 0.5);
        const nrm = rdir(r); if (spec.droop) nrm.y *= 0.3;
        const [U, Vv] = cardAxes(nrm.normalize(), s, s, r() * 6.28);
        vb.card(p, U, Vv, spec.cell, crownN, crownAO, (pp) => wf(pp) * 1.1);
      }
    }
  }
  return vb.geometry(R, H);
}

// Conifer. spec: { R, H, crown0, whorlGap, cell, bark, trunkR, scots }
function conifer(seed, spec, far) {
  const r = rng(seed), vb = new VB(), { R, H } = spec;
  const wf = (p) => Math.pow(Math.max(0, p.y) / H, 1.4);
  vb.tube(V3(0, -0.8, 0), V3(0, H * 0.97, 0), spec.trunkR, spec.trunkR * 0.15, far ? 4 : 6, spec.bark, 0.5, 0.8, 0, 0.3);
  const y0 = H * spec.crown0, gap = far ? spec.whorlGap * 2.6 : spec.whorlGap;
  let k = 0;
  for (let y = y0; y < H * 0.985; y += gap * (0.85 + r() * 0.3), k++) {
    const t = (y - y0) / (H - y0);
    const rr = spec.scots ? R * (0.55 + 0.45 * Math.sin(Math.min(1, t * 1.2) * Math.PI)) * (1 - t * 0.3) : R * Math.pow(1 - t, 0.85) * (0.88 + 0.24 * r()) + 0.25;
    const n = Math.max(3, Math.round((far ? 4 : 7) * Math.min(1, rr / R + 0.3)));
    for (let j = 0; j < n; j++) {
      const a = k * 2.4 + (j / n) * Math.PI * 2 + r() * 0.4;
      const d = V3(Math.cos(a), -0.18 - r() * 0.15, Math.sin(a)).normalize();
      const len = rr * (0.85 + r() * 0.3);
      const side = V3(-Math.sin(a), 0, Math.cos(a));
      const tilt = (j % 2 ? 1 : -1) * (0.45 + r() * 0.3);
      const Vv = side.clone().multiplyScalar(Math.cos(tilt)).add(V3(0, Math.sin(tilt), 0)).multiplyScalar(len * 0.42 + 0.3);
      const U = d.clone().multiplyScalar(len / 2);
      const c = V3(0, y, 0).add(U);
      const nf = () => d.clone().multiplyScalar(0.55).add(V3(0, 0.85, 0)).normalize();
      vb.card(c, U, Vv, 2, nf, (p, u) => (0.45 + 0.55 * u) * (0.7 + 0.3 * t), (p, u) => wf(p) * (0.6 + 0.4 * u));
    }
  }
  return vb.geometry(R, H);
}

// Bush (unit y ∈ [0,1] is the camo ellipsoid's full height). spec: { R, H, cards, size, cell, wide, cone }
function bush(seed, spec, far) {
  const r = rng(seed), vb = new VB(), { R, H } = spec;
  const C = V3(0, H * 0.5, 0), semi = V3(R, H * 0.5, R);
  const nf = (p) => V3((p.x - C.x) / semi.x, (p.y - C.y) / semi.y + 0.35, (p.z - C.z) / semi.z).normalize();
  const af = (p) => 0.5 + 0.5 * sstep(-0.2, 1.0, (p.y) / H);
  const wf = (p) => Math.max(0, p.y / H) * 0.5;
  vb.blob(V3(0, H * 0.42, 0), V3(R * 0.72, H * 0.42, R * 0.72), spec.cell, 0.55, 0.05, far ? 0 : 1);
  const n = far ? 6 : spec.cards;
  for (let k = 0; k < n; k++) {
    const d = rdir(r); d.y = Math.abs(d.y);
    if (spec.cone) d.y = d.y * 1.4;
    const f = far ? 0.55 : 0.6 + r() * 0.3;
    const p = V3(d.x * semi.x * f, H * 0.12 + d.y * H * 0.55 * f + (spec.cone ? 0 : 0.1 * H), d.z * semi.z * f);
    const s = spec.size * (far ? 1.6 : 0.75 + r() * 0.5);
    const nrm = far ? V3(Math.cos(k * 1.05), 0.3, Math.sin(k * 1.05)).normalize() : rdir(r);
    const [U, Vv] = cardAxes(nrm, s, s * (spec.cone ? 1.3 : 1), r() * 6.28);
    vb.card(p, U, Vv, spec.cell, nf, af, wf);
  }
  return vb.geometry(R, H);
}

// Hedge block: unit x ∈ [-0.5,0.5] (block length), y ∈ [0,1], z ∈ [-1,1] (half thickness).
function hedgeBlock(seed, far, cell) {
  const r = rng(seed), vb = new VB(), L = 2, H = 2.4, T = 1.3;
  const nf = (p) => V3(p.x * 0.2, 0.6 + p.y / H * 0.6, p.z / T).normalize();
  const af = (p) => 0.5 + 0.5 * sstep(-0.1, 1.0, p.y / H);
  vb.blob(V3(0, H * 0.45, 0), V3(L * 0.62, H * 0.46, T * 0.78), cell, 0.55, 0.05, far ? 0 : 1);
  const n = far ? 4 : 12;
  for (let k = 0; k < n; k++) {
    const side = k % 2 ? 1 : -1;
    const p = V3((r() - 0.5) * L * 0.9, H * (0.2 + r() * 0.65), side * T * (0.55 + r() * 0.25));
    const [U, Vv] = cardAxes(V3((r() - 0.5) * 0.6, 0.3 + r() * 0.5, side).normalize(), 0.8 + r() * 0.4, 0.8 + r() * 0.4, r() * 6.28);
    vb.card(p, U, Vv, cell, nf, af, (pp) => pp.y / H * 0.4);
  }
  for (let k = 0; k < (far ? 1 : 4); k++) { // top
    const p = V3((r() - 0.5) * L * 0.8, H * (0.88 + r() * 0.1), (r() - 0.5) * T);
    const [U, Vv] = cardAxes(V3((r() - 0.5) * 0.5, 1, (r() - 0.5) * 0.5).normalize(), 0.9, 0.9, r() * 6.28);
    vb.card(p, U, Vv, cell, nf, af, () => 0.4);
  }
  return vb.geometry(L, H, T);
}

// ================================================================== solid geometry (atlas)
class GB {
  constructor() { this.p = []; this.n = []; this.uv = []; this.c = []; this.r = []; this.rough = []; this.i = []; this.m = new THREE.Matrix4(); this.nm = new THREE.Matrix3(); this.tint = [1, 1, 1]; }
  setMatrix(m) { this.m.copy(m); this.nm.getNormalMatrix(m); return this; }
  resetMatrix() { this.m.identity(); this.nm.identity(); return this; }
  // polygon (convex, CCW seen from the front). pts: Vector3[], uvs: [u,v][] in tile units, cell name
  poly(pts, uvs, cell, shade = null, rough = 0.88) {
    const n = pts[1].clone().sub(pts[0]).cross(pts[2].clone().sub(pts[0])).normalize().applyMatrix3(this.nm).normalize();
    const rect = ATLAS[cell], b = this.p.length / 3;
    pts.forEach((q, j) => {
      const w = q.clone().applyMatrix4(this.m);
      this.p.push(w.x, w.y, w.z); this.n.push(n.x, n.y, n.z); this.uv.push(uvs[j][0], uvs[j][1]);
      const s = shade ? shade[j] : 1;
      this.c.push(s * this.tint[0], s * this.tint[1], s * this.tint[2]); this.r.push(...rect); this.rough.push(rough);
    });
    for (let j = 1; j < pts.length - 1; j++) this.i.push(b, b + j, b + j + 1);
  }
  // vertical wall quad from (x0,z0) to (x1,z1) (outward normal on the right when walking x0→x1… i.e. CCW from outside)
  wall(x0, z0, x1, z1, y0, y1, cell, { u0 = 0, ao = true, rough = 0.88, tile = TILE_M[cell] } = {}) {
    const L = Math.hypot(x1 - x0, z1 - z0);
    const pts = [V3(x0, y0, z0), V3(x1, y0, z1), V3(x1, y1, z1), V3(x0, y1, z0)];
    const uvs = [[u0 / tile, y0 / tile], [(u0 + L) / tile, y0 / tile], [(u0 + L) / tile, y1 / tile], [u0 / tile, y1 / tile]];
    const sh = ao ? [0.62, 0.62, 1, 1] : null;
    this.poly(pts, uvs, cell, sh, rough);
  }
  // axis-aligned box (in the current matrix), cells: side, top
  box(cx, cy, cz, hx, hy, hz, side, top = side, { bottom = false, ao = true, rough = 0.88, tile } = {}) {
    const x0 = cx - hx, x1 = cx + hx, y0 = cy - hy, y1 = cy + hy, z0 = cz - hz, z1 = cz + hz;
    const o = { ao, rough, tile };
    this.wall(x0, z1, x1, z1, y0, y1, side, o); this.wall(x1, z1, x1, z0, y0, y1, side, o);
    this.wall(x1, z0, x0, z0, y0, y1, side, o); this.wall(x0, z0, x0, z1, y0, y1, side, o);
    const t = tile || TILE_M[top];
    this.poly([V3(x0, y1, z1), V3(x1, y1, z1), V3(x1, y1, z0), V3(x0, y1, z0)], [[x0 / t, z1 / t], [x1 / t, z1 / t], [x1 / t, z0 / t], [x0 / t, z0 / t]], top, null, rough);
    if (bottom) this.poly([V3(x0, y0, z0), V3(x1, y0, z0), V3(x1, y0, z1), V3(x0, y0, z1)], [[0, 0], [1, 0], [1, 1], [0, 1]], top, null, rough);
  }
  // box with arbitrary orientation: centre c, axes (unit) ax, ay, az with half sizes
  obox(c, ax, ay, az, hx, hy, hz, cell, rough = 0.88) {
    const m = new THREE.Matrix4().makeBasis(ax, ay, az).setPosition(c);
    const save = this.m.clone();
    this.setMatrix(save.clone().multiply(m));
    this.box(0, 0, 0, hx, hy, hz, cell, cell, { bottom: true, ao: false, rough });
    this.setMatrix(save);
  }
  // vertical cylinder / cone frustum
  cyl(cx, cz, y0, y1, r0, r1, sides, cell, { cap = true, u0 = 0, tile = TILE_M[cell], rough = 0.88, ao = true } = {}) {
    const circ = 2 * Math.PI * Math.max(r0, r1);
    for (let j = 0; j < sides; j++) {
      const a0 = (j / sides) * Math.PI * 2, a1 = ((j + 1) / sides) * Math.PI * 2;
      const P = (a, r, y) => V3(cx + Math.cos(a) * r, y, cz - Math.sin(a) * r);
      const u = (a) => (u0 + (a / (Math.PI * 2)) * circ) / tile;
      this.poly([P(a0, r0, y0), P(a1, r0, y0), P(a1, r1, y1), P(a0, r1, y1)], [[u(a0), y0 / tile], [u(a1), y0 / tile], [u(a1), y1 / tile], [u(a0), y1 / tile]], cell, ao ? [0.7, 0.7, 1, 1] : null, rough);
    }
    if (cap && r1 > 0.01) {
      const pts = [], uvs = [];
      for (let j = 0; j < sides; j++) { const a = (j / sides) * Math.PI * 2; pts.push(V3(cx + Math.cos(a) * r1, y1, cz - Math.sin(a) * r1)); uvs.push([Math.cos(a) * r1 / tile, Math.sin(a) * r1 / tile]); }
      this.poly(pts, uvs, cell, null, rough);
    }
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setAttribute('aRect', new THREE.Float32BufferAttribute(this.r, 4));
    g.setAttribute('aRough', new THREE.Float32BufferAttribute(this.rough, 1));
    g.setIndex(this.i);
    return g;
  }
}

const WALL_TINTS = [[1, 1, 1], [1.04, 0.98, 0.9], [1.05, 0.95, 0.82], [0.98, 0.94, 0.95], [0.92, 0.94, 0.96], [1.06, 1.0, 0.92]];

// Gable-roofed building body (ridge along local x) at local offset ox. Collision: walls box
// to w = 0.6·H, roof prism from w to H over the same footprint.
function gableHouse(g, r, { ox = 0, sx, sz, H, wall = 'plaster', roof = 'roofTile', timber = false, windows = true, door = true, chimney = true, doorBig = false, tint = [1, 1, 1] }) {
  const w = 0.6 * H, ov = 0.45, x0 = ox - sx, x1 = ox + sx;
  g.tint = tint;
  // walls (down to -1.2 to sit on slopes)
  const yb = -1.2;
  g.wall(x0, sz, x1, sz, yb, w, wall); g.wall(x1, -sz, x0, -sz, yb, w, wall);
  g.wall(x1, sz, x1, -sz, yb, w, wall); g.wall(x0, -sz, x0, sz, yb, w, wall);
  // plinth band
  const pl = 0.55, e = 0.04;
  g.tint = [1, 1, 1];
  g.wall(x0 - e, sz + e, x1 + e, sz + e, yb, pl, 'stone', { ao: false }); g.wall(x1 + e, -sz - e, x0 - e, -sz - e, yb, pl, 'stone', { ao: false });
  g.wall(x1 + e, sz + e, x1 + e, -sz - e, yb, pl, 'stone', { ao: false }); g.wall(x0 - e, -sz - e, x0 - e, sz + e, yb, pl, 'stone', { ao: false });
  g.tint = tint;
  // gable triangles
  const t = TILE_M[wall];
  g.poly([V3(x1, w, sz), V3(x1, w, -sz), V3(x1, H, 0)], [[0, w / t], [2 * sz / t, w / t], [sz / t, H / t]], wall);
  g.poly([V3(x0, w, -sz), V3(x0, w, sz), V3(x0, H, 0)], [[0, w / t], [2 * sz / t, w / t], [sz / t, H / t]], wall);
  g.tint = [1, 1, 1];
  // roof slopes with overhang, plus underside and fascia
  const slope = (H - w) / sz, ye = w - ov * slope, tr = TILE_M[roof], rl = Math.hypot(sz + ov, H - ye), th = 0.18;
  const X0 = x0 - ov, X1 = x1 + ov;
  g.poly([V3(X0, ye, sz + ov), V3(X1, ye, sz + ov), V3(X1, H + th, 0), V3(X0, H + th, 0)], [[X0 / tr, 0], [X1 / tr, 0], [X1 / tr, rl / tr], [X0 / tr, rl / tr]], roof, [0.85, 0.85, 1, 1], 0.7);
  g.poly([V3(X1, ye, -sz - ov), V3(X0, ye, -sz - ov), V3(X0, H + th, 0), V3(X1, H + th, 0)], [[X1 / tr, 0], [X0 / tr, 0], [X0 / tr, rl / tr], [X1 / tr, rl / tr]], roof, [0.85, 0.85, 1, 1], 0.7);
  g.poly([V3(X1, ye - th, sz + ov), V3(X0, ye - th, sz + ov), V3(X0, H, 0), V3(X1, H, 0)], [[0, 0], [1, 0], [1, 1], [0, 1]], 'timber', [0.4, 0.4, 0.4, 0.4]);
  g.poly([V3(X0, ye - th, -sz - ov), V3(X1, ye - th, -sz - ov), V3(X1, H, 0), V3(X0, H, 0)], [[0, 0], [1, 0], [1, 1], [0, 1]], 'timber', [0.4, 0.4, 0.4, 0.4]);
  for (const s of [1, -1]) { // fascia boards along the eaves and the gable verges
    g.wall(X0, s * (sz + ov), X1, s * (sz + ov), ye - th, ye, 'timber', { ao: false });
    const xe = s > 0 ? X1 : X0;
    g.poly([V3(xe, ye - th, s * (sz + ov)), V3(xe, ye - th, -s * (sz + ov)), V3(xe, H, 0)].map((p, j) => p), [[0, 0], [1, 0], [0.5, 1]], 'timber', [0.5, 0.5, 0.5]);
  }
  // timber framing
  if (timber) {
    const beam = (xa, za, xb, zb, ya, yb2, wd) => g.wall(xa, za, xb, zb, ya, yb2, 'timber', { ao: false });
    for (const s of [1, -1]) {
      const z = s * (sz + 0.03);
      for (let x = x0 + 0.1; x <= x1 - 0.1; x += 1.6) s > 0 ? beam(x, z, x + 0.22, z, 0.5, w, 0.22) : beam(x + 0.22, z, x, z, 0.5, w, 0.22);
      for (const y of [0.5, w * 0.5, w - 0.25]) s > 0 ? beam(x0, z, x1, z, y, y + 0.22) : beam(x1, z, x0, z, y, y + 0.22);
    }
  }
  // windows & doors: quads just proud of the walls
  const floors = w > 5.4 ? 2 : 1, fh = (w - 0.4) / floors;
  const place = (cx, cz, nx, nz, ww, wh, yc, cell) => {
    const tx = nz, tz = -nx, e2 = 0.04, px = cx + nx * e2, pz = cz + nz * e2;
    g.poly([V3(px - tx * ww, yc - wh, pz - tz * ww), V3(px + tx * ww, yc - wh, pz + tz * ww), V3(px + tx * ww, yc + wh, pz + tz * ww), V3(px - tx * ww, yc + wh, pz - tz * ww)],
      [[0, 0], [1, 0], [1, 1], [0, 1]], cell, null, cell === 'window' ? 0.35 : 0.8);
  };
  let doorX = null;
  if (door) doorX = ox + (r() - 0.5) * sx * 0.8;
  if (windows) {
    const n = Math.max(1, Math.floor((2 * sx - 1) / 3.0));
    for (let f = 0; f < floors; f++) for (let k = 0; k < n; k++) {
      const x = x0 + (k + 0.5) * (2 * sx / n), yc = 0.6 + fh * f + fh * 0.55;
      for (const s of [1, -1]) {
        if (s > 0 && f === 0 && doorX !== null && Math.abs(x - doorX) < 1.3) continue;
        place(x, s * sz, 0, s, 0.62, Math.min(0.75, fh * 0.28), yc, 'window');
      }
    }
    const ng = Math.max(1, Math.floor((2 * sz - 1) / 3.2));
    for (let f = 0; f < floors; f++) for (let k = 0; k < ng; k++) {
      const z = -sz + (k + 0.5) * (2 * sz / ng), yc = 0.6 + fh * f + fh * 0.55;
      place(x1, z, 1, 0, 0.55, Math.min(0.72, fh * 0.28), yc, 'window');
      if (!doorBig) place(x0, -z, -1, 0, 0.55, Math.min(0.72, fh * 0.28), yc, 'window');
    }
    if (H - w > 2.6) { place(x1, 0, 1, 0, 0.4, 0.5, w + (H - w) * 0.35, 'window'); place(x0, 0, -1, 0, 0.4, 0.5, w + (H - w) * 0.35, 'window'); }
  }
  if (door) place(doorX, sz, 0, 1, 0.62, 1.1, 1.1, 'door');
  if (doorBig) place(x0, 0, -1, 0, Math.min(sz * 0.6, 2.2), Math.min(w * 0.4, 2.2), Math.min(w * 0.4, 2.2), 'door');
  if (chimney) {
    const cxm = ox + sx * (r() < 0.5 ? 0.5 : -0.5), czm = sz * 0.3;
    const yr = H - czm * slope;
    g.box(cxm, (yr + H + 1.2) / 2 - 0.3, czm, 0.35, (H + 1.2 - yr + 0.6) / 2, 0.35, 'brick', 'rubble');
  }
}

function roofOf(kind, v) {
  if (kind === 'barn') return ['roofSlate', 'rust', 'roofTile'][v % 3];
  if (kind === 'shed') return ['rust', 'planks', 'roofSlate'][v % 3];
  return ['roofTile', 'roofTile', 'roofSlate', 'roofTile'][v % 4];
}
function wallOf(kind, v) {
  if (kind === 'barn') return ['planks', 'stone', 'brick'][v % 3];
  if (kind === 'shed') return ['planks', 'planks', 'brick'][v % 3];
  if (kind === 'station') return 'brick';
  return ['plaster', 'brick', 'plaster2', 'plaster'][v % 4];
}

// Build one solid object's geometry in its local frame. hAt(lx, lz) → terrain height relative
// to the object's base (for draping long walls and fences).
function solidGeometry(o, hAt) {
  const g = new GB(), r = rng((o.id | 0) * 7919 + 13 + (o.variant | 0) * 101);
  const [sx, sy, sz] = o.s, v = o.variant | 0;
  switch (o.kind) {
    case 'house': case 'barn': case 'shed': case 'station': {
      const H = 2 * sy;
      gableHouse(g, r, { sx, sz, H, wall: wallOf(o.kind, v), roof: roofOf(o.kind, v), timber: o.kind === 'house' && v % 4 === 3,
        chimney: o.kind === 'house' || o.kind === 'station', doorBig: o.kind === 'barn', windows: o.kind !== 'shed' || v === 2,
        tint: o.kind === 'house' || o.kind === 'station' ? WALL_TINTS[(r() * WALL_TINTS.length) | 0] : [1, 1, 1] });
      break;
    }
    case 'church': {
      const tw = sz * 0.75, nl = sx - tw, nH = sy;
      gableHouse(g, r, { ox: -tw, sx: nl, sz, H: nH, wall: 'ashlar', roof: 'roofSlate', windows: false, door: false, chimney: false });
      // tall arched windows on the nave
      const w = 0.6 * nH, n = Math.max(2, Math.floor(2 * nl / 5));
      for (let k = 0; k < n; k++) for (const s of [1, -1]) {
        const x = -tw - nl + (k + 0.5) * (2 * nl / n), z = s * (sz + 0.04);
        const pts = [V3(x - 0.7, 1.8, z), V3(x + 0.7, 1.8, z), V3(x + 0.7, w - 1.0, z), V3(x - 0.7, w - 1.0, z)];
        if (s < 0) pts.reverse();
        g.poly(pts, s > 0 ? [[0, 0], [1, 0], [1, 1], [0, 1]] : [[0, 1], [1, 1], [1, 0], [0, 0]], 'window', null, 0.3);
      }
      // tower: ashlar shaft, belfry openings, slate spire
      const tx = sx - tw, Ht = 2 * sy, shaft = Ht * 0.7;
      g.box(tx, (shaft - 1.2) / 2, 0, tw, (shaft + 1.2) / 2, tw, 'ashlar', 'ashlar');
      g.box(tx, shaft + 0.2, 0, tw + 0.25, 0.25, tw + 0.25, 'ashlar', 'ashlar');
      for (const [nx, nz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const cx = tx + nx * (tw + 0.04), cz = nz * (tw + 0.04), tx2 = nz, tz2 = -nx, hw = tw * 0.35, y0 = shaft - 4.2, y1 = shaft - 1.2;
        g.poly([V3(cx - tx2 * hw, y0, cz - tz2 * hw), V3(cx + tx2 * hw, y0, cz + tz2 * hw), V3(cx + tx2 * hw, y1, cz + tz2 * hw), V3(cx - tx2 * hw, y1, cz - tz2 * hw)], [[0.3, 0.3], [0.7, 0.3], [0.7, 0.7], [0.3, 0.7]], 'window', [0.3, 0.3, 0.3, 0.3]);
      }
      const b = tw + 0.1, ts = TILE_M.roofSlate;
      for (const [a, c] of [[V3(tx + b, shaft + 0.45, b), V3(tx + b, shaft + 0.45, -b)], [V3(tx + b, shaft + 0.45, -b), V3(tx - b, shaft + 0.45, -b)], [V3(tx - b, shaft + 0.45, -b), V3(tx - b, shaft + 0.45, b)], [V3(tx - b, shaft + 0.45, b), V3(tx + b, shaft + 0.45, b)]])
        g.poly([a, c, V3(tx, Ht, 0)], [[0, 0], [2 * b / ts, 0], [b / ts, (Ht - shaft) / ts]], 'roofSlate', [0.8, 0.8, 1], 0.6);
      g.cyl(tx, 0, Ht, Ht + 1.6, 0.06, 0.03, 4, 'rust', { cap: false });
      g.box(tx, Ht + 1.2, 0, 0.45, 0.05, 0.05, 'rust', 'rust', { ao: false });
      // door in the tower
      g.poly([V3(sx + 0.04, 0, 1.0), V3(sx + 0.04, 0, -1.0), V3(sx + 0.04, 3.4, -1.0), V3(sx + 0.04, 3.4, 1.0)], [[0, 0], [1, 0], [1, 1], [0, 1]], 'door');
      break;
    }
    case 'ruin': {
      const H = 2 * sy;
      // wall A along x at z = -sz + 0.3, wall B along z at x = -sx + 0.3 (collision: objects.js)
      const col = (x0, x1, z0, z1, h, cell) => g.box((x0 + x1) / 2, (h - 1.2) / 2, (z0 + z1) / 2, (x1 - x0) / 2, (h + 1.2) / 2, (z1 - z0) / 2, cell, 'rubble');
      const cellA = v % 2 ? 'brick' : 'plaster2';
      for (let x = -sx; x < sx - 0.01; x += 1.0) {
        const t = (x + sx) / (2 * sx), h = H * (t < 0.25 ? 1 : 0.45 + 0.55 * r()) * (1 - t * 0.25);
        col(x, Math.min(sx, x + 1.0), -sz, -sz + 0.6, Math.max(0.8, h), cellA);
      }
      for (let z = -sz + 0.6; z < sz - 0.01; z += 1.0) {
        const t = (z + sz) / (2 * sz), h = 1.5 * sy * (t < 0.2 ? 1 : 0.4 + 0.6 * r()) * (1 - t * 0.3);
        col(-sx, -sx + 0.6, z, Math.min(sz, z + 1.0), Math.max(0.6, h), cellA);
      }
      // rubble piles and a charred beam
      for (let k = 0; k < 6; k++) {
        const px = (r() - 0.3) * sx, pz = (r() - 0.3) * sz, rr = 0.8 + r() * 1.2;
        g.cyl(px, pz, -0.3, 0.3 + r() * 0.6, rr, rr * 0.3, 7, 'rubble', { cap: true });
      }
      g.obox(V3(0, 0.6, 0), V3(0.9, 0.4, 0.2).normalize(), V3(-0.4, 0.9, 0).normalize(), V3(0.2, 0, 1).normalize().cross(V3(0.9, 0.4, 0.2).normalize()).normalize(), sx * 0.6, 0.12, 0.12, 'timber');
      break;
    }
    case 'wall': case 'sandbags': {
      // draped along local x: segments follow the terrain
      const n = Math.max(1, Math.ceil(2 * sx / 1.5)), H = 2 * sy;
      const cell = o.kind === 'wall' ? 'stone' : 'plaster2';
      if (o.kind === 'sandbags') g.tint = [0.82, 0.74, 0.56];
      for (let k = 0; k < n; k++) {
        const xa = -sx + (k / n) * 2 * sx, xb = -sx + ((k + 1) / n) * 2 * sx, xm = (xa + xb) / 2;
        const hb = Math.min(hAt(xa, 0), hAt(xb, 0), hAt(xm, sz), hAt(xm, -sz));
        if (o.kind === 'wall') {
          const top = hb + H + (r() - 0.5) * 0.12;
          g.box(xm, (hb - 0.6 + top) / 2, 0, (xb - xa) / 2 + 0.01, (top - hb + 0.6) / 2, sz, cell, 'stone');
          g.box(xm, top + 0.1, 0, (xb - xa) / 2 + 0.02, 0.12, sz + 0.06, 'ashlar', 'ashlar', { ao: false });
        } else {
          const rows = Math.max(2, Math.round(H / 0.32));
          for (let rw = 0; rw < rows; rw++) {
            const y = hb + rw * (H / rows) + H / rows / 2, off = (rw % 2) * 0.35;
            g.box(xm + off - 0.18, y, 0, (xb - xa) / 2 - 0.05, H / rows / 2 * 0.95, sz * (1 - rw * 0.08), cell, cell, { ao: false, rough: 0.95 });
          }
        }
      }
      g.tint = [1, 1, 1];
      break;
    }
    case 'fence': {
      const H = 2 * sy, n = Math.max(1, Math.round(2 * sx / 2.2));
      for (let k = 0; k <= n; k++) {
        const x = -sx + (k / n) * 2 * sx, hb = hAt(x, 0);
        g.box(x, hb + H / 2 - 0.25, 0, 0.07, H / 2 + 0.25, 0.07, 'timber', 'timber');
        if (k < n) {
          const x2 = -sx + ((k + 1) / n) * 2 * sx, hb2 = hAt(x2, 0);
          for (const y of [0.4, 0.85]) {
            const a = V3(x, hb + H * y, 0), b = V3(x2, hb2 + H * y, 0), c = a.clone().add(b).multiplyScalar(0.5), d = b.clone().sub(a);
            const L = d.length(); d.normalize();
            g.obox(c, d, V3(-d.y, d.x, 0), V3(0, 0, 1), L / 2, 0.06, 0.025, 'planks');
          }
        }
      }
      break;
    }
    case 'haystack': {
      const H = 2 * sy;
      g.tint = [1, 0.97, 0.9];
      if (v % 2 === 0) { g.cyl(0, 0, -0.3, H * 0.55, sx * 0.92, sx, 12, 'straw', { cap: false, rough: 1 }); g.cyl(0, 0, H * 0.55, H, sx, 0.15, 12, 'straw', { rough: 1 }); }
      else { g.cyl(0, 0, -0.3, H * 0.7, sx, sx * 0.97, 12, 'straw', { cap: false, rough: 1 }); g.cyl(0, 0, H * 0.7, H * 0.92, sx * 0.97, sx * 0.6, 12, 'straw', { cap: false }); g.cyl(0, 0, H * 0.92, H, sx * 0.6, 0.1, 12, 'straw'); }
      g.tint = [1, 1, 1];
      break;
    }
    case 'windmill': {
      const H = 2 * sy, sh = H * 0.8;
      g.cyl(0, 0, -1, sh, sx, sx * 0.68, 10, 'plaster2', { cap: false });
      g.cyl(0, 0, sh, sh + 0.3, sx * 0.78, sx * 0.78, 10, 'timber', { cap: false });
      g.cyl(0, 0, sh + 0.3, H, sx * 0.78, 0.2, 10, 'roofSlate');
      // sails on the local +z side, slightly rotated
      const hub = V3(0, sh + 0.3, sx * 0.85), L = H * 0.52, rot = 0.35;
      g.cyl(0, 0, 0, 0, 0, 0, 3, 'timber', { cap: false });
      for (let k = 0; k < 4; k++) {
        const a = rot + k * Math.PI / 2, d = V3(Math.cos(a), Math.sin(a), 0), s = V3(-Math.sin(a), Math.cos(a), 0);
        g.obox(hub.clone().addScaledVector(d, L / 2), d, s, V3(0, 0, 1), L / 2, 0.1, 0.1, 'timber');
        // sail lattice panel
        const p0 = hub.clone().addScaledVector(d, L * 0.22), p1 = hub.clone().addScaledVector(d, L);
        const q0 = p0.clone().addScaledVector(s, 1.4), q1 = p1.clone().addScaledVector(s, 1.4);
        const z = V3(0, 0, 0.05);
        g.poly([p0.clone().add(z), p1.clone().add(z), q1.clone().add(z), q0.clone().add(z)], [[0, 0], [3, 0], [3, 0.6], [0, 0.6]], 'plaster2', [0.9, 0.9, 0.9, 0.9]);
        g.poly([q0.clone().sub(z), q1.clone().sub(z), p1.clone().sub(z), p0.clone().sub(z)], [[0, 0.6], [3, 0.6], [3, 0], [0, 0]], 'plaster2', [0.7, 0.7, 0.7, 0.7]);
      }
      g.poly([V3(-0.7, 0, sx + 0.05), V3(0.7, 0, sx + 0.05), V3(0.7, 2.2, sx * 0.96 + 0.05), V3(-0.7, 2.2, sx * 0.96 + 0.05)], [[0, 0], [1, 0], [1, 1], [0, 1]], 'door');
      break;
    }
    case 'silo': {
      const H = 2 * sy;
      g.cyl(0, 0, -1, H * 0.85, sx, sx, 14, 'concrete', { cap: false });
      g.cyl(0, 0, H * 0.85, H, sx, sx * 0.2, 14, 'rust');
      break;
    }
    case 'logs': {
      const H = 2 * sy, rr = Math.min(0.35, H / 5), rows = Math.max(1, Math.floor(H / (rr * 1.8)));
      for (let rw = 0; rw < rows; rw++) {
        const n = Math.max(1, Math.floor((2 * sz) / (2 * rr)) - rw);
        for (let k = 0; k < n; k++) {
          const z = -((n - 1) * rr) + k * 2 * rr, y = rr + rw * rr * 1.75;
          g.obox(V3(0, y, z), V3(1, 0, 0), V3(0, 1, 0), V3(0, 0, 1), sx * (0.92 + r() * 0.08), rr * 0.92, rr * 0.92, 'timber');
        }
      }
      break;
    }
    case 'wreck': {
      g.tint = [0.55, 0.5, 0.48];
      g.box(0, sy * 0.55, 0, sx * 0.62, sy * 0.45, sz, 'rust', 'rust');
      g.box(sx * 0.85, sy * 0.35, 0, sx * 0.15, sy * 0.35, sz * 0.98, 'rust', 'rust');
      g.box(-sx * 0.85, sy * 0.35, 0, sx * 0.15, sy * 0.35, sz * 0.98, 'rust', 'rust');
      g.box(0, sy * 1.25, sz * 0.1, sx * 0.4, sy * 0.3, sz * 0.45, 'rust', 'rust');
      g.obox(V3(0, sy * 1.2, sz * 0.9), V3(1, 0, 0), V3(0, 0.97, -0.24).normalize(), V3(0, 0.24, 0.97).normalize(), 0.08, 0.08, sz * 0.6, 'rust');
      g.tint = [1, 1, 1];
      break;
    }
    case 'tank_trap': {
      const L = Math.min(sx, sy) * 1.9, c = V3(0, sy * 0.75, 0);
      for (let k = 0; k < 3; k++) {
        const a = k * Math.PI * 2 / 3;
        const d = V3(Math.cos(a) * 0.7, 0.7, Math.sin(a) * 0.7).normalize();
        const s = V3(-Math.sin(a), 0, Math.cos(a));
        g.obox(c, d, s, d.clone().cross(s).normalize(), L / 2, 0.1, 0.07, 'rust', 0.6);
      }
      break;
    }
    case 'bridge': {
      // the long axis is the span; deck top at 2·sy (drivable: query.js heightAt)
      const alongX = sx >= sz, span = alongX ? sx : sz, half = alongX ? sz : sx, top = 2 * sy;
      const save = new THREE.Matrix4();
      if (!alongX) g.setMatrix(new THREE.Matrix4().makeRotationY(Math.PI / 2));
      g.box(0, top - 0.45, 0, span, 0.45, half, 'ashlar', 'concrete', { bottom: true });
      for (const s of [1, -1]) g.box(0, top + 0.4, s * (half - 0.2), span, 0.4, 0.2, 'ashlar', 'ashlar');
      const np = Math.max(1, Math.round(2 * span / 12));
      for (let k = 0; k <= np; k++) {
        const x = -span + (k / np) * 2 * span, hb = Math.min(hAt(alongX ? x : 0, alongX ? 0 : x), top - 1) - 3;
        g.box(x, (hb + top - 0.9) / 2, 0, 0.9, (top - 0.9 - hb) / 2, half * 0.9, 'stone', 'stone');
      }
      g.setMatrix(save);
      break;
    }
    case 'rock': return null; // rocks are shared shapes, see rockGeometry
    default: {
      // unknown kinds: an honest crate so nothing is invisible
      g.box(0, sy, 0, sx, sy, sz, 'planks', 'planks');
    }
  }
  return g.geometry();
}

// Boulder: displaced icosahedron in a unit ellipsoid (centre at the base point, half buried);
// box-projected atlas uvs (triangle soup), smooth noisy normals, lichen on top.
function rockGeometry(seed) {
  const r = rng(seed), base = new THREE.IcosahedronGeometry(1, 3);
  const pos = base.attributes.position;
  const bumps = [...Array(9)].map(() => ({ d: rdir(r), a: (r() - 0.5) * 0.5, w: 2 + r() * 5 }));
  for (let j = 0; j < pos.count; j++) {
    const p = V3(pos.getX(j), pos.getY(j), pos.getZ(j)).normalize();
    let k = 1;
    for (const b of bumps) k += b.a * Math.exp(-b.w * (1 - p.dot(b.d)));
    k += (Math.sin(p.x * 9 + seed) * Math.sin(p.y * 11) * Math.sin(p.z * 7)) * 0.05;
    if (p.y > 0.55) k *= 1 - (p.y - 0.55) * 0.35; // flatter tops
    pos.setXYZ(j, p.x * k, p.y * k, p.z * k);
  }
  const g0 = base.toNonIndexed(); base.dispose();
  // smooth normals by position hashing
  g0.computeVertexNormals();
  const P = g0.attributes.position, N = new Float32Array(P.count * 3), acc = new Map();
  for (let j = 0; j < P.count; j += 3) {
    const a = V3(P.getX(j), P.getY(j), P.getZ(j)), b = V3(P.getX(j + 1), P.getY(j + 1), P.getZ(j + 1)), c = V3(P.getX(j + 2), P.getY(j + 2), P.getZ(j + 2));
    const n = b.clone().sub(a).cross(c.clone().sub(a));
    for (const [q, v] of [[a, j], [b, j + 1], [c, j + 2]]) { const key = q.x.toFixed(4) + ',' + q.y.toFixed(4) + ',' + q.z.toFixed(4); const e = acc.get(key) || V3(); e.add(n); acc.set(key, e); }
  }
  const uv = new Float32Array(P.count * 2), col = new Float32Array(P.count * 3), rect = new Float32Array(P.count * 4), rough = new Float32Array(P.count).fill(0.85);
  const R = ATLAS.rockface, T = 1 / 1.6;
  for (let j = 0; j < P.count; j += 3) {
    const a = V3(P.getX(j), P.getY(j), P.getZ(j)), b = V3(P.getX(j + 1), P.getY(j + 1), P.getZ(j + 1)), c = V3(P.getX(j + 2), P.getY(j + 2), P.getZ(j + 2));
    const fn = b.clone().sub(a).cross(c.clone().sub(a)); const ax = Math.abs(fn.x), ay = Math.abs(fn.y), az = Math.abs(fn.z);
    for (let t = 0; t < 3; t++) {
      const q = [a, b, c][t], v = j + t;
      const key = q.x.toFixed(4) + ',' + q.y.toFixed(4) + ',' + q.z.toFixed(4), n = acc.get(key).clone().normalize();
      N.set([n.x, n.y, n.z], v * 3);
      const [u, w] = ay >= ax && ay >= az ? [q.x, q.z] : ax >= az ? [q.z, q.y] : [q.x, q.y];
      uv[v * 2] = u * T * 2.2; uv[v * 2 + 1] = w * T * 2.2;
      const ao = 0.55 + 0.45 * sstep(-0.6, 0.6, q.y), lich = sstep(0.4, 0.9, n.y) * 0.25;
      col.set([ao * (1 - lich * 0.2), ao * (1 + lich * 0.05), ao * (1 - lich * 0.35)], v * 3);
      rect.set(R, v * 4);
    }
  }
  g0.setAttribute('normal', new THREE.BufferAttribute(N, 3));
  g0.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g0.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g0.setAttribute('aRect', new THREE.BufferAttribute(rect, 4));
  g0.setAttribute('aRough', new THREE.BufferAttribute(rough, 1));
  // index it (BatchedMesh wants all geometries indexed alike)
  g0.setIndex([...Array(P.count).keys()]);
  return g0;
}

// Rubble pile in a unit footprint (x,z ∈ [-1,1], y ∈ [0,1]) for destroyed/crushed props.
function rubbleGeometry(seed, low) {
  const g = new GB(), r = rng(seed);
  for (let k = 0; k < (low ? 10 : 16); k++) {
    const x = (r() - 0.5) * 1.7, z = (r() - 0.5) * 1.7, rr = 0.25 + r() * 0.45, h = (low ? 0.5 : 0.35) * (0.4 + r() * 0.6) * (1 - Math.hypot(x, z) * 0.35);
    g.cyl(x, z, -0.1, h, rr, rr * 0.35, 6, 'rubble', { cap: true, tile: 1 });
  }
  if (!low) for (let k = 0; k < 5; k++) { // broken wall stumps and beams
    const x = (r() - 0.5) * 1.6, z = (r() - 0.5) * 1.6;
    g.box(x, 0.3, z, 0.06 + r() * 0.2, 0.3 + r() * 0.25, 0.04, 'brick', 'rubble', { tile: 0.5 });
    g.obox(V3(x * 0.8, 0.25, z * 0.8), V3(Math.cos(k), 0.25, Math.sin(k)).normalize(), V3(0, 1, 0), V3(-Math.sin(k), 0, Math.cos(k)), 0.7, 0.04, 0.04, 'timber');
  }
  return g.geometry();
}

// ================================================================== materials
function vegMaterial(tex, U) {
  const m = new THREE.MeshStandardMaterial({ map: tex, vertexColors: true, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.82, metalness: 0 });
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, { uTime: U.uTime, uWind: U.uWind, uSunDir: U.uSunDir, uSunColor: U.uSunColor });
    patchFarShadow(sh, U);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aWind; uniform float uTime; uniform float uWind; varying float vWindT;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        {
          vec3 ip = vec3(0.0);
          #ifdef USE_BATCHING
          ip = batchingMatrix[3].xyz;
          #endif
          float ph = uTime * 1.1 + ip.x * 0.043 + ip.z * 0.061;
          float gust = 0.6 + 0.4 * sin(uTime * 0.37 + ip.x * 0.01);
          vec2 sway = vec2(sin(ph) + 0.3 * sin(ph * 2.7), cos(ph * 0.83) * 0.7) * 0.022 * gust;
          float fl = sin(uTime * 5.3 + dot(position, vec3(23.0, 17.0, 31.0))) * 0.006;
          transformed.xz += (sway * aWind * aWind + fl * step(0.05, aWind)) * uWind;
          transformed.y += fl * aWind * uWind;
          vWindT = aWind;
        }`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uSunDir; uniform vec3 uSunColor; varying float vWindT;')
      // keep leaf-card normals facing the same way on both sides (volumetric crown lighting)
      .replace('#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin.replace('normal *= faceDirection;', ''))
      // sharpened alpha test keeps foliage from thinning out in the distance
      .replace('#include <alphatest_fragment>', 'diffuseColor.a = (diffuseColor.a - 0.5) / max(fwidth(diffuseColor.a), 1e-4) + 0.5; if (diffuseColor.a < 0.5) discard;')
      // cheap translucency: leaves glow a little when the sun is behind them
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>
        { vec3 Vw = normalize(cameraPosition - vFsW); float back = pow(max(dot(-Vw, uSunDir), 0.0), 3.0);
          reflectedLight.directDiffuse += diffuseColor.rgb * uSunColor * back * 0.55 * step(0.02, vWindT) * farSun(); }`);
  };
  m.customProgramCacheKey = () => 'veg';
  return m;
}

function solidMaterial(U) {
  const m = new THREE.MeshStandardMaterial({ map: buildingAtlas(), vertexColors: true, roughness: 0.88, metalness: 0 });
  m.onBeforeCompile = (sh) => {
    patchFarShadow(sh, U);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aRect; attribute float aRough; varying vec4 vRect; varying float vRough;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRect = aRect; vRough = aRough;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec4 vRect; varying float vRough;')
      .replace('#include <map_fragment>', `{
        vec2 t = vMapUv; vec2 gx = dFdx(t) * vRect.zw, gy = dFdy(t) * vRect.zw;
        vec4 tc = textureGrad(map, vRect.xy + fract(t) * vRect.zw, gx, gy);
        diffuseColor *= tc; }`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = vRough;');
  };
  m.customProgramCacheKey = () => 'solid';
  return m;
}

// ================================================================== Props
const VEG_KINDS = { tree: 1, pine: 1, bush: 1, hedge: 1 };
const RUBBLE_ON_BREAK = { wall: 'low', sandbags: 'low', shed: 'high', house: 'high', barn: 'high', church: 'high', station: 'high', ruin: 'high', windmill: 'high', silo: 'high', logs: 'low', wreck: 'low' };
const TREE_SPECS = (bare) => [
  { R: 3, H: 9, crown0: 0.3, lobes: 5, cards: 17, size: 1.0, cell: bare ? 3 : 0, bark: 4, trunkR: 0.28, bare },                         // oak
  { R: 3, H: 9.5, crown0: 0.28, lobes: 6, cards: 15, size: 0.95, cell: bare ? 3 : 0, bark: 4, trunkR: 0.24, bare, narrow: true },     // linden
  { R: 2.6, H: 9, crown0: 0.32, lobes: 6, cards: 13, size: 0.8, cell: bare ? 3 : 1, bark: 5, trunkR: 0.17, bare, droop: true },     // birch
  { R: 2.6, H: 10, crown0: 0.25, lobes: 7, cards: 13, size: 0.9, cell: bare ? 3 : 1, bark: 4, trunkR: 0.22, bare, narrow: true },     // poplar/ash
];
const PINE_SPECS = [
  { R: 3.3, H: 18, crown0: 0.12, whorlGap: 0.85, bark: 4, trunkR: 0.32 },            // spruce
  { R: 3.0, H: 17, crown0: 0.2, whorlGap: 0.75, bark: 4, trunkR: 0.3 },              // fir
  { R: 3.3, H: 19, crown0: 0.6, whorlGap: 0.6, bark: 4, trunkR: 0.3, scots: true },  // scots pine
  { R: 3.6, H: 18, crown0: 0.08, whorlGap: 0.95, bark: 4, trunkR: 0.34 },            // big spruce
];
const BUSH_SPECS = [
  { R: 2, H: 1.8, cards: 34, size: 0.62, cell: 1 },
  { R: 2.3, H: 1.6, cards: 36, size: 0.7, cell: 0 },
  { R: 1.9, H: 2.0, cards: 30, size: 0.55, cell: 2, cone: true },
  { R: 2.1, H: 1.9, cards: 34, size: 0.62, cell: 1 },
];

export class Props {
  constructor(scene, quality, sharedU) {
    this.scene = scene; this.q = quality; this.U = sharedU;
    this.U.uTime = this.U.uTime || { value: 0 }; this.U.uWind = { value: quality.wind ? 1 : 0 };
    this.group = new THREE.Group(); this.group.name = 'props'; scene.add(this.group);
    this.anims = []; this._lodT = 0; this._camLast = new THREE.Vector3(1e9, 0, 0);
  }

  dispose() {
    for (const m of [this.veg, this.solid]) if (m) { this.group.remove(m); m.dispose(); }
    this.veg = this.solid = null; this.anims = []; this.recs = [];
  }

  setQuality(q) { this.q = q; this.U.uWind.value = q.wind ? 1 : 0; this._camLast.set(1e9, 0, 0); }

  build(map, theme, terrain) {
    this.dispose();
    this.map = map; this.theme = theme; this.terrain = terrain;
    const fol = theme.foliage, bare = !!fol.bare;
    const tex = foliageAtlas(fol, theme.name);
    this._brokenSeen = map.broken || 0;
    // ---------------- vegetation geometries: [near, far] per species
    const geos = { tree: [], pine: [], bush: [], hedge: [] };
    TREE_SPECS(bare).forEach((sp, k) => geos.tree.push([broadleaf(11 + k, sp, false), broadleaf(11 + k, sp, true)]));
    PINE_SPECS.forEach((sp, k) => geos.pine.push([conifer(31 + k, sp, false), conifer(31 + k, sp, true)]));
    BUSH_SPECS.forEach((sp, k) => geos.bush.push([bush(51 + k, sp, false), bush(51 + k, sp, true)]));
    geos.hedge.push([hedgeBlock(71, false, bare ? 3 : 1), hedgeBlock(71, true, bare ? 3 : 1)]);
    // instances
    const recs = []; // { obj, parts: [{mesh:'veg'|'solid', id, geoNear, geoFar, base: Matrix4, pos}] }
    const vegInst = [];
    const S = map.size, r = rng(map.seed || 5);
    for (const o of map.objects) {
      if (!VEG_KINDS[o.kind]) continue;
      const [sx, sy, sz] = o.s, v = (o.variant | 0) % 4;
      if (o.kind === 'hedge') {
        const n = Math.max(1, Math.round((2 * sx) / 2)), L = (2 * sx) / n;
        const c = Math.cos(o.yaw), s = Math.sin(o.yaw);
        for (let k = 0; k < n; k++) {
          const lx = -sx + (k + 0.5) * L, wx = o.x + lx * c, wz = o.z - lx * s;
          vegInst.push({ obj: o, kind: 'hedge', v: 0, x: wx, y: terrain.heightAt(wx, wz) - 0.1, z: wz, yaw: o.yaw + (k % 2) * Math.PI, sc: [L * 1.08, 2 * sy, sz] });
        }
      } else if (o.kind === 'bush') vegInst.push({ obj: o, kind: 'bush', v, x: o.x, y: o.y - 0.15, z: o.z, yaw: o.yaw, sc: [sx, 2 * sy, sz] });
      else vegInst.push({ obj: o, kind: o.kind, v, x: o.x, y: o.y - 0.05, z: o.z, yaw: o.yaw, sc: [sx, 2 * sy, sz] });
    }
    // forests and tree lines outside the playable square (far LOD only)
    const outer = [];
    const nOut = this.q.farTrees | 0;
    if (nOut > 0) {
      let tries = 0;
      while (outer.length < nOut && tries++ < nOut * 4) {
        const side = (r() * 4) | 0, along = -300 + r() * (S + 600), out = 25 + Math.pow(r(), 1.6) * 1100;
        const [cx, cz] = side === 0 ? [along, -out] : side === 1 ? [along, S + out] : side === 2 ? [-out, along] : [S + out, along];
        const nClump = 8 + ((r() * 26) | 0), rad = 25 + r() * 70;
        const pine = bare || r() < 0.45;
        for (let k = 0; k < nClump && outer.length < nOut; k++) {
          const a = r() * 6.28, d = Math.sqrt(r()) * rad, x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d;
          if (x > -8 && x < S + 8 && z > -8 && z < S + 8) continue;
          const h = pine ? 14 + r() * 8 : 8 + r() * 5, w = pine ? 3 + r() : 3 + r() * 1.5;
          outer.push({ obj: null, kind: pine ? 'pine' : 'tree', v: (r() * 4) | 0, x, y: terrain.heightAt(x, z) - 0.3, z, yaw: r() * 6.28, sc: [w, h, w], farOnly: true });
        }
      }
    }
    const allVeg = vegInst.concat(outer);
    // capacity
    let vCount = 0, iCount = 0;
    for (const k in geos) for (const pair of geos[k]) for (const g of pair) { vCount += g.attributes.position.count; iCount += g.index.count; }
    const vmat = vegMaterial(tex, this.U);
    const veg = new THREE.BatchedMesh(allVeg.length + 16, vCount + 16, iCount + 16, vmat);
    veg.castShadow = true; veg.receiveShadow = true; veg.name = 'vegetation';
    const gid = {};
    for (const k in geos) gid[k] = geos[k].map((pair) => pair.map((g) => veg.addGeometry(g)));
    for (const k in geos) for (const pair of geos[k]) for (const g of pair) g.dispose();
    const tint = new THREE.Color(), M = new THREE.Matrix4(), Q = new THREE.Quaternion(), Y = V3(0, 1, 0);
    const byObj = new Map();
    for (const it of allVeg) {
      const [near, far] = gid[it.kind][it.v % gid[it.kind].length];
      const id = veg.addInstance(it.farOnly ? far : near);
      Q.setFromAxisAngle(Y, it.yaw);
      M.compose(V3(it.x, it.y, it.z), Q, V3(...it.sc));
      veg.setMatrixAt(id, M);
      const h = rng((it.x * 131 + it.z * 7) | 0)();
      const br = 0.86 + h * 0.26;
      tint.setRGB(br * (1 + (h - 0.5) * 0.1), br, br * (1 - (h - 0.5) * 0.12));
      veg.setColorAt(id, tint);
      const part = { mesh: veg, id, near, far, farOnly: !!it.farOnly, x: it.x, z: it.z, base: M.clone(), lod: it.farOnly ? 1 : 0, r: Math.max(...it.sc) };
      if (it.obj) { let rec = byObj.get(it.obj); if (!rec) { rec = { obj: it.obj, parts: [] }; byObj.set(it.obj, rec); recs.push(rec); } rec.parts.push(part); }
      else recs.push({ obj: null, parts: [part] });
    }
    this.veg = veg; this.group.add(veg);
    // ---------------- solids
    const solidGeo = new Map(), solidList = [];
    const rubble = { high: rubbleGeometry(3, false), low: rubbleGeometry(4, true) };
    for (const o of map.objects) {
      if (VEG_KINDS[o.kind] || o.kind === 'crater') continue;
      const c = Math.cos(o.yaw), s = Math.sin(o.yaw);
      const drape = o.kind === 'wall' || o.kind === 'fence' || o.kind === 'sandbags' || o.kind === 'bridge';
      const key = o.kind === 'rock' ? 'rock' + (o.variant % 4) : drape ? 'obj' + o.id : [o.kind, o.variant | 0, ...o.s.map((x) => x.toFixed(2))].join('|');
      if (!solidGeo.has(key)) {
        const hAt = (lx, lz) => terrain.heightAt(o.x + lx * c + lz * s, o.z - lx * s + lz * c) - o.y;
        solidGeo.set(key, o.kind === 'rock' ? rockGeometry(900 + (o.variant | 0)) : solidGeometry(o, hAt));
      }
      solidList.push({ o, key });
    }
    let sv = 0, si = 0;
    for (const g of solidGeo.values()) { sv += g.attributes.position.count; si += g.index.count; }
    for (const g of Object.values(rubble)) { sv += g.attributes.position.count; si += g.index.count; }
    const smat = solidMaterial(this.U);
    const solid = new THREE.BatchedMesh(solidList.length * 2 + 16, sv + 16, si + 16, smat);
    solid.castShadow = true; solid.receiveShadow = true; solid.name = 'structures';
    const sgid = new Map();
    for (const [k, g] of solidGeo) { sgid.set(k, solid.addGeometry(g)); g.dispose(); }
    this.rubbleId = { high: solid.addGeometry(rubble.high), low: solid.addGeometry(rubble.low) };
    for (const { o, key } of solidList) {
      const id = solid.addInstance(sgid.get(key));
      Q.setFromAxisAngle(Y, o.yaw);
      const sc = o.kind === 'rock' ? V3(...o.s) : V3(1, 1, 1);
      M.compose(V3(o.x, o.y, o.z), Q, sc);
      solid.setMatrixAt(id, M);
      solid.setColorAt(id, tint.setRGB(1, 1, 1));
      recs.push({ obj: o, parts: [{ mesh: solid, id, base: M.clone(), x: o.x, z: o.z }] });
    }
    this.solid = solid; this.group.add(solid);
    this.recs = recs;
    this.recByObj = new Map(); this.recById = new Map();
    for (const rec of recs) if (rec.obj) { this.recByObj.set(rec.obj, rec); this.recById.set(rec.obj.id, rec); }
    // anything already broken (map reused mid-battle)
    for (const rec of recs) if (rec.obj && (rec.obj.fallen || rec.obj.destroyed)) this._break(rec, true);
  }

  // Ground-shadow casters for Terrain.bakeShadows.
  casters() {
    const out = [];
    for (const o of this.map.objects) {
      const [sx, sy, sz] = o.s;
      if (o.kind === 'tree' || o.kind === 'pine') out.push({ x: o.x, z: o.z, h: 2 * sy, hc: 1.3 * sy, r: Math.max(sx, sz) * 0.85, dark: o.kind === 'pine' ? 0.75 : 0.62 });
      else if (o.kind === 'bush') out.push({ x: o.x, z: o.z, h: 2 * sy, hc: sy * 0.8, r: Math.max(sx, sz) * 0.8, dark: 0.45 });
      else if (o.kind === 'hedge') {
        const c = Math.cos(o.yaw), s = Math.sin(o.yaw);
        for (let lx = -sx; lx <= sx; lx += 2) out.push({ x: o.x + lx * c, z: o.z - lx * s, h: 2 * sy, hc: sy, r: sz * 0.9, dark: 0.55 });
      } else if (['house', 'barn', 'shed', 'station', 'church', 'ruin', 'windmill', 'silo'].includes(o.kind)) {
        const c = Math.cos(o.yaw), s = Math.sin(o.yaw), m = Math.min(sx, sz);
        for (let lx = -sx + m * 0.6; lx <= sx - m * 0.6 + 0.01; lx += Math.max(1, m)) out.push({ x: o.x + lx * c, z: o.z - lx * s, h: 2 * sy, hc: sy * 1.2, r: m * 1.05, box: true });
      } else if (o.kind === 'wall') {
        const c = Math.cos(o.yaw), s = Math.sin(o.yaw);
        for (let lx = -sx; lx <= sx; lx += 1.5) out.push({ x: o.x + lx * c, z: o.z - lx * s, h: 2 * sy, hc: sy, r: 0.6, dark: 0.5 });
      } else if (o.kind === 'rock') out.push({ x: o.x, z: o.z, h: sy, hc: sy * 0.5, r: Math.max(sx, sz) * 0.8, dark: 0.5 });
    }
    return out;
  }

  // treeFall / objectBreak events (obj may be the object or its id)
  handle(ev) {
    if (ev.type !== 'treeFall' && ev.type !== 'objectBreak') return;
    const o = ev.obj;
    const rec = o && typeof o === 'object' ? this.recByObj.get(o) || this.recById.get(o.id) : this.recById.get(o);
    if (!rec) return;
    if (ev.dir !== undefined && rec.obj && rec.obj.fallDir === undefined) rec.obj.fallDir = typeof ev.dir === 'number' ? ev.dir : Math.atan2(ev.dir.x, ev.dir.z);
    this._break(rec, false);
  }

  _break(rec, instant) {
    if (rec.broken) return;
    rec.broken = true;
    const o = rec.obj, kind = o.kind;
    const fallDir = o.fallDir !== undefined ? o.fallDir : o.yaw + Math.PI / 2;
    if (kind === 'tree' || kind === 'pine' || kind === 'fence') {
      this.anims.push({ rec, type: 'fall', t: instant ? 99 : 0, dur: kind === 'fence' ? 0.6 : 1.8 + o.s[1] * 0.05, dir: fallDir });
    } else if (kind === 'haystack' || kind === 'bush') {
      this.anims.push({ rec, type: 'squash', t: instant ? 99 : 0, dur: 0.5 });
    } else if (RUBBLE_ON_BREAK[kind]) {
      const p = rec.parts[0], sub = RUBBLE_ON_BREAK[kind];
      p.mesh.setGeometryIdAt(p.id, this.rubbleId[sub]);
      const [sx, sy, sz] = o.s, M = new THREE.Matrix4().compose(V3(o.x, o.y, o.z), new THREE.Quaternion().setFromAxisAngle(V3(0, 1, 0), o.yaw), V3(sx * 1.05, sub === 'low' ? Math.min(0.9, sy * 1.1) : Math.min(3.5, sy * 0.55), sz * (sub === 'low' ? 2.5 : 1.05)));
      p.mesh.setMatrixAt(p.id, M);
    } else {
      for (const p of rec.parts) p.mesh.setVisibleAt(p.id, false);
    }
    this._applyAnims(0);
  }

  _applyAnims(dt) {
    const M = new THREE.Matrix4(), R = new THREE.Matrix4(), T = new THREE.Matrix4(), Ti = new THREE.Matrix4(), ax = V3();
    for (let k = this.anims.length - 1; k >= 0; k--) {
      const a = this.anims[k]; a.t += dt;
      const u = Math.min(1, a.t / a.dur);
      for (const p of a.rec.parts) {
        const pos = V3().setFromMatrixPosition(p.base);
        if (a.type === 'fall') {
          // gravity-like ease-in, a small bounce at the end; tipped about the base toward dir
          const ang = (u < 0.92 ? Math.pow(u / 0.92, 2) : 1 - Math.sin((u - 0.92) / 0.08 * Math.PI) * 0.04) * (Math.PI / 2 - 0.06);
          ax.set(Math.cos(a.dir), 0, -Math.sin(a.dir));
          R.makeRotationAxis(ax, ang);
          T.makeTranslation(pos.x, pos.y, pos.z); Ti.makeTranslation(-pos.x, -pos.y, -pos.z);
          M.copy(T).multiply(R).multiply(Ti).multiply(p.base);
          if (p.lod === 0 && p.near !== undefined) p.mesh.setGeometryIdAt(p.id, p.near);
        } else {
          const s = 1 - 0.7 * (u * u);
          M.copy(p.base).multiply(new THREE.Matrix4().makeScale(1 + 0.15 * u, s, 1 + 0.15 * u));
        }
        p.mesh.setMatrixAt(p.id, M);
      }
      if (u >= 1) this.anims.splice(k, 1);
    }
  }

  update(camera, dt) {
    if (!this.veg) return;
    this.U.uTime.value += dt;
    // state changes made without an event (e.g. several steps per frame): diff on map.broken
    if ((this.map.broken || 0) !== this._brokenSeen) {
      this._brokenSeen = this.map.broken || 0;
      for (const rec of this.recs) if (rec.obj && !rec.broken && (rec.obj.fallen || rec.obj.destroyed)) this._break(rec, false);
    }
    if (this.anims.length) this._applyAnims(dt);
    // LOD: re-bucket when the camera moved or zoomed noticeably
    this._lodT -= dt;
    const zoom = Math.tan((camera.fov * Math.PI) / 360) / Math.tan((50 * Math.PI) / 360);
    if (this._lodT <= 0 || camera.position.distanceToSquared(this._camLast) > 64 || Math.abs(zoom - (this._zoomLast || 0)) > 0.05) {
      this._lodT = 0.4; this._camLast.copy(camera.position); this._zoomLast = zoom;
      const D = this.q.treeLod / Math.max(0.05, zoom), D2 = D * D, cx = camera.position.x, cz = camera.position.z;
      for (const rec of this.recs) for (const p of rec.parts) {
        if (p.near === undefined || p.farOnly) continue;
        const dx = p.x - cx, dz = p.z - cz, lod = dx * dx + dz * dz < D2 ? 0 : 1;
        if (lod !== p.lod) { p.lod = lod; p.mesh.setGeometryIdAt(p.id, lod ? p.far : p.near); }
      }
    }
  }
}
