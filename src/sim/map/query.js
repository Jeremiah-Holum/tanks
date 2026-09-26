// World-geometry queries over MapData: terrain height / normal / ground, ray casts against the
// heightfield and against props, spatial queries, foliage for camo, and breaking props.
// Pure JS, deterministic, allocation-light (hot paths allocate only their result object).
// The acceleration index is built lazily on first use and cached on the map (non-enumerable
// `_q`); it is rebuilt automatically if `map.objects` is replaced.
import { OBJECT_KINDS, GROUND, BOX, CYL, ELL, GABLE, objectParts, foliagePart, objectBounds } from './objects.js';

export { OBJECT_KINDS, GROUND };

const HASH = 16;                 // spatial hash cell, metres
const NEAR_FOLIAGE = 15;         // WoT 15 m rule (bushes near the target / observer)

// ---------------------------------------------------------------- terrain

// Terrain height only (bilinear), clamped at the map edge.
export function terrainHeightAt(map, x, z) {
  const res = map.res, H = map.heights, inv = (res - 1) / map.size;
  let fx = x * inv, fz = z * inv;
  const m = res - 1.000001;
  fx = fx < 0 ? 0 : fx > m ? m : fx; fz = fz < 0 ? 0 : fz > m ? m : fz;
  const i = fx | 0, j = fz | 0, u = fx - i, v = fz - j, k = j * res + i;
  const a = H[k], b = H[k + 1], c = H[k + res], d = H[k + res + 1];
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

// Drivable surface height: the terrain, or a bridge deck where one covers (x, z).
export function heightAt(map, x, z) {
  const h = terrainHeightAt(map, x, z);
  const br = index(map).bridges;
  if (br.length === 0) return h;
  const d = bridgeDeck(br, x, z);
  return d > h ? d : h;
}

function bridgeDeck(br, x, z) {
  let best = -Infinity;
  for (let i = 0; i < br.length; i++) {
    const b = br[i], dx = x - b.cx, dz = z - b.cz;
    const lx = dx * b.c - dz * b.s, lz = dx * b.s + dz * b.c;
    if (lx >= -b.hx && lx <= b.hx && lz >= -b.hz && lz <= b.hz && b.top > best) best = b.top;
  }
  return best;
}

// Is (x, z) on a bridge deck? (returns the deck height or -Infinity)
export function bridgeAt(map, x, z) { return bridgeDeck(index(map).bridges, x, z); }

export function normalAt(map, x, z, out = { x: 0, y: 1, z: 0 }) {
  const e = 1.0;
  const hx = heightAt(map, x + e, z) - heightAt(map, x - e, z);
  const hz = heightAt(map, x, z + e) - heightAt(map, x, z - e);
  const nx = -hx, ny = 2 * e, nz = -hz, L = Math.hypot(nx, ny, nz);
  out.x = nx / L; out.y = ny / L; out.z = nz / L;
  return out;
}

// Slope in degrees at (x, z).
export function slopeAt(map, x, z) {
  const n = normalAt(map, x, z, _n);
  return Math.acos(Math.min(1, n.y)) * 180 / Math.PI;
}
const _n = { x: 0, y: 1, z: 0 };

// Ground type (GROUND enum) of the nearest sample; bridge decks read as ROAD.
export function groundAt(map, x, z) {
  const res = map.res, inv = (res - 1) / map.size;
  let i = Math.round(x * inv), j = Math.round(z * inv);
  i = i < 0 ? 0 : i >= res ? res - 1 : i; j = j < 0 ? 0 : j >= res ? res - 1 : j;
  const g = map.ground[j * res + i];
  if ((g === GROUND.DEEP || g === GROUND.SHALLOW) && index(map).bridges.length && bridgeAt(map, x, z) > -Infinity) return GROUND.ROAD;
  return g;
}

// Water depth at (x, z) (0 when dry or on a bridge deck).
export function waterDepthAt(map, x, z) {
  if (!map.water) return 0;
  const d = map.water.level - terrainHeightAt(map, x, z);
  if (d <= 0) return 0;
  return bridgeAt(map, x, z) > -Infinity ? 0 : d;
}

// Inside the playable area (map.play = {min, max}; defaults to the whole square), shrunk by margin.
export function inBounds(map, x, z, margin = 0) {
  const lo = (map.play ? map.play.min : 0) + margin, hi = (map.play ? map.play.max : map.size) - margin;
  return x >= lo && x <= hi && z >= lo && z <= hi;
}

// Clamp a point into the playable area.
export function clampToBounds(map, p, margin = 0) {
  const lo = (map.play ? map.play.min : 0) + margin, hi = (map.play ? map.play.max : map.size) - margin;
  p.x = p.x < lo ? lo : p.x > hi ? hi : p.x; p.z = p.z < lo ? lo : p.z > hi ? hi : p.z;
  return p;
}

// Clip t-range of a ray against the square [0,size]^2 in x/z. Returns false if it misses.
const _clip = [0, 0];
function clipSquare(size, ox, oz, dx, dz, t0, t1) {
  if (Math.abs(dx) < 1e-12) { if (ox < 0 || ox > size) return false; }
  else {
    let a = (0 - ox) / dx, b = (size - ox) / dx; if (a > b) { const t = a; a = b; b = t; }
    if (a > t0) t0 = a; if (b < t1) t1 = b;
  }
  if (Math.abs(dz) < 1e-12) { if (oz < 0 || oz > size) return false; }
  else {
    let a = (0 - oz) / dz, b = (size - oz) / dz; if (a > b) { const t = a; a = b; b = t; }
    if (a > t0) t0 = a; if (b < t1) t1 = b;
  }
  if (t0 > t1) return false;
  _clip[0] = t0; _clip[1] = t1; return true;
}

// Ray vs heightfield: exact against the bilinear surface. A 2D DDA walks the height cells
// along the ray; a cell is skipped when the ray is above its highest corner, otherwise the
// ray/bilinear-patch equation (quadratic in t) is solved inside the cell, so grazing rays
// and thin crests are handled without step-size artefacts. Returns t (0 if o starts under
// the ground) or -1. The terrain only: bridge decks are props (see raycastObjects).
export function raycastTerrain(map, o, d, maxT = 1000) {
  const q = index(map);
  const size = map.size, cell = map.size / (map.res - 1), res = map.res, H = map.heights;
  const ox = o.x, oy = o.y, oz = o.z, dx = d.x, dy = d.y, dz = d.z;
  if (!clipSquare(size, ox, oz, dx, dz, 0, maxT)) return -1;
  let t = _clip[0]; const tEnd = _clip[1];
  if (oy + dy * t > q.maxH && dy >= 0) return -1;
  // starting cell
  const n = res - 1;
  let px = (ox + dx * t) / cell, pz = (oz + dz * t) / cell;
  let ci = Math.floor(px), cj = Math.floor(pz);
  if (ci > n - 1) ci = n - 1; if (ci < 0) ci = 0; if (cj > n - 1) cj = n - 1; if (cj < 0) cj = 0;
  const sx = dx > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
  const adx = Math.abs(dx), adz = Math.abs(dz);
  const tdx = adx > 1e-12 ? cell / adx : Infinity, tdz = adz > 1e-12 ? cell / adz : Infinity;
  let tmx = adx > 1e-12 ? ((sx > 0 ? (ci + 1) * cell : ci * cell) - ox) / dx : Infinity;
  let tmz = adz > 1e-12 ? ((sz > 0 ? (cj + 1) * cell : cj * cell) - oz) / dz : Infinity;
  const cmax = q.cellMax;
  const invCell = 1 / cell;
  for (let guard = 0; guard < 4 * n + 8; guard++) {
    let tx = tmx < tmz ? tmx : tmz; if (tx > tEnd) tx = tEnd;
    const y0 = oy + dy * t, y1 = oy + dy * tx;
    const ylo = y0 < y1 ? y0 : y1;
    if (ylo <= cmax[cj * n + ci]) {
      // solve inside the cell
      const k = cj * res + ci;
      const a = H[k], b = H[k + 1] - a, c = H[k + res] - a, e = a - H[k + 1] - H[k + res] + H[k + res + 1];
      const u0 = (ox + dx * t) * invCell - ci, v0 = (oz + dz * t) * invCell - cj;
      const du = dx * invCell, dv = dz * invCell;
      const A = a + b * u0 + c * v0 + e * u0 * v0;
      const B = b * du + c * dv + e * (u0 * dv + v0 * du);
      const C = e * du * dv;
      const q0 = y0 - A, q1 = dy - B, q2 = -C, len = tx - t;
      if (q0 <= 0) return t;                               // at/under the surface at entry
      let r = -1;
      if (Math.abs(q2) < 1e-12) { if (q1 < 0) { const s = -q0 / q1; if (s <= len) r = s; } }
      else {
        const disc = q1 * q1 - 4 * q2 * q0;
        if (disc >= 0) {
          const sq = Math.sqrt(disc);
          // numerically stable roots
          const qq = -0.5 * (q1 + (q1 >= 0 ? sq : -sq));
          let r1 = qq / q2, r2 = qq !== 0 ? q0 / qq : Infinity;
          if (r1 > r2) { const tt = r1; r1 = r2; r2 = tt; }
          if (r1 >= 0 && r1 <= len) r = r1; else if (r2 >= 0 && r2 <= len) r = r2;
        }
      }
      if (r < 0 && oy + dy * tx - (a + b * (u0 + du * len) + c * (v0 + dv * len) + e * (u0 + du * len) * (v0 + dv * len)) <= 0) r = len; // round-off guard
      if (r >= 0) return t + r;
    } else if (dy >= 0 && ylo > q.maxH) return -1;
    if (tx >= tEnd) return -1;
    t = tx;
    if (tmx < tmz) { ci += sx; tmx += tdx; if (ci < 0 || ci >= n) return -1; }
    else { cj += sz; tmz += tdz; if (cj < 0 || cj >= n) return -1; }
  }
  return -1;
}

// ---------------------------------------------------------------- props index

function index(map) {
  let q = map._q;
  if (q && q.objects === (map.objects || q.objects) && q.count === (map.objects ? map.objects.length : 0) && q.heights === map.heights) return q;
  q = buildIndex(map);
  Object.defineProperty(map, '_q', { value: q, writable: true, configurable: true, enumerable: false });
  return q;
}
export { index as buildQueryIndex };

function buildHash(parts, n, rOf, topOf) {
  const counts = new Int32Array(n * n + 1), top = new Float32Array(n * n).fill(-Infinity);
  const ranges = [];
  for (let p = 0; p < parts.length; p++) {
    const pt = parts[p], r = rOf(pt);
    const i0 = Math.max(0, Math.floor((pt.cx - r) / HASH)), i1 = Math.min(n - 1, Math.floor((pt.cx + r) / HASH));
    const j0 = Math.max(0, Math.floor((pt.cz - r) / HASH)), j1 = Math.min(n - 1, Math.floor((pt.cz + r) / HASH));
    ranges.push(i0, i1, j0, j1);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) counts[j * n + i + 1]++;
  }
  for (let k = 0; k < n * n; k++) counts[k + 1] += counts[k];
  const fill = counts.slice(0, n * n), items = new Int32Array(counts[n * n]);
  for (let p = 0; p < parts.length; p++) {
    const [i0, i1, j0, j1] = ranges.slice(p * 4, p * 4 + 4), tp = topOf(parts[p]);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const c = j * n + i; items[fill[c]++] = p; if (tp > top[c]) top[c] = tp;
    }
  }
  return { start: counts, items, top };
}

