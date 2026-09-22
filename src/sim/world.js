// Pure game rules. No DOM, no three.js — this runs identically in node (tools/sim.mjs)
// and in the browser. The renderer reads `world` and drains `world.events`.
//
// Rules (World of Tanks style, toy scale):
//  - Shells fly straight. Touching a block / the frame stops them (`impact`); touching a
//    cardboard crate breaks it (`crateBreak`) and stops them. Pits don't stop shells.
//  - Each tank has hp and armour [front, side, rear]. A shell that touches a hull works out the
//    face it hit and the impact angle. Steeper than RICOCHET_ANGLE → ricochet (the shell reflects
//    and flies on with 70% pen, once). Otherwise pen × roll(0.75..1.25) vs armour / cos(angle):
//    penetrate → damage × roll(0.8..1.2) and maybe a module; else no-pen, the shell stops.
//  - Modules: tracks (immobilised), turret (slow traverse), engine (slow, may burn), ammo rack.
//  - Dispersion: moving / turning / traversing blooms the aim; standing still settles it.
import { TYPES, CLASSES, RICOCHET_ANGLE, kitFor } from './tanks.js';
import { parseLevel } from './levels.js';

export const COLS = 44, ROWS = 32, DT = 1 / 60; // defaults; each grid carries its own .cols/.rows
export const CELL = { FLOOR: 0, BLOCK: 1, CRATE: 2, PIT: 3 };
export const TANK_R = 0.36, SHELL_R = 0.085, BARREL = 0.62;
export const HULL_L = 0.4, HULL_W = 0.28; // hull hit box half-length / half-width (× type.scale)
export const MINE_R = 0.22, MINE_BLAST = 1.6, MINE_TRIGGER = 1.05, MINE_FUSE = 10, MINE_ARM = 0.6;
export const MINE_DMG_CENTRE = 110, MINE_DMG_EDGE = 45;
export const FACES = ['front', 'side', 'rear'];
export const MODULE = {
  TRACKS_T: 3, TURRET_T: 4, TURRET_SLOW: 0.4, ENGINE_SPEED: 0.6, FIRE_T: 5, FIRE_DPS: 4,
  P_TRACKS: 0.3, P_TURRET: 0.2, P_ENGINE: 0.35, P_FIRE: 0.4, P_AMMO: 0.05, AMMO_HP: 0.4,
};
export const RICOCHET_PEN = 0.7;
export { RICOCHET_ANGLE };
export const DISP_SETTLE = 1.2, DISP_BLOOM = 0.12; // time constants (s)
export const VIEW = 24, GHOST_VIEW = 2.6, HEAR = 15, REVEAL_T = 1.0, INTEL_EVERY = 6;
const SHELL_OWNER_GRACE = 0.2, SHELL_MAX_AGE = 10;

export function makeRng(seed) {
  let s = (seed >>> 0) || 0x9e3779b9;
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

export const wrapAngle = (a) => {
  a = (a + Math.PI) % (Math.PI * 2);
  if (a < 0) a += Math.PI * 2;
  return a - Math.PI;
};

// ---------------------------------------------------------------- grid queries
export function cellAt(grid, i, j) {
  const C = grid.cols;
  if (i < 0 || j < 0 || i >= C || j >= grid.rows) return CELL.BLOCK; // the frame
  return grid[j * C + i];
}
const shellSolid = (c) => c === CELL.BLOCK || c === CELL.CRATE;
const tankSolid = (c) => c !== CELL.FLOOR;

// Does a circle at (x,z) with radius r overlap a shell-solid cell?
export function circleHitsShellSolid(grid, x, z, r) {
  return solidCellAt(grid, x, z, r) !== null;
}

// The shell-solid cell a circle overlaps (the nearest one), or null. Returns a shared object.
const _cellHit = { i: 0, j: 0, c: 0 };
export function solidCellAt(grid, x, z, r = SHELL_R) {
  const i0 = Math.floor(x - r), i1 = Math.floor(x + r);
  const j0 = Math.floor(z - r), j1 = Math.floor(z + r);
  let best = Infinity, found = false;
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const c = cellAt(grid, i, j);
      if (!shellSolid(c)) continue;
      const cx = Math.max(i, Math.min(x, i + 1)), cz = Math.max(j, Math.min(z, j + 1));
      const dx = x - cx, dz = z - cz, d2 = dx * dx + dz * dz;
      if (d2 < r * r && d2 < best) { best = d2; found = true; _cellHit.i = i; _cellHit.j = j; _cellHit.c = c; }
    }
  }
  return found ? _cellHit : null;
}

// Line of sight for shells between two points (sampled; cheap and good enough for AI).
export function shellLineClear(grid, x0, z0, x1, z1, r = SHELL_R) {
  const d = Math.hypot(x1 - x0, z1 - z0);
  const n = Math.max(1, Math.ceil(d / 0.12));
  for (let k = 1; k <= n; k++) {
    const t = k / n;
    if (solidCellAt(grid, x0 + (x1 - x0) * t, z0 + (z1 - z0) * t, r)) return false;
  }
  return true;
}

