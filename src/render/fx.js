// Battle effects for Steel Front: muzzle flash + smoke ring + ground blast, tracers, ricochet and
// non-pen sparks, penetration flash + debris, HE explosions, ground impacts by surface, fire,
// wreck smoke columns, track dust, exhaust puffs, craters (decals.js).
//
//   const fx = new FxRenderer(scene, quality)   // 'low' | 'medium' | 'high'
//   fx.handle(event, world)                     // world.events, after each stepBattle
//   fx.update(dt, camera[, world])              // once per rendered frame
// Continuous per-tank effects are driven by TankRenderer (it finds this instance through
// scene.userData.steelFx): trackDust, exhaust, fire, wreckSmoke.
//
// Everything is two pooled camera-facing particle systems (additive + alpha) drawn as instanced
// quads from one procedural atlas, simulated on the CPU (SoA arrays) and uploaded once a frame.
import * as THREE from 'three';
import { GroundDecals } from './decals.js';

const QUALITY = {
  low: { add: 900, alpha: 1400, mul: 0.5, lights: 0 },
  medium: { add: 2200, alpha: 3200, mul: 0.8, lights: 1 },
  high: { add: 3800, alpha: 5200, mul: 1, lights: 2 },
};
// atlas tiles (4×4)
const T = { GLOW: 0, SMOKE: 1, SMOKE2: 2, SMOKE3: 3, FLAME: 4, SPARK: 5, CHUNK: 6, DUST: 7, FLASH: 8, DROP: 9, RING: 10, EMBER: 11 };
const GROUND = ['grass', 'dirt', 'road', 'sand', 'rock', 'mud', 'shallow', 'deep', 'field', 'snow'];
// dust / debris colours by surface (linear-ish rgb)
const SURF = {
  grass: { dust: [0.34, 0.31, 0.22], chunk: [0.14, 0.12, 0.07], amt: 1 },
  field: { dust: [0.42, 0.37, 0.25], chunk: [0.2, 0.16, 0.09], amt: 1.1 },
  dirt: { dust: [0.4, 0.33, 0.23], chunk: [0.17, 0.12, 0.08], amt: 1.2 },
  mud: { dust: [0.24, 0.2, 0.15], chunk: [0.12, 0.09, 0.06], amt: 0.7 },
  sand: { dust: [0.62, 0.53, 0.38], chunk: [0.4, 0.33, 0.22], amt: 1.4 },
  road: { dust: [0.5, 0.46, 0.4], chunk: [0.28, 0.26, 0.23], amt: 0.7, sparks: 0.4 },
  rock: { dust: [0.48, 0.47, 0.45], chunk: [0.3, 0.29, 0.28], amt: 0.6, sparks: 1 },
  snow: { dust: [0.85, 0.87, 0.9], chunk: [0.75, 0.77, 0.8], amt: 1.2 },
  building: { dust: [0.6, 0.56, 0.5], chunk: [0.42, 0.26, 0.2], amt: 1.5 },
  wood: { dust: [0.45, 0.38, 0.28], chunk: [0.32, 0.22, 0.13], amt: 0.8 },
  metal: { dust: [0.35, 0.34, 0.33], chunk: [0.12, 0.12, 0.11], amt: 0.4, sparks: 1.5 },
};
function surfaceKind(s) {
  if (typeof s === 'number') s = GROUND[s] || 'grass';
  s = String(s || 'grass').toLowerCase();
  if (s === 'water' || s === 'shallow' || s === 'deep') return 'water';
  if (SURF[s]) return s;
  if (/tank|wreck|metal|vehicle/.test(s)) return 'metal';
  if (/house|build|barn|church|ruin|wall|brick|tower|mill|station|bridge/.test(s)) return 'building';
  if (/rock|stone|boulder|cliff/.test(s)) return 'rock';
  if (/tree|bush|hedge|fence|wood|log|crate|pole/.test(s)) return 'wood';
  return 'dirt';
}

