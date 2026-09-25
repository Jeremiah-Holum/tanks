// Turret and gun laying, dispersion, firing, and the aim helpers the HUD and AI use.
import { muzzle, gunPivot, worldDirToHull, hullDirToWorld, updateRot } from './tank.js';
import { crewOk, previewPlate } from './damage.js';
import { castShell } from './ballistics.js';

const DEG = Math.PI / 180, G = 9.81;
export const SHELL_SPEED = 0.8;     // shells fly at v · 0.8
export const MAX_RANGE = 720;       // m of flight path
const ELEV_RATE = 22;               // gun elevation speed, deg/s
const wrap = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };

// Current shell def of a tank.
export const curShell = (t) => t.gunDef.shells[t.shell] || t.gunDef.shells[0];
// Gun traverse arc in radians or null (casemates: turret.traverse, or gun.arc).
export function gunArc(t) {
  const a = t.gunDef.arc || t.def.turret.traverse;
  return a ? [a[0] * DEG, a[1] * DEG] : null;
}

// Crew-, module- and skill-adjusted performance factors (1 = nominal).
export function perf(t) {
  const s = 0.85 + 0.15 * (t.crewSkill ?? 1);
  const cmd = crewOk(t, 'commander') ? 1 : 0.9;
  const gunner = crewOk(t, 'gunner') ? 1 : 0.8, loader = crewOk(t, 'loader') ? 1 : 0.8;
  const gm = t.modules.gun.state, rm = t.modules.turretRing.state, am = t.modules.ammoRack.state;
  return {
    reload: 1 / (s * cmd * loader) * (am === 'damaged' ? 1.3 : 1),
    aim: 1 / (s * cmd * gunner),
    disp: (1 / (0.5 + 0.5 * s * cmd * gunner)) * (gm === 'damaged' ? 1.3 : gm === 'destroyed' ? 1.8 : 1),
    traverse: s * cmd * (gunner < 1 ? 0.85 : 1) * (rm === 'damaged' ? 0.5 : rm === 'destroyed' ? 0.2 : 1),
  };
}

// Launch elevation (world, radians) to hit a point at horizontal distance r and height dy with
// speed v; the low solution. null when out of reach.
export function launchAngle(v, r, dy) {
  if (r < 1e-3) return dy >= 0 ? Math.PI / 2 : -Math.PI / 2;
  const v2 = v * v, disc = v2 * v2 - G * (G * r * r + 2 * dy * v2);
  if (disc < 0) return null;
  return Math.atan((v2 - Math.sqrt(disc)) / (G * r));
}

// aimSolution(world, tank, point) → { yaw, pitch, reachable } — turretYaw and gunPitch (hull
// relative, radians) that put the current shell on `point`, including drop.
const _p = {}, _l = {};
export function aimSolution(world, t, point, out = {}) {
  const v = curShell(t).v * SHELL_SPEED;
  let yaw = t.turretYaw, pitch = 0, inReach = true;
  for (let it = 0; it < 2; it++) {
    // pivot position for the candidate yaw (it swings with the turret)
    const saveY = t.turretYaw; t.turretYaw = yaw; gunPivot(t, _p); t.turretYaw = saveY;
    const dx = point.x - _p.x, dy = point.y - _p.y, dz = point.z - _p.z, r = Math.hypot(dx, dz);
    let a = launchAngle(v, r, dy);
    if (a === null) { a = 45 * DEG; inReach = false; } else inReach = Math.hypot(r, dy) <= MAX_RANGE;
    const ca = Math.cos(a);
    worldDirToHull(t, r > 1e-6 ? dx / r * ca : 0, Math.sin(a), r > 1e-6 ? dz / r * ca : ca, _l);
    yaw = Math.atan2(_l.x, _l.z); pitch = Math.atan2(_l.y, Math.hypot(_l.x, _l.z));
  }
  const g = t.gunDef, arc = gunArc(t);
  const inArc = !arc || (yaw >= arc[0] - 1e-6 && yaw <= arc[1] + 1e-6);
  out.yaw = yaw; out.pitch = pitch;
  out.reachable = inReach && inArc && pitch >= g.dep * DEG - 1e-6 && pitch <= g.elev * DEG + 1e-6;
  return out;
}

