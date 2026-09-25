// Battle loading screen: map name and blurb, both team lists, a tip and a progress bar.
import { h, clear, roman, classIcon, flag } from './dom.js';
import { MAPS } from '../meta/roster.js';
import { makeRng } from '../meta/rng.js';

export const TIPS = [
  'Angle your hull about 30° to the enemy: the effective thickness of your front plate goes up, and shells may ricochet.',
  'Wait for the aiming circle to shrink before firing. A fully aimed shot is far more likely to hit a weak spot.',
  'Right-click an enemy to lock your aim on it. Right-click again to release.',
  'Bushes hide you only while you have not fired. Stay 15 m behind a bush and your shots will not reveal you as easily.',
  'Tracks are spaced armour: a shell hitting them loses penetration, but the track may break and immobilise you.',
  'Hull-down: hide your hull behind a ridge and show only your turret. Heavy turrets bounce shells all day.',
  'A shell hitting armour at more than 70° always ricochets, unless its calibre is more than three times the armour.',
  'The sixth sense lamp lights up three seconds after you have been spotted. Move!',
  'Light tanks win games by spotting. Your team can only shoot what someone can see.',
  'HE shells deal damage even without penetrating, and wreck open-topped tank destroyers.',
  'Premium rounds penetrate more armour but cost far more credits. Keep a few for heavy targets.',
  'Capturing the enemy base wins the battle. Any damage to a capturing tank resets its points.',
  'Shoot the lower front plate, the cupola or the side of heavily armoured tanks. Their front turret is rarely the answer.',
  'Your view range and camouflage decide who shoots first. Tank destroyers rely on staying unseen.',
  'Use your repair kit on a broken track right away when enemies are aiming at you. Every second counts.',
  'Crew members get injured by penetrating hits. A first aid kit brings them back into action.',
  'Staying alive matters: a tank that survives keeps spotting, blocking and dealing damage.',
];

const THEME = {
  summer: ['#2e3a20', '#546b34', '#a7b56a'], autumn: ['#3a2c19', '#7a5a2a', '#c99a55'],
  winter: ['#2a3440', '#5f7486', '#d6e2ea'], desert: ['#4a3a22', '#8c6f3e', '#e0c48a'],
};

// Procedural contour-line "map" art.
function contours(seed, [c0, c1, c2]) {
  const rng = makeRng(seed);
  const hills = [...Array(7)].map(() => ({ x: rng() * 1600, y: rng() * 900, r: 120 + rng() * 260 }));
  let paths = '';
  for (const hl of hills) for (let k = 1; k <= 6; k++) {
    const r = hl.r * k / 6; let d = '';
    for (let a = 0; a <= 64; a++) {
      const t = a / 64 * Math.PI * 2, w = 1 + 0.18 * Math.sin(t * 3 + hl.x) + 0.1 * Math.sin(t * 5 + hl.y);
      d += (a ? 'L' : 'M') + (hl.x + Math.cos(t) * r * w).toFixed(1) + ' ' + (hl.y + Math.sin(t) * r * w * 0.8).toFixed(1);
    }
    paths += `<path d="${d}Z" fill="none" stroke="${c2}" stroke-opacity="${0.05 + k * 0.02}" stroke-width="1.2"/>`;
  }
  const roads = [...Array(3)].map(() => { let x = rng() * 1600, y = 0, d = `M${x} ${y}`; for (let i = 0; i < 6; i++) { x += (rng() - 0.5) * 400; y += 160; d += ` Q${x + (rng() - 0.5) * 200} ${y - 80} ${x} ${y}`; } return `<path d="${d}" stroke="${c2}" stroke-opacity=".12" stroke-width="5" fill="none" stroke-dasharray="14 10"/>`; }).join('');
  return `<svg viewBox="0 0 1600 900" preserveAspectRatio="xMidYMid slice"><defs><radialGradient id="lg" cx="50%" cy="45%" r="75%"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c0}"/></radialGradient></defs><rect width="1600" height="900" fill="url(#lg)"/>${paths}${roads}</svg>`;
}

export function buildLoading(S, battle, mapMeta) {
  const meta = battle.meta || {};
  const map = mapMeta || MAPS.find((m) => m.id === (battle.mapId || meta.mapId)) || { name: meta.mapName || 'Unknown', blurb: meta.blurb || '', theme: meta.theme || 'summer' };
  const pal = THEME[map.theme] || THEME.summer;
  const pt = meta.playerTeam ?? battle.teams.findIndex((t) => t.some((e) => e.player));
  const ally = battle.teams[pt] || battle.teams[0], enemy = battle.teams[1 - pt] || battle.teams[1];
  const tip = TIPS[(battle.seed || 0) % TIPS.length];
  const row = (e) => h('div.ld-row' + (e.player ? '.me' : ''),
    flag(e.def.nation, 'flag ld-flag'), h('span.ld-name', e.name), h('span.ld-tank', e.def.short || e.def.name),
    h('span.ld-tier', roman(e.def.tier)), classIcon(e.def.cls, 13));
  const fill = h('i'), label = h('span.ld-plabel', 'Preparing battle…'), pctEl = h('span.ld-pct', '0%');
  const el = h('section.loading',
    h('div.ld-art', { html: contours((battle.seed || 1) + map.name.length, pal) }),
    h('div.ld-shade'),
    h('div.ld-top',
      h('div.ld-mode', `${meta.modeLabel || 'Standard Battle'} · ${ally.length} vs ${enemy.length}`),
      h('h1.ld-map', map.name),
      h('p.ld-blurb', map.blurb),
      h('div.ld-cond', `Tiers ${roman(meta.tiers?.[0] ?? 1)}–${roman(meta.tiers?.[1] ?? 1)} · Win: destroy all enemies or capture their base · 15:00`)),
    h('div.ld-teams',
      h('div.ld-team.ally', h('h3', h('span', 'Your team')), ally.map((e) => row(e, 0))),
      h('div.ld-vs', 'VS'),
      h('div.ld-team.enemy', h('h3', h('span', 'Enemy team')), enemy.map((e) => row(e, 1)))),
    h('div.ld-bottom',
      h('div.ld-tip', h('b', 'Tip'), h('span', tip)),
      h('div.ld-progress', h('div.ld-bar', fill), h('div.ld-plabels', label, pctEl))));
  const progress = (p, text) => {
    fill.style.width = Math.round(Math.max(0, Math.min(1, p)) * 100) + '%';
    pctEl.textContent = Math.round(p * 100) + '%';
    if (text) label.textContent = text;
  };
  return { el, progress };
}
