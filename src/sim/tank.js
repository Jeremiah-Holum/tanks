// Tank state, frames and armour ray tests. See docs/DESIGN.md "Frames and units".
// Hull frame → world: translate(pos) · rotY(yaw) · rotX(−pitch) · rotZ(roll).
// Turret frame → hull: translate(armor.turretPos) · rotY(turretYaw) (casemate bodies don't turn).
import { buildArmor, rayConvex, rayBox } from './armor.js';

const DEG = Math.PI / 180;

// ------------------------------------------------------------------ rotation
// Rotation matrix (row-major 3×3) of the hull, written into out (Float64Array(9)).
export function hullRot(yaw, pitch, roll, out = new Float64Array(9)) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(-pitch), sp = Math.sin(-pitch), cr = Math.cos(roll), sr = Math.sin(roll);
  // Ry · Rx(−pitch) · Rz(roll)
  // Ry = [cy 0 sy; 0 1 0; -sy 0 cy], Rx = [1 0 0; 0 cp -sp; 0 sp cp], Rz = [cr -sr 0; sr cr 0; 0 0 1]
  const a00 = cy, a01 = sy * sp, a02 = sy * cp;
  const a10 = 0, a11 = cp, a12 = -sp;
  const a20 = -sy, a21 = cy * sp, a22 = cy * cp;
  out[0] = a00 * cr + a01 * sr; out[1] = -a00 * sr + a01 * cr; out[2] = a02;
  out[3] = a10 * cr + a11 * sr; out[4] = -a10 * sr + a11 * cr; out[5] = a12;
  out[6] = a20 * cr + a21 * sr; out[7] = -a20 * sr + a21 * cr; out[8] = a22;
  return out;
}
// The tank's cached hull rotation (refreshed by the sim every step; call updateRot after moving).
export function updateRot(t) { t._R = hullRot(t.yaw, t.pitch, t.roll, t._R || new Float64Array(9)); return t._R; }
const rot = (t) => t._R || updateRot(t);

// 4×4 world matrix of the hull, column-major (three.js Matrix4.fromArray order).
export function tankMatrix(t, out = new Array(16)) {
  const R = hullRot(t.yaw, t.pitch, t.roll, _R9);
  out[0] = R[0]; out[1] = R[3]; out[2] = R[6]; out[3] = 0;
  out[4] = R[1]; out[5] = R[4]; out[6] = R[7]; out[7] = 0;
  out[8] = R[2]; out[9] = R[5]; out[10] = R[8]; out[11] = 0;
  out[12] = t.pos.x; out[13] = t.pos.y; out[14] = t.pos.z; out[15] = 1;
  return out;
}
const _R9 = new Float64Array(9);

// Hull-frame point → world (out {x,y,z}); and world → hull. Directions: same without pos.
export function hullToWorld(t, x, y, z, out = {}) {
  const R = rot(t);
  out.x = t.pos.x + R[0] * x + R[1] * y + R[2] * z;
  out.y = t.pos.y + R[3] * x + R[4] * y + R[5] * z;
  out.z = t.pos.z + R[6] * x + R[7] * y + R[8] * z;
  return out;
}
export function hullDirToWorld(t, x, y, z, out = {}) {
  const R = rot(t);
  out.x = R[0] * x + R[1] * y + R[2] * z; out.y = R[3] * x + R[4] * y + R[5] * z; out.z = R[6] * x + R[7] * y + R[8] * z;
  return out;
}
export function worldToHull(t, x, y, z, out = {}) {
  const R = rot(t); x -= t.pos.x; y -= t.pos.y; z -= t.pos.z;
  out.x = R[0] * x + R[3] * y + R[6] * z; out.y = R[1] * x + R[4] * y + R[7] * z; out.z = R[2] * x + R[5] * y + R[8] * z;
  return out;
}
export function worldDirToHull(t, x, y, z, out = {}) {
  const R = rot(t);
  out.x = R[0] * x + R[3] * y + R[6] * z; out.y = R[1] * x + R[4] * y + R[7] * z; out.z = R[2] * x + R[5] * y + R[8] * z;
  return out;
}
// Turret-frame point → world (the turret/gun rotate by turretYaw; pass yaw 0 for casemate bodies).
export function turretToWorld(t, x, y, z, out = {}, yaw = t.turretYaw) {
  const a = t.armor, c = Math.cos(yaw), s = Math.sin(yaw);
  return hullToWorld(t, a.turretPos[0] + c * x + s * z, a.turretPos[1] + y, a.turretPos[2] - s * x + c * z, out);
}
// Centre (turret frame x, z) the gun and mantlet yaw about: the turret ring centre (0, 0) for
// turrets, the gun pivot for casemates (the gun swings in its embrasure).
export function gunYawCentre(t) {
  const p = t.armor.gun.pivot;
  return t.def.turret.shape === 'casemate' ? [p[0], p[2]] : [0, 0];
}
// Gun-frame point (turret frame at yaw 0) → world: rotate about gunYawCentre by turretYaw.
export function gunToWorld(t, x, y, z, out = {}) {
  const [cx, cz] = gunYawCentre(t), c = Math.cos(t.turretYaw), s = Math.sin(t.turretYaw);
  const lx = x - cx, lz = z - cz;
  return turretToWorld(t, cx + c * lx + s * lz, y, cz - s * lx + c * lz, out, 0);
}

