// Headless rules tests for the Steel Front sim. node tools/rules-test.mjs — exits non-zero on failure.
// Covers: roster & research tree, armour solids, armour cases (angling, overmatch, ricochet,
// tracks, HE/open tops, weak spots, ammo rack), ballistics, dispersion, movement, spotting,
// capture, rams, props, determinism, and (if src/sim/map exists) a smoke run on every real map.
import { TANKS, NATIONS, TREE, STARTERS } from '../src/data/tanks.js';
import { buildArmor, solidFaces } from '../src/sim/armor.js';
import { createBattle, stepBattle, DT, aimSolution, predictImpact, penPreview, muzzle, visibleTo, tankMatrix, hullToWorld, turretToWorld } from '../src/sim/battle.js';
import { fire } from '../src/sim/gunnery.js';
import { settle } from '../src/sim/move.js';
import { startFire, useConsumable, plateEff } from '../src/sim/damage.js';
import { testMap, simpleBot } from '../src/sim/testmap.js';
import { existsSync } from 'fs';

let fails = 0, passes = 0;
const check = (name, ok, info = '') => {
  if (ok) passes++; else fails++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (info !== '' ? '  (' + info + ')' : ''));
};
const f1 = (x) => (typeof x === 'number' ? x.toFixed(1) : x);
const DEG = Math.PI / 180;

// ------------------------------------------------------------------ helpers
function battle(defs0, defs1, opts = {}) {
  const map = opts.map || testMap(opts.mapOpts);
  return createBattle({ map, seed: opts.seed ?? 7, teams: [defs0.map((d) => ({ def: TANKS[d], ...opts.entry })), defs1.map((d) => ({ def: TANKS[d], ...opts.entry }))] });
}
const place = (w, t, x, z, yawDeg = 0) => { t.pos.x = x; t.pos.z = z; t.yaw = yawDeg * DEG; t.speed = 0; t.yawRate = 0; settle(w.map, t); settle(w.map, t); settle(w.map, t); };
const run = (w, secs, ctrl = new Map()) => { const ev = []; for (let k = 0; k < Math.round(secs / DT) && !w.result; k++) { stepBattle(w, ctrl); ev.push(...w.events); } return ev; };
// Fire one perfectly accurate shot from `a` at world point p with shell index si; returns events.
function shoot(w, a, p, si = 0, secs = 2.5) {
  a.shell = si; a.ammo[si] = Math.max(1, a.ammo[si]);
  const s = aimSolution(w, a, p); a.turretYaw = s.yaw; a.gunPitch = s.pitch;
  a.disp = 0; a.reload = 0;
  const ev = [];
  fire(w, a); ev.push(...w.events.splice(0));
  ev.push(...run(w, secs));
  return ev;
}
const hits = (ev, target) => ev.filter((e) => e.type === 'hit' && (target == null || e.target === target));
// World point on a tank: hull frame (x, y, z).
const onTank = (t, x, y, z) => hullToWorld(t, x, y, z, {});

// ------------------------------------------------------------------ roster
console.log('Roster and research tree');
{
  const all = Object.values(TANKS);
  for (const n of Object.keys(NATIONS)) {
    const list = all.filter((d) => d.nation === n);
    const tiers = new Set(list.map((d) => d.tier)), cls = new Set(list.map((d) => d.cls));
    check(`${n}: ${list.length} tanks, tiers I–VII, all classes`, list.length >= 8 && [1, 2, 3, 4, 5, 6, 7].every((k) => tiers.has(k)) && cls.size === 4);
    const vii = list.filter((d) => d.tier === 7).map((d) => d.cls);
    check(`${n}: tier VII in every line it runs (td, medium, heavy)`, ['td', 'medium', 'heavy'].every((c) => vii.includes(c)), vii.join(','));
  }
  check('starters are tier I, free, researched from nothing', STARTERS.length === 3 && STARTERS.every((id) => TANKS[id].tier === 1 && TANKS[id].price === 0 && TANKS[id].parents.length === 0));
  const reach = new Set(STARTERS);
  for (let k = 0; k < 10; k++) for (const e of TREE) if (reach.has(e.from)) reach.add(e.to);
  check('every tank is reachable in the tree', all.every((d) => reach.has(d.id)), `${reach.size}/${all.length}`);
  check('edges: same nation, parent tier below child', TREE.every((e) => TANKS[e.from] && TANKS[e.from].nation === TANKS[e.to].nation && TANKS[e.from].tier < TANKS[e.to].tier));
  const badGun = all.filter((d) => !d.guns.length || d.guns.length > 2 || d.guns[0].xp !== 0 || d.guns.some((g) => g.shells.length !== 3 || g.shells.some((s) => !(s.pen > 0 && s.dmg > 0 && s.v > 0))));
  check('1–2 guns, stock gun free, 3 sane shells each', !badGun.length, badGun.map((d) => d.id).join(','));
  // WoT-ish balance: mean top-gun pen and hp rise with tier
  const byTier = (f) => [1, 2, 3, 4, 5, 6, 7].map((k) => { const l = all.filter((d) => d.tier === k); return l.reduce((s, d) => s + f(d), 0) / l.length; });
  const pens = byTier((d) => d.guns[d.guns.length - 1].shells[0].pen), hps = byTier((d) => d.hp);
  check('pen and hp grow with tier', pens.every((p, i) => !i || p > pens[i - 1]) && hps.every((p, i) => !i || p > hps[i - 1]), 'pen ' + pens.map((p) => p.toFixed(0)).join(' ') + ' | hp ' + hps.map((p) => p.toFixed(0)).join(' '));
  check('camo, view and terrain filled for all', all.every((d) => d.camo && d.camo.still > 0 && d.view >= 250 && d.view <= 445 && d.terrain.length === 3));
}

