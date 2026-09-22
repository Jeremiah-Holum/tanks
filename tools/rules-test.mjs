// Headless rules tests. node tools/rules-test.mjs — exits non-zero on any failure.
import { createWorld, step, DT, CELL, HULL_L, HULL_W, SHELL_R, BARREL, teamSees, updateIntel, RICOCHET_ANGLE } from '../src/sim/world.js';
import { CLASSES } from '../src/sim/tanks.js';

let fails = 0, passes = 0;
const check = (name, ok, info = '') => {
  if (ok) { passes++; console.log('  ok   ' + name + (info ? '  (' + info + ')' : '')); }
  else { fails++; console.log('  FAIL ' + name + (info ? '  (' + info + ')' : '')); }
};

// An open 30×12 arena with a block column at x=20 and a crate at (20, 3); spawn digits 0,5,1.
function arena(extraRows = null) {
  const rows = [];
  for (let j = 0; j < 12; j++) {
    let r = '';
    for (let i = 0; i < 30; i++) r += i === 20 && j >= 5 && j <= 8 ? '#' : i === 20 && j === 3 ? 'x' : '.';
    rows.push(r);
  }
  const put = (i, j, ch) => { rows[j] = rows[j].slice(0, i) + ch + rows[j].slice(i + 1); };
  put(2, 1, '0'); put(27, 10, '5'); put(27, 1, '6');
  if (extraRows) extraRows(put);
  return rows;
}
function world(slots, seed = 1) {
  const w = createWorld({ level: arena(), mode: 'versus', seed, slots: slots.map((s, k) => ({ sp: [0, 5, 6][k], ...s })) });
  return w;
}
const place = (t, x, z, rot = 0) => { t.x = x; t.z = z; t._px = x; t._pz = z; t.rot = rot; t.aim = rot; t.ctrl.aim = rot; t.vx = 0; t.vz = 0; };
let sid = 1e6;
function shell(w, owner, x, z, ang, extra = {}) {
  const s = { id: sid++, owner: owner.id, team: owner.team, x, z, dx: Math.cos(ang), dz: Math.sin(ang), speed: 8, pen: owner.type.pen, dmg: owner.type.dmg, rocket: false, cls: owner.type.cls, ricochets: 0, age: 1, alive: true, ignore: null, ignoreT: 0, ...extra };
  w.shells.push(s);
  return s;
}
const run = (w, secs) => { const out = []; for (let k = 0; k < secs / DT && !w.over; k++) { step(w, null); out.push(...w.events); w.events.length = 0; } return out; };

console.log('A3 walls and crates');
{
  const w = world([{ team: 0, cls: 'medium' }, { team: 1, cls: 'medium' }]);
  const [a, b] = w.tanks;
  place(a, 16, 6.5, 0); place(b, 27, 1.5, Math.PI);
  a.cool = 0; a.disp = 0; a.ctrl.fire = true;
  const ev = run(w, 1.5);
  const fire = ev.find((e) => e.type === 'fire'), imp = ev.find((e) => e.type === 'impact');
  check('wall stops shell (impact event, shell dead)', fire && imp && imp.shell === fire.shell && !w.shells.some((s) => s.alive), imp ? `impact at x=${imp.x.toFixed(2)}` : 'no impact');
  check('shell stopped at the wall face, never came back', imp && imp.x > 19.6 && imp.x < 20, imp && imp.x.toFixed(3));
  check('no bounce events', !ev.some((e) => e.type === 'bounce'));
  // crate
  place(a, 16, 3.5, 0); a.cool = 0; a.disp = 0; a.ctrl.aim = 0; a.ctrl.fire = true;
  const ev2 = run(w, 1.5);
  const cb = ev2.find((e) => e.type === 'crateBreak');
  check('crate breaks when shot', cb && cb.i === 20 && cb.j === 3 && w.grid[3 * w.cols + 20] === CELL.FLOOR);
  check('shell stops at the crate', !w.shells.some((s) => s.alive) && !ev2.some((e) => e.type === 'hit'));
  // pit: shells fly over
  w.grid[6 * w.cols + 10] = CELL.PIT;
  place(a, 6, 6.5, 0); a.cool = 0; a.disp = 0; a.ctrl.aim = 0; a.ctrl.fire = true;
  const ev3 = run(w, 3);
  const im3 = ev3.find((e) => e.type === 'impact');
  check('pits do not stop shells', im3 && im3.x > 19.5, im3 && im3.x.toFixed(2));
}

