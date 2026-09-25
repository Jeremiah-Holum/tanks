// Steel Front audio: all Web Audio synthesis (no files) + speechSynthesis crew voice.
// Contract (docs/DESIGN.md): new Audio(); .unlock(); .setVolumes({master,sfx,music,voice});
// .event(ev, world, listener); .engine(tank, listener); .ui(kind); .music(on); .say(line).
// Safe to import in node and to call before unlock(): without an AudioContext everything no-ops.
// Details, event→sound table and tests: docs/notes/audio.md.
import { Kit, clamp } from './audio/core.js';
import * as S from './audio/sfx.js';
import { EnginePool, FirePool } from './audio/engine.js';
import { Music } from './audio/music.js';
import { Crew, LINES } from './audio/speech.js';

const SOUND = 343;          // m/s
const MAX_DELAY = 0.6;      // cap on the speed-of-sound delay, s
const MAX_ONESHOTS = 40;    // concurrent one-shot sounds before quiet ones are dropped
const ROLE_LINE = { commander: 'commander', gunner: 'gunner', driver: 'driver', radioman: 'radioman', radio: 'radioman', loader: 'loader' };
const MODULE_LINE = { engine: ['engineDmg', 'engineDead'], gun: ['gunDmg', 'gunDead'], ammoRack: ['ammoDmg', 'ammoDmg'], fuel: ['fuelDmg', 'fuelDmg'], turretRing: ['ringDmg', 'ringDmg'], trackL: [null, 'trackDead'], trackR: [null, 'trackDead'] };

const idOf = (x) => (x && typeof x === 'object' ? x.id : x);

export class Audio {
  // opts.context: use this (e.g. OfflineAudioContext) instead of creating one on unlock().
  constructor(opts = {}) {
    this.ctx = null; this.offline = false;
    this.vol = { master: 0.8, sfx: 0.9, music: 0.5, voice: 0.9 };
    this.listener = { pos: { x: 0, y: 0, z: 0 }, fwd: { x: 0, y: 0, z: 1 }, playerId: null };
    this.crew = new Crew(this);
    this.maxEngines = opts.maxEngines ?? 7;
    this._ends = []; this._cap = new Map(); this._raw = !!opts.raw;
    if (opts.context) this._init(opts.context, true);
  }

  get ready() { return !!this.ctx && (this.offline || this.ctx.state === 'running'); }
  get voiceOn() { return this.crew.on; }
  set voiceOn(v) { this.crew.on = !!v; if (!v) this.crew.cancel(); }

