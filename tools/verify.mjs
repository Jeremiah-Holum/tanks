// node tools/verify.mjs [low|medium|high] [--shots dir]
// Drives the real UI with real clicks and key presses (Playwright), asserting game state via
// window.__tt after every step. The render loop is paused (SwiftShader is slow); frames are
// advanced with __tt.tick so key presses go through the real Input path, and long fights are
// played out by a bot pilot with __tt.sim. Exits non-zero on any console error, page error,
// failed request or failed assertion.
import { chromium } from 'playwright';

const q = process.argv[2] || 'medium';
const shotDir = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null;
const PORT = process.env.TT_PORT || 8477;
const W = 1280, H = 720;

const errors = [];
let steps = 0, failed = 0;
const t0 = Date.now();
const log = (...a) => console.log(`[${q} ${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s]`, ...a);

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: W, height: H } });
const external = (u) => !/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(u) && !u.startsWith('data:');
const fonts = (u) => /^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(u);
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const url = m.location()?.url || '';
  if (url && external(url)) return; // Google Fonts is blocked in the harness
  errors.push('console: ' + m.text() + (url ? ` (${url})` : ''));
});
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message + '\n' + (e.stack || '').split('\n').slice(0, 4).join('\n')));
page.on('requestfailed', (r) => { if (!external(r.url())) errors.push('requestfailed: ' + r.url()); });
page.on('response', (r) => { if (r.status() >= 400 && !external(r.url())) errors.push(r.status() + ' ' + r.url()); });
await page.route((u) => external(u.toString()) && !fonts(u.toString()), (r) => r.abort()); // fonts may load; if offline their errors are ignored above

async function check(name, fn) {
  steps++;
  let ok = false, detail = '';
  try { const r = await fn(); ok = r === true || (r && r.ok); const d = r && r.detail !== undefined ? r.detail : r; detail = typeof d === 'object' ? JSON.stringify(d) : String(d); }
  catch (e) { detail = e.message.split('\n')[0]; }
  if (errors.length) { ok = false; detail += ' | errors: ' + errors.join(' || '); }
  log(ok ? 'PASS' : 'FAIL', name, ok ? '' : '→ ' + detail);
  if (!ok) failed++;
  if (errors.length) { errors.length = 0; }
  return ok;
}
const st = () => page.evaluate(() => window.__tt.state());
const ev = (fn, arg) => page.evaluate(fn, arg);
const tick = (sec = 1 / 60, frames = 1) => ev(([s, f]) => window.__tt.tick(s, f), [sec, frames]);
const key = async (code) => { await page.keyboard.press(code); await tick(1 / 60, 1); };
// Real mouse clicks. Under SwiftShader with the render loop paused, Playwright's "stable" check can
// stall on a panel's fade-in; after 15 s we still click (a real mouse event at the element), just
// without waiting for the animation.
const click = async (sel) => {
  try { await page.click(sel, { timeout: 15000 }); }
  catch (e) {
    if (!/Timeout/.test(e.message)) throw e;
    // the slow click may still have landed (the element is gone): the next check will tell
    if (!(await page.locator(sel).count())) { log('note: click on', sel, 'landed late'); return; }
    log('note: forced click on', sel); await page.locator(sel).first().scrollIntoViewIfNeeded(); await page.click(sel, { timeout: 15000, force: true });
  }
};
const shot = async (name) => { if (shotDir) { await page.waitForTimeout(450); await ev(() => window.__tt.renderOnce()); await page.screenshot({ path: `${shotDir}/${q}-${name}.png`, timeout: 180000 }); } };

// Play the current round out with a bot pilot; returns the state once the scene leaves 'play'
// (results) or the phase goes to 'lost' (between versus rounds).
async function playOut(maxSec = 400, skill = 'ace') {
  await ev((s) => window.__tt.botPlayer(s), skill);
  for (let t = 0; t < maxSec; t += 10) {
    await ev(() => window.__tt.sim(10));
    const s = await st();
    if (s.scene !== 'play' || s.phase === 'lost') return { ...s, t };
  }
  return { ...(await st()), t: maxSec, timeout: true };
}
async function stopBot() { await ev(() => { const tt = window.__tt; tt.G.botPlayer = null; const p = tt.world.tanks.find((t) => t.human); if (p) p.botDriven = false; }); }
// Set the player on fire with no way out: a deterministic knock-out through the real damage path.
async function burnPlayer() {
  await ev(() => { const w = window.__tt.world, p = w.tanks.find((t) => t.human), foe = w.tanks.find((t) => t.team !== p.team && t.alive); p.hp = 1; p.modules.fire = 5; p.modules.fireBy = foe ? foe.id : null; });
}
async function toFight() { await tick(0.5, 6); await page.waitForTimeout(500); } // the mission banner runs 2.4 s of game time, then fades out in real time

