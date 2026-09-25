// Three.js meshes straight from the armour solids (src/sim/armor.js). Used by the armour
// inspector (plates coloured by thickness) and as the hangar's stand-in model until
// src/render/tankModel.js exists. Hull pieces live in the hull frame; turret pieces are
// children of `turret`, placed at armor.turretPos (the model's +x is the tank's left).
import * as THREE from 'three';
import { buildArmor, solidFaces } from '../sim/armor.js';

// One BufferGeometry per piece; userData.faces[tri] = {plate, t, n} for picking.
export function pieceGeometry(planes) {
  const faces = solidFaces(planes);
  const pos = [], nor = [], triFace = [];
  faces.forEach((f, fi) => {
    const v = f.verts, n = f.plane.n;
    for (let i = 1; i < v.length - 1; i++) {
      for (const p of [v[0], v[i], v[i + 1]]) { pos.push(p[0], p[1], p[2]); nor.push(n[0], n[1], n[2]); }
      triFace.push(fi);
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.userData.faces = faces.map((f) => f.plane);
  g.userData.triFace = triFace;
  return g;
}

// Colour every triangle of a piece geometry: colorFn(plane) → THREE.Color.
export function paintFaces(g, colorFn) {
  const tf = g.userData.triFace, faces = g.userData.faces;
  let col = g.getAttribute('color');
  if (!col) { col = new THREE.Float32BufferAttribute(new Float32Array(tf.length * 9), 3); g.setAttribute('color', col); }
  for (let t = 0; t < tf.length; t++) {
    const c = colorFn(faces[tf[t]]);
    for (let k = 0; k < 3; k++) col.setXYZ(t * 3 + k, c.r, c.g, c.b);
  }
  col.needsUpdate = true;
}

// Build a group { group, hull, turret, gun, meshes: [{mesh, piece}] }.
// opts.material(piece) → material; default: a painted PBR material.
export function armorModel(def, opts = {}) {
  const a = buildArmor(def);
  const group = new THREE.Group(), turret = new THREE.Group();
  turret.position.set(...a.turretPos);
  group.add(turret);
  const meshes = [];
  const paint = new THREE.Color(opts.paint ?? 0x4b5a32);
  const defMat = (piece) => new THREE.MeshStandardMaterial({
    color: piece.kind === 'track' ? 0x2a2a28 : paint, roughness: piece.kind === 'track' ? 0.95 : 0.72, metalness: 0.25, flatShading: true });
  for (const piece of a.pieces) {
    const g = pieceGeometry(piece.planes);
    const m = new THREE.Mesh(g, (opts.material || defMat)(piece));
    m.castShadow = m.receiveShadow = true;
    m.userData.piece = piece;
    (piece.frame === 'turret' ? turret : group).add(m);
    meshes.push({ mesh: m, piece });
  }
  // gun barrel (not armour): a tapered cylinder from the pivot along +z
  const gd = def.guns?.[opts.gunIndex || 0] || def.guns?.[0];
  const r = Math.max(0.035, (gd?.cal || 75) / 2000 * 1.6), len = gd?.len || a.gun.len;
  const gun = new THREE.Group();
  gun.position.set(...a.gun.pivot);
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.9, r * 1.25, len, 14), opts.gunMaterial || defMat({ kind: 'gun' }));
  barrel.rotation.x = Math.PI / 2; barrel.position.z = len / 2; barrel.castShadow = true;
  gun.add(barrel);
  if (gd?.muzzleBrake) {
    const mb = new THREE.Mesh(new THREE.CylinderGeometry(r * 1.8, r * 1.8, r * 5, 12), barrel.material);
    mb.rotation.x = Math.PI / 2; mb.position.z = len - r * 2; gun.add(mb);
  }
  turret.add(gun);
  // stand-in running gear: road wheels inside each track
  if (opts.wheels !== false) {
    const tr = def.hull.track, W = def.hull.W, L = def.hull.L * (tr.len ?? 0.96);
    const n = tr.wheels || 5, wr = Math.min(tr.wheelR || 0.3, tr.h * 0.42);
    const wm = new THREE.MeshStandardMaterial({ color: 0x3a3b36, roughness: 0.8, metalness: 0.3 });
    const wg = new THREE.CylinderGeometry(wr, wr, tr.w * 1.02, 16);
    for (const side of [1, -1]) for (let i = 0; i < n; i++) {
      const w = new THREE.Mesh(wg, wm);
      w.rotation.z = Math.PI / 2;
      w.position.set(side * (W / 2 + tr.w / 2), wr + 0.02, -L / 2 + wr * 1.4 + (i / (n - 1)) * (L - wr * 2.8));
      w.visible = !opts.hideWheels;
      group.add(w);
    }
  }
  return { group, turret, gun, meshes, armor: a };
}

// Thickness → colour ramp (mm), like the in-game armour viewers: thin red → orange → yellow → green → blue.
const RAMP = [[0, 0xa32a1e], [15, 0xd6452b], [30, 0xe97d2c], [50, 0xf1c232], [80, 0x9ccc3b], [120, 0x3fae6a], [180, 0x2f8fbf], [250, 0x5b5fd0]];
const _c1 = new THREE.Color(), _c2 = new THREE.Color();
export function thicknessColor(mm, out = new THREE.Color()) {
  for (let i = 1; i < RAMP.length; i++) {
    if (mm <= RAMP[i][0]) {
      const f = (mm - RAMP[i - 1][0]) / (RAMP[i][0] - RAMP[i - 1][0]);
      return out.copy(_c1.setHex(RAMP[i - 1][1])).lerp(_c2.setHex(RAMP[i][1]), f);
    }
  }
  return out.setHex(RAMP[RAMP.length - 1][1]);
}
export const THICKNESS_RAMP = RAMP;
