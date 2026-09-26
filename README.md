# Steel Front

A single-player, browser World of Tanks–style game: real WWII tanks (USA, Germany, USSR, tiers
I–VII), 1 km outdoor battlefields, WoT aiming, armour and ballistics, 15 vs 15 random battles
against bots, and a garage / tech tree / XP / credits progression loop. Desktop, mouse and
keyboard, three.js, no server, no binary assets.

## Run
```
npm install
python3 -m http.server 8477      # from the repo root
open http://localhost:8477/
```
Build a static bundle into `dist/` (three.js bundled, minified): `node tools/build.mjs`.

## Controls
| key | action |
|---|---|
| W A S D | drive |
| Mouse | turn the camera; the turret follows the aim point |
| LMB | fire |
| RMB | click an enemy: lock the aim on it (again: release). Hold elsewhere: lock the gun (free look) |
| Wheel | zoom the camera 6–30 m; past the closest zoom: sniper ×2 / ×4 / ×8 |
| Shift | toggle sniper mode |
| Space / X | brake (Space also skips the pre-battle countdown) |
| 1 2 3 | shell type · R: reload with the selected shell |
| 4 5 6 | repair kit, first aid kit, fire extinguisher |
| Tab | score panel · M: minimap size · Esc: battle menu |

## Layout
- `src/main.js` boot and the hangar → loading → battle → results flow.
- `src/game/` battle session (fixed-step loop, bots, input, camera, aim), see `docs/notes/integration.md`.
- `src/sim/` deterministic simulation (armour, ballistics, spotting, rules), `src/sim/map/` the maps,
  `src/sim/ai/` the bots, `src/data/tanks.js` the roster.
- `src/render/` battle renderer (terrain, props, sky, post, tank models, FX).
- `src/meta/` profile, economy, matchmaker, results; `src/ui/` menus and the battle HUD (`hud.js`).
- `src/audio.js` Web Audio synthesis and crew voice lines.
- `docs/DESIGN.md` is the design contract; each part has notes in `docs/notes/`.

## Custom sounds
All audio is synthesised, but real recordings can replace the key sounds. Drop any of these into
`assets/sfx/` (`.wav`, `.ogg` or `.mp3`; tried in that order, loaded once when audio unlocks, and copied
into `dist/` by the build):
- `cannon.*` — one gun report, used for every shot (pitched ~1.25× for 20–37 mm down to ~0.75× for 122–152 mm),
  with the game's distance filtering, delay, panning, own-shot boost and ducking;
- `explosion.*` — HE, destruction and ammo-rack blasts (pitched by size);
- `engine.*` — a seamless engine loop recorded at about idle-to-mid rpm; its playback rate follows the rpm.
A missing or undecodable file silently falls back to the synth. In dist/, rerun `node tools/build.mjs` after adding files
(it copies them and writes the folder index the loader reads). Details: `docs/notes/audio.md`.

## Tests
```
node tools/rules-test.mjs                      # sim rules
node tools/maps-test.mjs                       # maps
node tools/meta-test.mjs                       # economy, matchmaker
node tools/battle-sim.mjs --n 2                # headless 15v15 bot battles
tools/capped.sh -- node tools/verify.mjs low   # end-to-end with real input (headless Chromium)
tools/capped.sh -- node tools/shot-game.mjs a='map=ashford&t=40'   # battle screenshot
```
Browser tools must run through `tools/capped.sh` (one headless browser at a time).
