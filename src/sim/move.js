// Tank movement on terrain: power-to-weight, ground resistance, slopes, hull traverse,
// terrain following, props (crush or block), deep water, map bounds, tank–tank collisions.
import { heightAt, groundAt, waterDepthAt, resolveCircle, clampToBounds, OBJECT_KINDS, breakObject } from './map/query.js';
import { GROUND_CLASS } from './map/objects.js';
import { updateRot } from './tank.js';
import { crewOk, dealDamage } from './damage.js';

const DEG = Math.PI / 180, G = 9.81;
const ROLL_RES = 0.05;       // rolling resistance coefficient per unit of def.terrain
const TRACTION = 0.65;       // max drive acceleration, g
const MAX_WADE = 1.3;        // deeper water blocks (m)
const RAM_KMH = 15;          // ram damage above this closing speed

// Ground resistance at (x, z) for a tank def (Infinity = impassable).
export function resistanceAt(map, def, x, z) {
  if (waterDepthAt(map, x, z) > MAX_WADE) return Infinity;
  const c = GROUND_CLASS[groundAt(map, x, z)];
  return c === Infinity ? Infinity : def.terrain[c ?? 1];
}

// Mobility factors from engine, driver, commander, tracks.
function mobility(t) {
  const e = t.modules.engine.state;
  const drv = crewOk(t, 'driver') ? 1 : 0.8, cmd = crewOk(t, 'commander') ? 1 : 0.92;
  const tracks = t.modules.trackL.state !== 'destroyed' && t.modules.trackR.state !== 'destroyed';
  const eng = e === 'destroyed' ? 0 : e === 'damaged' ? 0.55 : 1;
  return { power: eng * drv * cmd, top: (e === 'damaged' ? 0.8 : 1) * (drv < 1 ? 0.9 : 1), turn: drv * cmd, mobile: tracks && eng > 0 };
}

export function moveTank(world, t, c, dt) {
  const def = t.def, map = world.map, h = def.hull;
  const m = t.alive ? mobility(t) : { power: 0, top: 0, turn: 0, mobile: false };
  const fx = Math.sin(t.yaw), fz = Math.cos(t.yaw);
  const res = Math.min(4, resistanceAt(map, def, t.pos.x, t.pos.z));
  const vF = def.speed / 3.6 * m.top, vR = def.reverse / 3.6 * m.top;
  let th = m.mobile ? Math.max(-1, Math.min(1, c.throttle || 0)) : 0;
  let v = t.speed;
  const P = def.power * 745.7 * m.power, mass = def.mass * 1000;
  const slopeA = G * Math.sin(t.pitch) * Math.cos(t.roll);   // pitch > 0 nose up: pulls backwards
  const rollA = ROLL_RES * res * G;
  if (c.brake || th === 0) {
    // engine braking / brakes, holding on slopes
    const dec = (c.brake ? 7 : 2.2) + rollA;
    const a = -slopeA;
    v += a * dt;
    v = Math.abs(v) <= dec * dt ? 0 : v - Math.sign(v) * dec * dt;
    if (Math.abs(slopeA) < dec && Math.abs(v) < 0.05) v = 0;
  } else {
    const dir = Math.sign(th);
    let a;
    if (v * dir < -0.1) a = dir * 7; // reversing direction: brake first
    else a = dir * Math.min(TRACTION * G, P / (mass * Math.max(1, Math.abs(v)))) * Math.abs(th);
    a -= slopeA;
    v += a * dt;
    if (Math.abs(v) > 0.01) { const f = rollA * dt; v = Math.abs(v) <= f ? 0 : v - Math.sign(v) * f; }
    const lim = dir > 0 ? vF * Math.abs(th) : vR * Math.abs(th);
    if (dir > 0 && v > lim) v = Math.max(lim, v - 6 * dt);
    if (dir < 0 && v < -lim) v = Math.min(-lim, v + 6 * dt);
  }
  if (!m.mobile && Math.abs(v) > 0) v = Math.sign(v) * Math.max(0, Math.abs(v) - 8 * dt);
  // Hull traverse (steer +1 = turn right = yaw decreasing). Slower on soft ground and at speed.
  let steer = Math.max(-1, Math.min(1, c.steer || 0));
  if (Math.abs(steer) < 0.05 && t._autoSteer) steer = t._autoSteer;
  const rate = (m.mobile ? def.hullTraverse * DEG * m.turn : 0) * Math.pow(def.terrain[0] / res, 0.6) * (1 - 0.3 * Math.min(1, Math.abs(v) / Math.max(1, vF)));
  const want = -steer * rate;
  const dr = rate * 5 * dt + 1e-4;
  t.yawRate += Math.max(-dr, Math.min(dr, want - t.yawRate));
  if (!m.mobile) t.yawRate = 0;
  t.yaw += t.yawRate * dt;
  if (t.yawRate && Math.abs(v) > 0.5) v *= 1 - 0.15 * Math.abs(t.yawRate) / Math.max(rate, 1e-3) * dt;
  t.speed = v;
  // Translate, then check water / impassable ground at the leading edge.
  const ox = t.pos.x, oz = t.pos.z;
  const step = v * dt * Math.cos(t.pitch);
  if (step !== 0) {
    let nx = ox + fx * step, nz = oz + fz * step;
    const lead = Math.sign(step) * h.L * 0.5;
    if (resistanceAt(map, def, nx + fx * lead, nz + fz * lead) === Infinity) { nx = ox; nz = oz; t.speed = 0; }
    t.pos.x = nx; t.pos.z = nz;
  }
  if (step !== 0 || t.yawRate !== 0 || t._pushed) { collideProps(world, t); t._pushed = false; }
  clampToBounds(map, t.pos, 4);
  settle(map, t, dt);
}

