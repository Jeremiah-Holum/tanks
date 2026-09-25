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
