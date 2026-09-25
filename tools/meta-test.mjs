// node tools/meta-test.mjs [--quiet]
// Deterministic tests for src/meta: starting profile, research → buy → select, reward sanity,
// service costs vs. a tier-I player, matchmaker validity, and a progression simulation that
// counts battles to tier V and VII along each line for an "average player".
import { TANKS, TANK_LIST, NATIONS, MAPS, STUB_TANKS, STUB_MAPS, ROMAN, MAX_TIER, childrenOf } from '../src/meta/roster.js';
import { newProfile, migrate, ownedIds, selectTank, START_CREDITS, defaultAmmo } from '../src/meta/profile.js';
import * as eco from '../src/meta/economy.js';
import { buildBattle } from '../src/meta/matchmaker.js';
import { summarize, applyReport } from '../src/meta/results.js';
import { makeRng } from '../src/meta/rng.js';

const quiet = process.argv.includes('--quiet');
let fails = 0, passes = 0;
const ok = (cond, msg) => { if (cond) passes++; else { fails++; console.log('  FAIL', msg); } };
const log = (...a) => { if (!quiet) console.log(...a); };
log(`roster: ${TANK_LIST.length} tanks${STUB_TANKS ? ' (STUB)' : ''}, maps: ${MAPS.length}${STUB_MAPS ? ' (STUB)' : ''}`);

// ---------------------------------------------------------------- fake world for summarize()
function fakeWorld(battle, perf, rng) {
  const tanks = [];
  let id = 1;
  battle.teams.forEach((tm, team) => tm.forEach((e) => {
    const g = e.def.guns[e.gun];
    tanks.push({ id: id++, team, def: e.def, gunDef: g, name: e.name, player: e.player, alive: true, hp: e.def.hp, maxHp: e.def.hp,
      ammo: e.ammo.slice(), consumables: e.consumables.map((k) => ({ kind: k, ready: true, cd: 0 })),
      stats: { dmg: 0, assist: 0, blocked: 0, kills: 0, shots: 0, hits: 0, pens: 0, received: 0, spotted: 0, capture: 0, defended: 0 } });
  }));
  const me = tanks.find((t) => t.player);
  const others = tanks.filter((t) => !t.player);
  for (const t of others) { t.stats.dmg = Math.round(t.maxHp * rng() * 1.6); t.stats.kills = rng() < 0.5 ? 1 : 0; t.alive = rng() < 0.35; if (!t.alive) t.hp = 0; }
  Object.assign(me.stats, perf.stats);
  me.alive = perf.survived; me.hp = perf.survived ? Math.round(me.maxHp * 0.4) : 0;
  // shots fired: standard shells
  const std = me.ammo.indexOf(Math.max(...me.ammo));
  me.ammo[std] -= me.stats.shots;
  if (perf.usedRepair) me.consumables[0].ready = false;
  return { time: 540, seed: battle.seed, map: { id: battle.mapId, name: battle.meta.mapName }, tanks, result: { winner: perf.won ? me.team : perf.draw ? -1 : 1 - me.team, reason: 'destroyed' } };
}
function avgPerf(def, rng, won, scale = 1) {
  const hp = eco.refHp(def.tier);
  const shellDmg = def.guns[0].shells[0].dmg;
  const dmg = Math.round(hp * scale * (0.3 + rng() * 1.4));
  const hits = Math.max(1, Math.round(dmg / shellDmg));
  return { won, stats: { dmg, assist: Math.round(hp * 0.4 * scale * rng() * 2), blocked: Math.round(hp * 0.3 * rng()), kills: rng() < 0.55 * scale ? 1 + (rng() < 0.3 ? 1 : 0) : 0,
    shots: Math.round(hits * 1.4), hits, pens: hits, received: Math.round(def.hp * 0.7), spotted: rng() < 0.6 ? 1 + (rng() < 0.3 ? 1 : 0) : 0, capture: 0, defended: rng() < 0.1 ? 30 : 0 },
    survived: rng() < 0.3, usedRepair: rng() < 0.5 };
}

// ---------------------------------------------------------------- 1. starting profile
{
  const p = newProfile('Tester');
  const own = ownedIds(p);
  ok(p.credits === START_CREDITS && p.credits === 20000, 'starts with 20,000 credits');
  ok(own.length === Object.keys(NATIONS).length && own.every((id) => TANKS[id].tier === 1), 'owns the tier-I starters: ' + own.join(','));
  ok(own.every((id) => p.researched.includes(id)), 'starters researched');
  ok(own.includes(p.selected), 'a starter is selected');
  ok(p.freeXp === 0 && p.gold === 0, 'no free XP / gold');
  const m = migrate(JSON.parse(JSON.stringify(p)));
  ok(JSON.stringify(m.tanks) === JSON.stringify(p.tanks), 'migrate() round trip');
  ok(migrate(null).credits === 20000 && migrate({ v: 99 }).credits === 20000, 'migrate() of junk gives a fresh profile');
}

