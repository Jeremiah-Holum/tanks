// Game shell: state machine, controls, garage, campaign + versus flow, spectating, Director,
// combat feedback (reads world.events before the view consumes them), render loop.
import { View } from './render/view.js';
import { campaignWorld, versusWorld } from './sim/game.js';
import { step, DT, BARREL, SHELL_R, solidCellAt, hullContact, liveShellsOf, liveMinesOf } from './sim/world.js';
import { brainStep, teamSees } from './sim/ai.js';
import { TYPES, PERSONALITIES, CLASSES, CLASS_ORDER } from './sim/tanks.js';
import { CAMPAIGN, VERSUS, roster } from './sim/levels.js';
import { newDirector, recordResult, missionThreat, effectiveRating, SKILL_THREAT } from './sim/director.js';
import { Input } from './input.js';
import { Audio } from './audio.js';
import { UI, TEAM_COLORS, versusLayout } from './ui.js';

const params = new URLSearchParams(location.search);
const SAVE_KEY = 'toytanks.v1';
const defaults = () => ({ best: 0, cls: 'medium', dir: newDirector(), settings: { quality: 'auto', view: 'chase', aimLine: true, combatText: true, sens: 1, master: 0.8, sfx: 0.9, music: 0.45, adaptive: true }, vs: null, stats: { games: 0 } });
let save = defaults();
try { const s = JSON.parse(localStorage.getItem(SAVE_KEY)); if (s) save = { ...defaults(), ...s, settings: { ...defaults().settings, ...s.settings }, dir: { ...newDirector(), ...s.dir } }; } catch {}
if (!CLASSES[save.cls]) save.cls = 'medium';
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
  run: null, vs: null, aimYaw: 0, time: 0, autoQ: { t: 0, n: 0, sum: 0, done: save.settings.quality !== 'auto' || params.has('q') },
  closeBanner: null, paused: params.has('paused'),
  spec: null,            // id of the ally being watched after the player is knocked out
  tally: null,           // per-round gunnery the sim doesn't count: { rico, nopen, blocked }
  lastSeen: new Map(),   // enemy id → world time last in team sight (for "ENEMY SPOTTED")
  seen: new Set(), aim: null,
};
const MAX_LIVES = 6;

function setWorld(w) {
  G.world = w;
  view.buildBoard(w);
  const p = player();
  G.aimYaw = p ? p.aim : 0;
  G.spec = null; G.aim = null;
  G.tally = { rico: 0, nopen: 0, blocked: 0 };
  G.lastSeen = new Map(); G.seen = new Set();
  for (const t of w.tanks) { t._rx = t.x; t._rz = t.z; }
  if (G.botPlayer) window.__tt.botPlayer(G.botPlayer);
}
const player = () => G.world && G.world.tanks.find((t) => t.human);
const tankById = (w, id) => w.tanks.find((t) => t.id === id);
const pickRandomClass = () => CLASS_ORDER[Math.floor(Math.random() * CLASS_ORDER.length)];

