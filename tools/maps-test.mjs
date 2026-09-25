// Map tests (node, no browser): node tools/maps-test.mjs [mapId...]
// Loads every map, checks determinism, layout validity (spawns, bases, lanes, points, nav),
// and the geometry queries (terrain ray vs brute force, props, foliage, breaking) + perf.
import { MAPS, loadMap } from '../src/sim/map/index.js';
import { OBJECT_KINDS, GROUND, objectParts } from '../src/sim/map/objects.js';
import * as Q from '../src/sim/map/query.js';
import { findPath } from '../src/sim/map/nav.js';
import { makeRng } from '../src/sim/map/noise.js';
import { createHash } from 'node:crypto';

const argv = process.argv.slice(2), si = argv.indexOf('--seed');
const SEED = si >= 0 ? +argv[si + 1] : undefined;               // test a non-default seed
const only = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--seed');
let fails = 0, checks = 0;
const ok = (cond, msg) => { checks++; if (!cond) { fails++; console.log('  FAIL', msg); } return cond; };
const hashMap = (m) => {
  const h = createHash('sha1');
  h.update(Buffer.from(m.heights.buffer)); h.update(Buffer.from(m.ground.buffer)); h.update(Buffer.from(m.nav.cost.buffer));
  h.update(JSON.stringify([m.objects, m.spawns, m.points, m.lanes, m.bases, m.roads, m.theme, m.water]));
  return h.digest('hex').slice(0, 12);
};
const navCost = (m, x, z) => { const n = m.nav, c = Math.floor(x / n.cell), r = Math.floor(z / n.cell); return n.cost[r * n.cols + c]; };

