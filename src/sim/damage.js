// Armour, penetration, damage, modules, crew, fire and consumables (docs/DESIGN.md "Armour").
import { rayArmor, rayModules, distToTank } from './tank.js';

const DEG = Math.PI / 180;
export const RICOCHET_DEG = 70;
export const REPAIR_T = { trackL: 8, trackR: 8, engine: 14, gun: 10, turretRing: 10, fuel: 12, ammoRack: 12 };
const TIER_DMG = [0, 40, 45, 55, 90, 115, 180, 240];
const NORM = { AP: 5, APCR: 2, HEAT: 0, HE: 0 };

// Penetration after distance falloff (AP −10 %, APCR −25 % from 100 m to 500 m).
export function penAt(sh, dist) {
  const k = Math.min(1, Math.max(0, (dist - 100) / 400));
  return sh.pen * (1 - k * (sh.type === 'AP' ? 0.1 : sh.type === 'APCR' ? 0.25 : 0));
}

// One plate: { eff, angle (deg), ricochet, overmatch } for a shell of type/cal hitting plate
// thickness t at angle `ang` (radians, between −dir and the normal).
export function plateEff(type, cal, t, ang) {
  if (t <= 0) return { eff: 0, angle: ang / DEG, ricochet: false, overmatch: true };
  const over3 = cal > 3 * t, over2 = cal > 2 * t;
  let norm = NORM[type] || 0;
  if (over2 && norm) norm *= 1.4 * cal / (2 * t);
  const ricochet = (type === 'AP' || type === 'APCR') && !over3 && ang > RICOCHET_DEG * DEG;
  const a = Math.max(0, ang - norm * DEG);
  return { eff: t / Math.max(0.05, Math.cos(a)), angle: ang / DEG, ricochet, overmatch: over3 };
}

// Walk the armour pieces a ray enters, in order: tracks (spaced) absorb and let the shell on,
// the first main plate decides. Returns { hit, plate, eff, angle, ricochet, spaced: [{hit, eff}],
// ring, cupola } or null (a clean miss). Shared by the shell resolver and penPreview.
function firstPlate(tank, hits, dx, dy, dz, type, cal) {
  const spaced = [];
  for (const h of hits) {
    const ang = Math.acos(Math.min(1, Math.max(0, -(dx * h.nx + dy * h.ny + dz * h.nz))));
    let t = h.plane.t, plate = h.plane.plate, ring = false;
    if (h.piece.spaced) { spaced.push({ hit: h, eff: plateEff(type, cal, t, ang).eff, angle: ang / DEG }); continue; }
    // Turret ring: the bottom 10 cm of a turning turret's walls is a weak spot.
    if (h.piece.kind === 'turret' && !h.piece.fixed && h.ly < 0.1 && h.plane.n[1] < 0.5 && t > 0) { t = Math.round(t * 0.6); plate = 'turret.ring'; ring = true; }
    const pe = plateEff(type, cal, t, ang);
    return { hit: h, plate, t, ...pe, spaced, ring, cupola: h.piece.kind === 'cupola' };
  }
  return spaced.length ? { hit: null, spaced } : null;
}

// Pen preview for the HUD / AI: straight line o→dir against `target`, current shell of `tank`.
// → { plate, eff, chance, angle, ricochet, pen } or null when the line misses the target.
export function previewPlate(tank, target, o, d, dist) {
  const sh = tank.gunDef.shells[tank.shell] || tank.gunDef.shells[0];
  const hits = rayArmor(target, o.x, o.y, o.z, d.x, d.y, d.z, dist + 12);
  const r = firstPlate(target, hits, d.x, d.y, d.z, sh.type, tank.gunDef.cal);
  if (!r) return null;
  const pen = penAt(sh, dist);
  let absorbed = 0;
  for (const s of r.spaced) absorbed += s.eff;
  if (!r.hit) return { plate: 'track', eff: absorbed, chance: 0, angle: r.spaced[0].angle, ricochet: false, pen };
  const eff = r.eff + (sh.type === 'HE' ? 0 : absorbed);
  const chance = r.ricochet ? 0 : Math.max(0, Math.min(1, (1.25 - eff / pen) / 0.5));
  return { plate: r.plate, eff: Math.round(eff), chance, angle: Math.round(r.angle), ricochet: r.ricochet, pen: Math.round(pen) };
}

