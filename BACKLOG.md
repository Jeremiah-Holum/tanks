# Toy Tanks — backlog (PM: main session; code: Opus 5.5 subagents, one phase at a time)

Live: https://toytanks.jer.couleetech.network/ (deploy with `./deploy.sh`, see ~/Projects/GAME_HOSTING.md)
Every item traces to something Jer asked for (quoted where useful). Status: ☐ todo · ◐ in progress · ☑ done (verified).

## Direction (Jer, 2026-09-22) — the game we're building
A **World of Tanks–style toy tank battle**, rendered realistically like *Toy Soldiers* (Xbox 360):
die-cast toy tanks on a big diorama in a kid's bedroom. **Desktop PC**, played from its own subdomain.

## Done so far (verified by screenshot or sim)
- ☑ Hosting: vhost + cert + `deploy.sh`; README `~/Projects/GAME_HOSTING.md` + `~/Projects/CLAUDE.md` for future AIs
- ☑ Sim core (fixed 60 Hz, node-runnable), headless `tools/sim.mjs`, paused screenshot tool `tools/shot.mjs`
- ☑ Scripted bot engines Cadet/Veteran/Ace (not models) — "make sure theyre pretty good" (ladder verified on old rules)
- ☑ Director (adaptive difficulty) — "difficulty adapted as well to how good the player is"
- ☑ Realistic art pass: die-cast tanks w/ rolling link tracks, diorama terrain + grass flock, bedroom room, window light, env reflections, macro DOF
- ☑ Chase camera default ("like you are the tank"), V toggles tactical
- ☑ Title/menus/HUD/pause/results/settings, synthesized audio + march music

## Phase A — rules overhaul (sim only: src/sim/*, tools/sim.mjs)  ☑ verified by PM 2026-09-22 (rules-test 36/36, ladder rerun) — commit fffeb2a
- ☑ A1 Any-size maps everywhere (grid.cols/rows) — "fairly large map … world of wartanks"  *(started: world/ai/levels patched)*
- ☑ A2 Generated battlefields (mapgen.js, maps.js) — towns/farms/craters/river/fort, mirrored, sealed-pocket fill *(written, needs verifying)*
- ☑ A3 **No wall ricochets**: shells stop on blocks; cardboard crates break when shot — "i also dont want it to richochet off walls"
- ☑ A4 **Armour & penetration**: HP per tank; armour [front, side, rear] by facing; effective armour = t / cos(angle); pen roll ±25%; >70° = ricochet off the tank (shell deflects and flies on); non-pen stops — "some bullets richochet, and some will penetrate"
- ☑ A5 **Hit locations / modules**: tracks (immobilised a few s), turret (slow traverse), engine (slow + may catch fire, fire = damage over time), ammo rack (rare instant kill) — "different parts of the tank have different damage"
- ☑ A6 **Tank classes**: light / medium / heavy / tank destroyer (tanks.js CLASSES) — "multiple tank models"
- ☑ A7 Aim dispersion (circle blooms when moving/traversing, settles when still)
- ☑ A8 Spotting / fog of war for AI (team intel, view range, ghosts close only, shots heard) *(written in ai.js, needs verifying)* — "semi blind … cant see around corners"
- ☑ A9 AI rework for new rules: direct fire only, waits for aim to settle, prefers side/rear shots, flanks, Ace angles its armour; allies in campaign; versus team battles up to 5v5
- ☑ A10 Rebalance with sim: ladder (Ace>Vet ≥70%, Vet>Cadet ≥80%), every mission winnable by bot, difficulty curve, Director convergence; no NaN/stuck

