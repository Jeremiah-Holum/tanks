// Headless 15v15 bot-vs-bot battles (src/sim/ai) on every map, mixed tiers from the matchmaker.
// Reports win rates per team and map, how battles end and when, damage per class, shots / hit /
// pen rates, stuck tanks (alive, wanting to move, < 8 m progress over 60 s), AI and sim time per
// tick, and how bot skill correlates with damage and survival.
//   node tools/battle-sim.mjs [--n 4] [--maps ashford,kessel] [--workers 2] [--seed 1] [--limit 900] [--v]
//     [--skills 0.8,0.3 (force team skills)] [--tune cover=0,danger=0.5 (src/sim/ai TUNE knobs, for A/B)]
// --n = battles per map. Workers run battles in parallel (worker_threads); keep it ≤ 2 on a busy box.
import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import { performance } from 'perf_hooks';
import { fileURLToPath } from 'url';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };

async function runBattle({ mapId, seed, limit, verbose, skills, tune }) {
  const { loadMap } = await import('../src/sim/map/index.js');
  const { createBattle, stepBattle } = await import('../src/sim/battle.js');
  const { createBrain, TUNE } = await import('../src/sim/ai/index.js');
  Object.assign(TUNE, tune || {});
  const { buildBattle } = await import('../src/meta/matchmaker.js');
  const { TANK_LIST } = await import('../src/meta/roster.js');
  const { makeRng } = await import('../src/meta/rng.js');
  const rng = makeRng(seed * 31 + 7);
  // a random tier III–VII tank anchors the matchmaker; its "player" slot becomes a bot too
  const anchorPool = TANK_LIST.filter((d) => d.tier >= 2);
  const anchor = anchorPool[Math.floor(rng() * anchorPool.length)];
  const opts = buildBattle(null, anchor.id, { seed, mapId, timeLimit: limit });
  for (const tm of opts.teams) for (const e of tm) if (e.player) { e.player = false; e.bot = { skill: 0.5, role: 'x' }; e.crewSkill = 0.76; }
  // --skills a,b: force every bot of team 0 / 1 to that skill (crew follows like the matchmaker)
  if (skills) opts.teams.forEach((tm, k) => tm.forEach((e) => { e.bot.skill = skills[k]; e.crewSkill = +(0.55 + 0.42 * skills[k]).toFixed(2); }));
  const map = loadMap(mapId);
  const world = createBattle({ map, seed, timeLimit: limit, teams: opts.teams });
  const brains = new Map(world.tanks.map((t) => [t.id, createBrain(world, t)]));
  if (verbose) for (const b of brains.values()) b.log = [];
  const ctrl = new Map();
  let aiMs = 0, simMs = 0, steps = 0;
  const deathT = {}, deaths = [];
  // stuck tracking: samples every 5 s: [x, z, wantMove]
  const hist = new Map(world.tanks.map((t) => [t.id, []]));
  const stuck = new Map();
  while (!world.result) {
    ctrl.clear();
    const a = performance.now();
    for (const t of world.tanks) if (t.alive) ctrl.set(t.id, brains.get(t.id).control(world));
    const b = performance.now();
    stepBattle(world, ctrl);
    const c = performance.now();
    aiMs += b - a; simMs += c - b; steps++;
    for (const e of world.events) {
      if (e.type === 'kill') {
        deathT[e.victim] = world.time;
        { const v = world.byId[e.victim], k = world.byId[e.killer], bv = brains.get(v.id);
          deaths.push({ skill: bv.skill, cls: v.def.cls, state: bv.mode + (bv.hold ? '/hold' : bv.arrived ? '/at' : '/move') + (bv.peek ? '/peek' : ''), d: k ? Math.hypot(k.pos.x - v.pos.x, k.pos.z - v.pos.z) : -1, t: world.time }); }
        if (verbose) {
          const v = world.byId[e.victim], k = world.byId[e.killer], bv = brains.get(v.id), bk = k && brains.get(k.id);
          const d = k ? Math.hypot(k.pos.x - v.pos.x, k.pos.z - v.pos.z).toFixed(0) : '-';
          console.log(`  ${world.time.toFixed(0).padStart(4)}s KILL t${v.team} ${v.def.cls[0]}${v.def.tier} s${bv.skill.toFixed(2)} ${bv.mode}${bv.hold ? '/hold' : bv.arrived ? '/at' : '/move'} post ${bv.post ? bv.post.kind + ' ' + Math.hypot(bv.post.x - v.pos.x, bv.post.z - v.pos.z).toFixed(0) + 'm' : '-'} tgt ${bv.target ? bv.targetD.toFixed(0) : '-'} @${v.pos.x.toFixed(0)},${v.pos.z.toFixed(0)} by ${k ? k.def.cls[0] + k.def.tier + ' s' + bk.skill.toFixed(2) + ' ' + bk.mode : e.cause} d=${d} ${e.cause}`);
        }
      }
    }
    if (verbose && steps % 1800 === 0) {
      const T = [0, 1].map((k) => world.tanks.filter((t) => t.team === k && t.alive).map((t) => { const b = brains.get(t.id); return `${t.def.cls[0]}${b.mode[0]}${b.hold ? 'H' : b.arrived ? 'A' : ''}(${t.pos.x.toFixed(0)},${t.pos.z.toFixed(0)})`; }).join(' '));
      const tb = brains.get(world.tanks[0].id).team;
      console.log(`  --- ${world.time.toFixed(0)}s push ${tb.push} ratio ${tb.ratio.toFixed(2)} bases ${world.bases.map((b) => b.points.toFixed(0)).join('/')}\n   t0: ${T[0]}\n   t1: ${T[1]}`);
    }
    if (steps % 300 === 0) {
      for (const t of world.tanks) {
        if (!t.alive) continue;
        const h = hist.get(t.id), br = brains.get(t.id);
        h.push([t.pos.x, t.pos.z, br.wantMove ? 1 : 0]);
        if (h.length > 13) h.shift();
        if (h.length === 13 && !stuck.has(t.id)) {
          let maxD = 0, want = 0;
          for (const p of h) { maxD = Math.max(maxD, Math.hypot(p[0] - h[0][0], p[1] - h[0][1])); want += p[2]; }
          if (maxD < 8 && want >= 10) {
            stuck.set(t.id, { x: Math.round(t.pos.x), z: Math.round(t.pos.z), t: Math.round(world.time), mode: br.mode, cls: t.def.cls });
            if (verbose) { const c = br.c, g = br.goal; console.log(`  STUCK ${t.id} ${t.def.id} at ${t.pos.x.toFixed(1)},${t.pos.z.toFixed(1)} yaw ${t.yaw.toFixed(2)} speed ${t.speed.toFixed(2)} goal ${g && g.x.toFixed(0)},${g && g.z.toFixed(0)} hold ${br.hold} arrived ${br.arrived} rev ${br.reverseT.toFixed(2)} thr ${c.throttle.toFixed(2)} steer ${c.steer.toFixed(2)} brake ${c.brake} carrot ${br.carrot.x.toFixed(0)},${br.carrot.z.toFixed(0)} path ${br.follow.pts && br.follow.pts.map((p) => p.x.toFixed(0) + ',' + p.z.toFixed(0)).join(' ')} i=${br.follow.i} unsticks ${br.stats.unsticks} plans ${br.stats.plans} tracks ${t.modules.trackL.state}/${t.modules.trackR.state} engine ${t.modules.engine.state} log ${br.log}`); }
          }
        }
      }
    }
  }
  const tanks = world.tanks.map((t) => ({
    team: t.team, cls: t.def.cls, tier: t.def.tier, hp: t.maxHp, skill: t.bot ? t.bot.skill : 0.5, alive: t.alive,
    life: t.alive ? world.time : deathT[t.id] ?? world.time, share: (t.alive ? world.time : deathT[t.id] ?? world.time) / world.time, dmg: t.stats.dmg, shots: t.stats.shots, hits: t.stats.hits, pens: t.stats.pens,
    kills: t.stats.kills, received: t.stats.received, unsticks: brains.get(t.id).stats.unsticks, spotted: t.stats.spotted,
  }));
  const bots = world.tanks.length;
  return {
    mapId, seed, result: world.result, time: world.time, tanks, deaths, stuck: [...stuck.values()],
    aiMsPerBotTick: aiMs / steps / bots, aiMsPerTick: aiMs / steps, simMsPerTick: simMs / steps,
    alive: [0, 1].map((k) => world.tanks.filter((t) => t.team === k && t.alive).length),
  };
}

