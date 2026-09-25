// Tech tree: one nation at a time as a node graph (tiers left→right), with research / buy states,
// costs, XP-available tooltips and confirm dialogs. Layout is computed from the roster's parents.
import { h, clear, fmt, roman, ICON, svg, classIcon, flag } from './dom.js';
import { TANKS, TANK_LIST, NATIONS, NATION_IDS, MAX_TIER, CLASS_LABEL } from '../meta/roster.js';
import { isOwned, isResearched, selectTank } from '../meta/profile.js';
import * as eco from '../meta/economy.js';
import { derive } from './tankStats.js';

const CLS_ORDER = { light: 0, medium: 1, heavy: 2, td: 3 };

// rows: depth-first from the starters; a parent sits on its first child's row so lines run straight.
export function layoutTree(nation) {
  const defs = TANK_LIST.filter((d) => d.nation === nation);
  const kids = (id) => defs.filter((d) => (d.parents || []).includes(id))
    .sort((a, b) => a.tier - b.tier || CLS_ORDER[a.cls] - CLS_ORDER[b.cls] || a.id.localeCompare(b.id));
  const row = {}; let next = 0;
  const visit = (d) => {
    if (row[d.id] !== undefined) return row[d.id];
    const ks = kids(d.id).filter((k) => row[k.id] === undefined && (k.parents[0] === d.id || !defs.some((x) => x.id === k.parents[0])));
    if (!ks.length) return (row[d.id] = next++);
    const rs = ks.map(visit);
    return (row[d.id] = rs[0]);
  };
  const roots = defs.filter((d) => !(d.parents || []).some((p) => defs.some((x) => x.id === p)))
    .sort((a, b) => a.tier - b.tier || CLS_ORDER[a.cls] - CLS_ORDER[b.cls]);
  for (const r of roots) visit(r);
  for (const d of defs) if (row[d.id] === undefined) row[d.id] = next++;
  // the starter goes in the middle of its subtree
  for (const r of roots) {
    const sub = defs.filter((d) => d.tier > r.tier && reaches(d, r.id, defs)).map((d) => row[d.id]);
    if (sub.length) row[r.id] = Math.round((Math.min(...sub) + Math.max(...sub)) / 2);
  }
  const edges = defs.flatMap((d) => (d.parents || []).filter((p) => defs.some((x) => x.id === p)).map((p) => [p, d.id]));
  return { defs, row, rows: next, edges };
}
function reaches(d, rootId, defs) {
  const seen = new Set();
  const up = (x) => { if (x.id === rootId) return true; if (seen.has(x.id)) return false; seen.add(x.id);
    return (x.parents || []).some((p) => { const q = defs.find((z) => z.id === p); return q && up(q); }); };
  return up(d);
}

export function nodeState(p, id) {
  if (isOwned(p, id)) return 'owned';
  if (isResearched(p, id)) return 'researched';
  const r = eco.researchInfo(p, id);
  if (r.reason === 'locked') return 'locked';
  return r.ok ? 'ready' : 'available';
}

