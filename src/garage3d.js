// Garage product shots: the real die-cast class models (render/models.js buildTank) lit like a
// toy catalogue photo. One small WebGLRenderer serves every card; it is created when the garage
// opens and disposed when it closes. Unselected cards get a still (a data-URL image rendered once);
// the selected card shows the live canvas swaying slowly on its stand. If WebGL is unavailable
// the caller keeps its flat SVG silhouettes.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { buildTank } from './render/models.js';
import { kitFor } from './sim/tanks.js';

// every class is fitted to the frame, then set back a touch by size so a Heavy still reads big
const SIZE_HINT = { light: 1.12, medium: 1.05, heavy: 1.0, td: 1.03 };
const HERO_YAW = -0.6;
const SWAY = 0.5;         // live view swings ±SWAY rad about the hero angle    // 3/4 front view: nose toward the viewer's right

export class Studio {
  // opts: { color, trim, emblem, w, h (CSS px), still (true = never animate) }
  constructor({ color = 0x3d6fc4, trim = 0xe9f1ff, emblem = 'star', w = 240, h = 140, still = false } = {}) {
    this.w = w; this.h = h; this.still = still;
    this.paint = { color, trim, emblem };
    const canvas = document.createElement('canvas');
    canvas.className = 'studio-live';
    const r = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true, powerPreference: 'low-power' });
    r.setPixelRatio(Math.min(2, Math.max(1.5, window.devicePixelRatio || 1)));
    r.setSize(w, h);
    r.setClearColor(0x000000, 0);
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.NeutralToneMapping;
    r.toneMappingExposure = 0.95;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    this.canvas = canvas;

    const scene = this.scene = new THREE.Scene();
    const pm = new THREE.PMREMGenerator(r);
    this.env = pm.fromScene(new RoomEnvironment(), 0.03).texture;
    pm.dispose();
    scene.environment = this.env;
    scene.environmentIntensity = 0.5;

    // three-point studio light: warm key high front-left, cool rim behind, soft fill
    const key = new THREE.DirectionalLight(0xfff1dc, 2.6);
    key.position.set(1.6, 3.2, 2.2);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.radius = 6;
    key.shadow.bias = -0.0006;
    Object.assign(key.shadow.camera, { left: -1.4, right: 1.4, top: 1.4, bottom: -1.4, near: 0.5, far: 8 });
    const rim = new THREE.DirectionalLight(0xcfe0ff, 2.2); rim.position.set(-2.2, 1.6, -2.4);
    const fill = new THREE.HemisphereLight(0xfff8ee, 0x6b5a3e, 0.35);
    scene.add(key, rim, fill);

    // the "stand": a shadow-catcher plus a soft contact blot
    const ground = new THREE.Mesh(new THREE.CircleGeometry(1.3, 48), new THREE.ShadowMaterial({ opacity: 0.32 }));
    ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true;
    const blotTex = contactTexture();
    const blot = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 1.0), new THREE.MeshBasicMaterial({ map: blotTex, transparent: true, depthWrite: false, opacity: 0.75 }));
    blot.rotation.x = -Math.PI / 2; blot.position.y = 0.002;
    scene.add(ground, blot);
    this.stage = [ground, blot, blotTex];

    this.camera = new THREE.PerspectiveCamera(24, w / h, 0.05, 20);
    this.tanks = {};
    this.cur = null;
    this.yaw = HERO_YAW;
    this._raf = 0;
  }

  static create(opts) {
    try { return new Studio(opts); } catch (e) { return null; }
  }

  _tank(cls) {
    if (this.tanks[cls]) return this.tanks[cls];
    const type = { ...kitFor('player', cls), color: this.paint.color, trim: this.paint.trim };
    const root = buildTank(type, { emblem: this.paint.emblem });
    root.traverse((o) => { if (o.isMesh && o.layers.isEnabled(0)) o.castShadow = true; });
    // frame on the hull + turret + gun (not the whip antenna), rotation-invariant so the
    // turntable never clips: a bounding sphere around the box centre
    // the whip antenna would poke out of the frame: product shots show the tank without it
    // (Box3.setFromObject ignores `visible`, so the antenna comes off while measuring)
    const ant = root.userData.ant, antParent = ant && ant.parent;
    if (ant) { ant.visible = false; antParent.remove(ant); }
    root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(root, true);
    if (ant) antParent.add(ant);
    const c = box.getCenter(new THREE.Vector3()), sz = box.getSize(new THREE.Vector3());
    root.userData.frame = { c, box, h: sz.y };
    this.tanks[cls] = root;
    return root;
  }

  // Place the tank at `yaw` and frame it: one camera distance for every class (fitted to the
  // biggest, so a Heavy looks heavier than a Light), then pan so the model sits centred.
  _show(cls, yaw) {
    if (this.cur && this.cur !== this.tanks[cls]) this.scene.remove(this.cur);
    const t = this._tank(cls);
    if (t.parent !== this.scene) this.scene.add(t);
    this.cur = t;
    if (!t.userData.D) t.userData.D = this._fitDistance(t) * (SIZE_HINT[cls] || 1);
    this._place(t, yaw, t.userData.D);
    const e = this._ndc(t);
    const cam = this.camera, dist = cam.position.distanceTo(this._target);
    const hh = dist * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)), hw = hh * cam.aspect;
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0), up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
    const pan = right.multiplyScalar((e.x0 + e.x1) / 2 * hw).add(up.multiplyScalar(((e.y0 + e.y1) / 2 + 0.1) * hh));
    cam.position.add(pan); this._target.add(pan); cam.lookAt(this._target);
  }
  _place(t, yaw, d) {
    const F = t.userData.frame;
    t.rotation.y = yaw;
    t.position.set(-F.c.x * Math.cos(yaw) - F.c.z * Math.sin(yaw), 0, F.c.x * Math.sin(yaw) - F.c.z * Math.cos(yaw));
    const ty = F.h * 0.45;
    this._target = new THREE.Vector3(0, ty, 0);
    this.camera.position.set(0, ty + d * 0.36, d);
    this.camera.lookAt(this._target);
    this.camera.updateMatrixWorld(); t.updateMatrixWorld(true);
  }
  // projected bounds of the model's box, in NDC
  _ndc(t) {
    // the tight box measured at rest (scale included), turned and moved like the tank
    const box = t.userData.frame.box, v = new THREE.Vector3();
    const m = new THREE.Matrix4().makeRotationY(t.rotation.y).setPosition(t.position);
    const e = { x0: 1e9, x1: -1e9, y0: 1e9, y1: -1e9 };
    for (let k = 0; k < 8; k++) {
      v.set(k & 1 ? box.max.x : box.min.x, k & 2 ? box.max.y : box.min.y, k & 4 ? box.max.z : box.min.z).applyMatrix4(m).project(this.camera);
      e.x0 = Math.min(e.x0, v.x); e.x1 = Math.max(e.x1, v.x); e.y0 = Math.min(e.y0, v.y); e.y1 = Math.max(e.y1, v.y);
    }
    return e;
  }
  _fitDistance(t) {
    let need = 0;
    {
      for (let a = 0; a < 5; a++) {
        let d = 2.5;
        for (let it = 0; it < 3; it++) {
          this._place(t, HERO_YAW + (a / 4 * 2 - 1) * SWAY, d);
          const e = this._ndc(t);
          d *= Math.max((e.x1 - e.x0) / 2 / 0.94, (e.y1 - e.y0) / 2 / 0.8);
        }
        need = Math.max(need, d);
      }
    }
    return need;
  }

  // Still image of a class, as a data URL (or null if the context is gone).
  shot(cls) {
    try {
      this._show(cls, HERO_YAW);
      this.renderer.render(this.scene, this.camera);
      return this.renderer.domElement.toDataURL('image/png');
    } catch (e) { return null; }
  }

  // Put the live canvas in `host` turning `cls` slowly; returns the canvas.
  live(host, cls) {
    this.liveCls = cls;
    host.innerHTML = '';
    host.append(this.canvas);
    this.yaw = HERO_YAW;
    this._show(cls, this.yaw);
    this.renderer.render(this.scene, this.camera);
    if (!this.still && !this._raf) {
      let last = performance.now();
      const loop = (now) => {
        if (!this.renderer) return;
        const dt = Math.min(0.05, (now - last) / 1000); last = now;
        // sway slowly either side of the hero angle, like a model on a display turntable
        this._t = (this._t || 0) + dt;
        this.yaw = HERO_YAW + Math.sin(this._t * 0.45) * SWAY;
        if (this.canvas.isConnected) { this._show(this.liveCls, this.yaw); this.renderer.render(this.scene, this.camera); }
        this._raf = requestAnimationFrame(loop);
      };
      this._raf = requestAnimationFrame(loop);
    }
    return this.canvas;
  }

  dispose() {
    if (!this.renderer) return;
    cancelAnimationFrame(this._raf); this._raf = 0;
    for (const t of Object.values(this.tanks)) {
      // geometries are cached and shared with the game view: dispose only per-tank materials
      // and the per-tank emblem texture
      const ud = t.userData;
      for (const m of ud.mats || []) if (m && m.dispose) m.dispose();
      if (ud.emblemTex && ud.emblemTex.dispose) ud.emblemTex.dispose();
    }
    const [ground, blot, blotTex] = this.stage;
    ground.geometry.dispose(); ground.material.dispose(); blot.geometry.dispose(); blot.material.dispose(); blotTex.dispose();
    this.env.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.canvas.remove();
    this.renderer = null; this.tanks = {};
  }
}

function contactTexture() {
  const c = document.createElement('canvas'); c.width = 256; c.height = 170;
  const g = c.getContext('2d');
  g.translate(128, 85); g.scale(1, 0.62);
  const gr = g.createRadialGradient(0, 0, 8, 0, 0, 128);
  gr.addColorStop(0, 'rgba(30,20,8,0.55)'); gr.addColorStop(0.5, 'rgba(30,20,8,0.22)'); gr.addColorStop(1, 'rgba(30,20,8,0)');
  g.fillStyle = gr; g.beginPath(); g.arc(0, 0, 128, 0, Math.PI * 2); g.fill();
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
