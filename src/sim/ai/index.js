// Steel Front bot AI. createBrain(world, tank) → brain; brain.control(world) → Controls, every tick.
// Layers: TeamBrain (team.js: lanes, posts, phases, defence, shared memory) → Brain.decide
// (4 Hz: where to go, hold or move) → Brain.perceive (target choice, staggered by skill) →
// per-tick driving (path follower, avoidance, unstick) and gunnery (weak spot, lead, patience).
// Deterministic: randomness comes from a per-bot rng seeded from world.seed and the tank id.
// The bot only uses what its team has spotted (world.visible[team]); no wallhacks.
import { aimSolution, predictImpact, DT, makeRng, penPreview, hullToWorld } from '../battle.js';
import { heightAt, lineClear } from '../map/query.js';
import { teamBrain, planBudget } from './team.js';
import { plan, Follower, segClear } from './path.js';
import { bestAim, candWorld, lineTo, gunFacing, alphaOf, chooseShell, chanceWith, pHit } from './combat.js';
import { wrap, clamp, hyp, headingTo, shellSlots, snapPassable, passable, TAU } from './util.js';

const CRUISE_LOOK = 11;                    // m, carrot distance (+ speed)
const ENGAGE_RANGE = { light: 300, medium: 330, heavy: 240, td: 480 };   // stop and fight inside this
const FIRE_RANGE = { light: 330, medium: 390, heavy: 320, td: 520 };     // don't bother shooting beyond
const _sol = {};

export function createBrain(world, tank) { return new Brain(world, tank); }

export class Brain {
  constructor(world, tank) {
    this.t = tank;
    this.cls = tank.def.cls;
    const s = this.skill = clamp(tank.bot && tank.bot.skill != null ? tank.bot.skill : 0.5, 0, 1);
    this.rng = makeRng(((world.seed | 0) * 2654435761 ^ (tank.id * 40503 + 17)) >>> 0);
    this.team = teamBrain(world, tank.team);
    this.team.register(this);
    this.slots = shellSlots(tank.gunDef);
    this.phase = (tank.id * 7) % 60;
    // --- skill knobs (see docs/notes/ai.md)
    const p = 1 - s;
    this.react = 0.2 + 1.3 * p ** 1.3;                 // s before a fresh contact is engaged
    this.evalN = Math.round(10 + 20 * p);               // ticks between target evaluations
    this.aimErrBase = 0.08 + 2.2 * p * p;               // m of aim error at ~200 m
    this.patience = 0.3 + 2.4 * s;                      // × gun aim time we are willing to wait
    this.patienceK = 0.35 + 0.65 * s;                   // 1 ≈ optimal trigger timing, < 1 trigger-happy
    this.errFloor = 0.2 + 0.6 * p;                      // aim error left after tracking a target
    this.leadK = 0.25 + 0.75 * s;                       // fraction of the true lead applied
    this.goldBudget = s > 0.6 ? Math.round((s - 0.6) * 25) : 0;
    this.goldUsed = 0;
    this.angleArmor = (this.cls === 'heavy' || (this.cls === 'medium' && tank.def.hull.upper.t >= 60)) && s > 0.4 ? (s > 0.7 ? 0.45 : 0.3) : 0;
    this.angleSide = this.rng() < 0.5 ? 1 : -1;
    this.peeker = s >= 0.5 && tank.gunDef.reload >= 5.5;
    // --- state
    this.c = { throttle: 0, steer: 0, brake: false, aim: null, lockGun: false, fire: false, shell: tank.shell, use: null };
    this._aim = { x: 0, y: 0, z: 0 };
    this.post = null; this.goal = null; this.goalKey = ''; this.mode = 'post';
    this.follow = new Follower(); this.needPlan = true; this.planFail = 0;
    this.hold = false; this.arrived = false; this.wantMove = false;
    this.seen = new Map(); this.enemies = [];
    this.target = null; this.targetLos = false; this.targetD = 0; this.aimPt = null; this.aimAt = -9;
    this.aimSince = 0; this.laidSince = -1; this.err = { x: 0, y: 0, z: 0 }; this.errAt = -9;
    this.nextShot = 0; this.checkAt = 0; this.curErr = 0; this.readyAt = 0;
    this.lastHitT = -99; this.hitDir = null; this.recentDmg = 0;
    this.stuckT = 0; this.reverseT = 0; this.revSteer = 0; this.unsticks = []; this.jitter = null;
    this.progT = 0; this.pushT = 0; this.stall = 0; this.lastRemain = Infinity; this.progYaw = 0; this.escape = null; this.pivoting = false; this.intent = 0;
    this.peek = 0; this.peekT = 0; this.peekDur = 0; this.peekWhy = ''; this.duckUntil = -1;
    this.scoutPhase = 0; this.scoutAt = -1; this.relocAt = -99; this.flexAt = 40 + this.rng() * 30;
    this.brawlPushAt = 70 + this.rng() * 50;
    this.openingT = 75 + 40 * this.rng();
    this.dangerW = s < 0.3 ? 0 : 0.6 + 1.6 * s;          // A* cost per enemy that can see a cell
    this.yolo = this.rng() < 0.45 - s;                  // potatoes that charge alone
    this.yoloAt = 50 + this.rng() * 80;
    this.retreated = false; this.defending = false; this.huntId = null; this.cleared = new Map(); this.capping = false; this.pushS = 0; this.pushGoal = null; this.cover = null; this.coverAt = -99;
    this.useAt = {}; this.carrot = { x: 0, z: 0, remain: 0 };
    this.stats = { unsticks: 0, plans: 0 };
  }

