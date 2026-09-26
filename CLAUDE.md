# Steel Front: rules for Claude sessions

A single-player World of Tanks–style browser game (three.js, pure ES modules, no server).
**Read `HANDOFF.md` first** for the state and next steps. Then read `BACKLOG.md` (queue),
`IDEAS.md` (owner's wishlist), `docs/DESIGN.md` (architecture contract + "PM rulings") and
`docs/notes/*.md` (per-area notes).

## Owner rules (from their feedback; don't undo without asking)
- **Never push broken or unverified work.** Run the checks below before every push. Work-in-progress
  stays local.
- Owner plays on Windows (work PC with Intel iGPU, home PC with a GPU). Medium = 60 fps on the home
  PC. Keep perf budgets in `src/render/quality.js`. High renders at pixel ratio 1.
- Audio: no high-pitched loops (the turret whine is muted: `TURRET_WHINE = 0`). The cannon must be a
  loud, heavy bang. It uses the real recording `assets/sfx/cannon.ogg` (GPL, see
  `assets/sfx/CREDITS.md`); the synth is the fallback.
- Gun spread: all guns use `SPREAD = 0.6` in `src/data/tanks.js`. Magazine autocannons bloom only
  a little per round (capped at 1.5× base). Firing never shrinks the aim circle.
- Visibility: every tank is always drawn (terrain, props and fog hide them). Spotted enemies get a
  red highlight, marker, minimap icon and autoaim. Bots only use spotted info.
- Budget-conscious: the owner caps token spend, so be surgical.

## Engineering rules
- Armour geometry lives ONLY in `src/sim/armor.js`. Models and hitboxes are built from the same
  solids.
- The sim (`src/sim/`) is deterministic and has no DOM. The renderer only reads sim state.
- One headless browser at a time, always via `tools/capped.sh -- node tools/…` (SwiftShader
  Chrome uses GBs of RAM).
- Checks before pushing:
  `node tools/rules-test.mjs` · `node tools/meta-test.mjs` · `node tools/maps-test.mjs` ·
  `node tools/build.mjs` · `tools/capped.sh -- node tools/verify.mjs low` (and
  `tools/capped.sh -- node tools/audio-render.mjs` for audio changes).
- Run locally: `npm install` then `npx http-server -p 8477 -c-1` and open http://localhost:8477
  (Windows PowerShell: use `npm.cmd` / `npx.cmd`).