function partR(p) { return p.type === CYL ? p.hx : Math.hypot(p.hx, p.hz); }
function partTop(p) { return p.cy + p.hy; }

function buildIndex(map) {
  const n = Math.ceil(map.size / HASH);
  const res = map.res, H = map.heights, cn = res - 1;
  const cellMax = new Float32Array(cn * cn);
  let maxH = -Infinity;
  for (let j = 0; j < cn; j++) for (let i = 0; i < cn; i++) {
    const k = j * res + i;
    const m = Math.max(H[k], H[k + 1], H[k + res], H[k + res + 1]);
    cellMax[j * cn + i] = m; if (m > maxH) maxH = m;
  }
  const solids = [], foliage = [], bridges = [];
  const objs = map.objects || [];
  for (const o of objs) {
    for (const p of objectParts(o)) solids.push(p);
    const f = foliagePart(o); if (f) foliage.push(f);
    if (o.kind === 'bridge') { const p = objectParts(o)[0]; bridges.push({ obj: o, cx: p.cx, cz: p.cz, c: p.c, s: p.s, hx: p.hx, hz: p.hz, top: p.cy + p.hy }); }
  }
  const objParts = objs.map((o) => { const b = objectBounds(o); return { cx: o.x, cz: o.z, hx: b.r, hz: 0, cy: 0, hy: b.top, type: CYL, obj: o }; });
  return {
    objects: objs, count: objs.length, heights: H, n, cellMax, maxH,
    solids, solidHash: buildHash(solids, n, partR, partTop), solidStamp: new Uint32Array(solids.length),
    foliage, foliageHash: buildHash(foliage, n, partR, partTop), foliageStamp: new Uint32Array(foliage.length),
    objParts, objHash: buildHash(objParts, n, (p) => p.hx, (p) => p.hy), objStamp: new Uint32Array(objs.length),
    stamp: 0, bridges,
  };
}

