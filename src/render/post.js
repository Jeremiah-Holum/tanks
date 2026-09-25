// Post stack: scene → HDR target (half float, float depth) → [SSAO from depth, high] → [bloom,
// medium/high] → composite (aerial-perspective height fog reconstructed from depth, AO,
// exposure, ACES tone map, grade, vignette, sniper-mode aberration) → FXAA or SMAA → screen.
import * as THREE from 'three';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js';
import { SKY_GLSL } from './env.js';

const VERT = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const AO_FRAG = /* glsl */`
uniform highp sampler2D tDepth; uniform mat4 projInv; uniform mat4 proj; uniform vec2 texel; uniform float radius;
varying vec2 vUv;
vec3 viewPos(vec2 uv) { float d = texture2D(tDepth, uv).x; vec4 v = projInv * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0); return v.xyz / v.w; }
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
void main() {
  float d = texture2D(tDepth, vUv).x;
  if (d >= 1.0) { gl_FragColor = vec4(1.0); return; }
  vec3 P = viewPos(vUv);
  vec3 N = normalize(cross(dFdx(P), dFdy(P)));
  float occ = 0.0; float a0 = ign(gl_FragCoord.xy) * 6.2831;
  float r = radius;
  for (int i = 0; i < 10; i++) {
    float fi = float(i) + 0.5;
    float a = a0 + fi * 2.39996, rr = sqrt(fi / 10.0) * r;
    vec3 dir = vec3(cos(a), sin(a), 0.0);
    vec3 S = P + (dir * rr);
    vec4 c = proj * vec4(S, 1.0); vec2 suv = c.xy / c.w * 0.5 + 0.5;
    vec3 Q = viewPos(suv);
    vec3 v = Q - P; float l = length(v);
    float o = max(dot(N, v / max(l, 1e-3)) - 0.1, 0.0) * smoothstep(r * 2.5, 0.0, l);
    occ += o;
  }
  float ao = clamp(1.0 - occ / 10.0 * 1.6, 0.0, 1.0);
  gl_FragColor = vec4(ao, ao, ao, 1.0);
}`;

const COMP_FRAG = SKY_GLSL + /* glsl */`
uniform sampler2D tColor; uniform highp sampler2D tDepth; uniform sampler2D tAO;
uniform mat4 projInv; uniform mat4 viewInv; uniform vec3 camPos; uniform vec2 texel;
uniform float exposure; uniform float vignette; uniform float sniper; uniform float aoOn; uniform float fogBase;
varying vec2 vUv;
vec3 aces(vec3 x) { // Hill's ACES fit (same as three's ACESFilmic)
  const mat3 m1 = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
  const mat3 m2 = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
  vec3 v = m1 * x; vec3 a = v * (v + 0.0245786) - 0.000090537; vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return clamp(m2 * (a / b), 0.0, 1.0);
}
vec3 toSRGB(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
void main() {
  vec2 cc = vUv - 0.5;
  vec3 col;
  if (sniper > 0.5) {
    vec2 ab = cc * dot(cc, cc) * 0.012;
    col = vec3(texture2D(tColor, vUv + ab).r, texture2D(tColor, vUv).g, texture2D(tColor, vUv - ab).b);
  } else col = texture2D(tColor, vUv).rgb;
  float d = texture2D(tDepth, vUv).x;
  if (d < 1.0) {
    vec4 v = projInv * vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0); v /= v.w;
    vec3 wp = (viewInv * v).xyz;
    vec3 rd = wp - camPos; float dist = length(rd); rd /= dist;
    if (aoOn > 0.5) {
      float ao = 0.0;
      ao += texture2D(tAO, vUv + vec2(texel.x, texel.y)).r; ao += texture2D(tAO, vUv + vec2(-texel.x, texel.y)).r;
      ao += texture2D(tAO, vUv + vec2(texel.x, -texel.y)).r; ao += texture2D(tAO, vUv + vec2(-texel.x, -texel.y)).r;
      col *= mix(1.0, ao * 0.25, 0.8 * (1.0 - smoothstep(60.0, 180.0, dist)));
    }
    // exponential height fog, integrated along the ray (falloff 1/140 m above fogBase)
    float b = 1.0 / 140.0, h0 = camPos.y - fogBase, h1 = wp.y - fogBase, dh = h1 - h0;
    float hf = abs(dh) > 0.1 ? (exp(-b * max(h0, -60.0)) - exp(-b * max(h1, -60.0))) / (b * dh) : exp(-b * max(h0, -60.0));
    // thinner at combat range (≤ 445 m stays readable), full haze toward the horizon
    float amt = 1.0 - exp(-uFogDensity * dist * hf * (0.55 + 0.45 * smoothstep(250.0, 1600.0, dist)));
    vec3 fogCol = skyBase(normalize(vec3(rd.x, max(rd.y, 0.0) * 0.6 + 0.01, rd.z)));
    col = mix(col, fogCol, clamp(amt, 0.0, 1.0));
  }
  col *= exposure;
  col = aces(col);
  // gentle warm grade and a touch of saturation
  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(l), col, 1.08);
  col *= vec3(1.02, 1.0, 0.97);
  float vg = smoothstep(0.95, 0.3, length(cc * vec2(1.25, 1.0)));
  col *= mix(1.0, vg, vignette + sniper * 0.35);
  gl_FragColor = vec4(toSRGB(clamp(col, 0.0, 1.0)), 1.0);
}`;

