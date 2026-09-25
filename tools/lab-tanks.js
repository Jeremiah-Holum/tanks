// Tank lab: one tank (or the whole roster in tiles) on neutral ground under late-afternoon light,
// for screenshots of src/render/tankModel.js, tanks.js (TankRenderer) and fx.js (FxRenderer).
// Query: id, yaw (camera orbit °), elev (°), dist (m), zoom, turret (°), gun (°), lod (0|1),
//   dmg (tracks|trackL|burning|dead|ammorack), paint, number, q (low|medium|high),
//   grid=1 [&nation=usa&page=0&per=12], fx=<demo name> [&t=seconds], move=<m/s>, info=1
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { buildTankModel, triCount, modelStats } from '../src/render/tankModel.js';
import { TankRenderer } from '../src/render/tanks.js';
import { FxRenderer } from '../src/render/fx.js';
import { TANKS } from '../src/data/tanks.js';

const Q = new URLSearchParams(location.search);
const num = (k, d) => (Q.has(k) ? +Q.get(k) : d);
const canvas = document.getElementById('gl');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(1);
renderer.setSize(innerWidth, innerHeight, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xa9bccb);
scene.fog = new THREE.Fog(0xa9bccb, 120, 900);
const pm = new THREE.PMREMGenerator(renderer);
scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.45;
const hemi = new THREE.HemisphereLight(0xc4d6e8, 0x5d5140, 0.7);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffe2bd, 2.6);
sun.position.set(-30, 26, 18);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -9, right: 9, top: 9, bottom: -9, near: 1, far: 120 });
sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.02;
scene.add(sun, sun.target);

// neutral ground: dry grass / dirt noise
function groundTex() {
  const c = document.createElement('canvas'); c.width = c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = '#6d6a4c'; g.fillRect(0, 0, 512, 512);
  let s = 3; const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 9000; i++) {
    const v = r();
    g.fillStyle = v < 0.4 ? `rgba(88,84,58,${0.3 + r() * 0.4})` : v < 0.7 ? `rgba(120,108,78,${0.2 + r() * 0.3})` : `rgba(70,76,48,${0.3 + r() * 0.4})`;
    g.fillRect(r() * 512, r() * 512, 1 + r() * 4, 1 + r() * 4);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(60, 60); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}
const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardMaterial({ map: groundTex(), roughness: 0.95 }));
ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);

const camera = new THREE.PerspectiveCamera(num('fov', 35), innerWidth / innerHeight, 0.1, 3000);
const labels = document.getElementById('labels'), hud = document.getElementById('hud');
const lab = { done: false, info: {}, scene, camera, renderer, THREE, TANKS };
window.__lab = lab;

const ids = Object.keys(TANKS);
function dmgOf(s) {
  if (!s) return null;
  return { tracks: s === 'tracks' ? [true, true] : s === 'trackL' ? [true, false] : undefined, burning: s === 'burning', dead: s === 'dead' || s === 'ammorack', ammorack: s === 'ammorack', seed: 0.37 };
}
function frame(def, yawDeg, elevDeg, dist) {
  const h = def.hull, L = Math.max(h.L, h.L / 2 + (def.guns[0].len || 3) + (def.turret.z || 0));
  const size = Math.max(L, h.W + 2 * h.track.w, 2.6);
  const d = (dist || size * 0.62 / Math.tan((camera.fov * DEG) / 2) / Math.min(1, camera.aspect * 0.8)) / num('zoom', 1);
  const y = (h.clr + h.H + def.turret.H) * 0.45;
  const a = yawDeg * DEG, e = elevDeg * DEG;
  camera.position.set(Math.sin(a) * Math.cos(e) * d, y + Math.sin(e) * d, Math.cos(a) * Math.cos(e) * d);
  camera.lookAt(0, y, h.L * 0.05);
}
const DEG = Math.PI / 180;