// ---------------------------------------------------------------- 2. research → buy → select
{
  const p = newProfile('Tester');
  const start = p.selected, child = childrenOf(start)[0];
  ok(!!child, 'starter has a child in the tree');
  let r = eco.research(p, child.id);
  ok(!r.ok && r.reason === 'xp', 'cannot research without XP');
  p.tanks[start].xp = child.xp + 100;
  ok(eco.buy(p, child.id).reason === 'research', 'cannot buy before research');
  r = eco.research(p, child.id);
  ok(r.ok && p.researched.includes(child.id) && p.tanks[start].xp === 100, 'research spends parent XP');
  p.credits = child.price - 1;
  ok(eco.buy(p, child.id).reason === 'credits', 'cannot buy without credits');
  p.credits = child.price + 500;
  ok(eco.buy(p, child.id).ok && p.credits === 500 && ownedIds(p).includes(child.id), 'buy spends credits');
  ok(p.selected === child.id && selectTank(p, start) && p.selected === start, 'select works');
  ok(!selectTank(p, 'nope'), 'cannot select an unknown tank');
  // free XP top-up
  const grand = childrenOf(child.id)[0];
  if (grand) {
    p.tanks[child.id].xp = 10; p.freeXp = grand.xp;
    r = eco.research(p, grand.id);
    ok(r.ok && p.tanks[child.id].xp === 0 && p.freeXp === 10, 'research uses tank XP first, then free XP');
  }
  // gun research
  const gd = TANK_LIST.find((d) => d.guns.length > 1);
  if (gd) {
    p.tanks[gd.id] = { ...p.tanks[start], owned: true, xp: gd.guns[1].xp, guns: [0], gun: 0, ammo: defaultAmmo(gd, 0) }; p.freeXp = 0;
    ok(eco.researchGun(p, gd.id, 1).ok && p.tanks[gd.id].guns.includes(1), 'gun research');
    ok(eco.mountGun(p, gd.id, 1) && p.tanks[gd.id].gun === 1, 'mount researched gun');
    const cap = gd.guns[1].ammo;
    const a = eco.setAmmo(p, gd.id, [cap, cap, cap]);
    ok(a.reduce((x, y) => x + y, 0) === cap, 'ammo clamped to capacity');
  }
  ok(eco.sell(p, child.id).ok && p.credits >= 500 + child.price * 0.5 - 1, 'sell refunds half');
}

// ---------------------------------------------------------------- 3. rewards for a sample report
{
  const rng = makeRng(7);
  const p = newProfile('Tester');
  const def = TANK_LIST.find((d) => d.tier === 5 && d.cls === 'medium') || TANK_LIST.find((d) => d.tier === 5);
  p.tanks[def.id] = { ...p.tanks[p.selected], owned: true, ammo: defaultAmmo(def, 0) };
  const b = buildBattle(p, def.id, { seed: 11 });
  const perf = { won: true, survived: true, usedRepair: true, stats: { dmg: def.hp * 1.2, assist: 150, blocked: 200, kills: 2, shots: 9, hits: 8, pens: 7, received: 300, spotted: 2, capture: 0, defended: 20 } };
  const w = fakeWorld(b, perf, rng);
  const r = summarize(w, w.tanks.find((t) => t.player).id, p, b);
  log(`\nsample report: ${def.name} (tier ${def.tier}) ${r.result}: dmg ${r.stats.dmg}, kills ${r.stats.kills}`);
  log(`  XP: perf ${r.xp.perf} + win ${r.xp.win} = base ${r.xp.base}, first win +${r.xp.firstWin} → ${r.xp.total}, free ${r.xp.free}`);
  log(`  credits: gross ${r.credits.gross} − repair ${r.credits.repair} − ammo ${r.credits.ammo} − consumables ${r.credits.consumables} = net ${r.credits.net}`);
  log(`  mastery: ${r.masteryName || 'none'} (thresholds ${eco.masteryThresholds(def.tier).slice(1).join('/')}); medals: ${r.medals.map((m) => m.name).join(', ') || 'none'}`);
  ok(r.result === 'victory' && r.firstWin, 'victory with first-win bonus');
  ok(r.xp.base > 0 && r.xp.win === Math.round(r.xp.perf * 0.5), 'win bonus is ×1.5');
  ok(r.xp.total === r.xp.base * 2, 'first victory of the day doubles XP');
  ok(r.xp.free === Math.round(r.xp.total * 0.05), 'free XP is 5%');
  ok(r.credits.ammo === 9 * eco.shellPrice(def, 0, r.shellsUsed.findIndex((n) => n > 0)), 'ammo bill = shells fired × price');
  ok(r.credits.net > 0, 'a good battle earns credits');
  ok(r.teams[0].length === 15 && r.teams[1].length === 15, 'scoreboard has both teams');
  const cr0 = p.credits, xp0 = p.tanks[def.id].xp;
  applyReport(p, r); applyReport(p, r);
  ok(p.tanks[def.id].xp === xp0 + r.xp.total && p.credits === cr0 + r.credits.net, 'applyReport applies once');
  ok(p.stats.battles === 1 && p.history.length === 1 && p.freeXp === r.xp.free, 'stats + history updated');
  // losing, zero damage battle at the same tier earns much less
  const w2 = fakeWorld(buildBattle(p, def.id, { seed: 12 }), { won: false, survived: false, stats: { dmg: 0, shots: 0 } }, rng);
  const r2 = summarize(w2, w2.tanks.find((t) => t.player).id, p);
  ok(r2.xp.total > 0 && r2.xp.total < r.xp.base / 3, 'a zero-damage loss still gives a little XP');
  ok(r2.mastery === 0, 'no mastery for a bad game');
  log(`  bad game: XP ${r2.xp.total}, credits net ${r2.credits.net}`);
}