// Muzzle position and gun direction in world space: { pos, dir } (fresh objects unless out given).
export function muzzle(t, out = { pos: {}, dir: {} }) {
  const a = t.armor, p = a.gun.pivot, len = t.gunDef.len;
  const cg = Math.cos(t.gunPitch), sg = Math.sin(t.gunPitch), c = Math.cos(t.turretYaw), s = Math.sin(t.turretYaw);
  // gun direction in the turret frame (0, sg, cg), rotated into the hull frame
  hullDirToWorld(t, s * cg, sg, c * cg, out.dir);
  gunToWorld(t, p[0], p[1] + sg * len, p[2] + cg * len, out.pos);
  return out;
}
// Gun pivot (trunnion) in world space.
export function gunPivot(t, out = {}) { const p = t.armor.gun.pivot; return gunToWorld(t, p[0], p[1], p[2], out); }
// Commander's eye (turret top) in world space: the spotting observer point.
export function eyePos(t, out = {}) { return turretToWorld(t, 0, t.def.turret.H + 0.15, t.armor.gun.pivot[2] * 0.2, out, 0); }

// ------------------------------------------------------------------ creation
export const MODULES = ['engine', 'ammoRack', 'fuel', 'gun', 'turretRing', 'trackL', 'trackR'];
const TIER_DMG = [0, 40, 45, 55, 90, 115, 180, 240]; // typical same-tier shell damage (module hp scale)
const MOD_HP = { engine: 1.5, ammoRack: 1.7, fuel: 1.8, gun: 1.4, turretRing: 1.4, trackL: 1.0, trackR: 1.0 };

export function createTank(id, team, entry, spawn) {
  const def = entry.def, armor = buildArmor(def);
  const gi = Math.min(entry.gun | 0, def.guns.length - 1), g = def.guns[gi];
  const D = TIER_DMG[def.tier] || 100;
  const modules = {};
  for (const m of MODULES) { const max = Math.round(D * MOD_HP[m]); modules[m] = { hp: max, max, state: 'ok', t: 0 }; }
  const crew = {};
  for (const r of def.crew) crew[r] = { alive: true };
  const ammo = entry.ammo ? entry.ammo.slice(0, g.shells.length) : defaultAmmo(g);
  while (ammo.length < g.shells.length) ammo.push(0);
  const t = {
    id, team, def, gunDef: g, gunIndex: gi, name: entry.name || def.short, player: !!entry.player, bot: entry.bot || null,
    pos: { x: spawn.x, y: 0, z: spawn.z }, yaw: spawn.yaw || 0, pitch: 0, roll: 0, speed: 0, yawRate: 0, throttle: 0,
    turretYaw: 0, gunPitch: 0, turretRate: 0, gunRate: 0,
    hp: def.hp, maxHp: def.hp, alive: true, reload: g.reload * 0.3, shell: 0, ammo,
    disp: g.disp * 3, dispTarget: g.disp,
    modules, crew, fire: null,
    consumables: (entry.consumables || ['repair', 'medkit', 'extinguisher']).map((kind) => ({ kind, ready: true, cd: 0 })),
    spotted: false,
    stats: { dmg: 0, assist: 0, blocked: 0, kills: 0, shots: 0, hits: 0, pens: 0, received: 0, spotted: 0, capture: 0, defended: 0 },
    // --- additive fields (see docs/notes/sim.md)
    crewSkill: entry.crewSkill ?? 1, armor, clipLeft: g.clip ? g.clip.n : 0, clipSize: g.clip ? g.clip.n : 0,
    lastShot: -99, killedBy: null, deathCause: null, trackedBy: 0, fireBy: 0, fireProof: 0,
    lastSeen: [-99, -99], spottedBy: [0, 0], rad: 0, _R: null, _ramCd: 0,
  };
  // bounding sphere around (pos + up·cy)
  const h = def.hull, tu = def.turret;
  const top = h.clr + h.H + tu.H;
  t.cy = top / 2;
  t.rad = Math.hypot(h.L / 2 + 0.2, h.W / 2 + h.track.w, top / 2) + (g.len || 0) * 0.2;
  updateRot(t);
  return t;
}
function defaultAmmo(g) {
  const n = g.ammo, gold = Math.round(n * 0.2), he = Math.round(n * 0.2);
  return [n - gold - he, gold, he];
}

