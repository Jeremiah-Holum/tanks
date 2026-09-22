// Scripted tank brains. No learning, no models: a direct-fire shot planner that traces shells
// through the real hit code (walls, hull faces, armour), a dodge planner that simulates the real
// drive model against every live shell's future, grid flow fields for movement, team spotting
// (bots only shoot what their team can see), and a tactics layer (settle the aim, prefer side and
// rear shots, flank, angle armour, duck into cover while reloading).
import {
  DT, CELL, TANK_R, SHELL_R, BARREL, MINE_R, MINE_BLAST, MINE_FUSE, HULL_W,
  cellAt, solidCellAt, shellLineClear, sightClear, driveTank, wrapAngle, liveShellsOf, liveMinesOf,
  hullContact, penChance, mobilityOf, updateIntel, seesNow, hearShot, teamSees, VIEW, GHOST_VIEW, HEAR,
} from './world.js';
import { SKILLS } from './tanks.js';

export { updateIntel, seesNow, hearShot, teamSees, VIEW, GHOST_VIEW, HEAR };

const FUTURE_T = 1.0, FUTURE_EVERY = 2; // shell futures: 1 s ahead, a sample every 2 ticks
const FUTURE_N = Math.round(FUTURE_T / DT / FUTURE_EVERY);
const LEAD_MAX_AGE = 15;     // s: how long a last-known position stays interesting
const SNAP_RANGE = 3.5;      // closer than this, don't wait for the aim to settle
const ANGLE_OFF = 0.52;      // ~30°: how far Aces turn their front plate off the threat

// ------------------------------------------------------------------ profiles
const DEFAULTS = { think: 0.3, aimErr: 0.05, lead: false, dodge: false, dodgeLook: 0.4, fireTol: 0.06, mineUse: 0, verify: 'loose', counterFire: false, tactics: false, patience: 0.4, angle: false, flank: false };
export function profileOf(t) {
  if (t._profile) return t._profile;
  let P;
  if (t.skill) P = typeof t.skill === 'string' ? SKILLS[t.skill] : t.skill;
  else P = t.type.ai || SKILLS.veteran;
  P = { ...DEFAULTS, ...P };
  P.style = t.style || P.style || 'hunt';
  if (P.tactics == null) P.tactics = P.style === 'hunt' || P.style === 'trick';
  if (P.style === 'trick') P.flank = true;
  if (P.fireGap == null) P.fireGap = 0.3;
  t._profile = P;
  return P;
}

const BLOCK = 4; // coarse search grid (cells per block side)
function newBrain(world, t) {
  return {
    spawn: { x: t.x, z: t.z }, seen: new Float32Array(Math.ceil(world.cols / BLOCK) * Math.ceil(world.rows / BLOCK)).fill(-99),
    thinkT: world.rng() * 0.3, shot: null, err: 0, target: null,
    goal: null, goalT: 0, goalKind: '', flow: null, flowKey: '', flowT: 0,
    sweep: world.rng() < 0.5 ? -1 : 1, fireGap: 0.5 + world.rng(),
    lastDir: -1, stuckT: 0, mineT: 1 + world.rng() * 2, flee: null, dodging: 0, cantDodge: false,
    waitT: 0, hopelessT: 0, checked: {}, holding: false, explore: 0,
  };
}

// ------------------------------------------------------------------ helpers
const passable = (grid, i, j) => cellAt(grid, i, j) === CELL.FLOOR;
const isEnemy = (a, b) => a.team !== b.team;

