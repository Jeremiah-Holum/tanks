// Steel Front menus. Entry point for INTEGRATION:
//
//   const screens = new Screens(rootEl, { onBattle(tankId, { size, battle }), onSettings(settings), audio })
//   screens.showHangar() · showTree(nation?) · showDetails(tankId?) · showRecord() · showSettings()
//   screens.showLoading(battle, mapMeta?) · setLoadingProgress(0..1, label?) · setLoadingMap(mapData)
//   screens.finishBattle(world, playerTankId, battle) → report (summarize + apply + save + showResults)
//   screens.showResults(report) (applies it to the profile if report.applied is false)
//   screens.hideAll() · screens.profile · screens.settings · screens.save() · screens.toast(msg)
//
// `battle` is the matchmaker's buildBattle() result (createBattle options minus the map: call
// loadMap(battle.mapId) or `await withMap(battle)` from src/meta/matchmaker.js).
// The screens own the profile (localStorage 'steelfront.v1'); pass opts.profile/opts.storage to override.
import { h, clear, fmt, ICON, svg, rankIcon } from './dom.js';
import { loadProfile, saveProfile, rankOf } from '../meta/profile.js';
import { buildBattle } from '../meta/matchmaker.js';
import { summarize, applyReport } from '../meta/results.js';
import { buildHangar } from './hangar.js';
import { buildTree } from './techtree.js';
import { buildDetails } from './details.js';
import { buildLoading } from './loading.js';
import { buildResults } from './results.js';
import { buildRecord } from './record.js';
import { buildSettings } from './settings.js';
import { HangarScene } from './hangar3d.js';

export class Screens {
  constructor(root, opts = {}) {
    this.root = root; this.opts = opts;
    this.storage = opts.storage;
    this.profile = opts.profile || loadProfile(this.storage);
    this.audio = opts.audio || null;
    root.classList.add('sf-root');
    this.bar = this._topBar();
    this.view = h('div.sf-view');
    this.modals = h('div.sf-modals');
    this.toasts = h('div.sf-toasts');
    root.append(this.view, this.bar, this.modals, this.toasts);
    this.current = null; this.cleanup = null;
    this.thumbs = new Map();
    this.battleSize = this.profile.settings.battleSize === 7 ? 7 : 15;
    try { this.audio?.setVolumes?.({ ...this.settings.volumes, voiceOn: this.settings.voice }); } catch { /* optional */ }
    this.hideAll();
    // UI click sounds for every button
    root.addEventListener('click', (e) => { if (e.target.closest('button, .clickable')) this.sfx('click'); });
  }

  get settings() { return this.profile.settings; }
  save() { saveProfile(this.profile, this.storage); this.refreshBar(); }
  sfx(kind) { try { this.audio?.ui?.(kind); } catch { /* audio is optional */ } }

  // ---------------------------------------------------------------- top bar
  _topBar() {
    const tab = (id, label, icon, fn) => h('button.sf-tab', { 'data-tab': id, onclick: fn }, svg(ICON[icon]), h('span', label));
    this.barEls = {
      credits: h('span.val'), freexp: h('span.val'), name: h('span.pname'), rank: h('span.prank'), rankIco: h('span'),
    };
    const e = this.barEls;
    return h('header.sf-topbar',
      h('div.sf-logo', h('span.l1', 'STEEL'), h('span.l2', 'FRONT')),
      h('nav.sf-tabs',
        tab('hangar', 'Garage', 'garage', () => this.showHangar()),
        tab('tree', 'Tech Tree', 'tree', () => this.showTree()),
        tab('record', 'Service Record', 'record', () => this.showRecord())),
      h('div.sf-bar-spacer'),
      h('div.sf-wallet',
        h('div.sf-cur.credits', { title: 'Credits: buy tanks, pay for ammo and repairs' }, svg(ICON.credits), e.credits),
        h('div.sf-cur.freexp', { title: 'Free experience: usable to research any vehicle or module' }, svg(ICON.freexp), e.freexp)),
      h('div.sf-player', e.rankIco, h('div.sf-pwho', e.name, e.rank)),
      h('button.sf-iconbtn', { title: 'Settings', onclick: () => this.showSettings() }, svg(ICON.gear)));
  }
  refreshBar() {
    const p = this.profile, e = this.barEls, r = rankOf(p);
    e.credits.textContent = fmt(p.credits);
    e.freexp.textContent = fmt(p.freeXp);
    e.name.textContent = p.name;
    e.rank.textContent = r.name;
    clear(e.rankIco).append(rankIcon(r.index, 30));
    for (const t of this.bar.querySelectorAll('.sf-tab')) t.classList.toggle('on', t.dataset.tab === this.current);
  }

