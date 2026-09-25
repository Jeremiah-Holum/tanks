// Audio core: shared buffers (noise, crackle, reverb impulse responses), waveshaper curves and
// the small set of one-shot primitives every recipe is built from. Works on any BaseAudioContext
// (a live AudioContext or an OfflineAudioContext for tools/audio-render.mjs).

export const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
export const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

// Deterministic PRNG so impulse responses and buffers are the same every run.
export function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// Outdoor impulse response: early reflections, a few smeared hill echoes, and a diffuse tail
// that darkens as it decays. `len` s, stereo, decorrelated channels.
function fieldIR(ctx, len, R) {
  const sr = ctx.sampleRate, n = Math.floor(len * sr), b = ctx.createBuffer(2, n, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = b.getChannelData(ch);
    for (let k = 0; k < 16; k++) { const i = Math.floor((0.008 + R() * 0.24) * sr); d[i] += (R() < 0.5 ? -1 : 1) * 0.6 * (1 - i / sr / 0.3); }
    // hill / treeline echoes: short noise smears, each darker and quieter
    const echoes = [[0.42 + R() * 0.08, 0.3], [0.95 + R() * 0.15, 0.2], [1.7 + R() * 0.2, 0.12], [2.5 + R() * 0.2, 0.06]];
    for (const [at, amp] of echoes) {
      const i0 = Math.floor(at * sr), m = Math.floor((0.16 + at * 0.14) * sr); let lp = 0;
      const a = 0.12 / (1 + at);
      for (let i = 0; i < m && i0 + i < n; i++) { lp += a * ((R() * 2 - 1) - lp); const x = i / m; d[i0 + i] += lp * amp * 9 * Math.min(1, x * 6) * Math.pow(1 - x, 2); }
    }
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr, a = clamp(0.9 - t * 0.35, 0.04, 0.9); // brightness falls with time
      lp += a * ((R() * 2 - 1) - lp);
      d[i] += lp * 0.26 * Math.exp(-t / 0.8) * clamp(t / 0.02);
    }
  }
  return b;
}
// Small steel-box interior: short, dense, a little metallic.
function roomIR(ctx, len, R) {
  const sr = ctx.sampleRate, n = Math.floor(len * sr), b = ctx.createBuffer(2, n, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = b.getChannelData(ch); let lp = 0;
    for (let i = 0; i < n; i++) { const t = i / sr; lp += 0.5 * ((R() * 2 - 1) - lp); d[i] = lp * Math.exp(-t / 0.06) + 0.25 * Math.sin(2 * Math.PI * 190 * t) * Math.exp(-t / 0.09) * (R() - 0.5); }
  }
  return b;
}

