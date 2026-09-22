// Meshes: tanks, blocks, crates, shells, mines, and the giant set-dressing props.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import * as TX from './textures.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const cache = {};
const once = (k, f) => cache[k] || (cache[k] = f());

export function plastic(color, opts = {}) {
  return new THREE.MeshPhysicalMaterial({
    color, roughness: 0.32, metalness: 0.0, clearcoat: 0.9, clearcoatRoughness: 0.18,
    sheen: 0.0, envMapIntensity: 0.9, ...opts,
  });
}

// Map a rounded box's per-face UVs into a 4-slot horizontal strip so one texture carries
// a different letter on each visible face.
function stripUV(geo) {
  const n = geo.attributes.normal, uv = geo.attributes.uv;
  for (let k = 0; k < uv.count; k++) {
    const nx = n.getX(k), ny = n.getY(k), nz = n.getZ(k);
    const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
    let slot;
    if (ay >= ax && ay >= az) slot = ny > 0 ? 0 : 2;
    else if (az >= ax) slot = nz > 0 ? 1 : 3;
    else slot = nx > 0 ? 2 : 3;
    uv.setX(k, (Math.min(0.999, Math.max(0.001, uv.getX(k))) + slot) / 4);
  }
  uv.needsUpdate = true;
  return geo;
}

// ------------------------------------------------------------------ board pieces
export const blockGeo = () => once('blockGeo', () => stripUV(new RoundedBoxGeometry(0.94, 0.94, 0.94, 3, 0.07)));
export const crateGeo = () => once('crateGeo', () => new RoundedBoxGeometry(0.9, 0.82, 0.9, 2, 0.03));

export const blockMaterials = () => once('blockMats', () => [...Array(TX.BLOCK_VARIANTS)].map((_, v) =>
  new THREE.MeshPhysicalMaterial({ map: TX.blockTextureHQ(v), roughness: 0.62, clearcoat: 0.25, clearcoatRoughness: 0.5, envMapIntensity: 0.5 })));

export const crateMaterial = () => once('crateMat', () => new THREE.MeshStandardMaterial({ map: TX.cardboard(), roughness: 0.92, envMapIntensity: 0.3 }));

// ------------------------------------------------------------------ tank (die-cast toy)

const wear = () => once('wear', () => TX.paintWear());

export function diecast(color, opts = {}) {
  const w = wear();
  return new THREE.MeshPhysicalMaterial({
    color, map: w.map, metalnessMap: w.mr, roughnessMap: w.mr, metalness: 1, roughness: 1,
    clearcoat: 0.55, clearcoatRoughness: 0.35, envMapIntensity: 1.0, ...opts,
  });
}

// Track loop: a stadium path in the tank's local (x forward, y up) plane.
const TRACK = (() => {
  const R = 0.085, xf = 0.3, xr = -0.3, yc = 0.1, yTop = yc + R, yBot = yc - R;
  const straight = xf - xr, arc = Math.PI * R;
  const P = straight * 2 + arc * 2;
  const at = (s) => {
    s = ((s % P) + P) % P;
    if (s < straight) return [xr + s, yTop, 0];                          // top, rear → front
    s -= straight;
    if (s < arc) { const a = Math.PI / 2 - s / R; return [xf + Math.cos(a) * R, yc + Math.sin(a) * R, a - Math.PI / 2]; } // front wrap
    s -= arc;
    if (s < straight) return [xf - s, yBot, Math.PI];                    // bottom, front → rear
    s -= straight;
    const a = -Math.PI / 2 - s / R; return [xr + Math.cos(a) * R, yc + Math.sin(a) * R, a - Math.PI / 2]; // rear wrap
  };
  return { P, at, N: 36, R, yc, xf, xr };
})();
export { TRACK };

