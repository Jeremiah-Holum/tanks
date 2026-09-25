// MapBuilder: the shared toolkit the map generators use. Terrain sculpting on the height grid,
// roads and rivers (with their own flattening / carving), ground painting, an occupancy grid
// so props don't overlap, prop placement helpers, symmetry (mirror / rotate) for fairness,
// and finish(): spawns, points, lanes, nav and the MapData object.
import { makeRng, makeNoise, hashSeed, clamp, lerp, smooth, segDist, resample, spline, polyLength, inPoly } from './noise.js';
import { GROUND } from './objects.js';
import { terrainHeightAt, heightAt, slopeAt, objectsNear, buildQueryIndex } from './query.js';
import { OBJECT_KINDS } from './objects.js';
import { buildNav, findPath, simplify } from './nav.js';

const OCC = 2;               // occupancy grid cell, metres
export const FREE = 0, VEG = 1, KEEP = 2, SOLID = 3;

export class MapBuilder {
  constructor({ id, name, seed = 1, size = 1000, res = 257, sym = 'mirror', play = 50 }) {
    this.id = id; this.name = name; this.seed = seed;
    this.size = size; this.res = res; this.cell = size / (res - 1);
    this.H = new Float32Array(res * res); this.G = new Uint8Array(res * res);
    this.rng = makeRng(hashSeed(seed, 1)); this.noise = makeNoise(hashSeed(seed, 2)); this.noise2 = makeNoise(hashSeed(seed, 3));
    this.sym = sym; this.play = { min: play, max: size - play };
    this.objects = []; this.roads = []; this.rivers = []; this.fields = []; this.areas = [];
    this.water = null; this.bases = []; this.spawnDefs = []; this.pointDefs = []; this.laneDefs = [];
    this.on = size / OCC; this.occ = new Uint8Array(this.on * this.on);
    this._best = new Float32Array(res * res).fill(Infinity); this._bestS = new Float32Array(res * res);
  }

  get heights() { return this.H; }
  slope(x, z) {
    const e = 2, gx = (terrainHeightAt(this, x + e, z) - terrainHeightAt(this, x - e, z)) / (2 * e), gz = (terrainHeightAt(this, x, z + e) - terrainHeightAt(this, x, z - e)) / (2 * e);
    return Math.atan(Math.hypot(gx, gz)) * 180 / Math.PI;
  }
  // Full symmetric polyline from a team-0 half that ends on the mirror axis / centre.
  symLine(half) { const m = this.Mpoly(half).reverse(); return half.concat(m.slice(1)); }

  // ------------------------------------------------ symmetry
  // M maps a team-0 point to its team-1 twin; My maps a yaw.
  M([x, z]) { return this.sym === 'rotate' ? [this.size - x, this.size - z] : [x, this.size - z]; }
  My(y) { return this.sym === 'rotate' ? y + Math.PI : Math.PI - y; }
  Mpoly(poly) { return poly.map((p) => this.M(p)); }
  // Run fn(T) twice: with the identity and with the mirror transform. T has p, yaw, poly, twin.
  both(fn) {
    fn({ p: (q) => q.slice(), yaw: (y) => y, poly: (pl) => pl.map((q) => q.slice()), twin: 0 });
    fn({ p: (q) => this.M(q), yaw: (y) => this.My(y), poly: (pl) => this.Mpoly(pl), twin: 1 });
  }