// ------------------------------------------------------------------ atlas
let _atlas = null;
function atlas() {
  if (_atlas) return _atlas;
  const S = 128, c = document.createElement('canvas'); c.width = c.height = S * 4;
  const g = c.getContext('2d');
  let seed = 9; const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const at = (i, fn) => { g.save(); g.translate((i % 4) * S, Math.floor(i / 4) * S); g.beginPath(); g.rect(0, 0, S, S); g.clip(); fn(); g.restore(); };
  const radial = (x, y, r0, r1, stops) => { const gr = g.createRadialGradient(x, y, r0, x, y, r1); for (const [o, col] of stops) gr.addColorStop(o, col); return gr; };
  at(T.GLOW, () => { g.fillStyle = radial(64, 64, 0, 62, [[0, 'rgba(255,255,255,1)'], [0.25, 'rgba(255,255,255,0.6)'], [1, 'rgba(255,255,255,0)']]); g.fillRect(0, 0, S, S); });
  // cloudy puffs: fbm value noise under a soft radial falloff, lit from above (rgb), alpha = density
  const lat = new Float32Array(33 * 33 * 4).map(() => r());
  const vn = (x, y, o) => { const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi, u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
    const L = (i, j) => lat[(((j % 32) + 32) % 32) * 33 * 4 + (((i % 32) + 32) % 32) * 4 + o];
    return (L(xi, yi) * (1 - u) + L(xi + 1, yi) * u) * (1 - v) + (L(xi, yi + 1) * (1 - u) + L(xi + 1, yi + 1) * u) * v; };
  const puff = (tile, o, soft, dens) => {
    const id = g.createImageData(S, S);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const px = x / S * 2 - 1, py = y / S * 2 - 1, rr = Math.hypot(px, py);
      let n = 0, amp = 0.5, f = 3;
      for (let k = 0; k < 4; k++) { n += amp * vn(x / S * f + o * 7, y / S * f + o * 3, o); amp *= 0.5; f *= 2; }
      const a = Math.max(0, Math.min(1, (n * 1.6 - 0.35 - rr * rr * 1.1) * dens)) * Math.max(0, 1 - rr);
      const lit = 0.72 + 0.28 * Math.max(0, Math.min(1, 0.5 - py * 0.6 + (n - 0.5)));
      const i = (y * S + x) * 4; id.data[i] = id.data[i + 1] = id.data[i + 2] = Math.round(255 * lit); id.data[i + 3] = Math.round(255 * Math.min(1, a * soft));
    }
    g.putImageData(id, (tile % 4) * S, Math.floor(tile / 4) * S);
  };
  puff(T.SMOKE, 0, 1.0, 2.2); puff(T.SMOKE2, 1, 1.0, 2.1); puff(T.SMOKE3, 2, 1.0, 2.3); puff(T.DUST, 3, 0.85, 1.7);
  at(T.FLAME, () => { // tongues: tall soft ellipses rising from a bright base
    for (let k = 0; k < 9; k++) {
      const x = 64 + (r() - 0.5) * 44, h = 40 + r() * 50, w = 10 + r() * 12;
      g.save(); g.translate(x, 104 - h / 2); g.scale(w / h, 1);
      g.fillStyle = radial(0, h * 0.25, 0, h / 2, [[0, 'rgba(255,255,255,0.75)'], [0.6, 'rgba(255,255,255,0.3)'], [1, 'rgba(255,255,255,0)']]);
      g.fillRect(-h, -h, 2 * h, 2 * h); g.restore();
    }
    g.fillStyle = radial(64, 96, 0, 34, [[0, 'rgba(255,255,255,0.8)'], [1, 'rgba(255,255,255,0)']]); g.fillRect(0, 0, S, S);
  });
  { // spark / tracer streak: head at the bottom of the tile (v = 0), thin bright core
    const id = g.createImageData(S, S);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const u = (x + 0.5) / S - 0.5, v = 1 - (y + 0.5) / S;
      const a = Math.exp(-(u * u) / 0.012) * Math.pow(1 - v, 1.3) * Math.min(1, v * 12 + 0.3);
      const o = (y * S + x) * 4; id.data[o] = id.data[o + 1] = id.data[o + 2] = 255; id.data[o + 3] = Math.round(255 * Math.min(1, a * 1.3));
    }
    g.putImageData(id, (T.SPARK % 4) * S, Math.floor(T.SPARK / 4) * S);
  }
  at(T.CHUNK, () => {
    for (let k = 0; k < 3; k++) {
      g.fillStyle = `rgba(255,255,255,${0.9 - k * 0.2})`; g.beginPath();
      const cx = 40 + r() * 48, cy = 40 + r() * 48;
      for (let j = 0; j < 7; j++) { const a = j / 7 * 6.28, rr = 12 + r() * 16; g.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr); }
      g.fill();
    }
  });
  at(T.FLASH, () => {
    g.fillStyle = radial(64, 64, 0, 60, [[0, 'rgba(255,255,255,1)'], [0.3, 'rgba(255,255,255,0.5)'], [1, 'rgba(255,255,255,0)']]); g.fillRect(0, 0, S, S);
    for (let k = 0; k < 6; k++) { g.save(); g.translate(64, 64); g.rotate(k / 6 * 6.28 + r() * 0.3); const gr = g.createLinearGradient(0, 0, 62, 0); gr.addColorStop(0, 'rgba(255,255,255,0.9)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.beginPath(); g.moveTo(0, -6); g.lineTo(62, 0); g.lineTo(0, 6); g.fill(); g.restore(); }
  });
  at(T.DROP, () => { g.fillStyle = radial(64, 64, 0, 40, [[0, 'rgba(255,255,255,0.9)'], [0.6, 'rgba(255,255,255,0.5)'], [1, 'rgba(255,255,255,0)']]); g.fillRect(0, 0, S, S); });
  at(T.RING, () => { g.strokeStyle = radial(64, 64, 30, 62, [[0, 'rgba(255,255,255,0)'], [0.6, 'rgba(255,255,255,0.8)'], [1, 'rgba(255,255,255,0)']]); g.lineWidth = 30; g.beginPath(); g.arc(64, 64, 46, 0, 7); g.stroke(); });
  at(T.EMBER, () => { g.fillStyle = radial(64, 64, 0, 30, [[0, 'rgba(255,255,255,1)'], [0.4, 'rgba(255,255,255,0.6)'], [1, 'rgba(255,255,255,0)']]); g.fillRect(0, 0, S, S); });
  _atlas = new THREE.CanvasTexture(c);
  _atlas.colorSpace = THREE.SRGBColorSpace;
  return _atlas;
}

// ------------------------------------------------------------------ particle system
const VERT = /* glsl */`
attribute vec4 iPS; attribute vec4 iCol; attribute vec3 iVel; attribute vec2 iRF;
varying vec2 vUv; varying vec4 vCol;
#include <fog_pars_vertex>
void main() {
  vec4 mvPosition = viewMatrix * vec4(iPS.xyz, 1.0);
  float size = iPS.w;
  if (dot(iVel, iVel) > 0.0) {                     // streak: quad from pos (head) to pos + iVel (tail)
    vec4 mv2 = viewMatrix * vec4(iPS.xyz + iVel, 1.0);
    vec3 d = mv2.xyz - mvPosition.xyz;
    vec2 dir = d.xy; float l = length(dir);
    dir = l > 1e-5 ? dir / l : vec2(0.0, 1.0);
    vec2 perp = vec2(dir.y, -dir.x); // keeps the quad front-facing
    mvPosition.xyz += d * (position.y + 0.5) + vec3(perp * position.x * size, 0.0);
  } else {
    float c = cos(iRF.x), s = sin(iRF.x);
    mvPosition.xy += vec2(c*position.x - s*position.y, s*position.x + c*position.y) * size;
  }
  gl_Position = projectionMatrix * mvPosition;
  float f = iRF.y;
  vUv = (vec2(mod(f, 4.0), 3.0 - floor(f / 4.0)) + uv) / 4.0;
  vCol = iCol;
  #include <fog_vertex>
}`;
const FRAG = (additive) => /* glsl */`
uniform sampler2D map;
varying vec2 vUv; varying vec4 vCol;
#include <fog_pars_fragment>
void main() {
  vec4 t = texture2D(map, vUv);
  float fogF = 0.0;
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      fogF = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    #else
      fogF = smoothstep(fogNear, fogFar, vFogDepth);
    #endif
  #endif
  ${additive
    ? 'gl_FragColor = vec4(vCol.rgb * t.a * vCol.a * (1.0 - fogF), 1.0);'
    : `gl_FragColor = vec4(vCol.rgb * t.rgb, t.a * vCol.a);
  #ifdef USE_FOG
  gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, fogF);
  #endif`}
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
// per particle: 0 px 1 py 2 pz 3 vx 4 vy 5 vz 6 age 7 life 8 s0 9 s1 10 rot 11 rotV 12 r 13 g 14 b
// 15 a 16 drag 17 grav 18 frame 19 streak 20 fadeIn 21 floor 22 r2 23 g2 24 b2 25 aCurve
const F = 26;
class Pool {
  constructor(scene, max, additive) {
    this.max = max; this.n = 0; this.additive = additive;
    this.d = new Float32Array(max * F);
    const geo = new THREE.InstancedBufferGeometry();
    const q = new THREE.PlaneGeometry(1, 1);
    geo.index = q.index; geo.setAttribute('position', q.attributes.position); geo.setAttribute('uv', q.attributes.uv);
    this.aPS = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aVel = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aRF = new THREE.InstancedBufferAttribute(new Float32Array(max * 2), 2).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iPS', this.aPS); geo.setAttribute('iCol', this.aCol); geo.setAttribute('iVel', this.aVel); geo.setAttribute('iRF', this.aRF);
    geo.instanceCount = 0;
    const mat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { map: { value: null } }]),
      vertexShader: VERT, fragmentShader: FRAG(additive), fog: true,
      transparent: true, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    mat.uniforms.map.value = atlas();
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = additive ? 20 : 19;
    this.mesh.name = additive ? 'fx-add' : 'fx-alpha';
    scene.add(this.mesh);
  }
  // o: {x,y,z, vx,vy,vz, life, s0, s1, rot, rotV, r,g,b, a, drag, grav, frame, streak, fadeIn, floor, r2,g2,b2, curve}
  spawn(o) {
    if (this.n >= this.max) return;
    const d = this.d, i = this.n++ * F;
    d[i] = o.x; d[i + 1] = o.y; d[i + 2] = o.z; d[i + 3] = o.vx || 0; d[i + 4] = o.vy || 0; d[i + 5] = o.vz || 0;
    d[i + 6] = 0; d[i + 7] = o.life || 1; d[i + 8] = o.s0 ?? 1; d[i + 9] = o.s1 ?? o.s0 ?? 1;
    d[i + 10] = o.rot ?? Math.random() * 6.28; d[i + 11] = o.rotV ?? (Math.random() - 0.5);
    d[i + 12] = o.r ?? 1; d[i + 13] = o.g ?? 1; d[i + 14] = o.b ?? 1; d[i + 15] = o.a ?? 1;
    d[i + 16] = o.drag ?? 1; d[i + 17] = o.grav ?? 0; d[i + 18] = o.frame ?? 0; d[i + 19] = o.streak || 0;
    d[i + 20] = o.fadeIn ?? 0.05; d[i + 21] = o.floor ?? -1e9;
    d[i + 22] = o.r2 ?? d[i + 12]; d[i + 23] = o.g2 ?? d[i + 13]; d[i + 24] = o.b2 ?? d[i + 14]; d[i + 25] = o.curve ?? 1;
  }
  update(dt) {
    const d = this.d;
    let w = 0;
    for (let k = 0; k < this.n; k++) {
      const i = k * F;
      const age = d[i + 6] + dt;
      if (age >= d[i + 7]) continue;
      if (w !== k) d.copyWithin(w * F, i, i + F);
      const j = w * F;
      d[j + 6] = age;
      const damp = Math.exp(-d[j + 16] * dt);
      d[j + 3] *= damp; d[j + 4] = d[j + 4] * damp - d[j + 17] * dt; d[j + 5] *= damp;
      d[j] += d[j + 3] * dt; d[j + 1] += d[j + 4] * dt; d[j + 2] += d[j + 5] * dt;
      if (d[j + 1] < d[j + 21]) { d[j + 1] = d[j + 21]; d[j + 4] *= -0.25; d[j + 3] *= 0.5; d[j + 5] *= 0.5; d[j + 11] *= 0.5; }
      d[j + 10] += d[j + 11] * dt;
      w++;
    }
    this.n = w;
    const ps = this.aPS.array, col = this.aCol.array, vel = this.aVel.array, rf = this.aRF.array;
    for (let k = 0; k < w; k++) {
      const i = k * F, t = d[i + 6] / d[i + 7];
      ps[k * 4] = d[i]; ps[k * 4 + 1] = d[i + 1]; ps[k * 4 + 2] = d[i + 2];
      ps[k * 4 + 3] = d[i + 8] + (d[i + 9] - d[i + 8]) * (1 - Math.pow(1 - t, 2));
      const fin = d[i + 20] > 0 ? Math.min(1, d[i + 6] / d[i + 20]) : 1;
      const fade = fin * Math.pow(1 - t, d[i + 25]);
      col[k * 4] = d[i + 12] + (d[i + 22] - d[i + 12]) * t; col[k * 4 + 1] = d[i + 13] + (d[i + 23] - d[i + 13]) * t; col[k * 4 + 2] = d[i + 14] + (d[i + 24] - d[i + 14]) * t;
      col[k * 4 + 3] = d[i + 15] * fade;
      const st = d[i + 19];
      vel[k * 3] = -d[i + 3] * st; vel[k * 3 + 1] = -d[i + 4] * st; vel[k * 3 + 2] = -d[i + 5] * st;
      rf[k * 2] = d[i + 10]; rf[k * 2 + 1] = d[i + 18];
    }
    const g = this.mesh.geometry;
    g.instanceCount = w;
    for (const a of [this.aPS, this.aCol, this.aVel, this.aRF]) { a.clearUpdateRanges(); a.addUpdateRange(0, w * a.itemSize); a.needsUpdate = true; }
  }
  clear() { this.n = 0; this.mesh.geometry.instanceCount = 0; }
  dispose() { this.mesh.removeFromParent(); this.mesh.geometry.dispose(); this.mesh.material.dispose(); }
}

