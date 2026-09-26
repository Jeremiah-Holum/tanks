// One-shot sound recipes. Each takes the Kit, a destination node and a start time; gains are
// relative (the caller's placement node does distance, pan and bus levels).
// Style: layered, saturated noise with a real low end (punch + pitch-dropping sub boom), a mid
// crack for detail and long dark tails; pure tones only as sub-bass body or as struck-metal partials.
import { clamp } from './core.js';

// Calibre → 0..1 "size" (15 mm → 0, 135 mm → 1; 152 mm → 1.14, allowed to overshoot a little).
export const size = (cal) => clamp(((cal || 75) - 15) / 120, 0, 1.2);

// Cannon. A gun is its REPORT, with weight behind it:
// 1. muzzle-blast N-wave crack (`Kit.nwave`: 1-sample rise, 2–8 ms): sharp onset, but on the player's own
//    gun no more than ~2× the body's peak;
// 2. the bark: driven 150–900 Hz body, 150–250 ms (what laptop speakers actually play);
// 3. the BOOM: a strongly driven 60–250 Hz body that holds ~0.25 s and decays over ~1 s, plus true sub;
// 4. two slapback reflections and a short 1–1.5 s tail.
// o.far (0..1): distant shots lose the crack and most of the bark. o.player: recoil + breech + case.
// With a recorded `assets/sfx/cannon.*` (K.samples.cannon) the sample replaces the synth body.
export function cannon(K, out, t, cal, o = {}) {
  const k = size(cal), m = Math.min(1, k), g = o.gain ?? 1, brake = !!o.brake, far = clamp(o.far ?? 0), near = 1 - far;
  if (K.samples?.cannon) { cannonSample(K, out, t, cal, o); return; }
  // 1. crack
  K.nwave(out, t, 2 + 6 * m, g * (o.player ? 1.0 : 1.5 + 0.2 * m) * (0.25 + 0.75 * near));
  K.noise(out, t, { type: 'highpass', f: 1200, q: 0.5, dur: 0.008 + 0.006 * m, gain: g * 0.3 * near, attack: 0.0002, drive: 3 });
  if (cal < 30) { // autocannon: crack + a short bark
    K.noise(out, t, { type: 'bandpass', f: 900, q: 0.7, dur: 0.07, gain: g * 0.55, attack: 0.0003, drive: 6 });
    K.tone(out, t, { f: 160, f1: 90, fdur: 0.04, dur: 0.15, gain: g * 0.2, attack: 0.0005, shape: 3 });
    K.noise(out, t + 0.12, { type: 'lowpass', f: 700, dur: 0.12, gain: g * 0.08, attack: 0.001 });
    return;
  }
  // 2. bark: 150–250 ms, deeper and longer for bigger guns
  const bd = 0.15 + 0.1 * m, bf = 520 - 260 * m;
  K.noise(out, t, { type: 'bandpass', f: bf, q: 0.6, dur: bd, hold: 0.03, gain: g * (0.9 + 0.6 * m) * (0.5 + 0.5 * near), attack: 0.0003, drive: 7 });
  K.noise(out, t, { type: 'lowpass', f: 900 - 500 * far, q: 0.7, dur: bd * 1.2, gain: g * 0.45, attack: 0.0003, drive: 4 });
  if (brake) K.noise(out, t + 0.002, { type: 'bandpass', f: 700 - 200 * m, q: 0.9, dur: 0.1 + 0.08 * m, gain: g * 0.4, attack: 0.0003, drive: 5 });
  // 3. BOOM: driven low-mid body, holds ~0.25 s, gone by ~1 s
  const hold = 0.12 + 0.13 * m, bl = 0.55 + 0.55 * m;
  K.tone(out, t, { type: 'sawtooth', f: 150 - 50 * m, f1: 75 - 25 * m, fdur: 0.12 + 0.1 * m, dur: bl, hold, gain: g * (0.2 + 0.2 * m), attack: 0.004, shape: 6 });
  K.noise(out, t, { buf: 'brown', type: 'lowpass', f: 260 - 60 * m, q: 0.9, dur: bl, hold, gain: g * (0.3 + 0.3 * m), attack: 0.004, drive: 6 });
  K.tone(out, t, { f: 75 - 20 * m, f1: 42, fdur: 0.2, dur: bl * 0.9, hold: hold * 0.6, gain: g * (0.15 + 0.2 * m), attack: 0.004, shape: 2 });
  // 4. two slaps and a short tail (≈ half the first version's rolling tail)
  for (let i = 0; i < 2; i++) {
    const at = t + 0.18 + 0.25 * i + 0.2 * m * i + 0.05 * K.R() + 0.25 * far, a = g * (0.18 + 0.08 * m) * Math.pow(0.55, i) * (1 + 0.6 * far);
    K.noise(out, at, { type: 'bandpass', f: bf * (0.8 - 0.1 * i), q: 0.7, dur: 0.12, gain: a, attack: 0.002, drive: 3 });
    K.tone(out, at, { f: 90 - 25 * m, f1: 55, dur: 0.25 + 0.2 * m, gain: a * 0.6, attack: 0.003 });
  }
  K.thunder(out, t + 0.05, { len: 1 + 0.5 * m, f: 150 - 40 * m, gain: g * (0.1 + 0.2 * m) * (1 + 0.8 * far), echoes: 0 });
  if (o.player) gunnerSeat(K, out, t, cal, m, g, bf, bd);
}

