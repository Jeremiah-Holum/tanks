// Headless balance + AI checks.
// Usage: node tools/sim.mjs [campaign|ladder|director|teams|perf|all] [N]
import { step, DT } from '../src/sim/world.js';
import { brainStep } from '../src/sim/ai.js';
import { campaignWorld, versusWorld } from '../src/sim/game.js';
import { CAMPAIGN, VERSUS } from '../src/sim/levels.js';
import { newDirector, recordResult, missionThreat, effectiveRating } from '../src/sim/director.js';

const what = process.argv[2] || 'all';
const N = +process.argv[3] || 10;
const MAX_T = 240;
const agg = { games: 0, timeouts: 0, nan: 0, ticks: 0, ms: 0 };

function run(world) {
  let nan = false;
  const t0 = performance.now(), k0 = world.tick;
  while (!world.over && world.time < MAX_T) {
    step(world, brainStep);
    world.events.length = 0;
    for (const t of world.tanks) if (!Number.isFinite(t.x) || !Number.isFinite(t.z) || !Number.isFinite(t.aim) || !Number.isFinite(t.hp) || !Number.isFinite(t.disp)) nan = true;
    if (nan) break;
  }
  agg.games++; agg.ticks += world.tick - k0; agg.ms += performance.now() - t0;
  if (!world.over) agg.timeouts++;
  if (nan) agg.nan++;
  return { outcome: world.over ? world.outcome : 'timeout', time: world.time, nan };
}

function botPlayer(world, skill) {
  const p = world.tanks.find((t) => t.human);
  p.botDriven = true; p.skill = skill; p.style = 'hunt';
}

function campaign(skill, rating) {
  const rows = [];
  for (let m = 0; m < CAMPAIGN.length; m++) {
    let w = 0, to = 0, nan = 0, tt = 0;
    for (let k = 0; k < N; k++) {
      const world = campaignWorld(m, rating, 1000 + k * 7919 + m);
      botPlayer(world, skill);
      const r = run(world);
      if (r.outcome === 'won') w++; if (r.outcome === 'timeout') to++; if (r.nan) nan++;
      tt += r.time;
    }
    rows.push({ m: m + 1, name: CAMPAIGN[m].name, win: +(w / N).toFixed(2), timeout: to, nan, avgT: +(tt / N).toFixed(1) });
  }
  return rows;
}

// 1v1 medium vs medium over every versus map, both sides.
function duel(a, b, n, cls = 'medium') {
  let wa = 0, wb = 0, d = 0, to = 0, tt = 0;
  for (let k = 0; k < n; k++) {
    const map = Math.floor(k / 2) % VERSUS.length;
    const swap = k % 2 === 1;
    const slots = [
      { human: false, team: 0, skill: swap ? b : a, style: 'trick', cls },
      { human: false, team: 1, skill: swap ? a : b, style: 'trick', cls },
    ];
    const world = versusWorld(map, slots, 0.5, 5000 + k * 31);
    const r = run(world);
    tt += r.time;
    const aTeam = swap ? 1 : 0;
    if (r.outcome === 'team' + aTeam) wa++; else if (r.outcome === 'team' + (1 - aTeam)) wb++; else if (r.outcome === 'draw') d++; else to++;
  }
  return { [a]: wa, [b]: wb, draw: d, timeout: to, aShare: +(wa / Math.max(1, wa + wb)).toFixed(2), avgT: +(tt / n).toFixed(1) };
}

// Team battle: 5v5 mixed classes, one side all `a`, the other all `b`.
function teams(a, b, n) {
  const CL = ['medium', 'heavy', 'light', 'td', 'medium'];
  let wa = 0, wb = 0, to = 0, tt = 0;
  for (let k = 0; k < n; k++) {
    const swap = k % 2 === 1;
    const slots = [];
    for (let q = 0; q < 5; q++) slots.push({ team: 0, skill: swap ? b : a, style: q % 2 ? 'trick' : 'hunt', cls: CL[q] });
    for (let q = 0; q < 5; q++) slots.push({ team: 1, skill: swap ? a : b, style: q % 2 ? 'trick' : 'hunt', cls: CL[q] });
    const r = run(versusWorld(Math.floor(k / 2) % VERSUS.length, slots, 0.5, 7000 + k * 13));
    tt += r.time;
    const aTeam = swap ? 1 : 0;
    if (r.outcome === 'team' + aTeam) wa++; else if (r.outcome === 'team' + (1 - aTeam)) wb++; else if (r.outcome === 'timeout') to++;
  }
  return { [a]: wa, [b]: wb, timeout: to, avgT: +(tt / n).toFixed(1) };
}
function ffa(n) {
  const sk = ['ace', 'veteran', 'cadet', 'veteran'];
  const wins = [0, 0, 0, 0]; let to = 0;
  for (let k = 0; k < n; k++) {
    const rot = k % 4;
    const slots = sk.map((s, q) => ({ team: q, skill: sk[(q + rot) % 4], style: 'hunt', cls: 'medium' }));
    const w = versusWorld(k % VERSUS.length, slots, 0.5, 9000 + k);
    const r = run(w);
    if (r.outcome.startsWith('team')) wins[(+r.outcome.slice(4) + rot) % 4]++; else if (r.outcome === 'timeout') to++;
  }
  return { ace: wins[0], veteran: wins[1] + wins[3], cadet: wins[2], timeout: to };
}