// ------------------------------------------------------------------ armour ray test
// Every armour piece the (world-space) ray enters within maxT, sorted by distance:
// [{ t, tExit, piece, plane, nx,ny,nz (world entry normal), ly (entry height in the piece frame) }].
// Pieces in the turret frame use yaw turretYaw unless `fixed` (casemate body).
const _o = {}, _d = {}, _hits = [];
// skip: a piece to ignore when it is entered within 10 cm (a ricochet leaving that plate).
export function rayArmor(tank, ox, oy, oz, dx, dy, dz, maxT, skip = null) {
  const a = tank.armor, [gcx, gcz] = gunYawCentre(tank);
  worldToHull(tank, ox, oy, oz, _o); worldDirToHull(tank, dx, dy, dz, _d);
  _hits.length = 0;
  const tp = a.turretPos, ty = tank.turretYaw, cT = Math.cos(ty), sT = Math.sin(ty);
  const pieces = a.allPieces || (a.allPieces = a.cupola ? [...a.pieces, a.cupola] : a.pieces);
  for (let i = 0; i < pieces.length; i++) {
    const pc = pieces[i];
    let ox2 = _o.x, oy2 = _o.y, oz2 = _o.z, dx2 = _d.x, dy2 = _d.y, dz2 = _d.z, c = 1, s = 0;
    if (pc.frame === 'turret') {
      ox2 -= tp[0]; oy2 -= tp[1]; oz2 -= tp[2];
      if (!pc.fixed) { // inverse rotation about y by turretYaw (about the pivot for casemate mantlets)
        c = cT; s = sT;
        const qx = pc.gunYaw ? gcx : 0, qz = pc.gunYaw ? gcz : 0;
        const x = ox2 - qx, z = oz2 - qz; ox2 = c * x - s * z + qx; oz2 = s * x + c * z + qz;
        const u = dx2, w = dz2; dx2 = c * u - s * w; dz2 = s * u + c * w;
      }
    }
    const h = rayConvex(pc.planes, ox2, oy2, oz2, dx2, dy2, dz2, maxT);
    if (!h || (pc === skip && h.t < 0.1)) continue;
    const n = h.plane.n;
    // piece-frame normal → hull frame (rotate back by +yaw) → world
    let nx = n[0], ny = n[1], nz = n[2];
    if (s !== 0 || c !== 1) { const x = nx, z = nz; nx = c * x + s * z; nz = -s * x + c * z; }
    const wn = hullDirToWorld(tank, nx, ny, nz, {});
    _hits.push({ t: h.t, tExit: h.tExit, piece: pc, plane: h.plane, nx: wn.x, ny: wn.y, nz: wn.z, ly: oy2 + dy2 * h.t });
  }
  _hits.sort((p, q) => p.t - q.t);
  return _hits;
}

// Modules and crew boxes hit by a (world-space) segment: [{ t, box }] sorted by t.
export function rayModules(tank, ox, oy, oz, dx, dy, dz, len) {
  const a = tank.armor, out = [];
  worldToHull(tank, ox, oy, oz, _o); worldDirToHull(tank, dx, dy, dz, _d);
  const tp = a.turretPos, fixed = tank.def.turret.shape === 'casemate';
  const c = fixed ? 1 : Math.cos(tank.turretYaw), s = fixed ? 0 : Math.sin(tank.turretYaw);
  const tox = _o.x - tp[0], toy = _o.y - tp[1], toz = _o.z - tp[2];
  const Tox = c * tox - s * toz, Toz = s * tox + c * toz, Tdx = c * _d.x - s * _d.z, Tdz = s * _d.x + c * _d.z;
  for (const b of a.modules) {
    const tt = b.frame === 'turret' ? rayBox(b, Tox, toy, Toz, Tdx, _d.y, Tdz, len) : rayBox(b, _o.x, _o.y, _o.z, _d.x, _d.y, _d.z, len);
    if (tt >= 0) out.push({ t: tt, box: b });
  }
  return out.sort((p, q) => p.t - q.t);
}

// Is a world point inside the tank's hull bounding box (for splash distance)? Returns the
// distance from the point to the hull+turret box (0 when inside).
export function distToTank(tank, x, y, z) {
  const p = worldToHull(tank, x, y, z, _o), h = tank.def.hull;
  const hw = h.W / 2 + h.track.w, top = h.clr + h.H + tank.def.turret.H;
  const ex = Math.max(0, Math.abs(p.x) - hw), ey = Math.max(0, p.y - top, -p.y), ez = Math.max(0, Math.abs(p.z) - h.L / 2);
  return Math.hypot(ex, ey, ez);
}

export { DEG };
