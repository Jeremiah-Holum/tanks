// Battlefield generator: large, point-symmetric toy-town maps in the spirit of tank-battle
// games. Output is plain ASCII rows (the sim's format) plus `props`, which tell the renderer
// which blocked cells belong to one big toy (a house, a row of books, a tin can…).
//
//   . floor   # blocked   x cardboard crate (breakable)   o pit
//   P player  A/B team spawn hints  enemy letters: see levels.js
function makeRng(seed) {
  let s = (seed >>> 0) || 0x9e3779b9;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

export function generate({ w = 44, h = 32, seed = 1, theme = 'town', density = 1 }) {
  const rng = makeRng(seed * 7919 + 13);
  const R = (a, b) => a + Math.floor(rng() * (b - a + 1));
  const g = [...Array(h)].map(() => Array(w).fill('.'));
  const props = [];
  const inb = (i, j) => i >= 0 && j >= 0 && i < w && j < h;
  // Work on the left half and mirror through the centre, so both sides get the same map.
  const half = Math.floor(w / 2);
  const free = (i0, j0, ww, hh, pad = 1) => {
    for (let j = j0 - pad; j < j0 + hh + pad; j++) for (let i = i0 - pad; i < i0 + ww + pad; i++) {
      if (!inb(i, j)) { if (pad === 0) return false; continue; }
      if (g[j][i] !== '.') return false;
    }
    return true;
  };
  const keepOut = (i, j) => i < 5 && Math.abs(j - h / 2) < 5; // spawn apron
  const place = (kind, i, j, ww, hh, ch = '#', extra = {}) => {
    if (i < 1 || j < 1 || i + ww > half - 1 || j + hh > h - 1) return false;
    for (let y = j; y < j + hh; y++) for (let x = i; x < i + ww; x++) if (keepOut(x, y)) return false;
    if (!free(i, j, ww, hh, 1)) return false;
    for (let y = j; y < j + hh; y++) for (let x = i; x < i + ww; x++) g[y][x] = ch;
    props.push({ kind, i, j, w: ww, h: hh, v: R(0, 99), ...extra });
    return true;
  };

  const tryN = (n, f) => { let k = 0, guard = 0; while (k < n && guard++ < n * 40) if (f()) k++; };
  const D = density;

  // ---- themes decide the big features
  if (theme === 'town' || theme === 'village') {
    // houses along streets: a loose grid of plots
    const plotW = 6, plotH = 6;
    for (let py = 2; py < h - 4; py += plotH) {
      for (let px = 5; px < half - 4; px += plotW) {
        if (rng() < (theme === 'town' ? 0.72 : 0.45) * D) {
          const ww = R(2, 3), hh = R(2, 3);
          place('house', px + R(0, plotW - ww - 2), py + R(0, plotH - hh - 2), ww, hh);
        } else if (rng() < 0.5) {
          place('tower', px + R(0, 3), py + R(0, 3), 1, 1);
        }
      }
    }
  }
  if (theme === 'farm' || theme === 'village') {
    // hedgerows of crates with gaps, and a barn
    tryN(Math.round(6 * D), () => {
      const horiz = rng() < 0.5, len = R(4, 8);
      const i = R(3, half - 3 - (horiz ? len : 1)), j = R(2, h - 3 - (horiz ? 1 : len));
      return place('hedge', i, j, horiz ? len : 1, horiz ? 1 : len, 'x');
    });
    tryN(1, () => place('house', R(6, half - 8), R(3, h - 7), 3, 3, '#', { barn: true }));
  }
  if (theme === 'craters' || theme === 'river') {
    tryN(Math.round(7 * D), () => {
      const r = R(1, 2), ci = R(4, half - 4), cj = R(3, h - 4);
      if (!free(ci - r, cj - r, r * 2 + 1, r * 2 + 1, 1)) return false;
      let any = false;
      for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) if (x * x + y * y <= r * r + 0.5 && !keepOut(ci + x, cj + y)) { g[cj + y][ci + x] = 'o'; any = true; }
      return any;
    });
  }
  if (theme === 'river') {
    // a creek down the middle column band with two bridges (mirrors into a full crossing)
    const x0 = half - 3;
    let x = x0;
    for (let j = 0; j < h; j++) {
      x += rng() < 0.3 ? (rng() < 0.5 ? -1 : 1) : 0;
      x = Math.max(half - 5, Math.min(half - 2, x));
      const bridge = (j >= 5 && j <= 7) || (j >= h - 12 && j <= h - 10);
      if (!bridge) { g[j][x] = 'o'; g[j][x + 1] = 'o'; }
    }
  }
  if (theme === 'fort') {
    // a walled keep straddling the centre line (only the left half is drawn; it mirrors)
    const top = Math.floor(h / 2) - 6, bot = Math.floor(h / 2) + 5, left = half - 7;
    for (let i = left; i < half; i++) { g[top][i] = '#'; g[bot][i] = '#'; }
    for (let j = top; j <= bot; j++) if (Math.abs(j - h / 2) > 1.5) g[j][left] = '#';
    props.push({ kind: 'wall', i: left, j: top, w: half - left, h: 1, v: 1 }, { kind: 'wall', i: left, j: bot, w: half - left, h: 1, v: 2 });
    props.push({ kind: 'wall', i: left, j: top + 1, w: 1, h: Math.floor(h / 2) - 2 - top, v: 3 });
    props.push({ kind: 'wall', i: left, j: Math.floor(h / 2) + 2, w: 1, h: bot - Math.floor(h / 2) - 2, v: 4 });
    place('house', left + 2, Math.floor(h / 2) - 1, 2, 2);
  }
  // ---- generic cover everywhere: book rows, tin cans, brick walls, block towers, crate stacks
  tryN(Math.round(3 * D), () => { const horiz = rng() < 0.5, len = R(3, 5); return place('books', R(3, half - 6), R(2, h - 7), horiz ? len : 1, horiz ? 1 : len); });
  tryN(Math.round(5 * D), () => place('can', R(4, half - 3), R(2, h - 3), 1, 1));
  tryN(Math.round(4 * D), () => { const horiz = rng() < 0.5, len = R(3, 6); return place('bricks', R(3, half - 7), R(2, h - 7), horiz ? len : 1, horiz ? 1 : len); });
  tryN(Math.round(6 * D), () => place('tower', R(3, half - 3), R(2, h - 3), 1, 1));
  tryN(Math.round(8 * D), () => { const ww = R(1, 2), hh = R(1, 2); return place('crates', R(3, half - 3), R(2, h - 4), ww, hh, 'x'); });

  // ---- mirror left half through the centre (180° rotation) for fairness
  const mirroredProps = [];
  for (let j = 0; j < h; j++) for (let i = 0; i < half; i++) g[h - 1 - j][w - 1 - i] = g[j][i];
  for (const p of props) mirroredProps.push({ ...p, i: w - p.i - p.w, j: h - p.j - p.h, v: p.v + 1, mirror: true });
  props.push(...mirroredProps);

  // ---- make sure every open cell is reachable from every other (no sealed pockets)
  seal(g, w, h, props);
  return { rows: g.map((r) => r.join('')), props, w, h };
}

