// Battle HUD (WoT style). DOM for panels and text, one 2D canvas for the reticle, scope, lock
// brackets and damage-direction wedges, one canvas for the minimap. Text is only written when it
// changes; markers and floating numbers move with transforms. Styles: src/ui/hud.css.
//   const hud = new Hud(parent, { world, playerId, settings, onMenu(action) })
//   hud.update(state) every frame (see BattleSession._hudState) · hud.event(ev, world) per sim event
//   hud.toast(msg) · hud.flash(text) · hud.flashShell(k) · hud.cycleMinimap() · hud.menu(on)
//   hud.destroyed(world, me) · hud.result(world, me, left) · hud.resize() · hud.dispose()
import * as THREE from 'three';
import { h, clear, shellIcon, classIcon } from './dom.js';
import { renderMinimap } from './loading.js';

// ------------------------------------------------------------------ icons (24×24, currentColor)
const S = (inner) => `<svg viewBox="0 0 24 24" aria-hidden="true">${inner}</svg>`;
const ICO = {
  engine: S('<path fill="currentColor" d="M3 10h2V8h3V6h6v2h2l2 2h1V8h2v9h-2v-2h-1l-2 3H8l-1.5-2H5v2H3z"/>'),
  ammoRack: S('<path fill="currentColor" d="M4 21v-9.5L6 6l2 5.5V21zm6 0v-9.5L12 6l2 5.5V21zm6 0v-9.5L18 6l2 5.5V21z"/>'),
  fuel: S('<path fill="currentColor" d="M7 3h6l1.5 2H18l1 2v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V8zm2.2 7.5L8 11.7l2.8 2.8L8 17.3l1.2 1.2 2.8-2.8 2.8 2.8 1.2-1.2-2.8-2.8 2.8-2.8-1.2-1.2-2.8 2.8z"/>'),
  gun: S('<path fill="currentColor" d="M1 10.5h13v3H1zM14 8h5v8h-5zm5 1.5h4v5h-4z"/>'),
  turretRing: S('<circle cx="12" cy="12" r="7.5" fill="none" stroke="currentColor" stroke-width="3.2" stroke-dasharray="5.2 2.6"/><circle cx="12" cy="12" r="2.2" fill="currentColor"/>'),
  tracks: S('<rect x="2" y="7" width="20" height="10" rx="5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-dasharray="2.6 1.2"/><circle cx="7" cy="12" r="2.2" fill="currentColor"/><circle cx="12" cy="12" r="2.2" fill="currentColor"/><circle cx="17" cy="12" r="2.2" fill="currentColor"/>'),
  crew: S('<circle cx="12" cy="7" r="4.2" fill="currentColor"/><path fill="currentColor" d="M3.5 21.5c0-5.2 3.8-8.4 8.5-8.4s8.5 3.2 8.5 8.4z"/>'),
  fire: S('<path fill="currentColor" d="M12 1.5c.8 4.2 6.5 6.4 6.5 12.6a6.5 6.5 0 0 1-13 0c0-3.3 1.8-5.2 3.1-6.5-.1 2.1.9 3.6 2.3 3.8-.4-3.6-.4-6.7 1.1-9.9z"/>'),
  lamp: S('<path fill="currentColor" d="M12 1.8a7.2 7.2 0 0 0-4.3 13V18h8.6v-3.2A7.2 7.2 0 0 0 12 1.8zM8.5 19.3h7V21a1.5 1.5 0 0 1-1.5 1.5h-4A1.5 1.5 0 0 1 8.5 21z"/>'),
  repair: S('<path fill="currentColor" d="M21 6.5a5 5 0 0 1-6.6 4.7L6.6 19a2.1 2.1 0 0 1-3-3l7.8-7.8A5 5 0 0 1 17.5 2l-3 3 .8 3.7 3.7.8z"/>'),
  medkit: S('<rect x="2.5" y="5.5" width="19" height="15" rx="2" fill="currentColor"/><path fill="#16100c" d="M10.4 8.5h3.2v3.4H17v3.2h-3.4v3.4h-3.2v-3.4H7v-3.2h3.4z"/><path fill="none" stroke="currentColor" stroke-width="1.8" d="M9 5.5V3.8h6v1.7"/>'),
  extinguisher: S('<path fill="currentColor" d="M9 7.5h6a1 1 0 0 1 1 1V21a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V8.5a1 1 0 0 1 1-1zM10.5 3h3v3h-3zM13.5 3.6l5-1.6.6 1.5-4.6 2.2z"/>'),
  skull: S('<path fill="currentColor" d="M12 2.5c-4.8 0-8 3.2-8 7.6 0 2.6 1.1 4.3 2.7 5.4V19h2v-2h1.6v2h3.4v-2h1.6v2h2v-3.5c1.6-1.1 2.7-2.8 2.7-5.4 0-4.4-3.2-7.6-8-7.6zM8.6 13.2a2 2 0 1 1 0-4 2 2 0 0 1 0 4zm6.8 0a2 2 0 1 1 0-4 2 2 0 0 1 0 4z"/>'),
  target: S('<circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2.2"/><circle cx="12" cy="12" r="2.6" fill="currentColor"/><path stroke="currentColor" stroke-width="2.2" d="M12 1v5M12 18v5M1 12h5M18 12h5"/>'),
  shield: S('<path fill="currentColor" d="M12 2 4 5v6c0 5 3.4 9.3 8 11 4.6-1.7 8-6 8-11V5z"/>'),
  eye: S('<path fill="currentColor" d="M12 5C6.5 5 2.7 9.3 1.5 12c1.2 2.7 5 7 10.5 7s9.3-4.3 10.5-7C21.3 9.3 17.5 5 12 5zm0 11.2a4.2 4.2 0 1 1 0-8.4 4.2 4.2 0 0 1 0 8.4zm0-2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4z"/>'),
  burst: S('<path fill="currentColor" d="m12 1 2.2 6.3L20.5 5l-2.8 6 5.3 1.9-5.9 2 2.3 6.1-6-2.9L12 23l-1.6-4.9-6 2.9 2.3-6.1-5.9-2 5.3-1.9-2.8-6 6.3 2.3z"/>'),
};
const ico = (k, cls = 'hi') => { const s = document.createElement('span'); s.className = cls; s.innerHTML = ICO[k]; return s; };