console.log('A4 armour and penetration');
{
  // Light gun into a heavy's front plate, head on: should almost never pen.
  let nopen = 0, pen = 0, other = 0;
  for (let k = 0; k < 60; k++) {
    const w = world([{ team: 0, cls: 'light' }, { team: 1, cls: 'heavy' }], 100 + k);
    const [a, b] = w.tanks;
    place(a, 5, 6.5, 0); place(b, 10, 6.5, Math.PI); // heavy faces the light tank
    shell(w, a, 8.5, 6.5, 0);
    const h = run(w, 0.6).find((e) => e.type === 'hit');
    if (!h) other++; else if (h.result === 'nopen') nopen++; else if (h.result === 'pen') pen++; else other++;
    if (k === 0) check('front-on hit reports face=front', h && h.face === 'front', h && h.face);
  }
  check('light gun vs heavy front, head on: usually no-pen', nopen >= 54 && other === 0, `nopen ${nopen}, pen ${pen}, other ${other}`);
  // Medium gun into a light's side at 90° to the plate: always pens (0° impact angle).
  let pens = 0, dmgSum = 0;
  for (let k = 0; k < 40; k++) {
    const w = world([{ team: 0, cls: 'medium' }, { team: 1, cls: 'light' }], 200 + k);
    const [a, b] = w.tanks;
    place(a, 10, 3, 0); place(b, 10, 6.5, 0); // b faces +x; shell comes from -z onto its side
    shell(w, a, 10, 5, Math.PI / 2);
    const h = run(w, 0.5).find((e) => e.type === 'hit');
    if (h && h.result === 'pen' && h.face === 'side') { pens++; dmgSum += h.dmg; }
  }
  const avg = dmgSum / Math.max(1, pens);
  check('perpendicular side hit penetrates', pens === 40, `pens ${pens}/40`);
  check('pen damage ≈ dmg × 0.8..1.2', avg > CLASSES.medium.dmg * 0.85 && avg < CLASSES.medium.dmg * 1.15, `avg ${avg.toFixed(1)} vs ${CLASSES.medium.dmg}`);
  // Grazing side hit (80° from the plate's normal): ricochet, and it flies on into a second tank.
  const w = world([{ team: 0, cls: 'medium' }, { team: 1, cls: 'medium' }, { team: 1, cls: 'light' }], 7);
  const [a, b, c] = w.tanks;
  place(a, 3, 10, 0); place(b, 10, 6.5, 0);
  const inc = 80 * Math.PI / 180, W = HULL_W + SHELL_R;
  const ang = Math.PI / 2 - inc; // mostly +x with a little +z, meeting the side plate at z = 6.5 - W
  const ex = 10, ez = 6.5 - W;
  place(c, ex + Math.cos(ang) * 5, ez - Math.sin(ang) * 5, Math.PI / 2); // on the reflected path
  const s = shell(w, a, ex - Math.cos(ang) * 1.2, ez - Math.sin(ang) * 1.2, ang);
  const hpB = b.hp, penBefore = s.pen;
  const ev = run(w, 1.5);
  const hits = ev.filter((e) => e.type === 'hit');
  check('grazing side hit (80°) ricochets', hits[0] && hits[0].tank === b.id && hits[0].result === 'ricochet' && hits[0].face === 'side' && b.hp === hpB, hits[0] && `${hits[0].result} ${hits[0].face}`);
  check('ricochet angle threshold is 70°', Math.abs(RICOCHET_ANGLE - 70 * Math.PI / 180) < 1e-9);
  check('ricocheted shell keeps flying with 70% pen', Math.abs(s.pen - penBefore * 0.7) < 1e-6 && s.ricochets === 1);
  check('ricocheted shell hits a second tank', hits[1] && hits[1].tank === c.id, hits[1] ? `${hits[1].result} on ${hits[1].face}` : 'no second hit');
  // Self-hit grace: a fresh shell spawned inside the owner does not hit it.
  const w2 = world([{ team: 0, cls: 'medium' }, { team: 1, cls: 'medium' }]);
  const [p] = w2.tanks; place(p, 5, 6.5, 0);
  shell(w2, p, 5.3, 6.5, 0, { age: 0 });
  check('self-hit grace', !run(w2, 0.3).some((e) => e.type === 'hit'));
}

