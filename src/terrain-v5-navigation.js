import { getBiomeById } from "./biomes.js";
import { BLOCK as B, isSolid } from "./blocks.js";
import { hash, squareSpiral } from "./noise.js";
import { v4CaveBiome } from "./terrain-v4-underground.js";
import { readV4RegionCell } from "./terrain-v4-writer.js";
import {
  rememberV5, V5_LIMITS, V5_TREE_SPACING, v5InBounds,
} from "./terrain-v5-config.js";

const DIRECTIONS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const safeAir = (id) => !isSolid(id) && id !== B.WATER && id !== B.LAVA;
const safeFloor = (id) => isSolid(id) &&
  ![B.CACTUS, B.MAGMA_BLOCK, B.ICE, B.PACKED_ICE, B.BLUE_ICE].includes(id);

/**
 * Explicit searches may generate bounded validation regions. HUD/LOD field
 * queries never call these searches. Fail exhaustion honestly, never manufacture
 * a spawn platform, plant emergency trees or teleport into a guessed cave.
 */
export function createV5Navigation({
  dimension, salt, spec, sampleColumn, generateRegion, vegetation, counters,
  forDimension,
}) {
  const locators = new Map();
  let naturalSpawn;

  function landingAt(col) {
    if (!col || col.top === null) return null;
    const y = col.top + 1;
    if (y < spec.minY + 1 || y + 1 >= spec.maxY) return null;
    const generated = generateRegion(col.x - 1, col.z - 1, 3, 3);
    const id = (height) => readV4RegionCell(generated, col.x, height, col.z)?.id;
    return safeFloor(id(y - 1)) && safeAir(id(y)) && safeAir(id(y + 1))
      ? { x: col.x + 0.5, y: y + 0.01, z: col.z + 0.5 } : null;
  }

  function reachableWood(col) {
    const gx = Math.floor(col.x / V5_TREE_SPACING);
    const gz = Math.floor(col.z / V5_TREE_SPACING);
    const candidates = [];
    for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++)
      for (const tree of vegetation.getTrees(gx + dx, gz + dz)) {
        const distance = Math.hypot(tree.x - col.x, tree.z - col.z);
        if (tree.type !== "mushroom" && distance >= 6 && distance <= 26)
          candidates.push([tree, distance]);
      }
    candidates.sort((a, b) => a[1] - b[1]);
    for (const [tree] of candidates) {
      let x = col.x, z = col.z, previous = col, safe = true;
      while (Math.abs(x - tree.x) + Math.abs(z - tree.z) > 1) {
        if (x !== tree.x) x += Math.sign(tree.x - x);
        else z += Math.sign(tree.z - z);
        const next = sampleColumn(x, z);
        if (!next || next.waterLevel !== null || !next.treeSafe ||
          Math.abs(next.top - previous.top) > 1) {
          safe = false;
          break;
        }
        previous = next;
      }
      if (safe) return tree;
    }
    return null;
  }

  function nativeWoodAccessible(col, tree) {
    const minX = Math.min(col.x, tree.x) - 4, minZ = Math.min(col.z, tree.z) - 4;
    const width = Math.abs(col.x - tree.x) + 9, depth = Math.abs(col.z - tree.z) + 9;
    const region = generateRegion(minX, minZ, width, depth);
    const block = (x, y, z) => readV4RegionCell(region, x, y, z)?.id;
    if (block(tree.x, tree.ground + 1, tree.z) !== tree.wood) return false;
    const queue = [[col.x, col.z]], visited = new Set([`${col.x},${col.z}`]);
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const [x, z] = queue[cursor], top = sampleColumn(x, z).top;
      if (Math.abs(x - tree.x) + Math.abs(z - tree.z) <= 1 &&
        Math.abs(tree.ground - top) <= 2) return true;
      for (const [dx, dz] of DIRECTIONS) {
        const nx = x + dx, nz = z + dz, key = `${nx},${nz}`;
        if (visited.has(key) || nx < minX || nx >= minX + width ||
          nz < minZ || nz >= minZ + depth) continue;
        const next = sampleColumn(nx, nz);
        if (!next || next.waterLevel !== null || Math.abs(next.top - top) > 1 ||
          !safeFloor(block(nx, next.top, nz)) ||
          !safeAir(block(nx, next.top + 1, nz)) ||
          !safeAir(block(nx, next.top + 2, nz))) continue;
        visited.add(key);
        queue.push([nx, nz]);
      }
    }
    return false;
  }

  function getSpawn() {
    if (naturalSpawn) return { ...naturalSpawn };
    if (dimension === "end") {
      for (const [dx, dz] of squareSpiral(4)) {
        const point = landingAt(sampleColumn(dx * 4, dz * 4));
        if (point) {
          naturalSpawn = Object.freeze(point);
          return { ...point };
        }
      }
    } else {
      const startX = Math.floor((hash(0, 0, salt ^ 18119) - 0.5) * 96);
      const startZ = Math.floor((hash(0, 0, salt ^ 22621) - 0.5) * 96);
      const spacing = dimension === "overworld" ? 24 : 16;
      let validations = 0;
      for (const [dx, dz] of squareSpiral(96)) {
        counters.spawnCandidates++;
        const col = sampleColumn(startX + dx * spacing, startZ + dz * spacing);
        if (!col || col.top === null || !col.treeSafe || col.waterLevel !== null) continue;
        let wood;
        if (dimension === "nether") {
          if (col.top <= 33 || col.roof - col.top < 5) continue;
        } else {
          if (col.top < 66 || col.top > 180 || col.profile.bamboo ||
            !["forest", "grassland", "taiga", "savanna", "snowy", "mountain"]
              .includes(getBiomeById(col.id).category)) continue;
          const flat = DIRECTIONS.every(([x, z]) => {
            const near = sampleColumn(col.x + x * 2, col.z + z * 2);
            return near && near.treeSafe && near.waterLevel === null &&
              Math.abs(near.top - col.top) <= 1;
          });
          if (!flat) continue;
          wood = reachableWood(col);
          if (!wood) continue;
        }
        if (++validations > 96) break;
        const point = landingAt(col);
        if (point && (!wood || nativeWoodAccessible(col, wood))) {
          naturalSpawn = Object.freeze(point);
          return { ...point };
        }
      }
    }
    throw new Error(`No natural safe ${dimension} spawn found in the bounded origin search`);
  }

  function locatePoint(col, id) {
    if (id === "the_void")
      return { x: col.x + 0.5, y: 80.01, z: col.z + 0.5, dimension };
    const target = getBiomeById(id), region = generateRegion(col.x, col.z, 1, 1);
    const block = (y) => y < spec.minY || y >= spec.maxY ? B.AIR : region.blocks[y - spec.minY];
    if (target.category === "cave") {
      for (let y = spec.minY + 5; y < col.landTop - 3; y++)
        if (v4CaveBiome(col, y, salt) === id && safeFloor(block(y - 1)) &&
          safeAir(block(y)) && safeAir(block(y + 1)))
          return { x: col.x + 0.5, y: y + 0.01, z: col.z + 0.5, dimension };
      return null;
    }
    const ceiling = dimension === "nether" ? col.roof - 2 : spec.maxY - 2;
    const waterY = dimension === "overworld" && col.waterLevel !== null
      ? spec.seaLevel + 1 : spec.minY;
    for (let y = ceiling; y >= Math.max(spec.minY + 1, waterY); y--)
      if ((safeFloor(block(y - 1)) || (y === waterY && col.waterLevel !== null)) &&
        safeAir(block(y)) && safeAir(block(y + 1)))
        return { x: col.x + 0.5, y: y + 0.01, z: col.z + 0.5, dimension };
    return null;
  }

  function locateBiome(id, from = { x: 0, z: 0 }) {
    const target = getBiomeById(id);
    if (!target || !from || !v5InBounds(from.x, from.z)) return null;
    if (target.dimension !== dimension)
      return forDimension(target.dimension).locateBiome(id, from);
    const key = `${id}:${Math.floor(from.x / 96)},${Math.floor(from.z / 96)}`;
    if (locators.has(key)) {
      const cached = locators.get(key);
      return cached ? { ...cached } : null;
    }
    if (id === "the_end") return locatePoint(sampleColumn(0, 0), id);
    let validations = 0;
    const cave = target.category === "cave";
    for (const [dx, dz] of squareSpiral(64)) {
      const x = Math.floor(from.x / 96) * 96 + dx * 96 + (dz % 2 ? 29 : 0);
      const z = Math.floor(from.z / 96) * 96 + dz * 96;
      counters.locatorSamples++;
      const col = sampleColumn(x, z);
      if (!col) continue;
      if (cave) {
        if (![-48, -12, 20, 52, 92, 140].some(
          (y) => y < col.top - 4 && v4CaveBiome(col, y, salt) === id
        )) continue;
      } else if (col.id !== id) continue;
      const point = locatePoint(col, id);
      if (point) {
        rememberV5(locators, key, Object.freeze(point), V5_LIMITS.locators);
        return { ...point };
      }
      if (++validations >= 64) break;
    }
    rememberV5(locators, key, null, V5_LIMITS.locators);
    return null;
  }
  return { getSpawn, locateBiome, get cacheSize() { return locators.size; } };
}
