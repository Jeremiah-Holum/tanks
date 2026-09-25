# PM backlog: items for later phases
- INTEGRATION: delete old src/ui.js, src/ui.css, src/garage3d.js, old src/main.js; tools/build.mjs → copy src/ui/ui.css; index.html loads src/ui/ui.css.
- INTEGRATION: set world.firstKill (the id of the first killer) from kill events if SIM hasn't (Spearhead medal).
- META follow-up: Sell button in the hangar/details (economy.sell exists).
- SIM: a pivot buried underground on a steep crest is unhandled (rare).
- SIM: delete old toy sim files (world.js, tanks.js, levels.js, game.js, director.js, mapgen.js, maps.js, ai.js) once main.js is replaced.
- RENDER-TANKS polish (later): early boxy silhouettes (MS-1, T-26, AT-1) need glacis frac/shape tweaks; M6 near LOD 29k tris (trim twin wheels); tracers not interpolated; track hitbox taper (SIM).

## Token ledger (cap 3.5M counted, hard ceiling 3.75M; uncounted work is free per the owner)
Counted (reported agents): SIM 357k, MAPS 291k, AUDIO 192k, SIM-review 198k, META 317k, RENDER-WORLD 430k, RENDER-TANKS 504k = ~2.29M
Free: INTEGRATION and AI (running when the cap was set).
Remaining for new agents: ~1.2M (to 3.5M), wiggle to ~1.45M.