// Fill unreachable pockets so no tank can spawn or hide in a sealed room.
function seal(g, w, h, props) {
  const seen = new Uint8Array(w * h);
  const open = (i, j) => g[j][i] === '.' || g[j][i] === 'x';
  let si = 2, sj = Math.floor(h / 2);
  while (!open(si, sj)) si++;
  const q = [[si, sj]]; seen[sj * w + si] = 1;
  while (q.length) {
    const [i, j] = q.pop();
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ni = i + di, nj = j + dj;
      if (ni < 0 || nj < 0 || ni >= w || nj >= h || seen[nj * w + ni] || !open(ni, nj)) continue;
      seen[nj * w + ni] = 1; q.push([ni, nj]);
    }
  }
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) if (g[j][i] === '.' && !seen[j * w + i]) g[j][i] = 'x';
}

// Put spawns into a generated map. Returns new rows.
// team: [{ch, n}] for side A (left) and side B (right); positions are spread and kept apart.
export function populate(map, { left = [], right = [], rightDepth = 0.55, seed = 1 }) {
  const rng = makeRng(seed * 31 + 7);
  const g = map.rows.map((r) => r.split(''));
  const { w, h } = map;
  const used = [];
  const ok = (i, j) => {
    if (i < 1 || j < 1 || i >= w - 1 || j >= h - 1) return false;
    for (let y = j - 1; y <= j + 1; y++) for (let x = i - 1; x <= i + 1; x++) if (g[y][x] !== '.') return false;
    return used.every(([a, b]) => Math.abs(a - i) + Math.abs(b - j) >= 4);
  };
  const put = (ch, xmin, xmax, prefCover) => {
    let best = null, bs = -1e9;
    for (let k = 0; k < 160; k++) {
      const i = xmin + Math.floor(rng() * (xmax - xmin + 1)), j = 2 + Math.floor(rng() * (h - 4));
      if (!ok(i, j)) continue;
      let s = rng();
      if (prefCover) { let c = 0; for (let y = j - 2; y <= j + 2; y++) for (let x = i - 2; x <= i + 2; x++) if (g[y] && g[y][x] === '#') c++; s += c * 0.3; }
      if (s > bs) { bs = s; best = [i, j]; }
    }
    if (!best) return false;
    g[best[1]][best[0]] = ch; used.push(best);
    return true;
  };
  // player (or side A) near the left edge, centred-ish
  for (const { ch, n } of left) for (let k = 0; k < n; k++) put(ch, 1, 5, false);
  const xmin = Math.floor(w * (1 - rightDepth));
  for (const { ch, n, cover } of right) for (let k = 0; k < n; k++) put(ch, xmin, w - 2, !!cover);
  return g.map((r) => r.join(''));
}
