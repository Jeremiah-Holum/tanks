// Game shell: state machine, controls, campaign + versus flow, Director, render loop.
import { View } from './render/view.js';
import { campaignWorld, versusWorld } from './sim/game.js';
import { step, DT, BARREL, TANK_R, SHELL_R, moveShell, shellLineClear } from './sim/world.js';
import { brainStep } from './sim/ai.js';
import { TYPES, PERSONALITIES } from './sim/tanks.js';
import { CAMPAIGN, VERSUS, roster } from './sim/levels.js';
import { newDirector, recordResult, missionThreat, effectiveRating, SKILL_THREAT } from './sim/director.js';
import { Input } from './input.js';
import { Audio } from './audio.js';
import { UI, VS_COLORS, VS_NAMES } from './ui.js';

const params = new URLSearchParams(location.search);
const SAVE_KEY = 'toytanks.v1';
const defaults = () => ({ best: 0, dir: newDirector(), settings: { quality: 'auto', view: 'chase', aimLine: true, sens: 1, master: 0.8, sfx: 0.9, music: 0.45, adaptive: true }, vs: null, stats: { games: 0 } });
let save = defaults();
try { const s = JSON.parse(localStorage.getItem(SAVE_KEY)); if (s) save = { ...defaults(), ...s, settings: { ...defaults().settings, ...s.settings }, dir: { ...newDirector(), ...s.dir } }; } catch {}
const persist = () => { try { localStorage.setItem(SAVE_KEY, JSON.stringify(save)); } catch {} };
save.dir.adaptive = save.settings.adaptive;

// ------------------------------------------------------------------ boot
const canvas = document.getElementById('gl');
const loading = document.createElement('div'); loading.className = 'loading'; loading.textContent = 'UNPACKING THE TOY BOX…'; document.body.append(loading);
const initialQ = params.get('q') || (save.settings.quality === 'auto' ? 'high' : save.settings.quality);
const view = new View(canvas, initialQ);
const input = new Input(canvas);
const audio = new Audio();
audio.setVolumes({ master: save.settings.master, sfx: save.settings.sfx, music: save.settings.music });
const ui = new UI(document.getElementById('ui'), (k) => audio.play(k));
view.onSound = (k, o) => audio.play(k, o);
view.mode = save.settings.view;

const G = {
  scene: 'title', mode: 'attract', world: null, phase: 'fight', phaseT: 0,
  mission: 0, lives: 3, retries: 0, deathsThisMission: 0,
  run: null, vs: null, aimYaw: 0, time: 0, autoQ: { t: 0, n: 0, sum: 0, done: save.settings.quality !== 'auto' },
  closeBanner: null, paused: params.has('paused'),
};
const MAX_LIVES = 6;

function setWorld(w) {
  G.world = w;
  view.buildBoard(w);
  const p = player();
  G.aimYaw = p ? p.aim : 0;
  for (const t of w.tanks) { t._rx = t.x; t._rz = t.z; }
  if (G.botPlayer) window.__tt.botPlayer(G.botPlayer);
}
const player = () => G.world && G.world.tanks.find((t) => t.human);

// ------------------------------------------------------------------ title / attract
function attractWorld() {
  const map = Math.floor(Math.random() * VERSUS.length);
  const skills = ['veteran', 'ace', 'veteran', 'ace'], styles = ['hunt', 'trick', 'sniper', 'hunt'];
  const slots = [0, 1, 2, 3].map((k) => ({ human: false, team: k, skill: skills[k], style: styles[k], color: VS_COLORS[k] }));
  const w = versusWorld(map, slots, 0.5, Math.floor(Math.random() * 1e6));
  w.tanks.forEach((t, k) => { t.colorOverride = VS_COLORS[k]; });
  return w;
}

