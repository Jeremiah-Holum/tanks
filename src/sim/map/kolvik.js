// Kolvik Pass — winter valley between mountains. Point-symmetric (180° about the centre):
// team 0 south, team 1 north. A railway embankment crosses the valley through Kolvik station.
//  West lane:   Wolf Hill (team 0's, with a ruined fort on top) and team 1's pine forest
//  Centre:      Kolvik station and the embankment: three crossings, freight wagons, cabins
//  East lane:   team 0's logging forest and sawmill, then team 1's Wolf Hill
import { MapBuilder, KEEP, SOLID, VEG } from './build.js';
import { GROUND } from './objects.js';
import { smooth } from './noise.js';
import { outerWoods } from './ashford.js';

const railZ = (x) => 500 + 22 * Math.sin(2 * Math.PI * (x - 500) / 900);
const CROSS = [250, 500, 750];

export function kolvik(seed) {
  const B = new MapBuilder({ id: 'kolvik', name: 'Kolvik Pass', seed, sym: 'rotate' });
  const r = B.rng;
  // ---------------- terrain
  B.base(32, 4, 320, 4);
  B.detail(0.8, 70);
  // mountain walls east and west: the valley narrows the map to a pass
  B.add((x, z) => {
    const e = Math.min(x, 1000 - x);
    return 26 * (1 - smooth(40, 150, e)) * (0.75 + 0.35 * B.noise(x / 110, z / 110));
  });
  B.bumpBoth(220, 355, 115, 80, 26, 0.25, 0.8);           // Wolf Hill (SW; NE for team 1)
  B.bumpBoth(175, 320, 55, 45, 8, 0);                     // its steep shoulder
  B.bumpBoth(760, 300, 110, 90, 5);                       // forest rise (SE; NW)
  B.rim(34, 12);
  B.both((T) => { const [x, z] = T.p([500, 445]); B.flatten(x, z, 70, 30, null, 0.8); });
  // the embankment: 3.5 m, with level crossings
  const rail = []; for (let x = 20; x <= 980; x += 20) rail.push([x, railZ(x)]);
  const gapF = (x) => CROSS.reduce((m, c) => Math.min(m, 1 - Math.exp(-(((x - c) / 16) ** 2))), 1);
  B.ridge(rail, 4, 9, 3.5, (s, L, x) => 3.5 * gapF(x));
  // flats
  B.both((T) => { const [x, z] = T.p([570, 115]); B.flatten(x, z, 40, 30); const [a, b] = T.p([430, 125]); B.flatten(a, b, 45, 30, null, 0.7); });
  B.both((T) => { const [x, z] = T.p([220, 368]); B.flatten(x, z, 22, 14, null, 0.8); });   // fort plateau
  // ---------------- roads
  B.road(B.symLine([[570, 40], [560, 150], [520, 300], [500, 420], [500, 500]]), 8);
  B.roadBoth([[520, 300], [420, 330], [300, 380], [250, railZ(250) - 20], [250, 500], [240, 620], [200, 700]], 5, { kind: 'track' });
  B.roadBoth([[560, 150], [700, 220], [780, 290], [800, 400], [750, railZ(750) - 20], [750, railZ(750) + 20]], 5, { kind: 'track' });
  B.roadBoth([[330, 460], [420, 455], [500, 455], [620, 470]], 6, {});
  B.road(rail, 4, { kind: 'rail', grade: false, curve: false });
  B.finalizeHeights();
  // ---------------- ground
  B.paint(GROUND.SNOW);
  B.both((T) => { const [x, z] = T.p([500, 455]); B.paintCircle(x, z, 36, GROUND.DIRT, 0.45); });
  B.paintNatural({ rockSlope: 28 });
  B.paintRoads();
  B.paintPoly(rail, GROUND.ROCK, 3);
  // ---------------- layout
  B.markRoads(1.5);
  B.both((T) => { const [x, z] = T.p([570, 115]); B.mark(x, z, 26, KEEP); });
  B.spawnZone(430, 125, 0);
  B.basesAt(570, 115);
  B.lane('wolf hill', [[570, 115], [380, 260], [250, 380], [250, railZ(250)], [240, 620], [300, 760], [430, 885]]);
  B.laneSym('station', [[570, 115], [520, 300], [500, 420], [500, 500]]);
  B.lane('sawmill', [[570, 115], [700, 230], [800, 400], [750, railZ(750)], [805, 570], [680, 770], [430, 885]]);
  // ---------------- points
  B.point('sniper', 248, 392, 0, 0.3);                   // from the fort towards the NW
  B.point('sniper', 470, 300, 1, 0.1);
  B.point('sniper', 660, 260, 2, 0.1);
  B.point('hulldown', 455, railZ(455) - 9, 1, 0, { snap: 10 });
  B.point('hulldown', 700, railZ(700) - 9, 2, 0, { snap: 12 });
  B.point('hulldown', 320, railZ(320) - 9, 0, 0, { snap: 12 });
  B.point('brawl', 470, 440, 1);
  B.point('brawl', 560, 455, 1);
  B.point('brawl', 400, 470, 1);
  B.point('scout', 330, 440, 0, 0.2);
  B.point('scout', 690, 430, 2, 0);
  B.point('bush', 820, 420, 2, -0.2);
  B.point('bush', 150, 450, 0, 0.2);
  B.point('flank', 120, 470, 0);
  B.point('flank', 860, 480, 2);
  // ---------------- station & cabins (plan south, rotate north)
  B.both((T) => {
    const P = (x, z) => T.p([x, z]), Y = T.yaw;
    B.building('station', ...P(560, railZ(560) - 18), Y(-0.15), 34, 12, 11, 0, 1);
    B.building('shed', ...P(410, railZ(410) - 16), Y(0.12), 18, 9, 6, 1, 1);
    // freight wagons on the line
    for (const x of [360, 390, 630, 660]) { const z = railZ(x), [a, b] = P(x, z); B.obj('wreck', a, b, Y(Math.PI / 2 - 0.15), [1.6, 1.9, 6.5], 3, { y: undefined }); B.mark(a, b, 8, SOLID); }
    for (const [x, z, y] of [[470, 470, 0.4], [285, railZ(285) - 12, 1.2]]) { const [a, b] = P(x, z); if (B.free(a, b, 4, KEEP)) { B.obj('wreck', a, b, Y(y), [1.6, 1.3, 3.2], r.int(0, 2)); B.mark(a, b, 5, SOLID); } }
    // tank traps and sandbags at the crossings
    for (const c of CROSS) {
      for (const o of [-26, -18, 18, 26]) { const [a, b] = P(c + o, railZ(c + o) - 14 + r.range(-2, 2)); if (B.free(a, b, 1.5, VEG)) { B.obj('tank_trap', a, b, r.range(0, 3), [1.2, 0.8, 1.2], 0); B.mark(a, b, 2, SOLID); } }
      const [a, b] = P(c - 12, railZ(c - 12) - 22), [cc, d] = P(c + 12, railZ(c + 12) - 22);
      B.segment('sandbags', [a, b], [cc, d], 1.2, 1.3, 0, SOLID, true);
    }
    // log piles at the sawmill
    B.building('barn', ...P(790, 300), Y(0.5), 28, 12, 9, 3);
    for (const [x, z, y] of [[770, 335, 0.5], [815, 330, 0.2], [745, 285, 1.2], [830, 280, 0.9]]) { const [a, b] = P(x, z); if (B.rectFree(a, b, Y(y), 5, 2, 1)) { B.obj('logs', a, b, Y(y), [5, 1.1, 2], 0); B.markRect(a, b, Y(y), 5, 2, 1.5, SOLID); } }
    // the ruined fort on Wolf Hill
    const [fx, fz] = P(220, 368);
    for (let k = 0; k < 8; k++) {
      if (k === 1 || k === 5) continue;                  // gates
      const a0 = k * Math.PI / 4, a1 = (k + 1) * Math.PI / 4, R = 24;
      const A = [fx + Math.cos(a0) * R, fz + Math.sin(a0) * R], Bp = [fx + Math.cos(a1) * R, fz + Math.sin(a1) * R];
      B.segment('wall', A, Bp, 1.4, 2.6 + r.range(-0.8, 0.6), 1, SOLID, false);
    }
    B.building('ruin', fx + 4, fz - 3, Y(0.3), 12, 10, 6, 1, 0.5, true);
    for (let i = 0; i < 10; i++) { const a = r.range(0, 6.28), rr = r.range(35, 70); B.rock(fx + Math.cos(a) * rr, fz + Math.sin(a) * rr, r.range(1, 1.8)); }
  });
  B.placePlan(B.streetPlan([[330, 460], [420, 455], [500, 455], [610, 468]], -1, { spacing: [15, 22], gap: 0.15, setback: 7, width: [8, 11], depth: [7, 9], height: [5.5, 7] }), { garden: 0.5 });
  B.placePlan(B.streetPlan([[330, 460], [420, 455], [500, 455], [610, 468]], 1, { spacing: [16, 24], gap: 0.3, setback: 7, width: [8, 11], depth: [7, 9], height: [5.5, 7] }), { garden: 0.2 });
  B.dressPointDefs();
  // ---------------- forests
  B.both((T) => {
    const P = (x, z) => T.p([x, z]);
    B.forest(...P(770, 330), 95, 7.5, ['pine'], { density: 0.8, bushes: 0.1 });
    B.forest(...P(900, 180), 50, 8, ['pine'], { density: 0.75 });
    B.forest(...P(120, 200), 55, 8, ['pine'], { density: 0.7 });
    B.forest(...P(300, 260), 35, 8, ['pine', 'tree'], { density: 0.7 });
    B.forest(...P(640, 380), 22, 8, ['pine'], { density: 0.8 });
    B.forest(...P(90, 420), 30, 8, ['pine'], { density: 0.7 });
    B.forest(...P(610, 365), 18, 8, ['pine'], { density: 0.85 });
    B.forest(...P(395, 245), 22, 8, ['pine'], { density: 0.8 });
    B.forest(...P(540, 215), 14, 8, ['pine'], { density: 0.85 });
    for (let i = 0; i < 40; i++) { const [x, z] = P(r.range(60, 940), r.range(60, 470)); B.bush(x, z, r.range(0.9, 1.3)); }
    for (let i = 0; i < 12; i++) { const [x, z] = P(r.range(60, 940), r.range(60, 470)); B.rock(x, z, r.range(0.9, 1.6)); }
  });
  outerWoods(B, 300, ['pine']);
  return B.finish({ theme: THEME });
}

const THEME = { name: 'winter', sun: [-0.4, 0.3, -0.85], fog: { color: '#d9e1ea', density: 0.0016 }, sky: { top: '#8aa6c4', horizon: '#e6ebf0' }, tint: '#e8edf2' };
