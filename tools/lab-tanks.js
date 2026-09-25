// Tank lab: one tank (or the whole roster in tiles) on neutral ground under late-afternoon light,
// for screenshots of src/render/tankModel.js, tanks.js (TankRenderer) and fx.js (FxRenderer).
// Query: id, yaw (camera orbit °), elev (°), dist (m), zoom, turret (°), gun (°), lod (0|1),
//   dmg (tracks|trackL|burning|dead|ammorack), paint, number, q (low|medium|high),
//   grid=1 [&nation=usa&page=0&per=12], fx=<demo name> [&t=seconds], move=<m/s>, info=1
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { buildTankModel, triCount, modelStats } from '../src/render/tankModel.js';
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

async function single() {
  const id = Q.get('id') || 'usa_m4';
  const def = TANKS[id];
  if (!def) throw new Error('no tank ' + id);
  const model = buildTankModel(def, { lod: num('lod', 0), paint: Q.get('paint') || undefined, number: Q.get('number') ?? undefined, gunIndex: num('gunIndex', 0) });
  scene.add(model.group);
  const d = dmgOf(Q.get('dmg'));
  if (d) model.setDamage(d);
  const st = { turretYaw: num('turret', 0) * DEG, gunPitch: num('gun', 0) * DEG, speed: num('move', 0), yawRate: 0 };
  // advance time (turret flight, track scroll)
  const T = num('t', d && d.ammorack ? 3 : 0);
  for (let t = 0; t < T; t += 1 / 30) model.update(st, 1 / 30);
  model.update(st, 0);
  frame(def, num('yaw', 35), num('elev', 16), num('dist', 0));
  renderer.render(scene, camera);
  const s = modelStats(def);
  lab.info = { id, tris: triCount(model.group), near: s.near, far: s.far };
  if (Q.get('info') !== '0') hud.textContent = `${def.name}  (${id})  tier ${def.tier} ${def.cls}  ·  tris ${lab.info.tris} (far LOD ${s.far})`;
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
    if (Q.get('grid')) await grid(); else await single();
  } catch (e) { console.error('LAB ' + e.message + '\n' + e.stack); lab.info = { error: e.message }; }
  lab.done = true;
})();
