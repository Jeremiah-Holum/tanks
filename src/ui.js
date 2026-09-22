// DOM overlay: menus, banners, HUD, minimap, off-screen markers, results.
import { TYPES, ENEMY_ORDER } from './sim/tanks.js';
import { CAMPAIGN, VERSUS, parseLevel } from './sim/levels.js';
import { COLS, ROWS, CELL, liveShellsOf, liveMinesOf } from './sim/world.js';

const hex = (c) => '#' + c.toString(16).padStart(6, '0');
const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(k));
  return e;
};
export const VS_COLORS = [0x2f7dff, 0xe8453c, 0x19b36b, 0xf2c230];
export const VS_NAMES = ['Blue', 'Red', 'Green', 'Gold'];

export class UI {
  constructor(root, sound) {
    this.root = root; this.sound = sound || (() => {});
    this.layers = {};
    for (const n of ['hud', 'banner', 'screen', 'toast']) { const l = h('div', { class: 'layer' }); root.append(l); this.layers[n] = l; }
    this.hudEls = null;
  }
  clear(name) { this.layers[name].innerHTML = ''; }
  _btn(label, sub, onclick, cls = '') {
    return h('button', { class: 'btn ' + cls, onclick: () => { this.sound('ui'); onclick(); } }, label, sub ? h('span', { class: 'sub' }, sub) : null);
  }

  // ---------------------------------------------------------------- title
  title({ canContinue, continueLabel, onCampaign, onContinue, onVersus, onSettings, onHelp }) {
    this.clear('screen');
    const menu = h('div', { class: 'menu interactive' },
      canContinue ? this._btn('Continue', continueLabel, onContinue, 'primary') : null,
      this._btn('Campaign', '20 missions · the toy-box war', onCampaign, canContinue ? '' : 'primary'),
      this._btn('Versus', 'you against the bot engines', onVersus),
      this._btn('How to play', null, onHelp),
      this._btn('Settings', null, onSettings),
    );
    this.layers.screen.append(h('div', { class: 'title-wrap fade-in' },
      h('div', { class: 'logo' }, h('div', { class: 't1' }, 'TOY TANKS'), h('div', { class: 't2' }, 'Tabletop Armoured Warfare'), h('div', { class: 'ribbon' }, 'BATTERIES NOT INCLUDED')),
      menu,
      h('div', { class: 'foot' }, 'WASD drive · mouse aims · click fires · space lays a mine · V switches view'),
    ));
    setTimeout(() => menu.querySelector('button')?.focus(), 50);
  }

  // ---------------------------------------------------------------- panels
  panel(kicker, title, body, actions) {
    this.clear('screen');
    const p = h('div', { class: 'panel interactive fade-in' }, h('div', { class: 'kicker' }, kicker), h('h2', {}, title), ...body, h('div', { class: 'actions' }, ...actions));
    this.layers.screen.append(h('div', { class: 'panel-wrap' }, p));
    return p;
  }
  seg(options, value, onChange) {
    const wrap = h('div', { class: 'seg' });
    const render = (v) => { wrap.innerHTML = ''; for (const [val, lab] of options) wrap.append(h('button', { class: val === v ? 'on' : '', onclick: () => { this.sound('ui'); onChange(val); render(val); } }, lab)); };
    render(value);
    return wrap;
  }

  campaignSelect({ best, onStart, onBack }) {
    const starts = [0, 5, 10, 15].filter((m) => m <= best);
    const list = h('div', { class: 'maps' }, ...starts.map((m) => {
      const c = this.mapThumb(CAMPAIGN[m].rows);
      return h('div', { class: 'map', onclick: () => { this.sound('uiBig'); onStart(m); } }, c, `Mission ${m + 1}`, h('div', { style: 'font-weight:400;opacity:.7' }, CAMPAIGN[m].name));
    }));
    this.panel('Campaign', 'Choose a start', [h('p', {}, 'Every fifth mission is a checkpoint once you reach it. Three lives; clear missions 5, 10 and 15 for an extra tank.'), list], [this._btn('Back', null, onBack, 'small')]);
  }

