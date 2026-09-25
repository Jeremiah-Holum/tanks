// Environment: theme palettes, sky dome (analytic scattering + fbm clouds), sun light with a
// stabilised shadow map that follows the view, image-based ambient (PMREM of the sky), the
// aerial-perspective fog parameters (applied in post.js from depth) and the water surface.
import * as THREE from 'three';
import { noiseTexture, waterNormals } from './textures.js';

const deg = Math.PI / 180;
// Colours are sRGB 0..255 (converted where needed). sky/sun colours are linear HDR.
const SUMMER = {
  ground: {
    grass: [[62, 82, 30], [92, 104, 42], [138, 128, 66], [54, 80, 32], [168, 168, 92]],
    dirt: [[108, 86, 62], [88, 70, 52], [146, 134, 114]],
    road: [[142, 128, 104], [120, 108, 90], [170, 160, 140]],
    sand: [[192, 174, 134], [170, 152, 116]],
    rock: [[122, 118, 110], [90, 88, 84], [118, 124, 84]],
    mud: [[86, 70, 50], [54, 44, 34]],
    field: [[116, 92, 66], [94, 74, 54], [128, 132, 56], [190, 168, 92]], fieldCover: 0.75,
    snow: [[236, 240, 246], [196, 206, 224]],
  },
  foliage: {
    leaf: [[54, 76, 30], [70, 92, 36], [44, 64, 26], [86, 104, 44], [62, 86, 40]],
    leaf2: [[84, 110, 42], [66, 94, 36], [104, 124, 52], [74, 100, 40]],
    needle: [[34, 54, 34], [44, 66, 40], [30, 46, 30]],
    twig: [74, 60, 46], bark: [96, 80, 64],
    blade: [[74, 98, 36], [92, 112, 44], [112, 124, 56], [66, 88, 34]],
    flowers: [[240, 240, 232], [232, 204, 64], [176, 92, 168], [210, 70, 56]],
    bare: false,
  },
  sky: { zenith: [0.15, 0.32, 0.76], horizon: [0.8, 0.83, 0.88], sun: [1.0, 0.8, 0.58], sunI: 4.4, elev: 24, azim: 235,
    fog: 1 / 1700, haze: 0.9, clouds: 0.46, ground: [0.24, 0.24, 0.16], exposure: 1.0, env: 0.42 },
  grassDensity: 1, cropMix: 1,
};
function variant(base, over) {
  const o = JSON.parse(JSON.stringify(base));
  for (const k in over) o[k] = typeof over[k] === 'object' && !Array.isArray(over[k]) ? Object.assign(o[k] || {}, over[k]) : over[k];
  return o;
}
export const THEMES = {
  summer: SUMMER,
  autumn: variant(SUMMER, {
    ground: { grass: [[92, 90, 42], [112, 104, 50], [150, 126, 70], [80, 86, 40], [176, 140, 80]], field: [[132, 104, 76], [108, 86, 64], [150, 124, 72], [170, 140, 84]], fieldCover: 0.25 },
    foliage: { leaf: [[168, 92, 30], [196, 132, 40], [132, 60, 26], [150, 128, 44], [110, 96, 40]], leaf2: [[206, 160, 50], [180, 120, 40], [150, 136, 56]],
      blade: [[112, 104, 50], [132, 116, 58], [150, 130, 70], [96, 92, 44]], flowers: [[200, 170, 90]] },
    sky: { zenith: [0.2, 0.34, 0.66], horizon: [0.86, 0.8, 0.72], sun: [1.0, 0.78, 0.54], sunI: 3.0, elev: 18, fog: 1 / 1300, clouds: 0.56 },
    cropMix: 0.45,
  }),
  winter: variant(SUMMER, {
    ground: { grass: [[150, 150, 130], [176, 176, 160], [140, 132, 110], [130, 134, 120], [200, 200, 190]], field: [[210, 214, 222], [170, 170, 176], [226, 230, 238], [196, 200, 210]], fieldCover: 0.6,
      dirt: [[110, 100, 90], [90, 84, 78], [150, 146, 140]], road: [[168, 164, 160], [140, 136, 132], [200, 200, 204]] },
    foliage: { needle: [[30, 46, 34], [40, 58, 44], [150, 160, 170]], bare: true, blade: [[160, 156, 130], [180, 176, 150]], flowers: [[230, 230, 230]],
      leaf2: [[92, 82, 64], [110, 96, 74], [76, 70, 58], [200, 206, 214]], leaf: [[70, 76, 56], [84, 88, 64], [196, 204, 214]] },
    snow: 1,
    sky: { zenith: [0.3, 0.42, 0.66], horizon: [0.84, 0.86, 0.9], sun: [1.0, 0.9, 0.8], sunI: 2.4, elev: 14, fog: 1 / 1100, clouds: 0.62, ground: [0.6, 0.62, 0.66], env: 0.75 },
    grassDensity: 0.25, cropMix: 0,
  }),
  desert: variant(SUMMER, {
    ground: { grass: [[150, 136, 86], [168, 152, 98], [182, 160, 106], [132, 124, 76], [196, 180, 120]], field: [[176, 150, 108], [150, 126, 90], [186, 164, 100], [200, 178, 116]], fieldCover: 0.3,
      dirt: [[160, 128, 90], [136, 108, 76], [188, 170, 140]], sand: [[214, 190, 144], [196, 170, 124]] },
    foliage: { leaf: [[96, 104, 60], [118, 122, 72], [80, 88, 50]], leaf2: [[120, 124, 70], [100, 108, 60]], blade: [[150, 140, 80], [170, 156, 96]] },
    sky: { zenith: [0.22, 0.4, 0.74], horizon: [0.92, 0.86, 0.76], sun: [1.0, 0.88, 0.7], sunI: 3.8, elev: 30, fog: 1 / 1500, clouds: 0.25, ground: [0.4, 0.34, 0.24] },
    grassDensity: 0.35, cropMix: 0.6,
  }),
};
export function themeOf(map) {
  const name = (map && map.theme && map.theme.name) || 'summer';
  const th = variant(THEMES[name] || SUMMER, {});
  th.name = name;
  const mt = map && map.theme;
  if (mt && Array.isArray(mt.sun)) { // map-provided direction towards the sun
    const [x, y, z] = mt.sun, l = Math.hypot(x, y, z) || 1;
    th.sky.dir = [x / l, y / l, z / l];
  }
  if (mt && typeof mt.fog === 'number' && mt.fog > 0) th.sky.fog = mt.fog < 1 ? mt.fog : 1 / mt.fog;
  if (!th.sky.dir) {
    const e = th.sky.elev * deg, a = th.sky.azim * deg;
    th.sky.dir = [Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e)];
  }
  return th;
}