export function buildTree(S, nation) {
  const p = S.profile;
  nation = NATIONS[nation] ? nation : TANKS[p.selected]?.nation || NATION_IDS[0];
  const body = h('div.tt-body');
  const tip = h('div.tt-tip');
  const tabs = h('div.tt-nations', NATION_IDS.map((n) => h('button.tt-nation' + (n === nation ? '.on' : ''), { onclick: () => { nation = n; render(); } },
    flag(n), h('span', NATIONS[n].label))));
  const el = h('section.techtree', h('div.tt-bg'), h('div.tt-head', tabs, h('div.tt-legend',
    h('span.lg.owned', 'In garage'), h('span.lg.researched', 'Researched'), h('span.lg.ready', 'Can research'), h('span.lg.locked', 'Locked'))), body, tip);

  function render() {
    tip.classList.remove('on');
    for (const b of tabs.children) b.classList.toggle('on', b.textContent === NATIONS[nation].label);
    el.dataset.nation = nation;
    const L = layoutTree(nation);
    const W = Math.max(900, body.clientWidth || 1200), Hh = Math.max(300, body.clientHeight || 560);
    const cols = MAX_TIER, colW = (W - 40) / cols, nodeW = Math.min(176, colW - 24);
    const rowH = Math.max(70, Math.min(124, (Hh - 50) / Math.max(1, L.rows))), nodeH = Math.min(88, rowH - 16);
    const top = Math.max(38, (Hh - L.rows * rowH) / 2 + 10);
    const x = (d) => 20 + (d.tier - 1) * colW + (colW - nodeW) / 2, y = (d) => top + L.row[d.id] * rowH;
    const height = Math.max(Hh, top + L.rows * rowH + 10);
    const lines = L.edges.map(([a, b]) => {
      const A = TANKS[a], B = TANKS[b];
      const x1 = x(A) + nodeW, y1 = y(A) + nodeH / 2, x2 = x(B), y2 = y(B) + nodeH / 2, mx = x2 - 16;
      const st = nodeState(p, b);
      const cls = st === 'owned' || st === 'researched' ? 'done' : st === 'ready' ? 'ready' : st === 'available' ? 'avail' : 'locked';
      return `<path class="${cls}" d="M${x1} ${y1}H${mx}V${y2}H${x2 - 2}"/><path class="${cls} arrow" d="M${x2 - 8} ${y2 - 5}L${x2 - 1} ${y2}L${x2 - 8} ${y2 + 5}z"/>`;
    }).join('');
    const tiers = h('div.tt-tiers', [...Array(cols)].map((_, i) => h('div.tt-tier', { style: { left: (20 + i * colW) + 'px', width: colW + 'px' } }, roman(i + 1))));
    const cols_bg = [...Array(cols)].map((_, i) => h('div.tt-col' + (i % 2 ? '.odd' : ''), { style: { left: (20 + i * colW) + 'px', width: colW + 'px', height: height + 'px' } }));
    const canvas = h('div.tt-canvas', { style: { height: height + 'px' } }, cols_bg, svg(`<svg width="${W}" height="${height}">${lines}</svg>`, 'tt-lines'),
      L.defs.map((d) => node(S, d, { left: x(d), top: y(d), w: nodeW, h: nodeH }, tip, render)));
    clear(body).append(tiers, h('div.tt-scroll', canvas));
  }
  requestAnimationFrame(render);
  const onResize = () => render();
  window.addEventListener('resize', onResize);
  return { el, cleanup: () => window.removeEventListener('resize', onResize) };
}

function node(S, d, box, tip, rerender) {
  const p = S.profile, st = nodeState(p, d.id);
  const r = eco.researchInfo(p, d.id), b = eco.buyInfo(p, d.id);
  let foot;
  if (st === 'owned') foot = h('div.tn-foot.owned', svg(ICON.check), 'In garage');
  else if (st === 'researched') foot = h('div.tn-foot.buy' + (b.ok ? '' : '.short'), svg(ICON.credits), fmt(d.price));
  else foot = h('div.tn-foot.' + st, svg(st === 'locked' ? ICON.lock : ICON.xp), fmt(d.xp));
  const img = h('img.tn-img', { alt: '' });
  S.thumb(d).then((u) => { if (u) { img.src = u; img.classList.add('ok'); } });
  const el = h('button.tn.' + st + (d.id === p.selected ? '.sel' : ''), {
    'data-id': d.id,
    style: { left: box.left + 'px', top: box.top + 'px', width: box.w + 'px', height: box.h + 'px' },
    onclick: () => act(S, d, st, rerender),
    onmouseenter: () => showTip(S, tip, d, st, el),
    onmouseleave: () => tip.classList.remove('on'),
  },
  img,
  h('div.tn-top', h('span.tn-tier', roman(d.tier)), classIcon(d.cls, 12)),
  h('div.tn-name', d.short || d.name),
  foot);
  return el;
}

