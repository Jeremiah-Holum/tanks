// Derived tank parameters for the stats panels: raw numbers plus 0..1 scores against the roster.
import { TANK_LIST } from '../meta/roster.js';

export function derive(def, gi = 0) {
  const g = def.guns[gi] || def.guns[0];
  const std = g.shells.find((s) => !s.gold && s.type !== 'HE') || g.shells[0];
  const gold = g.shells.find((s) => s.gold);
  const he = g.shells.find((s) => s.type === 'HE');
  const h = def.hull, t = def.turret;
  return {
    gun: g, dmg: std.dmg, pen: std.pen, penGold: gold?.pen, penHe: he?.pen, dmgHe: he?.dmg,
    reload: g.reload, rof: 60 / g.reload, dpm: std.dmg * 60 / g.reload, aim: g.aim, disp: g.disp,
    v: std.v, dep: g.dep, elev: g.elev, ammo: g.ammo, cal: g.cal,
    hp: def.hp, hullF: h.upper.t, hullS: h.side.t, hullR: h.rear.t,
    turF: t.shape === 'open' ? t.front.t : t.front.t, turS: t.side.t, turR: t.rear.t,
    mass: def.mass, power: def.power, pw: def.power / def.mass, speed: def.speed, reverse: def.reverse,
    hullTraverse: def.hullTraverse, turretTraverse: def.turretTraverse, view: def.view,
    camo: def.camo.still, camoMove: def.camo.moving, crew: def.crew.length,
    // effective hull front along the line of sight (upper plate at its angle)
    hullFeff: Math.round(h.upper.t / Math.cos(h.upper.a * Math.PI / 180)),
  };
}

let MAX = null;
function maxes() {
  if (MAX) return MAX;
  MAX = {};
  for (const d of TANK_LIST) d.guns.forEach((_, gi) => {
    const s = derive(d, gi);
    for (const [k, v] of Object.entries(s)) if (typeof v === 'number') MAX[k] = Math.max(MAX[k] || 0, v);
  });
  return MAX;
}

// Four headline scores (0..1), WoT-garage style.
export function scores(def, gi = 0) {
  const s = derive(def, gi), m = maxes();
  const q = (k) => Math.min(1, s[k] / m[k]);
  return {
    firepower: 0.5 * q('dpm') + 0.3 * q('pen') + 0.2 * q('dmg'),
    survivability: 0.6 * q('hp') + 0.4 * Math.min(1, s.hullFeff / m.hullFeff),
    mobility: 0.4 * q('pw') + 0.35 * q('speed') + 0.25 * q('hullTraverse'),
    spotting: 0.6 * q('view') + 0.4 * q('camo'),
    s,
  };
}