// ------------------------------------------------------------------ shared sky/fog GLSL
// Uniforms are shared objects (Env.U) so the sky, water and post fog stay in sync.
export const SKY_GLSL = /* glsl */`
uniform vec3 uSunDir; uniform vec3 uSunColor; uniform vec3 uZenith; uniform vec3 uHorizon; uniform vec3 uGroundCol;
uniform float uHaze; uniform float uFogDensity; uniform float uCloud; uniform float uTime; uniform sampler2D uNoise;
// Sky radiance without clouds or sun disc (also the fog in-scatter colour).
vec3 skyBase(vec3 d) {
  float y = d.y;
  float mu = dot(d, uSunDir);
  float hz = pow(1.0 - clamp(y, 0.0, 1.0), 4.0);
  vec3 col = mix(uZenith, uHorizon, hz);
  // warm band near the horizon and the forward-scattering glow around the sun
  float sunLow = 1.0 - clamp(uSunDir.y * 2.2, 0.0, 1.0);
  col += uSunColor * (0.10 + 0.25 * sunLow) * pow(1.0 - abs(y), 6.0) * (0.5 + 0.5 * mu);
  col += uSunColor * (0.35 * pow(max(mu, 0.0), 8.0) + 0.9 * pow(max(mu, 0.0), 64.0)) * uHaze;
  if (y < 0.0) col = mix(col, uGroundCol * (0.6 + 0.4 * uSunDir.y), clamp(-y * 1.5, 0.0, 1.0) * 0.0);
  return col;
}
float cloudField(vec2 p) {
  float n = texture2D(uNoise, p).r * 0.62 + texture2D(uNoise, p * 2.7 + 0.31).g * 0.28 + texture2D(uNoise, p * 7.3).b * 0.1;
  return smoothstep(1.0 - uCloud, 1.0 - uCloud + 0.28, n);
}
vec3 skyFull(vec3 d) {
  vec3 col = skyBase(d);
  float mu = dot(d, uSunDir);
  col += uSunColor * 40.0 * smoothstep(0.99985, 0.99993, mu); // sun disc
  if (d.y > 0.0) {
    vec2 p = d.xz / (d.y + 0.12) * 0.09 + vec2(uTime * 0.0012, uTime * 0.0004);
    float c = cloudField(p);
    float c2 = cloudField(p + uSunDir.xz * 0.02); // self-shadow toward the sun
    vec3 lit = mix(vec3(0.62, 0.64, 0.7) * uHorizon, uSunColor * 1.35, clamp(c - c2 * 0.9 + 0.55, 0.0, 1.0));
    lit += uSunColor * pow(max(mu, 0.0), 6.0) * 1.2 * (1.0 - c);   // silver lining
    float fade = smoothstep(0.0, 0.18, d.y);
    col = mix(col, lit, c * fade * 0.92);
  }
  return col;
}
`;

