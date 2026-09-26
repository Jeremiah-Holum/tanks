// Post-battle: summarize(world, playerTankId, profile, battle?) → report, then applyReport(profile, report).
// `battle` (the buildBattle() result) is optional; it gives exact starting ammo so the ammo bill
// is exact, otherwise shells used are estimated from stats.shots as standard rounds.
import { TANKS, MAPS, NATIONS } from './roster.js';
import { computeRewards, perfUnits, masteryFor, refHp, MASTERY_NAMES } from './economy.js';
import { tankState, HISTORY_MAX } from './profile.js';

// Medals (id → name, description, test(ctx)). ctx = { me, s, all, allies, enemies, won, def }.
export const MEDALS = [
  { id: 'topgun', name: 'Top Gun', desc: 'Destroy 6 or more enemy vehicles.', test: (c) => c.s.kills >= 6 },
  { id: 'highcal', name: 'High Caliber', desc: 'Deal the most damage in the battle, at least 20 % of the enemy team\'s hit points.',
    test: (c) => c.s.dmg > 0 && c.s.dmg >= Math.max(...c.all.map((t) => t.stats.dmg)) && c.s.dmg >= 0.2 * c.enemies.reduce((a, t) => a + (t.life > 1 ? 0 : t.maxHp), 0) },
  { id: 'sniper', name: 'Sniper', desc: 'At least 85 % hits and 10 shots, dealing 1.5× your HP in damage.',
    test: (c) => c.s.shots >= 10 && c.s.hits / c.s.shots >= 0.85 && c.s.dmg >= 1.5 * c.me.maxHp },
  { id: 'steelwall', name: 'Steel Wall', desc: 'Block damage worth 1.5× your HP and receive at least 8 hits.',
    test: (c) => c.s.blocked >= 1.5 * c.me.maxHp && (c.s.hitsReceived ?? 8) >= 8 },
  { id: 'scout', name: 'Scout', desc: 'Spot the most enemies in the battle (at least 6).',
    test: (c) => c.s.spotted >= 6 && c.s.spotted >= Math.max(...c.allies.map((t) => t.stats.spotted || 0)) },
  { id: 'confederate', name: 'Confederate', desc: 'Assist with damage worth 2× your HP.', test: (c) => c.s.assist >= 2 * c.me.maxHp },
  { id: 'invader', name: 'Invader', desc: 'Earn 80 or more capture points in a victory.', test: (c) => c.won && c.s.capture >= 80 },
  { id: 'defender', name: 'Defender', desc: 'Reset 70 or more capture points.', test: (c) => c.s.defended >= 70 },
  { id: 'kolobanov', name: "Kolobanov's Medal", desc: 'Win as the last tank of your team against 5 or more enemies.',
    test: (c) => c.won && c.me.alive && c.allies.filter((t) => t.alive).length === 1 && c.s.kills >= 5 },
  { id: 'pool', name: "Pool's Medal", desc: 'Destroy 10 or more enemy vehicles.', test: (c) => c.s.kills >= 10 },
  { id: 'survivor', name: 'Tough Nut', desc: 'Survive after receiving damage worth your full HP (repairs included).',
    test: (c) => c.me.alive && c.s.received >= c.me.maxHp * 0.9 },
  { id: 'spearhead', name: 'Spearhead', desc: 'First blood: deal the first kill of the battle.', test: (c) => !!c.firstBlood },
];
export const MEDAL_BY_ID = Object.fromEntries(MEDALS.map((m) => [m.id, m]));
export { MASTERY_NAMES };

const today = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
const gunIndex = (t) => { if (t.gunIndex != null) return t.gunIndex; const i = t.def.guns.indexOf(t.gunDef); return i >= 0 ? i : (t.gun ?? 0); };

