// One-shot sound recipes. Each takes the Kit, a destination node and a start time; gains are
// relative (the caller's placement node does distance, pan and bus levels).
import { clamp } from './core.js';

// Calibre → 0..1 "size" (15 mm → 0, 135 mm → 1).
export const size = (cal) => clamp(((cal || 75) - 15) / 120);

// Cannon: supersonic crack + lowpassed blast sweeping down + saturated pressure thump + a long
// low rumble. Autocannons get a short bright pop instead of the rumble. Echo comes from the
// field reverb send (bigger guns send more).
export function cannon(K, out, t, cal, o = {}) {
  const k = size(cal), g = o.gain ?? 1, brake = !!o.brake;
  K.noise(out, t, { type: 'highpass', f: 2400 - 1000 * k, q: 0.5, dur: 0.03 + 0.05 * k, gain: g * (0.25 + 0.25 * k + (brake ? 0.25 : 0)) });
  K.noise(out, t, { type: 'lowpass', f: 5200 - 2800 * k, f1: 260 - 150 * k, fdur: 0.05 + 0.35 * k, q: 1.1, dur: 0.16 + 1.1 * k, gain: g * 0.7, attack: 0.001 });
  K.tone(out, t, { f: 150 - 90 * k, f1: 32 - 8 * k, fdur: 0.05 + 0.25 * k, dur: 0.1 + 0.55 * k, gain: g * (0.2 + 0.6 * k), shape: 3 });
  if (cal >= 30) K.noise(out, t + 0.015, { buf: 'brown', type: 'lowpass', f: 230 - 100 * k, dur: 0.4 + 2.4 * k, attack: 0.03 + 0.05 * k, gain: g * (0.15 + 0.5 * k * k) });
  else { K.noise(out, t, { type: 'bandpass', f: 1500, q: 2, dur: 0.09, gain: g * 0.4 }); K.tone(out, t, { type: 'square', f: 900, f1: 280, dur: 0.045, gain: g * 0.06 }); }
  if (brake) K.noise(out, t + 0.004, { type: 'bandpass', f: 1500 - 500 * k, q: 1.4, dur: 0.12 + 0.2 * k, gain: g * 0.35 });
  if (o.player) {
    // inside the turret: recoil and breech clank, a deeper body thump, then the spent case
    K.tone(out, t, { f: 75 - 25 * k, f1: 24, dur: 0.3 + 0.3 * k, gain: g * (0.25 + 0.35 * k), shape: 2 });
    K.metal(out, t + 0.07 + 0.08 * k, { f: 210 - 80 * k, dur: 0.45, gain: g * 0.12, bright: 0.6 });
    if (cal >= 37) { const tc = t + 0.7 + 0.5 * k; K.metal(out, tc, { f: 1650 - 500 * k, dur: 0.35, gain: g * 0.05, ratios: [1, 2.7, 5.2] }); K.metal(out, tc + 0.16, { f: 1700 - 500 * k, dur: 0.25, gain: g * 0.025, ratios: [1, 2.7] }); }
  }
}

// Explosion: size ~0.5 (HE splash) .. 3 (ammo rack).
export function explosion(K, out, t, s = 1, o = {}) {
  const g = o.gain ?? 1, z = clamp(s / 3);
  K.noise(out, t, { type: 'lowpass', f: 3500 - 1500 * z, f1: 180, fdur: 0.2 + 0.5 * z, q: 0.9, dur: 0.4 + 1.2 * z, gain: g * 0.75 });
  K.tone(out, t, { f: 110 - 50 * z, f1: 26, fdur: 0.12 + 0.3 * z, dur: 0.3 + 0.6 * z, gain: g * (0.35 + 0.45 * z), shape: 3 });
  K.noise(out, t + 0.02, { buf: 'brown', type: 'lowpass', f: 190, dur: 0.8 + 2.5 * z, attack: 0.04, gain: g * (0.3 + 0.35 * z) });
  K.ticks(out, t + 0.15, { n: Math.round(4 + 6 * z), span: 0.6 + 1.2 * z, f: 2200, q: 1.2, gain: g * 0.18, dur: 0.035 });
}

