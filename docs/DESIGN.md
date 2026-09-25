# STEEL FRONT — design & build contract

Toy Tanks is being rebuilt into **Steel Front**: a single-player, browser World of Tanks–style
game. Real WWII tanks, realistic outdoor 1 km battlefields, WoT aiming and armour, 15v15 random
battles against bots, and a garage / tech tree / XP / credits progression loop. Desktop, mouse and
keyboard, three.js, no server. The old toy/Wii-Tanks code is being replaced; git history keeps it.

This file is the **contract between agents**. If you need to change something here, don't
just do it. Write the change you need into `docs/notes/<your-agent>.md` under "CONTRACT CHANGE
REQUESTS", and the PM will decide. Additions that break nothing (new optional fields, new
events, new exports) are fine: make them and list them in your notes file.

## Ground rules for every agent
- Only edit the files and directories you **own** (see Ownership). You may read anything.
- Don't `git commit`, `git push`, `git reset` or `git checkout` files: the PM commits between phases.
- Headless browser: **one at a time on the machine**. Always launch browsers through
  `tools/capped.sh -- node tools/<script>.mjs …` (it takes a machine-wide lock). Close the
  browser in `finally`. Use `--use-gl=angle --use-angle=swiftshader` and small viewports
  (≤1280×720) for screenshots. Never leave a browser or dev server running when you finish.
- Dev server: `python3 -m http.server 8477` from the repo root (start it in the background only
  if nothing is already listening on 8477; check with `curl -s localhost:8477 >/dev/null`).
- Pure ES modules, no TypeScript, no new runtime dependencies besides `three` (0.185.1, with
  its `three/examples/jsm/*` addons). Dev tools may use `playwright` and `esbuild`.
- Code style: match the existing repo: compact, commented where non-obvious, no framework.
- Write a short report in `docs/notes/<your-agent>.md`: what you built, how to test it, known
  gaps, and any contract change requests. Keep it up to date as you go, since a crash loses your context.

## Frames and units
- Metres, seconds, kilograms, degrees in data / radians in code, mm for armour and penetration.
- World: three.js convention, **+y up**. The map spans x ∈ [0, size], z ∈ [0, size].
- **Yaw** θ rotates about +y. Forward = (sin θ, 0, cos θ). θ = 0 faces +z.
- **Hull frame**: origin on the ground under the hull centre, +z forward, +y up, **+x = the tank's
  left**. The world transform is translate(pos) · rotY(yaw) · rotX(−pitch) · rotZ(roll), where
  pitch > 0 is nose up. Use `tankMatrix(tank)` from `src/sim/tank.js` (SIM owns it) and never
  rebuild it yourself.
- **Turret frame**: origin at `armor.turretPos` in the hull frame, rotated about +y by
  `tank.turretYaw` (relative to the hull). Casemate pieces (`fixed: true`) don't rotate. Only
  pieces with `gunYaw: true` (the mantlet) and the gun rotate by turretYaw.
- **Gun**: pivots at `armor.gun.pivot` (turret frame) and is pitched by `tank.gunPitch` (radians,
  + up). The muzzle is at pivot + len · dir.

## Tank definitions: `src/data/tanks.js` (SIM owns)
`export const TANKS = { [id]: TankDef }`, `export const NATIONS = { usa, germany, ussr }` (label,
paint colour, marking), and `export const TREE`, the research edges. Three nations, tiers I–VII,
~8 tanks each, all four classes per nation. Starters (tier I) cost 0 credits and are
pre-researched. Use historical approximations: iconic vehicles, believable armour and guns,
balanced like WoT (tier matters more than history).