function toTitle() {
  G.scene = 'title'; G.mode = 'attract'; G.phase = 'fight';
  input.releaseLock();
  ui.hud(false); ui.clear('banner');
  setWorld(attractWorld());
  view.mode = 'orbit'; view.cam.introT = 1;
  view.hideAim();
  audio.startMusic(2, 104);
  const canContinue = save.best > 0;
  ui.title({
    canContinue, continueLabel: `Mission ${checkpointFor(save.best) + 1} checkpoint`,
    onContinue: () => startCampaign(checkpointFor(save.best)),
    onCampaign: () => save.best >= 5 ? ui.campaignSelect({ best: save.best, onStart: startCampaign, onBack: toTitle }) : startCampaign(0),
    onVersus: versusSetup,
    onSettings: () => settings(toTitle),
    onHelp: () => ui.help(toTitle),
  });
}
const checkpointFor = (m) => Math.min(15, Math.floor(m / 5) * 5);

function settings(back) {
  ui.settings(save.settings, {
    rating: save.dir.rating,
    onChange: (s) => {
      save.settings = s; save.dir.adaptive = s.adaptive;
      audio.setVolumes({ master: s.master, sfx: s.sfx, music: s.music });
      if (s.quality !== 'auto') { view.setQuality(s.quality); G.autoQ.done = true; }
      persist();
    },
    onBack: back,
  });
}

// ------------------------------------------------------------------ campaign
function startCampaign(m) {
  audio.unlock();
  G.mode = 'campaign'; G.mission = m; G.lives = 3; G.retries = 0;
  G.run = { kills: {}, shots: 0, hits: 0, time: 0, cleared: 0, startMission: m };
  beginMission();
}

function beginMission() {
  G.scene = 'play'; ui.clear('screen');
  const w = campaignWorld(G.mission, effectiveRating(save.dir, G.retries), (Date.now() & 0xffff) + G.mission * 977);
  setWorld(w);
  G.deathsThisMission = G.deathsThisMission || 0;
  view.mode = save.settings.view;
  G.phase = 'banner'; G.phaseT = 0;
  const r = roster(CAMPAIGN[G.mission]);
  const foes = Object.entries(r).map(([k, n]) => [TYPES[k].color, `${n}× ${TYPES[k].name}`]);
  G.closeBanner = ui.banner({ big: `MISSION ${G.mission + 1}`, name: CAMPAIGN[G.mission].name, foes });
  ui.hud(true, { mode: view.mode, title: `MISSION ${String(G.mission + 1).padStart(2, '0')}`, sub: CAMPAIGN[G.mission].name });
  audio.stopMusic(); audio.play('banner');
}

function musicLayers(w) {
  const tier = { rookie: 1, grunt: 1, zipper: 2, sapper: 2, burst: 3, ricochet: 3, hunter: 4, ghost: 4, boss: 4, ally: 3, player: 3 };
  let m = 1; for (const t of w.tanks) if (!t.human) m = Math.max(m, tier[t.typeKey] || 2);
  return m;
}

