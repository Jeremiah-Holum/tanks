// Offline audio checks: renders sounds from src/audio.js with OfflineAudioContext in headless
// Chromium, measures them (peak, RMS, clipping, onset, length to -40 dB, low-band ratio,
// brightness) and asserts sane levels. Also a node import smoke test (no AudioContext).
//   tools/capped.sh -- node tools/audio-render.mjs [--wav DIR] [--only name,name]
// No dev server needed: files are served from disk through Playwright routing.
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname, extname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const wavDir = args.includes('--wav') ? args[args.indexOf('--wav') + 1] : null;
const only = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',') : null;
const SR = 44100;

// ---- 1. node smoke test: importing and calling everything without Web Audio must not throw ----
{
  const { Audio } = await import(join(ROOT, 'src/audio.js'));
  const a = new Audio(); const ok = a.unlock();
  const w = { tanks: [{ id: 1, team: 0, pos: { x: 0, y: 0, z: 0 } }, { id: 2, team: 1, pos: { x: 50, y: 0, z: 0 } }] };
  const L = { pos: { x: 0, y: 0, z: 0 }, fwd: { x: 0, y: 0, z: 1 }, playerId: 1 };
  for (const type of ['shot', 'impact', 'hit', 'kill', 'fire', 'module', 'crew', 'spot', 'treeFall', 'objectBreak', 'ram', 'capture', 'consumable', 'reloaded', 'end', 'bogus'])
    a.event({ type, tank: 1, shooter: 1, target: 2, victim: 2, killer: 1, a: 1, b: 2, team: 0, points: 5, on: true, result: { winner: 0 } }, w, L);
  a.engine(w.tanks[0], L); a.ui('click'); a.music(true); a.music(false); a.say('pen'); a.setVolumes({ master: 0.5, voice: 0 });
  console.log(`node smoke: ok (unlock → ${ok}, stats ${JSON.stringify(a.stats())})`);
}