  setPost(post) {
    if (this.post && this.post.point !== (post && post.point)) this.team.releasePoint(this.post.point);
    // skilled snipers sit ~18 m behind their bush: the sim drops a target's own bush (≤ 15 m)
    // from its camo after it fires, but foliage farther in front still hides the muzzle flash
    if (post && this.skill > 0.55 && (post.kind === 'sniper' || post.kind === 'bush') && this.cls !== 'heavy') {
      const back = 17 + this.rng() * 4, x = post.x - Math.sin(post.yaw) * back, z = post.z - Math.cos(post.yaw) * back;
      if (passable(this.team.navS, x, z, 2.2)) post = { ...post, x, z, behind: true };
    }
    this.post = post;
  }

  control(world) {
    const t = this.t, c = this.c;
    c.fire = false; c.use = null;
    if (!t.alive) { c.throttle = 0; c.steer = 0; c.brake = true; c.aim = null; c.lockGun = true; this.wantMove = false; return c; }
    this.team.tick(world);
    this.team.work(world);
    this.events(world);
    const k = world.step + this.phase;
    if (k % this.evalN === 0 || (this.target && !this.target.alive)) this.perceive(world);
    if (k % 15 === 0 || !this.goal) this.decide(world);
    this.drive(world);
    this.gun(world);
    if (k % 20 === 3) this.consume(world);
    return c;
  }

  // ------------------------------------------------------------------ events
  events(world) {
    const t = this.t;
    for (const e of world.events) {
      if (e.type === 'hit' && e.target === t.id) {
        this.lastHitT = world.time; this.recentDmg += e.dmg || 0;
        const sh = world.byId[e.shooter];
        // the damage indicator gives a direction, not a position
        if (sh) this.hitDir = headingTo(t.pos.x, t.pos.z, sh.pos.x, sh.pos.z) + (this.rng() - 0.5) * 0.3;
      }
    }
    this.recentDmg *= 0.9995; // fades over ~30 s
  }

  // ------------------------------------------------------------------ perception / targets
  perceive(world) {
    const t = this.t, now = world.time, vis = world.visible[t.team], T = this.team, s = this.skill;
    this.enemies.length = 0;
    let best = null, bs = -Infinity;
    const myAlpha = alphaOf(t, this.slots.std);
    for (const e of world.tanks) {
      if (e.team === t.team || !e.alive) continue;
      if (!vis.has(e.id)) { this.seen.delete(e.id); continue; }
      if (!this.seen.has(e.id)) this.seen.set(e.id, now);
      const d = hyp(e.pos.x - t.pos.x, e.pos.z - t.pos.z);
      if (d > 600 || now - this.seen.get(e.id) < this.react) continue;
      const los = lineTo(world, this, e);
      this.enemies.push({ e, d, los });
      if (!los) continue;
      // quick pen estimate: the plate at the hull centre (skilled bots also know better spots)
      let pen = 0.5;
      if (s > 0.25) {
        const a = e === this.target && this.aimPt ? this.aimPt : null;
        pen = a ? a.chance : quickPen(world, t, e);
        if (s > 0.58 && pen < 0.3) pen = Math.max(pen, 0.25); // they know weak spots exist
      }
      const kill = e.hp <= myAlpha * 1.05 ? 1 : 0.5 * (1 - e.hp / e.maxHp);
      const threat = (alphaOf(e) / Math.max(1.5, e.gunDef.reload)) / 40 * (gunFacing(e, t.pos.x, t.pos.z) > 0.95 ? 1.6 : 1);
      let sc = 1.2 * pen + (0.3 + s) * kill + (0.2 + 0.6 * s) * Math.min(1.5, threat) - d / 450;
      sc += Math.min(3, T.focus.get(e.id) || 0) * 0.35 * s * s - (e === this.target ? 0 : 0.35);
      if (s < 0.4) sc += (this.rng() - 0.5) * (0.4 - s) * 3; // potatoes pick at random-ish
      if (sc > bs) { bs = sc; best = e; this.targetD = d; }
    }
    if (best !== this.target) {
      this.target = best; this.aimPt = null; this.laidSince = -1; this.aimSince = now;
      this.rollErr(now);
    }
    this.targetLos = !!best;
    if (best) this.pickAim(world);
  }
  rollErr(now) {
    const r = this.rng, a = r() * TAU, b = (r() - 0.5) * 2;
    this.err.x = Math.cos(a) * Math.sqrt(1 - b * b); this.err.z = Math.sin(a) * Math.sqrt(1 - b * b); this.err.y = b * 0.6;
    this.errAt = now;
  }
  pickAim(world) {
    const tg = this.target;
    if (!tg) return;
    this.aimPt = bestAim(world, this, tg);
    this.aimAt = world.time;
    if (!this.aimPt) { this.targetLos = false; return; }
    // shell for this plate (only switch when the gun has just fired: switching reloads it)
    this.wantShell = chooseShell(this, tg, this.aimPt, this.targetD);
  }

