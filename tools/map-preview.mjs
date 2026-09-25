// Top-down PNG previews of the maps (no browser): hill-shaded heights with 5 m contours,
// ground types, props (true collision footprints), bases, spawns, AI points, lanes and the
// red boundary. Also a nav-cost image. Usage:
//   node tools/map-preview.mjs [mapId...] [--out dir] [--scale 1] [--nav]
// Writes <out>/<id>.png (and <id>-nav.png with --nav). Default out: docs/notes/maps/.
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { MAPS, loadMap } from '../src/sim/map/index.js';
import { OBJECT_KINDS, objectParts, BOX, CYL, ELL, GABLE } from '../src/sim/map/objects.js';
import { terrainHeightAt, normalAt } from '../src/sim/map/query.js';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const out = opt('--out', 'docs/notes/maps');
const scale = +opt('--scale', 1);
const wantNav = args.includes('--nav');
const crop = opt('--crop', null)?.split(',').map(Number) || null;   // x0,z0,x1,z1 (metres)
let OX = 0, OZ = 0;
const ids = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && ['--out', '--scale', '--crop'].includes(args[i - 1])));
mkdirSync(out, { recursive: true });

// ---------------------------------------------------------------- PNG
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return (crc ^ 0xffffffff) >>> 0;
}
function png(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; rgb.copy ? rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3) : raw.set(rgb.subarray(y * w * 3, (y + 1) * w * 3), y * (w * 3 + 1) + 1); }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

// ---------------------------------------------------------------- raster
class Img {
  constructor(w, h) { this.w = w; this.h = h; this.d = new Uint8Array(w * h * 3); }
  // world (x, z) → pixel; north (+z) is up
  px(x) { return (x - OX) * scale; } py(z) { return this.h - 1 - (z - OZ) * scale; }
  set(x, y, [r, g, b], a = 1) {
    x = x | 0; y = y | 0; if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const k = (y * this.w + x) * 3, d = this.d;
    d[k] = d[k] + (r - d[k]) * a; d[k + 1] = d[k + 1] + (g - d[k + 1]) * a; d[k + 2] = d[k + 2] + (b - d[k + 2]) * a;
  }
  disc(x, z, r, col, a = 1) {
    const cx = this.px(x), cy = this.py(z), R = Math.max(0.7, r * scale);
    for (let y = Math.floor(cy - R); y <= Math.ceil(cy + R); y++) for (let X = Math.floor(cx - R); X <= Math.ceil(cx + R); X++)
      if ((X - cx) ** 2 + (y - cy) ** 2 <= R * R) this.set(X, y, col, a);
  }
  ring(x, z, r, col, t = 1.5, a = 1) {
    const cx = this.px(x), cy = this.py(z), R = r * scale;
    for (let y = Math.floor(cy - R - t); y <= Math.ceil(cy + R + t); y++) for (let X = Math.floor(cx - R - t); X <= Math.ceil(cx + R + t); X++)
      if (Math.abs(Math.hypot(X - cx, y - cy) - R) <= t / 2) this.set(X, y, col, a);
  }
  line(x0, z0, x1, z1, col, t = 1, a = 1) {
    const ax = this.px(x0), ay = this.py(z0), bx = this.px(x1), by = this.py(z1);
    const L = Math.hypot(bx - ax, by - ay), n = Math.ceil(L * 2) + 1;
    for (let i = 0; i <= n; i++) {
      const u = i / n, x = ax + (bx - ax) * u, y = ay + (by - ay) * u;
      if (t <= 1) this.set(x, y, col, a); else for (let dy = -t / 2; dy <= t / 2; dy += 0.5) for (let dx = -t / 2; dx <= t / 2; dx += 0.5) this.set(x + dx, y + dy, col, a);
    }
  }
  // oriented rect in world space: centre, half-extents, cos/sin of yaw (objects.js convention)
  rect(cx, cz, hx, hz, c, s, col, a = 1) {
    const R = Math.hypot(hx, hz) * scale;
    const px = this.px(cx), py = this.py(cz);
    for (let y = Math.floor(py - R - 1); y <= Math.ceil(py + R + 1); y++) for (let x = Math.floor(px - R - 1); x <= Math.ceil(px + R + 1); x++) {
      const dx = (x - px) / scale, dz = -(y - py) / scale;
      const lx = dx * c - dz * s, lz = dx * s + dz * c;
      if (Math.abs(lx) <= hx + 0.35 / scale && Math.abs(lz) <= hz + 0.35 / scale) this.set(x, y, col, a);
    }
  }
}

