// Tank classes (the hardware) and types (a class + paint + a brain).
// Units: speed in cells/s, angles in radians, armour and penetration in toy-millimetres.
//
// Armour is [front, side, rear]. A hit penetrates when penetration × roll(0.75..1.25) beats
// armour ÷ cos(impact angle); anything steeper than RICOCHET_ANGLE glances off.

export const CLASSES = {
  light: {
    label: 'Light', blurb: 'Fast scout. Thin skin, quick gun, sees first.',
    hp: 90, armor: [26, 18, 14], pen: 64, dmg: 30, shellSpeed: 7.0, reload: 1.6,
    speed: 3.0, turnRate: 6.5, turretRate: 2.6, dispBase: 0.045, dispMove: 0.05, maxShells: 1, mines: 2, scale: 0.9,
  },
  medium: {
    label: 'Medium', blurb: 'The all-rounder. Decent armour, decent gun.',
    hp: 130, armor: [55, 34, 22], pen: 92, dmg: 42, shellSpeed: 7.6, reload: 2.2,
    speed: 2.35, turnRate: 5.2, turretRate: 1.9, dispBase: 0.035, dispMove: 0.06, maxShells: 1, mines: 2, scale: 1.0,
  },
  heavy: {
    label: 'Heavy', blurb: 'Slow brick. Angle that front plate and shrug off hits.',
    hp: 190, armor: [96, 56, 34], pen: 112, dmg: 56, shellSpeed: 7.2, reload: 3.0,
    speed: 1.7, turnRate: 3.8, turretRate: 1.3, dispBase: 0.04, dispMove: 0.07, maxShells: 1, mines: 1, scale: 1.14,
  },
  td: {
    label: 'Tank Destroyer', blurb: 'Huge gun, low profile. Paper sides, slow turret.',
    hp: 120, armor: [82, 28, 20], pen: 150, dmg: 70, shellSpeed: 9.6, reload: 3.4,
    speed: 2.0, turnRate: 4.4, turretRate: 1.0, dispBase: 0.022, dispMove: 0.08, maxShells: 1, mines: 1, scale: 1.02,
  },
};
export const CLASS_ORDER = ['light', 'medium', 'heavy', 'td'];
export const RICOCHET_ANGLE = 70 * Math.PI / 180;

const T = (cls, extra) => ({ cls, ...CLASSES[cls], rocket: cls === 'td', bounces: 0, burst: 1, burstGap: 0, ...extra });