## Phase B — rendering (src/render/*)  ◐ agent running
- ☐ B1 Board/room/camera scale to any map size (board, frame, room, props placement, tactical fit, shadows)
- ☐ B2 **Taller toy obstacles**: toy houses, stacked block towers, book rows, tin cans, plastic-brick walls, fort walls, crate stacks — "more obsticles and taller, like toy houses"
- ☐ B3 Class tank models (light/medium/heavy/TD visibly different)
- ☐ B4 Damage visuals: hit sparks vs ricochet sparks vs penetration puff, smoke <50% HP, fire, broken track, wreck stays; floating damage text; HP bars over spotted enemies
- ☐ B5 **Aim line: one straight line** to first obstacle, no bounce preview, no hit colour — "only a one line, doesnt show you WHERE itll bounce"; crosshair shows dispersion
- ☐ B6 Semi-blind chase cam (low rig, blocks occlude) *(done, re-verify on big maps)*; tactical fog hides unspotted enemies
- ☐ B7 Perf on 48×34 maps at 1080p on a mid PC (auto quality still works)

## Phase C — UI & flow (src/ui.*, src/main.js, src/input.js, src/audio.js)  ◐ agent running
- ☐ C1 **Remove minimap** and edge markers — "no mini map"
- ☐ C2 HUD: HP bar, module status (tracks/turret/engine/fire), reload timer, crosshair/dispersion, hit feedback ("RICOCHET", "NO PEN", "−42")
- ☐ C3 Garage: pick class before campaign mission / versus
- ☐ C4 Versus setup: team battles (up to 5v5) on big maps; FFA up to 4
- ☐ C5 Help/roster/banners updated to the new rules

## Phase D — QA & ship
- ☐ D1 `tools/verify.mjs`: full flow by real input (title → garage → mission → death → retry → clear → versus), zero console errors
- ☐ D2 Paid-tester QA agents (graphics-first, plus real play); fix blockers
- ☐ D3 Deploy + screenshots to Jer

## Phase A notes for later review
- Shells ~50% faster than first spec (long-range fights were endless dodging). Director also scales enemy HP/dmg (×0.72…×1.1).
- Campaign curve noisy (Ace bot @0.5: M13 0.2); revisit after UI lands with real play. Dodge planner ignores tank ricochets.

## Later / parked
- More tank models beyond the four classes ("eventually")

## Definition of done (the whole game) — PM signs off only when every line is true
**Plays**
1. From the live URL on a desktop browser: title → garage → campaign mission → fight → win/lose → next mission/retry, and versus setup → match → rematch, all by mouse/keyboard, no dead ends.
2. All 20 campaign missions load, are winnable, and get harder; checkpoints every 5 missions save across reloads.
3. Versus works for 1v1, FFA up to 4, and team battles up to 5v5, with Cadet/Veteran/Ace/Adaptive bots.
4. Chase cam (default) is semi-blind: walls hide enemies; tactical view (V) fogs unspotted enemies; no minimap.
5. Rules behave as specified: shells stop on walls, crates break, penetration/no-pen/ricochet by armour & angle, module damage (tracks/turret/engine/fire/ammo), four tank classes that feel different, aim dispersion.
6. Adaptive difficulty moves with player skill (visible in settings/results).

**Looks & sounds** (graphics are the priority)
7. Reads as realistic toys (Toy Soldiers): die-cast tanks per class, tall toy obstacles (houses, towers, books, cans, bricks), diorama in a bedroom, good lighting, no obvious placeholder art.
8. Clear combat feedback: hit/ricochet/pen effects, damage numbers, HP bars on spotted enemies, smoke/fire, wrecks.
9. Sound for every action; music.

**Quality gates**
10. `tools/sim.mjs`: bot ladder holds (Ace>Vet ≥70%, Vet>Cadet ≥80%), no NaN, <5% stuck games, sim <4 ms/tick with 12 tanks.
11. `tools/rules-test.mjs` passes; `tools/verify.mjs` drives the full flow by real input with zero console errors on low/medium/high.
12. Paid-tester QA agents (graphics-first + real play) report no blocker; every major they report is fixed or explained.
13. Runs smoothly at 1080p on a mid-range PC (auto quality drops tiers if not).
14. Deployed to https://toytanks.jer.couleetech.network, final screenshots sent to Jer, BACKLOG fully ☑.