// ------------------------------------------------------------------ title / attract
function attractWorld() {
  const map = Math.floor(Math.random() * VERSUS.length);
  const skills = ['veteran', 'ace', 'veteran', 'ace', 'veteran', 'ace'], styles = ['hunt', 'trick', 'sniper', 'hunt', 'sniper', 'trick'];
  const slots = [0, 1, 2, 3, 4, 5].map((k) => ({ human: false, team: k % 2, skill: skills[k], style: styles[k], cls: CLASS_ORDER[k % 4], color: TEAM_COLORS[k % 2][k >> 1], label: 'Bot' }));
  return versusWorld(map, slots, 0.5, Math.floor(Math.random() * 1e6));
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
    onContinue: () => campaignGarage(checkpointFor(save.best), { fresh: true }),
    onCampaign: () => save.best >= 5 ? ui.campaignSelect({ best: save.best, onStart: (m) => campaignGarage(m, { fresh: true }), onBack: toTitle }) : campaignGarage(0, { fresh: true }),
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

// ------------------------------------------------------------------ garage (campaign)
function campaignBrief(m) {
  const r = roster(CAMPAIGN[m]);
  const foes = Object.entries(r).map(([k, n]) => [TYPES[k].color, `${n}× ${TYPES[k].name}`]);
  const allies = CAMPAIGN[m].allies || 0;
  const lvl = CAMPAIGN[m];
  const lines = [
    `Destroy every enemy tank. ${allies ? `${allies} allied ${allies === 1 ? 'tank rolls' : 'tanks roll'} with you.` : 'You go in alone.'}`,
    `Battlefield: ${lvl.rows[0].length} × ${lvl.rows.length} ${lvl.theme}.`,
  ];
  return { kicker: `Mission ${m + 1} of ${CAMPAIGN.length}`, title: CAMPAIGN[m].name, lines, foes };
}

// fresh: a new run from the title (resets lives); otherwise continues the current run.
function campaignGarage(m, { fresh = false } = {}) {
  audio.unlock();
  input.releaseLock();
  G.scene = 'garage';
  ui.hud(false); ui.clear('banner');
  view.hideAim();
  ui.garage({
    cls: save.cls, brief: campaignBrief(m),
    onPick: (c) => { save.cls = c; persist(); },
    onStart: (c) => {
      save.cls = c; persist(); audio.play('uiBig');
      if (fresh) startCampaign(m); else { G.mission = m; beginMission(); }
    },
    onBack: toTitle,
    backLabel: fresh ? 'Back' : 'Quit to title',
  });
}

// ------------------------------------------------------------------ campaign
function startCampaign(m) {
  audio.unlock();
  G.mode = 'campaign'; G.mission = m; G.lives = 3; G.retries = 0; G.deathsThisMission = 0;
  G.run = { kills: {}, shots: 0, hits: 0, pens: 0, dmg: 0, taken: 0, rico: 0, nopen: 0, blocked: 0, time: 0, cleared: 0, startMission: m };
  beginMission();
}

function beginMission() {
  G.mode = 'campaign';
  G.scene = 'play'; ui.clear('screen');
  const w = campaignWorld(G.mission, effectiveRating(save.dir, G.retries), (Date.now() & 0xffff) + G.mission * 977, { playerClass: save.cls, allyClass: 'medium' });
  setWorld(w);
  view.mode = save.settings.view;
  G.phase = 'banner'; G.phaseT = 0;
  const r = roster(CAMPAIGN[G.mission]);
  const foes = Object.entries(r).map(([k, n]) => [TYPES[k].color, `${n}× ${TYPES[k].name}`]);
  const allies = w.tanks.filter((t) => t.team === 0 && !t.human).length;
  G.closeBanner = ui.banner({ big: `MISSION ${G.mission + 1}`, name: CAMPAIGN[G.mission].name, foes, sub: `Your ${CLASSES[save.cls].label} tank${allies ? ` · ${allies} ${allies === 1 ? 'ally' : 'allies'}` : ''}` });
  ui.hud(true, { mode: view.mode, title: `MISSION ${String(G.mission + 1).padStart(2, '0')}`, sub: CAMPAIGN[G.mission].name });
  audio.stopMusic(); audio.play('banner');
}

function musicLayers(w) {
  const tier = { rookie: 1, grunt: 1, zipper: 2, sapper: 2, burst: 3, ricochet: 3, hunter: 4, ghost: 4, boss: 4, ally: 3, player: 3 };
  let m = 1; for (const t of w.tanks) if (!t.human && t.team !== 0) m = Math.max(m, tier[t.typeKey] || 2);
  return m;
}

// The player's gunnery for one round.
function roundStats(w, p) {
  const T = G.tally || { rico: 0, nopen: 0, blocked: 0 };
  return { shots: p.shots, hits: p.hits, pens: p.pens, dmg: Math.round(p.dmgDealt), taken: Math.round(w.stats.dmgTaken), rico: T.rico, nopen: T.nopen, blocked: T.blocked, ko: p.kills };
}
function statsGrid(s) {
  const acc = s.shots ? Math.round(s.hits / s.shots * 100) + '%' : '—';
  return [
    ['Damage dealt', String(s.dmg), 'good'], ['Damage taken', String(s.taken), 'bad'], ['Shots fired / hit', `${s.shots} / ${s.hits}`], ['Accuracy', acc],
    ['Penetrations', String(s.pens), 'good'], ['Ricochets', String(s.rico)], ['No penetration', String(s.nopen)], ['Shells your armour stopped', String(s.blocked)],
  ];
}
const addStats = (a, s) => { for (const k of ['shots', 'hits', 'pens', 'dmg', 'taken', 'rico', 'nopen', 'blocked', 'ko']) a[k] = (a[k] || 0) + (s[k] || 0); };

function onCampaignOutcome() {
  const w = G.world, p = player();
  const threat = missionThreat(G.mission);
  const rs = roundStats(w, p);
  addStats(G.run, rs); G.run.time += w.time;
  for (const [k, n] of Object.entries(w.stats.kills)) G.run.kills[k] = (G.run.kills[k] || 0) + n;
  const from = save.dir.rating;
  input.releaseLock();
  audio.stopMusic();
  G.scene = 'results';
  ui.hud(false); view.hideAim();
  if (w.outcome === 'won') {
    const acc = p.shots ? p.hits / p.shots : 0.5;
    const quality = Math.max(0, Math.min(1, acc * 0.5 + (p.hp / p.maxHp) * 0.2 + (G.deathsThisMission === 0 ? 0.3 : 0)));
    if (save.dir.adaptive) recordResult(save.dir, threat, 1, quality);
    G.run.cleared++;
    const bonus = (G.mission + 1) % 5 === 0 && G.mission < 19;
    if (bonus) G.lives = Math.min(MAX_LIVES, G.lives + 1);
    save.best = Math.max(save.best, G.mission + 1);
    persist();
    audio.play('win');
    const last = G.mission >= CAMPAIGN.length - 1;
    const killRows = Object.entries(w.stats.kills).map(([k, n]) => [`${TYPES[k].name} destroyed`, `${n}`]);
    ui.results({
      kicker: `Mission ${G.mission + 1} · ${CAMPAIGN[G.mission].name}`, title: last ? 'Campaign complete!' : 'Mission cleared', stamp: last ? 'VICTORY' : 'CLEARED',
      rows: [...killRows, ['Hull left', `${Math.ceil(p.hp)} / ${p.maxHp}`], ['Time', fmtTime(w.time)], ['Tanks in reserve', `${G.lives}${bonus ? ' (+1 bonus)' : ''}`]],
      stats: statsGrid(rs),
      note: save.dir.adaptive ? directorNote(from, save.dir.rating) : null,
      meter: save.dir.adaptive ? { from, to: save.dir.rating, threat } : null,
      actions: last
        ? [['Title', toTitle], ['Campaign summary', () => campaignSummary(true), 'primary']]
        : [['Quit', toTitle], ['Next mission', () => { G.retries = 0; G.deathsThisMission = 0; campaignGarage(G.mission + 1); }, 'primary']],
    });
  } else {
    if (save.dir.adaptive) recordResult(save.dir, threat, 0);
    persist();
    G.lives--; G.retries++; G.deathsThisMission++;
    audio.play('lose');
    if (G.lives <= 0) { campaignSummary(false); return; }
    const killer = p.lastHitBy != null ? tankById(w, p.lastHitBy) : null;
    ui.results({
      kicker: `Mission ${G.mission + 1} · ${CAMPAIGN[G.mission].name}`, title: 'Tank lost', stamp: 'K.O.',
      rows: [['Knocked out by', killer ? killer.label : '—'], ['Enemies left', `${w.tanks.filter((t) => t.alive && t.team !== 0).length}`], ['Time', fmtTime(w.time)], ['Tanks in reserve', `${G.lives}`]],
      stats: statsGrid(rs),
      note: 'Try another angle: go for sides and rears, keep your front plate toward the threat, and stop to let your aim settle.',
      actions: [['Quit', toTitle], ['Retry', () => campaignGarage(G.mission), 'primary']],
    });
  }
}

function campaignSummary(won) {
  G.scene = 'results';
  const k = Object.values(G.run.kills).reduce((a, b) => a + b, 0);
  ui.results({
    kicker: 'Campaign', title: won ? 'The toy box is yours' : 'Out of tanks', stamp: won ? 'HERO' : 'K.I.A.',
    rows: [['Missions cleared', `${G.run.cleared}`], ['Furthest mission', `${G.mission + 1} · ${CAMPAIGN[G.mission].name}`], ['Enemy tanks destroyed', `${k}`],
      ['Time in the field', fmtTime(G.run.time)], ['Director rating', `${Math.round(save.dir.rating * 100)}/100`]],
    stats: statsGrid(G.run),
    actions: won ? [['Title', toTitle, 'primary']] : [['Title', toTitle], [`Retry from mission ${checkpointFor(G.mission) + 1}`, () => campaignGarage(checkpointFor(G.mission), { fresh: true }), 'primary']],
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
const botSlot = (skill = 'veteran', style = 'brawler', cls = 'random') => ({ skill, style, cls });
function vsDefaults() {
  return {
    v: 2, format: 'team', ffa: 4, allies: 2, enemies: 3, rounds: 2, map: -1, cls: save.cls,
    allySlots: [botSlot('veteran', 'brawler'), botSlot('veteran', 'sniper'), botSlot('veteran', 'trickster'), botSlot('cadet', 'brawler')],
    enemySlots: [botSlot('veteran', 'brawler'), botSlot('veteran', 'sniper'), botSlot('veteran', 'trickster'), botSlot('ace', 'brawler'), botSlot('cadet', 'sniper')],
  };
}
// Accepts the current shape, the old { format: 'ffa'|'2v2', bots, slots } shape, or partial configs.
function normVs(c) {
  const d = vsDefaults();
  if (!c) return d;
  const out = { ...d, ...c };
  if (c.v !== 2) {
    const old = (c.slots || []).map((s) => botSlot(s.skill, s.style, s.cls || 'random'));
    if (c.format === '2v2') { out.format = 'team'; out.allies = 1; out.enemies = 2; out.allySlots = [old[0] || d.allySlots[0], ...d.allySlots.slice(1)]; out.enemySlots = [...old.slice(1, 3), ...d.enemySlots.slice(Math.min(2, old.length - 1))].slice(0, 5); }
    else if (c.format === 'ffa') { const bots = c.bots || 1; out.format = bots <= 1 ? '1v1' : 'ffa'; out.ffa = bots + 1; out.enemySlots = [...old, ...d.enemySlots.slice(old.length)].slice(0, 5); }
    out.v = 2;
  }
  out.allySlots = [...(out.allySlots || []), ...d.allySlots].slice(0, 4).map((s) => ({ ...botSlot(), ...s }));
  out.enemySlots = [...(out.enemySlots || []), ...d.enemySlots].slice(0, 5).map((s) => ({ ...botSlot(), ...s }));
  out.allies = Math.max(0, Math.min(4, out.allies | 0));
  out.enemies = Math.max(1, Math.min(5, out.enemies | 0));
  out.ffa = Math.max(3, Math.min(4, out.ffa | 0));
  if (!['1v1', 'ffa', 'team'].includes(out.format)) out.format = 'team';
  if (!CLASSES[out.cls]) out.cls = save.cls;
  if (!(out.map >= -1 && out.map < VERSUS.length)) out.map = -1;
  return out;
}

function versusSetup() {
  audio.unlock();
  G.scene = G.mode === 'attract' ? 'title' : 'garage';
  input.releaseLock(); ui.hud(false); ui.clear('banner'); view.hideAim();
  const cfg = normVs(save.vs);
  G.setupCfg = cfg;
  ui.versusSetup(cfg, { onStart: (c) => { save.vs = c; save.cls = c.cls; persist(); audio.play('uiBig'); startVersus(c); }, onBack: toTitle });
}

function startVersus(cfg0) {
  audio.unlock();
  const cfg = normVs(cfg0);
  G.mode = 'versus';
  const L = versusLayout(cfg);
  const slots = L.map((s) => s.human
    ? { human: true, team: 0, label: 'You', color: s.color, cls: cfg.cls }
    : { human: false, team: s.team, skill: s.ref.skill, style: (PERSONALITIES[s.ref.style] || PERSONALITIES.brawler).style, clsPick: s.ref.cls || 'random', color: s.color, label: s.label });
  const teams = [...new Set(slots.map((s) => s.team))];
  G.vs = { cfg, slots, teams, wins: Object.fromEntries(teams.map((t) => [t, 0])), round: 0, stats: {}, team: cfg.format === 'team' };
  nextRound();
}

function nextRound() {
  const V = G.vs;
  V.round++;
  const map = V.cfg.map >= 0 ? V.cfg.map : Math.floor(Math.random() * VERSUS.length);
  for (const s of V.slots) if (!s.human) s.cls = CLASSES[s.clsPick] ? s.clsPick : pickRandomClass();
  const w = versusWorld(map, V.slots.map(({ clsPick, ...s }) => s), effectiveRating(save.dir, 0), Date.now() & 0xffff);
  w.tanks.forEach((t) => { const s = V.slots[t.slot]; if (s) { t.colorOverride = s.color; t.label = s.label; } });
  setWorld(w);
  G.mode = 'versus';
  G.scene = 'play'; ui.clear('screen');
  view.mode = save.settings.view;
  G.phase = 'banner'; G.phaseT = 0;
  let foes, sub;
  if (V.team) {
    const mine = V.slots.filter((s) => s.team === 0).length, theirs = V.slots.length - mine;
    foes = V.slots.filter((s) => s.team !== 0).map((s) => [s.color, `${s.label} · ${skillLabel(s.skill)} ${CLASSES[s.cls].label}`]);
    sub = `Team battle ${mine} v ${theirs} · you drive a ${CLASSES[V.cfg.cls].label}`;
  } else {
    foes = V.slots.slice(1).map((s) => [s.color, `${s.label} · ${skillLabel(s.skill)} ${CLASSES[s.cls].label}`]);
    sub = `${V.slots.length === 2 ? 'One on one' : 'Free for all'} · you drive a ${CLASSES[V.cfg.cls].label}`;
  }
  G.closeBanner = ui.banner({ big: `ROUND ${V.round}`, name: `${VERSUS[map].name} · first to ${V.cfg.rounds}`, foes, sub });
  ui.hud(true, { mode: view.mode, title: `ROUND ${V.round}`, sub: VERSUS[map].name });
  audio.stopMusic(); audio.play('banner');
}
const skillLabel = (s) => ({ cadet: 'Cadet', veteran: 'Veteran', ace: 'Ace', adaptive: 'Adaptive' }[s] || s);
const teamName = (V, t) => V.team ? (t === 0 ? 'Your team' : 'Enemy team') : t === 0 ? 'You' : V.slots.find((s) => s.team === t).label;
function scoreLine() {
  const V = G.vs;
  return V.teams.map((t) => ({ color: V.team ? TEAM_COLORS[t][0] : V.slots.find((s) => s.team === t).color, wins: V.wins[t], label: V.team ? (t === 0 ? 'US' : 'THEM') : null }));
}

function onVersusOutcome() {
  const V = G.vs, w = G.world, p = player();
  const winTeam = w.outcome.startsWith('team') ? +w.outcome.slice(4) : null;
  if (winTeam != null) V.wins[winTeam]++;
  addStats(V.stats, roundStats(w, p));
  // Director: rate the round against the average opposing skill
  const opp = V.slots.filter((s) => s.team !== 0);
  const threat = opp.reduce((a, s) => a + (s.skill === 'adaptive' ? save.dir.rating : SKILL_THREAT[s.skill]), 0) / opp.length + (opp.length - 1) * 0.08;
  if (save.dir.adaptive) recordResult(save.dir, Math.min(1, threat), winTeam === 0 ? 1 : winTeam == null ? 0.5 : 0, 0.5);
  persist();
  audio.stopMusic();
  const champ = Object.entries(V.wins).find(([, n]) => n >= V.cfg.rounds);
  const label = winTeam == null ? 'Draw' : winTeam === 0 ? (V.team ? 'Your team wins the round' : 'You win the round') : `${teamName(V, winTeam)} wins the round`;
  audio.play(winTeam === 0 ? 'win' : 'lose');
  if (!champ) {
    G.phase = 'lost'; G.phaseT = 0;
    G.closeBanner = ui.banner({ big: winTeam === 0 ? 'ROUND WON' : winTeam == null ? 'DRAW' : 'ROUND LOST', name: label, sub: V.teams.map((t) => `${teamName(V, t)} ${V.wins[t]}`).join('  ·  ') });
    return;
  }
  input.releaseLock();
  G.scene = 'results';
  ui.hud(false); view.hideAim();
  const youWon = +champ[0] === 0;
  ui.results({
    kicker: `Versus · ${V.round} ${V.round === 1 ? 'round' : 'rounds'}`, title: youWon ? 'Match won' : 'Match lost', stamp: youWon ? 'VICTORY' : 'DEFEAT',
    rows: V.teams.map((t) => {
      const who = V.team ? teamName(V, t) : t === 0 ? 'You' : (() => { const s = V.slots.find((q) => q.team === t); return `${s.label} · ${skillLabel(s.skill)}`; })();
      return [who, `${V.wins[t]} ${V.wins[t] === 1 ? 'round' : 'rounds'}`];
    }),
    stats: [...statsGrid(V.stats), ['Tanks destroyed', String(V.stats.ko || 0), 'good']],
    note: save.dir.adaptive ? `Director rating now ${Math.round(save.dir.rating * 100)}/100.` : null,
    actions: [['Title', toTitle], ['Change setup', versusSetup], ['Rematch', () => startVersus(V.cfg), 'primary']],
  });
}

// ------------------------------------------------------------------ spectating (team battles / FFA after a knock-out)
function specCandidates() {
  const w = G.world, p = player();
  if (!w || !p) return [];
  const allies = w.tanks.filter((t) => t.alive && t.team === p.team && t !== p);
  return allies.length ? allies : w.tanks.filter((t) => t.alive && t !== p);
}
function spectateNext(dir = 1) {
  const c = specCandidates();
  if (!c.length) { G.spec = null; return; }
  const k = c.findIndex((t) => t.id === G.spec);
  G.spec = c[(k + dir + c.length) % c.length].id;
  view.cam.snap = true;
}
function specTank() {
  const w = G.world; if (!w || G.spec == null) return null;
  let t = tankById(w, G.spec);
  if (!t || !t.alive) { spectateNext(); t = G.spec != null ? tankById(w, G.spec) : null; }
  return t;
}

// ------------------------------------------------------------------ combat feedback (events → HUD)
const MODULE_TEXT = { tracks: 'TRACKED!', turret: 'TURRET JAMMED', engine: 'ENGINE HIT', fire: 'ON FIRE', ammo: 'AMMO RACK!' };
function screenAngle(p, x, z) {
  const ax = view.screenAxes ? view.screenAxes() : { rx: 1, rz: 0, ux: 0, uz: -1 };
  const dx = x - p.x, dz = z - p.z;
  return Math.atan2(dx * ax.rx + dz * ax.rz, dx * ax.ux + dz * ax.uz);
}
function onEvents(w) {
  const p = player();
  if (!p || G.mode === 'attract') return;
  const texts = save.settings.combatText !== false;
  for (const e of w.events) {
    if (e.type === 'hit') {
      const t = tankById(w, e.tank); if (!t) continue;
      const by = e.by != null ? tankById(w, e.by) : null;
      const mine = by === p, onMe = t === p;
      if (mine && t.team !== p.team) { if (e.result === 'ricochet') G.tally.rico++; else if (e.result === 'nopen') G.tally.nopen++; }
      if (onMe && e.result !== 'pen') G.tally.blocked++;
      if (onMe) {
        const src = by && by !== p ? by : e;
        ui.hitMe(src.x != null ? screenAngle(p, src.x, src.z) : null, e.result === 'pen');
        if (e.result === 'pen') audio.play('hitme');
      }
      const friendVictim = t.team === p.team;
      const visible = mine || onMe || friendVictim || teamSees(w, p.team, t.id);
      if (!texts || !visible) continue;
      const minor = !(mine || onMe);
      if (onMe && !G.spec) {
        if (e.result === 'pen') { ui.hurt(`\u2212${Math.round(e.dmg)}`, 'dmg-me'); if (e.module && MODULE_TEXT[e.module]) ui.hurt(MODULE_TEXT[e.module], 'module'); }
        else ui.hurt(e.result === 'ricochet' ? 'RICOCHET!' : 'BLOCKED', e.result === 'ricochet' ? 'rico' : 'nopen');
        continue;
      }
      if (e.result === 'pen') {
        const kind = mine ? 'dmg-mine' : onMe ? 'dmg-me' : by && by.team === p.team ? 'dmg-ally' : friendVictim ? 'dmg-foe' : 'dmg-other';
        ui.float(t, `−${Math.round(e.dmg)}`, kind, { big: mine || onMe, minor });
        if (e.module && MODULE_TEXT[e.module]) ui.float(t, MODULE_TEXT[e.module], 'module', { minor });
      } else if (e.result === 'ricochet') ui.float(t, 'RICOCHET!', 'rico', { minor });
      else if (e.result === 'nopen') ui.float(t, 'NO PENETRATION', 'nopen', { minor });
    } else if (e.type === 'tankDie') {
      const t = tankById(w, e.tank); if (!t) continue;
      const by = e.by != null ? tankById(w, e.by) : null;
      const col = (q) => q === p ? '#ffd34d' : q.team === p.team ? '#8cc8ff' : '#ff8a78';
      const how = { ammo: 'ammo rack', fire: 'burned out', mine: 'mine' }[e.cause];
      if (by && by !== t) ui.feed([[by.label, col(by), 'who'], [' ✖ ', null, 'x'], [t.label, col(t), 'who'], how ? [` · ${how}`, null, 'how'] : null].filter(Boolean));
      else ui.feed([[t.label, col(t), 'who'], [how ? ` · ${how}` : ' · knocked out', null, 'how']]);
      if (by === p && t.team !== p.team) { ui.float(t, 'DESTROYED', 'kill', { big: true }); audio.play('kill'); }
      if (t === p && G.mode === 'versus' && !w.outcome) {
        // knocked out but the round goes on: watch an ally
        input.releaseLock();
        G.spec = null; spectateNext();
        ui.toast('KNOCKED OUT', '#ff8a78');
      }
    }
  }
}

// "ENEMY SPOTTED": an enemy comes into team view after being out of it for a while.
function computeSeen(w) {
  const p = player(), s = new Set();
  const team = p ? p.team : 0;
  for (const t of w.tanks) if (t.alive && t.team !== team && teamSees(w, team, t.id)) s.add(t.id);
  return s;
}
function updateSpotting(w) {
  G.seen = computeSeen(w);
  if (G.mode === 'attract' || G.scene !== 'play' || G.phase !== 'fight') { for (const id of G.seen) G.lastSeen.set(id, w.time); return; }
  const fresh = [];
  for (const id of G.seen) {
    const last = G.lastSeen.get(id);
    if (last == null || w.time - last > 5) fresh.push(id);
    G.lastSeen.set(id, w.time);
  }
  if (fresh.length) {
    const t = tankById(w, fresh[0]);
    ui.callout(fresh.length === 1 ? 'ENEMY SPOTTED' : `${fresh.length} ENEMIES SPOTTED`, fresh.length === 1 && t ? `${t.label} · ${CLASSES[t.type.cls]?.label || ''}` : null);
    audio.play('spot');
  }
}

// ------------------------------------------------------------------ one fixed sim step
function stepWorld(w) {
  for (const t of w.tanks) { t._rx = t.x; t._rz = t.z; }
  for (const s of w.shells) { s._rx = s.x; s._rz = s.z; }
  step(w, brainStep);
  onEvents(w);
  view.consume(w); w.events.length = 0;
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
function resume() { ui.clear('screen'); G.scene = 'play'; const p = player(); if (view.mode === 'chase' && p && p.alive && !G.botPlayer) input.requestLock(); }

input.onLockChange = (locked) => {
  const p = player();
  if (!locked && G.scene === 'play' && G.phase === 'fight' && view.mode === 'chase' && !G.botPlayer && p && p.alive) pauseGame();
};
canvas.addEventListener('mousedown', (e) => {
  audio.unlock();
  if (G.scene !== 'play') return;
  if (G.spec != null) { if (e.button === 0) spectateNext(1); else if (e.button === 2) spectateNext(-1); input.mouse.leftHit = false; return; }
  if (view.mode === 'chase' && !input.locked && !G.botPlayer) { input.requestLock(); input.mouse.leftHit = false; e.preventDefault(); }
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

// The line of fire: from the barrel along the turret until the first block, crate or visible
// tank, capped at 30 cells. One straight line — no bounce preview, no colour change.
const AIM_MAX = 30, AIM_STEP = 0.06;
function aimRay(w, p, seen) {
  const a = p.aim, cx = Math.cos(a), cz = Math.sin(a);
  const from = { x: p.x + cx * BARREL, z: p.z + cz * BARREL };
  let x = from.x, z = from.z, enemy = false;
  if (solidCellAt(w.grid, x, z, SHELL_R)) return { from, to: { x, z }, dist: 0, yaw: a, enemy: false, disp: p.disp };
  const n = Math.ceil(AIM_MAX / AIM_STEP);
  outer: for (let k = 0; k < n; k++) {
    const nx = x + cx * AIM_STEP, nz = z + cz * AIM_STEP;
    for (const t of w.tanks) {
      if (!t.alive || t === p) continue;
      if (t.team !== p.team && !seen.has(t.id)) continue; // no free wallhack on unspotted tanks
      const dx = t.x - x, dz = t.z - z;
      if (dx * dx + dz * dz > 1.2) continue;
      const hc = hullContact(t.x, t.z, t.rot, t.type.scale || 1, x, z, nx, nz, cx, cz);
      if (hc) { x = hc.x; z = hc.z; enemy = t.team !== p.team; break outer; }
    }
    if (solidCellAt(w.grid, nx, nz, SHELL_R)) break;
    x = nx; z = nz;
  }
  return { from, to: { x, z }, dist: Math.hypot(x - from.x, z - from.z) + BARREL, yaw: a, enemy, disp: p.disp };
}
function showAim(ray) {
  if (!ray) { view.hideAim(); return; }
  if (view.setAimLine) { view.setAimLine(ray.from, ray.to); return; }
  // fallback for the old view: a dotted straight line
  const pts = [], d = Math.hypot(ray.to.x - ray.from.x, ray.to.z - ray.from.z), n = Math.floor(d / 0.22);
  for (let k = 1; k <= n; k++) pts.push({ x: ray.from.x + (ray.to.x - ray.from.x) * k / n, z: ray.from.z + (ray.to.z - ray.from.z) * k / n });
  if (view.setAimPath) view.setAimPath(pts, null, G.time); else view.hideAim();
}
function reloadInfo(w, p) {
  const left = Math.max(0, p.cool), total = p.type.reload;
  const inFlight = liveShellsOf(w, p) >= p.type.maxShells;
  return { left, total, frac: Math.max(0, Math.min(1, 1 - left / total)), inFlight, ready: left <= 0 && !inFlight };
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
  const p = player();
  if (G.scene === 'play' && (input.hit('KeyV') || input.pad.viewHit)) {
    view.mode = view.mode === 'chase' ? 'tactical' : 'chase';
    ui.setMode(view.mode);
    if (p) G.aimYaw = p.aim;
    if (view.mode === 'chase' && !G.botPlayer && p && p.alive) input.requestLock(); else input.releaseLock();
  }
  if (G.scene === 'play' && G.spec != null && (input.hit('Tab') || input.pad.fireHit)) spectateNext(input.down('ShiftLeft', 'ShiftRight') ? -1 : 1);
  if ((G.scene === 'results' || G.scene === 'garage') && input.hit('Enter', 'NumpadEnter') && !(document.activeElement && document.activeElement.tagName === 'BUTTON')) document.querySelector('.panel .actions .primary')?.click();

  let stepping = false;
  if (G.scene === 'title' || (G.mode === 'attract' && G.scene === 'garage')) stepping = true;
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
    ui.showLock(G.phase === 'fight' && view.mode === 'chase' && !input.locked && !G.botPlayer && p && p.alive && G.spec == null);
  }
  if (stepping) {
    if (p && p.alive && G.scene === 'play' && !G.botPlayer) controlPlayer(p, dt);
    acc += dt;
    let n = 0;
    while (acc >= DT && n < 5) {
      stepWorld(w);
      acc -= DT; n++;
      if (w.over) break;
    }
    if (n === 5) acc = 0;
    if (w.over) {
      if (G.scene === 'title' || G.mode === 'attract') { setWorld(attractWorld()); view.cam.introT = 1; }
      else if (G.phase === 'fight') { G.mode === 'campaign' ? onCampaignOutcome() : onVersusOutcome(); }
    }
  }
  renderFrame(dt, Math.min(1, acc / DT));
  // audio listener + engine
  const pw = player(), ft = focusTank() || pw;
  if (ft) { audio.listener.x = ft.x; audio.listener.z = ft.z; audio.listener.yaw = view.mode === 'chase' ? (ft === pw ? G.aimYaw : ft.aim) : -Math.PI / 2; }
  audio.engine(pw && pw.alive ? pw.speedNow : 0, G.scene === 'play' && pw && pw.alive);
  audio.burning(G.scene === 'play' || G.scene === 'title' ? G.world : null);
  audio.tickMusic();
  autoQuality(dt);
}

function focusTank() {
  const p = player();
  if (p && p.alive) return p;
  return specTank() || p;
}

function renderFrame(dt, alpha) {
  const w = G.world;
  const inGame = G.scene === 'play' || G.scene === 'paused';
  updateSpotting(w);
  const pw = player(), ft = focusTank();
  if (G.botPlayer && pw && pw.alive) G.aimYaw = pw.aim;
  const spectating = !!(pw && !pw.alive && ft && ft !== pw);
  const yaw = ft && ft !== pw ? ft.aim : G.aimYaw;
  view.sync(w, alpha, dt, ft, yaw, G.mode === 'attract' ? null : G.seen);
  G.aim = null;
  if (pw && pw.alive && inGame && (G.phase === 'fight' || G.phase === 'banner')) {
    G.aim = aimRay(w, pw, G.seen);
    showAim(save.settings.aimLine && G.phase === 'fight' ? G.aim : null);
  } else view.hideAim();
  view.render(dt, G.time);
  if (inGame) {
    const cands = spectating ? specCandidates() : [];
    ui.updateHUD(w, {
      player: pw, focus: ft, spectating, seen: G.seen, view, mode: view.mode, dt,
      lives: G.mode === 'campaign' ? G.lives : 0, maxLives: G.mode === 'campaign' ? Math.max(3, G.lives) : 0,
      score: G.mode === 'versus' && G.vs ? scoreLine() : null,
      aim: G.aim, reload: pw && pw.alive ? reloadInfo(w, pw) : null, minesLive: pw ? liveMinesOf(w, pw) : 0,
      specIndex: cands.findIndex((t) => t === ft), specCount: cands.length, specAllies: cands.length > 0 && cands[0].team === pw?.team,
    });
  }
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
function checkOutcome() {
  const w = G.world;
  if (w.over && G.scene === 'play' && G.phase === 'fight') { G.mode === 'campaign' ? onCampaignOutcome() : onVersusOutcome(); return true; }
  return false;
}
window.__tt = {
  get G() { return G; }, get world() { return G.world; }, view, save: () => save, ui, audio,
  pause(v = true) { G.paused = v; if (!v) { last = performance.now(); requestAnimationFrame(frame); } },
  tick(sec = 1 / 60, frames = 1) { for (let k = 0; k < frames; k++) { input.poll(); tick(sec); input.endFrame(); } },
  renderOnce() { renderFrame(1 / 60, 1); },
  // step the game logic without rendering (fast under SwiftShader); HUD events still fire
  sim(sec) {
    const n = Math.round(sec * 60);
    for (let k = 0; k < n; k++) {
      const w = G.world;
      if (w.over) { if (checkOutcome()) break; if (G.scene !== 'play') break; }
      stepWorld(w);
      if (view.fx && view.solidTop) view.fx.update(1 / 60, view.solidTop);
      if (k % 6 === 0) updateSpotting(w);
      if (w.over && checkOutcome()) break;
    }
    updateSpotting(G.world);
  },
  phase(ph) { G.phase = ph; G.phaseT = 0; if (ph === 'fight' && G.closeBanner) G.closeBanner(); },
  advance(sec) { const n = Math.round(sec * 60); for (let k = 0; k < n; k++) { const w = G.world; stepWorld(w); if (view.fx && view.solidTop) view.fx.update(1 / 60, view.solidTop); if (w.over) break; } },
  botPlayer(skill = 'ace') { G.botPlayer = skill; const p = player(); if (p) { p.botDriven = true; p.skill = skill; p.style = 'trick'; p._profile = null; p.ctrl.drive = false; p.ctrl.throttle = 0; p.ctrl.steer = 0; } },
  garage(cls) { if (!CLASSES[cls]) return null; save.cls = cls; if (save.vs) save.vs.cls = cls; if (G.setupCfg) G.setupCfg.cls = cls; persist(); if (ui._garageSet && G.scene === 'garage') ui._garageSet(cls); return cls; },
  spectateNext, campaignGarage, versusSetup,
  state() { const p = player(); return { scene: G.scene, mode: G.mode, phase: G.phase, mission: G.mission, lives: G.lives, cls: p ? p.type.cls : null, hp: p ? p.hp : null, alive: p ? p.alive : null, spec: G.spec, round: G.vs ? G.vs.round : null, wins: G.vs ? { ...G.vs.wins } : null, outcome: G.world ? G.world.outcome : null }; },
  startCampaign, startVersus, toTitle, beginMission, pauseGame, resume,
};

// ------------------------------------------------------------------ go
toTitle();
if (params.has('m')) startCampaign(+params.get('m'));
setTimeout(() => { loading.style.opacity = 0; setTimeout(() => loading.remove(), 700); }, 150);
if (!G.paused) requestAnimationFrame(frame);
