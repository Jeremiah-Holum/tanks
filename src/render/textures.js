// Every surface is painted here on a canvas at startup — no image assets.
import * as THREE from 'three';

const mk = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return [c, c.getContext('2d')]; };
let seed = 12345;
const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };

function tex(canvas, { srgb = true, repeat = null, aniso = 8 } = {}) {
  const t = new THREE.CanvasTexture(canvas);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = aniso;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]); }
  t.needsUpdate = true;
  return t;
}

// Smooth value noise for grain.
function noise1(x) { const i = Math.floor(x), f = x - i; const h = (n) => { const s = Math.sin(n * 127.1) * 43758.5453; return s - Math.floor(s); }; const u = f * f * (3 - 2 * f); return h(i) * (1 - u) + h(i + 1) * u; }

// ------------------------------------------------------------------ cork board
export function corkBoard(cols, rows, px = 72) {
  const W = cols * px, H = rows * px;
  const [c, g] = mk(W, H);
  const [b, bg] = mk(W, H); // bump
  g.fillStyle = '#c69a62'; g.fillRect(0, 0, W, H);
  bg.fillStyle = '#808080'; bg.fillRect(0, 0, W, H);
  // Large tonal blotches
  for (let k = 0; k < 90; k++) {
    const x = rnd() * W, y = rnd() * H, r = 60 + rnd() * 220;
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    const tone = rnd() < 0.5 ? 'rgba(120,80,40,0.10)' : 'rgba(235,200,150,0.10)';
    gr.addColorStop(0, tone); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // Granules
  const n = (W * H) / 26;
  for (let k = 0; k < n; k++) {
    const x = rnd() * W, y = rnd() * H, r = 0.6 + rnd() * 2.4;
    const v = rnd();
    g.fillStyle = v < 0.45 ? `rgba(95,60,28,${0.25 + rnd() * 0.35})` : v < 0.8 ? `rgba(225,188,135,${0.2 + rnd() * 0.3})` : `rgba(60,36,16,${0.3 + rnd() * 0.3})`;
    g.beginPath(); g.ellipse(x, y, r, r * (0.6 + rnd() * 0.6), rnd() * 3, 0, 7); g.fill();
    bg.fillStyle = v < 0.45 || v >= 0.8 ? `rgba(40,40,40,0.5)` : `rgba(200,200,200,0.4)`;
    bg.beginPath(); bg.arc(x, y, r, 0, 7); bg.fill();
  }
  // Printed play-mat grid: faint so it reads as print, strong enough to read bounces by.
  g.strokeStyle = 'rgba(70,40,15,0.13)'; g.lineWidth = 2;
  for (let i = 1; i < cols; i++) { g.beginPath(); g.moveTo(i * px, 0); g.lineTo(i * px, H); g.stroke(); }
  for (let j = 1; j < rows; j++) { g.beginPath(); g.moveTo(0, j * px); g.lineTo(W, j * px); g.stroke(); }
  g.fillStyle = 'rgba(70,40,15,0.18)';
  for (let i = 1; i < cols; i++) for (let j = 1; j < rows; j++) { g.beginPath(); g.arc(i * px, j * px, 3, 0, 7); g.fill(); }
  // Border print
  g.strokeStyle = 'rgba(150,40,30,0.35)'; g.lineWidth = 6; g.strokeRect(10, 10, W - 20, H - 20);
  g.strokeStyle = 'rgba(150,40,30,0.2)'; g.lineWidth = 2; g.strokeRect(22, 22, W - 44, H - 44);
  return { map: tex(c, { aniso: 16 }), bump: tex(b, { srgb: false, aniso: 16 }) };
}

// ------------------------------------------------------------------ hardwood floor
export function woodFloor() {
  const S = 2048;
  const [c, g] = mk(S, S);
  const [r, rg] = mk(S, S);
  const plankH = S / 8;
  for (let p = 0; p < 8; p++) {
    let x = -rnd() * 900;
    while (x < S) {
      const len = 700 + rnd() * 900;
      const base = [150 + rnd() * 40, 95 + rnd() * 30, 55 + rnd() * 20];
      const y0 = p * plankH;
      g.fillStyle = `rgb(${base[0] | 0},${base[1] | 0},${base[2] | 0})`;
      g.fillRect(x, y0, len, plankH);
      // grain
      const phase = rnd() * 100;
      for (let yy = 0; yy < plankH; yy += 2) {
        const w = noise1(yy * 0.05 + phase) * 0.6 + noise1(yy * 0.21 + phase * 2) * 0.4;
        g.fillStyle = `rgba(${w > 0.55 ? '60,30,10' : '255,220,170'},${Math.abs(w - 0.55) * 0.35})`;
        g.fillRect(x, y0 + yy, len, 2);
      }
      // knots
      if (rnd() < 0.35) {
        const kx = x + rnd() * len, ky = y0 + plankH * (0.3 + rnd() * 0.4);
        for (let q = 8; q > 0; q--) { g.strokeStyle = `rgba(70,35,12,${0.08 + q * 0.02})`; g.lineWidth = 2; g.beginPath(); g.ellipse(kx, ky, q * 7, q * 2.4, 0, 0, 7); g.stroke(); }
      }
      g.fillStyle = 'rgba(30,15,5,0.85)'; g.fillRect(x, y0, 3, plankH);
      rg.fillStyle = `rgb(${90 + rnd() * 40 | 0},0,0)`; rg.fillRect(x, y0, len, plankH);
      x += len;
    }
    g.fillStyle = 'rgba(25,12,4,0.9)'; g.fillRect(0, p * plankH, S, 3);
  }
  // varnish sheen variation → roughness map (green channel used by three)
  const id = rg.getImageData(0, 0, S, S); const d = id.data;
  for (let k = 0; k < d.length; k += 4) { d[k + 1] = d[k]; d[k + 2] = d[k]; d[k + 3] = 255; }
  rg.putImageData(id, 0, 0);
  return { map: tex(c, { repeat: [4, 4], aniso: 16 }), rough: tex(r, { srgb: false, repeat: [4, 4], aniso: 16 }) };
}

// ------------------------------------------------------------------ frame wood (walnut)
export function walnut() {
  const [c, g] = mk(512, 512);
  g.fillStyle = '#5a3620'; g.fillRect(0, 0, 512, 512);
  for (let y = 0; y < 512; y++) {
    const w = noise1(y * 0.06) * 0.6 + noise1(y * 0.23 + 9) * 0.4;
    g.fillStyle = `rgba(${w > 0.5 ? '25,12,4' : '160,110,70'},${Math.abs(w - 0.5) * 0.5})`;
    g.fillRect(0, y, 512, 1);
  }
  return tex(c, { repeat: [6, 1] });
}

// ------------------------------------------------------------------ toy blocks
const BLOCK_PAINT = [
  ['#d93b30', '#fff3d6'], ['#2c6fd6', '#fff3d6'], ['#f0b62a', '#8a2a14'], ['#3aa35b', '#fff3d6'],
  ['#e8dcc0', '#c8372d'], ['#f07f2a', '#fff3d6'], ['#7c4ec4', '#fff3d6'], ['#e8dcc0', '#2c6fd6'],
];
export const BLOCK_VARIANTS = BLOCK_PAINT.length;
const LETTERS = 'ABCDEFGHIJKLMNOPRSTUWXYZ123456789';

export function blockTexture(variant) {
  const S = 256;
  const [c, g] = mk(S * 4, S); // 4 faces worth of letters, sampled by face UV remap
  const [bg, fg] = BLOCK_PAINT[variant % BLOCK_PAINT.length];
  for (let f = 0; f < 4; f++) {
    const ox = f * S;
    // raw wood under paint
    g.fillStyle = '#e2c79a'; g.fillRect(ox, 0, S, S);
    // paint with worn edges
    g.fillStyle = bg; g.fillRect(ox + 6, 6, S - 12, S - 12);
    for (let k = 0; k < 40; k++) { g.fillStyle = 'rgba(226,199,154,0.55)'; const e = rnd() * 4 | 0, t = rnd() * S; const w = 3 + rnd() * 14; if (e === 0) g.fillRect(ox + t, 4, w, 3 + rnd() * 5); else if (e === 1) g.fillRect(ox + t, S - 8, w, 3 + rnd() * 5); else if (e === 2) g.fillRect(ox + 4, t, 3 + rnd() * 5, w); else g.fillRect(ox + S - 8, t, 3 + rnd() * 5, w); }
    // inset frame
    g.strokeStyle = fg; g.globalAlpha = 0.9; g.lineWidth = 10; g.strokeRect(ox + 26, 26, S - 52, S - 52); g.globalAlpha = 1;
    // letter, "engraved": shadow then fill
    const L = LETTERS[(variant * 7 + f * 5) % LETTERS.length];
    g.font = `900 ${S * 0.6}px "Arial Black", "Helvetica Neue", Arial, sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = 'rgba(0,0,0,0.28)'; g.fillText(L, ox + S / 2 + 4, S / 2 + 12);
    g.fillStyle = fg; g.fillText(L, ox + S / 2, S / 2 + 8);
    // speckle
    for (let k = 0; k < 300; k++) { g.fillStyle = `rgba(0,0,0,${rnd() * 0.06})`; g.fillRect(ox + rnd() * S, rnd() * S, 2, 2); }
  }
  return tex(c);
}

// ------------------------------------------------------------------ cardboard crate
export function cardboard() {
  const S = 512;
  const [c, g] = mk(S, S);
  g.fillStyle = '#c49a64'; g.fillRect(0, 0, S, S);
  for (let x = 0; x < S; x += 6) { g.fillStyle = `rgba(90,60,30,${0.05 + (x % 12 ? 0 : 0.04)})`; g.fillRect(x, 0, 2, S); }
  for (let k = 0; k < 2200; k++) { g.fillStyle = `rgba(${rnd() < 0.5 ? '80,50,20' : '240,210,160'},${rnd() * 0.12})`; g.fillRect(rnd() * S, rnd() * S, 2 + rnd() * 3, 1 + rnd() * 2); }
  // packing tape across the middle
  g.fillStyle = 'rgba(214,180,120,0.9)'; g.fillRect(S * 0.4, 0, S * 0.2, S);
  g.fillStyle = 'rgba(255,240,210,0.25)'; g.fillRect(S * 0.41, 0, S * 0.04, S);
  // printed arrows / fragile mark
  g.strokeStyle = 'rgba(60,35,15,0.5)'; g.lineWidth = 8;
  g.beginPath(); g.moveTo(80, 170); g.lineTo(80, 90); g.moveTo(55, 115); g.lineTo(80, 90); g.lineTo(105, 115); g.stroke();
  g.beginPath(); g.moveTo(130, 170); g.lineTo(130, 90); g.moveTo(105, 115); g.lineTo(130, 90); g.lineTo(155, 115); g.stroke();
  g.fillStyle = 'rgba(160,40,30,0.55)'; g.font = '900 44px Arial Black, Arial'; g.textAlign = 'center';
  g.save(); g.translate(S * 0.78, S * 0.72); g.rotate(-0.08); g.fillText('FRAGILE', 0, 0); g.restore();
  g.strokeStyle = 'rgba(80,50,20,0.35)'; g.lineWidth = 6; g.strokeRect(8, 8, S - 16, S - 16);
  return tex(c);
}

// ------------------------------------------------------------------ rubber tread
export function treadTexture() {
  const [c, g] = mk(64, 256);
  g.fillStyle = '#1d1e20'; g.fillRect(0, 0, 64, 256);
  for (let y = 0; y < 256; y += 16) { g.fillStyle = '#34363a'; g.fillRect(0, y, 64, 7); g.fillStyle = '#0c0c0d'; g.fillRect(0, y + 7, 64, 2); }
  const t = tex(c, { repeat: [1, 1] });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

// ------------------------------------------------------------------ soft sprites
export function softDot(inner = 'rgba(255,255,255,1)', outer = 'rgba(255,255,255,0)', size = 128) {
  const [c, g] = mk(size, size);
  const gr = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gr.addColorStop(0, inner); gr.addColorStop(0.4, inner.replace(/[\d.]+\)$/, '0.5)')); gr.addColorStop(1, outer);
  g.fillStyle = gr; g.fillRect(0, 0, size, size);
  return tex(c, { srgb: false });
}

export function smokePuff() {
  const S = 128;
  const [c, g] = mk(S, S);
  for (let k = 0; k < 14; k++) {
    const x = S / 2 + (rnd() - 0.5) * S * 0.35, y = S / 2 + (rnd() - 0.5) * S * 0.35, r = S * (0.16 + rnd() * 0.2);
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, 'rgba(255,255,255,0.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, S, S);
  }
  return tex(c, { srgb: false });
}

export function blobShadow() {
  const S = 128;
  const [c, g] = mk(S, S);
  const gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  gr.addColorStop(0, 'rgba(0,0,0,0.75)'); gr.addColorStop(0.55, 'rgba(0,0,0,0.35)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr; g.fillRect(0, 0, S, S);
  return tex(c, { srgb: false });
}

export function squareAO() {
  const S = 128;
  const [c, g] = mk(S, S);
  const id = g.createImageData(S, S);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const dx = Math.max(0, Math.abs(x - S / 2 + 0.5) - S * 0.3) / (S * 0.2);
    const dy = Math.max(0, Math.abs(y - S / 2 + 0.5) - S * 0.3) / (S * 0.2);
    const d = Math.min(1, Math.hypot(dx, dy));
    const a = (1 - d) * (1 - d) * 0.6;
    const k = (y * S + x) * 4; id.data[k + 3] = a * 255;
  }
  g.putImageData(id, 0, 0);
  return tex(c, { srgb: false });
}

export function scorchX() {
  const S = 256;
  const [c, g] = mk(S, S);
  const gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  gr.addColorStop(0, 'rgba(20,10,5,0.75)'); gr.addColorStop(0.5, 'rgba(30,15,5,0.35)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr; g.fillRect(0, 0, S, S);
  g.save(); g.translate(S / 2, S / 2); g.rotate(Math.PI / 4);
  g.fillStyle = 'rgba(15,8,4,0.8)';
  g.fillRect(-S * 0.34, -S * 0.07, S * 0.68, S * 0.14); g.fillRect(-S * 0.07, -S * 0.34, S * 0.14, S * 0.68);
  g.restore();
  for (let k = 0; k < 60; k++) { g.fillStyle = `rgba(10,5,0,${rnd() * 0.4})`; const a = rnd() * 7, r = rnd() * S * 0.45; g.beginPath(); g.arc(S / 2 + Math.cos(a) * r, S / 2 + Math.sin(a) * r, 2 + rnd() * 5, 0, 7); g.fill(); }
  return tex(c, { srgb: false });
}

export function treadMark() {
  const [c, g] = mk(32, 32);
  for (let y = 2; y < 32; y += 8) { g.fillStyle = 'rgba(40,22,8,0.9)'; g.fillRect(3, y, 26, 4); }
  return tex(c, { srgb: false });
}

// Decals printed on the turret: star for the player, stripes for others.
export function emblem(kind, color) {
  const S = 128;
  const [c, g] = mk(S, S);
  g.translate(S / 2, S / 2);
  g.fillStyle = color;
  if (kind === 'star') {
    g.beginPath();
    for (let k = 0; k < 10; k++) { const r = k % 2 ? 22 : 52; const a = -Math.PI / 2 + k * Math.PI / 5; g.lineTo(Math.cos(a) * r, Math.sin(a) * r); }
    g.closePath(); g.fill();
  } else if (kind === 'skull') {
    g.beginPath(); g.arc(0, -6, 34, 0, 7); g.fill(); g.fillRect(-20, 16, 40, 22);
    g.fillStyle = 'rgba(0,0,0,0.85)'; g.beginPath(); g.arc(-13, -8, 9, 0, 7); g.arc(13, -8, 9, 0, 7); g.fill();
  } else {
    g.beginPath(); g.arc(0, 0, 40, 0, 7); g.lineWidth = 12; g.strokeStyle = color; g.stroke();
    g.beginPath(); g.arc(0, 0, 14, 0, 7); g.fill();
  }
  return tex(c);
}

// ================================================================== realism pass
// Multi-octave value noise on a grid, for terrain and wear.
function makeNoise(size, seed0) {
  const g = new Float32Array(size * size);
  let s = seed0;
  const r = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  for (let k = 0; k < g.length; k++) g[k] = r();
  const at = (x, y) => g[((y % size + size) % size) * size + ((x % size + size) % size)];
  return (x, y) => { // x,y in lattice units, tiles every `size`
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    return (at(xi, yi) * (1 - u) + at(xi + 1, yi) * u) * (1 - v) + (at(xi, yi + 1) * (1 - u) + at(xi + 1, yi + 1) * u) * v;
  };
}
function fbm(n, x, y, oct = 5) { let a = 0.5, f = 1, t = 0, w = 0; for (let o = 0; o < oct; o++) { t += n(x * f, y * f) * a; w += a; a *= 0.5; f *= 2; } return t / w; }

// Diorama terrain: packed sandy earth with patches of static-grass flock and pebbles.
// Returns {map, rough, grassMask(x,z) in board cells} so 3D tufts can follow the painted grass.
export function diorama(cols, rows, px = 110) {
  const W = cols * px, H = rows * px;
  const [c, g] = mk(W, H);
  const img = g.createImageData(W, H), d = img.data;
  const [rc, rg] = mk(W, H);
  const rimg = rg.createImageData(W, H), rd = rimg.data;
  const nA = makeNoise(256, 7), nB = makeNoise(256, 99), nC = makeNoise(256, 1234);
  const grass = new Float32Array(cols * 4 * rows * 4); // mask at quarter-cell resolution
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = x / px, v = y / px;
      const e = fbm(nA, u * 0.9, v * 0.9, 5);
      const gm = fbm(nB, u * 0.35 + 20, v * 0.35 + 5, 4);
      const fine = nC(x * 0.35, y * 0.35);
      // base earth: warm sand to darker loam
      let r = 178 + (e - 0.5) * 70 + (fine - 0.5) * 26;
      let gg = 150 + (e - 0.5) * 60 + (fine - 0.5) * 22;
      let b = 108 + (e - 0.5) * 50 + (fine - 0.5) * 18;
      // grass flock where the patch noise is high; ragged edge from the fine noise
      const gv = (gm - 0.56) * 9 + (fine - 0.5) * 1.6;
      const gw = Math.max(0, Math.min(1, gv));
      if (gw > 0) {
        const tone = nC(x * 0.9 + 50, y * 0.9) ;
        const gr = 88 + tone * 40 + (e - 0.5) * 30, gg2 = 112 + tone * 50 + (e - 0.5) * 30, gb = 48 + tone * 20;
        r = r * (1 - gw) + gr * gw; gg = gg * (1 - gw) + gg2 * gw; b = b * (1 - gw) + gb * gw;
      }
      // tread-worn lighter lanes don't exist yet; add scattered dark grit
      if (fine > 0.93) { r *= 0.7; gg *= 0.7; b *= 0.7; }
      const k = (y * W + x) * 4;
      d[k] = r; d[k + 1] = gg; d[k + 2] = b; d[k + 3] = 255;
      const rough = 0.82 + gw * 0.12 - (fine > 0.93 ? 0.1 : 0);
      rd[k] = rd[k + 1] = rd[k + 2] = rough * 255; rd[k + 3] = 255;
      if ((x % (px / 4 | 0)) === 0 && (y % (px / 4 | 0)) === 0) {
        const gi = Math.floor(u * 4), gj = Math.floor(v * 4);
        if (gi < cols * 4 && gj < rows * 4) grass[gj * cols * 4 + gi] = gw;
      }
    }
  }
  g.putImageData(img, 0, 0); rg.putImageData(rimg, 0, 0);
  // pebbles with a baked contact shadow
  for (let k = 0; k < cols * rows * 3; k++) {
    const x = rnd() * W, y = rnd() * H, r = 1.5 + rnd() * 4;
    g.fillStyle = 'rgba(40,28,15,0.35)'; g.beginPath(); g.ellipse(x + r * 0.4, y + r * 0.4, r * 1.1, r * 0.9, 0, 0, 7); g.fill();
    const t = 120 + rnd() * 90 | 0;
    g.fillStyle = `rgb(${t},${t - 8},${t - 20})`; g.beginPath(); g.ellipse(x, y, r, r * (0.6 + rnd() * 0.4), rnd() * 3, 0, 7); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.25)'; g.beginPath(); g.arc(x - r * 0.3, y - r * 0.3, r * 0.35, 0, 7); g.fill();
  }
  const map = tex(c, { aniso: 16 }), rough = tex(rc, { srgb: false, aniso: 16 });
  const gcols = cols * 4;
  return { map, rough, grassAt: (x, z) => grass[Math.floor(z * 4) * gcols + Math.floor(x * 4)] || 0 };
}

// Tileable fine-grain normal map for close-up detail (sand grains / flock).
export function grainNormal(size = 512) {
  const [c, g] = mk(size, size);
  const n = makeNoise(128, 4242), n2 = makeNoise(64, 77);
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) h[y * size + x] = n(x / 4, y / 4) * 0.6 + n2(x / 16 * 4, y / 16 * 4) * 0.4;
  const img = g.createImageData(size, size), d = img.data;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const hx = h[y * size + (x + 1) % size] - h[y * size + (x - 1 + size) % size];
    const hy = h[((y + 1) % size) * size + x] - h[((y - 1 + size) % size) * size + x];
    const nx = -hx * 3, ny = -hy * 3, nz = 1, l = Math.hypot(nx, ny, nz);
    const k = (y * size + x) * 4;
    d[k] = (nx / l * 0.5 + 0.5) * 255; d[k + 1] = (ny / l * 0.5 + 0.5) * 255; d[k + 2] = (nz / l * 0.5 + 0.5) * 255; d[k + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = tex(c, { srgb: false, repeat: [22, 16] });
  return t;
}

// Painted die-cast wear: a colour-multiply map (white = paint as-is, specks of bare metal
// and grime), plus a matching metalness/roughness map (three reads B = metal, G = rough).
export function paintWear() {
  const S = 512;
  const [c, g] = mk(S, S), [m, mg] = mk(S, S);
  const n = makeNoise(64, 31);
  const img = g.createImageData(S, S), d = img.data;
  const mimg = mg.createImageData(S, S), md = mimg.data;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const v = fbm(n, x / 24, y / 24, 4);
    const k = (y * S + x) * 4;
    const grime = 1 - Math.max(0, v - 0.55) * 0.9;
    d[k] = d[k + 1] = d[k + 2] = 240 * grime + 15; d[k + 3] = 255;
    md[k] = 255; md[k + 1] = (0.42 + (v - 0.5) * 0.25) * 255; md[k + 2] = 0.12 * 255; md[k + 3] = 255;
  }
  g.putImageData(img, 0, 0); mg.putImageData(mimg, 0, 0);
  // chips: bare zinc showing through
  for (let k = 0; k < 260; k++) {
    const x = rnd() * S, y = rnd() * S, r = 0.5 + Math.pow(rnd(), 4) * 3.2;
    g.fillStyle = 'rgb(236,238,240)';
    mg.fillStyle = 'rgb(255,90,240)';
    g.beginPath(); mg.beginPath();
    for (let a = 0; a < 7; a++) { const rr = r * (0.6 + rnd() * 0.7), aa = a / 7 * Math.PI * 2; g.lineTo(x + Math.cos(aa) * rr, y + Math.sin(aa) * rr); mg.lineTo(x + Math.cos(aa) * rr, y + Math.sin(aa) * rr); }
    g.fill(); mg.fill();
  }
  const map = tex(c, { repeat: [1, 1] }), mr = tex(m, { srgb: false });
  map.wrapS = map.wrapT = mr.wrapS = mr.wrapT = THREE.RepeatWrapping;
  return { map, mr };
}

// Wooden toy block faces at higher resolution: grain under painted panels, worn corners.
export function blockTextureHQ(variant) {
  const S = 512;
  const [c, g] = mk(S * 4, S);
  const [bg, fg] = BLOCK_PAINT[variant % BLOCK_PAINT.length];
  const n = makeNoise(64, 500 + variant);
  for (let f = 0; f < 4; f++) {
    const ox = f * S;
    // raw beech
    for (let y = 0; y < S; y += 2) {
      const w = fbm(n, 3 + f * 7, y / 18, 3);
      g.fillStyle = `rgb(${214 + w * 30 | 0},${178 + w * 28 | 0},${128 + w * 20 | 0})`;
      g.fillRect(ox, y, S, 2);
    }
    // paint coat with slight mottling
    g.fillStyle = bg; g.globalAlpha = 0.94; g.fillRect(ox + 14, 14, S - 28, S - 28); g.globalAlpha = 1;
    for (let k = 0; k < 900; k++) { g.fillStyle = `rgba(${rnd() < 0.5 ? '0,0,0' : '255,255,255'},${rnd() * 0.035})`; const r = 2 + rnd() * 10; g.beginPath(); g.arc(ox + 14 + rnd() * (S - 28), 14 + rnd() * (S - 28), r, 0, 7); g.fill(); }
    // wear through to wood at the edges
    for (let k = 0; k < 90; k++) {
      const e = rnd() * 4 | 0, t = 10 + rnd() * (S - 20), w = 4 + rnd() * 26, dep = 3 + rnd() * 12;
      g.fillStyle = `rgba(222,188,140,${0.6 + rnd() * 0.4})`;
      if (e === 0) g.fillRect(ox + t, 10, w, dep); else if (e === 1) g.fillRect(ox + t, S - 10 - dep, w, dep);
      else if (e === 2) g.fillRect(ox + 10, t, dep, w); else g.fillRect(ox + S - 10 - dep, t, dep, w);
    }
    g.strokeStyle = fg; g.globalAlpha = 0.85; g.lineWidth = 16; g.strokeRect(ox + 52, 52, S - 104, S - 104); g.globalAlpha = 1;
    const L = LETTERS[(variant * 7 + f * 5) % LETTERS.length];
    g.font = `900 ${S * 0.58}px "Arial Black", "Helvetica Neue", Arial, sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillText(L, ox + S / 2 + 6, S / 2 + 22);
    g.fillStyle = fg; g.fillText(L, ox + S / 2, S / 2 + 16);
    g.fillStyle = 'rgba(255,255,255,0.12)'; g.fillText(L, ox + S / 2 - 3, S / 2 + 13);
  }
  return tex(c, { aniso: 16 });
}

// Grass tuft card (alpha) for 3D flock.
export function grassCard() {
  const [c, g] = mk(128, 128);
  for (let k = 0; k < 38; k++) {
    const x = 64 + (rnd() - 0.5) * 60, h = 50 + rnd() * 70, lean = (rnd() - 0.5) * 30;
    const t = rnd();
    g.strokeStyle = `rgb(${70 + t * 60 | 0},${100 + t * 70 | 0},${30 + t * 25 | 0})`;
    g.lineWidth = 2 + rnd() * 2.5;
    g.beginPath(); g.moveTo(x, 128); g.quadraticCurveTo(x + lean * 0.3, 128 - h * 0.6, x + lean, 128 - h); g.stroke();
  }
  return tex(c);
}

export function wallpaper() {
  const [c, g] = mk(512, 512);
  g.fillStyle = '#b9c7b0'; g.fillRect(0, 0, 512, 512);
  for (let x = 0; x < 512; x += 64) { g.fillStyle = 'rgba(255,255,255,0.18)'; g.fillRect(x, 0, 22, 512); g.fillStyle = 'rgba(60,80,60,0.08)'; g.fillRect(x + 22, 0, 3, 512); }
  for (let k = 0; k < 40; k++) { const x = (k % 8) * 64 + 43, y = Math.floor(k / 8) * 110 + 30; g.fillStyle = 'rgba(120,70,60,0.25)'; g.beginPath(); for (let p = 0; p < 5; p++) { const a = p / 5 * Math.PI * 2; g.ellipse(x + Math.cos(a) * 6, y + Math.sin(a) * 6, 5, 3, a, 0, 7); } g.fill(); }
  return tex(c, { repeat: [10, 3] });
}

export function rug() {
  const S = 1024;
  const [c, g] = mk(S, S);
  g.fillStyle = '#5e2a24'; g.fillRect(0, 0, S, S);
  for (let r = 0; r < 5; r++) { g.strokeStyle = r % 2 ? 'rgba(200,170,120,0.28)' : 'rgba(30,40,70,0.35)'; g.lineWidth = 10; g.strokeRect(30 + r * 26, 30 + r * 26, S - 60 - r * 52, S - 60 - r * 52); }
  for (let k = 0; k < 30000; k++) { g.fillStyle = `rgba(${rnd() < 0.5 ? '0,0,0' : '255,230,200'},${rnd() * 0.08})`; g.fillRect(rnd() * S, rnd() * S, 2, 3); }
  return tex(c);
}