```js
{
  id: 'usa_m4', name: 'M4 Sherman', short: 'M4', nation: 'usa', tier: 5,
  cls: 'light' | 'medium' | 'heavy' | 'td',
  price: 355000, xp: 13500,            // credits to buy; XP to research from a parent
  parents: ['usa_m3lee'],              // research edges also exported as TREE
  hp: 480, mass: 30.3, power: 400,     // tonnes, horsepower
  speed: 48, reverse: 20,              // km/h
  hullTraverse: 42, turretTraverse: 42,// deg/s
  terrain: [0.9, 1.1, 2.0],            // resistance on hard / medium / soft ground (lower = better)
  view: 360,                           // view range, m
  camo: { still: 0.16, moving: 0.08, fire: 0.6 }, // camo factors; fire = fraction kept after a shot
  crew: ['commander','gunner','driver','radioman','loader'],
  guns: [{                             // guns[0] is stock; later guns are researched on this tank
    name: '75 mm Gun M3', cal: 75, len: 3.0, muzzleBrake: false, xp: 0,
    reload: 3.4, aim: 2.1, disp: 0.43, // s, s (aim time), m at 100 m
    dMove: 0.18, dHull: 0.18, dTurret: 0.12, dShot: 4.0, // dispersion factors (see Aiming)
    dep: -10, elev: 25, ammo: 90,       // degrees, rounds carried
    shells: [
      { type: 'AP',   pen: 92,  dmg: 110, v: 619 },
      { type: 'APCR', pen: 127, dmg: 110, v: 774, gold: true },
      { type: 'HE',   pen: 38,  dmg: 175, v: 464, splash: 1.6 },
    ],
  }],
  hull:   { L, W, H, clr, engine: 'rear'|'front', ammo: 'hull'|'bustle'|'floor',
            track: { w, h, t, len, wheels, wheelR, style: 'vvss'|'hvss'|'christie'|'torsion'|'interleaved'|'leaf' },
            upper: { t, a, frac }, lower: { t, a }, side: { t, tUpper, a }, rear: { t, a }, roof, floor },
  turret: { shape: 'box'|'cast'|'casemate'|'open', z, zOff, L, W, H, ringR, chamfer, gunY,
            front: { t, a }, side: { t, a }, rear: { t, a }, roof, mantlet: { t, w, h, d },
            traverse: null | [-deg, +deg] },
  look:   { cupola, skirts, stowage, exhausts, number },   // optional cosmetic hints for the renderer
}
```
The armour parameters are interpreted **only** by `src/sim/armor.js` (`buildArmor`, `solidFaces`,
`rayConvex`, `rayBox`), which the PM wrote as the seed and SIM now owns. Angles `a` are measured
from vertical. The renderer builds hull, turret and track shapes from `solidFaces(piece.planes)`,
so the model and the hitbox are the same solid. It adds detail (wheels, track links, cupola,
tools, barrel) on top without changing the silhouette much.

## Map data: `src/sim/map/` (MAPS owns)
`import { MAPS, loadMap } from './sim/map/index.js'`. `MAPS` lists `{id, name, blurb, theme}`
and `loadMap(id, seed?) → MapData` is deterministic and runs in node in under 1.5 s.
```js
MapData = {
  id, name, size: 1000,                    // square, metres
  res: 257, cell: size/(res-1),            // height samples per side
  heights: Float32Array(res*res),          // row-major [j*res+i], x = i*cell, z = j*cell
  ground: Uint8Array(res*res),             // GROUND enum below
  water: null | { level },                 // water surface y; below level = water
  objects: [MapObject],                    // static props, see OBJECT_KINDS
  bases: [{ team: 0|1, x, z, r: 45 }],     // standard-battle capture circles
  spawns: [[{x,z,yaw} ×15], [{x,z,yaw} ×15]],
  points: [{ kind: 'sniper'|'hulldown'|'brawl'|'scout'|'flank'|'bush', x, z, team: 0|1|null, lane: 0..n, yaw? }],
  lanes: [{ name, path: [[x,z]...] }],     // for the AI: main approach routes
  nav: { cell: 8, cols, rows, cost: Float32Array }, // per-cell move cost; Infinity = impassable
  theme: { name: 'summer'|'autumn'|'winter'|'desert', sun: [x,y,z], fog, sky, tint },
}
GROUND = { GRASS:0, DIRT:1, ROAD:2, SAND:3, ROCK:4, MUD:5, SHALLOW:6, DEEP:7, FIELD:8, SNOW:9 }
MapObject = { id, kind, x, y, z, yaw, s: [sx,sy,sz] /* half-extents or scale */, variant: 0..n, hp? }
```
MAPS also owns **all** world-geometry queries (the sim, AI and camera use them). They live in
`src/sim/map/query.js`:
- `heightAt(map,x,z)`, `normalAt(map,x,z,out)`, `groundAt(map,x,z)`, `inBounds(map,x,z,margin)`
- `raycastTerrain(map, o, d, maxT) → t | -1` (o, d are `{x,y,z}`, d is a unit vector)
- `raycastObjects(map, o, d, maxT, filter) → {t, obj, nx,ny,nz} | null`: solid props only
  (buildings, rocks, walls). Fallen and destroyed objects are skipped.