// ------------------------------------------------------------------ shell vs tank
// The shell s (world segment o + d·t) hits `tank`. Resolves the armour and applies damage.
// Returns null when the ray misses the tank, else { t, stop, reflect: {x,y,z,nx,ny,nz}|null }.
// Hit events are pushed before the damage is dealt, so a `kill` always follows its `hit`.
export function shellHitsTank(world, s, tank, ox, oy, oz, dx, dy, dz, maxT, skipPiece = null) {
  const hits = rayArmor(tank, ox, oy, oz, dx, dy, dz, maxT, skipPiece);
  if (!hits.length) return null;
  const h0 = hits[0], t0 = h0.t;
  const at = (h) => ({ x: ox + dx * h.t, y: oy + dy * h.t, z: oz + dz * h.t });
  const nrm = (h) => ({ x: h.nx, y: h.ny, z: h.nz });
  // Friendly tanks and wrecks just stop shells (no team damage).
  if (tank.team === s.team || !tank.alive) {
    world.events.push({ type: 'impact', shell: s.id, pos: at(h0), normal: nrm(h0), surface: tank.alive ? 'tank' : 'wreck', shellType: s.type });
    if (s.type === 'HE') splash(world, s, at(h0), tank.id);
    return { t: t0, stop: true, reflect: null };
  }
  const shooter = world.byId[s.owner];
  const r = firstPlate(tank, hits, dx, dy, dz, s.type, s.cal);
  const rng = world.rng;
  let pen = penAt(s, s.dist + t0) * (0.75 + 0.5 * rng());
  const crits = [], crew = [];
  const ev = { type: 'hit', shooter: s.owner, target: tank.id, shell: s.id, shellType: s.type, pos: null, normal: null, result: 'nopen', dmg: 0, plate: '', eff: 0, pen: Math.round(pen), angle: 0, crits, crew };
  if (shooter) shooter.stats.hits++;
  // Tracks: absorb their thickness, take the hit, maybe break.
  for (const sp of r.spaced) {
    const trackName = sp.hit.piece.name; // 'trackL' | 'trackR'
    const md = s.dmg * (0.75 + 0.5 * rng()) * (s.type === 'HE' ? 1.2 : 1);
    damageModule(world, tank, trackName, md, s.owner, crits);
    if (s.type === 'HE') { // HE bursts on the track; the hull behind takes what gets through
      const side = tank.def.hull.side.t;
      const dmg = Math.max(0, Math.round(s.dmg / 2 * (0.75 + 0.5 * rng()) - (sp.eff + side) * 1.1));
      Object.assign(ev, { pos: at(sp.hit), normal: nrm(sp.hit), result: 'track', plate: 'track', eff: Math.round(sp.eff), angle: Math.round(sp.angle) });
      world.events.push(ev);
      if (dmg > 0) dealDamage(world, tank, dmg, s.owner, 'shot', ev); else tank.stats.blocked += s.dmg;
      splash(world, s, ev.pos, tank.id);
      return { t: sp.hit.t, stop: true, reflect: null };
    }
    pen -= sp.eff;
    if (pen <= 0 || !r.hit) {
      Object.assign(ev, { pos: at(sp.hit), normal: nrm(sp.hit), result: 'track', plate: 'track', eff: Math.round(sp.eff), angle: Math.round(sp.angle) });
      world.events.push(ev);
      tank.stats.blocked += s.dmg;
      return { t: sp.hit.t, stop: true, reflect: null };
    }
  }
  const h = r.hit, pos = at(h);
  Object.assign(ev, { pos, normal: nrm(h), plate: r.plate, eff: Math.round(r.eff), angle: Math.round(r.angle) });
  if (r.ricochet) {
    ev.result = 'ricochet';
    world.events.push(ev);
    tank.stats.blocked += s.dmg;
    const dn = dx * h.nx + dy * h.ny + dz * h.nz;
    return { t: h.t, stop: false, reflect: { x: pos.x + h.nx * 0.05, y: pos.y + h.ny * 0.05, z: pos.z + h.nz * 0.05, dx: dx - 2 * dn * h.nx, dy: dy - 2 * dn * h.ny, dz: dz - 2 * dn * h.nz, piece: h.piece } };
  }
  if (pen >= r.eff) {
    // Penetration: damage, then the shell travels on ~10 calibres through modules and crew.
    ev.result = 'pen';
    const dmg = Math.round(s.dmg * (s.type === 'HE' ? 1 : 0.75 + 0.5 * rng()));
    if (shooter) shooter.stats.pens++;
    const len = s.type === 'HE' ? 1.2 : Math.min(3, Math.max(1.5, s.cal * 0.025));
    const D = TIER_DMG[tank.def.tier] || 100;
    const inside = rayModules(tank, pos.x, pos.y, pos.z, dx, dy, dz, len);
    let k = 0;
    if (r.ring) damageModule(world, tank, 'turretRing', dmg, s.owner, crits);
    if (r.cupola && tank.crew.commander && rng() < 0.75) killCrew(world, tank, 'commander', crew);
    for (const { box } of inside) {
      const md = dmg * (0.75 + 0.5 * rng()) * Math.pow(0.8, k++);
      if (box.crew) { if (tank.crew[box.name]?.alive && rng() < Math.min(0.9, Math.max(0.3, md / (1.3 * D)))) killCrew(world, tank, box.name, crew); }
      else damageModule(world, tank, box.name, md, s.owner, crits);
      if (tank._rackBy) break;
    }
    world.events.push(ev);
    // An ammo rack pop kills: the shooter is credited with all the hp that was left.
    if (tank._rackBy) { tank._rackBy = 0; dealDamage(world, tank, tank.hp, s.owner, 'ammorack', ev); }
    else dealDamage(world, tank, dmg, s.owner, 'shot', ev);
    if (s.type === 'HE') splash(world, s, pos, tank.id);
    return { t: h.t, stop: true, reflect: null };
  }
  // No penetration.
  if (s.type === 'HE') {
    const dmg = Math.max(0, Math.round(s.dmg / 2 * (0.75 + 0.5 * rng()) - r.eff * 1.1));
    ev.result = dmg > 0 ? 'splash' : 'nopen';
    world.events.push(ev);
    if (dmg > 0) dealDamage(world, tank, dmg, s.owner, 'shot', ev); else tank.stats.blocked += s.dmg / 2;
    splash(world, s, pos, tank.id);
  } else {
    tank.stats.blocked += s.dmg;
    if (crits.length) ev.result = 'crit';
    world.events.push(ev);
  }
  return { t: h.t, stop: true, reflect: null };
}

