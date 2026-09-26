// node tools/meta-test.mjs [--quiet]
// Deterministic tests for src/meta: starting profile, research → buy → select, reward sanity,
// service costs vs. a tier-I player, matchmaker validity, and a progression simulation that
// counts battles to tier V, VII and X along each line for an "average player", and the post-war
// tiers VIII–X (research chain, rewards, full tier VIII–X battles).
import { TANKS, TANK_LIST, NATIONS, MAPS, STUB_TANKS, STUB_MAPS, ROMAN, MAX_TIER, childrenOf } from '../src/meta/roster.js';
import { newProfile, migrate, ownedIds, selectTank, START_CREDITS, defaultAmmo, startTankOf, LINEUP_MAX, fixLineup } from '../src/meta/profile.js';
import * as eco from '../src/meta/economy.js';
import { buildBattle, DEPLOYS, BATTLE_TIME } from '../src/meta/matchmaker.js';
import { createBattle, respawnTank, stepBattle, MAX_DEPLOYS, deploysLeft, spawnsLeft } from '../src/sim/battle.js';
import { kill } from '../src/sim/damage.js';
import { testMap } from '../src/sim/testmap.js';
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
  let t5 = [], t7 = [], t10 = [];
  for (const l of ls) {
    const runs = [1, 2, 3].map((s) => simulate(l, s));
    const at = (tier) => { const v = runs.map((r) => r.reached[tier]).filter(Boolean); return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null; };
    const row = { line: l.map((id, i) => `${TANKS[id].short || id} ${ROMAN[TANKS[id].tier]}` + (i ? ` @${Math.round(runs.reduce((a, r) => a + (r.reached[TANKS[id].tier] || 0), 0) / runs.length)}` : '')).join(' → '), t5: at(5), t7: at(7), t10: at(10) };
    rows.push(row);
    if (row.t5) t5.push(row.t5); if (row.t7) t7.push(row.t7); if (row.t10) t10.push(row.t10);
  }
  log('\nprogression (average player, 50% wins; @N = battles played when that tank is bought):');
  for (const r of rows) log('  ' + r.line);
  const mean = (a) => Math.round(a.reduce((x, y) => x + y, 0) / Math.max(1, a.length));
  log(`  mean battles to tier V: ${mean(t5)}, to tier VII: ${mean(t7)}, to tier X: ${mean(t10)}`);
  ok(mean(t5) >= 25 && mean(t5) <= 40, `tier V in 25–40 battles (${mean(t5)})`);
  if (t7.length) ok(mean(t7) >= 80 && mean(t7) <= 120, `tier VII in 80–120 battles (${mean(t7)})`);
  ok(t10.length === 3 && mean(t10) >= 220 && mean(t10) <= 340, `tier X in 220–340 battles on each nation's medium line (${t10.join(', ')})`);
  log('\nper-tier rates: tier | expected XP/battle | expected net credits/battle | mastery 3rd/2nd/1st/Ace');
  let mono = true;
  for (let t = 2; t <= MAX_TIER; t++) if (!(eco.expectedXp(t) > eco.expectedXp(t - 1) && eco.expectedNetCredits(t) > eco.expectedNetCredits(t - 1))) mono = false;
  ok(mono, 'XP and net credits per battle rise with every tier');
  for (let t = 1; t <= MAX_TIER; t++) log(`  ${ROMAN[t].padEnd(4)} ${String(Math.round(eco.expectedXp(t))).padStart(6)} ${String(Math.round(eco.expectedNetCredits(t))).padStart(8)}   ${eco.masteryThresholds(t).slice(1).join('/')}`);
}