// playerTankIds: the player's tank id, or every tank the player drove (lineup respawns) in order.
// Each tank earns its own XP, credits, service bill, mastery and medals from its own stats; the
// report's top-level stats / xp / credits / medals are the totals, and report.tanks[] the breakdown.
export function summarize(world, playerTankIds, profile, battle = null) {
  const ids = (Array.isArray(playerTankIds) ? playerTankIds : [playerTankIds]).filter((id) => world.tanks.some((t) => t.id === id));
  let mine = ids.map((id) => world.tanks.find((t) => t.id === id));
  if (!mine.length) mine = world.tanks.filter((t) => t.player).slice(0, 1);
  if (!mine.length) throw new Error('summarize: player tank not found');
  const me = mine[mine.length - 1], team = me.team;   // the tank that finished the battle
  const winner = world.result ? world.result.winner : -1;
  const won = winner === team, draw = winner === -1 || winner == null;
  const allies = world.tanks.filter((t) => t.team === team), enemies = world.tanks.filter((t) => t.team !== team);
  const enemyTier = enemies.reduce((a, t) => a + t.def.tier, 0) / Math.max(1, enemies.length);
  const firstWin = won && profile && profile.lastWinDay !== today();
  // starting loadouts: the player's battle entries (first tank + reserve)
  const entries = [];
  if (battle) { for (const tm of battle.teams) for (const e of tm) if (e.player) entries.push(e); for (const r of battle.reserve || []) entries.push(...r); }
  const used = new Set();
  const part = (t) => {
    const def = t.def;
    const s = { dmg: 0, assist: 0, blocked: 0, kills: 0, shots: 0, hits: 0, pens: 0, received: 0, spotted: 0, capture: 0, defended: 0, ...t.stats };
    const gi = gunIndex(t);
    const entry = entries.find((e) => !used.has(e) && e.def && e.def.id === def.id);
    if (entry) used.add(entry);
    const startAmmo = entry ? entry.ammo : null;
    const shellsUsed = startAmmo && t.ammo ? startAmmo.map((n, i) => Math.max(0, n - (t.ammo[i] ?? n))) : [s.shots || 0];
    const consumablesUsed = (t.consumables || []).flatMap((c) => new Array(c.used ?? (c.ready === false ? 1 : 0)).fill(c.kind));
    const hpLost = 1 - Math.max(0, t.hp) / t.maxHp;
    const rew = computeRewards({ tankId: def.id, gun: gi, won, stats: s, survived: t.alive, hpLost, shellsUsed, consumablesUsed, enemyTier, firstWin });
    const firstBlood = world.firstKill ? world.firstKill === t.id : false;
    const ctx = { me: t, s, all: world.tanks, allies, enemies, won, def, firstBlood };
    const medals = MEDALS.filter((m) => { try { return m.test(ctx); } catch { return false; } }).map((m) => ({ id: m.id, name: m.name, desc: m.desc }));
    const prevMastery = profile?.tanks[def.id]?.mastery || 0;
    let killedBy = null;
    if (!t.alive) { const k = world.tanks.find((o) => o.id === t.killedBy); killedBy = k ? { name: k.name, short: k.def.short || k.def.name, cause: t.deathCause } : { name: null, cause: t.deathCause }; }
    return {
      tankId: def.id, tankName: def.name, short: def.short || def.name, tier: def.tier, cls: def.cls, nation: def.nation, gun: gi,
      survived: !!t.alive, hpLeft: Math.max(0, Math.round(t.hp)), maxHp: t.maxHp,
      stats: { ...s, dmg: Math.round(s.dmg), assist: Math.round(s.assist), blocked: Math.round(s.blocked), received: Math.round(s.received) },
      shellsUsed, consumablesUsed, xp: rew.xp, credits: rew.credits, freeXp: rew.xp.free,
      mastery: rew.mastery, masteryName: MASTERY_NAMES[rew.mastery], masteryNew: rew.mastery > prevMastery, medals, killedBy,
    };
  };
  const parts = mine.map(part);
  const first = parts[0], last = parts[parts.length - 1];
  const xpRow = new Map(mine.map((t, i) => [t.id, parts[i].xp.base]));

  const row = (t) => {
    const st = t.stats || {};
    const xp = xpRow.has(t.id) ? xpRow.get(t.id) : Math.round(perfUnits({ ...st, survived: t.alive }, t.def.tier).total * (refHp(t.def.tier) * 0.9) * (t.team === winner ? 1.5 : 1));
    return { id: t.id, name: t.name, tankId: t.def.id, short: t.def.short || t.def.name, tier: t.def.tier, cls: t.def.cls,
      nation: t.def.nation, player: !!t.player, alive: !!t.alive, hp: Math.max(0, Math.round(t.hp)), maxHp: t.maxHp,
      dmg: Math.round(st.dmg || 0), kills: st.kills || 0, assist: Math.round(st.assist || 0), spotted: st.spotted || 0, xp };
  };
  const byXp = (a, b) => b.xp - a.xp || b.dmg - a.dmg;
  // one row per slot (a player or bot with its respawns): the last tank it drove, stats and XP summed
  const slotRows = (list) => {
    const g = new Map();
    for (const t of list) { const k = t.slot ?? t.id; if (!g.has(k)) g.set(k, []); g.get(k).push(t); }
    return [...g.values()].map((ts) => {
      const rs = ts.map(row), r = rs[rs.length - 1];
      if (rs.length > 1) for (const k of ['dmg', 'kills', 'assist', 'spotted', 'xp']) r[k] = rs.reduce((a, x) => a + x[k], 0);
      r.deploys = rs.length;
      return r;
    });
  };
  const teamRows = [slotRows(allies).sort(byXp), slotRows(enemies).sort(byXp)];
  const mapName = world.map?.name || MAPS.find((m) => m.id === (world.map?.id || battle?.mapId))?.name || 'Unknown';
  const mineIds = new Set(mine.map((t) => t.id));
  return {
    id: `${Date.now().toString(36)}-${(world.seed ?? 0).toString(36)}`, time: Date.now(), applied: false,
    tankId: first.tankId, tankName: first.tankName, tier: first.tier, cls: first.cls, nation: first.nation, nationLabel: NATIONS[first.nation]?.label,
    gun: first.gun, mapId: world.map?.id || battle?.mapId, mapName, mode: world.mode || 'standard',
    size: teamRows[0].length,   // slots: respawned tanks don't make the team bigger
    result: won ? 'victory' : draw ? 'draw' : 'defeat', reason: world.result?.reason || (draw ? 'time' : ''),
    duration: Math.round(world.time || 0), survived: last.survived, hpLeft: last.hpLeft, maxHp: last.maxHp,
    stats: parts.length === 1 ? first.stats : sumStats(parts.map((p) => p.stats)),
    shellsUsed: first.shellsUsed, consumablesUsed: parts.flatMap((p) => p.consumablesUsed), enemyTier: +enemyTier.toFixed(2), firstWin,
    xp: parts.length === 1 ? first.xp : sumXp(parts.map((p) => p.xp)),
    credits: parts.length === 1 ? first.credits : sumCredits(parts.map((p) => p.credits)),
    freeXp: parts.reduce((a, p) => a + p.freeXp, 0),
    mastery: first.mastery, masteryName: first.masteryName, masteryNew: first.masteryNew,
    medals: parts.flatMap((p) => p.medals), teams: teamRows, playerTeam: team, tanks: parts,
    kills: enemies.filter((t) => mineIds.has(t.killedBy)).map((t) => ({ name: t.name, short: t.def.short || t.def.name, tier: t.def.tier, cls: t.def.cls })),
    killedBy: last.killedBy,
    alive: [allies.filter((t) => t.alive).length, enemies.filter((t) => t.alive).length],
  };
}

