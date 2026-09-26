// Spotting (docs/DESIGN.md "Spotting"): each team scans every 0.5 s (the two teams are staggered
// by 0.25 s). Observer at turret-top height; target points on hull and turret; clear sight
// line against terrain and solid props; effective range view · (1 − camo); auto-spot inside
// 50 m; hard cap 445 m; a spotted tank stays visible 3 s after its last sighting.
import { lineClear, foliageAlong } from './map/query.js';
import { eyePos, turretToWorld, hullToWorld } from './tank.js';
import { crewOk } from './damage.js';

export const SPOT_PERIOD = 0.5, SPOT_MEMORY = 3, AUTO_SPOT = 50, MAX_SPOT = 445, FIRE_CAMO_T = 5;

// Effective view range of an observer (crew adjusted).
export function viewRange(t) {
  const s = 0.9 + 0.1 * (t.crewSkill ?? 1);
  return t.def.view * s * (crewOk(t, 'commander') ? 1 : 0.9) * (crewOk(t, 'radioman') ? 1 : 0.88);
}
// Camo factor of a tank right now (0..1), without foliage.
export function camoOf(world, t) {
  const c = t.def.camo;
  let k = Math.abs(t.speed) > 0.4 || Math.abs(t.yawRate) > 0.05 ? c.moving : c.still;
  if (world.time - t.lastShot < FIRE_CAMO_T) k *= c.fire;
  return k;
}

const _e = {}, _p = {};
// Can observer `o` see target `t` now? Returns true/false.
export function canSee(world, o, t) {
  eyePos(o, _e);
  const dx = t.pos.x - _e.x, dy = t.pos.y + t.cy - _e.y, dz = t.pos.z - _e.z;
  const d2 = dx * dx + dy * dy + dz * dz;
  if (d2 > MAX_SPOT * MAX_SPOT) return false;
  const pts = targetPoints(t);
  if (d2 <= AUTO_SPOT * AUTO_SPOT) return true;
  const base = camoOf(world, t), vr = viewRange(o);
  const d = Math.sqrt(d2);
  if (d > vr * (1 - base)) return false;
  const fired = world.time - t.lastShot < FIRE_CAMO_T;
  for (const p of pts) {
    if (!lineClear(world.map, _e, p)) continue;
    const f = foliageAlong(world.map, _e, p);
    const fol = fired ? f.far : f.amount;
    const camo = 1 - (1 - base) * (1 - fol);
    if (d <= vr * (1 - Math.min(0.95, camo))) return true;
  }
  return false;
}
// Hull centre, turret top, front and rear of the hull (world space).
function targetPoints(t) {
  const h = t.def.hull, mid = h.clr + h.H * 0.6;
  if (!t._pts) t._pts = [{}, {}, {}, {}];
  const P = t._pts;
  turretToWorld(t, 0, t.def.turret.H * 0.8, 0, P[0], 0);
  hullToWorld(t, 0, mid, 0, P[1]);
  hullToWorld(t, 0, mid, h.L * 0.45, P[2]);
  hullToWorld(t, 0, mid, -h.L * 0.45, P[3]);
  return P;
}

// Run one team's scan: updates lastSeen, spottedBy, spot events, stats, visibility sets.
export function scanTeam(world, team) {
  const now = world.time, enemy = 1 - team;
  const obs = world.tanks.filter((t) => t.team === team && t.alive);
  const vis = world.visible[team];
  for (const t of world.tanks) {
    if (t.team === team) continue;
    if (t.alive) {
      for (const o of obs) {
        if (!canSee(world, o, t)) continue;
        if (t.lastSeen[team] < 0) o.stats.spotted++; // first sighting this battle
        // the first spotter keeps the credit (assist) until the target is lost
        if (!vis.has(t.id) || !t.spottedBy[team]) t.spottedBy[team] = o.id;
        t.lastSeen[team] = now;
        break;
      }
    }
    const on = !t.alive || now - t.lastSeen[team] <= SPOT_MEMORY;
    const was = vis.has(t.id);
    if (on && !was) { vis.add(t.id); if (t.alive) world.events.push({ type: 'spot', team, tank: t.id, on: true }); }
    else if (!on && was) { vis.delete(t.id); t.spottedBy[team] = 0; world.events.push({ type: 'spot', team, tank: t.id, on: false }); }
    if (t.team === enemy) t.spotted = t.alive && vis.has(t.id);
  }
}

// visibleTo(world, team) → Set<id>: own team, every wreck, and currently spotted enemies.
export function visibleTo(world, team) { return world.visible[team]; }
