// World render lab: loads a map and places the camera from query params, for eyeballing and
// for tools/shot-world.mjs. Params:
//   map=ashford|kessel|steppe|kolvik|test  q=low|medium|high  time=<hour 6..20> (sun override)
//   x,z = ground point (default map centre)   y = eye height above ground (default 3.5)
//   yaw (deg, 0 = +z, 90 = +x)  pitch (deg, − = down)  fov (deg, default 55)
//   dist = orbit distance behind (x,z) (third person)   sniper=1   tanks=1 (a battle via sim/battle.js)
//   spawn=<k> puts the camera behind team-0 tank k (needs tanks=1)   live=1 keeps rendering (mouse look)
import { BattleView } from '../src/render/battleView.js';

const P = new URLSearchParams(location.search);
const num = (k, d) => (P.has(k) && P.get(k) !== '' ? +P.get(k) : d);

// Fallback procedural map (used when sim/map is unavailable or map=test).
function testMap() {
  const res = 257, size = 1000, cell = size / (res - 1);
  const heights = new Float32Array(res * res), ground = new Uint8Array(res * res);
  for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) {
    const x = i * cell, z = j * cell;
    heights[j * res + i] = 12 + 8 * Math.sin(x / 130) * Math.cos(z / 170) + 4 * Math.sin((x + z) / 60);
    ground[j * res + i] = Math.abs(x - 500 + 40 * Math.sin(z / 90)) < 5 ? 2 : (Math.sin(x / 70) * Math.sin(z / 90) > 0.5 ? 8 : 0);
  }
  const objects = []; let id = 0, s = 7;
  const r = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  for (let k = 0; k < 500; k++) {
    const x = 60 + r() * 880, z = 60 + r() * 880, i = Math.round(x / cell), j = Math.round(z / cell);
    const kind = k % 3 === 0 ? 'bush' : k % 3 === 1 ? 'tree' : 'pine';
    const sc = kind === 'bush' ? [2, 0.9, 2] : kind === 'tree' ? [3, 4.5, 3] : [3.2, 9, 3.2];
    objects.push({ id: id++, kind, x, y: heights[j * res + i], z, yaw: r() * 6.28, s: sc, variant: k % 4 });
  }
  objects.push({ id: id++, kind: 'house', x: 520, y: 12, z: 500, yaw: 0.3, s: [6, 4.3, 4.8], variant: 0 });
  return { id: 'test', name: 'Test', size, res, cell, heights, ground, water: null, objects, bases: [], spawns: [[], []], points: [], lanes: [],
    theme: { name: 'summer' }, play: { min: 50, max: 950 } };
}

async function getMap(id) {
  if (id === 'test') return testMap();
  try { const m = await import('../src/sim/map/index.js'); return m.loadMap(id); }
  catch (e) { console.warn('LAB map module unavailable, using test map:', e.message); return testMap(); }
}

async function makeWorld(map) {
  const world = { time: 0, map, tanks: [], shells: [], events: [], bases: [] };
  if (!P.get('tanks')) return world;
  try {
    const [{ createBattle }, { TANKS }] = await Promise.all([import('../src/sim/battle.js'), import('../src/data/tanks.js')]);
    const ids = Object.keys(TANKS);
    const team = (t) => [...Array(5)].map((_, k) => ({ def: TANKS[ids[(k * 7 + t * 3) % ids.length]], gun: 0, name: 'T' + t + k, player: t === 0 && k === 0, bot: null, ammo: [30, 10, 10], consumables: [], crewSkill: 1 }));
    return createBattle({ map, seed: 1, teams: [team(0), team(1)] });
  } catch (e) { console.warn('LAB battle unavailable:', e.message); return world; }
}

const canvas = document.getElementById('gl');
const view = new BattleView(canvas, { quality: P.get('q') || 'medium' });
const mapId = P.get('map') || 'ashford';
const map = await getMap(mapId);
const t0 = performance.now();
view.loadMap(map, { time: P.has('time') ? +P.get('time') : undefined });
const loadMs = performance.now() - t0;
const world = await makeWorld(map);
await view.ready;

