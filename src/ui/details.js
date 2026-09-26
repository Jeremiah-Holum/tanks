// Tank details: full specifications per gun, and the armour inspector.
import { h, clear, fmt, roman, ICON, svg, classIcon, flag } from './dom.js';
import { TANKS, TANK_LIST, NATIONS, NATION_IDS, CLASS_LABEL } from '../meta/roster.js';
import { derive } from './tankStats.js';
import { ArmorView } from './armorView.js';
import { THICKNESS_RAMP } from './armorGeo.js';

const CREW_LABEL = { commander: 'Commander', gunner: 'Gunner', driver: 'Driver', radioman: 'Radio Operator', loader: 'Loader' };

export function buildDetails(S, tankId) {
  let def = TANKS[tankId] || TANKS[S.profile.selected];
  let gi = S.profile.tanks[def.id]?.gun ?? 0;
  const specs = h('div.dt-specs');
  const head = h('div.dt-head');
  const stage = h('div.dt-stage');
  const hover = h('div.dt-hover');
  const modeBtns = h('div.seg', ['nominal', 'effective'].map((m) => h('button' + (m === 'nominal' ? '.on' : ''), { 'data-m': m, onclick: (e) => {
    av?.setMode(m); for (const b of modeBtns.children) b.classList.toggle('on', b === e.currentTarget);
  } }, m === 'nominal' ? 'Nominal' : 'Effective (line of sight)')));
  const views = h('div.seg.views', [['front', 'Front'], ['side', 'Side'], ['rear', 'Rear'], ['top', 'Top'], ['iso', '3/4']].map(([v, l]) => h('button', { onclick: () => av?.view(v) }, l)));
  const legend = h('div.dt-legend', h('span', 'mm'), h('div.ramp', { style: { background: `linear-gradient(90deg, ${THICKNESS_RAMP.map(([mm, c], i) => `#${c.toString(16).padStart(6, '0')} ${(i / (THICKNESS_RAMP.length - 1) * 100).toFixed(0)}%`).join(', ')})` } }),
    h('div.ticks', THICKNESS_RAMP.map(([mm]) => h('span', mm))));
  const inspector = h('div.dt-inspector.sf-panel', h('div.dt-ibar', h('h3.sf-h', 'Armour inspector'), modeBtns, views), stage, legend, hover,
    h('div.dt-hint', 'Drag to rotate · scroll to zoom · hover a plate'));
  const el = h('section.details', h('div.dt-bg'), head, h('div.dt-body', specs, inspector));

  let av = null;
  const renderHead = () => {
    const pick = h('select.dt-pick', { onchange: (e) => { def = TANKS[e.target.value]; gi = S.profile.tanks[def.id]?.gun ?? 0; renderAll(); av?.setTank(def, gi); } },
      NATION_IDS.map((n) => h('optgroup', { label: NATIONS[n].label }, TANK_LIST.filter((d) => d.nation === n).sort((a, b) => a.tier - b.tier)
        .map((d) => h('option', { value: d.id, selected: d.id === def.id }, `${roman(d.tier)} · ${d.name}`)))));
    clear(head).append(
      h('button.sf-btn.ghost', { onclick: () => S.showHangar() }, svg(ICON.arrowL), 'Garage'),
      flag(def.nation, 'flag dt-flag'),
      h('div.dt-tier', roman(def.tier)),
      h('div.dt-title', h('div.dt-name', def.name), h('div.dt-sub', classIcon(def.cls, 14), CLASS_LABEL[def.cls], h('span.dot', '•'), NATIONS[def.nation].label,
        h('span.dot', '•'), def.crew.map((c) => CREW_LABEL[c] || c).join(', '))),
      h('div.dt-spacer'), h('label.dt-picklabel', 'Vehicle', pick));
  };
  const renderSpecs = () => {
    const s = derive(def, gi), g = s.gun;
    const row = (l, v, u = '') => h('div.sp-row', h('span', l), h('b', v, u ? h('small', ' ' + u) : null));
    const shellRows = g.shells.map((sh) => row(`${sh.type}${sh.gold ? ' (premium)' : ''}`, `${sh.pen} / ${sh.dmg}`, 'mm / HP'));
    clear(specs).append(
      h('div.dt-guns', def.guns.map((gun, i) => h('button.dt-gun' + (i === gi ? '.on' : ''), { onclick: () => { gi = i; renderSpecs(); av?.setTank(def, gi); } },
        h('b', gun.name), h('small', i === 0 ? 'Stock' : S.profile.tanks[def.id]?.guns?.includes(i) ? 'Researched' : `${fmt(gun.xp)} XP`)))),
      h('div.sp-group', h('h3.sf-h', svg(ICON.gun), 'Firepower'),
        row('Penetration / damage', ''), ...shellRows.map((r) => (r.classList.add('sub'), r)),
        row('Rate of fire', s.rof.toFixed(2), 'rounds/min'), row('Damage per minute', fmt(s.dpm), 'HP/min'),
        row('Reload time', g.reload.toFixed(2), 's'), row('Aiming time', g.aim.toFixed(1), 's'), row('Dispersion at 100 m', g.disp.toFixed(2), 'm'),
        row('Shell velocity', fmt(s.v), 'm/s'), row('Gun depression / elevation', `${g.dep}° / +${g.elev}°`), row('Ammunition capacity', g.ammo, 'rounds')),
      h('div.sp-group', h('h3.sf-h', svg(ICON.shield), 'Survivability'),
        row('Hit points', fmt(def.hp), 'HP'), row('Hull armour', `${def.hull.upper.t} / ${def.hull.side.t} / ${def.hull.rear.t}`, 'mm'),
        row('Upper glacis', `${def.hull.upper.t} mm at ${def.hull.upper.a}°`, `≈ ${s.hullFeff} mm eff.`),
        row('Turret armour', def.turret.shape === 'open' ? `${def.turret.front.t} / ${def.turret.side.t} / open` : `${def.turret.front.t} / ${def.turret.side.t} / ${def.turret.rear.t}`, 'mm'),
        row('Crew', def.crew.length)),
      h('div.sp-group', h('h3.sf-h', svg(ICON.engine), 'Mobility'),
        row('Weight', s.mass.toFixed(1), 't'), row('Engine power', fmt(s.power), 'hp'), row('Specific power', s.pw.toFixed(1), 'hp/t'),
        row('Top speed / reverse', `${def.speed} / ${def.reverse}`, 'km/h'), row('Hull traverse', def.hullTraverse, '°/s'),
        row('Turret traverse', def.turret.traverse ? `${def.turretTraverse} (${def.turret.traverse[0]}° / +${def.turret.traverse[1]}°)` : def.turretTraverse, '°/s'),
        row('Terrain resistance', def.terrain.map((x) => x.toFixed(1)).join(' / '))),
      h('div.sp-group', h('h3.sf-h', svg(ICON.eye), 'Spotting'),
        row('View range', def.view, 'm'), row('Camouflage stationary / moving', `${Math.round(def.camo.still * 100)} / ${Math.round(def.camo.moving * 100)}`, '%'),
        row('Camouflage kept after firing', Math.round(def.camo.fire * 100), '%')));
  };
  const renderAll = () => { renderHead(); renderSpecs(); };
  renderAll();
  requestAnimationFrame(() => {
    try {
      av = new ArmorView(stage, def, { onHover: (hv) => {
        if (!hv) { hover.classList.remove('on'); return; }
        hover.classList.add('on');
        hover.style.left = Math.min(stage.clientWidth - 200, hv.x + 16) + 'px'; hover.style.top = (hv.y + 50) + 'px';
        clear(hover).append(h('b', hv.name), h('div', h('span', 'Nominal'), h('em', `${hv.t} mm`)),
          hv.spaced ? h('div', h('span', 'Spaced armour'), h('em', 'absorbs')) : h('div', h('span', `Effective (${hv.angle.toFixed(0)}°)`), h('em', `${Math.round(hv.eff)} mm`)),
          hv.angle > 70 && !hv.spaced ? h('div.ric', 'Ricochet angle') : null);
      } });
      av.setTank(def, gi);
    } catch (e) { stage.append(h('div.hg-nogl', 'Armour inspector needs WebGL')); console.warn(e); }
  });
  return { el, cleanup: () => av?.dispose() };
}
