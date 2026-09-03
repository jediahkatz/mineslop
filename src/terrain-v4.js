import { BIOME_INDEX, getBiomeById } from "./biomes.js";
import { BLOCK as B, isSolid } from "./blocks.js";
import { hash, noise, seedHash, squareSpiral } from "./noise.js";
import {
  newV4Counters,
  remember,
  V4_LAVA_LEVEL,
  V4_LIMITS,
  V4_NETHER_ROOF,
  V4_SPECS,
  V4_TREE_SPACING,
  v4InBounds,
} from "./terrain-v4-config.js";
import { requireTerrainV4Content } from "./terrain-v4-content.js";
import { createV4Decorators } from "./terrain-v4-decorators.js";
import { createV4Field } from "./terrain-v4-field.js";
import { createV4Marine } from "./terrain-v4-marine.js";
import { createV4Underground, v4CaveBiome } from "./terrain-v4-underground.js";
import { createV4Vegetation } from "./terrain-v4-vegetation.js";
import { createV4Writer, readV4RegionCell } from "./terrain-v4-writer.js";

const EMPTY = Object.freeze([]);
const DIRECTIONS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
const safeAir = (id) => !isSolid(id) && id !== B.WATER && id !== B.LAVA;
const safeFloor = (id) =>
  isSolid(id) &&
  ![B.CACTUS, B.MAGMA_BLOCK, B.ICE, B.PACKED_ICE, B.BLUE_ICE].includes(id);

function checkRegion(minX, minZ, width, depth) {
  if (
    ![minX, minZ, width, depth, minX + width, minZ + depth].every(
      Number.isSafeInteger
    ) ||
    width < 1 ||
    depth < 1 ||
    width > V4_LIMITS.regionSide ||
    depth > V4_LIMITS.regionSide
  )
    throw new RangeError(
      "Terrain regions require integer dimensions of 1–64 blocks"
    );
}

/**
 * Original v4 natural terrain, not Minecraft seed parity.
 *
 * sampleColumn/surfaceYAt/getBiome/getTrees are non-generating. Only explicit
 * generation, spawn validation, cave diagnostics and biome-location validation
 * evaluate underground cells. Structure decorators are optional and absent by
 * default at this low-level seam. createGenerator installs the frozen native
 * all-family manifest; neither path materializes loot or gameplay ownership.
 */