// The gunner's seat: extra close bark, recoil slam and breech clank, then the spent case.
function gunnerSeat(K, out, t, cal, m, g, bf, bd) {
  K.noise(out, t, { type: 'bandpass', f: bf * 1.3, q: 0.7, dur: bd, gain: g * 0.4, attack: 0.0003, drive: 6 });
  const tr = t + 0.045 + 0.04 * m;
  K.noise(out, tr, { type: 'bandpass', f: 420 - 100 * m, q: 1.1, dur: 0.09, gain: g * 0.35, attack: 0.0005, drive: 5 });
  K.metal(out, tr, { f: 170 - 50 * m, ratios: [1, 1.63, 2.41, 3.7], dur: 0.3, gain: g * 0.16, bright: 0.45 });
  const tb = t + 0.25 + 0.18 * m;
  K.punch(out, tb, { f: 180, f1: 80, gain: g * 0.22, nf: 1200 });
  K.metal(out, tb, { f: 280 - 80 * m, ratios: [1, 2.1, 3.3], dur: 0.22, gain: g * 0.1, bright: 0.5 });
  if (cal >= 37) { const tc = t + 0.7 + 0.4 * m; K.metal(out, tc, { f: 520 - 120 * m, ratios: [1, 2.7, 4.1], dur: 0.3, gain: g * 0.05, bright: 0.4 }); K.metal(out, tc + 0.14, { f: 540 - 120 * m, ratios: [1, 2.7], dur: 0.2, gain: g * 0.025, bright: 0.3 }); }
}

// Recorded cannon: the sample at a calibre-dependent rate (≈1.25 for 20–37 mm → ≈0.75 for 122–152 mm),
// louder for bigger guns; the synth crack stays on top only for small calibres.
function cannonSample(K, out, t, cal, o) {
  const k = size(cal), m = Math.min(1, k), g = o.gain ?? 1, far = clamp(o.far ?? 0);
  K.sample(out, t, K.samples.cannon, { rate: 1.3 - 0.55 * m, gain: g * (0.6 + 0.5 * m) });
  if (cal < 45 && far < 0.5) K.nwave(out, t, 2 + 4 * m, g * 0.6 * (1 - far));
  if (o.player) gunnerSeat(K, out, t, cal, m, g, 520 - 260 * m, 0.15 + 0.1 * m);
}