function nextStamp(q, arrName) {
  q.stamp = (q.stamp + 1) >>> 0;
  if (q.stamp === 0) { q.solidStamp.fill(0); q.foliageStamp.fill(0); q.objStamp.fill(0); q.stamp = 1; }
  return q.stamp;
}

// ---------------------------------------------------------------- ray vs parts
// All tests transform the ray into the part's local frame (origin at the part centre).
// They return the entry t (or -1) and write the world-space entry normal into _hn.
const _hn = { x: 0, y: 0, z: 0 };

function rayPart(p, ox, oy, oz, dx, dy, dz) {
  const rx = ox - p.cx, rz = oz - p.cz, c = p.c, s = p.s;
  const lx = rx * c - rz * s, lz = rx * s + rz * c, ly = oy - p.cy;
  const ldx = dx * c - dz * s, ldz = dx * s + dz * c, ldy = dy;
  let t = -1, nx = 0, ny = 0, nz = 0;
  if (p.type === BOX) {
    let tn = -Infinity, tf = Infinity, ax = 0;
    // x slab
    if (Math.abs(ldx) < 1e-12) { if (lx < -p.hx || lx > p.hx) return -1; }
    else { let a = (-p.hx - lx) / ldx, b = (p.hx - lx) / ldx; let sg = -1; if (a > b) { const q = a; a = b; b = q; sg = 1; } if (a > tn) { tn = a; ax = 1 * sg; } if (b < tf) tf = b; }
    if (Math.abs(ldy) < 1e-12) { if (ly < -p.hy || ly > p.hy) return -1; }
    else { let a = (-p.hy - ly) / ldy, b = (p.hy - ly) / ldy; let sg = -1; if (a > b) { const q = a; a = b; b = q; sg = 1; } if (a > tn) { tn = a; ax = 2 * sg; } if (b < tf) tf = b; }
    if (Math.abs(ldz) < 1e-12) { if (lz < -p.hz || lz > p.hz) return -1; }
    else { let a = (-p.hz - lz) / ldz, b = (p.hz - lz) / ldz; let sg = -1; if (a > b) { const q = a; a = b; b = q; sg = 1; } if (a > tn) { tn = a; ax = 3 * sg; } if (b < tf) tf = b; }
    if (tn > tf || tf < 0) return -1;
    if (tn < 0) { t = 0; nx = -ldx; ny = -ldy; nz = -ldz; }   // origin inside
    else { t = tn; const aa = Math.abs(ax), sg = ax > 0 ? 1 : -1; if (aa === 1) nx = sg; else if (aa === 2) ny = sg; else nz = sg; }
  } else if (p.type === CYL) {
    const r = p.hx;
    let tn = -Infinity, tf = Infinity, side = true;
    const a = ldx * ldx + ldz * ldz, cc = lx * lx + lz * lz - r * r;
    if (a < 1e-12) { if (cc > 0) return -1; }
    else {
      const b = lx * ldx + lz * ldz, disc = b * b - a * cc;
      if (disc < 0) return -1;
      const sq = Math.sqrt(disc); tn = (-b - sq) / a; tf = (-b + sq) / a;
    }
    if (Math.abs(ldy) < 1e-12) { if (ly < -p.hy || ly > p.hy) return -1; }
    else {
      let ya = (-p.hy - ly) / ldy, yb = (p.hy - ly) / ldy; if (ya > yb) { const q = ya; ya = yb; yb = q; }
      if (ya > tn) { tn = ya; side = false; } if (yb < tf) tf = yb;
    }
    if (tn > tf || tf < 0) return -1;
    if (tn < 0) { t = 0; nx = -ldx; ny = -ldy; nz = -ldz; }
    else { t = tn; if (side) { nx = lx + ldx * t; nz = lz + ldz * t; } else ny = ldy > 0 ? -1 : 1; }
  } else if (p.type === ELL) {
    const ix = 1 / p.hx, iy = 1 / p.hy, iz = 1 / p.hz;
    const sx = lx * ix, sy = ly * iy, sz = lz * iz, ex = ldx * ix, ey = ldy * iy, ez = ldz * iz;
    const a = ex * ex + ey * ey + ez * ez, b = sx * ex + sy * ey + sz * ez, cc = sx * sx + sy * sy + sz * sz - 1;
    const disc = b * b - a * cc;
    if (disc < 0) return -1;
    const sq = Math.sqrt(disc), t0 = (-b - sq) / a, t1 = (-b + sq) / a;
    if (t1 < 0) return -1;
    if (t0 < 0) { t = 0; nx = -ldx; ny = -ldy; nz = -ldz; }
    else { t = t0; nx = (lx + ldx * t) * ix * ix; ny = (ly + ldy * t) * iy * iy; nz = (lz + ldz * t) * iz * iz; }
  } else { // GABLE: planes n·p <= 1 in local coords (base at y=0)
    const H = p.hy, hx = p.hx, hz = p.hz;
    let tn = -Infinity, tf = Infinity, bn = -1;
    // plane list: [nx, ny, nz, d]
    const P = GABLE_PLANES; P[0] = 1 / hx; P[4] = -1 / hx; P[9] = -1; P[13] = 1 / H; P[14] = 1 / hz; P[17] = 1 / H; P[18] = -1 / hz;
    for (let k = 0; k < 20; k += 4) {
      const den = P[k] * ldx + P[k + 1] * ldy + P[k + 2] * ldz;
      const num = P[k + 3] - (P[k] * lx + P[k + 1] * ly + P[k + 2] * lz);
      if (Math.abs(den) < 1e-12) { if (num < 0) return -1; continue; }
      const tt = num / den;
      if (den < 0) { if (tt > tn) { tn = tt; bn = k; } } else if (tt < tf) tf = tt;
      if (tn > tf) return -1;
    }
    if (tf < 0) return -1;
    if (tn < 0) { t = 0; nx = -ldx; ny = -ldy; nz = -ldz; }
    else { t = tn; nx = P[bn]; ny = P[bn + 1]; nz = P[bn + 2]; }
  }
  // back to world
  const L = Math.hypot(nx, ny, nz) || 1;
  nx /= L; ny /= L; nz /= L;
  _hn.x = nx * c + nz * s; _hn.y = ny; _hn.z = -nx * s + nz * c;
  return t;
}
// x<=hx, -x<=hx, -y<=0, y/H+z/hz<=1, y/H-z/hz<=1  (d terms are the 4th entry)
const GABLE_PLANES = new Float64Array([1, 0, 0, 1, -1, 0, 0, 1, 0, -1, 0, 0, 0, 1, 1, 1, 0, 1, -1, 1]);

