// Menu music (a slow martial loop in D minor: pads, timpani, snare, a horn line that layers in
// over time) and battle ambience (gusting wind, distant artillery). A look-ahead scheduler
// queues notes ~0.6 s ahead on a timer; OfflineAudioContext callers use scheduleUntil(t).
import { mtof, clamp } from './core.js';

const BPM = 72, BEAT = 60 / BPM, BAR = BEAT * 4;
// two bars per chord: Dm – Bb – Gm – A
const CHORDS = [[38, 50, 53, 57, 62], [34, 50, 53, 58, 65], [31, 50, 55, 58, 62], [33, 49, 52, 57, 64]];
// horn phrase over the 8 bars: [beat offset, midi, beats]
const MELODY = [
  [[0, 62, 2], [2, 69, 1.5], [3.5, 67, 0.5], [4, 65, 2], [6, 64, 1], [7, 62, 1]],
  [[8, 65, 2], [10, 70, 2], [12, 69, 1.5], [13.5, 67, 0.5], [14, 65, 2]],
  [[16, 67, 1.5], [17.5, 69, 0.5], [18, 70, 2], [20, 74, 2], [22, 72, 1], [23, 70, 1]],
  [[24, 69, 3], [27, 67, 0.5], [27.5, 65, 0.5], [28, 64, 2], [30, 61, 2]],
];
const SNARE = [1, 0, 0, 0.5, 0.8, 0, 0.5, 0.5, 1, 0, 0, 0.5, 0.7, 0.4, 0.55, 0.7];

export class Music {
  constructor(A) { this.A = A; this.mode = null; this.timer = null; this.out = null; }
  get K() { return this.A.kit; }
  start(mode = 'menu') {
    if (this.mode === mode) return;
    this.stop();
    const A = this.A, c = A.ctx; this.mode = mode;
    this.out = c.createGain(); this.out.gain.setValueAtTime(0, c.currentTime); this.out.gain.linearRampToValueAtTime(1, c.currentTime + 1.5);
    if (mode === 'battle') { this.out.connect(A.amb); this.startAmbience(); }
    else { this.out.connect(A.musicBus); this.verb = c.createGain(); this.verb.gain.value = 0.5; this.out.connect(this.verb); this.verb.connect(A.hallSend); }
    this.next = c.currentTime + 0.1; this.bar = 0; this.nextBoom = c.currentTime + 3 + A.kit.R() * 6; this.nextGust = 0;
    if (!A.offline && typeof setInterval !== 'undefined') this.timer = setInterval(() => this.tick(), 120);
    this.tick();
  }
  stop(fade = 1.2) {
    if (this.timer) clearInterval(this.timer); this.timer = null;
    if (this.out) {
      const out = this.out, c = this.A.ctx, now = c.currentTime;
      out.gain.cancelScheduledValues(now); out.gain.setValueAtTime(out.gain.value, now); out.gain.linearRampToValueAtTime(0, now + fade);
      const srcs = this.loops || []; this.loops = null;
      const kill = () => { for (const s of srcs) { try { s.stop(); } catch (e) {} } try { out.disconnect(); } catch (e) {} };
      if (typeof setTimeout !== 'undefined' && !this.A.offline) setTimeout(kill, fade * 1000 + 3000); else for (const s of srcs) { try { s.stop(now + fade + 0.1); } catch (e) {} }
    }
    this.out = null; this.mode = null;
  }
  tick() { if (this.A.ctx && this.mode) this.scheduleUntil(this.A.ctx.currentTime + 0.6); }
  scheduleUntil(T) {
    if (!this.mode) return;
    if (this.mode === 'battle') return this.ambience(T);
    while (this.next < T) { this.scheduleBar(this.bar, this.next); this.next += BAR; this.bar++; }
  }