// Explosion: size ~0.5 (HE splash) .. 3 (ammo rack).
export function explosion(K, out, t, s = 1, o = {}) {
  const g = o.gain ?? 1, z = clamp(s / 3);
  if (K.samples?.explosion) { K.sample(out, t, K.samples.explosion, { rate: 1.3 - 0.5 * z, gain: g * (0.6 + 0.5 * z) }); return; }
  K.punch(out, t, { f: 150 - 60 * z, f1: 40, fdur: 0.04 + 0.03 * z, dur: 0.1 + 0.08 * z, gain: g * (0.6 + 0.3 * z), nf: 600 });
  K.boom(out, t, { f: 70 - 25 * z, f1: 24, fdur: 0.12 + 0.3 * z, dur: 0.5 + 1.2 * z, gain: g * (0.5 + 0.45 * z), shape: 2.8 });
  K.noise(out, t, { type: 'lowpass', f: 3200 - 1400 * z, f1: 170, fdur: 0.2 + 0.5 * z, q: 0.9, dur: 0.5 + 1.3 * z, gain: g * 0.75, drive: 3 });
  K.noise(out, t, { type: 'bandpass', f: 1100, q: 0.7, dur: 0.06 + 0.04 * z, gain: g * 0.35, drive: 5 });
  K.thunder(out, t + 0.03, { len: 1 + 2.5 * z, f: 150, gain: g * (0.35 + 0.35 * z), echoes: 2 + Math.round(2 * z) });
  // debris: dirt and fragments pattering down (dark, not ticky)
  K.ticks(out, t + 0.2, { n: Math.round(5 + 8 * z), span: 0.7 + 1.3 * z, f: 1100, q: 0.9, gain: g * 0.16, dur: 0.05 });
}

// Ammo rack: the biggest blast, a fireball roar, secondary blasts, cooking-off rounds and steel debris.
export function ammorack(K, out, t, o = {}) {
  const g = o.gain ?? 1;
  explosion(K, out, t, 3, { gain: g });
  K.boom(out, t + 0.12, { f: 45, f1: 20, fdur: 0.6, dur: 2.2, gain: g * 0.5, shape: 3 });
  K.noise(out, t + 0.05, { type: 'bandpass', f: 220, f1: 700, fdur: 1.5, q: 0.7, dur: 2.6, attack: 0.2, gain: g * 0.35, drive: 3 });
  for (let k = 0; k < 7; k++) {
    const tt = t + 0.35 + K.R() * 2.3, a = 0.3 + K.R() * 0.5;
    K.punch(out, tt, { f: 170, f1: 55, gain: g * 0.25 * a, nf: 800 });
    K.noise(out, tt, { type: 'lowpass', f: 1800, f1: 300, dur: 0.18, gain: g * 0.25 * a, drive: 3 });
  }
  for (let k = 0; k < 3; k++) K.metal(out, t + 0.9 + K.R() * 1.6, { f: 140 + K.R() * 90, ratios: [1, 1.7, 2.6], dur: 0.5, gain: g * 0.08, bright: 0.3 });
}

