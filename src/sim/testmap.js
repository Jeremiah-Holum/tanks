import { aimSolution, predictImpact } from './gunnery.js';

// A small synthetic MapData for tests and benchmarks (same shape as src/sim/map/ output).
// testMap({ size, res, hills, objects, water }) — flat by default; hills adds gentle sine waves.
export function testMap({ size = 1000, res = 129, hills = 0, objects = [], water = null, ground = 0 } = {}) {
  const heights = new Float32Array(res * res), g = new Uint8Array(res * res).fill(ground), cell = size / (res - 1);
  for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) {
    const x = i * cell, z = j * cell;
    heights[j * res + i] = 10 + hills * (Math.sin(x / 90) * Math.cos(z / 110) + 0.5 * Math.sin((x + z) / 47));
  }
  const spawns = [0, 1].map((team) => Array.from({ length: 15 }, (_, i) => ({
    x: size / 2 + ((i % 5) - 2) * 18, z: team ? size - 120 - Math.floor(i / 5) * 15 : 120 + Math.floor(i / 5) * 15, yaw: team ? Math.PI : 0,
  })));
  return {
    id: 'test', name: 'Test Range', size, res, cell, heights, ground: g, water,
    objects: objects.map((o, i) => ({ id: i + 1, y: 10, yaw: 0, variant: 0, ...o })),
    bases: [{ team: 0, x: size / 2, z: 70, r: 45 }, { team: 1, x: size / 2, z: size - 70, r: 45 }],
    spawns, points: [], lanes: [{ name: 'centre', path: [[size / 2, 100], [size / 2, size - 100]] }],
    nav: null, theme: { name: 'summer', sun: [1, 2, 1], fog: 0, sky: 0, tint: 0 },
  };
}

// A trivial scripted controller for tests and benchmarks (not the AI): drive towards the enemy
// base, stop to shoot the nearest spotted enemy inside 300 m. simpleBot(tank) → (world) => Controls.
export function simpleBot(tank) {
  let stuck = 0, lastX = tank.pos.x, lastZ = tank.pos.z, reverseT = 0;
  const c = { throttle: 0, steer: 0, brake: false, aim: null, lockGun: false, fire: false, shell: 0, use: null }, sol = {};
  return (world) => {
    const t = tank, base = world.bases.find((b) => b.team !== t.team) || { x: world.map.size / 2, z: world.map.size / 2 };
    const vis = world.visible[t.team];
    let best = null, bd = 300;
    for (const e of world.tanks) {
      if (!e.alive || e.team === t.team || !vis.has(e.id)) continue;
      const d = Math.hypot(e.pos.x - t.pos.x, e.pos.z - t.pos.z);
      if (d < bd) { bd = d; best = e; }
    }
    const gx = best && bd < 200 ? t.pos.x : base.x, gz = best && bd < 200 ? t.pos.z : base.z;
    const want = Math.atan2(gx - t.pos.x, gz - t.pos.z);
    let diff = want - t.yaw; while (diff > Math.PI) diff -= 2 * Math.PI; while (diff < -Math.PI) diff += 2 * Math.PI;
    const far = Math.hypot(gx - t.pos.x, gz - t.pos.z) > 15;
    // unstick: if we haven't moved for 3 s, reverse and turn for 2 s
    if ((world.step + t.id) % 60 === 0) {
      const m = Math.hypot(t.pos.x - lastX, t.pos.z - lastZ); lastX = t.pos.x; lastZ = t.pos.z;
      stuck = far && m < 1 ? stuck + 1 : 0;
      if (stuck >= 3) { reverseT = 2; stuck = 0; }
    }
    if (reverseT > 0) { reverseT -= 1 / 60; c.throttle = -1; c.steer = 1; }
    else { c.steer = Math.max(-1, Math.min(1, -diff * 2)); c.throttle = far ? (Math.abs(diff) < 0.8 ? 1 : 0.2) : 0; }
    c.brake = !far;
    c.aim = best ? { x: best.pos.x, y: best.pos.y + best.cy, z: best.pos.z } : null;
    c.lockGun = !best;
    let onTarget = false;
    if (best && t.reload <= 0) { // fire only once the gun is laid (within ~0.3°)
      const s = aimSolution(world, t, c.aim, sol);
      onTarget = s.reachable && Math.abs(s.yaw - t.turretYaw) < 0.005 && Math.abs(s.pitch - t.gunPitch) < 0.005;
      if (onTarget) { const p = predictImpact(world, t); onTarget = !!p.targetId && world.byId[p.targetId].team !== t.team; }
    }
    c.fire = onTarget && t.disp < t.gunDef.disp * 3;
    c.shell = t.ammo[0] > 0 ? 0 : t.ammo[2] > 0 ? 2 : 1;
    return c;
  };
}
