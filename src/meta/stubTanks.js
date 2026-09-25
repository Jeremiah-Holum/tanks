// STUB roster for META work while src/data/tanks.js (SIM) is being written. Same TankDef schema
// (docs/DESIGN.md "Tank definitions"); numbers are generated from tier and class, not history.
// roster.js only falls back to this file when the real data module is missing.
export const STUB = true;

export const NATIONS = {
  usa: { label: 'U.S.A.', paint: 0x4b5a32, marking: 'star' },
  germany: { label: 'Germany', paint: 0x5d5a4a, marking: 'cross' },
  ussr: { label: 'U.S.S.R.', paint: 0x44522f, marking: 'redstar' },
};

const CREW = { light: ['commander', 'gunner', 'driver'], medium: ['commander', 'gunner', 'driver', 'radioman', 'loader'],
  heavy: ['commander', 'gunner', 'driver', 'radioman', 'loader'], td: ['commander', 'gunner', 'driver', 'loader'] };
const PRICE = [0, 0, 3800, 42000, 135000, 370000, 910000, 1380000];
const XP = [0, 0, 250, 1500, 4200, 13500, 34000, 58000];
const CAL = [0, 20, 37, 47, 57, 75, 76, 88, 90];

function mk(id, name, short, nation, tier, cls, parents, o = {}) {
  const t = tier, heavy = cls === 'heavy', td = cls === 'td', light = cls === 'light';
  const fA = Math.round((light ? 14 + 5 * t : heavy ? 30 + 24 * t : td ? 18 + 16 * t : 18 + 12 * t));
  const cal = CAL[Math.min(8, t + (td ? 2 : heavy ? 1 : 0))];
  const pen = Math.round(cal * (1.1 + t * 0.06) * (td ? 1.2 : 1));
  const dmg = Math.round(cal * (cal < 60 ? 0.9 : 1.5) + t * 8);
  const L = 4.2 + 0.28 * t + (heavy ? 1 : 0), W = 2.0 + 0.1 * t + (heavy ? 0.3 : 0);
  const gun = (k) => ({
    name: `${cal + k * 10} mm ${nation === 'germany' ? 'KwK' : nation === 'ussr' ? 'ZiS' : 'Gun M'}${k ? ' (upgraded)' : ''}`,
    cal: cal + k * 10, len: 2.2 + t * 0.25 + k * 0.3, muzzleBrake: t > 4, xp: k ? Math.round(XP[Math.max(2, t)] * 0.35) : 0,
    reload: +(1.6 + t * 0.55 + (td ? 0.6 : 0) + k * 0.5).toFixed(1), aim: +(1.6 + t * 0.08 - (td ? 0.2 : 0)).toFixed(1),
    disp: +(0.46 - t * 0.012 - (td ? 0.04 : 0)).toFixed(2), dMove: 0.18, dHull: 0.18, dTurret: 0.12, dShot: 4, dep: -8, elev: 20,
    ammo: 60 + (light ? 40 : 0) - t * 3,
    shells: [
      { type: 'AP', pen: pen + k * 18, dmg: dmg + k * 20, v: 600 + t * 20 },
      { type: 'APCR', pen: Math.round((pen + k * 18) * 1.35), dmg: dmg + k * 20, v: 800 + t * 25, gold: true },
      { type: 'HE', pen: Math.round(cal * 0.5), dmg: Math.round((dmg + k * 20) * 1.33), v: 480, splash: 0.4 + cal / 60 },
    ],
  });
  return {
    id, name, short, nation, tier, cls, parents,
    price: PRICE[t] * (t === 1 ? 0 : 1), xp: XP[t],
    hp: Math.round((light ? 90 : heavy ? 150 : td ? 100 : 115) * (1 + (t - 1) * 0.42) * (heavy ? 1.2 : 1)),
    mass: +(light ? 7 + t * 2.4 : heavy ? 20 + t * 7 : td ? 10 + t * 4 : 10 + t * 4).toFixed(1),
    power: Math.round(light ? 170 + t * 60 : heavy ? 250 + t * 80 : 200 + t * 70),
    speed: light ? 60 : heavy ? 34 + t : td ? 44 : 46 + t, reverse: light ? 22 : 14,
    hullTraverse: light ? 48 : heavy ? 24 : td ? 36 : 40, turretTraverse: td ? 32 : light ? 46 : heavy ? 24 : 38,
    terrain: [0.9, 1.1, 2.0], view: 300 + t * 8 + (light ? 40 : 0),
    camo: { still: light ? 0.2 : td ? 0.24 : heavy ? 0.06 : 0.13, moving: light ? 0.2 : td ? 0.14 : heavy ? 0.03 : 0.1, fire: 0.3 },
    crew: CREW[cls],
    guns: t > 1 ? [gun(0), gun(1)] : [gun(0)],
    hull: {
      L, W, H: 0.95 + 0.06 * t, clr: 0.42, engine: nation === 'germany' ? 'rear' : 'rear', ammo: 'hull',
      track: { w: 0.36 + 0.035 * t, h: 0.95 + 0.03 * t, t: 20, len: 0.96, wheels: 5 + (t > 3 ? 1 : 0), wheelR: 0.3, style: nation === 'usa' ? 'vvss' : nation === 'ussr' ? 'christie' : 'interleaved' },
      upper: { t: fA, a: light ? 50 : nation === 'ussr' ? 60 : 35, frac: 0.6 }, lower: { t: Math.round(fA * 0.8), a: 40 },
      side: { t: Math.round(fA * 0.55), tUpper: Math.round(fA * 0.5), a: 0 }, rear: { t: Math.round(fA * 0.45), a: 10 },
      roof: Math.max(10, Math.round(fA * 0.2)), floor: 12,
    },
    turret: {
      shape: td ? (nation === 'usa' ? 'open' : 'casemate') : nation === 'ussr' ? 'cast' : 'box',
      z: td ? L * 0.12 : -0.1, zOff: 0, L: 1.7 + 0.12 * t, W: 1.5 + 0.1 * t + (heavy ? 0.3 : 0), H: 0.75 + 0.03 * t,
      ringR: 0.7, chamfer: nation === 'ussr' ? 0.35 : 0, gunY: null,
      front: { t: Math.round(fA * 1.15), a: nation === 'ussr' ? 25 : 10 }, side: { t: Math.round(fA * 0.6), a: 8 },
      rear: { t: Math.round(fA * 0.5), a: 5 }, roof: 15, mantlet: { t: Math.round(fA * 0.9), w: 0.8, h: 0.45, d: 0.12 },
      traverse: td ? [-15, 15] : null,
    },
    look: { cupola: t > 2, skirts: heavy && nation === 'germany', stowage: true, exhausts: 2, number: true },
    ...o,
  };
}

