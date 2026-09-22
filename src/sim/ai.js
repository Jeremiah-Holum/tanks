// Scripted tank brains. No learning, no models: a shot planner that traces shells
// through the real collision code, a dodge planner that simulates the real drive model
// against every live shell's future, grid flow fields for movement, and a tactics layer.
import {
  DT, CELL, TANK_R, SHELL_R, BARREL, MINE_R, MINE_BLAST, MINE_TRIGGER, MINE_FUSE,
  cellAt, moveShell, shellLineClear, sightClear, driveTank, wrapAngle, liveShellsOf, liveMinesOf,
} from './world.js';
import { SKILLS } from './tanks.js';

const TAU = Math.PI * 2;
const FUTURE_T = 1.0, FUTURE_EVERY = 2; // shell futures: 1 s ahead, a sample every 2 ticks
const FUTURE_N = Math.round(FUTURE_T / DT / FUTURE_EVERY);

// ------------------------------------------------------------------ profiles
export function profileOf(t) {
  if (t._profile) return t._profile;
  let P;
  if (t.skill) P = typeof t.skill === 'string' ? SKILLS[t.skill] : t.skill;
  else P = t.type.ai || SKILLS.veteran;
  P = { ...P };
  P.style = t.style || P.style || 'hunt';
  if (P.fireGap == null) P.fireGap = P.counterFire ? 0.3 : P.bank >= 1 ? 0.45 : 0.6;
  t._profile = P;
  return P;
}

function newBrain(world, t) {
  return {
    thinkT: world.rng() * 0.3, shot: null, err: 0, target: null,
    goal: null, goalT: 0, flow: null, flowKey: '', flowT: 0,
    sweep: world.rng() < 0.5 ? -1 : 1, fireGap: 0.5 + world.rng(),
    lastDir: -1, stuckT: 0, mineT: 1 + world.rng() * 2, flee: null,
    sweepCursor: Math.floor(world.rng() * 997), cands: [], dodging: 0,
  };
}

// ------------------------------------------------------------------ helpers
const passable = (grid, i, j) => cellAt(grid, i, j) === CELL.FLOOR;
const isEnemy = (a, b) => a.team !== b.team;

// ------------------------------------------------------------------ spotting
// Nobody is all-seeing. Each team knows what any of its tanks can see (line of sight within
// VIEW range; ghosts only up close), plus rough positions of shots it heard.
export const VIEW = 24, GHOST_VIEW = 2.6, HEAR = 15;
export function updateIntel(world) {
  if (world._intelTick === world.tick) return world.intel;
  world._intelTick = world.tick;
  if (world.tick % 6 !== 0 && world._intelInit) return world.intel;
  world._intelInit = true;
  const intel = world.intel;
  for (const o of world.tanks) {
    if (!o.alive) continue;
    for (const t of world.tanks) {
      if (!t.alive || t.team === o.team) continue;
      const I = intel[o.team] || (intel[o.team] = {});
      const e = I[t.id];
      const d = Math.hypot(t.x - o.x, t.z - o.z);
      const range = t.type.invisible && !(t.revealT > world.time) ? GHOST_VIEW : VIEW;
      if (d <= range && (d < 1.6 || sightClear(world.grid, o.x, o.z, t.x, t.z))) {
        I[t.id] = { x: t.x, z: t.z, t: world.time, vis: world.tick, seenBy: o.id };
      } else if (e && e.vis !== world.tick && e.seenBy === o.id) {
        e.vis = -1;
      }
    }
  }
  // anything not refreshed this pass is no longer in sight
  for (const I of Object.values(intel)) for (const e of Object.values(I)) if (e.vis !== world.tick) e.vis = -1;
  return intel;
}
// A shot is loud: nearby enemies get a rough fix on the shooter.
export function hearShot(world, shooter) {
  for (const o of world.tanks) {
    if (!o.alive || o.team === shooter.team) continue;
    if (Math.hypot(o.x - shooter.x, o.z - shooter.z) > HEAR) continue;
    const I = world.intel[o.team] || (world.intel[o.team] = {});
    const e = I[shooter.id];
    if (e && e.vis === world._intelTick) continue;
    I[shooter.id] = { x: shooter.x + (world.rng() - 0.5) * 3, z: shooter.z + (world.rng() - 0.5) * 3, t: world.time, vis: -1, heard: true };
  }
}
export const seesNow = (world, team, id) => { const e = world.intel[team] && world.intel[team][id]; return !!e && e.vis === world._intelTick; };