- `objectsNear(map, x, z, r, cb)`: spatial hash query
- `foliageAlong(map, o, p) → 0..1`: how much bush and tree foliage the sight line o→p passes
  through (for camo). Also reports `nearTarget` foliage within 15 m of p.
- `OBJECT_KINDS[kind] = { solidShell, solidTank, breakable: 'crush'|'shoot'|null, foliage, crushMass }`
- `breakObject(map, obj, dirX, dirZ)` marks it fallen/destroyed (map state is mutable per battle).

Four maps, each with a character: rolling farmland and a village, a river town with bridges, a
hilly steppe with ridge lines for hull-down play, and a winter or desert map. Each needs three
lanes (flank / centre / flank), sniper bushes for TDs, a brawling area for heavies, scouting
bushes for lights, a clear red boundary, and fair mirrored-ish spawns. At most about 2500
objects (instanced trees and bushes count).

## Simulation: `src/sim/` (SIM owns everything here except `map/` and `ai/`)
Pure JS, deterministic given a seed, runs in node. Fixed step `DT = 1/60`.
```js
import { createBattle, stepBattle, DT } from './sim/battle.js'
createBattle({
  map, seed, timeLimit: 900, mode: 'standard',
  teams: [[Entry ×N], [Entry ×N]],  // N ≤ 15 each
}) → world
Entry = { def: TankDef, gun: 0, name, player: bool, bot: { skill: 0..1, role? } | null,
          ammo: [n,n,n], consumables: ['repair','medkit','extinguisher'], crewSkill: 0.5..1 }
stepBattle(world, controls /* Map<tankId, Controls> */)
Controls = { throttle: -1..1, steer: -1..1, brake: bool,
             aim: {x,y,z} | null,       // world point to aim at; the sim traverses and elevates towards it
             lockGun: bool,             // hold the current gun orientation
             fire: bool, shell: 0|1|2, use: null|'repair'|'medkit'|'extinguisher' }
```
World and tank shape (read-only for everyone else):
```js
world = { time, map, tanks: [Tank], shells: [Shell], events: [Event], result: null | {winner: 0|1|-1, reason},
          bases: [{team, x, z, r, points: 0..100, cappers: [ids]}], timeLimit, seed, rng }
Tank = { id, team, def, gunDef, name, player, bot,
  pos:{x,y,z}, yaw, pitch, roll, speed /* m/s signed */, yawRate,
  turretYaw, gunPitch, turretRate, gunRate,        // current rates (for dispersion & audio)
  hp, maxHp, alive, reload /* s left */, shell, ammo: [..],
  disp /* current dispersion radius at 100 m, m */, dispTarget,
  modules: { engine, ammoRack, fuel, gun, turretRing, trackL, trackR }  // each { hp, max, state: 'ok'|'damaged'|'destroyed', t? }
  crew: { commander: {alive}, ... }, fire: null | { t },
  consumables: [{ kind, ready: bool, cd }],
  spotted: bool /* seen by the enemy team right now: the sixth-sense lamp */,
  stats: { dmg, assist, blocked, kills, shots, hits, pens, received, spotted, capture, defended } }
Shell = { id, owner, team, type, pos:{x,y,z}, vel:{x,y,z}, cal, pen, dmg, alive, tracer }
```
Also exported for the HUD and camera: `tankMatrix(tank)`, `muzzle(tank)` (pos and dir),
`predictImpact(world, tank) → {x,y,z, dist, targetId|null}` (where the gun points now, including
drop), `aimSolution(world, tank, point) → {yaw, pitch, reachable}`, `penPreview(world, tank,
point, targetId) → {plate, eff, chance}` (reticle colour) and `visibleTo(world, team) → Set<id>`.

### Rules (World of Tanks, simplified)
- **Movement**: power-to-weight gives acceleration, top speed comes from the def, reduced on
  slopes (gravity) and by ground resistance (GROUND → hard/medium/soft). Hull traverse slows on
  soft ground. Pitch and roll follow the terrain under the tracks. Tank–tank collisions push by
  mass and do ram damage over about 15 km/h of closing speed. Trees and fences fall when rammed
  (`treeFall`). Buildings and rocks block. Deep water blocks (no drowning in v1). A destroyed track
  immobilises the tank for `repairT` (about 8 s, faster with 'repair').