export function createTerrainV4(
  seed = "cedar-valley",
  dimension = "overworld",
  { decorators = [] } = {}
) {
  if (!Object.hasOwn(V4_SPECS, dimension))
    throw new RangeError("Unknown dimension");
  requireTerrainV4Content();
  const seedString = String(seed).slice(0, 80);
  const salt = seedHash(seedString);
  const spec = V4_SPECS[dimension];
  const counters = newV4Counters();
  const field = createV4Field(salt, dimension, counters);
  const { sampleColumn } = field;
  const underground = createV4Underground(salt, counters);
  const vegetation = createV4Vegetation({
    salt,
    dimension,
    spec,
    sampleColumn,
    counters,
  });
  const marine =
    dimension === "overworld"
      ? createV4Marine({ salt, sampleColumn, counters })
      : null;
  const decorate = createV4Decorators(
    decorators,
    { seed: seedString, salt, dimension, spec, sampleColumn },
    counters
  );
  const otherDimensions = new Map();
  const locators = new Map();
  let naturalSpawn;
  let lastGenerationWork = null;

  function overworldColumn(writer, col) {
    const { x, z, landTop } = col;
    const ceiling = Math.max(landTop, col.waterLevel ?? landTop);
    for (let y = spec.minY; y <= ceiling; y++) {
      counters.voxelVisits++;
      let id;
      if (y > landTop) {
        id =
          col.frozen &&
          y === spec.seaLevel &&
          noise(x / 17, z / 17, salt ^ 45007) > 0.15
            ? B.ICE
            : B.WATER;
      } else if (y === spec.minY) id = B.BEDROCK;
      else if (y === landTop) {
        id = col.surface;
        if (
          col.trench > 0.16 &&
          y < -18 &&
          hash(Math.floor(x / 3), Math.floor(z / 3), salt ^ 15427) < 0.12
        )
          id = B.MAGMA_BLOCK;
      } else if (y >= landTop - 3) id = col.soil;
      else {
        id = underground.rockAt(col, y);
        id = underground.oreAt(x, y, z, id, col);
      }
      writer.blocks[writer.at(x, y, z)] = id;
    }
    underground.carve(writer, col);
  }

  function netherColumn(writer, col) {
    const { x, z, top, roof, profile } = col;
    const ceilingGrowth = noise(x / 17, z / 17, salt ^ 39439);
    const ceilingTip =
      roof - Math.floor(Math.max(0, ceilingGrowth - 0.56) * 29);
    const shelf = noise(x / 67, z / 67, salt ^ 43867);
    const shelfLow = 61 + Math.floor(noise(x / 29, z / 29, salt ^ 20849) * 9);
    const shelfHigh = shelfLow + 3 + Math.floor(shelf * 5);
    const glow =
      hash(Math.floor(x / 3), Math.floor(z / 3), salt ^ 2903) < 0.055;
    for (let y = 0; y <= V4_NETHER_ROOF; y++) {
      counters.voxelVisits++;
      let id = B.AIR;
      if (
        y === 0 ||
        y === V4_NETHER_ROOF ||
        (y < 4 && hash(x, z, salt ^ Math.imul(y + 1, 6173)) < (4 - y) / 5) ||
        (y > 123 && hash(x, z, salt ^ Math.imul(y + 1, 2939)) < (y - 123) / 5)
      )
        id = B.BEDROCK;
      else if (y >= ceilingTip) id = B.NETHERRACK;
      else if (y <= top) {
        id = y === top ? col.surface : y >= top - 3 ? col.soil : profile.rock;
        if (y < top - 3) id = underground.oreAt(x, y, z, id, col, true);
      } else if (shelf > 0.72 && y >= shelfLow && y <= shelfHigh)
        id = profile.rock;
      else if (y <= V4_LAVA_LEVEL) id = B.LAVA;
      else if (glow && y >= ceilingTip - 2) id = B.GLOWSTONE;
      writer.blocks[writer.at(x, y, z)] = id;
    }
    // [128,256) is intentionally buildable air, not another natural roof.
  }

  function endColumn(writer, col) {
    if (col.top === null) return;
    for (let y = col.bottom; y <= col.top; y++) {
      counters.voxelVisits++;
      writer.blocks[writer.at(col.x, y, col.z)] = B.END_STONE;
    }
  }

  function buildRegion(minX, minZ, width, depth, chunk) {
    checkRegion(minX, minZ, width, depth);
    const bounds = { minX, minZ, width, depth };
    const writer = createV4Writer({ ...bounds, spec, counters });
    const columns = new Array(width * depth);
    const biomes = new Uint8Array(width * depth).fill(BIOME_INDEX.the_void);
    for (let z = minZ; z < minZ + depth; z++)
      for (let x = minX; x < minX + width; x++) {
        const at = (z - minZ) * width + x - minX;
        const col = sampleColumn(x, z);
        if (!col) continue;
        columns[at] = col;
        biomes[at] = BIOME_INDEX[col.id];
        if (dimension === "overworld") overworldColumn(writer, col);
        else if (dimension === "nether") netherColumn(writer, col);
        else endColumn(writer, col);
      }
    vegetation.decorate(bounds, writer);
    marine?.decorate(bounds, writer);
    for (const col of columns) {
      if (!col || col.top === null) continue;
      vegetation.groundCover(col, writer.put);
      marine?.plants(col, writer.put);
    }
    const structures = decorate(bounds, writer);
    return {
      ...writer.finish(chunk),
      biomes,
      ...(structures.length ? { structures } : {}),
      ...(chunk ? {} : bounds),
    };
  }

  function recordGeneration(before, width, depth) {
    lastGenerationWork = Object.freeze({
      width,
      depth,
      ...Object.fromEntries(
        Object.keys(counters).map((key) => [key, counters[key] - before[key]])
      ),
    });
  }

  function generateRegion(minX, minZ, width = 16, depth = 16) {
    const before = { ...counters };
    counters.regionGenerations++;
    const result = buildRegion(minX, minZ, width, depth, false);
    recordGeneration(before, width, depth);
    return result;
  }

  function generateChunk(cx, cz) {
    if (![cx, cz, cx * 16, cz * 16].every(Number.isSafeInteger))
      throw new RangeError("Chunk coordinates must be safe integers");
    const before = { ...counters };
    counters.chunkGenerations++;
    const result = { cx, cz, ...buildRegion(cx * 16, cz * 16, 16, 16, true) };
    recordGeneration(before, 16, 16);
    return result;
  }

  function surfaceYAt(x, z) {
    return sampleColumn(x, z)?.top ?? null;
  }

  function getBiome(x, z, y) {
    const col = sampleColumn(x, z);
    if (!col) return getBiomeById("the_void");
    if (
      dimension === "overworld" &&
      Number.isFinite(y) &&
      y >= spec.minY + 5 &&
      y < col.top - 4
    )
      return getBiomeById(v4CaveBiome(col, y, salt));
    return getBiomeById(col.id);
  }

  function landingAt(col) {
    if (!col || col.top === null) return null;
    const y = col.top + 1;
    if (y < spec.minY + 1 || y + 1 >= spec.maxY) return null;
    const generated = generateRegion(col.x - 1, col.z - 1, 3, 3);
    const id = (height) =>
      readV4RegionCell(generated, col.x, height, col.z)?.id;
    if (!safeFloor(id(y - 1)) || !safeAir(id(y)) || !safeAir(id(y + 1)))
      return null;
    return { x: col.x + 0.5, y: y + 0.01, z: col.z + 0.5 };
  }

  function reachableWood(col) {
    const gx = Math.floor(col.x / V4_TREE_SPACING);
    const gz = Math.floor(col.z / V4_TREE_SPACING);
    const candidates = [];
    for (let dz = -3; dz <= 3; dz++)
      for (let dx = -3; dx <= 3; dx++)
        for (const tree of vegetation.getTrees(gx + dx, gz + dz)) {
          const distance = Math.hypot(tree.x - col.x, tree.z - col.z);
          if (tree.type !== "mushroom" && distance >= 6 && distance <= 26)
            candidates.push([tree, distance]);
        }
    candidates.sort((a, b) => a[1] - b[1]);
    for (const [tree] of candidates) {
      let x = col.x;
      let z = col.z;
      let previous = col;
      let safe = true;
      // A cardinal route with <=1-block rises is traversable with normal jumps;
      // do not count a log across a river or atop an inaccessible cliff.
      while (Math.abs(x - tree.x) + Math.abs(z - tree.z) > 1) {
        if (x !== tree.x) x += Math.sign(tree.x - x);
        else z += Math.sign(tree.z - z);
        const next = sampleColumn(x, z);
        if (
          !next ||
          next.waterLevel !== null ||
          !next.treeSafe ||
          Math.abs(next.top - previous.top) > 1
        ) {
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
    const minX = Math.min(col.x, tree.x) - 4;
    const minZ = Math.min(col.z, tree.z) - 4;
    const width = Math.abs(col.x - tree.x) + 9;
    const depth = Math.abs(col.z - tree.z) + 9;
    const region = generateRegion(minX, minZ, width, depth);
    const block = (x, y, z) => readV4RegionCell(region, x, y, z)?.id;
    if (block(tree.x, tree.ground + 1, tree.z) !== tree.wood) return false;
    const queue = [[col.x, col.z]];
    const visited = new Set([`${col.x},${col.z}`]);
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const [x, z] = queue[cursor];
      const top = sampleColumn(x, z).top;
      if (
        Math.abs(x - tree.x) + Math.abs(z - tree.z) <= 1 &&
        Math.abs(tree.ground - top) <= 2
      )
        return true;
      for (const [dx, dz] of DIRECTIONS) {
        const nx = x + dx;
        const nz = z + dz;
        const key = `${nx},${nz}`;
        if (
          visited.has(key) ||
          nx < minX ||
          nx >= minX + width ||
          nz < minZ ||
          nz >= minZ + depth
        )
          continue;
        const next = sampleColumn(nx, nz);
        if (
          !next ||
          next.waterLevel !== null ||
          Math.abs(next.top - top) > 1 ||
          !safeFloor(block(nx, next.top, nz)) ||
          !safeAir(block(nx, next.top + 1, nz)) ||
          !safeAir(block(nx, next.top + 2, nz))
        )
          continue;
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
        if (
          !col ||
          col.top === null ||
          !col.treeSafe ||
          col.waterLevel !== null
        )
          continue;
        let wood;
        if (dimension === "nether") {
          if (col.top <= 33 || col.roof - col.top < 5) continue;
        } else {
          if (
            col.top < 66 ||
            col.top > 180 ||
            col.profile.bamboo ||
            ![
              "forest",
              "grassland",
              "taiga",
              "savanna",
              "snowy",
              "mountain",
            ].includes(getBiomeById(col.id).category)
          )
            continue;
          const flat = DIRECTIONS.every(([x, z]) => {
            const near = sampleColumn(col.x + x * 2, col.z + z * 2);
            return (
              near &&
              near.treeSafe &&
              near.waterLevel === null &&
              Math.abs(near.top - col.top) <= 1
            );
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
    throw new Error(
      `No natural safe ${dimension} spawn found in the bounded origin search`
    );
  }

  function locatePoint(col, id) {
    if (id === "the_void")
      return { x: col.x + 0.5, y: 80.01, z: col.z + 0.5, dimension };
    const target = getBiomeById(id);
    const region = generateRegion(col.x, col.z, 1, 1);
    const block = (y) =>
      y < spec.minY || y >= spec.maxY ? B.AIR : region.blocks[y - spec.minY];
    if (target.category === "cave") {
      for (let y = spec.minY + 5; y < col.landTop - 3; y++)
        if (
          v4CaveBiome(col, y, salt) === id &&
          safeFloor(block(y - 1)) &&
          safeAir(block(y)) &&
          safeAir(block(y + 1))
        )
          return { x: col.x + 0.5, y: y + 0.01, z: col.z + 0.5, dimension };
      return null;
    }
    const ceiling = dimension === "nether" ? col.roof - 2 : spec.maxY - 2;
    const waterY =
      dimension === "overworld" && col.waterLevel !== null
        ? spec.seaLevel + 1
        : spec.minY;
    for (let y = ceiling; y >= Math.max(spec.minY + 1, waterY); y--)
      if (
        (safeFloor(block(y - 1)) ||
          (y === waterY && col.waterLevel !== null)) &&
        safeAir(block(y)) &&
        safeAir(block(y + 1))
      )
        return { x: col.x + 0.5, y: y + 0.01, z: col.z + 0.5, dimension };
    return null;
  }

  function locateBiome(id, from = { x: 0, z: 0 }) {
    const target = getBiomeById(id);
    if (!target || !from || !v4InBounds(from.x, from.z)) return null;
    if (target.dimension !== dimension) {
      if (!otherDimensions.has(target.dimension))
        otherDimensions.set(
          target.dimension,
          createTerrainV4(seedString, target.dimension, { decorators })
        );
      return otherDimensions.get(target.dimension).locateBiome(id, from);
    }
    const key = `${id}:${Math.floor(from.x / 96)},${Math.floor(from.z / 96)}`;
    if (locators.has(key)) {
      const cached = locators.get(key);
      return cached ? { ...cached } : null;
    }
    if (id === "the_end") return locatePoint(sampleColumn(0, 0), id);
    let validations = 0;
    const cave = target.category === "cave";
    for (const [dx, dz] of squareSpiral(64)) {
      // A staggered grid avoids aligning every sample with the biome cell grid.
      const x = Math.floor(from.x / 96) * 96 + dx * 96 + (dz % 2 ? 29 : 0);
      const z = Math.floor(from.z / 96) * 96 + dz * 96;
      counters.locatorSamples++;
      const col = sampleColumn(x, z);
      if (!col) continue;
      if (cave) {
        const possible = [-48, -12, 20, 52, 92, 140].some(
          (y) => y < col.top - 4 && v4CaveBiome(col, y, salt) === id
        );
        if (!possible) continue;
      } else if (col.id !== id) continue;
      const point = locatePoint(col, id);
      if (point) {
        remember(locators, key, Object.freeze(point), V4_LIMITS.locators);
        return { ...point };
      }
      // Validation may construct terrain; cap it independently of cheap probes.
      if (++validations >= 64) break;
    }
    remember(locators, key, null, V4_LIMITS.locators);
    return null;
  }

  return {
    seed: seedString,
    dimension,
    generatorVersion: 4,
    spec,
    minY: spec.minY,
    maxY: spec.maxY,
    seaLevel: spec.seaLevel,
    generateChunk,
    generateRegion,
    sampleColumn,
    surfaceYAt,
    terrainHeight: surfaceYAt,
    getBiome,
    getSpawn,
    locateBiome,
    getTrees: vegetation.getTrees,
    getMarineFeatures: (gx, gz) => marine?.getFeatures(gx, gz) ?? EMPTY,
    getCaveIntervals: (x, z) => {
      const col = sampleColumn(x, z);
      return dimension === "overworld" && col
        ? underground.caves(col).map((interval) => [...interval])
        : [];
    },
    get counters() {
      return { ...counters };
    },
    get cacheSizes() {
      return {
        ...field.cacheSizes,
        ...underground.cacheSizes,
        trees: vegetation.cacheSize,
        marine: marine?.cacheSize ?? 0,
        locators: locators.size,
        dimensions: otherDimensions.size,
      };
    },
    get lastGenerationWork() {
      return lastGenerationWork;
    },
    get cavePlanCacheSize() {
      return underground.cacheSizes.caves;
    },
    get locatorSamples() {
      return counters.locatorSamples;
    },
  };
}