// ------------------------------------------------------------------ go
await page.goto(`http://127.0.0.1:${PORT}/index.html?paused&q=${q}`);
await page.waitForFunction(() => window.__tt && window.__tt.G, null, { timeout: 90000 });
await ev(() => { localStorage.removeItem('toytanks.v1'); });
await page.reload();
await page.waitForFunction(() => window.__tt && window.__tt.G, null, { timeout: 90000 });
await ev(() => document.querySelector('.loading')?.remove());
// panels fade in over 0.25 s; under SwiftShader that animation can stall Playwright's "stable" check
await page.addStyleTag({ content: '.fade-in { animation: none !important; }' });
await tick(1 / 60, 2);

await check('title screen', async () => { const s = await st(); const n = await page.locator('.menu button').count(); return { ok: s.scene === 'title' && n >= 4 && (await ev(() => window.__tt.view.quality.name)) === q, detail: { ...s, n } }; });
await shot('title');

// --- campaign → garage
await click('button[data-act="campaign"]');
await check('campaign → garage', async () => { const s = await st(); const n = await page.locator('.gcard').count(); return { ok: s.scene === 'garage' && n === 4, detail: { ...s, n } }; });
await click('.gcard[data-cls="heavy"]');
await check('garage: pick Heavy', async () => ({ ok: (await ev(() => window.__tt.save().cls)) === 'heavy' && (await page.locator('.gcard.on[data-cls="heavy"]').count()) === 1 }));
await check('garage: real model renders (3 stills + 1 live)', async () => ev(() => { const i = [...document.querySelectorAll('.gshot img')].filter((x) => x.complete && x.naturalWidth > 0).length, c = document.querySelectorAll('.gshot canvas').length; return { ok: i === 3 && c === 1, detail: { i, c } }; }));
await shot('garage');
await click('.panel .actions .primary');
await check('garage renderer disposed on roll out', async () => ({ ok: (await ev(() => window.__tt.ui.studio)) == null }));
await check('roll out → mission banner', async () => { const s = await st(); const b = await page.locator('.banner').count(); return { ok: s.scene === 'play' && s.phase === 'banner' && s.cls === 'heavy' && s.mission === 0 && b === 1, detail: { ...s, b } }; });
await toFight();
await check('banner → fight', async () => { const s = await st(); return { ok: s.phase === 'fight', detail: s }; });
await check('HUD: status, reload, reticle; no minimap', async () => {
  return ev(() => {
    const q = (s) => document.querySelector(s);
    const ok = !!q('.status .hpbar') && !!q('.reloadbox') && !q('.reticle').classList.contains('hidden') && !q('.mm') && !q('.marker') && q('.hptext').textContent.includes('/');
    return { ok, detail: { hp: q('.hptext')?.textContent, ret: q('.reticle')?.className, mm: !!q('.mm') } };
  });
});

// --- view toggle
await key('KeyV');
await check('V → tactical', async () => ({ ok: (await ev(() => window.__tt.view.mode)) === 'tactical' }));
await key('KeyV');
await check('V → chase', async () => ({ ok: (await ev(() => window.__tt.view.mode)) === 'chase' }));

// --- pause, settings change, resume
await key('Escape');
await check('Esc → paused', async () => { const s = await st(); return { ok: s.scene === 'paused' && (await page.locator('.panel h2').innerText()).includes('Hold fire'), detail: s }; });
await click('button[data-act="settings"]');
await click('[data-seg="aimline"] button[data-val="false"]');
await check('settings: aim line off', async () => ({ ok: (await ev(() => window.__tt.save().settings.aimLine)) === false }));
await click('[data-seg="aimline"] button[data-val="true"]');
await check('settings: aim line on', async () => ({ ok: (await ev(() => window.__tt.save().settings.aimLine)) === true }));
await click('button[data-act="done"]');
await check('settings → back to pause', async () => { const s = await st(); return { ok: s.scene === 'paused', detail: s }; });
await click('button[data-act="resume"]');
await tick(1 / 60, 1);
await check('resume', async () => { const s = await st(); return { ok: s.scene === 'play' && s.phase === 'fight' && (await page.locator('.panel').count()) === 0, detail: s }; });