function pickTarget(world, t) {
  // Visible enemies first (nearest); otherwise the freshest lead we have.
  const I = world.intel[t.team] || {};
  let best = null, bd = Infinity, lead = null, lt = -Infinity;
  for (const o of world.tanks) {
    if (!o.alive || !isEnemy(t, o)) continue;
    const e = I[o.id];
    if (!e) continue;
    if (e.vis === world._intelTick) {
      const d = Math.hypot(o.x - t.x, o.z - t.z);
      if (d < bd) { bd = d; best = o; }
    } else if (world.time - e.t < 12 && e.t > lt) { lt = e.t; lead = { x: e.x, z: e.z, id: o.id, ghost: true }; }
  }
  return best || lead;
}

// Shell futures for every live shell, computed once per tick and shared by all brains.
export function shellFutures(world) {
  if (world._shellFutureTick === world.tick) return world._shellFuture;
  const out = [];
  for (const s of world.shells) {
    if (!s.alive) continue;
    const p = { x: s.x, z: s.z, dx: s.dx, dz: s.dz };
    let bounces = s.bounces, dead = false;
    const xs = new Float32Array(FUTURE_N), zs = new Float32Array(FUTURE_N);
    let n = 0;
    for (let k = 0; k < FUTURE_N; k++) {
      if (!dead) {
        moveShell(world.grid, p, s.speed * DT * FUTURE_EVERY, () => { bounces++; if (bounces > s.maxBounces) { dead = true; return false; } return true; });
      }
      if (dead) break;
      xs[k] = p.x; zs[k] = p.z; n++;
    }
    out.push({ s, xs, zs, n });
  }
  world._shellFutureTick = world.tick; world._shellFuture = out;
  return out;
}

// Trace a shell fired by `shooter` at `angle` through the real bounce code.
// Returns what it would hit first: { kind: 'enemy'|'self'|'ally'|'none', tank, time, bounces }.
export function traceShot(world, shooter, angle, opts = {}) {
  const known = opts.known;
  const type = shooter.type;
  const cx = Math.cos(angle), cz = Math.sin(angle);
  const sx = shooter.x + cx * BARREL, sz = shooter.z + cz * BARREL;
  if (!shellLineClear(world.grid, shooter.x, shooter.z, sx, sz)) return { kind: 'blocked' };
  const s = { x: sx, z: sz, dx: cx, dz: cz };
  const stepD = type.shellSpeed * DT * 2;
  const maxLen = opts.maxLen ?? 30;
  const maxK = Math.ceil(maxLen / stepD);
  const lead = opts.lead ? Math.min(opts.leadCap ?? 1.4, 99) : 0;
  let bounces = 0, dead = false;
  const tanks = world.tanks;
  for (let k = 1; k <= maxK; k++) {
    moveShell(world.grid, s, stepD, () => { bounces++; if (bounces > type.bounces) { dead = true; return false; } return true; });
    if (dead) return { kind: 'none', time: k * DT * 2, bounces };
    const time = k * DT * 2;
    for (let q = 0; q < tanks.length; q++) {
      const o = tanks[q];
      if (!o.alive) continue;
      let ox = o.x, oz = o.z;
      if (lead && o !== shooter) { const lt = Math.min(time, lead); ox += o.vx * lt; oz += o.vz * lt; }
      const dx = s.x - ox, dz = s.z - oz, d2 = dx * dx + dz * dz;
      if (o === shooter) {
        if (bounces === 0 && time < 0.25) continue;
        if (d2 < (TANK_R + SHELL_R + 0.14) ** 2) return { kind: 'self', tank: o, time, bounces };
      } else if (!isEnemy(shooter, o)) {
        if (d2 < (TANK_R + SHELL_R + 0.14) ** 2) return { kind: 'ally', tank: o, time, bounces };
      } else {
        const r = opts.tight ? 0.24 : TANK_R + SHELL_R - 0.02;
        if (d2 < r * r) return known && !known(o) ? { kind: 'none', time, bounces } : { kind: 'enemy', tank: o, time, bounces };
      }
    }
    for (const m of world.mines) {
      if (!m.alive) continue;
      if ((s.x - m.x) ** 2 + (s.z - m.z) ** 2 < (MINE_R + SHELL_R) ** 2) {
        // Shooting a mine: it's a hit if the blast catches an enemy and none of ours.
        let enemy = null, friendly = false;
        for (const o of tanks) {
          if (!o.alive || Math.hypot(o.x - m.x, o.z - m.z) > MINE_BLAST - 0.1) continue;
          if (o === shooter || !isEnemy(shooter, o)) friendly = true; else enemy = o;
        }
        if (friendly) return { kind: 'self', time, bounces };
        if (enemy) return { kind: 'enemy', tank: enemy, time, bounces, viaMine: true };
        return { kind: 'none', time, bounces };
      }
    }
  }
  return { kind: 'none', time: maxK * DT * 2, bounces };
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
  tt = Math.min(tt, 1.4);
  return Math.atan2(pz + o.vz * tt, px + o.vx * tt);
}

