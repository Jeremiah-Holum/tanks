// The garage: a dim hangar interior with a turntable, the selected tank on it, orbit-drag camera
// and an open door glowing with daylight behind. Uses buildTankModel() from
// src/render/tankModel.js when it exists, else a stand-in built from the armour solids.
// Also renders carousel thumbnails (thumb(def) → dataURL) with the same renderer.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { armorModel } from './armorGeo.js';
import { NATIONS } from '../meta/roster.js';

let tankModelMod; // undefined = not tried, null = unavailable
async function loadTankModel() {
  if (tankModelMod !== undefined) return tankModelMod;
  try { tankModelMod = await import('../render/tankModel.js'); if (!tankModelMod.buildTankModel) tankModelMod = null; } catch { tankModelMod = null; }
  return tankModelMod;
}

function canvasTex(w, h, draw, repeat = [1, 1]) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(...repeat);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}
// Deterministic noise for textures
function rnd(seed) { let s = seed; return () => ((s = (s * 16807) % 2147483647) / 2147483647); }

function concrete(ctx, w, h) {
  const r = rnd(7);
  ctx.fillStyle = '#5d5f5b'; ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 2600; i++) {
    const x = r() * w, y = r() * h, s = 1 + r() * 3;
    ctx.fillStyle = `rgba(${r() < 0.5 ? '20,20,18' : '120,120,112'},${0.05 + r() * 0.1})`; ctx.fillRect(x, y, s, s);
  }
  for (let i = 0; i < 26; i++) { // oil stains
    const x = r() * w, y = r() * h, rad = 10 + r() * 50;
    const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, 'rgba(15,14,12,0.35)'); g.addColorStop(1, 'rgba(15,14,12,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, rad, 0, 7); ctx.fill();
  }
  ctx.strokeStyle = 'rgba(20,20,20,0.45)'; ctx.lineWidth = 2; // slab joints
  for (let i = 0; i <= 4; i++) { ctx.beginPath(); ctx.moveTo(i * w / 4, 0); ctx.lineTo(i * w / 4, h); ctx.stroke(); ctx.beginPath(); ctx.moveTo(0, i * h / 4); ctx.lineTo(w, i * h / 4); ctx.stroke(); }
}
function corrugated(ctx, w, h) {
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#2c302d'); g.addColorStop(1, '#3a3e39');
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  for (let x = 0; x < w; x += 8) {
    const lg = ctx.createLinearGradient(x, 0, x + 8, 0);
    lg.addColorStop(0, 'rgba(255,255,255,0.06)'); lg.addColorStop(0.5, 'rgba(0,0,0,0.18)'); lg.addColorStop(1, 'rgba(255,255,255,0.06)');
    ctx.fillStyle = lg; ctx.fillRect(x, 0, 8, h);
  }
  const r = rnd(3);
  for (let i = 0; i < 60; i++) { ctx.fillStyle = `rgba(90,60,30,${r() * 0.12})`; ctx.fillRect(r() * w, r() * h, 3 + r() * 20, 10 + r() * 80); }
}
function hazard(ctx, w, h) {
  ctx.fillStyle = '#d9a21a'; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#161616';
  for (let x = -h; x < w + h; x += h * 1.2) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + h * 0.6, 0); ctx.lineTo(x + h * 1.2 - h * 0.6 + h * 0.6 - h, h); ctx.lineTo(x - h * 0.6 + h * 0.6 - h * 0.6, h); ctx.fill(); }
}
function doorSky(ctx, w, h) {
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#f6e7c4'); g.addColorStop(0.55, '#f2d9a4'); g.addColorStop(0.62, '#8a9a6a'); g.addColorStop(1, '#5d6b45');
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  const r = rnd(11);
  ctx.fillStyle = 'rgba(70,86,52,0.9)';
  for (let x = 0; x < w; x += 6) { const th = 20 + r() * 50 + Math.sin(x * 0.02) * 20; ctx.fillRect(x, h * 0.6 - th, 7, th); }
}