// Terrain following: height and pitch/roll from four samples under the tracks.
export function settle(map, t, dt = 1) {
  const h = t.def.hull, fx = Math.sin(t.yaw), fz = Math.cos(t.yaw), lx = fz, lz = -fx; // left = (cos, 0, −sin)
  const a = h.L * 0.42, b = h.W / 2 + h.track.w / 2, x = t.pos.x, z = t.pos.z;
  const hF = heightAt(map, x + fx * a, z + fz * a), hB = heightAt(map, x - fx * a, z - fz * a);
  const hL = heightAt(map, x + lx * b, z + lz * b), hR = heightAt(map, x - lx * b, z - lz * b);
  const hC = heightAt(map, x, z);
  const pitch = Math.atan2(hF - hB, 2 * a), roll = Math.atan2(hL - hR, 2 * b);
  const k = Math.min(1, dt * 10);
  t.pitch += (pitch - t.pitch) * k; t.roll += (roll - t.roll) * k;
  t.pos.y = Math.max((hF + hB + hL + hR) / 4, hC - 0.12);
  updateRot(t);
}

// Props: crush what this tank can crush (trees, fences, sheds…), be pushed out of the rest.
function collideProps(world, t) {
  const map = world.map, def = t.def, h = def.hull;
  if (!t._blockF) {
    const mass = def.mass;
    t._crushF = (o, k) => k.solidTank && k.breakable === 'crush' && mass >= k.crushMass;
    t._blockF = (o, k) => k.solidTank && !(k.breakable === 'crush' && mass >= k.crushMass);
  }
  const r = h.W / 2 + h.track.w, off = Math.max(0, h.L / 2 - r);
  const fx = Math.sin(t.yaw), fz = Math.cos(t.yaw);
  for (let i = -1; i <= 1; i++) {
    const cx = t.pos.x + fx * off * i, cz = t.pos.z + fz * off * i;
    if (Math.abs(t.speed) > 0.3) {
      const cr = resolveCircle(map, cx, cz, r * 0.9, t._crushF);
      for (const o of cr.hits) if (breakObject(map, o, fx * Math.sign(t.speed), fz * Math.sign(t.speed))) {
        world.events.push({ type: 'treeFall', obj: o, dir: o.fallDir ?? t.yaw, tank: t.id });
        t.speed *= OBJECT_KINDS[o.kind].crushMass ? 0.6 : 0.92;
      }
    }
    const rc = resolveCircle(map, cx, cz, r, t._blockF);
    const px = rc.x - cx, pz = rc.z - cz;
    if (px || pz) {
      t.pos.x += px; t.pos.z += pz;
      const into = (px * fx + pz * fz) * Math.sign(t.speed);
      if (into < 0) t.speed *= 0.5; // driving into a wall
    }
  }
}