if (!isMainThread) {
  parentPort.on('message', async (job) => {
    if (!job) return process.exit(0);
    try { parentPort.postMessage(await runBattle(job)); } catch (e) { parentPort.postMessage({ error: String(e.stack || e), job }); }
  });
} else {
  const { MAPS } = await import('../src/sim/map/index.js');
  const n = +arg('n', 3), workers = +arg('workers', 2), seed0 = +arg('seed', 1), limit = +arg('limit', 900);
  const maps = (arg('maps', MAPS.map((m) => m.id).join(','))).split(',');
  const verbose = process.argv.includes('--v');
  const skills = arg('skills', null) ? arg('skills').split(',').map(Number) : null;
  const tune = Object.fromEntries((arg('tune', '') || '').split(',').filter(Boolean).map((kv) => { const [k, v] = kv.split('='); return [k, +v]; }));
  const jobs = [];
  for (let i = 0; i < n; i++) for (const mapId of maps) jobs.push({ mapId, seed: seed0 + i * 101 + mapId.length * 7, limit, verbose, skills, tune });
  const results = [];
  const t0 = performance.now();
  await new Promise((resolve) => {
    let next = 0, live = 0;
    const self = fileURLToPath(import.meta.url);
    for (let w = 0; w < Math.min(workers, jobs.length); w++) {
      const wk = new Worker(self); live++;
      const feed = () => { if (next < jobs.length) wk.postMessage(jobs[next++]); else { wk.postMessage(null); } };
      wk.on('message', (r) => {
        results.push(r);
        if (r.error) console.log('ERROR', r.job.mapId, r.job.seed, r.error);
        else {
          const R = r.result;
          console.log(`${r.mapId.padEnd(8)} seed ${String(r.seed).padStart(5)}: ${R.reason.padEnd(9)} ${R.winner < 0 ? 'draw  ' : 'team ' + R.winner} at ${(r.time / 60).toFixed(1)} min, alive ${r.alive.join(':')}, ai ${r.aiMsPerBotTick.toFixed(3)} ms/bot·tick, sim ${r.simMsPerTick.toFixed(2)} ms${r.stuck.length ? ', STUCK ' + r.stuck.map((s) => `${s.cls}@${s.x},${s.z}(${s.mode},${s.t}s)`).join(' ') : ''}`);
        }
        feed();
      });
      wk.on('exit', () => { if (--live === 0) resolve(); });
      feed();
    }
  });
  report(results.filter((r) => !r.error), (performance.now() - t0) / 1000);
}

