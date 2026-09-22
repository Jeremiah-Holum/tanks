// Pure game rules. No DOM, no three.js — this runs identically in node (tools/sim.mjs)
// and in the browser. The renderer reads `world` and drains `world.events`.
import { TYPES } from './tanks.js';
import { parseLevel } from './levels.js';

export const COLS = 44, ROWS = 32, DT = 1 / 60; // defaults; each grid carries its own .cols/.rows
export const CELL = { FLOOR: 0, BLOCK: 1, CRATE: 2, PIT: 3 };
export const TANK_R = 0.36, SHELL_R = 0.085, BARREL = 0.62;
export const MINE_R = 0.22, MINE_BLAST = 1.6, MINE_TRIGGER = 1.05, MINE_FUSE = 10, MINE_ARM = 0.6;
const SHELL_OWNER_GRACE = 0.2;

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
  const i0 = Math.floor(x - r), i1 = Math.floor(x + r);
  const j0 = Math.floor(z - r), j1 = Math.floor(z + r);
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      if (!shellSolid(cellAt(grid, i, j))) continue;
      const cx = Math.max(i, Math.min(x, i + 1)), cz = Math.max(j, Math.min(z, j + 1));
      const dx = x - cx, dz = z - cz;
      if (dx * dx + dz * dz < r * r) return true;
    }
  }
  return false;
}

// Line of sight for shells between two points (sampled; cheap and good enough for AI).
export function shellLineClear(grid, x0, z0, x1, z1, r = SHELL_R) {
  const d = Math.hypot(x1 - x0, z1 - z0);
  const n = Math.max(1, Math.ceil(d / 0.12));
  for (let k = 1; k <= n; k++) {
    const t = k / n;
    if (circleHitsShellSolid(grid, x0 + (x1 - x0) * t, z0 + (z1 - z0) * t, r)) return false;
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

// Advance a shell-like object {x,z,dx,dz} by `dist`, reflecting off solid cells.
// Returns the number of wall contacts made (a corner counts once). This exact function is
// used by the live world *and* by the AI's shot tracer, so predictions match reality.
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
      if (onBounce && onBounce(s.x, s.z) === false) return contacts;
    }
  }
  return contacts;
}

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
        let dx = t.x - cx, dz = t.z - cz;
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
  let diff = wrapAngle(want - k.rot);
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
  const sp = type.speed * mag * f * (k.rev ? -1 : 1);
  const ox = k.x, oz = k.z;
  k.x += Math.cos(k.rot) * sp * dt;
  k.z += Math.sin(k.rot) * sp * dt;
  resolveTankGrid(grid, k);
  const moved = Math.hypot(k.x - ox, k.z - oz);
  return k.rev ? -moved : moved;
}

// Tank-style drive for the chase camera: throttle along the hull, steer rotates it.
export function driveTankDirect(grid, k, type, throttle, steer, dt) {
  if (type.speed <= 0) return 0;
  k.rot = wrapAngle(k.rot + steer * type.turnRate * 0.36 * dt);
  const sp = type.speed * Math.max(-1, Math.min(1, throttle)) * (throttle < 0 ? 0.8 : 1);
  const ox = k.x, oz = k.z;
  k.x += Math.cos(k.rot) * sp * dt;
  k.z += Math.sin(k.rot) * sp * dt;
  resolveTankGrid(grid, k);
  const moved = Math.hypot(k.x - ox, k.z - oz);
  return throttle < 0 ? -moved : moved;
}

// ---------------------------------------------------------------- world
let nextId = 1;