// Shell into the ground / a building / water.
export function impact(K, out, t, surface, cal, o = {}) {
  const k = size(cal), g = (o.gain ?? 1) * (0.55 + 0.55 * k), s = String(surface || 'ground').toLowerCase();
  if (/water|shallow|deep|river|lake/.test(s)) {
    K.punch(out, t, { f: 120, f1: 40, gain: g * 0.45, nf: 400 });
    K.noise(out, t, { type: 'bandpass', f: 500, f1: 1600, fdur: 0.25, q: 0.7, dur: 0.45, gain: g * 0.5, drive: 2 });
    K.noise(out, t + 0.05, { type: 'lowpass', f: 2600, f1: 900, dur: 1.2, attack: 0.1, gain: g * 0.22 }); // spray falling back
    K.noise(out, t, { buf: 'brown', type: 'lowpass', f: 200, dur: 0.6, gain: g * 0.4 });
  } else if (/tree|pine|log|fence|shed|hay|hedge|bush/.test(s)) { // timber: splintering thunk
    K.punch(out, t, { f: 130, f1: 55, gain: g * 0.4, nf: 600 });
    K.noise(out, t, { type: 'bandpass', f: 750, f1: 350, q: 1, dur: 0.28, gain: g * 0.5, drive: 4 });
    K.ticks(out, t, { n: 7, span: 0.25, f: 1300, q: 1.5, gain: g * 0.3, dur: 0.025, skew: 1 });
  } else if (/rock|stone|build|house|wall|brick|concrete|object|road|ruin|church|barn|station|silo|windmill|bridge/.test(s)) {
    K.punch(out, t, { f: 150, f1: 50, gain: g * 0.5, nf: 800 });
    K.noise(out, t, { type: 'bandpass', f: 1300, q: 0.8, dur: 0.06, gain: g * 0.45, drive: 5 });
    K.noise(out, t, { type: 'lowpass', f: 1400, f1: 250, q: 0.8, dur: 0.4, gain: g * 0.5, drive: 3 });
    K.noise(out, t + 0.02, { buf: 'brown', type: 'lowpass', f: 220, dur: 0.8, attack: 0.02, gain: g * 0.35 });
    K.ticks(out, t + 0.05, { n: 10, span: 0.9, f: 1400, q: 1, gain: g * 0.18, dur: 0.035 });
  } else if (/tank|metal|steel|wreck/.test(s)) {
    K.punch(out, t, { f: 140, f1: 60, gain: g * 0.35, nf: 900 });
    K.metal(out, t, { f: 210, ratios: [1, 1.58, 2.37, 3.9], dur: 0.6, gain: g * 0.3, bright: 0.5 });
  } else { // soil, grass, mud, sand, snow, fields: a heavy thud and a spray of dirt
    K.punch(out, t, { f: 120, f1: 38, gain: g * 0.55, nf: 450 });
    K.boom(out, t, { f: 60, f1: 30, fdur: 0.12, dur: 0.35 + 0.3 * k, gain: g * 0.35 });
    K.noise(out, t, { type: 'lowpass', f: 1100, f1: 180, fdur: 0.18, dur: 0.45, gain: g * 0.55, drive: 3 });
    K.noise(out, t + 0.03, { buf: 'brown', type: 'lowpass', f: 180, dur: 0.7, gain: g * 0.4 });
    K.noise(out, t + 0.12, { type: 'bandpass', f: 1200, q: 0.6, dur: 0.7, attack: 0.05, gain: g * 0.1 }); // dirt raining down
    K.ticks(out, t + 0.15, { n: 5, span: 0.7, f: 1000, gain: g * 0.12, dur: 0.04 });
  }
}

// A near miss: the supersonic crack of a shell passing close, then its air rush.
export function snap(K, out, t, o = {}) {
  const g = o.gain ?? 1;
  K.noise(out, t, { type: 'bandpass', f: 2000, q: 0.7, dur: 0.02, gain: g * 0.45, attack: 0.0003, drive: 4 });
  K.noise(out, t + 0.005, { type: 'bandpass', f: 900, f1: 350, q: 1, dur: 0.3, gain: g * 0.2 });
}

// Ricochet: a noisy, descending tearing whine (resonant noise sweep with a faint pitched core).
export function whine(K, out, t, o = {}) {
  const g = o.gain ?? 1, f0 = 2000 + K.R() * 600, f1 = 450 + K.R() * 200, d = 0.5 + K.R() * 0.25;
  K.noise(out, t + 0.015, { type: 'bandpass', f: f0, f1, q: 5, dur: d, attack: 0.01, gain: g * 0.35 });
  K.noise(out, t + 0.015, { type: 'bandpass', f: f0 * 0.5, f1: f1 * 0.6, q: 2, dur: d * 0.8, attack: 0.01, gain: g * 0.18 });
  K.tone(out, t + 0.015, { f: f0 * 0.8, f1, dur: d * 0.8, attack: 0.02, gain: g * 0.04 });
}