// HE splash on every enemy tank near pos (except the one hit directly).
export function splash(world, s, pos, excludeId) {
  const R = s.splash || 1;
  for (const t of world.tanks) {
    if (!t.alive || t.id === excludeId || t.team === s.team) continue;
    const dx = t.pos.x - pos.x, dz = t.pos.z - pos.z;
    if (dx * dx + dz * dz > (R + t.rad) * (R + t.rad)) continue;
    const d = distToTank(t, pos.x, pos.y, pos.z);
    if (d >= R) continue;
    const tu = t.def.turret, h = t.def.hull;
    const open = tu.shape === 'open' || tu.open;
    const arm = open ? 0 : Math.min(h.side.t, h.roof, tu.roof ?? 10);
    const dmg = Math.max(0, Math.round(s.dmg / 2 * (1 - d / R) - arm * 1.1));
    if (dmg <= 0) continue;
    const ev = { type: 'hit', shooter: s.owner, target: t.id, shell: s.id, shellType: s.type, pos: { ...pos }, normal: { x: 0, y: 1, z: 0 }, result: 'splash', dmg: 0, plate: open ? 'open' : 'splash', eff: arm, pen: 0, angle: 0, crits: [], crew: [] };
    world.events.push(ev);
    dealDamage(world, t, dmg, s.owner, 'splash', ev);
  }
}