// Vision line of sight by grid DDA: blocks and crates hide what's behind them; pits don't.
export function sightClear(grid, x0, z0, x1, z1) {
  let i = Math.floor(x0), j = Math.floor(z0);
  const ie = Math.floor(x1), je = Math.floor(z1);
  const dx = x1 - x0, dz = z1 - z0;
  const si = dx > 0 ? 1 : -1, sj = dz > 0 ? 1 : -1;
  const tdx = dx !== 0 ? Math.abs(1 / dx) : Infinity, tdz = dz !== 0 ? Math.abs(1 / dz) : Infinity;
  let tx = dx !== 0 ? (dx > 0 ? (i + 1 - x0) : (x0 - i)) * tdx : Infinity;
  let tz = dz !== 0 ? (dz > 0 ? (j + 1 - z0) : (z0 - j)) * tdz : Infinity;
  for (let n = 0; n < 400; n++) {
    if (i === ie && j === je) return true;
    if (tx < tz) { i += si; tx += tdx; } else { j += sj; tz += tdz; }
    if (i === ie && j === je) return true;
    const c = cellAt(grid, i, j);
    if (c === CELL.BLOCK || c === CELL.CRATE) return false;
  }
  return true;
}

// Legacy helper (the renderer's old aim line uses it): advance {x,z,dx,dz} by `dist`,
// reflecting off solid cells and calling onBounce(x,z) per contact (return false to stop).
// The live rules no longer bounce — shells stop on walls — so callers should stop on contact.
export function moveShell(grid, s, dist, onBounce) {
  let contacts = 0;
  const n = Math.max(1, Math.ceil(dist / 0.06));
  const step = dist / n;
  for (let k = 0; k < n; k++) {
    let hit = false;
    const nx = s.x + s.dx * step;
    if (circleHitsShellSolid(grid, nx, s.z, SHELL_R)) { s.dx = -s.dx; hit = true; } else s.x = nx;
    const nz = s.z + s.dz * step;
    if (circleHitsShellSolid(grid, s.x, nz, SHELL_R)) { s.dz = -s.dz; hit = true; } else s.z = nz;
    if (hit) {
      contacts++;
      if (!onBounce || onBounce(s.x, s.z) === false) return contacts;
    }
  }
  return contacts;
}

// ---------------------------------------------------------------- hull hit box
// Shell segment (x0,z0)→(x1,z1) travelling along (ddx,ddz) against a hull box centred at
// (cx,cz) facing `rot`. Returns null or a shared object describing the contact:
// { face: 0 front | 1 side | 2 rear, cos: cos(impact angle), nx,nz: world face normal, x,z: entry }.
// Used by the live world and by the AI's shot tracer, so predictions match reality.
const _hc = { face: 0, cos: 1, nx: 0, nz: 0, x: 0, z: 0 };
export function hullContact(cx, cz, rot, scale, x0, z0, x1, z1, ddx, ddz) {
  const L = HULL_L * scale + SHELL_R, W = HULL_W * scale + SHELL_R;
  const ax = x0 - cx, az = z0 - cz, bx = x1 - cx, bz = z1 - cz;
  const c = Math.cos(rot), s = Math.sin(rot);
  const p0x = ax * c + az * s, p0z = -ax * s + az * c;
  const p1x = bx * c + bz * s, p1z = -bx * s + bz * c;
  if (Math.max(p0x, p1x) < -L || Math.min(p0x, p1x) > L || Math.max(p0z, p1z) < -W || Math.min(p0z, p1z) > W) return null;
  const dx = p1x - p0x, dz = p1z - p0z;
  let ex, ez, axis;
  if (Math.abs(p0x) <= L && Math.abs(p0z) <= W) {
    // already inside (spawned inside / grazing corner): nearest face
    axis = (L - Math.abs(p0x)) < (W - Math.abs(p0z)) ? 0 : 1; ex = p0x; ez = p0z;
  } else {
    let tmin = 0, tmax = 1; axis = -1;
    if (Math.abs(dx) < 1e-12) { if (Math.abs(p0x) > L) return null; }
    else {
      let t1 = (-L - p0x) / dx, t2 = (L - p0x) / dx; if (t1 > t2) { const q = t1; t1 = t2; t2 = q; }
      if (t1 > tmin) { tmin = t1; axis = 0; }
      if (t2 < tmax) tmax = t2;
    }
    if (Math.abs(dz) < 1e-12) { if (Math.abs(p0z) > W) return null; }
    else {
      let t1 = (-W - p0z) / dz, t2 = (W - p0z) / dz; if (t1 > t2) { const q = t1; t1 = t2; t2 = q; }
      if (t1 > tmin) { tmin = t1; axis = 1; }
      if (t2 < tmax) tmax = t2;
    }
    if (tmin > tmax || axis < 0) return null;
    ex = p0x + dx * tmin; ez = p0z + dz * tmin;
  }
  const nlx = axis === 0 ? (ex >= 0 ? 1 : -1) : 0, nlz = axis === 1 ? (ez >= 0 ? 1 : -1) : 0;
  const ul = Math.hypot(ddx, ddz) || 1;
  const udx = (ddx * c + ddz * s) / ul, udz = (-ddx * s + ddz * c) / ul;
  _hc.face = axis === 1 ? 1 : ex >= 0 ? 0 : 2;
  _hc.cos = Math.max(0.02, Math.min(1, -(udx * nlx + udz * nlz)));
  _hc.nx = nlx * c - nlz * s; _hc.nz = nlx * s + nlz * c;
  _hc.x = cx + ex * c - ez * s; _hc.z = cz + ex * s + ez * c;
  return _hc;
}