// Hit on another tank, heard from outside (world perspective or the shooter's confirmation).
export function hitOutside(K, out, t, result, cal, o = {}) {
  const k = size(cal), g = o.gain ?? 1;
  switch (result) {
    case 'pen': case 'crit':
      // a deep, crunching punch through armour
      K.punch(out, t, { f: 150 - 40 * k, f1: 45, gain: g * (0.6 + 0.3 * k), nf: 700 });
      K.boom(out, t, { f: 70, f1: 32, fdur: 0.1, dur: 0.4 + 0.3 * k, gain: g * (0.3 + 0.3 * k) });
      K.noise(out, t, { type: 'bandpass', f: 600, f1: 250, q: 0.9, dur: 0.3, gain: g * 0.6, drive: 5 });
      K.metal(out, t, { f: 120 + (1 - k) * 80, ratios: [1, 1.58, 2.37, 3.1], dur: 0.6, gain: g * 0.2, bright: 0.4 });
      K.ticks(out, t + 0.01, { n: 8, span: 0.18, f: 1600, q: 1, gain: g * 0.25, dur: 0.035 });
      if (result === 'crit') { K.noise(out, t + 0.06, { buf: 'brown', type: 'lowpass', f: 300, dur: 0.6, gain: g * 0.5, drive: 3 }); K.metal(out, t + 0.05, { f: 330, ratios: [1, 1.5, 2.2], dur: 0.4, gain: g * 0.1, bright: 0.5 }); }
      break;
    case 'nopen': // a heavy ringing clang: steel bell, driven noise strike
      K.punch(out, t, { f: 160, f1: 70, gain: g * 0.45, nf: 1100 });
      K.metal(out, t, { f: 260 - 110 * k, ratios: [1, 1.52, 2.33, 3.4, 4.6], dur: 1.2, gain: g * 0.35, bright: 0.6 });
      K.noise(out, t, { type: 'bandpass', f: 1400, q: 0.9, dur: 0.05, gain: g * 0.4, drive: 5 });
      break;
    case 'ricochet':
      K.punch(out, t, { f: 180, f1: 80, gain: g * 0.3, nf: 1200 });
      K.metal(out, t, { f: 420, ratios: [1, 1.6, 2.4], dur: 0.35, gain: g * 0.2, bright: 0.6 });
      whine(K, out, t, { gain: g });
      break;
    case 'track':
      K.punch(out, t, { f: 140, f1: 55, gain: g * 0.4, nf: 800 });
      K.metal(out, t, { f: 190, ratios: [1, 1.7, 2.6], dur: 0.45, gain: g * 0.25, bright: 0.5 });
      K.ticks(out, t + 0.02, { n: 12, span: 0.55, f: 1200, q: 1.5, gain: g * 0.3, dur: 0.035 });
      break;
    case 'splash': default:
      explosion(K, out, t, 0.3 + 0.9 * k, { gain: g * 0.7 });
  }
}

// Being hit, heard from inside the player's tank: a massive muffled slam through the hull, spall
// rattling around for penetrations, the tearing whine for ricochets. (No high "ear ring": the
// caller ducks the mix briefly instead.)
export function hitInside(K, out, t, result, cal, o = {}) {
  const k = size(cal), g = o.gain ?? 1;
  K.punch(out, t, { f: 130, f1: 38, fdur: 0.05, dur: 0.14, gain: g * (0.7 + 0.25 * k), nf: 450 });
  K.boom(out, t, { f: 62, f1: 26, fdur: 0.2, dur: 0.7 + 0.4 * k, gain: g * (0.5 + 0.35 * k), shape: 3 });
  K.metal(out, t, { f: 82 + K.R() * 20 + (1 - k) * 35, ratios: [1, 1.58, 2.37, 3.9, 5.1], dur: 1.3, gain: g * 0.35, bright: 0.45 });
  K.noise(out, t, { type: 'lowpass', f: 1600, f1: 250, fdur: 0.2, dur: 0.35, gain: g * 0.55, drive: 4 });
  if (result === 'pen' || result === 'crit') {
    K.ticks(out, t + 0.01, { n: 14, span: 0.45, f: 1700, q: 1, gain: g * 0.28, dur: 0.035 });
    K.noise(out, t, { type: 'bandpass', f: 500, q: 0.9, dur: 0.4, gain: g * 0.45, drive: 3 });
  }
  if (result === 'ricochet') whine(K, out, t + 0.02, { gain: g * 0.7 });
  if (result === 'track') K.ticks(out, t + 0.03, { n: 12, span: 0.6, f: 1200, q: 2, gain: g * 0.3, dur: 0.035 });
  if (result === 'splash') K.noise(out, t, { buf: 'brown', type: 'lowpass', f: 220, dur: 1, gain: g * 0.55, drive: 2 });
}