export const TYPES = {
  player: T('medium', { name: 'You', color: 0x3d6fc4, trim: 0xe9f1ff }),
  ally:   T('medium', { name: 'Ally', color: 0x4f7a3a, trim: 0xe8fff2 }),

  rookie: T('light', {
    name: 'Rookie', color: 0xc08a4a, trim: 0x5c3a1c, speed: 0, turnRate: 0, turretRate: 1.2, reload: 2.4, hp: 70,
    ai: { think: 0.55, aimErr: 0.09, lead: false, dodge: false, fireTol: 0.09, mineUse: 0, style: 'hold', sweep: true, verify: 'loose' },
  }),
  grunt: T('medium', {
    name: 'Grunt', color: 0x8d949c, trim: 0x3a3f45, speed: 1.6, reload: 2.6,
    ai: { think: 0.4, aimErr: 0.06, lead: false, dodge: false, dodgeLook: 0.3, fireTol: 0.07, mineUse: 0, style: 'wander', verify: 'loose' },
  }),
  zipper: T('light', {
    name: 'Zipper', color: 0x1fb5b0, trim: 0x0b4f4d, pen: 80, shellSpeed: 10, rocket: true,
    ai: { think: 0.3, aimErr: 0.025, lead: true, dodge: true, dodgeLook: 0.35, fireTol: 0.04, mineUse: 0, style: 'sniper', verify: 'strict' },
  }),
  sapper: T('light', {
    name: 'Sapper', color: 0xd9ad2a, trim: 0x6b5208, mines: 4,
    ai: { think: 0.35, aimErr: 0.07, lead: false, dodge: true, dodgeLook: 0.35, fireTol: 0.07, mineUse: 1, mineEvery: 4.5, style: 'sapper', verify: 'loose' },
  }),
  burst: T('medium', {
    name: 'Autoloader', color: 0xc8453c, trim: 0x5e1410, burst: 3, burstGap: 0.35, reload: 5.0, dmg: 32, maxShells: 3,
    ai: { think: 0.3, aimErr: 0.045, lead: true, dodge: true, dodgeLook: 0.35, fireTol: 0.05, mineUse: 0, style: 'wander', verify: 'strict' },
  }),
  ricochet: T('td', {
    name: 'Marksman', color: 0x5d8a2f, trim: 0x21470e, speed: 0, turnRate: 0,
    ai: { think: 0.25, aimErr: 0.01, lead: true, dodge: false, fireTol: 0.02, mineUse: 0, style: 'hold', verify: 'strict' },
  }),
  hunter: T('medium', {
    name: 'Hunter', color: 0x7a4fc0, trim: 0x33145e, speed: 2.5, reload: 1.9,
    ai: { think: 0.16, aimErr: 0.025, lead: true, dodge: true, dodgeLook: 0.6, fireTol: 0.035, mineUse: 0.5, style: 'hunt', verify: 'strict', flank: true },
  }),
  ghost: T('light', {
    name: 'Ghost', color: 0xe4e4dc, trim: 0x9aa0a6, invisible: true,
    ai: { think: 0.2, aimErr: 0.035, lead: true, dodge: true, dodgeLook: 0.5, fireTol: 0.04, mineUse: 0.4, style: 'trick', verify: 'strict', flank: true },
  }),
  boss: T('heavy', {
    name: 'Commander', color: 0x2e3034, trim: 0xd9a927, hp: 320, armor: [120, 70, 42], pen: 140, dmg: 70,
    ai: { think: 0.1, aimErr: 0.01, lead: true, dodge: true, dodgeLook: 0.8, fireTol: 0.025, mineUse: 0.6, style: 'hunt', verify: 'strict', counterFire: true, angle: true },
  }),
};

// Versus / ally bot engines. They drive whatever class they're given.
export const SKILLS = {
  cadet:   { label: 'Cadet',   think: 0.34, aimErr: 0.07,  lead: false, dodge: true, dodgeLook: 0.3,  dodgeEvery: 'think', fireTol: 0.08,  mineUse: 0.15, verify: 'loose',  counterFire: false, tactics: false, patience: 0.2, angle: false, flank: false },
  veteran: { label: 'Veteran', think: 0.18, aimErr: 0.025, lead: true,  dodge: true, dodgeLook: 0.6,  dodgeEvery: 'think', fireTol: 0.04,  mineUse: 0.5,  verify: 'strict', counterFire: false, tactics: true,  patience: 0.55, angle: false, flank: true },
  ace:     { label: 'Ace',     think: 0.09, aimErr: 0.006, lead: true,  dodge: true, dodgeLook: 0.9,  dodgeEvery: 'tick',  fireTol: 0.02,  mineUse: 1,    verify: 'strict', counterFire: true,  tactics: true,  patience: 0.9, angle: true, flank: true },
};

export const PERSONALITIES = {
  sniper:    { label: 'Sniper',    style: 'sniper' },
  brawler:   { label: 'Brawler',   style: 'hunt' },
  trickster: { label: 'Flanker',   style: 'trick' },
};

export const ENEMY_ORDER = ['rookie', 'grunt', 'zipper', 'sapper', 'burst', 'ricochet', 'hunter', 'ghost', 'boss'];

// The player's garage: a class swapped into the player's (or a bot's) kit.
export function kitFor(baseKey, cls) {
  const b = TYPES[baseKey];
  return { ...b, ...CLASSES[cls], cls, rocket: cls === 'td', name: b.name, color: b.color, trim: b.trim };
}