function hullGeometry() {
  // Side profile (x forward, y up), extruded across the width: sloped glacis, flat deck,
  // angled rear plate. Reads as a WW2 medium tank at toy scale.
  const sh = new THREE.Shape();
  sh.moveTo(-0.36, 0.13); sh.lineTo(0.27, 0.13); sh.lineTo(0.38, 0.2); sh.lineTo(0.3, 0.3);
  sh.lineTo(-0.3, 0.31); sh.lineTo(-0.37, 0.24); sh.lineTo(-0.36, 0.13);
  const g = new THREE.ExtrudeGeometry(sh, { depth: 0.36, bevelEnabled: true, bevelThickness: 0.018, bevelSize: 0.014, bevelSegments: 3, curveSegments: 4 });
  g.translate(0, 0, -0.18);
  return g;
}

function rivets() {
  const parts = [];
  const r = new THREE.SphereGeometry(0.009, 6, 4);
  const add = (x, y, z) => { const c = r.clone(); c.translate(x, y, z); parts.push(c); };
  for (let k = 0; k < 9; k++) { const x = -0.28 + k * 0.07; add(x, 0.318, 0.2); add(x, 0.318, -0.2); }
  for (let k = 0; k < 5; k++) { const z = -0.16 + k * 0.08; add(0.335, 0.27, z); add(-0.335, 0.285, z); }
  return mergeGeometries(parts);
}