- **Aiming**: the turret traverses at turretTraverse (hull traverse is added for TDs outside the
  gun arc), and gunPitch is clamped to [dep, elev] relative to the hull. The ballistic solution
  aims to hit `aim`, including drop.
  Dispersion: `dispTarget = gun.disp · sqrt(1 + (dMove·|speed km/h|/10)² + (dHull·|yawRate°|/10)² +
  (dTurret·|turretRate°|/10)²)`. After a shot, `disp *= dShot`-ish (cap it). `disp` relaxes to
  `dispTarget` with time constant `gun.aim / 3` (so full aim time ≈ 95%). The shot deviates by a
  truncated gaussian inside the circle (σ = radius/2, clipped at radius), angle = r/100 rad.
- **Ballistics**: shell speed = v · 0.8, gravity 9.81. Step the segment against terrain, solid
  objects and tanks, and take the earliest hit. Shells pass through foliage and ignore breakable
  props (knocking over trees they hit is fine). Max range 720 m.
- **Armour**: build the tank's world ray, transform it into each piece's frame and use `rayConvex`
  to get the earliest entry plate. Tracks are spaced armour: they absorb `t`, can be destroyed,
  and then the shell continues. Angle = between −dir and the plate normal.
  AP normalises by 5°, APCR by 2°, HEAT and HE by 0. Overmatch: calibre > 3·t means no ricochet;
  calibre > 2·t boosts normalisation by 1.4·cal/(2t). Auto-ricochet over 70° (AP/APCR, not
  HEAT/HE and not on overmatch). A ricochet reflects and keeps flying with full pen (it can hit
  something else). Effective thickness = t / cos(angle − norm). Pen rolls ±25% uniform, with
  falloff for AP/APCR: linear from 100 m to 500 m, down to −10% (AP) and −25% (APCR) at 500 m.
  **HE**: on penetration full damage; otherwise damage = max(0, dmg/2 − eff·1.1) to hp, plus
  splash to nearby tanks. Open-top roofs (t = 0) take full HE.
  **Damage** rolls ±25%. After a penetration the shell travels on inside for about 10 calibres
  (1.5–3 m) and hits modules and crew boxes on that line (`rayBox`). Modules have hp. Damaged
  engine = slower. Destroyed engine = immobile and high fire chance. Damaged gun = worse
  dispersion. Turret ring = slow traverse. Ammo rack damaged = slow reload, destroyed = instant
  kill (turret pops!). Fuel = fire chance. Dead crew: commander (−10% everything), gunner (aim,
  dispersion), driver (mobility), loader (reload), radioman (view). Medkit heals crew, repair
  fixes modules, extinguisher puts out fire (and auto-extinguish chance). Fire does about 1% hp/s.