  // Call from a user gesture. Creates/resumes the context. Returns true if audio is available.
  unlock() {
    try {
      if (!this.ctx) {
        const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
        if (!AC) return false;
        this._init(new AC({ latencyHint: 'interactive' }), false);
      }
      if (!this.offline && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    } catch (e) { console.warn('audio unavailable', e); this.ctx = null; return false; }
    this.crew.init();
    return true;
  }

  _init(ctx, offline) {
    this.ctx = ctx; this.offline = offline;
    const c = ctx, K = this.kit = new Kit(c);
    const G = (v, to) => { const g = c.createGain(); g.gain.value = v; if (to) g.connect(to); return g; };
    // master → compressor → tanh soft clip → out (guarantees |x| < 1)
    this.comp = c.createDynamicsCompressor();
    this.comp.threshold.value = -10; this.comp.knee.value = 6; this.comp.ratio.value = 8; this.comp.attack.value = 0.002; this.comp.release.value = 0.25;
    this.clip = c.createWaveShaper(); this.clip.curve = K.limitCurve(); this.clip.oversample = '2x';
    this.master = G(this.vol.master);
    if (this._raw) this.master.connect(c.destination); // measurement mode: no limiter (tools/audio-render.mjs)
    else { this.master.connect(this.comp); this.comp.connect(this.clip); this.clip.connect(c.destination); }
    this.sfx = G(this.vol.sfx * 0.55, this.master);          // 0.55: headroom for stacked one-shots
    this.musicBus = G(this.vol.music * 0.8, this.master);
    this.uiBus = G(0.8, this.sfx); this.amb = G(1, this.sfx);
    // reverbs: open field (long, echoey) for the world; steel box for inside the player's tank;
    // a hall for music (same IR, separate so it follows the music volume)
    const verb = (ir, ret, to) => { const cv = c.createConvolver(); cv.buffer = ir; const send = G(1); send.connect(cv); cv.connect(G(ret, to)); return send; };
    this.fieldSend = verb(K.fieldIR, 0.45, this.sfx);
    this.roomSend = verb(K.roomIR, 0.3, this.sfx);
    this.hallSend = verb(K.fieldIR, 0.4, this.musicBus);
    // inside-the-tank bus: slightly muffled, with the steel-box room
    this.inside = G(1); const inLp = c.createBiquadFilter(); inLp.type = 'lowpass'; inLp.frequency.value = 5500;
    this.inside.connect(inLp); inLp.connect(this.sfx); this.inside.connect(G(0.6, this.roomSend));
    this.engines = new EnginePool(this, this.maxEngines);
    this.fires = new FirePool(this);
    this.mus = new Music(this);
    if (this._wantMusic) this.music(this._wantMusic);
  }

  setVolumes(v = {}) {
    for (const k of ['master', 'sfx', 'music', 'voice']) if (v[k] != null && isFinite(v[k])) this.vol[k] = clamp(+v[k]);
    if (v.voiceOn != null) this.voiceOn = v.voiceOn;
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.vol.master, now, 0.03);
    this.sfx.gain.setTargetAtTime(this.vol.sfx * 0.55, now, 0.03);
    this.musicBus.gain.setTargetAtTime(this.vol.music * 0.8, now, 0.03);
  }

  // ---------- geometry ----------
  _setListener(l) {
    if (!l) return; const L = this.listener;
    if (l.pos) L.pos = l.pos; if (l.fwd) L.fwd = l.fwd; if (l.playerId !== undefined) L.playerId = l.playerId;
  }
  _dist(p) { if (!p) return 0; const L = this.listener.pos; return Math.hypot(p.x - L.x, (p.y ?? L.y) - L.y, p.z - L.z); }
  // Distance gain (inverse with rolloff), air-absorption lowpass, pan, reverb wetness, delay.
  _pos(p, o = {}) {
    const L = this.listener, ref = o.ref ?? 10, roll = o.roll ?? 1, range = o.range ?? 1;
    if (!p) return { d: 0, gain: 1, lp: 20000, pan: 0, wet: 0.15, delay: 0 };
    const dx = p.x - L.pos.x, dz = p.z - L.pos.z, d = Math.hypot(dx, (p.y ?? L.pos.y) - L.pos.y, dz);
    const fl = Math.hypot(L.fwd.x, L.fwd.z) || 1, fx = L.fwd.x / fl, fz = L.fwd.z / fl;
    const h = Math.hypot(dx, dz), side = h > 0.5 ? (dx * -fz + dz * fx) / h : 0, front = h > 0.5 ? (dx * fx + dz * fz) / h : 1;
    const gain = ref / (ref + roll * Math.max(0, d - ref));
    const lp = clamp(20000 * Math.exp(-d / (220 * range)), 500, 20000) * (front < -0.3 ? 0.7 : 1);
    return { d, gain, lp, pan: clamp(side, -1, 1) * 0.85 * clamp(h / 4), wet: clamp(0.12 + d / 700, 0.12, 0.85), delay: Math.min(d / SOUND, MAX_DELAY) };
  }
  // Build a placement chain for one sound: in → lowpass → pan → sfx, with a field-reverb send.
  // Returns {node, t} or null if inaudible / over budget. o: _pos opts + gain, wet, minGain, noDelay, bus
  _place(p, o = {}) {
    const c = this.ctx, P = this._pos(p, o);
    const gain = Math.max(P.gain, o.minGain || 0) * (o.gain ?? 1);
    if (gain < 0.004) return null;
    const now = c.currentTime + 0.01;
    this._ends = this._ends.filter((e) => e > now);
    if (this._ends.length >= MAX_ONESHOTS && gain < 0.25) return null;
    this._ends.push(now + (o.len || 2));
    const t = now + (o.noDelay ? 0 : P.delay);
    const g = c.createGain(); g.gain.value = gain;
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = o.lp ?? P.lp; lp.Q.value = 0.5;
    g.connect(lp);
    let head = lp;
    if (c.createStereoPanner && P.d > 0.5) { const pn = c.createStereoPanner(); pn.pan.value = o.pan ?? P.pan; lp.connect(pn); head = pn; }
    head.connect(o.bus || this.sfx);
    const wet = (o.wet ?? 0.25) * (o.wetScale ?? 1) * (0.5 + P.wet);
    if (wet > 0.01) { const s = c.createGain(); s.gain.value = wet; head.connect(s); s.connect(this.fieldSend); }
    return { node: g, t, P };
  }
  // Non-positional one-shot straight into a bus.
  _direct(bus, len = 2) {
    const c = this.ctx, now = c.currentTime + 0.01; this._ends = this._ends.filter((e) => e > now); this._ends.push(now + len);
    return { node: bus, t: now };
  }

