// Screenshot a battle at a given moment.
//   tools/capped.sh -- node tools/shot-game.mjs [--out shots/game] [--size 1280x720] name='query' ...
// query = index.html params (map, tank, t = seconds to fast-forward with the player on autopilot,
// q, size, seed, …) plus tool-only ones: press=ShiftLeft,Wheel+2 (keys/wheel after load),
// hold=Tab (held during the shot), yaw=deg (turn the camera), wait=ms (default 1500).
// Example: node tools/shot-game.mjs a='map=ashford&tank=usa_m4&t=45&q=medium' s='map=steppe&t=60&press=ShiftLeft,Wheel+1'
import { startServer, openBrowser, PORT } from './lib-browser.mjs';
import { mkdirSync } from 'fs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const out = opt('--out', 'shots/game');
const [W, H] = opt('--size', '1280x720').split('x').map(Number);
mkdirSync(out, { recursive: true });
const specs = args.map((a) => { const k = a.indexOf('='); return [a.slice(0, k), a.slice(k + 1)]; });
if (!specs.length) specs.push(['battle', 'map=ashford&t=40']);

const server = await startServer();
const { browser, page, errors } = await openBrowser({ w: W, h: H });
let bad = 0;
try {
  for (const [name, query] of specs) {
    const q = new URLSearchParams(query);
    const press = (q.get('press') || '').split(',').filter(Boolean), hold = (q.get('hold') || '').split(',').filter(Boolean);
    const yaw = q.has('yaw') ? +q.get('yaw') : null, wait = +(q.get('wait') || 1500);
    for (const k of ['press', 'hold', 'yaw', 'wait']) q.delete(k);
    if (!q.has('countdown')) q.set('countdown', '0');
    q.set('auto', '1');
    const t0 = Date.now();
    await page.goto(`http://127.0.0.1:${PORT}/index.html?${q}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__sf && ['play', 'dead', 'countdown'].includes(window.__sf.state().phase), null, { timeout: 300000, polling: 500 });
    await page.mouse.move(W / 2, H / 2);
    if (yaw != null) await page.evaluate((y) => { const c = window.__sf.session.cam; c.yaw += y * Math.PI / 180; }, yaw);
    for (const p of press) {
      const m = /^Wheel\s*([+-]?\d+)$/.exec(p);
      if (m) { const n = +m[1]; for (let i = 0; i < Math.abs(n); i++) { await page.mouse.wheel(0, n > 0 ? -100 : 100); await page.waitForTimeout(150); } }
      else { await page.keyboard.press(p); await page.waitForTimeout(150); }
    }
    for (const k of hold) await page.keyboard.down(k);
    await page.waitForTimeout(wait);
    const file = `${out}/${name}.png`;
    console.log('  before shot', JSON.stringify((await page.evaluate(() => window.__sf.state())).perf));
    await page.screenshot({ path: file, timeout: 180000 });
    for (const k of hold) await page.keyboard.up(k);
    const st = await page.evaluate(() => window.__sf.state());
    console.log(file, `${Date.now() - t0} ms`, `t=${st.time}`, st.perf && st.perf.fps ? `fps ${st.perf.fps.toFixed(1)} frame ${st.perf.frame.toFixed(0)} ms render ${st.perf.render.toFixed(0)} ms calls ${st.perf.calls} tris ${(st.perf.tris / 1e6).toFixed(2)}M` : '');
    if (errors.length) { bad++; console.log('  errors:\n   ' + errors.join('\n   ')); errors.length = 0; }
  }
} finally {
  await browser.close();
  if (server) server.kill();
}
process.exit(bad ? 1 : 0);
