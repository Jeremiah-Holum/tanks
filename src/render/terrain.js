// Terrain: the 1 km playable heightfield (chunked, 2× upsampled on medium/high), an outer ring
// that continues the land to the horizon, the splat material (8 texture-array layers with
// height blending, two-scale anti-tiling, detail normals, slope rock, oriented crop rows per
// field, macro variation, the red map boundary), baked far shadows / canopy AO, and near-camera
// grass. Heights are sampled bilinearly from MapData, like sim/map/query.js heightAt.
import * as THREE from 'three';
import { terrainLayers, noiseTexture, grassAtlas, tileNoise } from './textures.js';

export const GROUND = { GRASS: 0, DIRT: 1, ROAD: 2, SAND: 3, ROCK: 4, MUD: 5, SHALLOW: 6, DEEP: 7, FIELD: 8, SNOW: 9 };
// GROUND → splat channel weights [grass dirt road sand | rock mud field snow]
const G2W = {
  0: [1, 0, 0, 0, 0, 0, 0, 0], 1: [0, 1, 0, 0, 0, 0, 0, 0], 2: [0, 0, 1, 0, 0, 0, 0, 0], 3: [0, 0, 0, 1, 0, 0, 0, 0],
  4: [0, 0, 0, 0, 1, 0, 0, 0], 5: [0, 0, 0, 0, 0, 1, 0, 0], 6: [0, 0.2, 0, 0.4, 0, 0.4, 0, 0], 7: [0, 0, 0, 0.3, 0, 0.7, 0, 0],
  8: [0, 0, 0, 0, 0, 0, 1, 0], 9: [0, 0, 0, 0, 0, 0, 0, 1],
};
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// Bilinear height over the map grid (clamped). Matches query.js heightAt.
export function makeHeight(map) {
  const { res, heights, size } = map, cell = size / (res - 1);
  return (x, z) => {
    const gx = Math.min(res - 1.0001, Math.max(0, x / cell)), gz = Math.min(res - 1.0001, Math.max(0, z / cell));
    const i = gx | 0, j = gz | 0, fx = gx - i, fz = gz - j, o = j * res + i;
    const a = heights[o], b = heights[o + 1], c = heights[o + res], d = heights[o + res + 1];
    return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
  };
}

// Land beyond the map: extrude the edge profile, then blend into rolling hills that grow with
// distance so the horizon is framed by high ground.
export function makeOuterHeight(map, h) {
  const S = map.size, N = tileNoise(4242);
  let sum = 0, n = 0;
  for (let k = 0; k <= 64; k++) { const t = (k / 64) * S; sum += h(t, 0) + h(t, S) + h(0, t) + h(S, t); n += 4; }
  let base = sum / n;
  if (map.water) base = Math.max(base, map.water.level + 4);
  // rivers leaving the map carry on as channels cut through the outer hills
  const chans = [];
  for (const rv of map.rivers || []) {
    const pts = rv.path; if (!pts || pts.length < 2) continue;
    for (const [a, b] of [[pts[1], pts[0]], [pts[pts.length - 2], pts[pts.length - 1]]]) {
      let dx = b[0] - a[0], dz = b[1] - a[1]; const l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
      const ox = Math.min(S, Math.max(0, a[0])), oz = Math.min(S, Math.max(0, a[1]));
      let bed = h(ox, oz), half = 6;
      if (map.water) for (let k = 1; k < 60; k++) { const px = ox - dz * k, pz = oz + dx * k, qx = ox + dz * k, qz = oz - dx * k; if (h(px, pz) < map.water.level || h(qx, qz) < map.water.level) half = k; else break; }
      for (let k = -half; k <= half; k++) bed = Math.min(bed, h(Math.min(S, Math.max(0, ox - dz * k)), Math.min(S, Math.max(0, oz + dx * k))));
      chans.push({ ox, oz, dx, dz, bed, half: Math.max(8, rv.halfW || half) });
    }
  }
  const P = 1 << 16;
  const fbm = (x, z, sc, oct) => { let s = 0, a = 1, f = 1 / sc, no = 0; for (let o = 0; o < oct; o++) { s += a * (N.vn(x * f + 5000 + o * 31, z * f + 5000 - o * 17, P) - 0.5); no += a; a *= 0.5; f *= 2.03; } return s / no; };
  return (x, z) => {
    const cx = Math.min(S, Math.max(0, x)), cz = Math.min(S, Math.max(0, z));
    const d = Math.hypot(x - cx, z - cz);
    if (d <= 0) return h(cx, cz);
    // the edge profile, blurred along the edge more the further out we are (a plain
    // extrusion would stretch every bump on the edge into a long ridge)
    const spread = Math.min(260, d * 0.8), tx = cx === x ? 1 : 0, tz = cz === z ? 1 : 0;
    let he = 0;
    for (let k = -3; k <= 3; k++) { const t = (k / 3) * spread; he += h(Math.min(S, Math.max(0, cx + tx * t)), Math.min(S, Math.max(0, cz + tz * t))); }
    he /= 7;
    const w = smooth(0, 380, d);
    const amp = 10 + Math.min(d, 4000) * 0.06;
    const hills = base + fbm(x, z, 900, 5) * amp * 2.2 + Math.pow(Math.min(d, 5000) / 1000, 1.6) * 38 + fbm(x, z, 180, 3) * 6 * w;
    let out = he + (hills - he) * w;
    for (const c of chans) {
      const rx = x - c.ox, rz = z - c.oz, t = rx * c.dx + rz * c.dz;
      if (t < 0) continue;
      const perp = Math.abs(-rx * c.dz + rz * c.dx - Math.sin(t / 160) * Math.min(40, t * 0.15));
      const wb = c.half * (1 + t / 900);
      if (perp < wb * 3) out = Math.min(out, c.bed + (out - c.bed) * smooth(wb * 0.75, wb * 3, perp));
    }
    return out;
  };
}

