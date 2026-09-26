// Aim ray: from the camera through the screen centre against terrain, water, solid props and
// tanks (bounding sphere, refined with the sim's armour pieces), up to 720 m.
//   aimRay(world, o, d, { skipId, visible, maxT }) → { x, y, z, t, tankId, obj, sky }
// Unspotted enemies are ignored (they aren't drawn, so the reticle must not reveal them).
import { raycastTerrain, raycastObjects, waterDepthAt } from '../sim/map/query.js';
import { rayArmor } from '../sim/tank.js';

export const AIM_RANGE = 720;
const out = { x: 0, y: 0, z: 0, t: 0, tankId: null, obj: null, sky: false };

export function aimRay(world, o, d, { skipId = null, visible = null, maxT = AIM_RANGE, res = out } = {}) {
  const map = world.map;
  let t = maxT, tankId = null, obj = null, sky = true;
  const tt = raycastTerrain(map, o, d, maxT);
  if (tt >= 0 && tt < t) { t = tt; sky = false; }
  // water surface (the renderer draws it; shells burst on it)
  if (map.water && d.y < 0 && o.y > map.water.level) {
    const tw = (o.y - map.water.level) / -d.y;
    if (tw < t && waterDepthAt(map, o.x + d.x * tw, o.z + d.z * tw) > 0) { t = tw; sky = false; }
  }
  const ob = raycastObjects(map, o, d, t, 'shell');
  if (ob && ob.t < t) { t = ob.t; obj = ob.obj; sky = false; }
  for (const k of world.tanks) {
    if (k.id === skipId) continue;
    if (visible && k.alive && !visible.has(k.id)) continue;
    const cx = k.pos.x - o.x, cy = k.pos.y + k.cy - o.y, cz = k.pos.z - o.z;
    const along = cx * d.x + cy * d.y + cz * d.z;
    if (along < -k.rad || along > t + k.rad) continue;
    const px = cx - d.x * along, py = cy - d.y * along, pz = cz - d.z * along;
    if (px * px + py * py + pz * pz > k.rad * k.rad) continue;
    const hits = rayArmor(k, o.x, o.y, o.z, d.x, d.y, d.z, t);
    if (hits.length && hits[0].t < t) { t = hits[0].t; tankId = k.id; obj = null; sky = false; }
  }
  res.t = t; res.x = o.x + d.x * t; res.y = o.y + d.y * t; res.z = o.z + d.z * t;
  res.tankId = tankId; res.obj = obj; res.sky = sky;
  return res;
}

// Centre of mass of a tank (world): the hull centre raised to half the tank's height.
export function centreOf(t, outP = {}) {
  outP.x = t.pos.x; outP.y = t.pos.y + t.cy * 0.8; outP.z = t.pos.z;
  return outP;
}
