# AI notes (src/sim/ai/, tools/battle-sim.mjs)

Status: done for phase 2 (tuning can continue with the knobs below). Latest numbers under "Battle-sim results".

## API
```js
import { createBrain, TUNE } from './sim/ai/index.js'
const brain = createBrain(world, tank)   // once per bot, after createBattle
controls.set(tank.id, brain.control(world))   // every tick, before stepBattle
```
`control()` returns the same Controls object every tick (mutated in place). Dead tanks get an
idle control. `tank.bot.skill` (0..1, default 0.5) drives everything skill-related. A player
tank on the team is counted (lane strength, focus) but never steered. Read-only extras on the
brain for debugging/HUD: `mode` ('stage'|'post'|'push'|'cap'|'defend'|'cover'|'retreat'|'escape'),
`hold`, `arrived`, `wantMove`, `target`, `goal`, `post`, `knows` (tactics), `stats`.

Deterministic: every random choice uses a per-bot mulberry32 seeded from `world.seed` and the
tank id (team brains: world.seed and team). Never Math.random, never world.rng (so the AI
doesn't shift the sim's random stream). The AI only reads world state; it never writes to it.

## Files
| file | what |
|---|---|
| `index.js` | `Brain`: perception, decisions, driving, gunnery, consumables; `TUNE` knobs |
| `team.js` | `TeamBrain` (one per team per world): lane split and posts, memory of spotted enemies, lane strengths, push / all-in phases, base defence, nav overlay (congestion, wrecks, pinch points), danger map; per-team A* budget |
| `path.js` | A* (map/nav.js `findPath`) + string-pulling with a hull-width clearance and water check, pure-pursuit `Follower` |
| `combat.js` | aim candidates and weak spots (penPreview), hit probability model, shell choice |
| `util.js` | angles, lanes (`mapInfo`: lane geometry, points by geographic lane), shell slots |

## Behaviour
**Team plan (team.js).** Points are re-labelled by *geographic* lane (projection on
`map.lanes`), because team 1's `point.lane` is team-relative on the rotated maps. Initial
split: lights → scout points (then a passive bush in the same lane after 20–45 s or when lit),
TDs → sniper points (≤ 2 per point) then bushes, heavies → brawl points of the brawl lane (the
lane with most brawl points; 5th+ heavy to hull-down), mediums → the least-loaded lane
(hulldown / flank / bush / brawl points). Several bots on one point are spread sideways 12–14 m.
Bad players (P = 0.35 − skill) pick an odd spot: a random point or the open middle of a lane.
Phases (1 Hz): `push` 1 when stronger (value ratio > 1.35 after 150 s) or after 300 s; 2
(all-in, cap) after 450 s, ratio > 2.2, ≤ 2 enemies left. Value = class weight × 1.7^(tier−5)
× hp share (enemy hp as last seen). Base defence: when our base has cappers, the nearest bots
by ETA (2 + points/15 + cappers of them) go back and stop to shoot cappers.

**Opening.** Heavies and mediums first deploy at a staging spot (lane progress 0.2–0.3, the
least exposed cell from the prior danger map) for 45–105 s, then go to their posts. TDs and
lights go straight to their spots. Unspotted non-TDs hold fire beyond 220 m for the first
75–115 s (discipline).

**Lanes.** Heavies commit to the brawl lane at 80–140 s (mediums at 120–180 s, needing +1
numbers) when their lane is not outnumbered: next objective = the next point on the enemy side
of the lane, then their base. Pushing heavies / mediums only stop to fight inside brawl range
(170 m, up to 230 m when damaged) or when hit; TDs and lights keep their range. Mediums flex every 20 s to a lane that is winning (to push) or
collapsing (to hold). Pushing bots hunt the nearest remembered enemy (seen ≤ 30 s ago, sticky
target, a reached empty spot is "cleared") and cap when deep in enemy ground. A clearly winning
team (all-in, ratio > 1.8) sends every third tank straight to the enemy base, and after 9:20
everyone in all-in goes to cap (a capture rather than a time-out).

**Pathfinding.** A* over the team overlay: base nav + wrecks (permanent) + congestion (each
planned path adds cost to its cells, decays ×0.55 / 10 s, so teammates spread over parallel
streets) + stuck marks + pinch points (a hull-width `resolveCircle` check along each new route;
a gap between props that is narrower than this hull gets +8 and the route is re-planned) +
danger (skill-weighted, see below). String-pulling keeps a ±2.4 m corridor clear of expensive
cells and deep water. Pure pursuit with an 11 m + speed carrot (3 m when the carrot line
crosses deep water at bridges). Budget: 2 A* per team per tick.

**Danger map (avoid open ground in view).** 16 m cells, per team, built a slice per tick (90
line-of-sight rays/tick): (1) prior = cells seen from the enemy's sniper / bush / hull-down
points (map knowledge, 0.35 each); (2) for each enemy spotted in the last 20 s, cells it sees
from its last known position (1.0, 0.5 when older than 10 s). A* adds `dangerW` per seeing
enemy (0 for potatoes, 2.4·skill^1.5). Also used for staging spots and "safer spot" moves.