// ---------------------------------------------------------------- 4. tier-I player never goes bankrupt
{
  const rng = makeRng(3);
  const p = newProfile('Potato');
  p.credits = 0;
  let minNet = Infinity;
  for (let i = 0; i < 30; i++) {
    const id = p.selected;
    const b = buildBattle(p, id, { seed: 100 + i });
    const w = fakeWorld(b, { won: false, survived: false, usedRepair: true, stats: { dmg: 0, shots: 20 } }, rng);
    const r = summarize(w, w.tanks.find((t) => t.player).id, p, b);
    minNet = Math.min(minNet, r.credits.net);
    applyReport(p, r);
  }
  ok(minNet >= 0 && p.credits > 0, `worst-case tier-I battles never cost money (min net ${minNet}, credits after 30: ${p.credits})`);
  // gold ammo at tier I: quartermaster clamps at 0
  const p2 = newProfile('Goldspammer'); p2.credits = 0;
  const b = buildBattle(p2, p2.selected, { seed: 5 });
  const e = b.teams.flat().find((x) => x.player);
  const gi = e.def.guns[e.gun].shells.findIndex((s) => s.gold);
  if (gi >= 0) {
    e.ammo = e.def.guns[e.gun].shells.map((_, i) => (i === gi ? 30 : 0));
    const w = fakeWorld(b, { won: false, survived: false, stats: { dmg: 0, shots: 0 } }, rng);
    w.tanks.find((t) => t.player).ammo[gi] = 0;
    applyReport(p2, summarize(w, w.tanks.find((t) => t.player).id, p2, b));
    ok(p2.credits >= 0, 'credits never go negative');
  }
}

// ---------------------------------------------------------------- 5. matchmaker
{
  const p = newProfile('MM');
  const cnt = { spread: {}, maps: {} };
  let bad = 0, n = 0;
  for (const def of TANK_LIST) {
    p.tanks[def.id] = { ...p.tanks[p.selected], owned: true, ammo: defaultAmmo(def, 0), gun: 0, guns: [0] };
    for (const size of [15, 7]) for (let s = 0; s < 12; s++) {
      const b = buildBattle(p, def.id, { size, seed: s * 977 + def.tier });
      n++;
      const [A, B] = b.teams;
      const players = [...A, ...B].filter((e) => e.player);
      const valid = A.length === size && B.length === size && players.length === 1 && players[0].def === def
        && b.teams[b.meta.playerTeam].includes(players[0]);
      const sig = (tm) => tm.map((e) => e.def.tier + e.def.cls).sort().join();
      const tiers = [...A, ...B].map((e) => e.def.tier);
      const lo = Math.min(...tiers), hi = Math.max(...tiers);
      const spreadOk = hi - lo <= 2 && def.tier >= hi - 2 && def.tier <= lo + 2 && hi <= def.tier + 2 && lo >= def.tier - 2;
      const mirrored = sig(A) === sig(B);
      const entriesOk = [...A, ...B].every((e) => e.def && e.name && Array.isArray(e.ammo) && e.ammo.reduce((x, y) => x + y, 0) <= e.def.guns[e.gun].ammo
        && e.crewSkill >= 0.5 && e.crewSkill <= 1 && (e.player || (e.bot && e.bot.skill >= 0 && e.bot.skill <= 1)));
      const names = new Set([...A, ...B].map((e) => e.name));
      const lowOk = def.tier > 2 || hi <= def.tier + 1;
      if (!(valid && spreadOk && mirrored && entriesOk && names.size === size * 2 && lowOk && MAPS.some((m) => m.id === b.mapId))) {
        if (bad++ < 5) console.log('  bad battle', def.id, size, { valid, spreadOk, mirrored, entriesOk, names: names.size, lowOk, lo, hi });
      }
      cnt.spread[hi - def.tier] = (cnt.spread[hi - def.tier] || 0) + 1;
      cnt.maps[b.mapId] = (cnt.maps[b.mapId] || 0) + 1;
    }
  }
  ok(bad === 0, `matchmaker: ${n} battles valid (15v15 + 7v7, ±tier spread, mirrored classes, unique names, known maps)`);
  const a = buildBattle(p, TANK_LIST[5].id, { seed: 42 }), b = buildBattle(p, TANK_LIST[5].id, { seed: 42 });
  ok(JSON.stringify(a.teams.map((t) => t.map((e) => e.name + e.def.id))) === JSON.stringify(b.teams.map((t) => t.map((e) => e.name + e.def.id))), 'matchmaker is deterministic per seed');
  log(`\nmatchmaker: top tier − player tier distribution ${JSON.stringify(cnt.spread)}, maps ${JSON.stringify(cnt.maps)}`);
}

