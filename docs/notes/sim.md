# SIM notes (src/sim/, src/data/tanks.js)

## What exists
| file | what |
|---|---|
| `src/data/tanks.js` | 47 tanks: USA 16, Germany 15, USSR 16, tiers I–VII, all four classes per nation, a TD/medium/heavy at VII for every nation. `TANKS`, `NATIONS`, `TREE` (`[{from,to,xp}]`), plus `CLASSES`, `TIER_ROMAN`, `STARTERS`, `tanksOf(nation)`. `finish()` fills price/xp by tier, camo by class and height, view, terrain, dispersion factors, shells, mantlet/track defaults. |
| `src/sim/armor.js` | seed API kept (`buildArmor`, `solidFaces`, `rayConvex`, `rayBox`). Added: `open: true` on a casemate (open-topped fighting compartment), `armor.cupola`, a `gun` module box (the breech), bigger crew boxes. |
| `src/sim/tank.js` | `tankMatrix`, `muzzle`, `gunPivot`, `eyePos`, `hullToWorld`/`worldToHull`/`hullDirToWorld`/`worldDirToHull`/`turretToWorld`, `createTank`, `rayArmor`, `rayModules`. |
| `src/sim/battle.js` | `createBattle`, `stepBattle`, `DT`, `makeRng`, rules (capture, win, time-out). It also re-exports the helpers below, so one import is enough. |
| `src/sim/move.js` | driving, slopes, ground resistance, hull traverse, terrain following, crushing/blocking props, deep water, bounds, tank–tank collisions and rams. |
| `src/sim/gunnery.js` | turret/gun laying, dispersion, firing, `aimSolution`, `predictImpact`, `penPreview`, `perf(t)` (crew/module factors). |
| `src/sim/ballistics.js` | shell flight vs terrain, water, solid props and tanks; `castShell` (no side effects). |
| `src/sim/damage.js` | armour resolution, tracks as spaced armour, ricochet/overmatch/normalisation, HE and splash, modules, crew, fire, consumables, kills, assists, capture reset. |
| `src/sim/spotting.js` | `visibleTo`, `canSee`, `viewRange`, `camoOf`, staggered team scans. |
| `src/sim/testmap.js` | `testMap(opts)` synthetic MapData, `simpleBot(tank)` scripted controller (for tests/bench only, it isn't the AI). |

Map queries come straight from `src/sim/map/query.js` (MAPS agent), so no adapter was needed in the end.
The old toy files (`world.js tanks.js levels.js game.js director.js mapgen.js maps.js ai.js`) are
**not deleted yet**: the old `src/main.js`, `src/ui.js`, `src/garage3d.js` and `tools/lab.js` still
import them. They are safe to delete once INTEGRATION replaces those four files.

## How to test
- `node tools/rules-test.mjs`: 78 checks, about 6 s, exits 1 on failure. It covers the roster and tree, closed solids, turret seating, gun pivot, modules inside the armour, armour cases, ballistics, dispersion, movement, rams, props, water, spotting, capture, rules, determinism, and a 60 s 15v15 smoke run on every real map.
- `node tools/bench-sim.mjs [--quick]`: 15v15 tier V–VII with `simpleBot`, on the test map and all real maps.

### Latest results
- rules-test: **78 passed, 0 failed**. Tiger front vs M4 75 mm AP: eff 100 vs pen 92, 32% pen chance head-on, 2/60 pens live when angled 30°. Tiger side vs 76 mm: 20/20. 37 mm glances off the Pz II side at 76°, and 75 mm overmatches it. A ricochet flies on and pens a second tank. 20 mm is absorbed by tracks, while 122 mm goes through the tracks into the hull. A destroyed track immobilises the tank and is repaired in 8 s. 75 mm HE does its full 175 into the M10's open turret and 44 on the KV-1's turret roof. The cupola (50) is weaker than the Tiger turret front (102). Shell drop matches g·t²/2 within 1 cm at 400 m. aimSolution plus predictImpact lands 3 m from the aim point at 460 m over hills. The M4 tops out at 48 km/h (34 on mud). Ramming Tiger → Pz II: 122 dmg, 10 self-damage.
- bench, full battles (15v15 tier V–VII, `simpleBot`): step avg **test 0.09, ashford 0.22, kessel 0.20, steppe 0.12, kolvik 0.19 ms** (budget 2 ms). Every battle ended: steppe by destruction at 1.4 min, the others by a 15-min time-out (the dumb bot drives straight at the base and gets stuck in villages and at rivers, which is expected; the real AI is phase 2). Spotting scan: median 0.07 ms, p95 0.2 ms. Single-step maxima of 5–20 ms line up with machine load (load average 5 on 4 cores while six agents run), not with scans or GC (scavenges ~0.1 ms). Pens/hits ~80%, ricochets ~7%, fires ~5% of pens, ammo racks ~2%.

## API notes beyond the contract (all additive)
- **Controls.steer: +1 = turn right** (yaw decreases, since yaw grows towards +x = the tank's left). A missing control = idle (brakes, gun held).
- **Event discriminator** is `e.type` (`'shot'|'impact'|'hit'|…`). The shell type in `impact` (and in `hit`/`shot`) is therefore `e.shellType`, not `type`. Event references are ids (`tank`, `shooter`, `target`, `killer`, `victim`, `a`, `b`, `shell`), except `treeFall.obj` / `objectBreak.obj`, which are the MapObject itself (it has `.id`).
- Extra event fields: `hit.shellType, hit.angle` (deg), `hit.result 'crit'` = non-pen with module damage. `shot.shellType`, `impact.cal`, `ram.selfDmg`, `treeFall.tank`. `capture{team: base owner (PM ruling), by: capturing team, points}`, and points 0 means the capture was reset. `reloaded{tank, clip}`.
- **Magazine guns** (`gun.clip = { n, t }`, currently the Pz II's and Leichttraktor's 2 cm): `tank.clipLeft` is the number of rounds left in the loaded magazine and `tank.clipSize = n`. After a shot, if `clipLeft > 0` then `reload = clip.t` (the intra-clip interval), otherwise the magazine reloads fully: `reload = gun.reload` and `clipLeft = n`. `reloaded` fires every time `reload` reaches 0, i.e. **per shell**, and carries `clip` (rounds ready). HUD: a full magazine reload is `reloaded` with `clip === clipSize`. Switching shell type with rounds left costs half a reload.
- Tank extras: `throttle` (last applied control, PM ruling), `crewSkill`, `armor` (= buildArmor(def)), `clipLeft`, `clipSize`, `lastShot` (time), `killedBy`, `deathCause`, `trackedBy`, `fireBy`, `lastSeen[team]`, `spottedBy[team]`, `rad` / `cy` (bounding sphere around pos + up·cy), `gunIndex`. `fire = { t, acc }`.
- World extras: `byId`, `visible: [Set, Set]` (what `visibleTo` returns), `step`, `nextShell`, `mode`. Bases carry `contrib` (points per capper) and `idle`. Points reset if the circle is empty for 5 s. `result.time`.
- Shell extras: `gold`, `splash`, `dist` (m flown), `ricochets`.
- `tankMatrix(t)` returns a **column-major 16-array** (`new THREE.Matrix4().fromArray(m)`).
- `muzzle(t)` uses the *current* gun's length (`t.gunDef.len`). `armor.gun.len` is only the stock gun's.
- `penPreview(...) → { plate, eff, chance, angle, ricochet, pen }`, and null when the line misses the target. `chance` = P(pen·U(0.75, 1.25) > eff) with distance falloff. Tracks add their thickness.
- `armor.cupola` (null for open tops, tier I and `look.cupola: false`): `{ name, frame: 'turret', kind: 'cupola', planes, fixed, c: [x, H, z], r, h }`. The placement is copied from `tankModel.js` turretDetails (US on the right, others on the left, 30% of the roof from the rear) so that model and hitbox agree. **RENDER-TANKS: consider building the cupola from these planes/c/r/h.** `look.cupola` now defaults to true except on open tops and tier I.
- `buildArmor().modules` gained `gun` (breech box, turret frame).
- Data extras: `turret.open` (open-topped casemate: Pz.Jg. I, Marder II, SU-76M), `gun.clip`, `gun.arc` (unused so far), `look.miniTurrets` (T-28), `look.sponsonGun` (M3 Lee).

## Rules as implemented (numbers)
- Movement: drive accel = min(0.65 g, P/(m·v)), rolling resistance 0.05·g·terrain, gravity along pitch, top speed and reverse from the def. Hull traverse ∝ (terrain[hard]/res)^0.6 and −30% at full speed. Damaged engine: 55% power and 80% top speed. Destroyed engine or a destroyed track: immobile. Dead driver: −20% power and turning. Water deeper than 1.3 m (or GROUND.DEEP) blocks. Props: `resolveCircle` with three circles along the hull. Crushable props (`breakable 'crush'` and `mass ≥ crushMass`) fall with a `treeFall` event.
- Collisions: three circles per tank, pushed apart by mass (wrecks count ×3). Ram damage above 15 km/h closing speed, enemies only: base = (kmh − 15)·μ·0.35, split by mass. The rammer takes half its share.
- Dispersion: contract formula. Class factors are ~5× WoT's listed numbers because the formula divides by 10 (a medium at 40 km/h blooms ~×3.4). The shot bloom is `disp = min(8·gun.disp, max(disp, target)·dShot)`. Gun elevation runs at 22°/s. Crew skill k = 0.85 + 0.15·skill scales reload, aim time, dispersion and traverse.
- Armour: contract rules. Turret-ring weak spot: the lowest 10 cm of a turning turret's walls counts as 60% thickness and damages the turret ring. Cupola: max(2·roof, 0.6·side). Mantlet: its thickness is final (a mantlet pen is a turret pen). Tracks absorb their effective thickness and take the shell's damage as module damage. HE bursts on tracks.
- After a pen the shell traces on for clamp(0.025·cal, 1.5, 3) m (HE 1.2 m). Each module on the path takes dmg·U(0.75, 1.25)·0.8^k. A crew member dies with p = clamp(dmg/(1.3·D_tier), 0.3, 0.9). A cupola pen kills the commander 75% of the time. Module hp = D_tier × (engine 1.5, ammo 1.7, fuel 1.8, gun 1.4, ring 1.4, tracks 1.0). A module is damaged below 70% and destroyed at 0. Destroyed modules field-repair to 40% in `REPAIR_T` (tracks 8 s, engine 14 s, gun and ring 10 s). The repair kit restores everything to full.
- Fire: engine hit 15% (destroyed 45%), fuel 25% (destroyed 50%). 1.1% max hp/s. After 4 s, an 8%/s chance to go out by itself. The extinguisher puts it out and gives 10 s immunity. Cooldowns: repair and medkit 90 s, extinguisher 60 s. A consumable use is refused (not spent) when there's nothing to fix.
- No team damage: allied shells and rams do nothing (shells still stop on allies, with an `impact` event with surface `'tank'`). Wrecks stop shells (`'wreck'`).
- Assist: damage to a target you tracked (until the track is repaired), or else one your team first-spotted (the `spottedBy` of the shooter's team).

## Known gaps / ideas
- No gun-depression limits over the rear deck, no HEAT loss after spaced armour, no shell-vs-gun-barrel hits, no tree knock-down by shells.
- Tank–prop collision uses circles, so long hulls can clip building corners by a few cm.
- `stats.spotted` counts first sightings per battle (WoT-like). The assist attribution is simplified.
- Ammo-rack pops happen in ~1–3% of pens in the bench (WoT-like). Fire ~5%.

## Contract change requests
- None blocking. Please bless as contract: `steer +1 = right`, events keyed by `type` with `shellType` for the shell type, `capture.by`, the magazine fields above.
