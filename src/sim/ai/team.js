// Team-level plan: lane split by class and map points, shared memory of spotted enemies (only
// what the team has seen), lane strengths, push / all-in phases, base defence, and a nav cost
// overlay that spreads paths (congestion) so the team doesn't funnel down one street.
import { mapInfo, clamp, hyp, headingTo, snapPassable } from './util.js';
import { makeRng } from '../battle.js';
import { lineClear, heightAt } from '../map/query.js';

const SHARED = new WeakMap();
// Per-world shared AI state: both team brains and the per-tick path-planning budget.
export function shared(world) {
  let S = SHARED.get(world);
  if (!S) { S = { teams: [null, null], planStep: -1, plans: 0 }; SHARED.set(world, S); }
  return S;
}
export function teamBrain(world, team) {
  const S = shared(world);
  return S.teams[team] || (S.teams[team] = new TeamBrain(world, team));
}
// Path-planning budget: at most PLANS_PER_TICK A* searches per world tick.
const PLANS_PER_TICK = 2;
export function planBudget(world) {
  const S = shared(world);
  if (S.planStep !== world.step) { S.planStep = world.step; S.plans = 0; }
  if (S.plans >= PLANS_PER_TICK) return false;
  S.plans++;
  return true;
}

const CLS_W = { light: 0.7, medium: 1, heavy: 1.25, td: 1 };
// tier matters a lot: each tier up roughly doubles combat value (hp · dpm)
const value = (def, hpFrac) => CLS_W[def.cls] * Math.pow(1.7, def.tier - 5) * (0.35 + 0.65 * hpFrac);

export class TeamBrain {
  constructor(world, team) {
    this.team = team; this.enemy = 1 - team;
    this.map = world.map; this.info = mapInfo(world.map);
    this.rng = makeRng((world.seed * 97 + team * 7919 + 13) >>> 0);
    this.brains = [];
    this.last = -1;
    this.known = new Map();              // enemy id → { x, z, t, hp, def } last sighting
    this.base = world.bases.find((b) => b.team === team) || world.bases[0];
    this.eBase = world.bases.find((b) => b.team !== team) || world.bases[1];
    this.push = 0;                       // 0 hold, 1 push (heavies/mediums advance), 2 all-in (everyone, cap)
    this.defend = null;                  // { need, since } while our base is being captured
    this.pointUse = new Map();
    this.laneA = []; this.laneE = [];
    this.ratio = 1; this.aliveA = 0; this.aliveE = 0;
    this.focus = new Map();              // target id → number of our bots on it
    // nav cost overlay: base cost + congestion (decays)
    const nav = this.info.nav;
    if (nav) {
      this.navStatic = Float32Array.from(nav.cost);   // base + wrecks (permanent)
      this.navCost = Float32Array.from(nav.cost);     // static + congestion / blocked marks (decay)
      this.nav = { cell: nav.cell, cols: nav.cols, rows: nav.rows, cost: this.navCost };
      this.navS = { cell: nav.cell, cols: nav.cols, rows: nav.rows, cost: this.navStatic };
    } else this.nav = this.navS = null;
    this.wrecks = new Set();
    this.lastDecay = 0;
    this.assigned = false;
    // danger map: coarse cells seen by recently spotted enemies (computed a slice per tick)
    this.dc = 16; this.dn = Math.ceil(world.map.size / this.dc);
    this.danger = new Float32Array(this.dn * this.dn);
    this.views = new Map();              // enemy id → { x, z, t, cells: Uint8Array, k: next cell, done }
    this.workStep = -1; this.dangerAt = -1;
    this.planScratch = this.nav ? new Float32Array(this.navCost.length) : null;
  }

  register(b) { this.brains.push(b); }
  // Team-relative lane progress (0 at our base, 1 at theirs).
  prog(x, z, g) { const s = this.info.lanes[g].project(x, z).s; return this.team === 0 ? s : 1 - s; }
  laneAt(g, s) { return this.info.lanes[g].at(this.team === 0 ? s : 1 - s); }