// Ray-interval of a part (entry, exit) for foliage chords; returns false on a miss.
const _iv = [0, 0];
function partInterval(p, ox, oy, oz, dx, dy, dz) {
  const rx = ox - p.cx, rz = oz - p.cz, c = p.c, s = p.s;
  const lx = rx * c - rz * s, lz = rx * s + rz * c, ly = oy - p.cy;
  const ldx = dx * c - dz * s, ldz = dx * s + dz * c, ldy = dy;
  if (p.type === ELL) {
    const ix = 1 / p.hx, iy = 1 / p.hy, iz = 1 / p.hz;
    const sx = lx * ix, sy = ly * iy, sz = lz * iz, ex = ldx * ix, ey = ldy * iy, ez = ldz * iz;
    const a = ex * ex + ey * ey + ez * ez, b = sx * ex + sy * ey + sz * ez, cc = sx * sx + sy * sy + sz * sz - 1;
    const disc = b * b - a * cc; if (disc < 0) return false;
    const sq = Math.sqrt(disc); _iv[0] = (-b - sq) / a; _iv[1] = (-b + sq) / a; return true;
  }
  let tn = -Infinity, tf = Infinity;
  const slab = (o, d, h) => {
    if (Math.abs(d) < 1e-12) return o >= -h && o <= h;
    let a = (-h - o) / d, b = (h - o) / d; if (a > b) { const q = a; a = b; b = q; }
    if (a > tn) tn = a; if (b < tf) tf = b; return tn <= tf;
  };
  if (p.type === CYL) {
    const r = p.hx, a = ldx * ldx + ldz * ldz, cc = lx * lx + lz * lz - r * r;
    if (a < 1e-12) { if (cc > 0) return false; }
    else { const b = lx * ldx + lz * ldz, disc = b * b - a * cc; if (disc < 0) return false; const sq = Math.sqrt(disc); tn = (-b - sq) / a; tf = (-b + sq) / a; }
    if (!slab(ly, ldy, p.hy)) return false;
  } else if (!slab(lx, ldx, p.hx) || !slab(ly, ldy, p.hy) || !slab(lz, ldz, p.hz)) return false;
  _iv[0] = tn; _iv[1] = tf; return tn <= tf;
}

