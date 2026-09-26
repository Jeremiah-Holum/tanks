// Tank roster and map list for the meta game, re-exported from the data modules
// (src/data/tanks.js from SIM, src/sim/map/index.js from MAPS) plus a few derived helpers.
import * as data from '../data/tanks.js';
import { MAPS as maps } from '../sim/map/index.js';
export const TANKS = data.TANKS;
export const NATIONS = data.NATIONS;
export const TREE = data.TREE;
export const MAPS = maps;
export const STUB_TANKS = false, STUB_MAPS = false;

export const TANK_LIST = Object.values(TANKS);
export const NATION_IDS = Object.keys(NATIONS);
export const MAX_TIER = Math.max(...TANK_LIST.map((d) => d.tier));
export const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
export const CLASS_LABEL = { light: 'Light Tank', medium: 'Medium Tank', heavy: 'Heavy Tank', td: 'Tank Destroyer' };
export const childrenOf = (id) => TANK_LIST.filter((d) => (d.parents || []).includes(id));
export const starters = () => TANK_LIST.filter((d) => d.tier === 1 && !(d.parents || []).length);
