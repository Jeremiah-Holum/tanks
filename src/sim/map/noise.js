// Deterministic helpers shared by the map generators: seeded RNG, 2D gradient noise, fbm,
// smoothstep and small geometry helpers. Pure JS, no dependencies.

// mulberry32: fast, good enough, deterministic across engines.
export function makeRng(seed) {
  let s = (seed >>> 0) || 0x9e3779b9;
  const r = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  r.range = (a, b) => a + (b - a) * r();
  r.int = (a, b) => a + Math.floor(r() * (b - a + 1));
  r.pick = (arr) => arr[Math.floor(r() * arr.length)];
  r.chance = (p) => r() < p;
  return r;
}

// Hash a few integers into a 32-bit seed (for per-feature sub-streams).
export function hashSeed(...xs) {
  let h = 0x811c9dc5;
  for (const x of xs) {
    h ^= (x | 0) + 0x9e3779b9 + (h << 6) + (h >>> 2);
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  }
  return h >>> 0;
}

// Perlin-style 2D gradient noise, output roughly in [-1, 1].
export function makeNoise(seed) {
  const rng = makeRng(seed);
  const p = new Uint8Array(512);
  const perm = [...Array(256).keys()];
  for (let i = 255; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [perm[i], perm[j]] = [perm[j], perm[i]]; }
  for (let i = 0; i < 512; i++) p[i] = perm[i & 255];
  const gx = new Float32Array(256), gz = new Float32Array(256);
  for (let i = 0; i < 256; i++) { const a = rng() * Math.PI * 2; gx[i] = Math.cos(a); gz[i] = Math.sin(a); }
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  function n2(x, z) {
    const xi = Math.floor(x), zi = Math.floor(z);
    const xf = x - xi, zf = z - zi;
    const X = xi & 255, Z = zi & 255;
    const a = p[p[X] + Z], b = p[p[X + 1] + Z], c = p[p[X] + Z + 1], d = p[p[X + 1] + Z + 1];
    const va = gx[a] * xf + gz[a] * zf;
    const vb = gx[b] * (xf - 1) + gz[b] * zf;
    const vc = gx[c] * xf + gz[c] * (zf - 1);
    const vd = gx[d] * (xf - 1) + gz[d] * (zf - 1);
    const u = fade(xf), v = fade(zf);
    return 1.41 * ((va + u * (vb - va)) + v * ((vc + u * (vd - vc)) - (va + u * (vb - va))));
  }
  // fractal sum; scale = wavelength of the first octave in metres
  n2.fbm = (x, z, scale, oct = 4, gain = 0.5, lac = 2) => {
    let s = 0, a = 1, f = 1 / scale, norm = 0;
    for (let o = 0; o < oct; o++) { s += a * n2(x * f + o * 17.3, z * f - o * 9.1); norm += a; a *= gain; f *= lac; }
    return s / norm;
  };
  // ridged fbm in [0, 1]: sharp crests
  n2.ridged = (x, z, scale, oct = 4) => {
    let s = 0, a = 1, f = 1 / scale, norm = 0;
    for (let o = 0; o < oct; o++) { const v = 1 - Math.abs(n2(x * f + o * 31.7, z * f + o * 5.3)); s += a * v * v; norm += a; a *= 0.5; f *= 2; }
    return s / norm;
  };
  return n2;
}

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smooth = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };

// Distance from point to segment, with the segment parameter u in [0,1].
export function segDist(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz;
  let u = L2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / L2 : 0;
  u = u < 0 ? 0 : u > 1 ? 1 : u;
  const qx = ax + dx * u - px, qz = az + dz * u - pz;
  return { d: Math.sqrt(qx * qx + qz * qz), u };
}

// Resample a polyline to points every `step` metres (keeps the ends).
export function resample(poly, step) {
  const out = [poly[0].slice()];
  let carry = 0;
  for (let i = 1; i < poly.length; i++) {
    const [ax, az] = poly[i - 1], [bx, bz] = poly[i];
    const L = Math.hypot(bx - ax, bz - az);
    let s = step - carry;
    while (s <= L) { out.push([ax + (bx - ax) * s / L, az + (bz - az) * s / L]); s += step; }
    carry = L - (s - step);
  }
  const last = poly[poly.length - 1];
  const e = out[out.length - 1];
  if (Math.hypot(e[0] - last[0], e[1] - last[1]) > step * 0.3) out.push(last.slice()); else out[out.length - 1] = last.slice();
  return out;
}

// Catmull-Rom smoothing of a control polyline into a dense one.
export function spline(pts, perSeg = 8) {
  const out = [];
  const P = (i) => pts[Math.max(0, Math.min(pts.length - 1, i))];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    for (let k = 0; k < perSeg; k++) {
      const t = k / perSeg, t2 = t * t, t3 = t2 * t;
      const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  out.push(pts[pts.length - 1].slice());
  return out;
}

export function polyLength(poly) {
  let L = 0;
  for (let i = 1; i < poly.length; i++) L += Math.hypot(poly[i][0] - poly[i - 1][0], poly[i][1] - poly[i - 1][1]);
  return L;
}

// Point in polygon (even-odd), poly = [[x,z]...]
export function inPoly(x, z, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
