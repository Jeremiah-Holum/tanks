// BattleSession: one battle from loading to the result banner. Owns the BattleView, the sim world,
// the bot brains, the camera, aiming, input → Controls, the HUD, spectating and auto-quality.
//   const s = new BattleSession({ battle, screens, audio, settings, params, onExit })
//   await s.load((p, label) => …)  → s.start()  → s.frame(dtSeconds) every animation frame
//   onExit({ world, playerId, left }) when the result banner is done (or the player left).
// Loop: fixed-step sim (DT = 1/60) with an accumulator and a catch-up cap, render interpolation,
// every event of every step collected per frame and fed to the view, audio and HUD.
import { createBattle, stepBattle, DT, predictImpact, penPreview, viewRange } from '../sim/battle.js';
import { loadMap } from '../sim/map/index.js';
import { muzzle } from '../sim/tank.js';
import { BattleView } from '../render/battleView.js';
import { Input } from './input.js';
import { GameCamera } from './camera.js';
import { aimRay, centreOf } from './aim.js';
import { makeBrain } from './bots.js';
import { Hud } from '../ui/hud.js';

const DEG = Math.PI / 180;
const TIERS = ['low', 'medium', 'high'];
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

export class BattleSession {
  constructor({ battle, screens, audio, settings, params = new URLSearchParams(), onExit }) {
    this.battle = battle; this.screens = screens; this.audio = audio; this.settings = settings; this.params = params;
    this.onExit = onExit;
    const P = params;
    this.fast = P.get('fast') === '1';
    this.god = this.fast || P.get('god') === '1';
    this.speed = +(P.get('speed') || (this.fast ? 4 : 1));
    this.maxSteps = this.fast ? 150 : 5;               // catch-up cap per rendered frame (the game slows down instead)
    this.qFixed = P.get('q') || (settings.quality !== 'auto' ? settings.quality : null);
    this.quality = this.qFixed || 'medium';
    this.phase = 'loading';                            // loading → countdown → play → (dead) → ending → done
    this.acc = 0; this.countdown = +(P.get('countdown') ?? 10);
    this.events = [];
    this.perf = { frames: 0, sim: 0, ai: 0, render: 0, hud: 0, frame: 0, steps: 0, win: [], drops: [] };
    this._perfAcc = { n: 0, sim: 0, ai: 0, render: 0, hud: 0, frame: 0, steps: 0 };
    this.fireQueued = false; this.useQueued = null; this.reloadHack = 0;
    this.lockTarget = null; this.gunLock = false;
    this.spec = null; this.specSince = 0;
    this.menuOpen = false; this.scoreOpen = false; this.settingsOpen = false;
    this.endT = 0; this.left = false;
    this.aim = { x: 0, y: 0, z: 0, t: 0, tankId: null, obj: null, sky: true };
    this.impact = null; this.pen = null;
    this._ctl = new Map();
    this._ip = new Map();          // tank id → Float64Array [px,py,pz,pyaw, cx,cy,cz,cyaw]
    this._lockLost = false; this.reloads = 0; this._lastReload = 0;
    this.perfShow = !!settings.showFps || P.get('debug') === '1' || P.get('perf') === '1';   // F3 toggles
  }