// ------------------------------------------------------------------ far shadow patch
// Adds a baked sun-visibility lookup (terrain horizon + canopy shadows) that takes over from
// the realtime shadow map outside its range. Used by the terrain and prop materials.
export function patchFarShadow(shader, U) {
  Object.assign(shader.uniforms, { tFarShadow: U.tFarShadow, uFarC: U.uFarC, uFarR: U.uFarR, uMapSize: U.uMapSize });
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vFsW;')
    .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
      { vec4 fsw = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
        fsw = instanceMatrix * fsw;
        #endif
        vFsW = (modelMatrix * fsw).xyz; }`);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>
      varying vec3 vFsW; uniform sampler2D tFarShadow; uniform vec2 uFarC; uniform float uFarR; uniform float uMapSize;
      float farSun() {
        vec2 uv = vFsW.xz / uMapSize;
        float b = (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) ? 1.0 : texture2D(tFarShadow, uv).r;
        float w = smoothstep(uFarR * 0.62, uFarR * 0.92, length(vFsW.xz - uFarC));
        return mix(1.0, b, w);
      }`)
    .replace('#include <lights_fragment_begin>', THREE.ShaderChunk.lights_fragment_begin.replace(
      'directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow(',
      'directLight.color *= farSun(); directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow('));
}

