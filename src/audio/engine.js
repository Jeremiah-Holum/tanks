// Continuous per-tank loops: engine + tracks + turret whine (EnginePool) and fire crackle
// (FirePool). All nodes are built once per voice and only their params are automated per
// frame, so nothing is created in the steady state. Voices idle for a while are torn down.
import { clamp } from './core.js';

const TAU = 0.08;           // param smoothing time constant, s
const STALE_MS = 300;       // a voice not updated for this long fades out and is freed
const DESTROY_MS = 8000;    // a free voice idle this long is torn down (its sources stopped)
const MAX_DIST = 320;       // engines beyond this aren't worth a voice

// Narrow pulse train as a PeriodicWave: drives the track-link clatter amplitude.
function pulseWave(ctx) {
  const n = 24, re = new Float32Array(n), im = new Float32Array(n), d = 0.18;
  for (let i = 1; i < n; i++) re[i] = Math.sin(Math.PI * i * d) / (Math.PI * i) * 2;
  return ctx.createPeriodicWave(re, im);
}

// set an AudioParam smoothly, skipping tiny changes to keep the automation timeline short
function smooth(p, v, now, tau = TAU) { if (Math.abs(p._v - v) < Math.abs(v) * 0.01 + 1e-4) return; p._v = v; p.setTargetAtTime(v, now, tau); }

class EngineVoice {
  constructor(A) {
    const c = A.ctx, K = A.kit; this.A = A; this.id = null; this.last = 0; this.freeAt = 0; this.d = 0;
    this.srcs = [];
    const osc = (type, f) => { const o = c.createOscillator(); o.type = type; o.frequency.value = f; o.start(); this.srcs.push(o); return o; };
    const gain = (v) => { const g = c.createGain(); g.gain.value = v; g.gain._v = v; return g; };
    const filt = (type, f, q) => { const b = c.createBiquadFilter(); b.type = type; b.frequency.value = f; b.frequency._v = f; b.Q.value = q; return b; };
    // output chain: master gain → distance lowpass → panner → sfx (+ reverb send)
    this.out = gain(0); this.lp = filt('lowpass', 20000, 0.5); this.pan = c.createStereoPanner ? c.createStereoPanner() : null;
    this.send = gain(0);
    this.out.connect(this.lp);
    if (this.pan) { this.lp.connect(this.pan); this.pan.connect(A.sfx); this.pan.connect(this.send); } else this.lp.connect(A.sfx);
    this.send.connect(A.fieldSend);
    // engine: saw at firing frequency, square an octave down (the lope), saturated and lowpassed
    this.oA = osc('sawtooth', 30); this.oB = osc('square', 15); this.oB.detune.value = 9; this.oC = osc('sawtooth', 30.4);
    const mix = gain(1), ws = c.createWaveShaper(); ws.curve = K.curve(2.5);
    this.engLp = filt('lowpass', 300, 1.2); this.engG = gain(0);
    const gB = gain(0.6), gC = gain(0.5); this.oA.connect(mix); this.oB.connect(gB); gB.connect(mix); this.oC.connect(gC); gC.connect(mix);
    mix.connect(ws); ws.connect(this.engLp); this.engLp.connect(this.engG); this.engG.connect(this.out);
    // low rumble: brown noise through a lowpass
    const brown = K.src(K.brown, c.currentTime, null, 1); this.srcs.push(brown);
    this.rumLp = filt('lowpass', 110, 0.7); this.rumG = gain(0); brown.connect(this.rumLp); this.rumLp.connect(this.rumG); this.rumG.connect(this.out);
    // tracks: white noise band, amplitude-modulated by a pulse train at the link rate
    const white = K.src(K.white, c.currentTime, null, 1); this.srcs.push(white);
    this.trkBp = filt('bandpass', 1400, 0.9); this.trkAm = gain(0.25); this.trkG = gain(0);
    this.pulse = c.createOscillator(); this.pulse.setPeriodicWave(A._pulse || (A._pulse = pulseWave(c))); this.pulse.frequency.value = 1; this.pulse.start(); this.srcs.push(this.pulse);
    const pG = gain(0.75); this.pulse.connect(pG); pG.connect(this.trkAm.gain);
    white.connect(this.trkBp); this.trkBp.connect(this.trkAm); this.trkAm.connect(this.trkG); this.trkG.connect(this.out);
    // track squeal on pivots: a narrow resonant band that wanders
    this.sqBp = filt('bandpass', 2600, 14); this.sqG = gain(0);
    this.sqLfo = osc('sine', 0.7); const lg = gain(180); this.sqLfo.connect(lg); lg.connect(this.sqBp.frequency);
    white.connect(this.sqBp); this.sqBp.connect(this.sqG); this.sqG.connect(this.out);
    // turret traverse: electric/hydraulic motor whine
    this.wA = osc('triangle', 380); this.wB = osc('sawtooth', 190);
    const wBp = filt('bandpass', 800, 2), wG2 = gain(0.3); this.whG = gain(0);
    this.wA.connect(this.whG); this.wB.connect(wG2); wG2.connect(wBp); wBp.connect(this.whG); this.whG.connect(this.out);
    this.rpm = 0.25; this.prevSpeed = 0; this.prevT = 0;
  }
  destroy() { for (const s of this.srcs) { try { s.stop(); } catch (e) {} } try { this.out.disconnect(); this.send.disconnect(); } catch (e) {} }
  silence(now) { smooth(this.out.gain, 0, now, 0.15); this.id = null; this.freeAt = performance.now(); }

