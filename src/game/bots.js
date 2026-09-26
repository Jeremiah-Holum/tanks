// Bot brains for every non-player tank. 'ai' = the real AI (src/sim/ai), 'simple' = the scripted
// test bot from src/sim/testmap.js (fallback if the AI fails to build, or with ?bots=simple).
import { createBrain } from '../sim/ai/index.js';
import { simpleBot } from '../sim/testmap.js';

let warned = false;
export function makeBrain(world, tank, kind = 'ai') {
  if (kind !== 'simple') {
    try { return createBrain(world, tank); }
    catch (e) { if (!warned) { warned = true; console.warn('AI unavailable, using the simple bot:', e.message); } }
  }
  const f = simpleBot(tank);
  return { control: (w) => f(w) };
}
