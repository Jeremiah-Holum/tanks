// Screenshots of the Steel Front menus from tools/ui-lab.html into shots/ui/.
// Run through the browser lock:  tools/capped.sh -- node tools/shot-ui.mjs [screen[:query] ...] [--size 1280x720] [--out dir]
// Default: every screen. Example: node tools/shot-ui.mjs results:result=defeat tree:nation=ussr
// Needs the dev server on :8477 (python3 -m http.server 8477 from the repo root).
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
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
  for (const item of list) {
    const [screen, extra] = item.split(':');
    const t0 = Date.now();
    await page.goto(`http://127.0.0.1:${PORT}/tools/ui-lab.html?screen=${screen}${extra ? '&' + extra : ''}`);
    await page.waitForFunction(() => window.__lab && window.__lab.ready, null, { timeout: 120000 });
    const name = `${out}/${screen}${extra ? '-' + extra.replace(/[^a-z0-9]+/gi, '-') : ''}${W !== 1280 ? '-' + W + 'x' + H : ''}.png`;
    await page.screenshot({ path: name, timeout: 120000 });
    console.log(name, `${Date.now() - t0} ms`);
  }
} finally { await browser.close(); }
console.log(errors ? `${errors} page errors` : 'no page errors');
