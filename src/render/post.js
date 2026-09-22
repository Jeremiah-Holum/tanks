// Post stack: scene (HDR, MSAA, depth) → miniature depth-of-field (two separable passes that
// blur anything off the play board, plus a light tilt band) → bloom → grade/tonemap/vignette/grain.
import * as THREE from 'three';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

const COC_FRAG = /* glsl */`
  uniform sampler2D tDepth; uniform mat4 projInv; uniform mat4 viewInv;
  uniform vec2 boardHalf; uniform float tiltStrength; uniform float mode; uniform float focus;
  varying vec2 vUv;
  void main() {
    float d = texture2D(tDepth, vUv).x;
    vec4 v = projInv * vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0); v /= v.w;
    if (mode > 0.5) {
      // Chase cam: a macro lens riding behind the turret. Shallow field: the fight a few
      // cells ahead is sharp, the far board softens, the bedroom melts away.
      float dist = -v.z;
      float far = smoothstep(focus * 2.2, focus * 6.0, dist);
      float nearB = smoothstep(0.9, 0.3, dist);
      gl_FragColor = vec4(max(far, nearB), 0.0, 0.0, 1.0);
      return;
    }
    vec3 w = (viewInv * v).xyz;
    // The play board is in focus; anything off it, or tall above it, falls out of focus
    // the way it would under a macro lens. A light tilt band finishes the miniature look.
    float off = max(abs(w.x) - boardHalf.x, abs(w.z) - boardHalf.y);
    float c = clamp(off / 3.5, 0.0, 1.0);
    c = max(c, clamp((w.y - 1.4) / 3.0, 0.0, 1.0));
    float t = abs(vUv.y - 0.5) * 2.0;
    c = max(c, smoothstep(0.72, 1.0, t) * tiltStrength);
    gl_FragColor = vec4(c, 0.0, 0.0, 1.0);
  }
`;

const DOF_FRAG = /* glsl */`
  uniform sampler2D tColor; uniform sampler2D tCoc;
  uniform vec2 dir; uniform vec2 texel; uniform float maxRadius;
  varying vec2 vUv;
  void main() {
    float c0 = texture2D(tCoc, vUv).r;
    vec3 base = texture2D(tColor, vUv).rgb;
    if (c0 < 0.01) { gl_FragColor = vec4(base, 1.0); return; }
    vec4 acc = vec4(base, 1.0);
    float r = c0 * maxRadius;
    for (int i = 1; i <= 8; i++) {
      float o = float(i) / 8.0 * r;
      float w = exp(-float(i*i) / 24.0);
      for (int s = -1; s <= 1; s += 2) {
        vec2 uv = vUv + dir * texel * o * float(s);
        // Sharp pixels do not bleed into the blur, so the board edge stays crisp.
        float ww = w * clamp(texture2D(tCoc, uv).r * 1.5, 0.0, 1.0);
        acc += vec4(texture2D(tColor, uv).rgb * ww, ww);
      }
    }
    gl_FragColor = vec4(acc.rgb / acc.a, 1.0);
  }
`;

const FINAL_FRAG = /* glsl */`
  uniform sampler2D tColor; uniform float time; uniform float exposure; uniform float vignette;
  uniform float grain; uniform float aberration; uniform float flash; uniform vec2 texel;
  varying vec2 vUv;
  vec3 ACESFilm(vec3 x) {
    // Narkowicz fit, with a gentle toe for toy colours.
    return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14), 0.0, 1.0);
  }
  vec3 toSRGB(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0/2.4)) - 0.055, step(0.0031308, c)); }
  float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233)) + time * 7.13) * 43758.5453); }
  void main() {
    vec2 cc = vUv - 0.5;
    vec2 ab = cc * aberration * texel * 2.0;
    vec3 col;
    col.r = texture2D(tColor, vUv + ab).r;
    col.g = texture2D(tColor, vUv).g;
    col.b = texture2D(tColor, vUv - ab).b;
    col *= exposure;
    col += flash * vec3(1.0, 0.85, 0.6);
    col = ACESFilm(col);
    // warm grade: lift shadows toward amber, keep highlights clean
    col = mix(col, col * vec3(1.04, 1.0, 0.94) + vec3(0.012, 0.006, 0.0), 0.8);
    float l = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(vec3(l), col, 1.08);
    float v = smoothstep(0.95, 0.25, length(cc * vec2(1.1, 1.0)));
    col *= mix(1.0, v, vignette);
    col = toSRGB(col);
    col += (hash(vUv * 1000.0) - 0.5) * grain;
    gl_FragColor = vec4(col, 1.0);
  }
`;

