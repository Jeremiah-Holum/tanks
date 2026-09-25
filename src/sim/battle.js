// Battle: creation, the fixed-step loop and the standard-battle rules (docs/DESIGN.md "Simulation").
// Pure JS, deterministic for a given seed (all randomness goes through world.rng).
import { createTank } from './tank.js';
import { moveTank, collideTanks, settle } from './move.js';
import { updateGun } from './gunnery.js';
import { stepShells } from './ballistics.js';
import { tickDamage, useConsumable } from './damage.js';
import { scanTeam, SPOT_PERIOD } from './spotting.js';

export const DT = 1 / 60;
const CAP_RATE = 1, CAP_MAX_CAPPERS = 3, CAP_DECAY_T = 5;
const IDLE = { throttle: 0, steer: 0, brake: false, aim: null, lockGun: true, fire: false, shell: null, use: null };

// Small fast seeded PRNG (mulberry32) → () => [0, 1).
export function makeRng(seed) {
  let a = (seed >>> 0) || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createBattle({ map, seed = 1, timeLimit = 900, mode = 'standard', teams }) {
  const world = {
    time: 0, step: 0, map, tanks: [], shells: [], events: [], result: null, mode,
    bases: (map.bases || []).map((b) => ({ team: b.team, x: b.x, z: b.z, r: b.r || 45, points: 0, cappers: [], contrib: {}, idle: 0 })),
    timeLimit, seed, rng: makeRng(seed), byId: {}, visible: [new Set(), new Set()], nextShell: 1, _rams: new Map(),
  };
  let id = 1;
  teams.forEach((list, team) => list.forEach((entry, i) => {
    const sp = (map.spawns && map.spawns[team] && map.spawns[team][i % map.spawns[team].length]) || { x: map.size / 2, z: map.size / 2, yaw: 0 };
    const t = createTank(id++, team, entry, sp);
    // point the turret at the enemy side of the map
    settle(map, t);
    world.tanks.push(t); world.byId[t.id] = t;
    world.visible[team].add(t.id);
  }));
  return world;
}

// One fixed step. controls: Map<tankId, Controls> (missing = idle).
export function stepBattle(world, controls) {
  world.events.length = 0;
  if (world.result) return world;
  const dt = DT;
  world.time += dt; world.step++;
  for (const t of world.tanks) {
    const c = (t.alive && controls && controls.get(t.id)) || IDLE;
    if (t.alive) {
      if (c.use) useConsumable(world, t, c.use);
      updateGun(world, t, c, dt);
    }
    moveTank(world, t, t.alive ? c : IDLE, dt);
  }
  collideTanks(world, dt);
  stepShells(world, dt);
  for (const t of world.tanks) if (t.alive) tickDamage(world, t, dt);
  // Spotting: team 0 on the period, team 1 half a period later.
  const per = Math.round(SPOT_PERIOD / dt);
  if (world.step % per === 1) scanTeam(world, 0);
  if (world.step % per === (1 + (per >> 1)) % per) scanTeam(world, 1);
  rules(world, dt);
  return world;
}

// Capture, victory and time-out.
function rules(world, dt) {
  for (const b of world.bases) {
    const cappers = [];
    for (const t of world.tanks) {
      if (!t.alive || t.team === b.team) continue;
      const dx = t.pos.x - b.x, dz = t.pos.z - b.z;
      if (dx * dx + dz * dz <= b.r * b.r) cappers.push(t);
    }
    b.cappers = cappers.map((t) => t.id);
    if (cappers.length) {
      b.idle = 0;
      const before = Math.floor(b.points);
      const n = Math.min(CAP_MAX_CAPPERS, cappers.length), gain = Math.min(100 - b.points, CAP_RATE * n * dt);
      b.points += gain;
      for (const t of cappers.slice(0, n)) { const g = gain / n; b.contrib[t.id] = (b.contrib[t.id] || 0) + g; t.stats.capture += g; }
      if (Math.floor(b.points) !== before) world.events.push({ type: 'capture', team: 1 - b.team, base: b.team, points: Math.floor(b.points) });
      if (b.points >= 100) return finish(world, 1 - b.team, 'capture');
    } else if (b.points > 0) {
      b.idle += dt;
      if (b.idle > CAP_DECAY_T) { b.points = 0; b.contrib = {}; world.events.push({ type: 'capture', team: 1 - b.team, base: b.team, points: 0 }); }
    }
  }
  const alive = [0, 0];
  for (const t of world.tanks) if (t.alive) alive[t.team]++;
  if (!alive[0] || !alive[1]) return finish(world, !alive[0] && !alive[1] ? -1 : alive[0] ? 0 : 1, 'destroyed');
  if (world.time >= world.timeLimit) return finish(world, -1, 'time');
}

function finish(world, winner, reason) {
  world.result = { winner, reason, time: world.time };
  world.events.push({ type: 'end', result: world.result });
}

export { IDLE };
// One-stop exports for the HUD, camera and AI.
export { tankMatrix, muzzle, hullToWorld, worldToHull, turretToWorld, eyePos } from './tank.js';
export { aimSolution, predictImpact, penPreview, curShell, gunArc } from './gunnery.js';
export { visibleTo, viewRange, camoOf } from './spotting.js';
