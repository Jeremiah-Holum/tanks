// Garage screen: 3D hangar, BATTLE! with mode choice, tank parameters, gun / ammo / consumables
// loadout and the carousel of owned tanks.
import { h, clear, fmt, roman, ICON, svg, classIcon, flag, shellIcon, masteryIcon, pct } from './dom.js';
import { TANKS, NATIONS, CLASS_LABEL } from '../meta/roster.js';
import { ownedIds, tankState, selectTank, defaultAmmo, CONSUMABLES } from '../meta/profile.js';
import * as eco from '../meta/economy.js';
import { MASTERY_NAMES } from '../meta/economy.js';
import { scores } from './tankStats.js';

export function buildHangar(S) {
  const p = S.profile;
  const stage = h('div.hg-stage');
  const left = h('aside.hg-left.sf-panel');
  const right = h('aside.hg-right.sf-panel');
  const carousel = h('div.hg-carousel');
  const battle = battleBox(S);
  const el = h('section.hangar', stage, h('div.hg-vignette'), battle, left, right, carousel);

  const sc = S.scene3d();
  if (sc) { sc.attach(stage); sc.start(); } else stage.append(h('div.hg-nogl', 'WebGL unavailable: 3D garage disabled'));

  const refresh = (snap) => {
    const id = p.selected, def = TANKS[id], ts = tankState(p, id);
    renderLeft(S, left, def, ts);
    renderRight(S, right, def, ts, () => refresh(false));
    renderCarousel(S, carousel, () => refresh(true));
    if (sc && (snap || sc._shown !== id + ':' + ts.gun)) { sc._shown = id + ':' + ts.gun; sc.setTank(def, { gun: ts.gun, snap: true }); }
  };
  refresh(true);
  return { el, cleanup: () => { sc?.stop(); }, refresh };
}

function battleBox(S) {
  const mode = (size, label, sub) => h('button.hg-mode' + (S.battleSize === size ? '.on' : ''), {
    onclick: (e) => { S.battleSize = size; S.profile.settings.battleSize = size; S.save();
      for (const b of e.currentTarget.parentNode.children) b.classList.toggle('on', b === e.currentTarget); },
  }, h('b', label), h('small', sub));
  return h('div.hg-battle',
    h('button.sf-battle', { onclick: () => S.startBattle() }, h('span', 'BATTLE!')),
    h('div.hg-modes', mode(15, 'Standard', '15 vs 15'), mode(7, 'Skirmish', '7 vs 7')));
}

// ------------------------------------------------------------------ left: tank card & parameters
function bar(label, v, detail, icon) {
  return h('div.stat',
    h('div.stat-top', svg(ICON[icon]), h('span.stat-l', label), h('span.stat-v', Math.round(v * 100))),
    h('div.stat-bar', h('i', { style: { width: (v * 100).toFixed(1) + '%' } })),
    h('div.stat-d', detail));
}
function renderLeft(S, el, def, ts) {
  const sc = scores(def, ts.gun), s = sc.s;
  const winr = ts.battles ? ts.wins / ts.battles : 0;
  clear(el).append(
    h('div.tank-head',
      flag(def.nation, 'flag big'),
      h('div.th-tier', roman(def.tier)),
      h('div.th-main',
        h('div.th-name', def.name),
        h('div.th-sub', classIcon(def.cls, 14), CLASS_LABEL[def.cls], h('span.dot', '•'), NATIONS[def.nation]?.label || def.nation))),
    h('div.stats',
      bar('Firepower', sc.firepower, [h('span', `${s.dmg} dmg`), h('span', `${s.pen} mm`), h('span', `${fmt(s.dpm)} dpm`)], 'gun'),
      bar('Survivability', sc.survivability, [h('span', `${fmt(s.hp)} HP`), h('span', `${s.hullF}/${s.hullS}/${s.hullR} mm`)], 'shield'),
      bar('Mobility', sc.mobility, [h('span', `${s.speed} km/h`), h('span', `${s.pw.toFixed(1)} hp/t`), h('span', `${s.hullTraverse}°/s`)], 'engine'),
      bar('Spotting', sc.spotting, [h('span', `${s.view} m view`), h('span', `${Math.round(s.camo * 100)}% camo`)], 'eye')),
    h('div.tank-xp',
      h('div.txp-cell', svg(ICON.xp), h('div', h('b', fmt(ts.xp)), h('small', 'Vehicle XP'))),
      h('div.txp-cell', h('div', h('b', fmt(ts.battles)), h('small', 'Battles'))),
      h('div.txp-cell', h('div', h('b', ts.battles ? pct(winr) : '—'), h('small', 'Victories'))),
      h('div.txp-cell.m', { title: ts.mastery ? 'Mastery Badge: ' + MASTERY_NAMES[ts.mastery] : 'No Mastery Badge yet' }, masteryIcon(ts.mastery || 0, 30))),
    h('div.hg-actions',
      h('button.sf-btn', { onclick: () => S.showDetails(def.id) }, svg(ICON.info), 'Details & Armour'),
      h('button.sf-btn', { onclick: () => S.showTree(def.nation) }, svg(ICON.tree), 'Research')));
}