// Chance a shell with `pen` penetrates `face` of type `ttype` at impact cos `cos` (0 if it ricochets).
export function penChance(pen, ttype, face, cos) {
  if (Math.acos(Math.min(1, cos)) > RICOCHET_ANGLE) return 0;
  const eff = ttype.armor[face] / Math.max(0.02, cos);
  return Math.max(0, Math.min(1, (1.25 - eff / pen) / 0.5));
}

// ---------------------------------------------------------------- driving
// Circle vs tank-solid cells: push out. Returns true if it collided.
function resolveTankGrid(grid, t) {
  let hit = false;
  for (let pass = 0; pass < 2; pass++) {
    const i0 = Math.floor(t.x - TANK_R), i1 = Math.floor(t.x + TANK_R);
    const j0 = Math.floor(t.z - TANK_R), j1 = Math.floor(t.z + TANK_R);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        if (!tankSolid(cellAt(grid, i, j))) continue;
        const cx = Math.max(i, Math.min(t.x, i + 1)), cz = Math.max(j, Math.min(t.z, j + 1));
        const dx = t.x - cx, dz = t.z - cz;
        const d2 = dx * dx + dz * dz;
        if (d2 >= TANK_R * TANK_R) continue;
        hit = true;
        if (d2 < 1e-9) { // centre inside the cell: push out along the shortest axis
          const l = t.x - i, r = i + 1 - t.x, u = t.z - j, dn = j + 1 - t.z;
          const m = Math.min(l, r, u, dn);
          if (m === l) t.x = i - TANK_R; else if (m === r) t.x = i + 1 + TANK_R;
          else if (m === u) t.z = j - TANK_R; else t.z = j + 1 + TANK_R;
          continue;
        }
        const d = Math.sqrt(d2);
        t.x = cx + (dx / d) * TANK_R;
        t.z = cz + (dz / d) * TANK_R;
      }
    }
  }
  return hit;
}

// Tank drive model, shared with the AI's dodge planner. `k` is a kinematic object
// {x,z,rot,rev} and `type` supplies speed/turnRate. Returns the signed distance moved.
export function driveTank(grid, k, type, mx, mz, dt) {
  const mag = Math.min(1, Math.hypot(mx, mz));
  if (mag < 0.08 || type.speed <= 0) return 0;
  const want = Math.atan2(mz, mx);
  const diff = wrapAngle(want - k.rot);
  // Tanks can drive backwards; switch with hysteresis so the hull does not flip-flop.
  const revDiff = wrapAngle(diff + Math.PI);
  if (k.rev) { if (Math.abs(diff) < Math.PI / 2 - 0.35) k.rev = false; }
  else if (Math.abs(revDiff) < Math.PI / 2 - 0.35) k.rev = true;
  const d = k.rev ? revDiff : diff;
  const maxTurn = type.turnRate * dt;
  const turn = Math.max(-maxTurn, Math.min(maxTurn, d));
  k.rot = wrapAngle(k.rot + turn);
  const left = Math.abs(d - turn);
  const f = left < 0.3 ? 1 : Math.max(0, Math.cos(Math.min(Math.PI / 2, left * 1.4)));
  const sp = type.speed * mag * f * (k.rev ? -0.8 : 1);
  const ox = k.x, oz = k.z;
  k.x += Math.cos(k.rot) * sp * dt;
  k.z += Math.sin(k.rot) * sp * dt;
  resolveTankGrid(grid, k);
  const moved = Math.hypot(k.x - ox, k.z - oz);
  return k.rev ? -moved : moved;
}

// Tank-style drive for the chase camera: throttle along the hull, steer rotates it.
export function driveTankDirect(grid, k, type, throttle, steer, dt) {
  if (type.speed <= 0 && type.turnRate <= 0) return 0;
  k.rot = wrapAngle(k.rot + Math.max(-1, Math.min(1, steer)) * type.turnRate * 0.36 * dt);
  const sp = type.speed * Math.max(-1, Math.min(1, throttle)) * (throttle < 0 ? 0.8 : 1);
  const ox = k.x, oz = k.z;
  k.x += Math.cos(k.rot) * sp * dt;
  k.z += Math.sin(k.rot) * sp * dt;
  resolveTankGrid(grid, k);
  const moved = Math.hypot(k.x - ox, k.z - oz);
  return throttle < 0 ? -moved : moved;
}

// Mobility after module damage: tracks off = can't move or turn the hull; engine hit = 60% speed.
export function mobilityOf(t) {
  const m = t._mob || (t._mob = { speed: 0, turnRate: 0 });
  const tracks = t.modules && t.modules.tracks > 0;
  m.speed = tracks ? 0 : t.type.speed * (t.modules && t.modules.engine ? MODULE.ENGINE_SPEED : 1);
  m.turnRate = tracks ? 0 : t.type.turnRate;
  return m;
}
export const turretRateOf = (t) => t.type.turretRate * (t.modules && t.modules.turret > 0 ? MODULE.TURRET_SLOW : 1);

