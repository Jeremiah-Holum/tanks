// The Director: an Elo-style rating of how well the human plays, and the
// functions that turn that rating into enemy brains. Pure; persistence lives in main.js.
import { TYPES, SKILLS } from './tanks.js';

export const DEFAULT_RATING = 0.35;
export const FIXED_RATING = 0.5;

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => Math.max(0, Math.min(1, v));

export function newDirector() { return { rating: DEFAULT_RATING, games: 0, adaptive: true, history: [] }; }

// How hard a campaign mission is, on the same 0..1 scale as the rating.
export const missionThreat = (m, count = 20) => 0.08 + 0.87 * (m / Math.max(1, count - 1));

// What the rating is worth right now, after the retry mercy.
export function effectiveRating(dir, retries = 0) {
  if (!dir.adaptive) return FIXED_RATING;
  return clamp01(dir.rating - 0.05 * Math.max(0, retries - 2));
}

// result: 1 win, 0 loss, 0.5 draw. `quality` (0..1) nudges a win by accuracy/cleanliness.
export function recordResult(dir, threat, result, quality = 0.5) {
  const E = 1 / (1 + Math.exp(-(dir.rating - threat) * 6));
  const K = Math.max(0.035, 0.18 / Math.sqrt(1 + dir.games / 4));
  let R = result;
  if (result === 1) R = 0.85 + 0.3 * quality; // a sloppy win still counts, a clean one counts more
  dir.rating = clamp01(dir.rating + K * (R - E));
  dir.games++;
  dir.history.push(+dir.rating.toFixed(3));
  if (dir.history.length > 40) dir.history.shift();
  return dir.rating;
}

// Campaign: scale an enemy type's brain and reload by the rating.
export function tuneEnemy(typeKey, s) {
  const base = TYPES[typeKey];
  const ai = { ...base.ai };
  ai.aimErr = base.ai.aimErr * lerp(1.6, 0.6, s);
  ai.think = base.ai.think * lerp(1.5, 0.75, s);
  ai.samples = Math.round((base.ai.samples || 0) * lerp(0.5, 1.2, s));
  ai.fireTol = base.ai.fireTol * lerp(1.35, 0.8, s);
  ai.dodgeLook = (base.ai.dodgeLook || 0.4) * lerp(0.6, 1.25, s);
  // Low ratings switch dodging off for the mid-tier; the elites always dodge.
  const elite = typeKey === 'hunter' || typeKey === 'boss';
  ai.dodge = base.ai.dodge ? (elite || s >= 0.25) : (s >= 0.8 && base.speed > 0);
  ai.dodgeEvery = s >= 0.7 && elite ? 'tick' : 'think';
  ai.lead = base.ai.lead || s >= 0.6;
  const type = { ...base, reload: base.reload * lerp(1.25, 0.9, s), ai };
  return type;
}

// Versus "Adaptive" bot: blend Cadet → Veteran → Ace by rating.
export function blendSkill(s) {
  const [a, b, t] = s < 0.5 ? [SKILLS.cadet, SKILLS.veteran, s / 0.5] : [SKILLS.veteran, SKILLS.ace, (s - 0.5) / 0.5];
  const out = { label: 'Adaptive' };
  for (const k of Object.keys(a)) {
    if (k === 'label') continue;
    const va = a[k], vb = b[k];
    if (typeof va === 'number') out[k] = k === 'bank' || k === 'samples' ? Math.round(lerp(va, vb, t)) : lerp(va, vb, t);
    else out[k] = t < 0.5 ? va : vb;
  }
  return out;
}

export const SKILL_THREAT = { cadet: 0.15, veteran: 0.5, ace: 0.9 };
