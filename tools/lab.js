// Render lab: drives src/render/view.js with real sim worlds, without main.js / UI.
// Used by tools/labshot.mjs for screenshots and perf numbers.
import { View } from '../src/render/view.js';
import { campaignWorld, versusWorld } from '../src/sim/game.js';
import { step, DT, teamSees, createWorld } from '../src/sim/world.js';
import { brainStep } from '../src/sim/ai.js';
import { CAMPAIGN, VERSUS } from '../src/sim/levels.js';

const params = new URLSearchParams(location.search);
const view = new View(document.getElementById('gl'), params.get('q') || 'high');
const sounds = [];
view.onSound = (k, o) => sounds.push(k);
let world = null, time = 0, aimYaw = 0;
const player = () => world && (world.tanks.find((t) => t.human) || world.tanks[0]);

const lab = {
  view, get world() { return world; }, sounds, CAMPAIGN, VERSUS,
  get player() { return player(); },
  campaign(n, cls = 'medium', seed = 1) { world = campaignWorld(n, 0.5, seed, { playerClass: cls }); this._set(); return { cols: world.cols, rows: world.rows, props: world.props.length, tanks: world.tanks.length }; },
  versus(map, clsList = ['medium', 'medium'], seed = 1) {
    const slots = clsList.map((cls, k) => ({ human: k === 0, team: k % 2, skill: 'ace', style: 'hunt', cls }));
    world = versusWorld(map, slots, 0.5, seed); this._set();
    return { cols: world.cols, rows: world.rows, props: world.props.length, tanks: world.tanks.length };
  },
  _set() { view.buildBoard(world); for (const t of world.tanks) { t._rx = t.x; t._rz = t.z; } aimYaw = player() ? player().aim : 0; view.cam.introT = 1; view.cam.snap = true; },
  bot(skill = 'ace') { const p = player(); if (p) { p.botDriven = true; p.skill = skill; p.style = 'hunt'; } },
  sim(sec, render = false) {
    const n = Math.round(sec * 60);
    for (let k = 0; k < n; k++) {
      for (const t of world.tanks) { t._rx = t.x; t._rz = t.z; }
      for (const s of world.shells) { s._rx = s.x; s._rz = s.z; }
      step(world, brainStep); view.consume(world); world.events.length = 0; time += DT;
      if (render) { const p = player(); aimYaw = p ? p.aim : aimYaw; view.sync(world, 1, DT, p, aimYaw, this.seen()); view.fx.update(DT, view.solidTop); }
      if (world.over) break;
    }
  },
  seen() { const p = player(); if (!p) return null; const s = new Set(); for (const t of world.tanks) if (teamSees(world, p.team, t.id)) s.add(t.id); return s; },
  frame(n = 2, dt = 1 / 60) {
    for (let k = 0; k < n; k++) {
      const p = player(); if (p && p.alive) aimYaw = p.aim;
      time += dt; view.sync(world, 1, dt, p, aimYaw, this.seen()); view.render(dt, time);
    }
    return view.stats;
  },
  emit(e) { world.events.push({ t: world.time, ...e }); view.consume(world); world.events.length = 0; },
};
window.__lab = lab;
// Draw-call census: visible meshes by top-level owner, and how many cast shadows.
lab.census = () => {
  const out = {};
  const scene = view.scene;
  for (const child of scene.children) {
    let n = 0, sh = 0, tri = 0;
    child.traverseVisible((o) => { if (o.isMesh || o.isPoints) { n++; if (o.castShadow) sh++; const g = o.geometry; const c = g.index ? g.index.count : g.attributes.position.count; tri += (o.isInstancedMesh ? o.count : 1) * c / 3; } });
    if (!n) continue;
    const k = child === view.boardGroup ? 'board' : child === view.roomGroup ? 'room' : [...view.tankObjs.values()].some((o) => o.root === child) ? 'tank' : child.type + ':' + (child.material && child.material.type || '');
    const e = out[k] || (out[k] = { n: 0, sh: 0, tri: 0 }); e.n += n; e.sh += sh; e.tri += Math.round(tri);
  }
  return out;
};
// Place the camera by hand, in sim coords (x, z on the board; y up). DOF focuses on the target.
lab.look = (px, py, pz, tx, ty, tz, fov = 40) => {
  const v = view; v.mode = 'free';
  v.camera.position.set(px - v.OX, py, pz - v.OZ); v.camera.fov = fov; v.camera.up.set(0, 1, 0);
  v.camera.lookAt(tx - v.OX, ty, tz - v.OZ); v.camera.updateProjectionMatrix();
  v.freeFocus = Math.hypot(px - tx, py - ty, pz - tz);
};
// Find props of a kind: returns [{i,j,w,h,...}]
lab.props = (kind) => world.props.filter((p) => !kind || p.kind === kind);

// A small flat test board with one tank per class (light, medium, heavy, td) in a row.
lab.flat = (cls = ['light', 'medium', 'heavy', 'td'], cols = 20, rows = 12, extra = [], gap = 3) => {
  const g = [...Array(rows)].map(() => Array(cols).fill('.'));
  for (const [i, j, ch] of extra) g[j][i] = ch;
  cls.forEach((c, k) => { g[6][4 + k * gap] = String(k); });
  const COLS = [0x3d6fc4, 0xc8453c, 0xc08a4a, 0x5d8a2f, 0x8d949c, 0x7a4fc0];
  const slots = cls.map((c, k) => ({ human: k === 0, team: k, skill: 'ace', style: 'hunt', cls: c, sp: k, color: COLS[k % COLS.length] }));
  world = createWorld({ level: g.map((r) => r.join('')), mode: 'versus', slots, seed: 3 });
  lab._set();
  return world.tanks.map((t) => [t.type.cls, t.x, t.z]);
};
// Advance visuals only (no sim, no render): sync + particles, n frames of dt.
lab.tick = (n = 1, dt = 1 / 60) => { for (let k = 0; k < n; k++) { time += dt; const p = player(); view.sync(world, 1, dt, p, p ? p.aim : 0, lab.seen()); view.fx.update(dt, view.solidTop); } };
lab.kill = (t, cause = 'shell') => { t.alive = false; t.hp = 0; lab.emit({ type: 'tankDie', tank: t.id, x: t.x, z: t.z, cause }); };
