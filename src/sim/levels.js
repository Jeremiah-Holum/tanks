import { CAMPAIGN, VERSUS } from './maps.js';

const ENEMY = { a: 'rookie', g: 'grunt', z: 'zipper', y: 'sapper', r: 'burst', n: 'ricochet', h: 'hunter', w: 'ghost', k: 'boss', f: 'ally' };

// Any size: the grid takes its dimensions from the rows. `src` may be a level object
// ({rows, props, name}) or bare rows.
export function parseLevel(src) {
  const rows = Array.isArray(src) ? src : src.rows ? src.rows : String(src).trim().split('\n');
  const ROWS = rows.length, COLS = Math.max(...rows.map((r) => r.length));
  const grid = new Uint8Array(COLS * ROWS);
  const spawns = [];
  for (let j = 0; j < ROWS; j++) {
    const row = rows[j] || '';
    for (let i = 0; i < COLS; i++) {
      const ch = row[i] || '.';
      const x = i + 0.5, z = j + 0.5;
      let c = 0;
      if (ch === '#') c = 1;
      else if (ch === 'x') c = 2;
      else if (ch === 'o') c = 3;
      else if (ch === 'P') spawns.push({ kind: 'player', x, z });
      else if (ENEMY[ch]) spawns.push({ kind: ENEMY[ch], x, z });
      else if (ch >= '0' && ch <= '9') spawns.push({ kind: 'slot', slot: +ch, x, z });
      else if (ch === 'A' || ch === 'B') spawns.push({ kind: 'team', side: ch === 'A' ? 0 : 1, x, z });
      grid[j * COLS + i] = c;
    }
  }
  grid.cols = COLS; grid.rows = ROWS;
  return { grid, spawns, cols: COLS, rows: ROWS, props: (src && src.props) || [], name: (src && src.name) || '' };
}

export const CAMPAIGN_COUNT = CAMPAIGN.length;
export const VERSUS_COUNT = VERSUS.length;
export { CAMPAIGN, VERSUS };

// Enemy tally for the mission banner.
export function roster(level) {
  const { spawns } = parseLevel(level);
  const out = {};
  for (const s of spawns) if (!['player', 'slot', 'team', 'ally'].includes(s.kind)) out[s.kind] = (out[s.kind] || 0) + 1;
  return out;
}
