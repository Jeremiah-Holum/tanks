// Every surface is generated here at startup: no binary assets. The terrain layers are computed
// per pixel in JS (tileable noise) into texture arrays; foliage cards, bark and the building
// atlas are painted on 2D canvases. Results are cached per palette.
import * as THREE from 'three';

const mk = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return [c, c.getContext('2d')]; };
const cache = new Map();
const once = (k, f) => { if (!cache.has(k)) cache.set(k, f()); return cache.get(k); };

// ------------------------------------------------------------------ tileable noise
function hash3(x, y, s) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 982451653)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
export function tileNoise(seed = 1) {
  // value noise on a lattice of period P (so a [0,1) texture wraps seamlessly)
  const vn = (x, y, P) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    let fx = x - xi, fy = y - yi;
    const x0 = ((xi % P) + P) % P, y0 = ((yi % P) + P) % P, x1 = (x0 + 1) % P, y1 = (y0 + 1) % P;
    fx = fx * fx * fx * (fx * (fx * 6 - 15) + 10); fy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
    const a = hash3(x0, y0, seed), b = hash3(x1, y0, seed), c = hash3(x0, y1, seed), d = hash3(x1, y1, seed);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };
  const fbm = (u, v, P, oct = 4, gain = 0.5) => {
    let s = 0, a = 1, n = 0;
    for (let o = 0; o < oct; o++) { s += a * vn(u * P + o * 7, v * P + o * 3, P); n += a; a *= gain; P *= 2; }
    return s / n;
  };
  // Worley: F1, F2 and the cell hash of the nearest feature point (period P cells)
  const out = { f1: 0, f2: 0, id: 0 };
  const worley = (u, v, P) => {
    const x = u * P, y = v * P, xi = Math.floor(x), yi = Math.floor(y);
    let f1 = 9, f2 = 9, id = 0;
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
      const cx = ((xi + i) % P + P) % P, cy = ((yi + j) % P + P) % P;
      const px = xi + i + hash3(cx, cy, seed + 11), py = yi + j + hash3(cx, cy, seed + 23);
      const d = Math.hypot(px - x, py - y);
      if (d < f1) { f2 = f1; f1 = d; id = hash3(cx, cy, seed + 37); } else if (d < f2) f2 = d;
    }
    out.f1 = f1; out.f2 = f2; out.id = id; return out;
  };
  // tileable gradient noise (Perlin) in [0,1]: no axis-aligned blockiness
  const gn = (x, y, P) => {
    const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi;
    const g = (i, j, dx, dy) => { const a = hash3(((i % P) + P) % P, ((j % P) + P) % P, seed + 5) * Math.PI * 2; return Math.cos(a) * dx + Math.sin(a) * dy; };
    const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10), v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
    const a = g(xi, yi, fx, fy), b = g(xi + 1, yi, fx - 1, fy), c = g(xi, yi + 1, fx, fy - 1), d = g(xi + 1, yi + 1, fx - 1, fy - 1);
    return 0.5 + 0.75 * (a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v);
  };
  const gfbm = (u, v, P, oct = 4, gain = 0.5) => {
    let s = 0, a = 1, n = 0;
    for (let o = 0; o < oct; o++) { s += a * gn(u * P + o * 7, v * P + o * 3, P); n += a; a *= gain; P *= 2; }
    return s / n;
  };
  return { vn, fbm, worley, gn, gfbm };
}
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const sstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;
const mix3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

// ------------------------------------------------------------------ terrain layers
// Layer order matches the splat channels (terrain.js): GRASS DIRT ROAD SAND ROCK MUD FIELD SNOW.
export const LAYERS = ['grass', 'dirt', 'road', 'sand', 'rock', 'mud', 'field', 'snow'];
export const LAYER_SIZE = 512;

