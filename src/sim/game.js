// Match setup shared by the browser game and the headless tools.
import { createWorld } from './world.js';
import { CAMPAIGN, VERSUS } from './levels.js';
import { tuneEnemy, blendSkill } from './director.js';

export function campaignWorld(index, rating, seed = 1) {
  const world = createWorld({ level: CAMPAIGN[index].rows, seed, mode: 'campaign' });
  for (const t of world.tanks) if (t.team !== 0) t.type = tuneEnemy(t.typeKey, rating);
  world.levelIndex = index;
  return world;
}

// slots: [{ human, team, skill: 'cadet'|'veteran'|'ace'|'adaptive', style, label, color }]
export function versusWorld(mapIndex, slots, rating, seed = 1) {
  const s2 = slots.map((s) => ({ ...s, skill: s.human ? null : s.skill === 'adaptive' ? blendSkill(rating) : s.skill }));
  const world = createWorld({ level: VERSUS[mapIndex].rows, seed, mode: 'versus', slots: s2 });
  world.mapIndex = mapIndex;
  return world;
}
