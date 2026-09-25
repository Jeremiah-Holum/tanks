// UI lab: renders one Steel Front screen with sample data.
//   tools/ui-lab.html?screen=hangar|tree|details|loading|results|record|settings
//   &tank=<id>  &nation=<id>  &result=victory|defeat|draw  &fresh (new profile)  &persist (use localStorage)
import { Screens } from '../src/ui/screens.js';
import { TANKS, TANK_LIST } from '../src/meta/roster.js';
import { newProfile, defaultAmmo, tankState } from '../src/meta/profile.js';
import { buildBattle } from '../src/meta/matchmaker.js';
import { summarize, MEDALS } from '../src/meta/results.js';
import { makeRng } from '../src/meta/rng.js';

const q = new URLSearchParams(location.search);
const memStore = { data: {}, getItem(k) { return this.data[k] ?? null; }, setItem(k, v) { this.data[k] = v; } };

function sampleProfile() {
  const p = newProfile('Sgt_Steel');
  if (q.has('fresh')) return p;
  const rng = makeRng(5);
  const own = ['usa_m4', 'usa_m3lee', 'ger_pz4h', 'ger_tiger', 'ussr_t34', 'ussr_kv1', 'ger_stug3', 'usa_m2lt', 'ussr_su85', 'ger_pz3', 'usa_t1hvy'].filter((id) => TANKS[id]);
  const research = (id) => { if (!p.researched.includes(id)) p.researched.push(id); for (const par of TANKS[id].parents || []) research(par); };
  for (const id of own) {
    research(id);
    const ts = tankState(p, id);
    ts.owned = true; ts.battles = 5 + Math.floor(rng() * 60); ts.wins = Math.floor(ts.battles * (0.42 + rng() * 0.2));
    ts.xp = Math.floor(rng() * 9000); ts.dmg = Math.round(TANKS[id].hp * (0.7 + rng() * 0.8) * ts.battles); ts.kills = Math.round(ts.battles * rng() * 1.3); ts.mastery = Math.floor(rng() * 5); ts.guns = [0]; ts.ammo = defaultAmmo(TANKS[id], 0);
  }
  research('usa_m4a3e8');
  p.tanks.usa_m4.guns = [0, 1].filter((i) => TANKS.usa_m4.guns[i]); p.tanks.usa_m4.xp = 14200;
  p.selected = q.get('tank') && TANKS[q.get('tank')] ? q.get('tank') : 'usa_m4';
  if (!p.tanks[p.selected]?.owned) tankState(p, p.selected).owned = true;
  p.credits = 1284350; p.freeXp = 3120;
  Object.assign(p.stats, { battles: 187, wins: 99, losses: 81, draws: 7, survived: 61, kills: 214, dmg: 98650, assist: 41200, blocked: 30500, received: 70100,
    shots: 1520, hits: 1190, pens: 960, spotted: 233, capture: 410, defended: 380, xp: 168000, credits: 4100000, maxDmg: 2480, maxKills: 7, maxXp: 3120 });
  for (const m of MEDALS) if (rng() < 0.7) p.stats.medals[m.id] = 1 + Math.floor(rng() * 9);
  const maps = ['ashford', 'kessel', 'steppe', 'kolvik'];
  for (let i = 0; i < 12; i++) {
    const id = own[i % own.length], res = rng() < 0.52 ? 'victory' : rng() < 0.9 ? 'defeat' : 'draw';
    p.history.push({ id: 'h' + i, time: Date.now() - i * 3600e3 * 5, tankId: id, mapId: maps[i % 4], mapName: ['Ashford Fields', 'River Kessel', 'Steppe Ridge', 'Kolvik Pass'][i % 4],
      result: res, dmg: Math.floor(TANKS[id].hp * rng() * 2), kills: Math.floor(rng() * 4), xp: 300 + Math.floor(rng() * 1500), credits: Math.floor(rng() * 40000 - 5000),
      mastery: rng() < 0.2 ? 1 + Math.floor(rng() * 3) : 0, medals: [], survived: rng() < 0.4 });
  }
  return p;
}