// ------------------------------------------------------------------ right: loadout
function renderRight(S, el, def, ts, rerender) {
  const p = S.profile;
  const g = def.guns[ts.gun];
  const gunRows = def.guns.map((gun, gi) => {
    const info = eco.gunInfo(p, def.id, gi);
    const mounted = ts.gun === gi, have = ts.guns.includes(gi);
    const std = gun.shells.find((x) => !x.gold && x.type !== 'HE') || gun.shells[0];
    let action;
    if (mounted) action = h('span.gun-state.mounted', svg(ICON.check), 'Mounted');
    else if (have) action = h('button.sf-btn.small', { onclick: () => { eco.mountGun(p, def.id, gi); S.save(); rerender(); } }, 'Mount');
    else if (info.reason === 'locked') action = h('span.gun-state.locked', svg(ICON.lock), fmt(info.cost));
    else action = h('button.sf-btn.small.xp' + (info.ok ? '' : '.disabled'), {
      title: info.ok ? 'Research with vehicle XP (and free XP)' : `Need ${fmt(info.cost)} XP (${fmt(info.avail)} available)`,
      onclick: async () => {
        if (!info.ok) return S.toast(`Not enough experience: ${fmt(info.cost - info.avail)} XP missing`, 'warn');
        if (await S.confirm({ title: 'Research gun', body: [h('p', `Research the ${gun.name} for ${fmt(info.cost)} XP?`)], ok: 'Research' })) {
          eco.researchGun(p, def.id, gi); S.sfx('research'); S.save(); rerender();
        }
      } }, svg(ICON.xp), fmt(info.cost));
    return h('div.gun-row' + (mounted ? '.on' : ''),
      h('div.gun-cal', gun.cal, h('small', 'mm')),
      h('div.gun-info', h('b', gun.name), h('small', `${std.pen} mm · ${std.dmg} dmg · ${gun.reload.toFixed(1)} s`)),
      action);
  });

  const cap = g.ammo;
  const total = ts.ammo.reduce((a, b) => a + b, 0);
  const setAmmo = (i, n) => { const a = ts.ammo.slice(); a[i] = n; eco.setAmmo(p, def.id, a); S.save(); rerender(); };
  const shells = g.shells.map((s, i) => {
    const price = eco.shellPrice(def, ts.gun, i);
    const step = (d) => (e) => {
      const k = e.shiftKey ? 10 : 1;
      const free = cap - ts.ammo.reduce((a, b) => a + b, 0);
      setAmmo(i, Math.max(0, ts.ammo[i] + (d > 0 ? Math.min(k, free) : -k)));
    };
    return h('div.shell' + (s.gold ? '.gold' : ''),
      shellIcon(s),
      h('div.shell-info',
        h('b', s.type, s.gold ? h('span.prem', 'PREMIUM') : null),
        h('small', `${s.pen} mm · ${s.dmg} dmg`),
        h('small.price', svg(ICON.credits), price ? fmt(price) : 'free')),
      h('div.stepper',
        h('button', { onclick: step(-1), title: 'Shift: ×10' }, svg(ICON.minus)),
        h('input', { type: 'number', min: 0, max: cap, value: ts.ammo[i], onchange: (e) => setAmmo(i, +e.target.value) }),
        h('button', { onclick: step(1), title: 'Shift: ×10' }, svg(ICON.plus))),
      h('kbd', String(i + 1)));
  });
  const cons = CONSUMABLES.map((k, i) => {
    const on = ts.consumables.includes(k), info = eco.CONSUMABLE_INFO[k];
    return h('button.cons' + (on ? '.on' : ''), {
      title: `${info.name}: ${info.desc} Charged only when used: ${fmt(eco.consumablePrice(def, k))} credits.`,
      onclick: () => { eco.setConsumables(p, def.id, on ? ts.consumables.filter((x) => x !== k) : [...ts.consumables, k]); S.save(); rerender(); },
    }, svg(ICON[k]), h('kbd', String(4 + i)));
  });
  const maxAmmoBill = eco.loadoutCost(def, ts.gun, ts.ammo);
  clear(el).append(
    h('h3.sf-h', 'Gun'),
    h('div.guns', gunRows),
    h('h3.sf-h', 'Ammunition', h('span.ammo-count' + (total < cap ? '.under' : ''), `${total} / ${cap}`)),
    h('div.ammo-bar', ts.ammo.map((n, i) => h('i.t-' + g.shells[i].type + (g.shells[i].gold ? '.gold' : ''), { style: { width: (n / cap * 100) + '%' } }))),
    h('div.shells', shells),
    h('div.ammo-actions',
      h('button.sf-btn.small.ghost', { onclick: () => { ts.ammo = eco.setAmmo(p, def.id, defaultAmmo(def, ts.gun)); S.save(); rerender(); } }, 'Default'),
      h('button.sf-btn.small.ghost', { onclick: () => { const a = g.shells.map(() => 0); a[g.shells.findIndex((s) => !s.gold && s.type !== 'HE')] = cap; eco.setAmmo(p, def.id, a); S.save(); rerender(); } }, 'All AP')),
    h('h3.sf-h', 'Consumables'),
    h('div.conss', cons),
    h('div.service',
      h('div', h('span', 'Repair (destroyed)'), h('b', svg(ICON.credits), fmt(eco.repairCost(def, 1)))),
      h('div', h('span', 'Ammo, if all fired'), h('b', svg(ICON.credits), fmt(maxAmmoBill)))));
}

