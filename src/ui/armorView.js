// Armour inspector: the tank's armour solids coloured by thickness (nominal), or by effective
// thickness along the current line of sight (t / cos θ), with orbit-drag and a hover readout.
import * as THREE from 'three';
import { armorModel, paintFaces, thicknessColor } from './armorGeo.js';
import { disposeTree } from './hangar3d.js';

const PLATE_NAMES = {
  'hull.front.upper': 'Upper front plate', 'hull.front.lower': 'Lower front plate', 'hull.rear': 'Hull rear',
  'hull.side.lower': 'Lower hull side', 'hull.side.upper': 'Upper hull side (sponson)', 'hull.floor': 'Hull floor', 'hull.roof': 'Hull roof',
  'hull.sponson.floor': 'Sponson floor', track: 'Track (spaced)', 'turret.front': 'Turret front', 'turret.rear': 'Turret rear',
  'turret.side': 'Turret side', 'turret.cheek': 'Turret cheek', 'turret.roof': 'Turret roof', 'turret.open': 'Open top', 'turret.floor': 'Turret floor', mantlet: 'Gun mantlet',
};
export const plateName = (p) => PLATE_NAMES[p] || p;

export class ArmorView {
  constructor(container, def, { onHover } = {}) {
    this.container = container; this.onHover = onHover; this.mode = 'nominal';
    const canvas = this.canvas = document.createElement('canvas');
    canvas.className = 'armor-canvas';
    container.append(canvas);
    const r = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    r.setPixelRatio(Math.min(1.5, window.devicePixelRatio || 1));
    r.outputColorSpace = THREE.SRGBColorSpace;
    const s = this.scene = new THREE.Scene();
    s.add(new THREE.HemisphereLight(0xffffff, 0x404040, 2.2));
    const d = new THREE.DirectionalLight(0xffffff, 1.2); d.position.set(3, 6, 4); s.add(d);
    const grid = new THREE.GridHelper(20, 40, 0x4a5236, 0x262b20); grid.material.transparent = true; grid.material.opacity = 0.5; s.add(grid);
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
    this.orbit = { az: -0.8, el: 0.35, dist: 12 };
    this.ray = new THREE.Raycaster(); this.mouse = new THREE.Vector2(); this.hover = null;
    this._bind();
    this.setTank(def);
    this._ro = new ResizeObserver(() => this.resize()); this._ro.observe(container);
    this.resize();
  }
  setTank(def, gunIndex = 0) {
    if (this.model) { this.scene.remove(this.model.group); disposeTree(this.model.group); }
    const mat = () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.65, metalness: 0.05, flatShading: true, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
    this.model = armorModel(def, { material: mat, gunIndex, hideWheels: true, gunMaterial: new THREE.MeshStandardMaterial({ color: 0x3a3d38, roughness: 0.7 }) });
    for (const { mesh } of this.model.meshes) {
      const e = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, 1), new THREE.LineBasicMaterial({ color: 0x0b0d0b, transparent: true, opacity: 0.75 }));
      mesh.add(e);
    }
    this.scene.add(this.model.group);
    const box = new THREE.Box3().setFromObject(this.model.group), size = box.getSize(new THREE.Vector3());
    this.target = new THREE.Vector3(0, size.y * 0.45, 0);
    this.orbit.dist = Math.max(size.x, size.z) * 2.1;
    this.recolor(); this.render();
  }
  setMode(m) { this.mode = m; this.recolor(); this.render(); }

  // Effective thickness of plane p seen from the camera (towards the face centre).
  effective(plane, faceCentre) {
    const n = plane.n, c = this.camera.position;
    const v = new THREE.Vector3(c.x - faceCentre.x, c.y - faceCentre.y, c.z - faceCentre.z).normalize();
    const cos = Math.max(0.05, n[0] * v.x + n[1] * v.y + n[2] * v.z);
    return { eff: plane.t / cos, angle: Math.acos(Math.min(1, cos)) * 180 / Math.PI };
  }
  recolor() {
    const tmp = new THREE.Color(), grey = new THREE.Color(0x777b72);
    for (const { mesh, piece } of this.model.meshes) {
      const g = mesh.geometry;
      const centres = faceCentres(g, mesh);
      paintFaces(g, (pl) => {
        if (piece.kind === 'track') return tmp.copy(grey).multiplyScalar(0.8);
        if (this.mode === 'nominal' || pl.t === 0) return thicknessColor(pl.t, tmp);
        return thicknessColor(this.effective(pl, centres.get(pl)).eff, tmp);
      });
    }
  }
  resize() {
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false); this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); this.render();
  }
  render() {
    const o = this.orbit, c = this.camera, t = this.target;
    c.position.set(t.x + Math.sin(o.az) * Math.cos(o.el) * o.dist, t.y + Math.sin(o.el) * o.dist, t.z + Math.cos(o.az) * Math.cos(o.el) * o.dist);
    c.lookAt(t);
    this.renderer.render(this.scene, c);
  }
  view(name) {
    const v = { front: [0, 0.12], side: [Math.PI / 2, 0.08], rear: [Math.PI, 0.15], top: [0, 1.4], iso: [-0.8, 0.35] }[name];
    if (!v) return;
    [this.orbit.az, this.orbit.el] = v;
    if (this.mode === 'effective') this.recolor();
    this.render();
  }
  _bind() {
    const c = this.canvas; let drag = null;
    c.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY }; c.setPointerCapture(e.pointerId); });
    c.addEventListener('pointermove', (e) => {
      if (drag) {
        this.orbit.az -= (e.clientX - drag.x) * 0.008;
        this.orbit.el = Math.max(-0.2, Math.min(1.45, this.orbit.el + (e.clientY - drag.y) * 0.006));
        drag = { x: e.clientX, y: e.clientY };
        if (this.mode === 'effective') this.recolor();
        this.render();
      }
      this._pick(e);
    });
    const up = () => { drag = null; };
    c.addEventListener('pointerup', up); c.addEventListener('pointercancel', up);
    c.addEventListener('pointerleave', () => this.onHover?.(null));
    c.addEventListener('wheel', (e) => { e.preventDefault(); this.orbit.dist = Math.max(4, Math.min(30, this.orbit.dist * (1 + Math.sign(e.deltaY) * 0.1))); this.render(); }, { passive: false });
  }
  _pick(e) {
    const r = this.canvas.getBoundingClientRect();
    this.mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(this.mouse, this.camera);
    const hit = this.ray.intersectObjects(this.model.meshes.map((m) => m.mesh), false)[0];
    if (!hit) { this.onHover?.(null); return; }
    const g = hit.object.geometry, pl = g.userData.faces[g.userData.triFace[hit.faceIndex]];
    const piece = hit.object.userData.piece;
    const dir = this.ray.ray.direction;
    const cos = Math.max(0.02, -(pl.n[0] * dir.x + pl.n[1] * dir.y + pl.n[2] * dir.z));
    this.onHover?.({ plate: pl.plate, name: plateName(pl.plate), t: pl.t, eff: pl.t / cos, angle: Math.acos(Math.min(1, cos)) * 180 / Math.PI,
      spaced: piece.kind === 'track', x: e.clientX - r.left, y: e.clientY - r.top });
  }
  dispose() { this._ro.disconnect(); disposeTree(this.scene); this.renderer.dispose(); this.renderer.forceContextLoss?.(); this.canvas.remove(); }
}

// World-space centre of every face plane of a mesh (Map plane → Vector3).
function faceCentres(g, mesh) {
  if (g.userData.centres) return g.userData.centres;
  const pos = g.getAttribute('position'), tf = g.userData.triFace, faces = g.userData.faces;
  const acc = faces.map(() => [0, 0, 0, 0]);
  for (let t = 0; t < tf.length; t++) for (let k = 0; k < 3; k++) {
    const a = acc[tf[t]], i = t * 3 + k; a[0] += pos.getX(i); a[1] += pos.getY(i); a[2] += pos.getZ(i); a[3]++;
  }
  mesh.updateWorldMatrix(true, false);
  const m = new Map();
  faces.forEach((f, i) => { const a = acc[i]; m.set(f, new THREE.Vector3(a[0] / a[3], a[1] / a[3], a[2] / a[3]).applyMatrix4(mesh.matrixWorld)); });
  g.userData.centres = m;
  return m;
}
