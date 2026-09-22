# Toy Tanks — handoff (written 2026-09-22 20:40 UTC)

Read this before BACKLOG.md. It says where the work actually stands, which
the backlog does not, because the session driving it died mid-phase.

## What happened
The session ("Risk", Claude Code, PM in the main thread, two Opus 5.5
subagents coding Phase B and Phase C in parallel) was killed by the Linux
OOM killer at 19:10 UTC. Two headless Chrome processes rendering the 3D game
in software (SwiftShader, no GPU) reached 5.8 GB each on a 16 GB box with no
swap; the kernel killed one, systemd then killed the whole tmux scope, and the
session and both agents went with it. No code was corrupted. Every file
parses and `node tools/build.mjs` succeeds.

Rule for the next machine: one headless browser at a time, or give the box a
GPU or swap. The verify tool renders at three quality tiers; running them in
parallel is what did it.

## State of the code (commit 99c8633)
- Phase A (rules overhaul, sim only): done, verified, committed at fffeb2a.
  `tools/rules-test.mjs` 36/36; ladder Ace>Vet 0.78, Ace>Cadet 0.92; no tick
  over 4 ms with 12 tanks.
- Phase B (rendering) and Phase C (UI/flow): CODED, NOT VERIFIED, committed
  as a checkpoint at 99c8633 exactly as the agents left them.
- Phase D (verify, QA, ship): not started.
- The live site https://toytanks.jer.couleetech.network was deployed from
  99c8633 at 20:36 UTC without verification, on the owner's instruction.

## Phase B agent — what it finished, from its transcript (never reported)
In order, with its own notes:
- textures/post: fixed AO quad winding; removed a double sRGB→linear convert.
- fx.js: streak sparks (velocity-stretched), flames, engine smoke, smoulder,
  per-surface impact effects; ricochet streaks retuned to thin glancing
  lines; pen debris shrunk; no-pen clank made visible.
- view.js: FULL REWRITE — world-sized board, room and camera for any map
  size, prop pipeline, class tank models, damage and wreck states, the
  single straight aim line, the screen anchor.
- models.js: four class models (light/medium/heavy/TD) "read right" in the
  lab; paints made distinct per tank (they had all come out green); grass
  tufts rescaled against the tanks.
- Damage states staged in the lab: smoke, fire, thrown track, ammo-rack
  wreck. A "glint" artefact on the chase cam beside houses was removed.
- LAST THING IT WAS DOING (19:08–19:10): performance on the 48×34 town map
  with 12 tanks — 417 draw calls, 756k triangles — looking at which prop
  buckets carry the triangles. Its final edit to src/render/models.js
  (turning body trim into paint and lamps into detail) was cut off by the
  kill; check that edit is coherent before trusting it.
- Tools it added: tools/lab.html, tools/lab.js, tools/labshot.mjs — a
  paused render lab for screenshotting models, damage states and props
  without playing.
- Not confirmed by it: B1 (scale to any map size) beyond the rewrite, B6
  re-verify on big maps, B7 perf target.

## Phase C agent — what it finished
- Wrote tools/verify.mjs: drives the full flow (title → garage → mission →
  death → retry → clear → versus) by real input at a given quality, with
  optional --shots. Expects the repo served at http://127.0.0.1:8477
  (TT_PORT overrides).
- Its own run PASSED on `low`. The `medium` and `high` runs were killed
  before finishing. Its last edit was a small fix to verify.mjs's click
  helper at 19:05.
- Backlog items C1–C5 (minimap removed, HP/module HUD, garage, team versus,
  help text) were all in its brief; which are complete is not recorded —
  run the verify tool and play it.

## Next steps, in order
1. `npm install`; `node tools/rules-test.mjs`; `node tools/sim.mjs ladder 10`
   — confirm Phase A still holds under the new render code (it should; the
   sim does not import the renderer).
2. Serve the repo on 8477 and run `node tools/verify.mjs low --shots shots/x`,
   then medium, then high, ONE AT A TIME. Fix what fails.
3. Play it in a real browser against BACKLOG.md phases B and C; tick what is
   true, reopen what is not.
4. Phase D as written in the backlog.

## Where the context lives (on the original box)
- Session transcript: ~/.claude/projects/-home-jer-Projects-CCTS/1564c59d-9e0d-4b5c-b322-ede5f670bc47.jsonl
- Agent transcripts: same path, /subagents/agent-a23e14f9a21f06f4d (Phase A),
  agent-a76b37ed0483b1214 (Phase B), agent-a391af486a957b4e6 (Phase C).
- Hosting recipe: ~/Projects/GAME_HOSTING.md. Owner notes: ~/Projects/CLAUDE.md.
Copies of all of these ship in the export archive under context/.