**Driving.** Friendly tanks and wrecks ahead: steer round, slow down (the lower tank id has
right of way when two allies meet head-on). Unstick: progress = remaining route length
shrinking; two 2 s windows of trying without progress (or a pivot that doesn't turn) →
reverse 1–2 s with a random turn, mark the cell ahead as blocked, replan; the 2nd time in 45 s
also drive to a clear escape point 14–24 m away first; the 4th time jitter the goal. A goal
you can't reach after 2 unsticks within 22 m counts as reached.

**Combat.** Only `world.visible[team]` (spotted) enemies within 600 m are candidates, after
a reaction delay (0.2 s unicum … 1.5 s potato) and a line-of-sight check from the gun. Score
= pen chance (hull-centre penPreview, cached aim point for the current target) + kill chance
(hp ≤ our alpha) + threat (alpha/reload, ×1.6 if its gun points at us) − distance + team
focus (skill²) + stickiness; potatoes add noise. Aim point = best expected pen-hit over
candidates (hull, turret; +UFP/LFP/sides for skill ≥ 0.3; +cupola, turret ring, turret side,
rear side for ≥ 0.58), each checked with lineClear (hull-down) and penPreview; the value counts
the spot and the rest of the tank the shot may land on instead. Lead = target velocity × shell
flight time × (0.25 + 0.75·skill). Personal aim error (0.08 + 3.6·(1−s)^1.6 m at 200 m,
shrinking while tracking to a floor). Fire decision: optimal stopping on hits/second with the
sim's actual dispersion (half-normal radius, σ = R/2): fire when waiting 0.3 s more gains less
than pNow / (cycle · patienceK); patienceK = 0.1 + 0.6·skill; also fire when patience runs out
or the target is about to vanish. Never fire when predictImpact says an ally or a wall is in
the way. After ~3 s of a loaded gun that can't make the shot (depression, crest) the target is
dropped for 12 s so the bot moves. Shells: HE vs open tops / paper armour / low-hp finishes,
APCR (budget (s−0.6)·25 rounds) when AP pen chance < 45% and APCR adds 30%; switching only
right after a shot (switching reloads). Fire range: light 250, medium 300, heavy 270, TD 450 m
while unspotted (potatoes ×1.6); up to 445 once lit.

**Positioning / survival (skill-rolled tactics, `knows`).** Each bot rolls once per tactic
with P ramping with skill (so there is a gradient): `cover` (lit on the way to a post and
shot at → reverse into cover within ±50° behind; seen by ≥ 2 enemies at a post → slide to a
spot ≤ 34 m away that ~1 enemy sees), `duck` (over-exposed: ≥ 3 guns on us / 2 at < 70% hp /
25% hp lost recently → back off if that breaks the sight lines), `peek` (reload ≥ 4.5 s: back
off after the shot while lit, return when nearly loaded), `bush` (snipers sit ~18 m behind the
bush so the muzzle flash doesn't cost the bush), `angle` (heavies / thick mediums angle the hull
25–50° to the threat), `relocate` (TDs / passive lights move when lit and shot without an
answer), `retreat` (< 25% hp → fall back), `discipline` (range and opening fire discipline,
no low-odds snap shots on the move). Everyone stops to fight back when a target is inside
engage range on the way to a post (A/B: better than driving on through fire); skilled bots then
use cover. A sniper sitting behind its bush may shoot out to 445 m (the shot keeps its camo).

**Consumables.** Extinguisher on fire, repair on a destroyed track under fire / destroyed
engine / destroyed gun in combat / damaged ammo rack (unicums), medkit on a dead crew member;
all after a skill-scaled delay (0.4–2.9 s).

## Tuning knobs
In `index.js`: `ENGAGE_RANGE`, `FIRE_RANGE`, the skill formulas at the top of the `Brain`
constructor (react, evalN, aimErrBase, errFloor, patience, patienceK, leadK, goldBudget,
openingT, stageUntil, brawlPushAt, dangerW, yolo) and the tactic ramps (`tr(k, lo, hi)`).
`TUNE[k]` multiplies a tactic's probability (cover, duck, peek, bush, angle, relocate, retreat,
discipline, route) or the danger weight (danger); `battle-sim --tune cover=0,danger=0.5`.
In `team.js`: `PLANS_PER_TICK`, `PRIOR_W`, class values, push thresholds, defence count.

## Battle-sim
`node tools/battle-sim.mjs [--n 8] [--maps a,b] [--workers 2] [--seed 1] [--limit 900] [--v]
[--skills 0.8,0.3] [--tune k=v,...]` — n battles per map, matchmaker teams (random tier II–VII
anchor, its player slot becomes a skill-0.5 bot), worker threads. `--v` prints kills, a 30 s
state summary and stuck diagnostics. Stuck = alive, wanted to move in ≥ 10 of the last 13
five-second samples, and stayed within 8 m for 60 s.