  // ------------------------------------------------------------------ loading
  async load(progress = () => {}) {
    const b = this.battle, P = this.params;
    progress(0.03, 'Loading map…'); await nextFrame();
    const map = b.map || (b.map = loadMap(b.mapId));
    this.screens?.setLoadingMap?.(map);
    progress(0.14, 'Preparing the battlefield…'); await nextFrame();
    const canvas = this.canvas = document.createElement('canvas');
    canvas.className = 'battle-canvas';
    document.body.prepend(canvas);
    const view = this.view = new BattleView(canvas, { quality: this.quality });
    this._applyScale();
    progress(0.2, 'Building terrain and scenery…'); await nextFrame();
    view.loadMap(map);
    progress(0.58, 'Crews boarding…'); await nextFrame();
    await view.ready;
    if (!view.tanks || !view.fx) throw new Error('the tank / FX renderer failed to load');
    let timeLimit = b.timeLimit || 900;
    if (P.get('limit')) timeLimit = +P.get('limit'); else if (this.fast) timeLimit = 600;
    const world = this.world = createBattle({ ...b, map, timeLimit });
    const me = this.player = world.tanks.find((t) => t.player) || world.tanks[0];
    this.team = me.team;
    if (this.god) this._godOn();
    // prewarm the tank models (both LODs) in chunks so the bar moves
    if (view.tanks?.prewarm) {
      const seen = new Map();
      for (const t of world.tanks) { const k = t.def.id + ':' + t.gunIndex; if (!seen.has(k)) seen.set(k, []); seen.get(k).push(t); }
      const groups = [...seen.values()];
      for (let i = 0; i < groups.length; i++) {
        view.tanks.prewarm({ tanks: groups[i] });
        if (i % 2 === 1) { progress(0.6 + 0.25 * i / groups.length, `Rolling out vehicles… ${i + 1}/${groups.length}`); await nextFrame(); }
      }
      view.tanks.prewarm(world);
    }
    progress(0.87, 'Briefing the crews…'); await nextFrame();
    const botKind = P.get('bots') || 'ai';
    this.brains = new Map();
    for (const t of world.tanks) if (!t.player) this.brains.set(t.id, makeBrain(world, t, botKind));
    if (P.get('autopilot') === '1' || P.get('bot') === '1') this.autopilot = makeBrain(world, me, botKind);
    for (const t of world.tanks) this._snap(t, true);
    // camera, input, HUD
    this.cam = new GameCamera({ fov: this.settings.fov || 70, heightAt: (x, z) => view.heightAt(x, z) });
    this.cam.setYawPitch(me.yaw, -6 * DEG);
    this.input = new Input(canvas);
    this.hud = new Hud(document.body, { world, playerId: me.id, settings: this.settings, onMenu: (a) => this._menuAction(a) });
    // fast-forward (?t=seconds): the player is driven by a brain meanwhile
    const ff = +(P.get('t') || 0);
    if (ff > 0) {
      progress(0.9, `Fast-forwarding ${ff} s…`); await nextFrame();
      const pilot = this.autopilot || makeBrain(world, me, botKind);
      const n = Math.round(ff / DT);
      for (let i = 0; i < n && !world.result; i++) {
        this._ctl.clear();
        for (const [id, br] of this.brains) this._ctl.set(id, br.control(world));
        this._ctl.set(me.id, pilot.control(world));
        stepBattle(world, this._ctl);
        if (i % 600 === 599) await nextFrame();
      }
      for (const t of world.tanks) this._snap(t, true);
      this.countdown = 0;
      this.cam.setYawPitch(me.yaw + me.turretYaw, -4 * DEG);
    }
    progress(0.95, 'Deploying…'); await nextFrame();
    this._updateCamera(0);
    this._render(0);                   // compiles the remaining shaders
    progress(1, 'Ready'); await nextFrame();
    window.addEventListener('resize', this._onResize = () => { this.view.resize(); this.hud.resize(); });
    document.addEventListener('pointerlockchange', this._onLock = () => {
      if (!document.pointerLockElement && this.input.locked === false && this.phase !== 'ending' && this.phase !== 'done' && !this.menuOpen && !this.settingsOpen && !this._unlocking) this._lockLost = true;
      this._unlocking = false;
    });
  }

  _applyScale() {
    const s = Math.max(0.5, Math.min(1, +(this.params.get('scale') || this.settings.renderScale || 1)));
    if (s !== 1) { this.view.q = { ...this.view.q, pixelRatio: this.view.q.pixelRatio * s }; this.view.resize(); }
  }

  start() {
    this.phase = this.countdown > 0 ? 'countdown' : 'play';
    this.input.enable(true);
    this.hud.resize();
    try { this.audio?.music?.('battle'); } catch { /* optional */ }
  }