function onCampaignOutcome() {
  const w = G.world, p = player();
  const threat = missionThreat(G.mission);
  G.run.shots += p.shots; G.run.hits += p.hits; G.run.time += w.time;
  for (const [k, n] of Object.entries(w.stats.kills)) G.run.kills[k] = (G.run.kills[k] || 0) + n;
  const from = save.dir.rating;
  if (w.outcome === 'won') {
    const acc = p.shots ? p.hits / p.shots : 0.5;
    const quality = Math.max(0, Math.min(1, acc * 0.7 + (G.deathsThisMission === 0 ? 0.3 : 0)));
    if (save.dir.adaptive) recordResult(save.dir, threat, 1, quality);
    G.run.cleared++;
    const bonus = (G.mission + 1) % 5 === 0 && G.mission < 19;
    if (bonus) G.lives = Math.min(MAX_LIVES, G.lives + 1);
    save.best = Math.max(save.best, G.mission + 1);
    persist();
    input.releaseLock();
    audio.stopMusic(); audio.play('win');
    G.scene = 'results';
    const last = G.mission >= CAMPAIGN.length - 1;
    const killRows = Object.entries(w.stats.kills).map(([k, n]) => [`${TYPES[k].name} destroyed`, `${n}`]);
    ui.results({
      kicker: `Mission ${G.mission + 1} · ${CAMPAIGN[G.mission].name}`, title: last ? 'Campaign complete!' : 'Mission cleared', stamp: last ? 'VICTORY' : 'CLEARED',
      rows: [...killRows, ['Time', fmtTime(w.time)], ['Accuracy', p.shots ? Math.round(p.hits / p.shots * 100) + '%' : '—'], ['Tanks in reserve', `${G.lives}${bonus ? ' (+1 bonus)' : ''}`]],
      note: save.dir.adaptive ? directorNote(from, save.dir.rating) : null,
      meter: save.dir.adaptive ? { from, to: save.dir.rating, threat } : null,
      actions: last
        ? [['Title', toTitle], ['Campaign summary', () => campaignSummary(true), 'primary']]
        : [['Quit', toTitle], ['Next mission', () => { G.mission++; G.retries = 0; G.deathsThisMission = 0; beginMission(); }, 'primary']],
    });
  } else {
    if (save.dir.adaptive) recordResult(save.dir, threat, 0);
    persist();
    G.lives--; G.retries++; G.deathsThisMission++;
    audio.stopMusic();
    if (G.lives <= 0) { audio.play('lose'); input.releaseLock(); campaignSummary(false); return; }
    // quick retry: a short banner, then the same mission again
    G.scene = 'play'; G.phase = 'lost'; G.phaseT = 0;
    G.closeBanner = ui.banner({ big: 'TANK LOST', name: `${G.lives} ${G.lives === 1 ? 'tank' : 'tanks'} left in reserve` });
    audio.play('lose');
  }
}

function campaignSummary(won) {
  G.scene = 'results';
  const k = Object.values(G.run.kills).reduce((a, b) => a + b, 0);
  ui.results({
    kicker: 'Campaign', title: won ? 'The toy box is yours' : 'Out of tanks', stamp: won ? 'HERO' : 'K.I.A.',
    rows: [['Missions cleared', `${G.run.cleared}`], ['Furthest mission', `${G.mission + 1} · ${CAMPAIGN[G.mission].name}`], ['Enemy tanks destroyed', `${k}`],
      ['Accuracy', G.run.shots ? Math.round(G.run.hits / G.run.shots * 100) + '%' : '—'], ['Time in the field', fmtTime(G.run.time)], ['Director rating', `${Math.round(save.dir.rating * 100)}/100`]],
    actions: won ? [['Title', toTitle, 'primary']] : [['Title', toTitle], [`Retry from mission ${checkpointFor(G.mission) + 1}`, () => startCampaign(checkpointFor(G.mission)), 'primary']],
  });
}

const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
function directorNote(a, b) {
  const d = Math.round((b - a) * 100);
  if (d > 0) return `The Director saw that. Enemy crews sharpen up (+${d}).`;
  if (d < 0) return `The Director eases off a touch (${d}).`;
  return 'The Director holds steady.';
}

// ------------------------------------------------------------------ versus
function versusSetup() {
  audio.unlock();
  const cfg = save.vs || { format: 'ffa', bots: 1, rounds: 3, map: 0, slots: [{ skill: 'veteran', style: 'brawler' }, { skill: 'veteran', style: 'sniper' }, { skill: 'veteran', style: 'trickster' }] };
  ui.versusSetup(cfg, { onStart: (c) => { save.vs = c; persist(); startVersus(c); }, onBack: toTitle });
}

function startVersus(cfg) {
  G.mode = 'versus';
  const n = cfg.format === '2v2' ? 3 : cfg.bots;
  const slots = [{ human: true, team: 0, label: 'You', color: VS_COLORS[0] }];
  for (let k = 0; k < n; k++) {
    const b = cfg.slots[k];
    const team = cfg.format === '2v2' ? (k === 0 ? 0 : 1) : k + 1;
    slots.push({ human: false, team, skill: b.skill, style: PERSONALITIES[b.style].style, color: VS_COLORS[k + 1], label: VS_NAMES[k + 1] });
  }
  const teams = [...new Set(slots.map((s) => s.team))];
  G.vs = { cfg, slots, teams, wins: Object.fromEntries(teams.map((t) => [t, 0])), round: 0 };
  nextRound();
}