async function act(S, d, st, rerender) {
  const p = S.profile;
  if (st === 'owned') { selectTank(p, d.id); S.save(); S.showHangar(); return; }
  if (st === 'locked') { S.toast(`Research ${d.parents.map((x) => TANKS[x]?.name).join(' or ')} first.`, 'warn'); return; }
  if (st === 'researched') {
    const b = eco.buyInfo(p, d.id);
    if (!b.ok) { S.toast(`Not enough credits: ${fmt(b.missing)} more needed.`, 'warn'); return; }
    const ok = await S.confirm({ title: 'Purchase vehicle', ok: 'Buy', body: [
      h('div.dlg-tank', flag(d.nation), h('b', `${roman(d.tier)}  ${d.name}`), h('span', CLASS_LABEL[d.cls])),
      h('div.dlg-cost', h('span', 'Price'), h('b.credits', svg(ICON.credits), fmt(d.price))),
      h('div.dlg-cost', h('span', 'Credits after purchase'), h('b', fmt(p.credits - d.price))),
      h('p.dlg-note', 'The vehicle comes with a trained crew, its stock gun and a standard ammunition load.')] });
    if (ok) { eco.buy(p, d.id); S.sfx('buy'); S.save(); S.toast(`${d.name} has arrived in your garage.`, 'good'); rerender(); }
    return;
  }
  const r = eco.researchInfo(p, d.id);
  if (!r.ok) { S.toast(`Not enough experience: ${fmt(r.missing)} XP missing (about ${r.battles} battles).`, 'warn'); return; }
  const fromTank = Math.min(r.tankXp, r.cost);
  const ok = await S.confirm({ title: 'Research vehicle', ok: 'Research', body: [
    h('div.dlg-tank', flag(d.nation), h('b', `${roman(d.tier)}  ${d.name}`), h('span', CLASS_LABEL[d.cls])),
    h('div.dlg-cost', h('span', `${TANKS[r.from].name} XP`), h('b.xp', svg(ICON.xp), fmt(fromTank))),
    r.cost > fromTank ? h('div.dlg-cost', h('span', 'Free XP'), h('b.fxp', svg(ICON.freexp), fmt(r.cost - fromTank))) : null,
    h('div.dlg-cost.total', h('span', 'Research cost'), h('b.xp', svg(ICON.xp), fmt(r.cost)))] });
  if (ok) { eco.research(p, d.id); S.sfx('research'); S.save(); S.toast(`${d.name} researched.`, 'good'); rerender(); }
}

function showTip(S, tip, d, st, anchor) {
  const p = S.profile, r = eco.researchInfo(p, d.id), s = derive(d, 0);
  const lines = [];
  if (st === 'ready' || st === 'available') {
    lines.push(h('div.tip-row', h('span', 'Research cost'), h('b.xp', svg(ICON.xp), fmt(d.xp))));
    lines.push(h('div.tip-row', h('span', `${TANKS[r.from].short || TANKS[r.from].name} XP`), h('b', fmt(r.tankXp))));
    lines.push(h('div.tip-row', h('span', 'Free XP'), h('b.fxp', fmt(r.freeXp))));
    if (!r.ok) lines.push(h('div.tip-row.warn', h('span', 'Missing'), h('b', `${fmt(r.missing)} XP · ~${r.battles} battle${r.battles === 1 ? '' : 's'}`)));
  } else if (st === 'locked') lines.push(h('div.tip-row', h('span', 'Research first'), h('b', d.parents.map((x) => TANKS[x]?.short || x).join(' / '))));
  if (st !== 'owned') lines.push(h('div.tip-row', h('span', 'Price'), h('b', svg(ICON.credits), fmt(d.price))));
  else lines.push(h('div.tip-row', h('span', 'Vehicle XP'), h('b.xp', fmt(p.tanks[d.id].xp))));
  clear(tip).append(
    h('div.tip-head', flag(d.nation), h('span.tn-tier', roman(d.tier)), classIcon(d.cls, 13), h('b', d.name)),
    h('div.tip-cls', CLASS_LABEL[d.cls]),
    h('div.tip-stats', h('span', `${s.hp} HP`), h('span', `${s.pen} mm`), h('span', `${s.dmg} dmg`), h('span', `${d.speed} km/h`)),
    ...lines);
  const a = anchor.getBoundingClientRect(), W = window.innerWidth;
  tip.style.left = Math.min(W - 270, a.right + 8) + 'px';
  tip.style.top = Math.max(60, a.top - 6) + 'px';
  if (a.right + 270 > W) tip.style.left = (a.left - 268) + 'px';
  tip.classList.add('on');
}