  // ------------------------------------------------------------------ per frame
  frame(dt) {
    if (this.phase === 'loading' || this.phase === 'done') return;
    const f0 = performance.now(), rawDt = dt;
    dt = Math.min(dt, this.fast ? 1 : 0.25);   // ?fast: let a slow (headless) frame advance up to 1 s × speed
    const world = this.world, me = this.player, inp = this.input;
    this.events.length = 0;
    // --- input (not while a menu is open)
    if (this.settingsOpen && !this.screens.modals?.children.length) this._closeSettings();
    if (this._lockLost) { this._lockLost = false; inp.take('Escape'); if (!this.resolving && (this.phase === 'play' || this.phase === 'dead' || this.phase === 'countdown')) this._openMenu(); }
    if (this.resolving) inp.flush();
    else if (inp.take('Escape')) { if (this.settingsOpen) { /* the settings modal closes itself */ } else if (this.menuOpen) this._closeMenu(); else if (this.phase !== 'ending') this._openMenu(); }
    const menu = !this.resolving && (this.menuOpen || this.settingsOpen);
    if (!menu) this._handleInput(dt);
    else inp.flush();
    // --- countdown
    if (this.phase === 'countdown') {
      this.countdown -= dt;
      if (this.countdown <= 0 || inp.take('Space')) { this.countdown = 0; this.phase = 'play'; this.hud.flash('BATTLE!'); try { this.audio?.ui?.('battleStart'); } catch { /* */ } }
    }
    // --- aim (from the camera of the previous frame, updated for this frame's mouse)
    this._updateCamera(dt);
    this._updateAim();
    // --- simulation
    let sim = 0, ai = 0, steps = 0;
    const running = (this.phase === 'play' || this.phase === 'dead') && !menu && !world.result;
    if (running) {
      this.acc += dt * this.speed;
      while (this.acc >= DT && steps < this.maxSteps) {
        const a0 = performance.now();
        this._controls();
        const a1 = performance.now();
        stepBattle(world, this._ctl);
        const a2 = performance.now();
        ai += a1 - a0; sim += a2 - a1;
        for (const e of world.events) { this.events.push(e); if (e.type === 'kill' && world.firstKill == null && e.killer) world.firstKill = e.killer; }
        for (const t of world.tanks) this._snap(t, false);
        if (me.reload > this._lastReload + 0.02) this.reloads++;   // counts every (re)load start, for tests
        this._lastReload = me.reload;
        this.acc -= DT; steps++;
        if (world.result) break;
      }
      if (steps === this.maxSteps) this.acc = Math.min(this.acc, DT);
    }
    const alpha = running ? Math.max(0, Math.min(1, this.acc / DT)) : 1;
    this.alpha = alpha;
    // --- phases
    if (this.phase === 'play' && !me.alive) { this.phase = 'dead'; this.specSince = world.time; this.lockTarget = null; this.cam.sniper = false; this.hud.destroyed(world, me); }
    if (world.result && this.phase !== 'ending') { this.phase = 'ending'; this.endT = 0; if (this.god) this._godOff(); this.hud.result(world, me, this.left); inp.unlock(); }
    if (this.phase === 'ending') { this.endT += dt; if (this.endT > (this.left ? 0.2 : 4)) return this._exit(); }
    if (this.phase === 'dead') this._spectate();
    // --- camera for this frame (interpolated focus), render
    this._updateCamera(0);
    const r0 = performance.now();
    // FX and tank animation age with sim time (so a sped-up test battle doesn't pile up particles)
    this._render(running && this.speed !== 1 ? Math.min(0.5, dt * this.speed) : dt);
    const r1 = performance.now();
    // --- audio
    if (!this.resolving) this._audio();
    const a1 = performance.now();
    // --- HUD
    this.hud.update(this._hudState(dt));
    for (const e of this.events) this.hud.event(e, world);
    const h1 = performance.now();
    this._perf(rawDt, sim, ai, r1 - r0, h1 - a1, steps, performance.now() - f0, a1 - r1);
  }