// pal: theme palette (env.js THEMES[..].ground) with sRGB 0..255 triples
function layerPixel(k, u, v, N, pal, rgb) {
  let c, h;
  switch (LAYERS[k]) {
    case 'grass': {
      const big = N.fbm(u, v, 3, 4), mid = N.fbm(u, v, 12, 3), fine = N.vn(u * 160, v * 160, 160), fine2 = N.vn(u * 90 + 5, v * 90, 90);
      c = mix3(pal.grass[0], pal.grass[1], sstep(0.3, 0.75, big));
      c = mix3(c, pal.grass[2], sstep(0.58, 0.8, mid) * 0.8);            // dry patches
      const w = N.worley(u, v, 40);
      const clover = sstep(0.45, 0.2, w.f1) * (w.id > 0.7 ? 1 : 0);
      c = mix3(c, pal.grass[3], clover * 0.5);
      const bl = 0.72 + 0.56 * fine * (0.7 + 0.3 * fine2);
      c = [c[0] * bl, c[1] * bl, c[2] * bl];
      if (hash3((u * 512) | 0, (v * 512) | 0, 91) > 0.985) c = mix3(c, pal.grass[4], 0.6);
      const soil = sstep(0.28, 0.18, N.fbm(u, v, 20, 3));
      c = mix3(c, pal.dirt[0], soil * 0.55);
      h = 0.45 * fine + 0.35 * mid + 0.2 * (1 - soil);
      break;
    }
    case 'dirt': {
      const big = N.fbm(u, v, 4, 4), fine = N.fbm(u, v, 64, 2);
      c = mix3(pal.dirt[0], pal.dirt[1], sstep(0.3, 0.7, big));
      const w = N.worley(u, v, 22);
      const peb = sstep(0.32, 0.18, w.f1);
      c = mix3(c, mix3(pal.dirt[2], pal.dirt[1], w.id), peb * (w.id > 0.35 ? 1 : 0.3));
      const t = sstep(0.62, 0.8, N.fbm(u + 0.3, v, 6, 3));
      c = mix3(c, pal.grass[0], t * 0.6);
      const s = 0.85 + 0.3 * fine; c = [c[0] * s, c[1] * s, c[2] * s];
      h = 0.4 * fine + 0.5 * peb * (w.id > 0.35 ? 1 : 0.3) + 0.2 * big;
      break;
    }
    case 'road': {
      const big = N.fbm(u, v, 3, 4), fine = N.fbm(u, v, 96, 2);
      c = mix3(pal.road[0], pal.road[1], sstep(0.3, 0.75, big));
      const w = N.worley(u, v, 64);
      const g = sstep(0.4, 0.2, w.f1);
      c = mix3(c, mix3(pal.road[2], pal.road[0], w.id), g * 0.7);
      const s = 0.86 + 0.28 * fine; c = [c[0] * s, c[1] * s, c[2] * s];
      h = 0.5 * g + 0.3 * fine + 0.2 * big;
      break;
    }
    case 'sand': {
      const big = N.fbm(u, v, 3, 4), fine = N.vn(u * 256, v * 256, 256);
      const rip = 0.5 + 0.5 * Math.sin((v * 14 + N.fbm(u, v, 4, 3) * 1.6) * Math.PI * 2);
      c = mix3(pal.sand[0], pal.sand[1], sstep(0.3, 0.75, big));
      const s = 0.9 + 0.12 * rip + 0.12 * fine; c = [c[0] * s, c[1] * s, c[2] * s];
      h = 0.6 * rip + 0.2 * fine + 0.2 * big;
      break;
    }
    case 'rock': {
      const big = N.fbm(u, v, 2, 5), mid = N.fbm(u, v, 8, 4);
      const strata = 0.5 + 0.5 * Math.sin((v * 6 + big * 2.2) * Math.PI * 2);
      c = mix3(pal.rock[0], pal.rock[1], sstep(0.25, 0.8, big * 0.6 + strata * 0.4));
      const w = N.worley(u, v, 6);
      const crack = sstep(0.07, 0.0, w.f2 - w.f1);
      const lich = sstep(0.62, 0.72, N.fbm(u + 0.5, v, 10, 3));
      c = mix3(c, pal.rock[2], lich * 0.7);
      const s = (0.8 + 0.35 * mid) * (1 - crack * 0.6); c = [c[0] * s, c[1] * s, c[2] * s];
      h = 0.5 * big + 0.3 * mid + 0.2 * strata - crack * 0.5;
      break;
    }
    case 'mud': {
      const big = N.fbm(u, v, 3, 4), fine = N.fbm(u, v, 48, 2);
      const wet = sstep(0.42, 0.3, big);
      c = mix3(pal.mud[0], pal.mud[1], wet);
      const tr = Math.abs(Math.sin((u * 3 + big * 0.4) * Math.PI * 2)); // churned tread grooves
      const s = 0.85 + 0.25 * fine * (1 - wet) + 0.08 * tr; c = [c[0] * s, c[1] * s, c[2] * s];
      h = (1 - wet) * (0.5 + 0.4 * fine) + 0.1 * tr;
      break;
    }
    case 'field': {
      const rows = 16;
      const warp = N.fbm(u, v, 4, 2) * 0.05;
      const r = 0.5 + 0.5 * Math.cos((u + warp) * rows * Math.PI * 2);       // 1 on the ridge
      const big = N.fbm(u, v, 3, 4), fine = N.vn(u * 200, v * 200, 200), fine2 = N.vn(u * 64, v * 128, 64);
      const soil = mix3(pal.field[0], pal.field[1], big);
      const crop = mix3(pal.field[2], pal.field[3], sstep(0.3, 0.7, N.fbm(u, v, 6, 3)));
      const m = sstep(0.35, 0.75, r * (0.7 + 0.5 * fine2) * pal.fieldCover + (pal.fieldCover - 0.5) * 0.4);
      c = mix3(soil, crop, m);
      const s = 0.8 + 0.4 * fine; c = [c[0] * s, c[1] * s, c[2] * s];
      h = r * 0.8 + fine * 0.2;
      break;
    }
    default: { // snow
      const big = N.fbm(u, v, 3, 4), fine = N.fbm(u, v, 64, 2);
      c = mix3(pal.snow[1], pal.snow[0], sstep(0.25, 0.75, big));
      const s = 0.95 + 0.05 * fine; c = [c[0] * s, c[1] * s, c[2] * s];
      h = 0.7 * big + 0.3 * fine;
    }
  }
  rgb[0] = c[0]; rgb[1] = c[1]; rgb[2] = c[2];
  return clamp01(h);
}

