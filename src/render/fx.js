// Particles (camera-facing instanced quads, additive and alpha variants), plastic debris with
// simple physics, floor decals (scorches, tread tracks), and a small pool of flash lights.
import * as THREE from 'three';
import * as TX from './textures.js';

const PVERT = /* glsl */`
  attribute vec3 iPos; attribute vec4 iColor; attribute vec2 iSizeRot; attribute vec4 iVel;
  varying vec4 vColor; varying vec2 vUv;
  void main() {
    vUv = uv; vColor = iColor;
    vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
    vec2 p;
    if (iVel.w > 0.0) {
      // streak: stretch the quad along the particle's on-screen velocity
      vec2 d = (modelViewMatrix * vec4(iVel.xyz, 0.0)).xy;
      float l = length(d);
      vec2 ax = l > 1e-4 ? d / l : vec2(1.0, 0.0);
      vec2 ay = vec2(-ax.y, ax.x);
      p = (ax * position.x * (1.0 + l * iVel.w) + ay * position.y) * iSizeRot.x;
    } else {
      float c = cos(iSizeRot.y), s = sin(iSizeRot.y);
      p = vec2(position.x * c - position.y * s, position.x * s + position.y * c) * iSizeRot.x;
    }
    mv.xy += p;
    gl_Position = projectionMatrix * mv;
  }`;
const PFRAG = /* glsl */`
  uniform sampler2D map; varying vec4 vColor; varying vec2 vUv;
  void main() { vec4 t = texture2D(map, vUv); gl_FragColor = vec4(vColor.rgb * t.rgb, vColor.a * t.a); }`;