export function createWorld(opts) {
  const { level, seed = 1, mode = 'campaign', slots = null, tuneBrain = null } = opts;
  const parsed = typeof level === 'string' || Array.isArray(level) ? parseLevel(level) : level;
  const world = {
    mode, tick: 0, time: 0, rng: makeRng(seed), seed,
    grid: withDims(Uint8Array.from(parsed.grid), parsed.cols, parsed.rows),
    cols: parsed.cols, rows: parsed.rows, props: parsed.props || [], name: parsed.name || '',
    tanks: [], shells: [], mines: [], events: [], scorch: [],
    outcome: null, outcomeT: 0, over: false,
    stats: { fired: 0, playerFired: 0, playerHits: 0, kills: {}, bounces: 0 },
    _shellFutureTick: -1, _shellFuture: null,
  };
  const spawn = (typeKey, x, z, team, extra = {}) => {
    const type = TYPES[typeKey];
    const t = {
      id: nextId++, typeKey, type, team, x, z,
      rot: extra.rot ?? (team === 0 ? 0 : Math.PI), rev: false,
      aim: extra.rot ?? (team === 0 ? 0 : Math.PI),
      alive: true, cool: 0.4 + world.rng() * 0.6, burstLeft: 0, burstT: 0,
      mineCool: 1.5, tread: 0, recoil: 0, speedNow: 0, hitWall: false,
      human: false, brain: null, skill: null, label: type.name, slot: extra.slot ?? null,
      ctrl: { mx: 0, mz: 0, aim: extra.rot ?? 0, fire: false, mine: false },
      kills: 0, shots: 0, hits: 0, vx: 0, vz: 0, _px: x, _pz: z,
      ...extra,
    };
    world.tanks.push(t);
    return t;
  };

  if (mode === 'campaign') {
    for (const s of parsed.spawns) {
      if (s.kind === 'player') {
        spawn('player', s.x, s.z, 0, { human: true, rot: facing(parsed, s) });
      } else if (s.kind === 'ally') {
        spawn('ally', s.x, s.z, 0, { skill: 'veteran', style: 'hunt', label: 'Ally', rot: facing(parsed, s) });
      } else if (TYPES[s.kind]) {
        spawn(s.kind, s.x, s.z, 1, { rot: facing(parsed, s) });
      }
    }
  } else {
    // versus: slots = [{team, human, skill, style, kit}] mapped onto spawn points 1..4
    const pts = parsed.spawns.filter((s) => s.kind === 'slot').sort((a, b) => a.slot - b.slot);
    slots.forEach((sl, idx) => {
      const p = pts.find((q) => q.slot === sl.sp) || pts[idx % pts.length];
      spawn(sl.kit || (sl.human ? 'player' : 'ally'), p.x, p.z, sl.team, {
        human: !!sl.human, skill: sl.skill || null, style: sl.style || null,
        rot: facing(parsed, p), slot: idx, label: sl.label || (sl.human ? 'You' : 'Bot'),
        colorOverride: sl.color ?? null,
      });
    });
  }
  if (tuneBrain) world.tuneBrain = tuneBrain;
  // Where each team started: bots with no contact advance toward the enemy's side.
  world.home = {};
  for (const t of world.tanks) { const h = world.home[t.team] || (world.home[t.team] = { x: 0, z: 0, n: 0 }); h.x += t.x; h.z += t.z; h.n++; }
  for (const h of Object.values(world.home)) { h.x /= h.n; h.z /= h.n; }
  world.intel = {};
  return world;
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
  const s = {
    id: nextId++, owner: t.id, team: t.team, x: tx, z: tz, dx: cx, dz: cz,
    speed: type.shellSpeed, maxBounces: type.bounces, bounces: 0, rocket: type.rocket,
    age: 0, alive: true,
  };
  world.shells.push(s);
  t.recoil = 1; t.shots++;
  world.stats.fired++;
  if (t.human) world.stats.playerFired++;
  emit(world, 'fire', { x: tx, z: tz, angle: t.aim, tank: t.id, rocket: type.rocket, shell: s.id });
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
  if (!t.alive || world.outcome) return; // once the round is decided, nobody else dies
  t.alive = false;
  const by = world.tanks.find((o) => o.id === byId);
  if (by && by.id !== t.id && by.team !== t.team) {
    by.kills++;
    world.stats.kills[t.typeKey] = (world.stats.kills[t.typeKey] || 0) + (by.human ? 1 : 0);
  }
  world.scorch.push({ x: t.x, z: t.z, rot: t.rot });
  emit(world, 'tankDie', { x: t.x, z: t.z, tank: t.id, cause, by: byId, typeKey: t.typeKey });
}