const NORMAL_STRENGTH = [1.2, 2.0, 1.6, 1.0, 4.0, 1.2, 2.6, 0.8];

// → { albedo: DataArrayTexture (rgb sRGB, a = height), normal: DataArrayTexture (rg = normal xy),
//     avg: [[r,g,b] linear 0..1 per layer] }
export function terrainLayers(pal, key = 'default') {
  return once('terrain:' + key, () => {
    const S = LAYER_SIZE, L = LAYERS.length;
    const alb = new Uint8Array(S * S * 4 * L), nrm = new Uint8Array(S * S * 4 * L);
    const H = new Float32Array(S * S), rgb = [0, 0, 0], avg = [];
    for (let k = 0; k < L; k++) {
      const N = tileNoise(101 + k * 17);
      let ar = 0, ag = 0, ab = 0;
      const base = k * S * S * 4;
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        const h = layerPixel(k, x / S, y / S, N, pal, rgb);
        const o = base + (y * S + x) * 4;
        alb[o] = Math.min(255, rgb[0]); alb[o + 1] = Math.min(255, rgb[1]); alb[o + 2] = Math.min(255, rgb[2]); alb[o + 3] = h * 255;
        H[y * S + x] = h;
        ar += rgb[0]; ag += rgb[1]; ab += rgb[2];
      }
      const n = S * S, lin = (c) => Math.pow(c / n / 255, 2.2);
      avg.push([lin(ar), lin(ag), lin(ab)]);
      const st = NORMAL_STRENGTH[k] * 2.0;
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        const hx = H[y * S + ((x + 1) % S)] - H[y * S + ((x - 1 + S) % S)];
        const hy = H[((y + 1) % S) * S + x] - H[((y - 1 + S) % S) * S + x];
        let nx = -hx * st, ny = -hy * st; const l = Math.hypot(nx, ny, 1); nx /= l; ny /= l;
        const o = base + (y * S + x) * 4;
        nrm[o] = (nx * 0.5 + 0.5) * 255; nrm[o + 1] = (ny * 0.5 + 0.5) * 255; nrm[o + 2] = 255; nrm[o + 3] = 255;
      }
    }
    const mkArr = (data, srgb) => {
      const t = new THREE.DataArrayTexture(data, S, S, L);
      t.format = THREE.RGBAFormat; t.type = THREE.UnsignedByteType;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
      t.generateMipmaps = true; t.anisotropy = 8;
      if (srgb) t.colorSpace = THREE.SRGBColorSpace;
      t.needsUpdate = true; return t;
    };
    return { albedo: mkArr(alb, true), normal: mkArr(nrm, false), avg };
  });
}

// Generic tileable RGBA noise (r: fbm low, g: fbm high, b: value noise, a: worley) for macro
// variation, clouds and water.
export function noiseTexture(S = 256) {
  return once('noise' + S, () => {
    const N = tileNoise(7), d = new Uint8Array(S * S * 4);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const u = x / S, v = y / S, o = (y * S + x) * 4;
      d[o] = clamp01(N.gfbm(u, v, 4, 5)) * 255; d[o + 1] = clamp01(N.gfbm(u + 0.37, v + 0.71, 8, 5)) * 255;
      d[o + 2] = clamp01(N.gn(u * 32, v * 32, 32)) * 255; d[o + 3] = clamp01(N.worley(u, v, 8).f1) * 255;
    }
    const t = new THREE.DataTexture(d, S, S, THREE.RGBAFormat);
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true; t.needsUpdate = true; return t;
  });
}

// Tileable water normal map (two octaves of soft ripples).
export function waterNormals(S = 256) {
  return once('waterN', () => {
    const N = tileNoise(33), H = new Float32Array(S * S), d = new Uint8Array(S * S * 4);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) H[y * S + x] = N.fbm(x / S, y / S, 6, 4, 0.55);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const hx = H[y * S + (x + 1) % S] - H[y * S + (x - 1 + S) % S], hy = H[((y + 1) % S) * S + x] - H[((y - 1 + S) % S) * S + x];
      let nx = -hx * 6, ny = -hy * 6; const l = Math.hypot(nx, ny, 1);
      const o = (y * S + x) * 4; d[o] = (nx / l * 0.5 + 0.5) * 255; d[o + 1] = (ny / l * 0.5 + 0.5) * 255; d[o + 2] = (1 / l * 0.5 + 0.5) * 255; d[o + 3] = 255;
    }
    const t = new THREE.DataTexture(d, S, S, THREE.RGBAFormat);
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true; t.needsUpdate = true; return t;
  });
}