const TERRAIN_FRAG = /* glsl */`
uniform highp sampler2DArray tAlb; uniform highp sampler2DArray tNrm;
uniform sampler2D tSplatA; uniform sampler2D tSplatB; uniform sampler2D tField; uniform sampler2D tNoise;
uniform float uDetail; uniform vec2 uPlay; uniform float uCropMix; uniform vec3 uSoil; uniform vec3 uCrop[5]; uniform float uCropCov[5];
varying vec3 vTW; varying vec3 vTN;
vec3 tAlbedo; float tRough; vec3 tNormal; float tAO;
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
void terrainShade() {
  vec2 xz = vTW.xz;
  float dist = length(vTW - cameraPosition);
  vec4 nz = texture2D(tNoise, xz / 61.0);
  vec2 uvm = xz / uMapSize;
  vec2 warp = (nz.rg - 0.5) * 3.2 / uMapSize;
  vec4 A = texture2D(tSplatA, uvm + warp), B = texture2D(tSplatB, uvm + warp);
  vec4 F = texture2D(tField, uvm);
  // outside the playable square: the edge extruded, fading into a procedural patchwork
  vec2 cl = clamp(xz, 0.0, uMapSize); float dOut = length(xz - cl);
  if (dOut > 0.0) {
    vec2 wq = mat2(0.94, 0.34, -0.34, 0.94) * xz + (texture2D(tNoise, xz / 900.0).rg - 0.5) * 160.0 + (nz.rg - 0.5) * 30.0;
    vec2 fc = floor(wq / vec2(190.0, 130.0));
    float hc = hash12(fc), hc2 = hash12(fc + 7.3);
    float isF = step(0.42, hc) * step(hc, 0.88);
    vec4 PA = vec4(1.0 - isF, 0.0, 0.0, 0.0);
    vec4 PB = vec4(0.0, 0.0, isF, 0.0);
    float t = smoothstep(40.0, 260.0, dOut);
    A = mix(A, PA, t); B = mix(B, PB, t);
    float ang = 0.35 + step(0.5, hc2) * 1.5708;
    float oc = hc2 < 0.3 ? 2.0 : hc2 < 0.5 ? 4.0 : hc2 < 0.7 ? 3.0 : hc2 < 0.85 ? 1.0 : 0.0; // mostly green crops far out
    F = mix(F, vec4(0.5 + 0.5 * cos(ang), 0.5 + 0.5 * sin(ang), oc / 4.0, hash12(fc + 3.1)), step(0.5, t));
  }
  float w[8]; w[0] = A.r; w[1] = A.g; w[2] = A.b; w[3] = A.a; w[4] = B.r; w[5] = B.g; w[6] = B.b; w[7] = B.a;
  // the scenery ring outside the play area: rocky ground only where it is actually steep
  float outPlay = smoothstep(0.0, 12.0, -min(min(xz.x - uPlay.x, xz.y - uPlay.x), min(uPlay.y - xz.x, uPlay.y - xz.y)));
  float keepRock = smoothstep(0.12, 0.3, 1.0 - vTN.y);
  float mv = w[4] * outPlay * (1.0 - keepRock); w[4] -= mv; w[0] += mv * 0.8; w[1] += mv * 0.2;
  // steep slopes turn to rock
  float slope = 1.0 - clamp(vTN.y, 0.0, 1.0);
  float rk = smoothstep(0.22, 0.38, slope + (nz.b - 0.5) * 0.12);
  for (int i = 0; i < 8; i++) w[i] *= (1.0 - rk);
  w[4] += rk;
  // field orientation (per field component, from terrain.js)
  vec2 fdir = normalize(F.rg * 2.0 - 1.0 + 1e-4);
  mat2 frot = mat2(fdir.x, -fdir.y, fdir.y, fdir.x);
  vec2 uvN = xz / 4.0, uvF = mat2(0.8, -0.6, 0.6, 0.8) * xz / 15.7 + 0.37;
  vec2 fuv = frot * xz / 4.0;
  float far = smoothstep(25.0, 140.0, dist);
  // far away every layer fades to its average colour times un-tiled procedural variation,
  // so no tile repeat survives into the distance
  float fade = smoothstep(45.0, 240.0, dist);
  float nv = texture2D(tNoise, mat2(0.8, 0.6, -0.6, 0.8) * xz / 29.0).g * 0.6 + texture2D(tNoise, mat2(0.5, -0.87, 0.87, 0.5) * xz / 11.0).b * 0.4;
  vec4 col[8]; float hb[8]; float mx = 0.0;
  for (int i = 0; i < 8; i++) {
    col[i] = vec4(0.0); hb[i] = 0.0;
    if (w[i] > 0.01) {
      vec4 a, b;
      if (i == 6) { a = texture(tAlb, vec3(fuv, 6.0), 0.5); b = a; }
      else { a = texture(tAlb, vec3(uvN, float(i))); b = texture(tAlb, vec3(uvF, float(i))); }
      vec3 avg = textureLod(tAlb, vec3(0.5, 0.5, float(i)), 10.0).rgb;
      vec3 det = mix(a.rgb, b.rgb, mix(0.3, 0.62, far));
      col[i] = vec4(mix(det, avg * (0.78 + 0.44 * nv), fade * 0.85), mix(mix(a.a, b.a, 0.4), 0.5, fade));
      if (i == 6) { // crop rows: soil in the furrows, the field's crop on the ridges
        int ci = int(F.b * 4.0 + 0.5);
        float ridge = mix(smoothstep(0.25, 0.75, a.a), 0.62, smoothstep(20.0, 110.0, dist));
        float lum = clamp(dot(col[i].rgb, vec3(0.3, 0.59, 0.11)) / max(dot(avg, vec3(0.3, 0.59, 0.11)), 1e-3), 0.6, 1.4);
        float fill = uCropCov[ci];
        float dense = step(0.8, fill);
        float rowVar = 0.93 + 0.14 * texture2D(tNoise, vec2(dot(fuv, vec2(1.0, 0.0)) / 6.0, dot(fuv, vec2(0.0, 1.0)) / 90.0)).b;
        vec3 crop = mix(uSoil * lum, uCrop[ci] * lum * rowVar * mix(mix(0.72, 0.9, dense), 1.0, ridge), max(ridge, dense * fill));
        crop *= 0.92 + 0.16 * nv;
        col[i].rgb = mix(col[i].rgb, crop, uCropMix);
      }
      hb[i] = w[i] * (0.35 + col[i].a);
      mx = max(mx, hb[i]);
    }
  }
  vec3 c = vec3(0.0); float ws = 0.0; float rough = 0.0;
  vec2 dn = vec2(0.0);
  const float R[8] = float[8](0.95, 0.92, 0.88, 0.9, 0.82, 0.62, 0.93, 0.7);
  for (int i = 0; i < 8; i++) {
    if (hb[i] > 0.0) {
      float k = max(hb[i] - mx + 0.18, 0.0);
      c += col[i].rgb * k; ws += k; rough += R[i] * k;
      #ifdef TERRAIN_DETAIL
      if (dist < 160.0) {
        vec2 u1 = i == 6 ? fuv : uvN;
        vec2 n = texture(tNrm, vec3(u1, float(i))).rg * 2.0 - 1.0;
        if (i == 6) n = n * frot;
        dn += n * k;
      }
      #endif
    }
  }
  c /= max(ws, 1e-4); rough /= max(ws, 1e-4); dn /= max(ws, 1e-4);
  // per-field tint and crop variety
  float fw = w[6] / max(w[0] + w[1] + w[2] + w[3] + w[4] + w[5] + w[6] + w[7], 1e-3);
  c = mix(c, c * mix(vec3(1.08, 1.0, 0.82), vec3(0.86, 1.02, 0.9), F.b) * (0.9 + 0.2 * F.a), fw);
  // macro variation: large soft brightness / hue patches break tiling at every distance
  float m1 = texture2D(tNoise, mat2(0.87, 0.5, -0.5, 0.87) * xz / 520.0).r, m2 = texture2D(tNoise, mat2(0.6, -0.8, 0.8, 0.6) * xz / 190.0 + 0.5).g;
  float m3 = texture2D(tNoise, xz / 47.0 + 0.2).g;
  c *= 0.8 + 0.4 * m1;
  float gw = w[0] / max(w[0] + w[1] + w[2] + w[3] + w[4] + w[5] + w[6] + w[7], 1e-3);
  c = mix(c, c * vec3(1.16, 1.08, 0.72), smoothstep(0.42, 0.78, m2) * 0.7 * gw);   // sun-dried patches
  c = mix(c, c * vec3(0.82, 0.95, 0.9), smoothstep(0.55, 0.8, m3) * 0.5 * gw);     // lush, darker clumps
  // red boundary line (inside edge), plus a slight darkening just outside
  float dIn = min(min(xz.x - uPlay.x, xz.y - uPlay.x), min(uPlay.y - xz.x, uPlay.y - xz.y));
  float line = 1.0 - smoothstep(0.35, 0.9, abs(dIn - 0.6));
  float dash = step(0.35, fract((xz.x + xz.y) / 6.0));
  c = mix(c, vec3(0.55, 0.035, 0.02), line * 0.8 * mix(0.6, 1.0, dash) * (1.0 - smoothstep(250.0, 700.0, dist)));
  c *= mix(1.0, 0.9, smoothstep(0.0, 2.0, -dIn) * (1.0 - smoothstep(4.0, 30.0, -dIn)));
  tAlbedo = c; tRough = rough;
  float ds = uDetail * (1.0 - smoothstep(40.0, 160.0, dist));
  tNormal = normalize(vTN + vec3(dn.x, 0.0, dn.y) * ds);
  tAO = texture2D(tFarShadow, clamp(uvm, 0.0, 1.0)).g;
  if (dOut > 0.0) tAO = 1.0;
}
`;

