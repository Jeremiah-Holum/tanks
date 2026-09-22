// Campaign missions and versus arenas. Each map is generated from a fixed seed, so every
// player gets the same battlefield; the roster says who holds the far side.
// Enemy letters: a rookie g grunt z zipper y sapper r burst n ricochet h hunter w ghost k boss; f = your ally.
import { generate, populate } from './mapgen.js';

const M = (name, theme, w, h, seed, roster, allies = 0, density = 1) => ({ name, theme, w, h, seed, roster, allies, density });
const SPECS = [
  M('First Contact',   'village', 34, 24, 101, { a: 2, g: 1 }),
  M('Crossroads',      'town',    36, 26, 202, { g: 2, a: 2 }),
  M('Hedgerows',       'farm',    38, 26, 303, { g: 3, a: 2 }),
  M('Long Street',     'town',    40, 28, 404, { z: 1, g: 2, a: 1 }),
  M('Shell Holes',     'craters', 40, 28, 505, { g: 3, z: 2, a: 1 }, 1),
  M('Minefield',       'farm',    40, 28, 606, { y: 2, g: 1, a: 1 }),
  M('Red Dawn',        'village', 42, 30, 707, { r: 2, z: 1, g: 2 }, 1),
  M('Bank Shot',       'town',    42, 30, 808, { n: 2, g: 2 }),
  M('Mixed Company',   'craters', 44, 32, 909, { r: 1, z: 1, g: 2, a: 2, n: 1 }, 1),
  M('Purple Rain',     'river',   44, 32, 1010, { h: 2, g: 3 }, 1),
  M("Sappers' Maze",   'farm',    44, 32, 1111, { y: 2, g: 2, r: 1, h: 1 }, 1, 1.3),
  M('Greenhouse',      'village', 44, 32, 1212, { n: 3, r: 1, h: 1 }, 1),
  M('Now You See Me',  'town',    44, 32, 1313, { w: 2, g: 2, h: 1 }, 1),
  M('Pincer',          'river',   46, 32, 1414, { h: 2, z: 2, g: 1 }, 2),
  M('The Gauntlet',    'fort',    46, 32, 1515, { r: 2, z: 2, h: 1, n: 1 }, 1),
  M('Sniper Alley',    'craters', 46, 32, 1616, { z: 3, n: 2, g: 2 }, 1),
  M('Haunted House',   'town',    46, 34, 1717, { w: 3, y: 1, h: 1 }, 2),
  M('Fortress',        'fort',    48, 34, 1818, { n: 2, h: 2, r: 2 }, 1),
  M('Elite Guard',     'town',    48, 34, 1919, { h: 3, w: 2, r: 1, n: 2 }, 3),
  M('The Commander',   'fort',    48, 34, 2020, { k: 1, h: 2, w: 1, n: 2 }, 2),
];
const STATIONARY = new Set(['a', 'n']);

export const CAMPAIGN = SPECS.map((s) => {
  const map = generate(s);
  const right = Object.entries(s.roster).map(([ch, n]) => ({ ch, n, cover: STATIONARY.has(ch) }));
  const left = [{ ch: 'P', n: 1 }, ...(s.allies ? [{ ch: 'f', n: s.allies }] : [])];
  return { name: s.name, theme: s.theme, rows: populate(map, { left, right, seed: s.seed }), props: map.props, allies: s.allies };
});

// Versus arenas: spawn digits 0-4 on the left, 5-9 on the right (mirror images).
const VS = [
  ['Toy Town', 'town', 44, 32, 31], ['Farmyard', 'farm', 44, 32, 32], ['No Man\'s Rug', 'craters', 44, 32, 33],
  ['The Creek', 'river', 44, 32, 34], ['The Keep', 'fort', 44, 32, 35], ['Hamlet', 'village', 40, 28, 36],
  ['Downtown', 'town', 48, 34, 37], ['Back Forty', 'farm', 48, 34, 38],
];
export const VERSUS = VS.map(([name, theme, w, h, seed]) => {
  const map = generate({ w, h, seed, theme });
  const g = map.rows.map((r) => r.split(''));
  // five spawn points per side, spread top to bottom near the edge, mirrored
  const ys = [0.5, 0.22, 0.78, 0.36, 0.64];
  ys.forEach((fy, k) => {
    let i = 2, j = Math.round(fy * (h - 1));
    const clear = (i, j) => [-1, 0, 1].every((dy) => [-1, 0, 1].every((dx) => g[j + dy] && g[j + dy][i + dx] === '.'));
    let tries = 0;
    while (!clear(i, j) && tries++ < 60) { i = 1 + (tries % 4); j = Math.max(1, Math.min(h - 2, j + (tries % 2 ? tries >> 1 : -(tries >> 1)))); }
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { g[j + dy][i + dx] = '.'; g[h - 1 - j - dy][w - 1 - i - dx] = '.'; }
    g[j][i] = String(k); g[h - 1 - j][w - 1 - i] = String(k + 5);
  });
  return { name, theme, rows: g.map((r) => r.join('')), props: map.props };
});