// ---------------------------------------------------------------- spotting (team intel)
// Nobody is all-seeing. Each team knows what any of its tanks can see (line of sight within
// VIEW; ghosts only within GHOST_VIEW unless they fired in the last REVEAL_T s), plus rough
// fixes from shots heard within HEAR and from shells that hit them.
// intel[team][tankId] = { x, z, vx, vz, t (time last fixed), vis (pass id if in sight now, else -1), heard }
export function updateIntel(world, force = false) {
  if (!force && world._intelPass >= 0 && world.tick - world._intelPass < INTEL_EVERY) return world.intel;
  const pass = world._intelPass = world.tick;
  const intel = world.intel;
  const tanks = world.tanks;
  const teams = world._teams || (world._teams = [...new Set(tanks.map((t) => t.team))]);
  for (const team of teams) {
    const I = intel[team] || (intel[team] = {});
    for (const t of tanks) {
      if (t.team === team) continue;
      if (!t.alive) { delete I[t.id]; continue; }
      const range = t.type.invisible && !(t.revealT > world.time) ? GHOST_VIEW : VIEW;
      let seen = false;
      for (const o of tanks) {
        if (!o.alive || o.team !== team) continue;
        const dx = t.x - o.x, dz = t.z - o.z, d2 = dx * dx + dz * dz;
        if (d2 > range * range) continue;
        if (d2 < 1.6 * 1.6 || sightClear(world.grid, o.x, o.z, t.x, t.z)) { seen = true; break; }
      }
      if (seen) {
        const e = I[t.id] || (I[t.id] = {});
        e.x = t.x; e.z = t.z; e.vx = t.vx; e.vz = t.vz; e.t = world.time; e.vis = pass; e.heard = false;
      } else if (I[t.id]) I[t.id].vis = -1;
    }
  }
  return intel;
}
// Is `tankId` in sight of `team` right now? Own-team tanks always count as seen.
export function teamSees(world, team, tankId) {
  const t = world.tanks.find((q) => q.id === tankId);
  if (t && t.team === team) return true;
  const e = world.intel[team] && world.intel[team][tankId];
  return !!e && e.vis === world._intelPass && e.vis >= 0;
}
export const seesNow = (world, team, id) => { const e = world.intel[team] && world.intel[team][id]; return !!e && e.vis >= 0 && e.vis === world._intelPass; };
// A rough fix on `src` for every enemy team within `range` of it (a shot heard, a hit taken).
export function roughFix(world, src, range, jitter, onlyTeam = null) {
  for (const o of world.tanks) {
    if (!o.alive || o.team === src.team) continue;
    if (onlyTeam != null && o.team !== onlyTeam) continue;
    if (Math.hypot(o.x - src.x, o.z - src.z) > range) continue;
    const I = world.intel[o.team] || (world.intel[o.team] = {});
    const e = I[src.id];
    if (e && e.vis >= 0 && e.vis === world._intelPass) continue; // already in sight
    I[src.id] = { x: src.x + (world.rng() - 0.5) * jitter, z: src.z + (world.rng() - 0.5) * jitter, vx: 0, vz: 0, t: world.time, vis: -1, heard: true };
  }
}
export const hearShot = (world, shooter) => roughFix(world, shooter, HEAR, 3);

// ---------------------------------------------------------------- world
let nextId = 1;

// Resolve a type for a spawn: a TYPES key, optionally re-kitted to a class.
function typeFor(key, cls) {
  if (cls && CLASSES[cls]) return kitFor(TYPES[key] ? key : 'ally', cls);
  return TYPES[key] || TYPES.ally;
}

// opts: { level, seed, mode: 'campaign'|'versus', playerClass, allyClass, slots, tuneBrain }
// versus slots: [{ team, human, skill, style, cls, kit, sp (spawn digit), label, color }]
export function createWorld(opts) {
  const { level, seed = 1, mode = 'campaign', slots = null, tuneBrain = null, playerClass = 'medium', allyClass = 'medium' } = opts;
  const parsed = typeof level === 'string' || Array.isArray(level) ? parseLevel(level) : level.grid ? level : parseLevel(level);
  const world = {
    mode, tick: 0, time: 0, rng: makeRng(seed), seed,
    grid: withDims(Uint8Array.from(parsed.grid), parsed.cols, parsed.rows),
    cols: parsed.cols, rows: parsed.rows, props: parsed.props || [], name: parsed.name || '',
    tanks: [], shells: [], mines: [], events: [], scorch: [],
    outcome: null, outcomeT: 0, over: false,
    stats: { fired: 0, playerFired: 0, playerHits: 0, playerPens: 0, playerDmg: 0, dmgTaken: 0, kills: {}, ricochets: 0, pens: 0, nopens: 0 },
    intel: {}, _intelPass: -1, home: {},
    _shellFutureTick: -1, _shellFuture: null,
  };
  const spawn = (typeKey, type, x, z, team, extra = {}) => {
    const rot = extra.rot ?? (team === 0 ? 0 : Math.PI);
    const t = {
      id: nextId++, typeKey, type, team, x, z,
      rot, rev: false, aim: rot,
      alive: true, hp: type.hp, maxHp: type.hp,
      modules: { tracks: 0, turret: 0, engine: false, fire: 0, fireBy: null },
      disp: type.dispBase, cool: 0.4 + world.rng() * 0.6, burstLeft: 0, burstT: 0,
      mineCool: 1.5, tread: 0, recoil: 0, speedNow: 0, hitWall: false, revealT: 0, lastHitT: -99, lastHitBy: null,
      human: false, brain: null, skill: null, label: type.name, slot: extra.slot ?? null,
      ctrl: { mx: 0, mz: 0, aim: rot, fire: false, mine: false, hullAim: null },
      kills: 0, shots: 0, hits: 0, pens: 0, dmgDealt: 0, vx: 0, vz: 0, _px: x, _pz: z, _fireTickT: 0,
      ...extra,
    };
    t.aim = rot; t.ctrl.aim = rot;
    world.tanks.push(t);
    return t;
  };

  if (mode === 'campaign') {
    for (const s of parsed.spawns) {
      if (s.kind === 'player') {
        spawn('player', typeFor('player', playerClass), s.x, s.z, 0, { human: true, rot: facing(parsed, s) });
      } else if (s.kind === 'ally') {
        spawn('ally', typeFor('ally', allyClass), s.x, s.z, 0, { skill: 'veteran', style: 'hunt', label: 'Ally', rot: facing(parsed, s) });
      } else if (TYPES[s.kind]) {
        spawn(s.kind, TYPES[s.kind], s.x, s.z, 1, { rot: facing(parsed, s) });
      }
    }
  } else {
    // versus: each slot goes to spawn digit sl.sp (0-4 left side, 5-9 right side)
    const pts = parsed.spawns.filter((s) => s.kind === 'slot').sort((a, b) => a.slot - b.slot);
    slots.forEach((sl, idx) => {
      const p = pts.find((q) => q.slot === sl.sp) || pts[idx % pts.length];
      const key = sl.kit && TYPES[sl.kit] ? sl.kit : sl.human ? 'player' : 'ally';
      spawn(key, typeFor(key, sl.cls || (sl.kit && TYPES[sl.kit] ? null : 'medium')), p.x, p.z, sl.team, {
        human: !!sl.human, skill: sl.skill || null, style: sl.style || null,
        rot: facing(parsed, p), slot: idx, label: sl.label || (sl.human ? 'You' : 'Bot'),
        colorOverride: sl.color ?? null,
      });
    });
  }
  if (tuneBrain) world.tuneBrain = tuneBrain;
  computeHome(world);
  updateIntel(world, true);
  return world;
}