class ParticlePool {
  constructor(scene, max, map, additive) {
    this.max = max; this.n = 0;
    const geo = new THREE.InstancedBufferGeometry();
    const q = new THREE.PlaneGeometry(1, 1);
    geo.index = q.index; geo.attributes.position = q.attributes.position; geo.attributes.uv = q.attributes.uv;
    this.pos = new Float32Array(max * 3); this.col = new Float32Array(max * 4); this.sr = new Float32Array(max * 2); this.vel = new Float32Array(max * 4);
    geo.setAttribute('iPos', new THREE.InstancedBufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('iColor', new THREE.InstancedBufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('iSizeRot', new THREE.InstancedBufferAttribute(this.sr, 2).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('iVel', new THREE.InstancedBufferAttribute(this.vel, 4).setUsage(THREE.DynamicDrawUsage));
    geo.instanceCount = 0;
    const mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: map } }, vertexShader: PVERT, fragmentShader: PFRAG,
      transparent: true, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = additive ? 12 : 10;
    scene.add(this.mesh);
    this.p = [];
  }
  spawn(o) { if (this.p.length < this.max) this.p.push({ life: 1, age: 0, vx: 0, vy: 0, vz: 0, drag: 1.5, grow: 1, rot: Math.random() * 6, spin: (Math.random() - 0.5) * 2, g: 0, a0: 1, fadeIn: 0.05, streak: 0, floor: 0.02, ...o }); }
  update(dt) {
    const P = this.p;
    let w = 0;
    for (let k = 0; k < P.length; k++) {
      const p = P[k];
      p.age += dt;
      if (p.age >= p.life) continue;
      const damp = Math.exp(-p.drag * dt);
      p.vx *= damp; p.vy = p.vy * damp - p.g * dt; p.vz *= damp;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      if (p.y < p.floor && p.g > 0) { p.y = p.floor; p.vy *= -0.3; p.vx *= 0.5; p.vz *= 0.5; }
      p.rot += p.spin * dt;
      P[w++] = p;
    }
    P.length = w;
    const n = Math.min(P.length, this.max);
    for (let k = 0; k < n; k++) {
      const p = P[k], t = p.age / p.life;
      this.pos[k * 3] = p.x; this.pos[k * 3 + 1] = p.y; this.pos[k * 3 + 2] = p.z;
      const fade = Math.min(1, p.age / p.fadeIn) * (1 - t) * (1 - t * 0.3);
      const c = p.color;
      const cr = p.color2 ? c.r + (p.color2.r - c.r) * t : c.r;
      const cg = p.color2 ? c.g + (p.color2.g - c.g) * t : c.g;
      const cb = p.color2 ? c.b + (p.color2.b - c.b) * t : c.b;
      this.col[k * 4] = cr; this.col[k * 4 + 1] = cg; this.col[k * 4 + 2] = cb; this.col[k * 4 + 3] = p.a0 * fade;
      this.sr[k * 2] = p.size * (1 + (p.grow - 1) * t); this.sr[k * 2 + 1] = p.rot;
      this.vel[k * 4] = p.vx; this.vel[k * 4 + 1] = p.vy; this.vel[k * 4 + 2] = p.vz; this.vel[k * 4 + 3] = p.streak;
    }
    const g = this.mesh.geometry;
    g.instanceCount = n;
    g.attributes.iPos.needsUpdate = g.attributes.iColor.needsUpdate = g.attributes.iSizeRot.needsUpdate = g.attributes.iVel.needsUpdate = true;
  }
  clear() { this.p.length = 0; this.mesh.geometry.instanceCount = 0; }
}

const C = (h) => new THREE.Color(h);
const FIRE = [C(0xfff2c0), C(0xffb040), C(0xff6a1a)];

export class FX {
  constructor(scene, quality) {
    this.scene = scene; this.quality = quality;
    this.smoke = new ParticlePool(scene, 1400, TX.smokePuff(), false);
    this.glow = new ParticlePool(scene, 1000, TX.softDot(), true);
    this.dust = new ParticlePool(scene, 200, TX.softDot('rgba(255,245,220,0.9)'), true);
    this.flame = new ParticlePool(scene, 700, TX.flame(), true);
    this.bx = 15; this.bz = 10;
    // debris: instanced rounded chunks with per-instance colour
    this.debrisMax = 600;
    const dg = new THREE.BoxGeometry(1, 1, 1);
    this.debrisMesh = new THREE.InstancedMesh(dg, new THREE.MeshPhysicalMaterial({ roughness: 0.35, clearcoat: 0.8, clearcoatRoughness: 0.2 }), this.debrisMax);
    this.debrisMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.debrisMesh.castShadow = true; this.debrisMesh.receiveShadow = true;
    this.debrisMesh.count = 0; this.debrisMesh.frustumCulled = false;
    this.debrisMesh.setColorAt(0, new THREE.Color());
    scene.add(this.debrisMesh);
    this.debris = [];
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._e = new THREE.Euler(); this._s = new THREE.Vector3(); this._p = new THREE.Vector3();
    // tread marks: ring buffer of instanced quads on the floor
    this.trackMax = 2400; this.trackN = 0; this.trackHead = 0;
    const tg = new THREE.PlaneGeometry(0.16, 0.1); tg.rotateX(-Math.PI / 2);
    this.tracks = new THREE.InstancedMesh(tg, new THREE.MeshBasicMaterial({ map: TX.treadMark(), transparent: true, opacity: 0.22, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 }), this.trackMax);
    this.tracks.count = 0; this.tracks.frustumCulled = false; this.tracks.renderOrder = 2;
    scene.add(this.tracks);
    // scorches
    this.scorchMat = new THREE.MeshBasicMaterial({ map: TX.scorchX(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });
    this.scorchGeo = new THREE.PlaneGeometry(1.1, 1.1).rotateX(-Math.PI / 2);
    this.decals = [];
    // shockwave rings
    this.ringGeo = new THREE.RingGeometry(0.85, 1, 48).rotateX(-Math.PI / 2);
    this.rings = [];
    // flash lights
    this.lights = [0, 1, 2].map(() => { const l = new THREE.PointLight(0xffa040, 0, 6, 1.6); l.position.y = 0.8; scene.add(l); return { l, t: 0, dur: 0, peak: 0 }; });
    this.lightK = 0;
    // burning tanks get one of these, flickering
    this.fireLights = [0, 1].map(() => { const l = new THREE.PointLight(0xff7a28, 0, 4.5, 1.8); scene.add(l); return l; });
    // ambient dust motes drifting in the window light
    this.moteT = 0;
  }

  light(x, z, peak, dur, color = 0xffa040) {
    const s = this.lights[this.lightK++ % this.lights.length];
    s.l.position.set(x, 0.9, z); s.l.color.set(color); s.peak = peak; s.dur = dur; s.t = 0;
  }

  muzzle(x, z, angle, rocket, y = 0.42, big = 1) {
    const dx = Math.cos(angle), dz = Math.sin(angle);
    for (let k = 0; k < 7 + big * 3; k++) {
      const sp = (0.6 + Math.random() * 1.8) * big, sa = angle + (Math.random() - 0.5) * 0.7;
      this.smoke.spawn({ x, y, z, vx: Math.cos(sa) * sp, vy: 0.2 + Math.random() * 0.3, vz: Math.sin(sa) * sp, size: (0.16 + Math.random() * 0.12) * big, grow: 2.6, life: 0.7 + Math.random() * 0.6, color: C(0xe8e2d8), a0: 0.55, drag: 4 });
    }
    // side blast from the muzzle brake
    for (const sd of [-1, 1]) this.smoke.spawn({ x, y, z, vx: -dz * sd * 1.6 * big, vy: 0.2, vz: dx * sd * 1.6 * big, size: 0.12 * big, grow: 2.8, life: 0.5, color: C(0xe8e2d8), a0: 0.45, drag: 4 });
    this.glow.spawn({ x: x + dx * 0.05, y, z: z + dz * 0.05, size: (rocket ? 0.9 : 0.7) * big, grow: 0.3, life: 0.09, color: C(0xffd27a), a0: 1.6, fadeIn: 0.001 });
    this.flame.spawn({ x: x + dx * 0.12 * big, y, z: z + dz * 0.12 * big, vx: dx * 1.5, vz: dz * 1.5, size: 0.3 * big, grow: 0.4, life: 0.06, color: C(0xffe2a0), a0: 1.8, fadeIn: 0.001, streak: 0.5, drag: 0 });
    for (let k = 0; k < 5; k++) {
      const sp = 3 + Math.random() * 3, sa = angle + (Math.random() - 0.5) * 0.4;
      this.glow.spawn({ x, y, z, vx: Math.cos(sa) * sp, vy: Math.random(), vz: Math.sin(sa) * sp, size: 0.05, life: 0.12 + Math.random() * 0.1, color: C(0xffc060), a0: 1.2, drag: 6, fadeIn: 0.001, streak: 0.3 });
    }
    this.light(x, z, 5 * big, 0.12, 0xffb050);
  }

  trail(x, z, rocket) {
    if (rocket) {
      this.glow.spawn({ x, y: 0.4, z, size: 0.22, grow: 0.2, life: 0.18, color: FIRE[0], color2: FIRE[2], a0: 1.3, fadeIn: 0.001, drag: 0 });
      this.smoke.spawn({ x, y: 0.4, z, vy: 0.25, size: 0.12, grow: 3, life: 0.9, color: C(0xcfcac2), a0: 0.35, drag: 2 });
    } else {
      this.smoke.spawn({ x, y: 0.4, z, vy: 0.15, size: 0.09, grow: 2.6, life: 0.7, color: C(0xf2eee8), a0: 0.3, drag: 2 });
    }
  }

  spark(x, z, n = 10, color = 0xffd070, y = 0.4) {
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2, sp = 2 + Math.random() * 3.5;
      this.glow.spawn({ x, y, z, vx: Math.cos(a) * sp, vy: 1 + Math.random() * 2.5, vz: Math.sin(a) * sp, g: 9, size: 0.035, life: 0.25 + Math.random() * 0.25, color: C(color), a0: 1.6, drag: 2, fadeIn: 0.001, streak: 0.35 });
    }
    this.glow.spawn({ x, y, z, size: 0.4, grow: 0.2, life: 0.08, color: C(0xfff0c0), a0: 1.2, fadeIn: 0.001 });
  }