// Ammo rack: the biggest blast, a fireball whoosh and cooking-off rounds.
export function ammorack(K, out, t, o = {}) {
  const g = o.gain ?? 1;
  explosion(K, out, t, 3, { gain: g });
  K.noise(out, t + 0.05, { type: 'bandpass', f: 300, f1: 900, fdur: 1.5, q: 0.8, dur: 2.6, attack: 0.25, gain: g * 0.25 });
  for (let k = 0; k < 8; k++) {
    const tt = t + 0.4 + K.R() * 2.2;
    K.noise(out, tt, { type: 'bandpass', f: 900 + K.R() * 1200, q: 1.2, dur: 0.12, gain: g * (0.1 + K.R() * 0.15) });
    K.tone(out, tt, { f: 120, f1: 50, dur: 0.12, gain: g * 0.08 });
  }
}

// Shell into the ground / a building / water. kk = calibre size.
export function impact(K, out, t, surface, cal, o = {}) {
  const k = size(cal), g = (o.gain ?? 1) * (0.5 + 0.6 * k), s = String(surface || 'ground').toLowerCase();
  if (/water|shallow|deep|river|lake/.test(s)) {
    K.noise(out, t, { type: 'bandpass', f: 600, f1: 2400, fdur: 0.3, q: 0.8, dur: 0.5, gain: g * 0.45 });
    K.tone(out, t, { f: 220, f1: 70, dur: 0.18, gain: g * 0.35 });
    for (let i = 0; i < 4; i++) K.tone(out, t + 0.08 + K.R() * 0.4, { f: 450 + K.R() * 500, f1: 1100 + K.R() * 600, dur: 0.05, gain: g * 0.05 });
    K.noise(out, t + 0.1, { type: 'highpass', f: 2800, dur: 1.2, attack: 0.15, gain: g * 0.1 });
  } else if (/tree|pine|log|fence|shed|hay|hedge|bush/.test(s)) { // timber: splintering thunk
    K.noise(out, t, { type: 'bandpass', f: 700, f1: 350, q: 1.2, dur: 0.25, gain: g * 0.5 });
    K.ticks(out, t, { n: 6, span: 0.2, f: 1600, q: 2, gain: g * 0.3, dur: 0.02, skew: 1 });
    K.tone(out, t, { f: 160, f1: 80, dur: 0.15, gain: g * 0.25 });
  } else if (/rock|stone|build|house|wall|brick|concrete|object|road|ruin|church|barn|station|silo|windmill|bridge/.test(s)) {
    K.noise(out, t, { type: 'highpass', f: 1800, dur: 0.06, gain: g * 0.55 });
    K.noise(out, t, { type: 'bandpass', f: 900, f1: 300, q: 0.8, dur: 0.3, gain: g * 0.45 });
    K.tone(out, t, { f: 120, f1: 45, dur: 0.2, gain: g * 0.35 });
    K.ticks(out, t + 0.04, { n: 8, span: 0.7, f: 3000, gain: g * 0.18, dur: 0.02 });
  } else if (/tank|metal|steel|wreck/.test(s)) {
    K.metal(out, t, { f: 300, dur: 0.6, gain: g * 0.35 });
  } else { // soil, grass, mud, sand, snow, fields
    K.noise(out, t, { type: 'lowpass', f: 1000, f1: 160, fdur: 0.15, dur: 0.4, gain: g * 0.6 });
    K.noise(out, t, { buf: 'brown', type: 'lowpass', f: 140, dur: 0.55, gain: g * 0.45 });
    K.noise(out, t + 0.05, { type: 'bandpass', f: 2200, q: 0.7, dur: 0.6, attack: 0.03, gain: g * 0.1 });
    K.ticks(out, t + 0.12, { n: 4, span: 0.6, f: 1800, gain: g * 0.1, dur: 0.03 });
  }
}

// A near miss: the supersonic snap of a shell passing close.
export function snap(K, out, t, o = {}) {
  const g = o.gain ?? 1;
  K.noise(out, t, { type: 'highpass', f: 3000, dur: 0.025, gain: g * 0.4 });
  K.noise(out, t, { type: 'bandpass', f: 1800, f1: 700, q: 2, dur: 0.25, gain: g * 0.12 });
}

// Ricochet whine: a pitched sweep with a companion slightly detuned, plus air whoosh.
export function whine(K, out, t, o = {}) {
  const g = o.gain ?? 1, f0 = 2600 + K.R() * 1000, f1 = 650 + K.R() * 300, d = 0.55 + K.R() * 0.25;
  K.tone(out, t + 0.015, { f: f0, f1, dur: d, attack: 0.01, gain: g * 0.14 });
  K.tone(out, t + 0.015, { type: 'triangle', f: f0 * 1.013, f1: f1 * 1.02, dur: d * 0.9, attack: 0.01, gain: g * 0.06 });
  K.noise(out, t + 0.015, { type: 'bandpass', f: f0 * 0.9, f1, q: 6, dur: d * 0.8, gain: g * 0.12 });
}