export class Env {
  constructor(renderer, scene, quality) {
    this.renderer = renderer; this.scene = scene; this.q = quality;
    this.U = {
      uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uSunColor: { value: new THREE.Color() },
      uZenith: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() }, uGroundCol: { value: new THREE.Color() },
      uHaze: { value: 1 }, uFogDensity: { value: 1 / 1500 }, uCloud: { value: 0.45 }, uTime: { value: 0 }, uNoise: { value: noiseTexture() },
    };
    // sky dome
    const skyMat = new THREE.ShaderMaterial({
      uniforms: this.U, side: THREE.BackSide, depthWrite: false, depthTest: false,
      vertexShader: `varying vec3 vDir; void main(){ vDir = position; vec4 p = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_Position = p.xyww; }`,
      fragmentShader: SKY_GLSL + `varying vec3 vDir; void main(){ gl_FragColor = vec4(skyFull(normalize(vDir)), 1.0); }`,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(1000, 48, 24), skyMat);
    this.sky.frustumCulled = false; this.sky.renderOrder = -1000; this.sky.name = 'sky';
    scene.add(this.sky);
    // sun
    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = true;
    this.sun.shadow.bias = -0.0004; this.sun.shadow.normalBias = 0.6;
    scene.add(this.sun, this.sun.target);
    this.hemi = new THREE.HemisphereLight(0xbfd4ff, 0x4a4630, 0.12);
    scene.add(this.hemi);
    this._focus = new THREE.Vector3(); this._tmp = new THREE.Vector3();
    this.water = null;
    this.setQuality(quality);
  }

  setQuality(q) {
    this.q = q;
    const s = this.sun.shadow;
    if (s.mapSize.x !== q.shadowMap) { s.mapSize.set(q.shadowMap, q.shadowMap); if (s.map) { s.map.dispose(); s.map = null; } }
    s.radius = q.shadowRadius; s.blurSamples = 8;
    const R = q.shadowRange;
    Object.assign(s.camera, { left: -R, right: R, top: R, bottom: -R, near: 1, far: 1400 });
    s.camera.updateProjectionMatrix();
  }

  setTheme(th) {
    this.theme = th;
    const S = th.sky, U = this.U;
    U.uSunDir.value.set(...S.dir).normalize();
    U.uSunColor.value.setRGB(...S.sun); U.uZenith.value.setRGB(...S.zenith); U.uHorizon.value.setRGB(...S.horizon);
    U.uGroundCol.value.setRGB(...S.ground); U.uHaze.value = S.haze; U.uFogDensity.value = S.fog; U.uCloud.value = S.clouds;
    this.sun.color.setRGB(...S.sun); this.sun.intensity = S.sunI;
    this.hemi.color.setRGB(...S.horizon); this.hemi.groundColor.setRGB(...S.ground);
    this._bakeEnv();
  }

