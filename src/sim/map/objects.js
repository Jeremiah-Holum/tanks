// Object kinds, ground enum and the exact collision / foliage shapes of every map prop.
// docs/notes/maps.md documents these shapes for RENDER-WORLD: the mesh must match them.
//
// Conventions (MapObject = { id, kind, x, y, z, yaw, s:[sx,sy,sz], variant, hp? }):
//  - (x, y, z) is the base: y = ground level under the prop (the mesh origin sits there).
//  - yaw rotates about +y exactly like three.js `rotation.y = yaw`. Local +x maps to world
//    (cos yaw, 0, -sin yaw), local +z maps to world (sin yaw, 0, cos yaw).
//  - s = half-extents of the prop's bounding box in its local frame; the prop spans
//    y .. y + 2*sy (rocks are the exception: an ellipsoid centred on y, half buried).
//  - Mutable battle state: obj.fallen (crushed trees, fences…), obj.destroyed (shot to bits),
//    obj.fallDir (yaw of the fall). Fallen/destroyed props neither block nor hide anything.

export const GROUND = { GRASS: 0, DIRT: 1, ROAD: 2, SAND: 3, ROCK: 4, MUD: 5, SHALLOW: 6, DEEP: 7, FIELD: 8, SNOW: 9 };
export const GROUND_NAMES = ['grass', 'dirt', 'road', 'sand', 'rock', 'mud', 'shallow', 'deep', 'field', 'snow'];
// hard / medium / soft class per ground (index into TankDef.terrain), Infinity = impassable
export const GROUND_CLASS = [1, 1, 0, 2, 0, 2, 2, Infinity, 1, 1];

// Part types used by query.js
export const BOX = 0, CYL = 1, ELL = 2, GABLE = 3;

// solidShell: blocks shells and sight lines. solidTank: blocks tanks (until fallen/destroyed).
// breakable: 'crush' (falls when rammed by a tank of at least crushMass tonnes), 'shoot'
// (destroyed by any shell hit), or null. foliage: camo value 0..1 of the foliage volume.
// shape: collision description (see objectParts); navBlock: nav treats the footprint as a wall.
export const OBJECT_KINDS = {
  tree:      { solidShell: false, solidTank: true,  breakable: 'crush', foliage: 0.5,  crushMass: 0,  shape: 'trunk',  navBlock: false, label: 'deciduous tree' },
  pine:      { solidShell: false, solidTank: true,  breakable: 'crush', foliage: 0.45, crushMass: 0,  shape: 'trunk',  navBlock: false, label: 'conifer' },
  bush:      { solidShell: false, solidTank: false, breakable: null,    foliage: 0.5,  crushMass: 0,  shape: 'bush',   navBlock: false, label: 'bush' },
  hedge:     { solidShell: false, solidTank: false, breakable: null,    foliage: 0.6,  crushMass: 0,  shape: 'hedge',  navBlock: false, label: 'hedgerow strip' },
  haystack:  { solidShell: false, solidTank: false, breakable: 'crush', foliage: 0.6,  crushMass: 0,  shape: 'cyl',    navBlock: false, label: 'haystack' },
  rock:      { solidShell: true,  solidTank: true,  breakable: null,    foliage: 0,    crushMass: 0,  shape: 'rock',   navBlock: true,  label: 'boulder' },
  house:     { solidShell: true,  solidTank: true,  breakable: null,    foliage: 0,    crushMass: 0,  shape: 'house',  navBlock: true,  label: 'house' },
  barn:      { solidShell: true,  solidTank: true,  breakable: null,    foliage: 0,    crushMass: 0,  shape: 'house',  navBlock: true,  label: 'barn' },
  shed:      { solidShell: true,  solidTank: true,  breakable: 'crush', foliage: 0,    crushMass: 25, shape: 'house',  navBlock: true,  label: 'wooden shed' },
  church:    { solidShell: true,  solidTank: true,  breakable: null,    foliage: 0,    crushMass: 0,  shape: 'church', navBlock: true,  label: 'church with west tower' },
  station:   { solidShell: true,  solidTank: true,  breakable: null,    foliage: 0,    crushMass: 0,  shape: 'house',  navBlock: true,  label: 'railway station' },
  ruin:      { solidShell: true,  solidTank: true,  breakable: null,    foliage: 0,    crushMass: 0,  shape: 'ruin',   navBlock: true,  label: 'ruined house (L of walls)' },
  wall:      { solidShell: true,  solidTank: true,  breakable: 'crush', foliage: 0,    crushMass: 30, shape: 'box',    navBlock: true,  label: 'stone wall' },
  fence:     { solidShell: false, solidTank: true,  breakable: 'crush', foliage: 0,    crushMass: 0,  shape: 'box',    navBlock: false, label: 'wooden fence' },
  sandbags:  { solidShell: true,  solidTank: true,  breakable: 'crush', foliage: 0,    crushMass: 20, shape: 'box',    navBlock: true,  label: 'sandbag wall' },
  wreck:     { solidShell: true,  solidTank: true,  breakable: null,    foliage: 0,    crushMass: 0,  shape: 'box',    navBlock: true,  label: 'burnt-out tank or truck' },
  logs:      { solidShell: true,  solidTank: true,  breakable: null,    foliage: 0,    crushMass: 0,  shape: 'box',    navBlock: true,  label: 'log pile' },
  tank_trap: { solidShell: false, solidTank: true,  breakable: null,    foliage: 0,    crushMass: 0,  shape: 'cyl',    navBlock: true,  label: 'steel hedgehog' },
  windmill:  { solidShell: true,  solidTank: true,  breakable: null,    foliage: 0,    crushMass: 0,  shape: 'cyl',    navBlock: true,  label: 'windmill tower' },
  silo:      { solidShell: true,  solidTank: true,  breakable: null,    foliage: 0,    crushMass: 0,  shape: 'cyl',    navBlock: true,  label: 'grain silo / water tower' },
  bridge:    { solidShell: true,  solidTank: false, breakable: null,    foliage: 0,    crushMass: 0,  shape: 'box',    navBlock: false, label: 'bridge deck (drivable, see heightAt)' },
  crater:    { solidShell: false, solidTank: false, breakable: null,    foliage: 0,    crushMass: 0,  shape: 'none',   navBlock: false, label: 'shell crater decal' },
};