// Where each team started: bots with no contact advance toward the enemy's side.
export function computeHome(world) {
  world.home = {};
  for (const t of world.tanks) { const h = world.home[t.team] || (world.home[t.team] = { x: 0, z: 0, n: 0 }); h.x += t.x; h.z += t.z; h.n++; }
  for (const h of Object.values(world.home)) { h.x /= h.n; h.z /= h.n; }
  world._teams = null;
}

function facing(parsed, s) {
  // Face toward the arena centre so every tank starts looking at the fight.
  return Math.atan2(parsed.rows / 2 - s.z, parsed.cols / 2 - s.x);
}
export function withDims(grid, cols, rows) { grid.cols = cols; grid.rows = rows; return grid; }

export function emit(world, type, data) { world.events.push({ type, t: world.time, ...data }); }

const liveShellsOf = (world, t) => { let n = 0; for (const s of world.shells) if (s.owner === t.id && s.alive) n++; return n; };
const liveMinesOf = (world, t) => { let n = 0; for (const m of world.mines) if (m.owner === t.id && m.alive) n++; return n; };
export { liveShellsOf, liveMinesOf };
const tankById = (world, id) => { for (const t of world.tanks) if (t.id === id) return t; return null; };

// Roughly normal, mean 0, sd 1 (Irwin–Hall of 4), clamped to ±2.5. Deterministic via world.rng.
export function gauss(rng) { const g = (rng() + rng() + rng() + rng() - 2) * 1.7320508; return Math.max(-2.5, Math.min(2.5, g)); }

function tryFire(world, t) {
  const type = t.type;
  if (liveShellsOf(world, t) >= type.maxShells) return false;
  const cx = Math.cos(t.aim), cz = Math.sin(t.aim);
  const tx = t.x + cx * BARREL, tz = t.z + cz * BARREL;
  // A barrel stuck in a wall does not fire: that would spawn a shell inside the block.
  if (!shellLineClear(world.grid, t.x, t.z, tx, tz)) {
    emit(world, 'dud', { x: tx, z: tz, tank: t.id });
    t.cool = 0.25;
    return false;
  }
  const ang = t.aim + gauss(world.rng) * t.disp * 0.5;
  const s = {
    id: nextId++, owner: t.id, team: t.team, x: tx, z: tz, dx: Math.cos(ang), dz: Math.sin(ang),
    speed: type.shellSpeed, pen: type.pen, dmg: type.dmg, rocket: type.rocket, cls: type.cls,
    ricochets: 0, age: 0, alive: true, ignore: null, ignoreT: 0,
  };
  world.shells.push(s);
  t.recoil = 1; t.shots++;
  t.revealT = world.time + REVEAL_T;
  t.disp = Math.min(t.disp + type.dispMove * 0.5, type.dispBase + type.dispMove * 2); // firing kicks the aim
  world.stats.fired++;
  if (t.human) world.stats.playerFired++;
  hearShot(world, t);
  emit(world, 'fire', { x: tx, z: tz, angle: ang, tank: t.id, rocket: type.rocket, cls: type.cls, shell: s.id });
  return true;
}

function layMine(world, t) {
  if (liveMinesOf(world, t) >= t.type.mines || t.mineCool > 0) return false;
  for (const m of world.mines) if (m.alive && Math.hypot(m.x - t.x, m.z - t.z) < 0.6) return false;
  const m = { id: nextId++, owner: t.id, team: t.team, x: t.x, z: t.z, t: 0, alive: true, armed: false, trigger: -1 };
  world.mines.push(m);
  t.mineCool = 0.8;
  emit(world, 'mine', { x: m.x, z: m.z, tank: t.id, mine: m.id });
  return true;
}

