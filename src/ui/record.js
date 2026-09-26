// Service record: rank, career statistics, medals, per-vehicle table and recent battles.
import { h, fmt, signed, roman, pct, ICON, svg, classIcon, flag, masteryIcon, medalIcon, rankIcon } from './dom.js';
import { TANKS } from '../meta/roster.js';
import { rankOf } from '../meta/profile.js';
import { MEDALS } from '../meta/results.js';

const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };

export function buildRecord(S) {
  const p = S.profile, st = p.stats, r = rankOf(p), n = Math.max(1, st.battles);
  const stat = (label, v, sub) => h('div.sr-stat', h('b', v), h('span', label), sub ? h('small', sub) : null);
  const vehicles = Object.entries(p.tanks).filter(([id, t]) => TANKS[id] && (t.owned || t.battles)).sort((a, b) => b[1].battles - a[1].battles);
  const el = h('section.record', h('div.tt-bg'),
    h('div.sr-wrap',
      h('div.sr-left',
        h('div.sr-id.sf-panel',
          rankIcon(r.index, 64),
          h('div.sr-who', h('div.sr-name', p.name), h('div.sr-rank', r.name),
            h('div.sr-rankbar', h('i', { style: { width: (r.progress * 100) + '%' } })),
            h('small', r.next ? `Next rank: ${r.next}` : 'Highest rank achieved'))),
        h('div.sr-stats.sf-panel',
          stat('Battles', fmt(st.battles)), stat('Victories', st.battles ? pct(st.wins / n) : '—', `${fmt(st.wins)} W · ${fmt(st.losses)} L · ${fmt(st.draws)} D`),
          stat('Survived', st.battles ? pct(st.survived / n) : '—'), stat('Avg. damage', fmt(st.dmg / n)),
          stat('Avg. XP', fmt(st.xp / n)), stat('Hit ratio', st.shots ? pct(st.hits / st.shots) : '—'),
          stat('Vehicles destroyed', fmt(st.kills), `${(st.kills / n).toFixed(2)} per battle`), stat('Avg. assisted', fmt(st.assist / n)),
          stat('Max damage', fmt(st.maxDmg)), stat('Max kills', st.maxKills), stat('Max XP', fmt(st.maxXp)), stat('Credits earned', fmt(st.credits))),
        h('div.sr-medals.sf-panel', h('h3.sf-h', 'Medals'),
          h('div.sr-medal-grid', MEDALS.map((m) => { const c = st.medals[m.id] || 0;
            return h('div.sr-medal' + (c ? '' : '.none'), { title: `${m.name}: ${m.desc}` }, medalIcon(m.id, 52), c ? h('span.cnt', '×' + c) : null, h('small', m.name)); })))),
      h('div.sr-right',
        h('div.sr-vehicles.sf-panel', h('h3.sf-h', 'Vehicles'),
          h('div.sr-vrow.head', h('span.v', 'Vehicle'), h('span', 'Battles'), h('span', 'Victories'), h('span', 'Avg. dmg'), h('span.m', 'Mastery')),
          h('div.sr-vlist', vehicles.map(([id, t]) => { const d = TANKS[id];
            return h('div.sr-vrow', h('span.v', flag(d.nation), h('i', roman(d.tier)), classIcon(d.cls, 12), d.name),
              h('span', t.battles), h('span', t.battles ? pct(t.wins / t.battles) : '—'), h('span', t.battles ? fmt((t.dmg || 0) / t.battles) : '—'),
              h('span.m', masteryIcon(t.mastery || 0, 22))); }))),
        h('div.sr-history.sf-panel', h('h3.sf-h', 'Recent battles'),
          p.history.length ? h('div.sr-hlist', p.history.slice(0, 12).map((b) => { const d = TANKS[b.tankId];
            return h('div.sr-hrow.' + b.result, h('span.res', b.result === 'victory' ? 'Victory' : b.result === 'defeat' ? 'Defeat' : 'Draw'),
              h('span.tank', d ? d.short || d.name : b.tankId), h('span.map', b.mapName),
              h('span', svg(ICON.target), fmt(b.dmg)), h('span', svg(ICON.skull), b.kills), h('span.xp', svg(ICON.xp), fmt(b.xp)),
              h('span.cr' + (b.credits < 0 ? '.neg' : ''), signed(b.credits)), h('span.when', ago(b.time))); }))
            : h('div.rs-nomedal', 'No battles yet. The front is waiting, Commander.')))));
  return { el };
}