const rnd = Math.random;
const rs = (a) => (rnd() - 0.5) * 2 * a;
// random unit vector in the cone around (x,y,z) with half-angle ~a (radians)
function cone(x, y, z, a, out = {}) {
  let ux = x + rs(a), uy = y + rs(a), uz = z + rs(a);
  const l = Math.hypot(ux, uy, uz) || 1; out.x = ux / l; out.y = uy / l; out.z = uz / l;
  return out;
}
const _c = {};

export class FxRenderer {
  constructor(scene, quality = 'medium') {
    this.scene = scene;
    scene.userData.steelFx = this;
    this.world = null;
    this.shells = new Map(); // shell id → {type, cal, dir}
    this.time = 0;
    this.wind = { x: 1.2, z: 0.5 };
    this._build(quality);
  }
  _build(quality) {
    this.quality = QUALITY[quality] ? quality : 'medium';
    const Q = QUALITY[this.quality];
    this.mul = Q.mul;
    this.add = new Pool(this.scene, Q.add, true);
    this.alpha = new Pool(this.scene, Q.alpha, false);
    this.decals = new GroundDecals(this.scene, this.quality);
    this.lights = [];
    for (let k = 0; k < Q.lights; k++) {
      const l = new THREE.PointLight(0xffa860, 0, 60, 2);
      l.userData.t = 0; l.userData.peak = 0; l.userData.dur = 0.1;
      this.scene.add(l); this.lights.push(l);
    }
  }
  setQuality(q) {
    if (q === this.quality) return;
    this.dispose(); this.scene.userData.steelFx = this; this._build(q);
  }
  dispose() {
    this.add.dispose(); this.alpha.dispose(); this.decals.dispose();
    for (const l of this.lights) l.removeFromParent();
    if (this.scene.userData.steelFx === this) delete this.scene.userData.steelFx;
  }
  clear() { this.add.clear(); this.alpha.clear(); this.decals.clear(); this.shells.clear(); }
  _n(k) { const v = k * this.mul; return Math.floor(v) + (rnd() < v % 1 ? 1 : 0); }
  _flash(pos, intensity, dur, color = 0xffa860) {
    if (!this.lights.length) return;
    let l = this.lights[0];
    for (const x of this.lights) if (x.userData.t >= x.userData.dur) { l = x; break; }
    l.position.set(pos.x, pos.y + 1, pos.z); l.color.setHex(color);
    l.userData.t = 0; l.userData.dur = dur; l.userData.peak = intensity;
  }
  _tank(id) { const w = this.world; if (!w) return null; return (w.byId && w.byId[id]) || w.tanks.find((t) => t.id === id) || null; }
  _ground(x, z) {
    const m = this.world && this.world.map;
    if (!m || !m.ground) return 'grass';
    const i = Math.max(0, Math.min(m.res - 1, Math.round(x / m.cell))), j = Math.max(0, Math.min(m.res - 1, Math.round(z / m.cell)));
    return GROUND[m.ground[j * m.res + i]] || 'grass';
  }

