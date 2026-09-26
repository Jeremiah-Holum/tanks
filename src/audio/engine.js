// Continuous per-tank loops: engine + tracks (EnginePool) and fire crackle (FirePool). All nodes
// are built once per voice and only their params are updated per frame, so nothing is created in
// the steady state (bar the odd suspension thud / gear-shift clunk one-shot). Idle voices are torn down.
//
// Engine model: one oscillator runs at the crank-cycle frequency (rpm / 120) with a PeriodicWave
// holding one full 4-stroke cycle of exhaust pulses: `cyl` damped pulses per cycle, each cylinder a
// little different in strength and timing. So the firing frequency (rpm·cyl/120) and its harmonics
// form the stack, and the per-cylinder differences give sub-harmonics: a lumpy rumble, not a tone.
// → pre-drive (∝ load) → tanh → exhaust lowpass (opens with rpm·load) → muffler body boost.
// Combustion "gravel": noise amplitude-modulated by the same pulse wave (∝ load; diesel knock).
// Tracks: link clank + rattle (noise AM'd by pulse trains ∝ speed), pivot grind, suspension thuds.
import { clamp } from './core.js';

const TAU = 0.08;           // param smoothing time constant, s
const STALE_MS = 300;       // a voice not updated for this long fades out and is freed
const DESTROY_MS = 8000;    // a free voice idle this long is torn down (its sources stopped)
const MAX_DIST = 320;       // engines beyond this aren't worth a voice
// Turret traverse whine: removed. It was the owner's "high-pitched noise on mouse move": it treated
// turretRate (deg/s in the sim) as rad/s, so a mouse sweep pushed it to 10–17 kHz. Kept at 0 (no nodes).
const TURRET_WHINE = 0;

// Engine characters. idle/max rpm, cylinders, pulse decay (fraction of a firing interval), timing
// jitter, per-cylinder level spread, exhaust lowpass base/span, gravel band and level, drive.
const ENGINES = {
  radial: { cyl: 9, idle: 700, max: 2400, tau: 0.22, jit: 0.05, spread: 0.3, lp: 320, lpSpan: 1100, grav: 700, gravQ: 0.8, gravL: 0.5, drive: 2.2, sub: 0.8 },   // US Continental R-975 petrol radial: blatty
  maybach: { cyl: 12, idle: 750, max: 3000, tau: 0.3, jit: 0.025, spread: 0.18, lp: 280, lpSpan: 900, grav: 560, gravQ: 0.7, gravL: 0.35, drive: 1.8, sub: 0.6 }, // German Maybach V12 petrol: smoother, deeper roar
  diesel: { cyl: 12, idle: 550, max: 2000, tau: 0.16, jit: 0.06, spread: 0.35, lp: 300, lpSpan: 1000, grav: 1100, gravQ: 0.9, gravL: 0.9, drive: 2.8, sub: 0.9 }, // Soviet V-2 diesel: gruff, knocking
  small: { cyl: 6, idle: 800, max: 3200, tau: 0.25, jit: 0.05, spread: 0.3, lp: 380, lpSpan: 1200, grav: 800, gravQ: 0.8, gravL: 0.45, drive: 2, sub: 0.6 },     // light tanks: 6-cylinder
};
export function engineType(def = {}) {
  if ((def.mass || 30) < 14) return 'small';
  const n = String(def.nation || '').toLowerCase();
  return /ussr|soviet|russia/.test(n) ? 'diesel' : /germ|ger/.test(n) ? 'maybach' : 'radial';
}

