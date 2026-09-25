// Economy: battle rewards (XP, free XP, credits), service costs (repair, ammo, consumables),
// research, buying and selling, gun research, and mastery badges.
//
// Tuning idea: WoT-style research costs and prices come from the tank data, and the per-tier
// reward rates are derived from them so an average player (≈1× own HP of damage, 50 % wins)
// needs TARGET_BATTLES[t] battles on a tier-t tank to research and afford the next tier.
// That keeps progression at "tier V in ~30 battles, tier VII in ~100" whatever the exact numbers
// in src/data/tanks.js are. See docs/notes/meta.md for the resulting tables.
import { TANKS, TANK_LIST, MAX_TIER } from './roster.js';
import { tankState, defaultAmmo, isResearched, isOwned, ownedIds, CONSUMABLES } from './profile.js';

export const TARGET_BATTLES = [0, 1.5, 4, 8, 14, 26, 38, 45]; // battles at tier t to unlock tier t+1
export const AVG_PERF = 1.93;          // performance units an average player earns (see perfUnits)
export const WIN_XP = 1.5, WIN_CR = 1.25, FREE_XP = 0.05, FIRST_WIN_XP = 2;
export const SELL_FACTOR = 0.5;
export const CONSUMABLE_INFO = {
  repair: { name: 'Small Repair Kit', key: 4, desc: 'Repairs damaged modules and tracks.' },
  medkit: { name: 'Small First Aid Kit', key: 5, desc: 'Heals injured crew members.' },
  extinguisher: { name: 'Manual Fire Extinguisher', key: 6, desc: 'Puts out a fire.' },
};

const avg = (a) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
const tierDefs = (t) => TANK_LIST.filter((d) => d.tier === t);
export const refHp = (t) => avg(tierDefs(t).map((d) => d.hp)) || 100 * (1 + 0.45 * (t - 1));
const avgXpCost = (t) => avg(tierDefs(t).map((d) => d.xp || 0));
const avgPrice = (t) => avg(tierDefs(t).map((d) => d.price || 0));

// XP per performance unit at tier t, so that an average player researches tier t+1 in TARGET_BATTLES[t].
const XPT = [], CRT = [];
function tune() {
  for (let t = 1; t <= MAX_TIER; t++) {
    const next = avgXpCost(t + 1);
    XPT[t] = next ? next / (TARGET_BATTLES[t] * AVG_PERF * (1 + WIN_XP) / 2 * (1 + FREE_XP))
      : XPT[t - 1] * 1.3;
    const nextPrice = avgPrice(t + 1);
    const netWanted = nextPrice ? nextPrice / TARGET_BATTLES[t] * 1.05 : 0;
    const service = t === 1 ? 0 : avgServiceCost(t);
    CRT[t] = nextPrice ? (netWanted + service) / (AVG_PERF * (1 + WIN_CR) / 2) : CRT[t - 1] * 1.25;
    // never feel poorer after tiering up: XP and net credits per battle rise at least 10 % per tier
    if (t > 1) {
      XPT[t] = Math.max(XPT[t], XPT[t - 1] * 1.1);
      const minNet = expectedNetCredits(t - 1) * 1.1;
      if (expectedNetCredits(t) < minNet) CRT[t] = (minNet + service) / (AVG_PERF * (1 + WIN_CR) / 2);
    }
  }
}

// ------------------------------------------------------------------ prices
// Standard shells ~ calibre^1.6, premium (gold) shells ×10, HE ×0.9. Tier I shoots for free.
export function shellPrice(def, gunIdx, shellIdx) {
  const g = def.guns[gunIdx] || def.guns[0], s = g.shells[shellIdx];
  if (!s) return 0;
  const base = Math.max(1, Math.round(0.05 * Math.pow(g.cal, 1.6)));
  if (s.gold) return Math.max(5, Math.round(base * 10 / 5) * 5);
  if (def.tier === 1) return 0;
  return s.type === 'HE' ? Math.max(1, Math.round(base * 0.9)) : base;
}
export const consumablePrice = (def, kind) => (def.tier === 1 ? 0 : 200 + 350 * def.tier);
// Full repair (0 hp left): about 1.4 % of the tank's price, nothing at tier I.
export const repairCost = (def, lostFrac) => Math.round((def.tier === 1 ? 0 : Math.max(300, def.price * 0.014)) * Math.min(1, Math.max(0, lostFrac)));
function avgServiceCost(t) {
  const ds = tierDefs(t); if (!ds.length) return 0;
  return avg(ds.map((d) => repairCost(d, 0.7) + 14 * shellPrice(d, 0, 0) + 0.6 * consumablePrice(d, 'repair')));
}

