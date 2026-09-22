// DOM overlay: menus, garage, versus setup, banners, HUD (status, reload, dispersion reticle,
// enemy bars, combat text, damage direction, spotting callouts, kill feed), results.
// No minimap and no off-screen markers: the chase cam is meant to be semi-blind.
import { TYPES, ENEMY_ORDER, CLASSES, CLASS_ORDER } from './sim/tanks.js';
import { CAMPAIGN, VERSUS, parseLevel } from './sim/levels.js';
import { CELL } from './sim/world.js';

export const hex = (c) => '#' + (c >>> 0).toString(16).padStart(6, '0');
const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(k));
  return e;
};
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Free-for-all colours / names, and team palettes for team battles.
export const VS_COLORS = [0x2f7dff, 0xe8453c, 0x19b36b, 0xf2c230];
export const VS_NAMES = ['Blue', 'Red', 'Green', 'Gold'];
export const TEAM_COLORS = [[0x2f7dff, 0x3fb0f0, 0x2bb3a0, 0x6f8cff, 0x7cc6ff], [0xe8453c, 0xdb6a2c, 0xc23b6e, 0xf08a3f, 0xa8302a]];
export const ALLY_NAMES = ['Bravo', 'Charlie', 'Delta', 'Echo'];
export const ENEMY_NAMES = ['Viper', 'Cobra', 'Mamba', 'Adder', 'Krait'];
export const SKILL_OPTS = [['cadet', 'Cadet'], ['veteran', 'Veteran'], ['ace', 'Ace'], ['adaptive', 'Adaptive']];
export const STYLE_OPTS = [['brawler', 'Brawler'], ['sniper', 'Sniper'], ['trickster', 'Flanker']];
export const CLASS_OPTS = CLASS_ORDER.map((k) => [k, CLASSES[k].label]);

// ---------------------------------------------------------------- class stats (garage bars)
const dpm = (c) => c.dmg * 60 / c.reload;
const CLASS_MAX = {
  armour: Math.max(...CLASS_ORDER.map((k) => CLASSES[k].armor[0] + CLASSES[k].armor[1])),
  fire: Math.max(...CLASS_ORDER.map((k) => dpm(CLASSES[k]) * CLASSES[k].pen)),
  speed: Math.max(...CLASS_ORDER.map((k) => CLASSES[k].speed)),
  hp: Math.max(...CLASS_ORDER.map((k) => CLASSES[k].hp)),
};
export function classStats(k) {
  const c = CLASSES[k];
  return [
    ['Armour', (c.armor[0] + c.armor[1]) / CLASS_MAX.armour, `${c.armor[0]} / ${c.armor[1]} / ${c.armor[2]}`],
    ['Firepower', Math.sqrt(dpm(c) * c.pen / CLASS_MAX.fire), `${c.dmg} dmg · ${c.pen} pen · ${c.reload}s`],
    ['Speed', c.speed / CLASS_MAX.speed, `${c.speed.toFixed(1)} cells/s`],
    ['Hit points', c.hp / CLASS_MAX.hp, `${c.hp}`],
  ];
}

// Side-view toy silhouettes per class (hull, turret, gun) for the garage cards.
function classSvg(k, color = '#4a5324') {
  const S = {
    light:  { hull: [26, 50, 70, 16], tur: [44, 38, 26, 13], gun: [68, 42, 34, 4], wheels: 4 },
    medium: { hull: [18, 48, 84, 19], tur: [40, 33, 34, 16], gun: [72, 38, 40, 5], wheels: 5 },
    heavy:  { hull: [10, 44, 100, 24], tur: [34, 26, 44, 20], gun: [76, 33, 38, 7], wheels: 6 },
    td:     { hull: [12, 46, 96, 20], tur: [20, 36, 50, 12], gun: [68, 39, 48, 6], wheels: 5 },
  }[k];
  const [hx, hy, hw, hh] = S.hull, [tx, ty, tw, th] = S.tur, [gx, gy, gw, gh] = S.gun;
  let wheels = '';
  for (let i = 0; i < S.wheels; i++) wheels += `<circle cx="${hx + 8 + i * (hw - 16) / (S.wheels - 1)}" cy="${hy + hh + 4}" r="5.5" fill="#2a2418"/>`;
  return `<svg viewBox="0 0 130 80" class="sil"><rect x="${hx - 3}" y="${hy + hh - 4}" width="${hw + 6}" height="14" rx="7" fill="#3a3326"/>${wheels}
    <rect x="${hx}" y="${hy}" width="${hw}" height="${hh}" rx="3" fill="${color}"/><rect x="${gx}" y="${gy}" width="${gw}" height="${gh}" rx="1.5" fill="${color}"/>
    <rect x="${tx}" y="${ty}" width="${tw}" height="${th + 2}" rx="${k === 'td' ? 2 : 6}" fill="${color}"/><rect x="${hx}" y="${hy}" width="${hw}" height="3" fill="rgba(255,255,255,.18)"/></svg>`;
}