// Ramming: grinding crunch of steel on steel.
export function ram(K, out, t, dmg, o = {}) {
  const g = (o.gain ?? 1) * clamp(0.4 + (dmg || 0) / 150, 0.4, 1);
  K.punch(out, t, { f: 110, f1: 35, fdur: 0.06, dur: 0.16, gain: g * 0.7, nf: 400 });
  K.metal(out, t, { f: 68, ratios: [1, 1.7, 2.9, 4.4], dur: 0.9, gain: g * 0.4, bright: 0.5 });
  K.noise(out, t, { type: 'bandpass', f: 380, q: 0.9, dur: 0.6, gain: g * 0.6, drive: 5 });
  K.noise(out, t + 0.05, { type: 'bandpass', f: 1100, f1: 700, q: 1.5, dur: 0.45, gain: g * 0.2, drive: 3 });
}

// Tree: snapping fibres, a creaking groan as it goes, leaves rushing, the trunk thumping down.
export function treeFall(K, out, t, o = {}) {
  const g = o.gain ?? 1;
  K.punch(out, t, { f: 150, f1: 70, gain: g * 0.3, nf: 900 });
  K.ticks(out, t, { n: 9, span: 0.25, f: 1300, q: 1.5, gain: g * 0.45, dur: 0.025, skew: 1 });
  K.noise(out, t + 0.1, { type: 'bandpass', f: 320, f1: 200, q: 3, dur: 0.9, attack: 0.15, gain: g * 0.25, drive: 3 }); // groan
  K.noise(out, t + 0.25, { type: 'bandpass', f: 1800, q: 0.5, dur: 1.1, attack: 0.45, gain: g * 0.12 });            // leaves
  K.punch(out, t + 1.15, { f: 110, f1: 35, gain: g * 0.5, nf: 400 });
  K.boom(out, t + 1.15, { f: 55, f1: 28, fdur: 0.15, dur: 0.5, gain: g * 0.35 });
  K.noise(out, t + 1.15, { buf: 'brown', type: 'lowpass', f: 220, dur: 0.6, gain: g * 0.5 });
  K.ticks(out, t + 1.17, { n: 6, span: 0.35, f: 900, gain: g * 0.15, dur: 0.04 });
}

// Fence, shed or wall breaking: a crash of timber and rubble.
export function crash(K, out, t, o = {}) {
  const g = o.gain ?? 1;
  K.punch(out, t, { f: 130, f1: 45, gain: g * 0.5, nf: 600 });
  K.noise(out, t, { type: 'bandpass', f: 900, f1: 300, q: 0.8, dur: 0.45, gain: g * 0.5, drive: 4 });
  K.noise(out, t + 0.02, { buf: 'brown', type: 'lowpass', f: 250, dur: 0.9, gain: g * 0.45 });
  K.ticks(out, t, { n: 14, span: 0.9, f: 1200, q: 1.2, gain: g * 0.28, dur: 0.04 });
}

// Fire starting: ignition whoomp.
export function ignite(K, out, t, o = {}) {
  const g = o.gain ?? 1;
  K.boom(out, t, { f: 55, f1: 35, fdur: 0.3, dur: 0.6, attack: 0.05, gain: g * 0.3 });
  K.noise(out, t, { type: 'lowpass', f: 250, f1: 1100, fdur: 0.4, q: 0.8, dur: 1, attack: 0.08, gain: g * 0.5, drive: 3 });
  K.noise(out, t, { buf: 'crackle', type: 'bandpass', f: 1400, q: 0.7, dur: 1.2, attack: 0.1, gain: g * 0.5 });
}

