# Toy Tanks

A Wii Play Tanks–style arena shooter in the browser, built with three.js and
styled as a miniature: plastic toy tanks on a cork board of alphabet blocks.
See `SPEC.md` for the design, `BACKLOG.md` for the work plan and `HANDOFF.md`
for where development currently stands.

## three.js

three.js comes from npm, not from the host machine. The exact version is set
in `package.json` / `package-lock.json` (three 0.185.1). `npm ci` installs
that version, so the game renders the same on any machine. The code uses
`three/examples/jsm` addons (`RoundedBoxGeometry`, `BufferGeometryUtils`),
whose APIs change between three.js releases, so don't swap in another copy.

## Setup

Needs Node 18+ (developed on Node 22).

```sh
npm ci
```

## Run (development)

The root `index.html` loads `src/` directly and uses an import map pointing at
`./node_modules/three/`, so serve the **repo root** over HTTP after `npm ci`:

```sh
python3 -m http.server 8477
# open http://127.0.0.1:8477/
```

Any static server works. Opening the file directly (`file://`) won't work
because ES modules need HTTP.

## Build (production)

```sh
node tools/build.mjs
```

This writes `dist/` with three files: `index.html`, `game.js` (the game plus
three.js, bundled and minified by esbuild) and `ui.css`. `dist/` is fully
self-contained, so you can copy it to any static web host. The host doesn't
need Node or three.js.

`deploy.sh` builds and copies `dist/` to `/var/www/toytanks/` on the original
server. Change the paths in it for another host.

## Tools

| Command | What it does |
|---|---|
| `node tools/rules-test.mjs` | Headless rules tests; exits non-zero on failure |
| `node tools/sim.mjs [campaign\|ladder\|director\|teams\|perf\|all] [N]` | Headless balance and AI checks |
| `node tools/verify.mjs [low\|medium\|high] [--shots dir]` | Plays the full UI flow in headless Chromium. Needs the repo served on port 8477 (`TT_PORT` overrides) |
| `node tools/shot.mjs <query> <out.png> [w] [h] [js]` | Screenshot of the game |
| `tools/lab.html` + `node tools/labshot.mjs` | Paused render lab for models, damage states and props |

`verify.mjs`, `shot.mjs` and `labshot.mjs` need Playwright, which isn't in
`package.json`. Install it with `npm i -D playwright`. Run **one** headless
browser at a time: software rendering uses several GB of RAM per instance.

## Layout

```
index.html        dev entry (import map → node_modules/three)
src/main.js       boot
src/sim/          game rules, maps, AI, director (no three.js dependency)
src/render/       three.js view, models, props, effects, post-processing
src/ui.js, ui.css menus and HUD
src/input.js      keyboard, mouse, gamepad
src/audio.js      sound
tools/            build, tests, sims, screenshot and verify scripts
```
