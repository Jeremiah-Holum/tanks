// Small DOM helpers, number formatting and the inline-SVG icon set shared by every screen.
import { ROMAN } from '../meta/roster.js';

// h('div.cls1.cls2', {attrs|on*}, ...children)
export function h(tag, attrs, ...kids) {
  const [name, ...cls] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (cls.length) el.className = cls.join(' ');
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) { kids.unshift(attrs); attrs = null; }
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'class') el.className += (el.className ? ' ' : '') + v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, kids);
  return el;
}
function append(el, kids) {
  for (const k of kids) {
    if (k == null || k === false) continue;
    if (Array.isArray(k)) append(el, k);
    else el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}
export const svg = (markup, cls = 'ico') => { const s = document.createElement('span'); s.className = cls; s.innerHTML = markup; return s; };
export const fmt = (n) => Math.round(n || 0).toLocaleString('en-US');
export const signed = (n) => (n > 0 ? '+' : n < 0 ? '−' : '') + fmt(Math.abs(n));
export const roman = (t) => ROMAN[t] || String(t);
export const pct = (x) => (x * 100).toFixed(x < 0.1 && x > 0 ? 1 : 0) + '%';
export const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };

// ------------------------------------------------------------------ icons (viewBox 0 0 24 24)
const S = (inner, vb = '0 0 24 24') => `<svg viewBox="${vb}" aria-hidden="true">${inner}</svg>`;
export const ICON = {
  credits: S('<circle cx="12" cy="12" r="9.5" fill="#cfd3d6" stroke="#6d757b" stroke-width="1.5"/><circle cx="12" cy="12" r="6.6" fill="none" stroke="#8b9399" stroke-width="1"/><path d="M12 7.2l1.45 2.95 3.25.47-2.35 2.3.55 3.24L12 14.63 9.1 16.16l.55-3.24-2.35-2.3 3.25-.47z" fill="#737b82"/>'),
  xp: S('<path d="M12 2.5l2.6 5.6 6.1.7-4.5 4.2 1.2 6-5.4-3-5.4 3 1.2-6L3.3 8.8l6.1-.7z" fill="#f2c14e" stroke="#9b6d12" stroke-width="1"/><text x="12" y="14.6" font-size="6.2" font-family="Barlow Condensed,Arial" font-weight="700" text-anchor="middle" fill="#5a3d05">XP</text>'),
  freexp: S('<circle cx="12" cy="12" r="9.6" fill="#1d5f5a" stroke="#62d2c0" stroke-width="1.4"/><path d="M12 5l1.9 4.1 4.4.5-3.3 3 .9 4.4L12 14.8 8.1 17l.9-4.4-3.3-3 4.4-.5z" fill="#8ff2de"/>'),
  gold: S('<circle cx="12" cy="12" r="9.5" fill="#f5c542" stroke="#9a6c0f" stroke-width="1.5"/><circle cx="12" cy="12" r="5" fill="none" stroke="#9a6c0f" stroke-width="1.4"/>'),
  gear: S('<path fill="currentColor" d="M19.4 13.5a7.6 7.6 0 000-3l2-1.6-2-3.4-2.4 1a7.4 7.4 0 00-2.6-1.5L14 2.5h-4l-.4 2.5A7.4 7.4 0 007 6.5l-2.4-1-2 3.4 2 1.6a7.6 7.6 0 000 3l-2 1.6 2 3.4 2.4-1a7.4 7.4 0 002.6 1.5l.4 2.5h4l.4-2.5a7.4 7.4 0 002.6-1.5l2.4 1 2-3.4zM12 15.5a3.5 3.5 0 110-7 3.5 3.5 0 010 7z"/>'),
  garage: S('<path fill="currentColor" d="M12 3L2 8v13h3v-9h14v9h3V8zM7 14h10v2H7zm0 3h10v2H7z"/>'),
  tree: S('<path fill="none" stroke="currentColor" stroke-width="2" d="M4 5h5v4H4zM15 3h5v4h-5zM15 11h5v4h-5zM15 18h5v4h-5zM9 7h3v12h3M12 13h3M12 5h3"/>'),
  record: S('<path fill="currentColor" d="M5 3h11l3 3v15H5zm2 4v2h10V7zm0 4v2h10v-2zm0 4v2h6v-2z"/>'),
  close: S('<path stroke="currentColor" stroke-width="2.4" d="M5 5l14 14M19 5L5 19"/>'),
  lock: S('<path fill="currentColor" d="M7 10V7a5 5 0 0110 0v3h1.5v11h-13V10zm2 0h6V7a3 3 0 00-6 0z"/>'),
  check: S('<path fill="none" stroke="currentColor" stroke-width="2.6" d="M4 12.5l5 5L20 6.5"/>'),
  arrowL: S('<path fill="currentColor" d="M15 4l-8 8 8 8 1.6-1.6L10.2 12l6.4-6.4z"/>'),
  arrowR: S('<path fill="currentColor" d="M9 4l8 8-8 8-1.6-1.6 6.4-6.4-6.4-6.4z"/>'),
  eye: S('<path fill="currentColor" d="M12 5C6 5 2 12 2 12s4 7 10 7 10-7 10-7-4-7-10-7zm0 11a4 4 0 110-8 4 4 0 010 8z"/>'),
  shield: S('<path fill="currentColor" d="M12 2l8 3v6c0 5.3-3.4 9.5-8 11-4.6-1.5-8-5.7-8-11V5z"/>'),
  gun: S('<path fill="currentColor" d="M2 13h11v-2H2zm11-3h3l1-2h5v8h-5l-1-2h-3z"/>'),
  engine: S('<path fill="currentColor" d="M6 8h3V6h6v2h2l2 3h2v5h-2l-2 3H8l-2-3H3v-6h3z"/>'),
  target: S('<circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="2" fill="currentColor"/><path stroke="currentColor" stroke-width="2" d="M12 1v5M12 18v5M1 12h5M18 12h5"/>'),
  skull: S('<path fill="currentColor" d="M12 2a8 8 0 00-8 8c0 3 1.5 4.8 3 5.6V19h2v-2h2v2h2v-2h2v2h2v-3.4c1.5-.8 3-2.6 3-5.6a8 8 0 00-8-8zM8.5 13a2 2 0 110-4 2 2 0 010 4zm7 0a2 2 0 110-4 2 2 0 010 4z"/>'),
  clock: S('<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path stroke="currentColor" stroke-width="2" fill="none" d="M12 7v5l3.5 2"/>'),
  info: S('<circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path fill="currentColor" d="M11 10h2v7h-2zm0-4h2v2h-2z"/>'),
  plus: S('<path stroke="currentColor" stroke-width="2.6" d="M12 4v16M4 12h16"/>'),
  minus: S('<path stroke="currentColor" stroke-width="2.6" d="M4 12h16"/>'),
  repair: S('<path fill="currentColor" d="M21 6.5l-3.5 3.5-2.5-.5-.5-2.5L18 3.5a5.5 5.5 0 00-7 7L3 18.5 5.5 21l8-8a5.5 5.5 0 007.5-6.5z"/>'),
  medkit: S('<rect x="3" y="6" width="18" height="14" rx="2" fill="currentColor"/><path d="M9 6V4h6v2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M10.5 9h3v3h3v3h-3v3h-3v-3h-3v-3h3z" fill="#1a1d1b"/>'),
  extinguisher: S('<path fill="currentColor" d="M9 8h6v13H9zM10 4h4v3h-4zM14 5h4l2-2v4l-2-1h-4z"/><path fill="#1a1d1b" d="M10 12h4v2h-4z"/>'),
  battle: S('<path fill="currentColor" d="M3 17l5-5 3 3 7-7 3 3V4h-7l3 3-6 6-3-3-6 6z"/>'),
  star: S('<path fill="currentColor" d="M12 2.5l2.9 6 6.6.8-4.9 4.5 1.3 6.5L12 17l-5.9 3.3 1.3-6.5L2.5 9.3l6.6-.8z"/>'),
};