  // ------------------------------------------------------------------ decisions (4 Hz)
  decide(world) {
    const t = this.t, T = this.team, now = world.time, s = this.skill;
    const hpF = t.hp / t.maxHp;
    const pos = t.pos;
    let goal = null, mode = 'post', hold = false;
    const tgt = this.targetLos ? this.target : null;
    // over-exposed (skilled bots): several guns on us, or losing hp fast → duck out for a bit
    if (s > 0.45 && t.spotted && now > this.duckUntil + 4 && this.peek === 0) {
      let aimed = 0;
      for (const x of this.enemies) if (x.los && x.d < 450 && gunFacing(x.e, pos.x, pos.z) > 0.97) aimed++;
      const hot = aimed >= 3 || (aimed >= 2 && hpF < 0.7) || this.recentDmg > t.maxHp * 0.25;
      const blind = !tgt && now - this.lastHitT < 1.5 && this.arrived;   // lit and hit by someone we can't answer
      if (hot || blind) {
        // duck only when backing off actually breaks the sight lines; otherwise move elsewhere
        if (this.coverBehind(world, 9)) { this.duckUntil = now + (blind ? 4 : 2.5) + 3 * this.rng(); this.recentDmg *= 0.5; }
        else if (blind && now - this.relocAt > 25 && T.push < 2) { const q = T.relocatePost(this); if (q) { this.setPost(q); this.relocAt = now; this.arrived = false; } }
      }
    }
    // lit in the open on the way to the post (skilled bots): break contact behind nearby cover
    if (this.cover && (now > this.cover.until || this.defending)) this.cover = null;
    if (s > 0.45 && !this.cover && t.spotted && !this.arrived && now > this.coverAt + 8 && this.post && !this.defending
      && hyp(this.post.x - pos.x, this.post.z - pos.z) > 40 && (now - this.lastHitT < 2.5 || this.enemies.some((x) => x.los && x.d < 420 && gunFacing(x.e, pos.x, pos.z) > 0.97))) {
      this.coverAt = now;
      const cv = this.findCover(world);
      if (cv) this.cover = { x: cv.x, z: cv.z, until: now + 5 + 6 * this.rng(), geo: this.post.geo };
    }
    const range = ENGAGE_RANGE[this.cls];
    const g = this.post ? this.post.geo : T.info.brawlLane;
    const prog = T.prog(pos.x, pos.z, g);
    // light scouting: scout point, then fall back to a passive bush
    if (this.cls === 'light' && this.scoutPhase === 1 && this.arrived && this.post && this.post.kind === 'scout') {
      if (this.scoutAt < 0) this.scoutAt = now;
      if (now - this.scoutAt > 20 + 25 * this.rng() || (t.spotted && now - this.scoutAt > 4) || now - this.lastHitT < 2) {
        this.scoutPhase = 2; this.setPost(T.passivePost(this)); this.arrived = false;
      }
    }
    // TDs (and passive lights) relocate when lit and shot at without a target to answer
    if ((this.cls === 'td' || this.scoutPhase === 2) && s > 0.45 && t.spotted && now - this.lastHitT < 3 && !tgt && now - this.relocAt > 40 && T.push < 2) {
      const p = T.relocatePost(this); if (p) { this.setPost(p); this.relocAt = now; this.arrived = false; }
    }
    // flex mediums: move to the lane that needs them
    if (this.cls === 'medium' && now > this.flexAt && T.push === 0 && !tgt) {
      this.flexAt = now + 20;
      const ng = T.flexLane(this);
      if (this.post && ng !== this.post.geo) {
        const list = T.ownPoints(['hulldown', 'flank', 'bush', 'brawl'], ng);
        this.setPost(list.length ? T.postAt(T.leastUsed(list)) : T.lanePost(ng, 0.45)); this.arrived = false;
      }
    }
    if (this.cover) {
      goal = this.cover; mode = 'cover';
    } else if (this.defending) {
      // back to base: stop and shoot cappers / close enemies, otherwise drive into the circle
      const b = T.base, db = hyp(pos.x - b.x, pos.z - b.z);
      mode = 'defend';
      goal = this.jitterGoal(b.x, b.z, 18);
      if (tgt && (db < b.r + 60 || this.targetD < 150)) hold = true;
    } else if (hpF < 0.25 && s >= 0.3 && T.push < 2 && !this.retreated && this.enemies.some((x) => x.los && x.d < 380)) {
      // low hp: fall back towards our side of the lane and play support from there
      this.retreated = true;
      this.setPost(T.relocatePost(this) || T.lanePost(g, Math.max(0.08, prog - 0.25), 'fallback'));
      this.arrived = false; goal = this.post; mode = 'retreat';
    } else {
      const pushing = T.push >= 2 || (T.push === 1 && (this.cls === 'heavy' || this.cls === 'medium'))
        || (this.cls === 'heavy' && now > this.brawlPushAt && T.laneA[g] >= T.laneE[g] && !this.retreated)
        || (this.yolo && now > this.yoloAt && this.cls !== 'td');
      if (pushing && !(this.retreated && T.push < 2)) {
        mode = 'push';
        // hunt the nearest remembered enemy (sticky: switch only for a much closer one)
        // a last-known spot we reached without finding anyone is "cleared" until it's seen again
        if (this.huntId != null) {
          const k = T.known.get(this.huntId);
          if (k && hyp(k.x - pos.x, k.z - pos.z) < 45 && !world.visible[t.team].has(this.huntId)) { this.cleared.set(this.huntId, k.t); this.huntId = null; }
        }
        let hunt = T.nearestKnown(pos.x, pos.z, 30, now, 420, this.cleared);
        const cur = this.huntId != null && T.known.get(this.huntId);
        if (cur && now - cur.t < 30 && (!hunt || hunt.id === this.huntId || hunt.d > 0.6 * hyp(cur.x - pos.x, cur.z - pos.z))) hunt = { id: this.huntId, ...cur, d: hyp(cur.x - pos.x, cur.z - pos.z) };
        this.huntId = hunt ? hunt.id : null;
        if (!(T.push >= 1 || this.yolo)) this.capping = false;
        if (prog > 0.72 || (T.push >= 2 && prog > 0.6)) this.capping = true;
        if (tgt && this.targetD < range) hold = true;
        else if (hunt && hunt.d > 40) goal = this.jitterGoal(hunt.x, hunt.z, 10, 'h' + hunt.id);
        else if (this.capping) { goal = this.jitterGoal(T.eBase.x, T.eBase.z, 22, 'cap'); mode = 'cap'; }
        else {
          // lane objectives only ever move forward
          if (!this.pushGoal || hyp(this.pushGoal.x - pos.x, this.pushGoal.z - pos.z) < 18 || this.pushGoal.geo !== g) {
            this.pushGoal = T.pushGoal(g, Math.max(prog, this.pushS));
            if (this.pushGoal) this.pushS = this.pushGoal.s; else this.capping = true;
          }
          goal = this.pushGoal || this.jitterGoal(T.eBase.x, T.eBase.z, 22, 'cap');
        }
      } else {
        goal = this.post;
        // stop and fight when a target is in range (lights on a scouting run keep going)
        if (tgt && this.targetD < range && !(this.cls === 'light' && this.scoutPhase === 1 && !this.arrived && this.targetD > 120)) {
          // skilled bots finish the last few metres into cover first
          // skilled bots don't stop to trade in the open at range: they get to their post first
          const toPost = this.post ? hyp(this.post.x - pos.x, this.post.z - pos.z) : 0;
          hold = !(s > 0.5 && toPost < 70 && toPost > 8);
        }
      }
    }
    if (this.jitter && goal) goal = { ...goal, x: goal.x + this.jitter.x, z: goal.z + this.jitter.z };
    if (this.escape) {
      if (now > this.escape.until || hyp(this.escape.x - pos.x, this.escape.z - pos.z) < 6) { this.escape = null; this.goalKey = ''; }
      else { goal = this.escape; hold = false; mode = 'escape'; }
    }
    this.mode = mode; this.hold = hold;
    if (goal) {
      const key = mode + ':' + Math.round(goal.x / 10) + ',' + Math.round(goal.z / 10);
      if (key !== this.goalKey && (!this.goal || this.goalKey === '' || hyp(goal.x - this.goal.x, goal.z - this.goal.z) > 12)) {
        this.goalKey = key; this.needPlan = true; this.arrived = false;
        if (this.log) { this.log.push(now.toFixed(0) + ':' + key); if (this.log.length > 12) this.log.shift(); }
      }
      this.goal = goal;
    }
  }
  jitterGoal(x, z, r, key) {
    // a stable per-bot offset around shared goals (bases, hunted enemies) so they don't stack
    if (!this._jg || this._jgKey !== key) { const a = this.rng() * TAU, d = r * (0.3 + 0.7 * this.rng()); this._jg = { x: Math.cos(a) * d, z: Math.sin(a) * d }; this._jgKey = key; }
    const q = snapPassable(this.team.info.nav, x + this._jg.x, z + this._jg.z);
    return { x: q.x, z: q.z, geo: this.post ? this.post.geo : 0 };
  }