// ------------------------------------------------------------------ rewards
// Performance units: 1.0 = damage equal to one average tank of your tier.
export function perfUnits(s, tier) {
  const hp = refHp(tier);
  const parts = {
    participation: 0.35,
    damage: (s.dmg || 0) / hp,
    assist: 0.5 * (s.assist || 0) / hp,
    kills: 0.25 * (s.kills || 0),
    spotting: 0.12 * (s.spotted || 0),
    capture: 0.4 * Math.min(100, s.capture || 0) / 100,
    defence: 0.3 * Math.min(100, s.defended || 0) / 100,
    survival: s.survived ? 0.2 : 0,
    blocked: 0.1 * (s.blocked || 0) / hp,
  };
  let total = 0; for (const k in parts) total += parts[k];
  return { parts, total };
}

// input: { tankId, gun, result: 1 win | 0 loss | -1 draw ... use won: bool, draw: bool,
//          stats, survived, hpLost (0..1), shellsUsed: [n,...], consumablesUsed: [kind], enemyTier, firstWin }
export function computeRewards(input) {
  const def = TANKS[input.tankId];
  const t = def.tier;
  const s = { ...input.stats, survived: input.survived };
  const perf = perfUnits(s, t);
  // Damage to higher-tier tanks is worth a bit more (and a bit less to lower tiers).
  const tierMul = 1 + 0.1 * Math.max(-2, Math.min(2, (input.enemyTier ?? t) - t));
  const xpRate = XPT[t] * tierMul, crRate = CRT[t] * tierMul;
  const lines = [];
  for (const [k, v] of Object.entries(perf.parts)) if (v > 0) lines.push({ key: k, xp: Math.round(v * xpRate), cr: Math.round(v * crRate) });
  const perfXp = lines.reduce((a, l) => a + l.xp, 0);
  const perfCr = lines.reduce((a, l) => a + l.cr, 0);
  const winXp = input.won ? Math.round(perfXp * (WIN_XP - 1)) : 0;
  const base = perfXp + winXp;
  const firstWin = input.won && input.firstWin ? base * (FIRST_WIN_XP - 1) : 0;
  const total = base + firstWin;
  const free = Math.round(total * FREE_XP);
  const winCr = input.won ? Math.round(perfCr * (WIN_CR - 1)) : 0;
  const gross = perfCr + winCr;
  const g = input.gun ?? 0;
  const ammo = (input.shellsUsed || []).reduce((a, n, i) => a + n * shellPrice(def, g, i), 0);
  const cons = (input.consumablesUsed || []).reduce((a, k) => a + consumablePrice(def, k), 0);
  const repair = repairCost(def, input.hpLost ?? (input.survived ? 0.5 : 1));
  const service = ammo + cons + repair;
  return {
    xp: { lines, perf: perfXp, win: winXp, base, firstWin, total, free },
    credits: { lines, perf: perfCr, win: winCr, gross, repair, ammo, consumables: cons, service, net: gross - service },
    mastery: masteryFor(t, base),
    perf: perf.total,
  };
}

// Expected base XP (including win bonus average) of an average player at tier t.
export const expectedXp = (t) => XPT[t] * AVG_PERF * (1 + WIN_XP) / 2;
export const expectedNetCredits = (t) => CRT[t] * AVG_PERF * (1 + WIN_CR) / 2 - (t === 1 ? 0 : avgServiceCost(t));

// Mastery badge (0 none, 1 = 3rd class, 2 = 2nd class, 3 = 1st class, 4 = Ace Tanker) from base XP.
export const MASTERY_NAMES = ['', '3rd Class', '2nd Class', '1st Class', 'Ace Tanker'];
export const MASTERY_FACTORS = [0, 1.25, 1.7, 2.25, 3.0];
export const masteryThresholds = (t) => MASTERY_FACTORS.map((f) => Math.round(f * expectedXp(t)));
export function masteryFor(t, baseXp) {
  const th = masteryThresholds(t);
  let m = 0; for (let i = 1; i < th.length; i++) if (baseXp >= th[i]) m = i;
  return m;
}

