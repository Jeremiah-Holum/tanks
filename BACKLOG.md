# Steel Front: backlog

Status: ☐ todo · ☑ done. The detail for each item lives in HANDOFF.md and docs/notes/*.md.

## Done (2026-09-25)
- ☑ Contract and architecture (docs/DESIGN.md)
- ☑ Roster: 47 tanks, 3 nations, tiers I–VII, research tree
- ☑ Sim: WoT armour, ballistics, dispersion, modules, crew, fire, spotting, capture (rules-test 91/91), plus an independent review with 11 fixes
- ☑ Maps: Ashford Fields, River Kessel, Steppe Ridge, Kolvik Pass (maps-test 1356/1356)
- ☑ Rendering: world (terrain, sky, fog, water, props, 3 themes, quality tiers), tank models from the armour solids, FX, wrecks
- ☑ Meta: economy, research, matchmaker, results, all garage screens (meta-test 38/38)
- ☑ Audio: synthesized SFX, engines, music, crew voice
- ☑ AI: roles, lanes, danger-map routing, weak-spot aim, skill scaling (battle-sim: median 6.5 min)
- ☑ Integration: WoT camera, sniper, autoaim, full HUD, battle loop, results (verify 18/18 on low and medium)
- ☑ QA pass: 4 majors fixed, no blockers found

## Next
- ☐ Real-GPU fps measurement and quality tuning; a listening pass on the audio
- ☐ AI: skill → survival correlation, light-tank survival, fewer long-range kills, map length balance
- ☐ Garage: Sell button
- ☐ HUD: scale bottom panels at 1080p+; "skip to results" after leaving dead
- ☐ Visual: early-tank silhouettes, US hull variety, M6 triangle count, tracer interpolation, water reflections, crater props
- ☐ Sim: rear-deck depression, HEAT after spaced armour, buried-pivot edge case
- ☐ Deploy: update deploy.sh target for Steel Front
- ☐ Content: more maps, premiums, tier VIII+, encounter mode, crew skills, artillery