  // ------------------------------------------------------------------ driving
  drive(world) {
    const t = this.t, c = this.c, T = this.team;
    c.brake = false;
    if (this.reverseT > 0) {             // unsticking: back off and turn
      this.reverseT -= DT;
      c.throttle = -1; c.steer = this.revSteer; this.wantMove = true;
      if (this.reverseT <= 0) this.needPlan = true;
      return;
    }
    const goal = this.goal;
    if (!goal || this.hold || this.arrived) { this.holdStill(world); return; }
    if (this.needPlan && planBudget(world)) {
      const r = plan(T.planNav(this.dangerW), T.navS, t.pos.x, t.pos.z, goal.x, goal.z);
      this.stats.plans++;
      if (r) { this.follow.set(r.pts); T.notePath(r.raw); this.needPlan = false; this.planFail = 0; this.lastRemain = Infinity; }
      else { this.follow.set([{ x: t.pos.x, z: t.pos.z }, { x: goal.x, z: goal.z }]); this.needPlan = false; if (++this.planFail > 2) this.jitter = { x: (this.rng() - 0.5) * 40, z: (this.rng() - 0.5) * 40 }; }
    }
    const spd = Math.abs(t.speed);
    const car = this.follow.carrot(t.pos.x, t.pos.z, CRUISE_LOOK + spd * 0.8, this.carrot);
    const tx = car ? car.x : goal.x, tz = car ? car.z : goal.z;
    const remain = car ? car.remain + hyp(tx - t.pos.x, tz - t.pos.z) : hyp(goal.x - t.pos.x, goal.z - t.pos.z);
    const dg = hyp(goal.x - t.pos.x, goal.z - t.pos.z);
    // arrived: close to the goal, or near it and repeatedly blocked (goal hugging a wall)
    if (remain < 6 || dg < 7 || (dg < 22 && this.unsticks.length >= 2)) {
      this.arrived = true; this.holdStill(world); return;
    }
    this.wantMove = true; this.peek = 0;
    this.steerTo(tx, tz, Math.min(1, 0.3 + remain / 30));
    this.intent = this.pivoting ? 0 : Math.abs(c.throttle);  // what we meant before avoidance
    if (!this.pivoting) this.avoid(world);
    this.unstick(world, remain);
  }

