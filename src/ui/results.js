// Post-battle results: banner, personal stats, XP / credits breakdown, mastery & medals, team score.
import { h, clear, fmt, signed, roman, ICON, svg, classIcon, flag, masteryIcon, medalIcon } from './dom.js';
import { TANKS, CLASS_LABEL, childrenOf } from '../meta/roster.js';
import { researchInfo } from '../meta/economy.js';
import { masteryThresholds, MASTERY_NAMES } from '../meta/economy.js';

const LINE_LABEL = { participation: 'Participation', damage: 'Damage dealt', assist: 'Assisted damage', kills: 'Vehicles destroyed',
  spotting: 'Vehicles spotted', capture: 'Base capture', defence: 'Base defence', survival: 'Survival', blocked: 'Damage blocked' };
const REASON = { destroyed: 'All enemy vehicles destroyed', captured: 'Base captured', time: 'Time is up', allDead: 'All vehicles destroyed' };

export function buildResults(S, r) {
  const won = r.result === 'victory', lost = r.result === 'defeat';
  const def = TANKS[r.tankId];
  const mins = Math.floor(r.duration / 60), secs = String(r.duration % 60).padStart(2, '0');
  const reason = lost ? (r.reason === 'captured' ? 'Your base was captured' : r.reason === 'destroyed' ? 'All allied vehicles destroyed' : REASON[r.reason] || '') : REASON[r.reason] || r.reason;
  const tabs = h('div.rs-tabs');
  const body = h('div.rs-body');
  const el = h('section.results.' + r.result,
    h('div.rs-bg'),
    h('header.rs-banner',
      h('div.rs-ribbon', h('span.rs-title', r.result === 'victory' ? 'Victory!' : r.result === 'defeat' ? 'Defeat' : 'Draw')),
      h('div.rs-sub', h('span', reason), h('span.dot', '•'), h('span', r.mapName), h('span.dot', '•'), h('span', `${mins}:${secs}`), h('span.dot', '•'),
        h('span', `${r.size} vs ${r.size}`), h('span.dot', '•'), h('span', `Survivors ${r.alive[0]} : ${r.alive[1]}`))),
    tabs, body,
    h('footer.rs-foot',
      h('button.sf-btn.ghost', { onclick: () => S.showRecord() }, svg(ICON.record), 'Service record'),
      h('button.sf-btn.primary.rs-garage', { onclick: () => S.showHangar() }, svg(ICON.garage), 'To garage')));
  const views = { summary: () => summary(S, r, def), team: () => teamScore(r) };
  let cur = 'summary';
  const render = () => {
    clear(tabs).append(...[['summary', 'Personal result'], ['team', 'Team score']].map(([k, l]) => h('button.rs-tab' + (k === cur ? '.on' : ''), { onclick: () => { cur = k; render(); } }, l)));
    clear(body).append(views[cur]());
  };
  render();
  return { el };
}

function tile(icon, label, value, sub, cls = '') {
  return h('div.rs-tile' + (cls ? '.' + cls : ''), svg(ICON[icon]), h('b', value), h('span', label), sub ? h('small', sub) : null);
}