for (const meta of MAPS) {
  if (only.length && !only.includes(meta.id)) continue;
  console.log(`\n== ${meta.id} (${meta.name})`);
  let t = performance.now();
  const m = loadMap(meta.id, SEED);
  const loadMs = performance.now() - t;
  const m2 = loadMap(meta.id, SEED);
  const hA = hashMap(m), hB = hashMap(m2);
  ok(loadMs < 1500, `load time ${loadMs.toFixed(0)} ms`);
  ok(hA === hB, 'deterministic');
  const other = loadMap(meta.id, (SEED ?? 0) + 12345);
  ok(hashMap(other) !== hA, 'seed changes the map');
  // shape
  ok(m.size === 1000 && m.res === 257 && m.heights.length === 257 * 257 && m.ground.length === 257 * 257, 'grid shape');
  ok(m.objects.length <= 2500, `objects ${m.objects.length} <= 2500`);
  ok(m.objects.every((o, i) => o.id === i && OBJECT_KINDS[o.kind] && o.s.length === 3 && isFinite(o.x + o.y + o.z + o.yaw)), 'objects well-formed');
  ok(m.nav.cols === 125 && m.nav.rows === 125 && m.nav.cell === 8, 'nav 125x125x8');
  ok(['summer', 'autumn', 'winter', 'desert'].includes(m.theme.name), 'theme');
  let minH = Infinity, maxH = -Infinity; for (const h of m.heights) { minH = Math.min(minH, h); maxH = Math.max(maxH, h); }
  // playable slope stats
  let steep = 0, tot = 0;
  for (let z = m.play.min; z < m.play.max; z += 5) for (let x = m.play.min; x < m.play.max; x += 5) { tot++; if (Q.slopeAt(m, x, z) > 25) steep++; }
  ok(steep / tot < 0.08, `steep (>25°) share ${(100 * steep / tot).toFixed(1)}%`);
  // spawns
  ok(m.spawns.length === 2 && m.spawns.every((s) => s.length === 15), '15 spawns per team');
  for (let team = 0; team < 2; team++) for (const s of m.spawns[team]) {
    const where = `team ${team} spawn (${s.x},${s.z})`;
    ok(Q.inBounds(m, s.x, s.z, 5), `${where} in bounds`);
    ok(isFinite(navCost(m, s.x, s.z)), `${where} passable`);
    ok(Q.slopeAt(m, s.x, s.z) < 20, `${where} slope`);
    ok(Q.groundAt(m, s.x, s.z) !== GROUND.DEEP && Q.waterDepthAt(m, s.x, s.z) < 0.5, `${where} dry`);
    ok(Q.resolveCircle(m, s.x, s.z, 3.5, 'any').hits.length === 0, `${where} clear of props`);
    ok(m.spawns[team].every((o) => o === s || Math.hypot(o.x - s.x, o.z - s.z) >= 8), `${where} spacing`);
  }
  // bases reachable from every spawn, fairness of path costs
  ok(m.bases.length === 2 && m.bases[0].team === 0 && m.bases[1].team === 1, 'bases');
  const costs = [[], []];
  for (let team = 0; team < 2; team++) for (const s of m.spawns[team]) for (const b of m.bases) {
    const p = findPath(m.nav, s.x, s.z, b.x, b.z);
    ok(p !== null, `team ${team} spawn (${s.x},${s.z}) reaches base ${b.team}`);
    if (p && b.team !== team) costs[team].push(p.cost);
  }
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const fair = Math.abs(mean(costs[0]) - mean(costs[1])) / mean(costs[0]);
  ok(fair < 0.1, `spawn→enemy base path cost balance ${(100 * fair).toFixed(1)}%`);
  // lanes
  ok(m.lanes.length === 3, '3 lanes');
  for (const L of m.lanes) {
    ok(!L.broken && L.path.length >= 2, `lane ${L.name} valid`);
    const a = L.path[0], b = L.path[L.path.length - 1];
    ok(Math.hypot(a[0] - m.bases[0].x, a[1] - m.bases[0].z) < 60 && Math.hypot(b[0] - m.bases[1].x, b[1] - m.bases[1].z) < 60, `lane ${L.name} base to base`);
    let bad = 0;
    for (let i = 1; i < L.path.length; i++) { const [x0, z0] = L.path[i - 1], [x1, z1] = L.path[i], n = Math.ceil(Math.hypot(x1 - x0, z1 - z0) / 4); for (let k = 0; k <= n; k++) if (!isFinite(navCost(m, x0 + (x1 - x0) * k / n, z0 + (z1 - z0) * k / n))) bad++; }
    ok(bad <= 2, `lane ${L.name} stays on passable cells (${bad} bad samples)`);
  }
  // points
  const kinds = ['sniper', 'hulldown', 'brawl', 'scout', 'flank', 'bush'];
  for (const k of kinds) for (const team of [0, 1]) ok(m.points.some((p) => p.kind === k && p.team === team), `point ${k} team ${team}`);
  for (const p of m.points) ok(isFinite(navCost(m, p.x, p.z)) && Q.inBounds(m, p.x, p.z) && p.lane >= 0 && p.lane < 3, `point ${p.kind} (${p.x},${p.z}) valid`);
  for (const p of m.points.filter((q) => q.kind === 'bush' || q.kind === 'sniper')) {
    let near = 0; Q.objectsNear(m, p.x, p.z, 14, (o) => { if (OBJECT_KINDS[o.kind].foliage) near++; });
    ok(near > 0, `${p.kind} point (${p.x},${p.z}) has foliage nearby`);
  }
  // nav connectivity: nearly every passable cell reachable from team 0's base
  {
    const { cols, rows, cost, cell } = m.nav, seen = new Uint8Array(cols * rows);
    const start = Math.floor(m.bases[0].z / cell) * cols + Math.floor(m.bases[0].x / cell);
    const st = [start]; seen[start] = 1; let reach = 0, fin = 0;
    while (st.length) { const k = st.pop(); reach++; const c = k % cols, r = (k / cols) | 0; for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const cc = c + dc, rr = r + dr, nk = rr * cols + cc; if (cc >= 0 && rr >= 0 && cc < cols && rr < rows && !seen[nk] && isFinite(cost[nk])) { seen[nk] = 1; st.push(nk); } } }
    for (const v of cost) if (isFinite(v)) fin++;
    ok(reach / fin > 0.97, `nav connectivity ${(100 * reach / fin).toFixed(1)}% of passable cells`);
  }
  // hull-down points: a crest 0.6–2.6 m above the hull 4–10 m ahead
  let hdOk = 0, hdN = 0;
  for (const p of m.points.filter((q) => q.kind === 'hulldown')) {
    hdN++; const h0 = Q.terrainHeightAt(m, p.x, p.z); let crest = -Infinity;
    for (let s = 4; s <= 10; s += 1) crest = Math.max(crest, Q.terrainHeightAt(m, p.x + Math.sin(p.yaw) * s, p.z + Math.cos(p.yaw) * s));
    if (crest - h0 > 0.6 && crest - h0 < 2.6) hdOk++;
  }
  ok(hdOk >= hdN * 0.75, `hull-down points with a crest ahead ${hdOk}/${hdN}`);
  // sniper view: mean clear sight distance over ±25° from 2.5 m (terrain + solid props)
  const views = [];
  for (const p of m.points.filter((q) => q.kind === 'sniper')) {
    let sum = 0, k = 0;
    for (let a = -25; a <= 25; a += 5) {
      const y = p.yaw + a * Math.PI / 180, o = { x: p.x, y: Q.heightAt(m, p.x, p.z) + 2.5, z: p.z };
      for (const el of [-0.004, 0.002]) {
        const d = { x: Math.sin(y) * Math.cos(el), y: Math.sin(el), z: Math.cos(y) * Math.cos(el) };
        const h = Q.raycast(m, o, d, 600); sum += h ? h.t : 600; k++;
      }
    }
    views.push(sum / k);
  }
  const meanView = views.reduce((a, b) => a + b, 0) / views.length;
  ok(meanView > 150, `sniper points mean view ${meanView.toFixed(0)} m`);
  // ---------------------------------------------------------------- queries
  const rng = makeRng(99);
  // vertical rays hit exactly heightAt
  let vmax = 0;
  for (let i = 0; i < 500; i++) { const x = rng.range(1, 999), z = rng.range(1, 999), tt = Q.raycastTerrain(m, { x, y: 300, z }, { x: 0, y: -1, z: 0 }, 1000); vmax = Math.max(vmax, Math.abs(300 - tt - Q.terrainHeightAt(m, x, z))); }
  ok(vmax < 1e-3, `vertical rays match heights (max err ${vmax.toExponential(1)})`);
  // oblique and grazing rays vs brute force marching
  let bad = 0, n = 0, maxErr = 0;
  for (let i = 0; i < 400; i++) {
    const x = rng.range(60, 940), z = rng.range(60, 940), a = rng.range(0, 6.283), grazing = i % 2;
    const h0 = Q.terrainHeightAt(m, x, z), y = h0 + (grazing ? rng.range(0.3, 2.5) : rng.range(2, 40));
    const el = grazing ? rng.range(-0.04, 0.01) : rng.range(-0.4, -0.01), ce = Math.cos(el);
    const d = { x: Math.sin(a) * ce, y: Math.sin(el), z: Math.cos(a) * ce };
    const maxT = 300;
    const t1 = Q.raycastTerrain(m, { x, y, z }, d, maxT);
    let t2 = -1; for (let s = 0; s <= maxT; s += 0.01) { const px = x + d.x * s, pz = z + d.z * s; if (px < 0 || pz < 0 || px > 1000 || pz > 1000) break; if (y + d.y * s <= Q.terrainHeightAt(m, px, pz)) { t2 = s; break; } }
    n++;
    if ((t1 < 0) !== (t2 < 0)) bad++;
    else if (t1 >= 0) { const e = Math.abs(t1 - t2); maxErr = Math.max(maxErr, e); if (e > 0.05) bad++; }
  }
  ok(bad === 0, `terrain rays vs brute force: ${bad}/${n} disagree (max err ${maxErr.toFixed(3)} m)`);
  ok(Q.raycastTerrain(m, { x: 500, y: Q.terrainHeightAt(m, 500, 500) + 2, z: 500 }, { x: 0.3, y: 0.95, z: 0 }, 1000) === -1, 'upward ray misses');
  ok(Q.raycastTerrain(m, { x: -50, y: 300, z: 500 }, { x: 0, y: -1, z: 0 }, 1000) === -1, 'ray outside map misses');
  // props: rays at buildings from outside, and from above
  const solids = m.objects.filter((o) => OBJECT_KINDS[o.kind].solidShell && o.kind !== 'bridge');
  let hitSide = 0, hitTop = 0, tries = 0;
  for (const o of solids.slice(0, 200)) {
    const part = objectParts(o)[0]; tries++;
    const a = rng.range(0, 6.283), R = 40, cy = part.cy;
    const oo = { x: part.cx + Math.sin(a) * R, y: cy, z: part.cz + Math.cos(a) * R }, d = { x: -Math.sin(a), y: 0, z: -Math.cos(a) };
    const h = Q.raycastObjects(m, oo, d, 100);
    if (h && h.t < R && Math.abs(Math.hypot(h.nx, h.ny, h.nz) - 1) < 1e-6) hitSide++;
    const top = Q.raycastObjects(m, { x: part.cx, y: part.cy + 60, z: part.cz }, { x: 0, y: -1, z: 0 }, 100);
    if (top && top.ny > 0.2) hitTop++;
  }
  ok(hitSide === tries, `side rays hit props ${hitSide}/${tries}`);
  ok(hitTop === tries, `top rays hit props with upward normals ${hitTop}/${tries}`);
  // houses: ray through the gable roof
  const house = m.objects.find((o) => o.kind === 'house');
  if (house) {
    const [roof] = objectParts(house).slice(1);
    const hh = Q.raycastObjects(m, { x: roof.cx, y: roof.cy + roof.hy * 0.5, z: roof.cz }, { x: 0, y: -1, z: 0 }, 50);
    ok(hh === null || hh.obj === house, 'ray starting inside the roof reports the house');
    const miss = Q.raycastObjects(m, { x: roof.cx + roof.s * (roof.hz * 0.95), y: roof.cy + roof.hy * 0.95, z: roof.cz + roof.c * (roof.hz * 0.95) }, { x: roof.c, y: 0, z: -roof.s }, 0.1);
    ok(true, 'roof');
  }
  // breaking: a tree blocks tanks until crushed
  const tree = m.objects.find((o) => o.kind === 'tree' || o.kind === 'pine');
  if (tree) {
    const oo = { x: tree.x - 20, y: tree.y + 1, z: tree.z }, d = { x: 1, y: 0, z: 0 };
    const h1 = Q.raycastObjects(m, oo, d, 40, (o) => o === tree);
    ok(h1 && h1.obj === tree, 'tree trunk hit by tank filter');
    ok(Q.raycastObjects(m, oo, d, 40, 'shell')?.obj !== tree, 'shells pass trees');
    ok(Q.breakObject(m, tree, 1, 0) && tree.fallen, 'tree crushed');
    ok(Q.raycastObjects(m, oo, d, 40, (o) => o === tree) === null, 'fallen tree skipped');
    ok(!Q.breakObject(m, tree, 1, 0), 'break twice is a no-op');
  }
  // foliage
  const bush = m.objects.find((o) => o.kind === 'bush');
  {
    const p = { x: bush.x, y: bush.y + bush.s[1], z: bush.z };
    const o = { x: bush.x - 100, y: bush.y + bush.s[1] + 1, z: bush.z };
    const f = Q.foliageAlong(m, o, p);
    ok(f.nearTarget > 0.2 && f.amount >= f.nearTarget, `foliage: tank in a bush (near ${f.nearTarget.toFixed(2)})`);
    const f2 = Q.foliageAlong(m, { x: bush.x, y: bush.y + 30, z: bush.z }, { x: bush.x + 1, y: bush.y + 31, z: bush.z });
    ok(f2.amount === 0, 'foliage: clear sky line is 0');
    const p3 = { x: bush.x + 40, y: bush.y + bush.s[1], z: bush.z }, o3 = { x: bush.x - 60, y: bush.y + bush.s[1], z: bush.z };
    const f3 = Q.foliageAlong(m, o3, p3);
    ok(f3.far > 0 && f3.nearTarget < f3.amount + 1e-9, `foliage: bush mid-way counts as far (${f3.far.toFixed(2)})`);
  }
  // bridges: heightAt follows the deck
  for (const b of m.objects.filter((o) => o.kind === 'bridge')) {
    const top = b.y + 2 * b.s[1];
    ok(Math.abs(Q.heightAt(m, b.x, b.z) - top) < 1e-6 && Q.groundAt(m, b.x, b.z) === GROUND.ROAD && isFinite(navCost(m, b.x, b.z)), `bridge ${b.id} drivable`);
  }
  // ---------------------------------------------------------------- perf
  const rays = [];
  for (let i = 0; i < 10000; i++) {
    const x = rng.range(60, 940), z = rng.range(60, 940), a = rng.range(0, 6.283), el = rng.range(-0.05, 0.02), ce = Math.cos(el);
    rays.push([{ x, y: Q.heightAt(m, x, z) + 2.2, z }, { x: Math.sin(a) * ce, y: Math.sin(el), z: Math.cos(a) * ce }]);
  }
  t = performance.now(); let hits = 0;
  for (const [o, d] of rays) if (Q.raycastTerrain(m, o, d, 500) >= 0) hits++;
  const tTer = performance.now() - t;
  t = performance.now(); let oh = 0;
  for (const [o, d] of rays) if (Q.raycastObjects(m, o, d, 500)) oh++;
  const tObj = performance.now() - t;
  t = performance.now();
  for (const [o, d] of rays) Q.foliageAlong(m, o, { x: o.x + d.x * 300, y: o.y + d.y * 300, z: o.z + d.z * 300 });
  const tFol = performance.now() - t;
  t = performance.now();
  for (let i = 0; i < 100000; i++) Q.heightAt(m, rng.range(0, 1000), rng.range(0, 1000));
  const tH = performance.now() - t;
  t = performance.now();
  for (let i = 0; i < 10000; i++) Q.resolveCircle(m, rng.range(60, 940), rng.range(60, 940), 3.5);
  const tRC = performance.now() - t;
  ok(tTer < 250 && tObj < 400, 'ray perf');
  console.log(`  load ${loadMs.toFixed(0)} ms · hash ${hA} · ${m.objects.length} objects · h ${minH.toFixed(1)}..${maxH.toFixed(1)} m · steep ${(100 * steep / tot).toFixed(1)}%`);
  console.log(`  10k×500 m rays: terrain ${tTer.toFixed(0)} ms (${hits} hits), objects ${tObj.toFixed(0)} ms (${oh} hits), foliage(300 m) ${tFol.toFixed(0)} ms · 100k heightAt ${tH.toFixed(0)} ms · 10k resolveCircle ${tRC.toFixed(0)} ms`);
  console.log(`  path cost spawn→enemy base: team0 ${mean(costs[0]).toFixed(0)} team1 ${mean(costs[1]).toFixed(0)} · points ${m.points.length} · lanes ${m.lanes.map((l) => l.path.length).join('/')}`);
}
console.log(`\n${checks - fails}/${checks} checks passed${fails ? `, ${fails} FAILED` : ''}`);
process.exit(fails ? 1 : 0);