  // ---------------------------------------------------------------- routing
  _show(name, build, { bar = true } = {}) {
    this.closeModals();
    if (this.cleanup) { try { this.cleanup(); } catch (e) { console.warn(e); } this.cleanup = null; }
    clear(this.view);
    this.current = name;
    this.root.hidden = false;
    this.root.dataset.screen = name;
    this.bar.hidden = !bar;
    const res = build();
    this.view.append(res.el);
    this.cleanup = res.cleanup || null;
    this.refreshBar();
    return res;
  }
  hideAll() {
    this.closeModals();
    if (this.cleanup) { try { this.cleanup(); } catch (e) { console.warn(e); } this.cleanup = null; }
    clear(this.view);
    this.current = null;
    this.root.hidden = true;
    this.releaseScene();
    this.sfxMusic(false);
  }
  sfxMusic(on) { try { this.audio?.music?.(on); } catch { /* optional */ } }

  // The hangar scene is kept while browsing menus and released for battle (hideAll / loading).
  scene3d() {
    if (!this._scene) {
      try { this._scene = new HangarScene(h('div')); } catch (e) { console.warn('[ui] WebGL hangar unavailable', e); this._scene = null; }
    }
    return this._scene;
  }
  releaseScene() { if (this._scene) { this._scene.dispose(); this._scene = null; } }

  showHangar() { this.sfxMusic(true); return this._show('hangar', () => buildHangar(this)); }
  showTree(nation) { this.sfxMusic(true); return this._show('tree', () => buildTree(this, nation)); }
  showDetails(tankId) { return this._show('details', () => buildDetails(this, tankId || this.profile.selected)); }
  showRecord() { return this._show('record', () => buildRecord(this)); }
  showSettings() { return buildSettings(this); }
  showLoading(battle, mapMeta) {
    this.releaseScene(); this.sfxMusic(false);
    const r = this._show('loading', () => buildLoading(this, battle, mapMeta), { bar: false });
    this._loading = r;
    return r;
  }
  setLoadingProgress(p, label) { this._loading?.progress?.(p, label); }
  setLoadingMap(map) { this._loading?.setMap?.(map); }
  showResults(report) {
    if (!report.applied) { applyReport(this.profile, report); this.save(); }
    this.sfxMusic(true);
    return this._show('results', () => buildResults(this, report), { bar: false });
  }
  finishBattle(world, playerTankId, battle) {
    const report = summarize(world, playerTankId, this.profile, battle);
    this.showResults(report);
    return report;
  }

  // Build the battle for the selected tank and hand it to INTEGRATION.
  startBattle() {
    const id = this.profile.selected;
    const battle = buildBattle(this.profile, id, { size: this.battleSize });
    this.sfx('battle');
    if (this.opts.onBattle) this.opts.onBattle(id, { size: this.battleSize, battle });
    else this.toast('No battle handler connected (lab mode).');
    return battle;
  }

  // ---------------------------------------------------------------- modals & toasts
  modal(content, { cls = '', onClose, dismissable = true } = {}) {
    const box = h('div.sf-modal' + (cls ? '.' + cls : ''), content);
    const wrap = h('div.sf-modal-wrap', box);
    const close = () => { wrap.remove(); onClose?.(); document.removeEventListener('keydown', key); };
    const key = (e) => { if (e.key === 'Escape' && dismissable) close(); };
    if (dismissable) wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) close(); });
    document.addEventListener('keydown', key);
    this.modals.append(wrap);
    return close;
  }
  closeModals() { clear(this.modals); }
  confirm({ title, body, ok = 'Confirm', cancel = 'Cancel', danger = false, cost }) {
    return new Promise((res) => {
      let done = false;
      const fin = (v) => { if (!done) { done = true; close(); res(v); } };
      const close = this.modal([
        h('div.sf-modal-head', h('h2', title)),
        h('div.sf-modal-body', body),
        cost || null,
        h('div.sf-modal-foot',
          h('button.sf-btn.ghost', { onclick: () => fin(false) }, cancel),
          h('button.sf-btn' + (danger ? '.danger' : '.primary'), { onclick: () => fin(true) }, ok)),
      ], { cls: 'confirm', onClose: () => fin(false) });
    });
  }
  toast(msg, kind = 'info') {
    const t = h('div.sf-toast.' + kind, msg);
    this.toasts.append(t);
    setTimeout(() => t.classList.add('out'), 2600);
    setTimeout(() => t.remove(), 3100);
  }

  // Carousel thumbnail (cached dataURL) — resolves null without WebGL.
  async thumb(def) {
    if (this.thumbs.has(def.id)) return this.thumbs.get(def.id);
    const sc = this.scene3d();
    if (!sc) return null;
    const p = sc.thumb(def).catch(() => null);
    this.thumbs.set(def.id, p);
    return p;
  }
}
