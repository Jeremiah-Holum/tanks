# INTEGRATION notes

Owner of `src/main.js`, `src/game/*`, `src/ui/hud.js`, `src/ui/hud.css`, `index.html`, `tools/build.mjs`,
`tools/verify.mjs`, `tools/shot-game.mjs`, `tools/lib-browser.mjs`, `README.md`.

## Architecture
- `src/main.js`: boot. `Screens` (META) runs the menus; `onBattle` → `screens.showLoading(battle)` →
  `BattleSession.load(progress)` → `screens.hideAll()` → `session.start()`; the session's `onExit` →
  `screens.finishBattle(world, playerId, battle)` (results, applies rewards) → the results screen's
  "To garage" button → hangar. One `requestAnimationFrame` loop calls `session.frame(dt)`.
  `window.__sf` = `{ screens, audio, session, state(), lastReport }` for the test tools.
- `src/game/session.js` `BattleSession`: owns the `BattleView` (a fresh canvas per battle, disposed with
  `forceContextLoss` after the battle), the world, brains, camera, input and HUD.
  - Loading (real progress): loadMap → `setLoadingMap` → `new BattleView` → `view.loadMap` → `view.ready` →
    `createBattle` → `view.tanks.prewarm` per tank type (both LODs, in chunks) → brains → HUD → first render.
  - Phases: `countdown` (10 s, Space skips, the sim is frozen, the camera is free) → `play` → `dead`
    (spectate) → `ending` (result banner 4 s) → `done` (onExit).
  - Loop: accumulator × speed, fixed `DT = 1/60`, at most 5 steps per frame (the game slows down instead of
    spiralling), render interpolation `alpha = acc / DT` (tanks via TankRenderer's own snapshots, the camera
    focus and markers via the session's `ipos()`). Every event of every step is collected per frame and
    fed to `view.frame({events})`, `audio.event` and `hud.event`. `world.firstKill` is set from kill events.
  - Controls: bots from `src/game/bots.js` (`createBrain` from `src/sim/ai`; `?bots=simple` or an AI
    construction error falls back to `simpleBot` from `src/sim/testmap.js`). The player's Controls come
    from input: WASD, brake Space/X, aim = the camera aim point (or the locked target's centre of mass),
    `lockGun` while RMB is held without a target, fire on the LMB press edge, shell 1/2/3, R (switches to
    another shell for one step and back = a reload with the selected type), consumables 4/5/6.
- `src/game/camera.js` `GameCamera`: arcade orbit around a pivot 1.3 m above the turret top, 6–30 m (wheel,
  ×1.25 per notch), pitch −62°…+28°, collision against terrain and solid props (ray from the pivot, snaps in,
  eases out) and never below the rendered ground. Sniper: at the muzzle (+0.4 m forward, 0.28 m up) so the
  gun is behind the camera; ×2/×4/×8 of the arcade fov; look pitch limited to the gun's depression/elevation
  (±3°) plus the hull pitch along the view. Switching modes keeps the aim point under the crosshair.
- `src/game/aim.js` `aimRay`: screen-centre ray vs terrain, water surface, solid props (`raycastObjects
  'shell'`) and tanks (bounding sphere, then `rayArmor`), 720 m. Unspotted enemies are skipped. In arcade the
  ray starts at the pivot so nothing between the camera and the tank is aimed at.
- `src/game/input.js`: keys (codes), mouse deltas (pointer lock requested on click; plain `movementX/Y`
  works without it), wheel notches, button edges. Jumps > 300 px per event are ignored (lock spikes).
- `src/ui/hud.js` + `hud.css`: see below. Text is written only on change (`txt/sty/cls` caches), markers and
  floating numbers move with `translate3d`, team lists refresh at 4 Hz, the minimap at 15 Hz, the Tab panel at 2 Hz.

## HUD
- Reticle (canvas): centre dot = camera aim; the dispersion circle is drawn around the **gun marker**
  (`predictImpact` projected) with radius `6 px + disp/100 · focal` (true angular size plus a 6 px floor so
  it stays readable in arcade); colour from `penPreview` (red < 25 %, yellow, green > 75 %, plus the % under
  it) when the aim point is on an enemy or a target is locked. Reload arc on the left, reload seconds, shell
  count and type on the right, magazine x/y for clip guns. Lock brackets around the locked target.
  Red damage-direction wedges around the centre towards whoever hit us (3.5 s). Sniper: scope vignette, mil
  ticks, chevron, ×zoom and the rangefinder distance of the aim point.
- Top: team hp bars (sum of hp), alive counts, timer (red < 2 min), capture bars while a base has points.
- Sides: both team lists (tank short + name; dead struck through; enemies bright when spotted); you in amber.
- Bottom-left: damage panel (tier, class, name, speed, hp bar with a lagging damage bar, 6 module icons with
  damaged/destroyed state and repair countdown, crew icons, fire icon); damage log above it (dealt ▲,
  received ▼, blocked ■). Bottom centre: shells 1/2/3 (selected highlighted, empty dimmed), magazine pips,
  consumables 4/5/6 with cooldown sweep and seconds. Bottom-right: minimap (hill-shaded map from
  `renderMinimap`, red play boundary, bases, allies as arrows, spotted enemies as diamonds, last-known
  circles fading over 25 s, wrecks as ×, view-range circle, 445 m circle, camera cone); M cycles
  small/medium/large. Kill feed above the minimap.
- Centre: hit ribbons (Penetration, Critical hit, Ricochet, Didn't penetrate, Tracks destroyed / Track hit,
  Hit (HE), Target destroyed, Spotted, Damage blocked), merged with ×n and summed damage; floating damage
  numbers over hit enemies; toasts (module/crew/fire/consumables); sixth-sense lamp while `tank.spotted`
  (min 3 s; the voice line comes from audio's `spot` event).
- Markers over spotted enemies (red, tank + hp bar + hp, name < 160 m) and allies within 300 m (green, compact,
  name < 100 m or under the crosshair), scaled with distance, overlaps stacked then faded.
- Tab score panel (tier, class icon, vehicle, player, damage, kills; sorted by tier; unspotted dimmed).
- Death: "Destroyed by X · tank · cause" banner, then spectating allies (LMB/RMB next/previous).
- Esc menu: Resume / Settings (the Screens settings dialog shown over the battle: the root gets
  `.sf-overlay`) / Leave battle. The sim pauses while the menu or settings are open. Losing pointer lock
  (browser Esc) opens the menu. Leaving = defeat with the tank destroyed (`deathCause 'left'`).

## Audio
`audio.music('battle')` at start; per frame the listener is the camera (pos, forward, playerId);
`audio.event` for every event; `audio.engine` for the player and the nearest 8 visible tanks within 300 m;
`audio.stopAll()` at the end; the results/hangar screens switch the menu music back on (Screens does it).

## Auto quality
Setting `quality: 'auto'` (default) starts at `medium`; if the average frame time over the last 5 one-second
windows in battle is > 22 ms, it drops a tier (`view.setQuality`, a short stall) and shows a toast. A fixed
setting or `?q=` disables it. `renderScale` (settings) multiplies the view's pixel ratio.

## Debug URL params (index.html?…)
| param | effect |
|---|---|
| `q=low|medium|high` | fixed quality |
| `fast=1` | test mode: battle 600 s (unless `limit`), sim ×4 (unless `speed`), up to 150 steps / frame and 1 s per frame, player god mode |
| `god=1`, `speed=n`, `limit=s` | god mode, sim speed, battle time limit |
| `auto=1` | skip the hangar and start a battle at once (`tank=<id>`, `map=<id>`, `size=7|15`, `seed=n`) |
| `map`, `size`, `seed` | also override BATTLE! from the hangar |
| `t=s` | fast-forward s seconds after loading (the player drives on autopilot meanwhile), no countdown |
| `autopilot=1` | the player's tank is driven by the AI |
| `bots=simple` | use the test bot instead of the AI |
| `countdown=s` | countdown length (0 = none) |
| `perf=1`, `debug=1` | per-phase timing strip (also F3 in battle and the "Show FPS" setting) |
| `scale=0.5..1` | render scale |

## Controls
WASD drive · mouse aim · LMB fire · RMB lock target / hold gun · wheel zoom → sniper ×2/×4/×8 · Shift sniper ·
Space/X brake (Space skips the countdown) · 1/2/3 shells · R reload · 4/5/6 consumables · Tab score · M minimap ·
F3 perf strip · Esc menu. Sensitivities and invert Y come from Settings.

## Tools
- `tools/capped.sh -- node tools/verify.mjs low|medium` (one at a time): real input end to end, see the top of
  the file for the steps. Screenshots `shots/verify/<q>/NN-*.png`. It starts/stops its own dev server on 8477
  if none is running. Viewport 1024×576 (SwiftShader is CPU-bound).
- `tools/capped.sh -- node tools/shot-game.mjs name='map=ashford&tank=usa_m4&t=45&q=medium' …`
  (tool params: `press=ShiftLeft,Wheel1`, `hold=Tab`, `yaw=deg`, `wait=ms`), into `shots/game/`.
- `node tools/build.mjs` → `dist/` (game.js, ui.css, hud.css, index.html).

## Verify results / perf (SwiftShader, 4 shared cores, 1024×576)
- **verify low: 18/18 passed in 349 s**: hangar → pick tank → BATTLE! → loading → countdown (Space) → W drives
  (7.3 m) → mouse turns camera + turret → 4 shots → shells 3/1 → R reload → sniper ×4 → arcade zoom out → Tab →
  M → Esc/Resume → last 45 s at 4× → results (draw, 36 XP, 638 cr) → garage (no leftover battle nodes), zero
  console/page errors. Shots: `shots/verify/low/01…17-*.png`.
- **verify medium: 18/18 passed in 484 s** (same steps; Kolvik Pass). Shots: `shots/verify/medium/`.
- Per sim step with 30 tanks under SwiftShader load: sim 0.13–0.36 ms, AI (all bots) 0.17–0.45 ms. In node alone
  sim 0.23 ms/tick and AI 0.2 ms/tick (tools/battle-sim.mjs). Per frame: view.frame CPU 6–13 ms, HUD 1.5–2.4 ms,
  audio 6 ms (headless, many one-shots at 4×). Frame times of 170–600 ms are the CPU rasteriser.
  `view.stats()`: low 80–150 draw calls, 0.3–0.4 M tris; medium ~100–160 calls, ~1.05 M tris.
- FX and tank animations age with sim time (`dt × speed`), so a sped-up test battle doesn't pile up particles.

## Known issues / unfinished (priority order)
1. verify must fit capped.sh's 900 s under SwiftShader; the end leg uses the test hooks `__sf.endIn(45)` and
   `__sf.setSpeed(4)` (both only change the remaining time / sim speed). Low takes ~350 s, medium ~480 s.
2. Real-GPU frame timing and auto-quality haven't been measured here (headless only).
3. Marker clutter: allies are compact and scaled, overlaps stack up to 4 levels and then fade; it can still be busy
   at spawn. Consider hiding ally markers beyond ~150 m or behind terrain.
4. The "player tank invisible" shot came from a run where the dev server died mid-load, so TankRenderer and
   FxRenderer never loaded. Loading now fails loudly (back to the hangar with a toast) if either is missing.
   In the latest runs the player's tank is drawn in arcade view (e.g. `shots/verify/low/07-firing.png`).
6. The dispersion circle has a 6 px floor added to the true angular radius (readability in arcade).
7. No tree/prop occlusion test for markers; no shell fly-by; no replay of the damage log after death.
8. Audio can spike (65 ms in one headless frame at 4× with many one-shots); worth a look on real hardware.
9. Enemy markers can overlap the side team lists. The perf strip (F3, `?debug=1`, `?perf=1` or the Show FPS setting) is wide at 1024 px.