function report(R, secs) {
  const pct = (a, b) => (b ? (100 * a / b).toFixed(0) + '%' : '-');
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  console.log(`\n=== ${R.length} battles in ${secs.toFixed(0)} s ===`);
  const maps = [...new Set(R.map((r) => r.mapId))];
  for (const m of [...maps, 'ALL']) {
    const L = m === 'ALL' ? R : R.filter((r) => r.mapId === m);
    const w0 = L.filter((r) => r.result.winner === 0).length, w1 = L.filter((r) => r.result.winner === 1).length, dr = L.length - w0 - w1;
    const by = (k) => L.filter((r) => r.result.reason === k).length;
    const dur = L.map((r) => r.time / 60).sort((a, b) => a - b);
    const in410 = L.filter((r) => r.time >= 240 && r.time <= 600).length;
    console.log(`${m.padEnd(8)} n=${L.length}  wins t0 ${w0} / t1 ${w1} / draw ${dr}  | destroyed ${by('destroyed')} capture ${by('capture')} time ${by('time')} (${pct(by('time'), L.length)})  | min ${mean(dur).toFixed(1)} (median ${(dur[dur.length >> 1] || 0).toFixed(1)}, ${dur[0]?.toFixed(1)}–${dur[dur.length - 1]?.toFixed(1)}), 4–10 min ${pct(in410, L.length)}  | stuck ${L.reduce((a, r) => a + r.stuck.length, 0)}`);
  }
  const T = R.flatMap((r) => r.tanks);
  console.log('\nclass    n    dmg   dmg/hp  surv  shots hit%  pen%(of hits) kills');
  for (const c of ['light', 'medium', 'heavy', 'td', 'ALL']) {
    const L = c === 'ALL' ? T : T.filter((t) => t.cls === c);
    const sh = L.reduce((a, t) => a + t.shots, 0), hi = L.reduce((a, t) => a + t.hits, 0), pe = L.reduce((a, t) => a + t.pens, 0);
    console.log(`${c.padEnd(7)} ${String(L.length).padStart(4)} ${mean(L.map((t) => t.dmg)).toFixed(0).padStart(5)}  ${mean(L.map((t) => t.dmg / t.hp)).toFixed(2).padStart(5)}  ${pct(L.filter((t) => t.alive).length, L.length).padStart(4)}  ${(sh / Math.max(1, L.length)).toFixed(1).padStart(5)} ${pct(hi, sh).padStart(4)}  ${pct(pe, hi).padStart(4)}   ${mean(L.map((t) => t.kills)).toFixed(2)}`);
  }
  // skill correlation
  const corr = (xs, ys) => {
    const mx = mean(xs), my = mean(ys);
    let a = 0, b = 0, c = 0;
    for (let i = 0; i < xs.length; i++) { a += (xs[i] - mx) * (ys[i] - my); b += (xs[i] - mx) ** 2; c += (ys[i] - my) ** 2; }
    return a / Math.sqrt(b * c || 1);
  };
  const sk = T.map((t) => t.skill);
  const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };
  // within-class correlation (class and tier explain a lot of the raw variance)
  const within = ['light', 'medium', 'heavy', 'td'].map((c) => { const L = T.filter((t) => t.cls === c); return L.length > 20 ? `${c} ${corr(L.map((t) => t.skill), L.map((t) => t.dmg / t.hp)).toFixed(2)}` : ''; }).filter(Boolean).join(', ');
  console.log(`\nsd(dmg/hp) ${sd(T.map((t) => t.dmg / t.hp)).toFixed(2)}, sd(skill) ${sd(sk).toFixed(2)}; r(skill, dmg/hp) within class: ${within}`);
  console.log(`\nskill correlation: r(skill, dmg/hp) = ${corr(sk, T.map((t) => t.dmg / t.hp)).toFixed(2)}, r(skill, lifetime share) = ${corr(sk, T.map((t) => t.share)).toFixed(2)}, r(skill, survived) = ${corr(sk, T.map((t) => (t.alive ? 1 : 0))).toFixed(2)}, r(skill, hit%) = ${corr(sk.filter((_, i) => T[i].shots > 2), T.filter((t) => t.shots > 2).map((t) => t.hits / t.shots)).toFixed(2)}`);
  for (const [lo, hi, name] of [[0, 0.35, 'potato (<0.35)'], [0.35, 0.65, 'average'], [0.65, 1.01, 'unicum (>0.65)']]) {
    const L = T.filter((t) => t.skill >= lo && t.skill < hi);
    const sh = L.reduce((a, t) => a + t.shots, 0), hi2 = L.reduce((a, t) => a + t.hits, 0);
    const pe2 = L.reduce((a, t) => a + t.pens, 0);
    console.log(`  ${name.padEnd(15)} n=${String(L.length).padStart(4)}  dmg/hp ${mean(L.map((t) => t.dmg / t.hp)).toFixed(2)}  survived ${pct(L.filter((t) => t.alive).length, L.length)}  life ${mean(L.map((t) => t.life / 60)).toFixed(1)} min  shots ${(sh / Math.max(1, L.length)).toFixed(1)}  hit ${pct(hi2, sh)}  pen ${pct(pe2, hi2)}  kills ${mean(L.map((t) => t.kills)).toFixed(2)}  recv/hp ${mean(L.map((t) => t.received / t.hp)).toFixed(2)}`);
  }
  // how bots die (state at death) by skill bucket
  const D = R.flatMap((r) => r.deaths || []);
  for (const [lo, hi, name] of [[0, 0.35, 'potato'], [0.65, 1.01, 'unicum']]) {
    const L = D.filter((x) => x.skill >= lo && x.skill < hi), c = {};
    for (const x of L) c[x.state] = (c[x.state] || 0) + 1;
    console.log(`  deaths ${name}: ${Object.entries(c).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + ' ' + pct(v, L.length)).join(', ')}; killer dist ${mean(L.filter((x) => x.d >= 0).map((x) => x.d)).toFixed(0)} m; t ${mean(L.map((x) => x.t)).toFixed(0)} s`);
  }
  const bins = [60, 120, 180, 240, 360, 600, 1e9], bc = bins.map(() => 0);
  for (const x of D) bc[bins.findIndex((b) => x.t < b)]++;
  console.log(`  deaths by time: ${bins.map((b, i) => (i ? bins[i - 1] : 0) + '–' + (b > 1e8 ? '' : b) + 's ' + pct(bc[i], D.length)).join(', ')}; kill distance ${['<100', '100–200', '200–300', '300–400', '400+'].map((k, i) => k + ' ' + pct(D.filter((x) => x.d >= i * 100 && (i === 4 || x.d < i * 100 + 100)).length, D.length)).join(', ')}`);
  const ai = mean(R.map((r) => r.aiMsPerBotTick)), sim = mean(R.map((r) => r.simMsPerTick));
  console.log(`\nAI ${ai.toFixed(3)} ms per bot per tick (max ${Math.max(...R.map((r) => r.aiMsPerBotTick)).toFixed(3)}), ${mean(R.map((r) => r.aiMsPerTick)).toFixed(2)} ms per tick; sim ${sim.toFixed(2)} ms per tick; unsticks/tank ${mean(T.map((t) => t.unsticks)).toFixed(2)}`);
}