// One 4-stroke cycle of exhaust pulses as a PeriodicWave (fundamental = cycle rate = rpm/120).
function cycleWave(ctx, E, seed, missing = -1) {
  const M = 1024, x = new Float32Array(M); let s = seed >>> 0;
  const R = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  for (let i = 0; i < E.cyl; i++) {
    const amp = (1 - E.spread / 2 + E.spread * R()) * (i === missing ? 0.12 : 1), at = (i + (R() - 0.5) * 2 * E.jit) / E.cyl, tau = E.tau / E.cyl, lam = 0.55 / E.cyl;
    for (let j = 0; j < M; j++) { let ph = j / M - at; if (ph < 0) ph += 1; if (ph > 6 * tau) continue; x[j] += amp * Math.exp(-ph / tau) * Math.sin(2 * Math.PI * ph / lam); }
  }
  const N = Math.min(192, E.cyl * 16), re = new Float32Array(N), im = new Float32Array(N);
  // DFT with a cos/sin table (n·j mod M): was ~200k Math.cos+sin per engine type, a 10–30 ms hitch
  const CS = cycleWave.cs || (cycleWave.cs = (() => { const t = new Float64Array(M * 2); for (let j = 0; j < M; j++) { t[j] = Math.cos(2 * Math.PI * j / M); t[M + j] = Math.sin(2 * Math.PI * j / M); } return t; })());
  for (let n = 1; n < N; n++) { let a = 0, b = 0; for (let j = 0, k = 0; j < M; j++, k = (k + n) & (M - 1)) { a += x[j] * CS[k]; b += x[j] * CS[M + k]; } re[n] = a * 2 / M; im[n] = b * 2 / M; }
  return ctx.createPeriodicWave(re, im);
}

// Narrow pulse train as a PeriodicWave: drives the track clank / rattle amplitude.
function pulseWave(ctx) {
  const n = 24, re = new Float32Array(n), im = new Float32Array(n), d = 0.14;
  for (let i = 1; i < n; i++) re[i] = Math.sin(Math.PI * i * d) / (Math.PI * i) * 2;
  return ctx.createPeriodicWave(re, im);
}

// Move an AudioParam towards v, smoothing in JS (time constant tau) and writing .value only
// when it changed noticeably. Plain .value writes leave the param un-automated, so filters
// don't recompute coefficients every sample (setTargetAtTime on a biquad frequency does).
let DT = 1 / 60;
function smooth(p, v, now, tau = TAU) {
  if (p._f) { p.cancelScheduledValues(0); p._f = false; }
  const s = p._s ?? p.value, n = s + (v - s) * (1 - Math.exp(-DT / tau));
  p._s = Math.abs(n - v) < 1e-5 ? v : n;
  if (Math.abs(p._s - p._w) < Math.abs(p._s) * 0.004 + 1e-5) return;
  p._w = p._s; p.value = p._s;
}
// fade to silence on a timeline (voice released; no more per-frame updates will come)
function fadeOut(p, now, tau) { p.cancelScheduledValues(now); p.setValueAtTime(p._w ?? p.value, now); p.setTargetAtTime(0, now, tau); p._s = p._w = 0; p._f = true; }

// Shared looping noise sources (one white, one brown per context), fanned out to every voice.
function shared(A) {
  if (A._eng) return A._eng;
  const K = A.kit, c = A.ctx;
  return (A._eng = { white: K.src(K.white, c.currentTime, null, 1), brown: K.src(K.brown, c.currentTime, null, 1), waves: {}, pulse: pulseWave(c) });
}

function engineWave(A, type, eng) {
  const W = shared(A).waves, key = type + ':' + eng;
  return W[key] || (W[key] = cycleWave(A.ctx, ENGINES[type], type.length * 7919 + 17, eng === 'damaged' ? 3 : -1));
}
// Build every engine character's cycle wave (ok + damaged) up front, so a newly heard tank type or a
// damaged engine never computes one mid-battle.
export function prewarmEngines(A) { if (!A.ctx) return; for (const type in ENGINES) for (const eng of ['ok', 'damaged']) engineWave(A, type, eng); }