  puff(x, z, n = 6, color = 0xd8d2c8, y = 0.3, a0 = 0.45, size = 0.2) {
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2, sp = Math.random() * 0.8;
      this.smoke.spawn({ x: x + Math.cos(a) * 0.1, y, z: z + Math.sin(a) * 0.1, vx: Math.cos(a) * sp, vy: 0.3 + Math.random() * 0.4, vz: Math.sin(a) * sp, size, grow: 2.5, life: 0.8 + Math.random() * 0.5, color: C(color), a0, drag: 2.5 });
    }
  }

  // ---- shell-on-tank results
  // Ricochet: a bright glancing streak along the deflection (dx,dz is the shell's new heading).
  ricochet(x, z, dx, dz, y = 0.4) {
    for (let k = 0; k < 16; k++) {
      const j = (Math.random() - 0.5) * 0.5, c = Math.cos(j), s = Math.sin(j);
      const ddx = dx * c - dz * s, ddz = dx * s + dz * c, sp = 5 + Math.random() * 7;
      this.glow.spawn({ x, y, z, vx: ddx * sp, vy: (Math.random() - 0.2) * 2, vz: ddz * sp, g: 5, size: 0.022, life: 0.16 + Math.random() * 0.18, color: C(k % 3 ? 0xfff2c8 : 0xffc060), a0: 3.2, drag: 2.5, fadeIn: 0.001, streak: 1.4 });
    }
    this.glow.spawn({ x, y, z, size: 0.7, grow: 0.3, life: 0.09, color: C(0xfff8e8), a0: 2.4, fadeIn: 0.001 });
    // the glancing shell's white-hot scrape: one long streak along the new heading
    this.glow.spawn({ x, y, z, vx: dx * 9, vy: 0.3, vz: dz * 9, size: 0.035, life: 0.12, color: C(0xffffff), a0: 3.5, drag: 4, fadeIn: 0.001, streak: 2.2 });
    this.smoke.spawn({ x, y, z, vx: dx * 0.6, vy: 0.2, vz: dz * 0.6, size: 0.1, grow: 3, life: 0.6, color: C(0xcfc8bc), a0: 0.35, drag: 3 });
    this.light(x, z, 4, 0.08, 0xfff0c0);
  }
  // Penetration: sparks punched through, a dark smoke puff, bits of paint and steel.
  penetrate(x, z, dx, dz, colors, y = 0.35) {
    for (let k = 0; k < 18; k++) {
      const a = Math.random() * Math.PI * 2, sp = 1.5 + Math.random() * 3.5;
      this.glow.spawn({ x, y, z, vx: Math.cos(a) * sp - dx * 1.5, vy: 1 + Math.random() * 2.5, vz: Math.sin(a) * sp - dz * 1.5, g: 9, size: 0.035, life: 0.2 + Math.random() * 0.3, color: C(k % 2 ? 0xffb050 : 0xffe0a0), a0: 2, drag: 2, fadeIn: 0.001, streak: 0.45 });
    }
    this.glow.spawn({ x, y, z, size: 1.0, grow: 0.3, life: 0.12, color: C(0xffc070), a0: 2.2, fadeIn: 0.001 });
    this.flame.spawn({ x, y: y + 0.05, z, vy: 0.6, size: 0.35, grow: 0.6, life: 0.16, color: C(0xffb040), color2: C(0xc02008), a0: 1.4, fadeIn: 0.001, drag: 2 });
    for (let k = 0; k < 9; k++) {
      const a = Math.random() * Math.PI * 2, sp = Math.random() * 0.7;
      this.smoke.spawn({ x: x + Math.cos(a) * 0.05, y: y + 0.05, z: z + Math.sin(a) * 0.05, vx: Math.cos(a) * sp - dx * 0.4, vy: 0.5 + Math.random() * 0.6, vz: Math.sin(a) * sp - dz * 0.4, size: 0.14, grow: 3.2, life: 1.1 + Math.random() * 0.7, color: C(0x221e1b), color2: C(0x6a645e), a0: 0.7, drag: 2.2, fadeIn: 0.03 });
    }
    this.debrisBurst(x, z, colors, 9, 0.55, { y, size: 0.05 });
    this.light(x, z, 10, 0.16, 0xff9a40);
  }
  // No penetration: a dull clank, a small grey puff, a few dim sparks.
  clank(x, z, y = 0.35) {
    this.puff(x, z, 7, 0x9a958e, y, 0.6, 0.13);
    for (let k = 0; k < 8; k++) {
      const a = Math.random() * Math.PI * 2, sp = 1 + Math.random() * 1.5;
      this.glow.spawn({ x, y, z, vx: Math.cos(a) * sp, vy: 0.5 + Math.random(), vz: Math.sin(a) * sp, g: 9, size: 0.025, life: 0.15 + Math.random() * 0.1, color: C(0xffb070), a0: 1.0, drag: 3, fadeIn: 0.001, streak: 0.3 });
    }
    this.glow.spawn({ x, y, z, size: 0.4, grow: 0.3, life: 0.07, color: C(0xffe0b0), a0: 1.2, fadeIn: 0.001 });
  }
  // A shell stopping against an obstacle: dust plus chips of whatever it hit, thrown back
  // toward the shooter. surf: 1 wood, 2 paper, 3 metal, 4 plastic, 5 stone, 6 card, 0 frame.
  impact(x, z, surf, dx = 0, dz = 0, tint = null) {
    const y = 0.4;
    const kit = {
      0: { dust: 0x9a7a58, chips: [0x5a3620, 0x7a4a2a, 0x3a2414], flat: true },
      1: { dust: 0xc8b090, chips: tint != null ? [tint, tint, 0xe2c79a, 0xd9b98a] : [0xe2c79a, 0xd9b98a, 0xc49a64], flat: true },
      2: { dust: 0xe8e2d4, chips: [0xf4efe0, 0xefe6cf, tint ?? 0x8e2a25], flat: true, flutter: true },
      3: { dust: 0x9a948c, chips: [], sparks: true },
      4: { dust: 0xd8d2c8, chips: tint != null ? [tint, tint, tint] : [0xd6362c, 0x2a62c9, 0xf2c12e], flat: false },
      5: { dust: 0xb0aaa0, chips: [0x9a968e, 0xb9b4a8, 0x7a766e], flat: false },
      6: { dust: 0xc9b08a, chips: [0xc49a64, 0xb38850, 0xd6b478], flat: true },
    }[surf] || { dust: 0xc8b8a0, chips: [0xc49a64], flat: true };
    // dust bloom off the face
    for (let k = 0; k < 9; k++) {
      const a = Math.random() * Math.PI * 2, sp = Math.random() * 0.9;
      this.smoke.spawn({ x: x - dx * 0.05, y: y + (Math.random() - 0.5) * 0.1, z: z - dz * 0.05, vx: Math.cos(a) * sp - dx * 0.9, vy: 0.2 + Math.random() * 0.5, vz: Math.sin(a) * sp - dz * 0.9, size: 0.14, grow: 3, life: 0.9 + Math.random() * 0.8, color: C(kit.dust), a0: 0.5, drag: 2.6 });
    }
    if (kit.chips.length) this.debrisBurst(x - dx * 0.08, z - dz * 0.08, kit.chips, kit.flutter ? 10 : 8, 0.45, { y, size: 0.045, flat: kit.flat, dirx: -dx, dirz: -dz });
    if (kit.sparks || surf === 5) this.spark(x, z, kit.sparks ? 12 : 4, 0xffd080, y);
    this.glow.spawn({ x, y, z, size: 0.3, grow: 0.3, life: 0.06, color: C(0xffe8c0), a0: 1.0, fadeIn: 0.001 });
  }

