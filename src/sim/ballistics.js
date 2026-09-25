// Shell flight: gravity, segment tests against terrain, water, solid props and tanks.
import { raycastTerrain, raycastObjects, groundAt, waterDepthAt, normalAt, breakObject, OBJECT_KINDS } from './map/query.js';
import { GROUND_NAMES } from './map/objects.js';
import { rayArmor } from './tank.js';
import { shellHitsTank, splash } from './damage.js';

const G = 9.81, MAX_RANGE = 720;
const _o = {}, _d = {}, _n = {};

// Earliest tank entry along a segment (o, unit d, length L): { tank, t } or null.
function firstTank(world, o, d, L, skipId) {
  let best = null, bt = L;
  for (const t of world.tanks) {
    if (t.id === skipId) continue;
    // segment vs bounding sphere around the hull centre
    const cx = t.pos.x - o.x, cy = t.pos.y + t.cy - o.y, cz = t.pos.z - o.z;
    const along = cx * d.x + cy * d.y + cz * d.z;
    if (along < -t.rad || along > bt + t.rad) continue;
    const px = cx - d.x * along, py = cy - d.y * along, pz = cz - d.z * along;
    if (px * px + py * py + pz * pz > t.rad * t.rad) continue;
    const hits = rayArmor(t, o.x, o.y, o.z, d.x, d.y, d.z, bt);
    if (hits.length && hits[0].t < bt) { bt = hits[0].t; best = t; }
  }
  return best ? { tank: best, t: bt } : null;
}

// Water surface crossing on the segment (only where there is water under it): t or -1.
function waterHit(map, o, d, L) {
  if (!map.water || d.y >= 0) return -1;
  const lv = map.water.level;
  if (o.y < lv || o.y + d.y * L > lv) return -1;
  const t = (o.y - lv) / -d.y;
  return waterDepthAt(map, o.x + d.x * t, o.z + d.z * t) > 0 ? t : -1;
}

// One segment test: the earliest of terrain / water / object / tank.
// → { kind: 'terrain'|'water'|'object'|'tank', t, obj?, tank?, nx,ny,nz } | null
function segment(world, o, d, L, skipId) {
  const map = world.map;
  let t = L, kind = null, obj = null, tank = null, nx = 0, ny = 1, nz = 0;
  const tt = raycastTerrain(map, o, d, L);
  if (tt >= 0 && tt < t) { t = tt; kind = 'terrain'; }
  const tw = waterHit(map, o, d, t);
  if (tw >= 0 && tw < t) { t = tw; kind = 'water'; }
  const ob = raycastObjects(map, o, d, t, 'shell');
  if (ob && ob.t < t) { t = ob.t; kind = 'object'; obj = ob.obj; nx = ob.nx; ny = ob.ny; nz = ob.nz; }
  const tk = firstTank(world, o, d, t, skipId);
  if (tk) { t = tk.t; kind = 'tank'; tank = tk.tank; }
  if (!kind) return null;
  if (kind === 'terrain') { normalAt(map, o.x + d.x * t, o.z + d.z * t, _n); nx = _n.x; ny = _n.y; nz = _n.z; }
  return { kind, t, obj, tank, nx, ny, nz };
}

export function stepShells(world, dt) {
  const map = world.map;
  for (const s of world.shells) {
    if (!s.alive) continue;
    const v = s.vel, vy1 = v.y - G * dt;
    const sx = v.x * dt, sy = (v.y + vy1) / 2 * dt, sz = v.z * dt, L = Math.hypot(sx, sy, sz);
    _o.x = s.pos.x; _o.y = s.pos.y; _o.z = s.pos.z; _d.x = sx / L; _d.y = sy / L; _d.z = sz / L;
    // the firing tank is ignored for the first metres; a ricocheting shell ignores that tank once
    const skip = s.dist < 6 ? s.owner : s.ignore;
    s.ignore = 0;
    const h = segment(world, _o, _d, L, skip);
    if (!h) {
      s.pos.x += sx; s.pos.y += sy; s.pos.z += sz; v.y = vy1; s.dist += L;
      if (s.dist > MAX_RANGE || s.pos.y < -200) s.alive = false;
      continue;
    }
    const pos = { x: _o.x + _d.x * h.t, y: _o.y + _d.y * h.t, z: _o.z + _d.z * h.t };
    if (h.kind === 'tank') {
      const r = shellHitsTank(world, s, h.tank, _o.x, _o.y, _o.z, _d.x, _d.y, _d.z, L + 0.01);
      s.dist += h.t;
      if (r && r.reflect && s.ricochets < 2) {
        const sp = Math.hypot(v.x, vy1, v.z);
        s.pos.x = r.reflect.x; s.pos.y = r.reflect.y; s.pos.z = r.reflect.z;
        v.x = r.reflect.dx * sp; v.y = r.reflect.dy * sp; v.z = r.reflect.dz * sp;
        s.ricochets++; s.ignore = h.tank.id;
      } else if (r) s.alive = false;
      else { s.pos.x += sx; s.pos.y += sy; s.pos.z += sz; v.y = vy1; } // grazed the bounding volume only
      continue;
    }
    s.alive = false; s.pos.x = pos.x; s.pos.y = pos.y; s.pos.z = pos.z;
    let surface;
    if (h.kind === 'object') {
      surface = h.obj.kind;
      const k = OBJECT_KINDS[h.obj.kind];
      if (k && k.breakable === 'shoot' && breakObject(map, h.obj, _d.x, _d.z)) world.events.push({ type: 'objectBreak', obj: h.obj });
    } else surface = h.kind === 'water' ? 'water' : GROUND_NAMES[groundAt(map, pos.x, pos.z)] || 'grass';
    world.events.push({ type: 'impact', shell: s.id, pos, normal: { x: h.nx, y: h.ny, z: h.nz }, surface, shellType: s.type, cal: s.cal });
    if (s.type === 'HE') splash(world, s, pos, 0);
  }
  // drop dead shells (in place, keeps order)
  let k = 0;
  for (const s of world.shells) if (s.alive) world.shells[k++] = s;
  world.shells.length = k;
}

// Trace a trajectory without side effects (predictImpact): → { x, y, z, dist, targetId|null }.
export function castShell(world, p0, v0, skipId, step = 1 / 30) {
  const o = { x: p0.x, y: p0.y, z: p0.z }, v = { x: v0.x, y: v0.y, z: v0.z }, d = {};
  let flown = 0;
  while (flown < MAX_RANGE) {
    const vy1 = v.y - G * step;
    const sx = v.x * step, sy = (v.y + vy1) / 2 * step, sz = v.z * step, L = Math.hypot(sx, sy, sz);
    d.x = sx / L; d.y = sy / L; d.z = sz / L;
    const h = segment(world, o, d, L, skipId);
    if (h) {
      const x = o.x + d.x * h.t, y = o.y + d.y * h.t, z = o.z + d.z * h.t;
      return { x, y, z, dist: Math.hypot(x - p0.x, y - p0.y, z - p0.z), targetId: h.kind === 'tank' ? h.tank.id : null };
    }
    o.x += sx; o.y += sy; o.z += sz; v.y = vy1; flown += L;
  }
  return { x: o.x, y: o.y, z: o.z, dist: Math.hypot(o.x - p0.x, o.y - p0.y, o.z - p0.z), targetId: null };
}