  _handleInput(dt) {
    const inp = this.input, cam = this.cam, S = this.settings;
    const m = inp.mouse();
    cam.turn(m.dx, m.dy, cam.sniper ? (S.sniperSens ?? 0.6) * 1.6 : (S.mouseSens ?? 1), !!S.invertY);
    const w = inp.wheel();
    for (let i = 0; i < Math.abs(w); i++) this._zoom(w > 0 ? 1 : -1);
    if (inp.take('ShiftLeft') || inp.take('ShiftRight')) this._zoom(0);
    if (inp.take('KeyM')) this.hud.cycleMinimap();
    if (inp.take('F3')) this.perfShow = !this.perfShow;
    this.scoreOpen = inp.down('Tab');
    const me = this.player;
    if (this.phase === 'dead') {
      // spectate: LMB next ally, RMB previous
      if (inp.takeBtn(0)) this._specCycle(1);
      if (inp.takeBtn(2)) this._specCycle(-1);
      inp.takeRelease(2);
      return;
    }
    if (!me.alive) return;
    for (let k = 0; k < 3; k++) if (inp.take('Digit' + (k + 1)) || inp.take('Numpad' + (k + 1))) {
      if (me.gunDef.shells[k] && me.ammo[k] > 0) { this.shell = k; this.hud.flashShell(k); } else this.hud.toast('No ammunition of that type');
    }
    for (let k = 0; k < 3; k++) if (inp.take('Digit' + (k + 4)) || inp.take('Numpad' + (k + 4))) {
      const c = me.consumables[k];
      if (c && c.ready) { if (needs(me, c.kind)) this.useQueued = c.kind; else this.hud.toast(NOTHING[c.kind] || 'Nothing to fix', 'dim'); }
      else if (c) this.hud.toast(`${label(c.kind)} is not ready`);
    }
    if (inp.take('KeyR') && me.gunDef.shells.length > 1) this.reloadHack = 2;
    if (this.phase !== 'play') { inp.takeBtn(0); inp.takeBtn(2); return; }
    if (inp.takeBtn(0)) this.fireQueued = true;
    if (inp.takeBtn(2)) {
      if (this.lockTarget != null) { this.lockTarget = null; this.hud.toast('Target lock released', 'dim'); }
      else {
        const tg = this.aim.tankId != null ? this.world.byId[this.aim.tankId] : null;
        if (tg && tg.alive && tg.team !== this.team && this.world.visible[this.team].has(tg.id)) { this.lockTarget = tg.id; try { this.audio?.ui?.('toggle'); } catch { /* */ } }
        else this.gunLock = true;
      }
    }
    if (inp.takeRelease(2) || !inp.btn(2)) this.gunLock = false;
  }

  _zoom(n) {
    const cam = this.cam, before = cam.sniper;
    if (n === 0) cam.toggleSniper(); else cam.zoomStep(n);
    if (cam.sniper !== before) {
      // keep the aim point under the crosshair across the switch
      const f = this._focus(this._focusTank());
      const p = { x: this.aim.x, y: this.aim.y, z: this.aim.z };
      cam.lookAt(cam.sniper ? f.eye : f.pivot, p);
      if (!cam.sniper) cam.distWant = Math.max(cam.distWant, 6);
    }
  }

  // Player Controls for one step (plus every brain).
  _controls() {
    const world = this.world, me = this.player, inp = this.input, ctl = this._ctl;
    ctl.clear();
    for (const [id, br] of this.brains) ctl.set(id, br.control(world));
    if (!me.alive) return;
    if (this.autopilot) { ctl.set(me.id, this.autopilot.control(world)); return; }
    const c = this._pc || (this._pc = { throttle: 0, steer: 0, brake: false, aim: null, lockGun: false, fire: false, shell: 0, use: null });
    const play = this.phase === 'play';
    c.throttle = play ? (inp.down('KeyW') || inp.down('ArrowUp') ? 1 : 0) - (inp.down('KeyS') || inp.down('ArrowDown') ? 1 : 0) : 0;
    c.steer = play ? (inp.down('KeyD') || inp.down('ArrowRight') ? 1 : 0) - (inp.down('KeyA') || inp.down('ArrowLeft') ? 1 : 0) : 0;
    c.brake = play && (inp.down('Space') || inp.down('KeyX'));
    const tg = this.lockTarget != null ? world.byId[this.lockTarget] : null;
    c.aim = tg ? centreOf(tg, this._lockPt || (this._lockPt = {})) : { x: this.aim.x, y: this.aim.y, z: this.aim.z };
    c.lockGun = this.gunLock && !tg;
    c.fire = this.fireQueued; this.fireQueued = false;
    c.use = this.useQueued; this.useQueued = null;
    if (this.shell == null) this.shell = me.shell;
    c.shell = this.shell;
    if (this.reloadHack === 2) { c.shell = (this.shell + 1) % me.gunDef.shells.length; this.reloadHack = 1; }
    else if (this.reloadHack === 1) this.reloadHack = 0;
    ctl.set(me.id, c);
  }

