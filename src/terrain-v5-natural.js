import { getBiomeById } from "./biomes.js";
import { BLOCK as B } from "./blocks.js";
import { hash, noise } from "./noise.js";
import { createV4Underground } from "./terrain-v4-underground.js";
import {
  rememberV5, V5_LAVA_LEVEL, V5_LIMITS, V5_NETHER_ROOF,
} from "./terrain-v5-config.js";

const STRATA = Object.freeze([
  B.TERRACOTTA, B.ORANGE_TERRACOTTA, B.ORANGE_TERRACOTTA, B.YELLOW_TERRACOTTA,
  B.TERRACOTTA, B.RED_TERRACOTTA, B.RED_TERRACOTTA, B.WHITE_TERRACOTTA,
  B.TERRACOTTA, B.ORANGE_TERRACOTTA, B.TERRACOTTA, B.YELLOW_TERRACOTTA,
]);
const wrap = (n, size) => ((n % size) + size) % size;

export function v5RockAt(col, y, salt) {
  if (y === -64 ||
    (y < -60 && hash(col.x, col.z, salt ^ Math.imul(y, 6173)) < (-60 - y) / 5))
    return B.BEDROCK;
  if (getBiomeById(col.id).category === "badlands" && y >= 54 &&
    y >= col.landTop - 72) {
    // A terracotta cap with exposed stone interbeds and a stone interior.
    // Bonus gold still replaces real stone; it never transmutes terracotta.
    const layer = Math.floor((y + col.strataOffset) / 2);
    if (col.landTop - y <= 10 || wrap(layer, 8) >= 3)
      return STRATA[wrap(layer, STRATA.length)];
  }
  // Current natural transition is Y=8..0, not the old snapshot -8..0.
  // Ordinary stone is absent at/below zero; non-rock cave/surface skins remain.
  const deep = y <= 0 ||
    (y < 8 && hash(col.x, col.z, salt ^ Math.imul(y + 19, 3253)) < (8 - y) / 8);
  return deep ? B.DEEPSLATE : B.STONE;
}

/**
 * One authoritative pre-ore column raster: base rock, real cave intervals,
 * aquifers, cave skins, Nether shelves/ceiling. Generation AND ore exposure use
 * these exact bytes. No decorated chunk, recursive neighbor generation, or
 * fictional "noise means air" predicate participates in exposure decisions.
 */
export function createV5Natural({ salt, dimension, spec, sampleColumn, counters }) {
  const cache = new Map();
  // These frozen v4 cave geometry/decorating functions are reused unchanged.
  // Never call their v4 oreAt/rockAt methods or modify their shared tables.
  const caves = createV4Underground(salt, counters);
  const height = spec.maxY - spec.minY;

  function overworld(blocks, col) {
    const { x, z, landTop } = col;
    const ceiling = Math.max(landTop, col.waterLevel ?? landTop);
    for (let y = spec.minY; y <= ceiling; y++) {
      counters.voxelVisits++;
      let id;
      if (y > landTop)
        id = col.frozen && y === spec.seaLevel &&
          noise(x / 17, z / 17, salt ^ 45007) > 0.15 ? B.ICE : B.WATER;
      else if (y === spec.minY) id = B.BEDROCK;
      else if (y === landTop) {
        id = col.surface;
        if (col.trench > 0.16 && y < -18 &&
          hash(Math.floor(x / 3), Math.floor(z / 3), salt ^ 15427) < 0.12)
          id = B.MAGMA_BLOCK;
      } else if (y >= landTop - 3) id = col.soil;
      else id = v5RockAt(col, y, salt);
      blocks[y - spec.minY] = id;
    }
    caves.carve({ blocks, at: (_x, y, _z) => y - spec.minY }, col);
  }

  function nether(blocks, col) {
    const { x, z, top, roof, profile } = col;
    const ceilingTip = roof -
      Math.floor(Math.max(0, noise(x / 17, z / 17, salt ^ 39439) - 0.56) * 29);
    const shelf = noise(x / 67, z / 67, salt ^ 43867);
    const shelfLow = 61 + Math.floor(noise(x / 29, z / 29, salt ^ 20849) * 9);
    const shelfHigh = shelfLow + 3 + Math.floor(shelf * 5);
    const glow = hash(Math.floor(x / 3), Math.floor(z / 3), salt ^ 2903) < 0.055;
    for (let y = 0; y <= V5_NETHER_ROOF; y++) {
      counters.voxelVisits++;
      let id = B.AIR;
      if (y === 0 || y === V5_NETHER_ROOF ||
        (y < 4 && hash(x, z, salt ^ Math.imul(y + 1, 6173)) < (4 - y) / 5) ||
        (y > 123 && hash(x, z, salt ^ Math.imul(y + 1, 2939)) < (y - 123) / 5))
        id = B.BEDROCK;
      else if (y >= ceilingTip) id = B.NETHERRACK;
      else if (y <= top)
        id = y === top ? col.surface : y >= top - 3 ? col.soil : profile.rock;
      else if (shelf > 0.72 && y >= shelfLow && y <= shelfHigh) id = profile.rock;
      else if (y <= V5_LAVA_LEVEL) id = B.LAVA;
      else if (glow && y >= ceilingTip - 2) id = B.GLOWSTONE;
      blocks[y] = id;
    }
  }

  function column(col) {
    const key = `${col.x},${col.z}`;
    if (cache.has(key)) return cache.get(key);
    counters.naturalColumns++;
    const blocks = new Uint16Array(height);
    if (dimension === "overworld") overworld(blocks, col);
    else if (dimension === "nether") nether(blocks, col);
    else if (col.top !== null)
      for (let y = col.bottom; y <= col.top; y++) {
        counters.voxelVisits++;
        blocks[y - spec.minY] = B.END_STONE;
      }
    return rememberV5(cache, key, blocks, V5_LIMITS.naturalColumns);
  }

  function blockAt(x, y, z) {
    counters.naturalQueries++;
    if (!Number.isSafeInteger(y) || y < spec.minY || y >= spec.maxY) return B.AIR;
    const col = sampleColumn(x, z);
    return col ? column(col)[y - spec.minY] : B.AIR;
  }

  return {
    blockAt,
    writeColumn(writer, col) {
      const blocks = column(col);
      for (let y = spec.minY; y < spec.maxY; y++) {
        counters.voxelVisits++;
        writer.blocks[writer.at(col.x, y, col.z)] = blocks[y - spec.minY];
      }
    },
    caves: (col) => caves.caves(col),
    get cacheSizes() {
      return { naturalColumns: cache.size, caves: caves.cacheSizes.caves };
    },
  };
}