  // Once per second (the first bot to call it in a tick runs it).
  tick(world) {
    if (world.time - this.last < 1 && this.last >= 0) return;
    this.last = world.time;
    if (!this.assigned) { this.assignAll(world); this.assigned = true; }
    const vis = world.visible[this.team], nL = this.info.lanes.length;
    this.laneA = new Array(nL).fill(0); this.laneE = new Array(nL).fill(0);
    let sA = 0, sE = 0, aA = 0, aE = 0;
    this.focus.clear();
    for (const t of world.tanks) {
      if (!t.alive) {
        if (t.team !== this.team) this.known.delete(t.id);
        if (!this.wrecks.has(t.id)) { this.wrecks.add(t.id); this.addWreck(t.pos.x, t.pos.z); }
        continue;
      }
      if (t.team === this.team) {
        aA++; sA += value(t.def, t.hp / t.maxHp);
        this.laneA[this.info.geo(t.pos.x, t.pos.z)]++;
        continue;
      }
      aE++;
      if (vis.has(t.id)) this.known.set(t.id, { x: t.pos.x, z: t.pos.z, t: world.time, hp: t.hp, def: t.def });
      const k = this.known.get(t.id);
      // the team list is public (alive/dead, tank type); hp only as last seen
      sE += value(t.def, k ? k.hp / t.maxHp : 1);
      if (k && world.time - k.t < 25) this.laneE[this.info.geo(k.x, k.z)]++;
    }
    for (const b of this.brains) if (b.t.alive && b.target) this.focus.set(b.target.id, (this.focus.get(b.target.id) || 0) + 1);
    this.aliveA = aA; this.aliveE = aE;
    this.ratio = sA / Math.max(0.05, sE);
    // Phase: push when stronger or as time passes; all-in late or when crushing.
    const T = world.time;
    let push = 0;
    if ((T > 150 && this.ratio > 1.35) || T > 300 || (aE <= 3 && aA >= aE + 2)) push = 1;
    if (T > 450 || this.ratio > 2.2 || aE <= 2 || (T > 200 && this.ratio > 1.8)) push = 2;
    this.push = Math.max(this.push === 2 && this.ratio > 0.7 ? 2 : 0, push);
    // Base defence: our base is being captured.
    const b = world.bases.find((x) => x.team === this.team);
    if (b && b.points > 0 && b.cappers.length) {
      const need = Math.min(aA, 2 + Math.ceil(b.points / 15) + b.cappers.length);
      this.defend = { need, points: b.points, cappers: b.cappers.length, since: this.defend ? this.defend.since : T, calm: 0 };
    } else if (this.defend) {
      this.defend.calm = (this.defend.calm || 0) + 1;
      if (b.points === 0 && this.defend.calm > 6) this.defend = null;
    }
    this.pickDefenders(world);
    // congestion decay every 10 s
    if (this.nav && T - this.lastDecay > 10) {
      this.lastDecay = T;
      const base = this.navStatic, c = this.navCost;
      for (let i = 0; i < c.length; i++) if (c[i] !== base[i]) c[i] = base[i] + (c[i] - base[i]) * 0.55;
    }
  }

