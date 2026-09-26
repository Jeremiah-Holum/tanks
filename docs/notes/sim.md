# SIM notes (src/sim/, src/data/tanks.js)

## What exists
| file | what |
|---|---|
| `src/data/tanks.js` | 59 tanks: USA 20, Germany 19, USSR 20, tiers I–X (post-war VIII–X, see "Tiers VIII–X" below), all four classes per nation, a TD/medium/heavy at VII for every nation. `TANKS`, `NATIONS`, `TREE` (`[{from,to,xp}]`), plus `CLASSES`, `TIER_ROMAN`, `STARTERS`, `tanksOf(nation)`. `finish()` fills price/xp by tier, camo by class and height, view, terrain, dispersion factors, shells, mantlet/track defaults. |
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
- `node tools/rules-test.mjs`: 91 checks (including a 'Review regressions' section), about 6 s, exits 1 on failure. It covers the roster and tree, closed solids, turret seating, gun pivot, modules inside the armour, armour cases, ballistics, dispersion, movement, rams, props, water, spotting, capture, rules, determinism, and a 60 s 15v15 smoke run on every real map.
- `node tools/bench-sim.mjs [--quick]`: 15v15 tier V–VII with `simpleBot`, on the test map and all real maps.

### Latest results
- rules-test: **91 passed, 0 failed**. Tiger front vs M4 75 mm AP: eff 100 vs pen 92, 32% pen chance head-on, 2/60 pens live when angled 30°. Tiger side vs 76 mm: 20/20. 37 mm glances off the Pz II side at 76°, and 75 mm overmatches it. A ricochet flies on and pens a second tank. 20 mm is absorbed by tracks, while 122 mm goes through the tracks into the hull. A destroyed track immobilises the tank and is repaired in 8 s. 75 mm HE does its full 175 into the M10's open turret and 44 on the KV-1's turret roof. The cupola (50) is weaker than the Tiger turret front (102). Shell drop matches g·t²/2 within 1 cm at 400 m. aimSolution plus predictImpact lands 3 m from the aim point at 460 m over hills. The M4 tops out at 48 km/h (34 on mud). Ramming Tiger → Pz II: 122 dmg, 10 self-damage.
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
- `hull.sponson` (default true): false builds the upper hull only W wide (between the tracks, still sloped by side.a), so the tracks are exposed from above. Set on T1, M2 LT, Leichttraktor, Pz II, Pz.Jg. I, Pz 38(t), MS-1, T-26, AT-1, BT-7. The M3 Stuart, SU-76M and Marder II keep their sponsons (historically overhanging).
- Data extras: `turret.open` (open-topped casemate: Pz.Jg. I, Marder II, SU-76M), `gun.clip`, `gun.arc` (unused so far), `look.miniTurrets` (T-28), `look.sponsonGun` (M3 Lee).