const MODS = [['engine', 'Engine'], ['ammoRack', 'Ammo rack'], ['fuel', 'Fuel tanks'], ['gun', 'Gun'], ['turretRing', 'Turret ring'], ['tracks', 'Tracks']];
const ROLE = { commander: 'C', gunner: 'G', driver: 'D', radioman: 'R', loader: 'L' };
const ROLE_NAME = { commander: 'Commander', gunner: 'Gunner', driver: 'Driver', radioman: 'Radio operator', loader: 'Loader' };
const CONS = { repair: 'Repair kit', medkit: 'First aid kit', extinguisher: 'Fire extinguisher' };
const RIBBON = {
  pen: ['Penetration', 'burst', 'r-pen'], crit: ['Critical hit', 'target', 'r-crit'], ricochet: ['Ricochet', 'shield', 'r-grey'],
  nopen: ["Didn't penetrate", 'shield', 'r-grey'], track: ['Tracks destroyed', 'tracks', 'r-crit'], trackhit: ['Track hit', 'tracks', 'r-grey'],
  splash: ['Hit', 'burst', 'r-pen'], kill: ['Target destroyed', 'skull', 'r-kill'], spot: ['Spotted', 'eye', 'r-spot'],
  blocked: ['Damage blocked', 'shield', 'r-block'],
};
const MINI = { small: 0.25, medium: 0.33, large: 0.46 };
const MINI_ORDER = ['small', 'medium', 'large'];