function director(skill, adaptive, runs) {
  const dir = newDirector(); dir.adaptive = adaptive;
  let wins = 0, games = 0;
  for (let r = 0; r < runs; r++) {
    let m = 0, lives = 3, retries = 0;
    while (m < CAMPAIGN.length && lives > 0) {
      const world = campaignWorld(m, effectiveRating(dir, retries), 90000 + r * 101 + m * 7 + retries);
      botPlayer(world, skill);
      const res = run(world);
      games++;
      if (res.outcome === 'won') { wins++; if (adaptive) recordResult(dir, missionThreat(m), 1, 0.5); m++; retries = 0; if ((m % 5) === 0) lives++; }
      else { lives--; retries++; if (adaptive) recordResult(dir, missionThreat(m), 0); }
    }
  }
  return { skill, adaptive, rating: +dir.rating.toFixed(2), winRate: +(wins / games).toFixed(2), games };
}

// Per-tick cost with 12+ tanks: the last mission (13 tanks) and a 5v5 (10 tanks) + 2 extra.
function perf() {
  const out = [];
  { // JIT warm-up (a browser tab is warm after its first seconds too)
    const w = campaignWorld(19, 0.8, 1); botPlayer(w, 'ace');
    while (!w.over && w.time < 60) { step(w, brainStep); w.events.length = 0; }
  }
  const measure = (label, mk) => {
    const w = mk();
    const times = [];
    while (!w.over && w.time < 120) {
      const a = performance.now(); step(w, brainStep); times.push(performance.now() - a);
      w.events.length = 0;
    }
    times.sort((x, y) => x - y);
    const avg = times.reduce((s, x) => s + x, 0) / times.length;
    out.push({ label, tanks: w.tanks.length, ticks: times.length, avgMs: +avg.toFixed(3), p99Ms: +times[Math.floor(times.length * 0.99)].toFixed(3), maxMs: +times[times.length - 1].toFixed(3), over4ms: times.filter((x) => x > 4).length });
  };
  measure('campaign 20 (ace bot)', () => { const w = campaignWorld(19, 0.8, 4242); botPlayer(w, 'ace'); return w; });
  measure('versus 6v6 mixed skills', () => {
    const slots = []; for (let q = 0; q < 12; q++) slots.push({ team: q < 6 ? 0 : 1, skill: ['ace', 'veteran', 'cadet'][q % 3], style: q % 2 ? 'trick' : 'hunt', cls: ['medium', 'heavy', 'light', 'td'][q % 4], sp: q < 6 ? q % 5 : 5 + (q % 5) });
    return versusWorld(6, slots, 0.5, 777);
  });
  return out;
}

const t0 = Date.now();
if (what === 'perf' || what === 'all') { console.log('\n# perf (ms per 60 Hz tick, node)'); console.table(perf()); }
if (what === 'ladder' || what === 'all') {
  console.log(`\n# versus ladder, 1v1 medium vs medium, all ${VERSUS.length} maps × both sides, N=${N * 4}`);
  console.log('ace vs veteran  ', duel('ace', 'veteran', N * 4));
  console.log('veteran vs cadet', duel('veteran', 'cadet', N * 4));
  console.log('ace vs cadet    ', duel('ace', 'cadet', N * 4));
}
if (what === 'teams' || what === 'all') {
  console.log(`\n# 5v5 team battles (mixed classes), N=${N * 2}`);
  console.log('ace vs veteran  ', teams('ace', 'veteran', N * 2));
  console.log('veteran vs cadet', teams('veteran', 'cadet', N * 2));
  console.log(`# 4-way FFA (ace, veteran×2, cadet), N=${N * 2}`, ffa(N * 2));
}
if (what === 'campaign' || what === 'all') {
  for (const [skill, rating] of [['veteran', 0.5], ['ace', 0.5], ['ace', 1.0]]) {
    console.log(`\n# campaign: player-bot=${skill} (medium), enemy rating=${rating}, N=${N}`);
    console.table(campaign(skill, rating));
  }
}
if (what === 'director' || what === 'all') {
  console.log('\n# director convergence');
  for (const s of ['cadet', 'ace']) for (const a of [true, false]) console.log(director(s, a, Math.max(3, Math.round(N / 2))));
}
console.log(`\ngames ${agg.games}, timeouts ${agg.timeouts} (${(100 * agg.timeouts / Math.max(1, agg.games)).toFixed(1)}%), NaN games ${agg.nan}, avg ${(agg.ms / Math.max(1, agg.ticks)).toFixed(3)} ms/tick`);
console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (agg.nan) process.exitCode = 1;
