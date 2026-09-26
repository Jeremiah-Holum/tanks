// Decals: shell craters / scorch marks on the ground (one instanced mesh, ring buffer) and hit
// scars on tanks (penetration holes, non-pen gouges, ricochet streaks) parented to the hull or
// turret so they move with it.
//   const g = new GroundDecals(scene, quality); g.add(pos, normal, size, kind)   // kind: 'crater'|'scorch'|'hole'|'splat'
//   const s = new TankScars(); s.add(model, part /* 'hull'|'turret' */, worldPos, worldNormal, size, kind)  // 'pen'|'nopen'|'ricochet'
import * as THREE from 'three';

function canvas(n) { const c = document.createElement('canvas'); c.width = c.height = n; return c; }
let _groundTex = null, _scarTex = null;
const rnd = (() => { let s = 12345; return () => ((s = (s * 16807) % 2147483647) / 2147483647); })();

// 2×2 atlas: crater, HE scorch, small hole, dirt splatter.
function groundTex() {
  if (_groundTex) return _groundTex;
  const N = 512, h = N / 2, c = canvas(N), g = c.getContext('2d');
  const blob = (cx, cy, r, col, n = 18, jit = 0.35) => {
    g.fillStyle = col; g.beginPath();
    for (let k = 0; k <= n; k++) { const a = k / n * Math.PI * 2, rr = r * (1 - jit / 2 + rnd() * jit); g.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr); }
    g.fill();
  };
  const tile = (tx, ty, fn) => { g.save(); g.translate(tx * h, ty * h); fn(); g.restore(); };
  tile(0, 0, () => { // crater: thrown dirt ring, dark scorched bowl
    for (let k = 0; k < 26; k++) { const a = rnd() * 6.28, d = 60 + rnd() * 50; blob(128 + Math.cos(a) * d, 128 + Math.sin(a) * d, 8 + rnd() * 16, `rgba(60,45,30,${0.4 + rnd() * 0.4})`, 10); }
    const gr = g.createRadialGradient(128, 128, 5, 128, 128, 90);
    gr.addColorStop(0, 'rgba(12,10,8,0.95)'); gr.addColorStop(0.55, 'rgba(35,28,20,0.9)'); gr.addColorStop(0.8, 'rgba(70,55,38,0.7)'); gr.addColorStop(1, 'rgba(70,55,38,0)');
    g.fillStyle = gr; g.beginPath(); g.arc(128, 128, 90, 0, 7); g.fill();
  });
  tile(1, 0, () => { // HE scorch: black star burst
    for (let k = 0; k < 40; k++) {
      const a = rnd() * 6.28, L = 50 + rnd() * 70;
      g.strokeStyle = `rgba(10,9,8,${0.25 + rnd() * 0.35})`; g.lineWidth = 3 + rnd() * 9;
      g.beginPath(); g.moveTo(128, 128); g.lineTo(128 + Math.cos(a) * L, 128 + Math.sin(a) * L); g.stroke();
    }
    const gr = g.createRadialGradient(128, 128, 5, 128, 128, 80);
    gr.addColorStop(0, 'rgba(8,7,6,0.95)'); gr.addColorStop(0.6, 'rgba(15,13,11,0.75)'); gr.addColorStop(1, 'rgba(15,13,11,0)');
    g.fillStyle = gr; g.beginPath(); g.arc(128, 128, 80, 0, 7); g.fill();
  });
  tile(0, 1, () => { // small hole
    const gr = g.createRadialGradient(128, 128, 4, 128, 128, 70);
    gr.addColorStop(0, 'rgba(10,8,6,1)'); gr.addColorStop(0.4, 'rgba(40,32,22,0.85)'); gr.addColorStop(1, 'rgba(60,48,34,0)');
    g.fillStyle = gr; g.beginPath(); g.arc(128, 128, 70, 0, 7); g.fill();
  });
  tile(1, 1, () => { // dirt splatter
    for (let k = 0; k < 40; k++) { const a = rnd() * 6.28, d = rnd() * 100; blob(128 + Math.cos(a) * d, 128 + Math.sin(a) * d, 4 + rnd() * 12, `rgba(55,42,28,${0.35 + rnd() * 0.45})`, 8); }
  });
  _groundTex = new THREE.CanvasTexture(c);
  _groundTex.colorSpace = THREE.SRGBColorSpace; _groundTex.anisotropy = 4;
  return _groundTex;
}
const TILE = { crater: [0, 1], scorch: [1, 1], hole: [0, 0], splat: [1, 0] }; // uv offsets (flipY: canvas top row = v 0.5..1)