// ------------------------------------------------------------------ foliage cards
function canvasTex(c, { srgb = true, repeat = false, aniso = 4, mips = true } = {}) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = aniso;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (!mips) { t.generateMipmaps = false; t.minFilter = THREE.LinearFilter; }
  t.needsUpdate = true; return t;
}
const rgbs = (c, k = 1, a = 1) => `rgba(${Math.min(255, c[0] * k) | 0},${Math.min(255, c[1] * k) | 0},${Math.min(255, c[2] * k) | 0},${a})`;

// Foliage atlas for one palette: 1024x1536 canvas of 512² cells. Row 0: [0] broadleaf cluster,
// [1] small-leaf bush/birch cluster; row 1: [2] conifer needle spray, [3] bare twigs;
// row 2: [4] brown bark, [5] birch bark (vertically tileable). FOL_CELL(k) gives the uv rect.
// Leaves are lit top-left → bottom-right so the cards read as volume. Alpha = coverage.
export function foliageAtlas(pal, key) {
  return once('fol:' + key, () => {
    const S = 1024, C = 512;
    const [c, g] = mk(S, 1536);
    let seed = 777;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
    const pick = (arr) => arr[(rnd() * arr.length) | 0];
    // --- broadleaf / small leaves
    const leaves = (ox, oy, n, len, cols, twig) => {
      g.save(); g.translate(ox + C / 2, oy + C / 2);
      g.strokeStyle = rgbs(twig); g.lineCap = 'round';
      for (let k = 0; k < 9; k++) { // twigs from the centre outwards
        const a = rnd() * 6.28, r = 150 + rnd() * 80;
        g.lineWidth = 5; g.beginPath(); g.moveTo(0, 0);
        g.quadraticCurveTo(Math.cos(a + 0.3) * r * 0.5, Math.sin(a + 0.3) * r * 0.5, Math.cos(a) * r, Math.sin(a) * r); g.stroke();
      }
      for (let k = 0; k < n; k++) {
        // radius biased to fill the middle; silhouette ragged at the rim
        const a = rnd() * 6.28, r = Math.pow(rnd(), 0.62) * 225;
        const x = Math.cos(a) * r, y = Math.sin(a) * r;
        const light = 0.62 + 0.55 * clamp01(0.5 - (x + y) / 520 + (rnd() - 0.5) * 0.35) - (r / 225) * 0.05;
        const col = pick(cols);
        g.save(); g.translate(x, y); g.rotate(a + (rnd() - 0.5) * 1.6);
        const L = len * (0.7 + rnd() * 0.6);
        g.fillStyle = rgbs(col, light);
        g.beginPath(); g.moveTo(0, 0); g.quadraticCurveTo(L * 0.5, -L * 0.36, L, 0); g.quadraticCurveTo(L * 0.5, L * 0.36, 0, 0); g.fill();
        g.strokeStyle = rgbs(col, light * 0.72, 0.8); g.lineWidth = 1; g.beginPath(); g.moveTo(L * 0.1, 0); g.lineTo(L * 0.85, 0); g.stroke();
        g.restore();
      }
      g.restore();
    };
    leaves(0, 0, 520, 34, pal.leaf, pal.twig);
    leaves(C, 0, 900, 22, pal.leaf2, pal.twig);
    // --- conifer spray: a drooping branch with needle tufts, pointing +x
    g.save(); g.translate(0, C);
    for (let b = 0; b < 3; b++) {
      const y0 = 150 + b * 110, droop = 40 + rnd() * 30;
      const P = (t) => [30 + t * 450, y0 + droop * t * t - 30 * t];
      // a soft dark body under the needles gives the spray coverage at every mip level
      g.fillStyle = rgbs(pal.needle[2], 0.55, 0.9);
      g.beginPath();
      for (let t = 0; t <= 1.001; t += 0.05) { const [x, y] = P(t); g.lineTo(x, y - (1 - t * 0.75) * 40); }
      for (let t = 1; t >= -0.001; t -= 0.05) { const [x, y] = P(t); g.lineTo(x, y + (1 - t * 0.75) * 44); }
      g.fill();
      for (let k = 0; k < 900; k++) {
        const t = Math.pow(rnd(), 0.8), [x, y] = P(t), w = (1 - t * 0.7) * 70;
        const a = (rnd() - 0.5) * 2.6 + (rnd() < 0.5 ? 0 : Math.PI);
        const L = 10 + rnd() * w * 0.6;
        const light = 0.7 + 0.5 * clamp01(0.6 - (y - y0) / 120 + (rnd() - 0.5) * 0.4);
        g.strokeStyle = rgbs(pick(pal.needle), light); g.lineWidth = 2.2;
        g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * L * 0.4 + L * 0.3, y + Math.sin(a) * L); g.stroke();
      }
      g.strokeStyle = rgbs(pal.twig, 0.8); g.lineWidth = 4; g.beginPath();
      for (let t = 0; t <= 1; t += 0.05) { const [x, y] = P(t); t === 0 ? g.moveTo(x, y) : g.lineTo(x, y); } g.stroke();
    }
    g.restore();
    // --- bare twigs (winter broadleaf)
    g.save(); g.translate(C + C / 2, C + C / 2);
    const twig = (x, y, a, L, w, d) => {
      const x2 = x + Math.cos(a) * L, y2 = y + Math.sin(a) * L;
      g.strokeStyle = rgbs(pal.twig, 0.7 + 0.3 * rnd()); g.lineWidth = w; g.beginPath(); g.moveTo(x, y); g.lineTo(x2, y2); g.stroke();
      if (d > 0) for (let k = 0; k < 3; k++) twig(x + (x2 - x) * (0.4 + 0.6 * rnd()), y + (y2 - y) * (0.4 + 0.6 * rnd()), a + (rnd() - 0.5) * 1.6, L * 0.6, w * 0.6, d - 1);
    };
    for (let k = 0; k < 7; k++) twig(0, 0, rnd() * 6.28, 110 + rnd() * 60, 5, 3);
    g.restore();
    // bark row
    const N = tileNoise(5), img = g.createImageData(1024, 512);
    for (let y = 0; y < 512; y++) for (let x = 0; x < 1024; x++) {
      const o = (y * 1024 + x) * 4, birch = x >= 512, u = (x % 512) / 512, v = y / 512;
      if (!birch) {
        const f = N.fbm(u, v * 0.25, 8, 4), r = Math.abs(Math.sin((u * 10 + f * 1.5) * Math.PI));
        const k = 0.42 + 0.58 * Math.pow(r, 0.6) * (0.7 + 0.5 * N.vn(u * 64, v * 16, 64));
        img.data[o] = pal.bark[0] * k; img.data[o + 1] = pal.bark[1] * k; img.data[o + 2] = pal.bark[2] * k;
      } else {
        const f = N.fbm(u, v, 6, 3), lent = N.vn(u * 8, v * 64, 8) > 0.74 && N.vn(u * 32, v * 8, 32) > 0.4;
        const k = lent ? 0.22 : 0.8 + 0.2 * f;
        img.data[o] = 228 * k; img.data[o + 1] = 224 * k; img.data[o + 2] = 214 * k;
      }
      img.data[o + 3] = 255;
    }
    g.putImageData(img, 0, 1024);
    const t = canvasTex(c, { aniso: 4 });
    return t;
  });
}