## Rules as implemented (numbers)
- Movement: drive accel = min(0.65 g, P/(m·v)), rolling resistance 0.05·g·terrain, gravity along pitch, top speed and reverse from the def. Hull traverse ∝ (terrain[hard]/res)^0.6 and −30% at full speed. Damaged engine: 55% power and 80% top speed. Destroyed engine or a destroyed track: immobile. Dead driver: −20% power and turning. Water deeper than 1.3 m (or GROUND.DEEP) blocks. Props: `resolveCircle` with three circles along the hull. Crushable props (`breakable 'crush'` and `mass ≥ crushMass`) fall with a `treeFall` event.
- Collisions: three circles per tank, pushed apart by mass (wrecks count ×3). Ram damage above 15 km/h closing speed, enemies only: base = (kmh − 15)·μ·0.35, split by mass. The rammer takes half its share.
- Dispersion: contract formula, relaxing with τ = gun.aim (PM ruling). Class factors are ~5× WoT's listed numbers because the formula divides by 10 (a medium at 40 km/h blooms ~×3.4). The shot bloom is `disp = min(8·gun.disp, max(disp, target)·dShot)`. Gun elevation runs at 22°/s. Crew skill k = 0.85 + 0.15·skill scales reload, aim time, dispersion and traverse.
- Armour: contract rules. Turret-ring weak spot: the lowest 10 cm of a turning turret's walls counts as 60% thickness and damages the turret ring. Cupola: max(2·roof, 0.6·side). Mantlet: its thickness is final (a mantlet pen is a turret pen). Tracks absorb their effective thickness and take the shell's damage as module damage. HE bursts on tracks.
- After a pen the shell traces on for clamp(0.025·cal, 1.5, 3) m (HE 1.2 m). Each module on the path takes dmg·U(0.75, 1.25)·0.8^k. A crew member dies with p = clamp(dmg/(1.3·D_tier), 0.3, 0.9). A cupola pen kills the commander 75% of the time. Module hp = D_tier × (engine 1.5, ammo 1.7, fuel 1.8, gun 1.4, ring 1.4, tracks 1.0). A module is damaged below 70% and destroyed at 0. Destroyed modules field-repair to 40% in `REPAIR_T` (tracks 8 s, engine 14 s, gun and ring 10 s). The repair kit restores everything to full.
- Fire: engine hit 15% (destroyed 45%), fuel 25% (destroyed 50%). 1.1% max hp/s. After 4 s, an 8%/s chance to go out by itself. The extinguisher puts it out and gives 10 s immunity. Cooldowns: repair and medkit 90 s, extinguisher 60 s. A consumable use is refused (not spent) when there's nothing to fix.
- No team damage: allied shells and rams do nothing (shells still stop on allies, with an `impact` event with surface `'tank'`). Wrecks stop shells (`'wreck'`).
- Assist: damage to a target you tracked (until the track is repaired), or else one your team first-spotted (the `spottedBy` of the shooter's team).

## Gun transform (turrets and casemates) — RENDER-TANKS must match
Let `P = armor.gun.pivot` (turret frame), `ty = tank.turretYaw`, `gp = tank.gunPitch`, and let
`Ry(a)` map (x, z) → (x·cos a + z·sin a, −x·sin a + z·cos a).
- **Yaw centre** `C = gunYawCentre(tank)`: (0, 0), the ring centre, for turrets; **(P.x, P.z), the gun pivot, for casemates** (`turret.shape === 'casemate'`).
- A gun or mantlet point `q` (turret frame, at yaw 0) goes to the turret frame as `C + Ry(ty)(q − C)`, keeping y. The turret frame then goes to the hull as `+ armor.turretPos` (no further rotation for casemates; turrets have already rotated about the origin because C = 0). Then `tankMatrix`.
- The gun direction in the turret frame is `(sin ty·cos gp, sin gp, cos ty·cos gp)`, and the muzzle is `P' + len·dir`, where `P'` is P transformed as above (P' = P for casemates: the pivot doesn't move).
- For turrets this is exactly the old behaviour. For casemates the gun and mantlet now swing about the pivot: the SU-152 muzzle moves 0.9 m sideways at 12° instead of 1.5 m.
- The casemate body, the cupola on a casemate, and the casemate's module/crew boxes stay fixed. Helpers: `gunToWorld(t, x, y, z)`, `gunYawCentre(t)` in `src/sim/tank.js`.

## Review fixes (independent audit)
1. After spaced armour (tracks), the plate behind is searched over the tank's whole extent, not just the rest of the step. This removed the 7% of IS→Tiger-side shots that were wrongly stopped by the track.
2. Shells are traced from the **gun pivot** (`shell.pos` starts there and `shell.dist = −len`, so the firing tank is ignored until 6 m past the muzzle). A barrel poking into an enemy, a wall or the ground hits it. `predictImpact` traces from the pivot too. The `shot` event's `pos` is still the muzzle.
3. Ammo-rack pop: the `hit` event (with `dmg` = the remaining hp) comes first, then `kill{cause:'ammorack'}`. The shooter's `dmg` and the victim's `received` include it. More generally, every `hit` event is now pushed before its `kill`.
4. A non-finite `Controls.aim` is ignored (treated as null).
5. Casemate gun transform, see above.
6. Idle or braking: a stopped or crawling tank (< 0.6 m/s idle, < 2 m/s braking) holds on slopes below 30°. Steeper, it slides.
7. Capture reset only applies to tanks inside the circle now, and emits `capture{team, by, points, reset: tankId}`.
8. A ricochet skips only the plate it left (`shell.skipPiece`, for 10 cm), so it can hit other parts of the same tank. Ricochets and track-absorbed hits add the shell damage to the target's `stats.blocked`.
9. `spottedBy[team]` keeps the first spotter until the target drops off that team's visibility.
10. (Ruling) Aim time: dispersion relaxes with **τ = gun.aim** (e-folding), not aim/3.
11. (Ruling) View: `min(445, 320 + 12·tier + {light 40, medium 20, heavy 10, td 0})`.
Not fixed (not requested): a muzzle buried in a hill with the pivot above ground is now handled, since the terrain is hit from the pivot. A pivot that is itself underground is not.

## Known gaps / ideas
- No gun-depression limits over the rear deck, no HEAT loss after spaced armour, no shell-vs-gun-barrel hits, no tree knock-down by shells.
- Tank–prop collision uses circles, so long hulls can clip building corners by a few cm.
- `stats.spotted` counts first sightings per battle (WoT-like). The assist attribution is simplified.
- Ammo-rack pops happen in ~1–3% of pens in the bench (WoT-like). Fire ~5%.

## Contract change requests
- None blocking. Please bless as contract: `steer +1 = right`, events keyed by `type` with `shellType` for the shell type, `capture.by`, the magazine fields above.

## Deploys and wrecks (2026-09-26)
- `createBattle({ …, lives = MAX_DEPLOYS (3) })`. Every starting tank is a slot (`world.slots`, `world.slotOf[id]`;
  `t.slot` = the first tank's id, `t.life` = 1..lives). Player slot: `respawnTank` refuses past `lives`. Bot slots
  (`Entry.spares`): `respawnBots` brings the next spare in `BOT_RESPAWN_DELAY` = 6 s after a death at the safest spawn
  point (same placement as the player's). `deploysLeft(world, slot)`, `spawnsLeft(world, team)`. A team is defeated when
  it has no live tank and no spawn left (or its base is captured, or time-out → draw).
- `CAPTURE` = { rate 2 (was 1), max 3, decay 5 }: 100 points in 17 s with 3 cappers.
- Wreck cap: `WRECK_MAX` = 10. Beyond it the oldest wreck (by `diedAt`) gets `t.gone` + event `wreckGone`: no
  collision, no shell hits, not stepped, skipped by AI avoidance / nav (its wreck cost is removed); stats kept.
- rules-test "deploys" section: spawns left, not defeated while spawns remain, respawn delay / spare / fresh consumables,
  3rd tank then defeat, determinism, no spares → no respawn, wreck cap.

## Tiers VIII–X (post-war, 2026-09-26)
Twelve tanks, four per nation, continuing the tier VII lines (MT VIII → IX → X, HT VIII):
| tank | tier | hp | top gun (AP / premium, dmg, reload) | armour idea |
|---|---|---|---|---|
| M46 Patton | VIII MT | 1450 | 90 mm M41 212 / HEAT 258, 240, 6.0 s | M26-style 102 mm, soft |
| M103 | VIII HT | 1850 | 120 mm M58 248 / HEAT 340, 400, 12.8 s | 127@60 glacis, 127@58 cast turret + crown, weak cheeks, 114@45 lower |
| M48 Patton | IX MT | 1700 | 105 mm T254E2 235 / HEAT 300, 320, 7.5 s | 110@60 glacis, 178@35 elliptical turret + crown |
| M60 | X MT | 1950 | 105 mm M68 268 / HEAT 330, 390, 8.0 s | 110@65 wedge glacis, needle-nose turret 127@58 + crown |
| Tiger II | VIII HT | 1750 | 10.5 cm KwK 46 225 / APCR 285, 320, 9.8 s | 150@50 glacis, 180@9 turret (weak for a heavy) |
| Indien-Panzer | VIII MT | 1450 | 9 cm L/60 212 / APCR 265, 240, 6.1 s | thin (60@60), 65 km/h |
| Leopard Prototyp A | IX MT | 1700 | 10.5 cm L7A1 240 / APCR 300, 320, 7.4 s | thin (70@60), cast turret + crown |
| Leopard 1 | X MT | 1950 | 10.5 cm L7A3 268 / APCR 330, 390, 8.2 s | thin (70@60), welded wedge turret (box + crown), best dispersion 0.29 |
| T-44 | VIII MT | 1450 | 100 mm LB-1 190 / APCR 253, 250, 6.4 s | 120@60 glacis, T-34-85-style turret |
| IS-3 | VIII HT | 1750 | 122 mm BL-9 225 / APCR 265, 390, 11.4 s | 120@57 nose, flat dome 220@28 + crown |
| T-54 | IX MT | 1700 | 100 mm D-54 235 / APCR 305, 320, 7.3 s | 100@60 hull, dome 200@30 + crown |
| T-62A | X MT | 1950 | 115 mm U-5TS 270 / APCR 340, 360, 7.6 s | 100@60 hull, dome 240@35 + crown |
- Shell types stay AP / APCR (standing in for APDS / APFSDS) / HEAT / HE; no new mechanics. SPREAD 0.6 applies.
- **Crown** (`turret.crown = { h, a, k }`, src/sim/armor.js): for every wall (front, sides, rear, cheeks) a plane
  through the wall's line at height H − h, a° from vertical, k × the wall's thickness (default 0.75), same plate
  name. Skipped where the wall is already flatter. The solid stays convex, so rayConvex / solidFaces / the inspector
  and the model need nothing new. `turretSection(t, y)` (exported) = the shell's half width and front / rear z at
  height y (walls + crown); the gun pivot (`frontZAt`), the cupola placement and the renderer's roof details use it.
  For existing tanks it returns exactly the old values.
- `TIER_DMG` (module hp scale, damage.js / tank.js) extended to 280 / 330 / 380 for VIII–X.
- Balance probe (penPreview at 100 m, same-tier top AP): T-62A turret face 315 eff vs 268 (15 %), glacis 172 (100 %);
  T-54 turret cheek 238 vs 235 (47 %); IS-3 dome 288 vs 225 (0 %), lower plate 159 (100 %); Tiger II glacis 211 vs
  225 (63 %); M103 glacis 219 vs 225 (56 %); M48 glacis 190 vs 235 (88 %); Leopard line ≈ 120 everywhere (100 %).
  Bot battles (`battle-sim --tiers 9,10`): every new tank receives 0.8–1.0 × its hp, pens 68–85 % of its hits.
- rules-test: the roster check now wants tiers I–X per nation; new checks: T-62A turret vs M60 AP, the T-62A glacis
  is the weaker target and pens in live fire, IS-3 dome vs Tiger II, crowned turrets keep a roof with the cupola on it.