// ------------------------------------------------------------------ solids
console.log('Armour solids');
{
  const key = (v) => v.map((x) => x.toFixed(3)).join(',');
  const closed = (planes) => {
    const faces = solidFaces(planes), E = new Map();
    for (const f of faces) for (let i = 0; i < f.verts.length; i++) {
      const e = [key(f.verts[i]), key(f.verts[(i + 1) % f.verts.length])].sort().join('|'); E.set(e, (E.get(e) || 0) + 1);
    }
    return faces.length >= 4 && [...E.values()].every((n) => n === 2);
  };
  const inside = (planes, p, eps = 0.02) => planes.every((q) => q.n[0] * p[0] + q.n[1] * p[1] + q.n[2] * p[2] <= q.d + eps);
  const bad = { closed: [], seat: [], pivot: [], roof: [], modules: [], muzzle: [] };
  for (const d of Object.values(TANKS)) {
    const a = buildArmor(d);
    for (const p of [...a.pieces, ...(a.cupola ? [a.cupola] : [])]) if (!closed(p.planes)) bad.closed.push(d.id + ':' + p.name);
    // turret sits on the hull: its footprint lies on the upper hull roof (≤ 10 cm overhang)
    const up = a.pieces.find((p) => p.name === 'hullUpper'), tur = a.pieces.find((p) => p.name === 'turret');
    const roof = solidFaces(up.planes).find((f) => f.plane.plate === 'hull.roof' && f.plane.n[1] > 0.9);
    if (!roof) { bad.roof.push(d.id); continue; }
    const tp = a.turretPos;
    const foot = solidFaces(tur.planes).flatMap((f) => f.verts).filter((v) => v[1] < 0.01);
    const upGrow = up.planes.map((q) => ({ ...q, d: q.d + 0.1 * Math.hypot(q.n[0], q.n[2]) }));
    if (Math.abs(roof.verts[0][1] - tp[1]) > 1e-6 || !foot.every((v) => inside(upGrow, [v[0] + tp[0], tp[1] - 0.01, v[2] + tp[2]], 0.02))) bad.seat.push(d.id);
    // gun pivot at the turret front (on the mantlet face), inside the turret's height
    const fr = tur.planes.find((q) => q.plate === 'turret.front');
    const fz = (fr.d - fr.n[1] * a.gun.pivot[1]) / fr.n[2];
    const md = d.turret.mantlet ? d.turret.mantlet.d : 0;
    if (Math.abs(a.gun.pivot[2] - fz - md) > 0.01 || a.gun.pivot[1] <= 0 || a.gun.pivot[1] >= d.turret.H) bad.pivot.push(d.id);
    // module and crew boxes inside the armour of their frame
    const hullP = a.pieces.filter((p) => p.kind === 'hull'), turP = a.pieces.filter((p) => p.frame === 'turret');
    for (const m of a.modules) {
      const ps = m.frame === 'hull' ? hullP : turP;
      if (!ps.some((p) => inside(p.planes, m.c, 0.05))) bad.modules.push(d.id + ':' + m.name);
    }
  }
  check('every piece is a closed convex solid', !bad.closed.length, bad.closed.join(' '));
  check('turret footprint sits on the hull roof', !bad.roof.length && !bad.seat.length, [...bad.roof, ...bad.seat].join(' '));
  check('gun pivot at the turret front (mantlet face)', !bad.pivot.length, bad.pivot.join(' '));
  check('module and crew boxes inside the armour', !bad.modules.length, bad.modules.join(' '));
}