  // ------------------------------------------------------------------ camera & aim
  _focusTank() { return this.phase === 'dead' && this.spec != null ? this.world.byId[this.spec] || this.player : this.player; }
  ipos(t, out = {}) {
    const s = this._ip.get(t.id), a = this.alpha ?? 1;
    if (!s) { out.x = t.pos.x; out.y = t.pos.y; out.z = t.pos.z; return out; }
    out.x = s[0] + (s[4] - s[0]) * a; out.y = s[1] + (s[5] - s[1]) * a; out.z = s[2] + (s[6] - s[2]) * a;
    return out;
  }
  _snap(t, both) {
    let s = this._ip.get(t.id);
    if (!s) { s = new Float64Array(8); this._ip.set(t.id, s); both = true; }
    if (both) { s[0] = t.pos.x; s[1] = t.pos.y; s[2] = t.pos.z; s[3] = t.yaw; }
    else { s[0] = s[4]; s[1] = s[5]; s[2] = s[6]; s[3] = s[7]; }
    s[4] = t.pos.x; s[5] = t.pos.y; s[6] = t.pos.z; s[7] = t.yaw;
  }
  _focus(t) {
    const p = this.ipos(t, this._fp || (this._fp = {}));
    const dx = p.x - t.pos.x, dy = p.y - t.pos.y, dz = p.z - t.pos.z;
    const top = t.cy * 2;
    const pivot = this._piv || (this._piv = {});
    pivot.x = p.x; pivot.y = p.y + top + 1.3; pivot.z = p.z;
    // sniper eye: just ahead of the muzzle, a little above the barrel (so the gun is behind us)
    const m = muzzle(t, this._mz || (this._mz = { pos: {}, dir: {} }));
    const eye = this._eye || (this._eye = {});
    eye.x = m.pos.x + m.dir.x * 0.4 + dx; eye.y = m.pos.y + 0.28 + dy; eye.z = m.pos.z + m.dir.z * 0.4 + dz;
    return { pivot, eye };
  }
  _updateCamera(dt) {
    const t = this._focusTank();
    if (!t) return;
    if (this.phase === 'dead' && this.cam.sniper) this.cam.sniper = false;
    if (this.cam.sniper) {
      // look pitch limited to what the gun can reach: depression/elevation plus the hull's pitch along the view
      const g = t.gunDef, along = t.pitch * Math.cos(this.cam.yaw - t.yaw);
      this.cam.sniperLim = [along + (g.dep - 3) * DEG, along + (g.elev + 3) * DEG];
    }
    this.cam.update(this._focus(t), this.world.map, dt);
  }
  _updateAim() {
    const cam = this.cam, me = this.player, world = this.world;
    // skip what lies between the camera and the pivot (arcade), so nothing behind the tank is aimed at
    let o = cam.pos, d = cam.dir;
    if (!cam.sniper) {
      const p = cam.pivot, s = Math.max(0, (p.x - o.x) * d.x + (p.y - o.y) * d.y + (p.z - o.z) * d.z - 0.5);
      o = { x: o.x + d.x * s, y: o.y + d.y * s, z: o.z + d.z * s };
    }
    aimRay(world, o, d, { skipId: this._focusTank()?.id, visible: world.visible[this.team], res: this.aim });
    if (!me.alive) { this.impact = null; this.pen = null; return; }
    // release a lock on a target that died or went out of sight
    if (this.lockTarget != null) {
      const tg = world.byId[this.lockTarget];
      if (!tg || !tg.alive || !world.visible[this.team].has(tg.id)) { this.lockTarget = null; this.hud.toast('Target lost', 'dim'); }
    }
    this.impact = predictImpact(world, me);
    const tgId = this.lockTarget ?? (this.aim.tankId != null && world.byId[this.aim.tankId]?.team !== this.team ? this.aim.tankId : null);
    if (tgId != null) {
      const tg = world.byId[tgId];
      const pt = this.lockTarget != null ? centreOf(tg, {}) : this.aim;
      this.pen = tg && tg.alive ? penPreview(world, me, pt, tgId) : null;
      if (this.pen) this.pen.targetId = tgId;
    } else this.pen = null;
  }

  _render(dt) {
    const cam = this.cam, world = this.world;
    this.view.frame(world, {
      cam: { pos: cam.pos, look: cam.look, fov: cam.fov }, alpha: this.alpha ?? 1, visible: world.visible[this.team],
      playerId: this.player.id, dt, sniper: cam.sniper, events: this.events,
    });
  }