// Class icons, WoT style: light = empty diamond, medium = one bar, heavy = two bars, TD = triangle.
export function classIcon(cls, size = 16) {
  const f = 'currentColor';
  const d = {
    light: `<path d="M8 1.5L14.5 8 8 14.5 1.5 8z" fill="none" stroke="${f}" stroke-width="1.8"/>`,
    medium: `<path d="M8 1.5L14.5 8 8 14.5 1.5 8z" fill="none" stroke="${f}" stroke-width="1.8"/><path d="M5 8h6" stroke="${f}" stroke-width="2.2"/>`,
    heavy: `<path d="M8 1.5L14.5 8 8 14.5 1.5 8z" fill="none" stroke="${f}" stroke-width="1.8"/><path d="M4.8 6.6h6.4M4.8 9.4h6.4" stroke="${f}" stroke-width="1.8"/>`,
    td: `<path d="M1.8 3h12.4L8 14z" fill="none" stroke="${f}" stroke-width="1.8"/><path d="M6 6h4" stroke="${f}" stroke-width="1.8"/>`,
  }[cls] || '';
  return svg(`<svg viewBox="0 0 16 16" width="${size}" height="${size}" aria-hidden="true">${d}</svg>`, 'cls-ico cls-' + cls);
}

// Nation flags (stylised; 30×20 viewBox).
const FLAG = {
  usa: '',
  germany: '<rect width="30" height="20" fill="#5f6668"/><path d="M15 3.2v13.6M8.2 10h13.6" stroke="#fff" stroke-width="6.4"/><path d="M15 3.2v13.6M8.2 10h13.6" stroke="#161616" stroke-width="3.6"/>',
  ussr: '<rect width="30" height="20" fill="#b3261e"/><path d="M8 3.2l1.1 2.4 2.6.3-1.9 1.8.5 2.6L8 9l-2.3 1.3.5-2.6-1.9-1.8 2.6-.3z" fill="#f4c542"/>',
};
export function flag(nation, cls = 'flag') {
  return svg(`<svg viewBox="0 0 30 20" preserveAspectRatio="none" aria-hidden="true">${FLAG[nation] || '<rect width="30" height="20" fill="#555"/>'}</svg>`, cls);
}
FLAG.usa = '<rect width="30" height="20" fill="#eee"/>' + [0, 2, 4, 6, 8, 10, 12].map((i) => `<rect y="${(i * 20 / 13).toFixed(2)}" width="30" height="${(20 / 13).toFixed(2)}" fill="#b8343a"/>`).join('') +
  '<rect width="13" height="10.77" fill="#2e3f73"/>' + [...Array(12)].map((_, i) => `<circle cx="${(2 + (i % 4) * 3 + ((i / 4 | 0) % 2) * 1.2).toFixed(1)}" cy="${(2 + (i / 4 | 0) * 3.3).toFixed(1)}" r=".7" fill="#fff"/>`).join('');