export const FOL_CELL = (k) => { const cx = k % 2, cy = (k / 2) | 0; return [cx * 0.5, 1 - (cy + 1) / 3, 0.5, 1 / 3]; };

// Grass card atlas 512x256: [left] plain grass blades, [right] grass with wild flowers.
export function grassAtlas(pal, key) {
  return once('grass:' + key, () => {
    const W = 512, Hh = 256;
    const [c, g] = mk(W, Hh);
    let seed = 4242;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
    for (let half = 0; half < 2; half++) {
      const ox = half * 256;
      for (let k = 0; k < 70; k++) {
        const x = ox + 12 + rnd() * 232, h = 90 + rnd() * 160, lean = (rnd() - 0.5) * 70, w = 3 + rnd() * 4;
        const col = pal.blade[(rnd() * pal.blade.length) | 0];
        const gr = g.createLinearGradient(0, Hh, 0, Hh - h);
        gr.addColorStop(0, rgbs(col, 0.55)); gr.addColorStop(0.5, rgbs(col, 0.95)); gr.addColorStop(1, rgbs(col, 1.2));
        g.fillStyle = gr; g.beginPath(); g.moveTo(x - w, Hh);
        g.quadraticCurveTo(x - w * 0.5 + lean * 0.3, Hh - h * 0.6, x + lean, Hh - h);
        g.quadraticCurveTo(x + w * 0.5 + lean * 0.3, Hh - h * 0.6, x + w, Hh); g.fill();
      }
      if (half === 1) for (let k = 0; k < 6; k++) {
        const x = ox + 20 + rnd() * 216, y = Hh - 80 - rnd() * 150;
        g.strokeStyle = rgbs(pal.blade[0], 0.7); g.lineWidth = 2; g.beginPath(); g.moveTo(x, Hh); g.lineTo(x + (rnd() - 0.5) * 20, y); g.stroke();
        const fc = pal.flowers[(rnd() * pal.flowers.length) | 0];
        for (let p = 0; p < 5; p++) { g.fillStyle = rgbs(fc, 0.9 + rnd() * 0.2); g.beginPath(); g.arc(x + Math.cos(p * 1.26) * 3.5, y + Math.sin(p * 1.26) * 3.5, 3, 0, 7); g.fill(); }
        g.fillStyle = 'rgb(220,180,40)'; g.beginPath(); g.arc(x, y, 3, 0, 7); g.fill();
      }
    }
    const t = canvasTex(c, { aniso: 4 });
    t.wrapS = THREE.ClampToEdgeWrapping; return t;
  });
}

