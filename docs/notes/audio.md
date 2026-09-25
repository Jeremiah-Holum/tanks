# AUDIO agent notes

Status: phase 1 done. Owns `src/audio.js`, `src/audio/*.js`, `tools/audio-lab.html`, `tools/audio-render.mjs`.
Everything is Web Audio synthesis (noise buffers, biquads, waveshapers, convolution reverb from
generated impulse responses) plus `speechSynthesis` for the crew. No audio files.

## Files
- `src/audio.js`: the `Audio` class (buses, positional placement, event routing, voice lines).
- `src/audio/core.js`: `Kit`: noise/brown/crackle buffers, field + room impulse responses, primitives (`noise`, `tone`, `metal`, `ticks`).
- `src/audio/sfx.js`: one-shot recipes (cannon by calibre, explosions, ammo rack, impacts by surface, hits outside/inside, ricochet whine, ram, tree, crash, fire, reload, consumables, UI, alerts).
- `src/audio/engine.js`: pooled continuous voices: `EnginePool` (engine, tracks, squeal, turret whine) and `FirePool`.
- `src/audio/music.js`: menu music loop, battle ambience, victory/defeat stingers.
- `src/audio/speech.js`: `Crew` voice queue, `LINES` table, male English voice picker.

## API (contract + additions)
```js
import { Audio, LINES } from './audio.js'
const audio = new Audio()          // safe in node; no-ops until unlock() gets an AudioContext
audio.unlock()                     // call from a user gesture; also resumes a suspended context → bool
audio.setVolumes({ master, sfx, music, voice, voiceOn })   // 0..1 each; voiceOn is an addition
audio.event(ev, world, listener)   // every entry of world.events after each stepBattle
audio.engine(tank, listener)       // every frame, for the player and any tanks near the camera
audio.ui(kind)                     // 'hover' 'click' 'toggle' 'back' 'error' 'purchase' 'research' 'notify' 'battleStart'
audio.music(on)                    // true|'menu' → menu loop; 'battle' → battle ambience; false → stop
audio.say(line)                    // a LINES key ('pen', 'spotted', …) or free text
// additions: audio.voiceOn = bool; audio.stopAll() (leaving a battle); audio.stats();
// new Audio({ context }) renders into a given (Offline)AudioContext; { raw: true } skips the limiter.
listener = { pos: {x,y,z}, fwd: {x,y,z}, playerId }   // usually the camera position + camera forward
```
- Event type is read from `ev.type` (falls back to `ev.kind`). Tank, shell and object fields may be ids or objects;
  ids are looked up in `world.tanks`, `world.shells`, `world.map.objects`.
- Matches SIM's current emitters (`src/sim/damage.js`, `ballistics.js`): shell type from `ev.shellType`,
  calibre from `ev.cal` → shell → the firing tank's `gunDef.cal`. `impact` with `surface: 'tank'` is
  silent (the `hit` event carries that sound); `wreck` clangs. Surfaces: GROUND_NAMES (grass, dirt,
  mud, sand, snow, field → soil; road, rock → hard; shallow/deep/water → splash) and object kinds
  (house, barn, church, station, silo, ruin, wall, bridge → masonry; tree, pine, logs, fence, shed,
  haystack, hedge → timber).
- Hidden side effects are cheap: one-shots create a handful of nodes per event (no per-frame
  creation). Engines and fires are pooled voices whose params are updated in place.
- Old toy `main.js` shims kept until INTEGRATION replaces it: `play(k)`, `startMusic()`, `stopMusic()`.

## Signal flow
one-shot → placement (gain · lowpass · pan · delay) → **sfx** (+ send → field reverb) → **master** → compressor → soft limiter → out.
Player-perspective hits go to an **inside** bus (muffled, steel-box room reverb). Music → **music** bus (+ hall reverb).
UI and ambience are sub-buses of sfx. Speech volume = voice · master.

Positional model (`_pos`): inverse-distance gain `ref/(ref + roll·(d−ref))`, air-absorption lowpass
`20 kHz·e^(−d/220)` (≥ 500 Hz, darker behind), stereo pan from the listener's right vector
(`(−fwd.z, 0, fwd.x)`, i.e. −x when facing +z, matching the hull frame), reverb wetness rising with
distance, speed-of-sound delay `d/343` capped at 0.6 s. Max 40 concurrent one-shots (quiet ones dropped).