// Shell icon by type (AP / APCR / HE / HEAT), gold shells get a gold casing.
export function shellIcon(s) {
  const tip = { AP: '#9aa2a8', APCR: '#5aa7e0', HE: '#d8483a', HEAT: '#e0b340' }[s.type] || '#aaa';
  const casing = s.gold ? '#f0c24a' : '#c49a52';
  return svg(`<svg viewBox="0 0 12 36" aria-hidden="true"><path d="M3 12 Q6 1 9 12z" fill="${tip}"/><rect x="3" y="12" width="6" height="6" fill="${tip}" opacity=".85"/><rect x="2.4" y="18" width="7.2" height="15" rx=".6" fill="${casing}"/><rect x="2" y="32" width="8" height="2.5" fill="${casing}" opacity=".75"/><rect x="3.2" y="18" width="1.2" height="15" fill="#fff" opacity=".25"/></svg>`, 'shell-ico');
}

// Mastery badge 0..4 (0 = empty slot).
export function masteryIcon(m, size = 34) {
  const col = ['#3a3f3c', '#8c6a45', '#a9b1b6', '#e2b64a', '#f2d27a'][m] || '#333';
  const inner = m === 4
    ? '<path d="M16 7l2.4 5 5.4.6-4 3.7 1.1 5.4L16 19l-4.9 2.7 1.1-5.4-4-3.7 5.4-.6z" fill="#3b2a07"/>'
    : m > 0 ? `<text x="16" y="21" text-anchor="middle" font-family="Black Ops One, Impact, sans-serif" font-size="12" fill="#1a1a1a">${['', 'III', 'II', 'I'][m]}</text>` : '';
  return svg(`<svg viewBox="0 0 32 32" width="${size}" height="${size}" aria-hidden="true"><path d="M16 2l12 5v8c0 7.5-5 12.6-12 15C9 27.6 4 22.5 4 15V7z" fill="${col}" stroke="${m ? '#1b1b1b' : '#555'}" stroke-width="1.2" ${m ? '' : 'stroke-dasharray="3 2" fill-opacity=".35"'}/><path d="M16 4.6l9.6 4v6.4c0 6.2-4 10.4-9.6 12.5C10.4 25.4 6.4 21.2 6.4 15V8.6z" fill="none" stroke="#fff" stroke-opacity=".25"/>${inner}</svg>`, 'mastery-ico m' + m);
}