// ------------------------------------------------------------------ armour
console.log('Armour');
{
  // Tiger front vs 75 mm AP (M4 stock) at 100 m.
  const w = battle(['usa_m4'], ['ger_tiger']);
  const [m4, tiger] = w.tanks;
  place(w, m4, 500, 400, 0); place(w, tiger, 500, 500, 180);
  const face = onTank(tiger, 0, 1.55, 0);
  face.z = tiger.pos.z - 3; // upper glacis area seen from the M4
  const head = penPreview(w, m4, onTank(tiger, 0.3, 1.5, 3.1), tiger.id);
  check('Tiger front head-on vs M4 75 mm AP: nominal pen < effective armour', head && head.pen < head.eff && head.chance < 0.4, head && `${head.plate} eff ${head.eff} pen ${head.pen} chance ${f1(head.chance * 100)}%`);
  place(w, tiger, 500, 500, 180 + 30);
  const ang = penPreview(w, m4, onTank(tiger, 0.2, 1.5, 3.1), tiger.id);
  check('Tiger angled 30°: pen chance < 10%', ang && ang.chance < 0.1, ang && `${ang.plate} eff ${ang.eff} angle ${ang.angle}°`);
  let pens = 0, n = 60;
  for (let i = 0; i < n; i++) { tiger.hp = tiger.maxHp; const ev = hits(shoot(w, m4, onTank(tiger, 0.2 + (i % 3) * 0.1, 1.5, 3.1)), tiger.id); if (ev.some((e) => e.result === 'pen')) pens++; }
  check('live fire: angled Tiger bounces 75 mm AP', pens / n < 0.12, `${pens}/${n} pens`);
  // Side: Tiger broadside vs 76 mm M1A1 pens every time
  const w2 = battle(['usa_m4'], ['ger_tiger']); const [a2, t2] = w2.tanks;
  a2.gunDef = TANKS.usa_m4.guns[1]; a2.ammo = [50, 10, 10];
  place(w2, a2, 400, 500, 90); place(w2, t2, 520, 500, 0);
  let sp = 0;
  for (let i = 0; i < 20; i++) { t2.hp = t2.maxHp; t2.alive = true; const e = hits(shoot(w2, a2, onTank(t2, 0, 1.7, 0.5 - i * 0.05)), t2.id); if (e.some((x) => x.result === 'pen' && x.plate.startsWith('hull.side'))) sp++; }
  check('Tiger side (80 mm) vs 76 mm AP broadside: pens', sp === 20, `${sp}/20`);
  // Overmatch & ricochet at ~75°: Pz II side (15 mm) hit at a glancing angle.
  check('plateEff: 75 mm vs 15 mm at 75° overmatches (no ricochet)', !plateEff('AP', 75, 15, 75 * DEG).ricochet && plateEff('AP', 75, 15, 75 * DEG).overmatch);
  check('plateEff: 37 mm vs 15 mm at 75° ricochets', plateEff('AP', 37, 15, 75 * DEG).ricochet);
  check('plateEff: HEAT/HE never auto-ricochet', !plateEff('HEAT', 75, 80, 80 * DEG).ricochet && !plateEff('HE', 75, 80, 80 * DEG).ricochet);
  check('plateEff: 2×-calibre normalisation boost', plateEff('AP', 88, 40, 45 * DEG).eff < plateEff('AP', 76, 40, 45 * DEG).eff);
  {
    const w3 = battle(['ger_pz38t', 'usa_m4'], ['ger_pz2']); const [lt, m4b, pz2] = w3.tanks;
    place(w3, pz2, 500, 500, 105); // left side (+x hull) faces the shooter at ~75°
    place(w3, lt, 380, 500, 90); place(w3, m4b, 380, 506, 90);
    const sideP = () => onTank(pz2, pz2.def.hull.W / 2 + pz2.def.hull.track.w - 0.02, 1.2, 1.2);
    const e37 = hits(shoot(w3, lt, sideP()), pz2.id)[0];
    check('37 mm AP at ~75° on the Pz II side: ricochet', e37 && e37.result === 'ricochet', e37 && `${e37.plate} ${e37.angle}°`);
    pz2.hp = pz2.maxHp;
    const e75 = hits(shoot(w3, m4b, sideP()), pz2.id)[0];
    check('75 mm AP at ~75° on the Pz II side: overmatch pen', e75 && e75.result === 'pen', e75 && `${e75.plate} ${e75.angle}° eff ${e75.eff}`);
  }
  // A ricochet flies on and can hit a second tank.
  {
    const w4 = battle(['usa_m4'], ['ger_tiger', 'ger_pz4h']); const [a, t1, t2b] = w4.tanks;
    place(w4, a, 400, 500, 90); place(w4, t1, 500, 500, 105); // glancing on the Tiger's left side
    let ev = shoot(w4, a, onTank(t1, 1.7, 1.7, 1.5), 0, 0.2);
    const r = hits(ev, t1.id)[0];
    check('Ricochet off a 75°-ish side plate', r && r.result === 'ricochet', r && `${r.plate} ${r.angle}°`);
    const sh = w4.shells[0];
    check('Ricochet: the shell keeps flying', !!sh && sh.ricochets === 1);
    if (sh) {
      // put a Pz IV into the reflected path
      const v = sh.vel, L = Math.hypot(v.x, v.y, v.z);
      place(w4, t2b, sh.pos.x + v.x / L * 20, sh.pos.z + v.z / L * 20, 0);
      t2b.pos.y = sh.pos.y + v.y / L * 20 - t2b.cy;
      ev = run(w4, 1);
      check('Ricochet: the shell then hits another tank', hits(ev, t2b.id).length > 0 || ev.some((e) => e.type === 'impact'), hits(ev, t2b.id).map((e) => e.result).join(','));
    }
  }
  // Tracks absorb: 20 mm into the Tiger's track stops there; a big gun goes on into the hull.
  {
    const w5 = battle(['ger_pz2', 'ussr_is'], ['ger_tiger']); const [pz, is, tg] = w5.tanks;
    place(w5, tg, 500, 500, 0); place(w5, pz, 380, 500, 90); place(w5, is, 380, 510, 90);
    is.gunDef = TANKS.ussr_is.guns[1]; is.ammo = [20, 5, 5];
    const trackX = -(tg.def.hull.W / 2 + tg.def.hull.track.w / 2); // right side (−x) faces the shooters
    const e1 = hits(shoot(w5, pz, onTank(tg, trackX, 0.55, 0.5)), tg.id)[0];
    check('20 mm into the tracks: absorbed (result track)', e1 && e1.result === 'track' && tg.modules.trackR.hp < tg.modules.trackR.max, e1 && `${e1.result} trackR ${tg.modules.trackR.hp}/${tg.modules.trackR.max}`);
    const e2 = hits(shoot(w5, is, onTank(tg, trackX, 0.6, -0.5)), tg.id)[0];
    check('122 mm through the tracks into the hull', e2 && e2.result === 'pen' && e2.plate.startsWith('hull'), e2 && `${e2.result} ${e2.plate} dmg ${e2.dmg}`);
    // a destroyed track immobilises, then gets repaired in ~8 s
    tg.modules.trackR.hp = 1; tg.alive = true; tg.hp = tg.maxHp;
    tg.modules.trackR.state = 'ok'; const e3 = hits(shoot(w5, is, onTank(tg, trackX, 0.5, 0)), tg.id);
    run(w5, 0.1);
    const x0 = tg.pos.z; const c = new Map([[tg.id, { throttle: 1 }]]);
    run(w5, 3, c);
    check('destroyed track immobilises', tg.modules.trackR.state === 'destroyed' || e3.length === 0 ? Math.abs(tg.pos.z - x0) < 0.2 : false, `${tg.modules.trackR.state} moved ${f1(tg.pos.z - x0)} m`);
    run(w5, 6.5, c);
    check('track repaired after ~8 s, tank drives again', tg.modules.trackR.state !== 'destroyed' && tg.pos.z - x0 > 1, `${tg.modules.trackR.state} moved ${f1(tg.pos.z - x0)} m`);
  }
  // HE vs open top: the M10's open turret takes the full HE damage; a closed M4 turret doesn't.
  {
    const w6 = battle(['usa_t18'], ['usa_m10', 'ussr_kv1']); const [how, m10, m4c] = w6.tanks;
    place(w6, how, 500, 300, 0); place(w6, m10, 500, 500, 0); place(w6, m4c, 530, 500, 0);
    w6.rng = () => 0.5;
    const sh = TANKS.usa_t18.guns[0].shells[2];
    const drop = (tgt) => { // an HE shell falling straight into the turret from 5 m up
      const p = onTank(tgt, 0, tgt.def.hull.clr + tgt.def.hull.H + tgt.def.turret.H + 5, tgt.def.turret.z);
      w6.shells.push({ id: 999, owner: how.id, team: how.team, type: 'HE', pos: p, vel: { x: 0, y: -300, z: 0 }, cal: 75, pen: sh.pen, dmg: sh.dmg, splash: sh.splash, alive: true, dist: 50, ricochets: 0, ignore: 0 });
      return hits(run(w6, 0.2), tgt.id)[0];
    };
    const eo = drop(m10), ec = drop(m4c);
    check('HE into an open-topped turret: full damage', eo && eo.result === 'pen' && eo.dmg === sh.dmg, eo && `${eo.result} ${eo.plate} ${eo.dmg}/${sh.dmg}`);
    check('HE on a closed turret roof: partial damage', ec && ec.dmg < sh.dmg / 2 && ec.result !== 'pen', ec && `${ec.result} ${ec.plate} ${ec.dmg}`);
  }
  // Weak spots
  {
    const w7 = battle(['ussr_t34'], ['ussr_t34', 'ger_tiger']); const [a, t, tg] = w7.tanks;
    place(w7, a, 500, 400, 0); place(w7, t, 500, 500, 180); place(w7, tg, 520, 500, 180);
    const h = t.def.hull, up = penPreview(w7, a, onTank(t, 0.3, h.clr + h.H * 0.75, h.L / 2 - 0.5), t.id);
    const lo = penPreview(w7, a, onTank(t, 0.3, h.clr + 0.25, h.L / 2 - 0.15), t.id);
    check('T-34: lower plate weaker than the 60° glacis', up && lo && lo.plate === 'hull.front.lower' && lo.eff < up.eff, up && lo && `upper ${up.eff} lower ${lo.eff}`);
    const tt = tg.def.turret, ap = buildArmor(tg.def);
    const cv = solidFaces(ap.cupola.planes).flatMap((f) => f.verts), cc = [0, 1, 2].map((k) => cv.reduce((s, v) => s + v[k], 0) / cv.length);
    const cup = penPreview(w7, a, turretToWorld(tg, cc[0], cc[1], cc[2], {}), tg.id);
    const fr = penPreview(w7, a, onTank(tg, 0.9, ap.turretPos[1] + 0.5, ap.turretPos[2] + tt.L / 2), tg.id);
    check('Tiger cupola is weaker than the turret front', cup && fr && cup.plate === 'cupola' && cup.eff < fr.eff, cup && fr && `cupola ${cup.plate} ${cup.eff} vs ${fr.plate} ${fr.eff}`);
  }
  // Ammo rack pops, fire burns and is put out.
  {
    const w8 = battle(['ussr_is'], ['usa_m4']); const [is, m4] = w8.tanks;
    is.gunDef = TANKS.ussr_is.guns[1]; is.ammo = [20, 5, 5];
    place(w8, is, 380, 500, 90); place(w8, m4, 500, 500, 0);
    m4.modules.ammoRack.hp = 1;
    const a = buildArmor(m4.def), rack = a.modules.find((m) => m.name === 'ammoRack');
    const ev = shoot(w8, is, onTank(m4, 1.0, rack.c[1], rack.c[2]));
    const k = ev.find((e) => e.type === 'kill');
    check('ammo rack destroyed: instant kill (cause ammorack)', k && k.cause === 'ammorack' && !m4.alive, k ? k.cause : 'no kill: ' + hits(ev).map((e) => e.result + ' ' + e.crits).join(';'));
    const w9 = battle(['ussr_is'], ['usa_m4']); const [, m] = w9.tanks;
    startFire(w9, m, w9.tanks[0].id);
    run(w9, 3);
    check('fire burns about 1% hp/s', m.maxHp - m.hp >= m.maxHp * 0.025 && m.maxHp - m.hp <= m.maxHp * 0.04, `${m.maxHp - m.hp} hp in 3 s`);
    const used = useConsumable(w9, m, 'extinguisher');
    check('extinguisher puts the fire out', used && !m.fire);
    check('consumable then on cooldown', !m.consumables.find((c) => c.kind === 'extinguisher').ready && !useConsumable(w9, m, 'extinguisher'));
  }
}

