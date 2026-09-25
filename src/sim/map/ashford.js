// Ashford Fields — summer farmland. Mirror-symmetric across z = 500 (team 0 south, team 1 north).
//  West lane:   hedgerow fields in a shallow valley, farmsteads, haystacks (lights, mediums)
//  Centre:      Ashford village on a low rise, church square, walled gardens (brawl)
//  East lane:   Windmill Hill, a long whaleback on the axis: hull-down duel for its crest
import { MapBuilder, KEEP, SOLID, VEG } from './build.js';
import { GROUND } from './objects.js';

export function ashford(seed) {
  const B = new MapBuilder({ id: 'ashford', name: 'Ashford Fields', seed, sym: 'mirror' });
  const r = B.rng;
  // ---------------- terrain
  B.base(28, 6, 340, 4);
  B.detail(0.7, 70);
  B.bump(505, 500, 170, 150, 3.5, 0, 0.6);                // village rise
  B.bump(800, 500, 105, 200, 19, 0, 0.9);                 // Windmill Hill (on the axis)
  B.bump(835, 500, 50, 90, 4, 0, 1);                      // steeper east shoulder
  B.trench(B.symLine([[225, -20], [205, 260], [235, 500]]), 18, 55, 5);   // west valley
  B.bumpBoth(335, 290, 75, 55, 9, 0.3);                   // west-centre knolls (team sniper hills)
  B.bumpBoth(650, 240, 70, 60, 6);                        // south-east wood hill
  B.bumpBoth(120, 330, 60, 80, 7);                        // far west knoll
  B.rim(20, 7);
  // bases and spawns: flatten
  B.both((T) => { const [x, z] = T.p([380, 118]); B.flatten(x, z, 40, 30); const [a, b] = T.p([500, 128]); B.flatten(a, b, 45, 30, null, 0.7); });
  // village square level
  B.flatten(455, 500, 38, 25, null, 0.8);

  // ---------------- roads
  const main = B.road(B.symLine([[440, 30], [450, 150], [478, 290], [505, 400], [505, 500]]), 8);
  const street = B.road([[330, 500], [420, 500], [480, 500], [560, 500], [660, 500]], 7, { curve: false });
  B.road([[70, 500], [200, 500], [330, 500]], 5, { kind: 'track', curve: false });
  B.road([[660, 500], [740, 500], [778, 500]], 5, { kind: 'track', curve: false });
  B.roadBoth([[120, 70], [170, 180], [215, 300], [270, 400], [330, 500]], 5, { kind: 'track' });
  B.roadBoth([[560, 170], [660, 290], [735, 385], [770, 460]], 5, { kind: 'track' });
  B.roadBoth([[505, 400], [420, 440], [330, 500]], 5, { kind: 'track' });
  B.finalizeHeights();

  // ---------------- ground
  B.paint(GROUND.GRASS);
  // hedgerow fields in the west (plan for team 0 and mirror)
  const crops = ['wheat', 'barley', 'fallow', 'wheat', 'cabbage', 'wheat'];
  const cells = [];
  for (let z = 70; z < 470; z += 80) for (let x = 60; x < 330; x += 90) {
    const w = 80 + r.range(-6, 6), d = 70 + r.range(-6, 6), cx = x + 45, cz = z + 40;
    cells.push({ cx, cz, w, d, crop: r.pick(crops) });
  }
  B.both((T) => { for (const c of cells) { const [x, z] = T.p([c.cx, c.cz]); if (c.crop !== 'fallow') B.field(x, z, c.w - 6, c.d - 6, 0, c.crop); } });
  // a few fields east of the village
  B.both((T) => { for (const [x, z, w, d, y] of [[620, 380, 70, 60, 0.2], [700, 150, 90, 60, -0.1], [590, 120, 60, 50, 0]]) { const [a, b] = T.p([x, z]); B.field(a, b, w, d, T.yaw(y), 'wheat'); } });
  B.paintCircle(455, 500, 34, GROUND.DIRT, 0.2);         // church square
  B.both((T) => { const [x, z] = T.p([160, 215]); B.paintCircle(x, z, 22, GROUND.DIRT, 0.3); });
  B.paintNatural({ rockSlope: 30 });
  B.paintRoads();

  // ---------------- occupancy reservations
  B.markRoads(1.5);
  B.both((T) => { const [x, z] = T.p([380, 118]); B.mark(x, z, 26, KEEP); });
  B.spawnZone(500, 128, 0);

  // ---------------- village
  B.obj('church', 452, 500, Math.PI, [22, 13, 9], 0);     // tower at the west end, 26 m
  B.markRect(452, 500, 0, 22, 9, 3, SOLID);
  const mainPts = main.path.filter((p) => p[1] > 385 && p[1] < 497);
  B.placePlan(B.streetPlan(mainPts, 1, { spacing: [13, 17], gap: 0.05 }), { garden: 0.6 });
  B.placePlan(B.streetPlan(mainPts, -1, { spacing: [13, 17], gap: 0.05 }), { garden: 0.6 });
  const west = [[418, 500], [330, 500]], east = [[520, 500], [660, 500]];
  B.placePlan(B.streetPlan(west, 1, { spacing: [12, 16], gap: 0.1 }), { garden: 0.6 });   // south side (travel west → left = south)
  B.placePlan(B.streetPlan(east, -1, { spacing: [12, 16], gap: 0.1 }), { garden: 0.6 });
  // village outskirts: a second ring of cottages and barns along the back track
  B.placePlan(B.streetPlan([[505, 405], [420, 440], [340, 495]], -1, { spacing: [16, 26], gap: 0.3, kinds: ['house', 'barn', 'shed'] }), { garden: 0.3 });
  B.placePlan(B.streetPlan([[505, 405], [420, 440], [340, 495]], 1, { spacing: [18, 28], gap: 0.4, kinds: ['house', 'shed'] }), { garden: 0.3 });
  // churchyard wall
  B.line('wall', [[420, 482], [490, 482]], 0.7, 1.4, { maxLen: 10, gapEvery: 40, gap: 6, check: false });
  B.line('wall', [[420, 518], [490, 518]], 0.7, 1.4, { maxLen: 10, gapEvery: 40, gap: 6, check: false });
  // orchards south/north of the village
  B.both((T) => {
    for (let x = 540; x <= 620; x += 11) for (let z = 420; z <= 460; z += 11) {
      const [a, b] = T.p([x + r.range(-1, 1), z + r.range(-1, 1)]); B.tree(a, b, 'tree', 0.7);
    }
  });

  // ---------------- farmsteads (west fields)
  B.both((T) => {
    const P = (x, z) => T.p([x, z]), Y = T.yaw;
    const [fx, fz] = P(160, 215);
    B.building('barn', fx, fz, Y(0.25), 24, 13, 11, 1);
    const [hx, hz] = P(182, 240); B.building('house', hx, hz, Y(0.25 + Math.PI / 2), 12, 9, 8, 2);
    const [sx, sz] = P(138, 240); B.building('shed', sx, sz, Y(0.25), 8, 6, 4.5, 0);
    for (const [x, z] of [[120, 190], [128, 180], [200, 190], [140, 160]]) { const [a, b] = P(x, z); B.obj('haystack', a, b, 0, [2.6, 1.8, 2.6], 0); B.mark(a, b, 3, SOLID); }
    const [px, pz] = P(260, 420); B.building('barn', px, pz, Y(-0.4), 18, 10, 9, 0);
  });
  // hedgerows along the field cells (with gaps), mirrored
  B.both((T) => {
    for (const c of cells) {
      const x0 = c.cx - c.w / 2, x1 = c.cx + c.w / 2, z1 = c.cz + c.d / 2, z0 = c.cz - c.d / 2;
      const edges = [[[x0, z1], [x1, z1]], [[x1, z0], [x1, z1]]];
      for (const [a, b] of edges) {
        if (b[0] > 345) continue;
        B.line('hedge', [T.p(a), T.p(b)], 2.6, 2.3, { maxLen: 14, gapEvery: 36, gap: 10, level: VEG, jitter: 0.3 });
      }
    }
  });
  // haystacks in the fields
  B.both((T) => { for (let i = 0; i < 16; i++) { const [x, z] = T.p([r.range(80, 320), r.range(80, 470)]); if (B.free(x, z, 4)) { B.obj('haystack', x, z, 0, [2.3, 1.7, 2.3], r.int(0, 1)); B.mark(x, z, 3, SOLID); } } });

  // ---------------- Windmill Hill
  B.obj('windmill', 800, 500, 0.6, [3.6, 8, 3.6], 0); B.mark(800, 500, 6, SOLID);
  B.both((T) => {
    for (const [x, z] of [[775, 470], [830, 455], [790, 430], [850, 480], [760, 440]]) { const [a, b] = T.p([x, z]); B.rock(a, b, 1.2); }
    const [ax, az] = T.p([815, 470]); B.building('ruin', ax, az, T.yaw(0.2), 12, 8, 5, 0);
    B.line('wall', [T.p([740, 420]), T.p([770, 470])], 0.8, 1.3, { maxLen: 10 });
  });
  // points (team 0, mirrored)
  B.point('sniper', 205, 300, 0, 0.05);
  B.point('sniper', 585, 300, 1, -0.15);
  B.point('sniper', 690, 245, 2, 0.35);
  B.point('sniper', 330, 250, 1, 0.35);
  B.point('hulldown', 800, 455, 2, 0, { snap: 28 });
  B.point('hulldown', 335, 320, 0, 0.1);
  B.point('hulldown', 760, 440, 2, 0.4);
  B.point('brawl', 470, 462, 1);
  B.point('brawl', 530, 452, 1);
  B.point('brawl', 395, 480, 1);
  B.point('scout', 300, 425, 0, 0);
  B.point('scout', 640, 430, 2, 0.4);
  B.point('bush', 250, 380, 0, 0);
  B.point('bush', 700, 350, 2, 0.2);
  B.point('bush', 580, 470, 1, 0);
  B.point('flank', 130, 440, 0);
  B.point('flank', 900, 430, 2);
  B.dressPointDefs();

  // ---------------- woods & scatter
  B.both((T) => {
    const P = (x, z) => T.p([x, z]);
    B.forest(...P(650, 240), 55, 8, ['tree', 'tree', 'pine'], { density: 0.8 });
    B.forest(...P(900, 280), 60, 8, ['tree', 'pine'], { density: 0.75 });
    B.forest(...P(720, 110), 45, 9, ['tree'], { density: 0.7 });
    B.forest(...P(100, 110), 40, 9, ['tree'], { density: 0.7 });
    B.forest(...P(345, 380), 26, 8, ['tree'], { density: 0.8 });
    B.forest(...P(900, 440), 26, 9, ['tree', 'pine'], { density: 0.7 });
    // lone field trees along hedges
    for (let i = 0; i < 14; i++) { const [x, z] = P(r.range(70, 340), r.range(80, 480)); B.tree(x, z, 'tree', r.range(0.9, 1.3)); }
    // bushes: scattered clumps
    for (let i = 0; i < 40; i++) { const [x, z] = P(r.range(60, 940), r.range(60, 480)); if (x > 400 && x < 610 && z > 380) continue; B.bush(x, z, r.range(0.9, 1.3)); }
  });
  // boundary woods outside the play area
  outerWoods(B, 330);
  return B.finish({ theme: THEME, blurb: '' });
}

const THEME = { name: 'summer', sun: [-0.55, 0.42, -0.72], fog: { color: '#c9d3d8', density: 0.0011 }, sky: { top: '#6f9fd0', horizon: '#dfe6e6' }, tint: '#7a9a4a' };

// Trees on the rim (outside the red line), budget-limited.
export function outerWoods(B, n, kinds = ['tree', 'pine']) {
  const r = B.rng, { min, max } = B.play;
  let placed = 0;
  for (let i = 0; i < n * 3 && placed < n; i++) {
    const side = r.int(0, 3), t = r.range(0, B.size), o = r.range(4, min - 4);
    const x = side === 0 ? o : side === 1 ? B.size - o : t, z = side === 2 ? o : side === 3 ? B.size - o : t;
    if (B.noise2(x / 60, z / 60) < -0.25) continue;
    if (B.tree(x, z, r.pick(kinds), r.range(0.9, 1.2))) placed++;
  }
}
