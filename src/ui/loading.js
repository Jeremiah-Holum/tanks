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
  const mini = h('div.ld-mini', { html: contours((battle.seed || 3) * 7, pal) }, h('span.ld-mini-l', 'Awaiting recon…'));
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
      h('div.ld-mid', mini, h('div.ld-vs', 'VS')),
      h('div.ld-team.enemy', h('h3', h('span', 'Enemy team')), enemy.map((e) => row(e, 1)))),
    h('div.ld-bottom',
      h('div.ld-tip', h('b', 'Tip'), h('span', tip)),
      h('div.ld-progress', h('div.ld-bar', fill), h('div.ld-plabels', label, pctEl))));
  const progress = (p, text) => {
    fill.style.width = Math.round(Math.max(0, Math.min(1, p)) * 100) + '%';
    pctEl.textContent = Math.round(p * 100) + '%';
    if (text) label.textContent = text;
  };
  // Once INTEGRATION has loaded the MapData: a hill-shaded top-down map with both bases (own base at the bottom).
  const setMap = (m) => {
    try {
      clear(mini).append(renderMinimap(m, pt), h('span.ld-mini-l', m.name || map.name));
    } catch (e) { console.warn('[ui] minimap', e); }
  };
  return { el, progress, setMap };
}

// Ground colours by GROUND id (GRASS, DIRT, ROAD, SAND, ROCK, MUD, SHALLOW, DEEP, FIELD, SNOW).
const GROUND_RGB = [[92, 116, 58], [122, 102, 70], [150, 138, 112], [196, 176, 128], [128, 124, 116], [92, 78, 56], [70, 104, 118], [44, 70, 92], [170, 150, 80], [226, 232, 236]];
export function renderMinimap(m, playerTeam = 0, px = 256) {
  const c = document.createElement('canvas'); c.width = c.height = px; c.className = 'ld-minimap';
  const ctx = c.getContext('2d'), img = ctx.createImageData(px, px), res = m.res, hts = m.heights;
  const own = m.bases?.find((b) => b.team === playerTeam);
  const upsideDown = own ? own.z < m.size / 2 : false; // rotate 180° so our base is at the bottom
  for (let y = 0; y < px; y++) for (let x = 0; x < px; x++) {
    let i = Math.min(res - 2, Math.floor(x / px * (res - 1))), j = Math.min(res - 2, Math.floor(y / px * (res - 1)));
    if (upsideDown) { i = res - 2 - i; j = res - 2 - j; }
    const k = j * res + i, hgt = hts[k];
    const dx = hts[k + 1] - hgt, dz = hts[k + res] - hgt;
    const shade = Math.max(0.45, Math.min(1.35, 1 + (upsideDown ? 1 : -1) * (dx + dz) * 0.18));
    const g = GROUND_RGB[m.ground?.[k] ?? 0] || GROUND_RGB[0];
    let [r, gg, b] = g;
    if (m.water && hgt < m.water.level) { r = 52; gg = 86; b = 108; }
    const o = (y * px + x) * 4;
    img.data[o] = r * shade; img.data[o + 1] = gg * shade; img.data[o + 2] = b * shade; img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const sx = (x) => (upsideDown ? m.size - x : x) / m.size * px, sz = (z) => (upsideDown ? m.size - z : z) / m.size * px;
  ctx.fillStyle = 'rgba(40,40,30,0.55)';
  for (const o of m.objects || []) if (/house|building|church|barn|station|ruin|wall/.test(o.kind)) ctx.fillRect(sx(o.x) - 1.5, sz(o.z) - 1.5, 3, 3);
  for (const b of m.bases || []) {
    const own = b.team === playerTeam;
    ctx.beginPath(); ctx.arc(sx(b.x), sz(b.z), b.r / m.size * px, 0, 7);
    ctx.fillStyle = own ? 'rgba(143,194,90,0.3)' : 'rgba(216,84,58,0.3)'; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = own ? '#8fc25a' : '#ff7a5c'; ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 1;
  for (let k = 1; k < 10; k++) { ctx.beginPath(); ctx.moveTo(k * px / 10, 0); ctx.lineTo(k * px / 10, px); ctx.moveTo(0, k * px / 10); ctx.lineTo(px, k * px / 10); ctx.stroke(); }
  return c;
}