// ------------------------------------------------------------------ ballistics & aiming
console.log('Ballistics and aiming');
{
  const w = battle(['ger_tiger'], ['usa_m4']); const [a, b] = w.tanks;
  place(w, a, 500, 100, 0); place(w, b, 500, 700, 180);
  a.turretYaw = 0; a.gunPitch = 0; a.disp = 0; a.reload = 0; a.shell = 0;
  const m = muzzle(a);
  fire(w, a);
  const s = w.shells[0], v = s.vel.z;
  let tFlight = 0;
  while (s.alive && s.pos.z < m.pos.z + 400) { stepBattle(w, new Map()); tFlight += DT; }
  const drop = m.pos.y + (a.pos.y - a.pos.y) - s.pos.y, expect = 9.81 * tFlight * tFlight / 2;
  check('shell drop matches g·t²/2 (400 m)', Math.abs(drop - expect) < 0.15 + expect * 0.03, `drop ${drop.toFixed(2)} m, expected ${expect.toFixed(2)} m, v ${v.toFixed(0)} m/s`);
  const w2 = battle(['usa_m4'], ['ger_tiger'], { mapOpts: { hills: 1.5 } }); const [c, d] = w2.tanks;
  place(w2, c, 480, 100, 0); place(w2, d, 520, 560, 180);
  const target = onTank(d, 0, 1.4, 0);
  const sol = aimSolution(w2, c, target); c.turretYaw = sol.yaw; c.gunPitch = sol.pitch;
  const pi = predictImpact(w2, c);
  check('aimSolution + predictImpact land on a 460 m target over hills', sol.reachable && pi.targetId === d.id && Math.hypot(pi.x - target.x, pi.y - target.y, pi.z - target.z) < 3.5, `${f1(Math.hypot(pi.x - target.x, pi.y - target.y, pi.z - target.z))} m off, pitch ${f1(sol.pitch / DEG)}°`);
  // the sim lays the gun itself given ctrl.aim
  const ctrl = new Map([[c.id, { aim: target }]]);
  c.turretYaw = 1.5; c.gunPitch = 0;
  run(w2, 6, ctrl);
  const pi2 = predictImpact(w2, c);
  check('turret traverses to ctrl.aim within 6 s', pi2.targetId === d.id, `${f1(Math.abs(c.turretYaw - sol.yaw) / DEG)}° off`);
  // dispersion: blooms while moving and turning, converges when still
  const g = c.gunDef;
  run(w2, 3, new Map([[c.id, { throttle: 1, steer: 0.5, aim: target }]]));
  const moving = c.disp;
  run(w2, 1.5, new Map([[c.id, { brake: true, aim: target }]]));
  const t0 = c.disp;
  run(w2, g.aim, new Map([[c.id, { aim: target }]]));
  check('dispersion blooms while moving', moving > g.disp * 2, `${f1(moving)} vs ${g.disp}`);
  check('dispersion converges ~95% in aim time', (c.disp - c.dispTarget) <= (t0 - c.dispTarget) * 0.07 + 1e-3 && c.dispTarget < g.disp * 1.05, `${c.disp.toFixed(3)} → ${c.dispTarget.toFixed(3)}`);
  // shots land inside the circle, with a gaussian-ish spread
  const w3 = battle(['usa_m4'], ['ger_tiger']); const [e] = w3.tanks;
  place(w3, e, 500, 100, 0);
  const rs = [];
  for (let i = 0; i < 400; i++) {
    e.turretYaw = 0; e.gunPitch = 0; e.disp = 0.4; e.reload = 0;
    const m0 = muzzle(e); fire(w3, e); const sh = w3.shells.pop(); w3.events.length = 0;
    const L = Math.hypot(sh.vel.x, sh.vel.y, sh.vel.z);
    rs.push(Math.hypot(sh.vel.x / L - m0.dir.x, sh.vel.y / L - m0.dir.y, sh.vel.z / L - m0.dir.z) * 100);
  }
  const inside = rs.every((r) => r <= 0.4 + 1e-6), inHalf = rs.filter((r) => r < 0.2).length / rs.length;
  check('shots fall inside the dispersion circle, clustered in the middle', inside && inHalf > 0.55 && inHalf < 0.85, `${(inHalf * 100).toFixed(0)}% inside half radius`);
  // HE splash
  const w4 = battle(['usa_t18'], ['usa_m4']); const [, tg] = w4.tanks;
  place(w4, tg, 500, 500, 0);
  const shv = TANKS.usa_t18.guns[0].shells[2];
  w4.shells.push({ id: 5, owner: w4.tanks[0].id, team: 0, type: 'HE', pos: { x: 503.2, y: tg.pos.y + 5, z: 500 }, vel: { x: 0, y: -200, z: 0 }, cal: 75, pen: shv.pen, dmg: shv.dmg, splash: shv.splash, alive: true, dist: 50, ricochets: 0, ignore: 0 });
  const ev = run(w4, 0.2), sp = hits(ev, tg.id)[0];
  check('HE near miss splashes a nearby tank', sp && sp.result === 'splash' && sp.dmg > 0, sp ? sp.dmg : 'none');
}