// Bark atlas 512x512: [left half] rough brown bark, [right half] birch.
export function barkTexture() {
  return once('bark', () => {
    const [c, g] = mk(512, 512);
    const N = tileNoise(5);
    const img = g.createImageData(512, 512);
    for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) {
      const o = (y * 512 + x) * 4, birch = x >= 256, u = (x % 256) / 256, v = y / 512;
      if (!birch) {
        const f = N.fbm(u * 1, v * 0.25, 8, 4), r = Math.abs(Math.sin((u * 10 + f * 1.5) * Math.PI));
        const k = 0.45 + 0.55 * Math.pow(r, 0.6) * (0.7 + 0.5 * N.vn(u * 64, v * 16, 64));
        img.data[o] = 92 * k; img.data[o + 1] = 76 * k; img.data[o + 2] = 60 * k;
      } else {
        const f = N.fbm(u, v, 6, 3), lent = N.vn(u * 8, v * 64, 8) > 0.78 && N.vn(u * 32, v * 8, 32) > 0.4;
        const k = lent ? 0.25 : 0.82 + 0.18 * f;
        img.data[o] = 225 * k; img.data[o + 1] = 222 * k; img.data[o + 2] = 212 * k;
      }
      img.data[o + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    return canvasTex(c, { repeat: true });
  });
}

// ------------------------------------------------------------------ building atlas
// 2048² canvas split in 4×4 cells of 512² (inset by PAD so fract()-tiling doesn't bleed).
// ATLAS[name] = [u0, v0, du, dv] (uv space, v up as three uses it); the tile size in metres
// each cell represents is TILE_M[name] (for world-scaled uvs in props.js).
export const ATLAS_CELLS = ['plaster', 'plaster2', 'brick', 'stone', 'roofTile', 'roofSlate', 'planks', 'timber',
  'window', 'door', 'ashlar', 'rubble', 'straw', 'rust', 'concrete', 'rockface'];
export const TILE_M = { plaster: 4, plaster2: 4, brick: 2, stone: 2.5, roofTile: 2.5, roofSlate: 2.5, planks: 3, timber: 2,
  window: 1, door: 1, ashlar: 3, rubble: 3, straw: 2, rust: 2, concrete: 3, rockface: 3 };
const PAD = 6;
export const ATLAS = {};
ATLAS_CELLS.forEach((n, k) => {
  const cx = k % 4, cy = (k / 4) | 0;
  ATLAS[n] = [(cx * 512 + PAD) / 2048, 1 - ((cy + 1) * 512 - PAD) / 2048, (512 - 2 * PAD) / 2048, (512 - 2 * PAD) / 2048];
});

export function buildingAtlas() {
  return once('atlas', () => {
    const S = 2048, [c, g] = mk(S, S);
    const N = tileNoise(9);
    let seed = 99;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
    // Per-pixel noise fill for the plain materials, then vector detail on top.
    const img = g.createImageData(S, S);
    const cell = (k, f) => {
      const cx = (k % 4) * 512, cy = ((k / 4) | 0) * 512;
      for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) {
        const u = ((x - PAD + 500) % 500) / 500, v = ((y - PAD + 500) % 500) / 500;
        const col = f(u, v), o = ((cy + y) * S + cx + x) * 4;
        img.data[o] = col[0]; img.data[o + 1] = col[1]; img.data[o + 2] = col[2]; img.data[o + 3] = 255;
      }
    };
    const shade = (c0, k) => [c0[0] * k, c0[1] * k, c0[2] * k];
    cell(0, (u, v) => shade([214, 200, 172], 0.82 + 0.2 * N.fbm(u, v, 4, 5) + 0.06 * N.vn(u * 128, v * 128, 128)));
    cell(1, (u, v) => { // weathered lime wash with a few spalled patches showing stone
      const s = N.gfbm(u, v, 3, 5), pat = sstep(0.74, 0.78, N.gfbm(u + 0.2, v, 4, 5));
      const streak = 0.94 + 0.06 * N.vn(u * 40, v * 3, 40);
      return shade(mix3([200, 194, 182], [150, 136, 116], pat * 0.7), (0.82 + 0.2 * s) * streak);
    });
    cell(2, (u, v) => { // brick: 8 courses per tile, 4 bricks per course
      const row = Math.floor(v * 16), off = (row % 2) * 0.125, bu = (u + off) * 4, bi = Math.floor(bu);
      const mortar = (v * 16 % 1) < 0.14 || (bu % 1) < 0.05;
      const id = hash3(bi & 3, row, 5);
      if (mortar) return shade([170, 162, 150], 0.8 + 0.2 * N.vn(u * 64, v * 64, 64));
      return shade(mix3([150, 70, 50], [120, 58, 44], id), 0.82 + 0.25 * N.fbm(u, v, 16, 3));
    });
    cell(3, (u, v) => { // rubble masonry: worley stones with mortar
      const w = N.worley(u, v, 6), m = sstep(0.03, 0.09, w.f2 - w.f1);
      return shade(mix3([160, 156, 146], mix3([128, 122, 112], [150, 140, 120], w.id), m), 0.75 + 0.3 * N.fbm(u, v, 16, 3));
    });
    cell(4, (u, v) => { // clay roof tiles: 10 rows, rounded tiles
      const row = v * 10, rv = row % 1, t = (u * 8 + (Math.floor(row) % 2) * 0.5) % 1;
      const round = Math.sin(t * Math.PI), id = hash3(Math.floor(u * 8 + (Math.floor(row) % 2) * 0.5), Math.floor(row), 3);
      const k = (0.55 + 0.45 * round) * (0.65 + 0.35 * rv) * (0.85 + 0.25 * id) * (0.85 + 0.2 * N.fbm(u, v, 4, 3));
      const moss = sstep(0.6, 0.72, N.fbm(u, v, 3, 4));
      return shade(mix3([168, 78, 50], [110, 104, 70], moss * 0.6), k);
    });
    cell(5, (u, v) => { // slate
      const row = v * 12, rv = row % 1, t = (u * 10 + (Math.floor(row) % 2) * 0.5), id = hash3(Math.floor(t) % 10, Math.floor(row), 4);
      const edge = (t % 1) < 0.06 ? 0.6 : 1;
      return shade([88, 92, 98], (0.55 + 0.45 * rv) * edge * (0.8 + 0.3 * id) * (0.9 + 0.15 * N.vn(u * 64, v * 64, 64)));
    });
    cell(6, (u, v) => { // weathered vertical planks: 6 per tile
      const p = u * 6, pi = Math.floor(p), id = hash3(pi, 0, 6), gap = (p % 1) < 0.04;
      const grain = N.fbm(u * 1, v * 0.1 + id, 32, 3);
      return gap ? [40, 32, 25] : shade(mix3([122, 100, 76], [100, 96, 90], id), 0.7 + 0.45 * grain);
    });
    cell(7, (u, v) => shade([76, 58, 42], 0.7 + 0.45 * N.fbm(u, v * 0.1, 24, 3)));
    cell(10, (u, v) => { // ashlar: big cut blocks, 5 courses
      const row = Math.floor(v * 5), bu = u * 3 + (row % 2) * 0.5, joint = (v * 5 % 1) < 0.03 || (bu % 1) < 0.02;
      const id = hash3(Math.floor(bu) % 3, row, 8);
      return joint ? [120, 116, 108] : shade([188, 180, 164], (0.8 + 0.15 * id) * (0.85 + 0.2 * N.fbm(u, v, 8, 4)));
    });
    cell(11, (u, v) => { const w = N.worley(u, v, 10); return shade(mix3([130, 120, 108], [160, 90, 70], w.id > 0.75 ? 1 : 0), (0.55 + 0.5 * (1 - w.f1)) * (0.8 + 0.3 * N.fbm(u, v, 8, 3))); });
    cell(12, (u, v) => shade([196, 168, 96], 0.6 + 0.55 * N.vn(u * 90, v * 12, 90) * (0.7 + 0.3 * N.fbm(u, v, 8, 3))));
    cell(13, (u, v) => { // corrugated, weathered sheet metal (ribs along v)
      const rib = 0.75 + 0.25 * Math.sin(u * 16 * Math.PI * 2), r = N.gfbm(u, v, 4, 5);
      const rust = sstep(0.55, 0.8, r) * 0.55 + sstep(0.7, 0.95, N.gfbm(u, v * 0.3, 8, 3)) * 0.3;
      return shade(mix3([96, 98, 100], [118, 76, 52], rust), rib * (0.85 + 0.2 * N.vn(u * 64, v * 16, 64)));
    });
    cell(14, (u, v) => shade([160, 158, 150], 0.78 + 0.2 * N.fbm(u, v, 6, 5) + 0.06 * N.vn(u * 200, v * 200, 200)));
    cell(15, (u, v) => { // natural boulder surface
      const big = N.fbm(u, v, 3, 5), w = N.worley(u, v, 5), crack = sstep(0.06, 0.0, w.f2 - w.f1);
      const lich = sstep(0.6, 0.7, N.fbm(u + 0.4, v, 8, 3));
      return shade(mix3(mix3([128, 124, 116], [98, 96, 92], big), [132, 138, 96], lich * 0.6), (0.78 + 0.35 * N.fbm(u, v, 12, 3)) * (1 - crack * 0.55));
    });
    // window & door cells get vector art over a neutral base
    cell(8, () => [60, 56, 50]); cell(9, () => [80, 60, 42]);
    g.putImageData(img, 0, 0);
    // window: shutters + frame + glass panes (cell 8 at 0,1024)
    const win = (x0, y0) => {
      const s = 512, P = PAD;
      g.fillStyle = '#6b5a45'; g.fillRect(x0 + P, y0 + P, s - 2 * P, s - 2 * P);
      // shutters (green-grey), left & right thirds
      for (const sx of [x0 + P, x0 + s - P - 120]) {
        g.fillStyle = '#4f6552'; g.fillRect(sx, y0 + P, 120, s - 2 * P);
        g.strokeStyle = 'rgba(0,0,0,0.35)'; g.lineWidth = 3;
        for (let y = y0 + P + 12; y < y0 + s - P; y += 18) { g.beginPath(); g.moveTo(sx + 8, y); g.lineTo(sx + 112, y); g.stroke(); }
      }
      g.fillStyle = '#e8e2d4'; g.fillRect(x0 + 132, y0 + 40, 248, 432);
      const gl = g.createLinearGradient(x0, y0 + 40, x0 + 200, y0 + 460);
      gl.addColorStop(0, '#556c80'); gl.addColorStop(0.5, '#1d2630'); gl.addColorStop(1, '#303a44');
      g.fillStyle = gl;
      for (const [px, py] of [[148, 56], [262, 56], [148, 270], [262, 270]]) g.fillRect(x0 + px, y0 + py, 102, 186);
      g.fillStyle = 'rgba(255,255,255,0.12)'; g.fillRect(x0 + 150, y0 + 58, 30, 180);
    };
    win(0, 1024);
    // door: planks + frame (cell 9 at 512,1024)
    { const x0 = 512, y0 = 1024; g.fillStyle = '#4a3526'; g.fillRect(x0, y0, 512, 512);
      for (let k = 0; k < 6; k++) { g.fillStyle = `rgb(${96 + rnd() * 20},${68 + rnd() * 14},${44 + rnd() * 10})`; g.fillRect(x0 + 60 + k * 66, y0 + 30, 62, 482); }
      g.fillStyle = '#2e2218'; g.fillRect(x0 + 60, y0 + 140, 396, 18); g.fillRect(x0 + 60, y0 + 380, 396, 18);
      g.fillStyle = '#222'; g.beginPath(); g.arc(x0 + 400, y0 + 290, 10, 0, 7); g.fill(); }
    const t = canvasTex(c, { aniso: 8 });
    return t;
  });
}