class EngineVoice {
  constructor(A) {
    const c = A.ctx, sh = shared(A); this.A = A; this.id = null; this.last = 0; this.freeAt = 0; this.d = 0; this.type = null;
    this.srcs = [];
    const osc = (f) => { const o = c.createOscillator(); o.frequency.value = f; o.start(); this.srcs.push(o); return o; };
    const gain = (v) => { const g = c.createGain(); g.gain.value = v; return g; };
    const filt = (type, f, q, db) => { const b = c.createBiquadFilter(); b.type = type; b.frequency.value = f; b.Q.value = q; if (db) b.gain.value = db; return b; };
    const chain = (...n) => { for (let i = 0; i < n.length - 1; i++) n[i].connect(n[i + 1]); return n[n.length - 1]; };
    // output: level → distance lowpass → panner → sfx (+ field reverb send)
    this.out = gain(0); this.lp = filt('lowpass', 20000, 0.5); this.pan = c.createStereoPanner ? c.createStereoPanner() : null;
    this.send = gain(0);
    this.out.connect(this.lp);
    if (this.pan) { this.lp.connect(this.pan); this.pan.connect(A.sfx); this.pan.connect(this.send); } else this.lp.connect(A.sfx);
    this.send.connect(A.fieldSend);
    // exhaust: cycle wave → drive → tanh → exhaust lowpass → muffler body → level
    this.ex = osc(10); this.drv = gain(1); const ws = c.createWaveShaper(); ws.curve = A.kit.curve(3); ws.oversample = '2x';
    this.exLp = filt('lowpass', 300, 0.9); const body = filt('peaking', 95, 1, 6); this.engG = gain(0);
    chain(this.ex, this.drv, ws, this.exLp, body, this.engG, this.out);
    // combustion gravel / diesel knock: white noise band × the pulse wave
    this.gravBp = filt('bandpass', 700, 0.8); const gAm = gain(0), gDepth = gain(1); this.gravG = gain(0);
    chain(sh.white, this.gravBp, gAm, this.gravG, this.out); this.ex.connect(gDepth); gDepth.connect(gAm.gain);
    // low rumble (block, intake, ground) and mechanical noise (gears, fans)
    this.rumLp = filt('lowpass', 110, 0.7); this.rumG = gain(0); chain(sh.brown, this.rumLp, this.rumG, this.out);
    this.mechBp = filt('bandpass', 600, 0.6); this.mechG = gain(0); chain(sh.white, this.mechBp, this.mechG, this.out);
    // tracks: clank (links hitting sprocket/idler) and rattle (two pulse trains at a non-integer ratio)
    this.pA = osc(1); this.pB = osc(1); this.pA.setPeriodicWave(sh.pulse); this.pB.setPeriodicWave(sh.pulse);
    const clkBp = filt('bandpass', 420, 1.1), clkAm = gain(0.15), pAg = gain(0.85); this.clkG = gain(0);
    chain(sh.white, clkBp, clkAm, this.clkG, this.out); this.pA.connect(pAg); pAg.connect(clkAm.gain);
    const rtBp = filt('bandpass', 1000, 0.9), rtAm = gain(0.2), pBg = gain(0.8); this.rtG = gain(0);
    chain(sh.white, rtBp, rtAm, this.rtG, this.out); this.pB.connect(pBg); pBg.connect(rtAm.gain); this.pA.connect(pBg);
    // pivot grind: tracks scrubbing sideways (broad, low: no resonant squeal)
    this.grBp = filt('lowpass', 280, 1.1); this.grG = gain(0); chain(sh.brown, this.grBp, this.grG, this.out);
    this.rpm = 0; this.prevSpeed = 0; this.prevT = 0; this.gear = 0; this.shiftT = -1; this.thudT = 0; this.eng = 'ok';
  }
  // pick the engine character (per tank) and its cycle wave
  setType(tank) {
    const type = engineType(tank.def), eng = tank.modules?.engine?.state === 'damaged' ? 'damaged' : 'ok', key = type + ':' + eng;
    if (this.type === key) return; this.type = key; this.E = ENGINES[type];
    this.ex.setPeriodicWave(engineWave(this.A, type, eng));
    this.gravBp.frequency.value = this.E.grav; this.gravBp.Q.value = this.E.gravQ;
  }
  // ?debug=audio: every gain stage of this voice (keys ending in G) + the output level
  debug() { const o = { id: this.id, pl: this.pl ? 1 : 0, type: this.type, rpm: +this.rpm.toFixed(2), out: +(this.out.gain._w ?? 0).toFixed(3) }; for (const k in this) if (/G$/.test(k) && this[k]?.gain) o[k] = +(this[k].gain._w ?? this[k].gain.value).toFixed(4); return o; }
  destroy() { for (const s of this.srcs) { try { s.stop(); } catch (e) {} } try { this.out.disconnect(); this.send.disconnect(); } catch (e) {} }
  silence(now) { fadeOut(this.out.gain, now, 0.15); this.id = null; this.type = null; this.freeAt = performance.now(); }