const cam = { pos: { x: 0, y: 0, z: 0 }, look: { x: 0, y: 0, z: 1 }, fov: 55 };
const st = { x: 500, z: 500, y: 3.5, yaw: 0, pitch: -4, fov: 55, dist: 0, sniper: false };
function set(params = {}) {
  const g = (k, d) => (params[k] !== undefined && params[k] !== '' ? +params[k] : d);
  st.x = g('x', map.size / 2); st.z = g('z', map.size / 2); st.y = g('y', 3.5); st.yaw = g('yaw', 0); st.pitch = g('pitch', -4);
  st.fov = g('fov', 55); st.dist = g('dist', 0); st.sniper = !!+(params.sniper || 0);
  if (params.spawn !== undefined && world.tanks.length) {
    const t = world.tanks.filter((t) => t.team === 0)[+params.spawn] || world.tanks[0];
    st.x = t.pos.x; st.z = t.pos.z; st.yaw = t.yaw * 180 / Math.PI; st.dist = g('dist', 9); st.y = g('y', 3.2);
  }
  place();
}
function place() {
  const a = st.yaw * Math.PI / 180, p = st.pitch * Math.PI / 180;
  const fx = Math.sin(a) * Math.cos(p), fy = Math.sin(p), fz = Math.cos(a) * Math.cos(p);
  let px = st.x - Math.sin(a) * st.dist, pz = st.z - Math.cos(a) * st.dist;
  const py = view.heightAt(px, pz) + st.y;
  cam.pos = { x: px, y: py, z: pz }; cam.look = { x: px + fx * 100, y: py + fy * 100, z: pz + fz * 100 }; cam.fov = st.fov;
}
set(Object.fromEntries(P));

let last = performance.now();
const hud = document.getElementById('hud');
function frame(n = 1, dt = 1 / 60) {
  let s;
  for (let k = 0; k < n; k++) s = view.frame(world, { cam, alpha: 1, visible: null, playerId: world.tanks[0]?.id ?? null, dt, sniper: st.sniper, events: [] });
  return { ...s, loadMs: Math.round(loadMs) };
}
function census() {
  const out = {};
  view.scene.traverseVisible((o) => {
    if (!o.isMesh) return;
    const g = o.geometry, n = g.index ? g.index.count / 3 : g.attributes.position.count / 3;
    const k = o.name || o.type; const e = out[k] || (out[k] = { n: 0, tris: 0 }); e.n++; e.tris += Math.round(o.isInstancedMesh ? n * o.count : n);
  });
  return out;
}
window.__lab = { view, map, world, set, frame, census, st, place };
if (P.get('live')) {
  let drag = false, mx = 0, my = 0; const keys = {};
  canvas.onmousedown = (e) => { drag = true; mx = e.clientX; my = e.clientY; };
  onmouseup = () => (drag = false);
  onmousemove = (e) => { if (!drag) return; st.yaw -= (e.clientX - mx) * 0.2; st.pitch = Math.max(-89, Math.min(89, st.pitch - (e.clientY - my) * 0.2)); mx = e.clientX; my = e.clientY; };
  onkeydown = (e) => (keys[e.key.toLowerCase()] = true); onkeyup = (e) => (keys[e.key.toLowerCase()] = false);
  onresize = () => view.resize();
  const loop = () => {
    const now = performance.now(), dt = Math.min(0.1, (now - last) / 1000); last = now;
    const a = st.yaw * Math.PI / 180, sp = (keys.shift ? 60 : 15) * dt;
    if (keys.w) { st.x += Math.sin(a) * sp; st.z += Math.cos(a) * sp; } if (keys.s) { st.x -= Math.sin(a) * sp; st.z -= Math.cos(a) * sp; }
    if (keys.a) { st.x += Math.cos(a) * sp; st.z -= Math.sin(a) * sp; } if (keys.d) { st.x -= Math.cos(a) * sp; st.z += Math.sin(a) * sp; }
    if (keys.q) st.y += sp; if (keys.e) st.y = Math.max(0.5, st.y - sp);
    place();
    const s = frame(1, dt);
    hud.textContent = `${map.id} ${view.q.name}  calls ${s.calls}  tris ${(s.tris / 1e3).toFixed(0)}k  cpu ${s.ms.toFixed(1)} ms  fps ${(1 / dt).toFixed(0)}\n` +
      `x ${st.x.toFixed(0)} z ${st.z.toFixed(0)} y ${st.y.toFixed(1)} yaw ${st.yaw.toFixed(0)} pitch ${st.pitch.toFixed(0)}  (drag look, WASD move, QE up/down, shift fast)`;
    requestAnimationFrame(loop);
  };
  loop();
}
console.log('LAB ready', map.id, 'load', Math.round(loadMs), 'ms');
