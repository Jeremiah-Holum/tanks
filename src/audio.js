// All sound is synthesised: no audio files. Positional by stereo pan + distance.
export class Audio {
  constructor() {
    this.ctx = null; this.enabled = true;
    this.vol = { master: 0.8, sfx: 0.9, music: 0.45 };
    this.listener = { x: 11, z: 8, yaw: 0 };
    this.music = { on: false, next: 0, step: 0, layers: 1, tempo: 112 };
  }

  unlock() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { this.enabled = false; return; }
    const c = this.ctx = new AC();
    this.master = c.createGain(); this.master.gain.value = this.vol.master;
    const comp = c.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 4;
    this.master.connect(comp); comp.connect(c.destination);
    this.sfx = c.createGain(); this.sfx.gain.value = this.vol.sfx; this.sfx.connect(this.master);
    this.mus = c.createGain(); this.mus.gain.value = this.vol.music; this.mus.connect(this.master);
    // small room reverb for weight
    const len = c.sampleRate * 1.2, ir = c.createBuffer(2, len, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) { const d = ir.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3); }
    this.verb = c.createConvolver(); this.verb.buffer = ir;
    this.verbGain = c.createGain(); this.verbGain.gain.value = 0.18;
    this.verb.connect(this.verbGain); this.verbGain.connect(this.master);
    this.noise = c.createBuffer(1, c.sampleRate * 2, c.sampleRate);
    const nd = this.noise.getChannelData(0); for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    // engine: two detuned saws through a lowpass, gain follows speed
    this.eng = c.createGain(); this.eng.gain.value = 0;
    const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 260;
    this.engOsc = [c.createOscillator(), c.createOscillator()];
    this.engOsc[0].type = 'sawtooth'; this.engOsc[1].type = 'square';
    this.engOsc[0].frequency.value = 42; this.engOsc[1].frequency.value = 42.7;
    for (const o of this.engOsc) { o.connect(lp); o.start(); }
    lp.connect(this.eng); this.eng.connect(this.sfx);
    this.engLp = lp;
    // tread clatter: filtered noise
    this.clat = c.createGain(); this.clat.gain.value = 0;
    const src = c.createBufferSource(); src.buffer = this.noise; src.loop = true;
    const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 900; bp.Q.value = 1.4;
    src.connect(bp); bp.connect(this.clat); this.clat.connect(this.sfx); src.start();
  }

  setVolumes(v) { Object.assign(this.vol, v); if (!this.ctx) return; this.master.gain.value = this.vol.master; this.sfx.gain.value = this.vol.sfx; this.mus.gain.value = this.vol.music; }

  // Stereo pan + attenuation relative to the listener (the player's tank).
  _out(x, z, gain = 1) {
    const c = this.ctx;
    const g = c.createGain();
    let pan = 0, att = 1;
    if (x != null) {
      const dx = x - this.listener.x, dz = z - this.listener.z;
      const d = Math.hypot(dx, dz);
      att = 1 / (1 + d * 0.09);
      // project onto the listener's right vector
      const rx = -Math.sin(this.listener.yaw), rz = Math.cos(this.listener.yaw);
      pan = Math.max(-0.9, Math.min(0.9, (dx * rx + dz * rz) / Math.max(3, d) ));
    }
    g.gain.value = gain * att;
    if (c.createStereoPanner) { const p = c.createStereoPanner(); p.pan.value = pan; g.connect(p); p.connect(this.sfx); p.connect(this.verb); }
    else { g.connect(this.sfx); }
    return g;
  }

  _noise(out, t, dur, type, freq, q = 1, gain = 1, sweepTo = null) {
    const c = this.ctx;
    const s = c.createBufferSource(); s.buffer = this.noise; s.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = c.createBiquadFilter(); f.type = type; f.frequency.setValueAtTime(freq, t); f.Q.value = q;
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
    const g = c.createGain(); g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    s.connect(f); f.connect(g); g.connect(out); s.start(t, Math.random()); s.stop(t + dur + 0.05);
  }
  _tone(out, t, dur, type, f0, f1, gain = 1, attack = 0.002) {
    const c = this.ctx;
    const o = c.createOscillator(); o.type = type; o.frequency.setValueAtTime(f0, t);
    if (f1) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = c.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + attack); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(out); o.start(t); o.stop(t + dur + 0.05);
  }

  play(kind, o = {}) {
    if (!this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime;
    switch (kind) {
      case 'fire': {
        const out = this._out(o.x, o.z, o.mine ? 1.0 : 0.8);
        if (o.rocket) { this._noise(out, t, 0.45, 'bandpass', 2500, 2, 0.7, 500); this._tone(out, t, 0.2, 'sawtooth', 300, 80, 0.25); }
        this._tone(out, t, 0.22, 'sine', 150, 42, 1.0);
        this._noise(out, t, 0.18, 'lowpass', 2600, 0.7, 0.9, 300);
        this._tone(out, t, 0.05, 'square', 900, 300, 0.15);
        break;
      }
      case 'bounce': { const out = this._out(o.x, o.z, 0.5); this._tone(out, t, 0.25, 'sine', 2200 + Math.random() * 400, 1700, 0.45); this._tone(out, t, 0.12, 'triangle', 3400, 2600, 0.2); this._noise(out, t, 0.05, 'highpass', 3000, 1, 0.4); break; }
      case 'pop': { const out = this._out(o.x, o.z, 0.4); this._noise(out, t, 0.14, 'lowpass', 1400, 1, 0.8, 200); break; }
      // A shell off a tank's armour: a sharp strike, then the whining zing of it flying off.
      case 'ricochet': {
        const out = this._out(o.x, o.z, 0.75);
        this._noise(out, t, 0.04, 'highpass', 3500, 1, 0.7);
        this._tone(out, t, 0.08, 'square', 1900, 1500, 0.12);
        const f0 = 3200 + Math.random() * 900, f1 = 700 + Math.random() * 300, d = 0.55 + Math.random() * 0.2;
        this._tone(out, t + 0.02, d, 'sine', f0, f1, 0.42, 0.01);
        this._tone(out, t + 0.02, d * 0.9, 'triangle', f0 * 1.013, f1 * 1.02, 0.16, 0.01);
        this._noise(out, t + 0.02, d * 0.8, 'bandpass', f0 * 0.9, 8, 0.25, f1);
        break;
      }
      // A penetration: a heavy crunch — deep thump, torn metal, grit.
      case 'pen': {
        const out = this._out(o.x, o.z, 1.0);
        this._tone(out, t, 0.35, 'sine', 130, 38, 1.1, 0.003);
        this._noise(out, t, 0.32, 'lowpass', 1600, 0.9, 1.0, 180);
        this._tone(out, t, 0.14, 'sawtooth', 240, 70, 0.3);
        for (let k = 0; k < 6; k++) this._noise(out, t + 0.01 + k * 0.022 + Math.random() * 0.012, 0.035, 'bandpass', 700 + Math.random() * 1600, 2.5, 0.55);
        this._tone(out, t + 0.02, 0.22, 'square', 410, 360, 0.06);
        break;
      }
      // Stopped by the armour: a dull clank, short and flat.
      case 'nopen': {
        const out = this._out(o.x, o.z, 0.8);
        this._tone(out, t, 0.22, 'triangle', 330, 300, 0.5);
        this._tone(out, t, 0.16, 'triangle', 523, 480, 0.26);
        this._tone(out, t, 0.1, 'sine', 160, 90, 0.5);
        this._noise(out, t, 0.08, 'lowpass', 900, 1, 0.6, 250);
        break;
      }
      // A shell into a block. The renderer says what it hit: wooden toy blocks and the frame
      // thud, tin cans clang, plastic bricks knock hollow, books and card thump soft, stone cracks.
      case 'impact': {
        const out = this._out(o.x, o.z, 0.7), sf = o.surface || 'wood';
        if (sf === 'metal') {
          this._tone(out, t, 0.5, 'triangle', 620, 590, 0.35); this._tone(out, t, 0.4, 'sine', 1470, 1400, 0.2); this._tone(out, t, 0.3, 'sine', 2310, 2250, 0.1);
          this._noise(out, t, 0.06, 'highpass', 2500, 1, 0.5);
        } else if (sf === 'plastic') {
          this._tone(out, t, 0.12, 'triangle', 480, 300, 0.5); this._noise(out, t, 0.08, 'bandpass', 1800, 2, 0.6);
        } else if (sf === 'paper' || sf === 'card') {
          this._tone(out, t, 0.14, 'sine', 140, 70, 0.6); this._noise(out, t, 0.25, 'bandpass', 900, 0.8, 0.5, 400);
        } else if (sf === 'stone') {
          this._tone(out, t, 0.15, 'sine', 200, 70, 0.7); this._noise(out, t, 0.18, 'highpass', 1500, 0.7, 0.7);
          for (let k = 0; k < 6; k++) this._noise(out, t + 0.03 + Math.random() * 0.2, 0.025, 'bandpass', 3000 + Math.random() * 2000, 3, 0.2);
        } else {
          this._tone(out, t, 0.2, 'sine', 170, 55, 0.8);
          this._noise(out, t, 0.22, 'lowpass', 1100, 0.8, 0.8, 200);
          for (let k = 0; k < 4; k++) this._noise(out, t + 0.04 + Math.random() * 0.15, 0.03, 'bandpass', 2400 + Math.random() * 1800, 3, 0.18);
        }
        break;
      }
      // A cardboard crate giving way: a thump then a papery crumple.
      case 'crate': {
        const out = this._out(o.x, o.z, 0.7);
        this._tone(out, t, 0.14, 'sine', 120, 60, 0.6);
        for (let k = 0; k < 11; k++) this._noise(out, t + 0.01 + k * 0.03 + Math.random() * 0.03, 0.045 + Math.random() * 0.04, 'bandpass', 500 + Math.random() * 1400, 1.6, 0.5 - k * 0.03);
        this._noise(out, t, 0.4, 'highpass', 2500, 0.7, 0.12);
        break;
      }
      // Fire on a tank. The world-driven loop (burning()) is the real sound; this covers a
      // renderer that reports fire ticks for a tank the loop doesn't know about yet.
      case 'burn': {
        if (o.tank != null && this.burns && this.burns.has(o.tank)) { this.burns.get(o.tank).until = t + 0.8; break; }
        if (this.burns) { for (const b of this.burns.values()) if (o.x != null && Math.hypot(b.x - o.x, b.z - o.z) < 1.5) { b.until = t + 0.8; return; } }
        const out = this._out(o.x, o.z, 0.45);
        for (let k = 0; k < 8; k++) this._noise(out, t + Math.random() * 0.5, 0.02 + Math.random() * 0.02, 'bandpass', 1500 + Math.random() * 2500, 2, 0.5);
        this._noise(out, t, 0.55, 'lowpass', 500, 0.7, 0.35);
        break;
      }
      case 'clash': { const out = this._out(o.x, o.z, 0.6); this._tone(out, t, 0.3, 'triangle', 1500, 700, 0.5); this._noise(out, t, 0.2, 'bandpass', 2000, 1.5, 0.8); break; }
      case 'dud': { const out = this._out(o.x, o.z, 0.3); this._tone(out, t, 0.08, 'square', 180, 120, 0.2); this._noise(out, t, 0.06, 'lowpass', 600, 1, 0.3); break; }
      case 'mine': { const out = this._out(o.x, o.z, 0.5); this._tone(out, t, 0.06, 'square', 600, 600, 0.2); this._tone(out, t + 0.09, 0.06, 'square', 800, 800, 0.2); this._noise(out, t, 0.05, 'highpass', 2000, 1, 0.4); break; }
      case 'trip': { const out = this._out(o.x, o.z, 0.35); for (let k = 0; k < 3; k++) this._tone(out, t + k * 0.07, 0.05, 'square', 1400, 1400, 0.25); break; }
      // UI-side cues (not positional): you took a penetration, you got a kill, enemy spotted.
      case 'hitme': { const out = this._out(null, null, 0.6); this._tone(out, t, 0.4, 'sine', 90, 40, 0.9); this._tone(out, t, 0.5, 'triangle', 740, 690, 0.12); this._noise(out, t, 0.2, 'lowpass', 700, 1, 0.5); break; }
      case 'kill': { const out = this._out(null, null, 0.4); this._tone(out, t, 0.18, 'triangle', 988, 988, 0.3); this._tone(out, t + 0.09, 0.3, 'triangle', 1319, 1319, 0.3); break; }
      case 'spot': { const out = this._out(null, null, 0.3); this._noise(out, t, 0.05, 'bandpass', 2400, 2, 0.4); this._tone(out, t + 0.02, 0.07, 'square', 1175, 1175, 0.12); this._tone(out, t + 0.12, 0.07, 'square', 1568, 1568, 0.12); break; }
      case 'boom': {
        const out = this._out(o.x, o.z, o.human ? 1.3 : o.ammo ? 1.25 : 1.1);
        this._tone(out, t, 1.1, 'sine', 90, 28, 1.3, 0.005);
        this._noise(out, t, 1.4, 'lowpass', 1800, 0.8, 1.2, 120);
        this._noise(out, t, 0.25, 'highpass', 1500, 0.7, 0.6);
        for (let k = 0; k < 7; k++) this._noise(out, t + 0.05 + Math.random() * 0.5, 0.05, 'bandpass', 2500 + Math.random() * 2000, 3, 0.25);
        if (o.big || o.ammo) this._tone(out, t, 1.6, 'sine', 55, 22, 0.9, 0.01);
        if (o.ammo) for (let k = 0; k < 10; k++) this._noise(out, t + 0.15 + Math.random() * 0.9, 0.06, 'bandpass', 800 + Math.random() * 2500, 2, 0.35); // cook-off
        break;
      }
      case 'ui': { const out = this._out(null, null, 0.35); this._tone(out, t, 0.06, 'triangle', 880, 660, 0.4); break; }
      case 'uiBig': { const out = this._out(null, null, 0.4); this._tone(out, t, 0.12, 'square', 440, 440, 0.2); this._tone(out, t + 0.1, 0.18, 'square', 660, 660, 0.2); break; }
      case 'win': { const out = this._out(null, null, 0.5); [523, 659, 784, 1047].forEach((f, k) => this._tone(out, t + k * 0.11, 0.35, 'square', f, f, 0.18)); this._tone(out, t + 0.44, 0.7, 'triangle', 1047, 1047, 0.3); break; }
      case 'lose': { const out = this._out(null, null, 0.5); [392, 330, 262, 196].forEach((f, k) => this._tone(out, t + k * 0.18, 0.4, 'triangle', f, f * 0.98, 0.3)); break; }
      case 'banner': { const out = this._out(null, null, 0.45); for (let k = 0; k < 6; k++) this._noise(out, t + k * 0.09, 0.08, 'bandpass', 1800, 1.2, 0.8 - k * 0.08); this._tone(out, t + 0.55, 0.5, 'square', 392, 392, 0.12); break; }
    }
  }

  // One crackling loop per burning tank, positioned every frame. Pass the world (or null to stop all).
  burning(world) {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime;
    if (!this.burns) {
      this.burns = new Map();
      // a crackle bed: sparse sharp pops over a low roar
      const len = c.sampleRate * 2, b = c.createBuffer(1, len, c.sampleRate), d = b.getChannelData(0);
      let pop = 0, amp = 0;
      for (let i = 0; i < len; i++) {
        if (pop <= 0 && Math.random() < 0.0016) { pop = 60 + Math.random() * 260; amp = 0.4 + Math.random() * 0.6; }
        let v = (Math.random() * 2 - 1) * 0.06;
        if (pop > 0) { v += (Math.random() * 2 - 1) * amp * (pop / 300); pop--; }
        d[i] = v;
      }
      this.crackle = b;
    }
    const want = new Set();
    if (world) for (const tk of world.tanks) if (tk.alive && tk.modules && tk.modules.fire > 0) {
      want.add(tk.id);
      let L = this.burns.get(tk.id);
      if (!L) {
        const src = c.createBufferSource(); src.buffer = this.crackle; src.loop = true; src.playbackRate.value = 0.9 + Math.random() * 0.2;
        const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 180;
        const g = c.createGain(); g.gain.value = 0;
        const p = c.createStereoPanner ? c.createStereoPanner() : null;
        src.connect(hp); hp.connect(g);
        if (p) { g.connect(p); p.connect(this.sfx); } else g.connect(this.sfx);
        src.start(t, Math.random() * 1.5);
        L = { src, g, p, x: tk.x, z: tk.z, until: 0 };
        this.burns.set(tk.id, L);
      }
      L.x = tk.x; L.z = tk.z;
      const dx = tk.x - this.listener.x, dz = tk.z - this.listener.z, dd = Math.hypot(dx, dz);
      const rx = -Math.sin(this.listener.yaw), rz = Math.cos(this.listener.yaw);
      L.g.gain.setTargetAtTime(0.55 / (1 + dd * 0.09), t, 0.08);
      if (L.p) L.p.pan.setTargetAtTime(Math.max(-0.9, Math.min(0.9, (dx * rx + dz * rz) / Math.max(3, dd))), t, 0.08);
    }
    for (const [id, L] of this.burns) {
      if (want.has(id) || L.until > t) continue;
      L.g.gain.setTargetAtTime(0, t, 0.12);
      try { L.src.stop(t + 0.6); } catch {}
      this.burns.delete(id);
    }
  }

  engine(speed, active) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const s = Math.min(1, Math.abs(speed) / 2.3);
    this.eng.gain.setTargetAtTime(active ? 0.05 + s * 0.12 : 0, t, 0.1);
    this.clat.gain.setTargetAtTime(active ? s * 0.06 : 0, t, 0.08);
    for (const o of this.engOsc) o.frequency.setTargetAtTime(40 + s * 28, t, 0.15);
    this.engLp.frequency.setTargetAtTime(200 + s * 500, t, 0.15);
  }

  // A marching snare cadence; layers add kick, bass and a fife line as the enemy mix grows.
  startMusic(layers = 1, tempo = 112) { this.music.on = true; this.music.layers = layers; this.music.tempo = tempo; if (this.ctx) this.music.next = this.ctx.currentTime + 0.1; this.music.step = 0; }
  stopMusic() { this.music.on = false; }
  tickMusic() {
    if (!this.ctx || !this.music.on) return;
    const c = this.ctx, m = this.music, sixteenth = 60 / m.tempo / 4;
    const SN = [1, 0, 0, 1, 1, 0, 1, 0, 1, 0, 0, 1, 1, 1, 1, 0];
    const KI = [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0];
    const BASS = [55, 0, 0, 0, 55, 0, 0, 0, 41.2, 0, 0, 0, 49, 0, 0, 0];
    const FIFE = [784, 0, 784, 880, 988, 0, 880, 0, 784, 0, 659, 0, 587, 0, 0, 0, 659, 0, 659, 740, 784, 0, 740, 0, 659, 0, 587, 0, 523, 0, 0, 0];
    while (m.next < c.currentTime + 0.12) {
      const s = m.step % 16, t = m.next;
      if (SN[s]) this._noise(this.mus, t, 0.09, 'bandpass', 2600, 0.9, s % 4 === 0 ? 0.45 : 0.25);
      if (m.layers >= 2 && KI[s]) this._tone(this.mus, t, 0.25, 'sine', 110, 45, 0.7);
      if (m.layers >= 3 && BASS[s]) this._tone(this.mus, t, sixteenth * 3.5, 'triangle', BASS[s] * 2, BASS[s] * 2, 0.22, 0.01);
      if (m.layers >= 4) { const f = FIFE[m.step % 32]; if (f) this._tone(this.mus, t, sixteenth * 1.8, 'square', f, f, 0.045, 0.01); }
      m.next += sixteenth; m.step++;
    }
  }
}