// Per-step gun handling: traverse/elevate towards ctrl.aim, dispersion, reload, fire.
const _sol = {};
export function updateGun(world, t, c, dt) {
  const g = t.gunDef, p = perf(t);
  t._autoSteer = 0;
  let wantYaw = t.turretYaw, wantPitch = t.gunPitch;
  if (c.aim && !c.lockGun) { aimSolution(world, t, c.aim, _sol); wantYaw = _sol.yaw; wantPitch = _sol.pitch; }
  const arc = gunArc(t);
  let dyaw;
  if (arc) {
    // Casemate: clamp to the arc; outside it the hull turns for the gun (WoT TD behaviour).
    const w = wrap(wantYaw);
    if (c.aim && !c.lockGun && (w < arc[0] || w > arc[1])) t._autoSteer = w > 0 ? -1 : 1;
    dyaw = Math.min(arc[1], Math.max(arc[0], w)) - t.turretYaw;
  } else dyaw = wrap(wantYaw - t.turretYaw);
  const trMax = t.def.turretTraverse * DEG * p.traverse * dt;
  const ty = Math.max(-trMax, Math.min(trMax, dyaw));
  t.turretYaw = arc ? t.turretYaw + ty : wrap(t.turretYaw + ty);
  t.turretRate = ty / dt / DEG;
  const pMax = ELEV_RATE * DEG * dt * (p.traverse > 0.9 ? 1 : 0.8);
  const pt = Math.min(g.elev * DEG, Math.max(g.dep * DEG, wantPitch));
  const dp = Math.max(-pMax, Math.min(pMax, pt - t.gunPitch));
  t.gunPitch += dp; t.gunRate = dp / dt / DEG;
  // Dispersion (docs: Aiming). Rates in km/h and deg/s.
  const sp = Math.abs(t.speed) * 3.6, hr = Math.abs(t.yawRate) / DEG, tr = Math.abs(t.turretRate);
  t.dispTarget = g.disp * p.disp * Math.sqrt(1 + (g.dMove * sp / 10) ** 2 + (g.dHull * hr / 10) ** 2 + (g.dTurret * tr / 10) ** 2);
  const tau = g.aim * p.aim / 3;
  t.disp = t.dispTarget + (t.disp - t.dispTarget) * Math.exp(-dt / tau);
  // Shell selection: switching away from a loaded shell reloads the gun.
  if (c.shell != null && c.shell !== t.shell && g.shells[c.shell]) {
    t.shell = c.shell;
    if (!g.clip || t.clipLeft > 0) t.reload = Math.max(t.reload, g.reload * p.reload * (g.clip ? 0.5 : 1));
  }
  if (t.reload > 0) {
    t.reload -= dt;
    if (t.reload <= 0) { t.reload = 0; world.events.push({ type: 'reloaded', tank: t.id, clip: g.clip ? t.clipLeft : 0 }); }
  }
  if (c.fire && t.reload <= 0 && t.modules.gun.state !== 'destroyed' && t.ammo[t.shell] > 0) fire(world, t, p);
}

// Fire the gun: a shell leaves the muzzle, deviated inside the dispersion circle.
const _m = { pos: {}, dir: {} };
export function fire(world, t, p = perf(t)) {
  const g = t.gunDef, sh = curShell(t), rng = world.rng;
  muzzle(t, _m);
  // truncated gaussian radius (σ = R/2, clipped at R), angle r/100 rad
  const R = t.disp;
  let r;
  do { r = Math.abs(gauss(rng)) * R / 2; } while (r > R);
  const phi = rng() * 2 * Math.PI, dev = r / 100;
  const d = _m.dir;
  // basis perpendicular to d
  let ux = -d.z, uy = 0, uz = d.x; const ul = Math.hypot(ux, uz) || 1; ux /= ul; uz /= ul;
  const wx = d.y * uz - d.z * uy, wy = d.z * ux - d.x * uz, wz = d.x * uy - d.y * ux;
  const cp = Math.cos(phi) * dev, spp = Math.sin(phi) * dev;
  let dx = d.x + ux * cp + wx * spp, dy = d.y + uy * cp + wy * spp, dz = d.z + uz * cp + wz * spp;
  const dl = Math.hypot(dx, dy, dz); dx /= dl; dy /= dl; dz /= dl;
  const v = sh.v * SHELL_SPEED;
  const s = {
    id: world.nextShell++, owner: t.id, team: t.team, type: sh.type, gold: !!sh.gold,
    pos: { x: _m.pos.x, y: _m.pos.y, z: _m.pos.z }, vel: { x: dx * v, y: dy * v, z: dz * v },
    cal: g.cal, pen: sh.pen, dmg: sh.dmg, splash: sh.splash || 0, alive: true, tracer: true, dist: 0, ricochets: 0, ignore: 0,
  };
  world.shells.push(s);
  t.ammo[t.shell]--; t.stats.shots++; t.lastShot = world.time;
  world.events.push({ type: 'shot', tank: t.id, shell: s.id, pos: { ...s.pos }, dir: { x: dx, y: dy, z: dz }, cal: g.cal, shellType: sh.type });
  t.disp = Math.min(g.disp * 8, Math.max(t.disp, t.dispTarget) * g.dShot);
  if (g.clip) {
    t.clipLeft--;
    if (t.clipLeft > 0) t.reload = g.clip.t;
    else { t.clipLeft = g.clip.n; t.reload = g.reload * p.reload; }
  } else t.reload = g.reload * p.reload;
  // recoil kicks the hull a little (visual; also why you should stop to shoot)
  t.pitch += Math.min(0.02, g.cal / 6000) * Math.cos(t.turretYaw);
  updateRot(t);
  return s;
}
function gauss(rng) { let u = 0; while (u === 0) u = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng()); }

// predictImpact(world, tank) → { x, y, z, dist, targetId|null }: where the gun points now,
// with drop, no dispersion. Casts the trajectory in 1/30 s segments (cheap enough per frame).
export function predictImpact(world, t) {
  muzzle(t, _m);
  const v = curShell(t).v * SHELL_SPEED;
  return castShell(world, _m.pos, { x: _m.dir.x * v, y: _m.dir.y * v, z: _m.dir.z * v }, t.id);
}

// penPreview(world, tank, point, targetId) → { plate, eff, chance, angle, ricochet, pen } | null.
export function penPreview(world, t, point, targetId) {
  const target = world.byId[targetId];
  if (!target || !target.alive) return null;
  muzzle(t, _m);
  const o = _m.pos, dx = point.x - o.x, dy = point.y - o.y, dz = point.z - o.z, L = Math.hypot(dx, dy, dz);
  if (L < 0.1) return null;
  return previewPlate(t, target, o, { x: dx / L, y: dy / L, z: dz / L }, L);
}
