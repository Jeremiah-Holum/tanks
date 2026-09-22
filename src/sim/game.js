// Match setup shared by the browser game and the headless tools.
import { createWorld } from './world.js';
import { CAMPAIGN, VERSUS } from './levels.js';
import { tuneEnemy, blendSkill } from './director.js';

// opts: { playerClass: 'light'|'medium'|'heavy'|'td' (default medium), allyClass }
export function campaignWorld(index, rating, seed = 1, opts = {}) {
  const world = createWorld({ level: CAMPAIGN[index], seed, mode: 'campaign', playerClass: opts.playerClass || 'medium', allyClass: opts.allyClass || 'medium' });
  for (const t of world.tanks) if (t.team !== 0) { t.type = tuneEnemy(t.typeKey, rating); t.hp = t.maxHp = t.type.hp; t.disp = t.type.dispBase; }
  world.levelIndex = index;
  return world;
}

// Spawn digits: 0-4 are the left side, 5-9 the right side (mirror images: k ↔ k+5).
// Team battle (teams 0 and 1 only): team 0 fills 0,1,2,3,4 and team 1 fills 5,6,7,8,9.
// Free-for-all (up to 4 teams): corners, so nobody starts next to an opponent.
const FFA_SPAWNS = { 1: [0], 2: [0, 5], 3: [0, 6, 7], 4: [1, 6, 2, 7] };
export function assignSpawns(slots) {
  const teams = [...new Set(slots.map((s) => s.team))];
  const out = slots.map((s) => ({ ...s }));
  const teamBattle = teams.length === 2 && teams.every((k) => k === 0 || k === 1) && out.length > 2;
  if (teamBattle || (teams.length === 2 && out.length === 2 && teams.every((k) => k === 0 || k === 1))) {
    const next = { 0: 0, 1: 5 };
    for (const s of out) if (s.sp == null) s.sp = next[s.team]++;
  } else {
    const order = FFA_SPAWNS[Math.min(4, out.length)] || FFA_SPAWNS[4];
    out.forEach((s, k) => { if (s.sp == null) s.sp = order[k % order.length]; });
  }
  return out;
}

// slots: [{ human, team, skill: 'cadet'|'veteran'|'ace'|'adaptive', style, cls, sp, label, color }]
// FFA: every slot its own team (up to 4). Teams: team 0 vs team 1, up to 5 a side.
export function versusWorld(mapIndex, slots, rating, seed = 1) {
  const s2 = assignSpawns(slots).map((s) => ({ ...s, skill: s.human ? null : s.skill === 'adaptive' ? blendSkill(rating) : s.skill }));
  const world = createWorld({ level: VERSUS[mapIndex], seed, mode: 'versus', slots: s2 });
  world.mapIndex = mapIndex;
  return world;
}