function killTank(world, t, cause, byId) {
  if (!t.alive || world.outcome) return false; // once the round is decided, nobody else dies
  t.alive = false; t.hp = 0;
  t.modules.fire = 0;
  const by = tankById(world, byId);
  if (by && by.id !== t.id && by.team !== t.team) {
    by.kills++;
    world.stats.kills[t.typeKey] = (world.stats.kills[t.typeKey] || 0) + (by.human ? 1 : 0);
  }
  world.scorch.push({ x: t.x, z: t.z, rot: t.rot });
  emit(world, 'tankDie', { x: t.x, z: t.z, tank: t.id, cause, by: byId, typeKey: t.typeKey });
  return true;
}

// Apply damage; returns true if it killed. After the outcome nobody dies (hp floors at 1).
function damage(world, t, dmg, cause, byId) {
  if (!t.alive || dmg <= 0) return false;
  const by = tankById(world, byId);
  if (by && by.team !== t.team) { by.dmgDealt += Math.min(dmg, t.hp); if (by.human) world.stats.playerDmg += Math.min(dmg, t.hp); }
  if (t.human) world.stats.dmgTaken += Math.min(dmg, t.hp);
  if (world.outcome) { t.hp = Math.max(1, t.hp - dmg); return false; }
  t.hp -= dmg;
  if (t.hp <= 0) return killTank(world, t, cause, byId);
  return false;
}

// A shell touched tank `t`. `hc` is the hullContact result.
function shellHitsTank(world, s, t, hc) {
  const owner = tankById(world, s.owner);
  const face = hc.face, x = hc.x, z = hc.z, fname = FACES[face];
  if (owner && owner.team !== t.team) { owner.hits++; if (owner.human) world.stats.playerHits++; }
  t.lastHitT = world.time; t.lastHitBy = s.owner;
  // Getting hit tells you roughly where it came from.
  if (owner && owner.team !== t.team && owner.alive) roughFix(world, owner, 999, 4, t.team);
  const angle = Math.acos(hc.cos);
  if (angle > RICOCHET_ANGLE) {
    world.stats.ricochets++;
    emit(world, 'hit', { x, z, tank: t.id, by: s.owner, face: fname, result: 'ricochet', dmg: 0, module: null, shell: s.id });
    if (s.ricochets >= 1) { s.alive = false; return; }
    const dot = s.dx * hc.nx + s.dz * hc.nz;
    s.dx -= 2 * dot * hc.nx; s.dz -= 2 * dot * hc.nz;
    const l = Math.hypot(s.dx, s.dz) || 1; s.dx /= l; s.dz /= l;
    s.x = x + hc.nx * 0.03; s.z = z + hc.nz * 0.03;
    s.pen *= RICOCHET_PEN; s.ricochets++;
    s.ignore = t.id; s.ignoreT = 0.25;
    return;
  }
  s.alive = false;
  const eff = t.type.armor[face] / hc.cos;
  const roll = s.pen * (0.75 + 0.5 * world.rng());
  if (roll < eff) {
    world.stats.nopens++;
    emit(world, 'hit', { x, z, tank: t.id, by: s.owner, face: fname, result: 'nopen', dmg: 0, module: null, shell: s.id });
    return;
  }
  world.stats.pens++;
  if (owner && owner.team !== t.team) { owner.pens++; if (owner.human) world.stats.playerPens++; }
  const dmg = Math.round(s.dmg * (0.8 + 0.4 * world.rng()));
  let module = null, ammo = false;
  const M = t.modules, r = world.rng();
  if (t.hp < t.maxHp * MODULE.AMMO_HP && world.rng() < MODULE.P_AMMO) { module = 'ammo'; ammo = true; }
  else if (face === 1 && r < MODULE.P_TRACKS) { module = 'tracks'; M.tracks = MODULE.TRACKS_T; }
  else if (face === 0 && r < MODULE.P_TURRET) { module = 'turret'; M.turret = MODULE.TURRET_T; }
  else if (face === 2 && r < MODULE.P_ENGINE) {
    module = 'engine'; M.engine = true;
    if (world.rng() < MODULE.P_FIRE) { module = 'fire'; M.fire = MODULE.FIRE_T; M.fireBy = s.owner; }
  }
  emit(world, 'hit', { x, z, tank: t.id, by: s.owner, face: fname, result: 'pen', dmg, module, shell: s.id, fire: module === 'fire' });
  damage(world, t, ammo ? Math.max(dmg, t.hp) : dmg, ammo ? 'ammo' : 'shell', s.owner);
}