// ---- 2. scenarios, run in the page. Each gets (A, W, L, ctx, T) and schedules sounds at t≈0. ----
// W: two tanks (player id 1 at origin facing +z, enemy id 2), T(x,z): move the enemy.
const S = {
  shot20_50m:   { dur: 1.5, fn: (A, W, L, c, T) => { T(-50, 0); A.event({ type: 'shot', tank: 2, cal: 20, pos: W.tanks[1].pos }, W, L); } },
  shot88_50m:   { dur: 4, fn: (A, W, L, c, T) => { T(-50, 0); A.event({ type: 'shot', tank: 2, cal: 88, pos: W.tanks[1].pos }, W, L); } },
  shot122_50m:  { dur: 5, fn: (A, W, L, c, T) => { T(-50, 0); A.event({ type: 'shot', tank: 2, cal: 122, pos: W.tanks[1].pos }, W, L); } },
  shot122_own:  { dur: 5, fn: (A, W, L) => { A.event({ type: 'shot', tank: 1, cal: 122 }, W, L); } },
  shot20_own:   { dur: 1.5, fn: (A, W, L) => { W.tanks[0].gunDef.cal = 20; A.event({ type: 'shot', tank: 1, cal: 20 }, W, L); } },
  shot88_600m:  { dur: 5, fn: (A, W, L, c, T) => { T(0, 600); A.event({ type: 'shot', tank: 2, cal: 88, pos: W.tanks[1].pos }, W, L); } },
  pen_confirm:  { dur: 2, fn: (A, W, L, c, T) => { T(0, 250); A.event({ type: 'hit', shooter: 1, target: 2, result: 'pen', cal: 88, pos: W.tanks[1].pos }, W, L); } },
  nopen_inside: { dur: 3.5, fn: (A, W, L) => { A.event({ type: 'hit', shooter: 2, target: 1, result: 'nopen', cal: 122, pos: W.tanks[0].pos }, W, L); } },
  pen_inside:   { dur: 3.5, fn: (A, W, L) => { A.event({ type: 'hit', shooter: 2, target: 1, result: 'pen', cal: 88, pos: W.tanks[0].pos }, W, L); } },
  ricochet_30m: { dur: 2, fn: (A, W, L, c, T) => { T(20, 22); A.event({ type: 'hit', shooter: 3, target: 2, result: 'ricochet', cal: 75, pos: W.tanks[1].pos }, W, L); } },
  track_40m:    { dur: 2, fn: (A, W, L, c, T) => { T(20, 35); A.event({ type: 'hit', shooter: 3, target: 2, result: 'track', cal: 75, pos: W.tanks[1].pos }, W, L); } },
  ammorack_40m: { dur: 6, fn: (A, W, L, c, T) => { T(0, 40); A.event({ type: 'kill', killer: 1, victim: 2, cause: 'ammorack' }, W, L); } },
  he_ground:    { dur: 3, fn: (A, W, L) => { A.event({ type: 'impact', shell: { type: 'HE', cal: 105, owner: 2 }, pos: { x: 10, y: 0, z: 60 }, surface: 'grass' }, W, L); } },
  ap_ground:    { dur: 2, fn: (A, W, L) => { A.event({ type: 'impact', shell: { type: 'AP', cal: 75, owner: 1 }, pos: { x: 10, y: 0, z: 60 }, surface: 'dirt' }, W, L); } },
  ap_water:     { dur: 2.5, fn: (A, W, L) => { A.event({ type: 'impact', shell: { type: 'AP', cal: 75, owner: 1 }, pos: { x: 10, y: 0, z: 60 }, surface: 'water' }, W, L); } },
  tree_fall:    { dur: 3, fn: (A, W, L) => { A.event({ type: 'treeFall', obj: { x: 15, y: 0, z: 15 } }, W, L); } },
  ram_player:   { dur: 2, fn: (A, W, L) => { A.event({ type: 'ram', a: 1, b: 2, dmg: 60 }, W, L); } },
  reload_88:    { dur: 1, fn: (A, W, L) => { A.event({ type: 'reloaded', tank: 1 }, W, L); } },
  ui_click:     { dur: 0.5, fn: (A) => { A.ui('click'); } },
  ui_purchase:  { dur: 1.5, fn: (A) => { A.ui('purchase'); } },
  ui_battle:    { dur: 2.5, fn: (A) => { A.ui('battleStart'); } },
  victory:      { dur: 6, fn: (A, W, L) => { A.event({ type: 'end', result: { winner: 0 } }, W, L); } },
  // engine: player idles 1 s, full throttle 0→top over 3 s with a pivot and turret traverse
  engine_player: { dur: 5, engine: true, fn: (A, W, L, c) => {
    const p = W.tanks[0]; const steps = [];
    for (let t = 0.05; t < 5; t += 0.05) steps.push(t);
    return steps.map((t) => [t, () => { const a = Math.max(0, t - 1); p.throttle = t > 1 ? 1 : 0; p.speed = Math.min(12, a * 4); p.yawRate = t > 3.5 ? 0.5 : 0; p.turretRate = t > 2 && t < 3 ? 0.7 : 0; A.engine(p, L); }]);
  } },
  // CPU check: 7 engine voices + a burning tank for 10 s
  engine_7: { dur: 10, engine: true, cpu: true, fn: (A, W, L, c, T, mk) => {
    const tanks = [W.tanks[0]]; for (let i = 0; i < 9; i++) tanks.push(mk(10 + i, 20 + i * 15, i * 20));
    const steps = []; for (let t = 0.05; t < 10; t += 0.05) steps.push([t, () => { for (const k of tanks) { k.speed = 6 + 4 * Math.sin(t + k.id); A.engine(k, L); } }]);
    steps.unshift([0.02, () => A.event({ type: 'fire', tank: 12, on: true }, W, L)]);
    return steps;
  } },
  music_menu:   { dur: 30, fn: (A) => { A.music('menu'); A.mus.scheduleUntil(30); } },
  ambience:     { dur: 12, fn: (A) => { A.music('battle'); A.mus.nextBoom = 1; A.mus.scheduleUntil(12); } },
};

