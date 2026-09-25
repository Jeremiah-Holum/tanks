// River Kessel — summer river town. Point-symmetric (180° about the centre): team 0 south,
// team 1 north. The Kessel winds west→east through the middle in an S-curve.
//  West lane:   a shallow ford under Kessel Heights (the wooded hill of each team's west/east)
//  Centre:      Kessel town on both banks, two stone bridges, quays and narrow streets (brawl)
//  East lane:   the second ford, approached through a walled farm and orchard meadows
import { MapBuilder, KEEP, SOLID, VEG } from './build.js';
import { GROUND } from './objects.js';
import { smooth } from './noise.js';
import { outerWoods } from './ashford.js';

const LVL = 20, QUAY = LVL + 3.2;
const riverZ = (x) => 500 + 70 * Math.sin(Math.PI * (x - 500) / 450);
const riverSlope = (x) => 70 * Math.PI / 450 * Math.cos(Math.PI * (x - 500) / 450);
const inTown = (x, z) => x > 350 && x < 650 && Math.abs(z - riverZ(x)) < 150;

export function kessel(seed) {
  const B = new MapBuilder({ id: 'kessel', name: 'River Kessel', seed, sym: 'rotate' });
  const r = B.rng;
  B.water = { level: LVL };
  // ---------------- terrain: a valley falling gently to the river
  B.base(29, 3.5, 300, 4);
  B.detail(0.6, 60);
  B.add((x, z) => { const d = Math.abs(z - riverZ(x)); return -6 + 9 * smooth(20, 300, d); });
  B.bumpBoth(195, 270, 115, 95, 20, 0.3, 0.85);           // Kessel Heights (SW, and NE)
  B.bumpBoth(140, 330, 50, 50, 5);
  B.bumpBoth(780, 240, 120, 80, 4);                       // farm rise (SE, and NW)
  B.bumpBoth(640, 200, 60, 50, 6);                        // low knoll behind the town
  B.bermBoth(197, 282, 0.1, 2.6);                          // hull-down banks
  B.bermBoth(640, 205, -0.2, 2.0);
  B.rim(22, 8);
  // town terraces at quay level on both banks
  B.add((x, z) => 0);
  B.each((k, x, z) => {
    const dx = Math.max(0, Math.abs(x - 500) - 120), d = Math.abs(z - riverZ(x));
    const t = (1 - smooth(0, 60, dx)) * (1 - smooth(110, 170, d));
    B.H[k] += (QUAY - B.H[k]) * t;
  });
  // bases and spawns
  B.both((T) => { const [x, z] = T.p([600, 120]); B.flatten(x, z, 40, 30); const [a, b] = T.p([470, 125]); B.flatten(a, b, 45, 30, null, 0.7); });
  // ford approaches: ramps down to the water on both banks
  const fordX = 170, fordZ = riverZ(fordX);
  B.both((T) => { for (const side of [-1, 1]) { const [x, z] = T.p([fordX + side * 8, fordZ + side * 30]); B.flatten(x, z, 18, 22, LVL + 0.9, 0.9); } });
  // ---------------- the river
  const ctrl = []; for (let x = -30; x <= 1030; x += 20) ctrl.push([x, riverZ(x)]);
  const isFord = (x) => Math.abs(x - fordX) < 32 || Math.abs(x - (1000 - fordX)) < 32;
  B.river(ctrl,
    (x) => (isFord(x) ? 24 : 17),
    (x) => (x > 360 && x < 640 ? 2.5 : isFord(x) ? 26 : 12),
    (x) => { const f = Math.min(Math.abs(x - fordX), Math.abs(x - (1000 - fordX))); return 0.75 + 2.6 * smooth(20, 45, f); },
    { curve: false });
  // ---------------- roads
  const bridges = [];
  B.both((T) => {
    const bx = 440, bz = riverZ(bx), P = (x, z) => T.p([x, z]);
    const tl = Math.hypot(1, riverSlope(bx)), nx = -riverSlope(bx) / tl, nz = 1 / tl;
    const [cx, cz] = P(bx, bz), yaw = T.yaw(Math.atan2(nx, nz));
    bridges.push({ cx, cz, yaw });
    const a = [bx - nx * 32, bz - nz * 32], b = [bx + nx * 32, bz + nz * 32];
    // approach road (graded outside the town) and the crossing itself (not graded)
    B.road(T.poly([[395, 60], [410, 200], [425, 330], [a[0] - nx * 40, a[1] - nz * 40], a]), 8);
    B.road(T.poly([a, b]), 8, { grade: false, curve: false });
    B.road(T.poly([b, [b[0] + nx * 40, b[1] + nz * 40], [470, 640], [490, 720]]), 8, { grade: false });
    // quay street along the south bank, and a cross street
    const quay = []; for (let x = 360; x <= 640; x += 20) quay.push([x, riverZ(x) - 34]);
    B.road(T.poly(quay), 7, { grade: false });
    B.road(T.poly([[560, riverZ(560) - 34], [585, 400], [610, 330], [640, 250]]), 6, { grade: false });
    B.road(T.poly([[640, 250], [700, 200], [780, 215], [840, 260], [835, 400], [830, 470]]), 5, { kind: 'track' });
    B.road(T.poly([[395, 60 + 150], [300, 250], [200, 350], [178, 420]]), 5, { kind: 'track' });
  });
  B.finalizeHeights();
  // ---------------- ground
  B.paint(GROUND.GRASS);
  B.paintWhere((x, z) => Math.abs(x - 500) < 150 + 25 * B.noise2(x / 30, z / 30) && Math.abs(z - riverZ(x)) < 105 + 20 * B.noise2(z / 30, x / 30), GROUND.DIRT);
  B.both((T) => { const P = (x, z) => T.p([x, z]); for (const [x, z, w, d, y, c] of [[760, 330, 90, 60, 0.3, 'wheat'], [880, 300, 60, 90, -0.2, 'barley'], [740, 160, 100, 55, 0.1, 'wheat'], [300, 120, 90, 60, 0, 'cabbage']]) { const [a, b] = P(x, z); B.field(a, b, w, d, T.yaw(y), c); } });
  B.paintNatural({ rockSlope: 30, bank: GROUND.MUD });
  B.paintWhere((x, z, k) => B.G[k] === GROUND.MUD && B.noise2(x / 25, z / 25) > 0.25, GROUND.SAND);
  B.paintRoads();
  // ---------------- reservations
  B.markRoads(1.5);
  B.both((T) => { const [x, z] = T.p([600, 120]); B.mark(x, z, 26, KEEP); });
  // keep trees/buildings off the river and its banks
  B.each((k, x, z) => { if (B.H[k] < LVL + 0.4) B.mark(x, z, 3, KEEP); });
  B.spawnZone(470, 125, 0);
  B.basesAt(600, 120);
  B.lane('west ford', [[600, 120], [330, 240], [185, 395], [fordX, fordZ], [185, 540], [250, 700], [400, 880]]);
  B.lane('town', [[600, 120], [430, 300], [440, riverZ(440) - 40], [440, riverZ(440) + 40], [470, 640], [560, 780], [400, 880]]);
  B.lane('east ford', [[600, 120], [770, 250], [830, 440], [1000 - fordX, 1000 - fordZ], [820, 600], [670, 760], [400, 880]]);
  // ---------------- points
  B.point('sniper', 225, 330, 0, 0.35);
  B.point('sniper', 520, 300, 1, -0.1);
  B.point('sniper', 700, 330, 2, 0.35);
  B.point('sniper', 105, 360, 0, 0.2);
  B.point('hulldown', 197, 282, 0, 0.1, { snap: 8 });
  B.point('hulldown', 640, 205, 1, -0.2, { snap: 8 });
  B.point('brawl', 450, 420, 1);
  B.point('brawl', 530, 445, 1);
  B.point('brawl', 600, 470, 1);
  B.point('scout', 300, 400, 0, 0.3);
  B.point('scout', 690, 450, 2, 0);
  B.point('bush', 130, 400, 0, 0.2);
  B.point('bush', 880, 470, 2, -0.3);
  B.point('flank', fordX + 5, fordZ - 40, 0);
  B.point('flank', 1000 - fordX - 5, 1000 - fordZ - 40, 2);

  // ---------------- bridges (deck top at quay level)
  for (const b of bridges) {
    B.obj('bridge', b.cx, b.cz, b.yaw, [6, 0.6, 30], 0, { y: QUAY - 1.2 });
    const c = Math.cos(b.yaw), s = Math.sin(b.yaw);
    B.markRect(b.cx, b.cz, b.yaw, 7, 32, 1, SOLID);
  }
  // ---------------- town (plan the south half, rotate for the north)
  B.both((T) => {
    const [x, z] = T.p([618, riverZ(618) - 57]); B.building('church', x, z, T.yaw(-0.3), 28, 11, 22, 1, 0.5);
    for (const [ax, az] of [[480, riverZ(480) - 60], [405, riverZ(405) - 110]]) { const [a, b] = T.p([ax, az]); B.building('ruin', a, b, T.yaw(0.35), 13, 9, 6, r.int(0, 2)); }
    // quay wall stubs and sandbags along the bank (cover for bridge fights)
    for (const x of [380, 410, 470, 520, 610]) { const z = riverZ(x) - 25; const [a, b] = T.p([x - 6, z]), [c, d] = T.p([x + 6, z + riverSlope(x) * 12]); B.segment('sandbags', [a, b], [c, d], 1.2, 1.3, 0, SOLID, true); }
    for (const [x, z] of [[500, riverZ(500) - 36], [625, riverZ(625) - 32]]) { const [a, b] = T.p([x, z]); if (B.free(a, b, 3, KEEP)) { B.obj('wreck', a, b, T.yaw(r.range(0, 6)), [1.6, 1.3, 3.2], r.int(0, 2)); B.mark(a, b, 5, SOLID); } }
  });
  const quayS = []; for (let x = 365; x <= 635; x += 5) quayS.push([x, riverZ(x) - 34]);
  B.placePlan(B.streetPlan(quayS, -1, { spacing: [12, 15], gap: 0.08, setback: 7, height: [8, 11] }), { garden: 0.3 });
  const back = []; for (let x = 370; x <= 630; x += 5) back.push([x, riverZ(x) - 80]);
  B.road(back, 6, { grade: false, curve: false });
  B.placePlan(B.streetPlan(back, 1, { spacing: [12, 16], gap: 0.15, setback: 7, height: [7, 10] }), { garden: 0.2 });
  B.placePlan(B.streetPlan(back, -1, { spacing: [14, 20], gap: 0.25, setback: 7, kinds: ['house', 'house', 'shed'] }), { garden: 0.5 });
  // ---------------- farm (SE, rotated NW)
  B.both((T) => {
    const P = (x, z) => T.p([x, z]), Y = T.yaw;
    B.building('barn', ...P(820, 330), Y(0.4), 26, 13, 11, 0);
    B.building('house', ...P(790, 360), Y(0.4), 13, 9, 8, 1);
    B.building('shed', ...P(850, 355), Y(0.4 + Math.PI / 2), 9, 6, 4.5, 0);
    B.building('silo', ...P(862, 296), 0, 8, 8, 16, 0);
    B.line('wall', [P(760, 300), P(770, 395), P(870, 400)], 0.8, 1.4, { maxLen: 10, gapEvery: 30, gap: 9 });
    B.line('fence', [P(700, 380), P(860, 430)], 0.15, 1.2, { maxLen: 8, gapEvery: 40, gap: 10, level: VEG });
    for (let x = 870; x <= 925; x += 11) for (let z = 330; z <= 420; z += 11) { const [a, b] = P(x, z); B.tree(a, b, 'tree', 0.7); }
    for (let i = 0; i < 8; i++) { const [a, b] = P(r.range(700, 900), r.range(120, 200)); if (B.free(a, b, 4)) { B.obj('haystack', a, b, 0, [2.3, 1.7, 2.3], 0); B.mark(a, b, 3, SOLID); } }
  });
  B.dressPointDefs();
  // ---------------- woods and riverbank vegetation
  B.both((T) => {
    const P = (x, z) => T.p([x, z]);
    B.forest(...P(195, 255), 75, 8, ['tree', 'pine', 'pine'], { density: 0.75 });
    B.forest(...P(90, 180), 40, 8, ['pine'], { density: 0.8 });
    B.forest(...P(660, 190), 30, 8, ['tree'], { density: 0.8 });
    B.forest(...P(920, 190), 40, 9, ['tree'], { density: 0.7 });
    // willows and reeds along the banks outside town
    for (let x = 60; x <= 940; x += 9) {
      if (x > 340 && x < 660) continue;
      const z = riverZ(x) - 24 - r.range(0, 14), [a, b] = P(x + r.range(-3, 3), z);
      if (r() < 0.35) B.tree(a, b, 'tree', 0.8); else if (r() < 0.5) B.bush(a, b, 1.1);
    }
    B.forest(...P(330, 390), 20, 8, ['tree'], { density: 0.85 });
    B.forest(...P(270, 150), 25, 8, ['tree'], { density: 0.8 });
    B.forest(...P(700, 420), 16, 8, ['tree'], { density: 0.85 });
    B.line('wall', [P(250, 380), P(300, 350), P(360, 350)], 0.8, 1.3, { maxLen: 10, gapEvery: 30, gap: 8 });
    B.line('hedge', [P(560, 250), P(700, 280)], 2.6, 2.3, { maxLen: 14, gapEvery: 40, gap: 10, level: VEG });
    for (const [x, z] of [[360, 440], [300, 330], [650, 420], [255, 420]]) { const [a, b] = P(x, z); B.rock(a, b, 1.3); }
    for (let i = 0; i < 45; i++) { const [x, z] = P(r.range(60, 940), r.range(60, 420)); if (inTown(x, z)) continue; B.bush(x, z, r.range(0.9, 1.3)); }
  });
  outerWoods(B, 300);
  return B.finish({ theme: THEME });
}

const THEME = { name: 'summer', sun: [0.6, 0.45, -0.66], fog: { color: '#cdd6dc', density: 0.0012 }, sky: { top: '#6a9ccc', horizon: '#e2e8ea' }, tint: '#6f9448' };
