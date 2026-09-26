// Screenshots of tools/lab-tanks.html. Run through the machine-wide browser lock:
//   tools/capped.sh -- node tools/shot-tanks.mjs [--w=1280 --h=720] <outdir> name='query' [name='query' ...]
// Each name=query loads lab-tanks.html?query in the same browser, waits for __lab.ready and
// saves <outdir>/<name>.png. A query may carry js=... (URL-encoded) that runs with `lab` first.
import { chromium } from 'playwright';
const args = process.argv.slice(2);
const opt = Object.fromEntries(args.filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')));
const [outdir = 'shots/tanks', ...shots] = args.filter((a) => !a.startsWith('--'));
const W = +(opt.w || 1280), H = +(opt.h || 720);
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const logs = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning' || m.text().startsWith('LAB')) logs.push(m.type() + ': ' + m.text()); });
  page.on('pageerror', (e) => logs.push('pageerror: ' + e.message + '\n' + (e.stack || '').split('\n').slice(0, 5).join('\n')));
  page.on('response', (r) => { if (r.status() >= 400) logs.push(r.status() + ' ' + r.url()); });
  await page.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (r) => r.abort());
  for (const s of shots) {
    const i = s.indexOf('='), name = s.slice(0, i), q = s.slice(i + 1);
    const t0 = Date.now();
    await page.goto(`http://127.0.0.1:${process.env.TT_PORT || 8477}/tools/lab-tanks.html?${q}`);
    const res = await page.waitForFunction(() => window.__lab && window.__lab.done, null, { timeout: 180000, polling: 200 })
      .then(() => page.evaluate(() => window.__lab.info)).catch((e) => 'timeout: ' + e.message.split('\n')[0]);
    await page.screenshot({ path: `${outdir}/${name}.png` });
    console.log(name, Date.now() - t0, 'ms', JSON.stringify(res));
  }
  console.log(logs.slice(0, 30).join('\n') || 'no console errors');
} finally { await browser.close(); }
