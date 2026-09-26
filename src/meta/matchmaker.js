// Matchmaker: builds createBattle() options for the player's tank: two mirrored bot teams
// (same tier and class make-up on both sides), a WoT-like tier template, bot skill spread,
// fun names and a random map. Deterministic for a given opts.seed.
//
// buildBattle(profile, tankId, { size: 15|7, seed, mapId, mode }) → {
//   mapId, map: null,            // INTEGRATION: battle.map = loadMap(battle.mapId) (or await withMap(battle))
//   seed, timeLimit, mode, teams: [[Entry], [Entry]],
//   meta: { mapId, mapName, blurb, theme, size, template, tiers: [lo, hi], playerTeam, playerIndex, avgSkill: [a, b] }
// }
import { TANKS, TANK_LIST, MAPS, MAX_TIER, CLASS_LABEL } from './roster.js';
import { defaultAmmo, crewSkill, tankState, CONSUMABLES } from './profile.js';
import { pickNames } from './names.js';
import { makeRng } from './rng.js';

// Tier templates [top, mid, bottom] counts per team; weights are the chance of each template.
const TEMPLATES = {
  15: [{ w: 0.45, c: [3, 5, 7] }, { w: 0.35, c: [5, 10] }, { w: 0.2, c: [15] }],
  7: [{ w: 0.45, c: [2, 2, 3] }, { w: 0.35, c: [3, 4] }, { w: 0.2, c: [7] }],
};
const CLASS_W = { medium: 0.36, heavy: 0.22, td: 0.24, light: 0.18 };
const CLASS_CAP = { 15: { light: 3, heavy: 5, td: 5, medium: 8 }, 7: { light: 2, heavy: 3, td: 2, medium: 4 } };
export const ROLE = { light: 'scout', medium: 'flex', heavy: 'brawl', td: 'sniper' };

const weighted = (rng, entries) => {
  const tot = entries.reduce((a, [, w]) => a + w, 0);
  let r = rng() * tot;
  for (const [k, w] of entries) if ((r -= w) <= 0) return k;
  return entries[entries.length - 1][0];
};

// Tier list for one team (player's tier T included). Low tiers get protected matchmaking.
export function tierSlots(rng, T, size) {
  const tmpl = TEMPLATES[size] || TEMPLATES[15];
  const t = weighted(rng, tmpl.map((x) => [x, x.w]));
  const n = t.c.length;
  // the player's tank sits in one of the template's tier bands; its top tier is T + band
  const maxUp = T <= 2 ? Math.min(1, n - 1) : n - 1;
  let band = rng.int(maxUp + 1);
  let top = T + band;
  while (top > MAX_TIER) { top--; band--; }
  const tiers = [];
  t.c.forEach((cnt, i) => { for (let k = 0; k < cnt; k++) tiers.push(Math.max(1, top - i)); });
  // guarantee the player's tier appears (clamping at tier I or VII can shift bands)
  if (!tiers.includes(T)) tiers[tiers.length - 1] = T;
  return { tiers, template: t.c.join('/'), top };
}

function classesFor(rng, tiers, playerIdx, playerCls, size) {
  const cap = { ...(CLASS_CAP[size] || CLASS_CAP[15]) };
  const counts = { light: 0, medium: 0, heavy: 0, td: 0 };
  const out = new Array(tiers.length);
  out[playerIdx] = playerCls; counts[playerCls]++;
  for (let i = 0; i < tiers.length; i++) {
    if (i === playerIdx) continue;
    const exists = Object.entries(CLASS_W).filter(([c]) => TANK_LIST.some((d) => d.tier === tiers[i] && d.cls === c));
    const avail = exists.filter(([c]) => counts[c] < cap[c]);
    const c = avail.length ? weighted(rng, avail) : exists.length ? weighted(rng, exists) : 'medium';
    out[i] = c; counts[c]++;
  }
  return out;
}

function pickDef(rng, tier, cls, used) {
  let c = TANK_LIST.filter((d) => d.tier === tier && d.cls === cls);
  if (!c.length) c = TANK_LIST.filter((d) => d.tier === tier);
  if (!c.length) c = TANK_LIST.slice().sort((a, b) => Math.abs(a.tier - tier) - Math.abs(b.tier - tier)).slice(0, 3);
  const fresh = c.filter((d) => !used.has(d.id));
  const d = rng.pick(fresh.length ? fresh : c);
  used.add(d.id);
  return d;
}

// Bot skill: mostly average, some potatoes and some unicums.
const skillRoll = (rng) => Math.max(0.08, Math.min(0.97, 0.52 + (rng() + rng() + rng() - 1.5) * 0.42));