- **Spotting** (every 0.5 s per team): an observer at turret-top height, target points on hull
  and turret, a clear sight line (terrain + solid objects), and an effective range of
  `view · (1 − camoFactor)` where camoFactor = tank camo (still or moving, × fire after shooting,
  for 5 s) plus foliage between them (bushes near the target count only while it hasn't fired).
  Auto-spot within 50 m; hard cap 445 m. A spotted tank stays visible for 3 s after the last
  sighting (`lastSeen`). Spotting damage counts towards the spotter's `assist`.
- **Standard battle**: 15v15, 15 minutes. Win by destroying every enemy or capturing their base
  (points +1/s per capper in the circle, max 3 cappers, max 100). Any damage to a capper resets
  that capper's contribution. A time-out is a draw.
- **Events** (`world.events` is cleared at the start of each step, so read it after stepBattle):
  `shot{tank, shell, pos, dir, cal}` · `impact{shell, pos, normal, surface, type}` ·
  `hit{shooter, target, shell, pos, normal, result: 'pen'|'nopen'|'ricochet'|'track'|'splash'|'crit', dmg, plate, eff, pen, crits:[...], crew:[...]}` ·
  `kill{killer, victim, cause: 'shot'|'fire'|'ammorack'|'ram'|'splash'}` · `fire{tank, on}` ·
  `module{tank, module, state}` · `crew{tank, role, alive}` · `spot{team, tank, on}` ·
  `treeFall{obj, dir}` · `objectBreak{obj}` · `ram{a, b, dmg}` · `capture{team, points}` ·
  `consumable{tank, kind}` · `reloaded{tank}` · `end{result}`.
  (PM rulings: `capture.team` is the team that OWNS the base being captured. Tank also exposes
  `throttle` (−1..1, the last applied control) for engine audio. Magazine guns: see docs/notes/sim.md.)

Performance budget: `stepBattle` under 2 ms average with 30 tanks in node (the AI is separate).
Tests: `tools/rules-test.mjs` (rewrite it): armour cases (Tiger front vs 75 mm AP at 100 m
bounces or fails to pen, side pens, overmatch, ricochet at 75°, tracks absorb, HE vs open top),
ballistics drop, dispersion convergence, spotting through bushes, capture and reset, determinism.

## AI: `src/sim/ai/` (AI owns, phase 2)
`createBrain(world, tank) → brain`, `brain.control(world) → Controls`, called every tick. Heavy
thinking is staggered (≤ 0.3 ms per bot per tick on average). Role behaviour by class (lights
scout and spot, TDs sit in sniper bushes, heavies push the brawl lane, mediums flex and support),
lane choice, A* over `map.nav`, using cover and hull-down points, angling armour (heavies),
aiming at weak plates with `penPreview`, waiting for aim, retreating when low, defending and
capturing the base, and not driving into each other. Skill 0..1 scales reaction, aim patience,
weak-spot knowledge, positioning and awareness. Bots only know what their team has spotted.

## Rendering: `src/render/`
- **RENDER-WORLD owns** `battleView.js`, `terrain.js`, `env.js` (sky, sun, shadows, fog, water),
  `props.js` (instanced trees, bushes, rocks, buildings, walls, fences; falling trees; destroyed
  buildings), `post.js`, `quality.js`, `textures.js`.
  ```js
  const view = new BattleView(canvas, { quality: 'low'|'medium'|'high' })
  view.loadMap(map)                    // builds the terrain and props
  view.frame(world, { cam: {pos, look, fov}, alpha, visible: Set<id>, playerId, dt, sniper: bool })
  view.setQuality(q); view.resize(); view.stats() → { calls, tris, ms }
  view.scene, view.camera, view.renderer   // for other render modules
  ```
  BattleView owns the render loop pieces. It calls `TankRenderer` and `FxRenderer` (below) and
  feeds them `world.events` each frame (every event that step produced, even with multiple steps
  per frame, so the caller passes them in: `frame(world, {…, events})`). Look target: realistic,
  late-afternoon European countryside, like WoT's HD maps. That means soft shadows, atmospheric
  fog and sky, detailed terrain textures (procedural or canvas-generated, since there are no
  binary assets), grass near the camera on medium/high, and good-looking trees.
  60 fps at 1080p on a mid-range GPU on medium.
- **RENDER-TANKS owns** `tankModel.js`, `tanks.js` (TankRenderer), `fx.js` (FxRenderer), `decals.js`.
  ```js
  buildTankModel(def, { paint, lod, gunIndex }) → { group, parts: { hull, turret, gun, mantlet, trackL, trackR, wheelsL, wheelsR }, update(tankState, dt) , setDamage({tracks, burning, dead}), dispose() }
  new TankRenderer(scene, quality); .sync(world, { visible, alpha, playerId, dt }); .handle(event)
  new FxRenderer(scene, quality); .handle(event, world); .update(dt, camera)
  ```
  Models come from `solidFaces` plus detail: road wheels by suspension style, animated track
  texture scroll, wheels spinning with speed, sprockets and idlers, cupola, hatches, tools,
  exhausts, spare track links, a barrel with a muzzle brake, nation paint and markings, tactical
  numbers, and PBR-ish metal with wear and dirt. Destroyed tanks are blackened, smoking and
  burning, with the turret blown off after an ammo rack kill. FX: muzzle flash plus a smoke ring
  and dust kicked up around the tank, tracers, ricochet sparks, non-pen sparks, pen flash and
  debris, HE explosions, ground impacts by surface, fire, smoke, track dust, exhaust puffs and
  shell holes. Keep FX pooled and cheap.

## Game shell: `src/main.js`, `src/game/`, `src/ui/hud.js` (INTEGRATION owns, phase 2)
Battle loop (fixed-step sim, interpolated render). Camera: arcade third-person orbiting the tank
by mouse, scroll zooms out and in, and past the closest zoom goes into **sniper mode** (Shift
toggles; ×2/×4/×8 zoom, from the gun, with a scope overlay). The aim point is a ray from the
camera through the screen centre against terrain, objects and tanks. RMB on an enemy = autoaim
lock (RMB again releases). Hold RMB with no target = lock the gun (free look). HUD, WoT-style:
aim circle (dispersion), gun marker from `predictImpact`, reload arc, pen-colour reticle, damage
panel (hp, modules, crew), shells 1/2/3 and consumables 4/5/6, minimap (M toggles size, only
spotted enemies, view-range circle), team lists and hp bars at the top, kill feed, damage and
received logs, hit ribbons ("Penetration", "Critical hit", "Ricochet", "No penetration"), capture
bars, timer, sixth-sense lamp, speed, damage-direction indicator, and a Tab score panel.
Spectate a teammate after death. Esc menu.

## Meta game and screens: `src/meta/`, `src/ui/` except `hud.js` (META owns)
- `src/meta/profile.js`: localStorage `steelfront.v1`, `{ credits, freeXp, gold: 0, tanks: {[id]: { owned, xp, guns: [researched idx], battles, wins, mastery, ammo, consumables, crewXp }}, researched: [ids], selected, settings, stats, history }`.
  Starts with the three tier-I tanks owned and 20,000 credits.
- `src/meta/economy.js`: rewards (XP and credits from damage, assist, kills, spotting, capture and
  survival, ×1.5 on a win, 5% free XP), service costs (repair and ammo), research, buy and sell.
  Mastery badges (Mastery / I / II / III) come from base XP compared with per-tier thresholds.
- `src/meta/matchmaker.js`: `buildBattle(profile, tankId, opts) → createBattle options`: 15v15 by
  default (7v7 option), ±1 tier spread (up to +2 for the top of tier), mirrored class counts,
  bot skill spread, fun bot names, random map.
- `src/meta/results.js`: `summarize(world, playerTankId, profile) → report`, then apply it.
- `src/ui/`: hangar (3D garage scene with the selected tank on a turntable, using
  `buildTankModel`; carousel of owned tanks; BATTLE! button; top bar with credits and XP),
  tech tree per nation (research and buy, with costs), tank details (stats, gun choice, an armour
  inspector colouring plates by thickness using `solidFaces`), ammo loadout and consumables,
  battle loading screen (team lists and the map), post-battle results (medals and ribbons), service
  record, settings (graphics quality, sensitivity, volumes, controls). Military UI look: dark
  gunmetal, amber accents, stencil headings (Google Fonts are allowed).
  API for INTEGRATION: `new Screens(rootEl, { onBattle(tankId), ... })` with `.showHangar()`,
  `.showLoading(battleOpts, mapMeta)`, `.showResults(report)`, `.hideAll()`. `index.html` loads
  `src/ui/ui.css` (and `tools/build.mjs` copies it).

## Audio: `src/audio.js` (AUDIO owns)
Web Audio synthesis (no files). Cannon by calibre (distance-filtered, with echo), engine loop
by rpm and load per tank (player close up, others positional), tracks clatter, turret whine,
reload clunk, hits (pen crunch, ricochet whine, non-pen clang, crits), explosions and ammo rack
blasts, fire crackle, UI clicks, a menu music loop, and battle ambience. Crew voice lines use
`speechSynthesis` (rate-limited, toggleable) for things like "Penetration!", "Ricochet!",
"Didn't penetrate!", "We've been spotted!" (sixth sense), "Engine damaged!", "Fire!",
"Target destroyed!" and "Reloaded".
`new Audio(); .unlock(); .setVolumes({master,sfx,music,voice}); .event(ev, world, listener); .engine(tank, listener); .ui(kind); .music(on); .say(line)`.

## Phases
1. **Now, in parallel**: SIM (+data), MAPS, RENDER-WORLD, RENDER-TANKS, META, AUDIO. Each
   tests its own piece with node tests or a lab page in `tools/` (e.g. `tools/lab-world.html`).
2. INTEGRATION (main, game, HUD, camera, input) + AI.
3. QA: `tools/verify.mjs` drives the full loop, a headless 15v15 bot-battle sim for balance,
   reviewer agents, fixes, and polish.