Duel check (1v1 M4 vs M4, 260 m, stationary): skill 0.9 beats 0.15 59:1, beats 0.5 39:21;
0.5 beats 0.15 56:4. Tiger vs Tiger 0.9 vs 0.5: 32:8.

## Battle-sim results
Final run: `node tools/battle-sim.mjs --n 16 --workers 2` (64 battles, 16 per map, seed 1).
| map | t0 / t1 / draw | destroyed / capture / time | median min (range) | in 4–10 min | stuck |
|---|---|---|---|---|---|
| kessel | 9 / 7 / 0 | 10 / 6 / 0 | 5.3 (3.6–6.9) | 75% | 0 |
| ashford | 6 / 9 / 1 | 14 / 1 / 1 | 9.4 (5.1–15) | 69% | 1 |
| steppe | 7 / 9 / 0 | 16 / 0 / 0 | 6.0 (4.8–9.4) | 100% | 0 |
| kolvik | 7 / 8 / 1 | 15 / 0 / 1 | 6.7 (3.5–15) | 81% | 1 |
| all | 29 / 33 / 2 | 55 / 7 / 2 (3%) | 6.5 (mean 7.1) | 81% | 2 of 1920 |
- Per class dmg/hp, survival: light 0.44 / 6%, medium 0.77 / 10%, heavy 0.73 / 10%, TD 1.33 / 26%.
  Hit 49%, pen 72% of hits, 11.8 shots per tank.
- Deaths by time: < 1 min 4%, 1–2 min 18%, 2–3 min 30%, 3–4 min 22%, 4–6 min 16%, later 11%.
  Kill distance < 100 m 18%, 100–200 25%, 200–300 28%, 300–400 20%, 400+ 9%.
- Skill (potato < 0.35 / average / unicum > 0.65): dmg/hp 0.57 / 0.92 / 1.20, survival
  8 / 15 / 20%, lifetime 3.3 / 3.8 / 4.5 min, hit 34 / 51 / 59%, pen 65 / 70 / 78%, kills
  0.48 / 0.89 / 1.07. r(skill, dmg/hp) = 0.26 (0.27 with class and tier factored out; within
  class: heavy 0.31, TD 0.32, medium 0.24), r(skill, lifetime) 0.19, r(skill, survived) 0.12,
  r(skill, hit%) 0.37. Team level: an all-0.85 team beats an all-0.2 team 14:2.
- AI cost 0.004 ms per bot per tick on average (worst battle 0.013), 0.12 ms per tick for 30
  bots; sim 0.12 ms per tick. A* is budgeted at 2 per team per tick (~1 ms each).
- Duels (1v1 M4, 260 m, stationary): 0.9 beats 0.15 59:1 and 0.5 39:21; 0.5 beats 0.15 56:4.

History (what moved the numbers): danger-aware routing + staging → deaths in the first minute
from 26% to 4%; pHit model matched to the sim's half-normal dispersion → unicums stopped
over-waiting (duel 0.9 vs 0.5 went from 21:39 to 39:21); per-team A* budget fixed a team-0
bias (20:5 → even); "give up on an unshootable target" fixed embankment stand-offs (kolvik
time-outs 38% → 6%); hull-width pinch check + right of way + water-aware smoothing took stuck
tanks from ~15 to ~2 per 48 battles.

## What's still off (priority order, best guess at the fix)
1. **Skill correlation ~0.26, survival ~0.12 (target 0.3).** Unicums still die moving to /
   in cover (≈45% of their deaths are `cover/*`). Fix: pick cover from the danger map before
   leaving (only spots reachable by reversing ≤ 15 m, else stay and fight), time peeks to the
   enemy's reload (shot events of visible enemies give their reload window), and choose posts
   by prior danger (skilled bots take the less exposed bush of a pair).
2. **Long-range bias: 29% of kills at 300 m+, 43% under 200 m.** The maps are open and
   view ranges reach 400 m; TD sniper points see across the map. Fix: TD fire range 450 → 380
   unless hidden behind a bush, and move medium posts to the brawl side of their lane after
   the opening (flex mediums currently sit on hull-down points 250–350 m from the enemy's).
3. **Kessel is short (median 5.3 min, 6 of 16 by capture) and Ashford long (9.4).** Kessel's
   banks are open pasture; Ashford's village stalls pushes. Fix: per-map push timers (earlier
   all-in on Ashford), and on Kessel stage behind the town rather than in the fields.
4. **Lights die (6% survive, 0.44 dmg/hp).** They sit on the scout point too long. Fix: leave
   the scout point as soon as anything is spotted, and only passive-spot from bush points with
   foliage between them and the enemy.
5. **Landslides**: most battles end 15:3–15:8, a few 15:0–15:1. Mostly a snowball of early
   trades; a "don't push alone" rule (wait for 2+ allies in the lane) would slow it.
6. **Stuck: ~1 per 30 battles**, all at blocked goals next to buildings (arrived via the
   "can't reach it" rule, then idle). Fix: pick a new post when a goal is declared unreachable.

## CONTRACT CHANGE REQUESTS
- None. (The AI uses only exported sim / map functions; no sim edits.)