const VERT = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

export class Post {
  constructor(renderer, quality) {
    this.renderer = renderer;
    this.quality = quality;
    this.size = new THREE.Vector2(1, 1);
    this.depth = new THREE.DepthTexture(1, 1);
    this.depth.type = THREE.UnsignedIntType;
    this.sceneRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: quality.msaa, depthTexture: this.depth });
    this.rtA = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
    this.rtB = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
    this.cocRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
    this.cocMat = new THREE.ShaderMaterial({
      uniforms: {
        tDepth: { value: this.depth }, projInv: { value: new THREE.Matrix4() }, viewInv: { value: new THREE.Matrix4() },
        boardHalf: { value: new THREE.Vector2(11.9, 8.6) }, tiltStrength: { value: 0.55 }, mode: { value: 0 }, focus: { value: 5 },
      },
      vertexShader: VERT, fragmentShader: COC_FRAG, depthTest: false, depthWrite: false,
    });
    this.dofMat = new THREE.ShaderMaterial({
      uniforms: {
        tColor: { value: null }, tCoc: { value: this.cocRT.texture }, dir: { value: new THREE.Vector2(1, 0) },
        texel: { value: new THREE.Vector2() }, maxRadius: { value: 7 },
      },
      vertexShader: VERT, fragmentShader: DOF_FRAG, depthTest: false, depthWrite: false,
    });
    this.finalMat = new THREE.ShaderMaterial({
      uniforms: {
        tColor: { value: null }, time: { value: 0 }, exposure: { value: 0.88 }, vignette: { value: 0.55 },
        grain: { value: 0.022 }, aberration: { value: 1.2 }, flash: { value: 0 }, texel: { value: new THREE.Vector2() },
      },
      vertexShader: VERT, fragmentShader: FINAL_FRAG, depthTest: false, depthWrite: false,
    });
    this.quad = new FullScreenQuad(this.dofMat);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.34, 0.5, 1.45); // only real highlights bloom (flashes, fire, the window)
  }

  setSize(w, h) {
    this.size.set(w, h);
    for (const rt of [this.sceneRT, this.rtA, this.rtB, this.cocRT]) rt.setSize(w, h);
    this.bloom.setSize(w, h);
    this.dofMat.uniforms.texel.value.set(1 / w, 1 / h);
    this.finalMat.uniforms.texel.value.set(1 / w, 1 / h);
    this.dofMat.uniforms.maxRadius.value = 7 * Math.max(0.6, h / 1080) * (this.quality.dof ? 1 : 0);
  }

  render(scene, camera, time) {
    const r = this.renderer;
    r.setRenderTarget(this.sceneRT);
    r.render(scene, camera);
    let src = this.sceneRT;
    if (this.quality.dof) {
      const cu = this.cocMat.uniforms;
      cu.projInv.value.copy(camera.projectionMatrixInverse);
      cu.viewInv.value.copy(camera.matrixWorld);
      this.quad.material = this.cocMat;
      r.setRenderTarget(this.cocRT); this.quad.render(r);
      const u = this.dofMat.uniforms;
      this.quad.material = this.dofMat;
      u.tColor.value = this.sceneRT.texture; u.dir.value.set(1, 0);
      r.setRenderTarget(this.rtA); this.quad.render(r);
      u.tColor.value = this.rtA.texture; u.dir.value.set(0, 1);
      r.setRenderTarget(this.rtB); this.quad.render(r);
      src = this.rtB;
    }
    if (this.quality.bloom) this.bloom.render(r, null, src, 0, false);
    this.finalMat.uniforms.tColor.value = src.texture;
    this.finalMat.uniforms.time.value = time % 100;
    this.quad.material = this.finalMat;
    r.setRenderTarget(null);
    this.quad.render(r);
  }
}