function summary(S, r, def) {
  const s = r.stats;
  const img = h('img.rs-img', { alt: '' });
  S.thumb(def).then((u) => { if (u) { img.src = u; img.classList.add('ok'); } });
  const personal = h('div.rs-col.rs-personal.sf-panel',
    h('div.rs-tank', flag(def.nation, 'flag rs-flag'), img,
      h('div.rs-tank-name', h('span.tier', roman(def.tier)), classIcon(def.cls, 14), h('b', def.name)),
      h('div.rs-state' + (r.survived ? '.alive' : '.dead'), r.survived ? `Survived · ${fmt(r.hpLeft)} / ${fmt(r.maxHp)} HP` : 'Destroyed')),
    h('div.rs-tiles',
      tile('target', 'Damage', fmt(s.dmg), null, 'big'),
      tile('eye', 'Assisted', fmt(s.assist)),
      tile('shield', 'Blocked', fmt(s.blocked)),
      tile('skull', 'Destroyed', s.kills),
      tile('eye', 'Spotted', s.spotted),
      tile('gun', 'Hits / shots', `${s.hits}/${s.shots}`, s.shots ? `${Math.round(s.hits / s.shots * 100)}% accuracy` : null),
      tile('target', 'Penetrations', s.pens),
      tile('battle', 'Capture / defence', `${s.capture}/${s.defended}`),
      tile('shield', 'Received', fmt(s.received)),
      tile('clock', 'Battle time', `${Math.floor(r.duration / 60)}:${String(r.duration % 60).padStart(2, '0')}`)));

  const xl = r.xp.lines.map((l) => h('div.rs-line', h('span', LINE_LABEL[l.key] || l.key), h('b.xp', fmt(l.xp))));
  const cl = r.credits.lines.map((l) => h('div.rs-line', h('span', LINE_LABEL[l.key] || l.key), h('b', fmt(l.cr))));
  const earn = h('div.rs-col.rs-earn.sf-panel',
    h('div.rs-ledger',
      h('h3.sf-h', svg(ICON.xp), 'Experience'),
      ...xl,
      r.xp.win ? h('div.rs-line.bonus', h('span', 'Victory bonus ×1.5'), h('b.xp', '+' + fmt(r.xp.win))) : null,
      r.xp.firstWin ? h('div.rs-line.bonus', h('span', 'First victory of the day ×2'), h('b.xp', '+' + fmt(r.xp.firstWin))) : null,
      h('div.rs-line.total', h('span', 'Total XP'), h('b.xp', svg(ICON.xp), fmt(r.xp.total))),
      h('div.rs-line.sub', h('span', 'Free XP (5%)'), h('b.fxp', svg(ICON.freexp), '+' + fmt(r.xp.free)))),
    h('div.rs-ledger',
      h('h3.sf-h', svg(ICON.credits), 'Credits'),
      h('div.rs-line', h('span', 'Earned in battle'), h('b', fmt(r.credits.perf))),
      r.credits.win ? h('div.rs-line.bonus', h('span', 'Victory bonus'), h('b', '+' + fmt(r.credits.win))) : null,
      h('div.rs-line.neg', h('span', 'Repairs'), h('b', r.credits.repair ? '−' + fmt(r.credits.repair) : '0')),
      h('div.rs-line.neg', h('span', 'Ammunition'), h('b', r.credits.ammo ? '−' + fmt(r.credits.ammo) : '0')),
      h('div.rs-line.neg', h('span', 'Consumables'), h('b', r.credits.consumables ? '−' + fmt(r.credits.consumables) : '0')),
      h('div.rs-line.total' + (r.credits.net < 0 ? '.loss' : ''), h('span', 'Net income'), h('b', svg(ICON.credits), signed(r.credits.net)))));

  const th = masteryThresholds(r.tier);
  const nextM = r.mastery < 4 ? th[r.mastery + 1] : null;
  const ach = h('div.rs-col.rs-ach.sf-panel',
    h('h3.sf-h', 'Mastery badge'),
    h('div.rs-mastery' + (r.mastery ? '.got' : ''), masteryIcon(r.mastery, 64),
      h('div', h('b', r.mastery ? MASTERY_NAMES[r.mastery] : 'No badge'),
        h('small', r.mastery ? (r.masteryNew ? 'New best on this vehicle!' : `Base XP ${fmt(r.xp.base)}`) : `Base XP ${fmt(r.xp.base)} of ${fmt(th[1])} needed`),
        nextM ? h('small', `${MASTERY_NAMES[r.mastery + 1]}: ${fmt(nextM)} base XP`) : null)),
    h('h3.sf-h', 'Medals'),
    r.medals.length ? h('div.rs-medals', r.medals.map((m) => h('div.rs-medal', { title: m.desc }, medalIcon(m.id, 58), h('b', m.name), h('small', m.desc))))
      : h('div.rs-nomedal', 'No medals this battle. Top Gun needs 6 kills; Steel Wall, 1.5× your HP blocked.'),
    progress(S, r));
  return h('div.rs-summary', personal, earn, ach);
}

function teamScore(r) {
  const table = (rows, title, cls) => h('div.rs-team.' + cls,
    h('h3', title),
    h('div.rs-trow.head', h('span.n', 'Player'), h('span.t', 'Vehicle'), h('span.d', 'Damage'), h('span.k', 'Kills'), h('span.x', 'XP')),
    rows.map((x) => h('div.rs-trow' + (x.player ? '.me' : '') + (x.alive ? '' : '.dead'),
      h('span.n', x.alive ? null : svg(ICON.skull), x.name),
      h('span.t', classIcon(x.cls, 12), h('i', roman(x.tier)), x.short),
      h('span.d', fmt(x.dmg)), h('span.k', x.kills), h('span.x', fmt(x.xp)))));
  return h('div.rs-teams', table(r.teams[0], 'Your team', 'ally'), table(r.teams[1], 'Enemy team', 'enemy'));
}

// Research progress towards the next vehicles in this tank's line.
function progress(S, r) {
  const p = S.profile;
  const next = childrenOf(r.tankId).filter((d) => !p.researched.includes(d.id)).slice(0, 2);
  if (!next.length) return null;
  return h('div.rs-next', h('h3.sf-h', 'Research progress'), next.map((d) => {
    const ri = researchInfo(p, d.id), have = Math.min(d.xp, (p.tanks[r.tankId]?.xp || 0) + p.freeXp), f = have / Math.max(1, d.xp);
    return h('div.rs-nrow' + (ri.ok ? '.ok' : ''),
      h('div.rs-ntop', h('span.tier', roman(d.tier)), classIcon(d.cls, 12), h('b', d.name),
        h('span.rs-nval', ri.ok ? 'Ready to research!' : `${fmt(have)} / ${fmt(d.xp)} XP`)),
      h('div.rs-nbar', h('i', { style: { width: (f * 100).toFixed(1) + '%' } })));
  }));
}