// --- fight it out with the bot pilot
let r = await playOut();
await check(`mission 1 played out (${r.t}s game time)`, async () => ({ ok: !r.timeout && r.scene === 'results', detail: r }));
await check('combat feedback fired', async () => { const c = await ev(() => window.__tt.ui.counts); return { ok: c.float > 0 && c.feed > 0, detail: c }; });
await shot('results');
const won = r.outcome === 'won';
await check('results show gunnery stats', async () => {
  const txt = await page.locator('.panel').innerText();
  const n = await page.locator('.statgrid .sg').count();
  return { ok: n >= 8 && /Damage dealt/i.test(txt) && /Penetrations/i.test(txt) && /Ricochets/i.test(txt) && /Shots fired/i.test(txt) && /Damage taken/i.test(txt), detail: { n, won } };
});
if (won) {
  await click('button[data-act="next-mission"]');
  await check('next mission → garage (mission 2)', async () => { const s = await st(); const k = await page.locator('.panel .kicker').first().innerText(); return { ok: s.scene === 'garage' && /Mission 2/i.test(k), detail: { ...s, k } }; });
  await click('.panel .actions .primary');
  await check('mission 2 starts', async () => { const s = await st(); return { ok: s.scene === 'play' && s.mission === 1 && s.cls === 'heavy', detail: s }; });
  await toFight();
} else {
  await click('button[data-act="retry"]');
  await click('.panel .actions .primary');
  await toFight();
}

// --- death → retry (through the garage, switching class)
await stopBot();
const livesBefore = (await st()).lives;
const missionBefore = (await st()).mission;
await burnPlayer();
await ev(() => window.__tt.sim(6));
await check('player knocked out → results', async () => { const s = await st(); const t = await page.locator('.panel h2').innerText().catch(() => ''); return { ok: s.scene === 'results' && s.lives === livesBefore - 1 && /Tank lost/i.test(t), detail: { ...s, t } }; });
await click('button[data-act="retry"]');
await check('retry → garage, same mission', async () => { const s = await st(); const k = await page.locator('.panel .kicker').first().innerText(); return { ok: s.scene === "garage" && k.toLowerCase().includes(`mission ${missionBefore + 1} `), detail: { ...s, k } }; });
await click('.gcard[data-cls="light"]');
await page.keyboard.press('Enter'); // the primary button has focus
await tick(1 / 60, 1);
await check('retry with Light', async () => { const s = await st(); return { ok: s.scene === 'play' && s.cls === 'light' && s.mission === missionBefore, detail: s }; });
await toFight();
await check('__tt.garage pre-selects', async () => ({ ok: (await ev(() => window.__tt.garage('td'))) === 'td' && (await ev(() => window.__tt.save().cls)) === 'td' }));

// --- quit to title
await key('Escape');
await click('button[data-act="quit-to-title"]');
await check('quit → title', async () => { const s = await st(); return { ok: s.scene === 'title' && s.mode === 'attract', detail: s }; });