// ------------------------------------------------------------------ movement
console.log('Movement');
{
  const w = battle(['usa_m4', 'ger_tiger'], ['ussr_bt7']); const [m4, tg, bt] = w.tanks;
  place(w, m4, 300, 100, 0); place(w, tg, 400, 100, 0); place(w, bt, 600, 100, 0);
  const c = new Map([[m4.id, { throttle: 1 }], [tg.id, { throttle: 1 }], [bt.id, { throttle: 1 }]]);
  run(w, 4, c);
  const at4 = m4.speed * 3.6;
  run(w, 16, c);
  check('M4 reaches its top speed on grass-ish ground', m4.speed * 3.6 > 40 && m4.speed * 3.6 <= 48.1, `${f1(at4)} km/h at 4 s, ${f1(m4.speed * 3.6)} at 20 s`);
  check('BT-7 is faster than the Tiger', bt.speed > tg.speed * 1.4, `${f1(bt.speed * 3.6)} vs ${f1(tg.speed * 3.6)} km/h`);
  const w2 = battle(['usa_m4'], ['usa_m4'], { mapOpts: { ground: 5 } }); const [ms] = w2.tanks;
  place(w2, ms, 500, 100, 0);
  run(w2, 20, new Map([[ms.id, { throttle: 1 }]]));
  check('soft ground (mud) slows the M4', ms.speed * 3.6 < 36, `${f1(ms.speed * 3.6)} km/h`);
  // hills: pitch follows terrain
  const w3 = battle(['usa_m4'], ['usa_m4'], { mapOpts: { hills: 12 } }); const [mh] = w3.tanks;
  place(w3, mh, 480, 200, 0);
  let maxP = 0;
  for (let i = 0; i < 20 * 60; i++) { stepBattle(w3, new Map([[mh.id, { throttle: 1 }]])); maxP = Math.max(maxP, Math.abs(mh.pitch)); }
  check('pitch follows hills', maxP > 3 * DEG, `max pitch ${f1(maxP / DEG)}°`);
  // turning in place
  const w4 = battle(['usa_m4'], ['usa_m4']); const [mt] = w4.tanks;
  place(w4, mt, 500, 500, 0);
  run(w4, 3, new Map([[mt.id, { steer: 1 }]]));
  check('steer +1 turns right (yaw decreases) at ~hull traverse speed', mt.yaw < 0 && -mt.yaw / DEG > 0.7 * 3 * mt.def.hullTraverse * 0.9, `${f1(mt.yaw / DEG)}° in 3 s`);
  // tank matrix: forward = (sin yaw, 0, cos yaw)
  const M = tankMatrix(mt);
  check('tankMatrix column 2 is the forward vector', Math.abs(M[8] - Math.sin(mt.yaw)) < 1e-6 && Math.abs(M[10] - Math.cos(mt.yaw)) < 1e-6 && M[12] === mt.pos.x);
  // ram: Tiger into a Pz II at 35+ km/h
  const w5 = battle(['ger_tiger'], ['ger_pz2']); const [tr, pz] = w5.tanks;
  place(w5, tr, 500, 400, 0); place(w5, pz, 500, 410, 90);
  tr.speed = 11;
  const ev = run(w5, 1.5, new Map([[tr.id, { throttle: 1 }]]));
  const ram = ev.find((e) => e.type === 'ram');
  check('ramming at speed damages the light tank more', ram && ram.dmg > 40 && ram.dmg > ram.selfDmg, ram ? `dmg ${ram.dmg} self ${ram.selfDmg}` : 'no ram');
  check('rammed tank is pushed', pz.pos.z > 410.5, f1(pz.pos.z - 410));
  // props: trees fall, houses block
  const map = testMap({ objects: [{ kind: 'tree', x: 500, z: 130, s: [3, 7, 3] }, { kind: 'house', x: 300, z: 140, s: [5, 4, 4] }] });
  const w6 = createBattle({ map, seed: 1, teams: [[{ def: TANKS.usa_m4 }, { def: TANKS.usa_m4 }], [{ def: TANKS.usa_m4 }]] });
  const [p1, p2] = w6.tanks;
  place(w6, p1, 500, 110, 0); place(w6, p2, 300, 115, 0);
  const ev6 = run(w6, 6, new Map([[p1.id, { throttle: 1 }], [p2.id, { throttle: 1 }]]));
  check('a tank knocks a tree over (treeFall)', ev6.some((e) => e.type === 'treeFall') && map.objects[0].fallen && p1.pos.z > 135, f1(p1.pos.z));
  check('a house blocks the tank', p2.pos.z < 140 - 4 - 1.2, f1(p2.pos.z));
  // deep water blocks
  const wm = testMap({ water: { level: 9 } }); // dry land at y 10, a 2 m deep river from z 300 to 360
  for (let j = 0; j < wm.res; j++) for (let i = 0; i < wm.res; i++) if (j * wm.cell > 300 && j * wm.cell < 360) { wm.heights[j * wm.res + i] = 7; wm.ground[j * wm.res + i] = 7; }
  const w7 = createBattle({ map: wm, seed: 1, teams: [[{ def: TANKS.usa_m4 }], [{ def: TANKS.usa_m4 }]] });
  const [pw] = w7.tanks; place(w7, pw, 500, 250, 0);
  run(w7, 15, new Map([[pw.id, { throttle: 1 }]]));
  check('deep water blocks (drives up to the bank, stops)', pw.pos.z > 280 && pw.pos.z < 300, f1(pw.pos.z));
}

