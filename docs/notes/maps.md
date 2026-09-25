# MAPS agent notes

Owner of `src/sim/map/` (index, query, objects, nav, build, noise, one file per map),
`tools/maps-test.mjs` and `tools/map-preview.mjs`. Previews live in `docs/notes/maps/`.

## How to test / look
```
node tools/maps-test.mjs            # all maps: load, determinism, layout, queries, perf (≈10 s)
node tools/maps-test.mjs kessel     # one map
node tools/map-preview.mjs --nav    # docs/notes/maps/<id>.png (+ <id>-nav.png)
```
Preview legend: hill shading + 5 m contours (dark every 25 m), ground colours (grass, dirt,
road, sand, rock, mud, shallow, deep, field, snow), props drawn as their **collision
footprints** (houses red with the roof ridge line, church beige, walls grey, fences brown,
hedges dark green, bushes light green, tree crowns green with a trunk dot, rocks grey,
haystacks yellow, bridges dark brown), red line = play-area boundary, blue/red rings = team
0/1 bases, small blue/red dots = spawns (tick = yaw), lanes (yellow / white / cyan = lane
0 / 1 / 2), AI points: magenta sniper, orange hulldown, red brawl, cyan scout, yellow flank,
lime bush (inner dot = team colour, tick = yaw). Nav image: grey = road, green→red = cost,
black = impassable.

## API (all in `src/sim/map/`)
```js
import { MAPS, loadMap, GROUND, OBJECT_KINDS } from './sim/map/index.js'
MAPS = [{ id, name, theme, seed, blurb }]           // ashford, kessel, steppe, kolvik
loadMap(id, seed?) → MapData                        // deterministic; fresh object per call (battle state)

import { heightAt, terrainHeightAt, normalAt, slopeAt, groundAt, waterDepthAt, inBounds, clampToBounds,
         raycastTerrain, raycastObjects, raycast, lineClear, objectsNear, resolveCircle,
         foliageAlong, breakObject, bridgeAt, objectParts, foliagePart } from './sim/map/query.js'
import { findPath, simplify } from './sim/map/nav.js'   // A* over map.nav (optional helper)
```
- `heightAt(map,x,z)`: **drivable surface**: the bilinear terrain, or a bridge deck where one
  covers (x,z). `terrainHeightAt` = terrain only (what RENDER-WORLD meshes).
- `normalAt(map,x,z,out?)` (central differences over ±1 m of heightAt), `slopeAt` (degrees).
- `groundAt(map,x,z)`: GROUND of the nearest sample; bridge decks read as ROAD.
  `GROUND_CLASS` in objects.js maps ground → TankDef.terrain index (0 hard, 1 medium, 2 soft).
- `waterDepthAt(map,x,z)`: metres of water (0 when dry / on a bridge). Fordable ≤ 1.1 m
  (SHALLOW); DEEP is > 1.1 m and nav-impassable.
- `inBounds(map,x,z,margin)`: inside `map.play` = {min: 50, max: 950} (the red line). The
  outer 50 m ring is scenery (terrain rises, trees) and is nav-impassable.
- `raycastTerrain(map,o,d,maxT) → t | -1`: exact against the bilinear surface (2D DDA over
  height cells, per-cell max-height skip, closed-form quadratic per cell) so grazing rays and
  thin crests are handled without step artefacts. Returns 0 if o is under the ground. Terrain
  only (bridge decks are props).
- `raycastObjects(map,o,d,maxT,filter) → {t,obj,nx,ny,nz} | null`. filter: `'shell'`
  (default; kinds with solidShell), `'sight'` (same), `'tank'` (solidTank), `'any'`, or
  `fn(obj, kindDef) → bool`. Fallen/destroyed props are always skipped. If o starts inside a
  part, t = 0 and n = −d.
