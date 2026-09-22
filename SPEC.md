# TOY TANKS — spec

A Wii Play Tanks–style arena shooter, rendered as a miniature: plastic toy tanks
fighting on a cork play-board built from painted alphabet blocks, on a bedroom
floor, shot through a tilt-shift lens so the whole thing reads as a toy you
could pick up.

## Pillars
1. **One hit kills.** Every shell is a threat to everyone, including the tank that fired it.
2. **Bounces are the game.** Shells ricochet off blocks. Reading and banking shots is the skill.
3. **It looks like a toy.** Glossy plastic, painted wood, felt, cork; soft window light;
   shallow depth of field. Every hit ends in a pop of plastic parts.

## Modes
- **Campaign** — 20 missions against the colour-coded enemy roster below.
- **Versus** — you against 1–3 bot tanks. The bots are scripted engines, not models, and have
  the same kit as you (5 shells, 1 bounce, 2 mines, same speed). First to N round wins
  (3/5/7). Arena is picked from 8 duel maps or at random. Bot skill per slot:
  - **Cadet**: direct shots only, slow reactions (350 ms), wide aim error, dodges late.
  - **Veteran**: plans one-bounce bank shots, leads moving targets, dodges and uses cover (180 ms).
  - **Ace**: the full engine. Searches bank shots with 2 bounces through the real collision
    code, leads by solving the intercept, dodges using a model of every live shell, lays mines to cut off
    paths and pushes when you are out of shells. Reaction time 90 ms, near-perfect aim.
  - Personalities on top of skill: *Sniper* (holds range), *Brawler* (charges), *Trickster* (mines, bank shots).
  - Free-for-all or 2v2 (you + bot ally vs 2 bots).
  - The bot ladder is checked in `tools/sim.mjs`: Ace should beat Veteran ≥70% of the time, and Veteran should beat Cadet ≥80%.

## Adaptive difficulty (the Director)
- A rating `skill ∈ [0,1]` (starting at 0.35) is saved in localStorage and updated Elo-style after every
  mission result or life lost. The expected result comes from the mission's threat rating vs `skill`.
  A win with no deaths and good accuracy moves the rating up, a death moves it down, and the
  step size shrinks as the sample grows.
- Campaign: every enemy brain is tuned by the rating. At 0 you get 1.6× aim error, 1.5× slower
  thinking, 1.25× slower reloads, no dodging for mid-tier tanks and fewer bank-shot samples.
  At 1 you get 0.6× aim error, 0.75× thinking time, 0.9× reloads, dodging for every mover that can
  dodge, and full bank-shot search. The map and roster stay the same, so a mission is still the mission.
- A second, in-mission layer: on the 3rd+ retry of the same mission, the retries ease things slightly
  (an extra −0.05 per retry, floored). It resets once you clear the mission.
- Versus: the **Adaptive** skill blends the Cadet → Veteran → Ace parameters by rating, and your
  round results feed the same rating.
- Settings: Adaptive on/off (off uses the fixed rating of 0.5), and a readout of the current rating.
- `tools/sim.mjs` checks the Director: a weak player-bot and a strong player-bot should converge
  to clearly different ratings, and their win rates should end up closer together than with the Director off.

## Controls
Platform: **desktop PC in the browser**, served from our own vhost (toytanks.jer.couleetech.network),
same deploy pattern as Critical Mass. No mobile/touch target.

| | Keyboard + mouse | Gamepad |
|---|---|---|
| Move | WASD / arrows | left stick |
| Aim | mouse | right stick |
| Fire | left click | RT / A |
| Mine | space / right click | LT / B |
| Pause | Esc / P | Start |

## Rules
- Arena is a 22 × 16 grid (1 unit per cell), with a wooden frame around it.
- Cells: floor, **block** (indestructible, bounces shells), **crate** (cardboard, bounces
  shells, destroyed by mine blasts), **pit** (blocks tanks, shells fly over).
- A shell kills any tank it touches, including the one that fired it (after a short grace period).
  Two shells that meet cancel out. A shell that hits a mine sets it off.
- Each tank has a limit on live shells, a bounce count, a shell speed and a reload time.
- Mines: at most 2 per tank. They arm after 0.6 s, blow up after 10 s, and blow up early
  when an enemy tank comes within range. Blast radius 1.6: kills tanks, destroys crates and shells.
- The player has 3 lives. Clearing a mission gives +1 life every 5th mission. Losing a life
  restarts the current mission.