function botEntry(rng, def, name, skill) {
  const gun = def.guns.length > 1 && rng() < 0.25 + 0.65 * skill ? def.guns.length - 1 : 0;
  const ammo = defaultAmmo(def, gun);
  const gi = def.guns[gun].shells.findIndex((s) => s.gold);
  if (gi >= 0 && skill > 0.65) { const std = ammo.indexOf(Math.max(...ammo)); const k = Math.round(ammo[std] * 0.2); ammo[std] -= k; ammo[gi] += k; }
  return { def, gun, name, player: false, bot: { skill: +skill.toFixed(2), role: ROLE[def.cls] }, ammo,
    consumables: CONSUMABLES.slice(), crewSkill: +(0.55 + 0.42 * skill).toFixed(2) };
}

export function buildBattle(profile, tankId, opts = {}) {
  const def = TANKS[tankId];
  if (!def) throw new Error('buildBattle: unknown tank ' + tankId);
  const size = opts.size === 7 ? 7 : 15;
  const seed = (opts.seed ?? Math.floor(Math.random() * 2 ** 31)) >>> 0;
  const rng = makeRng(seed);
  // map: random, but avoid repeating the last one
  const last = profile?.history?.[0]?.mapId;
  const pool = MAPS.length > 1 ? MAPS.filter((m) => m.id !== last) : MAPS;
  const map = (opts.mapId && MAPS.find((m) => m.id === opts.mapId)) || rng.pick(pool);

  const { tiers, template } = tierSlots(rng, def.tier, size);
  const playerIdx = tiers.indexOf(def.tier);
  const classes = classesFor(rng, tiers, playerIdx, def.cls, size);
  const playerTeam = opts.playerTeam ?? rng.int(2);
  const names = pickNames(rng, size * 2 - 1, [profile?.name]);
  // mirrored skills: team B gets team A's skills shuffled with a little noise
  const skillsA = tiers.map(() => skillRoll(rng));
  const skillsB = rng.shuffle(skillsA.map((s) => Math.max(0.05, Math.min(0.98, s + (rng() - 0.5) * 0.08))));
  const ts = profile ? tankState(profile, tankId) : null;

  const teams = [[], []];
  let ni = 0;
  for (let team = 0; team < 2; team++) {
    const used = new Set([tankId]);
    const skills = team === playerTeam ? skillsA : skillsB;
    for (let i = 0; i < tiers.length; i++) {
      if (team === playerTeam && i === playerIdx) {
        teams[team].push({ def, gun: ts?.gun ?? 0, name: profile?.name || 'Player', player: true, bot: null,
          ammo: (ts?.ammo || defaultAmmo(def, ts?.gun ?? 0)).slice(), consumables: (ts?.consumables || CONSUMABLES).slice(),
          crewSkill: profile ? +crewSkill(profile, tankId).toFixed(2) : 0.75 });
        continue;
      }
      const d = pickDef(rng, tiers[i], classes[i], used);
      teams[team].push(botEntry(rng, d, names[ni++], skills[i]));
    }
    // team list order: tier desc, then class, then name
    const order = { heavy: 0, medium: 1, td: 2, light: 3 };
    teams[team].sort((a, b) => b.def.tier - a.def.tier || order[a.def.cls] - order[b.def.cls] || a.name.localeCompare(b.name));
  }
  const avgSkill = teams.map((tm) => +(tm.filter((e) => e.bot).reduce((a, e) => a + e.bot.skill, 0) / Math.max(1, tm.filter((e) => e.bot).length)).toFixed(3));
  return {
    mapId: map.id, map: null, seed, timeLimit: opts.timeLimit ?? 900, mode: opts.mode || 'standard', teams,
    meta: { mapId: map.id, mapName: map.name, blurb: map.blurb, theme: map.theme, size, template,
      tiers: [Math.min(...tiers), Math.max(...tiers)], playerTeam, playerIndex: teams[playerTeam].findIndex((e) => e.player),
      avgSkill, tankId, modeLabel: size === 7 ? 'Skirmish 7v7' : 'Standard Battle' },
  };
}

// Convenience for INTEGRATION: loads the MapData into battle.map (dynamic import keeps node tests light).
export async function withMap(battle) {
  const { loadMap } = await import('../sim/map/index.js');
  battle.map = loadMap(battle.mapId); // maps are authored at their own seed
  return battle;
}

export const mapMeta = (id) => MAPS.find((m) => m.id === id) || null;
export { CLASS_LABEL };