export function buildTank(type, { emblem = 'ring', colorOverride = null } = {}) {
  const color = colorOverride ?? type.color;
  const root = new THREE.Group();
  const body = new THREE.Group(); root.add(body);
  const paint = diecast(color);
  const trimPaint = diecast(type.trim);
  const steel = new THREE.MeshStandardMaterial({ color: 0x55585e, metalness: 0.9, roughness: 0.42 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x1c1d1f, roughness: 0.8, metalness: 0.2 });
  const linkMat = new THREE.MeshStandardMaterial({ color: 0x3a3a3c, metalness: 0.85, roughness: 0.5 });

  const hull = new THREE.Mesh(once('hullGeo2', hullGeometry), paint);
  hull.castShadow = hull.receiveShadow = true; body.add(hull);
  const riv = new THREE.Mesh(once('rivets', rivets), paint); body.add(riv);
  // fenders over the tracks
  for (const side of [1, -1]) {
    const f = new THREE.Mesh(once('fender', () => new RoundedBoxGeometry(0.82, 0.018, 0.13, 2, 0.006)), paint);
    f.position.set(0, 0.215, side * 0.25); f.castShadow = true; body.add(f);
    // stowage box on the fender
    const box = new THREE.Mesh(once('stow', () => new RoundedBoxGeometry(0.16, 0.05, 0.09, 2, 0.01)), paint);
    box.position.set(-0.18, 0.25, side * 0.26); box.castShadow = true; body.add(box);
  }
  // engine deck grille
  for (let k = 0; k < 5; k++) {
    const sl = new THREE.Mesh(once('slat', () => new THREE.BoxGeometry(0.012, 0.012, 0.22)), steel);
    sl.position.set(-0.3 + k * 0.03, 0.33, 0); body.add(sl);
  }
  // hull MG + headlights + tow hooks
  const mg = new THREE.Mesh(once('mg', () => { const g = new THREE.CylinderGeometry(0.009, 0.011, 0.09, 8); g.rotateZ(-Math.PI / 2); return g; }), steel);
  mg.position.set(0.37, 0.24, 0.08); body.add(mg);
  for (const side of [1, -1]) {
    const hl = new THREE.Mesh(once('hl2', () => { const g = new THREE.CylinderGeometry(0.022, 0.018, 0.03, 12); g.rotateZ(-Math.PI / 2); return g; }), new THREE.MeshStandardMaterial({ color: 0xfff4d6, emissive: 0xffe0a0, emissiveIntensity: 0.35, roughness: 0.15, metalness: 0.3 }));
    hl.position.set(0.35, 0.29, side * 0.15); body.add(hl);
    const hook = new THREE.Mesh(once('hook', () => new THREE.TorusGeometry(0.018, 0.006, 6, 10)), steel);
    hook.position.set(0.38, 0.15, side * 0.11); hook.rotation.y = Math.PI / 2; body.add(hook);
  }
  // exhausts
  for (const side of [1, -1]) {
    const ex = new THREE.Mesh(once('ex2', () => { const g = new THREE.CylinderGeometry(0.022, 0.026, 0.07, 10); g.rotateZ(Math.PI / 2); return g; }), steel);
    ex.position.set(-0.4, 0.22, side * 0.1); body.add(ex);
  }

  // running gear per side: road wheels, sprocket, idler, and animated track links
  const wheels = [];
  const links = new THREE.InstancedMesh(once('link', () => new THREE.BoxGeometry(TRACK.P / TRACK.N * 0.82, 0.018, 0.13)), linkMat, TRACK.N * 2);
  links.castShadow = true; links.receiveShadow = true; links.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  body.add(links);
  for (const side of [1, -1]) {
    const z = side * 0.25;
    for (let k = 0; k < 5; k++) {
      const w = new THREE.Group();
      const tire = new THREE.Mesh(once('rw', () => { const g = new THREE.CylinderGeometry(0.058, 0.058, 0.11, 18); g.rotateX(Math.PI / 2); return g; }), rubber);
      const hub = new THREE.Mesh(once('rwh', () => { const g = new THREE.CylinderGeometry(0.04, 0.04, 0.118, 12); g.rotateX(Math.PI / 2); return g; }), paint);
      const cap = new THREE.Mesh(once('rwc', () => { const g = new THREE.CylinderGeometry(0.014, 0.014, 0.124, 8); g.rotateX(Math.PI / 2); return g; }), steel);
      w.add(tire, hub, cap); w.position.set(-0.24 + k * 0.12, 0.078, z); body.add(w); wheels.push(w);
    }
    for (const [x, big] of [[TRACK.xf, true], [TRACK.xr, false]]) {
      const sp = new THREE.Mesh(once(big ? 'spr' : 'idl', () => { const g = new THREE.CylinderGeometry(big ? 0.072 : 0.066, big ? 0.072 : 0.066, 0.1, big ? 9 : 16); g.rotateX(Math.PI / 2); return g; }), big ? steel : paint);
      sp.position.set(x, TRACK.yc, z); body.add(sp); wheels.push(sp);
    }
    // track side skirt hint
  }

  // turret: a cast, rounded shell (lathe) with a mantlet
  const turret = new THREE.Group();
  turret.position.set(-0.02, 0.325, 0);
  root.add(turret);
  const shellGeo = once('turretShell', () => {
    const pts = [[0, 0.13], [0.1, 0.128], [0.16, 0.11], [0.19, 0.075], [0.2, 0.03], [0.195, 0.0], [0, 0]].map(([r, y]) => new THREE.Vector2(r, y));
    const g = new THREE.LatheGeometry(pts.reverse(), 36);
    g.scale(1.12, 1, 1);
    return g;
  });
  const tshell = new THREE.Mesh(shellGeo, paint); tshell.castShadow = tshell.receiveShadow = true; turret.add(tshell);
  const ring = new THREE.Mesh(once('tring', () => new THREE.CylinderGeometry(0.2, 0.21, 0.025, 36)), steel);
  ring.position.y = 0.005; turret.add(ring);
  const mantlet = new THREE.Mesh(once('mant', () => new RoundedBoxGeometry(0.07, 0.085, 0.15, 3, 0.02)), paint);
  mantlet.position.set(0.2, 0.065, 0); mantlet.castShadow = true; turret.add(mantlet);
  // commander cupola + hatch + periscope
  const cup = new THREE.Mesh(once('cup', () => new THREE.CylinderGeometry(0.055, 0.06, 0.045, 20)), paint);
  cup.position.set(-0.06, 0.15, 0.06); cup.castShadow = true; turret.add(cup);
  const hatch = new THREE.Mesh(once('hat', () => new THREE.CylinderGeometry(0.05, 0.05, 0.012, 20)), trimPaint);
  hatch.position.set(-0.06, 0.178, 0.06); turret.add(hatch);
  const peri = new THREE.Mesh(once('peri', () => new THREE.BoxGeometry(0.03, 0.025, 0.04)), steel);
  peri.position.set(0.04, 0.14, -0.06); turret.add(peri);
  // turret MG on a pintle
  const tmg = new THREE.Mesh(once('tmg', () => { const g = new THREE.CylinderGeometry(0.008, 0.008, 0.12, 6); g.rotateZ(-Math.PI / 2); g.translate(0.05, 0, 0); return g; }), steel);
  tmg.position.set(-0.04, 0.205, 0.06); turret.add(tmg);
  // emblem decals
  const emblemMat = new THREE.MeshStandardMaterial({ map: TX.emblem(emblem, '#f2efe6'), transparent: true, roughness: 0.5, polygonOffset: true, polygonOffsetFactor: -2, depthWrite: false });
  for (const side of [1, -1]) {
    const em = new THREE.Mesh(once('emGeo2', () => new THREE.PlaneGeometry(0.1, 0.1)), emblemMat);
    em.position.set(-0.02, 0.065, side * 0.203); em.rotation.y = side > 0 ? 0 : Math.PI; em.rotation.x = side * -0.2;
    turret.add(em);
  }
  // barrel group (recoils)
  const barrel = new THREE.Group(); turret.add(barrel);
  barrel.position.set(0.22, 0.065, 0);
  const tube = new THREE.Mesh(once('tube2', () => { const g = new THREE.CylinderGeometry(0.024, 0.03, 0.42, 20); g.rotateZ(-Math.PI / 2); g.translate(0.21, 0, 0); return g; }), paint);
  tube.castShadow = true; barrel.add(tube);
  const brake = new THREE.Mesh(once('brake', () => { const g = new THREE.CylinderGeometry(0.038, 0.038, 0.07, 16); g.rotateZ(-Math.PI / 2); g.translate(0.43, 0, 0); return g; }), steel);
  brake.castShadow = true; barrel.add(brake);
  const bore = new THREE.Mesh(once('bore2', () => { const g = new THREE.CircleGeometry(0.02, 12); g.rotateY(Math.PI / 2); g.translate(0.466, 0, 0); return g; }), new THREE.MeshBasicMaterial({ color: 0x050505 }));
  barrel.add(bore);
  // antenna + pennant
  const ant = new THREE.Mesh(once('ant2', () => { const g = new THREE.CylinderGeometry(0.004, 0.006, 0.4, 5); g.translate(0, 0.2, 0); return g; }), steel);
  ant.position.set(-0.14, 0.1, -0.1); turret.add(ant);
  const flag = new THREE.Mesh(once('flag2', () => { const g = new THREE.PlaneGeometry(0.12, 0.07, 6, 1); g.translate(-0.06, 0, 0); return g; }), new THREE.MeshStandardMaterial({ color: type.trim === 0x0b4f4d ? 0x1fb5b0 : color, side: THREE.DoubleSide, roughness: 0.85 }));
  flag.position.set(0, 0.36, 0); ant.add(flag);

  root.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  root.userData = { body, turret, barrel, wheels, links, flag, trackPhase: 0, mats: [paint, trimPaint, steel, rubber, linkMat, emblemMat, flag.material] };
  updateTracks(root, 0);
  return root;
}

