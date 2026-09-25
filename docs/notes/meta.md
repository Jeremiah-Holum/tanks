# META agent notes

Owns `src/meta/` (profile, economy, matchmaker, results, names, roster, rng), `src/ui/` except
`hud.js`, `tools/ui-lab.html`, `tools/ui-lab.js`, `tools/shot-ui.mjs`, `tools/meta-test.mjs`.

## How to test
- `node tools/meta-test.mjs` (add `--quiet` for the verdict only): 38 checks, all pass. It prints a
  sample battle's rewards, the matchmaker tier-spread histogram, a progression simulation per line
  and the per-tier reward table.
- UI lab: `python3 -m http.server 8477`, then open
  `tools/ui-lab.html?screen=hangar|tree|details|loading|results|record|settings`.
  Extra query params: `&tank=<id>`, `&nation=usa|germany|ussr`, `&result=victory|defeat|draw`,
  `&size=7`, `&fresh` (brand-new profile), `&persist` (use real localStorage), `&nomap`.
- Screenshots: `tools/capped.sh -- node tools/shot-ui.mjs [screen[:query] ...]` writes `shots/ui/*.png`
  (1280×720). `--flow` clicks through research → buy → garage → 7v7 → settings → BATTLE! on a fresh
  profile and asserts the state (all 7 pass). The tool serves Google Fonts through curl, because
  headless Chrome can't use the sandbox proxy.

## Screens API (for INTEGRATION)
```js
import { Screens } from './ui/screens.js';          // index.html must load src/ui/ui.css
const screens = new Screens(rootEl, {
  onBattle(tankId, { size, battle }) {},  // BATTLE! pressed. battle = buildBattle() result (see below)
  onSettings(settings) {},                // settings applied (profile.settings)
  audio,                                  // optional: Audio instance; uses .ui(kind), .music(on), .setVolumes({..., voiceOn})
  profile, storage,                       // optional overrides (default: localStorage 'steelfront.v1')
});
screens.showHangar(); screens.showTree(nation?); screens.showDetails(tankId?); screens.showRecord(); screens.showSettings();
screens.showLoading(battle, mapMeta?);    // mapMeta optional (looked up from MAPS by battle.mapId)
screens.setLoadingProgress(0..1, label?); screens.setLoadingMap(mapData);  // hill-shaded minimap with both bases
screens.finishBattle(world, playerTankId, battle) → report   // summarize + apply + save + show results
screens.showResults(report);              // applies the report to the profile if !report.applied
screens.hideAll();                        // hides the menus and releases the hangar's WebGL context
screens.profile / screens.settings / screens.save() / screens.toast(msg, 'info'|'warn'|'good')
screens.startBattle()                     // what BATTLE! does: buildBattle(profile, selected, {size}) → onBattle
```
- The root gets `hidden` when `hideAll()` runs. The menus use `position: fixed; inset: 0; z-index: 10`
  on the root, so put the battle canvas under it.
- Battle flow: `onBattle(id, {battle})` → `screens.showLoading(battle)` → `battle.map = loadMap(battle.mapId)`
  (or `await withMap(battle)` from `src/meta/matchmaker.js`) → `setLoadingMap(battle.map)` →
  `createBattle(battle)` → play → `screens.finishBattle(world, playerTank.id, battle)`.
  `battle.teams[t][i].player === true` marks the player's entry. The player's team is random (0 or 1).
- Settings (`profile.settings`): `quality` ('auto'|'low'|'medium'|'high'), `renderScale` 0.5..1, `fov`
  55..95, `mouseSens`, `sniperSens`, `invertY`, `volumes {master,sfx,music,voice}`, `voice` (callouts
  on/off; passed to audio as `voiceOn`), `minimap` ('small'|'medium'|'large'), `battleSize` 15|7,
  `showFps`, `damageLog`.
