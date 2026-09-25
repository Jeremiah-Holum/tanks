# RENDER-TANKS notes

Owner of `src/render/tankModel.js`, `src/render/tanks.js`, `src/render/fx.js`, `src/render/decals.js`,
`tools/lab-tanks.html`, `tools/lab-tanks.js`, `tools/shot-tanks.mjs`. Screenshots in `shots/tanks/`.

## API (matches docs/DESIGN.md)
```js
import { buildTankModel } from './render/tankModel.js';
const m = buildTankModel(def, { paint, lod: 0|1, gunIndex, number });
//   paint: undefined (nation default; German tier ≥ V gets 3-tone camo seeded by tank id) |
//          'olive'|'dunkelgelb'|'dunkelgelb_camo'|'grey'|'4bo'|'winter' | '#rrggbb' | 0xrrggbb | {base, camoA, camoB}
//   number: tactical number (3 digits on the turret sides); def.look.number === true → derived from def.id
m.group                         // THREE.Group in the hull frame (origin on the ground under the hull centre)
m.parts = { hull, body, trackL, trackR, wheelsL, wheelsR, turret /* = yaw group */, turretMesh,
            mantlet, gun /* pitch group */, gunMesh, yaw, turretBase, numbers }
m.info  = { exhausts:[[x,y,z]], engine:[x,y,z], top, trackRear, trackFront, xT, muzzleLen, cal, recoil }
m.update({ turretYaw, gunPitch, speed, yawRate, recoil /* m */, bodyPitch, bodyRoll, bodyY }, dt)
m.setDamage({ tracks: [left, right] | {L, R} | bool, burning, dead, ammorack, seed })
m.setOpacity(a)                 // fade (swaps to transparent clones below 1)
m.dispose()

new TankRenderer(scene, quality)       // src/render/tanks.js
  .sync(world, { visible, alpha, playerId, dt, camera? })   // camera optional (else learned from the render pass)
  .handle(event)                        // shot → recoil + hull kick, hit → scar decal on hull/turret
  .prewarm(world)   // build both LODs now (~35 ms per new tank type), else built lazily on first sight
  .modelOf(id), .setQuality(q), .clear(), .dispose(), .stats()
new FxRenderer(scene, quality)          // src/render/fx.js (registers itself as scene.userData.steelFx)
  .handle(event, world)                 // shot, impact, hit, kill, treeFall, objectBreak
  .update(dt, camera, world?)           // once per rendered frame (also draws tracers from world.shells)
  .setQuality(q), .clear(), .dispose(), .stats()
  // continuous FX used by TankRenderer: trackDust, exhaust, fire, wreckSmoke; one-shots: muzzle,
  // blast, groundHit, splash, sparks, ricochet, penetration, explosion, dust
```
BattleView should call, per frame: `tanks.sync(world, {...})`, for each event of the steps this
frame `tanks.handle(e); fx.handle(e, world)`, then `fx.update(dt, camera, world)`. No other wiring:
TankRenderer finds the FxRenderer through `scene.userData.steelFx`.

## How it's built
- Hull/turret/mantlet = `solidFaces` of the armour pieces, each face drawn as a plate with a 3-ring
  bevel (tilted normals + an `edge` attribute for wear). Cast turrets (`shape: 'cast'`) are lofted
  from the solid's horizontal sections with Minkowski-rounded corners and a rounded top edge
  (always inside the hitbox). The cupola is `armor.cupola`'s prism (+ vision slits, hatch lid).
- Casemates: the gun + mantlet yaw about the gun pivot (x, z) exactly like `gunToWorld`.
- Running gear from `hull.track` (style vvss/hvss/leaf/torsion/christie/interleaved): wheel layout,
  sprocket (front drive except USSR, override `look.drive`), idler, return rollers, bogies/springs.
  The track is a band along the convex hull of the wheels with sag on top runs; link texture scrolls
  (uTravel) and geometric cleats/guide horns morph one pitch forward in the vertex shader, so the
  links really move. Wheels spin in the vertex shader (aSpin). Exposed tracks (`hull.sponson: false`)
  get full-length track guards.
- Detail: fenders, skirts (`look.skirts`), headlights, hull MG, driver visor/hatches, periscopes,
  engine deck grilles, tools, tow cable, spare links, exhausts (German mufflers, Soviet pipes, US
  deflector), stowage (US bedrolls, German bustle box, Soviet fuel drums when `look.stowage`),
  cupola, loader hatch, .50 cal (US), smoke dischargers (DE), handrails (SU), antennas,
  `look.miniTurrets` (T-28), `look.sponsonGun` (M3 Lee), open-top interiors (walls, ammo racks,
  radio, seats, breech). Barrel: tapered lathe from gun.cal/len with sleeve, muzzle swell or
  double-baffle brake, bore, evacuator (`gun.evacuator`).
- One shader for every surface (MeshStandardMaterial + onBeforeCompile): paint colour/camo from the
  material, per-vertex metal/rough/paint mask/edge/dirt; procedural mottling, rain streaks, edge wear
  and chips, mud on the lower hull, dust on top faces, charred variant for wrecks, marking atlas
  (US star, Balkenkreuz, red star, slogans, digits), track texture + bump. Geometry is cached per
  (def, lod, gun) and shared by all instances; materials are shared per paint scheme; the only
  per-instance materials are the two running-gear clones carrying uTravel (same program).
