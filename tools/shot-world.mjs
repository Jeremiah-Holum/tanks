// Headless screenshots of the world lab (tools/lab-world.html).
//   tools/capped.sh -- node tools/shot-world.mjs [--w 1280 --h 720] name='map=ashford&x=500&z=300&yaw=0' ...
// Shots go to shots/world/<name>.png. Shots with the same map / q / time / tanks share one page
// load (the camera is moved with lab.set). Prints stats (draw calls, triangles) per shot.
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const args = process.argv.slice(2);
let W = 1280, H = 720, frames = 3;
const shots = [];
for (let k = 0; k < args.length; k++) {
  if (args[k] === '--w') W = +args[++k]; else if (args[k] === '--h') H = +args[++k]; else if (args[k] === '--frames') frames = +args[++k];
  else { const i = args[k].indexOf('='); shots.push({ name: args[k].slice(0, i), q: args[k].slice(i + 1) }); }
}
if (!shots.length) shots.push({ name: 'default', q: 'map=ashford' });
mkdirSync('shots/world', { recursive: true });
const port = process.env.TT_PORT || 8477;
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const logs = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning' || m.text().startsWith('LAB')) logs.push(m.type() + ': ' + m.text()); });
  page.on('pageerror', (e) => logs.push('pageerror: ' + e.message + '\n' + (e.stack || '').split('\n').slice(0, 4).join('\n')));
  page.on('response', (r) => { if (r.status() >= 400) logs.push(r.status() + ' ' + r.url()); });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (r) => r.abort());
  const key = (p) => ['map', 'q', 'time', 'tanks'].map((k) => p.get(k)).join('|');
  let cur = null;
  for (const s of shots) {
    const p = new URLSearchParams(s.q);
    const t0 = Date.now();
    if (key(p) !== cur) {
      await page.goto(`http://127.0.0.1:${port}/tools/lab-world.html?${s.q}`);
      await page.waitForFunction(() => window.__lab, null, { timeout: 240000 });
      cur = key(p);
    } else await page.evaluate((q) => window.__lab.set(Object.fromEntries(new URLSearchParams(q))), s.q);
    const st = await page.evaluate((n) => window.__lab.frame(n), frames);
    if (process.env.CENSUS) console.log(JSON.stringify(await page.evaluate(() => window.__lab.census())));
    await page.screenshot({ path: `shots/world/${s.name}.png`, timeout: 120000 });
    console.log(`${s.name}: ${Date.now() - t0} ms  calls ${st.calls}  tris ${st.tris}  cpu ${st.ms.toFixed(0)} ms  load ${st.loadMs} ms`);
  }
  console.log(logs.slice(0, 25).join('\n') || 'no console errors');
} finally { await browser.close(); }