function explodeMine(world, m) {
  if (!m.alive) return;
  m.alive = false;
  emit(world, 'explode', { x: m.x, z: m.z, mine: m.id, owner: m.owner });
  for (const t of world.tanks) {
    if (!t.alive) continue;
    const r = Math.hypot(t.x - m.x, t.z - m.z);
    if (r >= MINE_BLAST) continue;
    const dmg = Math.round(MINE_DMG_CENTRE - (MINE_DMG_CENTRE - MINE_DMG_EDGE) * (r / MINE_BLAST));
    t.modules.tracks = Math.max(t.modules.tracks, MODULE.TRACKS_T);
    t.lastHitT = world.time; t.lastHitBy = m.owner;
    emit(world, 'hit', { x: t.x, z: t.z, tank: t.id, by: m.owner, face: null, result: 'pen', dmg, module: 'tracks', mine: m.id });
    damage(world, t, dmg, 'mine', m.owner);
  }
  for (const s of world.shells) {
    if (s.alive && Math.hypot(s.x - m.x, s.z - m.z) < MINE_BLAST) { s.alive = false; emit(world, 'impact', { x: s.x, z: s.z, shell: s.id }); }
  }
  const r = MINE_BLAST + 0.25;
  for (let j = Math.floor(m.z - r); j <= Math.floor(m.z + r); j++) {
    for (let i = Math.floor(m.x - r); i <= Math.floor(m.x + r); i++) {
      if (cellAt(world.grid, i, j) !== CELL.CRATE) continue;
      if (Math.hypot(i + 0.5 - m.x, j + 0.5 - m.z) < r) breakCrate(world, i, j, null);
    }
  }
  for (const o of world.mines) {
    if (o.alive && o.trigger < 0 && Math.hypot(o.x - m.x, o.z - m.z) < MINE_BLAST) o.trigger = 0.12;
  }
}

function breakCrate(world, i, j, shell) {
  world.grid[j * world.cols + i] = CELL.FLOOR;
  emit(world, 'crateBreak', { i, j, x: i + 0.5, z: j + 0.5, shell });
}

// Move one shell for one tick: straight line, sub-stepped; walls, crates, hulls, mines.
function stepShell(world, s, dt) {
  const dist = s.speed * dt;
  const n = Math.max(1, Math.ceil(dist / 0.06));
  const st = dist / n;
  const grid = world.grid, tanks = world.tanks;
  for (let k = 0; k < n; k++) {
    const nx = s.x + s.dx * st, nz = s.z + s.dz * st;
    const cell = solidCellAt(grid, nx, nz, SHELL_R);
    // tanks first if the hull is reached before the wall this substep (both within 0.06: tank wins)
    let hitT = null, hc = null, best = Infinity;
    for (const t of tanks) {
      if (!t.alive) continue;
      if (t.id === s.owner && s.ricochets === 0 && s.age < SHELL_OWNER_GRACE) continue;
      if (s.ignore === t.id && s.ignoreT > 0) continue;
      const dx = t.x - s.x, dz = t.z - s.z;
      if (dx * dx + dz * dz > 1.2) continue;
      const c = hullContact(t.x, t.z, t.rot, t.type.scale || 1, s.x, s.z, nx, nz, s.dx, s.dz);
      if (!c) continue;
      const d = (c.x - s.x) ** 2 + (c.z - s.z) ** 2;
      if (d < best) { best = d; hitT = t; hc = { ...c }; }
    }
    if (hitT) { shellHitsTank(world, s, hitT, hc); if (!s.alive) return; continue; }
    if (cell) {
      s.alive = false;
      if (cell.c === CELL.CRATE && cell.i >= 0 && cell.j >= 0 && cell.i < world.cols && cell.j < world.rows) breakCrate(world, cell.i, cell.j, s.id);
      else emit(world, 'impact', { x: s.x, z: s.z, shell: s.id });
      return;
    }
    s.x = nx; s.z = nz;
    for (const m of world.mines) {
      if (m.alive && (m.x - s.x) ** 2 + (m.z - s.z) ** 2 < (MINE_R + SHELL_R) ** 2) { s.alive = false; explodeMine(world, m); return; }
    }
  }
}