  // ---- continuous emitters (call every frame with dt)
  // A burning tank: flame tongues, black smoke, embers.
  burn(x, y, z, dt, power = 1) {
    const n = Math.floor(dt * 70 * power + Math.random());
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2, r = Math.random() * 0.14;
      this.flame.spawn({ x: x + Math.cos(a) * r, y: y + Math.random() * 0.04, z: z + Math.sin(a) * r, vx: (Math.random() - 0.5) * 0.25, vy: 0.8 + Math.random() * 0.9, vz: (Math.random() - 0.5) * 0.25, size: (0.18 + Math.random() * 0.16) * (0.6 + 0.4 * power), grow: 0.4, life: 0.32 + Math.random() * 0.34, color: C(0xffc860), color2: C(0xd8280a), a0: 1.5, drag: 1.2, fadeIn: 0.02, spin: 0, rot: (Math.random() - 0.5) * 0.4 });
    }
    if (Math.random() < dt * 30 * power) this.glow.spawn({ x, y: y + 0.08, z, size: 0.55, grow: 1.2, life: 0.18, color: C(0xff8a30), a0: 0.35, fadeIn: 0.05, drag: 0 });
    if (Math.random() < dt * 16 * power) this.smoke.spawn({ x, y: y + 0.2, z, vx: (Math.random() - 0.5) * 0.2, vy: 0.9 + Math.random() * 0.5, vz: (Math.random() - 0.5) * 0.2, size: 0.16, grow: 4, life: 2 + Math.random(), color: C(0x151210), color2: C(0x4a4642), a0: 0.65, drag: 0.6, fadeIn: 0.1 });
    if (Math.random() < dt * 6) this.glow.spawn({ x, y: y + 0.1, z, vx: (Math.random() - 0.5) * 0.8, vy: 1.5 + Math.random() * 1.5, vz: (Math.random() - 0.5) * 0.8, size: 0.025, life: 0.8 + Math.random() * 0.6, color: C(0xffa040), a0: 1.5, drag: 1, fadeIn: 0.001 });
  }
  // A damaged engine: grey-to-black smoke off the engine deck. level 0 (50% hp) … 1 (dying).
  engineSmoke(x, y, z, dt, level) {
    if (Math.random() > dt * (5 + level * 14)) return;
    const c0 = C(0x3a3632).lerp(C(0x121010), level), c1 = C(0x8a857e).lerp(C(0x3a3632), level);
    this.smoke.spawn({ x: x + (Math.random() - 0.5) * 0.08, y, z: z + (Math.random() - 0.5) * 0.08, vx: (Math.random() - 0.5) * 0.15, vy: 0.45 + Math.random() * 0.35, vz: (Math.random() - 0.5) * 0.15, size: 0.09 + level * 0.06, grow: 4.5, life: 1.6 + Math.random() * 1.2, color: c0, color2: c1, a0: 0.4 + level * 0.25, drag: 0.8, fadeIn: 0.1 });
  }
  // A wreck: a thin smoulder that thins out over time, now and then an ember.
  smoulder(x, y, z, dt, age) {
    const rate = age < 12 ? 7 : age < 40 ? 3 : 1.2;
    if (Math.random() < dt * rate) this.smoke.spawn({ x: x + (Math.random() - 0.5) * 0.2, y, z: z + (Math.random() - 0.5) * 0.2, vx: (Math.random() - 0.5) * 0.1, vy: 0.35 + Math.random() * 0.3, vz: (Math.random() - 0.5) * 0.1, size: 0.08, grow: 5, life: 2.5 + Math.random() * 1.5, color: C(age < 12 ? 0x2a2622 : 0x4a4642), color2: C(0x9a958e), a0: age < 12 ? 0.5 : 0.3, drag: 0.5, fadeIn: 0.2 });
    if (age < 20 && Math.random() < dt * 2) this.glow.spawn({ x: x + (Math.random() - 0.5) * 0.3, y: y - 0.05, z: z + (Math.random() - 0.5) * 0.3, vy: 0.5 + Math.random(), size: 0.022, life: 0.6 + Math.random() * 0.6, color: C(0xff8030), a0: 1.3, drag: 1, fadeIn: 0.001 });
  }
  setFireLight(k, x, y, z, on, t) {
    const l = this.fireLights[k]; if (!l) return;
    if (!on) { l.intensity = 0; return; }
    l.position.set(x, y + 0.35, z);
    l.intensity = 3.2 * (0.75 + 0.25 * Math.sin(t * 23 + k) * Math.sin(t * 7.3 + 2 * k));
  }
  setBounds(hx, hz) { this.bx = hx; this.bz = hz; }

  explosion(x, z, big = 1) {
    // flash core
    this.glow.spawn({ x, y: 0.5, z, size: 2.6 * big, grow: 0.4, life: 0.14, color: C(0xfff4d0), a0: 2.2, fadeIn: 0.001 });
    // fireball
    for (let k = 0; k < 26 * big; k++) {
      const a = Math.random() * Math.PI * 2, e = Math.random() * 1.3, sp = (1.2 + Math.random() * 3.2) * big;
      this.glow.spawn({ x, y: 0.35, z, vx: Math.cos(a) * Math.cos(e) * sp, vy: Math.sin(e) * sp * 0.9 + 0.6, vz: Math.sin(a) * Math.cos(e) * sp, size: 0.35 + Math.random() * 0.45, grow: 1.8, life: 0.35 + Math.random() * 0.4, color: FIRE[0], color2: FIRE[2], a0: 1.3, drag: 3.5, fadeIn: 0.001 });
    }
    // smoke column
    for (let k = 0; k < 30 * big; k++) {
      const a = Math.random() * Math.PI * 2, sp = Math.random() * 2.2 * big;
      this.smoke.spawn({ x: x + Math.cos(a) * 0.2, y: 0.3 + Math.random() * 0.3, z: z + Math.sin(a) * 0.2, vx: Math.cos(a) * sp, vy: 0.8 + Math.random() * 1.6, vz: Math.sin(a) * sp, size: 0.35 + Math.random() * 0.35, grow: 3.4, life: 1.4 + Math.random() * 1.6, color: C(0x3a3430), color2: C(0x8f8a84), a0: 0.62, drag: 2.2, fadeIn: 0.12 });
    }
    // embers
    for (let k = 0; k < 22 * big; k++) {
      const a = Math.random() * Math.PI * 2, sp = 2 + Math.random() * 5;
      this.glow.spawn({ x, y: 0.4, z, vx: Math.cos(a) * sp, vy: 2 + Math.random() * 4, vz: Math.sin(a) * sp, g: 9, size: 0.05 + Math.random() * 0.05, life: 0.6 + Math.random() * 0.9, color: C(0xffb048), a0: 1.5, drag: 1.2, fadeIn: 0.001 });
    }
    // shockwave ring
    const ring = new THREE.Mesh(this.ringGeo, new THREE.MeshBasicMaterial({ color: 0xfff0d0, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false }));
    ring.position.set(x, 0.05, z); this.scene.add(ring);
    this.rings.push({ m: ring, t: 0, dur: 0.45, r: 1.9 * big });
    this.light(x, z, 28 * big, 0.5, 0xff8a30);
  }

  debrisBurst(x, z, colors, n = 22, power = 1, { y = 0.3, size = 0.1, flat = false, dirx = 0, dirz = 0 } = {}) {
    for (let k = 0; k < n; k++) {
      if (this.debris.length >= this.debrisMax) this.debris.shift();
      const a = Math.random() * Math.PI * 2, sp = (1 + Math.random() * 3.2) * power;
      const s = 0.018 + Math.random() * size;
      this.debris.push({
        x: x + Math.cos(a) * 0.1, y, z: z + Math.sin(a) * 0.1,
        vx: Math.cos(a) * sp + dirx * 2.5 * power, vy: (3 + Math.random() * 4) * power, vz: Math.sin(a) * sp + dirz * 2.5 * power,
        rx: Math.random() * 6, ry: Math.random() * 6, rz: Math.random() * 6,
        wx: (Math.random() - 0.5) * 20, wy: (Math.random() - 0.5) * 20, wz: (Math.random() - 0.5) * 20,
        sx: s * (0.6 + Math.random()) * (flat ? 1.6 : 1), sy: s * (flat ? 0.18 : 0.4 + Math.random() * 0.6), sz: s * (0.6 + Math.random()) * (flat ? 0.5 : 1),
        color: new THREE.Color(colors[k % colors.length]), age: 0, rest: false, smoking: Math.random() < 0.25,
      });
    }
  }

  scorch(x, z, rot) {
    const m = new THREE.Mesh(this.scorchGeo, this.scorchMat);
    m.position.set(x, 0.004, z); m.rotation.y = -rot;
    this.scene.add(m); this.decals.push(m);
  }

  track(x, z, rot) {
    const k = this.trackHead;
    this._m.compose(this._p.set(x, 0.003, z), this._q.setFromEuler(this._e.set(0, -rot, 0)), this._s.set(1, 1, 1));
    this.tracks.setMatrixAt(k, this._m);
    this.trackHead = (k + 1) % this.trackMax;
    this.trackN = Math.min(this.trackMax, this.trackN + 1);
    this.tracks.count = this.trackN;
    this.tracks.instanceMatrix.needsUpdate = true;
  }

  update(dt, solidTop) {
    this.smoke.update(dt); this.glow.update(dt); this.flame.update(dt);
    // motes
    this.moteT -= dt;
    if (this.moteT <= 0 && this.quality.motes) {
      this.moteT = 0.09 * 700 / (this.bx * this.bz * 2 + 400);
      this.dust.spawn({ x: (Math.random() - 0.5) * this.bx * 2, y: 0.5 + Math.random() * 5, z: (Math.random() - 0.5) * this.bz * 2, vx: 0.05 + Math.random() * 0.1, vy: (Math.random() - 0.5) * 0.05, vz: (Math.random() - 0.5) * 0.08, size: 0.02 + Math.random() * 0.035, life: 6 + Math.random() * 6, color: C(0xffe8c0), a0: 0.35, drag: 0, fadeIn: 1.5 });
    }
    this.dust.update(dt);
    // debris physics
    const D = this.debris;
    let w = 0;
    for (const d of D) {
      d.age += dt;
      if (d.age > 14) continue;
      if (!d.rest) {
        d.vy -= 13 * dt;
        d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt;
        d.rx += d.wx * dt; d.ry += d.wy * dt; d.rz += d.wz * dt;
        const floor = solidTop ? solidTop(d.x, d.z) : 0;
        const half = d.sy / 2;
        if (d.y < floor + half) {
          if (d.y < floor - 0.25) { // hit the side of a block: bounce back horizontally
            d.vx *= -0.4; d.vz *= -0.4; d.x += d.vx * dt * 2; d.z += d.vz * dt * 2; d.y = Math.max(d.y, half);
          } else {
            d.y = floor + half; d.vy *= -0.35; d.vx *= 0.6; d.vz *= 0.6; d.wx *= 0.5; d.wy *= 0.5; d.wz *= 0.5;
            if (Math.abs(d.vy) < 0.4 && Math.hypot(d.vx, d.vz) < 0.2) { d.rest = true; d.rx = Math.round(d.rx / (Math.PI / 2)) * Math.PI / 2; d.rz = Math.round(d.rz / (Math.PI / 2)) * Math.PI / 2; d.y = floor + half; }
          }
        }
        if (d.smoking && d.age < 2 && Math.random() < 0.3) this.smoke.spawn({ x: d.x, y: d.y, z: d.z, vy: 0.3, size: 0.06, grow: 3, life: 0.6, color: C(0x3a3632), a0: 0.4, drag: 1 });
      }
      D[w++] = d;
    }
    D.length = w;
    for (let k = 0; k < D.length; k++) {
      const d = D[k];
      const sink = d.age > 11 ? (d.age - 11) / 3 : 0;
      this._m.compose(this._p.set(d.x, d.y - sink * d.sy, d.z), this._q.setFromEuler(this._e.set(d.rx, d.ry, d.rz)), this._s.set(d.sx, d.sy * (1 - sink), d.sz));
      this.debrisMesh.setMatrixAt(k, this._m);
      this.debrisMesh.setColorAt(k, d.color);
    }
    this.debrisMesh.count = D.length;
    this.debrisMesh.instanceMatrix.needsUpdate = true;
    if (this.debrisMesh.instanceColor) this.debrisMesh.instanceColor.needsUpdate = true;
    // rings
    this.rings = this.rings.filter((r) => {
      r.t += dt; const t = r.t / r.dur;
      if (t >= 1) { this.scene.remove(r.m); r.m.material.dispose(); return false; }
      const s = 0.2 + (1 - Math.pow(1 - t, 3)) * r.r; r.m.scale.set(s, 1, s); r.m.material.opacity = 0.8 * (1 - t);
      return true;
    });
    for (const s of this.lights) {
      s.t += dt;
      s.l.intensity = s.t < s.dur ? s.peak * Math.pow(1 - s.t / s.dur, 2) : 0;
    }
  }

  clearLevel() {
    for (const m of this.decals) this.scene.remove(m);
    this.decals = [];
    this.debris = []; this.debrisMesh.count = 0;
    this.trackN = 0; this.trackHead = 0; this.tracks.count = 0;
    this.smoke.clear(); this.glow.clear(); this.flame.clear();
    for (const l of this.fireLights) l.intensity = 0;
    for (const r of this.rings) this.scene.remove(r.m);
    this.rings = [];
  }
}