  // ---------- world helpers ----------
  _isPlayer(x) { const id = idOf(x); return id != null && id === this.listener.playerId; }
  _tank(world, x) { if (x && typeof x === 'object') return x; return world && world.tanks ? world.tanks.find((t) => t.id === x) || null : null; }
  _shell(world, x) { if (x && typeof x === 'object') return x; return world && world.shells ? world.shells.find((s) => s.id === x) || null : null; }
  // calibre: event → shell → the firing tank's gun → 75 mm
  _cal(world, ev, sh, owner) { return ev.cal ?? sh?.cal ?? this._tank(world, owner)?.gunDef?.cal ?? 75; }
  _playerTeam(world) { const t = this._tank(world, this.listener.playerId); return t ? t.team : 0; }
  _obj(world, x) {
    if (x && typeof x === 'object') return x;
    const objs = world && world.map && world.map.objects; if (!objs) return null;
    return (objs[x] && objs[x].id === x) ? objs[x] : objs.find((o) => o.id === x) || null;
  }

  // ---------- contract: events ----------
  event(ev, world, listener) {
    if (listener) this._setListener(listener);
    if (!ev) return;
    const type = ev.type || ev.kind || ev.e;
    // voice lines work even with no AudioContext (speechSynthesis is separate)
    try { if (type === 'capture') this._lastCap = this._capState(ev, world || {}); if (this.ready) this._sound(type, ev, world || {}); this._voice(type, ev, world || {}); }
    catch (e) { if (!this._warned) { this._warned = true; console.warn('audio event failed', type, e); } }
  }