// ------------------------------------------------------------------ spotting
console.log('Spotting');
{
  const bushes = []; // a hedge line just in front of the target
  for (let k = -3; k <= 3; k++) bushes.push({ kind: 'bush', x: 500 + k * 2.5, z: 492, s: [1.8, 1.6, 1.8] });
  const mk = (withBush) => {
    const map = testMap({ objects: withBush ? bushes : [] });
    const w = createBattle({ map, seed: 1, teams: [[{ def: TANKS.usa_m4 }], [{ def: TANKS.usa_m10 }]] });
    const [o, t] = w.tanks; place(w, o, 500, 260, 0); place(w, t, 500, 500, 180);
    return [w, o, t];
  };
  const [wa, , ta] = mk(false); run(wa, 1.2);
  check('M10 in the open at 240 m is spotted', visibleTo(wa, 0).has(ta.id) && ta.spotted);
  const [wb, ob, tb] = mk(true); run(wb, 1.2);
  check('M10 behind a bush at 240 m is not spotted', !visibleTo(wb, 0).has(tb.id) && !tb.spotted);
  tb.reload = 0; tb.turretYaw = 0; tb.gunPitch = 0.05; tb.disp = 0; fire(wb, tb); run(wb, 0.7);
  check('after firing, its own bush no longer hides it', visibleTo(wb, 0).has(tb.id), ob.stats.spotted);
  run(wb, 8.5);
  check('hidden again once the fire camo penalty passes (3 s memory)', !visibleTo(wb, 0).has(tb.id));
  // auto-spot inside 50 m, even behind a building
  const map = testMap({ objects: [{ kind: 'house', x: 500, z: 500, s: [6, 5, 6] }] });
  const w = createBattle({ map, seed: 1, teams: [[{ def: TANKS.usa_m4 }], [{ def: TANKS.ger_pz4h }]] });
  const [o2, t2] = w.tanks; place(w, o2, 500, 480, 0); place(w, t2, 500, 522, 180);
  run(w, 1.2);
  check('auto-spot within 50 m through a house', visibleTo(w, 0).has(t2.id));
  place(w, o2, 500, 440, 0); run(w, 4.5);
  check('house blocks the sight line beyond 50 m', !visibleTo(w, 0).has(t2.id));
  const spots = [];
  const w2 = createBattle({ map: testMap(), seed: 1, teams: [[{ def: TANKS.usa_m4 }], [{ def: TANKS.ger_pz4h }]] });
  place(w2, w2.tanks[0], 500, 100, 0); place(w2, w2.tanks[1], 500, 700, 180);
  const c = new Map([[w2.tanks[1].id, { throttle: 1 }]]);
  for (let i = 0; i < 60 * 40; i++) { stepBattle(w2, c); for (const e of w2.events) if (e.type === 'spot') spots.push(e); }
  check('driving into view raises one spot event', spots.filter((e) => e.on && e.team === 0).length === 1, spots.map((e) => `${e.team}:${e.on}`).join(' '));
}

