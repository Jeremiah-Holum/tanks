// Steel Front: boot → hangar (Screens) → BATTLE! → loading (real progress) → countdown → battle →
// results (Screens.finishBattle) → hangar. The battle itself lives in src/game/session.js.
// Debug URL params (see docs/notes/integration.md): q, fast, god, speed, limit, t, map, tank,
// size, seed, auto, bots, autopilot, countdown, perf, scale.
import { Screens } from './ui/screens.js';
import { Audio } from './audio.js';
import { buildBattle } from './meta/matchmaker.js';
import { TANKS } from './meta/roster.js';
import { lineupOf } from './meta/profile.js';
import { BattleSession } from './game/session.js';
import { spawnsLeft } from './sim/battle.js';

const params = new URLSearchParams(location.search);
const root = document.getElementById('ui');
const audio = new Audio();
let session = null, lastT = performance.now(), state = 'hangar';

// audio needs a user gesture
const unlock = () => { try { audio.unlock(); } catch { /* no audio */ } };
window.addEventListener('pointerdown', unlock, { capture: true });
window.addEventListener('keydown', unlock, { capture: true });

const screens = new Screens(root, {
  audio,
  onBattle: (tankId, { battle }) => startBattle(tankId, battle),
  onSettings: (s) => { session?.applySettings(s); },
});

async function startBattle(tankId, battle) {
  if (session) return;
  // URL overrides for testing: map, size, seed, limit
  if (params.has('map') || params.has('size') || params.has('seed')) {
    battle = buildBattle(screens.profile, battle?.meta?.lineup || tankId, {
      start: battle?.meta?.tankId,
      size: +(params.get('size') || screens.battleSize), mapId: params.get('map') || undefined,
      seed: params.has('seed') ? +params.get('seed') : undefined,
    });
  }
  state = 'loading';
  screens.showLoading(battle);
  const s = session = new BattleSession({ battle, screens, audio, settings: screens.settings, params, onExit: endBattle });
  try {
    await s.load((p, label) => screens.setLoadingProgress(p, label));
  } catch (e) {
    console.error('battle failed to load', e);
    s.dispose(); session = null; state = 'hangar';
    screens.showHangar(); screens.toast('The battle could not be loaded: ' + e.message, 'warn');
    return;
  }
  screens.hideAll();
  state = 'battle';
  s.start();
}

function endBattle({ world, playerId, playerIds, battle }) {
  const s = session;
  state = 'results';
  let report = null;
  try { report = screens.finishBattle(world, playerIds || playerId, battle); }
  catch (e) { console.error('results failed', e); screens.showHangar(); }
  window.__sf.lastReport = report;
  // tear the battle down after the results screen is up
  setTimeout(() => { s.dispose(); if (session === s) session = null; }, 0);
}

function loop(now) {
  const dt = Math.min(5, Math.max(0, (now - lastT) / 1000)); // the session clamps it
  lastT = now;
  if (session && state === 'battle') {
    try { session.frame(dt); }
    catch (e) { console.error(e); state = 'error'; }
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// Debug / test hook (tools/verify.mjs, tools/shot-game.mjs)
window.__sf = {
  screens, audio, get session() { return session; },
  state() {
    const s = session, w = s?.world, me = s?.player;
    return {
      state, screen: screens.current, phase: s?.phase || null,
      time: w ? +w.time.toFixed(2) : null, result: w?.result || null, quality: s?.quality,
      cam: s?.cam ? { sniper: s.cam.sniper, zoom: s.cam.zoom, dist: +s.cam.dist.toFixed(1), yaw: +s.cam.yaw.toFixed(3), pitch: +s.cam.pitch.toFixed(3) } : null,
      player: me ? { id: me.id, tankId: me.def.id, alive: me.alive, hp: Math.round(me.hp), speed: +me.speed.toFixed(2), x: +me.pos.x.toFixed(1), z: +me.pos.z.toFixed(1), turretYaw: +me.turretYaw.toFixed(3), shell: me.shell, shots: me.stats.shots, ammo: me.ammo.slice(), reload: +me.reload.toFixed(2), reloads: s.reloads, spotted: me.spotted } : null,
      alive: w ? [0, 1].map((k) => w.tanks.filter((t) => t.team === k && t.alive).length) : null,
      driven: s?.driven ? s.driven.slice() : null, reserve: w ? w.reserve[s.team].map((e) => e.def.id) : null,
      spawns: w && s?._deploysLeft ? { mine: s._deploysLeft(), team: [0, 1].map((k) => spawnsLeft(w, k)), tanks: w.tanks.length, gone: w.tanks.filter((t) => t.gone).length } : null,
      respawn: s?.respawn ? { left: +s.respawn.t.toFixed(1), pick: s.respawn.pick } : null,
      startPick: s?.startPick ? { left: +s.startPick.t.toFixed(1), pick: s.startPick.pick, lineup: s.lineup.map((e) => e.def.id) } : null,
      menu: s?.menuOpen || false, score: s?.scoreOpen || false, lock: s?.lockTarget ?? null,
      perf: s ? { ...s.perf, win: undefined } : null, lastReport: this.lastReport ? { result: this.lastReport.result, xp: this.lastReport.xp?.total, credits: this.lastReport.credits?.net } : null,
    };
  },
  lastReport: null,
  setSpeed(n) { if (session) session.speed = n; },   // test hooks: sim speed multiplier, remaining battle time
  killPlayer() { session?.debugKill(); },             // test hook: destroy the player's tank now (for the lineup respawn test)
  endIn(sec) { if (session?.world) session.world.timeLimit = Math.min(session.world.timeLimit, session.world.time + sec); },
};

// boot
if (params.get('auto') === '1') {
  const id = params.get('tank') && TANKS[params.get('tank')] ? params.get('tank') : screens.profile.selected;
  if (params.get('tank') && TANKS[id]) screens.profile.selected = id;
  const battle = buildBattle(screens.profile, params.get('tank') ? [id] : lineupOf(screens.profile), { start: id, size: +(params.get('size') || screens.battleSize), mapId: params.get('map') || undefined, seed: params.has('seed') ? +params.get('seed') : undefined });
  startBattle(id, battle);
} else screens.showHangar();