console.log('A5 modules');
{
  // Tracks: side pens until one rolls tracks; then the tank can't drive for ~3 s but can traverse.
  let got = null;
  for (let k = 0; k < 80 && !got; k++) {
    const w = world([{ team: 0, cls: 'td' }, { team: 1, cls: 'heavy' }], 300 + k);
    const [a, b] = w.tanks;
    place(a, 10, 3, 0); place(b, 10, 6.5, 0);
    shell(w, a, 10, 5, Math.PI / 2);
    const h = run(w, 0.4).find((e) => e.type === 'hit');
    if (h && h.module === 'tracks') got = { w, b };
  }
  check('side pens can knock out tracks', !!got);
  if (got) {
    const { w, b } = got;
    const x0 = b.x, a0 = b.aim;
    b.ctrl.mx = 1; b.ctrl.mz = 0; b.ctrl.aim = a0 + 1.5;
    for (let k = 0; k < 60; k++) { b.ctrl.mx = 0; b.ctrl.mz = 1; step(w, null); }
    check('tracked tank cannot drive', Math.abs(b.x - x0) < 1e-6 && b.modules.tracks > 0, `moved ${Math.abs(b.x - x0).toFixed(3)}`);
    check('tracked tank can still traverse its turret', Math.abs(b.aim - a0) > 0.3);
    for (let k = 0; k < 150; k++) { b.ctrl.mx = 0; b.ctrl.mz = 1; step(w, null); }
    check('tracks repaired after ~3 s', b.modules.tracks === 0 && Math.hypot(b.x - x0, b.z - 6.5) > 0.2);
  }
  // Fire: rear pens until engine catches fire; fire burns hp over time with fireTick events.
  let fw = null;
  for (let k = 0; k < 200 && !fw; k++) {
    const w = world([{ team: 0, cls: 'td' }, { team: 1, cls: 'heavy' }], 500 + k);
    const [a, b] = w.tanks;
    place(a, 3, 6.5, 0); place(b, 10, 6.5, 0); // b faces away: shell hits its rear
    shell(w, a, 8.5, 6.5, 0);
    const h = run(w, 0.4).find((e) => e.type === 'hit');
    if (h && h.face === 'rear' && h.module === 'fire') fw = { w, b };
  }
  check('rear pens can set the engine on fire', !!fw);
  if (fw) {
    const { w, b } = fw;
    const hp0 = b.hp;
    const ev = run(w, 2);
    const ticks = ev.filter((e) => e.type === 'fireTick' && e.tank === b.id).length;
    check('fire does damage over time', hp0 - b.hp > 7 && hp0 - b.hp < 9, `lost ${(hp0 - b.hp).toFixed(2)} hp in 2 s`);
    check('fire emits fireTick', ticks >= 3, `${ticks} ticks`);
    check('engine hit slows the tank', b.modules.engine === true);
    run(w, 4);
    check('fire burns out', b.modules.fire === 0);
  }
  // Mines: centre ≈110 damage + tracks.
  const w = world([{ team: 0, cls: 'heavy' }, { team: 1, cls: 'heavy' }]);
  const [a, b] = w.tanks; place(a, 3, 3, 0); place(b, 10, 6.5, 0);
  w.mines.push({ id: 9e6, owner: a.id, team: a.team, x: 10, z: 6.5, t: 9.99, alive: true, armed: true, trigger: -1 });
  const hp0 = b.hp; const ev = run(w, 0.2);
  const mh = ev.find((e) => e.type === 'hit' && e.tank === b.id);
  check('mine hit ≈110 at centre with tracks', mh && hp0 - b.hp >= 105 && hp0 - b.hp <= 111 && b.modules.tracks > 0, `${hp0 - b.hp}`);
}