export class Kit {
  constructor(ctx) {
    this.ctx = ctx; const sr = this.sr = ctx.sampleRate, R = this.R = rng(0x5eed), n = sr * 2;
    this.white = ctx.createBuffer(1, n, sr);
    const w = this.white.getChannelData(0); for (let i = 0; i < n; i++) w[i] = R() * 2 - 1;
    // brown noise, de-trended so the loop point doesn't click, normalised to peak 1
    this.brown = ctx.createBuffer(1, n, sr);
    const b = this.brown.getChannelData(0); let last = 0, pk = 0;
    for (let i = 0; i < n; i++) { last = (last + 0.02 * (R() * 2 - 1)) / 1.02; b[i] = last; }
    const drift = b[n - 1] - b[0]; for (let i = 0; i < n; i++) { b[i] -= drift * i / (n - 1); pk = Math.max(pk, Math.abs(b[i])); }
    for (let i = 0; i < n; i++) b[i] /= pk;
    // fire crackle: sparse, randomly sized pops (loops seamlessly: it's sparse)
    this.crackle = ctx.createBuffer(1, n, sr);
    const c = this.crackle.getChannelData(0);
    for (let k = 0; k < 70; k++) {
      const i0 = Math.floor(R() * (n - sr * 0.01)), amp = Math.pow(R(), 2.5), tau = (0.0008 + R() * 0.004) * sr;
      for (let i = 0; i < tau * 5; i++) c[i0 + i] += amp * (R() * 2 - 1) * Math.exp(-i / tau);
    }
    this.fieldIR = fieldIR(ctx, 3.6, R);
    this.roomIR = roomIR(ctx, 0.45, R);
    this.curves = {};
  }
  // tanh saturation curve, cached by drive
  curve(k) {
    if (this.curves[k]) return this.curves[k];
    const n = 1024, a = new Float32Array(n), norm = Math.tanh(k);
    for (let i = 0; i < n; i++) { const x = i / (n - 1) * 2 - 1; a[i] = Math.tanh(k * x) / norm; }
    return (this.curves[k] = a);
  }
  // unity-gain soft limiter: linear to 0.7, then a tanh knee that never reaches 1
  limitCurve() {
    const n = 2048, a = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = i / (n - 1) * 2 - 1, m = Math.abs(x); a[i] = Math.sign(x) * (m < 0.7 ? m : 0.7 + 0.3 * Math.tanh((m - 0.7) / 0.3)); }
    return a;
  }
  // looping buffer source at a random offset, stopped after dur
  src(buf, t, dur, rate = 1) {
    const s = this.ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.playbackRate.value = rate;
    s.start(t, this.R() * (buf.duration - 0.05)); if (dur != null) s.stop(t + dur + 0.02);
    return s;
  }
  // attack (linear) → optional hold → exponential-ish decay (setTarget, reaching ~-50 dB at dur)
  env(param, t, peak, attack, dur, hold = 0) {
    param.setValueAtTime(0, t); param.linearRampToValueAtTime(peak, t + attack);
    const td = t + attack + hold; if (hold) param.setValueAtTime(peak, td);
    param.setTargetAtTime(0, td, Math.max(0.002, (dur - attack - hold) / 7));
  }
  // Filtered noise burst. o: {dur, f, f1, fdur, type, q, gain, attack, hold, buf:'white'|'brown'|'crackle', rate}
  noise(out, t, o) {
    const c = this.ctx, dur = o.dur, s = this.src(this[o.buf || 'white'], t, dur, o.rate || 1);
    const f = c.createBiquadFilter(); f.type = o.type || 'lowpass'; f.Q.value = o.q ?? 0.7;
    f.frequency.setValueAtTime(o.f ?? 1000, t);
    if (o.f1) f.frequency.exponentialRampToValueAtTime(o.f1, t + (o.fdur || dur));
    const g = c.createGain(); this.env(g.gain, t, o.gain ?? 1, o.attack ?? 0.002, dur, o.hold || 0);
    s.connect(f);
    // drive: tanh saturation after the filter (grit), output normalised back to about the same level
    if (o.drive) { const pre = c.createGain(); pre.gain.value = 1.6; const ws = c.createWaveShaper(); ws.curve = this.curve(o.drive); f.connect(pre); pre.connect(ws); ws.connect(g); }
    else f.connect(g);
    g.connect(out);
    return g;
  }
  // Low-end body: a sine whose pitch drops fast (f → f1 over fdur), soft-clipped so it thumps on
  // small speakers too (the clipping adds 2nd/3rd harmonics of the sub). o: {f, f1, fdur, dur, gain, shape}
  boom(out, t, o) {
    return this.tone(out, t, { f: o.f, f1: o.f1, fdur: o.fdur, dur: o.dur, gain: o.gain, attack: o.attack ?? 0.0015, shape: o.shape ?? 2.2 });
  }
  // Pressure-wave punch: a very short, heavily driven low click (the "kick" of a blast).
  punch(out, t, o) {
    this.tone(out, t, { f: o.f ?? 140, f1: o.f1 ?? 45, fdur: o.fdur ?? 0.035, dur: o.dur ?? 0.09, gain: o.gain ?? 1, attack: 0.0008, shape: 5 });
    this.noise(out, t, { type: 'lowpass', f: o.nf ?? 500, q: 0.9, dur: 0.035, gain: (o.gain ?? 1) * 0.7, attack: 0.0005, drive: 4 });
  }
  // Rolling outdoor tail: a long, dark brown-noise rumble plus discrete terrain reflections that
  // arrive later and darker (the "rolling thunder" of a big gun). len ~ 1..4 s.
  thunder(out, t, o) {
    const g = o.gain ?? 1, len = o.len ?? 2, lo = o.f ?? 160;
    this.noise(out, t + 0.02, { buf: 'brown', type: 'lowpass', f: lo, q: 0.8, dur: len, attack: 0.06 + 0.04 * len, hold: 0.1 * len, gain: g * 0.9, drive: 1.5 });
    const n = o.echoes ?? 4;
    for (let i = 0; i < n; i++) {
      const at = t + 0.28 + i * (0.22 + 0.18 * len / n) + this.R() * 0.12, a = g * 0.55 * Math.pow(0.62, i);
      this.noise(out, at, { buf: 'brown', type: 'lowpass', f: lo * (2.4 - i * 0.3), q: 0.7, dur: 0.35 + 0.15 * i, attack: 0.015 + 0.02 * i, gain: a, drive: 2 });
      this.noise(out, at, { type: 'lowpass', f: 900 - 150 * i, q: 0.6, dur: 0.12 + 0.05 * i, attack: 0.004, gain: a * 0.18 });
    }
  }
  // Oscillator note with optional pitch sweep and saturation. o: {dur, f, f1, fdur, type, gain, attack, hold, shape, detune}
  tone(out, t, o) {
    const c = this.ctx, dur = o.dur, osc = c.createOscillator(); osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(o.f, t); if (o.detune) osc.detune.value = o.detune;
    if (o.f1) osc.frequency.exponentialRampToValueAtTime(o.f1, t + (o.fdur || dur));
    const g = c.createGain(); this.env(g.gain, t, o.gain ?? 1, o.attack ?? 0.002, dur, o.hold || 0);
    let head = osc;
    if (o.shape) { const ws = c.createWaveShaper(); ws.curve = this.curve(o.shape); osc.connect(ws); head = ws; }
    head.connect(g); g.connect(out); osc.start(t); osc.stop(t + dur + 0.02);
    return g;
  }
  // Struck steel: a few inharmonic sine partials with their own decays plus a noise strike.
  metal(out, t, o) {
    const ratios = o.ratios || [1, 2.32, 4.25, 6.63], dur = o.dur, g = o.gain ?? 0.5, br = o.bright ?? 1;
    ratios.forEach((r, i) => this.tone(out, t, { f: o.f * r * (1 + (this.R() - 0.5) * 0.02), dur: dur / (1 + i * 0.7), gain: g * Math.pow(0.62, i) * (i ? br : 1), attack: 0.001 }));
    this.noise(out, t, { type: 'highpass', f: 2500, dur: 0.03, gain: g * 0.8 * br });
  }
  // Scattered short ticks (debris, chain links, spall). One shared filter.
  ticks(out, t, o) {
    const c = this.ctx, f = c.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = o.f || 2500; f.Q.value = o.q ?? 1.5; f.connect(out);
    for (let k = 0; k < o.n; k++) {
      const tt = t + Math.pow(this.R(), o.skew ?? 1.6) * o.span, d = (o.dur || 0.03) * (0.6 + this.R() * 0.8);
      const s = this.src(this.white, tt, d, 0.7 + this.R() * 0.6), g = c.createGain();
      this.env(g.gain, tt, (o.gain ?? 0.3) * (0.3 + 0.7 * this.R()) * (1 - 0.6 * (tt - t) / o.span), 0.001, d);
      s.connect(g); g.connect(f);
    }
  }
}