// ---------------------------------------------------------------- 7. post-war tiers VIII–X
{
  ok(MAX_TIER === 10 && ROMAN[10] === 'X', 'roster runs to tier X');
  // every nation: tier VIII, IX and X exist and a tier X tank is reachable from a starter
  for (const n of Object.keys(NATIONS)) {
    const list = TANK_LIST.filter((d) => d.nation === n);
    const reach = new Set(list.filter((d) => d.tier === 1).map((d) => d.id));
    for (let t = 2; t <= MAX_TIER; t++) for (const d of list.filter((x) => x.tier === t)) if (d.parents.some((q) => reach.has(q))) reach.add(d.id);
    const tops = list.filter((d) => d.tier === 10);
    ok([8, 9, 10].every((t) => list.some((d) => d.tier === t)) && tops.length && tops.every((d) => reach.has(d.id)), `${n}: tiers VIII–X exist and tier X is reachable from the starter`);
  }
  // research + buy along the chain VII → VIII → IX → X (parent XP, then credits)
  let chainOk = true;
  for (const top of TANK_LIST.filter((d) => d.tier === 10)) {
    const chain = [top]; while (chain[0].tier > 7) chain.unshift(TANKS[chain[0].parents[0]]);
    const p = newProfile('Chain');
    p.tanks[chain[0].id] = { ...p.tanks[p.selected], owned: true, xp: 0, guns: [0], gun: 0, ammo: defaultAmmo(chain[0], 0) };
    p.researched.push(chain[0].id);
    for (let i = 1; i < chain.length; i++) {
      const d = chain[i], par = chain[i - 1];
      p.tanks[par.id].xp = d.xp; p.credits = d.price;
      const rr = eco.researchInfo(p, d.id);
      if (!(rr.ok && eco.research(p, d.id).ok && eco.buy(p, d.id).ok && ownedIds(p).includes(d.id) && p.credits === 0)) chainOk = false;
    }
  }
  ok(chainOk, 'post-war lines research and buy VII → VIII → IX → X');
  // economy: research cost and price grow per tier, tier X nets credits for an average player,
  // service stays a fraction of the gross, and a tier-X loss with 0 damage costs < 1 average battle's net
  const avg = (t, f) => { const l = TANK_LIST.filter((d) => d.tier === t); return l.reduce((s, d) => s + f(d), 0) / l.length; };
  ok([8, 9, 10].every((t) => avg(t, (d) => d.xp) > avg(t - 1, (d) => d.xp) && avg(t, (d) => d.price) > avg(t - 1, (d) => d.price)), 'research XP and price rise through tiers VIII–X');
  let econ = true;
  for (const t of [8, 9, 10]) {
    const def = TANK_LIST.find((d) => d.tier === t);
    const p = newProfile('Eco'); p.tanks[def.id] = { ...p.tanks[p.selected], owned: true, guns: [0], gun: 0, ammo: defaultAmmo(def, 0) };
    const b = buildBattle(p, def.id, { seed: 70 + t });
    const w = fakeWorld(b, { won: false, survived: false, stats: { dmg: 0, shots: 10 } }, makeRng(t));
    const rep = summarize(w, w.tanks.find((x) => x.player).id, p, b);
    if (!(eco.expectedNetCredits(t) > 0 && rep.credits.net > -eco.expectedNetCredits(t))) econ = false;
    log(`  tier ${ROMAN[t]} ${def.short}: bad game net ${rep.credits.net}, expected net ${Math.round(eco.expectedNetCredits(t))}, price ${def.price}`);
  }
  ok(econ, 'tiers VIII–X: average battle nets credits; a zero-damage loss costs less than one average battle earns');
  // matchmaker: a tier X tank gets full, mirrored tier VIII–X battles; tier VIII can meet tier X
  let full = true, sawX = false;
  for (const def of TANK_LIST.filter((d) => d.tier >= 8)) {
    const p = newProfile('MMX'); p.tanks[def.id] = { ...p.tanks[p.selected], owned: true, guns: [0], gun: 0, ammo: defaultAmmo(def, 0) };
    p.lineup = [def.id];
    for (let s = 0; s < 10; s++) for (const size of [15, 7]) {
      const b = buildBattle(p, def.id, { size, seed: 500 + s });
      const all = [...b.teams[0], ...b.teams[1]], tiers = all.map((e) => e.def.tier);
      if (b.teams[0].length !== size || b.teams[1].length !== size || Math.min(...tiers) < def.tier - 2 || Math.max(...tiers) > Math.min(10, def.tier + 2)) full = false;
      if (def.tier === 10 && Math.min(...tiers) < 8) full = false;
      if (def.tier === 8 && Math.max(...tiers) === 10) sawX = true;
    }
  }
  ok(full, 'matchmaker: full 15v15 / 7v7 battles for every tier VIII–X tank, tiers within ±2 and ≤ X');
  ok(sawX, 'a tier VIII tank sometimes meets tier X');
}

