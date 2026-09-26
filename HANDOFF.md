# Steel Front: handoff (2026-09-25)

Read this first. It says where the project stands, how to check it, and what to do next.
`README.md` covers running the game and its controls, `docs/DESIGN.md` is the architecture
contract, and `docs/notes/*.md` holds each area's detailed notes.

## What this is
The repo started as "Toy Tanks", a Wii-Tanks-style toy game, and was rebuilt in one session into
**Steel Front**. It's a single-player, browser World of Tanks–style game:
- 47 WWII tanks (USA / Germany / USSR, tiers I–VII, light/medium/heavy/TD)
- four 1 km maps
- 15v15 (or 7v7) random battles against bots
- a garage → tech tree → research → buy → battle → results loop

It uses three.js and has no server and no binary assets: textures, models and sounds are all
procedural. The work was PM-driven: a main session wrote the contract and reviewed, and Opus
agents built each area in parallel. Each area was independently reviewed or verified before
acceptance.

## State: playable end to end ✅
| Check | Result |
|---|---|
| `node tools/rules-test.mjs` | 95/95 (armour, ballistics, dispersion, spotting, capture, respawn, regressions) |
| `node tools/maps-test.mjs` | 1356/1356 (4 maps, nav, spawns, fairness, raycasts) |
| `node tools/meta-test.mjs` | 65/65 (economy, research, matchmaker, results, lineup) |
| `node tools/battle-sim.mjs` | 64 bot battles: median 6.5 min, 3% time-outs, 29:33 wins, 2/1920 stuck |
| `tools/capped.sh -- node tools/verify.mjs low` / `medium` | low 20/20 (2026-09-26, Windows, system Chrome; adds lineup + respawn + two-tank results); medium 18/18 before the lineup: full flow by real input, zero console errors |
| `node tools/build.mjs` | `dist/` ≈ 1.17 MB, fully static |

What works:
- **Garage:** 3D hangar and carousel, a tech tree per nation, research and buy, gun modules,
  ammo and consumable loadout, an armour inspector, service record and settings. The profile is
  saved in localStorage.
- **Battle:**
  - WoT arcade camera, sniper ×2/×4/×8, autoaim and gun lock.
  - Dispersion circle and gun marker, and a pen-chance reticle colour.
  - Full HUD: damage panel with modules and crew, shells and consumables, a minimap with spotted
    enemies only, team lists, kill feed, hit ribbons, sixth sense, damage direction and Tab score.
  - Spectate after death, and Esc menu.
- **Rules:**
  - Sloped plate armour that is also the visual model, normalisation, overmatch, auto-ricochet
    (ricochets fly on), ±25% rolls, pen falloff and HE splash.
  - Modules, crew, fire, ammo racks, and tracks as spaced armour.
  - Spotting with camo and bushes, and base capture.
- **Bots:**
  - Class roles and lane play, danger-map routing, weak-spot aiming and consumables.
  - Skill from "potato" to "unicum".
- **Audio:** synthesized cannons scaled by calibre, engines, hits, music and ambience, and crew
  voice callouts via speechSynthesis.

## Battle lineup (2026-09-26)
Owner request: "lineup limited to 2 tanks, buy more spots, respawn with a tank when you die" (War Thunder style).
- Profile `lineup` + `lineupSlots` (2, buy up to 5: 25k / 60k / 120k credits). Old saves get [selected, next owned].
- Garage: the carousel starts with the lineup slots (order, remove, empty slots, buy slot); BATTLE! uses the lineup.
- Matchmaking tier = the highest-tier lineup tank. Bots are unchanged and never respawn.
- Battle: when your tank dies and lineup tanks remain, a panel counts down 5 s (1–5 / click picks), then you respawn
  at your spawn area in that tank (`respawnTank` in the sim). Your team isn't beaten while you can still respawn.
  Leaving forfeits the respawns.
- Results: each tank driven earns its own XP / credits / repairs / battle count; the results screen shows a per-vehicle table.
- Details: docs/notes/meta.md "Battle lineup", docs/notes/integration.md (HUD "Lineup respawn").
- Decisions made without the owner: `selected` stays the tank shown in the garage (the lineup order decides the
  spawn); lineups may mix nations; each respawn earns its own participation reward; a new tank fills a free slot.
