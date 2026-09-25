// Armour geometry, shared by the sim (hit tests) and the renderer (tank models are built from
// the same solids, so what you see is exactly what you can shoot).
//
// Every armoured piece is a convex solid: the intersection of half-spaces n·p <= d (n is the
// outward unit normal). Each plane is one armour plate with a thickness in mm and a name.
// Pieces live in one of two frames (see docs/DESIGN.md "Frames"):
//   'hull'   — origin on the ground under the hull centre; +z forward, +y up, +x = tank's LEFT.
//   'turret' — origin at the turret ring centre on the hull roof; rotates about +y by turretYaw
//              (casemate pieces stay at yaw 0: only the gun and mantlet traverse).
// Pure JS, no three.js.

const DEG = Math.PI / 180;
const EPS = 1e-6;

const plane = (nx, ny, nz, px, py, pz, t, plate) => {
  const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
  return { n: [nx, ny, nz], d: nx * px + ny * py + nz * pz, t, plate };
};

// ------------------------------------------------------------------ solids from parameters
function hullPieces(h) {
  const { L, W, H, clr } = h;
  const tr = h.track;
  const top = clr + H;
  const up = h.upper, lo = h.lower;
  const noseY = clr + H * (1 - up.frac);
  const au = up.a * DEG, al = lo.a * DEG, ar = (h.rear.a || 0) * DEG, as = (h.side.a || 0) * DEG;
  const trackTop = Math.min(tr.h, top - 0.05);
  const fullW = W + 2 * tr.w;
  const front = [
    plane(0, Math.sin(au), Math.cos(au), 0, noseY, L / 2, up.t, 'hull.front.upper'),
    plane(0, -Math.sin(al), Math.cos(al), 0, noseY, L / 2, lo.t, 'hull.front.lower'),
    plane(0, Math.sin(ar), -Math.cos(ar), 0, clr + H / 2, -L / 2, h.rear.t, 'hull.rear'),
  ];
  // Lower hull: between the tracks, belly up to the top of the tracks.
  const lower = [
    ...front,
    plane(1, 0, 0, W / 2, 0, 0, h.side.t, 'hull.side.lower'),
    plane(-1, 0, 0, -W / 2, 0, 0, h.side.t, 'hull.side.lower'),
    plane(0, -1, 0, 0, clr, 0, h.floor, 'hull.floor'),
    plane(0, 1, 0, 0, trackTop, 0, h.roof, 'hull.roof'), // internal seam; covered by the upper piece
  ];
  // Upper hull: full width over the tracks (sponsons / fenders), from track top to the roof.
  const tUp = h.side.tUpper ?? h.side.t;
  const upper = [
    ...front.map((p) => ({ ...p })),
    plane(Math.cos(as), Math.sin(as), 0, fullW / 2, trackTop, 0, tUp, 'hull.side.upper'),
    plane(-Math.cos(as), Math.sin(as), 0, -fullW / 2, trackTop, 0, tUp, 'hull.side.upper'),
    plane(0, -1, 0, 0, trackTop, 0, h.side.t, 'hull.sponson.floor'),
    plane(0, 1, 0, 0, top, 0, h.roof, 'hull.roof'),
  ];
  const trackPiece = (side) => {
    const x0 = side > 0 ? W / 2 : -W / 2 - tr.w, x1 = x0 + tr.w;
    const len = L * (tr.len ?? 0.96);
    return [
      plane(1, 0, 0, x1, 0, 0, tr.t, 'track'), plane(-1, 0, 0, x0, 0, 0, tr.t, 'track'),
      plane(0, 1, 0, 0, trackTop - 0.02, 0, tr.t, 'track'), plane(0, -1, 0, 0, 0, 0, tr.t, 'track'),
      plane(0, 0.35, 1, 0, trackTop * 0.5, len / 2, tr.t, 'track'),
      plane(0, 0.35, -1, 0, trackTop * 0.5, -len / 2, tr.t, 'track'),
    ];
  };
  return [
    { name: 'hullLower', frame: 'hull', planes: lower, kind: 'hull' },
    { name: 'hullUpper', frame: 'hull', planes: upper, kind: 'hull' },
    { name: 'trackL', frame: 'hull', planes: trackPiece(1), kind: 'track', spaced: true },
    { name: 'trackR', frame: 'hull', planes: trackPiece(-1), kind: 'track', spaced: true },
  ];
}