// ---------------------------------------------------------------- 6. progression simulation
function lines() {
  // every path from a starter to a top-tier tank
  const out = [];
  const walk = (id, path) => {
    const kids = childrenOf(id);
    if (!kids.length) { out.push([...path, id]); return; }
    for (const k of kids) walk(k.id, [...path, id]);
  };
  for (const d of TANK_LIST.filter((d) => d.tier === 1)) walk(d.id, []);
  return out.filter((l) => TANKS[l[l.length - 1]].tier >= 5);
}
function simulate(line, seed) {
  const rng = makeRng(seed);
  const p = newProfile('Sim');
  p.selected = line[0];
  let battles = 0, step = 1;
  const reached = {};
  while (step < line.length && battles < 600) {
    const def = TANKS[p.selected];
    const b = buildBattle(p, def.id, { seed: seed * 1000 + battles });
    const w = fakeWorld(b, avgPerf(def, rng, battles % 2 === 0), rng);
    applyReport(p, summarize(w, w.tanks.find((t) => t.player).id, p, b));
    battles++;
    const next = line[step];
    if (!p.researched.includes(next)) eco.research(p, next);
    if (p.researched.includes(next) && eco.buy(p, next).ok) { reached[TANKS[next].tier] = battles; step++; }
  }
  return { reached, battles, credits: p.credits };
}
{
  const ls = lines();
  const rows = [];
  let t5 = [], t7 = [];
  for (const l of ls) {
    const runs = [1, 2, 3].map((s) => simulate(l, s));
    const at = (tier) => { const v = runs.map((r) => r.reached[tier]).filter(Boolean); return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null; };
    const row = { line: l.map((id, i) => `${TANKS[id].short || id} ${ROMAN[TANKS[id].tier]}` + (i ? ` @${Math.round(runs.reduce((a, r) => a + (r.reached[TANKS[id].tier] || 0), 0) / runs.length)}` : '')).join(' → '), t5: at(5), t7: at(7) };
    rows.push(row);
    if (row.t5) t5.push(row.t5); if (row.t7) t7.push(row.t7);
  }
  log('\nprogression (average player, 50% wins; @N = battles played when that tank is bought):');
  for (const r of rows) log('  ' + r.line);
  const mean = (a) => Math.round(a.reduce((x, y) => x + y, 0) / Math.max(1, a.length));
  log(`  mean battles to tier V: ${mean(t5)}, to tier VII: ${mean(t7)}`);
  ok(mean(t5) >= 25 && mean(t5) <= 40, `tier V in 25–40 battles (${mean(t5)})`);
  if (t7.length) ok(mean(t7) >= 80 && mean(t7) <= 120, `tier VII in 80–120 battles (${mean(t7)})`);
  log('\nper-tier rates: tier | expected XP/battle | expected net credits/battle | mastery 3rd/2nd/1st/Ace');
  let mono = true;
  for (let t = 2; t <= MAX_TIER; t++) if (!(eco.expectedXp(t) > eco.expectedXp(t - 1) && eco.expectedNetCredits(t) > eco.expectedNetCredits(t - 1))) mono = false;
  ok(mono, 'XP and net credits per battle rise with every tier');
  for (let t = 1; t <= MAX_TIER; t++) log(`  ${ROMAN[t].padEnd(4)} ${String(Math.round(eco.expectedXp(t))).padStart(6)} ${String(Math.round(eco.expectedNetCredits(t))).padStart(8)}   ${eco.masteryThresholds(t).slice(1).join('/')}`);
}

console.log(`\nmeta-test: ${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
