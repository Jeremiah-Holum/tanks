// node tools/shot.mjs <query> <out.png> [w] [h] [js-to-run-before-render]
// Loads the game paused (SwiftShader is slow), runs the snippet (which can call __tt.*),
// renders a couple of frames, and screenshots.
import { chromium } from 'playwright';
const [q = '', out = 'shot.png', w = 1920, h = 1080, js = ''] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: +w, height: +h } });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(m.type() + ': ' + m.text()); });
page.on('pageerror', (e) => logs.push('pageerror: ' + e.message + '\n' + (e.stack || '').split('\n').slice(0, 4).join('\n')));
page.on('response', (r) => { if (r.status() >= 400) logs.push(r.status() + ' ' + r.url()); });
await page.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, (r) => r.abort());
await page.goto(`http://127.0.0.1:${process.env.TT_PORT || 8477}/index.html?paused&${q}`);
await page.waitForFunction(() => window.__tt, null, { timeout: 90000 }).catch(() => {});
const t0 = Date.now();
const res = await page.evaluate(async (js) => {
  const tt = window.__tt; if (!tt) return 'no __tt';
  let r = null;
  if (js) r = await (new Function('tt', 'return (async () => {' + js + '})()'))(tt);
  tt.view.cam.introT = 1; tt.view.cam.snap = true;
  document.querySelector('.loading')?.remove();
  for (let k = 0; k < 2; k++) tt.renderOnce();
  return r;
}, js).catch((e) => 'eval error: ' + e.message);
console.log('render ms', Date.now() - t0, res != null ? '→ ' + JSON.stringify(res) : '');
await page.waitForTimeout(300);
await page.screenshot({ path: out, timeout: 120000 });
console.log(logs.slice(0, 20).join('\n') || 'no console errors');
await browser.close();