  // Per-tick background work (first bot of the team each tick): one slice of the danger map.
  work(world) {
    if (this.workStep === world.step) return;
    this.workStep = world.step;
    let job = null;
    for (const v of this.views.values()) if (!v.done) { job = v; break; }
    if (!job) {
      // (re)start a view for the enemy whose record is missing or stale (moved > 20 m)
      for (const [id, k] of this.known) {
        if (world.time - k.t > 20) continue;
        const v = this.views.get(id);
        if (v && hyp(v.x - k.x, v.z - k.z) < 20) continue;
        job = { id, x: k.x, z: k.z, y: heightAt(world.map, k.x, k.z) + 2.6, cells: v ? v.cells : new Uint8Array(this.dn * this.dn), k: 0, done: false };
        job.cells.fill(0);
        this.views.set(id, job);
        break;
      }
      if (!job) return;
    }
    const n = this.dn, dc = this.dc, map = world.map, E = { x: job.x, y: job.y, z: job.z }, P = {};
    const R2 = 440 * 440;
    for (let it = 0; it < 90 && job.k < n * n; job.k++) {
      const i = job.k % n, j = (job.k / n) | 0, x = (i + 0.5) * dc, z = (j + 0.5) * dc;
      const dx = x - job.x, dz = z - job.z;
      if (dx * dx + dz * dz > R2) continue;
      it++;
      P.x = x; P.z = z; P.y = heightAt(map, x, z) + 1.8;
      job.cells[job.k] = lineClear(map, E, P) ? 1 : 0;
    }
    if (job.k >= n * n) { job.done = true; this.sumDanger(world); }
  }
  sumDanger(world) {
    const d = this.danger; d.fill(0);
    for (const [id, v] of this.views) {
      const k = this.known.get(id);
      if (!k || world.time - k.t > 25) { this.views.delete(id); continue; }
      if (!v.done) continue;
      const w = world.time - k.t < 10 ? 1 : 0.5;
      for (let i = 0; i < d.length; i++) if (v.cells[i]) d[i] += w;
    }
  }
  dangerAt2(x, z) { const n = this.dn, i = Math.min(n - 1, Math.max(0, Math.floor(x / this.dc))), j = Math.min(n - 1, Math.max(0, Math.floor(z / this.dc))); return this.danger[j * n + i]; }
  // Nav for A*: the overlay plus `w` per enemy that can see a cell (skilled bots avoid open ground).
  planNav(w) {
    if (!this.nav || w <= 0) return this.nav;
    const { cols, rows, cell } = this.nav, c = this.navCost, out = this.planScratch, n = this.dn, f = cell / this.dc;
    for (let r = 0; r < rows; r++) {
      const dj = Math.min(n - 1, Math.floor((r + 0.5) * f)) * n;
      for (let q = 0; q < cols; q++) {
        const k = r * cols + q, dd = this.danger[dj + Math.min(n - 1, Math.floor((q + 0.5) * f))];
        out[k] = dd ? c[k] + w * Math.min(3, dd) : c[k];
      }
    }
    return { cell, cols, rows, cost: out };
  }

  // Nearest bots to our base (by travel time) are flagged as defenders.
  pickDefenders(world) {
    const D = this.defend;
    const live = this.brains.filter((b) => b.t.alive);
    for (const b of live) b.defending = false;
    if (!D) return;
    const eta = (b) => hyp(b.t.pos.x - this.base.x, b.t.pos.z - this.base.z) / Math.max(3, b.t.def.speed / 3.6 * 0.7);
    const left = (100 - D.points) / Math.max(1, Math.min(3, D.cappers));
    const ranked = live.map((b) => [b, eta(b)]).sort((p, q) => p[1] - q[1]);
    let n = 0;
    for (const [b, e] of ranked) {
      if (n >= D.need) break;
      // anyone who can make it; if the cap is nearly done, everyone close enough tries
      if (e < left + 20 || n < 2) { b.defending = true; n++; }
    }
  }