// erf, Abramowitz–Stegun 7.1.26 (|error| < 1.5e-7)
function erf(x) {
  const s = x < 0 ? -1 : 1; x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
// Chance a shell fired with dispersion `disp` lands within a hull ~`half` wide at distance d.
export function hitProb(disp, d, half = HULL_W + SHELL_R + 0.04) {
  const a = Math.atan2(half, Math.max(0.3, d)), sd = Math.max(1e-4, disp * 0.5);
  return erf(a / (sd * Math.SQRT2));
}

// ------------------------------------------------------------------ targets
// Visible enemies (to my team, right now) and the freshest last-known lead otherwise.
function pickTarget(world, t, B) {
  const I = world.intel[t.team] || {};
  let best = null, bd = Infinity, lead = null, lt = -Infinity;
  for (const o of world.tanks) {
    if (!o.alive || !isEnemy(t, o)) continue;
    const e = I[o.id];
    if (!e) continue;
    if (e.vis >= 0 && e.vis === world._intelPass) {
      const d = Math.hypot(o.x - t.x, o.z - t.z);
      if (d < bd) { bd = d; best = o; }
    } else if (world.time - e.t < LEAD_MAX_AGE && e.t > lt && B.checked[o.id] !== e.t) {
      lt = e.t; lead = { x: e.x, z: e.z, id: o.id, ghost: true, seenT: e.t };
    }
  }
  return best || lead;
}

// The n nearest enemies my team can see right now.
function visibleFoes(world, t, n) {
  const out = [];
  for (const o of world.tanks) if (o.alive && isEnemy(t, o) && seesNow(world, t.team, o.id)) out.push(o);
  out.sort((a, b) => Math.hypot(a.x - t.x, a.z - t.z) - Math.hypot(b.x - t.x, b.z - t.z));
  return out.slice(0, n);
}

// Shell futures for every live shell, computed once per tick and shared by all brains.
// Straight lines that stop at the first wall (tank ricochets aren't predicted).
export function shellFutures(world) {
  if (world._shellFutureTick === world.tick) return world._shellFuture;
  const out = [];
  for (const s of world.shells) {
    if (!s.alive) continue;
    const xs = s._fx || (s._fx = new Float32Array(FUTURE_N)), zs = s._fz || (s._fz = new Float32Array(FUTURE_N));
    let x = s.x, z = s.z, n = 0;
    const stepD = s.speed * DT * FUTURE_EVERY;
    for (let k = 0; k < FUTURE_N; k++) {
      const nx = x + s.dx * stepD, nz = z + s.dz * stepD;
      if (solidCellAt(world.grid, nx, nz, SHELL_R)) break;
      x = nx; z = nz; xs[k] = x; zs[k] = z; n++;
    }
    out.push({ s, xs, zs, n });
  }
  world._shellFutureTick = world.tick; world._shellFuture = out;
  return out;
}

// Trace a shell fired by `shooter` at `angle` through the real wall and hull code.
// Returns { kind: 'enemy'|'self'|'ally'|'wall'|'blocked'|'none', tank, time, dist, face, cos }.
// opts.lead: move tanks along their velocity while the shell flies (capped at 1.6 s).
export function traceShot(world, shooter, angle, opts = {}) {
  const cx = Math.cos(angle), cz = Math.sin(angle);
  const sx = shooter.x + cx * BARREL, sz = shooter.z + cz * BARREL;
  if (!shellLineClear(world.grid, shooter.x, shooter.z, sx, sz)) return { kind: 'blocked', time: 0, dist: 0 };
  const speed = shooter.type.shellSpeed;
  const stepD = 0.1;
  const maxLen = opts.maxLen ?? 34;
  const maxK = Math.ceil(maxLen / stepD);
  const lead = opts.lead ? 1.6 : 0;
  const tanks = world.tanks;
  let x = sx, z = sz;
  for (let k = 1; k <= maxK; k++) {
    const nx = x + cx * stepD, nz = z + cz * stepD;
    const dist = k * stepD, time = dist / speed;
    let hit = null, hc = null, best = Infinity;
    for (let q = 0; q < tanks.length; q++) {
      const o = tanks[q];
      if (!o.alive) continue;
      if (o === shooter && time < 0.25) continue;
      let ox = o.x, oz = o.z;
      if (lead && o !== shooter) { const lt = Math.min(time, lead); ox += o.vx * lt; oz += o.vz * lt; }
      const dx = ox - x, dz = oz - z;
      if (dx * dx + dz * dz > 1.3) continue;
      const c = hullContact(ox, oz, o.rot, o.type.scale || 1, x, z, nx, nz, cx, cz);
      if (!c) continue;
      const d = (c.x - x) ** 2 + (c.z - z) ** 2;
      if (d < best) { best = d; hit = o; hc = { face: c.face, cos: c.cos }; }
    }
    if (hit) {
      const kind = hit === shooter ? 'self' : isEnemy(shooter, hit) ? 'enemy' : 'ally';
      return { kind, tank: hit, time, dist, face: hc.face, cos: hc.cos };
    }
    if (solidCellAt(world.grid, nx, nz, SHELL_R)) return { kind: 'wall', time, dist };
    x = nx; z = nz;
    for (const m of world.mines) {
      if (!m.alive) continue;
      if ((x - m.x) ** 2 + (z - m.z) ** 2 < (MINE_R + SHELL_R) ** 2) {
        // Shooting a mine: worth it if the blast catches an enemy and none of ours.
        let enemy = null, friendly = false;
        for (const o of tanks) {
          if (!o.alive || Math.hypot(o.x - m.x, o.z - m.z) > MINE_BLAST - 0.1) continue;
          if (o === shooter || !isEnemy(shooter, o)) friendly = true; else enemy = o;
        }
        if (friendly) return { kind: 'self', time, dist };
        if (enemy) return { kind: 'enemy', tank: enemy, time, dist, viaMine: true, face: 1, cos: 1 };
        return { kind: 'none', time, dist };
      }
    }
  }
  return { kind: 'none', time: maxK * stepD / speed, dist: maxLen };
}

// Solve the intercept angle for a direct shot at a moving target.
function leadAngle(t, o, speed) {
  const px = o.x - t.x, pz = o.z - t.z;
  const a = o.vx * o.vx + o.vz * o.vz - speed * speed;
  const b = 2 * (px * o.vx + pz * o.vz);
  const c = px * px + pz * pz;
  let tt = 0;
  if (Math.abs(a) < 1e-6) tt = b !== 0 ? -c / b : 0;
  else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) {
      const r1 = (-b - Math.sqrt(disc)) / (2 * a), r2 = (-b + Math.sqrt(disc)) / (2 * a);
      tt = Math.min(r1 > 0 ? r1 : Infinity, r2 > 0 ? r2 : Infinity);
      if (!isFinite(tt)) tt = 0;
    }
  }
  tt = Math.max(0, Math.min(tt, 1.6));
  return Math.atan2(pz + o.vz * tt, px + o.vx * tt);
}