  _sound(type, ev, world) {
    const K = this.kit;
    switch (type) {
      case 'shot': {
        const tk = this._tank(world, ev.tank), sh = this._shell(world, ev.shell);
        const cal = ev.cal ?? sh?.cal ?? tk?.gunDef?.cal ?? 75, brake = !!tk?.gunDef?.muzzleBrake, k = S.size(cal);
        if (this._isPlayer(ev.tank)) {
          const p = this._direct(this.sfx, 3); const s = this.ctx.createGain(); s.gain.value = 0.25 + 0.35 * k; s.connect(this.fieldSend);
          const g = this.ctx.createGain(); g.gain.value = 1; g.connect(this.sfx); g.connect(s);
          S.cannon(K, g, p.t, cal, { player: true, brake });
        } else {
          const p = this._place(ev.pos || tk?.pos, { ref: 15, roll: 0.45, range: 1.4, wet: 0.35 + 0.5 * k, len: 1 + 2 * k, gain: 0.55 + 0.45 * k });
          if (p) S.cannon(K, p.node, p.t, cal, { brake });
        }
        break;
      }
      case 'impact': {
        // tank hits also raise a 'hit' event, which carries the sound; wrecks clang here
        if (ev.surface === 'tank') break;
        const sh = this._shell(world, ev.shell), owner = sh?.owner ?? ev.owner, cal = this._cal(world, ev, sh, owner), st = ev.shellType ?? sh?.type;
        const p = this._place(ev.pos, { ref: 15, roll: 0.6, wet: 0.3, len: 1.5 });
        if (!p) break;
        if (st === 'HE') S.explosion(K, p.node, p.t, 0.3 + 1.2 * S.size(cal), { gain: 0.8 });
        else S.impact(K, p.node, p.t, ev.surface, cal);
        // near miss: a shell landing close to us that we didn't fire
        if (p.P.d < 30 && owner != null && !this._isPlayer(owner)) { const q = this._place(ev.pos, { ref: 10, noDelay: true, gain: 0.8 }); if (q) S.snap(K, q.node, q.t); }
        break;
      }
      case 'hit': {
        const sh = this._shell(world, ev.shell), cal = this._cal(world, ev, sh, ev.shooter), st = ev.shellType ?? sh?.type, r = ev.result || 'pen';
        const tgt = this._tank(world, ev.target), pos = ev.pos || tgt?.pos;
        if (this._isPlayer(ev.target)) {
          const p = this._direct(this.inside, 3); S.hitInside(K, p.node, p.t, r, cal, { gain: 0.9 });
          if (st === 'HE') S.explosion(K, p.node, p.t, 0.4 + S.size(cal), { gain: 0.5 });
        } else {
          // the shooter hears his own hit confirmed right away (no delay, floor on level)
          const mine = this._isPlayer(ev.shooter);
          const p = this._place(pos, mine ? { ref: 10, roll: 0.6, minGain: 0.75, noDelay: true, lp: 12000, wet: 0.25, len: 1.5 } : { ref: 10, roll: 0.8, wet: 0.3, len: 1.5 });
          if (!p) break;
          S.hitOutside(K, p.node, p.t, r, cal, { gain: mine ? 0.9 : 1 });
          if (st === 'HE' && r !== 'splash') S.explosion(K, p.node, p.t, 0.3 + S.size(cal), { gain: 0.6 });
        }
        break;
      }
      case 'kill': {
        const v = this._tank(world, ev.victim), pos = v?.pos || ev.pos, big = ev.cause === 'ammorack';
        const pl = this._isPlayer(ev.victim);
        const p = pl ? this._direct(this.inside, 4) : this._place(pos, { ref: 15, roll: 0.5, range: 1.3, wet: big ? 0.8 : 0.5, len: 3, gain: big ? 1 : 0.8 });
        if (p) { if (big) S.ammorack(K, p.node, p.t, { gain: pl ? 0.8 : 1 }); else S.explosion(K, p.node, p.t, ev.cause === 'ram' ? 1 : 1.6, { gain: 0.8 }); }
        // wreck burns for a while
        if (pos) { this.fires.linger(idOf(ev.victim), 20); if (big) this.fires.start(idOf(ev.victim), pos, false, 20, 0.7); }
        break;
      }
      case 'fire': {
        const tk = this._tank(world, ev.tank), pl = this._isPlayer(ev.tank);
        if (ev.on === false) { this.fires.stop(idOf(ev.tank)); break; }
        if (!tk) break;
        const p = pl ? this._direct(this.inside) : this._place(tk.pos, { ref: 8, roll: 1, wet: 0.2 });
        if (p) S.ignite(K, p.node, p.t);
        this.fires.start(tk.id, tk.pos, pl);
        break;
      }
      case 'module': {
        if (!this._isPlayer(ev.tank)) break;
        const p = this._direct(this.inside);
        if (ev.module === 'engine' && ev.state !== 'ok') S.engineCough(K, p.node, p.t);
        else if ((ev.module === 'trackL' || ev.module === 'trackR') && ev.state === 'destroyed') S.trackBreak(K, p.node, p.t);
        break;
      }
      case 'spot': {
        if (this._isPlayer(ev.tank) && ev.on !== false && ev.team !== this._playerTeam(world)) { const p = this._direct(this.uiBus); S.alert(K, p.node, p.t, 'spotted'); }
        break;
      }
      case 'treeFall': case 'objectBreak': {
        const o = this._obj(world, ev.obj), pos = o ? { x: o.x, y: o.y ?? 0, z: o.z } : ev.pos;
        const p = this._place(pos, { ref: 12, roll: 0.8, wet: 0.3, len: 2, gain: 1.4 });
        if (p) (type === 'treeFall' ? S.treeFall : S.crash)(K, p.node, p.t);
        break;
      }
      case 'ram': {
        const a = this._tank(world, ev.a), b = this._tank(world, ev.b);
        const pl = this._isPlayer(ev.a) || this._isPlayer(ev.b);
        const pos = a && b ? { x: (a.pos.x + b.pos.x) / 2, y: (a.pos.y + b.pos.y) / 2, z: (a.pos.z + b.pos.z) / 2 } : (a || b)?.pos;
        const p = pl ? this._direct(this.inside) : this._place(pos, { ref: 10, roll: 0.9, wet: 0.25 });
        if (p) S.ram(K, p.node, p.t, ev.dmg);
        break;
      }
      case 'capture': {
        const c = this._lastCap;
        if (c) { const p = this._direct(this.uiBus); S.alert(K, p.node, p.t, c); }
        break;
      }
      case 'consumable': {
        if (!this._isPlayer(ev.tank)) break;
        const p = this._direct(this.inside); S.consumable(K, p.node, p.t, ev.kind);
        if (ev.kind === 'extinguisher') this.fires.stop(idOf(ev.tank));
        break;
      }
      case 'reloaded': {
        if (!this._isPlayer(ev.tank)) break;
        const tk = this._tank(world, ev.tank), p = this._direct(this.inside);
        S.reload(K, p.node, p.t, tk?.gunDef?.cal ?? 75);
        break;
      }
      case 'end': {
        const w = ev.result?.winner, pt = this._playerTeam(world);
        this.engines.stopAll(); this.fires.stopAll();
        this.mus.stinger(w === pt);
        break;
      }
    }
  }