  // Congestion: each planned path makes its cells a bit dearer for the next teammate.
  notePath(pts) {
    if (!this.nav) return;
    const { cell, cols, rows } = this.nav, c = this.navCost, seen = new Set();
    for (const [x, z] of pts) {
      const cc = Math.floor(x / cell), rr = Math.floor(z / cell);
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        const r = rr + dr, q = cc + dc;
        if (r < 0 || q < 0 || r >= rows || q >= cols) continue;
        const k = r * cols + q;
        if (seen.has(k) || !isFinite(c[k])) continue;
        seen.add(k); c[k] += dr || dc ? 0.12 : 0.3;
      }
    }
  }
  // A wreck is a permanent obstacle: its cell (and the ones it overlaps) get dearer.
  addWreck(x, z) {
    if (!this.nav) return;
    const { cell, cols, rows } = this.nav, cc = Math.floor(x / cell), rr = Math.floor(z / cell);
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const r = rr + dr, q = cc + dc;
      if (r < 0 || q < 0 || r >= rows || q >= cols) continue;
      // overlap of a ~4.5 m wreck circle with the neighbouring cell
      const nx = Math.max(q * cell, Math.min(x, (q + 1) * cell)), nz = Math.max(r * cell, Math.min(z, (r + 1) * cell));
      if (Math.hypot(nx - x, nz - z) > 4.5) continue;
      const k = r * cols + q, add = dr || dc ? 1.5 : 4;
      if (isFinite(this.navStatic[k])) { this.navStatic[k] += add; this.navCost[k] += add; }
    }
  }
  // A cell where a bot got stuck: make it expensive for a while.
  noteBlocked(x, z) {
    if (!this.nav) return;
    const { cell, cols, rows } = this.nav, cc = Math.floor(x / cell), rr = Math.floor(z / cell);
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const r = rr + dr, q = cc + dc;
      if (r >= 0 && q >= 0 && r < rows && q < cols && isFinite(this.navCost[r * cols + q])) this.navCost[r * cols + q] += dr || dc ? 1 : 3;
    }
  }

  // ------------------------------------------------------------------ posts
  ownPoints(kinds, geo = -1) {
    return this.info.points.filter((p) => (p.team === this.team || p.team == null) && kinds.includes(p.kind) && (geo < 0 || p.geo === geo));
  }
  enemyPoints(kinds, geo = -1) {
    return this.info.points.filter((p) => p.team === this.enemy && kinds.includes(p.kind) && (geo < 0 || p.geo === geo));
  }
  // A post near point p for the k-th user: spread sideways, snapped to passable ground.
  postAt(p, spread = 14) {
    if (!p) return this.lanePost(this.info.brawlLane, 0.35);
    const k = this.pointUse.get(p.i) || 0;
    this.pointUse.set(p.i, k + 1);
    const face = this.faceFrom(p.x, p.z, p.geo);
    const side = k === 0 ? 0 : (k % 2 ? 1 : -1) * Math.ceil(k / 2) * spread;
    const back = k > 2 ? -8 : 0;
    const lx = Math.cos(face), lz = -Math.sin(face), fx = Math.sin(face), fz = Math.cos(face);
    const q = snapPassable(this.info.nav, p.x + lx * side + fx * back, p.z + lz * side + fz * back);
    return { x: q.x, z: q.z, yaw: face, kind: p.kind, geo: p.geo, point: p };
  }
  releasePoint(p) { if (p && this.pointUse.get(p.i)) this.pointUse.set(p.i, this.pointUse.get(p.i) - 1); }
  // Facing from a spot: towards the enemy side along its lane.
  faceFrom(x, z, g) {
    const s = this.prog(x, z, g), q = this.laneAt(g, Math.min(1, s + 0.25));
    return headingTo(x, z, q.x, q.z);
  }
  // A post on lane g at team-progress s (no map point).
  lanePost(g, s, kind = 'lane') {
    const q = this.laneAt(g, s), r = snapPassable(this.info.nav, q.x, q.z);
    return { x: r.x, z: r.z, yaw: this.faceFrom(r.x, r.z, g), kind, geo: g, point: null };
  }
  leastUsed(list) {
    let best = null, bu = Infinity;
    for (const p of list) { const u = (this.pointUse.get(p.i) || 0) + this.rng() * 0.5; if (u < bu) { bu = u; best = p; } }
    return best;
  }

  // Initial split: lights scout, TDs snipe, heavies brawl, mediums balance the lanes.
  assignAll(world) {
    const order = { light: 0, td: 1, heavy: 2, medium: 3 };
    const bots = this.brains.filter((b) => b.t.alive).sort((a, b) => order[a.cls] - order[b.cls] || a.t.id - b.t.id);
    const nL = this.info.lanes.length, laneLoad = new Array(nL).fill(0);
    // player(s) count towards the lane they will probably take: unknown, so centre-ish
    let heavies = 0;
    for (const b of bots) {
      let post = null;
      const potato = this.rng() < 0.35 - b.skill;       // bad players pick odd spots
      if (potato) {
        // bad players pick odd spots: a random point, or the open middle of a random lane
        const any = this.ownPoints(['sniper', 'bush', 'hulldown', 'brawl', 'flank', 'scout']);
        post = this.rng() < 0.5 ? this.lanePost(Math.floor(this.rng() * this.info.lanes.length), 0.4 + this.rng() * 0.12, 'open')
          : this.postAt(any[Math.floor(this.rng() * any.length)]);
      } else if (b.cls === 'light') {
        const p = this.leastUsed(this.ownPoints(['scout'])) || this.leastUsed(this.ownPoints(['bush', 'flank']));
        post = p && this.postAt(p);
        b.scoutPhase = post && post.kind === 'scout' ? 1 : 0;
      } else if (b.cls === 'td') {
        let list = this.ownPoints(['sniper']).filter((p) => (this.pointUse.get(p.i) || 0) < 2);
        if (!list.length) list = this.ownPoints(['bush', 'sniper']);
        post = this.postAt(this.leastUsed(list));
      } else if (b.cls === 'heavy') {
        heavies++;
        const list = heavies <= 4 ? this.ownPoints(['brawl'], this.info.brawlLane) : this.ownPoints(['hulldown', 'brawl']);
        const p = this.leastUsed(list.length ? list : this.ownPoints(['brawl', 'hulldown']));
        post = p && this.postAt(p, 12);
      } else {
        // medium: the lane with the lowest load (the brawl lane counts heavies)
        let g = 0, bl = Infinity;
        for (let i = 0; i < nL; i++) { const l = laneLoad[i] + (i === this.info.brawlLane ? 0.5 : 0) + this.rng() * 0.8; if (l < bl) { bl = l; g = i; } }
        const list = this.ownPoints(['hulldown', 'flank', 'bush', 'brawl'], g);
        post = list.length ? this.postAt(this.leastUsed(list)) : this.lanePost(g, 0.4);
      }
      if (!post) post = this.lanePost(this.info.brawlLane, 0.35);
      laneLoad[post.geo] += b.cls === 'td' ? 0.6 : 1;
      b.setPost(post);
    }
  }
  // A light that has scouted falls back to a passive bush in its lane.
  passivePost(b) {
    const g = b.post ? b.post.geo : 0;
    const p = this.leastUsed(this.ownPoints(['bush'], g)) || this.leastUsed(this.ownPoints(['bush', 'sniper']));
    return p ? this.postAt(p) : this.lanePost(g, 0.25);
  }
  // Somewhere else to snipe from (a TD that got lit up).
  relocatePost(b) {
    const cur = b.post && b.post.point;
    const list = this.ownPoints(b.cls === 'td' ? ['sniper', 'bush'] : ['bush', 'hulldown', 'sniper']).filter((p) => p !== cur);
    if (!list.length) return null;
    // nearest alternative
    let best = null, bd = Infinity;
    for (const p of list) { const d = hyp(p.x - b.t.pos.x, p.z - b.t.pos.z) + (this.pointUse.get(p.i) || 0) * 60; if (d < bd) { bd = d; best = p; } }
    return this.postAt(best);
  }
  // Flex: the lane a medium should support (winning lane to break through, or a collapsing one).
  flexLane(b) {
    const nL = this.info.lanes.length, cur = b.post ? b.post.geo : 0;
    let best = cur, bs = 0;
    for (let g = 0; g < nL; g++) {
      const d = this.laneA[g] - this.laneE[g];
      // winning lane (we outnumber them): support the push; collapsing lane: help hold
      const s = d >= 2 && this.laneE[g] > 0 ? 1 + d * 0.3 : this.laneE[g] - this.laneA[g] >= 3 ? 1 + (this.laneE[g] - this.laneA[g]) * 0.25 : 0;
      if (s > bs + 0.3 && g !== cur) { bs = s; best = g; }
    }
    return best;
  }
  // Next objective when pushing along lane g from team-progress s: an enemy-side point, then their base.
  pushGoal(g, s) {
    if (s > 0.72) return null; // → base
    const pts = this.info.points.filter((p) => p.geo === g && p.kind !== 'sniper' && p.kind !== 'scout');
    let best = null, bs = Infinity;
    for (const p of pts) {
      const ps = this.team === 0 ? p.s : 1 - p.s;
      if (ps > s + 0.06 && ps < s + 0.35 && ps < bs) { bs = ps; best = p; }
    }
    if (best) { const q = snapPassable(this.info.nav, best.x + (this.rng() - 0.5) * 20, best.z + (this.rng() - 0.5) * 20); return { x: q.x, z: q.z, geo: g, kind: best.kind, s: bs }; }
    const ns = Math.min(0.85, s + 0.18), q = this.laneAt(g, ns), r = snapPassable(this.info.nav, q.x, q.z);
    return { x: r.x, z: r.z, geo: g, kind: 'lane', s: ns };
  }
  // Nearest remembered enemy (seen within maxAge s) to (x, z).
  nearestKnown(x, z, maxAge, now, maxD = 600, skip = null) {
    let best = null, bd = maxD;
    for (const [id, k] of this.known) {
      if (now - k.t > maxAge || (skip && skip.get(id) === k.t)) continue;
      const d = hyp(k.x - x, k.z - z);
      if (d < bd) { bd = d; best = { id, ...k, d }; }
    }
    return best;
  }
}

export { clamp };