// Single tank through TankRenderer + FxRenderer with a fake one-tank world.
//   dmg: tracks|trackL|burning|dead|ammorack   move: m/s   t: seconds to simulate before the shot
//   fx: shot|ricochet|nopen|pen|he|track|impact:<surface>|splash|tracer|kill  ft: seconds after the fx event
async function single() {
  const id = Q.get('id') || 'usa_m4';
  const def = TANKS[id];
  if (!def) throw new Error('no tank ' + id);
  const tr = new TankRenderer(scene, Q.get('q') || 'high');
  const fx = new FxRenderer(scene, Q.get('q') || 'high');
  const dmg = Q.get('dmg') || '';
  const tank = {
    id: 1, team: 0, def, gunDef: def.guns[num('gunIndex', 0)], gunIndex: num('gunIndex', 0), pos: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, roll: 0,
    speed: num('move', 0), yawRate: 0, throttle: num('move', 0) ? 1 : 0, turretYaw: num('turret', 0) * DEG, gunPitch: num('gun', 0) * DEG,
    alive: !(dmg === 'dead' || dmg === 'ammorack'), fire: dmg === 'burning' ? { t: 0 } : null, deathCause: dmg === 'ammorack' ? 'ammorack' : 'shot',
    modules: { trackL: { state: dmg === 'tracks' || dmg === 'trackL' ? 'destroyed' : 'ok' }, trackR: { state: dmg === 'tracks' ? 'destroyed' : 'ok' } },
  };
  const world = { time: 0, tanks: [tank], shells: [], events: [], map: null, byId: { 1: tank } };
  const lod = Q.has('lod') ? num('lod', 0) : null;
  if (lod != null) tr.setQuality(lod ? 'low' : 'high');
  frame(def, num('yaw', 35), num('elev', 16), num('dist', 0));
  camera.updateMatrixWorld();
  const step = (dt) => {
    world.time += dt;
    if (tank.speed) { tank.pos.x += Math.sin(tank.yaw) * tank.speed * dt; tank.pos.z += Math.cos(tank.yaw) * tank.speed * dt; }
    for (const e of world.events) { tr.handle(e); fx.handle(e, world); }
    world.events.length = 0;
    tr.sync(world, { alpha: 1, dt, camera: lod != null ? (lod ? { matrixWorld: new THREE.Matrix4().makeTranslation(0, 0, 9999), fov: 55 } : camera) : camera });
    fx.update(dt, camera, world);
  };
  if (dmg === 'ammorack') world.events.push({ type: 'kill', victim: 1, cause: 'ammorack' });
  const T = num('t', dmg === 'ammorack' ? 3 : dmg === 'dead' ? 6 : dmg === 'burning' ? 3 : tank.speed ? 3 : 0.1);
  for (let t = 0; t < T; t += 1 / 30) step(1 / 30);
  // keep the moving tank framed
  if (tank.speed) { const d = camera.position.clone().sub(new THREE.Vector3(0, 0, 0)); camera.position.set(tank.pos.x + d.x, d.y, tank.pos.z + d.z); camera.lookAt(tank.pos.x, 1, tank.pos.z); camera.updateMatrixWorld(); }
  const kind = Q.get('fx');
  if (kind) {
    const m = tr.modelOf(1);
    m.group.updateMatrixWorld(true);
    const muz = m.parts.gunMesh.localToWorld(new THREE.Vector3(0, 0, m.info.muzzleLen));
    const dir = m.parts.gunMesh.localToWorld(new THREE.Vector3(0, 0, m.info.muzzleLen + 1)).sub(muz).normalize();
    const cal = tank.gunDef.cal;
    const hitP = { x: 0.3, y: def.hull.clr + def.hull.H * 0.6, z: def.hull.L / 2 + 0.05 }, n = { x: 0, y: 0.3, z: 0.95 };
    fx.shells.set(99, { type: kind === 'he' ? 'HE' : 'AP', cal: 88, dir: { x: 0.25, y: -0.05, z: -0.97 } });
    const ev = {
      shot: { type: 'shot', tank: 1, shell: 7, pos: muz, dir, cal, shellType: 'AP' },
      ricochet: { type: 'hit', target: 1, shell: 99, pos: hitP, normal: n, result: 'ricochet', plate: 'hull.front.upper' },
      nopen: { type: 'hit', target: 1, shell: 99, pos: hitP, normal: n, result: 'nopen', plate: 'hull.front.upper' },
      pen: { type: 'hit', target: 1, shell: 99, pos: hitP, normal: n, result: 'pen', dmg: 200, plate: 'hull.front.upper' },
      he: { type: 'hit', target: 1, shell: 99, pos: hitP, normal: n, result: 'nopen', shellType: 'HE', plate: 'hull.front.upper' },
      track: { type: 'hit', target: 1, shell: 99, pos: { x: def.hull.W / 2 + def.hull.track.w, y: 0.5, z: 1 }, normal: { x: 1, y: 0, z: 0 }, result: 'track', plate: 'track' },
      kill: { type: 'kill', victim: 1, cause: 'shot' },
    }[kind];
    if (ev) world.events.push(ev);
    else if (kind.startsWith('impact')) {
      const surf = kind.split(':')[1] || 'dirt';
      fx.shells.set(98, { type: Q.get('shell') || 'AP', cal: 88 });
      world.events.push({ type: 'impact', shell: 98, pos: { x: 3, y: 0, z: 5 }, normal: { x: 0, y: 1, z: 0 }, surface: surf, shellType: Q.get('shell') || 'AP', cal: 88 });
    } else if (kind === 'tracer') {
      for (let k = 0; k < 3; k++) world.shells.push({ id: 50 + k, alive: true, tracer: true, type: 'AP', cal: 75 + k * 20, pos: { x: -6 + k * 3, y: 2 + k, z: 8 + k * 2 }, vel: { x: 500, y: 5, z: -120 } });
    }
    const FT = num('ft', 0.03);
    for (let t = 0; t < FT; t += 1 / 60) step(1 / 60);
    step(1e-4);
  }
  renderer.render(scene, camera);
  const md = tr.modelOf(1);
  lab.info = { id, tris: triCount(md.group), lod: md.lod, fx: fx.stats(), ...modelStats(def) };
  lab.tr = tr; lab.fx = fx; lab.world = world;
  if (Q.get('info') !== '0') hud.textContent = `${def.name}  (${id})  tier ${def.tier} ${def.cls}  ·  tris ${lab.info.tris} (near ${lab.info.near}, far ${lab.info.far})`;
}