  update(tank, pl, isPlayer, now) {
    this.pl = isPlayer; this.setType(tank);
    const E = this.E, K = this.A.kit, def = tank.def || {}, top = (def.speed || 40) / 3.6, v = Math.abs(tank.speed || 0), sf = clamp(v / top);
    const dt = clamp(now - this.prevT, 1e-3, 0.1), acc = (v - this.prevSpeed) / Math.max(dt, 0.016); this.prevT = now; this.prevSpeed = v;
    DT = clamp(dt, 0.004, 0.1);
    const eng = tank.modules?.engine?.state, on = tank.alive !== false && eng !== 'destroyed' ? 1 : 0;
    // load: the applied throttle if the sim exposes it, else inferred from acceleration
    const thr = Math.abs(tank.throttle ?? tank.controls?.throttle ?? (acc > 0.15 ? 1 : sf > 0.05 ? 0.55 : 0));
    const turning = clamp(Math.abs(tank.yawRate || 0) / 0.6);
    // five-gear rpm model: rpm climbs through each gear band and drops at the shift; a shift is
    // a short throttle lift with a clunk, so it's audible as a drop and rise
    let rpm, gear = 0;
    if (sf < 0.03) rpm = 0.12 * thr + 0.03 * turning;   // a pivot on the spot only nudges the revs
    else { const gs = Math.min(4.999, sf * 5); gear = Math.floor(gs); rpm = 0.3 + 0.62 * (gs - gear) * (0.75 + 0.25 * thr) + 0.08 * thr; }
    if (gear !== this.gear) { if (gear > this.gear && thr > 0.3 && on) { this.shiftT = now; if (isPlayer || this.d < 60) K.punch(this.out, now + 0.02, { f: 110, f1: 50, gain: 0.12, nf: 300 }); } this.gear = gear; }
    const shifting = now - this.shiftT < 0.28;
    if (!on) rpm = 0;
    this.rpm += (rpm - this.rpm) * clamp(dt * (shifting ? 9 : 5));
    let load = clamp(0.15 + 0.85 * thr) * (shifting ? 0.25 : 1);
    const overrun = thr < 0.1 && sf > 0.15 ? 1 : 0;            // engine braking
    const r = this.rpm, rpmAbs = E.idle + (E.max - E.idle) * r;
    const wob = eng === 'damaged' ? 1 + 0.04 * Math.sin(now * 17) : 1 + 0.006 * Math.sin(now * 2.3);
    smooth(this.ex.frequency, rpmAbs / 120 * wob, now, 0.04);
    smooth(this.drv.gain, 0.5 + E.drive * load * (0.6 + 0.4 * r), now, 0.06);
    smooth(this.exLp.frequency, E.lp + E.lpSpan * r * (0.35 + 0.65 * load) - 80 * overrun, now);
    smooth(this.engG.gain, on * (0.16 + 0.12 * load + 0.06 * r), now);
    smooth(this.gravG.gain, on * E.gravL * (0.05 + 0.25 * load * (0.4 + r) * clamp(sf * 4 + thr) + 0.12 * overrun), now);
    smooth(this.rumG.gain, on * (0.25 + 0.2 * load) * E.sub + 0.35 * sf, now);
    smooth(this.rumLp.frequency, 90 + 90 * r + 40 * sf, now);
    smooth(this.mechG.gain, on * (0.01 + 0.03 * r), now);
    smooth(this.mechBp.frequency, 450 + 500 * r, now);
    // tracks: clank at the sprocket rate, rattle at a link rate; both ∝ speed; pivot grind
    const moving = clamp(v / 1.5), alive = tank.alive === false ? 0 : 1;
    smooth(this.pA.frequency, 0.4 + v * 1.6, now, 0.05); smooth(this.pB.frequency, 0.6 + v * 3.7, now, 0.05);
    smooth(this.clkG.gain, alive * moving * (0.25 + 0.2 * sf), now);
    smooth(this.rtG.gain, alive * moving * (0.03 + 0.1 * sf), now);
    smooth(this.grG.gain, alive * turning * 0.2, now);
    // suspension thuds over rough ground: occasional one-shots, more at speed
    if (alive && v > 2 && (isPlayer || this.d < 80) && now > this.thudT) {
      this.thudT = now + 0.25 + (1.8 - 1.2 * sf) * K.R();
      if (K.R() < 0.6) K.punch(this.out, now + 0.02, { f: 90 + 40 * K.R(), f1: 35, fdur: 0.05, gain: 0.08 + 0.12 * sf * K.R(), nf: 250 });
    }
    // recorded engine loop (assets/sfx/engine.*) replaces the synth exhaust + gravel: rate follows rpm
    const smp = K.samples?.engine;
    if (smp && !this.smp) { this.smp = K.src(smp, this.A.ctx.currentTime, null, 1); this.srcs.push(this.smp); this.smpG = this.A.ctx.createGain(); this.smpG.gain.value = 0; this.smp.connect(this.smpG); this.smpG.connect(this.out); }
    if (this.smp) {
      smooth(this.smp.playbackRate, 0.7 + 0.9 * r, now, 0.05); smooth(this.smpG.gain, on * (0.5 + 0.35 * load), now);
      smooth(this.engG.gain, 0, now); smooth(this.gravG.gain, 0, now);
    }
    // placement
    const P = this.A._pos(tank.pos, { ref: 6, roll: 1, range: 0.8 });
    this.d = isPlayer ? 0 : P.d;
    smooth(this.out.gain, isPlayer ? 0.32 : P.gain * 0.45, now, 0.1);
    smooth(this.lp.frequency, isPlayer ? 8000 : P.lp, now, 0.1);
    if (this.pan) smooth(this.pan.pan, isPlayer ? 0 : P.pan, now, 0.05);
    smooth(this.send.gain, isPlayer ? 0.05 : P.wet * 0.5, now, 0.2);
  }
}
export class EnginePool {
  constructor(A, max = 7) { this.A = A; this.max = max; this.voices = []; this.byId = new Map(); }
  update(tank, isPlayer) {
    const A = this.A, now = A.ctx.currentTime, ms = performance.now();
    this.gc(ms, now);
    let v = this.byId.get(tank.id);
    if (!v) {
      if (tank.alive === false) return;
      const d = isPlayer ? 0 : A._dist(tank.pos);
      if (d > MAX_DIST) return;
      v = this.voices.find((x) => x.id === null);
      // building a voice is ~25 audio nodes: at most one per 50 ms, so a group of tanks coming into
      // earshot at once (spotting) doesn't build 7 in one frame; the others get theirs next frames
      if (!v && this.voices.length < this.max) { if (ms - (this._builtAt || 0) < 50) return; this._builtAt = ms; v = new EngineVoice(A); this.voices.push(v); }
      if (!v) { // steal the farthest non-player voice if this tank is clearly closer
        let far = null; for (const x of this.voices) if (x.d > 0 && (!far || x.d > far.d)) far = x;
        if (!far || far.d < d + 15) return;
        this.byId.delete(far.id); v = far;
      }
      v.id = tank.id; this.byId.set(tank.id, v); v.prevT = now; v.prevSpeed = Math.abs(tank.speed || 0);
    } else if (!isPlayer && (tank.alive === false || A._dist(tank.pos) > MAX_DIST + 30)) { this.byId.delete(tank.id); v.silence(now); return; }
    v.last = ms;
    v.update(tank, A.listener, isPlayer, now);
  }
  gc(ms, now) {
    if (ms - (this._gcAt || 0) < 100) return; this._gcAt = ms;
    for (let i = this.voices.length - 1; i >= 0; i--) {
      const v = this.voices[i];
      if (v.id !== null && ms - v.last > STALE_MS) { this.byId.delete(v.id); v.silence(now); }
      else if (v.id === null && ms - v.freeAt > DESTROY_MS) { v.destroy(); this.voices.splice(i, 1); }
    }
  }
  stopAll() { const now = this.A.ctx.currentTime; for (const v of this.voices) if (v.id !== null) v.silence(now); this.byId.clear(); }
  get active() { return this.byId.size; }
}