// ---- 3. checks. m = metrics of the limited render, r = raw (no limiter) render ----
const CHECKS = [
  ['every sound is audible', (M) => Object.entries(M).filter(([n, m]) => m.peak < (n.includes('600m') ? 0.003 : 0.01)).map(([n, m]) => `${n} peak ${m.peak}`)],
  ['no clipping (final)', (M) => Object.entries(M).filter(([, m]) => m.clip > 0 || m.peak >= 1).map(([n, m]) => `${n} clip ${m.clip}`)],
  ['raw peak < 1.0 (headroom before the limiter)', (M) => Object.entries(M).filter(([, m]) => m.raw >= 1).map(([n, m]) => `${n} raw ${m.raw}`)],
  ['calibre ordering: 20 < 88 < 122 in length', (M) => (M.shot20_50m && M.shot88_50m && M.shot122_50m && !(M.shot20_50m.len < M.shot88_50m.len && M.shot88_50m.len < M.shot122_50m.len)) ? [`len ${M.shot20_50m.len} ${M.shot88_50m.len} ${M.shot122_50m.len}`] : []],
  ['calibre ordering: 20 < 88 < 122 in low-band energy', (M) => (M.shot20_50m && M.shot88_50m && M.shot122_50m && !(M.shot20_50m.low < M.shot88_50m.low && M.shot88_50m.low < M.shot122_50m.low)) ? [`low ${M.shot20_50m.low} ${M.shot88_50m.low} ${M.shot122_50m.low}`] : []],
  ['own 122 louder than 122 at 50 m', (M) => (M.shot122_own && M.shot122_50m && M.shot122_own.rms <= M.shot122_50m.rms) ? ['not louder'] : []],
  ['600 m shot delayed by the capped speed of sound (≈0.6 s)', (M) => (M.shot88_600m && Math.abs(M.shot88_600m.onset - 0.61) > 0.06) ? [`onset ${M.shot88_600m.onset}`] : []],
  ['600 m shot darker than 50 m shot', (M) => (M.shot88_600m && M.shot88_50m && M.shot88_600m.zcr >= M.shot88_50m.zcr) ? [`zcr ${M.shot88_600m.zcr} vs ${M.shot88_50m.zcr}`] : []],
  ['enemy to the left pans left', (M) => (M.shot88_50m && M.shot88_50m.pan <= 0.05) ? [`pan ${M.shot88_50m.pan}`] : []],
  ['engine gets louder under throttle', (M) => (M.engine_player && !(M.engine_player.seg[1] > M.engine_player.seg[0] * 1.3)) ? [`seg ${M.engine_player.seg}`] : []],
  ['one-shot lengths sane (< 6 s to -40 dB)', (M) => Object.entries(M).filter(([n, m]) => !/music|ambience|engine/.test(n) && m.len > 6).map(([n, m]) => `${n} len ${m.len}`)],
  ['music and ambience keep playing', (M) => ['music_menu', 'ambience'].filter((n) => M[n] && M[n].seg.some((x) => x < 0.002)).map((n) => `${n} seg ${M[n].seg}`)],
  ['engines + fire render faster than real time ×5', (M) => (M.engine_7 && M.engine_7.speed < 5) ? [`×${M.engine_7.speed}`] : []],
];