  steerTo(x, z, maxTh) {
    const t = this.t, c = this.c;
    this.pivoting = false;
    const want = headingTo(t.pos.x, t.pos.z, x, z), diff = wrap(want - t.yaw), d = hyp(x - t.pos.x, z - t.pos.z);
    const ad = Math.abs(diff);
    if (ad > 2.4 && d < 25) {                 // just behind us: reverse onto it
      const d2 = wrap(want + Math.PI - t.yaw);
      c.steer = clamp(-d2 * 2.5, -1, 1); c.throttle = -0.8;
    } else if (ad > 0.85) {                   // pivot
      c.steer = diff > 0 ? -1 : 1; c.throttle = t.speed > 3 ? 0 : 0.12; this.pivoting = true; return;
    } else {
      c.steer = clamp(-diff * 2.8, -1, 1);
      c.throttle = maxTh * (1 - ad * 0.55);
    }
  }

  // Friendly tanks and wrecks ahead: steer round them and slow down.
  avoid(world) {
    const t = this.t, c = this.c;
    if (c.throttle <= 0) return;
    const fx = Math.sin(t.yaw), fz = Math.cos(t.yaw), lx = fz, lz = -fx;
    let adj = 0, mul = 1;
    for (const o of world.tanks) {
      if (o === t || (o.alive && o.team !== t.team)) continue;
      const dx = o.pos.x - t.pos.x, dz = o.pos.z - t.pos.z;
      if (dx * dx + dz * dz > 400) continue;
      const f = dx * fx + dz * fz, l = dx * lx + dz * lz;
      if (f <= 0 || f > 18 || Math.abs(l) > 5) continue;
      const w = (1 - f / 18) * (1 - Math.abs(l) / 5);
      const side = Math.abs(l) < 0.4 ? (t.id > o.id ? 1 : -1) : Math.sign(l);
      const still = !o.alive || Math.abs(o.speed) < 0.5;
      adj += side * w * (still ? 3.5 : 2);      // obstacle on our left (+l) → steer right (+)
      if (f < 9 && Math.abs(l) < 3.2) {
        const sameWay = o.alive && Math.abs(o.speed) > 1.5 && Math.cos(o.yaw - t.yaw) > 0.5;
        mul = Math.min(mul, sameWay ? 0.55 : 0.3);
      }
    }
    if (adj) c.steer = clamp(c.steer + adj, -1, 1);
    c.throttle *= mul;
  }