// Burning tanks: roar + crackle loops, nearest few only, positions refreshed via engine() calls.
class FireVoice {
  constructor(A) {
    const c = A.ctx, K = A.kit; this.A = A; this.id = null; this.until = 0;
    this.srcs = [K.src(K.crackle, c.currentTime, null, 1), K.src(K.brown, c.currentTime, null, 1)];
    this.out = c.createGain(); this.out.gain.value = 0; this.out.gain._v = 0;
    const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 900;
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 380;
    const cg = c.createGain(); cg.gain.value = 1.3; const rg = c.createGain(); rg.gain.value = 0.35;
    this.srcs[0].connect(hp); hp.connect(cg); cg.connect(this.out); this.srcs[1].connect(lp); lp.connect(rg); rg.connect(this.out);
    this.lp = c.createBiquadFilter(); this.lp.type = 'lowpass'; this.lp.frequency.value = 20000; this.lp.frequency._v = 20000;
    this.pan = c.createStereoPanner ? c.createStereoPanner() : null;
    this.out.connect(this.lp); if (this.pan) { this.lp.connect(this.pan); this.pan.connect(A.sfx); } else this.lp.connect(A.sfx);
  }
  place(pos, isPlayer, level = 1) {
    const A = this.A, now = A.ctx.currentTime, P = A._pos(pos, { ref: 5, roll: 1.2, range: 0.6 });
    smooth(this.out.gain, (isPlayer ? 0.3 : P.gain * 0.5) * level, now, 0.3);
    smooth(this.lp.frequency, isPlayer ? 6000 : P.lp, now, 0.2);
    if (this.pan) smooth(this.pan.pan, isPlayer ? 0 : P.pan, now, 0.1);
  }
  destroy() { for (const s of this.srcs) { try { s.stop(); } catch (e) {} } try { this.lp.disconnect(); if (this.pan) this.pan.disconnect(); } catch (e) {} }
}

