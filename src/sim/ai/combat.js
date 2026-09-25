// Combat helpers: target scoring, weak-spot aim candidates (penPreview), lead, shell choice.
// Everything here only looks at tanks the bot's team has spotted (world.visible[team]).
import { penPreview, hullToWorld, turretToWorld, worldToHull, muzzle, gunPivot } from '../battle.js';
import { penAt } from '../damage.js';
import { lineClear } from '../map/query.js';
import { hyp, clamp } from './util.js';

const _m = { pos: {}, dir: {} }, _p = {}, _q = {}, _h = {};

// Aim candidates in the target's frames. size = rough radius (m) of the aimable area.
// tier 0: centre mass only; tier 1: plates any decent player knows; tier 2: unicum weak spots.
function candidates(tg, from) {
  const d = tg.def, h = d.hull, tu = d.turret;
  const loc = worldToHull(tg, from.x, from.y, from.z, _h);
  const sx = loc.x >= 0 ? 1 : -1, front = loc.z >= 0;             // which side / end faces us
  const side = Math.abs(loc.x) / (Math.abs(loc.z) + 1e-3) > 0.45;    // we see the side well
  const fz = front ? 1 : -1;
  const midY = h.clr + h.H * 0.55;
  const C = [
    { k: 'hull', f: 'hull', x: 0, y: midY, z: 0, size: 1.2, tier: 0 },
    { k: 'turret', f: 'turret', x: 0, y: tu.H * 0.5, z: 0, size: 0.8, tier: 0 },
    { k: front ? 'ufp' : 'rear', f: 'hull', x: 0, y: h.clr + h.H * 0.75, z: fz * h.L * 0.45, size: 0.5, tier: 1 },
    { k: front ? 'lfp' : 'rearL', f: 'hull', x: 0, y: h.clr + h.H * 0.25, z: fz * h.L * 0.49, size: 0.35, tier: 1 },
  ];
  if (side) {
    C.push({ k: 'side', f: 'hull', x: sx * h.W * 0.5, y: h.clr + h.H * 0.6, z: h.L * 0.15, size: 0.6, tier: 1 });
    C.push({ k: 'sideRear', f: 'hull', x: sx * h.W * 0.5, y: h.clr + h.H * 0.6, z: -h.L * 0.3, size: 0.55, tier: 2 });
    C.push({ k: 'turretSide', f: 'turret', x: sx * tu.W * 0.45, y: tu.H * 0.5, z: 0, size: 0.45, tier: 2 });
  }
  const cu = tg.armor.cupola;
  if (cu) C.push({ k: 'cupola', f: 'turret', fixed: !!cu.fixed, x: cu.c[0], y: cu.c[1] + (cu.h || 0.3) * 0.5, z: cu.c[2], size: 0.28, tier: 2 });
  // turret-ring shot: base of the turret face
  if (tu.shape !== 'casemate' && tu.shape !== 'open') C.push({ k: 'ring', f: 'turret', x: 0, y: 0.08, z: fz * tu.L * 0.42, size: 0.18, tier: 2 });
  return C;
}

// World position of a candidate on target tg (moves with it).
export function candWorld(tg, c, out) {
  if (c.f === 'hull') return hullToWorld(tg, c.x, c.y, c.z, out);
  return turretToWorld(tg, c.x, c.y, c.z, out, c.fixed ? 0 : tg.turretYaw);
}

// Hit probability for an aimable area of radius `size` at distance d, given the gun's aimed
// dispersion (σ = R/2) and the bot's own aim error `err` (m).
export function pHit(size, R, err) {
  const s2 = (R * 0.5) ** 2 + err * err;
  return 1 - Math.exp(-(size * size) / (2 * s2 + 1e-6));
}

