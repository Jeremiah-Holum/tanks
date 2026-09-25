// End-to-end check of the real game flow with real input (Playwright + SwiftShader):
// hangar → pick a tank → BATTLE! → loading → countdown (skipped with Space) → drive (W), turn the
// turret (mouse), fire (LMB), switch shells (1/3), sniper mode (Shift + wheel), score panel (Tab),
// minimap size (M), Esc menu → resume, then wait for the battle to end → results → garage.
// ?fast=1 makes the battle short (150 s of sim), runs the sim 3× and gives the player god mode.
// Fails on any console error or page error. Screenshots: shots/verify/<quality>/NN-step.png.
//   tools/capped.sh -- node tools/verify.mjs [low|medium|high]
// Run one quality at a time (one browser on the machine).
import { startServer, openBrowser, PORT } from './lib-browser.mjs';
import { mkdirSync, rmSync } from 'fs';

const q = process.argv[2] || 'low';
const W = 1280, H = 720;
const dir = `shots/verify/${q}`;
rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
const T0 = Date.now();
const log = (...a) => console.log(`[${q} ${((Date.now() - T0) / 1000).toFixed(0).padStart(4)}s]`, ...a);
let failed = 0, n = 0, shotN = 0;

const server = await startServer();
const { browser, page, errors } = await openBrowser({ w: W, h: H });
const st = () => page.evaluate(() => window.__sf.state());
const wait = (ms) => page.waitForTimeout(ms);
const shot = async (name) => { const f = `${dir}/${String(++shotN).padStart(2, '0')}-${name}.png`; await page.screenshot({ path: f, timeout: 240000 }); return f; };
async function check(name, fn) {
  n++;
  let ok = false, detail = '';
  try { const r = await fn(); ok = r === true || !!(r && r.ok); detail = r && r.detail !== undefined ? r.detail : ''; }
  catch (e) { detail = e.message.split('\n')[0]; }
  if (errors.length) { ok = false; detail += ' | ' + errors.splice(0).join(' || '); }
  log(ok ? 'PASS' : 'FAIL', name, detail ? '· ' + (typeof detail === 'object' ? JSON.stringify(detail) : detail) : '');
  if (!ok) failed++;
  return ok;
}
const until = async (fn, timeout = 60000, poll = 250) => {
  const t = Date.now();
  while (Date.now() - t < timeout) { const r = await fn(); if (r) return r; await wait(poll); }
  return null;
};
// relative mouse move in small steps (the game ignores single jumps > 300 px)
let mx = W / 2, my = H / 2;
const moveBy = async (dx, dy, steps = 8) => { for (let i = 0; i < steps; i++) { mx += dx / steps; my += dy / steps; await page.mouse.move(mx, my); await wait(30); } };
const perfNote = (s) => s.perf && s.perf.fps ? `${s.perf.fps.toFixed(1)} fps, frame ${s.perf.frame.toFixed(0)} ms (sim ${s.perf.sim.toFixed(2)}, ai ${s.perf.ai.toFixed(2)}, render cpu ${s.perf.render.toFixed(1)}, hud ${s.perf.hud.toFixed(2)} ms), ${s.perf.calls} calls, ${(s.perf.tris / 1e6).toFixed(2)} M tris` : '';