// --- versus: team battle 3v3
await click('button[data-act="versus"]');
await check('versus setup', async () => ({ ok: (await page.locator('.panel h2').innerText()).includes('Set up a match') }));
await click('[data-seg="format"] button[data-val="team"]');
await click('[data-seg="allies"] button[data-val="2"]');
await click('[data-seg="enemies"] button[data-val="3"]');
await click('[data-seg="rounds"] button[data-val="2"]');
await check('versus: 5 bot slots listed', async () => ({ ok: (await page.locator('.slots .slot').count()) === 5 }));
await page.locator('.slots .slot').nth(2).locator('select[data-sel="cls"]').selectOption('heavy');
await page.locator('.slots .slot').nth(2).locator('select[data-sel="skill"]').selectOption('ace');
await page.locator('.slots .slot').nth(0).locator('select[data-sel="cls"]').selectOption('light');
await click('.map[data-map="0"]');
await shot('versus-setup');
await click('button[data-act="choose-tank"]');
await check('versus setup → garage', async () => { const s = await st(); const k = await page.locator('.panel .kicker').first().innerText(); return { ok: s.scene === 'garage' && (await page.locator('.gcard').count()) === 4 && /Team battle 3 v 3/i.test(k), detail: { ...s, k } }; });
await click('.gcard[data-cls="td"]');
await shot('versus-garage');
await click('button[data-act="roll-out"]');
await check('versus round 1 starts (3v3)', async () => {
  return ev(() => {
    const tt = window.__tt, w = tt.world, s = tt.state();
    const t0 = w.tanks.filter((t) => t.team === 0), t1 = w.tanks.filter((t) => t.team === 1);
    const me = w.tanks.find((t) => t.human);
    const ally0 = t0.find((t) => !t.human && t.label === 'Bravo');
    const foe0 = t1.find((t) => t.label === 'Viper');
    const ok = s.scene === 'play' && s.round === 1 && t0.length === 3 && t1.length === 3 && me.type.cls === 'td' && foe0 && foe0.type.cls === 'heavy' && foe0.skill === 'ace' && ally0 && ally0.type.cls === 'light' && w.mapIndex === 0;
    return { ok, detail: { s, t0: t0.map((t) => t.label + ':' + t.type.cls), t1: t1.map((t) => t.label + ':' + t.type.cls + ':' + t.skill), map: w.mapIndex } };
  });
});
await toFight();
await ev(() => window.__tt.sim(2));
await burnPlayer();
await ev(() => window.__tt.sim(1));
await tick(1 / 60, 1);
await check('knocked out in team battle → spectating an ally', async () => {
  return ev(() => {
    const tt = window.__tt, w = tt.world, s = tt.state(), spec = w.tanks.find((t) => t.id === s.spec);
    const bar = document.querySelector('.spectate');
    return { ok: !s.alive && s.outcome == null && spec && spec.alive && spec.team === 0 && bar && !bar.classList.contains('hidden'), detail: { s, spec: spec && spec.label } };
  });
});
const specA = (await st()).spec;
await key('Tab');
await check('Tab cycles to the other ally', async () => { const s = await st(); const n = await ev(() => window.__tt.world.tanks.filter((t) => t.alive && t.team === 0 && !t.human).length); return { ok: n < 2 || (s.spec !== specA && s.spec != null), detail: { specA, spec: s.spec, n } }; });
await page.mouse.click(W / 2, H / 2);
await tick(1 / 60, 1);
await check('click cycles allies', async () => { const s = await st(); return { ok: s.spec != null, detail: s }; });
await shot('spectate');
// allies fight the round out on their own
r = await (async () => { for (let t = 0; t < 400; t += 10) { await ev(() => window.__tt.sim(10)); const s = await st(); if (s.scene !== 'play' || s.phase === 'lost') return { ...s, t }; } return { ...(await st()), timeout: true }; })();
await check(`round 1 decided (${r.t}s)`, async () => ({ ok: !r.timeout && (r.phase === 'lost' || r.scene === 'results'), detail: r }));
// play rounds with the bot pilot until the match ends
for (let k = 0; k < 4 && (await st()).scene === 'play'; k++) {
  await tick(0.5, 6); // round banner → next round
  const s = await st();
  if (s.scene !== 'play') break;
  await check(`round ${s.round} begins`, async () => ({ ok: s.phase === 'banner' || s.phase === 'fight', detail: s }));
  await toFight();
  r = await playOut();
  await check(`round ${s.round} played out (${r.t}s)`, async () => ({ ok: !r.timeout, detail: r }));
}
await check('match end → results', async () => {
  const s = await st(); const txt = await page.locator('.panel').innerText().catch(() => '');
  return { ok: s.scene === 'results' && /Match (won|lost)/.test(txt) && /Your team/.test(txt) && (await page.locator('.statgrid .sg').count()) >= 8, detail: { s, txt: txt.slice(0, 120) } };
});
await shot('versus-results');
await click('button[data-act="rematch"]');
await check('rematch', async () => { const s = await st(); return { ok: s.scene === 'play' && s.round === 1 && Object.values(s.wins).every((n) => n === 0), detail: s }; });

// --- FFA sanity: 4 tanks, every tank its own team
await key('Escape');
await click('button[data-act="quit-to-title"]');
await click('button[data-act="versus"]');
await click('[data-seg="format"] button[data-val="ffa"]');
await click('[data-seg="ffa"] button[data-val="4"]');
await click('button[data-act="choose-tank"]');
await click('button[data-act="roll-out"]');
await check('FFA x4 starts', async () => ev(() => { const w = window.__tt.world; const teams = new Set(w.tanks.map((t) => t.team)); return { ok: w.tanks.length === 4 && teams.size === 4, detail: [...teams] }; }));

// --- every synthesized sound builds and plays without throwing (headless has no speakers, but the graph runs)
await check('audio: every sound kind plays', async () => ev(() => {
  const a = window.__tt.audio; a.unlock();
  const kinds = ['fire', 'impact', 'ricochet', 'pen', 'nopen', 'boom', 'crate', 'mine', 'trip', 'clash', 'dud', 'burn', 'hitme', 'kill', 'spot', 'ui', 'uiBig', 'win', 'lose', 'banner'];
  for (const k of kinds) a.play(k, { x: 5, z: 5, tank: 999, rocket: k === 'fire', big: true, ammo: true });
  for (const sf of ['wood', 'paper', 'metal', 'plastic', 'stone', 'card', 'frame']) a.play('impact', { x: 3, z: 3, surface: sf });
  const w = window.__tt.world, t = w.tanks.find((q) => q.alive);
  t.modules.fire = 2; a.burning(w); const on = a.burns.size; t.modules.fire = 0; a.burning(w);
  return { ok: !!a.ctx && on >= 1, detail: { ctx: !!a.ctx, on } };
}));

// --- the real render loop, a few seconds, fighting
await toFight();
await ev(() => { window.__tt.botPlayer('veteran'); window.__tt.pause(false); });
await page.waitForTimeout(5000);
await ev(() => window.__tt.pause(true));
await check('real rAF loop runs clean', async () => ({ ok: (await ev(() => window.__tt.G.time)) > 0 }));

await browser.close();
log(`${steps - failed}/${steps} passed`);
process.exit(failed || errors.length ? 1 : 0);