  // Unstick: no progress while trying to drive → reverse, turn, mark the spot and replan.
  unstick(world, remain) {
    const t = this.t, c = this.c, T = this.team, now = world.time;
    // Progress = the remaining route length shrinking. Checked over 2 s windows in which we
    // really tried to drive (pivots and avoidance slow-downs still count as trying).
    this.progT += DT;
    if (this.intent > 0.3 || this.pivoting) this.pushT += DT;
    if (this.progT < 2) return;
    const gained = this.lastRemain - remain, tried = this.pushT > 1.4, turned = Math.abs(wrap(t.yaw - this.progYaw));
    this.progT = 0; this.pushT = 0; this.lastRemain = remain; this.progYaw = t.yaw;
    if (!tried || gained > 1.5 || (this.pivoting && turned > 0.15)) { this.stall = 0; return; }
    if (++this.stall < 2) return;          // two windows (4 s) without progress
    this.stall = 0; this.stats.unsticks++;
    this.unsticks.push(now);
    while (this.unsticks.length && now - this.unsticks[0] > 45) this.unsticks.shift();
    const n = this.unsticks.length;
    this.reverseT = 1.1 + this.rng() * 0.9;
    this.revSteer = (this.rng() < 0.5 ? -1 : 1) * (0.4 + this.rng() * 0.6);
    T.noteBlocked(t.pos.x + Math.sin(t.yaw) * 7, t.pos.z + Math.cos(t.yaw) * 7);
    if (this.cover) { this.cover = null; this.coverAt = now; }
    if (n >= 2) this.escape = this.escapePoint(world);             // drive somewhere clear first
    if (n >= 4) { this.jitter = { x: (this.rng() - 0.5) * 50, z: (this.rng() - 0.5) * 50 }; this.goalKey = ''; }
    c.throttle = -1; c.steer = this.revSteer;
  }
  // A clear spot ~12–24 m away (straight line drivable, no tank or wreck near it), preferring
  // directions away from where we were facing and towards the goal.
  escapePoint(world) {
    const t = this.t, nav = this.team.navS, fx = Math.sin(t.yaw), fz = Math.cos(t.yaw), g = this.goal;
    const gd = g ? hyp(g.x - t.pos.x, g.z - t.pos.z) || 1 : 1;
    let best = null, bs = -Infinity;
    for (let i = 0; i < 16; i++) {
      const a = i * TAU / 16, r = i % 2 ? 14 : 24, dx = Math.sin(a), dz = Math.cos(a);
      const x = t.pos.x + dx * r, z = t.pos.z + dz * r;
      if (!passable(nav, x, z, 2.2) || !segClear(nav, t.pos.x, t.pos.z, x, z)) continue;
      let near = false;
      for (const o of world.tanks) if (o !== t && hyp(o.pos.x - x, o.pos.z - z) < 7) { near = true; break; }
      if (near) continue;
      const sc = -(dx * fx + dz * fz) * 0.6 + (g ? (dx * (g.x - t.pos.x) + dz * (g.z - t.pos.z)) / gd : 0) + this.rng() * 0.4;
      if (sc > bs) { bs = sc; best = { x, z, until: world.time + 12 }; }
    }
    return best;
  }

  // A spot within ~40 m that no enemy currently shooting at us can see (closest ring first,
  // preferring spots away from them). null when there is none or no known threat.
  findCover(world) {
    const t = this.t, map = world.map, nav = this.team.navS;
    const th = this.enemies.filter((x) => x.los && x.d < 450).sort((a, b) => a.d - b.d).slice(0, 3);
    if (!th.length) return null;
    const eyes = th.map((x) => ({ x: x.e.pos.x, y: x.e.pos.y + x.e.cy * 1.6, z: x.e.pos.z }));
    let ax = 0, az = 0;
    for (const e of eyes) { const d = hyp(e.x - t.pos.x, e.z - t.pos.z) || 1; ax += (e.x - t.pos.x) / d; az += (e.z - t.pos.z) / d; }
    const top = t.def.hull.clr + t.def.hull.H + t.def.turret.H * 0.8, B = {};
    const a0 = this.rng() * TAU;
    for (const r of [10, 18, 28, 40]) {
      let best = null, bs = -Infinity;
      for (let i = 0; i < 10; i++) {
        const a = a0 + i * TAU / 10, px = t.pos.x + Math.cos(a) * r, pz = t.pos.z + Math.sin(a) * r;
        if (!passable(nav, px, pz, 2.2)) continue;
        B.x = px; B.z = pz; B.y = heightAt(map, px, pz) + top;
        let hidden = true;
        for (const E of eyes) if (lineClear(map, E, B)) { hidden = false; break; }
        if (!hidden) continue;
        const sc = -((px - t.pos.x) * ax + (pz - t.pos.z) * az) / r;
        if (sc > bs) { bs = sc; best = { x: px, z: pz }; }
      }
      if (best) return best;
    }
    return null;
  }

  // Would backing up `dist` metres hide us from the enemies that can see us now?
  coverBehind(world, dist) {
    const t = this.t, map = world.map, fx = Math.sin(t.yaw), fz = Math.cos(t.yaw);
    const bx = t.pos.x - fx * dist, bz = t.pos.z - fz * dist;
    if (!passable(this.team.navS, bx, bz)) return false;
    const top = t.def.hull.clr + t.def.hull.H + t.def.turret.H * 0.8;
    const B = { x: bx, y: heightAt(map, bx, bz) + top, z: bz };
    let n = 0;
    for (const x of this.enemies) {
      if (!x.los || x.d > 450) continue;
      const E = { x: x.e.pos.x, y: x.e.pos.y + x.e.cy * 1.6, z: x.e.pos.z };
      if (lineClear(map, E, B)) return false;
      if (++n >= 4) break;
    }
    return n > 0 || world.time - this.lastHitT < 2;
  }