const _m4 = new THREE.Matrix4(), _q4 = new THREE.Quaternion(), _p4 = new THREE.Vector3(), _s4 = new THREE.Vector3(1, 1, 1), _z = new THREE.Vector3(0, 0, 1);
// Roll the links around the loop and spin the wheels. `left`/`right` are distances travelled.
export function updateTracks(root, left, right = left) {
  const ud = root.userData;
  ud.phaseL = (ud.phaseL || 0) + left; ud.phaseR = (ud.phaseR || 0) + right;
  let n = 0;
  for (const [side, ph] of [[1, ud.phaseL], [-1, ud.phaseR]]) {
    for (let k = 0; k < TRACK.N; k++) {
      const [x, y, a] = TRACK.at(k / TRACK.N * TRACK.P + ph);
      _q4.setFromAxisAngle(_z, a);
      _m4.compose(_p4.set(x, y, side * 0.25), _q4, _s4);
      ud.links.setMatrixAt(n++, _m4);
    }
  }
  ud.links.instanceMatrix.needsUpdate = true;
  const wl = ud.wheels.length / 2;
  ud.wheels.forEach((w, k) => { w.rotation.z = -(k < wl ? ud.phaseL : ud.phaseR) / 0.06; });
}

// ------------------------------------------------------------------ shells & mines
export const shellGeo = () => once('shellGeo', () => { const g = new THREE.CapsuleGeometry(0.055, 0.12, 6, 12); g.rotateZ(Math.PI / 2); return g; });
export const rocketGeo = () => once('rocketGeo', () => { const g = new THREE.CapsuleGeometry(0.05, 0.22, 6, 12); g.rotateZ(Math.PI / 2); return g; });
export const shellMat = () => once('shellMat', () => new THREE.MeshStandardMaterial({ color: 0xd8b25a, metalness: 0.85, roughness: 0.25, emissive: 0x3a2600, emissiveIntensity: 0.4 }));
export const rocketMat = () => once('rocketMat', () => new THREE.MeshStandardMaterial({ color: 0xe9ecef, metalness: 0.4, roughness: 0.3, emissive: 0xff5a1f, emissiveIntensity: 0.25 }));