function nextRound() {
  const V = G.vs;
  V.round++;
  const map = V.cfg.map >= 0 ? V.cfg.map : Math.floor(Math.random() * VERSUS.length);
  const w = versusWorld(map, V.slots, effectiveRating(save.dir, 0), Date.now() & 0xffff);
  w.tanks.forEach((t) => { t.colorOverride = V.slots[t.slot].color; t.label = V.slots[t.slot].label; });
  setWorld(w);
  G.scene = 'play'; ui.clear('screen');
  view.mode = save.settings.view;
  G.phase = 'banner'; G.phaseT = 0;
  const foes = V.slots.slice(1).map((s) => [s.color, `${s.label} · ${skillLabel(s.skill)}`]);
  G.closeBanner = ui.banner({ big: `ROUND ${V.round}`, name: `${VERSUS[map].name} · first to ${V.cfg.rounds}`, foes });
  ui.hud(true, { mode: view.mode, title: `ROUND ${V.round}`, sub: VERSUS[map].name });
  audio.stopMusic(); audio.play('banner');
}
const skillLabel = (s) => ({ cadet: 'Cadet', veteran: 'Veteran', ace: 'Ace', adaptive: 'Adaptive' }[s] || s);

function onVersusOutcome() {
  const V = G.vs, w = G.world;
  const winTeam = w.outcome.startsWith('team') ? +w.outcome.slice(4) : null;
  if (winTeam != null) V.wins[winTeam]++;
  // Director: rate the round against the average opposing skill
  const opp = V.slots.filter((s) => s.team !== 0);
  const threat = opp.reduce((a, s) => a + (s.skill === 'adaptive' ? save.dir.rating : SKILL_THREAT[s.skill]), 0) / opp.length + (opp.length - 1) * 0.08;
  if (save.dir.adaptive) recordResult(save.dir, Math.min(1, threat), winTeam === 0 ? 1 : winTeam == null ? 0.5 : 0, 0.5);
  persist();
  audio.stopMusic();
  const champ = Object.entries(V.wins).find(([, n]) => n >= V.cfg.rounds);
  const label = winTeam == null ? 'Draw' : winTeam === 0 ? (V.cfg.format === '2v2' ? 'Your team wins the round' : 'You win the round') : `${V.slots.find((s) => s.team === winTeam).label} wins the round`;
  audio.play(winTeam === 0 ? 'win' : 'lose');
  if (!champ) {
    G.phase = 'lost'; G.phaseT = 0;
    G.closeBanner = ui.banner({ big: winTeam === 0 ? 'ROUND WON' : winTeam == null ? 'DRAW' : 'ROUND LOST', name: label });
    return;
  }
  input.releaseLock();
  G.scene = 'results';
  const youWon = +champ[0] === 0;
  ui.results({
    kicker: 'Versus', title: youWon ? 'Match won' : 'Match lost', stamp: youWon ? 'VICTORY' : 'DEFEAT',
    rows: V.teams.map((t) => [t === 0 ? (V.cfg.format === '2v2' ? 'Your team' : 'You') : V.slots.find((s) => s.team === t).label + ' · ' + skillLabel(V.slots.find((s) => s.team === t).skill), `${V.wins[t]}`]),
    note: save.dir.adaptive ? `Director rating now ${Math.round(save.dir.rating * 100)}/100.` : null,
    actions: [['Title', toTitle], ['Change setup', versusSetup], ['Rematch', () => startVersus(V.cfg), 'primary']],
  });
}