// Value of a traced shot that hits an enemy: expected damage, with a bonus for a likely kill.
function shotValue(t, r, d) {
  const pp = r.viaMine ? 1 : penChance(t.type.pen, r.tank.type, r.face, r.cos);
  const ph = hitProb(t.type.dispBase, d);
  const dmg = r.viaMine ? 80 : t.type.dmg;
  const kill = r.tank.hp <= dmg * 0.95 ? 1.6 : 1;
  return { pp, ev: ph * pp * dmg * kill };
}

// ------------------------------------------------------------------ shot planning (direct fire only)
function planShot(world, t, B, P) {
  let best = null;
  const consider = (ang, o, d) => {
    const r = traceShot(world, t, ang, { lead: P.lead, maxLen: d + 2.5 });
    if (r.kind !== 'enemy') return null;
    const { pp, ev } = shotValue(t, r, d);
    const turn = Math.abs(wrapAngle(ang - t.aim)) / t.type.turretRate;
    const score = (P.tactics ? ev : 10) - turn * 6 - d * 0.3;
    const c = { angle: ang, tank: r.tank, pp, ev, d, score, face: r.face };
    if (!best || score > best.score) best = c;
    return c;
  };
  for (const o of world.tanks) {
    if (!o.alive || !isEnemy(t, o) || !seesNow(world, t.team, o.id)) continue;
    const d = Math.hypot(o.x - t.x, o.z - t.z);
    if (d > VIEW + 2) continue;
    const base = P.lead ? leadAngle(t, o, t.type.shellSpeed) : Math.atan2(o.z - t.z, o.x - t.x);
    const c = consider(base, o, d);
    // Weak-spot hunting: nudge the aim toward the hull's ends to catch a side or rear face.
    if (P.tactics && (!c || c.pp < 0.6)) {
      const off = Math.atan2(0.22, d);
      consider(base + off, o, d); consider(base - off, o, d);
    }
  }
  return best;
}

// ------------------------------------------------------------------ movement
let _bfsQ = null;
function flowField(world, gi, gj) {
  const COLS = world.cols;
  const dist = new Int16Array(world.cols * world.rows).fill(-1);
  if (!passable(world.grid, gi, gj)) return dist;
  if (!_bfsQ || _bfsQ.length < world.cols * world.rows) _bfsQ = new Int32Array(world.cols * world.rows);
  const q = _bfsQ;
  let qh = 0, qt = 0;
  q[qt++] = gi + gj * COLS; dist[gi + gj * COLS] = 0;
  while (qh < qt) {
    const c = q[qh++], i = c % COLS, j = (c / COLS) | 0;
    for (let k = 0; k < 4; k++) {
      const ni = i + (k === 0 ? 1 : k === 1 ? -1 : 0), nj = j + (k === 2 ? 1 : k === 3 ? -1 : 0);
      if (!passable(world.grid, ni, nj)) continue;
      const n = ni + nj * COLS;
      if (dist[n] >= 0) continue;
      dist[n] = dist[c] + 1; q[qt++] = n;
    }
  }
  return dist;
}