// Walk the hash cells a 2D ray passes through; visit(cellIndex, tIn, tOut) returns true to stop.
function walkHash(q, size, ox, oz, dx, dz, maxT, visit) {
  if (!clipSquare(size, ox, oz, dx, dz, 0, maxT)) return;
  let t = _clip[0]; const tEnd = _clip[1], n = q.n;
  let ci = Math.floor((ox + dx * t) / HASH), cj = Math.floor((oz + dz * t) / HASH);
  if (ci > n - 1) ci = n - 1; if (ci < 0) ci = 0; if (cj > n - 1) cj = n - 1; if (cj < 0) cj = 0;
  const sx = dx > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1, adx = Math.abs(dx), adz = Math.abs(dz);
  const tdx = adx > 1e-12 ? HASH / adx : Infinity, tdz = adz > 1e-12 ? HASH / adz : Infinity;
  let tmx = adx > 1e-12 ? ((sx > 0 ? (ci + 1) * HASH : ci * HASH) - ox) / dx : Infinity;
  let tmz = adz > 1e-12 ? ((sz > 0 ? (cj + 1) * HASH : cj * HASH) - oz) / dz : Infinity;
  for (let g = 0; g < 4 * n + 8; g++) {
    let tx = tmx < tmz ? tmx : tmz; if (tx > tEnd) tx = tEnd;
    if (visit(cj * n + ci, t, tx)) return;
    if (tx >= tEnd) return;
    t = tx;
    if (tmx < tmz) { ci += sx; tmx += tdx; if (ci < 0 || ci >= n) return; }
    else { cj += sz; tmz += tdz; if (cj < 0 || cj >= n) return; }
  }
}