  // Image-based ambient: PMREM of the cloudless sky with a ground hemisphere.
  _bakeEnv() {
    const envScene = new THREE.Scene();
    const m = new THREE.ShaderMaterial({
      uniforms: this.U, side: THREE.BackSide, depthWrite: false,
      vertexShader: `varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: SKY_GLSL + `varying vec3 vDir; void main(){ vec3 d = normalize(vDir); vec3 c = skyBase(d);
        float cl = uCloud * 0.5; c = mix(c, uHorizon * 0.9, cl * smoothstep(0.0, 0.3, d.y));
        vec3 g = uGroundCol * (0.35 + 0.9 * uSunDir.y) + uSunColor * 0.05; c = mix(c, g, smoothstep(0.02, -0.08, d.y));
        gl_FragColor = vec4(c, 1.0); }`,
    });
    envScene.add(new THREE.Mesh(new THREE.SphereGeometry(100, 32, 16), m));
    const pm = new THREE.PMREMGenerator(this.renderer);
    if (this.envRT) this.envRT.dispose();
    this.envRT = pm.fromScene(envScene, 0, 0.1, 500);
    pm.dispose(); m.dispose();
    this.scene.environment = this.envRT.texture;
    this.scene.environmentIntensity = this.theme.sky.env;
  }

  // focus: world point the shadow map is centred on
  update(camera, dt, focus) {
    this.U.uTime.value += dt;
    this.sky.position.copy(camera.position);
    this.sky.scale.setScalar(Math.min(camera.far * 0.9, 20000) / 1000);
    const R = this.q.shadowRange, d = this.U.uSunDir.value, s = this.sun.shadow;
    // stabilise: snap the focus to whole shadow texels in light space
    const f = this._focus.copy(focus);
    const up = Math.abs(d.y) > 0.99 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const rx = this._tmp.crossVectors(up, d).normalize(), ry = new THREE.Vector3().crossVectors(d, rx);
    const texel = (2 * R) / s.mapSize.x;
    const a = f.dot(rx), b = f.dot(ry), c = f.dot(d);
    f.copy(rx).multiplyScalar(Math.round(a / texel) * texel).addScaledVector(ry, Math.round(b / texel) * texel).addScaledVector(d, c);
    this.sun.target.position.copy(f);
    this.sun.position.copy(f).addScaledVector(d, 700);
    this.sun.target.updateMatrixWorld(); this.sun.updateMatrixWorld();
    if (this.water) this.water.material.uniforms.uTime.value = this.U.uTime.value;
  }

  // Water plane at map.water.level; colour and shoreline from the terrain height texture.
  buildWater(map, terrain) {
    if (this.water) { this.scene.remove(this.water); this.water.geometry.dispose(); this.water.material.dispose(); this.water = null; }
    if (!map.water) return;
    const size = map.size, ext = 2600;
    const geo = new THREE.PlaneGeometry(size + ext * 2, size + ext * 2, 1, 1); geo.rotateX(-Math.PI / 2);
    geo.translate(size / 2, map.water.level, size / 2);
    const mat = new THREE.ShaderMaterial({
      uniforms: { ...this.U, uWN: { value: waterNormals() }, uHeight: { value: terrain.heightTex }, uHRes: { value: map.res }, uHSize: { value: size },
        uLevel: { value: map.water.level }, uTime: { value: 0 }, uShadowTex: { value: terrain.shadowTex } },
      transparent: true, depthWrite: true,
      vertexShader: `varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: SKY_GLSL + /* glsl */`
        uniform sampler2D uWN; uniform highp sampler2D uHeight; uniform float uHRes; uniform float uHSize; uniform float uLevel; uniform sampler2D uShadowTex;
        varying vec3 vW;
        float hAt(vec2 p) {
          vec2 g = clamp(p / uHSize, 0.0, 1.0) * (uHRes - 1.0); vec2 i = floor(g); vec2 f = g - i;
          ivec2 a = ivec2(i); ivec2 b = min(a + 1, ivec2(uHRes - 1.0));
          float h00 = texelFetch(uHeight, a, 0).r, h10 = texelFetch(uHeight, ivec2(b.x, a.y), 0).r;
          float h01 = texelFetch(uHeight, ivec2(a.x, b.y), 0).r, h11 = texelFetch(uHeight, b, 0).r;
          return mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
        }
        void main() {
          float depth = uLevel - hAt(vW.xz);
          if (depth < -0.02) discard;
          vec2 fl = vec2(uTime * 0.013, uTime * 0.006);
          vec3 n1 = texture2D(uWN, vW.xz / 23.0 + fl).xyz * 2.0 - 1.0;
          vec3 n2 = texture2D(uWN, vW.xz / 7.0 - fl * 1.7).xyz * 2.0 - 1.0;
          vec3 N = normalize(vec3(n1.x + n2.x * 0.6, 3.2, n1.y + n2.y * 0.6));
          vec3 V = normalize(cameraPosition - vW);
          float ndv = max(dot(N, V), 0.0);
          float fres = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
          vec3 R = reflect(-V, N); R.y = abs(R.y) + 0.02;
          float sh = texture2D(uShadowTex, vW.xz / uHSize).r;
          vec3 refl = skyFull(normalize(R)) * 0.85;
          // banks and trees darken the reflection near the shore
          refl *= mix(0.45, 1.0, smoothstep(0.2, 2.5, depth));
          vec3 shallow = vec3(0.10, 0.11, 0.07), deep = vec3(0.015, 0.035, 0.035);
          vec3 body = mix(shallow, deep, 1.0 - exp(-depth * 0.45)) * (0.4 + 0.6 * sh * uSunDir.y + 0.3);
          vec3 col = mix(body, refl, fres);
          float spec = pow(max(dot(R, uSunDir), 0.0), 380.0) * 6.0 * sh;
          col += uSunColor * spec;
          float foam = smoothstep(0.25, 0.0, depth) * smoothstep(0.35, 0.65, texture2D(uNoise, vW.xz / 9.0 + fl).g);
          col = mix(col, vec3(0.7, 0.72, 0.7) * (0.4 + 0.6 * sh), foam * 0.35);
          float a = smoothstep(-0.02, 0.9, depth);
          gl_FragColor = vec4(col, mix(a * 0.85, 1.0, fres * a));
        }`,
    });
    this.water = new THREE.Mesh(geo, mat);
    this.water.renderOrder = 1; this.water.name = 'water';
    this.scene.add(this.water);
  }
}