// ------------------------------------------------------------------ LEGACY (toy game)
// The old toy renderer (models.js, fx.js) still imports these; delete when those go away.
const mkL = mk;
let seedL = 12345;
const rndL = () => { seedL = (seedL * 16807) % 2147483647; return (seedL - 1) / 2147483646; };
function texL(canvas, { srgb = true, repeat = null, aniso = 8 } = {}) {
  const t = new THREE.CanvasTexture(canvas);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = aniso;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]); }
  t.needsUpdate = true; return t;
}
export function softDot(inner = 'rgba(255,255,255,1)', outer = 'rgba(255,255,255,0)', size = 128) {
  const [c, g] = mkL(size, size);
  const gr = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gr.addColorStop(0, inner); gr.addColorStop(1, outer); g.fillStyle = gr; g.fillRect(0, 0, size, size);
  return texL(c);
}
export function smokePuff() {
  const S = 128, [c, g] = mkL(S, S);
  for (let k = 0; k < 14; k++) {
    const x = S / 2 + (rndL() - 0.5) * S * 0.4, y = S / 2 + (rndL() - 0.5) * S * 0.4, r = S * (0.15 + rndL() * 0.2);
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, 'rgba(255,255,255,0.35)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, S, S);
  }
  return texL(c);
}
export function flame() {
  const [c, g] = mkL(64, 128);
  const gr = g.createRadialGradient(32, 90, 2, 32, 80, 60);
  gr.addColorStop(0, 'rgba(255,250,210,1)'); gr.addColorStop(0.3, 'rgba(255,170,50,0.9)'); gr.addColorStop(1, 'rgba(200,40,0,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 128); return texL(c);
}
export function scorchX() {
  const S = 128, [c, g] = mkL(S, S);
  const gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  gr.addColorStop(0, 'rgba(20,16,12,0.9)'); gr.addColorStop(0.6, 'rgba(30,24,18,0.5)'); gr.addColorStop(1, 'rgba(30,24,18,0)');
  g.fillStyle = gr; g.fillRect(0, 0, S, S); return texL(c);
}
export function treadMark() {
  const [c, g] = mkL(32, 64); g.fillStyle = 'rgba(40,30,20,0.5)';
  for (let y = 0; y < 64; y += 8) g.fillRect(2, y, 28, 4);
  return texL(c, { repeat: [1, 1] });
}
export function paintWear() {
  const S = 256, [c, g] = mkL(S, S); g.fillStyle = '#fff'; g.fillRect(0, 0, S, S);
  for (let k = 0; k < 300; k++) { g.fillStyle = `rgba(0,0,0,${rndL() * 0.15})`; g.beginPath(); g.arc(rndL() * S, rndL() * S, rndL() * 5, 0, 7); g.fill(); }
  return texL(c, { srgb: false });
}
export function emblem(kind, color) {
  const S = 128, [c, g] = mkL(S, S);
  g.fillStyle = color || '#fff'; g.beginPath(); g.arc(S / 2, S / 2, S * 0.4, 0, 7); g.fill();
  return texL(c);
}
export function cardboard() { const [c, g] = mkL(64, 64); g.fillStyle = '#b48a5a'; g.fillRect(0, 0, 64, 64); return texL(c); }
export const BLOCK_VARIANTS = 1;
export function blockTextureHQ() { const [c, g] = mkL(64, 64); g.fillStyle = '#c33'; g.fillRect(0, 0, 64, 64); return texL(c); }