  // Standing: face the threat (angled for armoured tanks), peek on long reloads.
  holdStill(world) {
    const t = this.t, c = this.c, now = world.time;
    this.wantMove = false; this.progT = 0; this.pushT = 0; this.stall = 0; this.lastRemain = Infinity;
    c.throttle = 0; c.steer = 0; c.brake = true;
    // peek-a-boo: back off behind cover after a shot on a long reload (come back when nearly
    // loaded), or duck out when over-exposed (come back after the duck timer)
    if (this.peek || (this.hold && this.target) || now < this.duckUntil) {
      const R = t.gunDef.reload;
      if (this.peek === 0) {
        if (this.peeker && t.reload > R * 0.6 && now - t.lastShot < 0.6 && t.spotted && this.coverBehind(world, 8)) { this.peek = 1; this.peekWhy = 'reload'; }
        else if (now < this.duckUntil) { this.peek = 1; this.peekWhy = 'duck'; }
        if (this.peek) { this.peekT = 0; this.peekDur = 1.3 + this.rng() * 0.8; }
      }
      if (this.peek === 1) { this.peekT += DT; c.throttle = -1; c.brake = false; if (this.peekT >= this.peekDur) this.peek = 2; return; }
      if (this.peek === 2) {
        const back = this.peekWhy === 'reload' ? t.reload < this.peekDur + 0.5 : now >= this.duckUntil && t.reload <= this.peekDur;
        if (back) { this.peek = 3; this.peekT = 0; }
        return;
      }
      if (this.peek === 3) { this.peekT += DT; c.throttle = 1; c.brake = false; if (this.peekT >= this.peekDur * 0.9) this.peek = 0; return; }
    }
    // facing
    let want = null;
    const tg = this.target;
    if (tg && this.targetLos) want = headingTo(t.pos.x, t.pos.z, tg.pos.x, tg.pos.z);
    else if (now - this.lastHitT < 6 && this.hitDir != null) want = this.hitDir;
    else if (this.post && this.arrived) want = this.post.yaw;
    if (want == null) return;
    const casemate = t.def.turret.shape === 'casemate';
    if (casemate && tg) return;                        // the sim swings the hull for the gun
    let tol = 0.35;
    if (tg || now - this.lastHitT < 6) {
      if (this.angleArmor) { want += this.angleSide * this.angleArmor; tol = 0.12; }
      else tol = casemate ? 0.12 : 0.6;
    }
    const diff = wrap(want - t.yaw);
    // turning blooms the aim: skilled bots only turn while reloading unless badly off
    if (Math.abs(diff) > tol && (Math.abs(diff) > 0.8 || t.reload > 0.8 || this.skill < 0.5)) c.steer = clamp(-diff * 3, -1, 1);
  }

  // ------------------------------------------------------------------ gunnery
  gun(world) {
    const t = this.t, c = this.c, now = world.time, tg = this.target;
    // keep the shell we want only when switching is cheap (just fired / empty)
    const want = this.wantShell != null ? this.wantShell : t.shell;
    c.shell = want !== t.shell && t.ammo[want] > 0 && (t.reload > t.gunDef.reload * 0.55 || t.ammo[t.shell] <= 0) ? want : t.shell;
    if (t.ammo[c.shell] <= 0) { const alt = t.ammo.findIndex((n) => n > 0); if (alt >= 0) c.shell = alt; }
    if (t.reload > 0) this.readyAt = now + t.reload;
    const vis = world.visible[t.team];
    if (tg && tg.alive && vis.has(tg.id) && this.aimPt) {
      if (now - this.aimAt > 0.6) this.pickAim(world);
      if (!this.aimPt) { this.lookAround(world); return; }
      const d = hyp(tg.pos.x - t.pos.x, tg.pos.z - t.pos.z);
      const p = candWorld(tg, this.aimPt.cand, this._aim);
      // lead: shell flight time × target velocity × how well this bot leads
      const sh = t.gunDef.shells[c.shell] || t.gunDef.shells[0];
      const tof = d / (sh.v * 0.8);
      p.x += Math.sin(tg.yaw) * tg.speed * tof * this.leadK;
      p.z += Math.cos(tg.yaw) * tg.speed * tof * this.leadK;
      // personal aim error: shrinks as the bot tracks the same target
      if (now - this.errAt > 2.5) this.rollErr(now);
      const e = this.curErr = this.aimErrBase * clamp(d / 200, 0.4, 2) * (this.errFloor + (1 - this.errFloor) * Math.exp(-(now - this.aimSince) / 1.8));
      p.x += this.err.x * e; p.y += this.err.y * e; p.z += this.err.z * e;
      c.aim = p; c.lockGun = false;
      this.maybeFire(world, tg, p, d);
    } else this.lookAround(world);
  }

  lookAround(world) {
    const t = this.t, c = this.c, now = world.time, T = this.team;
    let h = null, far = 150;
    if (now - this.lastHitT < 6 && this.hitDir != null) h = this.hitDir;
    else {
      const k = T.nearestKnown(t.pos.x, t.pos.z, 25, now, 500);
      if (k) { h = headingTo(t.pos.x, t.pos.z, k.x, k.z); far = Math.max(30, k.d); }
      else if (this.post && (this.arrived || this.hold)) h = this.post.yaw;
      else h = t.yaw;
    }
    const x = clamp(t.pos.x + Math.sin(h) * far, 5, world.map.size - 5), z = clamp(t.pos.z + Math.cos(h) * far, 5, world.map.size - 5);
    const a = this._aim; a.x = x; a.z = z; a.y = heightAt(world.map, x, z) + 2;
    c.aim = a; c.lockGun = false;
  }