// ------------------------------------------------------------------ research / buy / sell
// XP available to research `id`: the best researched parent's XP plus free XP.
export function researchInfo(p, id) {
  const def = TANKS[id];
  if (!def) return { ok: false, reason: 'unknown' };
  if (isResearched(p, id)) return { ok: false, reason: 'researched', cost: def.xp || 0 };
  const parents = (def.parents || []).filter((q) => isResearched(p, q));
  if (!parents.length) return { ok: false, reason: 'locked', cost: def.xp, parents: def.parents };
  const best = parents.reduce((a, q) => ((p.tanks[q]?.xp || 0) > (p.tanks[a]?.xp || 0) ? q : a), parents[0]);
  const tankXp = p.tanks[best]?.xp || 0;
  const avail = tankXp + p.freeXp;
  return { ok: avail >= def.xp, reason: avail >= def.xp ? null : 'xp', cost: def.xp, from: best, tankXp, freeXp: p.freeXp, avail,
    missing: Math.max(0, def.xp - avail), battles: Math.ceil(Math.max(0, def.xp - avail) / Math.max(1, expectedXp(TANKS[best].tier))) };
}
export function research(p, id) {
  const r = researchInfo(p, id);
  if (!r.ok) return r;
  const fromTank = Math.min(r.tankXp, r.cost);
  tankState(p, r.from).xp -= fromTank;
  p.freeXp -= r.cost - fromTank;
  p.researched.push(id);
  tankState(p, id);
  return { ok: true, spentTankXp: fromTank, spentFreeXp: r.cost - fromTank };
}
export function buyInfo(p, id) {
  const def = TANKS[id];
  if (!def) return { ok: false, reason: 'unknown' };
  if (isOwned(p, id)) return { ok: false, reason: 'owned', cost: def.price };
  if (!isResearched(p, id)) return { ok: false, reason: 'research', cost: def.price };
  return { ok: p.credits >= def.price, reason: p.credits >= def.price ? null : 'credits', cost: def.price, missing: Math.max(0, def.price - p.credits) };
}
export function buy(p, id, { select = true } = {}) {
  const r = buyInfo(p, id);
  if (!r.ok) return r;
  p.credits -= r.cost;
  const ts = tankState(p, id);
  ts.owned = true; ts.bought = Date.now();
  ts.ammo = defaultAmmo(TANKS[id], ts.gun || 0);
  if (select) p.selected = id;
  return { ok: true };
}
export const sellValue = (id) => Math.round((TANKS[id].price || 0) * SELL_FACTOR);
export function sell(p, id) {
  if (!isOwned(p, id)) return { ok: false, reason: 'not owned' };
  if (ownedIds(p).length <= 1) return { ok: false, reason: 'last tank' };
  const v = sellValue(id);
  p.credits += v;
  p.tanks[id].owned = false;
  if (p.selected === id) p.selected = ownedIds(p)[0];
  return { ok: true, credits: v };
}

// Guns: guns[i] (i ≥ 1) needs guns[i-1] and its XP from this tank's XP + free XP.
export function gunInfo(p, id, gi) {
  const def = TANKS[id], ts = p.tanks[id] || { guns: [0], xp: 0 };
  const g = def.guns[gi];
  if (!g) return { ok: false, reason: 'unknown' };
  if (ts.guns.includes(gi)) return { ok: false, reason: 'researched', cost: g.xp || 0 };
  if (!ts.guns.includes(gi - 1)) return { ok: false, reason: 'locked', cost: g.xp || 0 };
  const avail = (ts.xp || 0) + p.freeXp;
  return { ok: avail >= (g.xp || 0), reason: avail >= (g.xp || 0) ? null : 'xp', cost: g.xp || 0, avail };
}
export function researchGun(p, id, gi) {
  const r = gunInfo(p, id, gi);
  if (!r.ok) return r;
  const ts = tankState(p, id);
  const fromTank = Math.min(ts.xp, r.cost);
  ts.xp -= fromTank; p.freeXp -= r.cost - fromTank;
  ts.guns.push(gi);
  return { ok: true };
}
export function mountGun(p, id, gi) {
  const ts = tankState(p, id);
  if (!ts.guns.includes(gi)) return false;
  if (ts.gun !== gi) { ts.gun = gi; ts.ammo = defaultAmmo(TANKS[id], gi); }
  return true;
}
// Set the ammo loadout, clamped to capacity (later entries shrink first).
export function setAmmo(p, id, ammo) {
  const def = TANKS[id], ts = tankState(p, id), cap = def.guns[ts.gun].ammo;
  const a = ammo.map((n) => Math.max(0, Math.round(n || 0)));
  let over = a.reduce((x, y) => x + y, 0) - cap;
  for (let i = a.length - 1; i >= 0 && over > 0; i--) { const d = Math.min(a[i], over); a[i] -= d; over -= d; }
  ts.ammo = a; return a;
}
export function setConsumables(p, id, list) {
  tankState(p, id).consumables = CONSUMABLES.filter((k) => list.includes(k));
}
// Cost to fill the loadout if every shell were fired (shown in the loadout panel).
export const loadoutCost = (def, gi, ammo) => ammo.reduce((a, n, i) => a + n * shellPrice(def, gi, i), 0);

// An elite tank has every gun and every child tank researched.
export function isElite(p, id) {
  const def = TANKS[id], ts = p.tanks[id];
  if (!ts) return false;
  if (def.guns.some((_, i) => !ts.guns.includes(i))) return false;
  return TANK_LIST.filter((d) => (d.parents || []).includes(id)).every((d) => isResearched(p, d.id));
}

tune();
export const _rates = { XPT, CRT };