export class Terrain {
  constructor(scene, quality) {
    this.scene = scene; this.q = quality;
    this.group = new THREE.Group(); this.group.name = 'terrain';
    scene.add(this.group);
    this.U = {
      tFarShadow: { value: null }, uFarC: { value: new THREE.Vector2(500, 500) }, uFarR: { value: 150 }, uMapSize: { value: 1000 },
    };
    this.grass = null;
  }

  dispose() {
    this.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    this.group.clear();
    if (this.grass) { this.scene.remove(this.grass.mesh); this.grass.mesh.geometry.dispose(); this.grass = null; }
    for (const t of [this.heightTex, this.splatA, this.splatB, this.fieldTex, this.shadowTex]) if (t) t.dispose();
  }

  // Build everything for a map. theme from env.themeOf(map).
  build(map, theme) {
    this.dispose();
    this.map = map; this.theme = theme;
    const S = map.size;
    this.h = makeHeight(map);
    this.hOut = makeOuterHeight(map, this.h);
    this.U.uMapSize.value = S;
    this._textures(map);
    this.layers = terrainLayers(theme.ground, theme.name);
    this.material = this._material();
    this._meshes(map);
    this._buildGrass();
  }

  heightAt(x, z) { const S = this.map.size; return x >= 0 && z >= 0 && x <= S && z <= S ? this.h(x, z) : this.hOut(x, z); }