  update(tank, pl, isPlayer, now) {
    const def = tank.def || {}, top = (def.speed || 40) / 3.6, v = Math.abs(tank.speed || 0), sf = clamp(v / top);
    const dt = Math.max(1e-3, now - this.prevT), acc = (v - this.prevSpeed) / dt; this.prevT = now; this.prevSpeed = v;
    const mass = def.mass || 30, power = def.power || 400;
    // load: throttle if the sim exposes it, otherwise inferred from acceleration and speed
    const thr = Math.abs(tank.throttle ?? tank.controls?.throttle ?? (acc > 0.15 ? 1 : sf > 0.05 ? 0.55 : 0));
    const turning = clamp(Math.abs(tank.yawRate || 0) / 0.6);
    const eng = tank.modules?.engine?.state;
    // five-gear rpm model: rpm climbs through each gear band and drops at the shift
    let rpm;
    if (sf < 0.03) rpm = 0.22 + 0.45 * Math.max(thr, turning * 0.8);
    else { const gs = Math.min(4.999, sf * 5), inG = gs - Math.floor(gs); rpm = 0.42 + 0.5 * inG * (0.7 + 0.3 * thr) + 0.08 * thr; }
    if (!tank.alive || eng === 'destroyed') rpm = 0;
    this.rpm += (rpm - this.rpm) * clamp(dt * 6);
    const load = clamp(0.25 + 0.75 * thr);
    const base = (power > 600 ? 13 : 16) + 12 * (1 - clamp(mass / 60));  // idle firing Hz: heavy/V12s lower
    const f = base * (1 + 2.3 * this.rpm) * (eng === 'damaged' ? 1 + 0.03 * Math.sin(now * 23) : 1);
    smooth(this.oA.frequency, f, now, 0.05); smooth(this.oC.frequency, f * 1.013, now, 0.05); smooth(this.oB.frequency, f / 2, now, 0.05);
    smooth(this.engLp.frequency, 160 + 1500 * this.rpm * (0.4 + 0.6 * load), now);
    const on = tank.alive !== false && eng !== 'destroyed' ? 1 : 0;
    smooth(this.engG.gain, on * (0.08 + 0.13 * load + 0.08 * this.rpm), now);
    smooth(this.rumG.gain, on * (0.12 + 0.25 * sf + 0.1 * load) + 0.2 * sf, now);
    smooth(this.rumLp.frequency, 90 + 80 * sf, now);
    // tracks
    smooth(this.pulse.frequency, 0.5 + v * 2.4, now, 0.05);
    smooth(this.trkG.gain, clamp(v / 5) * 0.16 + turning * 0.04, now);
    smooth(this.trkBp.frequency, 1000 + v * 70, now);
    smooth(this.sqG.gain, turning * (1 - 0.6 * sf) * 0.035 * (tank.alive === false ? 0 : 1), now);
    // turret traverse whine
    const tr = Math.abs(tank.turretRate || 0);
    smooth(this.whG.gain, clamp(tr / 0.25) * (isPlayer ? 0.05 : 0.025), now, 0.05);
    smooth(this.wA.frequency, 330 + tr * 420, now); smooth(this.wB.frequency, 165 + tr * 210, now);
    // placement
    const P = this.A._pos(tank.pos, { ref: 6, roll: 1, range: 0.8 });
    this.d = isPlayer ? 0 : P.d;
    const lvl = isPlayer ? 0.6 : P.gain * 0.9;
    smooth(this.out.gain, lvl, now, 0.1);
    smooth(this.lp.frequency, isPlayer ? 9000 : P.lp, now, 0.1);
    if (this.pan) this.pan.pan.setTargetAtTime(isPlayer ? 0 : P.pan, now, 0.05);
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
      if (!v && this.voices.length < this.max) { v = new EngineVoice(A); this.voices.push(v); }
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
    if (this.pan) this.pan.pan.setTargetAtTime(isPlayer ? 0 : P.pan, now, 0.1);
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
  stop(id) { const v = this.voices.find((x) => x.id === id); if (v) { smooth(v.out.gain, 0, this.A.ctx.currentTime, 0.4); v.id = null; } }
  refresh(tank, isPlayer) {
    const now = this.A.ctx.currentTime;
    for (const v of this.voices) {
      if (v.id === null) continue;
      if (now > v.until) { smooth(v.out.gain, 0, now, 1); v.id = null; continue; }
      if (tank && v.id === tank.id) { v.pos = tank.pos; v.player = isPlayer; v.place(tank.pos, isPlayer, v.level); }
    }
  }
  stopAll() { for (const v of this.voices) if (v.id !== null) this.stop(v.id); }
}