// ------------------------------------------------------------------ hp, kills, assist
export function dealDamage(world, tank, dmg, byId, cause, ev) {
  if (!tank.alive || dmg <= 0) return 0;
  dmg = Math.min(dmg, tank.hp);
  tank.hp -= dmg; tank.stats.received += dmg;
  if (ev) ev.dmg = dmg;
  const by = world.byId[byId];
  if (by && by.team !== tank.team) {
    by.stats.dmg += dmg;
    // Assist: whoever tracked the target, else whoever spotted it for the shooter's team.
    const helper = tank.trackedBy && tank.trackedBy !== byId ? tank.trackedBy : tank.spottedBy[by.team];
    if (helper && helper !== byId && world.byId[helper]) world.byId[helper].stats.assist += dmg;
  }
  resetCapture(world, tank, by);
  if (tank.hp <= 0) kill(world, tank, byId, cause);
  return dmg;
}

export function kill(world, tank, byId, cause) {
  if (!tank.alive) return;
  tank.alive = false; tank.hp = 0; tank.killedBy = byId || null; tank.deathCause = cause;
  tank.reload = 0; tank.speed *= 0.3; tank.yawRate = 0; tank.turretRate = 0; tank.gunRate = 0;
  const by = world.byId[byId];
  if (by && by.team !== tank.team) by.stats.kills++;
  world.events.push({ type: 'kill', killer: byId || null, victim: tank.id, cause });
  if (tank.fire) { tank.fire = null; world.events.push({ type: 'fire', tank: tank.id, on: false }); }
}

// Any damage to a capper (a tank inside the circle now) removes the points it contributed
// (docs: "capture and reset"), with a capture event carrying the new points.
function resetCapture(world, tank, by) {
  for (const b of world.bases) {
    const c = b.contrib[tank.id];
    if (!c || !b.cappers.includes(tank.id)) continue;
    b.points = Math.max(0, b.points - c); b.contrib[tank.id] = 0;
    if (by && by.team === b.team) by.stats.defended += Math.round(c);
    world.events.push({ type: 'capture', team: b.team, by: 1 - b.team, points: Math.floor(b.points), reset: tank.id });
  }
}

// ------------------------------------------------------------------ modules & crew
export function setModuleState(world, tank, name, state) {
  const m = tank.modules[name];
  if (m.state === state) return;
  m.state = state;
  world.events.push({ type: 'module', tank: tank.id, module: name, state });
}

export function damageModule(world, tank, name, amount, byId, crits) {
  const m = tank.modules[name];
  if (!m || m.state === 'destroyed' || !tank.alive) return;
  m.hp = Math.max(0, Math.round(m.hp - amount));
  const rng = world.rng;
  const state = m.hp <= 0 ? 'destroyed' : m.hp < m.max * 0.7 ? 'damaged' : m.state;
  if (state === m.state) return;
  if (crits) crits.push(name + ':' + state);
  setModuleState(world, tank, name, state);
  if (state === 'destroyed') m.t = REPAIR_T[name] || 10;
  if (name === 'ammoRack' && state === 'destroyed') { tank._rackBy = byId || -1; return; } // the shell resolver kills (after its hit event)
  if ((name === 'trackL' || name === 'trackR') && state === 'destroyed') tank.trackedBy = byId || 0;
  const fireP = name === 'engine' ? (state === 'destroyed' ? 0.45 : 0.15) : name === 'fuel' ? (state === 'destroyed' ? 0.5 : 0.25) : 0;
  if (fireP && rng() < fireP) startFire(world, tank, byId);
}

