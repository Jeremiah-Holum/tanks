# RENDER-WORLD notes

Owner of `src/render/battleView.js`, `terrain.js`, `env.js`, `props.js`, `post.js`,
`quality.js`, `textures.js`, and `tools/lab-world.html`, `tools/lab-world.js`, `tools/shot-world.mjs`.
The old toy `view.js` is deleted. `textures.js` keeps a small LEGACY section at the bottom
(softDot, smokePuff, flame, scorchX, …) because the old `models.js` still imports it. Delete that
section when `models.js` goes away.

## API (as in the contract)
```js
import { BattleView } from './render/battleView.js'
const view = new BattleView(canvas, { quality: 'low'|'medium'|'high' })
view.loadMap(map, { time? })        // builds everything (≈1.5–3 s of JS on a desktop; the first call per theme generates the textures)
view.frame(world, { cam: {pos, look, fov}, alpha, visible, playerId, dt, sniper, events })
view.setQuality(q)                  // rebuilds terrain/props/shadow map for the loaded map (keeps the broken-prop state)
view.resize()                       // call on window resize (reads canvas.clientWidth/Height)
view.stats() → { calls, tris, ms }  // last frame: draw calls and triangles incl. the shadow pass and post; ms = CPU time of frame()
view.scene, view.camera, view.renderer
view.ready                          // Promise: resolves once TankRenderer / FxRenderer are loaded
view.heightAt(x, z)                 // rendered ground height (bilinear map + the scenery outside the map)
view.tanks, view.fx                 // the TankRenderer / FxRenderer instances (null until ready)
```
- `frame()` feeds every event in `events` (or `world.events` if omitted) to props (treeFall / objectBreak),
  `tanks.handle(ev)` and `fx.handle(ev, world)`, then calls `tanks.sync(world, {visible, alpha, playerId, dt, camera})`
  and `fx.update(dt, camera, world)`. FxRenderer is created first (TankRenderer finds it via `scene.userData.steelFx`).
- Props also watch `map.broken` (bumped by `breakObject`), so prop state stays right even if an event is missed.
- Sniper mode: near plane 1 m, grass hidden (like WoT), tree LOD distance scaled by zoom, the shadow map is
  centred on `cam.look`, plus slight chromatic aberration and a stronger vignette in post. The HUD draws the scope.
- Tone mapping, sRGB conversion and AA all happen in `post.js`. The renderer runs with `NoToneMapping`, and other
  modules' materials render into the HDR target like everything else.

## What's in it
- **terrain.js**: the 1 km heightfield in 4×4 chunks (513² vertices on medium/high, 257² on low; bilinear =
  `terrainHeightAt`), plus skirts along the map edge. The outer ring runs to 7 km with geometric spacing: it
  extrudes the edge profile, blurred along the edge so bumps don't become ridges, and blends into hills that
  frame the horizon. Rivers in `map.rivers` continue outward as carved channels.
  Splat material: 8 texture-array layers (grass, dirt, road, sand, rock, mud, field, snow) with height blending,
  two-scale anti-tiling, fade to average colour × un-tiled noise beyond ~50–240 m, detail normals (medium/high),
  rock on steep slopes, and macro hue/brightness variation. Fields come from `map.fields` (rows along each field's
  long side, crop colours wheat / barley / cabbage / stubble / sunflower). There is a patchwork of fields and woods
  outside the map and a red dashed line at `map.play`. A baked 1024² far-shadow texture (terrain horizon + tree,
  bush and building ground shadows) takes over from the realtime shadow map outside its range, and its AO channel
  darkens the ground under trees and buildings. Near-camera grass is one instanced draw: cards ≤ 0.45 m on GRASS
  only, cereal stalks on wheat / barley / stubble, fading out by 60 m (medium) or 80 m (high), with wind, and off
  in sniper mode.
- **env.js**: `THEMES` (summer, autumn, winter, desert: ground / foliage palettes, sky, sun, fog), `themeOf(map)`
  (uses `map.theme.sun` when present). It has an analytic sky dome with fbm clouds and a sun disc, a PMREM of the
  sky for image-based ambient, and a sun DirectionalLight with a stabilised (texel-snapped) shadow map that follows
  the view (PCF, Vogel-disk soft). The water plane's shader gives depth colour from the height texture, soft
  shorelines, foam, scrolling normals, a sky reflection with fresnel and sun glints. `SKY_GLSL` is shared with the
  post fog.
- **props.js**: two BatchedMeshes.
  - `vegetation`: 4 broadleaf species (oak, linden, birch, poplar), 4 conifers, 4 bushes and a hedge block, each
    with near/far LOD swapped by distance. Winter broadleaf trees are bare. Leaf-card crowns sit inside the camo
    ellipsoid, with spherical normals, alpha sharpening and a mip coverage boost, wind sway and leaf flutter, and
    back-light translucency. Forest trees (3+ neighbours within 9 m) get fuller crowns plus low undergrowth, which is
    visual only and < 0.9 m. The forests outside the map use far LOD.
  - `structures`: every solid prop is built in its local frame and textured from one 2048² atlas with fract()
    tiling. That covers houses (plaster, brick, stone, timber-frame; windows with shutters, doors, chimneys, barge
    boards), barns, sheds, the station, the church (nave plus tower with belfry and spire), ruins, walls, fences
    and sandbags (these four drape over the terrain), rounded haystacks, the windmill, silos, logs, wrecks, steel
    hedgehogs, stone bridges and boulders. Snow settles on roofs in winter.
  - Footprints follow `objectParts` / `foliagePart` in `sim/map/objects.js` (see docs/notes/maps.md).
  - Breaking: trees and fences topple about their base toward `obj.fallDir` (gravity ease plus a small bounce).
    Haystacks and bushes squash. Crushed walls, sandbags and sheds, and destroyed buildings, turn into a real-size
    rubble heap with wall stubs, masonry chunks and beams resting on it. Rubble geometry is built on demand and
    cached per size and material.