// ------------------------------------------------------------------ carousel
function renderCarousel(S, el, onPick) {
  const p = S.profile;
  const cards = ownedIds(p).map((id) => {
    const def = TANKS[id], ts = p.tanks[id];
    const img = h('img.car-img', { alt: '' });
    S.thumb(def).then((url) => { if (url) { img.src = url; img.classList.add('ok'); } });
    return h('button.car-card' + (id === p.selected ? '.on' : ''), {
      title: def.name,
      onclick: () => { if (id !== p.selected) { selectTank(p, id); S.save(); onPick(); } },
      ondblclick: () => S.showDetails(id),
    },
    flag(def.nation, 'flag car-flag'),
    img,
    h('div.car-top', h('span.car-tier', roman(def.tier)), classIcon(def.cls, 13), ts.mastery ? masteryIcon(ts.mastery, 16) : null),
    h('div.car-name', def.short || def.name));
  });
  cards.push(h('button.car-card.add', { onclick: () => S.showTree(TANKS[p.selected].nation), title: 'Research and buy vehicles' },
    svg(ICON.plus), h('div.car-name', 'Tech Tree')));
  const strip = h('div.car-strip', cards);
  const scroll = (d) => () => strip.scrollBy({ left: d * 400, behavior: 'smooth' });
  clear(el).append(h('button.car-nav', { onclick: scroll(-1) }, svg(ICON.arrowL)), strip, h('button.car-nav', { onclick: scroll(1) }, svg(ICON.arrowR)));
  requestAnimationFrame(() => el.querySelector('.car-card.on')?.scrollIntoView({ block: 'nearest', inline: 'center' }));
}