function turretPieces(t) {
  const { L, W, H } = t;
  const zo = t.zOff || 0; // body centre relative to the ring, + forward
  const af = t.front.a * DEG, as = (t.side.a || 0) * DEG, ar = (t.rear.a || 0) * DEG;
  const fz = zo + L / 2, rz = zo - L / 2;
  const ps = [
    plane(0, Math.sin(af), Math.cos(af), 0, H / 2, fz, t.front.t, 'turret.front'),
    plane(0, Math.sin(ar), -Math.cos(ar), 0, H / 2, rz, t.rear.t, 'turret.rear'),
    plane(Math.cos(as), Math.sin(as), 0, W / 2, 0, 0, t.side.t, 'turret.side'),
    plane(-Math.cos(as), Math.sin(as), 0, -W / 2, 0, 0, t.side.t, 'turret.side'),
    plane(0, -1, 0, 0, 0, 0, 0, 'turret.floor'), // never an entry face from outside (inside the hull)
  ];
  // Open-topped fighting compartments (shape 'open', or a casemate with open: true) have a
  // zero-thickness roof: anything, HE splash included, goes straight in.
  if (t.shape !== 'open' && !t.open) ps.push(plane(0, 1, 0, 0, H, 0, t.roof, 'turret.roof'));
  else ps.push(plane(0, 1, 0, 0, H, 0, 0, 'turret.open'));
  if (t.shape === 'cast' || t.chamfer) {
    // Cut the four vertical corners at 45° so cast turrets read round.
    const c = t.chamfer ?? 0.3;
    const cx = W / 2, cf = L / 2;
    const cut = (sx, sz, tt, name) => {
      const px = sx * cx * (1 - c), pz = zo + sz * cf;
      const p2x = sx * cx, p2z = zo + sz * cf * (1 - c);
      // plane through (px,pz) and (p2x,p2z), normal pointing outwards
      let nx = (pz - p2z), nz = -(px - p2x);
      if (nx * sx + nz * sz < 0) { nx = -nx; nz = -nz; }
      ps.push(plane(nx, 0, nz, px, 0, pz, tt, name));
    };
    const fs = Math.round((t.front.t + t.side.t) / 2), rs = Math.round((t.rear.t + t.side.t) / 2);
    cut(1, 1, fs, 'turret.cheek'); cut(-1, 1, fs, 'turret.cheek');
    cut(1, -1, rs, 'turret.side'); cut(-1, -1, rs, 'turret.side');
  }
  const m = t.mantlet;
  const pieces = [{ name: 'turret', frame: 'turret', planes: ps, kind: 'turret', fixed: t.shape === 'casemate' }];
  if (m && m.t > 0) {
    const gy = gunPivotY(t), mz = frontZAt(t, gy);
    pieces.push({
      name: 'mantlet', frame: 'turret', kind: 'mantlet', gunYaw: true,
      planes: box(0, gy, mz + m.d / 2 - 0.02, m.w / 2, m.h / 2, m.d / 2, m.t, 'mantlet'),
    });
  }
  return pieces;
}

// z of the turret front face at height y (the gun sits there)
function frontZAt(t, y) {
  const af = t.front.a * DEG;
  return (t.zOff || 0) + t.L / 2 - (y - t.H / 2) * Math.tan(af);
}
function gunPivotY(t) { return t.gunY ?? t.H * 0.48; }

function box(cx, cy, cz, hx, hy, hz, t, plate) {
  return [
    plane(1, 0, 0, cx + hx, cy, cz, t, plate), plane(-1, 0, 0, cx - hx, cy, cz, t, plate),
    plane(0, 1, 0, cx, cy + hy, cz, t, plate), plane(0, -1, 0, cx, cy - hy, cz, t, plate),
    plane(0, 0, 1, cx, cy, cz + hz, t, plate), plane(0, 0, -1, cx, cy, cz - hz, t, plate),
  ];
}