const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css' };
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
let failed = 0;
try {
  const page = await browser.newPage();
  const errs = []; page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errs.push(m.text()); });
  await page.route('http://audio.test/**', (r) => {
    const p = new URL(r.request().url()).pathname; const f = join(ROOT, p === '/' ? 'index.html' : p);
    if (p === '/blank') return r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>audio</title>' });
    if (!existsSync(f)) return r.fulfill({ status: 404, body: '' });
    r.fulfill({ contentType: MIME[extname(f)] || 'application/octet-stream', body: readFileSync(f) });
  });
  await page.goto('http://audio.test/blank');
  const M = {};
  for (const [name, sc] of Object.entries(S)) {
    if (only && !only.includes(name)) continue;
    const res = await page.evaluate(async ({ name, dur, fn, SR, engine, wantWav }) => {
      const { Audio } = await import('/src/audio.js');
      const scen = new Function('return ' + fn)();
      const run = async (raw) => {
        const ctx = new OfflineAudioContext(2, Math.ceil(dur * SR), SR);
        const A = new Audio({ context: ctx, raw });
        const mk = (id, x, z) => ({ id, team: 1, alive: true, pos: { x, y: 0, z }, speed: 0, yawRate: 0, turretRate: 0, def: { speed: 50, mass: 30, power: 450 }, gunDef: { cal: 88, reload: 7 }, modules: {} });
        const W = { tanks: [mk(1, 0, 0), mk(2, 0, 50)], shells: [], map: { objects: [] } }; W.tanks[0].team = 0;
        const L = { pos: { x: 0, y: 0, z: 0 }, fwd: { x: 0, y: 0, z: 1 }, playerId: 1 };
        const T = (x, z) => { W.tanks[1].pos = { x, y: 0, z }; };
        const steps = scen(A, W, L, ctx, T, (id, x, z) => { const k = mk(id, x, z); W.tanks.push(k); return k; }) || [];
        for (const [t, f] of steps) ctx.suspend(Math.round(t * SR / 128) * 128 / SR).then(() => { f(); ctx.resume(); });
        const t0 = performance.now(); const buf = await ctx.startRendering(); const ms = performance.now() - t0;
        return { buf, ms };
      };
      const { buf, ms } = await run(false);
      const raw = (await run(true)).buf;
      const L = buf.getChannelData(0), R = buf.getChannelData(1), n = L.length;
      let peak = 0, clip = 0, e = 0, eL = 0, eR = 0, lowE = 0, lp = 0, zc = 0, prev = 0, rawPeak = 0;
      const a = 1 - Math.exp(-2 * Math.PI * 250 / SR);
      for (let i = 0; i < n; i++) {
        const l = L[i], r = R[i], m = (l + r) / 2, al = Math.abs(l), ar = Math.abs(r);
        if (al > peak) peak = al; if (ar > peak) peak = ar; if (al >= 0.999 || ar >= 0.999) clip++;
        e += m * m; eL += l * l; eR += r * r; lp += a * (m - lp); lowE += lp * lp;
        if ((m >= 0) !== (prev >= 0) && Math.abs(m - prev) > 1e-4) zc++; prev = m;
      }
      for (const ch of [raw.getChannelData(0), raw.getChannelData(1)]) for (let i = 0; i < n; i++) { const v = Math.abs(ch[i]); if (v > rawPeak) rawPeak = v; }
      // envelope in 10 ms windows → onset (first > -40 dB re peak) and length (last > -40 dB)
      const win = Math.round(SR * 0.01), thr = peak * 0.01; let on = -1, off = 0;
      for (let i = 0; i < n; i += win) { let m = 0; for (let j = i; j < Math.min(n, i + win); j++) m = Math.max(m, Math.abs(L[j]), Math.abs(R[j])); if (m > thr) { if (on < 0) on = i; off = i + win; } }
      // four RMS segments (for loops)
      const seg = [0, 1, 2, 3].map((s) => { let q = 0; const a0 = Math.floor(n * s / 4), a1 = Math.floor(n * (s + 1) / 4); for (let i = a0; i < a1; i++) q += L[i] * L[i] + R[i] * R[i]; return +Math.sqrt(q / (2 * (a1 - a0))).toFixed(4); });
      if (engine) { const q = seg.slice(); seg.length = 0; seg.push(q[0], (q[2] + q[3]) / 2); }
      const r4 = (v) => +v.toFixed(4);
      const out = { peak: r4(peak), raw: r4(rawPeak), clip, rms: r4(Math.sqrt(e / n)), onset: r4(Math.max(0, on) / SR), len: r4(off / SR), low: r4(lowE / (e || 1)), zcr: Math.round(zc / (n / SR)), pan: r4((Math.sqrt(eR) - Math.sqrt(eL)) / (Math.sqrt(eR) + Math.sqrt(eL) + 1e-9)), seg, speed: r4(dur * 1000 / ms), dc: r4((L.reduce((s, v) => s + v, 0)) / n) };
      if (wantWav) { const i16 = new Int16Array(n * 2); for (let i = 0; i < n; i++) { i16[2 * i] = Math.max(-1, Math.min(1, L[i])) * 32767; i16[2 * i + 1] = Math.max(-1, Math.min(1, R[i])) * 32767; } let s = ''; const u8 = new Uint8Array(i16.buffer); for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); out.wav = btoa(s); }
      return out;
    }, { name, dur: sc.dur, fn: sc.fn.toString(), SR, engine: !!sc.engine, wantWav: !!wavDir });
    if (res.wav) { mkdirSync(wavDir, { recursive: true }); writeFileSync(join(wavDir, name + '.wav'), wav(Buffer.from(res.wav, 'base64'))); delete res.wav; }
    M[name] = res;
    console.log(name.padEnd(14), `peak ${res.peak.toFixed(3)} raw ${res.raw.toFixed(3)} rms ${res.rms.toFixed(4)} clip ${res.clip} onset ${res.onset.toFixed(2)}s len ${res.len.toFixed(2)}s low ${res.low.toFixed(2)} zcr ${String(res.zcr).padStart(5)} pan ${res.pan.toFixed(2)} ×rt ${res.speed.toFixed(0)}` + ((sc.engine || /music|amb/.test(name)) ? ` seg ${res.seg}` : ''));
  }
  console.log('');
  for (const [label, f] of CHECKS) { const bad = f(M); if (bad.length) failed++; console.log((bad.length ? 'FAIL ' : 'ok   ') + label + (bad.length ? ': ' + bad.join('; ') : '')); }
  if (errs.length) { console.log('page errors:\n' + errs.slice(0, 10).join('\n')); failed++; }
  if (wavDir) console.log('WAVs in', wavDir);
} finally { await browser.close(); }
process.exit(failed ? 1 : 0);

function wav(pcm) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22); h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