- `raycast(map,o,d,maxT,filter)`: terrain + props, nearest; `obj: null` for terrain.
- `lineClear(map,a,b,filter)`: segment clear of terrain and props (spotting helper).
- `objectsNear(map,x,z,r,cb)`: every prop whose bounding circle meets the circle, once;
  includes fallen ones (check `obj.fallen/destroyed`); `cb` returning true stops.
- `resolveCircle(map,x,z,r,filter='tank') → {x,z,hits}`: pushes a circle out of blocking
  footprints (walls boxes, cylinders, rocks at 0.85× their ellipse). Handy for tank vs props.
- `foliageAlong(map,o,p) → { amount, nearTarget, far }` (all 0..1). Each foliage volume the
  sight line crosses contributes `kind.foliage × min(1, chord/1 m)`, combined 1 − Π(1 − f).
  Volumes whose chord ends within 15 m of p → `nearTarget` (the target's own bush; drop it
  after the target fires). Volumes starting within 15 m of o are ignored (your own bush does
  not blind you). `far` = everything else, `amount` = both combined.
- `breakObject(map,obj,dirX,dirZ) → bool`: crushable props set `obj.fallen = true` and
  `obj.fallDir` (yaw the top falls towards = atan2(dirX, dirZ)); shootable ones set
  `obj.destroyed = true`. Bumps `map.broken` (a counter renderers can watch).
- Index: built lazily on first query and cached as non-enumerable `map._q` (rebuilt if
  `map.objects` is replaced). `loadMap` builds it eagerly.

### MapData additions (beyond the contract; all optional for consumers)
`play: {min,max}` · `roads: [{kind:'road'|'track'|'rail', width, path:[[x,z]…]}]` (crisp
centre lines for the terrain shader; ground is also painted ROAD/DIRT) · `rivers: [{path,
halfW}]` · `fields: [{x,z,w,d,yaw,crop,poly}]` (crop: wheat, barley, cabbage, stubble,
sunflower) · `blurb` · `seed` · theme = `{ name, sun:[x,y,z] (unit-ish direction TO the sun),
fog:{color,density}, sky:{top,horizon}, tint }` · points may omit `yaw` (brawl/flank) ·
lanes run from the team-0 base to the team-1 base (team 1 walks them reversed).

## Object conventions and collision shapes (RENDER-WORLD: make meshes match these)
`MapObject = { id, kind, x, y, z, yaw, s:[sx,sy,sz], variant }`
- (x,y,z) = base point; y = ground under the prop (solids use the minimum ground height
  over their footprint minus 0.15 m, so meshes should extend a little below y).
- yaw = three.js `rotation.y`. Local +x → world (cos yaw, 0, −sin yaw); local +z → world
  (sin yaw, 0, cos yaw).
- s = half-extents in the local frame. The prop spans y .. y+2·sy (rocks: see below).
- Houses, barns, sheds, stations, churches have their **ridge along local x**.

