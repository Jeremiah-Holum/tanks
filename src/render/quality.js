// Graphics quality tiers. Budget targets (1080p): low = integrated GPUs, medium = 60 fps on a
// mid-range GPU (GTX 1060 / RX 580 class), high = more shadow range, AO, SMAA, denser grass.
// Measured draw calls / triangles per tier are in docs/notes/render-world.md.
export const QUALITY = {
  low: {
    name: 'low', pixelRatio: 1, maxPixelRatio: 1,
    terrainStep: 1,          // terrain vertices per height sample (1 = 257², 2 = 513²)
    outerTerrain: 0.6,       // resolution factor of the outside-the-map ring
    shadowMap: 1024, shadowRange: 110, shadowRadius: 1.5,
    grass: null,             // { radius, spacing }
    treeLod: 110,            // near-LOD distance for trees and bushes (m)
    wind: false, bloom: false, ao: false, aa: 'fxaa', clouds: true, farTrees: 900,
    detailNormals: false,
  },
  medium: {
    name: 'medium', pixelRatio: 1, maxPixelRatio: 1,
    terrainStep: 2, outerTerrain: 1,
    shadowMap: 2048, shadowRange: 150, shadowRadius: 2.5,
    grass: { radius: 60, spacing: 0.62 },
    treeLod: 170, wind: true, bloom: true, ao: false, aa: 'fxaa', clouds: true, farTrees: 2600,
    detailNormals: true,
  },
  high: {
    name: 'high', pixelRatio: 1, maxPixelRatio: 1, // was 2: at 125–150% Windows scaling that drew 1.5–2.25× the pixels + AO → stutter
    terrainStep: 2, outerTerrain: 1.4,
    shadowMap: 3072, shadowRange: 220, shadowRadius: 3,
    grass: { radius: 80, spacing: 0.52 },
    treeLod: 260, wind: true, bloom: true, ao: true, aa: 'smaa', clouds: true, farTrees: 4200,
    detailNormals: true,
  },
};
export const qualityOf = (q) => (typeof q === 'object' && q ? q : QUALITY[q] || QUALITY.medium);
