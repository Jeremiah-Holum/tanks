// Navigation grid helpers: building map.nav from the terrain / ground / props, and A*.
// nav = { cell: 8, cols, rows, cost: Float32Array } with cost ≥ 0.8 per metre, Infinity = wall.
import { OBJECT_KINDS, GROUND, objectParts, BOX, CYL, ELL } from './objects.js';
import { bridgeAt, heightAt } from './query.js';

export const NAV_CELL = 8;
export const MAX_SLOPE = 30;           // degrees: steeper nav cells are impassable
const GROUND_COST = [1, 1, 0.8, 1.3, 1.1, 1.7, 2.2, Infinity, 1.15, 1.2];

export function slopeCost(deg) {
  if (deg <= 12) return 0;
  if (deg <= 24) return (deg - 12) / 12 * 1.5;
  if (deg <= MAX_SLOPE) return 1.5 + (deg - 24) / (MAX_SLOPE - 24) * 4;
  return Infinity;
}

export function buildNav(map) {
  const C = NAV_CELL, cols = Math.ceil(map.size / C), rows = cols;
  const cost = new Float32Array(cols * rows);
  const lo = map.play ? map.play.min : 0, hi = map.play ? map.play.max : map.size;
  const res = map.res, inv = (res - 1) / map.size;
  const gAt = (x, z) => {
    const i = Math.min(res - 1, Math.max(0, Math.round(x * inv))), j = Math.min(res - 1, Math.max(0, Math.round(z * inv)));
    return map.ground[j * res + i];
  };
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const x = (c + 0.5) * C, z = (r + 0.5) * C;
    if (x < lo + 3 || x > hi - 3 || z < lo + 3 || z > hi - 3) { cost[r * cols + c] = Infinity; continue; }
    // slope: steepest of two 8 m-baseline gradients (and the diagonals)
    const h = (a, b) => heightAt(map, a, b);
    const gx = (h(x + 4, z) - h(x - 4, z)) / 8, gz = (h(x, z + 4) - h(x, z - 4)) / 8;
    const gd1 = (h(x + 2.8, z + 2.8) - h(x - 2.8, z - 2.8)) / 8, gd2 = (h(x + 2.8, z - 2.8) - h(x - 2.8, z + 2.8)) / 8;
    const g = Math.max(Math.hypot(gx, gz), Math.hypot(gd1, gd2));
    const deg = Math.atan(g) * 180 / Math.PI;
    // ground: worst of the centre and four inner points (bridges read as road)
    let gc = 0, deep = 0;
    for (const [ox, oz] of [[0, 0], [-2.5, -2.5], [2.5, -2.5], [-2.5, 2.5], [2.5, 2.5]]) {
      let gr = gAt(x + ox, z + oz);
      if ((gr === GROUND.DEEP || gr === GROUND.SHALLOW) && bridgeAt(map, x + ox, z + oz) > -Infinity) gr = GROUND.ROAD;
      if (gr === GROUND.DEEP) deep++;
      gc = Math.max(gc, GROUND_COST[gr]);
    }
    let onBridge = false;
    for (const [ox, oz] of [[0, 0], [-2.5, -2.5], [2.5, -2.5], [-2.5, 2.5], [2.5, 2.5]]) if (bridgeAt(map, x + ox, z + oz) > -Infinity) onBridge = true;
    if (!onBridge && (deep >= 2 || (deep && gAt(x, z) === GROUND.DEEP))) { cost[r * cols + c] = Infinity; continue; }
    if (deep) gc = 3;
    cost[r * cols + c] = onBridge ? 0.8 : gc + slopeCost(deg);
  }
  // props: blocking footprints (expanded by a tank half-width margin) and tree clutter
  const sub = [[-2.5, -2.5], [2.5, -2.5], [-2.5, 2.5], [2.5, 2.5], [0, 0]];
  for (const o of map.objects) {
    const k = OBJECT_KINDS[o.kind];
    if (!k) continue;
    if (!k.navBlock) {
      if (k.solidTank) { const c = Math.floor(o.x / C), r = Math.floor(o.z / C); if (c >= 0 && r >= 0 && c < cols && r < rows) cost[r * cols + c] += o.kind === 'fence' ? 0.4 : 0.25; }
      continue;
    }
    for (const p of objectParts(o)) {
      if (p.type !== BOX && p.type !== CYL && p.type !== ELL) continue;
      const m = 1.2, R = (p.type === CYL ? p.hx : Math.hypot(p.hx, p.hz)) + m + C;
      const c0 = Math.max(0, Math.floor((p.cx - R) / C)), c1 = Math.min(cols - 1, Math.floor((p.cx + R) / C));
      const r0 = Math.max(0, Math.floor((p.cz - R) / C)), r1 = Math.min(rows - 1, Math.floor((p.cz + R) / C));
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
        let inside = 0;
        for (const [sx, sz] of sub) {
          const dx = (c + 0.5) * C + sx - p.cx, dz = (r + 0.5) * C + sz - p.cz;
          if (p.type === CYL) { if (Math.hypot(dx, dz) <= p.hx + m) inside++; continue; }
          const sc = p.type === ELL ? 0.85 : 1;
          const lx = dx * p.c - dz * p.s, lz = dx * p.s + dz * p.c;
          if (Math.abs(lx) <= p.hx * sc + m && Math.abs(lz) <= p.hz * sc + m) inside++;
        }
        const k2 = r * cols + c;
        if (inside >= 2 || (inside && p.hx * p.hz > 20)) cost[k2] = Infinity;
        else if (inside) cost[k2] += 2;
      }
    }
  }
  return { cell: C, cols, rows, cost };
}