  // ---- menu music ----
  scheduleBar(b, t) {
    const K = this.K, out = this.out, loop = Math.floor(b / 8), pos = b % 8, ch = CHORDS[pos >> 1];
    const layer = loop === 0 ? 0 : 1 + ((loop - 1) % 3);           // 0: pads+drum, 1: +snare, 2: +horn, 3: all
    if (pos % 2 === 0) this.pad(ch, t, BAR * 2);
    // timpani on the downbeat, a pickup on beats 3–4 of every second bar
    this.timp(mtof(ch[0] + 12), t, 0.22);
    if (pos % 2 === 1) { this.timp(mtof(ch[0] + 12), t + BEAT * 2.5, 0.08); this.timp(mtof(ch[0] + 12), t + BEAT * 3, 0.12); }
    if ((layer === 1 || layer === 3) && pos < 7) SNARE.forEach((a, i) => a && this.snare(t + i * BEAT / 4, a * (0.5 + 0.5 * K.R())));
    if (layer >= 2) for (const [bo, m, beats] of MELODY[pos >> 1]) { const tb = pos % 2 === 0 ? bo - (pos >> 1) * 8 : null; if (tb !== null) this.horn(mtof(m), t + tb * BEAT, beats * BEAT); }
  }
  pad(ch, t, dur) {
    const c = this.A.ctx, K = this.K;
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 0.8;
    lp.frequency.setValueAtTime(300, t); lp.frequency.linearRampToValueAtTime(900, t + dur * 0.5); lp.frequency.linearRampToValueAtTime(400, t + dur + 1.5);
    const g = c.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.05, t + 1.4); g.gain.setValueAtTime(0.05, t + dur - 0.3); g.gain.linearRampToValueAtTime(0, t + dur + 1.8);
    lp.connect(g); g.connect(this.out);
    ch.forEach((m, i) => {
      for (const det of [-7, 7]) {
        const o = c.createOscillator(); o.type = i === 0 ? 'triangle' : 'sawtooth'; o.frequency.value = mtof(m); o.detune.value = det + (K.R() - 0.5) * 4;
        const vg = c.createGain(); vg.gain.value = i === 0 ? 1.6 : 0.5; o.connect(vg); vg.connect(lp); o.start(t); o.stop(t + dur + 2);
      }
    });
  }
  timp(f, t, gain) {
    const K = this.K;
    K.tone(this.out, t, { f: f * 1.06, f1: f, fdur: 0.08, dur: 1.4, gain });
    K.tone(this.out, t, { f: f * 1.5, dur: 0.5, gain: gain * 0.3 });
    K.noise(this.out, t, { buf: 'brown', type: 'lowpass', f: 400, dur: 0.18, gain: gain * 0.6 });
  }
  snare(t, a) {
    const K = this.K;
    K.noise(this.out, t, { type: 'bandpass', f: 3200, q: 0.7, dur: 0.09, gain: 0.05 * a });
    K.tone(this.out, t, { f: 200, f1: 170, dur: 0.05, gain: 0.025 * a });
  }
  horn(f, t, dur) {
    const c = this.A.ctx, g = c.createGain(), lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 1.5;
    lp.frequency.setValueAtTime(350, t); lp.frequency.linearRampToValueAtTime(1500, t + 0.15); lp.frequency.linearRampToValueAtTime(900, t + dur);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.055, t + 0.09); g.gain.setValueAtTime(0.05, t + Math.max(0.1, dur - 0.08)); g.gain.linearRampToValueAtTime(0, t + dur + 0.25);
    const vib = c.createOscillator(); vib.frequency.value = 5; const vg = c.createGain(); vg.gain.setValueAtTime(0, t); vg.gain.linearRampToValueAtTime(7, t + 0.5);
    vib.connect(vg); vib.start(t); vib.stop(t + dur + 0.3);
    for (const [type, det, lvl] of [['sawtooth', -4, 1], ['sawtooth', 5, 0.8], ['square', 0, 0.3]]) {
      const o = c.createOscillator(); o.type = type; o.frequency.value = f; o.detune.value = det; vg.connect(o.detune);
      const og = c.createGain(); og.gain.value = lvl; o.connect(og); og.connect(lp); o.start(t); o.stop(t + dur + 0.3);
    }
    lp.connect(g); g.connect(this.out);
  }

  // ---- battle ambience ----
  startAmbience() {
    const A = this.A, c = A.ctx, K = A.kit, t = c.currentTime;
    const w = K.src(K.white, t, null, 1), b = K.src(K.brown, t, null, 1);
    this.windBp = c.createBiquadFilter(); this.windBp.type = 'bandpass'; this.windBp.frequency.value = 450; this.windBp.Q.value = 0.7;
    this.windG = c.createGain(); this.windG.gain.value = 0.025;
    this.lowG = c.createGain(); this.lowG.gain.value = 0.08; const lowLp = c.createBiquadFilter(); lowLp.type = 'lowpass'; lowLp.frequency.value = 160;
    w.connect(this.windBp); this.windBp.connect(this.windG); this.windG.connect(this.out);
    b.connect(lowLp); lowLp.connect(this.lowG); this.lowG.connect(this.out);
    this.loops = [w, b];
  }
  ambience(T) {
    const K = this.K, R = K.R, c = this.A.ctx;
    const now = c.currentTime;
    if (now >= this.nextGust) { // new gust targets every couple of seconds
      this.windG.gain.setTargetAtTime(0.012 + 0.04 * R() * R(), now, 1.2);
      this.windBp.frequency.setTargetAtTime(280 + 500 * R(), now, 1.5);
      this.lowG.gain.setTargetAtTime(0.05 + 0.06 * R(), now, 2);
      this.nextGust = now + 1.5 + R() * 2.5;
    }
    while (this.nextBoom < T) { // far-off artillery: a dull thud with a long rolling tail
      const t = this.nextBoom, pan = c.createStereoPanner ? c.createStereoPanner() : null, g = c.createGain(); g.gain.value = 0.35 + 0.5 * R();
      if (pan) { pan.pan.value = R() * 1.6 - 0.8; g.connect(pan); pan.connect(this.out); pan.connect(this.A.fieldSend); } else g.connect(this.out);
      K.noise(g, t, { buf: 'brown', type: 'lowpass', f: 140 + 120 * R(), dur: 2 + R() * 1.5, attack: 0.03, gain: 0.35 });
      K.tone(g, t, { f: 55, f1: 30, dur: 0.6, gain: 0.12 });
      if (R() < 0.35) K.noise(g, t + 0.5 + R(), { buf: 'brown', type: 'lowpass', f: 180, dur: 1.8, attack: 0.05, gain: 0.2 });
      this.nextBoom = t + 5 + R() * 14;
    }
  }

  // Victory / defeat stinger (music bus, independent of the loop).
  stinger(win) {
    const A = this.A, c = A.ctx, t = c.currentTime + 0.05, g = c.createGain(); g.gain.value = 1; g.connect(A.musicBus); g.connect(A.hallSend);
    const prev = this.out; this.out = g;
    const seq = win ? [[[50, 57, 62, 66], 0, 0.7], [[55, 59, 62, 67], 0.7, 0.5], [[50, 57, 62, 66, 69], 1.2, 2.2]]
      : [[[50, 57, 62, 65], 0, 1], [[46, 53, 58, 62], 1, 1], [[45, 52, 57, 61], 2, 1.2], [[38, 50, 57, 62, 65], 3.2, 2.5]];
    for (const [notes, at, d] of seq) { for (const m of notes) this.horn(mtof(m), t + at, d); this.timp(mtof(notes[0]), t + at, 0.18); }
    this.out = prev;
  }
}
export { BAR, BEAT, clamp };