  // ------------------------------------------------ terrain
  each(fn) { const { res, cell } = this; for (let j = 0, k = 0; j < res; j++) for (let i = 0; i < res; i++, k++) fn(k, i * cell, j * cell); }
  // Symmetric fbm: average of the noise and its mirror, rescaled.
  base(h0, amp, scale, oct = 4) {
    const n = this.noise;
    this.each((k, x, z) => { const [mx, mz] = this.M([x, z]); this.H[k] = h0 + amp * 1.4 * 0.5 * (n.fbm(x, z, scale, oct) + n.fbm(mx, mz, scale, oct)); });
  }
  // Small asymmetric detail (keeps the mirror from looking artificial).
  detail(amp, scale, oct = 3) { const n = this.noise2; this.each((k, x, z) => { this.H[k] += amp * n.fbm(x, z, scale, oct); }); }
  add(fn) { this.each((k, x, z) => { this.H[k] += fn(x, z, this.H[k]); }); }
  // Elliptic cosine bump; pow < 1 gives a plateau-ish top, > 1 a peak.
  bump(x, z, rx, rz, h, yaw = 0, pow = 1) {
    const c = Math.cos(yaw), s = Math.sin(yaw), R = Math.max(rx, rz);
    const { res, cell, H } = this;
    const i0 = Math.max(0, Math.floor((x - R) / cell)), i1 = Math.min(res - 1, Math.ceil((x + R) / cell));
    const j0 = Math.max(0, Math.floor((z - R) / cell)), j1 = Math.min(res - 1, Math.ceil((z + R) / cell));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const dx = i * cell - x, dz = j * cell - z;
      const lx = (dx * c - dz * s) / rx, lz = (dx * s + dz * c) / rz, d = Math.hypot(lx, lz);
      if (d >= 1) continue;
      H[j * res + i] += h * Math.pow(0.5 + 0.5 * Math.cos(Math.PI * d), pow);
    }
  }
  bumpBoth(x, z, rx, rz, h, yaw = 0, pow = 1) { this.both((T) => { const [a, b] = T.p([x, z]); this.bump(a, b, rx, rz, h, T.yaw(yaw), pow); }); }

  // Visit every height sample within maxD of a polyline: cb(k, d, s, total) with the
  // nearest distance d and the along-line distance s of the nearest point.
  polyField(poly, maxD, cb) {
    const { res, cell } = this, best = this._best, bs = this._bestS, touched = [];
    let s0 = 0;
    for (let a = 1; a < poly.length; a++) {
      const [ax, az] = poly[a - 1], [bx, bz] = poly[a], L = Math.hypot(bx - ax, bz - az);
      const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - maxD) / cell)), i1 = Math.min(res - 1, Math.ceil((Math.max(ax, bx) + maxD) / cell));
      const j0 = Math.max(0, Math.floor((Math.min(az, bz) - maxD) / cell)), j1 = Math.min(res - 1, Math.ceil((Math.max(az, bz) + maxD) / cell));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const { d, u } = segDist(i * cell, j * cell, ax, az, bx, bz);
        if (d > maxD) continue;
        const k = j * res + i;
        if (d < best[k]) { if (best[k] === Infinity) touched.push(k); best[k] = d; bs[k] = s0 + u * L; }
      }
      s0 += L;
    }
    for (const k of touched) { cb(k, best[k], bs[k], s0); best[k] = Infinity; }
  }

  // Ridge / embankment along a polyline: flat-ish top of half-width w, falloff over fall.
  ridge(poly, w, fall, h, hFn = null) {
    const H = this.H;
    this.polyField(poly, w + fall, (k, d, s, L) => {
      const f = d <= w ? 1 : 0.5 + 0.5 * Math.cos(Math.PI * (d - w) / fall);
      H[k] += (hFn ? hFn(s, L) : h) * f;
    });
  }
  ridgeBoth(poly, w, fall, h, hFn) { this.both((T) => this.ridge(T.poly(poly), w, fall, h, hFn)); }
  // Carve a trench (gully) along a polyline, depth dFn(s,L) or constant.
  trench(poly, w, fall, depth, dFn = null) { this.ridge(poly, w, fall, -depth, dFn ? (s, L) => -dFn(s, L) : null); }

  // Pull heights in a circle towards a level (default: the mean inside).
  flatten(x, z, r, blend, level = null, strength = 1) {
    const { res, cell, H } = this, R = r + blend;
    const i0 = Math.max(0, Math.floor((x - R) / cell)), i1 = Math.min(res - 1, Math.ceil((x + R) / cell));
    const j0 = Math.max(0, Math.floor((z - R) / cell)), j1 = Math.min(res - 1, Math.ceil((z + R) / cell));
    if (level === null) {
      let s = 0, n = 0;
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (Math.hypot(i * cell - x, j * cell - z) <= r) { s += H[j * res + i]; n++; }
      level = n ? s / n : terrainHeightAt(this, x, z);
    }
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const d = Math.hypot(i * cell - x, j * cell - z);
      if (d > R) continue;
      const t = strength * (1 - smooth(r, R, d)), k = j * res + i;
      H[k] = lerp(H[k], level, t);
    }
    return level;
  }

  // Roads: records the road (for rendering and ground) and grades the terrain along it.
  road(ctrl, width = 7, { kind = 'road', grade = true, blend = 10, win = 60, curve = true, bridgeAt = null } = {}) {
    const path = curve && ctrl.length > 2 ? spline(ctrl, 6) : ctrl.map((p) => p.slice());
    const pts = resample(path, 4);
    if (grade) {
      // smoothed height profile along the road
      let prof = pts.map(([x, z]) => terrainHeightAt(this, x, z));
      const n = Math.max(1, Math.round(win / 8));
      for (let pass = 0; pass < 3; pass++) {
        const q = prof.slice();
        for (let i = 0; i < prof.length; i++) {
          let s = 0, c = 0;
          for (let j = Math.max(0, i - n); j <= Math.min(prof.length - 1, i + n); j++) { s += q[j]; c++; }
          prof[i] = s / c;
        }
      }
      if (this.water) prof = prof.map((h) => Math.max(h, this.water.level + 0.4)); // roads stay dry unless forded explicitly
      if (bridgeAt) prof = prof.map((h, i) => bridgeAt(i * 4, h));
      const hw = width / 2 + 1;
      const H = this.H;
      this.polyField(pts, hw + blend, (k, d, s) => {
        const f = s / 4, i = Math.min(prof.length - 2, Math.floor(f)), u = f - i;
        const target = lerp(prof[i], prof[i + 1] ?? prof[i], u);
        const t = d <= hw ? 1 : 1 - smooth(hw, hw + blend, d);
        H[k] = lerp(H[k], target, t);
      });
    }
    const r = { kind, width, path: simplify(pts, 0.6).map(([x, z]) => [Math.round(x * 10) / 10, Math.round(z * 10) / 10]) };
    this.roads.push(r);
    return r;
  }
  roadBoth(ctrl, width, opts) { const out = []; this.both((T) => out.push(this.road(T.poly(ctrl), width, opts))); return out; }

  // River: carve a channel. depthFn(s, L) → bed depth below the water level at the centre.
  river(ctrl, halfW, bankW, depthFn, { curve = true } = {}) {
    const path = curve ? spline(ctrl, 8) : ctrl;
    const pts = resample(path, 5);
    const lvl = this.water.level, H = this.H;
    this.polyField(pts, halfW + bankW, (k, d, s, L) => {
      const depth = depthFn(s, L);
      let target;
      if (d <= halfW) { const u = d / halfW; target = lvl - 0.25 - (depth - 0.25) * (1 - u * u); }
      else target = lerp(lvl - 0.25, H[k], smooth(halfW, halfW + bankW, d));
      if (target < H[k]) H[k] = target;
    });
    this.rivers.push({ path: pts.map(([x, z]) => [Math.round(x * 10) / 10, Math.round(z * 10) / 10]), halfW });
  }

  // Outer boundary: terrain rises beyond the playable square.
  rim(h = 18, amp = 6) {
    const n = this.noise2, { min, max } = this.play;
    this.add((x, z) => {
      const o = Math.max(min - x, x - max, min - z, z - max, -8) + 8;
      if (o <= 0) return 0;
      return (h + amp * n.fbm(x, z, 90, 3)) * smooth(0, 55, o) + 0.15 * o * (1 + n.fbm(z, x, 60, 2));
    });
  }

  finalizeHeights(minH = 0.5) { const H = this.H; for (let k = 0; k < H.length; k++) if (H[k] < minH) H[k] = minH; }

  // ------------------------------------------------ ground
  paint(g) { this.G.fill(g); }
  paintWhere(fn, g) { this.each((k, x, z) => { if (fn(x, z, k)) this.G[k] = g; }); }
  paintPoly(poly, g, maxD) { this.polyField(poly, maxD, (k) => { this.G[k] = g; }); }
  paintPolygon(poly, g) {
    const { res, cell } = this; let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of poly) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    for (let j = Math.max(0, Math.floor(z0 / cell)); j <= Math.min(res - 1, Math.ceil(z1 / cell)); j++)
      for (let i = Math.max(0, Math.floor(x0 / cell)); i <= Math.min(res - 1, Math.ceil(x1 / cell)); i++)
        if (inPoly(i * cell, j * cell, poly)) this.G[j * res + i] = g;
  }
  paintCircle(x, z, r, g, noiseAmt = 0) {
    const n = this.noise2;
    this.paintWhere((px, pz) => Math.hypot(px - x, pz - z) < r * (1 + noiseAmt * n(px / 20, pz / 20)), g);
  }
  // Slope-driven rock, water depth → SHALLOW/DEEP, wet banks → MUD/SAND. Roads re-painted last.
  paintNatural({ rockSlope = 32, bank = GROUND.MUD, rockG = GROUND.ROCK } = {}) {
    const { res, cell, H, G } = this;
    for (let j = 1; j < res - 1; j++) for (let i = 1; i < res - 1; i++) {
      const k = j * res + i;
      const gx = (H[k + 1] - H[k - 1]) / (2 * cell), gz = (H[k + res] - H[k - res]) / (2 * cell);
      const deg = Math.atan(Math.hypot(gx, gz)) * 180 / Math.PI;
      if (deg > rockSlope + 4 * this.noise2(i * 0.3, j * 0.3)) G[k] = rockG;
    }
    if (this.water) {
      const lvl = this.water.level;
      for (let k = 0; k < H.length; k++) {
        const d = lvl - H[k];
        if (d > 1.1) G[k] = GROUND.DEEP; else if (d > 0) G[k] = GROUND.SHALLOW; else if (d > -0.7 && G[k] !== GROUND.ROAD) G[k] = bank;
      }
    }
  }
  paintRoads() {
    for (const r of this.roads) this.paintPoly(r.path, r.kind === 'track' ? GROUND.DIRT : GROUND.ROAD, r.width / 2 + 0.6);
  }
  // Rectangular field (oriented), recorded in map.fields for the renderer.
  field(x, z, w, d, yaw, crop = 'wheat', g = GROUND.FIELD) {
    const c = Math.cos(yaw), s = Math.sin(yaw), hw = w / 2, hd = d / 2;
    const poly = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([lx, lz]) => [x + lx * c + lz * s, z - lx * s + lz * c]);
    this.paintPolygon(poly, g);
    const f = { x, z, w, d, yaw, crop, poly: poly.map(([a, b]) => [Math.round(a * 10) / 10, Math.round(b * 10) / 10]) };
    this.fields.push(f);
    return f;
  }

  // ------------------------------------------------ occupancy
  _occRange(x, z, r) {
    const n = this.on;
    return [Math.max(0, Math.floor((x - r) / OCC)), Math.min(n - 1, Math.floor((x + r) / OCC)), Math.max(0, Math.floor((z - r) / OCC)), Math.min(n - 1, Math.floor((z + r) / OCC))];
  }
  free(x, z, r, maxLevel = FREE) {
    if (x < 1 || z < 1 || x > this.size - 1 || z > this.size - 1) return false;
    const [i0, i1, j0, j1] = this._occRange(x, z, r), n = this.on;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const dx = (i + 0.5) * OCC - x, dz = (j + 0.5) * OCC - z;
      if (dx * dx + dz * dz <= (r + 1) * (r + 1) && this.occ[j * n + i] > maxLevel) return false;
    }
    return true;
  }
  mark(x, z, r, level) {
    const [i0, i1, j0, j1] = this._occRange(x, z, r), n = this.on;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const dx = (i + 0.5) * OCC - x, dz = (j + 0.5) * OCC - z, k = j * n + i;
      if (dx * dx + dz * dz <= r * r && this.occ[k] < level) this.occ[k] = level;
    }
  }
  // Oriented rectangle (half-extents hx, hz, local x = (cos yaw, -sin yaw)) plus margin.
  rectFree(x, z, yaw, hx, hz, margin = 1, maxLevel = VEG) {
    const c = Math.cos(yaw), s = Math.sin(yaw), R = Math.hypot(hx, hz) + margin;
    if (x - R < this.play.min - 40 || z - R < this.play.min - 40 || x + R > this.play.max + 40 || z + R > this.play.max + 40) return false;
    const [i0, i1, j0, j1] = this._occRange(x, z, R), n = this.on;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const dx = (i + 0.5) * OCC - x, dz = (j + 0.5) * OCC - z;
      const lx = dx * c - dz * s, lz = dx * s + dz * c;
      if (Math.abs(lx) <= hx + margin && Math.abs(lz) <= hz + margin && this.occ[j * n + i] > maxLevel) return false;
    }
    return true;
  }
  markRect(x, z, yaw, hx, hz, margin, level) {
    const c = Math.cos(yaw), s = Math.sin(yaw), R = Math.hypot(hx, hz) + margin;
    const [i0, i1, j0, j1] = this._occRange(x, z, R), n = this.on;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const dx = (i + 0.5) * OCC - x, dz = (j + 0.5) * OCC - z;
      const lx = dx * c - dz * s, lz = dx * s + dz * c, k = j * n + i;
      if (Math.abs(lx) <= hx + margin && Math.abs(lz) <= hz + margin && this.occ[k] < level) this.occ[k] = level;
    }
  }
  markPoly(poly, r, level) { for (const [x, z] of resample(poly, Math.max(1, r * 0.7))) this.mark(x, z, r, level); }
  markRoads(extra = 1.5) { for (const r of this.roads) this.markPoly(r.path, r.width / 2 + extra, KEEP); }

  // ------------------------------------------------ props
  // Terrain-following base height: min over the footprint for solids (sunk so no gaps).
  baseY(x, z, yaw, hx, hz) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    let m = terrainHeightAt(this, x, z);
    for (const [a, b] of [[-1, -1], [1, -1], [-1, 1], [1, 1], [0, -1], [0, 1], [-1, 0], [1, 0]]) {
      const lx = a * hx, lz = b * hz;
      m = Math.min(m, terrainHeightAt(this, x + lx * c + lz * s, z - lx * s + lz * c));
    }
    return m;
  }
  obj(kind, x, z, yaw, s, variant = 0, extra = {}) {
    const k = OBJECT_KINDS[kind];
    let y;
    if (extra.y !== undefined) y = extra.y;
    else if (kind === 'rock') y = terrainHeightAt(this, x, z) - s[1] * 0.25;
    else if (k.navBlock || kind === 'fence' || kind === 'hedge' || kind === 'tank_trap') y = this.baseY(x, z, yaw, s[0], s[2]) - 0.15;
    else y = terrainHeightAt(this, x, z) - 0.1;
    delete extra.y;
    const o = { id: 0, kind, x: r2(x), y: r2(y), z: r2(z), yaw: Math.round(yaw * 1000) / 1000, s: s.map(r2), variant, ...extra };
    this.objects.push(o);
    return o;
  }
  // Building with its long side along local x. Marks occupancy.
  building(kind, x, z, yaw, w, d, h, variant = 0, margin = 1.5, force = false) {
    if (!force && !this.rectFree(x, z, yaw, w / 2, d / 2, margin, VEG)) return null;
    this.markRect(x, z, yaw, w / 2, d / 2, margin + 1, SOLID);
    return this.obj(kind, x, z, yaw, [w / 2, h / 2, d / 2], variant);
  }
  // A building and its mirror twin, both or neither.
  buildingBoth(kind, x, z, yaw, w, d, h, variant = 0, margin = 1.5) {
    const [mx, mz] = this.M([x, z]), my = this.My(yaw);
    if (Math.hypot(mx - x, mz - z) < Math.hypot(w, d)) return this.building(kind, x, z, yaw, w, d, h, variant, margin);
    if (!this.rectFree(x, z, yaw, w / 2, d / 2, margin, VEG) || !this.rectFree(mx, mz, my, w / 2, d / 2, margin, VEG)) return null;
    this.building(kind, x, z, yaw, w, d, h, variant, margin, true);
    return this.building(kind, mx, mz, my, w, d, h, variant, margin, true);
  }
  // Houses along one side (+1 left of travel, -1 right) of a polyline: returns a plan.
  streetPlan(path, side, { from = 0, to = Infinity, spacing = [14, 20], depth = [8, 11], width = [9, 14], height = [6.5, 9], setback = 4.5, gap = 0.12, kinds = ['house'] } = {}) {
    const pts = resample(path, 1), r = this.rng, plan = [];
    let s = from + r.range(0, 4);
    const L = Math.min(to, pts.length - 2);
    while (s < L) {
      const w = r.range(...width), d = r.range(...depth), h = r.range(...height);
      const i = Math.min(pts.length - 2, Math.floor(s + w / 2)), [ax, az] = pts[i], [bx, bz] = pts[i + 1];
      const tl = Math.hypot(bx - ax, bz - az) || 1, tx = (bx - ax) / tl, tz = (bz - az) / tl;
      const nx = -tz * side, nz = tx * side, off = setback + d / 2;
      if (r() > gap && s + w <= L) plan.push({ kind: r.pick(kinds), x: ax + nx * off, z: az + nz * off, yaw: Math.atan2(-tz, tx), w, d, h, variant: r.int(0, 3), nx, nz });
      s += w + r.range(spacing[0] - 10, spacing[1] - 10) + 2;
    }
    return plan;
  }
  // Place a plan (and its mirror). Gardens: a wall/fence behind some houses.
  placePlan(plan, { mirror = true, garden = 0.5 } = {}) {
    let n = 0;
    for (const p of plan) {
      const o = mirror ? this.buildingBoth(p.kind, p.x, p.z, p.yaw, p.w, p.d, p.h, p.variant) : this.building(p.kind, p.x, p.z, p.yaw, p.w, p.d, p.h, p.variant);
      if (!o) continue;
      n++;
      if (this.rng() < garden) {
        // garden wall/fence behind the house, parallel to the street
        const back = p.d / 2 + 7, c = Math.cos(p.yaw), s = Math.sin(p.yaw);
        const ex = c * (p.w / 2 + 2), ez = -s * (p.w / 2 + 2);
        const gx = p.x + p.nx * back, gz = p.z + p.nz * back;
        const kind = this.rng() < 0.5 ? 'wall' : 'fence';
        const a = [gx - ex, gz - ez], b = [gx + ex, gz + ez];
        const th = kind === 'wall' ? 0.6 : 0.15, hh = kind === 'wall' ? 1.3 : 1.2;
        if (mirror) {
          const [ma, mb] = [this.M(a), this.M(b)];
          if (this.segment(kind, a, b, th, hh, 0, SOLID, true)) this.segment(kind, ma, mb, th, hh, 0, SOLID, false);
        } else this.segment(kind, a, b, th, hh, 0, SOLID, true);
      }
    }
    return n;
  }

  // Straight wall / fence / hedge segment from a to b.
  segment(kind, a, b, thick, height, variant = 0, level = SOLID, check = false) {
    const [ax, az] = a, [bx, bz] = b, L = Math.hypot(bx - ax, bz - az);
    if (L < 0.5) return null;
    const x = (ax + bx) / 2, z = (az + bz) / 2, yaw = Math.atan2(-(bz - az), bx - ax);
    if (check && !this.rectFree(x, z, yaw, L / 2, thick / 2, 0.5, VEG)) return null;
    this.markRect(x, z, yaw, L / 2, thick / 2, 0.5, level);
    return this.obj(kind, x, z, yaw, [L / 2, height / 2, thick / 2], variant);
  }
  // Split a polyline into straight segments no longer than maxLen, with optional gaps.
  line(kind, poly, thick, height, { maxLen = 12, gapEvery = 0, gap = 8, variant = 0, level = SOLID, check = true, jitter = 0 } = {}) {
    const pts = resample(poly, maxLen);
    let run = 0, n = 0;
    for (let i = 1; i < pts.length; i++) {
      run += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      if (gapEvery && run > gapEvery) { run = -gap; continue; }
      if (run < 0) continue;
      const h = height * (1 + jitter * (this.rng() - 0.5));
      if (this.segment(kind, pts[i - 1], pts[i], thick, h, variant, level, check)) n++;
    }
    return n;
  }
  tree(x, z, kind, scale = 1, check = true) {
    if (check && !this.free(x, z, 2.2, FREE)) return null;
    this.mark(x, z, 1.6, VEG);
    const r = this.rng;
    const h = (kind === 'pine' ? r.range(13, 20) : r.range(10, 16)) * scale, cr = (kind === 'pine' ? r.range(2.6, 3.6) : r.range(3.2, 4.8)) * scale;
    return this.obj(kind, x, z, r.range(0, 6.283), [cr, h / 2, cr], r.int(0, 3));
  }
  bush(x, z, scale = 1, check = true) {
    const r = this.rng, w = r.range(1.6, 2.6) * scale, h = r.range(1.3, 2.2) * scale;
    if (check && !this.free(x, z, w * 0.8, VEG)) return null;
    this.mark(x, z, w, VEG);
    return this.obj('bush', x, z, r.range(0, 6.283), [w, h / 2, w * r.range(0.7, 1.0)], r.int(0, 3));
  }
  rock(x, z, size = 1, check = true) {
    const r = this.rng, a = r.range(1.2, 2.6) * size, b = r.range(0.9, 2.0) * size, c = r.range(1.0, 2.4) * size;
    if (check && !this.free(x, z, Math.max(a, c) + 0.5, VEG)) return null;
    this.mark(x, z, Math.max(a, c) + 0.8, SOLID);
    return this.obj('rock', x, z, r.range(0, 6.283), [a, b, c], r.int(0, 3));
  }
  // Scatter within a region test fn(x,z) using a jittered grid; density = keep probability,
  // mask(x,z) → 0..1 multiplies it. place(x,z) returns truthy when it placed something.
  scatter(x0, z0, x1, z1, spacing, test, place, { density = 1, mask = null, max = Infinity } = {}) {
    let n = 0;
    for (let z = z0; z <= z1; z += spacing) for (let x = x0; x <= x1; x += spacing) {
      if (n >= max) return n;
      const px = x + (this.rng() - 0.5) * spacing * 0.9, pz = z + (this.rng() - 0.5) * spacing * 0.9;
      if (!test(px, pz)) continue;
      const p = density * (mask ? mask(px, pz) : 1);
      if (this.rng() >= p) continue;
      if (place(px, pz)) n++;
    }
    return n;
  }
  forest(cx, cz, r, spacing, kinds, { density = 0.8, rough = 0.35, bushes = 0.15, edgeBush = true } = {}) {
    const n = this.noise2; let c = 0;
    c += this.scatter(cx - r * 1.3, cz - r * 1.3, cx + r * 1.3, cz + r * 1.3, spacing,
      (x, z) => Math.hypot(x - cx, z - cz) < r * (1 + rough * n(x / 45, z / 45)),
      (x, z) => {
        if (this.rng() < bushes) return this.bush(x, z, 1.1);
        return this.tree(x, z, this.rng.pick(kinds), this.rng.range(0.85, 1.15));
      }, { density });
    if (edgeBush) for (let a = 0; a < 6.283; a += 14 / r) {
      const rr = r * (1 + rough * n((cx + Math.cos(a) * r) / 45, (cz + Math.sin(a) * r) / 45)) + 3;
      if (this.rng() < 0.55) c += this.bush(cx + Math.cos(a) * rr, cz + Math.sin(a) * rr, 1) ? 1 : 0;
    }
    return c;
  }

  // ------------------------------------------------ battle layout
  base(team, x, z) { this.bases.push({ team, x, z, r: 45 }); }
  // spawn block centre for team 0; mirrored for team 1
  spawnZone(x, z, yaw, { cols = 5, rows = 3, dx = 14, dz = 15 } = {}) {
    this.spawnDefs = [{ x, z, yaw, cols, rows, dx, dz }];
    this.both((T) => { const [a, b] = T.p([x, z]); this.mark(a, b, Math.max(cols * dx, rows * dz) * 0.62, KEEP); });
  }
  // point defs for team 0 (mirrored for team 1 unless team === null and on the axis)
  point(kind, x, z, lane, yaw = null, opts = {}) { this.pointDefs.push({ kind, x, z, lane, yaw, ...opts }); }
  lane(name, waypoints) { this.laneDefs.push({ name, waypoints }); }

  // Sniper / bush / scout points get bushes in front (towards yaw) or around.
  dressPoints(pts) {
    for (const p of pts) {
      const fx = Math.sin(p.yaw ?? 0), fz = Math.cos(p.yaw ?? 0), lx = fz, lz = -fx;
      if (p.kind === 'sniper' || p.kind === 'scout') {
        const ahead = p.kind === 'sniper' ? 9 : 5;
        for (const o of [-3.5, 0, 3.5]) this.bush(p.x + fx * (ahead + this.rng() * 2) + lx * o, p.z + fz * (ahead + this.rng() * 2) + lz * o, 1.1, false);
      } else if (p.kind === 'bush') {
        for (const [a, o] of [[0.5, 0], [2.5, -2.5], [2.5, 2.5], [-2, 3], [-2, -3]]) this.bush(p.x + fx * a + lx * o, p.z + fz * a + lz * o, 1.15, false);
      }
    }
  }

  // Find a hull-down spot near (x, z) facing yaw: ground ~1–2.2 m higher 5–8 m ahead,
  // and falling away beyond the crest (so the gun sees over it).
  hulldownSnap(x, z, yaw, radius = 30) {
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    let best = null, bs = -Infinity;
    for (let dz = -radius; dz <= radius; dz += 3) for (let dx = -radius; dx <= radius; dx += 3) {
      const px = x + dx, pz = z + dz;
      if (Math.hypot(dx, dz) > radius) continue;
      const h0 = terrainHeightAt(this, px, pz);
      const crest = Math.max(terrainHeightAt(this, px + fx * 6, pz + fz * 6), terrainHeightAt(this, px + fx * 8, pz + fz * 8));
      const beyond = terrainHeightAt(this, px + fx * 30, pz + fz * 30);
      const rise = crest - h0;
      if (rise < 0.8 || rise > 2.4) continue;
      if (this.slope(px, pz) > 14) continue;
      const score = -Math.abs(rise - 1.5) * 2 + Math.min(4, crest - beyond) - Math.hypot(dx, dz) / radius;
      if (crest - beyond < 0.5) continue;
      if (score > bs) { bs = score; best = [px, pz]; }
    }
    return best;
  }

  // ------------------------------------------------ finish
  finish({ theme, blurb = '' }) {
    const size = this.size;
    this.objects.forEach((o, i) => { o.id = i; });
    const map = {
      id: this.id, name: this.name, size, res: this.res, cell: this.cell,
      heights: this.H, ground: this.G, water: this.water,
      objects: this.objects, bases: this.bases, spawns: [[], []], points: [], lanes: [],
      nav: null, theme, play: { ...this.play }, roads: this.roads, rivers: this.rivers, fields: this.fields, blurb,
      seed: this.seed,
    };
    buildQueryIndex(map);
    map.nav = buildNav(map);
    const nav = map.nav;
    const passable = (x, z) => { const c = Math.floor(x / nav.cell), r = Math.floor(z / nav.cell); return c >= 0 && r >= 0 && c < nav.cols && r < nav.rows && isFinite(nav.cost[r * nav.cols + c]) && nav.cost[r * nav.cols + c] < 4; };
    const clearOf = (x, z, r) => { let ok = true; objectsNear(map, x, z, r, (o) => { const k = OBJECT_KINDS[o.kind]; if (k.solidTank || k.solidShell) { ok = false; return true; } return false; }); return ok; };
    const good = (x, z, r = 4.5) => passable(x, z) && slopeAt(map, x, z) < 16 && clearOf(x, z, r) && x > this.play.min + 10 && x < this.play.max - 10 && z > this.play.min + 10 && z < this.play.max - 10;
    const nudge = (x, z, r = 4.5, maxR = 30) => {
      if (good(x, z, r)) return [x, z];
      for (let rad = 2; rad <= maxR; rad += 2) for (let a = 0; a < 16; a++) {
        const px = x + Math.cos(a * Math.PI / 8) * rad, pz = z + Math.sin(a * Math.PI / 8) * rad;
        if (good(px, pz, r)) return [px, pz];
      }
      return null;
    };
    // spawns
    const sd = this.spawnDefs[0];
    this.both((T) => {
      const [cx, cz] = T.p([sd.x, sd.z]), yaw = T.yaw(sd.yaw), fx = Math.sin(yaw), fz = Math.cos(yaw), lx = fz, lz = -fx;
      const list = map.spawns[T.twin], taken = [];
      for (let r = 0; r < sd.rows; r++) for (let c = 0; c < sd.cols; c++) {
        const o = (c - (sd.cols - 1) / 2) * sd.dx + (r % 2 ? sd.dx / 2 : 0), b = -(r - (sd.rows - 1) / 2) * sd.dz;
        let x = cx + lx * o + fx * b, z = cz + lz * o + fz * b;
        let p = null;
        for (let rad = 0; rad <= 40 && !p; rad += 2) for (let a = 0; a < (rad ? 16 : 1) && !p; a++) {
          const px = x + Math.cos(a * Math.PI / 8) * rad, pz = z + Math.sin(a * Math.PI / 8) * rad;
          if (good(px, pz, 5) && taken.every(([tx, tz]) => Math.hypot(tx - px, tz - pz) >= 11)) p = [px, pz];
        }
        if (!p) p = [x, z];
        taken.push(p);
        list.push({ x: r2(p[0]), z: r2(p[1]), yaw: Math.round(yaw * 1000) / 1000 });
      }
    });
    // points
    const pts = [];
    for (const d of this.pointDefs) {
      const variants = d.team === null ? [[0, (q) => q, (y) => y]] : [[0, (q) => q, (y) => y], [1, (q) => this.M(q), (y) => this.My(y)]];
      for (const [team, P, Y] of variants) {
        let [x, z] = P([d.x, d.z]);
        const yaw = d.yaw === null ? null : Y(d.yaw);
        if (d.kind === 'hulldown' && yaw !== null) { const s = this.hulldownSnap(x, z, yaw, d.snap ?? 30); if (s) [x, z] = s; }
        const n = nudge(x, z, d.kind === 'bush' || d.kind === 'sniper' ? 3 : 4, 30);
        if (!n) continue;
        pts.push({ kind: d.kind, x: r2(n[0]), z: r2(n[1]), team: d.team === null ? null : team, lane: d.lane, ...(yaw !== null ? { yaw: Math.round(yaw * 1000) / 1000 } : {}) });
      }
    }
    map.points = pts;
    // lanes: A* through the waypoints, simplified
    for (const L of this.laneDefs) {
      const wps = L.waypoints;
      let path = [];
      for (let i = 1; i < wps.length; i++) {
        const seg = findPath(nav, wps[i - 1][0], wps[i - 1][1], wps[i][0], wps[i][1]);
        if (!seg) { path = null; break; }
        path.push(...(path.length ? seg.slice(1) : seg));
      }
      if (path) map.lanes.push({ name: L.name, path: simplify(path, 5).map(([x, z]) => [r2(x), r2(z)]) });
      else map.lanes.push({ name: L.name, path: wps.map((p) => p.slice()), broken: true });
    }
    return map;
  }

  // Bushes for points must exist before nav: call with the raw point defs (team 0 + mirror).
  dressPointDefs() {
    const all = [];
    for (const d of this.pointDefs) {
      if (d.dress === false) continue;
      all.push({ kind: d.kind, x: d.x, z: d.z, yaw: d.yaw });
      if (d.team !== null) { const [x, z] = this.M([d.x, d.z]); all.push({ kind: d.kind, x, z, yaw: d.yaw === null ? null : this.My(d.yaw) }); }
    }
    this.dressPoints(all);
  }
}

const r2 = (v) => Math.round(v * 100) / 100;
export { r2, smooth, lerp, clamp, polyLength, resample, spline, inPoly };
