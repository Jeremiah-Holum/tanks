// node tools/uishots.mjs <outdir> [WxH ...] [--only name,name]
// Screenshots every menu screen (title, garage, versus setup 5v5, versus garage, help, campaign
// select, settings) at each size, reporting any panel whose content overflows its scroll box.
// Run through tools/capped.sh like every browser tool.
import { chromium } from 'playwright';
const args = process.argv.slice(2);
const out = args[0] || 'shots/ui';
const only = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',') : null;
const sizes = args.slice(1).filter((a) => /^\d+x\d+$/.test(a)).map((a) => a.split('x').map(Number));
if (!sizes.length) sizes.push([1280, 720], [1920, 1080]);
const PORT = process.env.TT_PORT || 8477;
const external = (u) => !/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(u) && !u.startsWith('data:');
const fonts = (u) => /^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(u);

const SCENES = {
  title: 'tt.toTitle()',
  garage: 'tt.campaignGarage(0, { fresh: true })',
  'versus-setup': "tt.save().vs = { v: 2, format: 'team', allies: 4, enemies: 5, rounds: 2, map: 0, cls: 'td' }; tt.versusSetup()",
  'versus-garage': "tt.save().vs = { v: 2, format: 'team', allies: 2, enemies: 3, rounds: 2, map: 0, cls: 'td' }; tt.versusSetup(); document.querySelector('button[data-act=\"choose-tank\"]').click()",
  help: "tt.toTitle(); document.querySelector('button[data-act=\"how-to-play\"]').click()",
  'campaign-select': "tt.save().best = 12; tt.toTitle(); document.querySelector('button[data-act=\"campaign\"]').click()",
  settings: "tt.toTitle(); document.querySelector('button[data-act=\"settings\"]').click()",
};

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: sizes[0][0], height: sizes[0][1] } });
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !external(m.location()?.url || '')) errs.push('console: ' + m.text()); });
await page.route((u) => external(u.toString()) && !fonts(u.toString()), (r) => r.abort());
await page.goto(`http://127.0.0.1:${PORT}/index.html?paused&q=low`);
await page.waitForFunction(() => window.__tt, null, { timeout: 90000 });
await page.evaluate(() => document.querySelector('.loading')?.remove());
await page.evaluate(() => document.fonts && document.fonts.ready);
for (const [w, h] of sizes) {
  await page.setViewportSize({ width: w, height: h });
  for (const [name, js] of Object.entries(SCENES)) {
    if (only && !only.includes(name)) continue;
    const info = await page.evaluate(async (js) => {
      const tt = window.__tt;
      new Function('tt', js)(tt);
      await new Promise((r) => setTimeout(r, 400));
      tt.view.cam.introT = 1; tt.view.cam.snap = true; tt.renderOnce();
      const p = document.querySelector('.panel'), b = document.querySelector('.p-body');
      if (!p) return null;
      const r = p.getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), scroll: b ? b.scrollHeight - b.clientHeight : 0 };
    }, js);
    const file = `${out}/${name}-${w}x${h}.png`;
    await page.screenshot({ path: file, timeout: 180000 });
    console.log(file, info ? JSON.stringify(info) : '');
  }
}
console.log(errs.length ? errs.join('\n') : 'no page errors');
await browser.close();