  // Capture state machine: announce when a base starts being captured (points leave 0).
  // capture.team is taken as the base's owner (see notes: contract clarification requested).
  _capState(ev, world) {
    const team = ev.team, pts = ev.points ?? 0, prev = this._cap.get(team) ?? 0;
    this._cap.set(team, pts);
    if (pts <= 0.01 || prev > 0.01) return null;
    return team === this._playerTeam(world) ? 'baseLost' : 'baseWin';
  }

  _voice(type, ev, world) {
    const say = (k) => this.crew.say(k);
    switch (type) {
      case 'hit': {
        const r = ev.result;
        if (this._isPlayer(ev.shooter) && !this._isPlayer(ev.target)) {
          const k = { pen: 'pen', nopen: 'nopen', ricochet: 'ricochet', crit: 'crit', track: 'track' }[r] || (r === 'splash' && ev.dmg > 0 ? 'hit' : null);
          if (k) say(k);
        } else if (this._isPlayer(ev.target)) {
          const k = { ricochet: 'bounceUs', nopen: 'heldUs', pen: 'hitUs', splash: ev.dmg > 0 ? 'hitUs' : null }[r];
          if (k) say(k);
        }
        break;
      }
      case 'kill':
        if (this._isPlayer(ev.victim)) say('killed');
        else if (this._isPlayer(ev.killer)) say('kill');
        break;
      case 'fire':
        if (this._isPlayer(ev.tank)) say(ev.on === false ? 'fireOut' : 'fire');
        break;
      case 'module': {
        if (!this._isPlayer(ev.tank)) break;
        if (ev.state === 'ok') { say('repaired'); break; }
        const m = MODULE_LINE[ev.module]; const k = m && m[ev.state === 'destroyed' ? 1 : 0];
        if (k) say(k);
        break;
      }
      case 'crew':
        if (this._isPlayer(ev.tank) && ev.alive === false) { const k = ROLE_LINE[String(ev.role).replace(/\d+$/, '')]; if (k) say(k); }
        break;
      case 'spot': {
        if (ev.on === false) break;
        const pt = this._playerTeam(world);
        if (this._isPlayer(ev.tank) && ev.team !== pt) say('spotted');
        else if (ev.team === pt) { const t = this._tank(world, ev.tank); if (t && t.team !== pt) say('enemySpotted'); }
        break;
      }
      case 'capture': {
        if (this._lastCap) say(this._lastCap);
        break;
      }
      case 'consumable':
        if (this._isPlayer(ev.tank) && ev.kind === 'medkit') say('healed');
        break;
      case 'reloaded': {
        if (!this._isPlayer(ev.tank)) break;
        const tk = this._tank(world, ev.tank);
        if ((tk?.gunDef?.reload ?? 0) >= 4.5) say('reloaded');
        break;
      }
      case 'end': {
        const w = ev.result?.winner, pt = this._playerTeam(world);
        say(w === -1 || w == null ? 'draw' : w === pt ? 'victory' : 'defeat');
        break;
      }
    }
  }