try {
  await check('boot → hangar', async () => {
    await page.goto(`http://127.0.0.1:${PORT}/index.html?fast=1&q=${q}&perf=1`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.hangar .sf-battle', { timeout: 120000 });
    await wait(1500);
    await shot('hangar');
    const s = await st();
    return { ok: s.screen === 'hangar', detail: s.screen };
  });

  await check('pick a tank in the carousel', async () => {
    const before = await page.evaluate(() => window.__sf.screens.profile.selected);
    const cards = await page.$$('.car-card:not(.add):not(.on)');
    if (!cards.length) return { ok: false, detail: 'no other tank card' };
    await cards[0].click({ timeout: 60000 });
    await wait(1500);
    const after = await page.evaluate(() => window.__sf.screens.profile.selected);
    await shot('hangar-picked');
    return { ok: after !== before, detail: `${before} → ${after}` };
  });

  await check('BATTLE! → loading screen', async () => {
    await page.click('.sf-battle', { timeout: 60000 });
    await page.waitForSelector('.loading', { timeout: 60000 });
    await until(async () => (await page.evaluate(() => { const b = document.querySelector('.ld-pct'); return b && parseInt(b.textContent) >= 15; })), 60000, 100);
    await shot('loading');
    return true;
  });

  await check('loading → countdown', async () => {
    const s = await until(async () => { const s = await st(); return s.phase === 'countdown' || s.phase === 'play' ? s : null; }, 240000, 500);
    await wait(800);
    await shot('countdown');
    return { ok: !!s, detail: s && s.phase };
  });

  await check('Space skips the countdown', async () => {
    await page.mouse.move(mx, my);
    await page.keyboard.press('Space');
    const s = await until(async () => { const s = await st(); return s.phase === 'play' ? s : null; }, 20000);
    return { ok: !!s, detail: s && `t=${s.time}` };
  });

  await check('W drives forward', async () => {
    const a = await st();
    await page.keyboard.down('KeyW');
    await until(async () => { const s = await st(); return Math.hypot(s.player.x - a.player.x, s.player.z - a.player.z) > 4; }, 30000);
    const b = await st();
    await shot('driving');
    await page.keyboard.up('KeyW');
    const d = Math.hypot(b.player.x - a.player.x, b.player.z - a.player.z);
    return { ok: d > 4, detail: `moved ${d.toFixed(1)} m, speed ${b.player.speed} m/s` };
  });

  await check('mouse turns the camera and the turret follows', async () => {
    const a = await st();
    await moveBy(260, 0, 10);
    const b = await until(async () => { const s = await st(); return Math.abs(s.player.turretYaw - a.player.turretYaw) > 0.3 ? s : null; }, 30000);
    await shot('turret-turned');
    const s = b || (await st());
    return { ok: !!b && Math.abs(s.cam.yaw - a.cam.yaw) > 0.3, detail: `cam yaw ${a.cam.yaw} → ${s.cam.yaw}, turret ${a.player.turretYaw} → ${s.player.turretYaw}` };
  });

  await check('LMB fires several shots', async () => {
    const a = await st();
    let shots = a.player.shots;
    for (let i = 0; i < 4; i++) {
      await until(async () => (await st()).player.reload <= 0, 30000, 150);
      await page.mouse.down(); await wait(80); await page.mouse.up();
      await until(async () => (await st()).player.shots > shots, 10000, 100);
      shots = (await st()).player.shots;
      if (i === 0) { await wait(250); await shot('firing'); }
    }
    const b = await st();
    return { ok: b.player.shots - a.player.shots >= 3, detail: `${b.player.shots - a.player.shots} shots, ammo ${b.player.ammo.join('/')}` };
  });

  await check('3 / 1 switch shells', async () => {
    const s0 = await st();
    const k = s0.player.ammo[2] > 0 ? 3 : 2;
    await page.keyboard.press('Digit' + k);
    const a = await until(async () => { const s = await st(); return s.player.shell === k - 1 ? s : null; }, 10000);
    await wait(300);
    await shot('shell-switched');
    await page.keyboard.press('Digit1');
    const b = await until(async () => { const s = await st(); return s.player.shell === 0 ? s : null; }, 10000);
    return { ok: !!a && !!b, detail: `shell ${a && a.player.shell} then ${b && b.player.shell}` };
  });

  await check('R reloads the selected shell type', async () => {
    await until(async () => (await st()).player.reload <= 0, 30000, 150);
    await page.keyboard.press('KeyR');
    const s = await until(async () => { const s = await st(); return s.player.reload > 0 ? s : null; }, 5000, 50);
    return { ok: !!s && s.player.shell === 0, detail: s && `reload ${s.player.reload} s, shell ${s.player.shell}` };
  });

  await check('Shift → sniper mode, wheel zooms ×4', async () => {
    await page.keyboard.press('ShiftLeft');
    const a = await until(async () => { const s = await st(); return s.cam.sniper ? s : null; }, 10000);
    await page.mouse.wheel(0, -100);
    const b = await until(async () => { const s = await st(); return s.cam.zoom === 4 ? s : null; }, 10000);
    await wait(600);
    await shot('sniper-x4');
    await page.keyboard.press('ShiftLeft');
    const c = await until(async () => { const s = await st(); return !s.cam.sniper ? s : null; }, 10000);
    return { ok: !!a && !!b && !!c, detail: `sniper ${!!a}, zoom ${b && b.cam.zoom}, back to arcade ${!!c}` };
  });

  await check('wheel zooms the arcade camera out', async () => {
    const a = await st();
    for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, 100); await wait(120); }
    const b = await until(async () => { const s = await st(); return s.cam.dist > a.cam.dist + 3 ? s : null; }, 10000);
    return { ok: !!b, detail: `dist ${a.cam.dist} → ${b && b.cam.dist}` };
  });

  await check('Tab shows the score panel', async () => {
    await page.keyboard.down('Tab');
    const a = await until(async () => { const s = await st(); return s.score ? s : null; }, 10000);
    await wait(700);
    await shot('score-panel');
    await page.keyboard.up('Tab');
    const b = await until(async () => { const s = await st(); return !s.score ? s : null; }, 10000);
    const vis = await page.evaluate(() => document.querySelectorAll('.hud-scorepanel .sp-row:not(.head)').length);
    return { ok: !!a && !!b && vis >= 4, detail: `${vis} rows` };
  });

  await check('M cycles the minimap size', async () => {
    const w0 = await page.evaluate(() => document.querySelector('.hud-mini-cv').clientWidth);
    await page.keyboard.press('KeyM');
    await wait(400);
    const w1 = await page.evaluate(() => document.querySelector('.hud-mini-cv').clientWidth);
    return { ok: w1 !== w0, detail: `${w0} → ${w1} px` };
  });

  await check('Esc opens the battle menu, Resume closes it', async () => {
    await page.keyboard.press('Escape');
    const a = await until(async () => { const s = await st(); return s.menu ? s : null; }, 10000);
    await wait(300);
    await shot('esc-menu');
    await page.click('.hud-menu.on .hm-btn', { timeout: 30000 });
    const b = await until(async () => { const s = await st(); return !s.menu ? s : null; }, 10000);
    return { ok: !!a && !!b, detail: '' };
  });

  let mid = null;
  await check('battle plays out to the end (god mode, fast sim)', async () => {
    // keep driving and shooting a little on the way
    await page.keyboard.down('KeyW');
    let shotMid = false;
    const end = await until(async () => {
      const s = await st();
      if (!shotMid && s.time > 60) { shotMid = true; mid = s; await page.keyboard.up('KeyW'); await shot('mid-battle'); log('  mid-battle:', perfNote(s)); }
      if (s.phase === 'ending' && !mid?.endShot) { mid = { ...(mid || {}), endShot: true }; await shot('result-banner'); }
      return s.state === 'results' ? s : null;
    }, 420000, 400);
    await page.keyboard.up('KeyW');
    return { ok: !!end, detail: end && `report ${JSON.stringify(end.lastReport)}` };
  });

  await check('results screen shows the report', async () => {
    await page.waitForSelector('.rs-garage', { timeout: 60000 });
    await wait(1200);
    await shot('results');
    const r = await page.evaluate(() => window.__sf.lastReport);
    return { ok: !!r && typeof r.xp?.total === 'number', detail: r && `${r.result}, ${r.xp.total} XP, ${r.credits.net ?? r.credits.total} credits, battle ${r.duration} s` };
  });

  await check('back to the garage', async () => {
    await page.click('.rs-garage', { timeout: 60000 });
    await page.waitForSelector('.hangar .sf-battle', { timeout: 120000 });
    await wait(1500);
    await shot('hangar-after');
    const s = await st();
    const canvases = await page.evaluate(() => document.querySelectorAll('canvas.battle-canvas, .hud').length);
    return { ok: s.screen === 'hangar' && canvases === 0, detail: `screen ${s.screen}, leftover battle nodes ${canvases}` };
  });
} finally {
  await browser.close();
  if (server) server.kill();
}
log(`${n - failed}/${n} passed${failed ? `, ${failed} FAILED` : ''}. Screenshots in ${dir}/`);
process.exit(failed ? 1 : 0);