console.log('A7 dispersion');
{
  const w = world([{ team: 0, cls: 'medium' }, { team: 1, cls: 'medium' }]);
  const [a] = w.tanks; place(a, 4, 3, 0);
  const base = a.type.dispBase;
  for (let k = 0; k < 60; k++) { a.ctrl.mx = 1; a.ctrl.mz = 0; step(w, null); }
  const moving = a.disp;
  a.ctrl.mx = 0;
  for (let k = 0; k < 60 * 4; k++) step(w, null);
  check('moving blooms dispersion', moving > base * 1.8, `${moving.toFixed(4)} vs base ${base}`);
  check('standing still settles dispersion', a.disp < base * 1.1, `${a.disp.toFixed(4)} after 4 s`);
  a.ctrl.aim = a.aim + 2;
  for (let k = 0; k < 20; k++) step(w, null);
  check('turret traverse blooms dispersion', a.disp > base * 1.5, a.disp.toFixed(4));
  // spread of fired shells ≈ disp/2 sd
  let sum2 = 0, n = 0;
  for (let k = 0; k < 200; k++) {
    const w2 = world([{ team: 0, cls: 'medium' }, { team: 1, cls: 'medium' }], 900 + k);
    const [p] = w2.tanks; place(p, 4, 3, 0); p.disp = 0.1; p.cool = 0; p.ctrl.fire = true;
    step(w2, null);
    const f = w2.events.find((e) => e.type === 'fire'); if (f) { sum2 += f.angle ** 2; n++; }
  }
  const sd = Math.sqrt(sum2 / n);
  check('shot spread sd ≈ disp × 0.5', sd > 0.04 && sd < 0.06, `sd ${sd.toFixed(4)} for disp 0.1`);
}

console.log('A8 spotting');
{
  const v = createWorld({ level: arena(), mode: 'versus', seed: 3, slots: [{ team: 0, cls: 'medium', sp: 0 }, { team: 1, kit: 'ghost', sp: 5 }, { team: 1, kit: 'grunt', sp: 6 }] });
  const [me, ghost, grunt] = v.tanks;
  place(me, 4, 10.5, 0); place(ghost, 12, 10.5, Math.PI); place(grunt, 12, 1.5, Math.PI);
  updateIntel(v, true);
  check('normal tank at 8 cells in the open is spotted', teamSees(v, 0, grunt.id));
  check('ghost at 8 cells in the open is NOT spotted', !teamSees(v, 0, ghost.id));
  place(ghost, 6, 10.5, Math.PI); updateIntel(v, true);
  check('ghost within 2.6 is spotted', teamSees(v, 0, ghost.id));
  place(ghost, 12, 10.5, Math.PI); v.time += 0; ghost.cool = 0; ghost.ctrl.fire = true; ghost.ctrl.aim = Math.PI / 2; ghost.aim = Math.PI / 2;
  step(v, null); updateIntel(v, true);
  check('ghost that just fired is spotted at range', teamSees(v, 0, ghost.id));
  for (let k = 0; k < 90; k++) step(v, null);
  updateIntel(v, true);
  check('…and fades again ~1 s later', !teamSees(v, 0, ghost.id));
  place(grunt, 24, 6.5, Math.PI); place(me, 16, 6.5, 0); updateIntel(v, true);
  check('tank behind a block is not spotted', !teamSees(v, 0, grunt.id));
  check('the lead survives as last-known (not visible)', v.intel[0][grunt.id] && v.intel[0][grunt.id].vis === -1);
}

console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