// ------------------------------------------------------------------ shot planning
function planShot(world, t, B, P, target) {
  const cands = [];
  if (!target || target.ghost) return null;
  const known = (o) => seesNow(world, t.team, o.id);
  const consider = (ang) => {
    const r = traceShot(world, t, ang, { lead: P.lead, tight: true, known });
    if (r.kind !== 'enemy' || r.bounces > P.bank) return;
    const turn = Math.abs(wrapAngle(ang - t.aim)) / t.type.turretRate;
    cands.push({ angle: ang, score: r.time + turn + r.bounces * 0.25, tank: r.tank, bounces: r.bounces });
  };
  if (target) {
    consider(P.lead ? leadAngle(t, target, t.type.shellSpeed) : Math.atan2(target.z - t.z, target.x - t.x));
    for (const o of world.tanks) if (o.alive && o !== target && isEnemy(t, o) && known(o) && Math.hypot(o.x - t.x, o.z - t.z) < 9) consider(Math.atan2(o.z - t.z, o.x - t.x));
  }
  // Rolling bank-shot sweep: a slice of the circle every think, so a full sweep costs
  // several thinks and no single frame pays for all of it.
  if (P.bank > 0 && P.samples > 0) {
    const slice = Math.max(12, Math.ceil(P.samples / 3));
    const off = world.rng() / P.samples;
    for (let k = 0; k < slice; k++) {
      const idx = (B.sweepCursor + k) % P.samples;
      consider(((idx / P.samples) + off) * TAU);
    }
    B.sweepCursor = (B.sweepCursor + slice) % P.samples;
  }
  // Keep the previous best alive and refine around it.
  if (B.shot && B.shot.tank && B.shot.tank.alive) {
    const a = B.shot.angle;
    for (const d of [0, -0.02, 0.02, -0.05, 0.05]) consider(a + d);
  }
  if (!cands.length) return null;
  cands.sort((a, b) => a.score - b.score);
  const best = cands[0];
  // Centre the shot: find the edges of the hitting window and aim at its middle.
  const hits = (a) => { const r = traceShot(world, t, a, { lead: P.lead, known }); return r.kind === 'enemy' && r.tank === best.tank; };
  let lo = best.angle, hi = best.angle;
  for (let k = 0; k < 6 && hits(lo - 0.012); k++) lo -= 0.012;
  for (let k = 0; k < 6 && hits(hi + 0.012); k++) hi += 0.012;
  best.angle = (lo + hi) / 2;
  return best;
}

