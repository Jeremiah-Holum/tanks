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
    test: (c) => c.s.dmg > 0 && c.s.dmg >= Math.max(...c.all.map((t) => t.stats.dmg)) && c.s.dmg >= 0.2 * c.enemies.reduce((a, t) => a + t.maxHp, 0) },
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

export function summarize(world, playerTankId, profile, battle = null) {
  const me = world.tanks.find((t) => t.id === playerTankId) || world.tanks.find((t) => t.player);
  if (!me) throw new Error('summarize: player tank not found');
  const def = me.def, team = me.team;
  const winner = world.result ? world.result.winner : -1;
  const won = winner === team, draw = winner === -1 || winner == null;
  const allies = world.tanks.filter((t) => t.team === team), enemies = world.tanks.filter((t) => t.team !== team);
  const s = { dmg: 0, assist: 0, blocked: 0, kills: 0, shots: 0, hits: 0, pens: 0, received: 0, spotted: 0, capture: 0, defended: 0, ...me.stats };
  const gi = gunIndex(me);
  // shells used per type
  let startAmmo = null;
  if (battle) for (const tm of battle.teams) for (const e of tm) if (e.player) startAmmo = e.ammo;
  const shellsUsed = startAmmo && me.ammo ? startAmmo.map((n, i) => Math.max(0, n - (me.ammo[i] ?? n))) : [s.shots || 0];
  const consumablesUsed = (me.consumables || []).flatMap((c) => new Array(c.used ?? (c.ready === false ? 1 : 0)).fill(c.kind));
  const enemyTier = enemies.reduce((a, t) => a + t.def.tier, 0) / Math.max(1, enemies.length);
  const firstWin = won && profile && profile.lastWinDay !== today();
  const hpLost = 1 - Math.max(0, me.hp) / me.maxHp;
  const rew = computeRewards({ tankId: def.id, gun: gi, won, stats: s, survived: me.alive, hpLost, shellsUsed, consumablesUsed, enemyTier, firstWin });

  const firstBlood = world.firstKill ? world.firstKill === me.id : false;
  const ctx = { me, s, all: world.tanks, allies, enemies, won, def, firstBlood };
  const medals = MEDALS.filter((m) => { try { return m.test(ctx); } catch { return false; } }).map((m) => ({ id: m.id, name: m.name, desc: m.desc }));
  const prevMastery = profile?.tanks[def.id]?.mastery || 0;

  const row = (t) => {
    const st = t.stats || {};
    const xp = t === me ? rew.xp.base : Math.round(perfUnits({ ...st, survived: t.alive }, t.def.tier).total * (refHp(t.def.tier) * 0.9) * (t.team === winner ? 1.5 : 1));
    return { id: t.id, name: t.name, tankId: t.def.id, short: t.def.short || t.def.name, tier: t.def.tier, cls: t.def.cls,
      nation: t.def.nation, player: !!t.player, alive: !!t.alive, hp: Math.max(0, Math.round(t.hp)), maxHp: t.maxHp,
      dmg: Math.round(st.dmg || 0), kills: st.kills || 0, assist: Math.round(st.assist || 0), spotted: st.spotted || 0, xp };
  };
  const byXp = (a, b) => b.xp - a.xp || b.dmg - a.dmg;
  const teamRows = [allies.map(row).sort(byXp), enemies.map(row).sort(byXp)];
  const mapName = world.map?.name || MAPS.find((m) => m.id === (world.map?.id || battle?.mapId))?.name || 'Unknown';
  return {
    id: `${Date.now().toString(36)}-${(world.seed ?? 0).toString(36)}`, time: Date.now(), applied: false,
    tankId: def.id, tankName: def.name, tier: def.tier, cls: def.cls, nation: def.nation, nationLabel: NATIONS[def.nation]?.label,
    gun: gi, mapId: world.map?.id || battle?.mapId, mapName, mode: world.mode || 'standard', size: allies.length,
    result: won ? 'victory' : draw ? 'draw' : 'defeat', reason: world.result?.reason || (draw ? 'time' : ''),
    duration: Math.round(world.time || 0), survived: !!me.alive, hpLeft: Math.max(0, Math.round(me.hp)), maxHp: me.maxHp,
    stats: { ...s, dmg: Math.round(s.dmg), assist: Math.round(s.assist), blocked: Math.round(s.blocked), received: Math.round(s.received) },
    shellsUsed, consumablesUsed, enemyTier: +enemyTier.toFixed(2), firstWin,
    xp: rew.xp, credits: rew.credits, freeXp: rew.xp.free,
    mastery: rew.mastery, masteryName: MASTERY_NAMES[rew.mastery], masteryNew: rew.mastery > prevMastery,
    medals, teams: teamRows, playerTeam: team,
    kills: enemies.filter((t) => t.killedBy === me.id).map((t) => ({ name: t.name, short: t.def.short || t.def.name, tier: t.def.tier, cls: t.def.cls })),
    killedBy: me.alive ? null : (() => { const k = world.tanks.find((t) => t.id === me.killedBy); return k ? { name: k.name, short: k.def.short || k.def.name, cause: me.deathCause } : { name: null, cause: me.deathCause }; })(),
    alive: [allies.filter((t) => t.alive).length, enemies.filter((t) => t.alive).length],
  };
}

// Apply a report to the profile once (report.applied guards against double application).
export function applyReport(p, r) {
  if (r.applied) return p;
  const ts = tankState(p, r.tankId);
  const won = r.result === 'victory', draw = r.result === 'draw';
  ts.xp += r.xp.total; ts.crewXp += r.xp.total; ts.battles++; if (won) ts.wins++;
  ts.dmg = (ts.dmg || 0) + r.stats.dmg; ts.kills = (ts.kills || 0) + r.stats.kills;
  ts.mastery = Math.max(ts.mastery || 0, r.mastery);
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
  p.history.unshift({ id: r.id, time: r.time, tankId: r.tankId, mapId: r.mapId, mapName: r.mapName, result: r.result,
    dmg: s.dmg, kills: s.kills, xp: r.xp.total, credits: r.credits.net, mastery: r.mastery, medals: r.medals.map((m) => m.id), survived: r.survived });
  p.history.length = Math.min(p.history.length, HISTORY_MAX);
  r.applied = true;
  return p;
}