export function step(world, brains) {
  const dt = DT;
  if (world.over) return;
  world.tick++; world.time += dt;
  updateIntel(world);

  // 1. controllers
  for (const t of world.tanks) {
    if (!t.alive) continue;
    if ((!t.human || t.botDriven) && brains) brains(world, t, dt);
  }

  // 2. tanks
  for (const t of world.tanks) {
    if (!t.alive) continue;
    const c = t.ctrl, M = t.modules, type = t.type;
    M.tracks = Math.max(0, M.tracks - dt);
    M.turret = Math.max(0, M.turret - dt);
    const mob = mobilityOf(t);
    const rot0 = t.rot, aim0 = t.aim;
    let moved = c.drive
      ? driveTankDirect(world.grid, t, mob, c.throttle || 0, c.steer || 0, dt)
      : driveTank(world.grid, t, mob, c.mx, c.mz, dt);
    if (!c.drive && c.hullAim != null && moved === 0 && Math.hypot(c.mx, c.mz) < 0.08 && mob.turnRate > 0) {
      const d = wrapAngle(c.hullAim - t.rot), mt = mob.turnRate * 0.6 * dt; // pivot in place
      t.rot = wrapAngle(t.rot + Math.max(-mt, Math.min(mt, d)));
    }
    t.tread += moved;
    t.speedNow = moved / dt;
    // turret: world-space aim; the hull turning under it does not drag it along
    const d = wrapAngle(c.aim - t.aim);
    const mt = turretRateOf(t) * dt;
    t.aim = wrapAngle(t.aim + Math.max(-mt, Math.min(mt, d)));
    // dispersion
    const hullTurn = Math.abs(wrapAngle(t.rot - rot0)) / dt, trav = Math.abs(wrapAngle(t.aim - aim0)) / dt;
    const mv = (type.speed > 0 ? Math.abs(t.speedNow) / type.speed : 0) + (type.turnRate > 0 ? 0.5 * hullTurn / type.turnRate : 0) + 0.6 * trav / type.turretRate;
    const want = type.dispBase + type.dispMove * Math.min(1.6, mv);
    t.disp += (want - t.disp) * (1 - Math.exp(-dt / (want > t.disp ? DISP_BLOOM : DISP_SETTLE)));
    t.recoil = Math.max(0, t.recoil - dt * 5);
    t.cool -= dt; t.mineCool -= dt;
    if (t.burstLeft > 0) {
      t.burstT -= dt;
      if (t.burstT <= 0) { if (tryFire(world, t)) { t.burstLeft--; t.burstT = type.burstGap; } else t.burstLeft = 0; }
    } else if (c.fire && t.cool <= 0) {
      if (tryFire(world, t)) {
        t.cool = type.reload;
        if (type.burst > 1) { t.burstLeft = type.burst - 1; t.burstT = type.burstGap; }
      }
    }
    c.fire = false;
    if (c.mine) { layMine(world, t); c.mine = false; }
    // fire damage over time
    if (M.fire > 0) {
      M.fire = Math.max(0, M.fire - dt);
      t._fireTickT -= dt;
      if (t._fireTickT <= 0) { t._fireTickT = 0.5; emit(world, 'fireTick', { tank: t.id, x: t.x, z: t.z }); }
      damage(world, t, MODULE.FIRE_DPS * dt, 'fire', M.fireBy);
    }
  }
  // tank vs tank separation
  const ts = world.tanks;
  for (let a = 0; a < ts.length; a++) {
    const A = ts[a]; if (!A.alive) continue;
    for (let b = a + 1; b < ts.length; b++) {
      const B = ts[b]; if (!B.alive) continue;
      const dx = B.x - A.x, dz = B.z - A.z, d = Math.hypot(dx, dz), min = TANK_R * 2;
      if (d < min && d > 1e-6) {
        const push = (min - d) / 2, nx = dx / d, nz = dz / d;
        const aMov = A.type.speed > 0, bMov = B.type.speed > 0;
        const wa = aMov && bMov ? 1 : aMov ? 2 : 0, wb = aMov && bMov ? 1 : bMov ? 2 : 0;
        A.x -= nx * push * wa; A.z -= nz * push * wa;
        B.x += nx * push * wb; B.z += nz * push * wb;
        resolveTankGrid(world.grid, A); resolveTankGrid(world.grid, B);
      }
    }
  }
  for (const t of ts) if (t.alive) { t.vx = (t.x - t._px) / dt || 0; t.vz = (t.z - t._pz) / dt || 0; t._px = t.x; t._pz = t.z; }

  // 3. shells
  for (const s of world.shells) {
    if (!s.alive) continue;
    s.age += dt;
    if (s.ignoreT > 0) s.ignoreT -= dt;
    if (s.age > SHELL_MAX_AGE) { s.alive = false; emit(world, 'impact', { x: s.x, z: s.z, shell: s.id }); continue; }
    stepShell(world, s, dt);
  }
  const sh = world.shells;
  for (let a = 0; a < sh.length; a++) {
    const A = sh[a]; if (!A.alive) continue;
    for (let b = a + 1; b < sh.length; b++) {
      const B = sh[b]; if (!B.alive) continue;
      if (Math.hypot(A.x - B.x, A.z - B.z) < SHELL_R * 2.4) {
        A.alive = false; B.alive = false;
        emit(world, 'shellClash', { x: (A.x + B.x) / 2, z: (A.z + B.z) / 2, shells: [A.id, B.id] });
      }
    }
  }

  // 4. mines
  for (const m of world.mines) {
    if (!m.alive) continue;
    m.t += dt;
    if (!m.armed && m.t >= MINE_ARM) m.armed = true;
    if (m.trigger >= 0) { m.trigger -= dt; if (m.trigger <= 0) { explodeMine(world, m); continue; } }
    if (m.t >= MINE_FUSE) { explodeMine(world, m); continue; }
    if (m.armed) {
      for (const t of world.tanks) {
        if (t.alive && t.team !== m.team && Math.hypot(t.x - m.x, t.z - m.z) < MINE_TRIGGER) { m.trigger = 0.25; emit(world, 'mineTrip', { mine: m.id }); break; }
      }
    }
  }

  // housekeeping (keep arrays small; renderer tracks by id)
  if (world.tick % 30 === 0) {
    world.shells = world.shells.filter((s) => s.alive);
    world.mines = world.mines.filter((m) => m.alive);
  }

  // 5. outcome
  if (!world.outcome) {
    const teams = new Set(world.tanks.filter((t) => t.alive).map((t) => t.team));
    if (world.mode === 'campaign') {
      const player = world.tanks.find((t) => t.human);
      if (!player || !player.alive) world.outcome = 'lost';
      else if (!world.tanks.some((t) => t.alive && t.team !== 0)) world.outcome = 'won';
    } else {
      if (teams.size <= 1) world.outcome = teams.size === 0 ? 'draw' : 'team' + [...teams][0];
    }
    if (world.outcome) { world.outcomeT = world.time; emit(world, 'outcome', { outcome: world.outcome }); }
  } else if (world.time - world.outcomeT > 2.2) {
    world.over = true;
  }
}