// ------------------------------------------------------------------ movement
function flowField(world, gi, gj) {
  const COLS = world.cols;
  const dist = new Int16Array(world.cols * world.rows).fill(-1);
  if (!passable(world.grid, gi, gj)) return dist;
  const q = [gi + gj * COLS]; dist[q[0]] = 0;
  for (let h = 0; h < q.length; h++) {
    const c = q[h], i = c % COLS, j = (c / COLS) | 0;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ni = i + di, nj = j + dj;
      if (!passable(world.grid, ni, nj)) continue;
      const n = ni + nj * COLS;
      if (dist[n] >= 0) continue;
      dist[n] = dist[c] + 1; q.push(n);
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

function randomReachableCell(world, B, t, radius, scoreFn, tries = 18) {
  let best = null, bs = -Infinity;
  for (let k = 0; k < tries; k++) {
    const i = Math.floor(t.x + (world.rng() * 2 - 1) * radius), j = Math.floor(t.z + (world.rng() * 2 - 1) * radius);
    if (!passable(world.grid, i, j)) continue;
    const s = scoreFn ? scoreFn(i + 0.5, j + 0.5) : world.rng();
    if (s > bs) { bs = s; best = [i, j]; }
  }
  return best;
}

function mineThreat(world, t, x, z) {
  let d = 0;
  for (const m of world.mines) {
    if (!m.alive) continue;
    const r = Math.hypot(m.x - x, m.z - z);
    const hostile = m.team !== t.team;
    const reach = hostile ? MINE_BLAST + 0.35 : MINE_BLAST + 0.3;
    if (r > reach) continue;
    const fuseLeft = MINE_FUSE - m.t;
    let w = hostile ? 0.9 : fuseLeft < 3 || m.trigger >= 0 ? 1 : 0.35;
    if (m.trigger >= 0) w = 1;
    d = Math.max(d, w * (1 - r / reach) + 0.25);
  }
  return d;
}

function chooseGoal(world, t, B, P, target) {
  const style = P.style;
  const los = (x, z) => target ? shellLineClear(world.grid, x, z, target.x, target.z) : false;
  const tDist = (x, z) => target ? Math.hypot(target.x - x, target.z - z) : 0;
  let goal = null, life = 2 + world.rng() * 2;

  if (B.flee) {
    const m = B.flee;
    goal = randomReachableCell(world, B, t, 5, (x, z) => Math.min(4, Math.hypot(x - m.x, z - m.z)) - 0.2 * Math.hypot(x - t.x, z - t.z) - mineThreat(world, t, x, z) * 4, 24);
    life = 1.6;
    if (!m.alive || Math.hypot(t.x - m.x, t.z - m.z) > MINE_BLAST + 1) B.flee = null;
  } else if (P.tactics && target && !target.ghost) {
    const myLive = liveShellsOf(world, t), theirLive = liveShellsOf(world, target);
    const dryMe = myLive >= t.type.maxShells - 1 && t.type.maxShells > 1;
    const dryThem = theirLive >= target.type.maxShells;
    if (dryThem) {
      goal = [Math.floor(target.x), Math.floor(target.z)]; life = 0.8; // they're out: push
    } else if (dryMe) {
      goal = randomReachableCell(world, B, t, 4, (x, z) => (los(x, z) ? -3 : 2) - 0.3 * Math.hypot(x - t.x, z - t.z) - mineThreat(world, t, x, z) * 4, 22);
      life = 1.0;
    }
  }
  if (!goal && !target && style !== 'hold') {
    // No contact: push toward the enemy's side, a leg at a time, through cover.
    const foe = Object.entries(world.home).find(([k]) => +k !== t.team);
    const fx = foe ? foe[1].x : world.cols / 2, fz = foe ? foe[1].z : world.rows / 2;
    const pace = style === 'sniper' ? 0.2 : style === 'wander' || style === 'sapper' ? 0.35 : 0.5;
    const ax = t.x + (fx - t.x) * pace, az = t.z + (fz - t.z) * pace;
    goal = randomReachableCell(world, B, { x: ax, z: az }, 5, (x, z) => world.rng() - mineThreat(world, t, x, z) * 4, 24);
    life = 3 + world.rng() * 3;
  }
  if (!goal && target && target.ghost) {
    goal = [Math.floor(target.x), Math.floor(target.z)]; life = 2.5;
  }
  if (!goal && target && !target.ghost) {
    if (style === 'hunt') {
      if (tDist(t.x, t.z) > 4.5) { goal = [Math.floor(target.x), Math.floor(target.z)]; life = 1.2; }
      else goal = randomReachableCell(world, B, t, 3, (x, z) => (los(x, z) ? 1.5 : 0) - Math.abs(tDist(x, z) - 3.5) - mineThreat(world, t, x, z) * 4);
    } else if (style === 'sniper') {
      goal = randomReachableCell(world, B, t, 6, (x, z) => (los(x, z) ? 2 : 0) - Math.abs(tDist(x, z) - 7.5) * 0.7 - mineThreat(world, t, x, z) * 4 - 0.1 * Math.hypot(x - t.x, z - t.z), 24);
    } else if (style === 'trick') {
      goal = randomReachableCell(world, B, t, 5, (x, z) => (los(x, z) ? -0.5 : 1) - Math.abs(tDist(x, z) - 5) * 0.6 - mineThreat(world, t, x, z) * 4, 24);
    } else if (style === 'sapper' || style === 'wander') {
      goal = randomReachableCell(world, B, t, 5, (x, z) => world.rng() - mineThreat(world, t, x, z) * 4 - (tDist(x, z) < 2.5 ? 2 : 0));
    }
  }
  if (goal) {
    const key = goal[0] + ',' + goal[1];
    if (key !== B.flowKey || world.time - B.flowT > 1) { B.flow = flowField(world, goal[0], goal[1]); B.flowKey = key; B.flowT = world.time; }
    B.goal = goal; B.goalT = world.time + life;
  }
}

function considerMine(world, t, B, P, target) {
  if (!P.mineUse || t.type.mines <= 0 || liveMinesOf(world, t) >= t.type.mines || t.mineCool > 0) return;
  for (const o of world.tanks) if (o.alive && o !== t && !isEnemy(t, o) && Math.hypot(o.x - t.x, o.z - t.z) < MINE_BLAST + 1) return;
  for (const m of world.mines) if (m.alive && Math.hypot(m.x - t.x, m.z - t.z) < 1.4) return;
  const d = target ? Math.hypot(target.x - t.x, target.z - t.z) : 99;
  let want = false;
  if (P.style === 'sapper') { B.mineT -= P.think; if (B.mineT <= 0 && d > 2.6) { want = true; B.mineT = (P.mineEvery || 4) * (0.7 + world.rng() * 0.6); } }
  else if (target) {
    // Cut them off: they're coming at us through a lane and are close enough to walk into it.
    const closing = !target.ghost && (target.vx * (t.x - target.x) + target.vz * (t.z - target.z)) > 0.4;
    let open = 0; const i = Math.floor(t.x), j = Math.floor(t.z);
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (passable(world.grid, i + di, j + dj)) open++;
    if (d > 2.2 && d < 4.5 && closing) want = world.rng() < P.mineUse;
    else if (open <= 2 && d < 7 && d > 2.4) want = world.rng() < P.mineUse * 0.3;
  }
  if (want) {
    t.ctrl.mine = true;
    B.flee = { x: t.x, z: t.z, alive: true };
    B.goalT = 0;
  }
}

// Evaluate a move direction by simulating the real drive model against shell futures.
function dangerOf(world, t, fut, mx, mz, look) {
  const k = { x: t.x, z: t.z, rot: t.rot, rev: t.rev };
  const steps = Math.min(FUTURE_N, Math.ceil(look / (DT * FUTURE_EVERY)));
  let danger = 0;
  const hitR = TANK_R + SHELL_R + 0.12, nearR = TANK_R + 0.55;
  for (let m = 0; m < steps; m++) {
    driveTank(world.grid, k, t.type, mx, mz, DT * FUTURE_EVERY);
    for (const f of fut) {
      if (m >= f.n) continue;
      if (f.s.owner === t.id && f.s.bounces === 0 && f.s.age < 0.25) continue;
      const dx = f.xs[m] - k.x, dz = f.zs[m] - k.z, d2 = dx * dx + dz * dz;
      if (d2 < hitR * hitR) danger = Math.max(danger, 1 - (m / steps) * 0.4);
      else if (d2 < nearR * nearR) danger = Math.max(danger, 0.12);
    }
  }
  danger = Math.max(danger, mineThreat(world, t, k.x, k.z) * 0.8);
  return danger;
}

const DIRS = [...Array(8)].map((_, k) => [Math.cos(k * Math.PI / 4), Math.sin(k * Math.PI / 4)]);

function steer(world, t, B, P, fut) {
  const c = t.ctrl;
  let gdir = flowDir(world, B, t);
  if (B.goal && B.flow && B.flow[Math.floor(t.x) + Math.floor(t.z) * world.cols] === 0 && !gdir) B.goalT = Math.min(B.goalT, world.time + 0.3);
  // Is anything worth dodging nearby?
  let threat = mineThreat(world, t, t.x, t.z) > 0;
  if (!threat && P.dodge) {
    for (const f of fut) {
      for (let m = 0; m < f.n; m += 3) {
        if ((f.xs[m] - t.x) ** 2 + (f.zs[m] - t.z) ** 2 < 3.2 * 3.2) { threat = true; break; }
      }
      if (threat) break;
    }
  }
  if (!threat || !P.dodge) {
    B.dodging = 0;
    if (gdir) { c.mx = gdir[0]; c.mz = gdir[1]; } else { c.mx = 0; c.mz = 0; }
    return;
  }
  const look = P.dodgeLook || 0.5;
  let best = null, bs = -Infinity, bestIdx = -1;
  const opts = DIRS.map((d, k) => [d[0], d[1], k]);
  if (gdir) opts.push([gdir[0], gdir[1], 8]);
  opts.push([0, 0, 9]);
  for (const [mx, mz, k] of opts) {
    const dng = dangerOf(world, t, fut, mx, mz, look);
    const align = gdir && (mx || mz) ? (mx * gdir[0] + mz * gdir[1]) * 0.5 : 0;
    const s = -dng * 5 + align + (k === B.lastDir ? 0.25 : 0);
    if (s > bs) { bs = s; best = [mx, mz]; bestIdx = k; }
  }
  B.lastDir = bestIdx;
  B.dodging = bs < -1 ? 1 : 0;
  c.mx = best[0]; c.mz = best[1];
}

// Counter-fire: shoot the shell that's about to hit us.
function counterShot(world, t, fut) {
  let worst = null, wt = Infinity;
  for (const f of fut) {
    if (f.s.team === t.team && f.s.owner !== t.id) continue;
    for (let m = 0; m < f.n; m++) {
      const d = Math.hypot(f.xs[m] - t.x, f.zs[m] - t.z);
      if (d < TANK_R + SHELL_R + 0.1) { if (m < wt) { wt = m; worst = f; } break; }
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

// ------------------------------------------------------------------ the brain
export function brainStep(world, t, dt) {
  updateIntel(world);
  const P = profileOf(t);
  const B = t.brain || (t.brain = newBrain(world, t));
  const c = t.ctrl;
  const target = pickTarget(world, t);
  B.target = target;
  const fut = shellFutures(world);
  B.fireGap -= dt;

  B.thinkT -= dt;
  const thinking = B.thinkT <= 0;
  if (thinking) {
    B.thinkT = P.think * (0.85 + world.rng() * 0.3);
    B.shot = target || world.tanks.some((o) => o.alive && isEnemy(t, o)) ? planShot(world, t, B, P, target) : null;
    B.err = (world.rng() * 2 - 1) * P.aimErr;
    if (t.type.speed > 0) {
      considerMine(world, t, B, P, target);
      if (world.time > B.goalT || !B.goal) chooseGoal(world, t, B, P, target);
      if (Math.abs(t.speedNow) < 0.05 && (c.mx || c.mz)) { B.stuckT += P.think; if (B.stuckT > 1.2) { B.goalT = 0; B.stuckT = 0; B.goal = null; } }
      else B.stuckT = 0;
    }
  }

  // Aim.
  let aimAt = null, wantFire = false;
  if (P.counterFire && (thinking || B.dodging)) {
    const a = counterShot(world, t, fut);
    if (a != null) { aimAt = a; wantFire = Math.abs(wrapAngle(t.aim - a)) < 0.06; }
  }
  if (aimAt == null) {
    if (B.shot) aimAt = B.shot.angle + B.err;
    else if (P.sweep) { if (thinking && world.rng() < 0.3) B.sweep = -B.sweep; aimAt = t.aim + B.sweep * 0.6; }
    else if (target) aimAt = Math.atan2(target.z - t.z, target.x - t.x);
    else if (Math.abs(t.speedNow) > 0.2) aimAt = t.rot; // no contact: turret forward while driving
    else aimAt = t.aim;
  }
  c.aim = aimAt;

  // Fire.
  const ready = t.cool <= 0 && t.burstLeft === 0 && liveShellsOf(world, t) < t.type.maxShells;
  if (ready && B.fireGap <= 0) {
    if (wantFire) { c.fire = true; B.fireGap = 0.15; }
    else if (B.shot && Math.abs(wrapAngle(t.aim - aimAt)) < P.fireTol) {
      // Keep a shell in reserve for counter-fire unless the shot is point blank.
      const reserve = P.counterFire && liveShellsOf(world, t) >= t.type.maxShells - 1 && B.shot.score > 0.6;
      if (!reserve) {
        const r = traceShot(world, t, t.aim, { lead: P.lead, known: (o) => seesNow(world, t.team, o.id) });
        const ok = P.verify === 'strict' ? r.kind === 'enemy' : r.kind !== 'self' && r.kind !== 'ally' && r.kind !== 'blocked';
        if (ok) { c.fire = true; B.fireGap = P.fireGap * (0.8 + world.rng() * 0.4); B.shot = null; B.thinkT = Math.min(B.thinkT, 0.05); }
      }
    }
  }

  // Move.
  if (t.type.speed > 0) {
    if (P.dodgeEvery === 'tick' || thinking || B.dodging) steer(world, t, B, P, fut);
    else if (!B.dodging) { const g = flowDir(world, B, t); c.mx = g ? g[0] : 0; c.mz = g ? g[1] : 0; }
  }
}