  // ------------------------------------------------------------------ spectating
  _spectate() {
    const world = this.world;
    if (world.time - this.specSince < 2.5) return;   // linger on our wreck first
    const cur = this.spec != null ? world.byId[this.spec] : null;
    if (!cur || !cur.alive) this._specCycle(1);
  }
  _specCycle(dir) {
    const world = this.world;
    if (world.time - this.specSince < 1) return;
    const allies = world.tanks.filter((t) => t.team === this.team && t.alive && t !== this.player);
    if (!allies.length) { this.spec = null; return; }
    let i = allies.findIndex((t) => t.id === this.spec);
    i = i < 0 ? 0 : (i + dir + allies.length) % allies.length;
    const t = allies[i];
    if (t.id !== this.spec) { this.spec = t.id; this.cam.setYawPitch(t.yaw + t.turretYaw, -10 * DEG); this.cam.distWant = 14; }
  }

  // ------------------------------------------------------------------ audio
  _audio() {
    const A = this.audio; if (!A) return;
    const cam = this.cam, world = this.world;
    const L = this._listener || (this._listener = { pos: {}, fwd: {}, playerId: this.player.id });
    L.pos = cam.pos; L.fwd = cam.dir; L.playerId = this.player.id;
    try {
      for (const e of this.events) A.event(e, world, L);
      // engines: the player plus the nearest visible tanks within 300 m
      const vis = world.visible[this.team], near = this._near || (this._near = []);
      near.length = 0;
      for (const t of world.tanks) {
        if (!t.alive || !vis.has(t.id)) continue;
        const d = Math.hypot(t.pos.x - cam.pos.x, t.pos.z - cam.pos.z);
        if (d < 300 || t === this.player) near.push([d, t]);
      }
      near.sort((a, b) => a[0] - b[0]);
      for (let i = 0; i < near.length && i < 8; i++) A.engine(near[i][1], L);
    } catch (e) { if (!this._audioErr) { this._audioErr = true; console.warn('audio', e); } }
  }

  // ------------------------------------------------------------------ HUD state
  _hudState(dt) {
    return {
      dt, world: this.world, me: this.player, focus: this._focusTank(), cam: this.cam, camera: this.view.camera,
      aim: this.aim, impact: this.impact, pen: this.pen, lockTarget: this.lockTarget, gunLock: this.gunLock,
      phase: this.phase, countdown: this.countdown, score: this.scoreOpen, menu: this.menuOpen,
      visible: this.world.visible[this.team], ipos: (t, o) => this.ipos(t, o), viewRange: viewRange(this.player),
      spec: this.spec, perf: this.perf, perfShow: this.perfShow, quality: this.quality,
    };
  }

  // ------------------------------------------------------------------ menu
  _openMenu() { if (this.menuOpen) return; this.menuOpen = true; this.input.unlock(); this._unlocking = true; this.hud.menu(true); }
  _closeMenu() { this.menuOpen = false; this.hud.menu(false); this.input.flush(); }
  _menuAction(a) {
    if (a === 'resume') { this._closeMenu(); this.input.lock(); }
    else if (a === 'settings') {
      this.hud.menu(false); this.menuOpen = false; this.settingsOpen = true;
      const S = this.screens; S.root.hidden = false; S.root.classList.add('sf-overlay'); S.bar.hidden = true;
      S.showSettings();
    } else if (a === 'leave') this.leave();
  }
  _closeSettings() {
    const S = this.screens; this.settingsOpen = false;
    S.root.classList.remove('sf-overlay'); S.root.hidden = true;
    this.settings = S.settings;
    this.hud.settings = this.settings; this.hud.applySettings?.();
    this.cam.baseFov = this.settings.fov || 70;
    if (!this.params.get('q')) {
      const want = this.settings.quality === 'auto' ? null : this.settings.quality;
      this.qFixed = want;
      if (want && want !== this.quality) this._setQuality(want);
    }
    this._openMenu();
  }
  // settings applied from the in-battle dialog (main forwards onSettings here)
  applySettings(s) { this.settings = s; }

  // Leaving counts as a defeat with the tank destroyed (for rewards).
  leave() {
    const w = this.world, me = this.player;
    this.left = true; this.menuOpen = false; this.hud.menu(false);
    if (!w.result && !me.alive) {
      // already destroyed: no desertion penalty, the rest of the battle plays out at speed (no sound)
      this.resolving = true; this.speed = Math.max(this.speed, 40); this.maxSteps = Math.max(this.maxSteps, 400);
      try { this.audio?.stopAll?.(); } catch { /* */ }
      this.hud.toast('Leaving: the battle is being resolved…', 'dim');
      return;
    }
    if (!w.result) {
      if (this.god) this._godOff();
      if (me.alive) { me.alive = false; me.hp = 0; me.deathCause = 'left'; }
      w.result = { winner: 1 - me.team, reason: 'left', time: w.time };
    }
  }