export function buildMine() {
  const g = new THREE.Group();
  const base = new THREE.Mesh(once('mineBase', () => new THREE.CylinderGeometry(0.22, 0.24, 0.05, 28)), new THREE.MeshStandardMaterial({ color: 0x2b2b2b, roughness: 0.5, metalness: 0.5 }));
  base.position.y = 0.025; g.add(base);
  const dome = new THREE.Mesh(once('mineDome', () => { const d = new THREE.SphereGeometry(0.19, 28, 12, 0, Math.PI * 2, 0, Math.PI / 2); d.scale(1, 0.55, 1); return d; }), plastic(0xf2c230));
  dome.position.y = 0.05; g.add(dome);
  // hazard stripes as small dark boxes around the dome skirt
  for (let k = 0; k < 6; k++) {
    const s = new THREE.Mesh(once('mineStripe', () => new THREE.BoxGeometry(0.05, 0.03, 0.12)), new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.6 }));
    const a = (k / 6) * Math.PI * 2;
    s.position.set(Math.cos(a) * 0.17, 0.075, Math.sin(a) * 0.17); s.rotation.y = -a;
    g.add(s);
  }
  const lamp = new THREE.Mesh(once('mineLamp', () => new THREE.SphereGeometry(0.045, 16, 10)), new THREE.MeshStandardMaterial({ color: 0x550000, emissive: 0xff1a0a, emissiveIntensity: 0, roughness: 0.2 }));
  lamp.position.y = 0.16; g.add(lamp);
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  g.userData.lamp = lamp; g.userData.dome = dome;
  return g;
}

// ------------------------------------------------------------------ set dressing (giant desk things)
export function pencil(color = 0xf2c230) {
  const g = new THREE.Group();
  const L = 14;
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, L, 6), plastic(color, { clearcoat: 0.6, roughness: 0.4 }));
  body.rotation.z = Math.PI / 2; g.add(body);
  const wood = new THREE.Mesh(new THREE.ConeGeometry(0.42, 1.6, 6, 1, true), new THREE.MeshStandardMaterial({ color: 0xe8c79a, roughness: 0.8, side: THREE.DoubleSide }));
  wood.rotation.z = -Math.PI / 2; wood.position.x = L / 2 + 0.8; g.add(wood);
  const lead = new THREE.Mesh(new THREE.ConeGeometry(0.15, 0.55, 12), new THREE.MeshStandardMaterial({ color: 0x2a2a2e, roughness: 0.3, metalness: 0.5 }));
  lead.rotation.z = -Math.PI / 2; lead.position.x = L / 2 + 1.33; g.add(lead);
  const ferrule = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.9, 24), new THREE.MeshStandardMaterial({ color: 0xc9ccd1, metalness: 1, roughness: 0.25 }));
  ferrule.rotation.z = Math.PI / 2; ferrule.position.x = -L / 2 - 0.45; g.add(ferrule);
  const eraser = new THREE.Mesh(new RoundedBoxGeometry(1.0, 0.86, 0.86, 3, 0.2), new THREE.MeshStandardMaterial({ color: 0xf28fa8, roughness: 0.9 }));
  eraser.position.x = -L / 2 - 1.3; g.add(eraser);
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

