# AUDIO agent notes

Status: phase 3 rework done (owner feedback: high-pitched noise on mouse move, thin cannons, weak engines, thin SFX). Owns `src/audio.js`, `src/audio/*.js`, `tools/audio-lab.html`, `tools/audio-render.mjs`.
Everything is Web Audio synthesis (noise buffers, biquads, waveshapers, convolution reverb from
generated impulse responses) plus `speechSynthesis` for the crew. No audio files.

## Files
- `src/audio.js`: the `Audio` class (buses, positional placement, event routing, voice lines).
- `src/audio/core.js`: `Kit`: noise/brown/crackle buffers, field + room impulse responses, primitives (`noise` with optional `drive` saturation, `tone`, `boom` = pitch-dropping soft-clipped sub, `punch` = pressure-wave kick, `thunder` = rolling outdoor tail with terrain reflections, `metal`, `ticks`).
- `src/audio/sfx.js`: one-shot recipes (cannon by calibre, explosions, ammo rack, impacts by surface, hits outside/inside, ricochet whine, ram, tree, crash, fire, reload, consumables, UI, alerts).
- `src/audio/engine.js`: pooled continuous voices: `EnginePool` (engine by type, tracks, pivot grind, suspension thuds) and `FirePool`.
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
// new Audio({ context }) renders into a given (Offline)AudioContext; { raw: true } skips the final soft clipper.
// ?debug=audio (or new Audio({ debug: true })): window.__audioLog gets every ui/event/say call and, every
// 250 ms, each active engine voice's gain stages plus the output level in bands (<120 Hz, <2 kHz, >2 kHz)
// and the loudest bin above 2 kHz (AnalyserNode on the final output).
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
one-shot → placement (gain · lowpass · pan · delay) → **sfx** (+ send → field reverb) → **duck** → **master** →
glue compressor (−20 dB, 3:1, 6 ms / 300 ms) → makeup ×1.25 → peak limiter (−6 dB, 20:1, 1 ms) → tanh soft clip → out.
The player's own shot and hits on the player (the **inside** bus: muffled, steel-box room reverb) go to a **front**
bus that skips the duck; they dip the duck bus (world sfx, music, ambience) sidechain-style: own shot to
0.35→0.25 (by calibre) for 0.1–0.25 s, released over 0.25–0.55 s; a hit on us to 0.45 with a 0.8 s release.
Music → **music** bus (+ hall reverb) → duck.
UI and ambience are sub-buses of sfx. Speech volume = voice · master.

Positional model (`_pos`): inverse-distance gain `ref/(ref + roll·(d−ref))`, air-absorption lowpass
`20 kHz·e^(−d/220)` (≥ 500 Hz, darker behind), stereo pan from the listener's right vector
(`(−fwd.z, 0, fwd.x)`, i.e. −x when facing +z, matching the hull frame), reverb wetness rising with
distance, speed-of-sound delay `d/343` capped at 0.6 s. Max 40 concurrent one-shots (quiet ones dropped).

## Event → sound table
| event | world (AI vs AI) | player involved | crew line |
|---|---|---|---|
| shot | cannon by calibre: pressure punch + 30–80 Hz sub with fast pitch drop + saturated blast body + mid crack + supersonic snap + rolling 1–4 s thunder with terrain reflections (<30 mm: hard pop); muzzle-brake bark; far shots (`far` from distance) drop crack/snap and are mostly tail | own gun: extra long low boom, recoil slam + breech clank, spent case; ducks everything else | — |
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