// Player's module damage cues (heard inside).
export function engineCough(K, out, t, o = {}) {
  const g = o.gain ?? 1;
  for (let i = 0; i < 3; i++) { const tt = t + 0.15 + i * (0.18 + K.R() * 0.1); K.punch(out, tt, { f: 90, f1: 40, gain: g * 0.3, nf: 300 }); K.noise(out, tt, { buf: 'brown', type: 'lowpass', f: 400, dur: 0.18, gain: g * 0.5, drive: 3 }); }
  K.metal(out, t, { f: 230, dur: 0.3, gain: g * 0.1, bright: 0.4 });
}
export function trackBreak(K, out, t, o = {}) {
  const g = o.gain ?? 1;
  K.punch(out, t, { f: 150, f1: 60, gain: g * 0.4, nf: 900 });
  K.metal(out, t, { f: 200, ratios: [1, 1.7, 2.6], dur: 0.5, gain: g * 0.25, bright: 0.5 });
  K.ticks(out, t + 0.05, { n: 16, span: 0.9, f: 1100, q: 2, gain: g * 0.3, dur: 0.04 });
  K.noise(out, t + 0.6, { buf: 'brown', type: 'lowpass', f: 220, dur: 0.35, gain: g * 0.45 });
  K.punch(out, t + 0.62, { f: 100, f1: 40, gain: g * 0.3, nf: 400 });
}

// Loading: rammer slide, then the breech block slamming shut. Heavier for big guns.
export function reload(K, out, t, cal, o = {}) {
  const k = size(cal), g = o.gain ?? 1;
  if (cal < 30) { K.noise(out, t, { type: 'bandpass', f: 1100, q: 1.5, dur: 0.03, gain: g * 0.2, drive: 3 }); K.punch(out, t + 0.08, { f: 200, f1: 90, gain: g * 0.15, nf: 1200 }); K.metal(out, t + 0.08, { f: 520, ratios: [1, 2.3], dur: 0.12, gain: g * 0.06, bright: 0.4 }); return; }
  K.noise(out, t, { type: 'bandpass', f: 800, f1: 400, q: 1, dur: 0.2, gain: g * 0.16, drive: 2 });
  const tb = t + 0.17;
  K.punch(out, tb, { f: 150 - 40 * k, f1: 55, gain: g * (0.3 + 0.2 * k), nf: 800 });
  K.metal(out, tb, { f: 190 - 70 * k, ratios: [1, 1.63, 2.41], dur: 0.35, gain: g * 0.22, bright: 0.4 });
  K.noise(out, tb, { type: 'bandpass', f: 1300, q: 1.2, dur: 0.025, gain: g * 0.18, drive: 4 });
}

// Consumables.
export function consumable(K, out, t, kind, o = {}) {
  const g = o.gain ?? 1;
  if (kind === 'repair') { for (let i = 0; i < 6; i++) { K.noise(out, t + i * 0.08, { type: 'bandpass', f: 1300 + K.R() * 300, q: 2, dur: 0.03, gain: g * 0.14, drive: 3 }); } K.punch(out, t + 0.55, { f: 150, f1: 70, gain: g * 0.25, nf: 900 }); K.metal(out, t + 0.55, { f: 300, dur: 0.35, gain: g * 0.12, bright: 0.4 }); }
  else if (kind === 'medkit') { K.noise(out, t, { type: 'bandpass', f: 1400, f1: 2200, q: 1.5, dur: 0.3, attack: 0.05, gain: g * 0.16 }); K.noise(out, t + 0.35, { type: 'bandpass', f: 900, q: 1, dur: 0.15, gain: g * 0.12, drive: 2 }); }
  else { K.noise(out, t, { type: 'bandpass', f: 1500, q: 0.5, dur: 1.4, attack: 0.04, hold: 0.8, gain: g * 0.28 }); K.noise(out, t, { type: 'lowpass', f: 500, dur: 0.35, gain: g * 0.3, drive: 2 }); }
}

