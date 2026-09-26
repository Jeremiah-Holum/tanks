// Path planning (A* on the team's nav overlay, then string-pulling with a tank-width clearance
// check) and a pure-pursuit follower along the smoothed route.
import { findPath } from '../map/nav.js';
import { hyp, passable } from './util.js';
import { waterDepthAt } from '../map/query.js';

// Can a tank drive straight from a to b? Samples every 2.5 m, centre and ±2.4 m sideways,
// against the base nav (finite, not too costly: no cutting through buildings, steep or deep).
// With `map` given, also refuses water deeper than fording depth (nav cells at a bridge's
// edge are passable, but the water beside the deck is not).
export function segClear(nav, ax, az, bx, bz, maxCost = 2.6, map = null) {
  const L = hyp(bx - ax, bz - az);
  if (L < 1) return true;
  const ux = (bx - ax) / L, uz = (bz - az) / L, lx = -uz * 2.4, lz = ux * 2.4;
  const wet = map && map.water ? (x, z) => waterDepthAt(map, x, z) > 1.1 : null;
  for (let d = 0; d <= L; d += 2.5) {
    const x = ax + ux * d, z = az + uz * d;
    if (!passable(nav, x, z, maxCost) || !passable(nav, x + lx, z + lz, maxCost) || !passable(nav, x - lx, z - lz, maxCost)) return false;
    if (wet && (wet(x, z) || wet(x + lx, z + lz) || wet(x - lx, z - lz))) return false;
  }
  return true;
}

// Greedy string-pulling: from each kept point jump to the farthest point still in clear view
// (max 120 m per leg so long straight legs still follow gentle road bends).
export function smooth(nav, pts, map = null) {
  if (pts.length < 3) return pts.map(([x, z]) => ({ x, z }));
  const out = [{ x: pts[0][0], z: pts[0][1] }];
  let i = 0;
  while (i < pts.length - 1) {
    let j = i + 1;
    for (let k = i + 2; k < pts.length; k++) {
      if (hyp(pts[k][0] - pts[i][0], pts[k][1] - pts[i][1]) > 120) break;
      if (segClear(nav, pts[i][0], pts[i][1], pts[k][0], pts[k][1], 2.6, map)) j = k;
      else if (k - j > 4) break; // gave up looking further along this stretch
    }
    out.push({ x: pts[j][0], z: pts[j][1] });
    i = j;
  }
  return out;
}

// Plan from (ax, az) to (bx, bz) on the overlay nav; returns { pts:[{x,z}], raw } or null.
export function plan(navOverlay, baseNav, ax, az, bx, bz, map = null) {
  if (!navOverlay) return { pts: [{ x: ax, z: az }, { x: bx, z: bz }], raw: [] };
  const raw = findPath(navOverlay, ax, az, bx, bz, 60000);
  if (!raw || !raw.length) return null;
  const pts = smooth(baseNav, raw, map);
  // start from where we are and end on the exact goal (when clear of the last cell centre)
  pts[0] = { x: ax, z: az };
  const last = pts[pts.length - 1];
  if (hyp(last.x - bx, last.z - bz) < 12 && passable(baseNav, bx, bz)) { last.x = bx; last.z = bz; }
  return { pts, raw };
}

// Follower state on a path: returns the carrot point `look` metres ahead of the tank's
// projection on the route, and the remaining distance.
export class Follower {
  constructor() { this.pts = null; this.i = 1; }
  set(pts) { this.pts = pts; this.i = 1; }
  clear() { this.pts = null; }
  get done() { return !this.pts || this.i >= this.pts.length; }
  // (x, z) = tank position. Returns { x, z, remain } or null when there is no path.
  carrot(x, z, look, out) {
    const P = this.pts;
    if (!P) return null;
    const n = P.length;
    // advance past waypoints we reached or passed
    while (this.i < n - 1) {
      const a = P[this.i - 1], b = P[this.i], ex = b.x - a.x, ez = b.z - a.z;
      const L2 = ex * ex + ez * ez || 1, k = ((x - a.x) * ex + (z - a.z) * ez) / L2;
      if (k >= 1 || hyp(b.x - x, b.z - z) < 5) this.i++; else break;
    }
    const a = P[this.i - 1], b = P[Math.min(this.i, n - 1)];
    const ex = b.x - a.x, ez = b.z - a.z, L = Math.sqrt(ex * ex + ez * ez) || 1;
    let k = Math.max(0, Math.min(1, ((x - a.x) * ex + (z - a.z) * ez) / (L * L)));
    // walk `look` metres from the projection
    let px = a.x + ex * k, pz = a.z + ez * k, left = look, seg = this.i;
    // lateral error pulls the carrot closer so we rejoin the line
    const off = hyp(x - px, z - pz);
    left = Math.max(4, look - off * 0.5);
    let remain = 0;
    let cx = px, cz = pz, placed = false;
    for (let s = seg; s < n; s++) {
      const qx = P[s].x, qz = P[s].z, d = hyp(qx - px, qz - pz);
      if (!placed) {
        if (d >= left) { cx = px + (qx - px) * left / d; cz = pz + (qz - pz) * left / d; placed = true; remain += d; }
        else { left -= d; cx = qx; cz = qz; remain += d; }
      } else remain += d;
      px = qx; pz = qz;
    }
    out.x = cx; out.z = cz; out.remain = remain;
    return out;
  }
}