// Tank–tank collisions: three circles per tank, push apart by mass, inelastic impulse along
// the contact normal, ram damage above 15 km/h closing speed (enemies only).
export function collideTanks(world, dt) {
  const T = world.tanks, n = T.length;
  for (let i = 0; i < n; i++) {
    const A = T[i], ha = A.def.hull, ra = ha.W / 2 + ha.track.w, La = Math.max(0, ha.L / 2 - ra);
    for (let j = i + 1; j < n; j++) {
      const B = T[j];
      const dx0 = B.pos.x - A.pos.x, dz0 = B.pos.z - A.pos.z, R = (ha.L + B.def.hull.L) / 2 + 0.5;
      if (dx0 * dx0 + dz0 * dz0 > R * R || Math.abs(B.pos.y - A.pos.y) > 4) continue;
      const hb = B.def.hull, rb = hb.W / 2 + hb.track.w, Lb = Math.max(0, hb.L / 2 - rb);
      const afx = Math.sin(A.yaw), afz = Math.cos(A.yaw), bfx = Math.sin(B.yaw), bfz = Math.cos(B.yaw);
      // deepest overlapping circle pair
      let best = 0, nx = 0, nz = 0;
      for (let p = -1; p <= 1; p++) for (let q = -1; q <= 1; q++) {
        const dx = B.pos.x + bfx * Lb * q - (A.pos.x + afx * La * p), dz = B.pos.z + bfz * Lb * q - (A.pos.z + afz * La * p);
        const d = Math.hypot(dx, dz), pen = ra + rb - d;
        if (pen > best) { best = pen; nx = d > 1e-6 ? dx / d : 1; nz = d > 1e-6 ? dz / d : 0; }
      }
      if (best <= 0) continue;
      const ma = A.def.mass * (A.alive ? 1 : 3), mb = B.def.mass * (B.alive ? 1 : 3), mt = ma + mb;
      A.pos.x -= nx * best * mb / mt; A.pos.z -= nz * best * mb / mt;
      B.pos.x += nx * best * ma / mt; B.pos.z += nz * best * ma / mt;
      A._pushed = B._pushed = true;
      const vax = afx * A.speed, vaz = afz * A.speed, vbx = bfx * B.speed, vbz = bfz * B.speed;
      const close = (vax - vbx) * nx + (vaz - vbz) * nz; // > 0: approaching
      if (close <= 0) continue;
      // Ram damage (once per contact).
      const key = A.id * 1000 + B.id, last = world._rams.get(key) ?? -9;
      if (close * 3.6 > RAM_KMH && world.time - last > 1 && A.team !== B.team && A.alive && B.alive) {
        const mu = ma * mb / mt, base = (close * 3.6 - RAM_KMH) * mu * 0.35;
        // the faster tank is the rammer
        const aFast = Math.abs(A.speed) >= Math.abs(B.speed);
        const toB = Math.round(base * 2 * ma / mt), toA = Math.round(base * 2 * mb / mt * 0.5);
        const [ram, vic, dV, dR] = aFast ? [A, B, toB, toA] : [B, A, toA, toB];
        const ev = { type: 'ram', a: ram.id, b: vic.id, dmg: 0, selfDmg: 0 };
        world.events.push(ev);
        ev.dmg = dealDamage(world, vic, dV, ram.id, 'ram', null);
        ev.selfDmg = dealDamage(world, ram, dR, vic.id, 'ram', null);
      }
      world._rams.set(key, world.time);
      // inelastic impulse (restitution 0.1), projected back onto each hull's forward axis
      const imp = close * 1.1 / (1 / ma + 1 / mb);
      A.speed = (vax - imp / ma * nx) * afx + (vaz - imp / ma * nz) * afz;
      B.speed = (vbx + imp / mb * nx) * bfx + (vbz + imp / mb * nz) * bfz;
    }
  }
}