export class Post {
  constructor(renderer, quality, skyU) {
    this.renderer = renderer; this.q = quality;
    const depth = new THREE.DepthTexture(1, 1, THREE.FloatType);
    this.sceneRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthTexture: depth, samples: 0 });
    this.aoRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.UnsignedByteType, depthBuffer: false });
    this.ldrRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.UnsignedByteType, depthBuffer: false });
    this.aoMat = new THREE.ShaderMaterial({
      uniforms: { tDepth: { value: depth }, projInv: { value: new THREE.Matrix4() }, proj: { value: new THREE.Matrix4() }, texel: { value: new THREE.Vector2() }, radius: { value: 1.2 } },
      vertexShader: VERT, fragmentShader: AO_FRAG, depthTest: false, depthWrite: false,
    });
    this.compMat = new THREE.ShaderMaterial({
      uniforms: { ...skyU, tColor: { value: null }, tDepth: { value: depth }, tAO: { value: this.aoRT.texture },
        projInv: { value: new THREE.Matrix4() }, viewInv: { value: new THREE.Matrix4() }, camPos: { value: new THREE.Vector3() }, texel: { value: new THREE.Vector2() },
        exposure: { value: 1 }, vignette: { value: 0.28 }, sniper: { value: 0 }, aoOn: { value: 0 }, fogBase: { value: 0 } },
      vertexShader: VERT, fragmentShader: COMP_FRAG, depthTest: false, depthWrite: false,
    });
    this.fxaaMat = new THREE.ShaderMaterial({ ...FXAAShader, uniforms: THREE.UniformsUtils.clone(FXAAShader.uniforms), depthTest: false, depthWrite: false });
    this.quad = new FullScreenQuad(this.compMat);
    this.bloom = null; this.smaa = null;
    this.setQuality(quality);
  }

  setQuality(q) {
    this.q = q;
    if (q.bloom && !this.bloom) { this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.28, 0.55, 1.6); if (this.w) this.bloom.setSize(this.w, this.h); }
    if (q.aa === 'smaa' && !this.smaa) { this.smaa = new SMAAPass(); this.smaa.renderToScreen = true; if (this.w) this.smaa.setSize(this.w, this.h); }
    this.compMat.uniforms.aoOn.value = q.ao ? 1 : 0;
  }

  setSize(w, h) {
    this.w = w; this.h = h;
    this.sceneRT.setSize(w, h); this.ldrRT.setSize(w, h);
    this.aoRT.setSize(Math.max(1, w >> 1), Math.max(1, h >> 1));
    if (this.bloom) this.bloom.setSize(w, h);
    if (this.smaa) this.smaa.setSize(w, h);
    this.compMat.uniforms.texel.value.set(2 / w, 2 / h);
    this.aoMat.uniforms.texel.value.set(2 / w, 2 / h);
    this.fxaaMat.uniforms.resolution.value.set(1 / w, 1 / h);
  }

  render(scene, camera, { sniper = false, exposure = 1, fogBase = 0 } = {}) {
    const r = this.renderer, q = this.q;
    r.setRenderTarget(this.sceneRT);
    r.render(scene, camera);
    if (q.ao) {
      const u = this.aoMat.uniforms;
      u.projInv.value.copy(camera.projectionMatrixInverse); u.proj.value.copy(camera.projectionMatrix);
      this.quad.material = this.aoMat; r.setRenderTarget(this.aoRT); this.quad.render(r);
    }
    if (q.bloom && this.bloom) this.bloom.render(r, null, this.sceneRT, 0, false);
    const u = this.compMat.uniforms;
    u.tColor.value = this.sceneRT.texture;
    u.projInv.value.copy(camera.projectionMatrixInverse); u.viewInv.value.copy(camera.matrixWorld); u.camPos.value.copy(camera.position);
    u.sniper.value = sniper ? 1 : 0; u.exposure.value = exposure; u.fogBase.value = fogBase;
    this.quad.material = this.compMat;
    r.setRenderTarget(this.ldrRT); this.quad.render(r);
    if (q.aa === 'smaa' && this.smaa) { this.smaa.render(r, null, this.ldrRT); }
    else if (q.aa === 'fxaa') { this.fxaaMat.uniforms.tDiffuse.value = this.ldrRT.texture; this.quad.material = this.fxaaMat; r.setRenderTarget(null); this.quad.render(r); }
    else { this.fxaaMat.uniforms.tDiffuse.value = this.ldrRT.texture; this.quad.material = this.fxaaMat; r.setRenderTarget(null); this.quad.render(r); }
  }

  dispose() {
    for (const t of [this.sceneRT, this.aoRT, this.ldrRT]) t.dispose();
    if (this.bloom) this.bloom.dispose(); if (this.smaa) this.smaa.dispose();
  }
}