function explodeMine(world, m) {
  if (!m.alive) return;
  m.alive = false;
  emit(world, 'explode', { x: m.x, z: m.z, mine: m.id, owner: m.owner });
  for (const t of world.tanks) {
    if (t.alive && Math.hypot(t.x - m.x, t.z - m.z) < MINE_BLAST) killTank(world, t, 'mine', m.owner);
  }
  for (const s of world.shells) {
    if (s.alive && Math.hypot(s.x - m.x, s.z - m.z) < MINE_BLAST) { s.alive = false; emit(world, 'shellPop', { x: s.x, z: s.z, shell: s.id }); }
  }
  const r = MINE_BLAST + 0.25;
  for (let j = Math.floor(m.z - r); j <= Math.floor(m.z + r); j++) {
    for (let i = Math.floor(m.x - r); i <= Math.floor(m.x + r); i++) {
      if (cellAt(world.grid, i, j) !== CELL.CRATE) continue;
      if (Math.hypot(i + 0.5 - m.x, j + 0.5 - m.z) < r) {
        world.grid[j * world.cols + i] = CELL.FLOOR;
        emit(world, 'crateBreak', { i, j });
      }
    }
  }
  for (const o of world.mines) {
    if (o.alive && o.trigger < 0 && Math.hypot(o.x - m.x, o.z - m.z) < MINE_BLAST) o.trigger = 0.12;
  }
}

export function step(world, brains) {
  const dt = DT;
  if (world.over) return;
  world.tick++; world.time += dt;

  // 1. controllers
  for (const t of world.tanks) {
    if (!t.alive) continue;
    if ((!t.human || t.botDriven) && brains) brains(world, t, dt);
  }

  // 2. tanks
  for (const t of world.tanks) {
    if (!t.alive) continue;
    const c = t.ctrl;
    const moved = c.drive
      ? driveTankDirect(world.grid, t, t.type, c.throttle || 0, c.steer || 0, dt)
      : driveTank(world.grid, t, t.type, c.mx, c.mz, dt);
    t.tread += moved;
    t.speedNow = moved / dt;
    // turret
    const d = wrapAngle(c.aim - t.aim);
    const mt = t.type.turretRate * dt;
    t.aim = wrapAngle(t.aim + Math.max(-mt, Math.min(mt, d)));
    t.recoil = Math.max(0, t.recoil - dt * 5);
    t.cool -= dt; t.mineCool -= dt;
    if (t.burstLeft > 0) {
      t.burstT -= dt;
      if (t.burstT <= 0) { if (tryFire(world, t)) { t.burstLeft--; t.burstT = t.type.burstGap; } else t.burstLeft = 0; }
    } else if (c.fire && t.cool <= 0) {
      if (tryFire(world, t)) {
        t.cool = t.type.reload;
        if (t.type.burst > 1) { t.burstLeft = t.type.burst - 1; t.burstT = t.type.burstGap; }
      }
    }
    c.fire = false;
    if (c.mine) { layMine(world, t); c.mine = false; }
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
    moveShell(world.grid, s, s.speed * dt, (x, z) => {
      s.bounces++;
      world.stats.bounces++;
      if (s.bounces > s.maxBounces) {
        s.alive = false;
        emit(world, 'shellPop', { x, z, shell: s.id, wall: true });
        return false;
      }
      emit(world, 'bounce', { x, z, shell: s.id });
      return true;
    });
    if (!s.alive) continue;
    for (const t of world.tanks) {
      if (!t.alive) continue;
      if (t.id === s.owner && s.bounces === 0 && s.age < SHELL_OWNER_GRACE) continue;
      if (Math.hypot(t.x - s.x, t.z - s.z) < TANK_R + SHELL_R) {
        s.alive = false;
        const owner = world.tanks.find((o) => o.id === s.owner);
        if (owner && owner.team !== t.team) { owner.hits++; if (owner.human) world.stats.playerHits++; }
        killTank(world, t, 'shell', s.owner);
        break;
      }
    }
    if (!s.alive) continue;
    for (const m of world.mines) {
      if (m.alive && Math.hypot(m.x - s.x, m.z - s.z) < MINE_R + SHELL_R) { s.alive = false; explodeMine(world, m); break; }
    }
  }
  const sh = world.shells;
  for (let a = 0; a < sh.length; a++) {
    const A = sh[a]; if (!A.alive) continue;
    for (let b = a + 1; b < sh.length; b++) {
      const B = sh[b]; if (!B.alive) continue;
      if (Math.hypot(A.x - B.x, A.z - B.z) < SHELL_R * 2.4) {
        A.alive = false; B.alive = false;
        emit(world, 'shellClash', { x: (A.x + B.x) / 2, z: (A.z + B.z) / 2 });
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