const mk = (type, obj, lx, cy, lz, hx, hy, hz) => {
  const c = Math.cos(obj.yaw), s = Math.sin(obj.yaw);
  // local (lx, lz) → world offset: lx*(c,-s) + lz*(s,c)
  return { type, obj, cx: obj.x + lx * c + lz * s, cy, cz: obj.z - lx * s + lz * c, c, s, hx, hy, hz };
};

// Collision parts of an object (world space). Part = { type, obj, cx, cy, cz, c, s, hx, hy, hz }:
//  BOX:   centre (cx,cy,cz), half-extents (hx,hy,hz) in the yawed frame
//  CYL:   vertical cylinder, centre (cx,cy,cz), radius hx, half-height hy
//  ELL:   ellipsoid, centre (cx,cy,cz), semi-axes (hx,hy,hz) in the yawed frame
//  GABLE: roof prism, base centre (cx,cy,cz), footprint half (hx,hz), ridge height hy above
//         the base, ridge along local x
export function objectParts(o) {
  const [sx, sy, sz] = o.s, y = o.y;
  switch (OBJECT_KINDS[o.kind]?.shape) {
    case 'trunk': { const r = Math.min(0.5, Math.max(0.15, sx * 0.07)); return [mk(CYL, o, 0, y + sy, 0, r, sy, r)]; }
    case 'rock': return [mk(ELL, o, 0, y, 0, sx, sy, sz)];
    case 'box': return [mk(BOX, o, 0, y + sy, 0, sx, sy, sz)];
    case 'cyl': return [mk(CYL, o, 0, y + sy, 0, sx, sy, sx)];
    case 'house': { const H = 2 * sy, w = 0.6 * H; return [mk(BOX, o, 0, y + w / 2, 0, sx, w / 2, sz), mk(GABLE, o, 0, y + w, 0, sx, H - w, sz)]; }
    case 'church': {
      const tw = sz * 0.75, nl = sx - tw, nH = sy, w = 0.6 * nH;
      return [
        mk(BOX, o, -tw, y + w / 2, 0, nl, w / 2, sz), mk(GABLE, o, -tw, y + w, 0, nl, nH - w, sz),
        mk(BOX, o, sx - tw, y + sy, 0, tw, sy, tw),
      ];
    }
    case 'ruin': return [
      mk(BOX, o, 0, y + sy, -sz + 0.3, sx, sy, 0.3),
      mk(BOX, o, -sx + 0.3, y + sy * 0.75, 0, 0.3, sy * 0.75, sz),
    ];
    default: return [];
  }
}

// Foliage volume (for camo) of an object, or null.
export function foliagePart(o) {
  const [sx, sy, sz] = o.s, y = o.y;
  switch (o.kind) {
    case 'tree': case 'pine': return mk(ELL, o, 0, y + 1.3 * sy, 0, sx, 0.7 * sy, sz);
    case 'bush': return mk(ELL, o, 0, y + sy, 0, sx, sy, sz);
    case 'hedge': return mk(BOX, o, 0, y + sy, 0, sx, sy, sz);
    case 'haystack': return mk(CYL, o, 0, y + sy, 0, sx, sy, sx);
    default: return null;
  }
}

// Horizontal bounding radius and top of an object (for hashing).
export function objectBounds(o) {
  const [sx, sy, sz] = o.s;
  return { r: Math.hypot(sx, sz), top: o.kind === 'rock' ? o.y + sy : o.y + 2 * sy };
}
