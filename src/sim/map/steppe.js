// Steppe Ridge — autumn steppe. Mirror-symmetric across z = 500 (team 0 south, team 1 north).
// Two long ridges face each other across an open valley: the hull-down lines. Saddles let the
// lanes through them.
//  West lane:   the balka, a dry gully that hides a flanking push up the west edge
//  Centre:      the kurgan (burial mound) in the middle of the valley, hull-down on its flanks
//  East lane:   Krasny Put' collective farm: cow sheds, silos and yards for close fighting
import { MapBuilder, KEEP, SOLID, VEG } from './build.js';
import { GROUND } from './objects.js';
import { smooth } from './noise.js';
import { outerWoods } from './ashford.js';

export function steppe(seed) {
  const B = new MapBuilder({ id: 'steppe', name: 'Steppe Ridge', seed, sym: 'mirror' });
  const r = B.rng;
  // ---------------- terrain
  B.base(40, 4.5, 400, 4);
  B.detail(0.9, 80);
  B.bump(500, 500, 460, 130, -4, 0, 1);                                     // the valley
  const saddle = (x) => 1 - 0.8 * Math.exp(-(((x - 335) / 38) ** 2)) - 0.8 * Math.exp(-(((x - 655) / 38) ** 2));
  const ridgeLine = [[90, 285], [230, 318], [400, 338], [580, 334], [760, 318], [910, 290]];
  B.ridgeBoth(ridgeLine, 10, 55, 10, (s, L, x) => 10 * saddle(x) * smooth(0, 60, s) * smooth(0, 60, L - s));
  B.ridgeBoth([[380, 250], [470, 270]], 6, 35, 3);                          // a rear fold for second-line TDs
  B.bump(500, 500, 62, 62, 13, 0, 1.25);                                     // the kurgan
  B.bump(500, 500, 130, 110, 2.5, 0, 1);
  // the balka (west gully)
  B.trench(B.symLine([[150, 170], [180, 290], [160, 400], [172, 500]]), 9, 22, 7, (s, L) => 7 * smooth(0, 90, s) * smooth(0, 90, L - s));
  B.trench(B.symLine([[70, 380], [120, 440], [172, 500]]), 5, 14, 3.5, (s, L) => 3.5 * smooth(0, 60, s));
  B.bumpBoth(120, 200, 70, 70, 6);
  B.bumpBoth(860, 170, 90, 70, 7);
  B.rim(16, 6);
  // flats: bases, spawns, the farm
  B.both((T) => { const [x, z] = T.p([300, 112]); B.flatten(x, z, 40, 30); const [a, b] = T.p([470, 122]); B.flatten(a, b, 45, 30, null, 0.7); });
  B.flatten(800, 500, 75, 40, null, 0.85);
  // ---------------- roads
  B.road(B.symLine([[300, 40], [330, 160], [470, 230], [600, 300], [655, 336], [720, 420], [770, 480], [790, 500]]), 7, { kind: 'track' });
  B.road([[790, 500], [930, 500]], 6, { kind: 'track', curve: false });
  B.roadBoth([[300, 160], [250, 250], [335, 330], [320, 420], [220, 480]], 5, { kind: 'track' });
  B.road([[180, 500], [300, 500], [420, 500]], 5, { kind: 'track', curve: false });
  B.road([[580, 500], [700, 500], [790, 500]], 5, { kind: 'track', curve: false });
  B.finalizeHeights();
  // ---------------- ground
  B.paint(GROUND.GRASS);
  B.paintWhere((x, z) => B.noise2(x / 70, z / 70) > 0.42, GROUND.DIRT);
  B.both((T) => { const P = (x, z) => T.p([x, z]); for (const [x, z, w, d, y, c] of [[580, 420, 140, 70, 0.08, 'wheat'], [380, 420, 110, 60, -0.05, 'stubble'], [700, 200, 120, 80, 0, 'sunflower'], [880, 360, 70, 110, 0, 'wheat'], [130, 90, 100, 60, 0, 'stubble']]) { const [a, b] = P(x, z); B.field(a, b, w, d, T.yaw(y), c); } });
  B.paintCircle(800, 500, 62, GROUND.DIRT, 0.25);
  B.paintNatural({ rockSlope: 27 });
  B.paintWhere((x, z, k) => B.slope(x, z) > 20 && B.G[k] === GROUND.GRASS && B.noise2(x / 12, z / 12) > 0, GROUND.DIRT);
  B.paintRoads();
  // ---------------- reservations & layout
  B.markRoads(1.5);
  B.both((T) => { const [x, z] = T.p([300, 112]); B.mark(x, z, 26, KEEP); });
  B.spawnZone(470, 122, 0);
  B.basesAt(300, 112);
  B.laneSym('balka', [[300, 112], [200, 240], [178, 300], [165, 420], [172, 500]]);
  B.laneSym('kurgan', [[300, 112], [420, 230], [500, 330], [470, 430], [440, 500]]);
  B.laneSym('kolkhoz', [[300, 112], [540, 250], [655, 336], [740, 440], [790, 500]]);
  // ---------------- points
  B.point('hulldown', 480, 322, 1, 0, { snap: 25 });
  B.point('hulldown', 600, 318, 1, 0.05, { snap: 25 });
  B.point('hulldown', 230, 305, 0, 0.1, { snap: 25 });
  B.point('hulldown', 780, 300, 2, -0.1, { snap: 25 });
  B.point('brawl', 462, 462, 1);
  B.point('sniper', 405, 336, 1, 0.05);
  B.point('sniper', 560, 334, 1, -0.05);
  B.point('sniper', 840, 306, 2, -0.3);
  B.point('sniper', 95, 230, 0, 0.3);
  B.point('brawl', 790, 455, 2);
  B.point('brawl', 850, 490, 2);
  B.point('brawl', 720, 470, 2);
  B.point('scout', 500, 380, 1, 0);
  B.point('scout', 300, 420, 0, 0.1);
  B.point('bush', 640, 420, 2, -0.1);
  B.point('bush', 250, 380, 0, 0);
  B.point('flank', 168, 420, 0);
  B.point('flank', 920, 400, 2);
  // ---------------- Krasny Put' kolkhoz (plan south half, mirror)
  B.building('silo', 760, 500, 0, 9, 9, 22, 1);                             // water tower on the axis
  B.both((T) => {
    const P = (x, z) => T.p([x, z]), Y = T.yaw;
    B.building('barn', ...P(815, 468), Y(0), 46, 12, 9, 2);                   // long cow sheds
    B.building('barn', ...P(862, 436), Y(0.1), 36, 12, 9, 2);
    B.building('silo', ...P(768, 424), 0, 7, 7, 15, 0);
    B.building('silo', ...P(782, 414), 0, 7, 7, 15, 0);
    B.building('shed', ...P(885, 470), Y(0), 10, 7, 5, 0);
    B.building('ruin', ...P(812, 425), Y(0.2), 14, 9, 5, 0);
    B.building('barn', ...P(900, 400), Y(1.4), 22, 11, 8, 0);
    B.line('wall', [P(740, 470), P(735, 445), P(790, 440)], 0.8, 1.5, { maxLen: 10, gapEvery: 34, gap: 8 });
    B.line('fence', [P(890, 440), P(915, 480)], 0.15, 1.3, { maxLen: 8, level: VEG });
    for (const [x, z, y] of [[800, 482, 0.7], [850, 485, -0.3]]) { const [a, b] = P(x, z); if (B.free(a, b, 4, KEEP)) { B.obj('wreck', a, b, Y(y), [1.5, 1.3, 3], r.int(0, 2)); B.mark(a, b, 4.5, SOLID); } }
    for (let i = 0; i < 10; i++) { const [a, b] = P(r.range(600, 900), r.range(150, 250)); if (B.free(a, b, 4)) { B.obj('haystack', a, b, 0, [2.6, 2, 2.6], 1); B.mark(a, b, 3.5, SOLID); } }
  });
  B.placePlan(B.streetPlan([[585, 500], [712, 500]], -1, { spacing: [14, 20], gap: 0.1, setback: 7, height: [5.5, 7.5], width: [9, 12] }), { garden: 0.6 });
  B.dressPointDefs();
  // ---------------- vegetation: shelterbelts, gully scrub, ridge bushes
  B.both((T) => {
    const P = (x, z) => T.p([x, z]);
    // shelterbelts (tree rows with gaps) east and west
    for (const [a, b] of [[[600, 395], [930, 395]], [[80, 150], [260, 150]], [[560, 170], [800, 175]]]) {
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      for (let s = 0; s < L; s += 8) {
        if ((s % 90) > 72) continue;
        const u = s / L, [x, z] = P(a[0] + (b[0] - a[0]) * u + r.range(-1, 1), a[1] + (b[1] - a[1]) * u + r.range(-1.5, 1.5));
        if (r() < 0.8) B.tree(x, z, 'tree', r.range(0.8, 1.05)); else B.bush(x, z, 1.2);
      }
    }
    // scrub in the balka
    for (let i = 0; i < 70; i++) { const z = r.range(170, 500), x = 170 + r.range(-18, 18) - (z < 290 ? 10 : 0); const [a, b] = P(x, z); if (r() < 0.25) B.tree(a, b, 'tree', 0.8); else B.bush(a, b, r.range(0.9, 1.3)); }
    // bushes and rocks along the ridge crests
    for (let i = 0; i < 26; i++) { const x = r.range(110, 890), z = 300 + 40 * Math.sin(x / 300) - 5 + r.range(-18, 18); const [a, b] = P(x, z); if (r() < 0.3) B.rock(a, b, r.range(0.8, 1.5)); else B.bush(a, b, r.range(1, 1.3)); }
    // scattered valley bushes and birch copses
    for (let i = 0; i < 30; i++) { const [a, b] = P(r.range(80, 920), r.range(360, 480)); B.bush(a, b, r.range(0.9, 1.3)); }
    B.forest(...P(90, 330), 30, 8, ['tree'], { density: 0.8 });
    B.forest(...P(420, 170), 22, 8, ['tree'], { density: 0.8 });
    B.forest(...P(640, 90), 30, 9, ['tree'], { density: 0.75 });
    B.forest(...P(930, 250), 28, 9, ['tree'], { density: 0.75 });
    for (const [x, z] of [[470, 470], [530, 468], [440, 420], [560, 410]]) { const [a, b] = P(x, z); B.rock(a, b, 1.1); }
  });
  outerWoods(B, 220, ['tree']);
  return B.finish({ theme: THEME });
}

const THEME = { name: 'autumn', sun: [-0.7, 0.38, -0.6], fog: { color: '#d8cdb8', density: 0.0010 }, sky: { top: '#7fa2c4', horizon: '#eadcc0' }, tint: '#a39a5a' };