// A finished world for the results screen: the player had a strong game.
function sampleWorld(p, battle, result) {
  const rng = makeRng(9);
  const tanks = []; let id = 1;
  battle.teams.forEach((tm, team) => tm.forEach((e) => tanks.push({ id: id++, team, def: e.def, gunDef: e.def.guns[e.gun], name: e.name, player: e.player,
    alive: true, hp: e.def.hp, maxHp: e.def.hp, ammo: e.ammo.slice(), consumables: e.consumables.map((k) => ({ kind: k, ready: true })),
    stats: { dmg: 0, assist: 0, blocked: 0, kills: 0, shots: 0, hits: 0, pens: 0, received: 0, spotted: 0, capture: 0, defended: 0 } })));
  const me = tanks.find((t) => t.player);
  const won = result === 'victory', draw = result === 'draw';
  for (const t of tanks) if (t !== me) {
    t.stats.dmg = Math.round(t.maxHp * rng() * 1.5); t.stats.kills = rng() < 0.4 ? 1 + (rng() < 0.3 ? 1 : 0) : 0; t.stats.assist = Math.round(t.maxHp * rng() * 0.6);
    t.stats.spotted = rng() < 0.3 ? 1 : 0;
    const dead = t.team === me.team ? rng() < (won ? 0.45 : 0.9) : rng() < (won ? 0.95 : 0.5);
    if (dead && !draw) { t.alive = false; t.hp = 0; } else t.hp = Math.round(t.maxHp * (0.1 + rng() * 0.8));
  }
  Object.assign(me.stats, { dmg: Math.round(me.maxHp * 2.6), assist: 640, blocked: 820, kills: 4, shots: 14, hits: 12, pens: 10, received: 380, spotted: 5, capture: 0, defended: 45 });
  me.hp = Math.round(me.maxHp * 0.21); me.ammo[0] -= 14; me.consumables[0].ready = false;
  return { time: 611, seed: battle.seed, map: { id: battle.mapId, name: battle.meta.mapName }, mode: 'standard', tanks, firstKill: me.id,
    result: { winner: won ? me.team : draw ? -1 : 1 - me.team, reason: won ? 'destroyed' : draw ? 'time' : 'captured' } };
}

const root = document.getElementById('ui');
const profile = sampleProfile();
const screens = new Screens(root, {
  profile, storage: q.has('persist') ? undefined : memStore,
  onBattle: (id, o) => { console.log('onBattle', id, o); screens.showLoading(o.battle); },
  onSettings: (s) => console.log('onSettings', s),
});
window.__lab = { screens, ready: false };
const screen = q.get('screen') || 'hangar';
const battle = buildBattle(profile, profile.selected, { seed: 1234, size: +(q.get('size') || 15) });
if (screen === 'hangar') screens.showHangar();
else if (screen === 'tree') screens.showTree(q.get('nation') || 'germany');
else if (screen === 'details') screens.showDetails(q.get('tank') || profile.selected);
else if (screen === 'record') screens.showRecord();
else if (screen === 'settings') { screens.showHangar(); screens.showSettings(); }
else if (screen === 'loading') {
  screens.showLoading(battle); screens.setLoadingProgress(0.62, 'Building terrain…');
  if (!q.has('nomap')) { const { loadMap } = await import('../src/sim/map/index.js'); await new Promise((r) => setTimeout(r, 50)); screens.setLoadingMap(loadMap(battle.mapId)); }
}
else if (screen === 'results') {
  const world = sampleWorld(profile, battle, q.get('result') || 'victory');
  screens.finishBattle(world, world.tanks.find((t) => t.player).id, battle);
}
await document.fonts.ready;
setTimeout(() => { window.__lab.ready = true; }, +(q.get('wait') || 2500));
