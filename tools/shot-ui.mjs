// Screenshots of the Steel Front menus from tools/ui-lab.html into shots/ui/.
// Run through the browser lock:  tools/capped.sh -- node tools/shot-ui.mjs [screen[:query] ...] [--size 1280x720] [--out dir]
// Default: every screen. Example: node tools/shot-ui.mjs results:result=defeat tree:nation=ussr
// Needs the dev server on :8477 (python3 -m http.server 8477 from the repo root).
import { chromium } from 'playwright';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { createHash } from 'crypto';
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const [W, H] = opt('--size', '1280x720').split('x').map(Number);
const out = opt('--out', 'shots/ui');
const PORT = process.env.SF_PORT || 8477;
const list = args.length ? args : ['hangar', 'tree', 'details', 'loading', 'results', 'record', 'settings'];
mkdirSync(out, { recursive: true });
const external = (u) => !/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(u) && !u.startsWith('data:') && !u.startsWith('blob:');
const fonts = (u) => /^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(u);
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
let errors = 0;
try {
  const page = await browser.newPage({ viewport: { width: W, height: H }, ignoreHTTPSErrors: true });
  page.on('pageerror', (e) => { errors++; console.log('  pageerror:', e.message); });
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('  console.' + m.type() + ':', m.text()); });
  await page.route((u) => external(u.toString()) && !fonts(u.toString()), (r) => r.abort());
  // Google Fonts: headless Chrome can't use the sandbox proxy, so fetch them with curl (cached).
  const cache = tmpdir() + '/sf-font-cache'; mkdirSync(cache, { recursive: true });
  await page.route((u) => fonts(u.toString()), async (r) => {
    const url = r.request().url(), f = cache + '/' + createHash('md5').update(url).digest('hex');
    try {
      if (!existsSync(f)) writeFileSync(f, execFileSync('curl', ['-sfL', '--max-time', '20', '-A', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36', url]));
      const css = url.includes('googleapis');
      await r.fulfill({ status: 200, body: readFileSync(f), headers: { 'content-type': css ? 'text/css' : 'font/woff2', 'access-control-allow-origin': '*' } });
    } catch { await r.abort(); }
  });
  for (const item of list) {
    const [screen, extra] = item.split(':');
    const t0 = Date.now();
    await page.goto(`http://127.0.0.1:${PORT}/tools/ui-lab.html?screen=${screen}${extra ? '&' + extra : ''}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => window.__lab && window.__lab.ready, null, { timeout: 120000 });
    const name = `${out}/${screen}${extra ? '-' + extra.replace(/[^a-z0-9]+/gi, '-') : ''}${W !== 1280 ? '-' + W + 'x' + H : ''}.png`;
    await page.screenshot({ path: name, timeout: 120000 });
    console.log(name, `${Date.now() - t0} ms`);
  }
} finally { await browser.close(); }
console.log(errors ? `${errors} page errors` : 'no page errors');