// ------------------------------------------------------------------ pause
function pauseGame() {
  if (G.scene !== 'play') return;
  G.scene = 'paused';
  input.releaseLock();
  ui.pause({
    onResume: resume,
    onRestart: () => { ui.clear('screen'); if (G.mode === 'campaign') { beginMission(); } else { G.vs.round--; nextRound(); } },
    restartLabel: G.mode === 'campaign' ? 'Restart mission' : 'Restart round',
    onSettings: () => settings(pauseMenuAgain),
    onQuit: toTitle,
  });
}
function pauseMenuAgain() { G.scene = 'play'; pauseGame(); }
function resume() { ui.clear('screen'); G.scene = 'play'; if (view.mode === 'chase') input.requestLock(); }

input.onLockChange = (locked) => {
  if (!locked && G.scene === 'play' && G.phase === 'fight' && view.mode === 'chase' && !G.botPlayer) pauseGame();
};
canvas.addEventListener('mousedown', (e) => {
  audio.unlock();
  if (G.scene === 'play' && view.mode === 'chase' && !input.locked) { input.requestLock(); input.mouse.leftHit = false; e.preventDefault(); }
});
addEventListener('keydown', () => audio.unlock());

// ------------------------------------------------------------------ controls
function controlPlayer(p, dt) {
  const c = p.ctrl, K = input, pad = input.pad;
  const fwd = (K.down('KeyW', 'ArrowUp') ? 1 : 0) - (K.down('KeyS', 'ArrowDown') ? 1 : 0);
  const side = (K.down('KeyD', 'ArrowRight') ? 1 : 0) - (K.down('KeyA', 'ArrowLeft') ? 1 : 0);
  if (view.mode === 'chase') {
    c.drive = true;
    c.throttle = Math.max(-1, Math.min(1, fwd - pad.ly));
    c.steer = Math.max(-1, Math.min(1, side + pad.lx));
    G.aimYaw += input.mouse.dx * 0.0022 * save.settings.sens + pad.rx * 3.4 * dt;
    c.aim = G.aimYaw;
  } else {
    c.drive = false;
    const ax = view.screenAxes();
    let mx = ax.rx * side + ax.ux * fwd, mz = ax.rz * side + ax.uz * fwd;
    if (pad.connected && Math.hypot(pad.lx, pad.ly) > 0.1) { mx = ax.rx * pad.lx - ax.ux * pad.ly; mz = ax.rz * pad.lx - ax.uz * pad.ly; }
    c.mx = mx; c.mz = mz;
    if (input.lastDevice === 'pad' && Math.hypot(pad.rx, pad.ry) > 0.35) c.aim = Math.atan2(ax.rz * pad.rx - ax.uz * pad.ry, ax.rx * pad.rx - ax.ux * pad.ry);
    else { const b = view.screenToBoard(input.mouse.x, input.mouse.y); if (b) c.aim = Math.atan2(b.z - p.z, b.x - p.x); }
    G.aimYaw = c.aim;
  }
  if (input.mouse.leftHit || pad.fireHit) c.fire = true;
  if (input.mouse.rightHit || input.hit('Space') || pad.mineHit) c.mine = true;
}

// Where will my shell go? Same bounce code as the real thing.
function aimPath(w, p) {
  const a = p.aim, cx = Math.cos(a), cz = Math.sin(a);
  const s = { x: p.x + cx * BARREL, z: p.z + cz * BARREL, dx: cx, dz: cz };
  if (!shellLineClear(w.grid, p.x, p.z, s.x, s.z)) return null;
  const pts = []; let bounces = 0, dead = false, len = 0, hit = null, acc = 0;
  const maxLen = view.mode === 'chase' ? 16 : 13;
  while (len < maxLen && !dead && !hit) {
    moveShell(w.grid, s, 0.06, () => { bounces++; if (bounces > p.type.bounces) { dead = true; return false; } return true; });
    len += 0.06; acc += 0.06;
    if (acc >= 0.22) { acc = 0; pts.push({ x: s.x, z: s.z }); }
    for (const t of w.tanks) {
      if (!t.alive || (t === p && bounces === 0)) continue;
      if (t.type.invisible && t !== p && w.time > 1.8) continue; // no free wallhack on ghosts
      if (Math.hypot(t.x - s.x, t.z - s.z) < TANK_R + SHELL_R) { hit = { x: t.x, z: t.z, enemy: t.team !== p.team, self: t === p }; break; }
    }
  }
  return { pts, hit };
}

