// node tools/labshot.mjs <out.png> [w] [h] [js] [query]
// Loads tools/lab.html (render lab, no UI), runs js with `lab`, renders 2 frames, screenshots.
import { chromium } from 'playwright';
const [out = 'shot.png', w = 1920, h = 1080, js = '', q = ''] = process.argv.slice(2);
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: +w, height: +h } });
const logs = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning' || m.text().startsWith('LAB')) logs.push(m.type() + ': ' + m.text()); });
page.on('pageerror', (e) => logs.push('pageerror: ' + e.message + '\n' + (e.stack || '').split('\n').slice(0, 5).join('\n')));
page.on('response', (r) => { if (r.status() >= 400) logs.push(r.status() + ' ' + r.url()); });
await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
await page.goto(`http://127.0.0.1:${process.env.TT_PORT || 8477}/tools/lab.html?${q}`);
await page.waitForFunction(() => window.__lab, null, { timeout: 90000 }).catch(() => {});
const t0 = Date.now();
const res = await page.evaluate(async (js) => {
  const lab = window.__lab; if (!lab) return 'no __lab';
  let r = null;
  if (js) r = await (new Function('lab', 'return (async () => {' + js + '})()'))(lab);
  if (!r || !r.noRender) { const st = lab.frame(2); r = { ret: r, stats: st }; }
  return r;
}, js).catch((e) => 'eval error: ' + e.message);
console.log('ms', Date.now() - t0, JSON.stringify(res));
await page.screenshot({ path: out, timeout: 120000 });
console.log(logs.slice(0, 20).join('\n') || 'no console errors');
await browser.close();