function flowDir(world, B, t) {
  if (!B.flow) return null;
  const COLS = world.cols;
  const i = Math.floor(t.x), j = Math.floor(t.z);
  const here = B.flow[i + j * COLS];
  if (here === 0) {
    const dx = i + 0.5 - t.x, dz = j + 0.5 - t.z, d = Math.hypot(dx, dz);
    return d < 0.15 ? null : [dx / d, dz / d];
  }
  let best = null, bv = here < 0 ? 9999 : here;
  for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
    if (!di && !dj) continue;
    const ni = i + di, nj = j + dj;
    if (!passable(world.grid, ni, nj)) continue;
    if (di && dj && (!passable(world.grid, i + di, j) || !passable(world.grid, i, j + dj))) continue;
    const v = B.flow[ni + nj * COLS];
    if (v < 0) continue;
    const cost = v + (di && dj ? 0.4 : 0);
    if (cost < bv) { bv = cost; best = [ni + 0.5, nj + 0.5]; }
  }
  if (!best) return null;
  const dx = best[0] - t.x, dz = best[1] - t.z, d = Math.hypot(dx, dz) || 1;
  return [dx / d, dz / d];
}

function randomReachableCell(world, c, radius, scoreFn, tries = 18) {
  let best = null, bs = -Infinity;
  for (let k = 0; k < tries; k++) {
    const i = Math.floor(c.x + (world.rng() * 2 - 1) * radius), j = Math.floor(c.z + (world.rng() * 2 - 1) * radius);
    if (!passable(world.grid, i, j)) continue;
    const s = scoreFn ? scoreFn(i + 0.5, j + 0.5) : world.rng();
    if (s > bs) { bs = s; best = [i, j]; }
  }
  return best;
}
// Nearest floor cell to (x,z) (for goals on top of obstacles / unknown positions).
function floorNear(world, x, z) {
  const i0 = Math.floor(x), j0 = Math.floor(z);
  for (let r = 0; r < 6; r++) for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
    if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
    if (passable(world.grid, i0 + di, j0 + dj)) return [i0 + di, j0 + dj];
  }
  return null;
}

// How much solid cover hugs a cell (0..4 blocked orthogonal neighbours; pits don't count).
function coverAt(world, x, z) {
  const i = Math.floor(x), j = Math.floor(z);
  let n = 0;
  for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const c = cellAt(world.grid, i + di, j + dj); if (c === CELL.BLOCK || c === CELL.CRATE) n++; }
  return n;
}

function mineThreat(world, t, x, z) {
  let d = 0;
  for (const m of world.mines) {
    if (!m.alive) continue;
    const r = Math.hypot(m.x - x, m.z - z);
    const reach = MINE_BLAST + 0.4;
    if (r > reach) continue;
    // Every mine hurts everyone in the blast, ours included.
    const w = m.team !== t.team || m.trigger >= 0 || MINE_FUSE - m.t < 3 ? 1 : 0.8;
    d = Math.max(d, w * (1 - r / reach) + 0.25);
  }
  return d;
}

function setGoal(world, B, goal, life, kind) {
  if (!goal) return false;
  const key = goal[0] + ',' + goal[1];
  if (key !== B.flowKey || world.time - B.flowT > 1.5) { B.flow = flowField(world, goal[0], goal[1]); B.flowKey = key; B.flowT = world.time; }
  B.goal = goal; B.goalT = world.time + life; B.goalKind = kind;
  return true;
}