export class FirePool {
  constructor(A, max = 4) { this.A = A; this.max = max; this.voices = []; }
  start(id, pos, isPlayer, secs = 60, level = 1) {
    if (this.A._dist(pos) > 250 && !isPlayer) return;
    let v = this.voices.find((x) => x.id === id) || this.voices.find((x) => x.id === null);
    if (!v && this.voices.length < this.max) { v = new FireVoice(this.A); this.voices.push(v); }
    if (!v) return;
    v.id = id; v.pos = pos; v.player = isPlayer; v.level = level; v.until = this.A.ctx.currentTime + secs;
    v.place(pos, isPlayer, level);
  }
  // wreck keeps burning for `secs` more, quieter
  linger(id, secs, level = 0.6) { const v = this.voices.find((x) => x.id === id); if (v) { v.until = Math.min(v.until, this.A.ctx.currentTime + secs); v.level = level; v.place(v.pos, v.player, level); } }
  stop(id) { const v = this.voices.find((x) => x.id === id); if (v) { fadeOut(v.out.gain, this.A.ctx.currentTime, 0.4); v.id = null; } }
  refresh(tank, isPlayer) {
    const now = this.A.ctx.currentTime;
    for (const v of this.voices) {
      if (v.id === null) continue;
      if (now > v.until) { fadeOut(v.out.gain, now, 1); v.id = null; continue; }
      if (tank && v.id === tank.id) { v.pos = tank.pos; v.player = isPlayer; v.place(tank.pos, isPlayer, v.level); }
    }
  }
  stopAll() { for (const v of this.voices) if (v.id !== null) this.stop(v.id); }
}