- Sounds requested from `audio.ui(kind)`: 'click' (every button), 'battle', 'research', 'buy'.
  `audio.music(true)` plays in the menus and `audio.music(false)` runs on loading and hideAll.
- The old `src/ui.js`, `src/ui.css` and `src/garage3d.js` are still imported by the old `src/main.js`.
  **INTEGRATION: delete them when `main.js` is replaced**, and change `tools/build.mjs` to copy
  `src/ui/ui.css` (index.html → `href="src/ui/ui.css"`).

## Meta API
- `profile.js`: `newProfile(name)`, `loadProfile(storage?)`, `saveProfile(p, storage?)`, `migrate(p)`,
  `tankState(p,id)`, `ownedIds(p)`, `selectTank(p,id)`, `crewSkill(p,id)` (0.5..1 from crew XP),
  `rankOf(p)`, `defaultAmmo(def, gun)`, `DEFAULT_SETTINGS`. The shape follows the contract, plus
  per-tank `gun` (mounted), `dmg`, `kills`, `bought`, and profile `name`, `lastWinDay`, `battleSeq`.
- `economy.js`: `computeRewards(input)`, `researchInfo/research`, `buyInfo/buy`, `sell` (50 %),
  `gunInfo/researchGun/mountGun`, `setAmmo`, `setConsumables`, `shellPrice`, `repairCost`,
  `consumablePrice`, `masteryFor/masteryThresholds`, `expectedXp(t)`, `isElite`.
  Research uses the best researched parent's XP first, then free XP. Gun `i` needs gun `i-1`.
- `matchmaker.js`: `buildBattle(profile, tankId, { size: 15|7, seed, mapId, playerTeam, timeLimit })`
  → `{ mapId, map: null, seed, timeLimit, mode, teams, meta }`. The tier templates are 3/5/7 (45 %),
  5/10 (35 %) and 15 (20 %), or 2/2/3, 3/4 and 7 for 7v7. The player's tank sits in any band, so the
  top tier is T..T+2 (T+1 at most for tiers I–II). Class and tier make-up is mirrored exactly
  between the teams, with class caps (lights ≤ 3, TDs ≤ 5, …). Bot skill is a bell curve of
  0.08..0.97, and the enemy team gets the same skills shuffled ±0.04. Bots mount the top gun with
  probability 0.25 + 0.65·skill, good bots carry 20 % premium ammo, and crewSkill = 0.55 + 0.42·skill.
  Bots get a `role` hint by class ('scout'|'flex'|'brawl'|'sniper'). Maps are random but never
  repeat the last map.
- `results.js`: `summarize(world, playerTankId, profile, battle?)` → report, `applyReport(p, report)`
  (applied once). `MEDALS` has 12 medals: Top Gun, High Caliber, Sniper, Steel Wall, Scout,
  Confederate, Invader, Defender, Kolobanov's, Pool's, Tough Nut and Spearhead (needs `world.firstKill`).
  Consumables used are read from `tank.consumables[i].used` (or `ready === false`), and shells used
  from `battle` entry ammo − `tank.ammo`.

## Economy (live roster)
Reward rates are **derived from the roster** (average research cost and price of tier t+1), so an
average player (≈1× own HP of damage, 50 % wins) spends `TARGET_BATTLES = [–, 1.5, 4, 8, 14, 26, 38]`
battles per tier. Rates are forced to rise at least 10 % per tier. Win ×1.5 XP (×1.25 credits),
first win of the day ×2 XP, 5 % free XP. Damage to higher tiers is worth +10 % per tier.
Service: repairs cost ≈1.4 % of the price at 0 HP, standard shells ≈0.05·cal^1.6, premium ×10,
and consumables 200 + 350·tier when used. **Tier I is free** (no repairs, standard ammo,
consumables), and the credits balance is clamped at 0.

