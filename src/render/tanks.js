// TankRenderer: places a tank model per sim tank, interpolated between sim ticks, with turret yaw,
// gun pitch, recoil, suspension rock, wheel spin / track scroll, damage state (broken tracks,
// wrecks, ammo-rack turret toss), hit scars, fade-out of enemies that aren't spotted, LOD by
// camera distance, and the continuous FX (track dust, exhaust, fire, wreck smoke).
//
//   const tr = new TankRenderer(scene, quality)
//   tr.sync(world, { visible /* Set<id> | null */, alpha /* 0..1 */, playerId, dt, camera? })
//   tr.handle(event)       // world.events: shot (recoil), hit (scars), kill (turret toss)
// FX go to the FxRenderer that registered itself as scene.userData.steelFx (if any).
import * as THREE from 'three';
import { buildTankModel } from './tankModel.js';
import { TankScars } from './decals.js';
import { tankMatrix } from '../sim/tank.js';

const LOD_DIST = { low: 45, medium: 75, high: 110 };
const GROUND = ['grass', 'dirt', 'road', 'sand', 'rock', 'mud', 'shallow', 'deep', 'field', 'snow'];
const lerpAngle = (a, b, t) => { let d = b - a; d -= Math.round(d / (Math.PI * 2)) * Math.PI * 2; return a + d * t; };
const _m = new THREE.Matrix4(), _v = new THREE.Vector3(), _arr = new Array(16);