// Hit on another tank, heard from outside (world perspective or the shooter's confirmation).
export function hitOutside(K, out, t, result, cal, o = {}) {
  const k = size(cal), g = o.gain ?? 1;
  switch (result) {
    case 'pen': case 'crit':
      K.noise(out, t, { type: 'bandpass', f: 700, q: 1.1, dur: 0.22, gain: g * 0.55 });
      K.tone(out, t, { f: 120, f1: 40, dur: 0.25, gain: g * (0.3 + 0.3 * k), shape: 2 });
      K.metal(out, t, { f: 170 + (1 - k) * 160, dur: 0.5, gain: g * 0.22, bright: 0.5 });
      K.ticks(out, t + 0.005, { n: 6, span: 0.12, f: 2600, gain: g * 0.3, dur: 0.03 });
      if (result === 'crit') K.metal(out, t + 0.03, { f: 1250, dur: 0.3, gain: g * 0.08, ratios: [1, 1.5] });
      break;
    case 'nopen':
      K.metal(out, t, { f: 420 - 170 * k, dur: 1.2, gain: g * 0.4, bright: 1 });
      K.noise(out, t, { type: 'highpass', f: 3200, dur: 0.05, gain: g * 0.35 });
      K.tone(out, t, { f: 140, f1: 70, dur: 0.12, gain: g * 0.2 });
      break;
    case 'ricochet':
      K.metal(out, t, { f: 900, dur: 0.25, gain: g * 0.22, ratios: [1, 2.3] });
      whine(K, out, t, { gain: g });
      break;
    case 'track':
      K.metal(out, t, { f: 260, dur: 0.45, gain: g * 0.3 });
      K.ticks(out, t + 0.02, { n: 10, span: 0.5, f: 1800, q: 3, gain: g * 0.28, dur: 0.025 });
      K.tone(out, t, { f: 100, f1: 45, dur: 0.18, gain: g * 0.3 });
      break;
    case 'splash': default:
      explosion(K, out, t, 0.3 + 0.9 * k, { gain: g * 0.7 });
  }
}

// Being hit, heard from inside the player's tank: a massive clang through the hull, with
// spall for penetrations, a whine for ricochets and a ringing in the ears for big hits.
export function hitInside(K, out, t, result, cal, o = {}) {
  const k = size(cal), g = o.gain ?? 1;
  K.metal(out, t, { f: 88 + K.R() * 25 + (1 - k) * 40, ratios: [1, 1.58, 2.37, 3.9, 5.1], dur: 1.4, gain: g * 0.45, bright: 0.7 });
  K.tone(out, t, { f: 65, f1: 28, dur: 0.4, gain: g * (0.45 + 0.35 * k), shape: 3 });
  K.noise(out, t, { type: 'lowpass', f: 1900, f1: 300, fdur: 0.2, dur: 0.3, gain: g * 0.55 });
  if (result === 'pen' || result === 'crit') {
    K.ticks(out, t + 0.01, { n: 12, span: 0.4, f: 3200, gain: g * 0.3, dur: 0.03 });
    K.noise(out, t, { type: 'bandpass', f: 600, q: 1, dur: 0.35, gain: g * 0.4 });
  }
  if (result === 'ricochet') whine(K, out, t + 0.02, { gain: g * 0.7 });
  if (result === 'track') K.ticks(out, t + 0.03, { n: 12, span: 0.6, f: 1600, q: 3, gain: g * 0.3, dur: 0.03 });
  if (result === 'splash') K.noise(out, t, { buf: 'brown', type: 'lowpass', f: 200, dur: 1, gain: g * 0.5 });
  if (k > 0.45 && result !== 'track') K.tone(out, t + 0.05, { f: 3650 + K.R() * 300, dur: 2.2 + k, attack: 0.08, gain: g * 0.018 });
}

// Ramming: grinding crunch of steel on steel.
export function ram(K, out, t, dmg, o = {}) {
  const g = (o.gain ?? 1) * clamp(0.4 + (dmg || 0) / 150, 0.4, 1);
  K.metal(out, t, { f: 72, ratios: [1, 1.7, 2.9, 4.4], dur: 0.9, gain: g * 0.5, bright: 0.6 });
  K.noise(out, t, { type: 'bandpass', f: 500, q: 0.8, dur: 0.5, gain: g * 0.5 });
  K.noise(out, t + 0.05, { type: 'bandpass', f: 1800, q: 2, dur: 0.4, gain: g * 0.2 });
}