  _exit() {
    if (this.phase === 'done') return;
    this.phase = 'done';
    this.input.enable(false);
    try { this.audio?.stopAll?.(); } catch { /* */ }
    this.onExit?.({ world: this.world, playerId: this.player.id, left: this.left, battle: this.battle });
  }

  // ------------------------------------------------------------------ god mode (?fast / ?god)
  _godOn() { const t = this.player; this._godHp = t.maxHp; t.hp = t.maxHp * 1000; t.modules.ammoRack.hp = t.modules.ammoRack.max * 1000; }
  _godOff() { const t = this.player; if (t.alive) t.hp = Math.min(t.hp, t.maxHp); t.modules.ammoRack.hp = Math.min(t.modules.ammoRack.hp, t.modules.ammoRack.max); this.god = false; }

  // ------------------------------------------------------------------ perf & auto-quality
  _perf(dt, sim, ai, render, hud, steps, frame, audio) {
    const A = this._perfAcc;
    // a hidden tab / alt-tab / debugger pause is not a slow frame: drop the window so auto-quality
    // doesn't lower the graphics after every tab switch
    if (dt > 0.5 && !this.fast) { Object.assign(A, { n: 0, sim: 0, ai: 0, render: 0, hud: 0, frame: 0, steps: 0, cpu: 0, t: 0, audio: 0 }); return; }
    A.audio = (A.audio || 0) + audio;
    A.n++; A.sim += sim; A.ai += ai; A.render += render; A.hud += hud; A.frame += dt * 1000; A.steps += steps; A.cpu = (A.cpu || 0) + frame;
    A.t = (A.t || 0) + dt;
    if (A.t >= 1) {
      const P = this.perf, n = A.n;
      // sim and AI per step (ms), the rest per frame
      P.fps = n / A.t; P.frame = A.frame / n; P.sim = A.steps ? A.sim / A.steps : 0; P.ai = A.steps ? A.ai / A.steps : 0;
      P.render = A.render / n; P.hud = A.hud / n; P.cpu = A.cpu / n; P.steps = A.steps / n; P.audio = A.audio / n;
      const st = this.view.stats(); P.calls = st.calls; P.tris = st.tris;
      P.frames += n;
      if (this.phase === 'play' || this.phase === 'dead') P.win.push(P.frame);
      if (P.win.length > 5) P.win.shift();
      this._autoQuality();
      Object.assign(A, { n: 0, sim: 0, ai: 0, render: 0, hud: 0, frame: 0, steps: 0, cpu: 0, t: 0, audio: 0 });
    }
  }
  _autoQuality() {
    const P = this.perf;
    if (this.qFixed || P.win.length < 5 || this.menuOpen || this.resolving) return;
    const avg = P.win.reduce((a, b) => a + b, 0) / P.win.length;
    const i = TIERS.indexOf(this.quality);
    if (avg > 22 && i > 0) { this._setQuality(TIERS[i - 1]); P.drops.push({ at: this.world.time, to: this.quality, avg }); this.hud.toast(`Graphics quality lowered to ${this.quality} (${avg.toFixed(0)} ms/frame)`, 'dim'); }
  }
  _setQuality(q) {
    this.quality = q; this.view.setQuality(q); this._applyScale(); this.perf.win.length = 0;
  }

  dispose() {
    try { this.input?.dispose(); } catch { /* */ }
    window.removeEventListener('resize', this._onResize);
    document.removeEventListener('pointerlockchange', this._onLock);
    try { this.hud?.dispose(); } catch { /* */ }
    try { this.view?.dispose(); this.view?.renderer.forceContextLoss(); } catch { /* */ }
    this.canvas?.remove();
    this.world = null; this.brains = null;
  }
}

const label = (k) => ({ repair: 'Repair kit', medkit: 'First aid kit', extinguisher: 'Fire extinguisher' }[k] || k);
// Would a consumable do anything right now? (the sim refuses it silently otherwise)
const needs = (t, k) => (k === 'repair' ? Object.values(t.modules).some((m) => m.state !== 'ok')
  : k === 'medkit' ? Object.values(t.crew).some((c) => !c.alive) : k === 'extinguisher' ? !!t.fire : true);
const NOTHING = { repair: 'No damaged modules to repair', medkit: 'No injured crew', extinguisher: 'No fire to put out' };