function makeFilter(filter) {
  if (typeof filter === 'function') return filter;
  if (filter === 'tank') return (o, k) => k.solidTank;
  if (filter === 'any') return (o, k) => k.solidTank || k.solidShell;
  return (o, k) => k.solidShell;                           // 'shell' / 'sight' (default)
}
const FILTERS = { shell: makeFilter('shell'), tank: makeFilter('tank'), any: makeFilter('any') };

// Ray vs solid props. filter: 'shell' (default; solidShell kinds), 'sight' (same),
// 'tank' (solidTank kinds), 'any', or fn(obj, kindDef) → bool. Fallen/destroyed props are
// always skipped. Returns { t, obj, nx, ny, nz } (entry normal, world space) or null.
export function raycastObjects(map, o, d, maxT = 1000, filter) {
  const q = index(map);
  if (q.solids.length === 0) return null;
  const f = typeof filter === 'function' ? filter : FILTERS[filter] || FILTERS.shell;
  const stamp = nextStamp(q), st = q.solidStamp, hs = q.solidHash, parts = q.solids;
  const ox = o.x, oy = o.y, oz = o.z, dx = d.x, dy = d.y, dz = d.z;
  let best = maxT, bestP = null, bnx = 0, bny = 0, bnz = 0;
  walkHash(q, map.size, ox, oz, dx, dz, maxT, (cell, t0, t1) => {
    if (t0 > best) return true;
    const y0 = oy + dy * t0, y1 = oy + dy * t1;
    if ((y0 < y1 ? y0 : y1) > hs.top[cell]) return false;
    for (let k = hs.start[cell], e = hs.start[cell + 1]; k < e; k++) {
      const pi = hs.items[k];
      if (st[pi] === stamp) continue; st[pi] = stamp;
      const p = parts[pi], ob = p.obj;
      if (ob.fallen || ob.destroyed) continue;
      const kd = OBJECT_KINDS[ob.kind]; if (!kd || !f(ob, kd)) continue;
      const t = rayPart(p, ox, oy, oz, dx, dy, dz);
      if (t >= 0 && t < best) { best = t; bestP = p; bnx = _hn.x; bny = _hn.y; bnz = _hn.z; }
    }
    return best <= t1;
  });
  return bestP ? { t: best, obj: bestP.obj, nx: bnx, ny: bny, nz: bnz } : null;
}