// ------------------------------------------------------------------ modules & crew
// Axis-aligned boxes {name, frame, c:[x,y,z], h:[hx,hy,hz]} inside the armour. After a shell
// penetrates, the sim traces it on through these (docs/DESIGN.md "Damage").
function modules(def) {
  const h = def.hull, t = def.turret;
  const { L, W, H, clr } = h;
  const mid = clr + H * 0.45;
  const rearEngine = (h.engine ?? 'rear') === 'rear';
  const ez = rearEngine ? -L * 0.33 : L * 0.3;
  const tz = t.z ?? 0;
  const out = [
    { name: 'engine', frame: 'hull', c: [0, mid, ez], h: [W * 0.35, H * 0.3, L * 0.14] },
    { name: 'fuel', frame: 'hull', c: [0, clr + H * 0.3, rearEngine ? -L * 0.12 : L * 0.12], h: [W * 0.42, H * 0.18, L * 0.06] },
    { name: 'turretRing', frame: 'hull', c: [0, clr + H - 0.08, tz], h: [t.ringR ?? W * 0.35, 0.1, t.ringR ?? W * 0.35] },
  ];
  const ammo = h.ammo ?? 'hull';
  if (ammo === 'bustle') out.push({ name: 'ammoRack', frame: 'turret', c: [0, t.H * 0.5, (t.zOff || 0) - t.L * 0.38], h: [t.W * 0.3, t.H * 0.22, t.L * 0.1] });
  else if (ammo === 'floor') out.push({ name: 'ammoRack', frame: 'hull', c: [0, clr + 0.15, tz], h: [W * 0.3, 0.12, L * 0.12] });
  else out.push({ name: 'ammoRack', frame: 'hull', c: [0, clr + H * 0.35, tz - 0.1], h: [W * 0.45, H * 0.2, L * 0.08] });
  // Crew
  const crew = def.crew || [];
  const seat = (name, frame, x, y, z) => ({ name, frame, crew: true, c: [x, y, z], h: [0.22, 0.35, 0.22] });
  const fz = L / 2 - 0.9, s = W * 0.28;
  for (const c of crew) {
    if (c === 'driver') out.push(seat(c, 'hull', -s, clr + 0.45, fz)); // right side of hull (−x = right)
    else if (c === 'radioman') out.push(seat(c, 'hull', s, clr + 0.45, fz));
    else if (c === 'commander') out.push(seat(c, 'turret', 0, t.H * 0.45, (t.zOff || 0) - t.L * 0.2));
    else if (c === 'gunner') out.push(seat(c, 'turret', s * 0.8, t.H * 0.35, (t.zOff || 0) + t.L * 0.1));
    else if (c === 'loader') out.push(seat(c, 'turret', -s * 0.8, t.H * 0.35, (t.zOff || 0)));
  }
  return out;
}

// ------------------------------------------------------------------ public
// buildArmor(def) → {
//   pieces: [{name, frame, kind, planes, fixed?, gunYaw?, spaced?}],
//   modules: [{name, frame, c, h, crew?}],
//   gun: { pivot:[x,y,z] (turret frame), len, r },
//   turretPos: [x,y,z] (hull frame position of the turret ring centre),
// } — cached on def.
export function buildArmor(def) {
  if (def._armor) return def._armor;
  const t = def.turret, h = def.hull;
  const gy = gunPivotY(t);
  const gz = frontZAt(t, gy) + (t.mantlet ? t.mantlet.d : 0);
  const gun = def.guns ? def.guns[0] : def.gun;
  const a = {
    pieces: [...hullPieces(h), ...turretPieces(t)],
    modules: modules(def),
    gun: { pivot: [0, gy, gz], len: gun ? gun.len : 3, r: gun ? Math.max(0.04, gun.cal / 2000 * 1.8) : 0.06 },
    turretPos: [0, h.clr + h.H, t.z ?? 0],
  };
  Object.defineProperty(def, '_armor', { value: a, enumerable: false });
  return a;
}