function chooseGoal(world, t, B, P, target) {
  const style = P.style;
  const vis = target && !target.ghost;
  const tx = target ? target.x : 0, tz = target ? target.z : 0;
  const seesT = (x, z) => (target ? sightClear(world.grid, x, z, tx, tz) : false);
  const tDist = (x, z) => Math.hypot(tx - x, tz - z);
  const mt = (x, z) => mineThreat(world, t, x, z) * 4;

  if (B.flee) {
    const m = B.flee;
    if (!m.alive || Math.hypot(t.x - m.x, t.z - m.z) > MINE_BLAST + 1) B.flee = null;
    else return setGoal(world, B, randomReachableCell(world, t, 5, (x, z) => Math.min(4, Math.hypot(x - m.x, z - m.z)) - 0.2 * Math.hypot(x - t.x, z - t.z) - mt(x, z), 24), 1.6, 'flee');
  }
  if (vis && P.tactics && style !== 'hold') {
    // Reloading and exposed: duck behind something, come back out when loaded.
    if (t.cool > 1.1 && t.type.maxShells === 1) {
      const foes = visibleFoes(world, t, 4);
      const exposed = (x, z) => { let n = 0; for (const o of foes) if (sightClear(world.grid, x, z, o.x, o.z)) n++; return n; };
      const g = randomReachableCell(world, t, 3, (x, z) => 2 - exposed(x, z) * 3 - 0.45 * Math.hypot(x - t.x, z - t.z) - mt(x, z), 22);
      if (g && !exposed(g[0] + 0.5, g[1] + 0.5)) return setGoal(world, B, g, Math.min(t.cool - 0.5, 1.8), 'cover');
    }
    // Their front is too thick for us: go round to the side.
    if (B.hopelessT > 1 || (P.flank && B.shot && B.shot.pp < 0.35)) return flankGoal(world, t, B, P, target, mt);
  }
  if (!target) {
    if (style === 'hold') return false;
    // Campaign defenders hold their ground until their side makes contact.
    if (world.mode === 'campaign' && t.team !== 0 && style !== 'hunt' && style !== 'trick') {
      return setGoal(world, B, randomReachableCell(world, B.spawn, 4, (x, z) => world.rng() - mt(x, z), 16), 4 + world.rng() * 3, 'patrol');
    }
    // No contact: push toward the enemy's side a leg at a time; once there, search the
    // least recently visited ground, nearest first.
    const foe = Object.entries(world.home).filter(([k]) => +k !== t.team).map(([, h]) => h);
    const f = foe.length ? foe[Math.abs(t.id) % foe.length] : { x: world.cols / 2, z: world.rows / 2 };
    const df = Math.hypot(f.x - t.x, f.z - t.z);
    if (df > 8 && B.explore < 1) {
      const pace = style === 'sniper' ? 0.3 : style === 'wander' || style === 'sapper' ? 0.4 : 0.55;
      const a = { x: t.x + (f.x - t.x) * pace, z: t.z + (f.z - t.z) * pace };
      return setGoal(world, B, randomReachableCell(world, a, 4, (x, z) => world.rng() + coverAt(world, x, z) * 0.35 - mt(x, z), 24) || floorNear(world, a.x, a.z), 3 + world.rng() * 2, 'advance');
    }
    B.explore++;
    const bw = Math.ceil(world.cols / BLOCK);
    const g = randomReachableCell(world, { x: world.cols / 2, z: world.rows / 2 }, Math.max(world.cols, world.rows) / 2, (x, z) => {
      const stale = Math.min(60, world.time - B.seen[Math.floor(x / BLOCK) + Math.floor(z / BLOCK) * bw]);
      return stale / 15 - 0.07 * Math.hypot(x - t.x, z - t.z) - 0.04 * Math.hypot(x - f.x, z - f.z) + world.rng() * 0.5 - mt(x, z);
    }, 36);
    return setGoal(world, B, g, 6 + world.rng() * 3, 'explore');
  }
  if (target.ghost) {
    if (style === 'hold') return false;
    // Investigate the last-known position; once there, it's checked.
    if (tDist(t.x, t.z) < 1.8) { B.checked[target.id] = target.seenT; return false; }
    return setGoal(world, B, floorNear(world, tx, tz), 2.5, 'investigate');
  }
  if (style === 'hold') return false;
  const d = tDist(t.x, t.z);
  if (style === 'hunt') {
    if (d > 9) return setGoal(world, B, randomReachableCell(world, { x: t.x + (tx - t.x) * 0.5, z: t.z + (tz - t.z) * 0.5 }, 2.5, (x, z) => world.rng() - mt(x, z)) || floorNear(world, tx, tz), 1.5, 'close');
    return setGoal(world, B, randomReachableCell(world, t, 3, (x, z) => (seesT(x, z) ? 1.5 : 0) - Math.abs(tDist(x, z) - 5.5) * 0.5 - mt(x, z)), 1.8, 'fight');
  }
  if (style === 'sniper') {
    return setGoal(world, B, randomReachableCell(world, t, 6, (x, z) => (seesT(x, z) ? 2 : 0) - Math.abs(tDist(x, z) - 12) * 0.35 - mt(x, z) - 0.1 * Math.hypot(x - t.x, z - t.z), 24), 3, 'fight');
  }
  if (style === 'trick') return flankGoal(world, t, B, P, target, mt);
  // wander / sapper
  return setGoal(world, B, randomReachableCell(world, t, 5, (x, z) => world.rng() - mt(x, z) - (tDist(x, z) < 3 ? 2 : 0) + (seesT(x, z) ? 0.5 : 0)), 2 + world.rng() * 2, 'fight');
}