// Terrain + props in one call: { t, obj|null, nx, ny, nz } or null.
export function raycast(map, o, d, maxT = 1000, filter) {
  const tt = raycastTerrain(map, o, d, maxT);
  const ob = raycastObjects(map, o, d, tt >= 0 ? tt : maxT, filter);
  if (ob) return ob;
  if (tt < 0) return null;
  const n = normalAt(map, o.x + d.x * tt, o.z + d.z * tt);
  return { t: tt, obj: null, nx: n.x, ny: n.y, nz: n.z };
}

// Is the segment a→b clear of terrain and solid (shell-blocking) props?
export function lineClear(map, a, b, filter) {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z, L = Math.hypot(dx, dy, dz);
  if (L < 1e-6) return true;
  const d = { x: dx / L, y: dy / L, z: dz / L };
  if (raycastTerrain(map, a, d, L) >= 0) return false;
  return raycastObjects(map, a, d, L, filter) === null;
}

// Calls cb(obj) once for every prop whose bounding circle overlaps the circle (x, z, r),
// including fallen/destroyed ones (check obj.fallen / obj.destroyed). cb returning true stops.
// Returns the number of objects visited.
export function objectsNear(map, x, z, r, cb) {
  const q = index(map), n = q.n, hs = q.objHash, st = q.objStamp, stamp = nextStamp(q);
  const i0 = Math.max(0, Math.floor((x - r) / HASH)), i1 = Math.min(n - 1, Math.floor((x + r) / HASH));
  const j0 = Math.max(0, Math.floor((z - r) / HASH)), j1 = Math.min(n - 1, Math.floor((z + r) / HASH));
  let count = 0;
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const c = j * n + i;
    for (let k = hs.start[c], e = hs.start[c + 1]; k < e; k++) {
      const pi = hs.items[k];
      if (st[pi] === stamp) continue; st[pi] = stamp;
      const p = q.objParts[pi], rr = r + p.hx;
      if ((p.cx - x) ** 2 + (p.cz - z) ** 2 > rr * rr) continue;
      count++;
      if (cb && cb(p.obj)) return count;
    }
  }
  return count;
}

// Collision parts of one object (world space), see objects.js.
export { objectParts, foliagePart };

// Push a circle (x, z, radius r) out of the 2D footprints of blocking props.
// filter as raycastObjects ('tank' by default). Roof prisms are skipped (the wall box
// has the same footprint); rocks use their ground-level ellipse as a box of 0.85×.
// Returns { x, z, hits: [obj] } with the corrected centre and the props touched.
export function resolveCircle(map, x, z, r, filter = 'tank') {
  const q = index(map);
  const f = typeof filter === 'function' ? filter : FILTERS[filter] || FILTERS.tank;
  const hits = [];
  for (let pass = 0; pass < 3; pass++) {
    let moved = false;
    const n = q.n, hs = q.solidHash, st = q.solidStamp, stamp = nextStamp(q);
    const R = r + 12;
    const i0 = Math.max(0, Math.floor((x - R) / HASH)), i1 = Math.min(n - 1, Math.floor((x + R) / HASH));
    const j0 = Math.max(0, Math.floor((z - R) / HASH)), j1 = Math.min(n - 1, Math.floor((z + R) / HASH));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const cell = j * n + i;
      for (let k = hs.start[cell], e = hs.start[cell + 1]; k < e; k++) {
        const pi = hs.items[k];
        if (st[pi] === stamp) continue; st[pi] = stamp;
        const p = q.solids[pi], ob = p.obj;
        if (p.type === GABLE || ob.fallen || ob.destroyed) continue;
        const kd = OBJECT_KINDS[ob.kind]; if (!kd || !f(ob, kd)) continue;
        const rx = x - p.cx, rz = z - p.cz;
        let px, pz;
        if (p.type === CYL) {
          const d = Math.hypot(rx, rz), m = r + p.hx;
          if (d >= m) continue;
          const nx = d > 1e-6 ? rx / d : 1, nz = d > 1e-6 ? rz / d : 0;
          px = nx * (m - d); pz = nz * (m - d);
        } else {
          const sc = p.type === ELL ? 0.85 : 1, hx = p.hx * sc, hz = p.hz * sc;
          const lx = rx * p.c - rz * p.s, lz = rx * p.s + rz * p.c;
          const cx = Math.max(-hx, Math.min(hx, lx)), cz = Math.max(-hz, Math.min(hz, lz));
          let ex = lx - cx, ez = lz - cz, d = Math.hypot(ex, ez), mx, mz;
          if (d > 1e-6) { if (d >= r) continue; mx = ex / d * (r - d); mz = ez / d * (r - d); }
          else { // centre inside: leave by the nearest face
            const fx = hx - Math.abs(lx), fz = hz - Math.abs(lz);
            if (fx < fz) { mx = Math.sign(lx || 1) * (fx + r); mz = 0; } else { mx = 0; mz = Math.sign(lz || 1) * (fz + r); }
          }
          px = mx * p.c + mz * p.s; pz = -mx * p.s + mz * p.c;
        }
        x += px; z += pz; moved = true;
        if (!hits.includes(ob)) hits.push(ob);
      }
    }
    if (!moved) break;
  }
  return { x, z, hits };
}