| kind | shells | tanks | break | foliage | collision parts (local frame, base at y) |
|---|---|---|---|---|---|
| tree, pine | – | yes | crush (any mass) | 0.5 / 0.45 | trunk cylinder r = clamp(0.07·sx, 0.15, 0.5), y..y+2sy. Crown (foliage only) = ellipsoid centre y+1.3sy, semi-axes (sx, 0.7sy, sz) |
| bush | – | – | – | 0.5 | foliage ellipsoid centre y+sy, semi-axes s |
| hedge | – | – | – | 0.6 | foliage box centre y+sy, half s (long axis local x) |
| haystack | – | – | crush | 0.6 | foliage cylinder r = sx, height 2sy |
| rock | yes | yes | – | – | ellipsoid centred **at y** (half buried), semi-axes s |
| house, barn, shed, station | yes | yes | shed: crush ≥25 t | – | walls box half (sx, 0.6sy, sz) from y to y+1.2sy; gable roof prism from y+1.2sy to y+2sy, footprint (sx,sz), ridge along local x |
| church | yes | yes | – | – | tower at local +x: box centre x = sx−tw, half (tw, sy, tw), tw = 0.75sz, full height 2sy. Nave: house shape centred at x = −tw, half-length sx−tw, half-width sz, height sy (walls 0.6sy + roof 0.4sy) |
| ruin | yes | yes | – | – | two walls (L): back wall box centre z = −sz+0.3, half (sx, sy, 0.3); side wall box centre x = −sx+0.3, half (0.3, 0.75sy, sz), height 1.5sy |
| wall | yes | yes | crush ≥30 t | – | box half s (long axis local x) |
| fence | – | yes | crush | – | box half s |
| sandbags | yes | yes | crush ≥20 t | – | box half s |
| wreck | yes | yes | – | – | box half s (variant 3 = railway wagon, long axis local z) |
| logs | yes | yes | – | – | box half s (log pile, logs along local x) |
| tank_trap | – | yes | – | – | cylinder r = sx, height 2sy (steel hedgehog) |
| windmill, silo | yes | yes | – | – | cylinder r = sx, height 2sy (silo also used for water towers) |
| bridge | yes | no (driven on) | – | – | deck box half s, top at y+2sy (= heightAt on the deck); long axis local z |
| crater | – | – | – | – | decal only |

`navBlock` kinds (rock, buildings, wall, sandbags, wreck, logs, tank_trap, windmill, silo)
are walls in `map.nav` (footprint + 1.2 m).

## Nav grid
125×125 cells of 8 m. cost = ground cost (road 0.8, grass/dirt 1, field 1.15, rock 1.1,
snow 1.2, sand 1.3, mud 1.7, shallow 2.2) + slope cost (0 below 12°, rising to 1.5 at 24°,
5.5 at 30°, Infinity above 30°) + 0.25 per tree / 0.4 per fence. Infinity: deep water (unless
on a bridge), blocking props, outside the play area.

## The maps
All 1000 m, play area 900 m (50–950), bases r 45, 15 spawns/team in a 5×3 staggered block.
Team 0 always spawns south (z small) facing north.
- **Ashford Fields** (summer, mirror across z=500). West: hedgerow fields in a shallow
  valley, two farmsteads, haystacks, knolls for snipers. Centre: Ashford village on a low
  rise, church (26 m tower) in a walled square, main street N–S, side streets, gardens with
  walls, orchards (brawl). East: Windmill Hill, a 19 m whaleback on the axis: the hull-down
  duel. Copses and walls break up the pasture between.
- **River Kessel** (summer, 180° rotation). The Kessel (water level 20 m) winds W→E in an
  S-curve; deep (3.3 m) except two fords (0.75 m, 48 m wide) at x≈170 / 830. Kessel town on
  both banks at quay level, two stone bridges (12 m wide decks), quay streets with sandbags,
  churches, ruins, wrecks (brawl). Each team has a wooded hill (Kessel Heights) over one ford
  and a walled farm with silo and orchard by the other.
- **Steppe Ridge** (autumn, mirror across z=500). Two 7–10 m ridges face each other across
  the valley (saddles at x≈335 / 655 for the lanes): hull-down lines. The kurgan (13 m mound)
  in the middle. West: the balka, a 7 m deep gully with scrub for a hidden flank. East: the
  Krasny Put' collective farm (cow sheds, silos, water tower, workers' houses) for brawling.
  Shelterbelts (tree rows) and haystacks.
- **Kolvik Pass** (winter, 180° rotation). Mountain walls east and west. A 3.5 m railway
  embankment crosses the valley with three level crossings (tank traps, sandbags), freight
  wagons on the line, Kolvik station and log cabins in the centre (brawl). Wolf Hill (26 m,
  ruined fort on top, rocky faces) guards each team's west/east, logging forests with a
  sawmill and log piles on the other flank.