// Tree: snapping fibres, a creak as it goes, leaves rushing, the trunk thumping down.
export function treeFall(K, out, t, o = {}) {
  const g = o.gain ?? 1;
  K.ticks(out, t, { n: 7, span: 0.18, f: 1500, q: 2, gain: g * 0.5, dur: 0.02, skew: 1 });
  K.tone(out, t + 0.1, { type: 'sawtooth', f: 140, f1: 70, dur: 0.8, attack: 0.1, gain: g * 0.04 });
  K.noise(out, t + 0.2, { type: 'highpass', f: 2500, dur: 1.2, attack: 0.5, gain: g * 0.12 });
  K.noise(out, t + 1.15, { buf: 'brown', type: 'lowpass', f: 160, dur: 0.5, gain: g * 0.5 });
  K.ticks(out, t + 1.15, { n: 5, span: 0.3, f: 900, gain: g * 0.15, dur: 0.03 });
}

// Fence, shed or wall breaking: a crash of timber and rubble.
export function crash(K, out, t, o = {}) {
  const g = o.gain ?? 1;
  K.noise(out, t, { type: 'bandpass', f: 1000, f1: 350, q: 0.8, dur: 0.4, gain: g * 0.5 });
  K.tone(out, t, { f: 110, f1: 50, dur: 0.2, gain: g * 0.3 });
  K.ticks(out, t, { n: 12, span: 0.8, f: 1400, q: 1.2, gain: g * 0.3, dur: 0.035 });
}

// Fire starting: ignition whoomp.
export function ignite(K, out, t, o = {}) {
  const g = o.gain ?? 1;
  K.noise(out, t, { type: 'bandpass', f: 250, f1: 900, q: 0.8, dur: 0.9, attack: 0.08, gain: g * 0.4 });
  K.noise(out, t, { buf: 'crackle', type: 'highpass', f: 1200, dur: 1.2, attack: 0.1, gain: g * 0.6 });
}

// Player's module damage cues (heard inside).
export function engineCough(K, out, t, o = {}) {
  const g = o.gain ?? 1;
  for (let i = 0; i < 3; i++) { const tt = t + 0.15 + i * (0.18 + K.R() * 0.1); K.noise(out, tt, { buf: 'brown', type: 'lowpass', f: 400, dur: 0.15, gain: g * 0.5 }); K.tone(out, tt, { type: 'sawtooth', f: 45, dur: 0.12, gain: g * 0.12 }); }
  K.metal(out, t, { f: 330, dur: 0.3, gain: g * 0.12 });
}
export function trackBreak(K, out, t, o = {}) {
  const g = o.gain ?? 1;
  K.metal(out, t, { f: 240, dur: 0.5, gain: g * 0.3 });
  K.ticks(out, t + 0.05, { n: 14, span: 0.9, f: 1500, q: 3, gain: g * 0.3, dur: 0.03 });
  K.noise(out, t + 0.6, { buf: 'brown', type: 'lowpass', f: 200, dur: 0.3, gain: g * 0.4 });
}

// Loading: rammer, breech block closing. Heavier for big guns, a click for autocannons.
export function reload(K, out, t, cal, o = {}) {
  const k = size(cal), g = o.gain ?? 1;
  if (cal < 30) { K.metal(out, t, { f: 1400, dur: 0.1, gain: g * 0.1, ratios: [1, 2.1] }); K.metal(out, t + 0.08, { f: 900, dur: 0.12, gain: g * 0.12, ratios: [1, 2.3] }); return; }
  K.noise(out, t, { type: 'bandpass', f: 1200, f1: 500, q: 1, dur: 0.18, gain: g * 0.12 });
  K.metal(out, t + 0.16, { f: 260 - 120 * k, dur: 0.35, gain: g * 0.3, bright: 0.5 });
  K.tone(out, t + 0.16, { f: 110 - 40 * k, f1: 50, dur: 0.12, gain: g * 0.3 });
}