export class TankRenderer {
  constructor(scene, quality = 'medium') {
    this.scene = scene;
    this.group = new THREE.Group(); this.group.name = 'tanks';
    scene.add(this.group);
    this.quality = LOD_DIST[quality] ? quality : 'medium';
    this.entries = new Map();
    this.scars = new TankScars();
    this.shellCal = new Map();
    this.time = 0;
    this.camPos = new THREE.Vector3(); this.camFov = 55; this.hasCam = false;
    // Invisible probe: learns the camera from the render pass (sync doesn't get one).
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(9), 3)); g.setDrawRange(0, 0);
    const probe = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false }));
    probe.frustumCulled = false; probe.name = 'camProbe';
    probe.onBeforeRender = (r, s, cam) => { if (cam.isPerspectiveCamera) { this.camPos.setFromMatrixPosition(cam.matrixWorld); this.camFov = cam.fov; this.hasCam = true; } };
    this.group.add(probe);
  }
  setQuality(q) { if (LOD_DIST[q]) this.quality = q; }

  _entry(t) {
    const e = {
      id: t.id, def: t.def, gunIndex: t.gunIndex ?? (t.def.guns ? Math.max(0, t.def.guns.indexOf(t.gunDef)) : 0),
      number: 100 + ((t.id * 53 + t.team * 7) % 800),
      root: new THREE.Group(), models: [null, null], lod: -1,
      prev: null, cur: null, t: -1, fade: 1, recoilT: 9, dmgKey: '', deadAt: -1,
      susp: { p: 0, pv: 0, r: 0, rv: 0 }, lastSpeed: 0, accel: 0, yawRate: 0, seen: true,
    };
    e.root.name = 'tank#' + t.id; e.root.matrixAutoUpdate = false;
    this.group.add(e.root);
    this.entries.set(t.id, e);
    return e;
  }
  _model(e, lod) {
    if (!e.models[lod]) {
      const m = buildTankModel(e.def, { lod, gunIndex: e.gunIndex, number: e.number });
      e.models[lod] = m; e.root.add(m.group); m.group.visible = false;
      e.dmgKey = ''; // re-apply damage to the new model
    }
    return e.models[lod];
  }
  _snap(t) {
    return { x: t.pos.x, y: t.pos.y, z: t.pos.z, yaw: t.yaw, pitch: t.pitch || 0, roll: t.roll || 0, ty: t.turretYaw || 0, gp: t.gunPitch || 0, speed: t.speed || 0, yr: t.yawRate || 0 };
  }

  sync(world, opts = {}) {
    const { visible = null, alpha = 1, playerId = null, dt = 1 / 60, camera = null } = opts;
    this.time += dt;
    if (camera) { this.camPos.setFromMatrixPosition(camera.matrixWorld); this.camFov = camera.fov || 55; this.hasCam = true; }
    const fx = this.scene.userData.steelFx;
    const player = playerId != null ? (world.byId ? world.byId[playerId] : world.tanks.find((x) => x.id === playerId)) : null;
    const myTeam = player ? player.team : null;
    for (const e of this.entries.values()) e.seen = false;
    const map = world.map;
    for (const t of world.tanks) {
      const e = this.entries.get(t.id) || this._entry(t);
      e.seen = true;
      // ---- interpolation snapshots (prev ← cur when the sim advanced)
      if (e.t !== world.time) { e.prev = e.cur || this._snap(t); e.cur = this._snap(t); e.t = world.time; }
      const a = Math.max(0, Math.min(1, alpha)), P = e.prev, C = e.cur;
      const s = {
        pos: { x: P.x + (C.x - P.x) * a, y: P.y + (C.y - P.y) * a, z: P.z + (C.z - P.z) * a },
        yaw: lerpAngle(P.yaw, C.yaw, a), pitch: P.pitch + (C.pitch - P.pitch) * a, roll: P.roll + (C.roll - P.roll) * a,
      };
      let ty = lerpAngle(P.ty, C.ty, a), gp = P.gp + (C.gp - P.gp) * a;
      const speed = P.speed + (C.speed - P.speed) * a, yawRate = P.yr + (C.yr - P.yr) * a;
      // ---- visibility: unspotted enemies fade out, wrecks and allies stay
      const enemy = myTeam != null && t.team !== myTeam;
      const show = !enemy || !visible || visible.has(t.id) || !t.alive;
      e.fade = Math.max(0, Math.min(1, e.fade + (show ? 4 : -4) * dt));
      if (e.fade <= 0) { e.root.visible = false; continue; }
      e.root.visible = true;
      // ---- LOD by camera distance (zoom-aware)
      let lod = 0;
      if (this.hasCam) {
        const d = Math.hypot(this.camPos.x - s.pos.x, this.camPos.y - s.pos.y, this.camPos.z - s.pos.z) * (this.camFov / 55);
        const lim = LOD_DIST[this.quality];
        lod = e.lod === 1 ? (d > lim * 0.9 ? 1 : 0) : (d > lim * 1.1 ? 1 : 0);
      }
      const model = this._model(e, lod);
      if (e.lod !== lod) { if (e.models[e.lod]) e.models[e.lod].group.visible = false; model.group.visible = true; e.lod = lod; }
      // ---- world matrix (sim convention via tankMatrix)
      tankMatrix(s, _arr);
      e.root.matrix.fromArray(_arr); e.root.matrixWorldNeedsUpdate = true;
      // ---- damage state
      const mods = t.modules || {};
      const trL = mods.trackL?.state === 'destroyed', trR = mods.trackR?.state === 'destroyed';
      const dead = !t.alive, burning = !!t.fire;
      if (dead && e.deadAt < 0) e.deadAt = this.time;
      if (!dead) e.deadAt = -1;
      const key = `${trL}${trR}${dead}${burning}`;
      if (key !== e.dmgKey) {
        for (const m of e.models) if (m) m.setDamage({ tracks: [trL, trR], burning, dead, ammorack: dead && t.deathCause === 'ammorack', seed: (t.id * 0.618) % 1 });
        e.dmgKey = key;
      }
      // ---- suspension: pitch with acceleration, roll in turns, kick when firing
      const acc = (speed - e.lastSpeed) / Math.max(dt, 1 / 60); e.lastSpeed = speed;
      e.accel += (Math.max(-30, Math.min(30, acc)) - e.accel) * Math.min(1, dt * 8);
      const sp = e.susp, k = 70, c = 7;
      const tp = dead ? 0 : Math.max(-0.045, Math.min(0.045, e.accel * 0.006));
      const tr = dead ? 0 : Math.max(-0.035, Math.min(0.035, yawRate * speed * 0.006));
      // sub-stepped (stable at any frame rate) and clamped: a slow frame must never spin the hull
      const hdt = Math.min(Math.max(dt, 0), 0.25), ns = Math.max(1, Math.ceil(hdt / (1 / 120))), h = hdt / ns;
      for (let i = 0; i < ns; i++) {
        sp.pv += (k * (tp - sp.p) - c * sp.pv) * h; sp.p += sp.pv * h;
        sp.rv += (k * (tr - sp.r) - c * sp.rv) * h; sp.r += sp.rv * h;
      }
      const cl = (v, m) => (Number.isFinite(v) ? Math.max(-m, Math.min(m, v)) : 0);
      sp.p = cl(sp.p, 0.08); sp.r = cl(sp.r, 0.08); sp.pv = cl(sp.pv, 2); sp.rv = cl(sp.rv, 2);
      const bump = dead ? 0 : Math.sin(this.time * 9 + t.id) * 0.006 * Math.min(1, Math.abs(speed) / 8);
      // ---- recoil
      e.recoilT += dt;
      const rt = e.recoilT, rmax = model.info.recoil;
      const recoil = rt < 0.04 ? rmax * rt / 0.04 : rt < 0.6 ? rmax * Math.pow(1 - (rt - 0.04) / 0.56, 2) : 0;
      if (dead) { gp = Math.min(gp, -0.08); }
      model.update({ turretYaw: ty, gunPitch: gp, speed: dead ? 0 : speed, yawRate: dead ? 0 : yawRate, recoil, bodyPitch: sp.p, bodyRoll: sp.r, bodyY: bump }, dt);
      model.setOpacity(e.fade);
      // ---- continuous FX
      if (fx && e.fade > 0.5) this._fx(fx, e, t, model, s, speed, dt, map);
    }
    // tanks that left the world (new battle): drop them
    for (const [id, e] of this.entries) if (!e.seen) this._remove(id);
  }
  _fx(fx, e, t, model, s, speed, dt, map) {
    const info = model.info, W = e.root.matrix;
    const fwdX = Math.sin(s.yaw), fwdZ = Math.cos(s.yaw);
    const wp = (x, y, z) => _v.set(x, y, z).applyMatrix4(W);
    if (t.alive) {
      if (Math.abs(speed) > 0.8) {
        let ground = 'grass';
        if (map && map.ground) { const i = Math.max(0, Math.min(map.res - 1, Math.round(s.pos.x / map.cell))), j = Math.max(0, Math.min(map.res - 1, Math.round(s.pos.z / map.cell))); ground = GROUND[map.ground[j * map.res + i]] || 'grass'; }
        const zEnd = speed > 0 ? info.trackRear : info.trackFront;
        for (const side of [1, -1]) { wp(side * info.xT, 0.1, zEnd); fx.trackDust(_v.x, _v.y, _v.z, fwdX, fwdZ, speed, ground, dt); }
      }
      const load = Math.min(1, Math.abs(t.throttle || 0) * 0.6 + Math.abs(e.accel) * 0.25);
      for (const ex of info.exhausts || []) { wp(ex[0], ex[1], ex[2]); fx.exhaust(_v.x, _v.y, _v.z, fwdX, fwdZ, load, dt); }
      if (t.fire) { wp(info.engine[0], info.engine[1], info.engine[2]); fx.fire(_v.x, _v.y, _v.z, dt, 1); }
    } else {
      const age = this.time - e.deadAt;
      wp(0, info.top + 0.2, 0);
      fx.wreckSmoke(_v.x, _v.y, _v.z, dt, age);
      if (age < 25) { wp(info.engine[0], info.engine[1], info.engine[2]); fx.fire(_v.x, _v.y, _v.z, dt, age < 8 ? 1.3 : 0.7); }
    }
  }

  handle(ev) {
    const type = ev.type || ev.kind;
    if (type === 'shot') {
      this.shellCal.set(ev.shell, ev.cal);
      if (this.shellCal.size > 400) this.shellCal.delete(this.shellCal.keys().next().value);
      const e = this.entries.get(ev.tank);
      if (!e) return;
      e.recoilT = 0;
      // hull rocks back against the gun direction
      const m = e.models[e.lod], ty = e.cur ? e.cur.ty : 0, kick = Math.min(0.5, (ev.cal || 75) / 180) * (e.def.turret.shape === 'casemate' ? 1 : 0.8);
      e.susp.pv += kick * Math.cos(ty); e.susp.rv += kick * Math.sin(ty) * 0.8;
      void m;
    } else if (type === 'hit' && ev.pos && ev.normal) {
      const e = this.entries.get(ev.target);
      const m = e && e.models[0];
      if (!m || e.lod !== 0) return;
      const cal = this.shellCal.get(ev.shell) || 75;
      const pl = ev.plate || '';
      const part = /^(turret|mantlet|cupola)/.test(pl) ? (m.parts.turretMesh.parent === m.parts.yaw ? m.parts.turretMesh : m.parts.turretBase) : m.parts.body;
      const kind = ev.result === 'ricochet' ? 'ricochet' : ev.result === 'pen' || (ev.result === 'crit' && ev.dmg > 0) ? 'pen' : 'nopen';
      if (ev.result === 'splash') return;
      this.scars.add(part, ev.pos, ev.normal, 0.12 + cal / 1000 * (kind === 'pen' ? 2.5 : 3.2), kind);
    }
  }
  // Build both LODs of every tank up front (≈35 ms per new tank type) to avoid hitches later.
  prewarm(world) { for (const t of world.tanks) { const e = this.entries.get(t.id) || this._entry(t); this._model(e, 0); this._model(e, 1); } }
  // Shader warm-up (BattleView.warmup): every built model in each material variant, compile() per pass.
  warm(compile) {
    const ms = [];
    for (const e of this.entries.values()) for (const m of e.models) if (m && m.warm) ms.push(m);
    for (const pass of [0, 1, 2, 3]) { for (const m of ms) m.warm(pass); compile(); }
    for (const m of ms) m.warm(-1);
  }
  modelOf(id) { const e = this.entries.get(id); return e ? e.models[Math.max(0, e.lod)] : null; }
  _remove(id) {
    const e = this.entries.get(id);
    if (!e) return;
    for (const m of e.models) if (m) m.dispose();
    e.root.removeFromParent();
    this.entries.delete(id);
  }
  clear() { for (const id of [...this.entries.keys()]) this._remove(id); }
  dispose() { this.clear(); this.group.removeFromParent(); }
  stats() {
    let n = 0, near = 0;
    for (const e of this.entries.values()) if (e.root.visible) { n++; if (e.lod === 0) near++; }
    return { tanks: this.entries.size, visible: n, near };
  }
}
