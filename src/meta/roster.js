// Tank roster and map list for the meta game. Uses the real data modules when present
// (src/data/tanks.js from SIM, src/sim/map/index.js from MAPS) and falls back to stubs, so the
// meta layer, its tests and the UI lab keep working while those land.
let data, maps;
try { data = await import('../data/tanks.js'); } catch (e) {
  if (!/Cannot find|Failed to fetch|ERR_MODULE_NOT_FOUND|404/i.test(String(e && (e.code || e.message)))) console.warn('[meta] src/data/tanks.js failed to load, using stub roster:', e);
  data = await import('./stubTanks.js');
}
try { maps = (await import('../sim/map/index.js')).MAPS; } catch (e) { maps = null; }

export const TANKS = data.TANKS;
export const NATIONS = data.NATIONS;
export const TREE = data.TREE;
export const STUB_TANKS = !!data.STUB;
export const STUB_MAPS = !maps;
export const MAPS = maps || [
  { id: 'farmland', name: 'Hartfeld', blurb: 'Rolling wheat fields around a quiet village. The windmill ridge overlooks everything.', theme: 'summer' },
  { id: 'river', name: 'Oderbrück', blurb: 'A river town split by two bridges. Brawl in the streets or snipe from the far bank.', theme: 'autumn' },
  { id: 'steppe', name: 'Kursk Steppe', blurb: 'Open steppe cut by long ridges: hull-down heaven, scout paradise.', theme: 'summer' },
  { id: 'winter', name: 'Frozen Pass', blurb: 'A snowbound valley with a frozen lake and a hamlet in the middle.', theme: 'winter' },
];

export const TANK_LIST = Object.values(TANKS);
export const NATION_IDS = Object.keys(NATIONS);
export const MAX_TIER = Math.max(...TANK_LIST.map((d) => d.tier));
export const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
export const CLASS_LABEL = { light: 'Light Tank', medium: 'Medium Tank', heavy: 'Heavy Tank', td: 'Tank Destroyer' };
export const childrenOf = (id) => TANK_LIST.filter((d) => (d.parents || []).includes(id));
export const starters = () => TANK_LIST.filter((d) => d.tier === 1 && !(d.parents || []).length);