// A spot off the target's flank (or rear), with line of sight, within reach.
function flankGoal(world, t, B, P, target, mt) {
  const o = target.tank || target;
  const rot = o.rot ?? 0;
  const tx = target.x, tz = target.z;
  const g = randomReachableCell(world, { x: (t.x + tx) / 2, z: (t.z + tz) / 2 }, 6, (x, z) => {
    const dx = x - tx, dz = z - tz, d = Math.hypot(dx, dz);
    const rel = Math.abs(wrapAngle(Math.atan2(dz, dx) - rot)); // 0 = in front of them, π = behind
    const sideness = Math.sin(rel) + (rel > 2.2 ? 0.6 : 0);
    return sideness * 2 - Math.abs(d - 5) * 0.4 + (sightClear(world.grid, x, z, tx, tz) ? 1 : 0) - 0.12 * Math.hypot(x - t.x, z - t.z) - mt(x, z);
  }, 28);
  return setGoal(world, B, g, 2.5, 'flank');
}

function considerMine(world, t, B, P, target) {
  if (!P.mineUse || t.type.mines <= 0 || liveMinesOf(world, t) >= t.type.mines || t.mineCool > 0) return;
  const mob = mobilityOf(t);
  if (mob.speed < t.type.speed * 0.9) return; // can't get clear of our own blast
  for (const o of world.tanks) if (o.alive && o !== t && !isEnemy(t, o) && Math.hypot(o.x - t.x, o.z - t.z) < MINE_BLAST + 1.5) return;
  for (const m of world.mines) if (m.alive && Math.hypot(m.x - t.x, m.z - t.z) < 2.5) return;
  const d = target ? Math.hypot(target.x - t.x, target.z - t.z) : 99;
  let want = false;
  if (P.style === 'sapper') {
    B.mineT -= P.think;
    if (B.mineT <= 0 && d > 3.5 && d < 14) { want = true; B.mineT = (P.mineEvery || 4) * (0.7 + world.rng() * 0.6); }
  } else if (target && !target.ghost && d > 3.2 && d < 6) {
    // Cut them off: they're driving at us down a lane and we're pulling back from it.
    const closing = (target.vx * (t.x - target.x) + target.vz * (t.z - target.z)) > 0.5 * d;
    const leaving = (t.vx * (t.x - target.x) + t.vz * (t.z - target.z)) > 0.5 * d;
    if (closing && leaving) want = world.rng() < P.mineUse * 0.5;
  }
  if (want) {
    t.ctrl.mine = true;
    B.flee = { x: t.x, z: t.z, alive: true };
    B.goalT = 0;
  }
}

// Evaluate a move direction by simulating the real drive model against shell futures.
function dangerOf(world, t, mob, fut, mx, mz, look) {
  const k = { x: t.x, z: t.z, rot: t.rot, rev: t.rev };
  const steps = Math.min(FUTURE_N, Math.ceil(look / (DT * FUTURE_EVERY)));
  let danger = 0;
  const hitR = TANK_R + SHELL_R + 0.12, nearR = TANK_R + 0.55;
  for (let m = 0; m < steps; m++) {
    driveTank(world.grid, k, mob, mx, mz, DT * FUTURE_EVERY);
    for (const f of fut) {
      if (m >= f.n) continue;
      if (f.s.owner === t.id && f.s.age < 0.25) continue;
      const dx = f.xs[m] - k.x, dz = f.zs[m] - k.z, d2 = dx * dx + dz * dz;
      if (d2 < hitR * hitR) danger = Math.max(danger, 1 - (m / steps) * 0.4);
      else if (d2 < nearR * nearR) danger = Math.max(danger, 0.12);
    }
  }
  danger = Math.max(danger, mineThreat(world, t, k.x, k.z) * 0.8);
  return danger;
}

const DIRS = [...Array(8)].map((_, k) => [Math.cos(k * Math.PI / 4), Math.sin(k * Math.PI / 4)]);