// Module icons (24×24).
const ICON = {
  tracks: '<svg viewBox="0 0 24 24"><rect x="2" y="7" width="20" height="10" rx="5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="7" cy="12" r="2" fill="currentColor"/><circle cx="12" cy="12" r="2" fill="currentColor"/><circle cx="17" cy="12" r="2" fill="currentColor"/></svg>',
  turret: '<svg viewBox="0 0 24 24"><path d="M4 16 a6 6 0 0 1 12 0 z" fill="currentColor"/><rect x="13" y="10" width="10" height="3" fill="currentColor"/><rect x="2" y="16" width="16" height="3" fill="currentColor"/></svg>',
  engine: '<svg viewBox="0 0 24 24"><rect x="4" y="8" width="14" height="10" fill="none" stroke="currentColor" stroke-width="2"/><rect x="7" y="4" width="8" height="4" fill="currentColor"/><path d="M18 11h3v4h-3M1 11h3v4H1" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
  fire: '<svg viewBox="0 0 24 24"><path d="M12 2c1 4 6 6 6 12a6 6 0 0 1-12 0c0-3 2-5 3-6 0 2 1 3 2 3 0-4-1-6 1-9z" fill="currentColor"/></svg>',
};

export class UI {
  constructor(root, sound) {
    this.root = root; this.sound = sound || (() => {});
    this.layers = {};
    for (const n of ['hud', 'fx', 'banner', 'screen', 'toast']) { const l = h('div', { class: 'layer layer-' + n }); root.append(l); this.layers[n] = l; }
    this.hudEls = null;
    this.floaters = [];
    this.dirs = [];
    this.counts = { float: 0, hitMe: 0, callout: 0, feed: 0 }; // for tools/verify.mjs
  }
  clear(name) { this.layers[name].innerHTML = ''; if (name === 'fx') { this.floaters = []; this.dirs = []; } }
  _btn(label, sub, onclick, cls = '') {
    return h('button', { class: 'btn ' + cls, 'data-act': slug(label), onclick: () => { this.sound('ui'); onclick(); } }, label, sub ? h('span', { class: 'sub' }, sub) : null);
  }