const STAT_KEYS = ['dmg', 'assist', 'blocked', 'kills', 'shots', 'hits', 'pens', 'received', 'spotted', 'capture', 'defended', 'hitsReceived'];
function sumStats(list) {
  const out = { ...list[0] };
  for (const k of STAT_KEYS) if (list.some((s) => s[k] != null)) out[k] = list.reduce((a, s) => a + (s[k] || 0), 0);
  return out;
}
function mergeLines(ls) {
  const m = new Map();
  for (const l of ls.flat()) { const x = m.get(l.key) || { key: l.key, xp: 0, cr: 0 }; x.xp += l.xp; x.cr += l.cr; m.set(l.key, x); }
  return [...m.values()];
}
const sumK = (list, keys) => Object.fromEntries(keys.map((k) => [k, list.reduce((a, o) => a + (o[k] || 0), 0)]));
const sumXp = (list) => ({ lines: mergeLines(list.map((x) => x.lines)), ...sumK(list, ['perf', 'win', 'base', 'firstWin', 'total', 'free']) });
const sumCredits = (list) => ({ lines: mergeLines(list.map((x) => x.lines)), ...sumK(list, ['perf', 'win', 'gross', 'repair', 'ammo', 'consumables', 'service', 'net']) });

// Apply a report to the profile once (report.applied guards against double application).
// Every tank in report.tanks gets its own XP, crew XP, battle, win, damage, kills and mastery;
// the service record counts one battle with the summed stats.
export function applyReport(p, r) {
  if (r.applied) return p;
  const won = r.result === 'victory', draw = r.result === 'draw';
  const parts = r.tanks && r.tanks.length ? r.tanks : [{ tankId: r.tankId, xp: r.xp, stats: r.stats, mastery: r.mastery }];
  for (const x of parts) {
    const ts = tankState(p, x.tankId);
    ts.xp += x.xp.total; ts.crewXp += x.xp.total; ts.battles++; if (won) ts.wins++;
    ts.dmg = (ts.dmg || 0) + x.stats.dmg; ts.kills = (ts.kills || 0) + x.stats.kills;
    ts.mastery = Math.max(ts.mastery || 0, x.mastery);
  }
  p.freeXp += r.xp.free;
  // The quartermaster never lets the bill take you below zero.
  const before = p.credits;
  p.credits = Math.max(0, p.credits + r.credits.net);
  r.credits.applied = p.credits - before;
  const st = p.stats, s = r.stats;
  st.battles++; if (won) st.wins++; else if (draw) st.draws++; else st.losses++;
  if (r.survived) st.survived++;
  for (const k of ['kills', 'dmg', 'assist', 'blocked', 'received', 'shots', 'hits', 'pens', 'spotted', 'capture', 'defended']) st[k] += s[k] || 0;
  st.xp += r.xp.total; st.credits += r.credits.net;
  st.maxDmg = Math.max(st.maxDmg, s.dmg); st.maxKills = Math.max(st.maxKills, s.kills); st.maxXp = Math.max(st.maxXp, r.xp.total);
  for (const m of r.medals) st.medals[m.id] = (st.medals[m.id] || 0) + 1;
  if (won) p.lastWinDay = today(r.time);
  p.battleSeq = (p.battleSeq || 0) + 1;
  p.history.unshift({ id: r.id, time: r.time, tankId: r.tankId, tankIds: parts.map((x) => x.tankId), mapId: r.mapId, mapName: r.mapName, result: r.result,
    dmg: s.dmg, kills: s.kills, xp: r.xp.total, credits: r.credits.net, mastery: r.mastery, medals: r.medals.map((m) => m.id), survived: r.survived });
  p.history.length = Math.min(p.history.length, HISTORY_MAX);
  r.applied = true;
  return p;
}