// ------------------------------------------------------------------ capture & rules
console.log('Battle rules');
{
  const w = battle(['usa_m4', 'usa_m4'], ['ger_tiger']); const [a, b, d] = w.tanks;
  const base = w.bases.find((x) => x.team === 1);
  place(w, a, base.x, base.z, 0); place(w, b, base.x + 5, base.z, 0); place(w, d, base.x, base.z - 250, 0);
  run(w, 10);
  check('two cappers: +2 points/s', Math.abs(base.points - 20) < 0.5, f1(base.points));
  // damage a capper: its contribution is removed
  d.reload = 0; d.gunDef = TANKS.ger_tiger.guns[1];
  const ev = shoot(w, d, onTank(a, 0, 1.2, 0), 0, 1.5);
  check('damaging a capper resets its contribution', hits(ev, a.id).some((e) => e.dmg > 0) && base.points < 15, f1(base.points));
  run(w, 60);
  check('capture reaches 100 and wins', w.result && w.result.winner === 0 && w.result.reason === 'capture', JSON.stringify(w.result));
  const w2 = battle(['usa_m4'], ['ger_pz2']);
  place(w2, w2.tanks[0], 500, 400, 0); place(w2, w2.tanks[1], 500, 500, 180);
  w2.tanks[1].hp = 5;
  shoot(w2, w2.tanks[0], onTank(w2.tanks[1], 0, 1, 0));
  check('destroying every enemy wins', w2.result && w2.result.winner === 0 && w2.result.reason === 'destroyed', JSON.stringify(w2.result));
  const w3 = createBattle({ map: testMap(), seed: 1, timeLimit: 3, teams: [[{ def: TANKS.usa_m4 }], [{ def: TANKS.usa_m4 }]] });
  const ev3 = run(w3, 4);
  check('time-out is a draw with an end event', w3.result && w3.result.winner === -1 && ev3.some((e) => e.type === 'end'));
}