  help(onBack) {
    const keys = h('div', { class: 'keys' },
      h('kbd', {}, 'W / S'), 'Drive forward / reverse (chase view) — or move in that screen direction (tactical view)',
      h('kbd', {}, 'A / D'), 'Turn the hull',
      h('kbd', {}, 'MOUSE'), 'Traverse the turret (chase view locks the pointer; click to grab it)',
      h('kbd', {}, 'LEFT CLICK'), 'Fire. You have 5 shells in the air at once; each bounces once',
      h('kbd', {}, 'SPACE / RIGHT CLICK'), 'Lay a mine (2 at a time). It arms, then blows after 10 s or when a foe rolls near',
      h('kbd', {}, 'V'), 'Switch between the chase camera and the tactical overhead view',
      h('kbd', {}, 'ESC / P'), 'Pause',
      h('kbd', {}, 'GAMEPAD'), 'Left stick drive, right stick turret, RT fire, LT mine, Y view, Start pause',
    );
    const roster = h('div', { class: 'roster' }, ...ENEMY_ORDER.map((k) => h('div', {}, h('span', { class: 'chip', style: `background:${hex(TYPES[k].color)}` }), h('b', {}, TYPES[k].name), ' ', rosterNote(k))));
    this.panel('Field manual', 'How to play', [
      h('p', {}, 'One hit destroys any tank, yours included. Shells ricochet off blocks and crates, so bank them around cover, and watch for your own coming back. The dotted line shows where your shot will go; it turns red when it will hit.'),
      keys, h('p', { style: 'margin-top:18px;font-weight:600;letter-spacing:.15em;text-transform:uppercase;font-size:13px;color:#4a3d25' }, 'Know your enemy'), roster,
    ], [this._btn('Back', null, onBack, 'small')]);
  }