  // ---------------------------------------------------------------- data textures
  _textures(map) {
    const { res, heights, ground } = map;
    // heights (exact, fetched with texelFetch + manual bilinear)
    const ht = new THREE.DataTexture(new Float32Array(heights), res, res, THREE.RedFormat, THREE.FloatType);
    ht.minFilter = ht.magFilter = THREE.NearestFilter; ht.needsUpdate = true;
    this.heightTex = ht;
    // splat weights, upsampled ×4 with a smooth (cubic B-spline-ish) filter so roads and field
    // edges curve instead of showing the bilinear diamond pattern
    const U = 4, R2 = (res - 1) * U + 1;
    const W = new Float32Array(res * res * 8);
    for (let k = 0; k < res * res; k++) { const w = G2W[ground[k]] || G2W[0]; for (let c = 0; c < 8; c++) W[k * 8 + c] = w[c]; }
    const A = new Uint8Array(R2 * R2 * 4), B = new Uint8Array(R2 * R2 * 4);
    const bs = (t) => { const a = Math.abs(t); return a < 1 ? (4 - 6 * a * a + 3 * a * a * a) / 6 : a < 2 ? Math.pow(2 - a, 3) / 6 : 0; };
    const acc = new Float32Array(8);
    for (let y = 0; y < R2; y++) for (let x = 0; x < R2; x++) {
      const gx = x / U, gy = y / U, ix = Math.floor(gx), iy = Math.floor(gy);
      acc.fill(0); let ws = 0;
      for (let j = -1; j <= 2; j++) {
        const yy = Math.min(res - 1, Math.max(0, iy + j)), wy = bs(gy - (iy + j));
        if (!wy) continue;
        for (let i = -1; i <= 2; i++) {
          const xx = Math.min(res - 1, Math.max(0, ix + i)), wgt = wy * bs(gx - (ix + i));
          if (!wgt) continue;
          const o = (yy * res + xx) * 8;
          for (let c = 0; c < 8; c++) acc[c] += W[o + c] * wgt;
          ws += wgt;
        }
      }
      const o = (y * R2 + x) * 4;
      for (let c = 0; c < 4; c++) { A[o + c] = (acc[c] / ws) * 255; B[o + c] = (acc[c + 4] / ws) * 255; }
    }
    const mkT = (d, n) => { const t = new THREE.DataTexture(d, n, n, THREE.RGBAFormat); t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.generateMipmaps = true; t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.needsUpdate = true; return t; };
    this.splatA = mkT(A, R2); this.splatB = mkT(B, R2);
    this.splatData = { A, R2 };
    // fields: row direction (rg = cos/sin of the texture rotation), crop (b) and a tint seed (a).
    // From map.fields when present (rows along each field's long side), otherwise connected
    // components of FIELD cells with rows along their principal axis.
    const F = new Uint8Array(res * res * 4), lab = new Int32Array(res * res).fill(-1);
    let nComp = 0;
    const CROPS = { wheat: 0, barley: 1, cabbage: 2, stubble: 3, sunflower: 4 };
    if (map.fields && map.fields.length) {
      nComp = -1; // skip the component pass
      const cell = map.size / (res - 1);
      map.fields.forEach((f, id) => {
        const long = f.w >= f.d, rx = long ? Math.cos(f.yaw) : Math.sin(f.yaw), rz = long ? -Math.sin(f.yaw) : Math.cos(f.yaw);
        const ct = rz, st = -rx; // texture rotation θ: rows run along (−sinθ, cosθ) = (rx, rz)
        const crop = CROPS[f.crop] ?? (id % 5), h2 = ((id * 40503 + 17) % 997) / 997;
        const poly = f.poly || [[f.x - f.w / 2, f.z - f.d / 2], [f.x + f.w / 2, f.z - f.d / 2], [f.x + f.w / 2, f.z + f.d / 2], [f.x - f.w / 2, f.z + f.d / 2]];
        let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9; for (const [x, z] of poly) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
        for (let j = Math.max(0, Math.floor(z0 / cell) - 1); j <= Math.min(res - 1, Math.ceil(z1 / cell) + 1); j++)
          for (let i = Math.max(0, Math.floor(x0 / cell) - 1); i <= Math.min(res - 1, Math.ceil(x1 / cell) + 1); i++) {
            const px = i * cell, pz = j * cell; let inside = false;
            for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) {
              const [xa, za] = poly[a], [xb, zb] = poly[b];
              if ((za > pz) !== (zb > pz) && px < ((xb - xa) * (pz - za)) / (zb - za) + xa) inside = !inside;
            }
            if (!inside) continue;
            const o = (j * res + i) * 4;
            F[o] = (ct * 0.5 + 0.5) * 255; F[o + 1] = (st * 0.5 + 0.5) * 255; F[o + 2] = (crop / 4) * 255; F[o + 3] = h2 * 255;
          }
      });
    }
    const stack = [];
    for (let k = 0; k < res * res && nComp >= 0; k++) {
      if (ground[k] !== GROUND.FIELD || lab[k] >= 0) continue;
      const id = nComp++, cells = [];
      stack.push(k); lab[k] = id;
      while (stack.length) {
        const c = stack.pop(); cells.push(c);
        const ci = c % res, cj = (c / res) | 0;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const ni = ci + di, nj = cj + dj; if (ni < 0 || nj < 0 || ni >= res || nj >= res) continue;
          const n = nj * res + ni; if (ground[n] === GROUND.FIELD && lab[n] < 0) { lab[n] = id; stack.push(n); }
        }
      }
      let mx = 0, mz = 0; for (const c of cells) { mx += c % res; mz += (c / res) | 0; } mx /= cells.length; mz /= cells.length;
      let sxx = 0, szz = 0, sxz = 0; for (const c of cells) { const dx = (c % res) - mx, dz = ((c / res) | 0) - mz; sxx += dx * dx; szz += dz * dz; sxz += dx * dz; }
      // rows run along the major axis; the texture's rows run along v, so rotate u onto the minor axis
      const ang = 0.5 * Math.atan2(2 * sxz, sxx - szz) + Math.PI / 2;
      const h1 = ((id * 2654435761) >>> 0) / 4294967296, h2 = ((id * 40503 + 17) % 997) / 997;
      for (const c of cells) { const o = c * 4; F[o] = (Math.cos(ang) * 0.5 + 0.5) * 255; F[o + 1] = (Math.sin(ang) * 0.5 + 0.5) * 255; F[o + 2] = (((id * 7) % 5) / 4) * 255; F[o + 3] = h2 * 255; }
    }
    // spread the field attributes one cell into neighbours so bilinear edges keep the direction
    for (let pass = 0; pass < 2; pass++) for (let k = 0; k < res * res; k++) {
      if (F[k * 4] || F[k * 4 + 1]) continue;
      const ci = k % res, cj = (k / res) | 0;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ni = ci + di, nj = cj + dj; if (ni < 0 || nj < 0 || ni >= res || nj >= res) continue;
        const n = (nj * res + ni) * 4; if (F[n] || F[n + 1]) { for (let c = 0; c < 4; c++) F[k * 4 + c] = F[n + c]; break; }
      }
    }
    for (let k = 0; k < res * res; k++) if (!F[k * 4] && !F[k * 4 + 1]) { F[k * 4] = 255; F[k * 4 + 1] = 128; F[k * 4 + 2] = 128; F[k * 4 + 3] = 128; }
    const ft = new THREE.DataTexture(F, res, res, THREE.RGBAFormat); ft.minFilter = ft.magFilter = THREE.NearestFilter; ft.needsUpdate = true;
    this.fieldTex = ft;
    // placeholder far-shadow texture (terrain only) until bakeShadows() runs with the casters
    this.shadowTex = null;
  }

  // Baked sun visibility (r) and ambient occlusion (g), 1024² over the map: heightfield horizon
  // tracing plus the ground shadows of trees, bushes and buildings. casters: [{x,z,h,r,kind}]
  bakeShadows(sunDir, casters = []) {
    const map = this.map, S = map.size, N = 1024, px = S / N;
    const sun = new Float32Array(N * N).fill(1), ao = new Float32Array(N * N).fill(1);
    const res = map.res, cell = S / (res - 1), h = this.h;
    const len = Math.hypot(sunDir.x, sunDir.z) || 1, dx = sunDir.x / len, dz = sunDir.z / len, slope = sunDir.y / len;
    // terrain horizon at the height grid resolution, soft penumbra
    const T = new Float32Array(res * res);
    let hmax = -1e9; for (let k = 0; k < res * res; k++) hmax = Math.max(hmax, map.heights[k]);
    for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) {
      const x0 = i * cell, z0 = j * cell, h0 = map.heights[j * res + i] + 0.5;
      let vis = 1;
      for (let s = 1; s < 220; s++) {
        const t = s * cell * 0.8, x = x0 + dx * t, z = z0 + dz * t;
        if (x < 0 || z < 0 || x > S || z > S) break;
        const ry = h0 + t * slope; if (ry > hmax) break;
        const d = ry - h(x, z);
        vis = Math.min(vis, 0.5 + d / (t * 0.035 + 0.8));
        if (vis <= 0) { vis = 0; break; }
      }
      T[j * res + i] = Math.max(0, Math.min(1, vis));
    }
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const gx = Math.min(res - 1.001, (x + 0.5) * px / cell), gz = Math.min(res - 1.001, (y + 0.5) * px / cell);
      const i = gx | 0, j = gz | 0, fx = gx - i, fz = gz - j, o = j * res + i;
      sun[y * N + x] = (T[o] * (1 - fx) + T[o + 1] * fx) * (1 - fz) + (T[o + res] * (1 - fx) + T[o + res + 1] * fx) * fz;
    }
    // casters: an ellipse per crown/building offset down-sun, elongated by 1/tan(elevation)
    const cot = Math.min(4, 1 / Math.max(0.2, slope));
    const stamp = (cx, cz, rx, rAlong, dark, arr) => {
      const r = Math.max(rx, rAlong), x0 = Math.max(0, ((cx - r) / px) | 0), x1 = Math.min(N - 1, ((cx + r) / px) | 0);
      const y0 = Math.max(0, ((cz - r) / px) | 0), y1 = Math.min(N - 1, ((cz + r) / px) | 0);
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const wx = (x + 0.5) * px - cx, wz = (y + 0.5) * px - cz;
        const a = wx * dx + wz * dz, b = -wx * dz + wz * dx;
        const q = (a * a) / (rAlong * rAlong) + (b * b) / (rx * rx);
        if (q < 1) { const k = y * N + x; arr[k] = Math.min(arr[k], 1 - dark * Math.min(1, (1 - q) * 2.5)); }
      }
    };
    for (const c of casters) {
      const off = (c.hc !== undefined ? c.hc : c.h * 0.6) * cot;
      if (c.box) { // building: stamp several discs along the projected box
        for (let t = 0; t <= 1.001; t += 0.25) stamp(c.x + dx * off * t, c.z + dz * off * t, c.r, c.r, 0.8, sun);
      } else stamp(c.x + dx * off, c.z + dz * off, c.r * 0.9, c.r * 0.9 + c.h * 0.25 * cot, c.dark || 0.65, sun);
      stamp(c.x, c.z, c.r * 1.25, c.r * 1.25, c.box ? 0.35 : 0.3, ao);
    }
    const D = new Uint8Array(N * N * 4);
    for (let k = 0; k < N * N; k++) { D[k * 4] = sun[k] * 255; D[k * 4 + 1] = ao[k] * 255; D[k * 4 + 3] = 255; }
    if (this.shadowTex) this.shadowTex.dispose();
    const t = new THREE.DataTexture(D, N, N, THREE.RGBAFormat);
    t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.generateMipmaps = true; t.needsUpdate = true;
    this.shadowTex = t; this.U.tFarShadow.value = t;
    this.sunVis = sun; this.sunVisN = N;
    return t;
  }

  // ---------------------------------------------------------------- material
  _material() {
    const q = this.q;
    const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0 });
    const lin = (c) => new THREE.Color().setRGB(c[0] / 255, c[1] / 255, c[2] / 255, THREE.SRGBColorSpace);
    const th = this.theme, play = this.map.play || { min: 0, max: this.map.size };
    const CROP = th.crops || [[196, 158, 62], [186, 176, 104], [70, 104, 56], [176, 150, 98], [52, 84, 30]];
    const U = { tAlb: { value: this.layers.albedo }, tNrm: { value: this.layers.normal }, tSplatA: { value: this.splatA }, tSplatB: { value: this.splatB },
      tField: { value: this.fieldTex }, tNoise: { value: noiseTexture() }, uDetail: { value: 1 }, uPlay: { value: new THREE.Vector2(play.min, play.max) },
      uCropMix: { value: th.cropMix ?? 1 }, uSoil: { value: lin(th.ground.field[1]) }, uCrop: { value: CROP.map(lin) }, uCropCov: { value: [0.95, 0.92, 0.4, 0.85, 0.5] } };
    this.cropU = U;
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, U);
      patchFarShadow(sh, this.U);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vTW; varying vec3 vTN;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvTW = (modelMatrix * vec4(transformed, 1.0)).xyz; vTN = normalize(mat3(modelMatrix) * objectNormal);');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\n' + (q.detailNormals ? '#define TERRAIN_DETAIL\n' : ''))
        .replace('#include <map_fragment>', 'terrainShade(); diffuseColor.rgb *= tAlbedo;')
        .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = tRough;')
        .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\nnormal = normalize((viewMatrix * vec4(tNormal, 0.0)).xyz);')
        .replace('#include <aomap_fragment>', 'reflectedLight.indirectDiffuse *= tAO; reflectedLight.indirectSpecular *= tAO;');
      // TERRAIN_FRAG goes right before main()
      sh.fragmentShader = sh.fragmentShader.replace('void main() {', TERRAIN_FRAG + '\nvoid main() {');
    };
    m.customProgramCacheKey = () => 'terrain' + (q.detailNormals ? 1 : 0);
    return m;
  }

  // ---------------------------------------------------------------- meshes
  _meshes(map) {
    const S = map.size, res = map.res, step = (S / (res - 1)) / this.q.terrainStep;
    const NC = 4, per = Math.round((res - 1) * this.q.terrainStep / NC);
    const h = this.h, e = step * 0.5;
    const nrm = (x, z, out, o, hf) => {
      const hx = hf(x + e, z) - hf(x - e, z), hz = hf(x, z + e) - hf(x, z - e);
      const l = Math.hypot(hx, 2 * e, hz); out[o] = -hx / l; out[o + 1] = 2 * e / l; out[o + 2] = -hz / l;
    };
    for (let cj = 0; cj < NC; cj++) for (let ci = 0; ci < NC; ci++) {
      const n = per + 1, edges = [ci === 0, ci === NC - 1, cj === 0, cj === NC - 1];
      const nSk = edges.filter(Boolean).length * n;
      const pos = new Float32Array((n * n + nSk) * 3), nor = new Float32Array((n * n + nSk) * 3);
      const idx = [];
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const x = (ci * per + i) * step, z = (cj * per + j) * step, o = (j * n + i) * 3;
        pos[o] = x; pos[o + 1] = h(x, z); pos[o + 2] = z; nrm(x, z, nor, o, h);
      }
      for (let j = 0; j < per; j++) for (let i = 0; i < per; i++) {
        const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
        // alternate the diagonal to follow the terrain better
        if ((i + j) & 1) idx.push(a, c, b, b, c, d); else idx.push(a, c, d, a, d, b);
      }
      // skirts along the map edge hide seams with the outer ring
      let v = n * n;
      const skirt = (list, flip) => {
        const base = v;
        for (const k of list) { pos[v * 3] = pos[k * 3]; pos[v * 3 + 1] = pos[k * 3 + 1] - 4; pos[v * 3 + 2] = pos[k * 3 + 2]; nor.set(nor.subarray(k * 3, k * 3 + 3), v * 3); v++; }
        for (let t = 0; t < list.length - 1; t++) { const a = list[t], b = list[t + 1], c = base + t, d = base + t + 1; if (flip) idx.push(a, b, c, b, d, c); else idx.push(a, c, b, b, c, d); }
      };
      const rowI = (j) => [...Array(n)].map((_, i) => j * n + i), colI = (i) => [...Array(n)].map((_, j) => j * n + i);
      if (edges[0]) skirt(colI(0), true);
      if (edges[1]) skirt(colI(n - 1), false);
      if (edges[2]) skirt(rowI(0), false);
      if (edges[3]) skirt(rowI(n - 1), true);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      g.setIndex(idx); g.computeBoundingSphere(); g.computeBoundingBox();
      const mesh = new THREE.Mesh(g, this.material);
      mesh.receiveShadow = true; mesh.castShadow = true; mesh.name = 'terrain-chunk';
      this.group.add(mesh);
    }
    // outer ring
    const coords = (inner) => {
      const out = [], L = 7000;
      let p = 0, s = 4;
      const neg = []; while (p > -L) { p -= s; s = Math.min(s * 1.09, 400); neg.push(p); }
      out.push(...neg.reverse());
      for (let k = 0; k <= inner; k++) out.push((k / inner) * S);
      p = S; s = 4; while (p < S + L) { p += s; s = Math.min(s * 1.09, 400); out.push(p); }
      return out;
    };
    const inner = Math.round(64 * this.q.outerTerrain);
    const xs = coords(inner), zs = xs, nx = xs.length, nz = zs.length;
    const pos = new Float32Array(nx * nz * 3), nor = new Float32Array(nx * nz * 3);
    const ho = this.hOut;
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const x = xs[i], z = zs[j], o = (j * nx + i) * 3;
      pos[o] = x; pos[o + 1] = ho(x, z); pos[o + 2] = z;
      const ee = Math.max(2, Math.abs(x - S / 2) * 0.004);
      const hx = ho(x + ee, z) - ho(x - ee, z), hz = ho(x, z + ee) - ho(x, z - ee), l = Math.hypot(hx, 2 * ee, hz);
      nor[o] = -hx / l; nor[o + 1] = 2 * ee / l; nor[o + 2] = -hz / l;
    }
    const idx = [];
    for (let j = 0; j < nz - 1; j++) for (let i = 0; i < nx - 1; i++) {
      const cx = (xs[i] + xs[i + 1]) / 2, cz = (zs[j] + zs[j + 1]) / 2;
      if (cx > 0 && cx < S && cz > 0 && cz < S) continue;
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setIndex(idx); g.computeBoundingSphere();
    const outer = new THREE.Mesh(g, this.material);
    outer.receiveShadow = true; outer.name = 'terrain-outer';
    this.group.add(outer);
  }

  // ---------------------------------------------------------------- grass
  _buildGrass() {
    const gq = this.q.grass, dens = this.theme.grassDensity;
    if (!gq || dens <= 0) return;
    const n = Math.ceil((gq.radius * 2) / gq.spacing);
    // base clump: two crossed cards, 0.8 m wide, 0.55 m tall
    const base = new THREE.BufferGeometry();
    const P = [], UV = [], I = [];
    for (let k = 0; k < 2; k++) {
      const a = k * Math.PI / 2 + 0.3, cx = Math.cos(a) * 0.42, cz = Math.sin(a) * 0.42, o = P.length / 3;
      P.push(-cx, 0, -cz, cx, 0, cz, cx, 1, cz, -cx, 1, -cz);
      UV.push(0, 0, 1, 0, 1, 1, 0, 1);
      I.push(o, o + 1, o + 2, o, o + 2, o + 3);
    }
    base.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    base.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2));
    base.setAttribute('normal', new THREE.Float32BufferAttribute(P.map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
    base.setIndex(I);
    const geo = new THREE.InstancedBufferGeometry().copy(base);
    const cells = [];
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const dx = (i - n / 2) * gq.spacing, dz = (j - n / 2) * gq.spacing;
      if (dx * dx + dz * dz < gq.radius * gq.radius) cells.push(i - n / 2, j - n / 2);
    }
    geo.setAttribute('aCell', new THREE.InstancedBufferAttribute(new Float32Array(cells), 2));
    geo.instanceCount = cells.length / 2;
    const tex = grassAtlas(this.theme.foliage, this.theme.name);
    const m = new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.95 });
    const U = { uOrigin: { value: new THREE.Vector2() }, uSpacing: { value: gq.spacing }, uRadius: { value: gq.radius }, uDensity: { value: dens },
      uHeight: { value: this.heightTex }, uHRes: { value: this.map.res }, uSize: { value: this.map.size }, tSplatA: { value: this.splatA }, tSplatB: { value: this.splatB },
      uTime: { value: 0 }, tNoise: { value: noiseTexture() }, tField: { value: this.fieldTex }, uCropMix: { value: this.theme.cropMix ?? 1 } };
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, U);
      patchFarShadow(sh, this.U);
      sh.vertexShader = sh.vertexShader.replace('#include <common>', `#include <common>
        attribute vec2 aCell; uniform vec2 uOrigin; uniform float uSpacing, uRadius, uDensity, uHRes, uSize, uTime;
        uniform highp sampler2D uHeight; uniform sampler2D tSplatA; uniform sampler2D tSplatB; uniform sampler2D tNoise; uniform sampler2D tField; uniform float uCropMix;
        varying vec3 vShade;
        float gh(vec2 p) {
          vec2 g = clamp(p / uSize, 0.0, 1.0) * (uHRes - 1.0); vec2 i = floor(g); vec2 f = g - i;
          ivec2 a = ivec2(i); ivec2 b = min(a + 1, ivec2(uHRes - 1.0));
          float h00 = texelFetch(uHeight, a, 0).r, h10 = texelFetch(uHeight, ivec2(b.x, a.y), 0).r;
          float h01 = texelFetch(uHeight, ivec2(a.x, b.y), 0).r, h11 = texelFetch(uHeight, b, 0).r;
          return mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
        }
        vec3 ghash(vec2 p) { vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.103, 0.0973)); q += dot(q, q.yxz + 33.33); return fract((q.xxy + q.yzz) * q.zyx); }`)
        .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(0.0, 1.0, 0.0);')
        .replace('#include <begin_vertex>', `
          vec2 cellI = uOrigin + aCell;
          vec3 hh = ghash(cellI);
          vec2 wp = (cellI + hh.xy) * uSpacing;
          float dist = length(wp - cameraPosition.xz);
          vec2 uvm = wp / uSize;
          vec4 SA = texture2D(tSplatA, uvm), SB = texture2D(tSplatB, uvm);
          float patchN = texture2D(tNoise, wp / 23.0).g;
          float dens = smoothstep(0.55, 0.9, SA.r) * (1.0 - SB.r) * smoothstep(0.25, 0.6, patchN + 0.2) * uDensity;
          // cereal stalks on wheat / barley / stubble fields
          vec4 FC = texture2D(tField, uvm);
          int crop = int(FC.b * 4.0 + 0.5);
          float cropH = crop == 0 ? 1.55 : crop == 1 ? 1.25 : crop == 3 ? 0.4 : 0.0;
          float onField = smoothstep(0.6, 0.9, SB.b) * step(0.1, cropH) * uCropMix;
          dens = max(dens, onField);
          float inMap = step(0.0, wp.x) * step(0.0, wp.y) * step(wp.x, uSize) * step(wp.y, uSize);
          float keep = step(hh.z, dens) * inMap;
          float fade = 1.0 - smoothstep(uRadius * 0.55, uRadius * 0.98, dist);
          float sc = keep * fade * (0.65 + 0.7 * fract(hh.z * 13.7));
          float ang = hh.x * 6.2831;
          vec3 transformed = position;
          transformed.xz = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * transformed.xz * (0.8 + 0.5 * hh.y);
          float tall = texture2D(tNoise, wp / 9.0 + 0.3).b;
          transformed.y *= sc * mix(0.22 + 0.5 * patchN * patchN + 0.25 * tall, cropH * (0.8 + 0.2 * tall), onField);
          transformed.xz *= 0.75;
          transformed.xz *= step(0.001, sc);
          float sway = sin(uTime * 1.9 + wp.x * 0.35 + wp.y * 0.21) + 0.4 * sin(uTime * 4.3 + wp.x * 1.3);
          transformed.xz += position.y * vec2(0.07, 0.04) * sway * sc;
          transformed += vec3(wp.x, gh(wp) - 0.03, wp.y);
          float m1 = texture2D(tNoise, mat2(0.87, 0.5, -0.5, 0.87) * wp / 520.0).r, m2 = texture2D(tNoise, mat2(0.6, -0.8, 0.8, 0.6) * wp / 190.0 + 0.5).g;
          vShade = vec3(0.8 + 0.4 * m1) * mix(vec3(1.0), vec3(1.16, 1.08, 0.72), smoothstep(0.42, 0.78, m2) * 0.7) * (0.9 + 0.2 * position.y);
          vMapUv = vec2((uv.x + (onField > 0.5 ? 2.0 : step(0.93, fract(hh.y * 7.1)))) / 3.0, uv.y);
          if (onField > 0.5) vShade = (crop == 1 ? vec3(1.05, 1.05, 0.85) : crop == 3 ? vec3(1.1, 1.0, 0.85) : vec3(1.0)) * (0.85 + 0.3 * fract(hh.z * 31.0));`)
        .replace('#include <uv_vertex>', '');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vShade;')
        .replace('#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin.replace('normal *= faceDirection;', ''))
        .replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.rgb *= vShade;');
      // vUv isn't declared for a plain map material in all builds: declare what we use
    };
    m.customProgramCacheKey = () => 'grass';
    const mesh = new THREE.Mesh(geo, m);
    mesh.frustumCulled = false; mesh.receiveShadow = true; mesh.name = 'grass';
    this.scene.add(mesh);
    this.grass = { mesh, U, spacing: gq.spacing };
  }

  update(camera, dt, U) {
    if (this.grass) {
      const s = this.grass.spacing, u = this.grass.U;
      u.uOrigin.value.set(Math.round(camera.position.x / s), Math.round(camera.position.z / s));
      u.uTime.value += dt;
    }
  }
}