## Status / test numbers (latest run)
`node tools/maps-test.mjs`: **1356/1356 checks pass** (also with `--seed 1/2/3/77/2024`).
Checks: load < 1.5 s, determinism (sha1 of heights/ground/nav/objects/layout), a different
seed changes the map, ≤ 2500 objects, steep (>25°) share < 8 %, 15 spawns/team in bounds,
passable, dry, slope < 20°, clear of props, spaced ≥ 8 m; every spawn reaches both bases
by A*; spawn→enemy-base path cost balanced within 10 %; 3 lanes base→base on passable cells;
every point kind for both teams; sniper/bush points have foliage; nav connectivity > 97 %;
hull-down points have a 0.6–2.6 m crest 4–10 m ahead (≥ 75 %); sniper mean view > 150 m;
vertical rays exact (< 1e-3 m); 400 oblique + grazing rays agree with 1 cm brute-force
marching (max err ≈ 0.01 m); prop rays from the side / top; tree crush; foliage cases;
bridges drivable.

| map | load | objects | heights | spawn→enemy base cost t0 / t1 | 10k×500 m rays terrain / props / foliage(300 m) |
|---|---|---|---|---|---|
| ashford | 250–350 ms | 1806 | 20–62 m | 799 / 801 | 21 / 41 / 38 ms |
| kessel  | 190–300 ms | 1621 | 17–70 m | 759 / 753 | 7 / 29 / 19 ms |
| steppe  | 140–180 ms | 990  | 28–72 m | 841 / 831 | 5 / 13 / 17 ms |
| kolvik  | 110–130 ms | 1915 | 30–105 m | 895 / 896 | 6 / 18 / 19 ms |

100k heightAt ≈ 10 ms; 10k resolveCircle 6–30 ms. SIM's `tools/rules-test.mjs` (which runs
a minute of 15v15 on every real map) passes 78/78 against these maps.

Previews: `docs/notes/maps/{ashford,kessel,steppe,kolvik}.png` (+ `-nav.png`).
`--crop x0,z0,x1,z1 --scale 3` renders a close-up (e.g. a village).

## Generator structure
`build.js` MapBuilder: symmetric fbm base + detail (mirror or 180° rotation for fairness),
bumps / ridges / trenches / berms (short earth banks that make guaranteed hull-down spots),
flatten, roads (graded along a smoothed profile), rivers (position-dependent width, bank and
depth: fords are just shallow stretches), ground painting (fields, slope → rock, water depth
→ shallow/deep, wet banks → mud/sand), a 2 m occupancy grid (FREE/VEG/KEEP/SOLID) so props
never overlap roads, spawns or each other, prop helpers (street plans of houses with gardens,
mirrored twins, walls/fences/hedges split into ≤ 12–14 m segments with gaps, forests,
scatter), then finish(): nav, spawns (5×3 block, nudged to clear flat ground), points (team 0
defs mirrored for team 1; hull-down snapped once and mirrored; bushes dressed around the
final positions), lanes (A* through waypoints, RDP-simplified). Each map file is ~100–170
lines of layout on top of it.

## Known gaps
- Water is one global level per map (`water.level`); raycastTerrain ignores the water surface
  (shells into rivers hit the river bed; the sim can test `y < water.level` for splashes).
- Bridge decks are a single box; there are no railings in collision.
- Foliage for fallen trees is dropped entirely.
- Points: Kolvik has 6 hull-down points (the embankment), Wolf Hill itself is too steep for
  one; Steppe's kurgan is a brawl point (it is a round mound, no natural lip).
- Terrain is exactly symmetric at large scale (plus 0.2 m of asymmetric detail); props are
  mirrored for buildings/walls/hedges but vegetation scatter is independent per side.
- `objectsNear` must not be nested inside its own callback (shared visit stamps).
- Unknown map id in `loadMap` falls back to the first map.

## CONTRACT CHANGE REQUESTS
- (none blocking) `foliageAlong` returns `{amount, nearTarget, far}` rather than a bare
  number, as the PM's brief asked. `heightAt` includes bridge decks (use `terrainHeightAt`
  for the raw terrain).