export class GroundDecals {
  constructor(scene, quality = 'medium') {
    this.max = quality === 'low' ? 60 : quality === 'high' ? 260 : 150;
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    this.tile = new Float32Array(this.max * 2);
    geo.setAttribute('aTile', new THREE.InstancedBufferAttribute(this.tile, 2));
    const mat = new THREE.MeshStandardMaterial({
      map: groundTex(), transparent: true, depthWrite: false, roughness: 1, metalness: 0,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    });
    mat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec2 aTile;')
        .replace('#include <uv_vertex>', '#include <uv_vertex>\n#ifdef USE_MAP\nvMapUv = vMapUv * 0.5 + aTile * 0.5;\n#endif');
    };
    mat.customProgramCacheKey = () => 'steelfront-ground-decal';
    this.mesh = new THREE.InstancedMesh(geo, mat, this.max);
    this.mesh.count = 0; this.mesh.frustumCulled = false; this.mesh.receiveShadow = true;
    this.mesh.renderOrder = 1;
    scene.add(this.mesh);
    this.next = 0;
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._q2 = new THREE.Quaternion(); this._up = new THREE.Vector3(0, 1, 0); this._n = new THREE.Vector3();
  }
  add(pos, normal, size = 1, kind = 'crater') {
    const i = this.next; this.next = (this.next + 1) % this.max;
    this._n.set(normal?.x ?? 0, normal?.y ?? 1, normal?.z ?? 0).normalize();
    this._q.setFromUnitVectors(this._up, this._n);
    this._q2.setFromAxisAngle(this._up, Math.random() * Math.PI * 2);
    this._q.multiply(this._q2);
    this._m.compose(new THREE.Vector3(pos.x + this._n.x * 0.03, pos.y + this._n.y * 0.03, pos.z + this._n.z * 0.03), this._q, new THREE.Vector3(size, 1, size));
    this.mesh.setMatrixAt(i, this._m);
    const t = TILE[kind] || TILE.crater;
    this.tile[i * 2] = t[0]; this.tile[i * 2 + 1] = t[1];
    this.mesh.geometry.attributes.aTile.needsUpdate = true;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.count = Math.max(this.mesh.count, i + 1);
  }
  clear() { this.mesh.count = 0; this.next = 0; }
  dispose() { this.mesh.removeFromParent(); this.mesh.geometry.dispose(); this.mesh.material.dispose(); }
}

