// BattleView: the battle renderer (docs/DESIGN.md "Rendering"). Owns the WebGL renderer, the
// scene and camera, the environment (sky, sun, shadows, fog, water), terrain, props and the
// post stack, and drives TankRenderer / FxRenderer (RENDER-TANKS) when they are available.
//   const view = new BattleView(canvas, { quality })
//   view.loadMap(map)
//   view.frame(world, { cam: {pos, look, fov}, alpha, visible, playerId, dt, sniper, events })
//   view.warmup()   // after tanks.prewarm: compiles every tank/FX material variant
//   view.setQuality(q); view.resize(); view.stats() → { calls, tris, ms, ev, tanks, fx, progs }
import * as THREE from 'three';
import { qualityOf } from './quality.js';
import { Env, themeOf } from './env.js';
import { Terrain } from './terrain.js';
import { Props } from './props.js';
import { Post } from './post.js';
import { scarWarmMesh } from './decals.js';

const deg = Math.PI / 180;

export class BattleView {
  constructor(canvas, { quality = 'medium' } = {}) {
    this.canvas = canvas;
    this.q = qualityOf(quality);
    const r = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, stencil: false, powerPreference: 'high-performance' });
    r.shadowMap.enabled = true; r.shadowMap.type = THREE.PCFShadowMap;
    r.info.autoReset = false;
    r.toneMapping = THREE.NoToneMapping; // tone mapping happens in post.js
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.3, 14000);
    this.env = new Env(r, this.scene, this.q);
    this.terrain = new Terrain(this.scene, this.q);
    this.U = { ...this.terrain.U, uSunDir: this.env.U.uSunDir, uSunColor: this.env.U.uSunColor, uTime: { value: 0 } };
    this.props = new Props(this.scene, this.q, this.U);
    this.post = new Post(r, this.q, this.env.U);
    this.tanks = null; this.fx = null; this.map = null;
    this._stats = { calls: 0, tris: 0, ms: 0 };
    this._focus = new THREE.Vector3(); this._fwd = new THREE.Vector3();
    this.exposure = 1;
    this.ready = this._loadRenderers();
    this.resize();
  }

  // TankRenderer / FxRenderer are optional at load time (written concurrently); a missing
  // module or class just means no tanks / FX are drawn.
  async _loadRenderers() {
    const qn = this.q.name;
    // FxRenderer first: TankRenderer finds it through scene.userData.steelFx
    try { const m = await import('./fx.js'); if (m.FxRenderer) this.fx = new m.FxRenderer(this.scene, qn); }
    catch (e) { console.warn('BattleView: FxRenderer unavailable:', e.message); }
    try { const m = await import('./tanks.js'); if (m.TankRenderer) this.tanks = new m.TankRenderer(this.scene, qn); }
    catch (e) { console.warn('BattleView: TankRenderer unavailable:', e.message); }
    if (this.map) { this.tanks?.setMap?.(this.map, this); this.fx?.setMap?.(this.map, this); }
  }

  // opts.time: hour of day (6..20) overriding the theme's sun (lab / cinematics)
  loadMap(map, opts = {}) {
    this.map = map;
    const th = themeOf(map);
    if (opts.time !== undefined && opts.time !== null) {
      const t = +opts.time, e = Math.max(4, 58 * Math.sin(Math.PI * (t - 5.5) / 15)) * deg, a = (90 + (t - 6) * 13) * deg;
      th.sky.dir = [Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e)];
    }
    this.theme = th;
    this.env.setTheme(th);
    this.terrain.build(map, th);
    this.props.build(map, th, this.terrain);
    this.terrain.bakeShadows(this.env.U.uSunDir.value, this.props.casters());
    this.env.buildWater(map, this.terrain);
    let hmin = Infinity; for (const h of map.heights) hmin = Math.min(hmin, h);
    this.fogBase = map.water ? Math.min(hmin, map.water.level) : hmin;
    this.exposure = th.sky.exposure || 1;
    this.tanks?.setMap?.(map, this); this.fx?.setMap?.(map, this);
    this._compile();
  }

  // renderer.compile with the scene render target bound: the scene is drawn into post's HDR target,
  // whose programs differ from the canvas ones (linear output), so a plain compile() builds the wrong set.
  _compile() {
    const r = this.renderer, prev = r.getRenderTarget();
    r.setRenderTarget(this.post.sceneRT || null); r.compile(this.scene, this.camera); r.setRenderTarget(prev);
  }
  // Load-time warm-up (after TankRenderer.prewarm): every tank model of the battle, both LODs, in each
  // material variant (live, faded-in, charred, charred+faded), plus the hit-scar material, so neither
  // spotting a tank, a first hit nor a first kill compiles a shader mid-battle.
  warmup() {
    const scar = scarWarmMesh(); this.scene.add(scar);
    try {
      if (this.tanks?.warm) this.tanks.warm(() => this._compile()); else this._compile();
      if (scar.material.map) this.renderer.initTexture(scar.material.map);
    } finally { scar.removeFromParent(); scar.geometry.dispose(); }
  }

  // Terrain height as rendered (bilinear, plus the scenery outside the map).
  heightAt(x, z) { return this.terrain.map ? this.terrain.heightAt(x, z) : 0; }

  setQuality(q) {
    this.q = qualityOf(q);
    this.env.setQuality(this.q); this.post.setQuality(this.q); this.props.setQuality(this.q);
    this.terrain.q = this.q;
    this.resize();
    if (this.map) this.loadMap(this.map);
    this.tanks?.setQuality?.(this.q.name); this.fx?.setQuality?.(this.q.name);
  }

  resize() {
    const c = this.canvas;
    const w = Math.max(1, c.clientWidth || c.width || 1), h = Math.max(1, c.clientHeight || c.height || 1);
    const pr = Math.min(this.q.maxPixelRatio, (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1)) * this.q.pixelRatio;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    this.post.setSize(Math.round(w * pr), Math.round(h * pr));
  }

  frame(world, { cam, alpha = 1, visible = null, playerId = null, dt = 1 / 60, sniper = false, events = null } = {}) {
    const t0 = performance.now();
    const camera = this.camera;
    if (cam) {
      camera.position.set(cam.pos.x, cam.pos.y, cam.pos.z);
      if (cam.fov) camera.fov = cam.fov;
      camera.near = sniper ? 1.0 : 0.3;
      camera.up.set(0, 1, 0);
      camera.lookAt(cam.look.x, cam.look.y, cam.look.z);
      camera.updateProjectionMatrix(); camera.updateMatrixWorld();
    }
    // events: props (tree falls, rubble), tanks and fx
    const evs = events || (world && world.events) || [];
    for (const ev of evs) {
      this.props.handle(ev);
      if (this.tanks) this.tanks.handle(ev);
      if (this.fx) this.fx.handle(ev, world);
    }
    const t1 = performance.now();
    if (world && this.tanks) this.tanks.sync(world, { visible, alpha, playerId, dt, camera });
    const t2 = performance.now();
    if (this.fx) this.fx.update(dt, camera, world);
    const t3 = performance.now();
    // shadow focus: ahead of the camera (third person), or the looked-at area (sniper)
    const R = this.q.shadowRange, f = this._focus, fwd = this._fwd;
    camera.getWorldDirection(fwd);
    if (sniper && cam) f.set(cam.look.x, cam.look.y, cam.look.z);
    else { fwd.y = 0; if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, 1); fwd.normalize(); f.copy(camera.position).addScaledVector(fwd, R * 0.5); f.y = this.map ? this.heightAt(f.x, f.z) : 0; }
    this.env.update(camera, dt, f);
    this.U.uFarC.value.set(f.x, f.z); this.U.uFarR.value = this.debugNoFar ? 1e9 : R;
    this.terrain.update(camera, dt, sniper);
    this.props.update(camera, dt);
    this.renderer.info.reset();
    this.post.render(this.scene, camera, { sniper, exposure: this.exposure, fogBase: this.fogBase || 0 });
    const info = this.renderer.info.render;
    // ev: event handling (props/tanks/fx), tanks: TankRenderer.sync, fx: particle update; progs: shader programs so far
    this._stats = { calls: info.calls, tris: info.triangles, ms: performance.now() - t0, ev: t1 - t0, tanks: t2 - t1, fx: t3 - t2, progs: this.renderer.info.programs ? this.renderer.info.programs.length : 0 };
    return this._stats;
  }

  stats() { return { ...this._stats }; }

  dispose() {
    this.terrain.dispose(); this.props.dispose(); this.post.dispose();
    this.renderer.dispose();
  }
}