// Consumables.
export function consumable(K, out, t, kind, o = {}) {
  const g = o.gain ?? 1;
  if (kind === 'repair') { for (let i = 0; i < 7; i++) K.metal(out, t + i * 0.07, { f: 2400 + K.R() * 300, dur: 0.05, gain: g * 0.07, ratios: [1, 1.9] }); K.metal(out, t + 0.6, { f: 380, dur: 0.35, gain: g * 0.18 }); }
  else if (kind === 'medkit') { K.noise(out, t, { type: 'bandpass', f: 2500, f1: 5000, q: 2, dur: 0.35, attack: 0.05, gain: g * 0.18 }); K.noise(out, t + 0.4, { type: 'bandpass', f: 1200, q: 1, dur: 0.15, gain: g * 0.1 }); }
  else { K.noise(out, t, { type: 'highpass', f: 1800, dur: 1.4, attack: 0.04, hold: 0.8, gain: g * 0.25 }); K.noise(out, t, { type: 'lowpass', f: 600, dur: 0.3, gain: g * 0.2 }); }
}

// UI: short, dry, quiet.
export function ui(K, out, t, kind) {
  switch (kind) {
    case 'hover': K.tone(out, t, { f: 2900, dur: 0.02, gain: 0.04 }); break;
    case 'click': case 'toggle': K.tone(out, t, { f: kind === 'toggle' ? 1400 : 1850, f1: 1200, dur: 0.05, gain: 0.18 }); K.noise(out, t, { type: 'highpass', f: 3000, dur: 0.012, gain: 0.12 }); break;
    case 'back': K.tone(out, t, { f: 1200, f1: 700, dur: 0.07, gain: 0.16 }); break;
    case 'error': K.tone(out, t, { type: 'square', f: 150, dur: 0.12, gain: 0.07 }); K.tone(out, t + 0.14, { type: 'square', f: 150, dur: 0.14, gain: 0.07 }); break;
    case 'purchase':
      K.metal(out, t, { f: 2093, dur: 0.5, gain: 0.12, ratios: [1, 2.76] }); K.metal(out, t + 0.1, { f: 3136, dur: 0.8, gain: 0.12, ratios: [1, 2.76] });
      K.noise(out, t, { type: 'bandpass', f: 1200, dur: 0.06, gain: 0.15 }); break;
    case 'research': [523, 659, 784, 1047].forEach((f, i) => K.tone(out, t + i * 0.09, { type: 'triangle', f, dur: 0.6, attack: 0.01, gain: 0.12 })); break;
    case 'battleStart': case 'battle':
      K.tone(out, t, { f: 90, f1: 35, dur: 0.9, gain: 0.5, shape: 2 }); K.noise(out, t, { buf: 'brown', type: 'lowpass', f: 250, dur: 1.5, gain: 0.35 });
      for (const m of [50, 57, 62]) K.tone(out, t + 0.05, { type: 'sawtooth', f: 440 * Math.pow(2, (m - 69) / 12), dur: 1.6, attack: 0.12, hold: 0.4, gain: 0.05 });
      break;
    case 'notify': K.tone(out, t, { f: 988, dur: 0.15, gain: 0.1 }); K.tone(out, t + 0.12, { f: 1319, dur: 0.25, gain: 0.1 }); break;
    case 'squelch': K.noise(out, t, { type: 'bandpass', f: 1800, q: 1.5, dur: 0.07, gain: 0.05 }); break;
    default: K.tone(out, t, { f: 1600, dur: 0.04, gain: 0.12 });
  }
}

// Short warning cues that go with voice lines.
export function alert(K, out, t, kind) {
  if (kind === 'spotted') { K.tone(out, t, { type: 'triangle', f: 330, dur: 0.9, attack: 0.01, gain: 0.12 }); K.tone(out, t, { type: 'triangle', f: 466, dur: 0.9, attack: 0.01, gain: 0.08 }); K.noise(out, t, { buf: 'brown', type: 'lowpass', f: 120, dur: 0.8, gain: 0.3 }); }
  else if (kind === 'baseLost') { for (let i = 0; i < 2; i++) { K.tone(out, t + i * 0.35, { type: 'square', f: 620, dur: 0.16, gain: 0.03 }); K.tone(out, t + i * 0.35 + 0.16, { type: 'square', f: 480, dur: 0.16, gain: 0.03 }); } }
  else if (kind === 'baseWin') { K.tone(out, t, { type: 'triangle', f: 660, dur: 0.2, gain: 0.08 }); K.tone(out, t + 0.15, { type: 'triangle', f: 880, dur: 0.35, gain: 0.08 }); }
}