// ------------------------------------------------------------------ loop
let last = performance.now(), acc = 0;
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  G.time += dt;
  input.poll();
  tick(dt);
  input.endFrame();
  if (!G.paused) requestAnimationFrame(frame);
}

function tick(dt) {
  const w = G.world;
  // global keys
  if (G.scene === 'play' && (input.hit('Escape', 'KeyP') || input.pad.startHit)) pauseGame();
  else if (G.scene === 'paused' && (input.hit('KeyP') || input.pad.startHit)) resume();
  if (G.scene === 'play' && (input.hit('KeyV', 'Tab') || input.pad.viewHit)) {
    view.mode = view.mode === 'chase' ? 'tactical' : 'chase';
    ui.setMode(view.mode);
    const p = player(); if (p) G.aimYaw = p.aim;
    if (view.mode === 'chase' && !G.botPlayer) input.requestLock(); else input.releaseLock();
  }
  if (G.scene === 'results' && input.hit('Enter', 'NumpadEnter')) document.querySelector('.panel .actions .primary')?.click();

  const p = player();
  let stepping = false;
  if (G.scene === 'title') stepping = true;
  if (G.scene === 'play') {
    G.phaseT += dt;
    if (G.phase === 'banner') {
      if (G.phaseT > 2.4) {
        G.phase = 'fight'; if (G.closeBanner) G.closeBanner();
        audio.startMusic(G.mode === 'campaign' ? musicLayers(w) : 3, 112 + (G.mode === 'campaign' ? G.mission : 6));
        if (view.mode === 'chase' && !G.botPlayer) input.requestLock();
      }
    } else if (G.phase === 'fight') {
      stepping = true;
    } else if (G.phase === 'lost') {
      stepping = !w.over; // let the wreck finish smoking
      if (G.phaseT > 2.4) { if (G.closeBanner) G.closeBanner(); if (G.mode === 'campaign') beginMission(); else nextRound(); return; }
    }
    ui.showLock(G.phase === 'fight' && view.mode === 'chase' && !input.locked && !G.botPlayer);
  }
  if (stepping) {
    if (p && p.alive && G.scene === 'play' && !G.botPlayer) controlPlayer(p, dt);
    acc += dt;
    let n = 0;
    while (acc >= DT && n < 5) {
      for (const t of w.tanks) { t._rx = t.x; t._rz = t.z; }
      for (const s of w.shells) { s._rx = s.x; s._rz = s.z; }
      step(w, brainStep);
      view.consume(w); w.events.length = 0;
      acc -= DT; n++;
      if (w.over) break;
    }
    if (n === 5) acc = 0;
    if (w.over) {
      if (G.scene === 'title') { setWorld(attractWorld()); view.cam.introT = 1; }
      else if (G.phase === 'fight') { G.mode === 'campaign' ? onCampaignOutcome() : onVersusOutcome(); }
    }
    // kill feed
  }
  // render
  const pw = player();
  view.sync(G.world, Math.min(1, acc / DT), dt, pw, G.aimYaw);
  if (pw && pw.alive && G.scene === 'play' && G.phase === 'fight' && save.settings.aimLine) {
    const ap = aimPath(G.world, pw);
    if (ap) view.setAimPath(ap.pts, ap.hit && (ap.hit.enemy || ap.hit.self) ? ap.hit : null, G.time); else view.hideAim();
  } else view.hideAim();
  view.render(dt, G.time);
  if (G.scene === 'play' || G.scene === 'paused') {
    ui.updateHUD(G.world, pw, {
      lives: G.mode === 'campaign' ? G.lives : 0, maxLives: G.mode === 'campaign' ? Math.max(3, G.lives) : 0, view, mode: view.mode,
      score: G.mode === 'versus' ? G.vs.teams.map((t) => ({ color: G.vs.slots.find((s) => s.team === t).color, wins: G.vs.wins[t] })) : null,
    });
  }
  // audio listener + engine
  if (pw) { audio.listener.x = pw.x; audio.listener.z = pw.z; audio.listener.yaw = view.mode === 'chase' ? G.aimYaw : -Math.PI / 2; }
  audio.engine(pw && pw.alive ? pw.speedNow : 0, G.scene === 'play' && pw && pw.alive);
  audio.tickMusic();
  autoQuality(dt);
}