- **post.js**: HDR target (half float, float depth) → [depth SSAO, high] → [UnrealBloom threshold 1.6,
  medium/high] → composite: exponential height fog reconstructed from depth, lighter at combat range (at 445 m
  about 13 % summer / 18 % winter), full haze toward the horizon, sky-coloured in-scatter with a sun glow. Then
  exposure, ACES, a mild grade and vignette, and the sniper tweaks. Last comes FXAA (low/medium) or SMAA (high).
- **textures.js**: tileable value/gradient/Worley noise, the terrain layer arrays (512² × 8, albedo+height and
  normals), the macro noise, the water normals, the foliage atlas (broadleaf, small leaves, conifer spray, bare
  twigs, bark, birch bark), the grass/cereal atlas and the building atlas. All of it is cached per theme.
- **quality.js**: the tiers below.

## Quality tiers and measured cost
Headless SwiftShader cannot time the GPU, so these are counts from `view.stats()` at 1280×720 on Ashford. They
include the shadow pass and post quads, and exclude tanks (each visible tank adds about 8 calls and 5–15k tris,
from TankRenderer).

| tier | settings | village, tank eye (390,470 → E) | forest edge, tank eye (815,240) | overview 320 m up |
|---|---|---|---|---|
| low | 257² terrain, 1024 shadow / 110 m, no grass, no bloom/AO, FXAA, 900 outer trees | 29 calls, 0.30 M tris | 16 calls, 0.20 M | – |
| medium | 513² terrain, 2048 shadow / 150 m, grass r 60 m, bloom, FXAA, wind, 2600 outer trees | 44 calls, 1.03 M tris | 32 calls, 0.66 M | 45 calls, 1.06 M |
| high | 513² terrain, 4096 shadow / 220 m, grass r 80 m, bloom, SSAO, SMAA, DPR ≤ 2, 4200 outer trees | 50 calls, 1.42 M tris | 36 calls, 0.95 M | – |

Medium budget: about 1 M triangles and < 50 draw calls, well inside a GTX 1060 / RX 580 at 1080p. The costly parts
are fill: the terrain splat shader (usually 1–3 active layers per pixel, 2 samples each plus normals), alpha-tested
foliage and grass cards, and the post chain (fog composite, bloom mips, FXAA). If a real mid GPU misses 60 fps,
lower these first: `grass.radius` (60 → 45) and `detailNormals`, then `shadowMap` 2048 → 1536. CPU cost of
`frame()` is about 1–3 ms (BatchedMesh per-instance culling of about 5k vegetation instances, two passes).

## How to run the lab
```
python3 -m http.server 8477        # if nothing is listening on 8477
open http://localhost:8477/tools/lab-world.html?map=ashford&x=500&z=250&yaw=0&live=1   # drag = look, WASD/QE move
tools/capped.sh -- node tools/shot-world.mjs 'name=map=ashford&x=500&z=250&y=4&yaw=0&pitch=-3' ...
CENSUS=1 tools/capped.sh -- node tools/shot-world.mjs ...     # also prints visible meshes
```
Params: `map` (ashford, kessel, steppe, kolvik, test, or gallery for every prop kind and variant), `q`, `time`
(hour 6..20, overrides the sun), `x z` (ground point), `y` (eye height above ground), `yaw` (deg, 0 = +z),
`pitch`, `fov`, `dist` (orbit distance behind x,z), `sniper=1`, `tanks=1` (a 5v5 battle via sim/battle.js),
`spawn=k` (camera behind team-0 tank k), `knock=1&kx&kz&kr` (break props in a radius and play the animations),
`dbg=noshadow,nofog,nograss,noveg,nosolid,nofarshadow`. The shots go to `shots/world/<name>.png`. Shots with the
same map, q, time and tanks share one page load.

Useful shots: `shots/world/field.png` (wheat, hedges, haystacks), `v_medium.png` (village), `f_medium.png`
(forest edge), `tk1.png` / `far.png` (tank eye with tanks), `sn1.png` (sniper), `over.png` (overview),
`k2.png`, `wa1.png`, `wa2.png` (river), `st1.png` (autumn), `w1.png` (winter), `kn.png` (rubble), and
`gal1.png`, `gal3.png` (gallery).

## Known gaps
- Water reflects only the sky (plus darkening near banks). There are no planar reflections of banks or trees.
- Crater decals (`kind: 'crater'`) are not drawn. FxRenderer's decals cover shell holes.
- Church windows reuse the shuttered house window, which is a bit domestic.
- Tree shadows are right in the realtime range. Beyond it they come from the bake, so they don't sway and don't
  update when a tree falls.
- Loading is JS-heavy (texture synthesis and the splat upsample): ~1.5–3 s on desktop Chrome for the first map of
  a theme. It could move to a worker if the loading screen needs to animate.
- SSAO (high) is a simple depth-only estimate. It can halo slightly at silhouettes.

## CONTRACT CHANGE REQUESTS
- (additive) `loadMap(map, { time })` optional hour override. `view.ready`, `view.heightAt`, `view.tanks`,
  `view.fx` extra members.
- (additive) `frame()` passes `camera` to `TankRenderer.sync` and `world` to `FxRenderer.update` (both accept
  these per RENDER-TANKS' code).
