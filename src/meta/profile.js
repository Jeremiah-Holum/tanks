// Player profile: credits, XP, owned and researched tanks, loadouts, settings, lifetime stats and
// recent battle history. Persisted as JSON in localStorage under 'steelfront.v1'.
// Every function takes the profile object explicitly, so node tests can run without storage.
import { TANKS, starters } from './roster.js';

export const STORAGE_KEY = 'steelfront.v1';
export const START_CREDITS = 20000;
export const HISTORY_MAX = 40;
export const CONSUMABLES = ['repair', 'medkit', 'extinguisher'];

export const DEFAULT_SETTINGS = {
  quality: 'auto',            // 'low' | 'medium' | 'high' | 'auto'
  renderScale: 1,             // 0.5..1 of devicePixelRatio-limited resolution
  fov: 70,                    // arcade camera vertical field of view, degrees
  mouseSens: 1.0,             // 0.2..3, multiplier
  sniperSens: 0.6,            // 0.1..2, multiplier in sniper mode
  invertY: false,
  volumes: { master: 0.8, sfx: 0.9, music: 0.45, voice: 0.85 },
  voice: true,                // crew voice callouts
  minimap: 'medium',          // 'small' | 'medium' | 'large'
  battleSize: 15,             // 15 or 7 (per team)
  showFps: false,
  damageLog: true,
};

export const newStats = () => ({
  battles: 0, wins: 0, losses: 0, draws: 0, survived: 0, kills: 0, dmg: 0, assist: 0, blocked: 0,
  received: 0, shots: 0, hits: 0, pens: 0, spotted: 0, capture: 0, defended: 0, xp: 0, credits: 0,
  maxDmg: 0, maxKills: 0, maxXp: 0, medals: {},
});

// Default ammo split for a gun: 75 % standard AP, 0 premium, rest HE (by shell order in the def).
export function defaultAmmo(def, gunIdx = 0) {
  const g = def.guns[gunIdx] || def.guns[0];
  const n = g.shells.length, cap = g.ammo;
  const out = new Array(n).fill(0);
  const std = g.shells.findIndex((s) => !s.gold && s.type !== 'HE');
  const he = g.shells.findIndex((s) => s.type === 'HE');
  const a = Math.round(cap * (he >= 0 ? 0.75 : 1));
  out[std >= 0 ? std : 0] = a;
  if (he >= 0) out[he] += cap - a;
  return out;
}

export function newTankState(def, owned = false) {
  return { owned, xp: 0, guns: [0], gun: 0, battles: 0, wins: 0, mastery: 0, ammo: defaultAmmo(def, 0),
    consumables: CONSUMABLES.slice(), crewXp: 0, dmg: 0, kills: 0, bought: 0 };
}

export function newProfile(name) {
  const p = {
    v: 1, name: name || 'Commander_' + (1000 + Math.floor(Math.random() * 9000)), created: Date.now(),
    credits: START_CREDITS, freeXp: 0, gold: 0, tanks: {}, researched: [], selected: null,
    settings: structuredClone(DEFAULT_SETTINGS), stats: newStats(), history: [], lastWinDay: null, battleSeq: 0,
  };
  for (const d of starters()) {
    p.tanks[d.id] = newTankState(d, true);
    p.researched.push(d.id);
  }
  p.selected = starters()[0]?.id || Object.keys(TANKS)[0];
  return p;
}

// Fill in anything missing (older saves, roster changes) and drop tanks that no longer exist.
export function migrate(p) {
  const base = newProfile(p && p.name);
  if (!p || typeof p !== 'object' || p.v !== 1) return base;
  for (const k of Object.keys(base)) if (p[k] === undefined) p[k] = base[k];
  p.settings = { ...structuredClone(DEFAULT_SETTINGS), ...p.settings, volumes: { ...DEFAULT_SETTINGS.volumes, ...(p.settings?.volumes || {}) } };
  p.stats = { ...newStats(), ...p.stats };
  for (const id of Object.keys(p.tanks)) {
    const def = TANKS[id];
    if (!def) { delete p.tanks[id]; continue; }
    const t = p.tanks[id] = { ...newTankState(def), ...p.tanks[id] };
    t.guns = t.guns.filter((g) => g < def.guns.length);
    if (!t.guns.includes(0)) t.guns.unshift(0);
    if (!t.guns.includes(t.gun)) t.gun = 0;
    const sh = def.guns[t.gun].shells.length;
    if (!Array.isArray(t.ammo) || t.ammo.length !== sh || t.ammo.reduce((a, b) => a + b, 0) > def.guns[t.gun].ammo) t.ammo = defaultAmmo(def, t.gun);
  }
  p.researched = p.researched.filter((id) => TANKS[id]);
  for (const d of starters()) {
    if (!p.researched.includes(d.id)) p.researched.push(d.id);
    if (!p.tanks[d.id]) p.tanks[d.id] = newTankState(d, true);
  }
  if (!TANKS[p.selected] || !p.tanks[p.selected]?.owned) p.selected = ownedIds(p)[0];
  return p;
}

const storage = (s) => s || (typeof localStorage !== 'undefined' ? localStorage : null);
export function loadProfile(s) {
  const st = storage(s);
  try { const raw = st && st.getItem(STORAGE_KEY); if (raw) return migrate(JSON.parse(raw)); } catch (e) { console.warn('[meta] profile load failed', e); }
  return newProfile();
}
export function saveProfile(p, s) {
  const st = storage(s);
  try { st && st.setItem(STORAGE_KEY, JSON.stringify(p)); } catch (e) { console.warn('[meta] profile save failed', e); }
}
export function resetProfile(s) { const p = newProfile(); saveProfile(p, s); return p; }

// ------------------------------------------------------------------ helpers
export const tankState = (p, id) => (p.tanks[id] ||= newTankState(TANKS[id], false));
export const isOwned = (p, id) => !!p.tanks[id]?.owned;
export const isResearched = (p, id) => p.researched.includes(id);
export const ownedIds = (p) => Object.keys(p.tanks).filter((id) => p.tanks[id].owned && TANKS[id])
  .sort((a, b) => TANKS[a].tier - TANKS[b].tier || TANKS[a].nation.localeCompare(TANKS[b].nation) || a.localeCompare(b));

export function selectTank(p, id) {
  if (!isOwned(p, id)) return false;
  p.selected = id; return true;
}

// Crew skill 0.5..1 from the tank's crew XP (100 % crew at ~60 battles on the tank).
export const crewSkill = (p, id) => Math.min(1, 0.5 + 0.5 * Math.sqrt(Math.min(1, (p.tanks[id]?.crewXp || 0) / 40000)));

const RANKS = [
  [0, 'Recruit'], [5, 'Private'], [15, 'Corporal'], [35, 'Sergeant'], [70, 'Staff Sergeant'], [120, 'Lieutenant'],
  [200, 'Captain'], [320, 'Major'], [500, 'Colonel'], [800, 'General'],
];
// Rank from battles fought (and wins weigh a little extra).
export function rankOf(p) {
  const score = p.stats.battles + p.stats.wins * 0.5;
  let r = 0; for (let i = 0; i < RANKS.length; i++) if (score >= RANKS[i][0]) r = i;
  const next = RANKS[r + 1];
  return { index: r, name: RANKS[r][1], next: next ? next[1] : null, progress: next ? (score - RANKS[r][0]) / (next[0] - RANKS[r][0]) : 1 };
}
