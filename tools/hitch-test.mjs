// Hitch test: a scripted 15 v 15 brawl. The enemy team is teleported in front of the player (mass
// spotting), then both teams fight at close range (volleys). Reports the worst main-thread frame
// (JS time: the whole frame minus the WebGL render call, which is SwiftShader rasterisation here)
// in the frames right after spot events and in frames with many shots/hits/impacts, plus the
// shader programs compiled mid-battle (each one is a real-GPU hitch on Windows/ANGLE).
// Usage: tools/capped.sh -- node tools/hitch-test.mjs [q=medium] [secs=40] [map=ashford]
import { startServer, openBrowser, PORT } from './lib-browser.mjs';

const arg = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')));
const q = arg.q || 'medium', secs = +(arg.secs || 40), map = arg.map || 'ashford';
const server = await startServer();
const { browser, page, errors } = await openBrowser({ w: 1024, h: 576 });
try {
  await page.goto(`http://127.0.0.1:${PORT}/index.html?auto=1&size=15&q=${q}&map=${map}&seed=7&countdown=0&god=1&debug=hitch${arg.scale ? `&scale=${arg.scale}` : ""}`, { waitUntil: 'domcontentloaded' });
  const logs = []; page.on('console', (m) => { if (!m.text().startsWith('[hitch]')) logs.push(m.type() + ': ' + m.text()); });
  try { await page.waitForFunction(() => window.__sf && window.__sf.state().phase === 'play', null, { timeout: 400000, polling: 500 }); }
  catch (e) { console.log('not in play:', JSON.stringify(await page.evaluate(() => window.__sf && window.__sf.state())), '\n' + errors.concat(logs).join('\n')); throw e; }
  await page.mouse.click(512, 288);
  await page.evaluate(() => {
    const S = window.__sf.session; try { window.__sf.audio.unlock(); } catch { /* */ }
    const recs = window.__recs = [];
    const orig = S._spike.bind(S);
    S._spike = (cpu, sim, ai, render, hud, audio) => {
      const V = S.view._stats, gl = Math.max(0, render - (V.ev || 0) - (V.fx || 0) - (V.tanks || 0));
      const ev = {}; for (const e of S.events) { const k = e.type === 'spot' ? (e.on ? 'spotOn' : 'spotOff') : e.type; ev[k] = (ev[k] || 0) + 1; }
      orig(cpu, sim, ai, render, hud, audio);
      recs.push({ t: S.world.time, cpu, js: cpu - gl, gl, sim, ai, tanks: V.tanks || 0, fx: (V.ev || 0) + (V.fx || 0), hud, audio, progs: V.progs || 0, ev });
    };
  });
  await page.waitForTimeout(3000);
  // teleport: enemies 110–160 m in front of the player, allies around the player
  await page.evaluate(() => {
    const S = window.__sf.session, w = S.world, me = S.player, v = S.view;
    const fx = Math.sin(me.yaw), fz = Math.cos(me.yaw), rx = fz, rz = -fx;
    let a = 0, b = 0;
    for (const t of w.tanks) {
      if (!t.alive) continue;
      const enemy = t.team !== me.team;
      if (t === me) continue;
      const k = enemy ? a++ : b++, lat = (k - 7) * 9, fwd = enemy ? 130 + (k % 3) * 15 : -10 - (k % 3) * 10;
      t.pos.x = me.pos.x + fx * fwd + rx * lat; t.pos.z = me.pos.z + fz * fwd + rz * lat; t.pos.y = v.heightAt(t.pos.x, t.pos.z) + 0.5;
      t.yaw = enemy ? me.yaw + Math.PI : me.yaw;
      S._snap(t, true);
    }
    window.__tp = window.__recs.length;
  });
  const t0 = Date.now();
  while (Date.now() - t0 < secs * 1000) { await page.waitForTimeout(2000); }
  const R = await page.evaluate(() => ({ recs: window.__recs, tp: window.__tp }));
  const recs = R.recs, after = recs.slice(R.tp);
  const base = recs[R.tp - 1]?.progs ?? recs[0].progs;
  const max = (xs, k = 'js') => xs.reduce((m, r) => (r[k] > m[k] ? r : m), { [k]: 0 });
  const spotIdx = new Set(); after.forEach((r, i) => { if (r.ev.spotOn) for (let j = i; j < Math.min(after.length, i + 6); j++) spotIdx.add(j); });
  const spot = after.filter((r, i) => spotIdx.has(i));
  const volley = after.filter((r) => (r.ev.shot || 0) + (r.ev.hit || 0) + (r.ev.impact || 0) >= 4);
  const med = (xs) => { const s = xs.map((r) => r.js).sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };
  const f = (r) => r && r.js ? `${r.js.toFixed(1)} ms JS (sim ${r.sim.toFixed(1)} ai ${r.ai.toFixed(1)} tanks ${r.tanks.toFixed(1)} fx ${r.fx.toFixed(1)} hud ${r.hud.toFixed(1)} audio ${r.audio.toFixed(1)}; gl ${r.gl.toFixed(0)}) ev ${JSON.stringify(r.ev)}` : '-';
  let shots = 0; for (const r of after) shots += r.ev.shot || 0;
  const progsLog = []; for (let i = 1; i < recs.length; i++) if (recs[i].progs > recs[i - 1].progs) progsLog.push(`t=${recs[i].t.toFixed(1)} +${recs[i].progs - recs[i - 1].progs} ${JSON.stringify(recs[i].ev)}`);
  console.log(`frames ${after.length} after teleport, ${shots} shots, spot frames ${spot.length}, volley frames ${volley.length}`);
  console.log(`median JS/frame ${med(after).toFixed(1)} ms`);
  console.log(`worst spot   : ${f(max(spot))}`);
  console.log(`worst volley : ${f(max(volley))}`);
  console.log(`worst overall: ${f(max(after))}`);
  console.log(`shader programs: ${base} at teleport → ${recs[recs.length - 1].progs} at end; compiles in battle:\n  ${progsLog.join('\n  ') || 'none'}`);
  if (errors.length) console.log('errors:\n  ' + errors.join('\n  '));
} finally {
  await browser.close();
  if (server) server.kill();
}
