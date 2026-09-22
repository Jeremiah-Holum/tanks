// Headless balance + AI checks. Usage: node tools/sim.mjs [campaign|ladder|director|all] [N]
import { step, DT } from '../src/sim/world.js';
import { brainStep } from '../src/sim/ai.js';
import { campaignWorld, versusWorld } from '../src/sim/game.js';
import { CAMPAIGN, VERSUS } from '../src/sim/levels.js';
import { newDirector, recordResult, missionThreat, effectiveRating } from '../src/sim/director.js';

const what = process.argv[2] || 'all';
const N = +process.argv[3] || 10;
const MAX_T = 150;

function run(world) {
  let nan = false;
  while (!world.over && world.time < MAX_T) {
    step(world, brainStep);
    world.events.length = 0;
    for (const t of world.tanks) if (!Number.isFinite(t.x) || !Number.isFinite(t.z) || !Number.isFinite(t.aim)) nan = true;
    if (nan) break;
  }
  return { outcome: world.over ? world.outcome : 'timeout', time: world.time, nan };
}

function botPlayer(world, skill) {
  const p = world.tanks.find((t) => t.human);
  p.botDriven = true; p.skill = skill; p.style = skill === 'cadet' ? 'hunt' : 'trick';
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
    rows.push({ m: m + 1, name: CAMPAIGN[m].name, win: w / N, timeout: to, nan, avgT: +(tt / N).toFixed(1) });
  }
  return rows;
}

function duel(a, b, n) {
  let wa = 0, wb = 0, d = 0, to = 0;
  for (let k = 0; k < n; k++) {
    const map = k % VERSUS.length;
    const swap = k % 2 === 1;
    const slots = [
      { human: false, team: 0, skill: swap ? b : a, style: 'trick' },
      { human: false, team: 1, skill: swap ? a : b, style: 'trick' },
    ];
    const world = versusWorld(map, slots, 0.5, 5000 + k * 31);
    const r = run(world);
    const aTeam = swap ? 1 : 0;
    if (r.outcome === 'team' + aTeam) wa++; else if (r.outcome === 'team' + (1 - aTeam)) wb++; else if (r.outcome === 'draw') d++; else to++;
  }
  return { [a]: wa, [b]: wb, draw: d, timeout: to, aShare: +(wa / Math.max(1, wa + wb)).toFixed(2) };
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
      if (res.outcome === 'won') { wins++; if (adaptive) recordResult(dir, missionThreat(m), 1, 0.5); m++; retries = 0; }
      else { lives--; retries++; if (adaptive) recordResult(dir, missionThreat(m), 0); }
    }
  }
  return { skill, adaptive, rating: +dir.rating.toFixed(2), winRate: +(wins / games).toFixed(2), games };
}

const t0 = Date.now();
if (what === 'campaign' || what === 'all') {
  for (const [skill, rating] of [['veteran', 0.5], ['ace', 0.5], ['ace', 1.0]]) {
    console.log(`\n# campaign: player-bot=${skill}, enemy rating=${rating}, N=${N}`);
    console.table(campaign(skill, rating));
  }
}
if (what === 'ladder' || what === 'all') {
  console.log('\n# versus ladder, 1v1, N=' + N * 4);
  console.log('ace vs veteran', duel('ace', 'veteran', N * 4));
  console.log('veteran vs cadet', duel('veteran', 'cadet', N * 4));
  console.log('ace vs cadet', duel('ace', 'cadet', N * 4));
}
if (what === 'director' || what === 'all') {
  console.log('\n# director convergence');
  for (const s of ['cadet', 'ace']) for (const a of [true, false]) console.log(director(s, a, Math.max(2, N / 5)));
}
console.log(`\n${((Date.now() - t0) / 1000).toFixed(1)}s`);
