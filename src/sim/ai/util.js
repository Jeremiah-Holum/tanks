// AI helpers: angles, per-map analysis (lanes, points by geographic lane), shell indices.
import { findPath } from '../map/nav.js';

export const TAU = Math.PI * 2;
export const wrap = (a) => { while (a > Math.PI) a -= TAU; while (a < -Math.PI) a += TAU; return a; };
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, k) => a + (b - a) * k;
export const hyp = (dx, dz) => Math.sqrt(dx * dx + dz * dz);
export const dist = (a, b) => hyp(a.x - b.x, a.z - b.z);
// Heading (yaw) from a to b: forward = (sin θ, cos θ).
export const headingTo = (ax, az, bx, bz) => Math.atan2(bx - ax, bz - az);

// Shell slots of a gun: std (non-gold, non-HE), gold (premium), he. -1 when absent.
export function shellSlots(g) {
  const s = g.shells;
  let std = -1, gold = -1, he = -1;
  s.forEach((x, i) => {
    if (x.type === 'HE' && he < 0) he = i;
    else if (x.gold && gold < 0) gold = i;
    else if (!x.gold && x.type !== 'HE' && std < 0) std = i;
  });
  if (std < 0) std = gold >= 0 ? gold : 0;
  return { std, gold, he };
}

// ------------------------------------------------------------------ lanes
// Polyline with cumulative lengths; project(x, z) → { s: 0..1 from the team-0 base, d: metres off }.
function laneGeom(path) {
  const cum = [0];
  for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + hyp(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]));
  const len = cum[cum.length - 1] || 1;
  return {
    path, cum, len,
    project(x, z) {
      let bd = Infinity, bs = 0;
      for (let i = 1; i < path.length; i++) {
        const [ax, az] = path[i - 1], [bx, bz] = path[i], ex = bx - ax, ez = bz - az, L2 = ex * ex + ez * ez || 1;
        const k = clamp(((x - ax) * ex + (z - az) * ez) / L2, 0, 1), px = ax + ex * k, pz = az + ez * k;
        const d = hyp(x - px, z - pz);
        if (d < bd) { bd = d; bs = (cum[i - 1] + k * (cum[i] - cum[i - 1])) / len; }
      }
      return { s: bs, d: bd };
    },
    at(s) { // point at progress s (0..1)
      const L = clamp(s, 0, 1) * len;
      let i = 1; while (i < path.length - 1 && cum[i] < L) i++;
      const k = (L - cum[i - 1]) / Math.max(1e-6, cum[i] - cum[i - 1]);
      return { x: lerp(path[i - 1][0], path[i][0], k), z: lerp(path[i - 1][1], path[i][1], k) };
    },
  };
}

// Per-map analysis, cached on the MapData.
const INFO = new WeakMap();
export function mapInfo(map) {
  let I = INFO.get(map);
  if (I) return I;
  const lanes = (map.lanes && map.lanes.length ? map.lanes : [{ name: 'centre', path: [[map.bases[0].x, map.bases[0].z], [map.bases[1].x, map.bases[1].z]] }]).map((l) => laneGeom(l.path));
  const geo = (x, z) => { let b = 0, bd = Infinity; lanes.forEach((l, i) => { const p = l.project(x, z); if (p.d < bd) { bd = p.d; b = i; } }); return b; };
  const points = (map.points || []).map((p, i) => { const g = geo(p.x, p.z); return { ...p, i, geo: g, s: lanes[g].project(p.x, p.z).s }; });
  // brawl lane: the one holding most brawl points
  const nb = lanes.map((_, i) => points.filter((p) => p.kind === 'brawl' && p.geo === i).length);
  const brawlLane = nb.indexOf(Math.max(...nb));
  const nav = map.nav || null;
  I = { lanes, geo, points, brawlLane, nav, centre: { x: map.size / 2, z: map.size / 2 } };
  INFO.set(map, I);
  return I;
}

// Is a nav cell at (x, z) passable (and not too expensive)?
export function passable(nav, x, z, maxCost = 2.6) {
  if (!nav) return true;
  const c = Math.floor(x / nav.cell), r = Math.floor(z / nav.cell);
  if (c < 0 || r < 0 || c >= nav.cols || r >= nav.rows) return false;
  const k = nav.cost[r * nav.cols + c];
  return k < maxCost;
}
// Nearest passable spot to (x, z) within ~40 m (spiral search), or the input.
export function snapPassable(nav, x, z, maxCost = 2.2) {
  if (!nav || passable(nav, x, z, maxCost)) return { x, z };
  for (let r = 4; r <= 40; r += 4) for (let a = 0; a < 12; a++) {
    const px = x + Math.cos(a * TAU / 12) * r, pz = z + Math.sin(a * TAU / 12) * r;
    if (passable(nav, px, pz, maxCost)) return { x: px, z: pz };
  }
  return { x, z };
}

export { findPath };