export function killCrew(world, tank, role, list) {
  const c = tank.crew[role];
  if (!c || !c.alive) return;
  c.alive = false;
  if (list) list.push(role);
  world.events.push({ type: 'crew', tank: tank.id, role, alive: false });
}

export function startFire(world, tank, byId) {
  if (tank.fire || !tank.alive || world.time < tank.fireProof) return;
  tank.fire = { t: 0, acc: 0 }; tank.fireBy = byId || 0;
  world.events.push({ type: 'fire', tank: tank.id, on: true });
}

// Is this crew role able to work? Missing roles are covered by the commander.
export const crewOk = (t, role) => (t.crew[role] ? t.crew[role].alive : t.crew.commander ? t.crew.commander.alive : true);

// Per-step upkeep: module field repairs, fire, consumable cooldowns.
export function tickDamage(world, t, dt) {
  const k = crewOk(t, 'commander') ? 1 : 1.15;
  for (const name in t.modules) {
    const m = t.modules[name];
    if (m.state !== 'destroyed' || name === 'ammoRack') continue;
    m.t -= dt / k * (name.startsWith('track') && !crewOk(t, 'driver') ? 0.7 : 1);
    if (m.t <= 0) { m.hp = Math.round(m.max * 0.4); setModuleState(world, t, name, 'damaged'); if (name.startsWith('track')) t.trackedBy = 0; }
  }
  if (t.fire) {
    t.fire.t += dt; t.fire.acc += t.maxHp * 0.011 * dt;
    if (t.fire.acc >= 1) { const d = Math.floor(t.fire.acc); t.fire.acc -= d; dealDamage(world, t, d, t.fireBy, 'fire', null); }
    // every second after 4 s: 8 % chance the crew gets it under control
    if (t.alive && t.fire && t.fire.t > 4 && Math.floor(t.fire.t) !== Math.floor(t.fire.t - dt) && world.rng() < 0.08) {
      t.fire = null; world.events.push({ type: 'fire', tank: t.id, on: false });
    }
  }
  for (const c of t.consumables) if (!c.ready) { c.cd -= dt; if (c.cd <= 0) { c.cd = 0; c.ready = true; } }
}

export const CONSUMABLE_CD = { repair: 90, medkit: 90, extinguisher: 60 };
// Use a consumable (Controls.use). Refused (returns false) when not ready or nothing to fix.
export function useConsumable(world, t, kind) {
  const c = t.consumables.find((x) => x.kind === kind);
  if (!c || !c.ready || !t.alive) return false;
  if (kind === 'repair') {
    const bad = Object.keys(t.modules).filter((n) => t.modules[n].state !== 'ok');
    if (!bad.length) return false;
    for (const n of bad) { const m = t.modules[n]; m.hp = m.max; m.t = 0; setModuleState(world, t, n, 'ok'); if (n.startsWith('track')) t.trackedBy = 0; }
  } else if (kind === 'medkit') {
    const dead = Object.keys(t.crew).filter((r) => !t.crew[r].alive);
    if (!dead.length) return false;
    for (const r of dead) { t.crew[r].alive = true; world.events.push({ type: 'crew', tank: t.id, role: r, alive: true }); }
  } else if (kind === 'extinguisher') {
    if (!t.fire) return false;
    t.fire = null; t.fireProof = world.time + 10;
    world.events.push({ type: 'fire', tank: t.id, on: false });
  } else return false;
  c.ready = false; c.cd = CONSUMABLE_CD[kind] || 60;
  world.events.push({ type: 'consumable', tank: t.id, kind });
  return true;
}