| tier | exp. XP/battle | exp. net credits/battle | mastery 3rd / 2nd / 1st / Ace (base XP) |
|---|---|---|---|
| I | 159 | 2,520 | 198 / 270 / 357 / 476 |
| II | 274 | 9,726 | 342 / 465 / 616 / 821 |
| III | 429 | 17,719 | 536 / 729 / 964 / 1,286 |
| IV | 782 | 27,450 | 978 / 1,330 / 1,760 / 2,347 |
| V | 952 | 37,646 | 1,190 / 1,619 / 2,143 / 2,857 |
| VI | 1,228 | 41,410 | 1,535 / 2,088 / 2,763 / 3,684 |
| VII | 1,596 | 49,466 | 1,996 / 2,714 / 3,592 / 4,789 |

Progression simulation (average player): **tier V after 29 battles, tier VII after 93** on every
line (Panther: 78, because it skips tier VI). Examples:
`T1 → M2 LT @1 → M2 MT @6 → Lee @14 → M4 @29 → Easy 8 @56 → T20 @95`,
`MS-1 → AT-1 @1 → SU-76 @6 → SU-85B @14 → SU-85 @29 → SU-100 @56 → SU-152 @95`.
A tier-I potato (0 damage, dies, fires 20 shells) nets ≥ 0 credits every battle.

## Screens
- **Hangar**: 3D hangar (`hangar3d.js`) with a corrugated hall, an open door onto daylight, a
  turntable with a hazard ring, and orbit-drag and zoom. The turntable auto-rotates after 4 s idle.
  The tank is `buildTankModel` (falls back to armour solids). Panels: tank card with 4 parameter bars,
  XP/battles/wins/mastery, Details and Research; loadout (gun research/mount, ammo steppers
  (Shift ×10), Default/All AP, consumable toggles with keys 4/5/6, service estimate); a carousel with
  3D thumbnails (own small tone-mapped renderer, one fixed camera framed on the hull); and BATTLE!
  with a Standard 15v15 / Skirmish 7v7 selector.
- **Tech tree**: per-nation node graph laid out from `parents` (a parent sits on its first child's
  row, starters are centred), with elbow connectors coloured by state, node states (in garage,
  researched + price, can research, research available, locked), hover tooltip (XP from parent + free
  XP, missing XP ≈ battles, price), and confirm dialogs for research and buy.
- **Details**: all specs per gun, and the armour inspector (`armorView.js`), which shows armour solids
  from `solidFaces` coloured by nominal thickness, or by **effective thickness along the line of sight**,
  with front/side/rear/top/3/4 views and a hover readout (plate, nominal, angle, effective, ricochet warning).
- **Loading**: map name and blurb, both team lists (flag, name, tank, tier, class), a minimap (contour
  art until `setLoadingMap`), a tip and a progress bar.
- **Results**: banner (victory/defeat/draw), personal tiles, XP and credits ledgers, mastery badge
  (with the next threshold), medals, research progress towards the next tanks, and a team score tab.
- **Service record**: rank with progress, 12 career stats, a medal cabinet, a vehicles table and recent battles.
- **Settings** modal: Graphics / Controls / Audio / Game tabs, Defaults, Cancel, Apply, and a reset-progress confirm.

## Known gaps
- No sell button in the UI yet (`economy.sell` exists).
- No platoon, gold or premium tanks (gold is always 0).
- The hangar and each thumbnail build full LOD-0 models, and swiftshader takes about 20 s for the
  first hangar shot. That's fine on real GPUs.
- The kill list in results needs kill events, which the world doesn't keep. If SIM adds
  `world.firstKill` (the killer id of the first kill), Spearhead works.

## CONTRACT CHANGE REQUESTS
- (optional, SIM) `world.firstKill = killerId` on the first kill, and `tank.consumables[i].used`
  (a count). Both have fallbacks.
- `buildBattle()` returns `map: null` plus `mapId`, because loading the map (~0.3–1.5 s) belongs in the
  loading screen. INTEGRATION sets `battle.map` before `createBattle`. Maps load with their authored
  seed (`loadMap(id)`); the battle seed is for the sim only.