// Foliage on the sight line o→p (camo). Each foliage volume the line passes through adds its
// kind.foliage (weighted by chord length up to 1 m) combined as 1 − Π(1 − f). Volumes whose
// chord ends within 15 m of p count as `nearTarget` (the target's own bush: the sim should
// drop those after the target fires); volumes whose chord starts within 15 m of o are ignored
// (WoT: your own bush does not blind you). Fallen props are skipped.
// Returns { amount: total 0..1, nearTarget: 0..1, far: 0..1 (excluding nearTarget) }.
export function foliageAlong(map, o, p) {
  const q = index(map);
  const dx0 = p.x - o.x, dy0 = p.y - o.y, dz0 = p.z - o.z, L = Math.hypot(dx0, dy0, dz0);
  if (L < 1e-6 || q.foliage.length === 0) return { amount: 0, nearTarget: 0, far: 0 };
  const dx = dx0 / L, dy = dy0 / L, dz = dz0 / L;
  const stamp = nextStamp(q), st = q.foliageStamp, hs = q.foliageHash, parts = q.foliage;
  let farP = 1, nearP = 1;
  walkHash(q, map.size, o.x, o.z, dx, dz, L, (cell, t0, t1) => {
    const y0 = o.y + dy * t0, y1 = o.y + dy * t1;
    if ((y0 < y1 ? y0 : y1) > hs.top[cell]) return false;
    for (let k = hs.start[cell], e = hs.start[cell + 1]; k < e; k++) {
      const pi = hs.items[k];
      if (st[pi] === stamp) continue; st[pi] = stamp;
      const fp = parts[pi], ob = fp.obj;
      if (ob.fallen || ob.destroyed) continue;
      if (!partInterval(fp, o.x, o.y, o.z, dx, dy, dz)) continue;
      const a = Math.max(0, _iv[0]), b = Math.min(L, _iv[1]);
      if (b - a < 0.05) continue;
      const fo = OBJECT_KINDS[ob.kind].foliage * Math.min(1, (b - a) / 1.0);
      if (L - b <= NEAR_FOLIAGE) nearP *= 1 - fo;
      else if (a >= NEAR_FOLIAGE) farP *= 1 - fo;
    }
    return false;
  });
  return { amount: 1 - farP * nearP, nearTarget: 1 - nearP, far: 1 - farP };
}

// Knock a prop over or destroy it. Crushable props fall (away from the push direction
// dirX, dirZ), shootable ones are destroyed. Returns true if its state changed.
// The map is battle state: load a fresh map (loadMap) per battle.
export function breakObject(map, obj, dirX = 0, dirZ = 1) {
  const k = OBJECT_KINDS[obj.kind];
  if (!k || !k.breakable || obj.fallen || obj.destroyed) return false;
  if (k.breakable === 'crush') { obj.fallen = true; obj.fallDir = Math.atan2(dirX, dirZ); }
  else obj.destroyed = true;
  map.broken = (map.broken || 0) + 1;
  return true;
}