// Returns true if it is dodging (overriding the goal).
function steer(world, t, B, P, fut, hold) {
  const c = t.ctrl;
  const gdir = hold ? null : flowDir(world, B, t);
  if (B.goal && B.flow && B.flow[Math.floor(t.x) + Math.floor(t.z) * world.cols] === 0 && !gdir && !hold) B.goalT = Math.min(B.goalT, world.time + 0.3);
  let threat = mineThreat(world, t, t.x, t.z) > 0;
  if (!threat && P.dodge) {
    for (const f of fut) {
      if (f.s.owner === t.id) continue;
      for (let m = 0; m < f.n; m += 3) {
        if ((f.xs[m] - t.x) ** 2 + (f.zs[m] - t.z) ** 2 < 2.6 * 2.6) { threat = true; break; }
      }
      if (threat) break;
    }
  }
  B.cantDodge = false;
  if (!threat || !P.dodge) {
    B.dodging = 0;
    if (gdir) { c.mx = gdir[0]; c.mz = gdir[1]; } else { c.mx = 0; c.mz = 0; }
    return false;
  }
  const mob = mobilityOf(t);
  const look = P.dodgeLook || 0.5;
  let best = null, bs = -Infinity, bestIdx = -1, stillDanger = 0;
  const opts = DIRS.map((d, k) => [d[0], d[1], k]);
  if (gdir) opts.push([gdir[0], gdir[1], 8]);
  opts.push([0, 0, 9]);
  for (const [mx, mz, k] of opts) {
    const dng = mob.speed > 0 || k === 9 ? dangerOf(world, t, mob, fut, mx, mz, look) : 9;
    if (k === 9) stillDanger = dng;
    const align = gdir && (mx || mz) ? (mx * gdir[0] + mz * gdir[1]) * 0.5 : 0;
    const s = -dng * 5 + align + (k === B.lastDir ? 0.25 : 0) + (k === 9 && hold ? 0.3 : 0);
    if (s > bs) { bs = s; best = [mx, mz]; bestIdx = k; }
  }
  B.lastDir = bestIdx;
  B.dodging = stillDanger > 0.5 && bestIdx !== 9 ? 1 : 0;
  B.cantDodge = bs < -3;
  c.mx = best[0]; c.mz = best[1];
  return B.dodging === 1;
}

// Counter-fire: shoot the shell that's about to hit us.
function counterShot(world, t, fut) {
  let worst = null, wt = Infinity;
  for (const f of fut) {
    if (f.s.team === t.team) continue;
    for (let m = 0; m < f.n; m++) {
      const d = Math.hypot(f.xs[m] - t.x, f.zs[m] - t.z);
      if (d < TANK_R + SHELL_R + 0.15) { if (m < wt) { wt = m; worst = f; } break; }
    }
  }
  if (!worst || wt < 3) return null;
  const sp = t.type.shellSpeed;
  for (let m = 2; m < worst.n && m <= wt; m++) {
    const x = worst.xs[m], z = worst.zs[m];
    const d = Math.hypot(x - t.x, z - t.z) - BARREL;
    const time = m * DT * FUTURE_EVERY;
    if (d <= sp * time && shellLineClear(world.grid, t.x, t.z, x, z)) return Math.atan2(z - t.z, x - t.x);
  }
  return null;
}

// Is turning the front plate ~30° off this threat worth it? Only if it cuts their pen chance
// (it does for thick fronts; a medium's plate gets penned either way, so it just blooms our aim).
function angleHelps(t, o) {
  const pen = o.type.pen;
  const flat = penChance(pen, t.type, 0, 1);
  const angled = Math.max(penChance(pen, t.type, 0, Math.cos(ANGLE_OFF)), penChance(pen, t.type, 1, Math.cos(Math.PI / 2 - ANGLE_OFF)));
  return angled < flat - 0.1;
}

// How good the current aim has to be before we pull the trigger, as a hit chance.
function aimReady(P, t, d) {
  if (d < SNAP_RANGE) return true;
  const need = hitProb(t.type.dispBase, d) * Math.min(0.95, 0.3 + 0.62 * P.patience);
  return hitProb(t.disp, d) >= need;
}