// ---------------------------------------------------------------- 8. battle lineup (slots, respawns, per-tank rewards)
{
  const p = newProfile('Tester');
  const own = ownedIds(p);
  ok(p.lineupSlots === 2 && p.lineup.length === 2 && p.lineup[0] === p.selected && p.lineup.every((id) => own.includes(id)), 'new profile: 2 slots, lineup = selected + next owned');
  const old = JSON.parse(JSON.stringify(p)); delete old.lineup; delete old.lineupSlots; old.selected = own[2];
  const m = migrate(old);
  ok(m.lineupSlots === 2 && m.lineup[0] === own[2] && m.lineup.length === 2 && new Set(m.lineup).size === 2, 'old save migrates to [selected, next owned]');
  ok(!eco.setLineup(p, [own[0], own[0]]).ok && !eco.setLineup(p, own).ok && !eco.setLineup(p, []).ok, 'setLineup rejects duplicates, too many tanks, empty');
  const unowned = TANK_LIST.find((d) => !own.includes(d.id)).id;
  ok(eco.setLineup(p, [own[0], unowned]).reason === 'not owned', 'setLineup rejects tanks you do not own');
  ok(eco.setLineup(p, [own[1], own[0]]).ok && p.lineup.join() === [own[1], own[0]].join(), 'setLineup sets the spawn order');
  ok(eco.moveInLineup(p, own[0], -1).ok && p.lineup[0] === own[0], 'moveInLineup reorders');
  ok(eco.addToLineup(p, own[2]).reason === 'slots', 'lineup is full at 2 slots');
  p.credits = 24999;
  ok(eco.slotPrice(p) === 25000 && eco.buySlot(p).reason === 'credits', '3rd slot costs 25,000');
  p.credits = 25000 + 60000 + 120000 + 200000 + 300000 + 450000 + 650000 + 900000 + 7;
  ok(eco.buySlot(p).ok && p.lineupSlots === 3 && eco.slotPrice(p) === 60000, 'buy 3rd slot, 4th costs 60,000');
  ok(eco.buySlot(p).ok && eco.slotPrice(p) === 120000 && eco.buySlot(p).ok && p.lineupSlots === 5, 'slots 4 and 5 (120,000)');
  const prices = [];
  while (eco.slotPrice(p) != null) { prices.push(eco.slotPrice(p)); if (!eco.buySlot(p).ok) break; }
  ok(prices.join() === '200000,300000,450000,650000,900000' && p.lineupSlots === 10 && p.credits === 7, 'slots 6–10 escalate (200k … 900k), credits spent');
  ok(LINEUP_MAX === 10 && eco.slotPrice(p) === null && eco.buySlot(p).reason === 'max', 'max 10 slots');
  { const f = newProfile('F'); f.lineupSlots = 99; fixLineup(f); ok(f.lineupSlots === 10, 'fixLineup clamps slots to 10'); }
  ok(eco.addToLineup(p, own[2]).ok && p.lineup.length === 3, 'add a tank to a bought slot');
  ok(eco.removeFromLineup(p, own[1]).ok && !p.lineup.includes(own[1]), 'remove a tank from the lineup');
  // selling removes the tank from the lineup; buying fills a free slot
  const child = childrenOf(own[0])[0];
  p.researched.push(child.id); p.credits = child.price;
  ok(eco.buy(p, child.id).ok && p.lineup.includes(child.id), 'a bought tank fills a free lineup slot');
  ok(eco.sell(p, child.id).ok && !p.lineup.includes(child.id) && p.lineup.length >= 1, 'selling removes the tank from the lineup');
  const p2 = newProfile('T2'); p2.lineup = [p2.lineup[0]];
  eco.sell(p2, p2.lineup[0]);
  ok(p2.lineup.length >= 1 && p2.lineup.every((id) => p2.tanks[id].owned), 'selling the only lineup tank refills the lineup');

  // matchmaker: tier from the highest lineup tank, reserve = the other lineup tanks
  const q = newProfile('Tester');
  const t5 = TANK_LIST.find((d) => d.tier === 5);
  q.tanks[t5.id] = { ...q.tanks[q.selected], owned: true, gun: 0, guns: [0], ammo: defaultAmmo(t5, 0) };
  eco.setLineup(q, [q.selected, t5.id]);
  let okTier = true;
  for (let s = 1; s <= 30; s++) { const b = buildBattle(q, q.lineup, { seed: s }); if (b.meta.tiers[1] < 5 || b.meta.tiers[0] < 3 || b.meta.topTier !== 5) okTier = false; }
  ok(okTier, 'battle tier comes from the highest-tier lineup tank');
  const b = buildBattle(q, q.lineup, { seed: 4 });
  const pe = b.teams[b.meta.playerTeam].find((e) => e.player);
  ok(pe.def.id === q.lineup[0] && b.reserve[b.meta.playerTeam].length === 1 && b.reserve[b.meta.playerTeam][0].def.id === t5.id && !b.reserve[1 - b.meta.playerTeam].length,
    'spawn in the first lineup tank, the rest in reserve');
  ok(b.teams.every((tm) => tm.length === 15 && tm.filter((e) => e.player).length <= 1), 'teams stay 15v15 with one player entry');
  // starting tank: the garage's selected lineup tank (else lineup #1); same matchmaking either way
  const q0 = q.selected; selectTank(q, t5.id);
  const bs = buildBattle(q, q.lineup, { seed: 4, start: startTankOf(q) }), pt = bs.meta.playerTeam;
  ok(startTankOf(q) === t5.id && bs.teams[pt].find((e) => e.player).def.id === t5.id && bs.reserve[pt].map((e) => e.def.id).join() === q0 && bs.meta.tankId === t5.id
    && bs.meta.lineup.join() === q.lineup.join() && bs.meta.tiers.join() === b.meta.tiers.join() && bs.mapId === b.mapId, 'start in the selected lineup tank, the rest in reserve, same tier and map');
  const outside = ownedIds(q).find((id) => !q.lineup.includes(id));
  if (outside) { selectTank(q, outside); ok(startTankOf(q) === q.lineup[0], 'a selected tank outside the lineup: start in lineup #1'); }
  selectTank(q, q0);

  // deploys: a 5-tank lineup still deploys at most 3 tanks; bots get 2 spares each
  {
    const L = newProfile('Deploy'), five = TANK_LIST.filter((d) => d.tier >= 2 && d.tier <= 3).slice(0, 4);
    for (const d of five) L.tanks[d.id] = { ...L.tanks[L.selected], owned: true, gun: 0, guns: [0], ammo: defaultAmmo(d, 0) };
    L.lineupSlots = 5; eco.setLineup(L, [L.selected, ...five.map((d) => d.id)].slice(0, 5));
    const B = buildBattle(L, L.lineup, { seed: 11 }), pt = B.meta.playerTeam;
    ok(DEPLOYS === 3 && MAX_DEPLOYS === 3 && B.lives === 3 && B.timeLimit === BATTLE_TIME && BATTLE_TIME === 1200, 'battles: 3 deploys each, 20 min');
    ok(B.reserve[pt].length === L.lineup.length - 1 && L.lineup.length === 5, 'the whole lineup is offered in reserve (5 tanks)');
    const bots = B.teams.flat().filter((e) => e.bot), [lo, hi] = B.meta.tiers;
    ok(bots.every((e) => e.spares.length === 2 && e.spares.every((s) => s.bot && s.name === e.name && s.bot.skill === e.bot.skill && s.def.nation === e.def.nation
      && Math.abs(s.def.tier - e.def.tier) <= 1 && s.def.tier >= lo && s.def.tier <= hi)), 'bot spares: 2 each, same name / skill / nation, tier ±1 inside the battle');
    ok(bots.filter((e) => e.spares.some((s) => s.def !== e.def)).length >= bots.length * 0.8, 'bot spares are mostly other tanks');
    const B2 = buildBattle(L, L.lineup, { seed: 11 });
    ok(JSON.stringify(B2.teams.flat().map((e) => (e.spares || []).map((s) => s.def.id))) === JSON.stringify(B.teams.flat().map((e) => (e.spares || []).map((s) => s.def.id))), 'bot spares are deterministic');
    // the sim caps the player at 3 deploys even with 4 lineup tanks in reserve
    const W = createBattle({ map: testMap(), seed: 3, teams: [[{ ...B.teams[pt].find((e) => e.player) }], [{ ...bots[0], spares: [] }]], reserve: [B.reserve[pt], []] });
    const me = W.tanks[0], foe = W.tanks[1], slot = W.slotOf[me.id];
    ok(deploysLeft(W, slot) === 2 && spawnsLeft(W, 0) === 2, 'player: 2 respawns left at the start (4 lineup tanks in reserve)');
    kill(W, me, foe.id, 'shot'); const r1 = respawnTank(W, 0, 3);
    kill(W, r1, foe.id, 'shot'); const r2 = respawnTank(W, 0, 0);
    kill(W, r2, foe.id, 'shot'); const r3 = respawnTank(W, 0, 0);
    ok(r1 && r2 && !r3 && r2.life === 3 && r2.slot === me.id && W.reserve[0].length === 2 && deploysLeft(W, slot) === 0, '3rd death: no 4th tank although 2 lineup tanks are unused');
    stepBattle(W, new Map());
    ok(W.result && W.result.winner === 1 && W.result.reason === 'destroyed', 'after 3 deploys the team is defeated');
  }

  // per-tank rewards: two tanks driven, each with its own stats
  const rng = makeRng(5);
  const w = fakeWorld(b, { won: true, survived: false, stats: { dmg: 120, shots: 4, hits: 3, pens: 2, kills: 1 } }, rng);
  const first = w.tanks.find((t) => t.player);
  const e2 = b.reserve[b.meta.playerTeam][0];
  const second = { id: 99, slot: first.id, life: 2, team: first.team, def: e2.def, gunDef: e2.def.guns[0], name: first.name, player: true, alive: true, hp: Math.round(e2.def.hp * 0.5), maxHp: e2.def.hp,
    ammo: e2.ammo.slice(), consumables: e2.consumables.map((k) => ({ kind: k, ready: true, cd: 0 })),
    stats: { dmg: 900, assist: 0, blocked: 0, kills: 2, shots: 6, hits: 5, pens: 5, received: 400, spotted: 1, capture: 0, defended: 0 } };
  second.ammo[0] -= 6;
  w.tanks.push(second);
  const r = summarize(w, [first.id, second.id], q, b);
  ok(r.tanks.length === 2 && r.tanks[0].tankId === q.lineup[0] && r.tanks[1].tankId === t5.id, 'report has a per-tank breakdown');
  ok(r.stats.dmg === r.tanks[0].stats.dmg + r.tanks[1].stats.dmg && r.stats.kills === 3 && r.stats.shots === 10, 'stats add up over the tanks');
  ok(r.xp.total === r.tanks[0].xp.total + r.tanks[1].xp.total && r.credits.net === r.tanks[0].credits.net + r.tanks[1].credits.net, 'XP and credits add up over the tanks');
  ok(r.tanks[1].credits.ammo === 6 * eco.shellPrice(t5, 0, 0) && r.tanks[1].credits.repair === eco.repairCost(t5, 0.5), 'each tank pays its own ammo and repairs');
  ok(r.survived && !r.tanks[0].survived && r.size === 15, 'survival from the last tank; team size unchanged');
  const x0 = q.tanks[q.lineup[0]].xp, x1 = q.tanks[t5.id].xp, cr0 = q.credits;
  applyReport(q, r);
  ok(q.tanks[q.lineup[0]].xp === x0 + r.tanks[0].xp.total && q.tanks[t5.id].xp === x1 + r.tanks[1].xp.total, 'each tank gets its own XP');
  ok(q.tanks[q.lineup[0]].battles === 1 && q.tanks[t5.id].battles === 1 && q.stats.battles === 1 && q.stats.dmg === r.stats.dmg, 'per-tank battle counts; service record counts one battle');
  ok(q.credits === Math.max(0, cr0 + r.credits.net) && q.history[0].tankIds.length === 2, 'credits and history');
}

console.log(`\nmeta-test: ${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