// Minimal binary heap keyed by f
class Heap {
  constructor() { this.k = []; this.v = []; }
  push(key, val) {
    const k = this.k, v = this.v; let i = k.length; k.push(key); v.push(val);
    while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v, top = v[0], lk = k.pop(), lv = v.pop(), n = k.length;
    if (n) {
      let i = 0;
      for (;;) { let c = 2 * i + 1; if (c >= n) break; if (c + 1 < n && k[c + 1] < k[c]) c++; if (k[c] >= lk) break; k[i] = k[c]; v[i] = v[c]; i = c; }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
  get size() { return this.k.length; }
}

// A* over map.nav from world (ax, az) to (bx, bz), 8-connected, no corner cutting past walls.
// Returns [[x,z]...] cell centres (start and goal snapped to the nearest passable cell) or null.
export function findPath(nav, ax, az, bx, bz, maxIter = 200000) {
  const { cell: C, cols, rows, cost } = nav;
  const snap = (x, z) => {
    let c = Math.min(cols - 1, Math.max(0, Math.floor(x / C))), r = Math.min(rows - 1, Math.max(0, Math.floor(z / C)));
    if (isFinite(cost[r * cols + c])) return r * cols + c;
    for (let rad = 1; rad < 6; rad++) for (let dr = -rad; dr <= rad; dr++) for (let dc = -rad; dc <= rad; dc++) {
      const rr = r + dr, cc = c + dc;
      if (rr >= 0 && cc >= 0 && rr < rows && cc < cols && isFinite(cost[rr * cols + cc])) return rr * cols + cc;
    }
    return -1;
  };
  const s = snap(ax, az), g = snap(bx, bz);
  if (s < 0 || g < 0) return null;
  const N = cols * rows, gs = new Float32Array(N).fill(Infinity), from = new Int32Array(N).fill(-1), closed = new Uint8Array(N);
  const gc = g % cols, gr = (g / cols) | 0;
  const hfn = (k) => { const dc = Math.abs(k % cols - gc), dr = Math.abs(((k / cols) | 0) - gr); return 0.8 * C * (Math.max(dc, dr) + 0.414 * Math.min(dc, dr)); };
  const heap = new Heap();
  gs[s] = 0; heap.push(hfn(s), s);
  let it = 0;
  while (heap.size && it++ < maxIter) {
    const k = heap.pop();
    if (closed[k]) continue; closed[k] = 1;
    if (k === g) break;
    const c = k % cols, r = (k / cols) | 0;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const cc = c + dc, rr = r + dr;
      if (cc < 0 || rr < 0 || cc >= cols || rr >= rows) continue;
      const nk = rr * cols + cc;
      if (closed[nk] || !isFinite(cost[nk])) continue;
      if (dr && dc && (!isFinite(cost[r * cols + cc]) || !isFinite(cost[rr * cols + c]))) continue;
      const step = (dr && dc ? 1.4142 : 1) * C * 0.5 * (cost[k] + cost[nk]);
      const ng = gs[k] + step;
      if (ng < gs[nk]) { gs[nk] = ng; from[nk] = k; heap.push(ng + hfn(nk), nk); }
    }
  }
  if (from[g] < 0 && g !== s) return null;
  const out = [];
  for (let k = g; k >= 0; k = from[k]) { out.push([(k % cols + 0.5) * C, (((k / cols) | 0) + 0.5) * C]); if (k === s) break; }
  out.reverse();
  out.cost = gs[g];
  return out;
}

// Ramer–Douglas–Peucker polyline simplification.
export function simplify(pts, tol) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let md = 0, mi = -1;
    const [ax, az] = pts[a], [bx, bz] = pts[b], L = Math.hypot(bx - ax, bz - az) || 1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((bx - ax) * (az - pts[i][1]) - (ax - pts[i][0]) * (bz - az)) / L;
      if (d > md) { md = d; mi = i; }
    }
    if (md > tol) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