const L = [
  // USA
  mk('usa_t1', 'T1 Cunningham', 'T1', 'usa', 1, 'light', []),
  mk('usa_m2lt', 'M2 Light Tank', 'M2 LT', 'usa', 2, 'light', ['usa_t1']),
  mk('usa_t18', 'T18 HMC', 'T18', 'usa', 2, 'td', ['usa_t1']),
  mk('usa_m3stuart', 'M3 Stuart', 'Stuart', 'usa', 3, 'light', ['usa_m2lt']),
  mk('usa_m2med', 'M2 Medium Tank', 'M2 Med', 'usa', 3, 'medium', ['usa_m2lt']),
  mk('usa_m3lee', 'M3 Lee', 'Lee', 'usa', 4, 'medium', ['usa_m2med']),
  mk('usa_m10', 'M10 Wolverine', 'M10', 'usa', 4, 'td', ['usa_t18']),
  mk('usa_m4', 'M4 Sherman', 'M4', 'usa', 5, 'medium', ['usa_m3lee']),
  mk('usa_t1hvy', 'T1 Heavy Tank', 'T1 Hvy', 'usa', 5, 'heavy', ['usa_m3lee']),
  mk('usa_m36', 'M36 Jackson', 'M36', 'usa', 6, 'td', ['usa_m10']),
  mk('usa_m4a3e8', 'M4A3E8 Sherman', 'Easy 8', 'usa', 6, 'medium', ['usa_m4']),
  mk('usa_t29', 'T29', 'T29', 'usa', 7, 'heavy', ['usa_t1hvy']),
  mk('usa_t20', 'T20', 'T20', 'usa', 7, 'medium', ['usa_m4a3e8']),
  // Germany
  mk('ger_ltraktor', 'Leichttraktor', 'LTr', 'germany', 1, 'light', []),
  mk('ger_pz2', 'Pz.Kpfw. II', 'Pz. II', 'germany', 2, 'light', ['ger_ltraktor']),
  mk('ger_pzjg1', 'Panzerjäger I', 'PzJg I', 'germany', 2, 'td', ['ger_ltraktor']),
  mk('ger_pz3', 'Pz.Kpfw. III', 'Pz. III', 'germany', 3, 'medium', ['ger_pz2']),
  mk('ger_marder', 'Marder II', 'Marder', 'germany', 3, 'td', ['ger_pzjg1']),
  mk('ger_pz4', 'Pz.Kpfw. IV Ausf. H', 'Pz. IV H', 'germany', 4, 'medium', ['ger_pz3']),
  mk('ger_stug', 'StuG III Ausf. G', 'StuG III', 'germany', 5, 'td', ['ger_marder']),
  mk('ger_vk3001', 'VK 30.01 (H)', 'VK 30.01', 'germany', 5, 'heavy', ['ger_pz4']),
  mk('ger_panther', 'Panther', 'Panther', 'germany', 6, 'medium', ['ger_pz4']),
  mk('ger_tiger', 'Tiger I', 'Tiger', 'germany', 7, 'heavy', ['ger_vk3001']),
  mk('ger_jpanther', 'Jagdpanther', 'Jagdpanther', 'germany', 7, 'td', ['ger_stug']),
  // USSR
  mk('ussr_ms1', 'MS-1', 'MS-1', 'ussr', 1, 'light', []),
  mk('ussr_bt2', 'BT-2', 'BT-2', 'ussr', 2, 'light', ['ussr_ms1']),
  mk('ussr_at1', 'AT-1', 'AT-1', 'ussr', 2, 'td', ['ussr_ms1']),
  mk('ussr_bt7', 'BT-7', 'BT-7', 'ussr', 3, 'light', ['ussr_bt2']),
  mk('ussr_su76', 'SU-76M', 'SU-76', 'ussr', 3, 'td', ['ussr_at1']),
  mk('ussr_t28', 'T-28', 'T-28', 'ussr', 4, 'medium', ['ussr_bt7']),
  mk('ussr_t34', 'T-34', 'T-34', 'ussr', 5, 'medium', ['ussr_t28']),
  mk('ussr_kv1', 'KV-1', 'KV-1', 'ussr', 5, 'heavy', ['ussr_t28']),
  mk('ussr_su85', 'SU-85', 'SU-85', 'ussr', 5, 'td', ['ussr_su76']),
  mk('ussr_t3485', 'T-34-85', 'T-34-85', 'ussr', 6, 'medium', ['ussr_t34']),
  mk('ussr_kv85', 'KV-85', 'KV-85', 'ussr', 6, 'heavy', ['ussr_kv1']),
  mk('ussr_is', 'IS', 'IS', 'ussr', 7, 'heavy', ['ussr_kv85']),
];

export const TANKS = Object.fromEntries(L.map((d) => [d.id, d]));
export const TREE = L.flatMap((d) => d.parents.map((p) => [p, d.id]));