export function crayon(color) {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.55 });
  const paper = new THREE.MeshStandardMaterial({ color: new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.15), roughness: 0.9 });
  const b = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 6, 24), paper); b.rotation.z = Math.PI / 2; g.add(b);
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.505, 0.505, 0.25, 24), new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.8 }));
  band.rotation.z = Math.PI / 2; band.position.x = 2.2; g.add(band);
  const band2 = band.clone(); band2.position.x = -2.2; g.add(band2);
  const bare = new THREE.Mesh(new THREE.CylinderGeometry(0.48, 0.48, 0.8, 24), mat); bare.rotation.z = Math.PI / 2; bare.position.x = 3.4; g.add(bare);
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.48, 0.9, 24), mat); tip.rotation.z = -Math.PI / 2; tip.position.x = 4.25; g.add(tip);
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

export function mug() {
  const g = new THREE.Group();
  const pts = [];
  for (let k = 0; k <= 20; k++) { const t = k / 20; pts.push(new THREE.Vector2(2.2 + Math.sin(t * Math.PI) * 0.12, t * 5)); }
  pts.push(new THREE.Vector2(2.0, 5)); pts.push(new THREE.Vector2(2.0, 0.4)); pts.push(new THREE.Vector2(0, 0.4));
  const mat = new THREE.MeshPhysicalMaterial({ color: 0xe9e4da, roughness: 0.18, clearcoat: 1, clearcoatRoughness: 0.05 });
  const body = new THREE.Mesh(new THREE.LatheGeometry(pts, 48), mat); g.add(body);
  const bottom = new THREE.Mesh(new THREE.CircleGeometry(2.2, 48), mat); bottom.rotation.x = Math.PI / 2; g.add(bottom);
  const handle = new THREE.Mesh(new THREE.TorusGeometry(1.1, 0.28, 16, 32, Math.PI * 1.2), mat);
  handle.position.set(2.2, 2.6, 0); handle.rotation.z = -Math.PI * 0.6; g.add(handle);
  const coffee = new THREE.Mesh(new THREE.CircleGeometry(2.0, 48), new THREE.MeshPhysicalMaterial({ color: 0x2a140a, roughness: 0.05, clearcoat: 1 }));
  coffee.rotation.x = -Math.PI / 2; coffee.position.y = 4.4; g.add(coffee);
  const band = new THREE.Mesh(new THREE.CylinderGeometry(2.26, 2.26, 0.7, 48, 1, true), new THREE.MeshStandardMaterial({ color: 0x2c6fd6, roughness: 0.3 }));
  band.position.y = 3.6; g.add(band);
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

export function brick(color, w = 4, d = 2) {
  const g = new THREE.Group();
  const U = 0.8;
  const mat = plastic(color, { roughness: 0.25, clearcoat: 1 });
  const b = new THREE.Mesh(new RoundedBoxGeometry(w * U, U * 1.2, d * U, 3, 0.05), mat); b.position.y = U * 0.6; g.add(b);
  const stud = new THREE.CylinderGeometry(U * 0.3, U * 0.3, U * 0.2, 24);
  for (let i = 0; i < w; i++) for (let j = 0; j < d; j++) {
    const s = new THREE.Mesh(stud, mat); s.position.set((i - (w - 1) / 2) * U, U * 1.3, (j - (d - 1) / 2) * U); g.add(s);
  }
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

export function toySoldier() {
  const g = new THREE.Group();
  const mat = plastic(0x3f6b3a, { roughness: 0.5, clearcoat: 0.2 });
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 0.15, 24), mat); base.position.y = 0.075; g.add(base);
  const legs = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.3, 1.4, 12), mat); legs.position.y = 0.85; g.add(legs);
  const torso = new THREE.Mesh(new RoundedBoxGeometry(0.75, 1.1, 0.45, 2, 0.12), mat); torso.position.y = 2.0; g.add(torso);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.26, 16, 12), mat); head.position.y = 2.8; g.add(head);
  const helm = new THREE.Mesh(new THREE.SphereGeometry(0.32, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), mat); helm.position.y = 2.85; g.add(helm);
  const rifle = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 1.4), mat); rifle.position.set(0.4, 2.2, 0.3); rifle.rotation.x = -0.6; g.add(rifle);
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