const GCOL = [[104, 140, 70], [140, 118, 84], [165, 160, 150], [214, 198, 150], [128, 124, 118], [100, 86, 64], [96, 150, 180], [40, 80, 140], [196, 176, 96], [236, 240, 245]];
const PCOL = { sniper: [255, 60, 200], hulldown: [255, 150, 0], brawl: [230, 30, 30], scout: [0, 230, 255], flank: [255, 255, 0], bush: [120, 255, 80] };
const LCOL = [[255, 235, 120], [255, 255, 255], [140, 230, 255]];
const TEAM = [[60, 140, 255], [255, 70, 60]];

function render(map, id) {
  const span = crop ? Math.max(crop[2] - crop[0], crop[3] - crop[1]) : map.size;
  if (crop) { OX = crop[0]; OZ = crop[1]; }
  const W = Math.round(span * scale), img = new Img(W, W);
  const sun = { x: -0.5, y: 0.7, z: 0.5 }, sl = Math.hypot(sun.x, sun.y, sun.z);
  const n = { x: 0, y: 1, z: 0 };
  const lvl = map.water ? map.water.level : -Infinity;
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const wx = OX + (x + 0.5) / scale, wz = OZ + (W - 1 - y + 0.5) / scale;
    const h = terrainHeightAt(map, wx, wz);
    const i = Math.round(wx / map.cell), j = Math.round(wz / map.cell);
    const g = map.ground[Math.min(map.res - 1, j) * map.res + Math.min(map.res - 1, i)];
    let col = GCOL[g];
    normalAt(map, wx, wz, n);
    let shade = 0.55 + 0.75 * Math.max(0, (n.x * sun.x + n.y * sun.y + n.z * sun.z) / sl) - 0.25;
    if (h < lvl) { const dp = Math.min(1, (lvl - h) / 3); col = [70 - 40 * dp, 130 - 50 * dp, 175 - 20 * dp]; shade = 1; }
    // contours every 5 m (thicker every 25 m)
    const c5 = Math.abs(h / 5 - Math.round(h / 5)) * 5, grad = Math.max(0.05, Math.hypot(n.x, n.z) / Math.max(0.2, n.y));
    const onC = grad > 0.08 && c5 < 0.35 * grad / scale + 0.05;
    const k = (y * W + x) * 3;
    for (let q = 0; q < 3; q++) img.d[k + q] = Math.max(0, Math.min(255, col[q] * shade * (onC ? (Math.round(h / 5) % 5 === 0 ? 0.62 : 0.8) : 1)));
    if (!(wx >= map.play.min && wx <= map.play.max && wz >= map.play.min && wz <= map.play.max)) for (let q = 0; q < 3; q++) img.d[k + q] *= 0.6;
  }
  // roads centre lines (thin, crisp)
  for (const r of map.roads || []) for (let i = 1; i < r.path.length; i++) img.line(...r.path[i - 1], ...r.path[i], r.kind === 'track' ? [120, 100, 70] : [185, 180, 170], Math.max(1, r.width * scale * 0.7), 0.8);
  // props (collision footprints)
  const order = ['crater', 'hedge', 'bush', 'haystack', 'fence', 'wall', 'sandbags', 'rock', 'logs', 'wreck', 'tank_trap', 'bridge', 'ruin', 'shed', 'house', 'barn', 'station', 'church', 'silo', 'windmill', 'tree', 'pine'];
  const byKind = {}; for (const o of map.objects) (byKind[o.kind] ||= []).push(o);
  for (const kind of order) for (const o of byKind[kind] || []) {
    const c = Math.cos(o.yaw), s = Math.sin(o.yaw);
    if (kind === 'tree' || kind === 'pine') { img.disc(o.x, o.z, o.s[0] * 0.8, kind === 'pine' ? [20, 70, 40] : [40, 95, 35], 0.75); img.disc(o.x, o.z, 0.6, [60, 40, 20]); continue; }
    if (kind === 'bush') { img.disc(o.x, o.z, o.s[0], [70, 150, 50], 0.85); continue; }
    if (kind === 'hedge') { img.rect(o.x, o.z, o.s[0], o.s[2], c, s, [50, 120, 40], 0.9); continue; }
    if (kind === 'haystack') { img.disc(o.x, o.z, o.s[0], [220, 190, 90]); continue; }
    for (const p of objectParts(o)) {
      const col = kind === 'fence' ? [150, 110, 60] : kind === 'wall' || kind === 'sandbags' ? [90, 90, 95] : kind === 'rock' ? [110, 110, 110] :
        kind === 'bridge' ? [95, 70, 45] : kind === 'tank_trap' ? [60, 60, 60] : kind === 'church' ? [200, 190, 170] : kind === 'ruin' ? [120, 90, 80] : kind === 'wreck' ? [50, 45, 40] : [160, 70, 55];
      if (p.type === GABLE) img.line(p.cx - p.c * p.hx, p.cz + p.s * p.hx, p.cx + p.c * p.hx, p.cz - p.s * p.hx, [80, 30, 25], 1);
      else if (p.type === CYL) img.disc(p.cx, p.cz, p.hx, col);
      else if (p.type === ELL) img.rect(p.cx, p.cz, p.hx * 0.85, p.hz * 0.85, p.c, p.s, col);
      else img.rect(p.cx, p.cz, p.hx, p.hz, p.c, p.s, col);
    }
  }
  // boundary
  const { min, max } = map.play;
  for (const [a, b, c, d] of [[min, min, max, min], [max, min, max, max], [max, max, min, max], [min, max, min, min]]) img.line(a, b, c, d, [230, 20, 20], 2.5);
  // lanes
  map.lanes.forEach((L, i) => { for (let k = 1; k < L.path.length; k++) img.line(...L.path[k - 1], ...L.path[k], L.broken ? [255, 0, 0] : LCOL[i % 3], 2, 0.75); });
  // bases & spawns
  for (const b of map.bases) { img.ring(b.x, b.z, b.r, TEAM[b.team], 3); img.disc(b.x, b.z, 3, TEAM[b.team]); }
  map.spawns.forEach((list, t) => { for (const s of list) { img.disc(s.x, s.z, 3.2, [0, 0, 0]); img.disc(s.x, s.z, 2.4, TEAM[t]); img.line(s.x, s.z, s.x + Math.sin(s.yaw) * 7, s.z + Math.cos(s.yaw) * 7, TEAM[t], 1.5); } });
  // points
  for (const p of map.points) {
    const col = PCOL[p.kind] || [255, 255, 255];
    img.disc(p.x, p.z, 5, [0, 0, 0]); img.disc(p.x, p.z, 3.8, col);
    if (p.team !== null) img.disc(p.x, p.z, 1.6, TEAM[p.team]);
    if (p.yaw !== undefined) img.line(p.x, p.z, p.x + Math.sin(p.yaw) * 18, p.z + Math.cos(p.yaw) * 18, col, 2);
  }
  writeFileSync(`${out}/${id}${crop ? '-crop' : ''}.png`, png(W, W, img.d));
}