  // ---------------------------------------------------------------- title
  title({ canContinue, continueLabel, onCampaign, onContinue, onVersus, onSettings, onHelp }) {
    this.clear('screen');
    const menu = h('div', { class: 'menu interactive' },
      canContinue ? this._btn('Continue', continueLabel, onContinue, 'primary') : null,
      this._btn('Campaign', '20 missions · the toy-box war', onCampaign, canContinue ? '' : 'primary'),
      this._btn('Versus', '1v1 · free-for-all · team battles up to 5v5', onVersus),
      this._btn('How to play', 'armour, angles, modules, spotting', onHelp),
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
  panel(kicker, title, body, actions, cls = '') {
    this.clear('screen');
    const p = h('div', { class: 'panel interactive fade-in ' + cls }, h('div', { class: 'kicker' }, kicker), h('h2', {}, title), ...body, h('div', { class: 'actions' }, ...actions));
    this.layers.screen.append(h('div', { class: 'panel-wrap' }, p));
    return p;
  }
  seg(options, value, onChange, name = '') {
    const wrap = h('div', { class: 'seg', 'data-seg': name });
    const render = (v) => { wrap.innerHTML = ''; for (const [val, lab] of options) wrap.append(h('button', { class: val === v ? 'on' : '', 'data-val': String(val), onclick: () => { this.sound('ui'); onChange(val); render(val); } }, lab)); };
    render(value);
    return wrap;
  }
  select(options, value, onChange, name = '') {
    const s = h('select', { class: 'sel', 'data-sel': name }, ...options.map(([v, l]) => h('option', { value: String(v), selected: String(v) === String(value) ? 'selected' : false }, l)));
    s.addEventListener('change', () => { this.sound('ui'); onChange(s.value); });
    return s;
  }

  campaignSelect({ best, onStart, onBack }) {
    const starts = [0, 5, 10, 15].filter((m) => m <= best);
    const list = h('div', { class: 'maps' }, ...starts.map((m) => {
      const c = this.mapThumb(CAMPAIGN[m]);
      return h('div', { class: 'map', 'data-mission': m, onclick: () => { this.sound('uiBig'); onStart(m); } }, c, `Mission ${m + 1}`, h('div', { style: 'font-weight:400;opacity:.7' }, CAMPAIGN[m].name));
    }));
    this.panel('Campaign', 'Choose a start', [h('p', {}, 'Every fifth mission is a checkpoint once you reach it. Three tanks in reserve; clear missions 5, 10 and 15 for an extra one.'), list], [this._btn('Back', null, onBack, 'small')]);
  }

  // ---------------------------------------------------------------- garage
  // Pick a class. `brief` = { kicker, title, lines: [text], foes: [[color, label]] }.
  garage({ cls, brief, onStart, onBack, onPick, startLabel = 'Roll out', backLabel = 'Back' }) {
    let sel = CLASSES[cls] ? cls : 'medium';
    const cards = h('div', { class: 'garage' });
    const draw = () => {
      cards.innerHTML = '';
      for (const k of CLASS_ORDER) {
        const c = CLASSES[k];
        const bars = classStats(k).map(([lab, v, txt]) => h('div', { class: 'stat' }, h('span', { class: 'sl' }, lab), h('span', { class: 'sb' }, h('i', { style: `width:${Math.round(Math.max(0.06, Math.min(1, v)) * 100)}%` })), h('span', { class: 'sv' }, txt)));
        cards.append(h('div', { class: 'gcard' + (k === sel ? ' on' : ''), 'data-cls': k, tabindex: 0,
          onclick: () => { if (sel !== k) { sel = k; this.sound('ui'); onPick && onPick(k); draw(); } },
          ondblclick: () => { sel = k; onPick && onPick(k); this.sound('uiBig'); onStart(k); } },
        h('div', { class: 'gname' }, c.label), h('div', { class: 'gsil', html: classSvg(k, k === sel ? '#4a5324' : '#6b6450') }), h('div', { class: 'gblurb' }, c.blurb), ...bars));
      }
    };
    draw();
    this._garageSet = (k) => { if (CLASSES[k]) { sel = k; draw(); } };
    const body = [];
    if (brief) {
      body.push(h('div', { class: 'brief' },
        ...(brief.lines || []).map((l) => h('p', {}, l)),
        brief.foes && brief.foes.length ? h('div', { class: 'foes-row' }, h('b', {}, 'Opposition'), ...brief.foes.map(([color, label]) => h('span', {}, h('span', { class: 'chip', style: `background:${hex(color)}` }), label))) : null));
    }
    body.push(h('div', { class: 'kicker', style: 'margin-top:14px' }, 'Choose your tank'), cards,
      h('p', { class: 'fine' }, 'Armour is front / side / rear in toy-millimetres. Shells that hit steeper than 70° ricochet; otherwise penetration has to beat armour ÷ cos(angle).'));
    const p = this.panel(brief ? brief.kicker : 'Garage', brief ? brief.title : 'Pick your tank', body,
      [onBack ? this._btn(backLabel, null, onBack, 'small') : null, this._btn(startLabel, null, () => onStart(sel), 'small primary')].filter(Boolean), 'wide');
    setTimeout(() => p.querySelector('.actions .primary')?.focus(), 60);
  }

  help(onBack) {
    const keys = h('div', { class: 'keys' },
      h('kbd', {}, 'W / S'), 'Drive forward / reverse (chase view) — or move in that screen direction (tactical view)',
      h('kbd', {}, 'A / D'), 'Turn the hull',
      h('kbd', {}, 'MOUSE'), 'Traverse the turret (chase view locks the pointer; click to grab it)',
      h('kbd', {}, 'LEFT CLICK'), 'Fire. One shell at a time, then reload (the ring round your reticle)',
      h('kbd', {}, 'SPACE / RIGHT CLICK'), 'Lay a mine. It arms, then blows after 10 s or when a foe rolls near',
      h('kbd', {}, 'V'), 'Switch between the chase camera and the tactical overhead view',
      h('kbd', {}, 'TAB / CLICK'), 'Knocked out in a team battle? Watch the next living ally',
      h('kbd', {}, 'ESC / P'), 'Pause',
      h('kbd', {}, 'GAMEPAD'), 'Left stick drive, right stick turret, RT fire, LT mine, Y view, Start pause',
    );
    const sub = (t) => h('p', { class: 'subhead' }, t);
    const classes = h('div', { class: 'roster' }, ...CLASS_ORDER.map((k) => h('div', {}, h('b', {}, CLASSES[k].label), ' — ', CLASSES[k].blurb)));
    const roster = h('div', { class: 'roster' }, ...ENEMY_ORDER.map((k) => h('div', {}, h('span', { class: 'chip', style: `background:${hex(TYPES[k].color)}` }), h('b', {}, TYPES[k].name), ' ', rosterNote(k))));
    this.panel('Field manual', 'How to play', [
      sub('Armour and angles'),
      h('p', {}, 'Every tank has hit points and armour: thickest on the front, thinner on the sides, thinnest at the rear. A shell that strikes at more than 70° from square-on RICOCHETS off and flies on. Otherwise it has to beat the armour\'s effective thickness (thickness ÷ cos angle): if it does it PENETRATES and deals damage, if not it\'s NO PENETRATION and does nothing. So angle your front plate at the enemy, and hunt for sides and rears.'),
      sub('Modules'),
      h('p', {}, 'A penetration can knock something out. Side hits break TRACKS (you can\'t move for a few seconds). Front hits jam the TURRET (slow traverse). Rear hits damage the ENGINE (slow) and can set you ON FIRE (damage over time). A badly hurt tank can lose its AMMO RACK and go up in one shot.'),
      sub('Shooting'),
      h('p', {}, 'Shells fly straight and stop on walls — no bank shots. Cardboard crates break when shot. The aim line shows your line of fire to the first thing in the way. The reticle circle is your spread: it blooms when you drive or swing the turret and settles when you stop. Wait for it on long shots.'),
      sub('Spotting'),
      h('p', {}, 'There is no minimap. You see what your team sees: walls and crates hide tanks, and you can\'t see round corners. Enemies your team spots get a health bar; firing gives your position away for a moment.'),
      keys,
      sub('Tank classes'), classes,
      sub('Know your enemy'), roster,
    ], [this._btn('Back', null, onBack, 'small')], 'wide');
  }

  settings(s, { onChange, onBack, rating }) {
    const vol = (key) => { const r = h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: s[key], 'data-range': key }); r.addEventListener('input', () => { s[key] = +r.value; onChange(s); }); return r; };
    const sens = h('input', { type: 'range', min: 0.3, max: 3, step: 0.1, value: s.sens, 'data-range': 'sens' }); sens.addEventListener('input', () => { s.sens = +sens.value; onChange(s); });
    const pct = Math.round(rating * 100);
    this.panel('Settings', 'Field adjustments', [
      h('div', { class: 'row' }, h('label', {}, 'Graphics'), this.seg([['auto', 'Auto'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']], s.quality, (v) => { s.quality = v; onChange(s); }, 'quality')),
      h('div', { class: 'row' }, h('label', {}, 'Default view'), this.seg([['chase', 'Chase cam'], ['tactical', 'Tactical']], s.view, (v) => { s.view = v; onChange(s); }, 'view')),
      h('div', { class: 'row' }, h('label', {}, 'Aim line'), this.seg([[true, 'On'], [false, 'Off']], s.aimLine, (v) => { s.aimLine = v; onChange(s); }, 'aimline')),
      h('div', { class: 'row' }, h('label', {}, 'Combat text'), this.seg([[true, 'On'], [false, 'Off']], s.combatText, (v) => { s.combatText = v; onChange(s); }, 'combattext')),
      h('div', { class: 'row' }, h('label', {}, 'Mouse speed'), sens),
      h('div', { class: 'row' }, h('label', {}, 'Master'), vol('master')),
      h('div', { class: 'row' }, h('label', {}, 'Effects'), vol('sfx')),
      h('div', { class: 'row' }, h('label', {}, 'Music'), vol('music')),
      h('div', { class: 'row' }, h('label', {}, 'Adaptive difficulty'), this.seg([[true, 'On'], [false, 'Off']], s.adaptive, (v) => { s.adaptive = v; onChange(s); }, 'adaptive')),
      h('div', { style: 'font-size:14px;color:#5a4a2e;margin-top:4px' }, `The Director rates your play at ${pct}/100 and tunes enemy aim, reaction, nerve and toughness to match. Off locks it at 50.`,
        h('div', { class: 'meter' }, h('i', { style: `width:${pct}%` }))),
    ], [this._btn('Done', null, onBack, 'small primary')]);
  }

  // ---------------------------------------------------------------- versus setup
  // cfg: { format: '1v1'|'ffa'|'team', ffa: 3|4 (players), allies: 0-4, enemies: 1-5, rounds, map, cls,
  //        allySlots: [{skill, style, cls}×4], enemySlots: [{skill, style, cls}×5] }
  versusSetup(cfg, { onStart, onBack }) {
    const maps = h('div', { class: 'maps' });
    const drawMaps = () => {
      maps.innerHTML = '';
      VERSUS.forEach((m, k) => maps.append(h('div', { class: 'map' + (cfg.map === k ? ' on' : ''), 'data-map': k, onclick: () => { cfg.map = k; this.sound('ui'); drawMaps(); } }, this.mapThumb(m), m.name)));
      maps.append(h('div', { class: 'map' + (cfg.map === -1 ? ' on' : ''), 'data-map': -1, onclick: () => { cfg.map = -1; this.sound('ui'); drawMaps(); } }, h('div', { class: 'rnd' }, '?'), 'Random'));
    };
    drawMaps();
    const slots = h('div', { class: 'slots' });
    const clsOpts = [['random', 'Random'], ...CLASS_OPTS];
    const slotRow = (b, color, name, side) => h('div', { class: 'slot' },
      h('span', { class: 'chip', style: `background:${hex(color)}` }),
      h('div', { class: 'sname' }, h('b', {}, name), h('span', {}, side)),
      this.select(SKILL_OPTS, b.skill, (v) => { b.skill = v; }, 'skill'),
      this.select(STYLE_OPTS, b.style, (v) => { b.style = v; }, 'style'),
      this.select(clsOpts, b.cls || 'random', (v) => { b.cls = v; }, 'cls'));
    const drawSlots = () => {
      slots.innerHTML = '';
      const L = versusLayout(cfg);
      for (const s of L) if (!s.human) slots.append(slotRow(s.ref, s.color, s.label, s.side));
    };
    const counts = h('span', { class: 'counts' });
    const drawCounts = () => {
      counts.innerHTML = '';
      if (cfg.format === 'ffa') counts.append(this.seg([[3, '3 tanks'], [4, '4 tanks']], cfg.ffa, (v) => { cfg.ffa = v; drawSlots(); }, 'ffa'));
      if (cfg.format === 'team') {
        counts.append(h('span', { class: 'cl' }, 'Allies'), this.seg([[0, '0'], [1, '1'], [2, '2'], [3, '3'], [4, '4']], cfg.allies, (v) => { cfg.allies = v; drawSlots(); }, 'allies'),
          h('span', { class: 'cl' }, 'Enemies'), this.seg([[1, '1'], [2, '2'], [3, '3'], [4, '4'], [5, '5']], cfg.enemies, (v) => { cfg.enemies = v; drawSlots(); }, 'enemies'));
      }
    };
    drawCounts(); drawSlots();
    const body = [
      h('div', { class: 'row' }, h('label', {}, 'Format'), this.seg([['1v1', '1 v 1'], ['ffa', 'Free for all'], ['team', 'Team battle']], cfg.format, (v) => { cfg.format = v; drawCounts(); drawSlots(); }, 'format'), counts),
      h('div', { class: 'row' }, h('label', {}, 'First to'), this.seg([[1, '1 round'], [2, '2 rounds'], [3, '3 rounds'], [5, '5 rounds']], cfg.rounds, (v) => { cfg.rounds = v; }, 'rounds')),
      h('div', { class: 'row' }, h('label', {}, 'Your tank'), this.seg(CLASS_OPTS, cfg.cls, (v) => { cfg.cls = v; }, 'mycls')),
      h('div', { class: 'slot-head' }, h('span', {}), h('span', {}, 'Crew'), h('span', {}, 'Skill'), h('span', {}, 'Personality'), h('span', {}, 'Tank')),
      slots,
      h('p', { class: 'fine' }, 'Bots are hand-written engines, not cheats: they only shoot what their team can see. Cadet reacts late and fires on the move. Veteran waits for its aim to settle, goes for your sides and flanks. Ace angles its armour, reads your shots and punishes a reload. Adaptive tracks your Director rating. Brawlers push, Snipers hold long lines, Flankers go round.'),
      h('div', { class: 'row' }, h('label', {}, 'Battlefield')), maps,
    ];
    this.panel('Versus', 'Set up a match', body, [this._btn('Back', null, onBack, 'small'), this._btn('Roll out', null, () => onStart(cfg), 'small primary')], 'wide');
  }

  mapThumb(level) {
    const { grid, spawns, cols, rows } = parseLevel(level);
    const S = 4, c = document.createElement('canvas'); c.width = cols * S; c.height = rows * S;
    const g = c.getContext('2d');
    g.fillStyle = '#b89a6a'; g.fillRect(0, 0, c.width, c.height);
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      const v = grid[j * cols + i];
      if (v === CELL.BLOCK) g.fillStyle = '#5b4a33'; else if (v === CELL.CRATE) g.fillStyle = '#d4b27a'; else if (v === CELL.PIT) g.fillStyle = '#1a120b'; else continue;
      g.fillRect(i * S, j * S, S, S);
    }
    for (const s of spawns) {
      if (s.kind === 'slot') g.fillStyle = s.slot < 5 ? '#2f7dff' : '#e8453c';
      else g.fillStyle = s.kind === 'player' ? '#2f7dff' : s.kind === 'ally' ? '#4f7a3a' : hex(TYPES[s.kind]?.color ?? 0xffffff);
      g.fillRect(s.x * S - 3, s.z * S - 3, 6, 6);
    }
    return c;
  }

  // ---------------------------------------------------------------- banner
  banner({ big, name, foes, sub }) {
    this.clear('banner');
    const b = h('div', { class: 'banner' },
      h('div', { class: 'strip' }, h('div', { class: 'm' }, big), h('div', { class: 'n' }, name)),
      foes && foes.length ? h('div', { class: 'foes' }, ...foes.map(([color, label]) => h('span', {}, h('span', { class: 'chip', style: `background:${hex(color)}` }), label))) : null,
      sub ? h('div', { class: 'bsub' }, sub) : null,
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
  hud(on, { mode, title, sub } = {}) {
    this.clear('hud'); this.clear('fx');
    this.hudEls = null;
    if (!on) return;
    const mod = (k, label) => h('div', { class: 'mod', 'data-mod': k }, h('div', { class: 'mi', html: ICON[k] }), h('div', { class: 'ml' }, label), h('div', { class: 'mt' }));
    const els = {
      plaque: h('div', { class: 'plaque' }, h('div', { class: 'm' }, title), h('div', { class: 'n' }, sub), h('div', { class: 'lives' })),
      status: h('div', { class: 'status' },
        h('div', { class: 'st-top' }, h('span', { class: 'st-cls' }), h('span', { class: 'st-spec' })),
        h('div', { class: 'hpbar' }, h('i', { class: 'hpfill' }), h('b', { class: 'hpghost' }), h('span', { class: 'hptext' })),
        h('div', { class: 'mods' }, mod('tracks', 'Tracks'), mod('turret', 'Turret'), mod('engine', 'Engine'), mod('fire', 'Fire'))),
      reload: h('div', { class: 'reloadbox' },
        h('div', { class: 'rl-lbl' }, h('span', { class: 'rl-state' }, 'READY'), h('span', { class: 'rl-time' })),
        h('div', { class: 'rl-bar' }, h('i')),
        h('div', { class: 'rl-mines' }, h('span', {}, 'Mines'), h('span', { class: 'grp mines' }))),
      foes: h('div', { class: 'foesleft' }),
      hint: h('div', { class: 'hint' }),
      reticle: h('div', { class: 'reticle hidden', html: '<svg><circle class="disp"/><circle class="rl-ring-bg"/><circle class="rl-ring"/></svg><i class="dot"></i><span class="rt"></span>' }),
      bars: h('div', { class: 'tbars' }),
      lock: h('div', { class: 'lockprompt hidden' }, 'CLICK TO TAKE COMMAND'),
      score: h('div', { class: 'score' }),
      feed: h('div', { class: 'feed' }),
      callout: h('div', { class: 'callout' }),
      spec: h('div', { class: 'spectate hidden' }, h('div', { class: 'sp1' }), h('div', { class: 'sp2' }, 'TAB / CLICK — next ally')),
      flash: h('div', { class: 'dmgflash' }),
      hitmsg: h('div', { class: 'hitmsg' }, "YOU'VE BEEN HIT"),
      dirs: h('div', { class: 'dmgdirs' }),
    };
    els.barMap = new Map();
    this.layers.hud.append(els.flash, els.bars, els.dirs, els.plaque, els.status, els.reload, els.foes, els.hint, els.reticle, els.lock, els.score, els.feed, els.callout, els.spec, els.hitmsg);
    this.hudEls = els;
    this.setMode(mode);
  }
  setMode(mode) {
    if (!this.hudEls) return;
    this.mode = mode;
    this.hudEls.hint.innerHTML = mode === 'chase'
      ? '<kbd>V</kbd> tactical view<br><kbd>ESC</kbd> pause'
      : '<kbd>V</kbd> chase cam<br><kbd>ESC</kbd> pause';
  }
  showLock(v) { if (this.hudEls) this.hudEls.lock.classList.toggle('hidden', !v); }

  // o: { player, focus (tank the camera follows), spectating, seen (Set), view, mode, lives, maxLives,
  //      score, aim: {to:{x,z}, dist, disp} | null, reload: {frac, left, ready, total} | null, dt }
  updateHUD(world, o) {
    const E = this.hudEls; if (!E) return;
    const { player, focus, view } = o;
    // lives
    const L = E.plaque.querySelector('.lives');
    if (o.maxLives) {
      if (L.childElementCount !== o.maxLives) { L.innerHTML = ''; for (let k = 0; k < o.maxLives; k++) L.append(h('i')); }
      [...L.children].forEach((c, k) => c.classList.toggle('gone', k >= o.lives));
    } else if (L.childElementCount) L.innerHTML = '';

    // status panel (the tank the camera is on)
    const st = focus || player;
    if (st) {
      const hp = Math.max(0, Math.ceil(st.alive ? st.hp : 0)), max = st.maxHp;
      const f = Math.max(0, Math.min(1, hp / max));
      const fill = E.status.querySelector('.hpfill'), ghost = E.status.querySelector('.hpghost');
      fill.style.width = f * 100 + '%';
      fill.classList.toggle('low', f < 0.35);
      // the ghost bar trails behind to show the chunk just lost
      this._ghost = this._ghost == null || this._ghostId !== st.id ? f : Math.max(f, this._ghost - (o.dt || 0.016) * 0.5);
      this._ghostId = st.id;
      ghost.style.width = this._ghost * 100 + '%';
      E.status.querySelector('.hptext').textContent = `${hp} / ${max}`;
      E.status.querySelector('.st-cls').textContent = `${st.human ? 'Your' : st.label + "'s"} ${CLASSES[st.type.cls]?.label || ''} tank`.replace(/\s+/g, ' ');
      E.status.querySelector('.st-spec').textContent = o.spectating ? 'SPECTATING' : '';
      const M = st.modules || {};
      const setMod = (k, bad, t) => {
        const el = E.status.querySelector(`[data-mod="${k}"]`);
        el.classList.toggle('bad', !!bad);
        el.querySelector('.mt').textContent = bad ? (t != null ? t.toFixed(1) + 's' : 'HIT') : 'OK';
      };
      setMod('tracks', M.tracks > 0, M.tracks);
      setMod('turret', M.turret > 0, M.turret);
      setMod('engine', M.engine, null);
      setMod('fire', M.fire > 0, M.fire);
      E.status.classList.toggle('dead', !st.alive);
    }

    // reload box + reticle
    const R = o.reload;
    const showRet = !!(o.aim && R && player && player.alive && !o.spectating);
    E.reload.classList.toggle('hidden', !(R && player && player.alive && !o.spectating));
    if (R && player) {
      E.reload.classList.toggle('ready', R.ready);
      E.reload.querySelector('.rl-state').textContent = R.ready ? 'READY' : R.left > 0 ? 'RELOADING' : 'SHELL AWAY';
      E.reload.querySelector('.rl-time').textContent = R.ready || R.left <= 0 ? '' : Math.max(0.1, R.left).toFixed(1) + 's';
      E.reload.querySelector('.rl-bar i').style.width = (R.frac * 100).toFixed(1) + '%';
      const M = E.reload.querySelector('.mines');
      const mmax = player.type.mines, mlive = o.minesLive || 0;
      if (M.childElementCount !== mmax) { M.innerHTML = ''; for (let k = 0; k < mmax; k++) M.append(h('i', { class: 'mineI' })); }
      [...M.children].forEach((c, k) => c.classList.toggle('out', k >= mmax - mlive));
    }
    E.reticle.classList.toggle('hidden', !showRet);
    if (showRet) this._reticle(o, view);

    // enemy / ally bars
    this._bars(world, o);

    // foes left
    const me = player || focus;
    const foes = world.tanks.filter((t) => !me || t.team !== me.team);
    const key = foes.map((t) => t.id + (t.alive ? 'a' : 'd')).join();
    if (E.foes.dataset.k !== key) {
      E.foes.dataset.k = key; E.foes.innerHTML = '';
      const left = foes.filter((t) => t.alive).length;
      E.foes.append(h('span', { class: 'fl' }, `Hostiles ${left}/${foes.length}`));
      for (const t of foes) E.foes.append(h('span', { class: 'chip' + (t.alive ? '' : ' dead'), style: `background:${hex(t.colorOverride ?? t.type.color)}` }));
    }
    if (o.score) {
      const k2 = JSON.stringify(o.score);
      if (E.score.dataset.k !== k2) {
        E.score.dataset.k = k2; E.score.innerHTML = '';
        for (const s of o.score) E.score.append(h('div', {}, h('span', { class: 'chip', style: `background:${hex(s.color)}` }), s.label ? h('span', { class: 'sl' }, s.label) : null, String(s.wins)));
      }
    } else if (E.score.childElementCount) E.score.innerHTML = '';
    // spectate bar
    E.spec.classList.toggle('hidden', !o.spectating);
    if (o.spectating && focus) E.spec.querySelector('.sp1').textContent = `Watching ${focus.label}` + (o.specCount > 1 ? `  ·  ${o.specIndex + 1}/${o.specCount}` : '');
    E.spec.querySelector('.sp2').textContent = o.specAllies ? 'TAB / CLICK — next ally' : 'TAB / CLICK — next tank';
    this._tickFx(o.dt || 0.016, view);
  }

  _reticle(o, view) {
    const E = this.hudEls, A = o.aim, R = o.reload;
    const c = view.boardToScreen(A.to.x, A.to.z, 0.4);
    if (c.behind) { E.reticle.classList.add('hidden'); return; }
    // radius: project a point displaced sideways by dist × disp (≈ 2σ of the real spread)
    const px = -Math.sin(A.yaw), pz = Math.cos(A.yaw);
    const off = Math.max(0.05, A.dist * A.disp);
    const e = view.boardToScreen(A.to.x + px * off, A.to.z + pz * off, 0.4);
    const r = Math.max(9, Math.min(260, Math.hypot(e.x - c.x, e.y - c.y)));
    const S = Math.ceil(r + 14) * 2;
    const svg = E.reticle.firstChild;
    svg.setAttribute('width', S); svg.setAttribute('height', S);
    svg.style.left = svg.style.top = -S / 2 + 'px';
    const [disp, bg, ring] = svg.children;
    for (const q of [disp, bg, ring]) { q.setAttribute('cx', S / 2); q.setAttribute('cy', S / 2); }
    disp.setAttribute('r', r);
    bg.setAttribute('r', r + 7); ring.setAttribute('r', r + 7);
    const C = 2 * Math.PI * (r + 7);
    ring.setAttribute('stroke-dasharray', `${(C * R.frac).toFixed(1)} ${C.toFixed(1)}`);
    E.reticle.style.transform = `translate(${c.x.toFixed(1)}px, ${c.y.toFixed(1)}px)`;
    E.reticle.classList.toggle('ready', R.ready);
    E.reticle.classList.toggle('enemy', !!A.enemy);
    const rt = E.reticle.querySelector('.rt');
    rt.style.top = r + 12 + 'px';
    rt.textContent = R.ready || R.left <= 0 ? '' : Math.max(0.1, R.left).toFixed(1);
  }

  _bars(world, o) {
    const E = this.hudEls, view = o.view, me = o.player;
    const myTeam = me ? me.team : 0;
    const W = innerWidth, H = innerHeight;
    const live = new Set();
    for (const t of world.tanks) {
      if (!t.alive || t === o.focus || (t === me && !o.spectating)) continue;
      const friend = t.team === myTeam;
      if (!friend && !(o.seen && o.seen.has(t.id))) continue;
      const a = anchorOf(view, t);
      if (!a || a.behind || a.x < -40 || a.x > W + 40 || a.y < -20 || a.y > H + 20) continue;
      live.add(t.id);
      let b = E.barMap.get(t.id);
      if (!b) {
        b = h('div', { class: 'tbar ' + (friend ? 'friend' : 'foe') }, h('div', { class: 'tn' }, h('span', { class: 'chip', style: `background:${hex(t.colorOverride ?? t.type.color)}` }), h('span', { class: 'tl' }, t.label || t.type.name)), h('div', { class: 'tb' }, h('i'), h('span')));
        E.bars.append(b); E.barMap.set(t.id, b);
      }
      const f = Math.max(0, Math.min(1, t.hp / t.maxHp));
      b.querySelector('.tb i').style.width = (f * 100).toFixed(1) + '%';
      b.querySelector('.tb span').textContent = Math.ceil(t.hp);
      b.style.transform = `translate(${a.x.toFixed(1)}px, ${a.y.toFixed(1)}px)`;
      b.classList.toggle('burning', t.modules && t.modules.fire > 0);
      b.classList.toggle('occl', a.visible === false); // spotted, but behind cover from here
      b.style.display = '';
    }
    for (const [id, b] of E.barMap) if (!live.has(id)) b.style.display = 'none';
  }

  // ---------------------------------------------------------------- combat feedback
  // A floating line of text over a tank. kind: dmg-mine, dmg-me, dmg-ally, dmg-foe, dmg-other, rico, nopen, module
  float(tank, text, kind, { big = false, minor = false } = {}) {
    if (!this.hudEls) return;
    this.counts.float++;
    const recent = this.floaters.filter((f) => f.id === tank.id && f.age < 0.25).length;
    const el = h('div', { class: `float ${kind}${big ? ' big' : ''}${minor ? ' minor' : ''}` }, text);
    this.layers.fx.append(el);
    this.floaters.push({ el, id: tank.id, x: tank.x, z: tank.z, age: 0, life: big ? 1.6 : 1.3, stack: recent, tank });
  }
  // Damage to your own tank pops off the HP bar rather than over your hull (keeps the reticle clear).
  hurt(text, kind) {
    const E = this.hudEls; if (!E) return;
    this.counts.float++;
    const el = h('div', { class: 'hurt ' + kind }, text);
    const n = E.status.querySelectorAll('.hurt').length;
    el.style.top = -14 - n * 24 + 'px';
    E.status.append(el);
    setTimeout(() => el.remove(), 1500);
  }
  hitMe(angle, pen) {
    const E = this.hudEls; if (!E) return;
    this.counts.hitMe++;
    if (pen) {
      E.flash.classList.remove('on'); void E.flash.offsetWidth; E.flash.classList.add('on');
      E.hitmsg.classList.remove('on'); void E.hitmsg.offsetWidth; E.hitmsg.classList.add('on');
    }
    if (angle != null) {
      const el = h('div', { class: 'dir' + (pen ? ' pen' : ''), style: `transform: rotate(${angle}rad)` }, h('i'));
      E.dirs.append(el);
      this.dirs.push({ el, age: 0 });
    }
  }
  callout(text, sub) {
    const E = this.hudEls; if (!E) return;
    this.counts.callout++;
    E.callout.innerHTML = '';
    const el = h('div', { class: 'co' }, h('b', {}, text), sub ? h('span', {}, sub) : null);
    E.callout.append(el);
    setTimeout(() => el.remove(), 2200);
  }
  feed(parts) {
    const E = this.hudEls; if (!E) return;
    this.counts.feed++;
    const el = h('div', { class: 'fe' }, ...parts.map(([t, c, cls]) => h('span', { class: cls || '', style: c ? `color:${c}` : '' }, t)));
    E.feed.prepend(el);
    while (E.feed.childElementCount > 5) E.feed.lastChild.remove();
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 500); }, 5000);
  }
  _tickFx(dt, view) {
    for (let k = this.floaters.length - 1; k >= 0; k--) {
      const f = this.floaters[k];
      f.age += dt;
      if (f.age > f.life) { f.el.remove(); this.floaters.splice(k, 1); continue; }
      if (f.tank && f.tank.alive) { f.x = f.tank.x; f.z = f.tank.z; }
      const a = anchorOf(view, f.tank && f.tank.alive ? f.tank : { x: f.x, z: f.z, type: { scale: 1 } });
      if (!a || a.behind) { f.el.style.display = 'none'; continue; }
      f.el.style.display = '';
      const rise = 26 + f.age * 46 + f.stack * 26;
      const op = f.age > f.life - 0.35 ? (f.life - f.age) / 0.35 : 1;
      f.el.style.opacity = op.toFixed(2);
      f.el.style.transform = `translate(${a.x.toFixed(1)}px, ${(a.y - rise).toFixed(1)}px) translate(-50%, -50%) scale(${f.age < 0.1 ? 1.5 - f.age * 5 : 1})`;
    }
    for (let k = this.dirs.length - 1; k >= 0; k--) {
      const d = this.dirs[k]; d.age += dt;
      if (d.age > 1.6) { d.el.remove(); this.dirs.splice(k, 1); continue; }
      d.el.style.opacity = Math.min(1, (1.6 - d.age) / 0.6).toFixed(2);
    }
  }

  // ---------------------------------------------------------------- results
  results({ kicker, title, stamp, rows, stats, note, meter, actions }) {
    const body = [];
    if (rows && rows.length) body.push(h('table', { class: 'tally' }, ...rows.map(([a, b]) => h('tr', {}, h('td', {}, a), h('td', {}, b)))));
    if (stats && stats.length) {
      body.push(h('div', { class: 'kicker', style: 'margin-top:16px' }, 'Your gunnery'),
        h('div', { class: 'statgrid' }, ...stats.map(([a, b, c]) => h('div', { class: 'sg' + (c ? ' ' + c : '') }, h('b', {}, b), h('span', {}, a)))));
    }
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

// Where to hang a bar / text over a tank. Uses the view's anchor when it has one.
function anchorOf(view, t) {
  if (view.tankScreenAnchor && t.id != null) {
    const a = view.tankScreenAnchor(t);
    if (a) return a;
  }
  const s = view.boardToScreen(t.x, t.z, 0.85 * ((t.type && t.type.scale) || 1));
  return { x: s.x, y: s.y, behind: s.behind, visible: !s.behind };
}

// The versus line-up in slot order, human first. Shared by the setup screen and main.js.
export function versusLayout(cfg) {
  const out = [];
  if (cfg.format === 'team') {
    out.push({ human: true, team: 0, color: TEAM_COLORS[0][0], label: 'You', side: 'Your team' });
    for (let k = 0; k < cfg.allies; k++) out.push({ team: 0, ref: cfg.allySlots[k], color: TEAM_COLORS[0][k + 1], label: ALLY_NAMES[k], side: 'Ally' });
    for (let k = 0; k < cfg.enemies; k++) out.push({ team: 1, ref: cfg.enemySlots[k], color: TEAM_COLORS[1][k], label: ENEMY_NAMES[k], side: 'Enemy' });
  } else {
    const n = cfg.format === '1v1' ? 2 : cfg.ffa;
    out.push({ human: true, team: 0, color: VS_COLORS[0], label: 'You', side: '' });
    for (let k = 1; k < n; k++) out.push({ team: k, ref: cfg.enemySlots[k - 1], color: VS_COLORS[k], label: VS_NAMES[k], side: cfg.format === '1v1' ? 'Opponent' : 'Every tank for itself' });
  }
  return out;
}

function rosterNote(k) {
  return {
    rookie: '— dug-in light gun. Thin skin, weak gun.',
    grunt: '— slow medium line tank. Wanders into you.',
    zipper: '— fast light with rockets. Hits hard, dies fast.',
    sapper: '— light that lays mines. Watch the ground.',
    burst: '— autoloader: three quick shells, then a long reload.',
    ricochet: '— dug-in tank destroyer. Huge penetration; don\'t sit still in its lane.',
    hunter: '— fast medium that flanks for your side armour.',
    ghost: '— invisible until close or it fires. Listen for shots.',
    boss: '— the Commander. Thick heavy armour, and it angles it.',
  }[k];
}