// Mini battle on a flat test map with the sim's simpleBot: ?battle=1&ids=a,b,c&t=20&cam=x,y,z,lx,ly,lz
async function battle() {
  const { createBattle, stepBattle, DT } = await import('../src/sim/battle.js');
  const { testMap, simpleBot } = await import('../src/sim/testmap.js');
  const map = testMap({ size: 1000, res: 129, hills: 0 });
  ground.position.y = 10;
  const ids = (Q.get('ids') || 'usa_m4,ger_pz4h,ussr_t34,ger_tiger,usa_m10,ussr_is').split(',');
  const teams = [[], []];
  ids.forEach((id, k) => teams[k % 2].push({ def: TANKS[id], gun: 0, name: id, player: k === 0, bot: { skill: 0.7 } }));
  const world = createBattle({ map, seed: num('seed', 3), teams });
  for (const t of world.tanks) { t.pos.z = t.team ? 500 + 60 : 500 - 60; t.pos.x = 500 + (t.id % 5 - 2) * 12; }
  const bots = new Map(world.tanks.map((t) => [t.id, simpleBot(t)]));
  const tr = new TankRenderer(scene, 'high'), fx = new FxRenderer(scene, 'high');
  const c = (Q.get('cam') || '540,25,470,500,10,500').split(',').map(Number);
  camera.position.set(c[0], c[1], c[2]); camera.lookAt(c[3], c[4], c[5]); camera.updateMatrixWorld();
  sun.target.position.set(c[3], c[4], c[5]); sun.position.set(c[3] - 30, c[4] + 26, c[5] + 18);
  Object.assign(sun.shadow.camera, { left: -60, right: 60, top: 60, bottom: -60 }); sun.shadow.camera.updateProjectionMatrix();
  const T = num('t', 20);
  const ctl = new Map();
  let events = 0;
  for (let k = 0; k < T / DT; k++) {
    for (const t of world.tanks) if (t.alive) ctl.set(t.id, bots.get(t.id)(world));
    stepBattle(world, ctl);
    for (const e of world.events) { tr.handle(e); fx.handle(e, world); events++; }
    tr.sync(world, { alpha: 1, dt: DT, camera, playerId: world.tanks[0].id });
    fx.update(DT, camera, world);
    if (world.result) break;
  }
  renderer.render(scene, camera);
  lab.info = { time: world.time.toFixed(1), events, alive: world.tanks.filter((t) => t.alive).length, fx: fx.stats(), tanks: tr.stats(), result: world.result };
  lab.world = world; lab.tr = tr; lab.fx = fx;
}

async function grid() {
  const nation = Q.get('nation');
  const list = ids.filter((id) => !nation || TANKS[id].nation === nation).sort((a, b) => TANKS[a].tier - TANKS[b].tier);
  const per = num('per', 12), page = num('page', 0);
  const show = list.slice(page * per, page * per + per);
  const cols = num('cols', show.length <= 4 ? 2 : show.length <= 9 ? 3 : 4), rows = Math.ceil(show.length / cols);
  const W = innerWidth, H = innerHeight, tw = Math.floor(W / cols), th = Math.floor(H / rows);
  camera.aspect = tw / th; camera.updateProjectionMatrix();
  renderer.setScissorTest(true);
  renderer.setClearColor(0x000000);
  const out = {};
  const models = show.map((id) => { const m = buildTankModel(TANKS[id], { lod: num('lod', 0), number: 100 + (id.length * 37) % 800 }); m.update({ turretYaw: num('turret', 0) * DEG, gunPitch: num('gun', 0) * DEG }, 0); scene.add(m.group); m.group.visible = false; return m; });
  show.forEach((id, k) => {
    const c = k % cols, r = Math.floor(k / cols);
    const x = c * tw, y = H - (r + 1) * th;
    models.forEach((m, j) => (m.group.visible = j === k));
    frame(TANKS[id], num('yaw', 35), num('elev', 16), 0);
    renderer.setViewport(x, y, tw, th); renderer.setScissor(x, y, tw, th);
    renderer.render(scene, camera);
    const el = document.createElement('div');
    el.style.left = c * tw + 'px'; el.style.top = r * th + 'px';
    const tris = triCount(models[k].group);
    el.innerHTML = `${TANKS[id].name} <span>${['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII'][TANKS[id].tier]} ${TANKS[id].cls} · ${Math.round(tris / 100) / 10}k</span>`;
    labels.appendChild(el);
    out[id] = tris;
  });
  lab.info = { page, of: Math.ceil(list.length / per), tris: out };
}

(async () => {
  try {
    if (Q.get('grid')) await grid(); else if (Q.get('battle')) await battle(); else await single();
  } catch (e) { console.error('LAB ' + e.message + '\n' + e.stack); lab.info = { error: e.message }; }
  lab.done = true;
})();
