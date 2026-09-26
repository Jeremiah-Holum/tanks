// Map registry. loadMap(id, seed?) → MapData (see docs/DESIGN.md "Map data" and
// docs/notes/maps.md). Deterministic: the same (id, seed) gives the same map, byte for byte.
// The returned map is battle state (breakObject mutates it): load a fresh one per battle.
import { ashford } from './ashford.js';
import { kessel } from './kessel.js';
import { steppe } from './steppe.js';
import { kolvik } from './kolvik.js';

export { GROUND, OBJECT_KINDS } from './objects.js';

const GEN = { ashford, kessel, steppe, kolvik };

export const MAPS = [
  { id: 'ashford', name: 'Ashford Fields', theme: 'summer', seed: 1944,
    blurb: 'Rolling English-style farmland. Hedgerows and wheat in the west, the walled village of Ashford and its church in the centre, and Windmill Hill to the east: the hull-down prize both teams race for.' },
  { id: 'kessel', name: 'River Kessel', theme: 'summer', seed: 7,
    blurb: 'A river town split by a winding river. Two stone bridges lead into the brawl in Kessel\'s streets; shallow fords on each flank let flankers cross under the guns of the wooded heights.' },
  { id: 'steppe', name: 'Steppe Ridge', theme: 'autumn', seed: 42,
    blurb: 'Open autumn steppe cut by two long ridges facing each other across a valley. A burial mound in the middle, a hidden gully in the west and a collective farm in the east. Hull-down heaven, death for the careless.' },
  { id: 'kolvik', name: 'Kolvik Pass', theme: 'winter', seed: 1940,
    blurb: 'A snowbound valley between mountains. The railway embankment and Kolvik station hold the centre, Wolf Hill with its ruined fort overlooks the flanks, and dark pine forests hide the scouts.' },
];

export function loadMap(id, seed) {
  const meta = MAPS.find((m) => m.id === id) || MAPS[0];
  const gen = GEN[meta.id];
  const map = gen(seed ?? meta.seed);
  map.blurb = meta.blurb;
  return map;
}