- 20 missions. Progress (the highest mission reached) is saved; you can continue from any
  mission that is a multiple of 5 that you have reached.

## Enemy roster (colour = behaviour, as in the original)
| Name | Colour | Moves | Shells | Bounces | Speed | Mines | Notes |
|---|---|---|---|---|---|---|---|
| Rookie | tan | no | 1 | 1 | slow | – | slow turret |
| Grunt | grey | slow | 1 | 1 | slow | – | wanders |
| Zipper | teal | slow | 1 | 0 | fast rocket | – | snipes down straight lines |
| Sapper | yellow | fast | 1 | 1 | slow | 4 | lays mines, runs away from them |
| Burst | red | slow | 3 | 1 | slow | – | fires bursts |
| Ricochet | green | no | 2 | 2 | fast rocket | – | plans bank shots |
| Hunter | purple | fast | 5 | 1 | normal | 2 | aggressive, dodges |
| Ghost | white | normal | 5 | 1 | normal | 2 | turns invisible (leaves tracks) |
| Boss | black | very fast | 2 | 0 | fast rocket | 2 | final mission |

## AI
- **Aim:** turret turns toward a target angle at a set turn rate. It first checks a direct
  line of fire, then (for tanks that bounce) samples 90 angles and traces each shell
  path to find a bank shot. A shot is rejected if its path passes near the tank itself or an ally.
- **Move:** grid pathfinding toward a goal chosen by personality (close in / keep range / wander /
  flee mines). Steering avoids shells: it predicts incoming shells over 0.6 s and dodges sideways.
- **Mines:** the sapper and hunter types drop one when the player is close, or at a crate
  choke point, then move away from it.

## Presentation
- Three.js r185 with a WebGL2 post-processing stack: render → (GTAO on High) → bloom →
  tilt-shift blur → grade, vignette and grain → SMAA.
- ACES tone mapping, RoomEnvironment reflections, 4K PCF soft shadow map from a warm
  "window" key light, plus a cool fill.
- Procedural canvas textures, so there are no asset files: cork board, hardwood floor,
  painted blocks with letters, cardboard crates, tread rubber.
- Tanks: rounded plastic hulls with a clearcoat, treads that scroll with movement, a
  turret with recoil, a flag antenna.
- FX: shell smoke trails, a flame trail on rockets, muzzle flash, ricochet sparks, the
  explosion (fireball, smoke, shockwave ring, 20+ plastic debris parts with physics that
  bounce), a scorched X where a tank died, tread tracks, dust motes in the light.
- Camera: angled 3/4 view, a small lean toward the aim point, a swooping intro each
  mission, trauma-based screen shake.
- Around the board sits giant set dressing, blurred by the tilt-shift: pencils, crayons,
  a mug, building bricks, a toy box.
- Audio synthesised with WebAudio (cannon pop, ricochet, explosion, mine beep, tread
  rumble). A march on drums with layers that change with the enemy mix.
- UI: a toy-box style HTML overlay. Title → mission banner ("Mission 4 · Enemy tanks: 5") →
  play → a "Mission cleared!" tally → results / game over with a kill breakdown.
- Quality: Low / Medium / High, auto-picked from the frame time over the first 2 s;
  can be overridden in settings.

## Architecture
```
src/sim/     pure game logic, no three.js (runs in node)
  world.js   state, fixed 60 Hz step, collisions, shells, mines
  ai.js      enemy brains + player-bot (used by the headless sim)
  levels.js  20 ASCII missions + parser/validator
  tanks.js   type table
  director.js adaptive difficulty rating + brain tuning
src/render/  three.js view of the sim (reads state, never mutates rules)
src/audio.js, src/input.js, src/ui.js, src/main.js
tools/build.mjs    → dist/index.html (single self-contained file)
tools/sim.mjs      headless: every mission played N times by the player-bot
tools/verify.mjs   Playwright: real input through title → missions → death → game over
```
Test hook: `window.__tt` exposes the state and debug commands; the game never reads it.

## Done means
- `tools/sim.mjs`: every mission is winnable by the bot. Win rate falls off as missions progress. No stuck states and no NaNs.
- `tools/verify.mjs`: the full flow runs by real input with zero console errors on all three quality tiers.
- Screenshots of every mission look good at 1920×1080, 1366×768 and 2560×1440.
- Paid-tester QA agents found no blocker.