// Medal: ribbon with stripes + round disc with an emblem, hue from the medal id.
const MEDAL_ART = {
  topgun: ['#b8343a', '#f1d27a', 'target'], highcal: ['#2d5f9a', '#e2e2e2', 'gun'], sniper: ['#3e6b36', '#f1d27a', 'target'],
  steelwall: ['#50555a', '#cfd6db', 'shield'], scout: ['#2f7f6e', '#e8e2c8', 'eye'], confederate: ['#6e3f8a', '#f1d27a', 'star'],
  invader: ['#9a5a1c', '#f1d27a', 'battle'], defender: ['#1c4f7a', '#f1d27a', 'shield'], kolobanov: ['#8a1c1c', '#ffd24a', 'star'],
  pool: ['#1c6a8a', '#ffd24a', 'skull'], survivor: ['#5a6e2a', '#e6e6d2', 'shield'], spearhead: ['#9a2a2a', '#dcdcdc', 'battle'],
};
export function medalIcon(id, size = 56) {
  const [rib, disc, emb] = MEDAL_ART[id] || ['#555', '#ccc', 'star'];
  const e = (ICON[emb] || ICON.star).replace('<svg viewBox="0 0 24 24" aria-hidden="true">', '').replace('</svg>', '').replace(/currentColor/g, '#2a2419');
  return svg(`<svg viewBox="0 0 48 64" width="${size * 0.75}" height="${size}" aria-hidden="true">
    <path d="M12 0h24l-4 26H16z" fill="${rib}"/><path d="M19 0h4l-1 26h-2zM25 0h4l-2 26h-2z" fill="#fff" opacity=".55"/>
    <circle cx="24" cy="42" r="17" fill="${disc}" stroke="#6b5520" stroke-width="2"/><circle cx="24" cy="42" r="13.5" fill="none" stroke="#6b5520" stroke-opacity=".6"/>
    <g transform="translate(14.4 32.4) scale(.8)">${e}</g></svg>`, 'medal-ico');
}

// Rank chevrons 0..9.
export function rankIcon(i, size = 26) {
  const n = Math.min(3, (i % 4) + 1), officer = i >= 5;
  let d = '';
  if (!officer) for (let k = 0; k < n; k++) d += `<path d="M4 ${16 - k * 5}l10-6 10 6v3l-10-6-10 6z" fill="#e2b64a"/>`;
  else for (let k = 0; k < Math.min(4, i - 4); k++) d += `<path d="M${14 + (k - (Math.min(4, i - 4) - 1) / 2) * 7} 8l1.5 3.2 3.5.4-2.6 2.4.7 3.5-3.1-1.8-3.1 1.8.7-3.5-2.6-2.4 3.5-.4z" fill="#e2b64a"/>`;
  return svg(`<svg viewBox="0 0 28 26" width="${size}" height="${size}" aria-hidden="true"><rect x="1" y="1" width="26" height="24" rx="3" fill="#2a2f2b" stroke="#6b5520"/>${d}</svg>`, 'rank-ico');
}
