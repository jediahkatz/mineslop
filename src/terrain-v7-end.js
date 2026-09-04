import { BIOME_PROFILES } from "./biomes.js";
import { BLOCK as B } from "./blocks.js";
import { hash, mix, noise } from "./noise.js";
import { v5Ramp as ramp } from "./terrain-v5-biomes.js";
import { rememberV5, v5InBounds } from "./terrain-v5-config.js";

export const V7_END_LIMITS = Object.freeze({
  centralColumns: 2048, bowls: 3, pillars: 10, centralReach: 256,
});
const EMPTY = Object.freeze([]);
// A voxel mask, shared by generation and consumers of the pure metadata API.
// No renderer needs a second placement or rasterization formula.
const FOOTPRINT = Object.freeze(
  Array.from({ length: 25 }, (_, i) => [i % 5 - 2, Math.floor(i / 5) - 2])
    .filter(([x, z]) => x * x + z * z <= 5).map(Object.freeze)
);
const MASK = FOOTPRINT.reduce((mask, [x, z]) => mask | (1 << ((z + 2) * 5 + x + 2)), 0);

/** Only the central End changes. The v6 outer field and all other dimensions
 * remain frozen. Constant-size source plans require no chunks or natural voxels.
 */
export function createV7EndField(salt, frozen, counters) {
  const roll = (i, channel) => hash(i, channel, salt ^ 59419);
  const phase = roll(0, 17) * Math.PI * 2;
  const columns = new Map();
  const bowls = Object.freeze(Array.from({ length: V7_END_LIMITS.bowls }, (_, i) => {
    const angle = phase + i * Math.PI * 2 / 3;
    const distance = 55 + roll(i, 23) * 9;
    return Object.freeze({
      x: Math.round(Math.cos(angle) * distance), z: Math.round(Math.sin(angle) * distance),
      radius: 23 + roll(i, 29) * 4, depth: 14 + roll(i, 31) * 4,
      rim: 5 + roll(i, 37) * 2,
    });
  }));
  const sites = Array.from({ length: V7_END_LIMITS.pillars }, (_, i) => {
    const angle = phase * 0.3 + i * Math.PI / 5;
    const distance = 106 + roll(i, 41) * 6;
    return {
      id: i, x: Math.round(Math.cos(angle) * distance),
      z: Math.round(Math.sin(angle) * distance),
    };
  });

  function innerHeight(x, z) {
    const ridge = 1 - Math.abs(noise(x / 119, z / 119, salt ^ 44531) * 2 - 1);
    let height = 77 + (noise(x / 91, z / 91, salt ^ 48119) - 0.5) * 9 +
      (noise(x / 35, z / 35, salt ^ 59051) - 0.5) * 4 + ridge ** 3 * 9;
    for (const bowl of bowls) {
      const d = Math.hypot(x - bowl.x, z - bowl.z) / bowl.radius;
      height -= bowl.depth * (1 - ramp(d, 0.15, 1));
      height += bowl.rim * ramp(d, 0.6, 1) * (1 - ramp(d, 1, 1.55));
    }
    return height;
  }
  const spawnTop = Math.floor(innerHeight(0, 0));
  const pillars = Object.freeze(sites.map((site) => {
    const base = Math.floor(innerHeight(site.x, site.z));
    const top = base + 27 + Math.floor(roll(site.id, 43) * 25);
    return Object.freeze({
      ...site, generatorVersion: 7, dimension: "end", base, top,
      body: Object.freeze({
        block: B.OBSIDIAN, minY: base + 1, maxY: top + 1,
        columns: FOOTPRINT, columnMask: MASK, blockCount: FOOTPRINT.length * (top - base),
      }),
      cap: Object.freeze({ block: B.GLOWSTONE, x: site.x, y: top + 1, z: site.z }),
    });
  }));
  const plan = Object.freeze({ bowls, spawnTop, phase, centralReach: V7_END_LIMITS.centralReach });

  function central(x, z) {
    const radius = Math.hypot(x, z), angle = Math.atan2(z, x);
    const edge = 181 + noise(x / 91, z / 91, salt ^ 27551) * 24 +
      Math.sin(angle * 3 + phase) * 14 + Math.sin(angle * 5 - phase) * 7;
    let top = null, bottom = null;
    if (radius < edge) {
      let height = mix(spawnTop, innerHeight(x, z), ramp(radius, 8, 22));
      const rim = ramp(radius, edge - 48, edge);
      height = mix(height, 43 + noise(x / 43, z / 43, salt ^ 4703) * 4, rim);
      // Foundations are applied after the island's rim shaping, so even the
      // lowest outline lobe cannot shave a voxel off a pillar's support.
      for (const pillar of pillars) {
        const d = Math.hypot(x - pillar.x, z - pillar.z);
        height = mix(pillar.base, height, ramp(d, 6, 14));
      }
      top = Math.floor(height);
      // Connected columns with >=16 blocks under the bowls, not open shafts.
      // The outer rim narrows to five blocks without detached voxel platforms.
      bottom = Math.min(
        Math.floor(27 + noise(x / 87, z / 87, salt ^ 51767) * 9 + rim * 11),
        top - Math.ceil(mix(16, 5, rim))
      );
    }
    const id = top === null ? "the_void" : "the_end", profile = BIOME_PROFILES[id];
    return Object.freeze({
      x, z, id, profile, top, landTop: top, bottom, temperature: 0.5,
      moisture: 0, continental: 0, surface: profile.surface, soil: profile.soil,
      depth: 0, waterLevel: null, frozen: false, openings: EMPTY,
      surfaceOpen: false, treeSafe: false,
    });
  }
  return {
    sampleColumn(x, z) {
      if (!v5InBounds(x, z)) return frozen.sampleColumn(x, z);
      x = Math.floor(x); z = Math.floor(z);
      if (Math.hypot(x, z) >= V7_END_LIMITS.centralReach) return frozen.sampleColumn(x, z);
      counters.surfaceQueries++;
      const key = `${x},${z}`;
      if (columns.has(key)) return columns.get(key);
      counters.surfaceSamples++;
      return rememberV5(columns, key, central(x, z), V7_END_LIMITS.centralColumns);
    },
    getEndPillars: () => pillars,
    getEndTerrainPlan: () => plan,
    get cacheSizes() { return { ...frozen.cacheSizes, centralColumns: columns.size }; },
  };
}

export function writeV7EndLandmarks(bounds, writer, pillars, counters) {
  for (const pillar of pillars) {
    for (const [dx, dz] of pillar.body.columns) {
      const x = pillar.x + dx, z = pillar.z + dz;
      if (x < bounds.minX || x >= bounds.minX + bounds.width ||
          z < bounds.minZ || z >= bounds.minZ + bounds.depth) continue;
      counters.landmarkColumns++;
      for (let y = pillar.body.minY; y < pillar.body.maxY; y++)
        if (writer.put(x, y, z, pillar.body.block, { mode: "air" })) counters.landmarkWrites++;
      if (dx === 0 && dz === 0 &&
          writer.put(x, pillar.cap.y, z, pillar.cap.block, { mode: "air" }))
        counters.landmarkWrites++;
    }
  }
}