// Ray vs convex solid. o, dir in the solid's frame (dir need not be unit; t is in dir units).
// Returns {t, plane} for the entry point, or null. Also {tExit}.
const _hit = { t: 0, tExit: 0, plane: null };
export function rayConvex(planes, ox, oy, oz, dx, dy, dz, tMax = Infinity) {
  let tIn = -Infinity, tOut = tMax, pIn = null;
  for (let i = 0; i < planes.length; i++) {
    const p = planes[i], n = p.n;
    const dn = n[0] * dx + n[1] * dy + n[2] * dz;
    const dist = p.d - (n[0] * ox + n[1] * oy + n[2] * oz); // >= 0 inside
    if (Math.abs(dn) < EPS) { if (dist < 0) return null; continue; }
    const tt = dist / dn;
    if (dn < 0) { if (tt > tIn) { tIn = tt; pIn = p; } } else if (tt < tOut) tOut = tt;
    if (tIn > tOut) return null;
  }
  if (!pIn || tIn < 0 || tIn > tMax) return null;
  _hit.t = tIn; _hit.tExit = tOut; _hit.plane = pIn;
  return _hit;
}

// Ray vs axis-aligned box {c, h}. Returns entry t or -1.
export function rayBox(b, ox, oy, oz, dx, dy, dz, tMax = Infinity) {
  let t0 = 0, t1 = tMax;
  const o = [ox, oy, oz], d = [dx, dy, dz];
  for (let k = 0; k < 3; k++) {
    const lo = b.c[k] - b.h[k], hi = b.c[k] + b.h[k];
    if (Math.abs(d[k]) < EPS) { if (o[k] < lo || o[k] > hi) return -1; continue; }
    let a = (lo - o[k]) / d[k], c = (hi - o[k]) / d[k];
    if (a > c) { const s = a; a = c; c = s; }
    if (a > t0) t0 = a; if (c < t1) t1 = c;
    if (t0 > t1) return -1;
  }
  return t0;
}

// Faces of a convex solid for rendering / the armour inspector:
// [{plane, verts:[[x,y,z], ...] (CCW seen from outside)}].
export function solidFaces(planes) {
  const verts = [];
  const n = planes.length;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) for (let k = j + 1; k < n; k++) {
    const p = intersect3(planes[i], planes[j], planes[k]);
    if (!p) continue;
    let inside = true;
    for (const q of planes) if (q.n[0] * p[0] + q.n[1] * p[1] + q.n[2] * p[2] > q.d + 1e-5) { inside = false; break; }
    if (!inside) continue;
    if (!verts.some((v) => Math.abs(v[0] - p[0]) + Math.abs(v[1] - p[1]) + Math.abs(v[2] - p[2]) < 1e-5)) verts.push(p);
  }
  const faces = [];
  for (const pl of planes) {
    const on = verts.filter((v) => Math.abs(pl.n[0] * v[0] + pl.n[1] * v[1] + pl.n[2] * v[2] - pl.d) < 1e-4);
    if (on.length < 3) continue;
    const c = [0, 0, 0];
    for (const v of on) { c[0] += v[0] / on.length; c[1] += v[1] / on.length; c[2] += v[2] / on.length; }
    // basis in the plane
    const nn = pl.n, ref = Math.abs(nn[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const u = norm(cross(ref, nn)), w = cross(nn, u);
    on.sort((a, b) => {
      const aa = Math.atan2(dot(sub(a, c), w), dot(sub(a, c), u));
      const bb = Math.atan2(dot(sub(b, c), w), dot(sub(b, c), u));
      return aa - bb;
    });
    faces.push({ plane: pl, verts: on });
  }
  return faces;
}

function intersect3(a, b, c) {
  const n1 = a.n, n2 = b.n, n3 = c.n;
  const x23 = cross(n2, n3), det = dot(n1, x23);
  if (Math.abs(det) < 1e-9) return null;
  const x31 = cross(n3, n1), x12 = cross(n1, n2);
  return [
    (a.d * x23[0] + b.d * x31[0] + c.d * x12[0]) / det,
    (a.d * x23[1] + b.d * x31[1] + c.d * x12[1]) / det,
    (a.d * x23[2] + b.d * x31[2] + c.d * x12[2]) / det,
  ];
}
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