export class HangarScene {
  constructor(container) {
    this.container = container;
    const canvas = this.canvas = document.createElement('canvas');
    canvas.className = 'hangar-canvas';
    container.prepend(canvas);
    const r = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: true });
    r.setPixelRatio(Math.min(1.5, window.devicePixelRatio || 1));
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping; r.toneMappingExposure = 1.05;
    r.shadowMap.enabled = true; r.shadowMap.type = THREE.PCFSoftShadowMap;
    const scene = this.scene = new THREE.Scene();
    scene.background = new THREE.Color(0x121412);
    scene.fog = new THREE.Fog(0x141613, 16, 42);
    const pm = new THREE.PMREMGenerator(r);
    this.env = pm.fromScene(new RoomEnvironment(), 0.04).texture; pm.dispose();
    scene.environment = this.env; scene.environmentIntensity = 0.35;
    this.camera = new THREE.PerspectiveCamera(32, 1, 0.1, 120);
    this.orbit = { az: -0.75, el: 0.2, dist: 11, tAz: -0.75, tEl: 0.2, tDist: 11, target: new THREE.Vector3(0, 1.1, 0) };
    this.spin = 0; this.idle = 0;
    this._build();
    this._bindInput();
    this.resize();
    this._ro = new ResizeObserver(() => this.resize()); this._ro.observe(container);
    this.running = false;
    this._loop = this._loop.bind(this);
    this.clock = new THREE.Clock();
  }

  _build() {
    const s = this.scene;
    // floor
    const floorTex = canvasTex(512, 512, concrete, [5, 5]);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.82, metalness: 0.05 }));
    floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; s.add(floor);
    // painted bay lines
    const lineMat = new THREE.MeshStandardMaterial({ color: 0xc7951f, roughness: 0.7 });
    for (const x of [-6.2, 6.2]) { const l = new THREE.Mesh(new THREE.PlaneGeometry(0.18, 26), lineMat); l.rotation.x = -Math.PI / 2; l.position.set(x, 0.005, 0); s.add(l); }
    // walls: back wall with a big open door, side walls
    const wallTex = canvasTex(512, 256, corrugated, [6, 1]);
    const wallMat = new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.6, metalness: 0.5, side: THREE.DoubleSide });
    const back = new THREE.Group();
    const seg = (w, h, x, y) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), wallMat); m.position.set(x, y, 0); back.add(m); };
    seg(10, 12, -12, 6); seg(10, 12, 12, 6); seg(14, 5, 0, 9.5);
    back.position.z = -14; s.add(back);
    const door = new THREE.Mesh(new THREE.PlaneGeometry(14, 7), new THREE.MeshBasicMaterial({ map: canvasTex(512, 256, doorSky), fog: false }));
    door.position.set(0, 3.5, -14.6); s.add(door);
    for (const x of [-18, 18]) {
      const side = new THREE.Mesh(new THREE.PlaneGeometry(40, 12), wallMat);
      side.rotation.y = x < 0 ? Math.PI / 2 : -Math.PI / 2; side.position.set(x, 6, 4); s.add(side);
    }
    // steel columns and roof trusses
    const steel = new THREE.MeshStandardMaterial({ color: 0x3b403c, roughness: 0.5, metalness: 0.7 });
    for (const x of [-7, 7]) for (const z of [-13.6, -4, 6]) {
      const c = new THREE.Mesh(new THREE.BoxGeometry(0.45, 12, 0.45), steel); c.position.set(x * (z < -13 ? 1 : 1.9), 6, z); c.castShadow = true; s.add(c);
    }
    for (const z of [-10, -3, 4]) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(36, 0.5, 0.35), steel); b.position.set(0, 9.2, z); s.add(b);
      const lamp = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.8, 0.35, 16, 1, true), steel); lamp.position.set(0, 8.4, z); s.add(lamp);
      const bulb = new THREE.Mesh(new THREE.CircleGeometry(0.48, 16), new THREE.MeshBasicMaterial({ color: 0xffe2a8 }));
      bulb.rotation.x = Math.PI / 2; bulb.position.set(0, 8.24, z); s.add(bulb);
    }
    // crates and barrels for a lived-in look
    const crateMat = new THREE.MeshStandardMaterial({ color: 0x4d4a32, roughness: 0.85 });
    const barrelMat = new THREE.MeshStandardMaterial({ color: 0x3d4a2a, roughness: 0.6, metalness: 0.4 });
    for (const [x, z, sy] of [[-9.5, -9, 1], [-10.6, -8.2, 0.8], [-9.8, -7.5, 0.7], [9.2, -10.5, 1.1]]) {
      const c = new THREE.Mesh(new THREE.BoxGeometry(1.2 * sy, 1.0 * sy, 1.2 * sy), crateMat); c.position.set(x, 0.5 * sy, z); c.rotation.y = x * 0.3; c.castShadow = c.receiveShadow = true; s.add(c);
    }
    for (const [x, z] of [[10.5, -8], [11.2, -7.2], [10.3, -6.8]]) {
      const b = new THREE.Mesh(new THREE.CylinderGeometry(0.33, 0.33, 0.95, 16), barrelMat); b.position.set(x, 0.475, z); b.castShadow = true; s.add(b);
    }
    // turntable
    const table = this.table = new THREE.Group();
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(4.6, 4.75, 0.22, 64), new THREE.MeshStandardMaterial({ color: 0x2c302d, roughness: 0.45, metalness: 0.75 }));
    disc.position.y = 0.11; disc.receiveShadow = true; table.add(disc);
    const plate = new THREE.Mesh(new THREE.CylinderGeometry(4.3, 4.3, 0.02, 64), new THREE.MeshStandardMaterial({ map: canvasTex(256, 256, (c, w, h) => {
      c.fillStyle = '#353a36'; c.fillRect(0, 0, w, h);
      c.strokeStyle = 'rgba(0,0,0,0.35)'; c.lineWidth = 2;
      for (let i = 0; i < w; i += 16) { c.beginPath(); c.moveTo(i, 0); c.lineTo(i, h); c.stroke(); } // tread plate
      for (let y = 0; y < h; y += 16) for (let x = 0; x < w; x += 16) { c.fillStyle = 'rgba(255,255,255,0.06)'; c.fillRect(x + 4, y + 6, 8, 3); }
    }, [3, 3]), roughness: 0.55, metalness: 0.6 }));
    plate.position.y = 0.23; plate.receiveShadow = true; table.add(plate);
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(4.78, 4.78, 0.2, 64, 1, true), new THREE.MeshStandardMaterial({ map: canvasTex(512, 32, hazard, [8, 1]), roughness: 0.6 }));
    ring.position.y = 0.1; table.add(ring);
    this.tankHolder = new THREE.Group(); this.tankHolder.position.y = 0.24; table.add(this.tankHolder);
    s.add(table);
    // lights
    s.add(new THREE.HemisphereLight(0x9aa6b8, 0x2a241c, 0.55));
    const key = this.key = new THREE.SpotLight(0xfff0d8, 420, 40, 0.62, 0.55, 1.6);
    key.position.set(4.5, 10.5, 7); key.target.position.set(0, 0.5, 0);
    key.castShadow = true; key.shadow.mapSize.set(1024, 1024); key.shadow.bias = -0.0004; key.shadow.normalBias = 0.02;
    s.add(key, key.target);
    const rim = new THREE.DirectionalLight(0xffd9a0, 1.6); rim.position.set(-2, 5, -12); s.add(rim);
    const fill = new THREE.PointLight(0x8fb4ff, 30, 18, 1.8); fill.position.set(-7, 3.5, 5); s.add(fill);
    const warm = new THREE.PointLight(0xffb266, 22, 14, 1.8); warm.position.set(8, 2.5, -4); s.add(warm);
    for (const z of [-10, -3, 4]) { const p = new THREE.PointLight(0xffe2a8, 14, 12, 2); p.position.set(0, 7.8, z); s.add(p); }
  }

  _bindInput() {
    const c = this.canvas; let drag = null;
    c.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY }; c.setPointerCapture(e.pointerId); c.classList.add('dragging'); });
    c.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const o = this.orbit;
      o.tAz -= (e.clientX - drag.x) * 0.006; o.tEl = Math.max(0.02, Math.min(0.85, o.tEl + (e.clientY - drag.y) * 0.004));
      drag = { x: e.clientX, y: e.clientY }; this.idle = 0;
    });
    const up = () => { drag = null; c.classList.remove('dragging'); };
    c.addEventListener('pointerup', up); c.addEventListener('pointercancel', up);
    c.addEventListener('wheel', (e) => { e.preventDefault(); const o = this.orbit; o.tDist = Math.max(this.minDist, Math.min(this.maxDist, o.tDist * (1 + Math.sign(e.deltaY) * 0.1))); this.idle = 0; }, { passive: false });
  }

  resize() {
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // frame the tank slightly above centre (the carousel covers the bottom)
    this.camera.setViewOffset(w, h, 0, h * 0.06, w, h);
    this.camera.updateProjectionMatrix();
  }

  async setTank(def, opts = {}) {
    const token = this._token = {};
    const paint = NATIONS[def.nation]?.paint ?? 0x4b5a32;
    let model = null;
    const mod = await loadTankModel();
    if (token !== this._token) return;
    if (mod) { try { model = mod.buildTankModel(def, { paint, lod: 0, gunIndex: opts.gun || 0 }); } catch (e) { console.warn('[hangar] buildTankModel failed', e); } }
    const group = model ? model.group : armorModel(def, { paint, gunIndex: opts.gun || 0 }).group;
    group.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    if (this.model) { this.tankHolder.remove(this.modelGroup); this.model.dispose?.(); disposeTree(this.modelGroup); }
    this.model = model; this.modelGroup = group;
    this.tankHolder.add(group);
    // frame: distance from the tank's size
    const box = new THREE.Box3().setFromObject(group), size = box.getSize(new THREE.Vector3());
    const r = Math.max(size.x, size.z * 0.9, size.y * 1.6);
    this.minDist = r * 1.3; this.maxDist = r * 3.4;
    this.orbit.tDist = r * 2.05; this.orbit.target.set(0, Math.max(0.9, size.y * 0.5), 0);
    if (opts.snap) this.orbit.dist = this.orbit.tDist;
    this.renderOnce();
  }

  start() { if (this.running) return; this.running = true; this.clock.getDelta(); requestAnimationFrame(this._loop); }
  stop() { this.running = false; }
  _loop() {
    if (!this.running) return;
    const dt = Math.min(0.05, this.clock.getDelta());
    this.idle += dt;
    if (this.idle > 4) this.table.rotation.y += dt * 0.12;
    this.renderOnce(dt);
    requestAnimationFrame(this._loop);
  }
  renderOnce(dt = 1) {
    const o = this.orbit, k = Math.min(1, dt * 8);
    o.az += (o.tAz - o.az) * k; o.el += (o.tEl - o.el) * k; o.dist += (o.tDist - o.dist) * k;
    const c = this.camera;
    c.position.set(o.target.x + Math.sin(o.az) * Math.cos(o.el) * o.dist, o.target.y + Math.sin(o.el) * o.dist, o.target.z + Math.cos(o.az) * Math.cos(o.el) * o.dist);
    c.lookAt(o.target);
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.scene, c);
  }

  // Thumbnail of a tank for the carousel (transparent background, 3/4 front view).
  async thumb(def, w = 256, h = 128) {
    const mod = await loadTankModel();
    const paint = NATIONS[def.nation]?.paint ?? 0x4b5a32;
    let model = null;
    if (mod) try { model = mod.buildTankModel(def, { paint, lod: 1 }); } catch { model = null; }
    const group = model ? model.group : armorModel(def, { paint }).group;
    if (!this._thumbScene) {
      const s = this._thumbScene = new THREE.Scene();
      s.environment = this.env; s.environmentIntensity = 0.5;
      s.add(new THREE.HemisphereLight(0xdde6ff, 0x3a3226, 1.2));
      const d = new THREE.DirectionalLight(0xfff0d8, 2.4); d.position.set(4, 6, 5); s.add(d);
      this._thumbCam = new THREE.PerspectiveCamera(24, w / h, 0.1, 100);
      this._rt = new THREE.WebGLRenderTarget(w * 2, h * 2, { samples: 4 });
      this._rt.texture.colorSpace = THREE.SRGBColorSpace;
    }
    const s = this._thumbScene, cam = this._thumbCam;
    s.add(group);
    const box = new THREE.Box3().setFromObject(group), size = box.getSize(new THREE.Vector3()), ctr = box.getCenter(new THREE.Vector3());
    const r = Math.max(size.x, size.y, size.z);
    cam.position.set(ctr.x + r * 1.55, ctr.y + r * 0.55, ctr.z + r * 1.9); cam.lookAt(ctr.x, ctr.y - r * 0.02, ctr.z);
    const rr = this.renderer, prevClear = rr.getClearAlpha(), prevColor = rr.getClearColor(new THREE.Color());
    rr.setRenderTarget(this._rt); rr.setClearColor(0x000000, 0); rr.clear(); rr.render(s, cam);
    const W = w * 2, H = h * 2, buf = new Uint8Array(W * H * 4);
    rr.readRenderTargetPixels(this._rt, 0, 0, W, H, buf);
    rr.setRenderTarget(null); rr.setClearColor(prevColor, prevClear);
    s.remove(group); model?.dispose?.(); disposeTree(group);
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d'), img = ctx.createImageData(W, H);
    for (let y = 0; y < H; y++) img.data.set(buf.subarray((H - 1 - y) * W * 4, (H - y) * W * 4), y * W * 4);
    ctx.putImageData(img, 0, 0);
    return cv.toDataURL('image/png');
  }

  dispose() {
    this.stop(); this._ro.disconnect();
    disposeTree(this.scene); this.env.dispose(); this._rt?.dispose();
    this.renderer.dispose(); this.renderer.forceContextLoss?.();
    this.canvas.remove();
  }
}

export function disposeTree(o) {
  o.traverse?.((m) => {
    if (m.geometry) m.geometry.dispose();
    if (m.material) for (const mat of [].concat(m.material)) { for (const k in mat) if (mat[k]?.isTexture) mat[k].dispose(); mat.dispose(); }
  });
}
