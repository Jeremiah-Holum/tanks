// Battle: creation, the fixed-step loop and the standard-battle rules (docs/DESIGN.md "Simulation").
// Pure JS, deterministic for a given seed (all randomness goes through world.rng).
import { createTank } from './tank.js';
import { moveTank, collideTanks, settle } from './move.js';
import { updateGun } from './gunnery.js';
import { stepShells } from './ballistics.js';
import { tickDamage, useConsumable } from './damage.js';
import { scanTeam, SPOT_PERIOD } from './spotting.js';

export const DT = 1 / 60;
// Base capture: points per second per capper, cappers that count, seconds without cappers before reset.
export const CAPTURE = { rate: 2, max: 3, decay: 5 };   // rate 2 (was 1): 3 deploys per side, battles must still end (docs/notes/sim.md)
// Deploys (owner: "we should only get to choose 3 throughout the course of the game"): every
// player and every bot may put at most MAX_DEPLOYS tanks into one battle (the start + 2 respawns).
export const MAX_DEPLOYS = 3;
export const BOT_RESPAWN_DELAY = 6;   // s from a bot's death to its next tank (the player's picker is 5 s)
// Wreck cap: with respawns up to ~90 tanks die per battle. Beyond WRECK_MAX wrecks the oldest is
// cleared (t.gone: no collision, no shell hits, not drawn; its stats stay). Deterministic.
export const WRECK_MAX = 10;
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

// reserve (optional): [[Entry], [Entry]]: the player's remaining lineup tanks (respawnTank()).
// Entry.spares (optional, bots): the tanks that bot respawns in, in order (the sim brings them in
// BOT_RESPAWN_DELAY s after each death). Each starting tank is a "slot" (world.slots, t.slot = the
// slot id = the first tank's id, t.life = 1..lives) that deploys at most `lives` tanks. A team is
// not defeated while it has a live tank or a spawn left (spawnsLeft).
export function createBattle({ map, seed = 1, timeLimit = 900, mode = 'standard', teams, reserve = null, lives = MAX_DEPLOYS }) {
  const world = {
    time: 0, step: 0, map, tanks: [], shells: [], events: [], result: null, mode,
    bases: (map.bases || []).map((b) => ({ team: b.team, x: b.x, z: b.z, r: b.r || 45, points: 0, cappers: [], contrib: {}, idle: 0 })),
    timeLimit, seed, rng: makeRng(seed), byId: {}, visible: [new Set(), new Set()], nextShell: 1, _rams: new Map(),
    reserve: [0, 1].map((t) => (reserve && reserve[t] ? reserve[t].slice() : [])), nextTank: 1,
    lives: Math.max(1, lives | 0), slots: [], slotOf: {}, wrecks: [],
  };
  let id = 1;
  teams.forEach((list, team) => list.forEach((entry, i) => {
    const sp = (map.spawns && map.spawns[team] && map.spawns[team][i % map.spawns[team].length]) || { x: map.size / 2, z: map.size / 2, yaw: 0 };
    const t = createTank(id++, team, entry, sp);
    // point the turret at the enemy side of the map
    settle(map, t);
    world.tanks.push(t); world.byId[t.id] = t;
    world.visible[team].add(t.id);
    const slot = { id: t.id, team, tank: t.id, used: 1, player: !!entry.player, name: t.name, due: -1,
      spares: entry.player ? null : (entry.spares || []).slice(0, world.lives - 1) };
    world.slots.push(slot); world.slotOf[t.id] = slot;
    t.slot = t.id; t.life = 1;
  }));
  world.nextTank = id;
  return world;
}

