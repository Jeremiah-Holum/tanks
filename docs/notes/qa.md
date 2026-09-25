# QA notes (phase 3)

Headless QA pass (SwiftShader, 640–1920 px viewports) over the areas verify doesn't cover. The scripts live
outside the repo; each is a short Playwright run through `tools/capped.sh` that reuses `tools/lib-browser.mjs`
and the `window.__sf` hooks. How to rebuild them is under "Reproducing" below.

## Findings

| # | Severity | Area | Finding | Status | File |
|---|---|---|---|---|---|
| 1 | major | auto quality | A frame gap after a hidden tab, alt-tab or a debugger pause (`dt` up to 5 s) went into the auto-quality window as one huge frame, so every tab switch could drop the graphics a tier. | fixed: frames longer than 0.5 s reset the window | src/game/session.js `_perf` |
| 2 | major | leave battle | Leaving via Esc **after death** turned the whole battle into an immediate defeat (reason "left"), even when your team was winning. | fixed: when you are already dead, the battle resolves at ×40 without sound, the results follow, and there's no penalty. Leaving while alive is still a defeat. | src/game/session.js `leave` |
| 3 | major | settings in battle | The in-battle settings dialog offered "Reset progress", which wiped the profile and rebuilt the hangar underneath a running battle. | fixed: hidden while the dialog is an overlay (`.sf-overlay`) | src/ui/settings.js |
| 4 | major | results UX | At heights ≤ 600 px the results columns clipped the credit ledger. "Net income" was below the fold, and the column scrollbar is thin. | fixed: compact header at `max-height: 640px` | src/ui/ui.css |
| 5 | minor | consumables | Pressing 4/5/6 with nothing to repair, heal or extinguish did nothing and gave no feedback, because the sim refuses silently. | fixed: a dim toast ("No damaged modules to repair" and so on) | src/game/session.js |
| 6 | minor | Esc / pointer lock | If a browser delivers the Esc keydown along with the pointer-lock loss, the menu would open and close in the same frame. | fixed: a pending Esc is dropped when lock loss opens the menu | src/game/session.js |
| 7 | minor | HUD | Destroyed entries in the side team lists (opacity .45, muted) were almost invisible against a bright sky. | fixed: opacity .6 plus a text shadow | src/ui/hud.css |
| 8 | minor | input | Two LMB presses within one rendered frame fire only once (`fireQueued` is a flag). This only shows up at < 3 fps (SwiftShader); real frame rates are unaffected. | open | src/game/session.js |
| 9 | minor | capture | Capture points reset whenever a capper takes damage (WoT rule). In god/fast test runs, bots near their own base keep the bar at 0–1 %, so capture tests should freeze or kill the defenders first. | by design (test note) | — |
| 10 | minor | leave after death | The resolve takes up to ~25 s on a long battle: 400 steps/frame of sim + AI (it took 67 s headless). A spinner or "skip to results" could be added. | open | src/game/session.js |
| 11 | minor | HUD | The damage panel, shells and consumables don't scale up at 1920×1080 (the layout is fine, just small). | open | src/ui/hud.css |
| 12 | minor | results | Rewards in `?fast=1` god-mode runs are huge (a Tiger on autopilot earned 13.7k XP and 255k credits) because god mode lets the player farm the whole team. Test mode only. | open (test only) | — |

## Verified working (no change needed)
- Progression: the 3 starters (usa_t1, ger_ltraktor, ussr_ms1) each battle → results → XP and credits applied → garage.
  Research + buy Pz II → selected → the profile persists across a reload → a 7v7 on River Kessel in the Pz II. Credits
  are clamped at ≥ 0 and tier I repairs and ammo are free, so there's no soft-lock (meta-test also covers this).
- All 4 maps load (ashford, steppe, kolvik, kessel; 6–8 s headless). 7v7 and 15v15 both work. The Tiger I (tier VII) battle HUD was checked at 1280×720 and 1920×1080.
- Pz II magazine: 10 rounds 0.23 s apart, then the 4 s reload, both in play and in node.
- StuG III casemate: the gun stays within ±10° and the hull auto-turns towards the aim (1.5 rad in 5 s).
- Consumables via keys 4/5/6: the repair kit restores engine, track and gun; the first-aid kit revives the gunner and
  driver; the extinguisher puts out the fire; all three then go on cooldown. A destroyed track is field-repaired in 8.1 s.
- Ammo-rack and fire kills reach the kill feed, FX and audio. Both capture bars appear ("Capturing the enemy base" and
  "Our base is being captured").
- Death → "Destroyed by …" banner → spectating an ally after 2.5 s; LMB cycles to the next ally → battle end → results.
- Esc → Leave battle (alive) → defeat → results → garage. No battle canvas is left behind.
- RMB target lock and release, gun lock while RMB is held, window resize mid-battle (canvas and HUD follow),
  and a 3 s main-thread stall: the sim advances only by the per-frame clamp.
- In-battle settings apply live: sensitivity ×2 doubles the turn, invert Y flips the pitch, quality low → medium,
  master volume 0.2.
- Losing pointer lock opens the menu, and Resume re-locks.
- A 600 s battle at ×4 (Tiger, autopilot, 15v15): no NaNs, no errors, event listeners balanced (+0 net), DOM steady at ~550 nodes,
  geometries 194 → 241 (wrecks and decals), FX pools peaked at 139/900 and 1035/1400 (never exhausted), JS heap flat.
  On the results screen the DOM drops back to its pre-battle size. Audio (when unlocked): 7 engine voices, ≤ 12 one-shots.

## Reproducing (script recipes)
Start each script with `import { startServer, openBrowser } from '<repo>/tools/lib-browser.mjs'` and run it through
`tools/capped.sh -- node script.mjs`.
- Mechanics: open `index.html?fast=1&speed=1&countdown=0&q=low&size=7&auto=1&tank=ger_stug3&map=steppe`. To damage the
  player, `import('/src/sim/damage.js')` and call `damageModule(fw, player, 'engine', 1e6)`, `killCrew` and
  `startFire` with `fw = Object.create(world, { events: { value: [] } })`: events pushed outside a step are cleared
  at the next step start. To have the HUD, audio and FX see an injected event, wrap `world.events` in a Proxy that
  re-pushes pending events after `length = 0`.
- Input: SwiftShader frames take 0.3–1 s, so wait at least 1 s between synthetic clicks. Under pointer lock,
  Playwright's `mouse.move` produces bogus `movementX` values (±500, which the game ignores as spikes), so for
  mouse-sensitivity tests stub out `HTMLCanvasElement.prototype.requestPointerLock` and test pointer lock separately.
- Long run: `?fast=1&speed=4&limit=900&autopilot=1&tank=ger_tiger&map=kolvik`. Count listeners with an init script
  that wraps `EventTarget.prototype.addEventListener` and `removeEventListener`. Sample `view.renderer.info.memory`,
  `view.fx.add.n` and `view.fx.alpha.n`, and `audio.stats()`. Audio only runs after a real click in the hangar (`pointerdown` unlocks it).