// ------------------------------------------------------------------ tank scars
// Atlas 256×128 (flipY): [pen hole | non-pen gouge] on the top row, ricochet streak below.
function scarTex() {
  if (_scarTex) return _scarTex;
  const c = document.createElement('canvas'); c.width = 256; c.height = 256;
  const g = c.getContext('2d');
  // pen: jagged black hole, torn bright rim, scorch
  let gr = g.createRadialGradient(64, 64, 2, 64, 64, 60);
  gr.addColorStop(0, 'rgba(0,0,0,1)'); gr.addColorStop(0.28, 'rgba(8,6,5,1)'); gr.addColorStop(0.36, 'rgba(150,140,125,1)');
  gr.addColorStop(0.45, 'rgba(40,34,30,0.9)'); gr.addColorStop(1, 'rgba(20,16,14,0)');
  g.fillStyle = gr; g.beginPath(); g.arc(64, 64, 60, 0, 7); g.fill();
  // non-pen: bright metal gouge with dark rim
  gr = g.createRadialGradient(192, 64, 2, 192, 64, 56);
  gr.addColorStop(0, 'rgba(190,182,168,1)'); gr.addColorStop(0.35, 'rgba(120,112,100,1)'); gr.addColorStop(0.55, 'rgba(35,30,26,0.8)'); gr.addColorStop(1, 'rgba(30,26,22,0)');
  g.fillStyle = gr; g.beginPath(); g.arc(192, 64, 56, 0, 7); g.fill();
  // ricochet: elongated shiny streak
  g.save(); g.translate(128, 192); g.scale(1, 0.22);
  gr = g.createRadialGradient(0, 0, 2, 0, 0, 120);
  gr.addColorStop(0, 'rgba(200,192,178,1)'); gr.addColorStop(0.4, 'rgba(110,104,95,0.9)'); gr.addColorStop(1, 'rgba(40,35,30,0)');
  g.fillStyle = gr; g.beginPath(); g.arc(0, 0, 120, 0, 7); g.fill(); g.restore();
  _scarTex = new THREE.CanvasTexture(c); _scarTex.colorSpace = THREE.SRGBColorSpace;
  return _scarTex;
}
let _scarMat = null;
const scarMat = () => _scarMat || (_scarMat = new THREE.MeshStandardMaterial({
  map: scarTex(), transparent: true, alphaTest: 0.08, depthWrite: false, roughness: 0.6, metalness: 0.4,
  polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide,
}));
// A throwaway scar mesh for BattleView.warmup (compiles the scar shader and uploads its texture at load).
export function scarWarmMesh() {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(12), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(8), 2));
  g.setIndex([0, 1, 2, 0, 2, 3]); g.setDrawRange(0, 0);
  const m = new THREE.Mesh(g, scarMat()); m.frustumCulled = false; m.name = 'scars-warm';
  return m;
}
const SCAR_UV = { pen: [0, 0.5, 0.5, 1], nopen: [0.5, 0.5, 1, 1], ricochet: [0, 0, 1, 0.5] };
const MAXS = 24;
const _inv = new THREE.Matrix4(), _p = new THREE.Vector3(), _nv = new THREE.Vector3(), _t = new THREE.Vector3(), _b = new THREE.Vector3();
export class TankScars {
  // part: an Object3D (hull body or turret mesh) of a tank model.
  add(part, worldPos, worldNormal, size = 0.25, kind = 'nopen', dir = null) {
    if (!part) return;
    let m = part.userData.scars;
    if (!m) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAXS * 12), 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(MAXS * 12), 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(MAXS * 8), 2));
      const idx = []; for (let k = 0; k < MAXS; k++) idx.push(k * 4, k * 4 + 1, k * 4 + 2, k * 4, k * 4 + 2, k * 4 + 3);
      geo.setIndex(idx); geo.setDrawRange(0, 0);
      m = new THREE.Mesh(geo, scarMat()); m.name = 'scars'; m.frustumCulled = false; m.userData.n = 0;
      part.add(m); part.userData.scars = m;
    }
    part.updateWorldMatrix(true, false);
    _inv.copy(part.matrixWorld).invert();
    _p.set(worldPos.x, worldPos.y, worldPos.z).applyMatrix4(_inv);
    _nv.set(worldNormal.x, worldNormal.y, worldNormal.z).transformDirection(_inv);
    // tangent: along the shell direction projected on the plate (ricochet streaks), else arbitrary
    if (dir) _t.set(dir.x, dir.y, dir.z).transformDirection(_inv); else _t.set(0, 1, 0);
    _t.addScaledVector(_nv, -_t.dot(_nv));
    if (_t.lengthSq() < 1e-4) { _t.set(1, 0, 0).addScaledVector(_nv, -_nv.x); }
    _t.normalize(); _b.crossVectors(_nv, _t);
    const k = m.userData.n % MAXS; m.userData.n++;
    const pos = m.geometry.attributes.position, nor = m.geometry.attributes.normal, uv = m.geometry.attributes.uv;
    const [u0, v0, u1, v1] = SCAR_UV[kind] || SCAR_UV.nopen;
    const sx = kind === 'ricochet' ? size * 2.4 : size, sy = size;
    const corners = [[-1, -1, u0, v0], [1, -1, u1, v0], [1, 1, u1, v1], [-1, 1, u0, v1]];
    corners.forEach(([a, b, u, v], j) => {
      pos.setXYZ(k * 4 + j, _p.x + _t.x * a * sx / 2 + _b.x * b * sy / 2 + _nv.x * 0.006, _p.y + _t.y * a * sx / 2 + _b.y * b * sy / 2 + _nv.y * 0.006, _p.z + _t.z * a * sx / 2 + _b.z * b * sy / 2 + _nv.z * 0.006);
      nor.setXYZ(k * 4 + j, _nv.x, _nv.y, _nv.z); uv.setXY(k * 4 + j, u, v);
    });
    // make the winding face outwards
    pos.needsUpdate = nor.needsUpdate = uv.needsUpdate = true;
    m.geometry.setDrawRange(0, Math.min(m.userData.n, MAXS) * 6);
  }
}