// ------------------------------------------------------------------ bedroom furniture (giant, far)
export function bed() {
  const g = new THREE.Group();
  const wood = new THREE.MeshStandardMaterial({ color: 0x8a5a36, roughness: 0.6 });
  const frame = new THREE.Mesh(new RoundedBoxGeometry(20, 4, 40, 3, 0.4), wood); frame.position.y = 2; g.add(frame);
  const mat = new THREE.Mesh(new RoundedBoxGeometry(19, 4, 39, 4, 1.5), new THREE.MeshStandardMaterial({ color: 0xf1ede4, roughness: 0.9 })); mat.position.y = 6; g.add(mat);
  const quilt = new THREE.Mesh(new RoundedBoxGeometry(20.5, 1.5, 28, 4, 0.7), new THREE.MeshStandardMaterial({ color: 0x3a64a8, roughness: 0.95 })); quilt.position.set(0, 8.2, 5); g.add(quilt);
  const pillow = new THREE.Mesh(new RoundedBoxGeometry(12, 2.4, 6, 4, 1.1), new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 })); pillow.position.set(0, 9, -15); g.add(pillow);
  const head = new THREE.Mesh(new RoundedBoxGeometry(21, 16, 1.5, 3, 0.5), wood); head.position.set(0, 8, -20); g.add(head);
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

export function bookshelf() {
  const g = new THREE.Group();
  const wood = new THREE.MeshStandardMaterial({ color: 0xe9dcc6, roughness: 0.55 });
  const W = 16, H = 26, D = 5;
  const side = new RoundedBoxGeometry(0.8, H, D, 2, 0.2);
  for (const x of [-W / 2, W / 2]) { const m = new THREE.Mesh(side, wood); m.position.set(x, H / 2, 0); g.add(m); }
  const back = new THREE.Mesh(new THREE.BoxGeometry(W, H, 0.3), wood); back.position.set(0, H / 2, -D / 2); g.add(back);
  const cols = [0xc0392b, 0x2e86c1, 0xf4d03f, 0x27ae60, 0x8e44ad, 0xe67e22, 0x34495e, 0xecf0f1];
  let h = 3;
  const r = () => { h = (h * 16807) % 2147483647; return h / 2147483647; };
  for (let s = 0; s < 4; s++) {
    const y = 0.5 + s * 6.4;
    const shelf = new THREE.Mesh(new THREE.BoxGeometry(W, 0.6, D), wood); shelf.position.set(0, y, 0); g.add(shelf);
    let x = -W / 2 + 0.6;
    while (x < W / 2 - 1.5) {
      const bw = 0.5 + r() * 0.9, bh = 3.2 + r() * 2.2;
      if (r() < 0.12) { x += 1.2; continue; }
      const book = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, D * 0.8), new THREE.MeshStandardMaterial({ color: cols[Math.floor(r() * cols.length)], roughness: 0.7 }));
      book.position.set(x + bw / 2, y + 0.3 + bh / 2, 0.2); book.rotation.z = (r() - 0.5) * 0.05;
      g.add(book); x += bw + 0.05;
    }
  }
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

export function toyChest() {
  const g = new THREE.Group();
  const paintM = new THREE.MeshStandardMaterial({ color: 0xb03a2e, roughness: 0.5 });
  const trim = new THREE.MeshStandardMaterial({ color: 0xf4d03f, roughness: 0.4, metalness: 0.2 });
  const box = new THREE.Mesh(new RoundedBoxGeometry(14, 8, 8, 3, 0.4), paintM); box.position.y = 4; g.add(box);
  const lid = new THREE.Mesh(new RoundedBoxGeometry(14.4, 1.2, 8.4, 3, 0.4), trim); lid.position.y = 8.4; g.add(lid);
  for (const x of [-5, 5]) { const band = new THREE.Mesh(new THREE.BoxGeometry(0.8, 8.2, 8.3), trim); band.position.set(x, 4, 0); g.add(band); }
  g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}