// ------------------------------------------------------------------ the brain
export function brainStep(world, t, dt) {
  updateIntel(world);
  const P = profileOf(t);
  const B = t.brain || (t.brain = newBrain(world, t));
  const c = t.ctrl;
  const target = pickTarget(world, t, B);
  if (target && !target.ghost) B.explore = 0;
  B.target = target;
  const fut = shellFutures(world);
  B.fireGap -= dt;
  const mob = mobilityOf(t);
  const canMove = t.type.speed > 0;

  B.thinkT -= dt;
  const thinking = B.thinkT <= 0;
  if (thinking) {
    B.thinkT = P.think * (0.85 + world.rng() * 0.3);
    B.seen[Math.floor(t.x / BLOCK) + Math.floor(t.z / BLOCK) * Math.ceil(world.cols / BLOCK)] = world.time;
    const prev = B.shot;
    B.shot = planShot(world, t, B, P);
    if (!B.shot || !prev || prev.tank !== B.shot.tank) B.err = (world.rng() * 2 - 1) * P.aimErr;
    else B.err = B.err * 0.6 + (world.rng() * 2 - 1) * P.aimErr * 0.4;
    if (B.shot && B.shot.pp < 0.12) B.hopelessT += P.think; else if (B.shot) B.hopelessT = Math.max(0, B.hopelessT - P.think * 2);
    if (!B.shot) B.waitT = 0;
    if (canMove) {
      considerMine(world, t, B, P, target);
      const fightChange = target && !target.ghost && (B.goalKind === 'advance' || B.goalKind === 'explore' || B.goalKind === 'investigate' || B.goalKind === 'patrol');
      const lostContact = (!target || target.ghost) && (B.goalKind === 'fight' || B.goalKind === 'cover' || B.goalKind === 'flank' || B.goalKind === 'close');
      if (world.time > B.goalT || !B.goal || fightChange || lostContact) chooseGoal(world, t, B, P, target);
      if (Math.abs(t.speedNow) < 0.05 && (c.mx || c.mz) && mob.speed > 0) { B.stuckT += P.think; if (B.stuckT > 1.2) { B.goalT = 0; B.stuckT = 0; B.goal = null; B.explore++; } }
      else B.stuckT = 0;
    }
  }

  // Aim.
  let aimAt = null, wantFire = false;
  if (P.counterFire && B.cantDodge) {
    const a = counterShot(world, t, fut);
    if (a != null) { aimAt = a; wantFire = Math.abs(wrapAngle(t.aim - a)) < 0.05; }
  }
  if (aimAt == null) {
    if (B.shot) aimAt = B.shot.angle + B.err;
    else if (target) aimAt = Math.atan2(target.z - t.z, target.x - t.x);
    else if (P.sweep) { if (thinking && world.rng() < 0.3) B.sweep = -B.sweep; aimAt = t.aim + B.sweep * 0.6; }
    else if (Math.abs(t.speedNow) > 0.2) aimAt = t.rot; // no contact: turret forward while driving
    else aimAt = t.aim;
  }
  c.aim = aimAt;

  // Fire.
  const ready = t.cool <= 0 && t.burstLeft === 0 && liveShellsOf(world, t) < t.type.maxShells;
  let settling = false;
  if (ready && B.fireGap <= 0) {
    if (wantFire) { c.fire = true; B.fireGap = 0.15; }
    else if (B.shot && Math.abs(wrapAngle(t.aim - aimAt)) < P.fireTol + Math.atan2(0.2, B.shot.d)) {
      const d = B.shot.d;
      B.waitT += dt;
      const settled = aimReady(P, t, d) || B.waitT > 1 + 3 * P.patience;
      const worth = !P.tactics || B.shot.pp >= 0.2 || B.hopelessT > 5 || d < SNAP_RANGE;
      if (!settled) settling = true;
      if (settled && worth) {
        const r = traceShot(world, t, t.aim, { lead: P.lead, maxLen: d + 2.5 });
        const ok = P.verify === 'strict' ? r.kind === 'enemy' && (!P.tactics || r.viaMine || penChance(t.type.pen, r.tank.type, r.face, r.cos) >= 0.15 || B.hopelessT > 5)
          : r.kind === 'enemy' || (r.kind === 'none') || (r.kind === 'wall' && r.dist > d * 0.85);
        if (ok) { c.fire = true; B.fireGap = P.fireGap * (0.8 + world.rng() * 0.4); B.shot = null; B.waitT = 0; B.thinkT = Math.min(B.thinkT, 0.05); }
      }
    }
  } else if (B.shot && t.cool < 0.6) settling = !aimReady(P, t, B.shot.d);

  // Move.
  if (canMove) {
    // Stop to let the aim settle for a long shot (unless something is about to hit us).
    const hold = settling && B.shot && B.shot.d > SNAP_RANGE && P.patience >= 0.3 && B.goalKind !== 'flee' && B.goalKind !== 'cover';
    B.holding = hold;
    if (P.dodgeEvery === 'tick' || thinking || B.dodging || hold) steer(world, t, B, P, fut, hold);
    else if (!B.dodging) { const g = flowDir(world, B, t); c.mx = g ? g[0] : 0; c.mz = g ? g[1] : 0; }
    // Stationary and fighting: angle the hull (front plate ~30° off the threat).
    c.hullAim = null;
    if (P.angle && target && !target.ghost && Math.hypot(c.mx, c.mz) < 0.08 && angleHelps(t, target)) {
      const b = Math.atan2(target.z - t.z, target.x - t.x);
      const a1 = b + ANGLE_OFF, a2 = b - ANGLE_OFF;
      c.hullAim = Math.abs(wrapAngle(a1 - t.rot)) < Math.abs(wrapAngle(a2 - t.rot)) ? a1 : a2;
    }
  }
}
