import { BLOCK } from "./blocks.js";
import { clamp, hash, mix, noise, seedHash, smooth } from "./noise.js";

export const LEGACY_MIN = -80;
export const LEGACY_MAX = 80;
export const LEGACY_HEIGHT = 64;
const SIZE = 160;
const LAYER = SIZE * SIZE;
const WATER_LEVEL = 15;
const index = (x, y, z) => y * LAYER + (z + 80) * SIZE + x + 80;
export const isLegacyColumn = (x, z) =>
  x >= LEGACY_MIN && x < LEGACY_MAX && z >= LEGACY_MIN && z < LEGACY_MAX;

// Frozen generator-v1 algorithm, extracted from the shipped finite World.
// Do not retune: saves contain deltas against these exact original voxels.
export function createLegacyTerrain(seedString) {
  let blocks;
  let heights;
  function generate() {
    if (blocks) return;
    blocks = new Uint8Array(LAYER * LEGACY_HEIGHT);
    heights = new Uint8Array(LAYER);
    const seed = seedHash(seedString);
    const caveX = new Float64Array(SIZE);
    const caveZ = new Float64Array(SIZE);
    const caveY = new Float64Array(LEGACY_HEIGHT);
    for (let i = 0; i < SIZE; i++) {
      caveX[i] = Math.sin((i + LEGACY_MIN) * 0.19 + (seed % 73));
      caveZ[i] = Math.cos((i + LEGACY_MIN) * 0.17);
    }
    for (let y = 0; y < LEGACY_HEIGHT; y++) caveY[y] = Math.sin(y * 0.35);

    for (let z = LEGACY_MIN; z < LEGACY_MAX; z++) {
      for (let x = LEGACY_MIN; x < LEGACY_MAX; x++) {
        const column = (z + 80) * SIZE + x + 80;
        const broad = noise(x / 34, z / 34, seed);
        const detail = noise(x / 11, z / 11, seed ^ 815);
        let height = 18 + broad * 8 + detail * 3;
        const north = smooth(clamp((-z - 17) / 38));
        const ridge = Math.max(
          0,
          1 - Math.abs(noise(x / 25, z / 27, seed ^ 9871) * 2 - 1)
        );
        height += north * (10 + ridge * 23);
        height += Math.max(0, Math.abs(x) - 49) * 0.19;
        const riverCenter = Math.sin(z * 0.055) * 8 + Math.sin(z * 0.11) * 3;
        const riverDistance = Math.abs(x - riverCenter);
        const riverWidth = 3.6 + Math.sin(z * 0.065) * 1.2;
        height = mix(
          11 + detail * 2,
          height,
          smooth(clamp((riverDistance - riverWidth) / 7))
        );
        const lakeDistance = Math.hypot((x + 8) / 1.35, z - 3);
        height = mix(
          11 + detail * 2,
          height,
          smooth(clamp((lakeDistance - 9) / 8))
        );
        const overlook = smooth(clamp(1 - Math.hypot(x - 21, z - 30) / 9));
        height = mix(height, 26, overlook);
        const top = clamp(Math.floor(height), 6, LEGACY_HEIGHT - 9);
        heights[column] = top;
        const beach = top <= WATER_LEVEL + 1;
        const rock = top >= 34;
        for (let y = 0; y <= Math.max(top, WATER_LEVEL); y++) {
          let id;
          if (y === 0) id = BLOCK.BEDROCK;
          else if (y > top) id = BLOCK.WATER;
          else if (y === top)
            id = beach
              ? BLOCK.SAND
              : top > 43
                ? BLOCK.SNOW
                : rock
                  ? BLOCK.STONE
                  : BLOCK.GRASS;
          else if (y > top - 4 && !rock) id = beach ? BLOCK.SAND : BLOCK.DIRT;
          else if (
            y > 3 &&
            y < top - 5 &&
            caveX[x + 80] + caveZ[z + 80] + caveY[y] > 2.22
          )
            id = BLOCK.AIR;
          else
            id =
              hash(x + y * 177, z - y * 53, seed) < 0.035
                ? BLOCK.COAL_ORE
                : BLOCK.STONE;
          blocks[y * LAYER + column] = id;
        }
      }
    }
    for (let z = LEGACY_MIN + 4; z < LEGACY_MAX - 4; z += 6) {
      for (let x = LEGACY_MIN + 4; x < LEGACY_MAX - 4; x += 6) {
        const chance = hash(x, z, seed ^ 913);
        if (chance > 0.62) continue;
        const tx = x + Math.floor(hash(x, z, seed ^ 84) * 3);
        const tz = z + Math.floor(hash(x, z, seed ^ 17) * 3);
        const top = heights[(tz + 80) * SIZE + tx + 80];
        if (
          Math.hypot(tx - 21, tz - 30) < 11 ||
          (tz > 4 && tz < 31 && tx > 12 && tx < 29)
        )
          continue;
        if (
          blocks[index(tx, top, tz)] !== BLOCK.GRASS ||
          top < WATER_LEVEL + 3 ||
          top > 32
        )
          continue;
        const birch = chance < 0.19;
        const trunk = birch ? BLOCK.BIRCH_LOG : BLOCK.OAK_LOG;
        const leaves = birch ? BLOCK.BIRCH_LEAVES : BLOCK.LEAVES;
        const crown = top + (birch ? 6 : 4) + (chance < 0.3 ? 1 : 0);
        for (let y = top + 1; y <= crown; y++) blocks[index(tx, y, tz)] = trunk;
        for (let dy = -2; dy <= 1; dy++) {
          const radius = dy === 1 ? 1 : 2;
          for (let dz = -radius; dz <= radius; dz++) {
            for (let dx = -radius; dx <= radius; dx++) {
              if (
                Math.abs(dx) === radius &&
                Math.abs(dz) === radius &&
                dy !== -1
              )
                continue;
              const at = index(tx + dx, crown + dy, tz + dz);
              if (blocks[at] === BLOCK.AIR) blocks[at] = leaves;
            }
          }
        }
      }
    }
    for (let z = LEGACY_MIN; z < LEGACY_MAX; z++) {
      for (let x = LEGACY_MIN; x < LEGACY_MAX; x++) {
        const top = heights[(z + 80) * SIZE + x + 80];
        const chance = hash(x, z, seed ^ 7103);
        if (
          chance < 0.019 &&
          blocks[index(x, top, z)] === BLOCK.GRASS &&
          blocks[index(x, top + 1, z)] === BLOCK.AIR
        )
          blocks[index(x, top + 1, z)] =
            chance < 0.009 ? BLOCK.RED_FLOWER : BLOCK.YELLOW_FLOWER;
      }
    }
  }

  function copyRegion(minX, minZ, width, depth, target) {
    if (
      minX >= LEGACY_MAX ||
      minZ >= LEGACY_MAX ||
      minX + width <= LEGACY_MIN ||
      minZ + depth <= LEGACY_MIN
    )
      return;
    generate();
    const layer = width * depth;
    const targetHeight = target.length / layer;
    for (let z = 0; z < depth; z++)
      for (let x = 0; x < width; x++) {
        const wx = minX + x,
          wz = minZ + z;
        if (!isLegacyColumn(wx, wz)) continue;
        for (let y = 0; y < targetHeight; y++)
          target[y * layer + z * width + x] =
            y < LEGACY_HEIGHT ? blocks[index(wx, y, wz)] : BLOCK.AIR;
      }
  }

  return {
    get blocks() {
      generate();
      return blocks;
    },
    terrainHeight(x, z) {
      generate();
      return isLegacyColumn(x, z)
        ? heights[(Math.floor(z) + 80) * SIZE + Math.floor(x) + 80]
        : -1;
    },
    copyRegion,
    copyChunk(cx, cz, target) {
      copyRegion(cx * 16, cz * 16, 16, 16, target);
    },
    getSpawn: () => ({ x: 21.5, y: 27.01, z: 30.5 }),
  };
}