function renderNav(map, id) {
  const { cols, rows, cost, cell } = map.nav, S = 4, img = new Img(cols * S, rows * S);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const v = cost[r * cols + c];
    const col = !isFinite(v) ? [0, 0, 0] : v < 1 ? [150, 150, 160] : [Math.min(255, 60 + v * 45), Math.max(0, 220 - v * 40), 60];
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) img.set(c * S + x, (rows - 1 - r) * S + y, col);
  }
  const sc = S / cell;
  map.lanes.forEach((L, i) => { for (let k = 1; k < L.path.length; k++) { const [a, b] = L.path[k - 1], [c, d] = L.path[k]; const n = 60; for (let q = 0; q <= n; q++) { const x = (a + (c - a) * q / n) * sc, z = (b + (d - b) * q / n) * sc; img.set(x, rows * S - 1 - z, LCOL[i % 3]); } } });
  writeFileSync(`${out}/${id}-nav.png`, png(cols * S, rows * S, img.d));
}

for (const m of MAPS) {
  if (ids.length && !ids.includes(m.id)) continue;
  const t = performance.now();
  const map = loadMap(m.id);
  const lt = performance.now() - t;
  render(map, m.id);
  if (wantNav) renderNav(map, m.id);
  console.log(`${m.id}: loaded in ${lt.toFixed(0)} ms, ${map.objects.length} objects → ${out}/${m.id}.png`);
}