  settings(s, { onChange, onBack, rating }) {
    const vol = (key) => { const r = h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: s[key] }); r.addEventListener('input', () => { s[key] = +r.value; onChange(s); }); return r; };
    const sens = h('input', { type: 'range', min: 0.3, max: 3, step: 0.1, value: s.sens }); sens.addEventListener('input', () => { s.sens = +sens.value; onChange(s); });
    const pct = Math.round(rating * 100);
    this.panel('Settings', 'Field adjustments', [
      h('div', { class: 'row' }, h('label', {}, 'Graphics'), this.seg([['auto', 'Auto'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']], s.quality, (v) => { s.quality = v; onChange(s); })),
      h('div', { class: 'row' }, h('label', {}, 'Default view'), this.seg([['chase', 'Chase cam'], ['tactical', 'Tactical']], s.view, (v) => { s.view = v; onChange(s); })),
      h('div', { class: 'row' }, h('label', {}, 'Aim line'), this.seg([[true, 'On'], [false, 'Off']], s.aimLine, (v) => { s.aimLine = v; onChange(s); })),
      h('div', { class: 'row' }, h('label', {}, 'Mouse speed'), sens),
      h('div', { class: 'row' }, h('label', {}, 'Master'), vol('master')),
      h('div', { class: 'row' }, h('label', {}, 'Effects'), vol('sfx')),
      h('div', { class: 'row' }, h('label', {}, 'Music'), vol('music')),
      h('div', { class: 'row' }, h('label', {}, 'Adaptive difficulty'), this.seg([[true, 'On'], [false, 'Off']], s.adaptive, (v) => { s.adaptive = v; onChange(s); })),
      h('div', { style: 'font-size:14px;color:#5a4a2e;margin-top:4px' }, `The Director rates your play at ${pct}/100 and tunes enemy aim, reaction and nerve to match. Off locks it at 50.`,
        h('div', { class: 'meter' }, h('i', { style: `width:${pct}%` }))),
    ], [this._btn('Done', null, onBack, 'small primary')]);
  }

  versusSetup(cfg, { onStart, onBack }) {
    const body = [];
    const maps = h('div', { class: 'maps' });
    const drawMaps = () => {
      maps.innerHTML = '';
      VERSUS.forEach((m, k) => maps.append(h('div', { class: 'map' + (cfg.map === k ? ' on' : ''), onclick: () => { cfg.map = k; this.sound('ui'); drawMaps(); } }, this.mapThumb(m.rows), m.name)));
      maps.append(h('div', { class: 'map' + (cfg.map === -1 ? ' on' : ''), onclick: () => { cfg.map = -1; this.sound('ui'); drawMaps(); } }, h('div', { style: 'height:64px;display:flex;align-items:center;justify-content:center;font-family:var(--stencil);font-size:34px' }, '?'), 'Random'));
    };
    drawMaps();
    const slots = h('div');
    const drawSlots = () => {
      slots.innerHTML = '';
      const n = cfg.format === '2v2' ? 3 : cfg.bots;
      for (let k = 0; k < n; k++) {
        const b = cfg.slots[k];
        const team = cfg.format === '2v2' ? (k === 0 ? 'Your ally' : 'Enemy') : 'Enemy';
        slots.append(h('div', { class: 'slot' },
          h('span', { class: 'chip', style: `background:${hex(VS_COLORS[k + 1])}` }),
          h('div', {}, h('div', { style: 'font-weight:600;letter-spacing:.15em;text-transform:uppercase;font-size:12px;color:#4a3d25;margin-bottom:6px' }, `${VS_NAMES[k + 1]} · ${team}`),
            h('div', { class: 'row', style: 'margin:0' }, this.seg([['cadet', 'Cadet'], ['veteran', 'Veteran'], ['ace', 'Ace'], ['adaptive', 'Adaptive']], b.skill, (v) => { b.skill = v; }),
              this.seg([['sniper', 'Sniper'], ['brawler', 'Brawler'], ['trickster', 'Trickster']], b.style, (v) => { b.style = v; }))),
        ));
      }
    };
    drawSlots();
    const botsSeg = h('span');
    const drawBots = () => { botsSeg.innerHTML = ''; if (cfg.format === 'ffa') botsSeg.append(this.seg([[1, '1 bot'], [2, '2 bots'], [3, '3 bots']], cfg.bots, (v) => { cfg.bots = v; drawSlots(); })); };
    drawBots();
    body.push(
      h('div', { class: 'row' }, h('label', {}, 'Format'), this.seg([['ffa', 'Free for all'], ['2v2', '2 v 2']], cfg.format, (v) => { cfg.format = v; drawBots(); drawSlots(); }), botsSeg),
      h('div', { class: 'row' }, h('label', {}, 'First to'), this.seg([[3, '3 rounds'], [5, '5 rounds'], [7, '7 rounds']], cfg.rounds, (v) => { cfg.rounds = v; })),
      slots,
      h('p', { style: 'font-size:14px;color:#5a4a2e' }, 'Bots are hand-written engines with your exact kit. Cadet shoots straight and reacts late. Veteran leads targets, plans one-bounce shots and ducks behind cover. Ace traces two-bounce shots through the real physics, shoots your shells out of the air, and pushes when you run dry. Adaptive tracks your rating.'),
      h('div', { class: 'row' }, h('label', {}, 'Arena')), maps,
    );
    this.panel('Versus', 'Set up a match', body, [this._btn('Back', null, onBack, 'small'), this._btn('Roll out', null, () => onStart(cfg), 'small primary')]);
  }

  mapThumb(rows) {
    const c = document.createElement('canvas'); c.width = COLS * 5; c.height = ROWS * 5;
    const g = c.getContext('2d');
    const { grid, spawns } = parseLevel(rows);
    g.fillStyle = '#b89a6a'; g.fillRect(0, 0, c.width, c.height);
    for (let j = 0; j < ROWS; j++) for (let i = 0; i < COLS; i++) {
      const v = grid[j * COLS + i];
      if (v === CELL.BLOCK) g.fillStyle = '#5b4a33'; else if (v === CELL.CRATE) g.fillStyle = '#d4b27a'; else if (v === CELL.PIT) g.fillStyle = '#1a120b'; else continue;
      g.fillRect(i * 5, j * 5, 5, 5);
    }
    for (const s of spawns) { g.fillStyle = s.kind === 'player' ? '#2f7dff' : s.kind === 'slot' ? hex(VS_COLORS[s.slot - 1]) : hex(TYPES[s.kind]?.color ?? 0xffffff); g.fillRect(s.x * 5 - 3, s.z * 5 - 3, 6, 6); }
    return c;
  }

  // ---------------------------------------------------------------- banner
  banner({ big, name, foes }) {
    this.clear('banner');
    const b = h('div', { class: 'banner' },
      h('div', { class: 'strip' }, h('div', { class: 'm' }, big), h('div', { class: 'n' }, name)),
      foes ? h('div', { class: 'foes' }, ...foes.map(([color, label]) => h('span', {}, h('span', { class: 'chip', style: `background:${hex(color)}` }), label))) : null,
    );
    this.layers.banner.append(b);
    return () => { b.classList.add('out'); setTimeout(() => b.remove(), 400); };
  }

  toast(text, color) {
    const t = h('div', { class: 'toast', style: color ? `color:${color}` : '' }, text);
    this.layers.toast.append(t);
    setTimeout(() => t.remove(), 1700);
  }

  // ---------------------------------------------------------------- HUD
  hud(on, { mode, title, sub, versus = null } = {}) {
    this.clear('hud');
    this.hudEls = null;
    if (!on) return;
    const mm = document.createElement('canvas'); mm.width = COLS * 9; mm.height = ROWS * 9;
    const els = {
      plaque: h('div', { class: 'plaque' }, h('div', { class: 'm' }, title), h('div', { class: 'n' }, sub), h('div', { class: 'lives' })),
      mm: h('div', { class: 'mm' }, mm, h('div', { class: 'cap' }, h('span', {}, 'Recon'), h('span', { class: 'mmv' }, ''))),
      ammo: h('div', { class: 'ammo' }, h('div', {}, h('div', { class: 'grp shells' }), h('div', { class: 'lbl' }, 'Shells')), h('div', {}, h('div', { class: 'grp mines' }), h('div', { class: 'lbl' }, 'Mines'))),
      foes: h('div', { class: 'foesleft' }),
      hint: h('div', { class: 'hint' }),
      xhair: h('div', { class: 'xhair' }),
      markers: h('div', { class: 'layer' }),
      lock: h('div', { class: 'lockprompt hidden' }, 'CLICK TO TAKE COMMAND'),
      score: h('div', { class: 'score' }),
    };
    els.mmCanvas = mm; els.mmCtx = mm.getContext('2d');
    this.layers.hud.append(els.markers, els.plaque, els.mm, els.ammo, els.foes, els.hint, els.xhair, els.lock, els.score);
    this.hudEls = els;
    this.versus = versus;
    this.setMode(mode);
  }
  setMode(mode) {
    if (!this.hudEls) return;
    this.hudEls.xhair.classList.toggle('hidden', mode !== 'chase');
    this.hudEls.hint.innerHTML = mode === 'chase'
      ? '<kbd>V</kbd> tactical view<br><kbd>ESC</kbd> pause'
      : '<kbd>V</kbd> chase cam<br><kbd>ESC</kbd> pause';
  }
  showLock(v) { if (this.hudEls) this.hudEls.lock.classList.toggle('hidden', !v); }

  updateHUD(world, player, { lives = 0, maxLives = 0, view, mode, score } = {}) {
    const E = this.hudEls; if (!E) return;
    // lives
    const L = E.plaque.querySelector('.lives');
    if (maxLives) {
      if (L.childElementCount !== maxLives) { L.innerHTML = ''; for (let k = 0; k < maxLives; k++) L.append(h('i')); }
      [...L.children].forEach((c, k) => c.classList.toggle('gone', k >= lives));
    }
    // ammo
    if (player) {
      const S = E.ammo.querySelector('.shells'), M = E.ammo.querySelector('.mines');
      const max = player.type.maxShells, live = liveShellsOf(world, player);
      if (S.childElementCount !== max) { S.innerHTML = ''; for (let k = 0; k < max; k++) S.append(h('i', { class: 'shell' })); }
      [...S.children].forEach((c, k) => c.classList.toggle('out', k >= max - live));
      const mmax = player.type.mines, mlive = liveMinesOf(world, player);
      if (M.childElementCount !== mmax) { M.innerHTML = ''; for (let k = 0; k < mmax; k++) M.append(h('i', { class: 'mineI' })); }
      [...M.children].forEach((c, k) => c.classList.toggle('out', k >= mmax - mlive));
      E.xhair.classList.toggle('reload', live >= max || player.cool > 0);
    }
    // foes
    const foes = world.tanks.filter((t) => !player || t.team !== player.team);
    const key = foes.map((t) => t.id + (t.alive ? 'a' : 'd')).join();
    if (E.foes.dataset.k !== key) {
      E.foes.dataset.k = key; E.foes.innerHTML = '';
      E.foes.append(h('span', { style: 'margin-right:6px' }, 'Hostiles'));
      for (const t of foes) E.foes.append(h('span', { class: 'chip' + (t.alive ? '' : ' dead'), style: `background:${hex(t.colorOverride ?? t.type.color)}` }));
    }
    if (score) {
      const k2 = JSON.stringify(score);
      if (E.score.dataset.k !== k2) {
        E.score.dataset.k = k2; E.score.innerHTML = '';
        for (const s of score) E.score.append(h('div', {}, h('span', { class: 'chip', style: `background:${hex(s.color)}` }), String(s.wins)));
      }
    }
    this.drawMinimap(world, player, view);
    this.drawMarkers(world, player, view, mode);
  }

  drawMinimap(world, player, view) {
    const E = this.hudEls, g = E.mmCtx, S = 9;
    const cv = E.mmCanvas;
    g.fillStyle = '#9d8762'; g.fillRect(0, 0, cv.width, cv.height);
    const grid = world.grid;
    for (let j = 0; j < ROWS; j++) for (let i = 0; i < COLS; i++) {
      const v = grid[j * COLS + i];
      if (v === CELL.FLOOR) continue;
      g.fillStyle = v === CELL.BLOCK ? '#3d3122' : v === CELL.CRATE ? '#c9a66e' : '#120c07';
      g.fillRect(i * S, j * S, S, S);
    }
    const t = performance.now() / 1000;
    for (const m of world.mines) { if (!m.alive) continue; g.fillStyle = Math.sin(t * 10) > 0 ? '#ff3b1f' : '#f2c230'; g.beginPath(); g.arc(m.x * S, m.z * S, 3, 0, 7); g.fill(); }
    g.fillStyle = '#fff4d0';
    for (const s of world.shells) { if (!s.alive) continue; g.fillRect(s.x * S - 1.5, s.z * S - 1.5, 3, 3); }
    for (const tk of world.tanks) {
      if (!tk.alive) continue;
      if (tk.type.invisible && tk !== player && world.time > 1.8) continue;
      g.save(); g.translate(tk.x * S, tk.z * S); g.rotate(tk.rot);
      g.fillStyle = hex(tk.colorOverride ?? tk.type.color);
      g.strokeStyle = tk === player ? '#ffffff' : '#1a120b'; g.lineWidth = 1.5;
      g.fillRect(-5, -4, 10, 8); g.strokeRect(-5, -4, 10, 8);
      g.rotate(tk.aim - tk.rot); g.fillRect(0, -1, 8, 2);
      g.restore();
    }
    if (player && player.alive && view.mode === 'chase') {
      const yaw = player.ctrl.aim;
      g.fillStyle = 'rgba(255,245,210,0.18)';
      g.beginPath(); g.moveTo(player.x * S, player.z * S);
      g.arc(player.x * S, player.z * S, 60, yaw - 0.55, yaw + 0.55); g.closePath(); g.fill();
    }
    E.mm.querySelector('.mmv').textContent = view.mode === 'chase' ? 'Chase' : 'Tactical';
  }

  drawMarkers(world, player, view, mode) {
    const E = this.hudEls;
    E.markers.innerHTML = '';
    if (!player || !player.alive || mode !== 'chase') return;
    const W = innerWidth, H = innerHeight, pad = 46;
    for (const t of world.tanks) {
      if (!t.alive || t.team === player.team) continue;
      if (t.type.invisible && world.time > 1.8) continue;
      const p = view.boardToScreen(t.x, t.z, 0.35);
      const on = !p.behind && p.x > pad && p.x < W - pad && p.y > pad && p.y < H - pad;
      if (on) continue;
      let dx = p.x - W / 2, dy = p.y - H / 2;
      if (p.behind) { dx = -dx; dy = -dy; if (Math.abs(dy) < 1) dy = 1; }
      const a = Math.atan2(dy, dx);
      const sx = (W / 2 - pad) / Math.abs(Math.cos(a) || 1e-6), sy = (H / 2 - pad) / Math.abs(Math.sin(a) || 1e-6);
      const r = Math.min(sx, sy);
      const x = W / 2 + Math.cos(a) * r, y = H / 2 + Math.sin(a) * r;
      const d = Math.hypot(t.x - player.x, t.z - player.z);
      E.markers.append(h('div', { class: 'marker', style: `left:${x}px;top:${y}px;color:${hex(t.colorOverride ?? t.type.color)};transform:rotate(${a + Math.PI / 2}rad) scale(${Math.max(0.6, 1.3 - d * 0.05)})` }, h('b')));
    }
  }

  // ---------------------------------------------------------------- results
  results({ kicker, title, stamp, rows, note, meter, actions }) {
    const table = h('table', { class: 'tally' }, ...rows.map(([a, b]) => h('tr', {}, h('td', {}, a), h('td', {}, b))));
    const body = [table];
    if (note) body.push(h('p', { style: 'font-size:14px;color:#5a4a2e;margin-bottom:0' }, note));
    if (meter) {
      const m = h('div', { class: 'meter' }, h('i', { style: `width:${meter.from * 100}%` }), h('em', { style: `left:${meter.threat * 100}%` }));
      body.push(h('div', { style: 'font-size:12px;letter-spacing:.2em;text-transform:uppercase;color:#4a3d25;margin-top:10px' }, 'Director rating (red mark: this mission)'), m);
      setTimeout(() => { m.querySelector('i').style.width = meter.to * 100 + '%'; }, 250);
    }
    const p = this.panel(kicker, title, body, actions.map(([l, f, c]) => this._btn(l, null, f, 'small ' + (c || ''))));
    if (stamp) p.append(h('div', { class: 'stamp' }, stamp));
    setTimeout(() => p.querySelector('.actions .primary')?.focus(), 60);
  }

  pause({ onResume, onRestart, onSettings, onQuit, restartLabel = 'Restart mission' }) {
    this.panel('Paused', 'Hold fire', [h('p', {}, 'The toys wait for you.')], [
      this._btn('Quit to title', null, onQuit, 'small'), this._btn('Settings', null, onSettings, 'small'),
      this._btn(restartLabel, null, onRestart, 'small'), this._btn('Resume', null, onResume, 'small primary'),
    ]);
  }
}

function rosterNote(k) {
  return {
    rookie: '— stationary, slow turret', grunt: '— wanders, single shots', zipper: '— fast rockets, no bounce',
    sapper: '— lays mines', burst: '— fires three at once', ricochet: '— plans double-bank rockets',
    hunter: '— fast, dodges, hunts you', ghost: '— invisible; watch its tracks', boss: '— the Commander',
  }[k];
}