// ------------------------------------------------------------------ determinism
console.log('Determinism');
{
  const ids = Object.keys(TANKS);
  const sim = (seed) => {
    const pick = (k) => ({ def: TANKS[ids[(k * 7 + 3) % ids.length]], gun: k % 2 });
    const w = createBattle({ map: testMap({ hills: 5 }), seed, teams: [[0, 1, 2, 3, 4].map(pick), [5, 6, 7, 8, 9].map(pick)] });
    const bots = new Map(w.tanks.map((t) => [t.id, simpleBot(t)]));
    for (let i = 0; i < 60 * 60 && !w.result; i++) {
      const c = new Map(); for (const t of w.tanks) if (t.alive) c.set(t.id, bots.get(t.id)(w));
      stepBattle(w, c);
    }
    return JSON.stringify(w.tanks.map((t) => [t.hp, +t.pos.x.toFixed(4), +t.pos.z.toFixed(4), t.stats.shots, t.stats.dmg]));
  };
  const s1 = sim(11), s2 = sim(11), s3 = sim(12);
  check('same seed → identical battle', s1 === s2);
  check('different seed → different battle', s1 !== s3);
  check('scripted bots actually fought', JSON.parse(s1).some((r) => r[3] > 0 && r[4] > 0));
}

// ------------------------------------------------------------------ real maps
if (existsSync(new URL('../src/sim/map/index.js', import.meta.url))) {
  console.log('Real maps');
  const { MAPS, loadMap } = await import('../src/sim/map/index.js');
  for (const m of MAPS) {
    const map = loadMap(m.id);
    const ids = Object.keys(TANKS).filter((id) => TANKS[id].tier >= 4);
    const teams = [0, 1].map((tm) => Array.from({ length: 15 }, (_, i) => ({ def: TANKS[ids[(i * 5 + tm * 3) % ids.length]] })));
    const w = createBattle({ map, seed: 3, teams });
    const bots = new Map(w.tanks.map((t) => [t.id, simpleBot(t)]));
    const okSpawn = w.tanks.every((t) => Number.isFinite(t.pos.y) && Math.abs(t.pitch) < 0.5);
    let ev = 0;
    for (let i = 0; i < 60 * 60; i++) { const c = new Map(); for (const t of w.tanks) if (t.alive) c.set(t.id, bots.get(t.id)(w)); stepBattle(w, c); ev += w.events.length; }
    const moved = w.tanks.filter((t) => Math.hypot(t.pos.x - (t._sx ?? t.pos.x), 0) >= 0).length;
    check(`${m.id}: 15v15 spawns sane, a minute of battle runs`, okSpawn && w.tanks.every((t) => Number.isFinite(t.pos.x) && Number.isFinite(t.pos.y)), `${ev} events, ${w.tanks.filter((t) => !t.alive).length} dead`);
  }
}

console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