// cached writes
const txt = (el, v) => { v = String(v); if (el._t !== v) { el._t = v; el.textContent = v; } };
const sty = (el, k, v) => { if (el['_s' + k] !== v) { el['_s' + k] = v; el.style[k] = v; } };
const cls = (el, c, on) => { on = !!on; const k = '_c' + c; if (el[k] !== on) { el[k] = on; el.classList.toggle(c, on); } };
const mmss = (s) => { s = Math.max(0, Math.ceil(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const penColor = (c) => (c == null ? null : c > 0.75 ? '#5ee05a' : c > 0.25 ? '#ffd23a' : '#ff3b2a');

const _v = new THREE.Vector3();

export class Hud {
  constructor(parent, { world, playerId, settings, onMenu }) {
    this.world = world; this.playerId = playerId; this.settings = settings; this.onMenu = onMenu;
    this.me = world.byId[playerId]; this.team = this.me.team;
    this.miniSize = settings.minimap in MINI ? settings.minimap : 'medium';
    this.t = 0;
    this.ribbons = []; this.feed = []; this.log = []; this.wedges = []; this.floats = []; this.toasts = [];
    this.lampT = -9; this.lampOn = false; this.reloadTotal = this.me.gunDef.reload; this._lastReload = this.me.reload;
    this.lastKnown = new Map();
    this._build(parent);
    this.resize();
  }

  // ------------------------------------------------------------------ DOM
  _build(parent) {
    const me = this.me, w = this.world;
    this.cv = h('canvas.hud-cv'); this.ctx = this.cv.getContext('2d');
    this.markers = h('div.hud-markers');
    this.floatLayer = h('div.hud-floats');
    // top: team hp bars, counts, timer, capture bars
    this.top = {
      aBar: h('i'), eBar: h('i'), aN: h('b.ha'), eN: h('b.he'), timer: h('div.hud-timer', '15:00'),
      aHp: h('span.hp-n'), eHp: h('span.hp-n'), caps: h('div.hud-caps'),
    };
    const T = this.top;
    const topEl = h('div.hud-top',
      h('div.hud-score-row',
        h('div.hud-tbar.ally', T.aHp, h('div.tb', T.aBar)), h('div.hud-count', T.aN, h('span.sep', ':'), T.eN),
        h('div.hud-tbar.enemy', h('div.tb', T.eBar), T.eHp)),
      T.timer, T.caps);
    // team lists
    this.lists = [h('div.hud-list.ally'), h('div.hud-list.enemy')];
    this.rows = new Map();
    for (const t of w.tanks) {
      const row = h('div.tl-row' + (t.id === this.playerId ? '.me' : ''), h('span.tl-tank', t.def.short || t.def.name), h('span.tl-name', t.name));
      this.rows.set(t.id, row);
      this.lists[t.team === this.team ? 0 : 1].append(row);
    }
    // sixth sense lamp
    this.lamp = h('div.hud-lamp', ico('lamp'));
    // ribbons, toasts, banners
    this.ribbonEl = h('div.hud-ribbons');
    this.toastEl = h('div.hud-toasts');
    this.banner = h('div.hud-banner');
    this.flashEl = h('div.hud-flash');
    // damage panel
    const D = this.dp = { name: h('span.dp-name', me.def.name), speed: h('span.dp-speed', '0'), hpBar: h('i'), hpLag: h('i.lag'), hpN: h('span.dp-hpn'), mods: {}, crew: {}, fire: ico('fire', 'hi dp-fire') };
    const modEls = MODS.map(([k, n]) => { const el = h('div.dp-mod', { title: n }, ico(k), h('span.dp-t')); D.mods[k] = el; return el; });
    const crewEls = Object.keys(me.crew).map((r) => { const el = h('div.dp-crew', { title: ROLE_NAME[r] || r }, ico('crew'), h('span.dp-role', ROLE[r] || r[0].toUpperCase())); D.crew[r] = el; return el; });
    this.dmgPanel = h('div.hud-dmg',
      h('div.dp-head', h('span.dp-tier', ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII'][me.def.tier] || ''), classIcon(me.def.cls, 14), D.name, h('span.dp-sp', D.speed, h('small', 'km/h'))),
      h('div.dp-hp', h('div.dp-hpbar', D.hpLag, D.hpBar), D.hpN),
      h('div.dp-row', h('div.dp-mods', modEls), D.fire),
      h('div.dp-row.crew', crewEls));
    // shells & consumables
    this.slots = me.gunDef.shells.map((s, k) => {
      const el = h('div.sl-slot.shell', h('span.sl-key', String(k + 1)), shellIcon(s), h('span.sl-type', s.type), h('span.sl-n', '0'));
      if (s.gold) el.classList.add('gold');
      return el;
    });
    this.cons = me.consumables.map((c, k) => h('div.sl-slot.cons', { title: CONS[c.kind] || c.kind }, h('span.sl-key', String(k + 4)), ico(c.kind === 'repair' ? 'repair' : c.kind === 'medkit' ? 'medkit' : 'extinguisher'), h('span.sl-cd'), h('i.sl-sweep')));
    this.clipEl = h('div.sl-clip');
    this.shellsEl = h('div.hud-shells', h('div.sl-group', this.slots), this.clipEl, h('div.sl-group', this.cons));
    // damage log, kill feed, minimap
    this.logEl = h('div.hud-log');
    this.feedEl = h('div.hud-feed');
    this.mini = h('canvas.hud-mini-cv'); this.mctx = this.mini.getContext('2d');
    this.miniLabel = h('div.hud-mini-l', `${w.map.name || ''}`);
    this.miniEl = h('div.hud-mini', this.mini, this.miniLabel, h('span.hud-mini-k', 'M'));
    try { this.miniBg = renderMinimap(w.map, this.team, 512); } catch { this.miniBg = null; }
    const own = w.map.bases?.find((b) => b.team === this.team);
    this.flip = own ? own.z < w.map.size / 2 : false;
    // score panel, menu, perf
    this.scoreEl = h('div.hud-scorepanel');
    this.menuEl = h('div.hud-menu',
      h('div.hm-box',
        h('h2', 'Battle menu'),
        h('button.hm-btn', { onclick: () => this.onMenu?.('resume') }, 'Resume'),
        h('button.hm-btn', { onclick: () => this.onMenu?.('settings') }, 'Settings'),
        h('button.hm-btn.danger', { onclick: () => this.onMenu?.('leave') }, 'Leave battle'),
        h('p.hm-note', 'Leaving counts as a defeat: your tank is destroyed.')));
    this.perfEl = h('div.hud-perf');
    this.hint = h('div.hud-hint');
    this.el = h('div.hud',
      this.cv, this.markers, this.floatLayer, topEl, this.lists[0], this.lists[1], this.lamp, this.ribbonEl, this.toastEl, this.flashEl,
      this.dmgPanel, this.shellsEl, this.logEl, this.feedEl, this.miniEl, this.banner, this.hint, this.scoreEl, this.perfEl, this.menuEl);
    parent.append(this.el);
    this.markerPool = new Map();
    this.applySettings();
  }

  applySettings() {
    cls(this.logEl, 'off', this.settings.damageLog === false);
  }

  resize() {
    const W = this.W = window.innerWidth, H = this.H = window.innerHeight, dpr = this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.cv.width = Math.round(W * dpr); this.cv.height = Math.round(H * dpr);
    this._miniResize();
  }
  _miniResize() {
    const px = Math.round(Math.max(150, Math.min(this.H * MINI[this.miniSize], this.W * 0.36)));
    this.miniPx = px;
    this.mini.width = this.mini.height = Math.round(px * this.dpr);
    this.mini.style.width = this.mini.style.height = px + 'px';
    this.el.style.setProperty('--mini', px + 'px');
    this._miniT = 0;
  }
  cycleMinimap() { this.miniSize = MINI_ORDER[(MINI_ORDER.indexOf(this.miniSize) + 1) % 3]; this._miniResize(); }

  // ------------------------------------------------------------------ per frame
  update(s) {
    this.s = s; this.t += s.dt;
    const me = s.me, w = s.world, alive = me.alive;
    cls(this.el, 'dead', !alive); cls(this.el, 'sniper', s.cam.sniper);
    this._camera = s.camera;
    this._top(w);
    if ((this._listT = (this._listT || 0) - s.dt) <= 0) { this._listT = 0.25; this._lists(w, s.visible); }
    this._damagePanel(me);
    this._shells(me);
    this._lamp(me);
    this._markers(s);
    this._floats();
    this._ribbons();
    this._feedLog();
    this._toasts();
    if ((this._miniT = (this._miniT || 0) - s.dt) <= 0) { this._miniT = 1 / 15; this._minimap(s); }
    this._reticle(s);
    this._banner(s);
    cls(this.scoreEl, 'on', s.score); if (s.score && (this._scoreT = (this._scoreT || 0) - s.dt) <= 0) { this._scoreT = 0.5; this._scorePanel(w); }
    if (!s.score) this._scoreT = 0;
    cls(this.perfEl, 'on', !!s.perf);
    if (s.perf && s.perf.fps) txt(this.perfEl, `${s.perf.fps.toFixed(0)} fps · ${s.perf.frame.toFixed(1)} ms · sim ${s.perf.sim.toFixed(2)} · ai ${s.perf.ai.toFixed(2)} · render ${s.perf.render.toFixed(1)} · hud ${s.perf.hud.toFixed(2)} · ${s.perf.calls} calls · ${(s.perf.tris / 1e6).toFixed(2)} M tris · ${s.quality}`);
    // hints
    let hint = '';
    if (s.phase === 'dead') hint = s.spec != null ? 'Spectating · LMB / RMB: next / previous ally · Esc: menu' : '';
    else if (s.lockTarget != null) hint = 'Target locked · RMB to release';
    else if (s.gunLock) hint = 'Gun locked';
    txt(this.hint, hint); cls(this.hint, 'on', !!hint);
  }

  _top(w) {
    const T = this.top, hp = [0, 0], max = [0, 0], n = [0, 0];
    for (const t of w.tanks) { const k = t.team === this.team ? 0 : 1; if (t.alive) { n[k]++; hp[k] += Math.max(0, Math.min(t.hp, t.maxHp)); } max[k] += t.maxHp; }
    sty(T.aBar, 'transform', `scaleX(${(hp[0] / max[0]).toFixed(3)})`); sty(T.eBar, 'transform', `scaleX(${(hp[1] / max[1]).toFixed(3)})`);
    txt(T.aHp, Math.round(hp[0])); txt(T.eHp, Math.round(hp[1]));
    txt(T.aN, n[0]); txt(T.eN, n[1]);
    const left = w.timeLimit - w.time;
    txt(T.timer, mmss(left)); cls(T.timer, 'low', left < 120);
    // capture bars
    const caps = w.bases.filter((b) => b.points > 0);
    const key = caps.map((b) => b.team).join(',');
    if (key !== this._capKey) {
      this._capKey = key; clear(T.caps); this._capEls = caps.map((b) => {
        const ours = b.team === this.team, fill = h('i'), n = h('b');
        T.caps.append(h('div.cap' + (ours ? '.ours' : '.theirs'), h('span.cap-l', ours ? 'Our base is being captured' : 'Capturing the enemy base'), n, h('div.cap-bar', fill)));
        return { b, fill, n };
      });
    }
    for (const c of this._capEls || []) { sty(c.fill, 'transform', `scaleX(${(c.b.points / 100).toFixed(3)})`); txt(c.n, Math.floor(c.b.points) + '%'); }
  }

  _lists(w, vis) {
    for (const t of w.tanks) {
      const row = this.rows.get(t.id);
      cls(row, 'dead', !t.alive);
      if (t.team !== this.team) cls(row, 'spot', t.alive && vis.has(t.id));
    }
  }

  _damagePanel(me) {
    const D = this.dp;
    txt(D.speed, Math.round(Math.abs(me.speed) * 3.6));
    const hp = Math.max(0, Math.min(me.hp, me.maxHp)), f = hp / me.maxHp;
    sty(D.hpBar, 'transform', `scaleX(${f.toFixed(3)})`);
    this._hpLag = this._hpLag == null ? f : Math.max(f, this._hpLag - this.s.dt * 0.25);
    sty(D.hpLag, 'transform', `scaleX(${this._hpLag.toFixed(3)})`);
    cls(D.hpBar, 'low', f < 0.3);
    txt(D.hpN, `${Math.round(hp)} / ${me.maxHp}`);
    const M = me.modules;
    for (const [k] of MODS) {
      let st, tLeft = 0;
      if (k === 'tracks') {
        const a = M.trackL, b = M.trackR;
        st = a.state === 'destroyed' || b.state === 'destroyed' ? 'destroyed' : a.state === 'damaged' || b.state === 'damaged' ? 'damaged' : 'ok';
        tLeft = Math.max(a.state === 'destroyed' ? a.t : 0, b.state === 'destroyed' ? b.t : 0);
      } else { st = M[k].state; tLeft = st === 'destroyed' ? M[k].t : 0; }
      const el = D.mods[k];
      cls(el, 'dmg', st === 'damaged'); cls(el, 'dead', st === 'destroyed');
      txt(el.lastChild, st === 'destroyed' && tLeft > 0 ? tLeft.toFixed(0) : '');
    }
    for (const r in D.crew) cls(D.crew[r], 'dead', !me.crew[r].alive);
    cls(D.fire, 'on', !!me.fire);
  }

  _shells(me) {
    const g = me.gunDef, sel = this.s && this.s.me === me ? me.shell : me.shell;
    this.slots.forEach((el, k) => { cls(el, 'sel', k === sel); txt(el.lastChild, me.ammo[k] ?? 0); cls(el, 'empty', !(me.ammo[k] > 0)); });
    this.cons.forEach((el, k) => {
      const c = me.consumables[k]; if (!c) return;
      cls(el, 'cd', !c.ready);
      txt(el.querySelector('.sl-cd'), c.ready ? '' : Math.ceil(c.cd));
      const tot = c.kind === 'extinguisher' ? 60 : 90;
      sty(el.lastChild, 'transform', `scaleY(${c.ready ? 0 : Math.min(1, c.cd / tot).toFixed(3)})`);
    });
    if (g.clip) {
      const n = me.clipSize, left = me.clipLeft, key = n + ':' + left;
      if (this._clipKey !== key) { this._clipKey = key; clear(this.clipEl).append(...Array.from({ length: n }, (_, i) => h('i' + (i < left ? '.full' : '')))); }
    }
    // reload bookkeeping for the reticle
    if (me.reload > this._lastReload + 0.02) this.reloadTotal = me.reload;
    this._lastReload = me.reload;
  }

  _lamp(me) {
    if (me.alive && me.spotted && !this.lampOn) { this.lampOn = true; this.lampT = this.t; }
    const show = me.alive && (me.spotted || this.t - this.lampT < 3) && this.lampT > 0;
    if (!me.spotted && this.t - this.lampT >= 3) this.lampOn = false;
    cls(this.lamp, 'on', show);
  }

  _proj(x, y, z) {
    _v.set(x, y, z).project(this._camera);
    if (_v.z > 1 || _v.z < -1) return null;
    return [(_v.x + 1) / 2 * this.W, (1 - _v.y) / 2 * this.H];
  }

  _markers(s) {
    const w = s.world, vis = s.visible, cam = s.cam, P = {};
    const used = new Set();
    for (const t of w.tanks) {
      if (!t.alive || t.id === s.focus.id) continue;
      const enemy = t.team !== this.team;
      if (enemy && !vis.has(t.id)) continue;
      s.ipos(t, P);
      const d = Math.hypot(P.x - cam.pos.x, P.y - cam.pos.y, P.z - cam.pos.z);
      if (!enemy && d > 260) continue;
      if (d > 720) continue;
      const p = this._proj(P.x, P.y + t.cy * 2 + 1.6, P.z);
      if (!p || p[0] < -50 || p[0] > this.W + 50 || p[1] < -30 || p[1] > this.H + 30) continue;
      let m = this.markerPool.get(t.id);
      if (!m) {
        const bar = h('i'), name = h('span.mk-n'), tank = h('span.mk-t', t.def.short || t.def.name), hpn = h('span.mk-hp');
        const el = h('div.mk' + (enemy ? '.en' : '.al'), h('div.mk-l', tank, name), h('div.mk-bar', bar, hpn));
        this.markers.append(el);
        m = { el, bar, name, hpn }; this.markerPool.set(t.id, m);
      }
      used.add(t.id);
      sty(m.el, 'transform', `translate3d(${p[0].toFixed(1)}px,${p[1].toFixed(1)}px,0)`);
      sty(m.el, 'display', '');
      const f = Math.max(0, Math.min(1, t.hp / t.maxHp));
      sty(m.bar, 'transform', `scaleX(${f.toFixed(3)})`);
      txt(m.hpn, Math.round(t.hp));
      txt(m.name, d < 160 ? t.name : '');
      cls(m.el, 'far', d > 300);
      cls(m.el, 'lock', t.id === s.lockTarget);
    }
    for (const [id, m] of this.markerPool) if (!used.has(id)) sty(m.el, 'display', 'none');
  }

  _floats() {
    for (let i = this.floats.length - 1; i >= 0; i--) {
      const f = this.floats[i]; f.age += this.s.dt;
      if (f.age > 1.6) { f.el.remove(); this.floats.splice(i, 1); continue; }
      const p = this._proj(f.x, f.y + 1.5, f.z);
      if (!p) { sty(f.el, 'opacity', '0'); continue; }
      sty(f.el, 'transform', `translate3d(${p[0].toFixed(1)}px,${(p[1] - f.age * 38).toFixed(1)}px,0)`);
      sty(f.el, 'opacity', String(Math.min(1, (1.6 - f.age) * 2.5).toFixed(2)));
    }
  }

  _ribbons() {
    for (let i = this.ribbons.length - 1; i >= 0; i--) {
      const r = this.ribbons[i]; r.age += this.s.dt;
      if (r.age > 3.2 && !r.out) { r.out = true; r.el.classList.add('out'); }
      if (r.age > 3.6) { r.el.remove(); this.ribbons.splice(i, 1); }
    }
  }
  _feedLog() {
    for (let i = this.feed.length - 1; i >= 0; i--) { const f = this.feed[i]; f.age += this.s.dt; if (f.age > 9 && !f.out) { f.out = true; f.el.classList.add('out'); } if (f.age > 9.6) { f.el.remove(); this.feed.splice(i, 1); } }
  }
  _toasts() {
    for (let i = this.toasts.length - 1; i >= 0; i--) { const f = this.toasts[i]; f.age += this.s.dt; if (f.age > 1.8 && !f.out) { f.out = true; f.el.classList.add('out'); } if (f.age > 2.3) { f.el.remove(); this.toasts.splice(i, 1); } }
    if (this._flashAge != null) { this._flashAge += this.s.dt; if (this._flashAge > 1.4) { this.flashEl.classList.remove('on'); this._flashAge = null; } }
  }

  // ------------------------------------------------------------------ minimap
  _mx(x) { return (this.flip ? this.world.map.size - x : x) / this.world.map.size * this.miniPx; }
  _minimap(s) {
    const c = this.mctx, px = this.miniPx, w = s.world, size = w.map.size, k = this.flip ? -1 : 1, dpr = this.dpr;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (this.miniBg) c.drawImage(this.miniBg, 0, 0, px, px); else { c.fillStyle = '#2b3322'; c.fillRect(0, 0, px, px); }
    c.fillStyle = 'rgba(0,0,0,0.12)'; c.fillRect(0, 0, px, px);
    // play-area boundary
    const pl = w.map.play;
    if (pl) { c.strokeStyle = 'rgba(255,60,40,0.7)'; c.lineWidth = 1; c.setLineDash([4, 3]); const a = this._mx(pl.min), b = this._mx(pl.max); c.strokeRect(Math.min(a, b), Math.min(a, b), Math.abs(b - a), Math.abs(b - a)); c.setLineDash([]); }
    const X = (x) => this._mx(x), Z = (z) => this._mx(z), sc = px / size;
    const vis = s.visible, P = {};
    // last known positions of enemies that went dark (fade over 25 s)
    for (const t of w.tanks) {
      if (t.team === this.team) continue;
      if (vis.has(t.id) && t.alive) this.lastKnown.set(t.id, { x: t.pos.x, z: t.pos.z, t: w.time });
      else if (!t.alive) this.lastKnown.delete(t.id);
    }
    for (const [id, lk] of this.lastKnown) {
      if (vis.has(id)) continue;
      const age = w.time - lk.t; if (age > 25) { this.lastKnown.delete(id); continue; }
      c.globalAlpha = 0.75 * (1 - age / 25);
      c.strokeStyle = '#ff5a40'; c.lineWidth = 1.5;
      c.beginPath(); c.arc(X(lk.x), Z(lk.z), 3.5, 0, 7); c.stroke();
      c.globalAlpha = 1;
    }
    const me = s.me, foc = s.focus;
    for (const t of w.tanks) {
      const ally = t.team === this.team;
      if (!ally && !vis.has(t.id)) continue;
      s.ipos(t, P);
      const x = X(P.x), y = Z(P.z);
      if (!t.alive) { c.strokeStyle = ally ? 'rgba(160,200,140,0.55)' : 'rgba(255,120,100,0.55)'; c.lineWidth = 1.4; c.beginPath(); c.moveTo(x - 2.5, y - 2.5); c.lineTo(x + 2.5, y + 2.5); c.moveTo(x + 2.5, y - 2.5); c.lineTo(x - 2.5, y + 2.5); c.stroke(); continue; }
      if (t === me || t === foc) continue;
      c.fillStyle = ally ? '#7fe05a' : '#ff4a32'; c.strokeStyle = 'rgba(0,0,0,0.75)'; c.lineWidth = 1;
      if (ally) { this._arrow(c, x, y, t.yaw, 4.2, k); }
      else { c.beginPath(); c.moveTo(x, y - 4.4); c.lineTo(x + 4.4, y); c.lineTo(x, y + 4.4); c.lineTo(x - 4.4, y); c.closePath(); c.fill(); c.stroke(); }
    }
    // focus tank (player or spectated ally): view range, camera direction, arrow
    s.ipos(foc, P);
    const fx = X(P.x), fy = Z(P.z);
    if (foc === me && me.alive) {
      c.strokeStyle = 'rgba(255,255,255,0.55)'; c.lineWidth = 1; c.setLineDash([3, 3]);
      c.beginPath(); c.arc(fx, fy, s.viewRange * sc, 0, 7); c.stroke(); c.setLineDash([]);
      c.strokeStyle = 'rgba(255,255,255,0.18)'; c.beginPath(); c.arc(fx, fy, 445 * sc, 0, 7); c.stroke();
    }
    const cy = s.cam.yaw, half = s.cam.fov * Math.PI / 360 * (this.W / this.H), L = 60 * sc * (size / 400);
    const g = c.createRadialGradient(fx, fy, 2, fx, fy, L);
    g.addColorStop(0, 'rgba(255,255,255,0.35)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g; c.beginPath(); c.moveTo(fx, fy);
    const a0 = cy - Math.min(0.9, half), a1 = cy + Math.min(0.9, half);
    for (let i = 0; i <= 8; i++) { const a = a0 + (a1 - a0) * i / 8; c.lineTo(fx + Math.sin(a) * L * k, fy + Math.cos(a) * L * k); }
    c.closePath(); c.fill();
    c.fillStyle = foc === me ? '#fff1c8' : '#9ff07a'; c.strokeStyle = '#000'; c.lineWidth = 1.2;
    this._arrow(c, fx, fy, foc.yaw, 6, k);
    // frame
    c.strokeStyle = 'rgba(222,196,132,0.4)'; c.lineWidth = 1; c.strokeRect(0.5, 0.5, px - 1, px - 1);
  }
  _arrow(c, x, y, yaw, r, k) {
    const fx = Math.sin(yaw) * k, fz = Math.cos(yaw) * k, rx = fz, rz = -fx;
    c.beginPath();
    c.moveTo(x + fx * r * 1.3, y + fz * r * 1.3);
    c.lineTo(x - fx * r * 0.8 + rx * r * 0.8, y - fz * r * 0.8 + rz * r * 0.8);
    c.lineTo(x - fx * r * 0.35, y - fz * r * 0.35);
    c.lineTo(x - fx * r * 0.8 - rx * r * 0.8, y - fz * r * 0.8 - rz * r * 0.8);
    c.closePath(); c.fill(); c.stroke();
  }

  // ------------------------------------------------------------------ reticle canvas
  _reticle(s) {
    const c = this.ctx, W = this.W, H = this.H, dpr = this.dpr, me = s.me, cam = s.cam;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, W, H);
    const cx = W / 2, cy = H / 2;
    const focal = (H / 2) / Math.tan(cam.fov * Math.PI / 360);
    if (cam.sniper && me.alive) this._scope(c, W, H, cx, cy, s);
    // damage-direction wedges (towards whoever hit us)
    for (let i = this.wedges.length - 1; i >= 0; i--) {
      const wd = this.wedges[i]; wd.age += s.dt;
      if (wd.age > 3.5) { this.wedges.splice(i, 1); continue; }
      const P = s.ipos(me, {}), dx = wd.x - P.x, dz = wd.z - P.z, y = cam.yaw;
      const f = dx * Math.sin(y) + dz * Math.cos(y), r = -dx * Math.cos(y) + dz * Math.sin(y);
      const th = Math.atan2(r, f) - Math.PI / 2, a = Math.min(1, (3.5 - wd.age) * 1.2);
      const R0 = Math.min(W, H) * 0.16, R1 = R0 + 26;
      c.beginPath(); c.arc(cx, cy, R1, th - 0.26, th + 0.26); c.arc(cx, cy, R0, th + 0.12, th - 0.12, true); c.closePath();
      const gr = c.createRadialGradient(cx, cy, R0, cx, cy, R1);
      gr.addColorStop(0, `rgba(255,40,20,${0.95 * a})`); gr.addColorStop(1, `rgba(255,40,20,${0.15 * a})`);
      c.fillStyle = gr; c.fill();
    }
    if (!me.alive || s.phase === 'ending') return;
    // centre: camera aim point
    c.lineCap = 'round';
    const tick = (x0, y0, x1, y1, col, lw) => { c.strokeStyle = 'rgba(0,0,0,0.6)'; c.lineWidth = lw + 2; c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke(); c.strokeStyle = col; c.lineWidth = lw; c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke(); };
    if (!cam.sniper) { c.fillStyle = 'rgba(0,0,0,0.6)'; c.beginPath(); c.arc(cx, cy, 2.6, 0, 7); c.fill(); c.fillStyle = '#fff'; c.beginPath(); c.arc(cx, cy, 1.3, 0, 7); c.fill(); }
    // gun marker: where the gun points now (differs from the aim point while the turret traverses)
    const col = penColor(s.pen ? s.pen.chance : null) || '#f2eedf';
    let gx = cx, gy = cy;
    if (s.impact) { const p = this._proj(s.impact.x, s.impact.y, s.impact.z); if (p) { gx = p[0]; gy = p[1]; } }
    const trueR = me.disp / 100 * focal, R = 6 + trueR;
    c.strokeStyle = 'rgba(0,0,0,0.55)'; c.lineWidth = 3.4; c.beginPath(); c.arc(gx, gy, R, 0, 7); c.stroke();
    c.strokeStyle = col; c.lineWidth = 1.6; c.beginPath(); c.arc(gx, gy, R, 0, 7); c.stroke();
    for (let q = 0; q < 4; q++) { const a = q * Math.PI / 2, ca = Math.cos(a), sa = Math.sin(a); tick(gx + ca * (R + 2), gy + sa * (R + 2), gx + ca * (R + 8), gy + sa * (R + 8), col, 1.6); }
    c.fillStyle = col; c.beginPath(); c.arc(gx, gy, 1.6, 0, 7); c.fill();
    // reload ring (fixed size around the gun marker) + numbers
    const rr = 34, tot = Math.max(0.05, this.reloadTotal || me.gunDef.reload), k = me.reload > 0 ? 1 - me.reload / tot : 1;
    c.lineWidth = 3; c.strokeStyle = 'rgba(0,0,0,0.35)';
    c.beginPath(); c.arc(gx, gy, rr, Math.PI * 0.62, Math.PI * 1.38); c.stroke();
    c.strokeStyle = me.reload > 0 ? '#f0a830' : '#6ee05a';
    c.beginPath(); c.arc(gx, gy, rr, Math.PI * 1.38 - Math.PI * 0.76 * k, Math.PI * 1.38); c.stroke();
    c.font = '600 15px "Barlow Condensed", "Arial Narrow", sans-serif'; c.textBaseline = 'middle';
    const label = (t, x, y, colr, align) => { c.textAlign = align; c.lineWidth = 3; c.strokeStyle = 'rgba(0,0,0,0.7)'; c.strokeText(t, x, y); c.fillStyle = colr; c.fillText(t, x, y); };
    if (me.reload > 0) label(me.reload.toFixed(1), gx - rr - 8, gy, '#ffc862', 'right');
    const shell = me.gunDef.shells[me.shell];
    label(`${me.ammo[me.shell] ?? 0}`, gx + rr + 8, gy - 8, '#f2eedf', 'left');
    if (shell) label(shell.type, gx + rr + 8, gy + 9, shell.gold ? '#ffd35a' : '#bdb8a6', 'left');
    if (me.gunDef.clip) label(`${me.clipLeft}/${me.clipSize}`, gx - rr - 8, gy + 16, '#bdb8a6', 'right');
    if (s.pen && s.pen.chance != null) label(`${Math.round(s.pen.chance * 100)}%`, gx, gy + rr + 12, col, 'center');
    // autoaim lock brackets
    if (s.lockTarget != null) {
      const t = s.world.byId[s.lockTarget];
      if (t) {
        const P = s.ipos(t, {}), p = this._proj(P.x, P.y + t.cy, P.z);
        if (p) {
          const d = Math.hypot(P.x - cam.pos.x, P.y - cam.pos.y, P.z - cam.pos.z), r = Math.max(14, t.rad / Math.max(1, d) * focal);
          c.strokeStyle = '#ff3b2a'; c.lineWidth = 2;
          for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
            c.beginPath(); c.moveTo(p[0] + sx * r, p[1] + sy * r * 0.7 - sy * 8); c.lineTo(p[0] + sx * r, p[1] + sy * r * 0.7); c.lineTo(p[0] + sx * r - sx * 8, p[1] + sy * r * 0.7); c.stroke();
          }
        }
      }
    }
  }

  _scope(c, W, H, cx, cy, s) {
    const R = Math.min(W, H) * 0.47;
    const g = c.createRadialGradient(cx, cy, R * 0.82, cx, cy, R * 1.25);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(0.55, 'rgba(0,0,0,0.55)'); g.addColorStop(1, 'rgba(0,0,0,0.88)');
    c.fillStyle = g; c.fillRect(0, 0, W, H);
    c.strokeStyle = 'rgba(10,10,10,0.85)'; c.lineWidth = 1.2;
    const gap = 46;
    c.beginPath();
    c.moveTo(cx - R, cy); c.lineTo(cx - gap, cy); c.moveTo(cx + gap, cy); c.lineTo(cx + R, cy);
    c.moveTo(cx, cy + gap); c.lineTo(cx, cy + R);
    c.stroke();
    c.lineWidth = 1;
    for (let i = 1; i <= 8; i++) {
      const x = gap + i * 22, hh = i % 2 ? 4 : 7;
      c.beginPath(); c.moveTo(cx - x, cy - hh); c.lineTo(cx - x, cy + hh); c.moveTo(cx + x, cy - hh); c.lineTo(cx + x, cy + hh); c.stroke();
    }
    // chevron
    c.strokeStyle = 'rgba(10,10,10,0.9)'; c.lineWidth = 1.6;
    c.beginPath(); c.moveTo(cx - 10, cy + 16); c.lineTo(cx, cy + 5); c.lineTo(cx + 10, cy + 16); c.stroke();
    c.font = '600 16px "Barlow Condensed", "Arial Narrow", sans-serif'; c.textAlign = 'left'; c.textBaseline = 'middle';
    c.fillStyle = 'rgba(255,236,190,0.95)';
    c.fillText(`×${s.cam.zoom}`, cx + R * 0.52, cy + R * 0.62);
    if (s.aim && !s.aim.sky) c.fillText(`${Math.round(s.aim.t)} m`, cx + R * 0.52, cy + R * 0.62 + 20);
  }

  // ------------------------------------------------------------------ banners
  _banner(s) {
    let key = '', html = '';
    if (s.phase === 'countdown') { const n = Math.ceil(s.countdown); key = 'cd' + n; html = `<small>Battle starts in</small><b class="big">${n}</b><em>Press <kbd>Space</kbd> to skip</em>`; }
    else if (s.phase === 'dead' && this._deadMsg) { key = 'dead' + (s.spec ?? '') ; const sp = s.spec != null ? s.world.byId[s.spec] : null; html = this._deadMsg + (sp ? `<em>Spectating <b>${esc(sp.name)}</b> · ${esc(sp.def.short || sp.def.name)}</em>` : ''); }
    else if (s.phase === 'ending' && this._endMsg) { key = 'end'; html = this._endMsg; }
    if (key !== this._bannerKey) { this._bannerKey = key; this.banner.innerHTML = html; cls(this.banner, 'on', !!html); this.banner.className = 'hud-banner' + (html ? ' on ' + (s.phase === 'ending' ? this._endCls : s.phase) : ''); }
  }
  destroyed(world, me) {
    const k = me.killedBy != null ? world.byId[me.killedBy] : null;
    const cause = { ammorack: 'Ammo rack detonation', fire: 'Burned out', ram: 'Rammed', splash: 'HE splash', left: 'Left the battle' }[me.deathCause] || '';
    this._deadMsg = `<b class="big red">Destroyed</b>` + (k ? `<small>by <b>${esc(k.name)}</b> · ${esc(k.def.short || k.def.name)}${cause ? ' · ' + cause : ''}</small>` : (cause ? `<small>${cause}</small>` : ''));
    this.lampOn = false; cls(this.lamp, 'on', false);
  }
  result(world, me, left) {
    const r = world.result, won = r.winner === me.team, draw = r.winner === -1;
    const why = { destroyed: won ? 'All enemy vehicles destroyed' : draw ? 'Both teams destroyed' : 'All allied vehicles destroyed', capture: won ? 'Enemy base captured' : 'Our base was captured', time: 'Time is up', left: 'You left the battle' }[r.reason] || '';
    this._endCls = won ? 'win' : draw ? 'draw' : 'lose';
    this._endMsg = `<b class="big">${won ? 'Victory!' : draw ? 'Draw' : 'Defeat'}</b><small>${why}</small>`;
  }
  flash(text) { this.flashEl.textContent = text; this.flashEl.classList.remove('on'); void this.flashEl.offsetWidth; this.flashEl.classList.add('on'); this._flashAge = 0; }
  flashShell(k) { const el = this.slots[k]; if (el) { el.classList.remove('pick'); void el.offsetWidth; el.classList.add('pick'); } }
  toast(msg, kind = '') {
    if (this.toasts.length && this.toasts[this.toasts.length - 1].msg === msg) { this.toasts[this.toasts.length - 1].age = 0; return; }
    const el = h('div.ht' + (kind ? '.' + kind : ''), msg); this.toastEl.append(el); this.toasts.push({ el, age: 0, msg });
    while (this.toasts.length > 3) this.toasts.shift().el.remove();
  }
  menu(on) { cls(this.menuEl, 'on', on); }

  // ------------------------------------------------------------------ events
  event(e, w) {
    const me = this.me, pid = this.playerId;
    switch (e.type) {
      case 'hit': {
        const tg = w.byId[e.target], sh = w.byId[e.shooter];
        if (e.shooter === pid && tg) {
          let kind = e.result;
          if (kind === 'track') kind = tg.modules.trackL.state === 'destroyed' || tg.modules.trackR.state === 'destroyed' ? 'track' : 'trackhit';
          if (kind === 'nopen' && e.crits && e.crits.length) kind = 'crit';
          if (kind === 'pen' && e.crits && e.crits.length && !e.dmg) kind = 'crit';
          if (kind === 'splash' && !e.dmg) kind = 'nopen';
          this.ribbon(kind, e.dmg || 0);
          if (e.dmg > 0) { this.floatDmg(e.pos || tg.pos, e.dmg); this.logLine('dealt', e.dmg, tg, e.result); }
        }
        if (e.target === pid && sh) {
          this.wedges.push({ x: sh.pos.x, z: sh.pos.z, age: 0 });
          if (e.dmg > 0) this.logLine('recv', e.dmg, sh, e.result);
          else { this.logLine('block', 0, sh, e.result); if (e.result === 'ricochet' || e.result === 'nopen' || e.result === 'track') this.ribbon('blocked', 0); }
        }
        break;
      }
      case 'kill': {
        const k = w.byId[e.killer], v = w.byId[e.victim];
        if (v) this.killFeed(k, v, e.cause);
        if (e.killer === pid && v && v.team !== me.team) this.ribbon('kill', 0);
        break;
      }
      case 'spot':
        if (e.on && e.team === this.team && me.alive) { const t = w.byId[e.tank]; if (t && t.spottedBy[this.team] === pid) this.ribbon('spot', 0); }
        break;
      case 'module':
        if (e.tank === pid && e.state === 'destroyed') this.toast({ engine: 'Engine destroyed!', gun: 'Gun destroyed!', trackL: 'Track destroyed!', trackR: 'Track destroyed!', turretRing: 'Turret ring destroyed!', ammoRack: 'Ammo rack destroyed!', fuel: 'Fuel tank destroyed!' }[e.module] || 'Module destroyed', 'bad');
        break;
      case 'crew':
        if (e.tank === pid && !e.alive) this.toast(`${ROLE_NAME[e.role] || e.role} is wounded!`, 'bad');
        break;
      case 'fire':
        if (e.tank === pid) this.toast(e.on ? 'Fire!' : 'Fire extinguished', e.on ? 'bad' : '');
        break;
      case 'consumable':
        if (e.tank === pid) this.toast(`${CONS[e.kind] || e.kind} used`, 'good');
        break;
      case 'reloaded':
        if (e.tank === pid) { this.reloadTotal = me.gunDef.clip && me.clipLeft > 0 && me.clipLeft < me.clipSize ? me.gunDef.clip.t : me.gunDef.reload; }
        break;
      default:
    }
  }

  ribbon(kind, dmg) {
    const def = RIBBON[kind]; if (!def) return;
    const cur = this.ribbons.find((r) => r.kind === kind && !r.out);
    if (cur) {
      cur.n++; cur.dmg += dmg; cur.age = 0;
      txt(cur.cnt, '×' + cur.n); if (cur.dmgEl) txt(cur.dmgEl, cur.dmg);
      cur.el.classList.remove('pop'); void cur.el.offsetWidth; cur.el.classList.add('pop');
      return;
    }
    const cnt = h('span.rb-n'), dmgEl = dmg > 0 || kind === 'pen' ? h('b.rb-d', dmg) : null;
    const el = h('div.rb.pop.' + def[2], ico(def[1]), h('span.rb-l', def[0]), dmgEl, cnt);
    this.ribbonEl.append(el);
    this.ribbons.push({ kind, el, cnt, dmgEl, n: 1, dmg, age: 0 });
    while (this.ribbons.length > 4) this.ribbons.shift().el.remove();
  }
  floatDmg(p, dmg) {
    const el = h('div.fd', '−' + dmg);
    this.floatLayer.append(el);
    this.floats.push({ el, x: p.x, y: p.y, z: p.z, age: 0 });
  }
  logLine(kind, dmg, other, result) {
    if (this.settings.damageLog === false) return;
    const what = { pen: 'Penetration', crit: 'Critical hit', ricochet: 'Ricochet', nopen: 'No penetration', track: 'Track hit', splash: 'HE splash' }[result] || result;
    const el = h('div.dl.' + kind, h('b', kind === 'dealt' ? '▲' : kind === 'recv' ? '▼' : '■'), h('span.dl-d', kind === 'block' ? '0' : String(dmg)), h('span.dl-w', what), h('span.dl-t', `${other.def.short || other.def.name} · ${other.name}`));
    this.logEl.append(el);
    this.log.push(el);
    while (this.log.length > 6) this.log.shift().remove();
  }
  killFeed(k, v, cause) {
    const side = (t) => (t.team === this.team ? 'a' : 'e');
    const me = (t) => (t && t.id === this.playerId ? '.me' : '');
    const icon = cause === 'ammorack' ? ico('burst', 'hi kf-i') : cause === 'fire' ? ico('fire', 'hi kf-i') : ico('skull', 'hi kf-i');
    const el = h('div.kf' + (k && k.id === this.playerId ? '.mine' : '') + (v.id === this.playerId ? '.mine' : ''),
      k ? h('span.kf-n.' + side(k) + me(k), `${k.name}`, h('small', k.def.short || '')) : h('span.kf-n.x', cause === 'fire' ? 'Fire' : '—'),
      icon, h('span.kf-n.' + side(v) + me(v), `${v.name}`, h('small', v.def.short || '')));
    this.feedEl.append(el);
    this.feed.push({ el, age: 0 });
    while (this.feed.length > 5) this.feed.shift().el.remove();
  }

  _scorePanel(w) {
    const teams = [w.tanks.filter((t) => t.team === this.team), w.tanks.filter((t) => t.team !== this.team)];
    const col = (list, k) => h('div.sp-col.' + (k ? 'en' : 'al'),
      h('h3', k ? 'Enemy team' : 'Your team', h('span', `${list.filter((t) => t.alive).length} / ${list.length}`)),
      h('div.sp-row.head', h('span', 'Vehicle'), h('span', 'Player'), h('span', 'Dmg'), h('span', 'Kills')),
      list.map((t) => h('div.sp-row' + (t.alive ? '' : '.dead') + (t.id === this.playerId ? '.me' : '') + (k && t.alive && !w.visible[this.team].has(t.id) ? '.hid' : ''),
        h('span.sp-tank', classIcon(t.def.cls, 12), ` ${t.def.short || t.def.name}`), h('span.sp-name', t.name), h('span', Math.round(t.stats.dmg)), h('span', t.stats.kills))));
    clear(this.scoreEl).append(h('div.sp-box', h('div.sp-head', h('b', w.map.name || ''), h('span', mmss(w.timeLimit - w.time))), h('div.sp-cols', col(teams[0], 0), col(teams[1], 1))));
  }

  dispose() { this.el.remove(); }
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