- Paint defaults: US Olive Drab, Soviet 4BO, German Panzergrau (tier ≤ III), Dunkelgelb (IV),
  3-tone camo (≥ V, pattern seeded per tank id). Markings: US star (hull sides, glacis), Balkenkreuz
  (hull sides, rear), Soviet slogans (hull sides) + red star (large turrets); tactical numbers.
- Triangles: near LOD 13–25k (Tiger 22k, M4 15.6k, T29 ~25k), far LOD 0.9–1.4k. Geometry build ≈ 35 ms
  per tank type (both LODs), cached. Draw calls per
  near tank ≈ 9 (hull, turret, mantlet, gun, numbers, 2×track, 2×wheels), far ≈ 4.
  LOD switch at 75 m (medium; 45 low / 110 high), scaled by camera fov/55 (sniper zoom keeps LOD0).

## FX
Two pooled instanced-quad particle systems (additive + alpha, one procedural atlas, CPU SoA
simulation, one upload per frame; streak mode for sparks/tracers), a small point-light pool for
flashes (medium 1, high 2, low 0), ground decals (instanced, ring buffer: crater/scorch/hole/splat)
and per-part tank scar decals (pen hole / non-pen gouge / ricochet streak). Surfaces from impact
`surface` (GROUND names, 'water', object kinds, 'tank'/'wreck'). Quality scales pool sizes,
spawn counts and lights.

## Lab
`tools/lab-tanks.html?…` (serve the repo root on 8477):
- `id=ger_tiger&yaw=35&elev=16&zoom=1&turret=30&gun=5&lod=0|1&paint=…&number=…`
- `dmg=tracks|trackL|burning|dead|ammorack&t=<s>`, `move=<m/s>` (track dust, wheel spin)
- `fx=shot|ricochet|nopen|pen|he|track|kill|tracer|impact:<surface>&shell=HE&ft=<s after>`
- `grid=1&nation=usa&per=16` roster tiles with tri counts; `battle=1&ids=a,b,c&t=20&cam=x,y,z,lx,ly,lz`
  runs the real sim (testMap + simpleBot) through TankRenderer/FxRenderer.
Screenshots: `tools/capped.sh -- node tools/shot-tanks.mjs [--w=1280 --h=720] shots/tanks name='query' …`

## Screenshots (shots/tanks/)
usa.png, ger.png, ussr.png (roster grids) · m4.png, m4c.png, tiger.png, t34.png, bt7.png, pz2.png,
lee.png, kv.png, marder.png, m10.png (open tops) · lod1.png · tracks.png (broken tracks) · ammo.png
(ammo rack) · fire.png, wreck.png · shot.png/shot2.png (muzzle 0.03 s / 0.6 s) · ric.png, nopen.png,
pen.png, he.png, tracer.png, dust.png · battle.png, battle2.png (real sim through the renderers).

## Gaps / TODO
- Track band silhouette differs a little from the armour 'track' piece ends (the piece's end planes
  lean the wrong way for a raised sprocket); the visual loop is inside the piece's length.
- Fade of unspotted enemies uses transparent material clones for ~0.25 s (sorted per object).
- Tracers are drawn at the current sim position (not interpolated between ticks).
- Old toy `src/render/models.js` is still imported by the old view.js/props.js/garage3d.js; delete it
  once RENDER-WORLD/META no longer import it. The old `FX` export of fx.js is gone (replaced).

## Contract change requests
- none blocking. Suggestion for SIM: the track piece end planes use normal (0, 0.35, ±1), which makes
  the hitbox longer at the bottom; real tracks are longer at the top (raised sprocket/idler).

## Silhouette pass (PM-authorised dimension edits in src/data/tanks.js)
Dimension/`look` fields only (no armour, guns or mobility): M2 Medium (narrow barbette body, exposed
tracks, small turret), M3 Lee (taller hull, `look.hullGun` = right-sponson 75 mm), T1 Heavy / M6
(taller slab hulls, wider tracks; M6 bigger turret), T29 (huge wide cast turret), T20 (long, low),
T25 AT (low casemate), MS-1 / T-26 / AT-1 / BT-7 (narrow low hulls, taller tracks, smaller turrets;
BT-7 four big Christie wheels), T-28 (exposed tracks, main turret back so the MG sub-turrets fit).
rules-test 91/91, meta-test 38/38. M6 near LOD is now ~29k tris (twin HVSS wheels).

## Fix: hull vanishing at low frame rates (PM bug, Leichttraktor at 'low')
The suspension spring on the model body (hull + turret; the tracks aren't under it) was integrated
with the raw frame dt; at ~7 fps it went unstable and spun the body out of view. It is now
sub-stepped at 1/120 s, dt is capped at 0.25 s, and pitch, roll and their rates are clamped (NaN-safe).
Lab: `fdt=<s>` simulates a slow frame rate; `grid=1&ids=a,b,…` shows chosen tanks.
