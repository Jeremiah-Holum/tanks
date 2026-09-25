// Sim benchmark: 15v15 with a trivial scripted controller (src/sim/testmap.js simpleBot) on the
// test map and every real map. Reports stepBattle ms/step (controller time excluded), how the
// battle ended, and some battle stats. Budget: < 2 ms/step average.
//   node tools/bench-sim.mjs            full battles (until a result or the 15 min limit)
//   node tools/bench-sim.mjs --quick    3 simulated minutes per map
import { TANKS } from '../src/data/tanks.js';
import { createBattle, stepBattle } from '../src/sim/battle.js';
import { testMap, simpleBot } from '../src/sim/testmap.js';
import { existsSync } from 'fs';
import { performance } from 'perf_hooks';

const quick = process.argv.includes('--quick');
const maxSteps = quick ? 60 * 180 : Infinity;
const maps = [['test', () => testMap({ hills: 6 })]];
if (existsSync(new URL('../src/sim/map/index.js', import.meta.url))) {
  const { MAPS, loadMap } = await import('../src/sim/map/index.js');
  for (const m of MAPS) maps.push([m.id, () => loadMap(m.id)]);
}

// Mixed tier V–VII teams, mirrored classes.
const pool = Object.values(TANKS).filter((d) => d.tier >= 5);
const team = (off) => Array.from({ length: 15 }, (_, i) => ({ def: pool[(i * 7 + off) % pool.length], gun: i % 2, crewSkill: 0.75 + (i % 4) * 0.08 }));

let worstAvg = 0, allEnded = true;
for (const [id, make] of maps) {
  const t0 = performance.now();
  const map = make();
  const tLoad = performance.now() - t0;
  const w = createBattle({ map, seed: 42, timeLimit: 900, teams: [team(0), team(3)] });
  const bots = new Map(w.tanks.map((t) => [t.id, simpleBot(t)]));
  const ctrl = new Map();
  let simMs = 0, worst = 0, steps = 0, shots = 0, hits = 0, pens = 0, rics = 0, fires = 0, racks = 0, falls = 0;
  while (!w.result && steps < maxSteps) {
    ctrl.clear();
    for (const t of w.tanks) if (t.alive) ctrl.set(t.id, bots.get(t.id)(w));
    const a = performance.now();
    stepBattle(w, ctrl);
    const ms = performance.now() - a;
    simMs += ms; if (ms > worst && steps > 10) worst = ms; steps++;
    for (const e of w.events) {
      if (e.type === 'shot') shots++;
      else if (e.type === 'hit') { hits++; if (e.result === 'pen') pens++; if (e.result === 'ricochet') rics++; }
      else if (e.type === 'fire' && e.on) fires++;
      else if (e.type === 'kill' && e.cause === 'ammorack') racks++;
      else if (e.type === 'treeFall') falls++;
    }
  }
  const avg = simMs / steps;
  worstAvg = Math.max(worstAvg, avg);
  if (!quick && !w.result) allEnded = false;
  const dead = [0, 1].map((k) => w.tanks.filter((t) => t.team === k && !t.alive).length);
  const res = w.result ? `${w.result.reason} → ${w.result.winner < 0 ? 'draw' : 'team ' + w.result.winner} at ${(w.result.time / 60).toFixed(1)} min` : `running at ${(w.time / 60).toFixed(1)} min`;
  console.log(`${id.padEnd(8)} load ${tLoad.toFixed(0).padStart(4)} ms | step avg ${avg.toFixed(3)} ms, worst ${worst.toFixed(2)} ms over ${steps} steps | ${res} | dead ${dead[0]}:${dead[1]} | shots ${shots} hits ${hits} pens ${pens} rico ${rics} fires ${fires} racks ${racks} trees ${falls}`);
}
console.log(`\nworst average ${worstAvg.toFixed(3)} ms/step (budget 2 ms) — ${worstAvg < 2 ? 'OK' : 'OVER BUDGET'}${quick ? '' : allEnded ? ', every battle ended' : ', SOME BATTLES DID NOT END'}`);
process.exit(worstAvg < 2 && allEnded ? 0 : 1);