## Event → sound table
| event | world (AI vs AI) | player involved | crew line |
|---|---|---|---|
| shot | cannon by calibre: crack + blast + thump + rumble (<30 mm: short pop), muzzle-brake bark, positional with delay, echo send ∝ calibre | own gun: louder, deeper, recoil + breech clank + spent case | — |
| impact | by `surface`: soil thud + dirt spray, rock/building crack + rubble, water splash + bubbles, metal; HE shells → explosion ∝ calibre | shell landing < 30 m not fired by us: supersonic snap | — |
| hit pen / crit | crunch, thump, spall ticks (crit adds a bright ping) | shooter: same, no delay, level floor · target: huge inside clang + spall + ear ring (big calibres) | shooter: "Penetration!" / "Critical hit!" · target: "We're hit!" |
| hit nopen | ringing steel clang + spark | target: inside clang | "Didn't penetrate!" / "Armour held!" |
| hit ricochet | clang + descending whine | target: inside clang + whine | "Ricochet!" / "That one bounced!" |
| hit track | clank + link rattle | target: inside clank + rattle | "Hit their track!" |
| hit splash | small explosion | inside boom | "Hit!" if dmg > 0 / "We're hit!" |
| kill | explosion (ammorack: huge blast, fireball, cook-offs + wreck fire loop) | victim: inside | killer: "Target destroyed!" · victim: "We're knocked out!" |
| fire on/off | ignition whoomp + crackle/roar loop (nearest 4) | inside | "We're on fire!" / "Fire extinguished." |
| module | — | engine: cough; track destroyed: snap + rattle | "Engine damaged!", "Engine destroyed!", "Track destroyed!", "Gun damaged!", "Ammo rack damaged!", "Fuel tank hit!", "Turret ring damaged!", "Repairs complete." |
| crew (alive:false) | — | — | "Loader is wounded!" etc. (commander, gunner, driver, radio operator, loader) |
| spot | — | we are spotted: low alert chord | "We've been spotted!" · our team spots an enemy: "Enemy spotted!" (12 s cooldown) |
| treeFall / objectBreak | wood snaps, creak, leaves, trunk thud / timber-rubble crash | — | — |
| ram | steel grinding crunch ∝ dmg | inside | — |
| capture | two-tone alert (our base) / rising chirp (enemy base) when points leave 0 | — | "Our base is being captured!" / "Enemy base capture in progress" |
| consumable | — | repair ratchet, medkit zip, extinguisher hiss (also stops fire loop) | "Crew treated." (medkit) |
| reloaded | — | breech clunk by calibre | "Reloaded" only for guns with reload ≥ 4.5 s |
| end | stops engines/fires, victory or defeat stinger | — | "Victory!" / "Defeat." / "Draw." |

Engine voice (`engine(tank)`): rpm from a 5-gear model on |speed|/top speed plus throttle (uses
`tank.throttle` if present, else infers load from acceleration), idle firing frequency by mass and
power (heavy tanks lower); saw + sub-octave square → saturation → lowpass opening with rpm·load;
brown-noise rumble; track clatter = noise band AM'd by a pulse train at 2.4·|speed| Hz; squeal
∝ |yawRate| at low speed; turret whine ∝ |turretRate| (rad/s). Engine destroyed / dead → silent.
Budget: the player + nearest others up to 7 voices within 320 m; a closer tank steals the farthest
voice (15 m hysteresis); voices not updated for 300 ms fade out; idle voices are torn down after 8 s.

Crew voice: English male voice preferred (en-GB, then en-US; names like Daniel/David/George),
rate 1.08, pitch 0.82. Lines are collected for 70 ms and the highest priority wins; per-line
cooldowns, 0.5 s minimum gap, queue ≤ 3, lines expire after 3 s, a line ≥ 3 priority levels higher
interrupts the current one. A soft radio squelch plays before each line.

## How to test
- `tools/capped.sh -- node tools/audio-render.mjs [--wav DIR] [--png DIR] [--only a,b]`:
  node import smoke test, then 27 scenarios rendered with OfflineAudioContext in headless Chromium
  (files served from disk, no dev server). Reports peak (limited and raw), RMS, clipping, onset,
  length to −40 dB, low-band ratio, zero-crossing rate, pan, render speed; asserts: all audible,
  no clipping, raw peak < 1, 20 < 88 < 122 mm in length and low-band energy, own shot louder than
  others, 600 m shot delayed ≈ 0.6 s and darker, panning side, engine louder under throttle,
  one-shots < 6 s, music/ambience continuous, 7 engines + fire render ≥ 5× real time.
  `--png` writes spectrogram + waveform images (useful since nobody can listen in CI).
  Current: all 13 checks pass. Loudest: own 122 mm shot 0.79 (raw 0.89), inside hits ≈ 0.72.
- `tools/audio-lab.html` (via the dev server): buttons for every event (world / player shoots /
  player hit perspectives, distance, bearing, calibre, muzzle brake), every crew line, UI sounds,
  music/ambience, and a live engine sim (class, throttle, steer, turret rate, engine state, up to 12
  circling AI tanks to exercise the voice budget). `window.__audio` is exposed.

## Known gaps
- No shell fly-by whizz for shells in flight (needs per-frame shell positions; only near-miss impacts snap).
- Tracks don't vary by ground type (could use `groundAt` under the tank; needs the map in `engine()`).
- speechSynthesis can't be routed through Web Audio, so there's no radio filter on voices; voice quality depends on the OS.
- Autocannon bursts are one `shot` event per round; fine up to ~10 rounds/s.
- Can't listen here: the mix was tuned from levels and spectrograms, so it needs a listening pass in phase 3.

## CONTRACT CHANGE REQUESTS
- Clarify `capture.team`: I treat it as the **base owner** (as in `world.bases[].team`), so
  `team === player's team` means "our base is being captured". If SIM means the capturing team, tell
  me and I'll flip it (one line in `_capState`).
- Optional (non-breaking): `Tank.throttle` (−1..1, the applied control) would make engine load
  exact; without it load is inferred from acceleration.
- INTEGRATION: call `audio.event` for every event of every sim step (like the renderer), `audio.engine`
  each frame for the player plus tanks visible or within ~300 m, `audio.music('battle')` on battle
  start and `audio.stopAll()` + `audio.music('menu')` on return to the garage.
