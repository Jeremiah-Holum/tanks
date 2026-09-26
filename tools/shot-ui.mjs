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
const flow = args.includes('--flow'); if (flow) args.splice(args.indexOf('--flow'), 1);
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
  if (flow) await runFlow(page);
  else for (const item of list) {
    const [screen, extra] = item.split(':');
    const t0 = Date.now();
    await page.goto(`http://127.0.0.1:${PORT}/tools/ui-lab.html?screen=${screen}${extra ? '&' + extra : ''}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => window.__lab && window.__lab.ready, null, { timeout: 120000 });
    const name = `${out}/${screen}${extra ? '-' + extra.replace(/[^a-z0-9]+/gi, '-') : ''}${W !== 1280 ? '-' + W + 'x' + H : ''}.png`;
    await page.screenshot({ path: name, timeout: 120000 });
    console.log(name, `${Date.now() - t0} ms`);
  }
} finally { await browser.close(); }

// --flow: click through research → buy → garage → battle → settings on a fresh profile and assert the state.
async function runFlow(page) {
  const check = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) errors++; };
  await page.goto(`http://127.0.0.1:${PORT}/tools/ui-lab.html?screen=tree&nation=usa&fresh`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__lab && window.__lab.ready, null, { timeout: 120000 });
  await page.evaluate(() => { const S = window.__lab.screens; S.profile.tanks.usa_t1.xp = 400; S.showTree('usa'); });
  await page.waitForTimeout(400);
  await page.hover('.tn[data-id="usa_m3stuart"]'); await page.waitForTimeout(250);
  await page.screenshot({ path: `${out}/flow-tree-tooltip.png` });
  await page.click('.tn[data-id="usa_m2lt"]');
  await page.waitForSelector('.sf-modal.confirm'); await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/flow-research-dialog.png` });
  await page.click('.sf-modal .sf-btn.primary');
  await page.waitForTimeout(300);
  check(await page.evaluate(() => window.__lab.screens.profile.researched.includes('usa_m2lt')), 'research via tree dialog');
  await page.click('.tn[data-id="usa_m2lt"]');
  await page.waitForSelector('.sf-modal.confirm'); await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/flow-buy-dialog.png` });
  await page.click('.sf-modal .sf-btn.primary');
  await page.waitForTimeout(300);
  const st = await page.evaluate(() => { const p = window.__lab.screens.profile; return { owned: p.tanks.usa_m2lt.owned, credits: p.credits, sel: p.selected }; });
  check(st.owned && st.sel === 'usa_m2lt', `buy via tree dialog (credits left ${st.credits})`);
  await page.click('.tn[data-id="usa_m2lt"]');
  await page.waitForSelector('.hangar');
  await page.waitForTimeout(1500);
  check(await page.evaluate(() => document.querySelector('.car-card.on')?.dataset.id === 'usa_m2lt'), 'owned node opens the garage with it selected');
  await page.click('.hg-mode:nth-child(2)');
  check(await page.evaluate(() => window.__lab.screens.battleSize === 7), 'skirmish 7v7 selected');
  await page.click('.shell:nth-child(1) .stepper button:first-child');
  const ammo = await page.evaluate(() => window.__lab.screens.profile.tanks.usa_m2lt.ammo.slice());
  check(ammo.reduce((a, b) => a + b, 0) < 999, `ammo stepper works (${ammo.join('/')})`);
  await page.click('.sf-iconbtn[title="Settings"]');
  await page.click('.st-tab:nth-child(3)');
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${out}/flow-settings-audio.png` });
  await page.click('.st-toggle');
  await page.click('.sf-modal .sf-btn.primary');
  check(await page.evaluate(() => window.__lab.screens.profile.settings.voice === false), 'settings apply (voice off)');
  await page.click('.sf-battle');
  await page.waitForSelector('.loading');
  const b = await page.evaluate(() => ({ n: document.querySelectorAll('.ld-team.ally .ld-row').length, me: document.querySelector('.ld-row.me .ld-tank')?.textContent }));
  check(b.n === 7 && /M2/.test(b.me || ''), `BATTLE! builds a 7v7 and shows the loading screen (${b.n} rows, player in ${b.me})`);
  await page.screenshot({ path: `${out}/flow-loading-7v7.png` });
}
console.log(errors ? `${errors} page errors` : 'no page errors');