  maybeFire(world, tg, p, d) {
    const t = this.t, c = this.c, now = world.time, s = this.skill;
    if (t.reload > 0 || now < this.nextShot || t.ammo[t.shell] <= 0 || c.shell !== t.shell) return;
    // lights on passive spotting duty hold fire unless it's close, a kill, or late game
    if (this.cls === 'light' && this.scoutPhase > 0 && this.team.push < 1 && d > 200 && tg.hp > alphaOf(t) * 1.1 && now - this.lastHitT > 5) return;
    if (d > FIRE_RANGE[this.cls] * (1 + 0.25 * (1 - s)) && now - this.lastHitT > 4) return;
    // opening discipline: unspotted non-TDs keep their camo at range early on (potatoes don't)
    if (now < this.openingT && !t.spotted && s >= 0.3 && this.cls !== 'td' && d > 220 && tg.hp > alphaOf(t) && now - this.lastHitT > 4) return;
    const sol = aimSolution(world, t, p, _sol);
    if (!sol.reachable) return;
    const angErr = Math.abs(wrap(sol.yaw - t.turretYaw)) + Math.abs(sol.pitch - t.gunPitch);
    const Rd = t.disp * d / 100;
    const laid = angErr * d < 0.35 + 0.4 * Rd;
    if (!laid) { this.laidSince = -1; return; }
    if (this.laidSince < 0) this.laidSince = now;
    // When to pull the trigger: optimal stopping for hits per second. Waiting another 0.3 s buys
    // (pNext − pNow); a shot costs a whole cycle (reload + time spent waiting). Fire when the
    // marginal gain × cycle drops below pNow / patienceK (skilled ≈ optimal, potatoes trigger-happy).
    // Also fire when patience runs out, or the target is about to vanish.
    const size = 1.2;                   // ~ the tank's half-size: hits anywhere count
    const tau = t.gunDef.aim / (0.85 + 0.15 * (t.crewSkill ?? 1));
    const Rnext = (t.dispTarget + (t.disp - t.dispTarget) * Math.exp(-0.3 / tau)) * d / 100;
    const pNow = pHit(size, Rd, this.curErr), pNext = pHit(size, Rnext, this.curErr), pFull = pHit(size, t.dispTarget * d / 100, this.curErr);
    const cycle = t.gunDef.reload + Math.max(0, now - Math.max(this.readyAt, this.aimSince));
    const waited = now - this.laidSince >= this.patience * t.gunDef.aim;
    // leaving: the team is about to lose sight of it (last sighting ageing), or it's moving fast
    const leaving = now - tg.lastSeen[t.team] > 1.4 || (Math.abs(tg.speed) > 5 && s > 0.4);
    // skilled bots don't waste shots (and camo) on hopeless long-range pokes
    if (s > 0.5 && pFull * Math.max(0.05, this.aimPt.chance) < 0.12 * s && !leaving && now - this.lastHitT > 3) return;
    const ready = (pNext - pNow) / 0.3 * cycle * this.patienceK <= pNow;
    if (!(ready || waited || (leaving && pNow >= 0.5 * pFull))) return;
    // don't shoot friends or into a wall
    if (now < this.checkAt) return;
    this.checkAt = now + 0.08;
    const hit = predictImpact(world, t);
    if (hit.targetId) {
      const o = world.byId[hit.targetId];
      if (o && o.team === t.team && o.alive) return;
    } else if (hit.dist < d - 10 && s > 0.2) return;
    c.fire = true;
    this.nextShot = now + 0.2;
    if (c.shell === this.slots.gold) this.goldUsed++;
    this.rollErr(now); this.aimSince = now; this.laidSince = -1;
    // next shell choice happens on the next pickAim; rechoose now if we were on gold / HE
    if (this.aimPt) this.wantShell = chooseShell(this, tg, this.aimPt, d);
  }

  // ------------------------------------------------------------------ consumables
  consume(world) {
    const t = this.t, c = this.c, now = world.time, s = this.skill;
    const ready = (k) => t.consumables.some((x) => x.kind === k && x.ready);
    const delay = 0.4 + 2.5 * (1 - s) ** 1.5;
    const due = (key, cond) => {
      if (!cond) { delete this.useAt[key]; return false; }
      if (this.useAt[key] == null) this.useAt[key] = now + delay * (0.6 + 0.8 * this.rng());
      return now >= this.useAt[key];
    };
    if (due('fire', !!t.fire) && ready('extinguisher')) { c.use = 'extinguisher'; return; }
    const m = t.modules;
    const tracks = m.trackL.state === 'destroyed' || m.trackR.state === 'destroyed';
    const underFire = now - this.lastHitT < 5 || this.enemies.some((x) => x.los && x.d < 300);
    const bad = (tracks && underFire && s > 0.2) || m.engine.state === 'destroyed' || (m.gun.state === 'destroyed' && this.target)
      || (m.ammoRack.state !== 'ok' && s > 0.7 && this.target);
    if (due('repair', bad) && ready('repair')) { c.use = 'repair'; return; }
    const crewDown = ['gunner', 'driver', 'loader', 'commander'].some((r) => t.crew[r] && !t.crew[r].alive);
    if (due('medkit', crewDown) && ready('medkit')) c.use = 'medkit';
  }
}

// Pen chance at the hull centre (cheap target-scoring estimate).
const _qp = {};
function quickPen(world, t, e) {
  const h = e.def.hull;
  hullToWorld(e, 0, h.clr + h.H * 0.55, 0, _qp);
  const pv = penPreview(world, t, _qp, e.id);
  return pv ? pv.chance : 0;
}
export { chanceWith };