- Headless tools on Windows: `tools/lib-browser.mjs` now falls back to a node static server (no python3) and to the
  installed Chrome / Edge when Playwright's Chromium isn't installed (`SF_CHANNEL=chrome|msedge` forces one).

## Not verified
- **Real-GPU performance.** All browser testing ran on SwiftShader (CPU rendering). Budgets are
  sized for 60 fps on medium at 1080p on a mid-range GPU (≈100–160 draw calls, ~1.1 M triangles),
  but that has not been measured. Auto-quality exists and was tested only headless.
- **Actual listening.** Audio was checked by rendered-level and spectrogram tests only.
- **Hand-played feel.** No human has played it yet. Play a few battles in each class before
  tuning anything.

## Next steps, in priority order
1. **Play it on a real machine** (`npm install`, serve the repo root, open it). Measure fps on
   medium and high (F3 shows the perf overlay) and tune `src/render/quality.js` if needed.
   Listen to the audio mix.
2. **AI feel** (`docs/notes/ai.md` "still off"):
   - Skill barely affects survival: r = 0.12 against a 0.3 target, because skilled bots die while
     moving to or sitting in cover.
   - Light tanks survive only 6% of the time.
   - About 29% of kills are still at 300 m or more.
   - Kessel battles run short and Ashford long.
   Re-run `tools/battle-sim.mjs --n 8 --workers 1` after each change.
3. **Minor open issues** (`docs/notes/qa.md`):
   - Add a "skip to results" option to the ×40 play-out after leaving a battle dead.
   - The bottom HUD panels don't scale up at 1080p+.
   - `?fast=1` test mode gives huge rewards (test only).
4. **Garage gaps:** no Sell button in the UI yet (`economy.sell` exists).
5. **Visual polish** (`docs/notes/pm-backlog.md`, `render-tanks.md`, `render-world.md`):
   - Early tanks (MS-1, T-26, AT-1) still read boxy, and several US mid-tier hulls look alike.
   - The M6 close-up model is 29k triangles.
   - Tracers aren't interpolated.
   - Water reflects the sky only.
   - Static crater props aren't drawn.
6. **Sim gaps** (`docs/notes/sim.md`):
   - Gun depression over the rear deck isn't modelled, and HEAT doesn't lose pen after spaced armour.
   - A gun pivot buried underground on a steep crest isn't handled.
   - The track hitbox tapers the wrong way.
7. **Content ideas:** more maps (a generator per map in `src/sim/map/`), premium tanks, tier
   VIII+, encounter mode, crew skills, and artillery.
8. **Deploy:** `deploy.sh` still copies to the old toy-tanks path on the original server. Point
   it at the new site before deploying.

## Rules for whoever continues
- **One headless browser at a time.** Always launch it through `tools/capped.sh -- …`
  (SwiftShader Chrome uses GBs of RAM; two at once OOM-killed an earlier session).
- **Respect the contract.** `docs/DESIGN.md` defines frames, units, the data schemas, the events
  and the per-area APIs, and its "PM rulings" paragraph lists accepted deviations. The render
  models are built from the same armour solids as the hitboxes (`src/sim/armor.js`), so change
  armour geometry there and nowhere else.
- **Keep the suites green.** Add a regression test with every sim fix.

## Map of the code
```
src/data/tanks.js      roster (47 tanks), nations, research tree
src/sim/               deterministic sim: armor, tank, move, gunnery, ballistics, damage, spotting, battle
src/sim/map/           4 map generators + terrain/object queries + nav/A*
src/sim/ai/            bot brains (team plan, pathing, combat)
src/render/            battleView, terrain, env, props, post, quality, tankModel, tanks, fx, decals
src/game/              session (battle loop), camera, aim, input, bots
src/meta/              profile, economy, matchmaker, results, names
src/ui/                screens (hangar, tree, details/armour, loading, results, record, settings), hud
src/audio.js, src/audio/   synthesized audio + crew voice
tools/                 tests, battle-sim, verify, labs and screenshot tools, build
docs/                  DESIGN.md (contract), notes/ (per-area notes, QA findings, PM backlog)
```