  // ---------- contract: continuous sounds ----------
  // Call every frame for each tank you want audible (at least the player + nearby tanks).
  // Voice budget: the player + the nearest others (maxEngines total); the rest are culled.
  engine(tank, listener) {
    if (listener) this._setListener(listener);
    if (!this.ready || !tank || !tank.pos) return;
    try {
      const pl = this._isPlayer(tank);
      this.engines.update(tank, pl);
      this.fires.refresh(tank, pl);
    } catch (e) { if (!this._warnedE) { this._warnedE = true; console.warn('audio engine failed', e); } }
  }

  ui(kind) {
    if (!this.ready) return;
    if (kind === 'hover') { const n = this.ctx.currentTime; if (n - (this._hoverAt ?? -1) < 0.04) return; this._hoverAt = n; }
    const p = this._direct(this.uiBus, 2); S.ui(this.kit, p.node, p.t, kind);
  }

  // music(true | 'menu') → menu loop; music('battle') → battle ambience; music(false) → stop.
  music(on) {
    const mode = on === true ? 'menu' : on || null;
    this._wantMusic = mode;
    if (!this.ctx) return;
    if (!mode) this.mus.stop(); else this.mus.start(mode);
  }

  // Crew voice line: a LINES key ('pen', 'spotted', …) or free text. Toggle with voiceOn.
  say(line, prio) { return this.crew.say(line, prio); }

  // Radio click before a crew line.
  _squelch() { if (this.ready && this.vol.voice > 0) { const p = this._direct(this.uiBus, 0.2); S.ui(this.kit, p.node, p.t, 'squelch'); } }

  // Stop all loops (leaving a battle).
  stopAll() { if (!this.ctx) return; this.engines.stopAll(); this.fires.stopAll(); this.crew.cancel(); }
  stats() { return { ctx: this.ctx ? this.ctx.state : 'none', engines: this.ctx ? this.engines.active : 0, voices: this.ctx ? this.engines.voices.length : 0, oneshots: this._ends.length, music: this.ctx ? this.mus.mode : null }; }

  // --- legacy shims for the old toy-game main.js until INTEGRATION replaces it ---
  play(kind) { this.ui({ uiBig: 'battleStart', banner: 'battleStart', win: 'research', lose: 'error' }[kind] || 'click'); }
  startMusic() { this.music('menu'); }
  stopMusic() { this.music(false); }
}

export { LINES };