// Best aim point on target tg for bot b: { cand, chance, ev } or null when nothing is visible.
export function bestAim(world, b, tg) {
  const t = b.t, map = world.map;
  muzzle(t, _m);
  const d = hyp(tg.pos.x - t.pos.x, tg.pos.z - t.pos.z);
  const R = t.gunDef.disp * d / 100;
  const know = b.skill < 0.3 ? 0 : b.skill < 0.58 ? 1 : 2;
  let best = null;
  for (const c of candidates(tg, _m.pos)) {
    if (c.tier > know) continue;
    candWorld(tg, c, _p);
    if (!lineClear(map, _m.pos, _p)) continue;               // terrain / building in the way (hull-down)
    const pv = penPreview(world, t, _p, tg.id);
    if (!pv) continue;
    const ch = pv.chance;
    // expected value: pen chance × chance to hit that area; potatoes just want centre mass
    const ev = know === 0 ? (c.k === 'hull' ? 1 : 0.8) : (0.05 + ch) * pHit(c.size, R, b.aimErrBase);
    if (!best || ev > best.ev) best = { cand: c, chance: ch, ev, eff: pv.eff, plate: pv.plate };
  }
  return best;
}

// Does bot b have a clear line to any of tg's two main points? (gun pivot → hull / turret)
export function lineTo(world, b, tg) {
  gunPivot(b.t, _m.pos);
  const h = tg.def.hull;
  hullToWorld(tg, 0, h.clr + h.H * 0.6, 0, _p);
  if (lineClear(world.map, _m.pos, _p)) return true;
  turretToWorld(tg, 0, tg.def.turret.H * 0.7, 0, _p);
  return lineClear(world.map, _m.pos, _p);
}

// Is a tank facing / aiming at (x, z)? cos of the angle between its gun and the direction.
export function gunFacing(e, x, z) {
  const a = e.yaw + e.turretYaw, dx = x - e.pos.x, dz = z - e.pos.z, L = hyp(dx, dz) || 1;
  return (Math.sin(a) * dx + Math.cos(a) * dz) / L;
}

// Rough damage-per-minute of a tank's current gun.
export const dpm = (tk) => { const g = tk.gunDef, s = g.shells[0]; return s.dmg * 60 / (g.clip ? g.reload / g.clip.n + g.clip.t : g.reload); };
export const alphaOf = (tk, slot = 0) => (tk.gunDef.shells[slot] || tk.gunDef.shells[0]).dmg;

// Pen chance of shell slot on effective thickness eff at distance d.
export function chanceWith(t, slot, eff, d) {
  const sh = t.gunDef.shells[slot];
  if (!sh) return 0;
  const pen = penAt(sh, d);
  return clamp((1.25 - eff / pen) / 0.5, 0, 1);
}

// Choose a shell slot for the target given the chosen plate's effective armour.
export function chooseShell(b, tg, aim, d) {
  const t = b.t, S = b.slots, ammo = t.ammo;
  const has = (i) => i >= 0 && ammo[i] > 0;
  let want = has(S.std) ? S.std : has(S.gold) ? S.gold : S.he;
  if (!aim) return want;
  const eff = aim.eff;
  const cStd = chanceWith(t, S.std, eff, d);
  // HE: open tops, paper armour, or a low-hp target it will finish without a pen
  if (has(S.he) && b.skill > 0.25) {
    const he = t.gunDef.shells[S.he], open = tg.def.turret.open || tg.def.turret.shape === 'open';
    const heNoPen = Math.max(0, he.dmg / 2 - eff * 1.1);
    const heChance = clamp((1.25 - eff / he.pen) / 0.5, 0, 1);
    if (open && (aim.cand.k === 'turret' || aim.cand.k === 'turretSide' || aim.cand.k === 'cupola')) return S.he;
    if (heChance > 0.8 && he.dmg > t.gunDef.shells[S.std].dmg * 1.2) return S.he;
    if (tg.hp <= heNoPen * 0.8 && cStd < 0.9) return S.he;
    if (cStd < 0.08 && heNoPen > 25 && b.skill > 0.45) return S.he;
  }
  // APCR sparingly for skilled bots when the standard round struggles
  if (has(S.gold) && b.skill > 0.6 && b.goldUsed < b.goldBudget && cStd < 0.45) {
    const cGold = chanceWith(t, S.gold, eff, d);
    if (cGold > cStd + 0.3) return S.gold;
  }
  return want;
}