// UI: short, dry, mechanical (switch clicks and thunks, not beeps).
export function ui(K, out, t, kind) {
  const click = (tt, f, gain, body) => { K.noise(out, tt, { type: 'bandpass', f, q: 1.3, dur: 0.012, gain, attack: 0.0003, drive: 3 }); K.tone(out, tt, { f: body, f1: body * 0.55, dur: 0.05, gain: gain * 0.9, shape: 2 }); };
  switch (kind) {
    case 'hover': K.noise(out, t, { type: 'bandpass', f: 900, q: 1.5, dur: 0.008, gain: 0.03 }); break;
    case 'click': click(t, 1500, 0.22, 170); break;
    case 'toggle': click(t, 1200, 0.18, 150); click(t + 0.05, 1600, 0.12, 190); break;
    case 'back': click(t, 1000, 0.2, 120); break;
    case 'error': K.tone(out, t, { type: 'sawtooth', f: 95, dur: 0.12, gain: 0.08, shape: 2 }); K.tone(out, t + 0.14, { type: 'sawtooth', f: 90, dur: 0.14, gain: 0.08, shape: 2 }); K.noise(out, t, { type: 'lowpass', f: 500, dur: 0.3, gain: 0.12 }); break;
    case 'purchase': // a heavy stamp and a warm bell
      K.punch(out, t, { f: 150, f1: 60, gain: 0.35, nf: 700 }); K.noise(out, t, { type: 'bandpass', f: 1100, q: 1, dur: 0.05, gain: 0.2, drive: 3 });
      K.metal(out, t + 0.08, { f: 523, dur: 0.9, gain: 0.08, ratios: [1, 2.0, 2.76], bright: 0.4 }); K.metal(out, t + 0.2, { f: 784, dur: 1, gain: 0.07, ratios: [1, 2.0, 2.76], bright: 0.4 }); break;
    case 'research': [262, 330, 392, 523].forEach((f, i) => K.tone(out, t + i * 0.09, { type: 'triangle', f, dur: 0.7, attack: 0.012, gain: 0.1 })); K.punch(out, t, { f: 130, f1: 60, gain: 0.2, nf: 500 }); break;
    case 'battleStart': case 'battle':
      K.punch(out, t, { f: 120, f1: 35, gain: 0.5, nf: 500 }); K.boom(out, t, { f: 60, f1: 26, fdur: 0.3, dur: 1.1, gain: 0.5, shape: 2.5 });
      K.thunder(out, t + 0.03, { len: 2, f: 150, gain: 0.35, echoes: 3 });
      for (const m of [38, 45, 50]) K.tone(out, t + 0.05, { type: 'sawtooth', f: 440 * Math.pow(2, (m - 69) / 12), dur: 1.6, attack: 0.12, hold: 0.4, gain: 0.045, shape: 1.5 });
      break;
    case 'notify': click(t, 1300, 0.12, 160); K.tone(out, t + 0.03, { type: 'triangle', f: 660, dur: 0.25, gain: 0.06 }); break;
    case 'squelch': K.noise(out, t, { type: 'bandpass', f: 1500, q: 1.2, dur: 0.07, gain: 0.05 }); break;
    default: click(t, 1400, 0.15, 160);
  }
}

// Short warning cues that go with voice lines.
export function alert(K, out, t, kind) {
  if (kind === 'spotted') { K.tone(out, t, { type: 'triangle', f: 220, dur: 0.9, attack: 0.01, gain: 0.12 }); K.tone(out, t, { type: 'triangle', f: 311, dur: 0.9, attack: 0.01, gain: 0.08 }); K.boom(out, t, { f: 60, f1: 40, fdur: 0.3, dur: 0.8, gain: 0.3 }); }
  else if (kind === 'baseLost') { for (let i = 0; i < 2; i++) { K.tone(out, t + i * 0.35, { type: 'square', f: 440, dur: 0.16, gain: 0.03 }); K.tone(out, t + i * 0.35 + 0.16, { type: 'square', f: 330, dur: 0.16, gain: 0.03 }); } }
  else if (kind === 'baseWin') { K.tone(out, t, { type: 'triangle', f: 440, dur: 0.2, gain: 0.08 }); K.tone(out, t + 0.15, { type: 'triangle', f: 587, dur: 0.35, gain: 0.08 }); }
}