  // ---------------------------------------------------------------- events
  handle(e, world) {
    if (world) this.world = world;
    switch (e.type || e.kind) {
      case 'shot': return this._shot(e);
      case 'impact': return this._impact(e);
      case 'hit': return this._hit(e);
      case 'kill': return this._kill(e);
      case 'treeFall': case 'objectBreak': {
        const o = e.obj; if (o) this.dust({ x: o.x, y: (o.y || 0) + 1, z: o.z }, 'wood', 1.2);
        return;
      }
      default:
    }
  }
  _shot(e) {
    const p = e.pos, d = e.dir, cal = e.cal || 75, s = Math.sqrt(cal / 75);
    this.shells.set(e.shell, { type: e.shellType, cal, dir: d });
    if (this.shells.size > 400) this.shells.delete(this.shells.keys().next().value);
    this.muzzle(p, d, cal);
    const t = this._tank(e.tank);
    if (t) {
      this.blast(t.pos, d, cal, this._ground(t.pos.x, t.pos.z));
      if (t.def && t.gunDef?.muzzleBrake !== undefined ? t.gunDef.muzzleBrake : false) this.brakeJets(p, d, cal);
    }
    this._flash(p, 12 * s * s, 0.07);
  }
  // Muzzle: flash core, forward flame tongues, smoke ring and lingering smoke.
  muzzle(p, d, cal = 75) {
    const s = Math.sqrt(cal / 75), A = this.add, B = this.alpha;
    const ox = p.x + d.x * 0.3 * s, oy = p.y + d.y * 0.3 * s, oz = p.z + d.z * 0.3 * s;
    A.spawn({ x: ox, y: oy, z: oz, life: 0.06, s0: 1.3 * s, s1: 1.7 * s, frame: T.FLASH, r: 3, g: 1.9, b: 0.8, a: 1, drag: 0, fadeIn: 0, curve: 1.5 });
    A.spawn({ x: ox + d.x * 0.8 * s, y: oy + d.y * 0.8 * s, z: oz + d.z * 0.8 * s, life: 0.08, s0: 1.0 * s, s1: 1.6 * s, frame: T.FLAME, r: 2.6, g: 1.2, b: 0.35, a: 1, drag: 0, fadeIn: 0 });
    for (let k = 0; k < 5; k++) {
      cone(d.x, d.y, d.z, 0.14, _c); const v = (20 + rnd() * 25) * s;
      A.spawn({ x: ox, y: oy, z: oz, vx: _c.x * v, vy: _c.y * v, vz: _c.z * v, life: 0.05 + rnd() * 0.04, s0: 0.35 * s, s1: 0.6 * s, frame: T.FLAME, streak: 0.05, r: 3, g: 1.6, b: 0.5, a: 1, drag: 8, fadeIn: 0 });
    }
    // smoke ring: puffs around the muzzle axis, pushed outward and forward
    const ux = -d.z, uz = d.x, ul = Math.hypot(ux, uz) || 1;
    const u = { x: ux / ul, y: 0, z: uz / ul }, w = { x: d.y * u.z - d.z * u.y, y: d.z * u.x - d.x * u.z, z: d.x * u.y - d.y * u.x };
    const n = this._n(16);
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2, c = Math.cos(a), sn = Math.sin(a);
      const rx = u.x * c + w.x * sn, ry = u.y * c + w.y * sn, rz = u.z * c + w.z * sn;
      const v = (5 + rnd() * 3) * s, fw = (6 + rnd() * 5) * s;
      const g = 0.62 + rnd() * 0.12;
      B.spawn({ x: ox + d.x * 0.6, y: oy + d.y * 0.6, z: oz + d.z * 0.6, vx: rx * v + d.x * fw, vy: ry * v + d.y * fw + 0.3, vz: rz * v + d.z * fw,
        life: 2.2 + rnd() * 1.6, s0: 0.7 * s, s1: 3.6 * s, frame: T.SMOKE + (k % 3), r: g, g: g * 0.97, b: g * 0.93, a: 0.8, drag: 2.6, grav: -0.25, fadeIn: 0.03, curve: 1.3 });
    }
    for (let k = 0; k < this._n(8); k++) {
      const f = 0.5 + rnd() * 5 * s, g = 0.62 + rnd() * 0.1;
      B.spawn({ x: ox + d.x * f, y: oy + d.y * f, z: oz + d.z * f, vx: d.x * 4 + rs(0.8), vy: 0.4 + rnd() * 0.4, vz: d.z * 4 + rs(0.8),
        life: 3 + rnd() * 2.5, s0: 1.4 * s, s1: 5 * s, frame: T.SMOKE + (k % 3), r: g, g, b: g * 0.95, a: 0.6, drag: 1.4, grav: -0.2, fadeIn: 0.06, curve: 1.3 });
    }
  }
  brakeJets(p, d, cal) {
    const s = Math.sqrt(cal / 75), ux = -d.z, uz = d.x, ul = Math.hypot(ux, uz) || 1;
    for (const sg of [-1, 1]) for (let k = 0; k < 2; k++) {
      const v = 14 + rnd() * 8, vx = (ux / ul) * sg * v + d.x * 4, vz = (uz / ul) * sg * v + d.z * 4;
      this.add.spawn({ x: p.x, y: p.y, z: p.z, vx, vy: rs(1), vz, life: 0.07, s0: 0.45 * s, s1: 0.7 * s, frame: T.FLAME, streak: 0.05, r: 5, g: 2.5, b: 0.8, drag: 8, fadeIn: 0 });
      const g = 0.55;
      this.alpha.spawn({ x: p.x, y: p.y, z: p.z, vx: vx * 0.4, vy: 0.3, vz: vz * 0.4, life: 1.5, s0: 0.4 * s, s1: 1.8 * s, frame: T.SMOKE2, r: g, g, b: g, a: 0.45, drag: 2, grav: -0.2 });
    }
  }
  // Dust kicked up around the firing tank (mostly towards the muzzle side).
  blast(pos, d, cal, ground) {
    const S = SURF[surfaceKind(ground)] || SURF.grass;
    if (surfaceKind(ground) === 'water') return this.splash({ x: pos.x + d.x * 3, y: pos.y, z: pos.z + d.z * 3 }, 0.6);
    const s = Math.sqrt(cal / 75), n = this._n(18 * s * S.amt);
    const hl = Math.hypot(d.x, d.z) || 1, fx = d.x / hl, fz = d.z / hl;
    for (let k = 0; k < n; k++) {
      const a = rnd() * Math.PI * 2, rx = Math.cos(a), rz = Math.sin(a);
      const bias = Math.max(0, rx * fx + rz * fz);
      const v = (2 + bias * 7 + rnd() * 2) * s, r0 = 1.5 + rnd();
      const c = S.dust, g = 0.85 + rnd() * 0.3;
      this.alpha.spawn({ x: pos.x + rx * r0 + fx * 2, y: pos.y + 0.3, z: pos.z + rz * r0 + fz * 2, vx: rx * v + fx * 2 * s, vy: 0.4 + rnd() * 0.8, vz: rz * v + fz * 2 * s,
        life: 1.8 + rnd() * 1.6, s0: 1.0, s1: 3.8 * s, frame: T.DUST, r: c[0] * g, g: c[1] * g, b: c[2] * g, a: 0.6, drag: 1.8, grav: -0.1, fadeIn: 0.06 });
    }
  }
  _impact(e) {
    const info = this.shells.get(e.shell) || {};
    const type = e.shellType || info.type || 'AP', cal = e.cal || info.cal || 75;
    const surf = surfaceKind(e.surface);
    if (e.surface === 'tank' || e.surface === 'wreck') { this.sparks(e.pos, e.normal, cal, 1); if (type === 'HE') this.explosion(e.pos, cal / 75); return; }
    if (type === 'HE') this.explosion(e.pos, Math.sqrt(cal / 75) * 1.3, surf);
    this.groundHit(e.pos, e.normal, surf, cal, info.dir);
    if (surf !== 'water' && (surf !== 'building' && surf !== 'wood') && (e.normal?.y ?? 1) > 0.5) {
      this.decals.add(e.pos, e.normal, (type === 'HE' ? 2.4 : 1.1) * Math.sqrt(cal / 75), type === 'HE' ? 'scorch' : cal >= 70 ? 'crater' : 'hole');
    }
  }
  // Shell into the ground / an object.
  groundHit(p, n = { x: 0, y: 1, z: 0 }, surf = 'dirt', cal = 75, dir = null) {
    const s = Math.sqrt(cal / 75);
    if (surf === 'water') return this.splash(p, s);
    const S = SURF[surf] || SURF.dirt, A = this.alpha;
    const nx = n.x ?? 0, ny = n.y ?? 1, nz = n.z ?? 0;
    // thrown earth: dark chunks with gravity, and a dust burst along the normal
    const nc = this._n(14 * s * S.amt);
    for (let k = 0; k < nc; k++) {
      cone(nx, ny + 0.6, nz, 0.7, _c); const v = (5 + rnd() * 9) * s;
      const c = S.chunk, g = 0.7 + rnd() * 0.5;
      A.spawn({ x: p.x, y: p.y + 0.1, z: p.z, vx: _c.x * v, vy: _c.y * v, vz: _c.z * v, life: 0.9 + rnd() * 0.8, s0: (0.12 + rnd() * 0.18) * s, s1: 0.1 * s,
        frame: T.CHUNK, r: c[0] * g, g: c[1] * g, b: c[2] * g, a: 1, drag: 0.4, grav: 14, fadeIn: 0, floor: p.y - 0.2, curve: 0.3, rotV: rs(8) });
    }
    const nd = this._n(8 * s * S.amt);
    for (let k = 0; k < nd; k++) {
      cone(nx, ny + 0.4, nz, 0.55, _c); const v = (2 + rnd() * 5) * s;
      const c = S.dust, g = 0.8 + rnd() * 0.35;
      A.spawn({ x: p.x, y: p.y + 0.2, z: p.z, vx: _c.x * v, vy: _c.y * v, vz: _c.z * v, life: 1.8 + rnd() * 1.8, s0: 0.6 * s, s1: (2.5 + rnd() * 1.5) * s,
        frame: T.DUST + 0, r: c[0] * g, g: c[1] * g, b: c[2] * g, a: 0.55, drag: 1.6, grav: -0.15, fadeIn: 0.05 });
    }
    if (S.sparks) this.sparks(p, n, cal, S.sparks * 0.6);
  }
  splash(p, s = 1) {
    const A = this.alpha;
    for (let k = 0; k < this._n(26 * s); k++) {
      const a = rnd() * 6.28, r = rnd() * 0.5 * s, v = (6 + rnd() * 9) * s;
      A.spawn({ x: p.x + Math.cos(a) * r, y: p.y, z: p.z + Math.sin(a) * r, vx: Math.cos(a) * rnd() * 2.5, vy: v, vz: Math.sin(a) * rnd() * 2.5,
        life: 0.9 + rnd() * 0.6, s0: (0.25 + rnd() * 0.25) * s, s1: 0.5 * s, frame: T.DROP, r: 0.85, g: 0.9, b: 0.95, a: 0.8, drag: 0.3, grav: 12, fadeIn: 0, streak: 0.04 });
    }
    for (let k = 0; k < this._n(8 * s); k++) {
      const a = rnd() * 6.28;
      A.spawn({ x: p.x, y: p.y + 0.3, z: p.z, vx: Math.cos(a) * 2, vy: 2 + rnd() * 2, vz: Math.sin(a) * 2, life: 1.6 + rnd(), s0: 0.8 * s, s1: 3 * s,
        frame: T.DUST, r: 0.8, g: 0.84, b: 0.88, a: 0.4, drag: 1.5, grav: -0.1 });
    }
    A.spawn({ x: p.x, y: p.y + 0.05, z: p.z, life: 1.2, s0: 0.5 * s, s1: 5 * s, frame: T.RING, r: 0.85, g: 0.9, b: 0.95, a: 0.5, rot: 0, rotV: 0, drag: 0 });
  }
  // Bright sparks bouncing off armour (non-pen, tracks, metal).
  sparks(p, n = { x: 0, y: 1, z: 0 }, cal = 75, amt = 1) {
    const A = this.add, s = Math.sqrt(cal / 75);
    for (let k = 0; k < this._n(22 * amt * s); k++) {
      cone(n.x ?? 0, (n.y ?? 1) + 0.2, n.z ?? 0, 0.9, _c); const v = 8 + rnd() * 22;
      A.spawn({ x: p.x, y: p.y, z: p.z, vx: _c.x * v, vy: _c.y * v, vz: _c.z * v, life: 0.25 + rnd() * 0.35, s0: 0.045, s1: 0.03, frame: T.SPARK, streak: 0.02,
        r: 3, g: 1.7, b: 0.6, a: 1, drag: 2, grav: 9, fadeIn: 0, curve: 0.7 });
    }
    A.spawn({ x: p.x + (n.x ?? 0) * 0.1, y: p.y + (n.y ?? 0) * 0.1, z: p.z + (n.z ?? 0) * 0.1, life: 0.08, s0: 0.8 * s, s1: 1.1 * s, frame: T.FLASH, r: 2.6, g: 2, b: 1.2, a: 1, drag: 0, fadeIn: 0 });
    const g = 0.45;
    this.alpha.spawn({ x: p.x, y: p.y, z: p.z, vx: (n.x ?? 0) * 1.5, vy: 0.5, vz: (n.z ?? 0) * 1.5, life: 1.2, s0: 0.3 * s, s1: 1.4 * s, frame: T.SMOKE2, r: g, g, b: g, a: 0.4, drag: 1.5, grav: -0.3 });
  }
  // Glancing hit: a fan of sparks along the reflected direction.
  ricochet(p, n, dir, cal = 75) {
    const A = this.add, s = Math.sqrt(cal / 75);
    let rx = 0, ry = 1, rz = 0;
    if (dir) { const dn = dir.x * n.x + dir.y * n.y + dir.z * n.z; rx = dir.x - 2 * dn * n.x; ry = dir.y - 2 * dn * n.y; rz = dir.z - 2 * dn * n.z; }
    for (let k = 0; k < this._n(26 * s); k++) {
      cone(rx, ry, rz, 0.3, _c); const v = 25 + rnd() * 40;
      A.spawn({ x: p.x, y: p.y, z: p.z, vx: _c.x * v, vy: _c.y * v, vz: _c.z * v, life: 0.2 + rnd() * 0.3, s0: 0.05, s1: 0.03, frame: T.SPARK, streak: 0.025,
        r: 3.2, g: 1.9, b: 0.7, a: 1, drag: 1.5, grav: 6, fadeIn: 0, curve: 0.8 });
    }
    A.spawn({ x: p.x, y: p.y, z: p.z, vx: rx * 30, vy: ry * 30, vz: rz * 30, life: 0.12, s0: 0.25 * s, s1: 0.2, frame: T.SPARK, streak: 0.08, r: 4, g: 3, b: 1.6, drag: 0, fadeIn: 0 });
    A.spawn({ x: p.x, y: p.y, z: p.z, life: 0.07, s0: 1.1 * s, s1: 1.5 * s, frame: T.FLASH, r: 3, g: 2.4, b: 1.6, a: 1, drag: 0, fadeIn: 0 });
  }
  // Penetration: hot flash, sparks, dark fragments and a puff of smoke from the hole.
  penetration(p, n, cal = 75, big = false) {
    const s = Math.sqrt(cal / 75) * (big ? 1.4 : 1), A = this.add, B = this.alpha;
    A.spawn({ x: p.x + n.x * 0.2, y: p.y + n.y * 0.2, z: p.z + n.z * 0.2, life: 0.1, s0: 1.5 * s, s1: 2.1 * s, frame: T.FLASH, r: 3, g: 1.6, b: 0.6, a: 1, drag: 0, fadeIn: 0 });
    A.spawn({ x: p.x + n.x * 0.2, y: p.y + n.y * 0.2, z: p.z + n.z * 0.2, life: 0.22, s0: 0.8 * s, s1: 1.4 * s, frame: T.FLAME, r: 1.8, g: 0.7, b: 0.15, a: 1, drag: 0, fadeIn: 0 });
    for (let k = 0; k < this._n(18 * s); k++) {
      cone(n.x, n.y + 0.3, n.z, 1.0, _c); const v = 10 + rnd() * 25;
      A.spawn({ x: p.x, y: p.y, z: p.z, vx: _c.x * v, vy: _c.y * v, vz: _c.z * v, life: 0.3 + rnd() * 0.5, s0: 0.05, s1: 0.03, frame: T.SPARK, streak: 0.022, r: 3, g: 1.4, b: 0.45, drag: 2, grav: 9, fadeIn: 0 });
    }
    for (let k = 0; k < this._n(10 * s); k++) {
      cone(n.x, n.y + 0.5, n.z, 0.9, _c); const v = 4 + rnd() * 9;
      B.spawn({ x: p.x, y: p.y, z: p.z, vx: _c.x * v, vy: _c.y * v, vz: _c.z * v, life: 1 + rnd() * 0.8, s0: 0.1 + rnd() * 0.1, s1: 0.08, frame: T.CHUNK, r: 0.06, g: 0.055, b: 0.05, a: 1, drag: 0.3, grav: 12, fadeIn: 0, curve: 0.3, rotV: rs(10), floor: p.y - 3 });
    }
    for (let k = 0; k < this._n(4); k++) {
      const g = 0.18 + rnd() * 0.1;
      B.spawn({ x: p.x, y: p.y, z: p.z, vx: n.x * 1.5 + rs(0.5), vy: 1 + rnd(), vz: n.z * 1.5 + rs(0.5), life: 2 + rnd() * 1.5, s0: 0.5 * s, s1: 2.5 * s, frame: T.SMOKE + k % 3, r: g, g, b: g, a: 0.55, drag: 1, grav: -0.6 });
    }
    this._flash(p, 8 * s * s, 0.12);
  }
  // HE / ammo explosion: fireball, dark smoke, dust, debris, ground ring.
  explosion(p, scale = 1, surf = 'dirt') {
    const s = scale, A = this.add, B = this.alpha;
    A.spawn({ x: p.x, y: p.y + 0.3 * s, z: p.z, life: 0.1, s0: 2.6 * s, s1: 3.6 * s, frame: T.FLASH, r: 2.6, g: 1.6, b: 0.7, a: 1, drag: 0, fadeIn: 0 });
    for (let k = 0; k < this._n(9 * s); k++) {
      cone(0, 1, 0, 1.2, _c); const v = (3 + rnd() * 6) * s;
      A.spawn({ x: p.x, y: p.y + 0.4 * s, z: p.z, vx: _c.x * v, vy: Math.abs(_c.y) * v, vz: _c.z * v, life: 0.3 + rnd() * 0.3, s0: 0.9 * s, s1: 2.0 * s,
        frame: T.FLAME, r: 1.5, g: 0.65, b: 0.18, r2: 0.7, g2: 0.15, b2: 0.02, a: 0.9, drag: 3, grav: -2, fadeIn: 0, curve: 1.2, rotV: rs(3) });
    }
    for (let k = 0; k < this._n(12 * s); k++) {
      cone(0, 1, 0, 1.1, _c); const v = (2 + rnd() * 4) * s, g = 0.12 + rnd() * 0.12;
      B.spawn({ x: p.x + rs(0.5 * s), y: p.y + 0.5 * s, z: p.z + rs(0.5 * s), vx: _c.x * v, vy: Math.abs(_c.y) * v + 1, vz: _c.z * v, life: 2.8 + rnd() * 2.5, s0: 1.2 * s, s1: (4 + rnd() * 3) * s,
        frame: T.SMOKE + k % 3, r: g, g, b: g * 0.95, a: 0.7, drag: 1.4, grav: -0.5, fadeIn: 0.12, curve: 1.3 });
    }
    for (let k = 0; k < this._n(18 * s); k++) {
      cone(0, 1, 0, 1.1, _c); const v = (8 + rnd() * 16) * s;
      A.spawn({ x: p.x, y: p.y + 0.3, z: p.z, vx: _c.x * v, vy: Math.abs(_c.y) * v, vz: _c.z * v, life: 0.5 + rnd() * 0.6, s0: 0.07, s1: 0.04, frame: T.SPARK, streak: 0.025, r: 3, g: 1.5, b: 0.45, drag: 1, grav: 9, fadeIn: 0 });
    }
    if (surf && surf !== 'metal') this.groundHit(p, { x: 0, y: 1, z: 0 }, surf, 75 * s * s);
    const S = SURF[surf] || SURF.dirt, c = S.dust;
    B.spawn({ x: p.x, y: p.y + 0.15, z: p.z, life: 0.9, s0: 1 * s, s1: 9 * s, frame: T.RING, r: c[0], g: c[1], b: c[2], a: 0.5, rot: 0, rotV: 0, drag: 0 });
    this._flash(p, 40 * s * s, 0.25);
  }
  dust(p, surf = 'dirt', s = 1) {
    const S = SURF[surf] || SURF.dirt, c = S.dust;
    for (let k = 0; k < this._n(10 * s); k++) {
      const a = rnd() * 6.28, v = (1 + rnd() * 3) * s, g = 0.85 + rnd() * 0.3;
      this.alpha.spawn({ x: p.x, y: p.y, z: p.z, vx: Math.cos(a) * v, vy: 0.5 + rnd(), vz: Math.sin(a) * v, life: 1.5 + rnd() * 1.5, s0: 0.8 * s, s1: 3 * s,
        frame: T.DUST, r: c[0] * g, g: c[1] * g, b: c[2] * g, a: 0.45, drag: 1.5, grav: -0.1 });
    }
  }
  _hit(e) {
    if (!e.pos) return;
    const info = this.shells.get(e.shell) || {};
    const cal = info.cal || 75, n = e.normal || { x: 0, y: 1, z: 0 };
    switch (e.result) {
      case 'ricochet': return this.ricochet(e.pos, n, info.dir, cal);
      case 'pen': case 'crit': if (e.result === 'pen' || (e.dmg || 0) > 0) { this.penetration(e.pos, n, cal, e.shellType === 'HE'); if (e.shellType === 'HE') this.explosion(e.pos, Math.sqrt(cal / 75), 'metal'); return; }
        return this.sparks(e.pos, n, cal, 1);
      case 'splash': return e.plate === 'splash' || e.plate === 'open' ? undefined : this.explosion(e.pos, Math.sqrt(cal / 75), 'metal');
      case 'track': this.sparks(e.pos, n, cal, 0.8); return this.groundHit(e.pos, n, 'metal', cal * 0.6);
      default: {
        this.sparks(e.pos, n, cal, 1.2);
        if (e.shellType === 'HE') this.explosion(e.pos, Math.sqrt(cal / 75) * 0.9, 'metal');
      }
    }
  }
  _kill(e) {
    const t = this._tank(e.victim);
    if (!t) return;
    const p = { x: t.pos.x, y: t.pos.y + (t.def ? t.def.hull.clr + t.def.hull.H : 1.5), z: t.pos.z };
    if (e.cause === 'ammorack') {
      this.explosion(p, 2.4, null);
      for (let k = 0; k < this._n(20); k++) { // column of fire shooting up
        const v = 10 + rnd() * 14;
        this.add.spawn({ x: p.x + rs(0.4), y: p.y, z: p.z + rs(0.4), vx: rs(2), vy: v, vz: rs(2), life: 0.5 + rnd() * 0.5, s0: 1.4, s1: 3,
          frame: T.FLAME, r: 6, g: 2.8, b: 0.8, r2: 2, g2: 0.4, b2: 0.05, drag: 1.5, grav: 4, fadeIn: 0, curve: 1.3 });
      }
      this._flash(p, 120, 0.5, 0xffb070);
    } else this.explosion(p, 1.3, null);
  }

  // ---------------------------------------------------------------- continuous (called per frame)
  // Dust (or spray) behind a moving track. dir = unit forward (world), speed m/s, ground name/enum.
  trackDust(x, y, z, dirX, dirZ, speed, ground, dt) {
    const sp = Math.abs(speed);
    if (sp < 0.8) return;
    const surf = surfaceKind(ground);
    const rate = Math.min(20, sp * 1.4) * this.mul * (surf === 'road' ? 0.4 : surf === 'rock' ? 0.3 : surf === 'mud' ? 0.6 : 1);
    this._acc = (this._acc || 0);
    let n = rate * dt; let cnt = Math.floor(n) + (rnd() < n % 1 ? 1 : 0);
    const back = speed > 0 ? -1 : 1;
    for (let k = 0; k < cnt; k++) {
      if (surf === 'water') {
        this.alpha.spawn({ x: x + rs(0.3), y: y + 0.2, z: z + rs(0.3), vx: dirX * back * 2 + rs(1.5), vy: 2 + rnd() * 3, vz: dirZ * back * 2 + rs(1.5), life: 0.7, s0: 0.3, s1: 0.8, frame: T.DROP, r: 0.85, g: 0.9, b: 0.95, a: 0.6, drag: 0.5, grav: 10, streak: 0.03 });
        continue;
      }
      const S = SURF[surf] || SURF.dirt, c = S.dust, g = 0.85 + rnd() * 0.3, big = Math.min(1, sp / 12);
      this.alpha.spawn({ x: x + rs(0.3), y: y + 0.25, z: z + rs(0.3), vx: dirX * back * sp * 0.25 + rs(0.8) + this.wind.x * 0.3, vy: 0.3 + rnd() * 0.6, vz: dirZ * back * sp * 0.25 + rs(0.8) + this.wind.z * 0.3,
        life: 1.8 + rnd() * 2.2 * big, s0: 0.8, s1: (2 + 3 * big), frame: T.DUST, r: c[0] * g * 1.15, g: c[1] * g * 1.15, b: c[2] * g * 1.15, a: (surf === 'snow' ? 0.6 : 0.45) * (0.5 + big * 0.6), drag: 1.2, grav: -0.05, fadeIn: 0.1 });
      if ((surf === 'mud' || surf === 'field' || surf === 'dirt') && rnd() < 0.3) {
        const cc = S.chunk;
        this.alpha.spawn({ x, y: y + 0.4, z, vx: dirX * back * 2 + rs(1), vy: 2 + rnd() * 2, vz: dirZ * back * 2 + rs(1), life: 0.7, s0: 0.08 + rnd() * 0.06, s1: 0.06, frame: T.CHUNK, r: cc[0], g: cc[1], b: cc[2], a: 1, drag: 0.5, grav: 12, fadeIn: 0, floor: y, curve: 0.2 });
      }
    }
  }
  // Exhaust puff; load 0..1 (throttle / acceleration) makes it darker and denser.
  exhaust(x, y, z, dirX, dirZ, load, dt) {
    const n = (1.5 + load * 7) * this.mul * dt, cnt = Math.floor(n) + (rnd() < n % 1 ? 1 : 0);
    for (let k = 0; k < cnt; k++) {
      const g = 0.32 - load * 0.18 + rnd() * 0.06;
      this.alpha.spawn({ x, y, z, vx: dirX * -0.8 + rs(0.3) + this.wind.x * 0.4, vy: 0.8 + rnd() * 0.5, vz: dirZ * -0.8 + rs(0.3) + this.wind.z * 0.4,
        life: 1.2 + rnd() * 0.8, s0: 0.2, s1: 0.9 + load * 0.8, frame: T.SMOKE + k % 3, r: g, g, b: g, a: 0.22 + load * 0.25, drag: 1.2, grav: -0.4, fadeIn: 0.05 });
    }
  }
  // A burning tank: flames licking up plus thick black smoke.
  fire(x, y, z, dt, s = 1) {
    const nf = 22 * s * this.mul * dt, cf = Math.floor(nf) + (rnd() < nf % 1 ? 1 : 0);
    for (let k = 0; k < cf; k++) {
      this.add.spawn({ x: x + rs(0.7 * s), y: y + rnd() * 0.2, z: z + rs(0.7 * s), vx: rs(0.3) + this.wind.x * 0.2, vy: 1.2 + rnd() * 1.6, vz: rs(0.3) + this.wind.z * 0.2,
        life: 0.5 + rnd() * 0.45, s0: 1.3 * s, s1: 0.4 * s, frame: T.FLAME, r: 1.2, g: 0.45, b: 0.09, r2: 0.7, g2: 0.12, b2: 0.02, a: 0.7, drag: 1, grav: -1.8, fadeIn: 0.1, curve: 0.7, rotV: rs(2) });
    }
    const ns = 6 * s * this.mul * dt, cs = Math.floor(ns) + (rnd() < ns % 1 ? 1 : 0);
    for (let k = 0; k < cs; k++) {
      const g = 0.06 + rnd() * 0.05;
      this.alpha.spawn({ x: x + rs(0.4), y: y + 0.6, z: z + rs(0.4), vx: this.wind.x * 0.8 + rs(0.3), vy: 2.2 + rnd(), vz: this.wind.z * 0.8 + rs(0.3),
        life: 4 + rnd() * 2, s0: 0.8 * s, s1: 4.5 * s, frame: T.SMOKE + k % 3, r: g, g, b: g, a: 0.65, drag: 0.5, grav: -0.3, fadeIn: 0.2, curve: 1.4 });
    }
    if (rnd() < dt * 6) this.add.spawn({ x: x + rs(0.5), y, z: z + rs(0.5), vx: rs(1), vy: 3 + rnd() * 3, vz: rs(1), life: 1 + rnd(), s0: 0.06, s1: 0.03, frame: T.EMBER, r: 4, g: 1.6, b: 0.3, drag: 0.8, grav: -0.5, fadeIn: 0 });
  }
  // Wreck smoke column: tall, dark, drifting with the wind; thins out with age (s).
  wreckSmoke(x, y, z, dt, age = 0) {
    const k0 = age < 30 ? 1 : age < 120 ? 0.6 : 0.3;
    const n = 2.2 * k0 * this.mul * dt, cnt = Math.floor(n) + (rnd() < n % 1 ? 1 : 0);
    for (let k = 0; k < cnt; k++) {
      const g = 0.08 + rnd() * 0.08 + (age > 60 ? 0.1 : 0);
      this.alpha.spawn({ x: x + rs(0.5), y: y + 0.5, z: z + rs(0.5), vx: this.wind.x * 1.5 + rs(0.3), vy: 3 + rnd() * 1.5, vz: this.wind.z * 1.5 + rs(0.3),
        life: 9 + rnd() * 5, s0: 1.2, s1: 10 + rnd() * 4, frame: T.SMOKE + k % 3, r: g, g, b: g * 1.02, a: 0.55 * (0.6 + k0 * 0.4), drag: 0.25, grav: -0.15, fadeIn: 0.1, curve: 1.6 });
    }
  }

  // ---------------------------------------------------------------- frame
  update(dt, camera, world) {
    if (world) this.world = world;
    this.time += dt;
    this.add.update(dt); this.alpha.update(dt); // tracers are added after stepping, see below
    // tracers: one-frame streaks from the live shells
    const w = this.world;
    if (w && w.shells) {
      for (const s of w.shells) {
        if (!s.alive || s.tracer === false) continue;
        const v = s.vel, sp = Math.hypot(v.x, v.y, v.z) || 1, cal = s.cal || 75;
        const len = Math.min(26, sp * 0.028), k = len / sp, wd = 0.08 + cal / 1000 * 1.1;
        const warm = s.type === 'HE' ? [5, 2.4, 0.9] : s.type === 'APCR' || s.gold ? [5, 4.2, 2.2] : [6, 3.4, 1.1];
        this._tracer(s.pos, v, k, wd, warm, 1);
        this._tracer(s.pos, v, k * 1.1, wd * 4, [warm[0] * 0.25, warm[1] * 0.2, warm[2] * 0.15], 0.6);
      }
    }
    const A = this.add; // write tracer particles (appended after the step, drawn this frame)
    A.update(0);
    for (const l of this.lights) {
      const u = l.userData;
      u.t += dt;
      l.intensity = u.t < u.dur ? u.peak * (1 - u.t / u.dur) : 0;
    }
  }
  _tracer(p, v, k, wd, c, a) {
    // life ≈ 0: it survives the zero-length update that uploads it, then dies next frame
    this.add.spawn({ x: p.x, y: p.y, z: p.z, vx: v.x, vy: v.y, vz: v.z, life: 1e-4, s0: wd, s1: wd, frame: T.SPARK, streak: k, r: c[0], g: c[1], b: c[2], a, drag: 0, fadeIn: 0, rot: 0, rotV: 0 });
  }
  stats() { return { add: this.add.n, alpha: this.alpha.n, decals: this.decals.mesh.count }; }
}