// Respawn: take reserve[team][index] into the battle as a new tank at the team's spawn area.
// The spawn point is the map spawn slot farthest from every tank (live or wreck), avoiding
// slots with a live enemy within 150 m. Deterministic. Returns the tank (or null).
export function respawnTank(world, team, index = 0) {
  const list = world.reserve[team], slot = world.slots.find((s) => s.player && s.team === team);
  if (world.result || !list || !list[index] || (slot && slot.used >= world.lives)) return null;
  const entry = list.splice(index, 1)[0];
  const t = deploy(world, team, entry, slot);
  world.events.push({ type: 'respawn', tank: t.id, team });
  return t;
}
// Deploys left for a slot: the player's = min(lives left, lineup tanks left); a bot's = its spares.
export function deploysLeft(world, slot) {
  const pool = slot.player ? world.reserve[slot.team].length : slot.spares.length;
  return Math.max(0, Math.min(world.lives - slot.used, pool));
}
// Spawns a team still has (not counting its live tanks).
export function spawnsLeft(world, team) {
  let n = 0;
  for (const s of world.slots) if (s.team === team) n += deploysLeft(world, s);
  return n;
}
// A new tank for `slot` (or a slot-less one) at the team's safest spawn point.
function deploy(world, team, entry, slot) {
  const map = world.map, spawns = (map.spawns && map.spawns[team] && map.spawns[team].length) ? map.spawns[team] : [{ x: map.size / 2, z: map.size / 2, yaw: 0 }];
  let best = spawns[0], bestS = -Infinity;
  for (const sp of spawns) {
    let near = Infinity, enemy = false;
    for (const o of world.tanks) {
      const d = Math.hypot(o.pos.x - sp.x, o.pos.z - sp.z);
      if (d < near) near = d;
      if (o.alive && o.team !== team && d < 150) enemy = true;
    }
    const s = Math.min(near, 60) - (enemy ? 1000 : 0);
    if (s > bestS) { bestS = s; best = sp; }
  }
  const t = createTank(world.nextTank++, team, entry, best);
  settle(map, t);
  world.tanks.push(t); world.byId[t.id] = t;
  world.visible[team].add(t.id);
  t.spawnedAt = world.time;
  if (slot) { slot.used++; slot.tank = t.id; slot.due = -1; t.slot = slot.id; t.life = slot.used; world.slotOf[t.id] = slot; }
  else { t.slot = t.id; t.life = 1; }
  return t;
}
// Bots: BOT_RESPAWN_DELAY s after a death the slot's next spare comes in (fresh consumables).
function respawnBots(world) {
  for (const s of world.slots) {
    if (s.player || world.byId[s.tank].alive || !deploysLeft(world, s)) continue;
    if (s.due < 0) { s.due = world.time + BOT_RESPAWN_DELAY; continue; }
    if (world.time < s.due) continue;
    const t = deploy(world, s.team, s.spares.shift(), s);
    world.events.push({ type: 'respawn', tank: t.id, team: s.team, bot: true });
  }
}
// Wreck cap: clear the oldest wrecks beyond WRECK_MAX (event 'wreckGone' for the renderer).
function clearWrecks(world) {
  let add = false;
  for (const t of world.tanks) if (!t.alive && !t.wreck) { t.wreck = true; world.wrecks.push(t); add = true; }
  if (!add || world.wrecks.length <= WRECK_MAX) return;
  world.wrecks.sort((a, b) => (a.diedAt ?? 0) - (b.diedAt ?? 0) || a.id - b.id);
  while (world.wrecks.length > WRECK_MAX) {
    const t = world.wrecks.shift();
    t.gone = true; t.speed = 0; world.events.push({ type: 'wreckGone', tank: t.id });
  }
}
// Starting tank (lineup picker during the countdown, before the first step): replace the team's
// player tank with lineup[index], same id and spawn point; world.reserve[team] becomes the other
// lineup entries in lineup order. lineup: every lineup Entry (the one driven now included).
// Only valid while world.step === 0. Deterministic. Returns the new tank (or null).
export function chooseStartTank(world, team, lineup, index) {
  const i = world.tanks.findIndex((t) => t.player && t.team === team);
  if (world.step !== 0 || world.result || i < 0 || !lineup || !lineup[index]) return null;
  const old = world.tanks[i];
  const t = createTank(old.id, team, lineup[index], { x: old.pos.x, z: old.pos.z, yaw: old.yaw });
  settle(world.map, t);
  world.tanks[i] = t; world.byId[t.id] = t;
  t.slot = old.slot ?? t.id; t.life = 1;
  const slot = world.slotOf[t.id];
  if (slot) { slot.name = t.name; }
  world.reserve[team] = lineup.filter((_, k) => k !== index);
  return t;
}
// Give up the remaining respawns (the player left the battle).
export function forfeitReserve(world, team) { if (world.reserve[team]) world.reserve[team].length = 0; }

// One fixed step. controls: Map<tankId, Controls> (missing = idle).
export function stepBattle(world, controls) {
  world.events.length = 0;
  if (world.result) return world;
  const dt = DT;
  world.time += dt; world.step++;
  for (const t of world.tanks) {
    if (t.gone) continue;
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
  clearWrecks(world);
  respawnBots(world);
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
      const n = Math.min(CAPTURE.max, cappers.length), gain = Math.min(100 - b.points, CAPTURE.rate * n * dt);
      b.points += gain;
      for (const t of cappers.slice(0, n)) { const g = gain / n; b.contrib[t.id] = (b.contrib[t.id] || 0) + g; t.stats.capture += g; }
      if (Math.floor(b.points) !== before) world.events.push({ type: 'capture', team: b.team, by: 1 - b.team, points: Math.floor(b.points) });
      if (b.points >= 100) return finish(world, 1 - b.team, 'capture');
    } else if (b.points > 0) {
      b.idle += dt;
      if (b.idle > CAPTURE.decay) { b.points = 0; b.contrib = {}; world.events.push({ type: 'capture', team: b.team, by: 1 - b.team, points: 0 }); }
    }
  }
  const alive = [0, 0];
  for (const t of world.tanks) if (t.alive) alive[t.team]++;
  // a team whose tanks are all destroyed but still has a spawn left is not beaten yet
  for (let k = 0; k < 2; k++) if (!alive[k] && spawnsLeft(world, k)) alive[k] = 1;
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