function autoQuality(dt) {
  const A = G.autoQ;
  if (A.done || G.scene !== 'play' || G.phase !== 'fight') return;
  A.t += dt; A.sum += dt; A.n++;
  if (A.t > 4) {
    const avg = A.sum / A.n;
    const q = view.quality.name;
    if (avg > 1 / 38 && q !== 'low') { view.setQuality(q === 'high' ? 'medium' : 'low'); A.t = 0; A.sum = 0; A.n = 0; }
    else A.done = true;
  }
}

// ------------------------------------------------------------------ test hooks (the game never reads these)
window.__tt = {
  get G() { return G; }, get world() { return G.world; }, view, save: () => save, ui,
  pause(v = true) { G.paused = v; if (!v) { last = performance.now(); requestAnimationFrame(frame); } },
  tick(sec = 1 / 60, frames = 1) { for (let k = 0; k < frames; k++) { input.poll(); tick(sec); input.endFrame(); } },
  renderOnce() {
    view.sync(G.world, 1, 1 / 60, player(), G.aimYaw); view.render(1 / 60, G.time);
    if (G.scene === 'play' || G.scene === 'paused') ui.updateHUD(G.world, player(), { lives: G.mode === 'campaign' ? G.lives : 0, maxLives: G.mode === 'campaign' ? Math.max(3, G.lives) : 0, view, mode: view.mode, score: G.mode === 'versus' ? G.vs.teams.map((t) => ({ color: G.vs.slots.find((s) => s.team === t).color, wins: G.vs.wins[t] })) : null });
    const pw = player();
    if (pw && pw.alive && G.scene === 'play' && save.settings.aimLine) { const ap = aimPath(G.world, pw); if (ap) view.setAimPath(ap.pts, ap.hit && (ap.hit.enemy || ap.hit.self) ? ap.hit : null, G.time); }
  },
  // step the game logic without rendering (fast under SwiftShader)
  sim(sec) { const n = Math.round(sec * 60); for (let k = 0; k < n; k++) { const w = G.world; for (const t of w.tanks) { t._rx = t.x; t._rz = t.z; } const p = player(); step(w, brainStep); view.consume(w); w.events.length = 0; view.fx.update(1 / 60, view.solidTop); if (w.over) { if (G.scene === 'play' && G.phase === 'fight') { G.mode === 'campaign' ? onCampaignOutcome() : onVersusOutcome(); } break; } } },
  phase(ph) { G.phase = ph; G.phaseT = 0; if (ph === 'fight' && G.closeBanner) G.closeBanner(); },
  advance(sec) { const n = Math.round(sec * 60); for (let k = 0; k < n; k++) { const w = G.world; for (const t of w.tanks) { t._rx = t.x; t._rz = t.z; } step(w, brainStep); view.fx.update(1 / 60, view.solidTop); view.consume(w); w.events.length = 0; if (w.over) break; } },
  botPlayer(skill = 'ace') { G.botPlayer = skill; const p = player(); if (p) { p.botDriven = true; p.skill = skill; p.style = 'trick'; p._profile = null; } },
  startCampaign, startVersus, toTitle, beginMission, pauseGame, resume,
};

// ------------------------------------------------------------------ go
toTitle();
if (params.has('m')) startCampaign(+params.get('m'));
setTimeout(() => { loading.style.opacity = 0; setTimeout(() => loading.remove(), 700); }, 150);
if (!G.paused) requestAnimationFrame(frame);