Engine voice (`engine(tank)`): one oscillator at the crank-cycle rate (rpm/120) playing a PeriodicWave of one
4-stroke cycle of damped exhaust pulses, `cyl` per cycle with per-cylinder level/timing spread: so the stack
sits on the firing frequency (rpm·cyl/120) with sub-harmonics from the spread (a lumpy idle, not a tone).
→ pre-drive ∝ load → tanh → exhaust lowpass (opens with rpm·load, closes on overrun) → +6 dB muffler body at 95 Hz.
Combustion gravel / diesel knock = white-noise band × the same pulse wave, ∝ load. Brown-noise rumble,
quiet mechanical band. Engine types (`engineType(def)`): `radial` (US, 9 cyl, 700–2400 rpm, blatty),
`maybach` (German V12 petrol, 750–3000, smoother), `diesel` (Soviet V-2, 550–2000, knocking), `small`
(< 14 t, 6 cyl). A damaged engine gets a misfiring cylinder and a wobble. 5-gear rpm model; an upshift is
a 0.28 s throttle lift plus a clunk. Tracks: clank (noise AM'd by a pulse train at 0.4 + 1.6·v Hz) and
rattle (second train at 0.6 + 3.7·v Hz), pivot grind (dark lowpassed brown noise, no resonant squeal),
random suspension thuds at speed. No turret whine: it was the high-pitched mouse-move noise (see below).
Shared noise sources feed every voice; nodes are built once per voice.
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
  Added checks: calibre ordering 20 < 37 < 75 < 88 < 122 < 152 in sub-120 Hz level; ≥ 75 mm cannons
  have ≥ 50 % of their energy below 120 Hz; a mouse-only TD traverse adds ≤ 1 dB above 2 kHz over idle;
  engines have no narrow peaks above 2 kHz. Metrics added: sub<120 dB, hi>2k dB, peak prominence, pulse
  modulation. `AUDIO_ROOT=<checkout>` renders another tree (before/after comparisons).
  Current: all 17 checks pass. Loudest: own shots ≈ 0.83 (pre-clipper 0.84), everything big rides the limiter.
- `tools/audio-lab.html` (via the dev server): buttons for every event (world / player shoots /
  player hit perspectives, distance, bearing, calibre, muzzle brake), every crew line, UI sounds,
  music/ambience, and a live engine sim (class, throttle, steer, turret rate, engine state, up to 12
  circling AI tanks to exercise the voice budget). `window.__audio` is exposed.

## The high-pitched noise on mouse movement (phase 3)
Cause: the turret traverse whine. SIM's `turretRate` is in **deg/s** but the whine treated it as rad/s, so
a mouse sweep (20–40 °/s) drove its oscillators to 330 + 420·rate ≈ 10–17 kHz. Muted by the PM
(`TURRET_WHINE = 0`), owner confirmed; the nodes are now gone entirely. Also removed: the 2600 Hz / Q 14
track-squeal band that played when a TD auto-turns its hull on the spot (offline: +7.3 dB above 2 kHz
during a TD traverse vs idle before, +0.7 dB now). Instrumented in-game with ?debug=audio (a scratch
Playwright probe that moves only the mouse): no ui/event/say call fires on mouse movement in the hangar
or in battle, and output energy above 2 kHz stays at the floor (jagdpanther: −60 dB moving vs −59 dB still).

## Before / after (tools/audio-render.mjs, shots/audio/before-* and after-*)
| sound | sub<120 Hz before → after | share of energy <120 Hz | peak |
|---|---|---|---|
| 20 mm @50 m | −60.5 → −47.8 dB | 0.14 → 0.15 | 0.17 → 0.47 |
| 75 mm @50 m | −47.5 → −28.0 dB | 0.44 → 0.78 | 0.30 → 0.78 |
| 88 mm @50 m | −44.8 → −26.2 dB | 0.51 → 0.81 | 0.34 → 0.78 |
| 122 mm @50 m | −39.1 → −23.0 dB | 0.67 → 0.84 | 0.43 → 0.80 |
| 152 mm @50 m | −36.8 → −20.4 dB | 0.72 → 0.86 | 0.44 → 0.81 |
| own 122 mm | −28.3 → −16.0 dB (rms 0.046 → 0.175) | 0.69 → 0.82 | 0.79 → 0.82 |
| ammo rack @40 m | −34.4 → −19.4 dB | | 0.28 → 0.79 |
| player engine, full throttle | −26.0 → −22.1 dB (rms 0.062 → 0.122) | | 0.22 → 0.35 |
Engines: harmonic stacks on the firing frequency with pulse modulation (5 ms envelope CV 0.28–0.44), no
narrow peaks above 2 kHz (max prominence 2.2 dB). Nothing clips; pre-clipper peak ≤ 0.85.

## Known gaps
- No shell fly-by whizz for shells in flight (needs per-frame shell positions; only near-miss impacts snap).
- Tracks don't vary by ground type (could use `groundAt` under the tank; needs the map in `engine()`).
- speechSynthesis can't be routed through Web Audio, so there's no radio filter on voices; voice quality depends on the OS.
- Autocannon bursts are one `shot` event per round; fine up to ~10 rounds/s.
- Can't listen here: the phase-3 mix was tuned from levels and spectrograms; big sounds now sit on the limiter, so if
  the mix feels squashed, lower `SFX` (src/audio.js) or the limiter makeup before touching recipes.
- CPU: the layered one-shots create ~2–3× more nodes per event. verify's headless fast-sim (0.3–0.9 fps, many
  seconds of events per frame) now reports audio 17–28 ms/frame (6 ms noted earlier); 7 engines + fire render at ×6
  real time offline (check: ≥ ×5). If it shows on real PCs, trim layers for quiet placed sounds (gain < 0.05).

## CONTRACT CHANGE REQUESTS
- Clarify `capture.team`: I treat it as the **base owner** (as in `world.bases[].team`), so
  `team === player's team` means "our base is being captured". If SIM means the capturing team, tell
  me and I'll flip it (one line in `_capState`).
- Optional (non-breaking): `Tank.throttle` (−1..1, the applied control) would make engine load
  exact; without it load is inferred from acceleration.
- INTEGRATION: call `audio.event` for every event of every sim step (like the renderer), `audio.engine`
  each frame for the player plus tanks visible or within ~300 m, `audio.music('battle')` on battle
  start and `audio.stopAll()` + `audio.music('menu')` on return to the garage.
