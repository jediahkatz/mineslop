import { BIOME_INDEX, BIOME_PROFILES, BIOMES, getBiomeById } from "./biomes.js";
import { BLOCK as B, BLOCKS, isSolid } from "./blocks.js";
import { findNaturalSpawn, shapeOverworld } from "./landforms.js";
import { createLegacyTerrain, isLegacyColumn } from "./legacy-terrain.js";
import {
  clamp,
  fractal,
  hash,
  mix,
  noise,
  seedHash,
  smooth,
  squareSpiral,
} from "./noise.js";
import { sampleCaveIntervals } from "./terrain-cave-field.js";
import { carveEntrance, createCaveGenerator } from "./terrain-caves.js";
import {
  carveCaves,
  caveId,
  oceanId,
  oreCell,
  selectRegionBiome,
  strata,
  sulfurPocket,
} from "./terrain-profiles.js";
import { treeClearsCaves } from "./terrain-tree-clearance.js";
import {
  createTreeGenerator,
  TREE_REACH as FEATURE_REACH,
  TREE_SPACING as FEATURE_SPACING,
  writeTree,
} from "./terrain-trees.js";
import { createTerrainV4 } from "./terrain-v4.js";
import {
  getNativeV4Decorators,
  V4_GENERATION_MANIFEST,
} from "./terrain-v4-manifest.js";
import { createTerrainV5 } from "./terrain-v5.js";
import {
  getNativeV5Decorators,
  V5_GENERATION_MANIFEST,
} from "./terrain-v5-manifest.js";

export { BIOMES, getBiomeById } from "./biomes.js";
export const WORLD_MIN = -30000000;
export const WORLD_MAX = 30000000;
export const WORLD_HEIGHT = 96;
export const CHUNK_SIZE = 16;
export const WATER_LEVEL = 24;
export const GENERATOR_VERSION = 3;
const REGION_SIZE = 224;
const LOCATOR_RINGS = 36;
const validXZ = (x, z) =>
  Number.isFinite(x) &&
  Number.isFinite(z) &&
  x >= WORLD_MIN &&
  x < WORLD_MAX &&
  z >= WORLD_MIN &&
  z < WORLD_MAX;

export function createGenerator(
  seed = "cedar-valley",
  dimension = "overworld",
  generatorVersion = GENERATOR_VERSION
) {
  const seedString = String(seed).slice(0, 80);
  if (!["overworld", "nether", "end"].includes(dimension))
    throw new RangeError("Unknown dimension");
  if (generatorVersion === 4) {
    const generator = createTerrainV4(seedString, dimension, {
      // createTerrainV4 supplies its raw, non-generating field sampler to every
      // descriptor. Do not build a second generator or sample decorated cells.
      decorators: getNativeV4Decorators(),
    });
    Object.defineProperty(generator, "generationManifest", {
      value: V4_GENERATION_MANIFEST,
      enumerable: true,
    });
    return generator;
  }
  if (generatorVersion === 5) {
    const generator = createTerrainV5(seedString, dimension, {
      decorators: getNativeV5Decorators(),
    });
    Object.defineProperty(generator, "generationManifest", {
      value: V5_GENERATION_MANIFEST,
      enumerable: true,
    });
    return generator;
  }
  if (![1, 2, 3].includes(generatorVersion))
    throw new RangeError("Unknown generator version");
  const salt = seedHash(seedString);
  const naturalLandforms = generatorVersion >= 3 && dimension === "overworld";
  let naturalSpawn;
  const legacy =
    generatorVersion === 1 && dimension === "overworld"
      ? createLegacyTerrain(seedString)
      : null;
  const regions = new Map();
  const columns = new Map();
  const surfaces = new Map();
  const otherDimensions = new Map();
  const atlases = new Map();
  const phase = (salt % 997) / 71;
  const surfaceCaves = naturalLandforms
    ? createCaveGenerator({
        salt,
        surface: surfaceColumn,
        waterLevel: WATER_LEVEL,
        validXZ,
      })
    : null;

  function region(gx, gz) {
    const key = `${gx},${gz}`;
    if (regions.has(key)) return regions.get(key);
    const x =
      (gx + 0.5 + (hash(gx, gz, salt ^ 7187) - 0.5) * 0.64) * REGION_SIZE;
    const z =
      (gz + 0.5 + (hash(gx, gz, salt ^ 2333) - 0.5) * 0.64) * REGION_SIZE;
    const temperature = clamp(
      0.5 + (noise(x / 830, z / 830, salt ^ 8617) - 0.5) * 1.8
    );
    const moisture = noise(x / 620, z / 620, salt ^ 1889);
    const continental = fractal(x / 710, z / 710, salt ^ 4001);
    const variant = hash(gx, gz, salt ^ 3191);
    const id = selectRegionBiome(
      dimension,
      temperature,
      moisture,
      continental,
      variant
    );
    const result = {
      x,
      z,
      id,
      temperature,
      moisture,
      profile: BIOME_PROFILES[id],
    };
    if (regions.size >= 4096) regions.delete(regions.keys().next().value);
    regions.set(key, result);
    return result;
  }

  function regional(x, z) {
    const wx = x + (noise(x / 280, z / 280, salt ^ 1283) - 0.5) * 84;
    const wz = z + (noise(x / 280, z / 280, salt ^ 1993) - 0.5) * 84;
    const gx = Math.floor(wx / REGION_SIZE);
    const gz = Math.floor(wz / REGION_SIZE);
    let nearest,
      minimum = Infinity;
    const candidates = [];
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++) {
        const candidate = region(gx + dx, gz + dz);
        const distance = Math.hypot(wx - candidate.x, wz - candidate.z);
        candidates.push([candidate, distance]);
        if (distance < minimum) {
          minimum = distance;
          nearest = candidate;
        }
      }
    let height = 0,
      relief = 0,
      weight = 0,
      ocean = 0;
    for (const [candidate, distance] of candidates) {
      const w = smooth(clamp(1 - (distance - minimum) / 74));
      height += candidate.profile.height * w;
      relief += candidate.profile.relief * w;
      ocean += (getBiomeById(candidate.id).category === "ocean" ? 1 : 0) * w;
      weight += w;
    }
    return {
      nearest,
      height: height / weight,
      relief: relief / weight,
      ocean: ocean / weight,
    };
  }

  // A separate bounded sampler lets cave planning inspect dry banks and
  // hillsides without recursively constructing neighboring cave columns.
  function surfaceColumn(x, z, field) {
    x = Math.floor(x);
    z = Math.floor(z);
    const key = `${x},${z}`;
    if (surfaces.has(key)) return surfaces.get(key);
    field ??= regional(x, z);
    const shaped = shapeOverworld(x, z, field, salt, WATER_LEVEL);
    const result = {
      x,
      z,
      id: shaped.id,
      top: clamp(Math.floor(shaped.height), 5, 86),
      profile: BIOME_PROFILES[shaped.id],
      temperature: shaped.temperature,
    };
    result.sulfur = sulfurPocket(result, field, salt);
    if (surfaces.size >= 8192) surfaces.delete(surfaces.keys().next().value);
    surfaces.set(key, result);
    return result;
  }

  function endColumn(x, z) {
    const radius = Math.hypot(x, z);
    const detail = noise(x / 41, z / 41, salt ^ 4703);
    let id = "the_void",
      top = -1,
      bottom = 0;
    if (radius < 156) {
      id = "the_end";
      top = Math.floor(43 + detail * 5 - Math.max(0, radius - 85) * 0.31);
      bottom = Math.max(
        5,
        top - Math.floor(28 * clamp((156 - radius) / 45)) - 3
      );
    } else if (radius > 295) {
      const island = fractal(x / 170, z / 170, salt ^ 6971);
      if (island > 0.63) {
        id = "end_highlands";
        top = Math.floor(44 + (island - 0.63) * 55 + detail * 4);
      } else if (island > 0.52) {
        id = "end_midlands";
        top = Math.floor(32 + (island - 0.52) * 110 + detail * 3);
      } else if (island > 0.46) {
        id = "end_barrens";
        top = Math.floor(24 + (island - 0.46) * 125);
      } else if (noise(x / 47, z / 47, salt ^ 9181) > 0.77) {
        id = "small_end_islands";
        top = Math.floor(26 + detail * 7);
      }
      bottom =
        top < 0
          ? 0
          : Math.max(
              4,
              top -
                (id === "small_end_islands"
                  ? 5
                  : Math.floor((island - 0.43) * 70 + 4))
            );
    }
    return {
      x,
      z,
      id,
      top,
      bottom,
      profile: BIOME_PROFILES[id],
      temperature: 0.5,
      caves: [],
      roof: 96,
    };
  }

  function column(x, z) {
    x = Math.floor(x);
    z = Math.floor(z);
    const key = `${x},${z}`;
    if (columns.has(key)) return columns.get(key);
    let result;
    if (dimension === "end") result = endColumn(x, z);
    else {
      const field = regional(x, z);
      let id = field.nearest.id;
      let temperature = field.nearest.temperature;
      const detail = noise(x / 53, z / 53, salt ^ 2851);
      let height =
        field.height +
        (detail - 0.5) * field.relief * 1.8 +
        (noise(x / 17, z / 17, salt ^ 739) - 0.5) * 2;
      if (id === "desert")
        height +=
          Math.sin(x * 0.12 + noise(x / 94, z / 94, salt ^ 193) * 7) * 3;
      if (id === "eroded_badlands")
        height += noise(x / 21, z / 21, salt ^ 1913) ** 3 * 22;
      if (
        id === "badlands" ||
        id === "wooded_badlands" ||
        id === "savanna_plateau"
      )
        height = mix(height, Math.round(height / 4) * 4, 0.7);
      let waterCut = 0;
      if (naturalLandforms) {
        const surface = surfaceColumn(x, z, field);
        height = surface.top;
        id = surface.id;
        temperature = surface.temperature;
      } else if (dimension === "overworld") {
        const riverDistance = Math.abs(
          noise(x / 235, z / 235, salt ^ 3571) - 0.5
        );
        waterCut = 1 - smooth(clamp((riverDistance - 0.013) / 0.038));
        const lake = smooth(
          clamp((noise(x / 145, z / 145, salt ^ 6311) - 0.76) / 0.11)
        );
        if (field.ocean < 0.4 && getBiomeById(id).category !== "swamp")
          height = mix(height, 19 + detail * 2, Math.max(waterCut, lake));
        const scenic = smooth(clamp(1 - Math.hypot(x - 21, z - 30) / 145));
        if (scenic > 0) {
          const north = smooth(clamp((-z - 8) / 90));
          const valley = 32 + detail * 7 + north * 24;
          height = mix(height, valley, scenic);
          const stream = Math.abs(x + 7 - Math.sin(z * 0.035) * 8);
          const streamBank = smooth(clamp((stream - 5) / 10));
          const lakeBank = smooth(
            clamp((Math.hypot((x + 7) / 1.3, z - 4) - 17) / 12)
          );
          const bank = Math.min(streamBank, lakeBank);
          height = mix(height, mix(19 + detail * 2, valley, bank), scenic);
          if (scenic > 0.45) {
            id = noise(x / 78, z / 78, salt ^ 913) > 0.46 ? "forest" : "plains";
            temperature = 0.6;
            waterCut = 1 - bank;
          }
          const overlook = smooth(clamp(1 - Math.hypot(x - 21, z - 30) / 13));
          height = mix(height, 31, overlook);
        }
        const low = Math.floor(height);
        const swamp = getBiomeById(id).category === "swamp";
        if (!swamp && low < WATER_LEVEL - 1) {
          id =
            field.ocean > 0.5 && scenic < 0.45
              ? oceanId(temperature, low < 11)
              : temperature < 0.23
                ? "frozen_river"
                : "river";
        } else if (
          !swamp &&
          low <= WATER_LEVEL + 2 &&
          (field.ocean > 0.1 || waterCut > 0.15)
        ) {
          id =
            temperature < 0.23
              ? "snowy_beach"
              : field.relief > 10
                ? "stony_shore"
                : "beach";
        }
      } else {
        const channels = Math.abs(noise(x / 170, z / 170, salt ^ 5527) - 0.5);
        height = mix(16, height, smooth(clamp((channels - 0.017) / 0.045)));
      }
      const top = clamp(Math.floor(height), 5, naturalLandforms ? 86 : 80);
      const caveHumidity = noise(x / 270, z / 270, salt ^ 6491);
      const caves = naturalLandforms
        ? sampleCaveIntervals(x, z, top, salt, WATER_LEVEL)
        : [];
      if (
        !naturalLandforms &&
        dimension === "overworld" &&
        top > WATER_LEVEL + 2
      ) {
        // Saved v1/v2 worlds retain the original field and decoration exactly.
        const caveShape = noise(x / 91, z / 91, salt ^ 3371);
        const lower =
          9 + Math.sin(x * 0.021 + phase) * 2 + Math.cos(z * 0.025) * 2;
        const upper =
          18 + caveShape * 9 + Math.sin(x * 0.014 + z * 0.008 + phase) * 4;
        const worm = Math.abs(
          Math.sin(x * 0.036 + phase) + Math.cos(z * 0.031)
        );
        if (worm < 0.85)
          caves.push([
            Math.max(4, Math.floor(lower - 3)),
            Math.min(top - 5, Math.floor(lower + 3)),
          ]);
        if (caveShape > 0.35)
          caves.push([
            Math.max(13, Math.floor(upper - 4 - caveShape * 3)),
            Math.min(top - 5, Math.floor(upper + 4 + caveShape * 2)),
          ]);
      }
      result = {
        x,
        z,
        id,
        top,
        bottom: 0,
        profile: BIOME_PROFILES[id],
        temperature,
        caves,
        caveHumidity,
        naturalCaves: naturalLandforms,
        caveGrowth: naturalLandforms ? noise(x / 13, z / 13, salt ^ 8849) : 0,
        strataOffset: Math.floor(noise(x / 180, z / 180, salt ^ 1811) * 3),
        roof: 78 + Math.floor(noise(x / 95, z / 95, salt ^ 1861) * 8),
      };
      if (dimension === "overworld" && !(legacy && isLegacyColumn(x, z)))
        result.sulfur = sulfurPocket(result, field, salt);
      if (surfaceCaves) Object.assign(result, surfaceCaves.column(result));
    }
    if (columns.size >= 8192) columns.delete(columns.keys().next().value);
    columns.set(key, result);
    return result;
  }

  function getBiome(x, z, y) {
    if (!validXZ(x, z)) return getBiomeById("the_void");
    if (legacy && isLegacyColumn(x, z)) {
      const height = legacy.terrainHeight(x, z);
      return getBiomeById(
        height < 15
          ? "river"
          : height < 17
            ? "beach"
            : height > 43
              ? "jagged_peaks"
              : height >= 34
                ? "windswept_hills"
                : "forest"
      );
    }
    const col = naturalLandforms ? surfaceColumn(x, z) : column(x, z);
    if (
      dimension === "overworld" &&
      Number.isFinite(y) &&
      y >= 1 &&
      (y < col.top - 4 ||
        (col.sulfur && y < col.top - 3 && caveId(col, y) === "sulfur_caves"))
    )
      return getBiomeById(
        caveId(
          naturalLandforms
            ? {
                ...col,
                caveHumidity: noise(col.x / 270, col.z / 270, salt ^ 6491),
              }
            : col,
          y
        )
      );
    return getBiomeById(col.id);
  }
  function terrainHeight(x, z) {
    if (!validXZ(x, z)) return -1;
    if (naturalLandforms) return surfaceColumn(x, z).top;
    return legacy && isLegacyColumn(x, z)
      ? legacy.terrainHeight(x, z)
      : column(x, z).top;
  }
  const trees = createTreeGenerator({
    salt,
    dimension,
    version: generatorVersion,
    column,
    surfaceColumn: naturalLandforms ? surfaceColumn : column,
    isTreeEligible: surfaceCaves
      ? (tree) => treeClearsCaves(tree, column, surfaceCaves.getFeatures)
      : undefined,
    getSpawn,
    waterLevel: WATER_LEVEL,
    validXZ,
  });

  // A wider bounded region is useful for offline maps and tests. Both paths use
  // identical world-coordinate anchors; clipping never changes feature ownership.
  function generateRegion(minX, minZ, width = 16, depth = 16) {
    if (
      ![minX, minZ, width, depth].every(Number.isInteger) ||
      width < 1 ||
      depth < 1 ||
      width > 64 ||
      depth > 64
    )
      throw new RangeError(
        "Terrain region must have integer dimensions of 1–64 blocks"
      );
    const layer = width * depth;
    const blocks = new Uint8Array(layer * WORLD_HEIGHT);
    const biomes = new Uint8Array(layer);
    const heightmap = new Array(layer);
    const oreCache = new Map();
    const at = (x, y, z) => y * layer + (z - minZ) * width + x - minX;
    function put(x, y, z, id, replaceWater = false) {
      if (
        x < minX ||
        z < minZ ||
        x >= minX + width ||
        z >= minZ + depth ||
        y < 1 ||
        y >= WORLD_HEIGHT ||
        !validXZ(x, z)
      )
        return;
      const col = heightmap[(z - minZ) * width + x - minX];
      if (col?.caveMouth && y >= col.entrance.low && y <= col.entrance.high)
        return;
      const i = at(x, y, z),
        previous = blocks[i];
      if (
        previous === B.AIR ||
        BLOCKS[previous].shape === "cross" ||
        BLOCKS[previous].texture === "leaves" ||
        (replaceWater && (previous === B.WATER || previous === B.ICE))
      )
        blocks[i] = id;
    }
    for (let z = minZ; z < minZ + depth; z++)
      for (let x = minX; x < minX + width; x++) {
        const index = (z - minZ) * width + x - minX;
        if (!validXZ(x, z)) {
          biomes[index] = BIOME_INDEX.the_void;
          continue;
        }
        const col = column(x, z),
          { top, profile } = col;
        heightmap[index] = col;
        biomes[index] = BIOME_INDEX[col.id];
        if (top < 0) continue;
        const strataProfile = getBiomeById(col.id).category === "badlands";
        const caveNoise = hash(x, z, salt ^ 5861);
        let oreColumn;
        if (dimension === "overworld") {
          const gx = Math.floor(x / 4),
            gz = Math.floor(z / 4),
            key = `${gx},${gz}`;
          oreColumn = oreCache.get(key);
          if (!oreColumn) {
            oreColumn = new Uint8Array(24);
            for (let gy = 0; gy < 24; gy++)
              oreColumn[gy] = oreCell(gx, gy, gz, salt);
            oreCache.set(key, oreColumn);
          }
        }
        const ceiling =
          dimension === "end"
            ? top
            : dimension === "nether"
              ? 95
              : Math.max(WATER_LEVEL, top);
        for (let y = col.bottom; y <= ceiling; y++) {
          let id = B.AIR;
          if (dimension !== "end" && y === 0) id = B.BEDROCK;
          else if (dimension === "nether" && y >= col.roof)
            id = y === 95 ? B.BEDROCK : B.NETHERRACK;
          else if (y > top) {
            if (dimension === "overworld" && y <= WATER_LEVEL)
              id =
                y === WATER_LEVEL && col.temperature < 0.23 ? B.ICE : B.WATER;
            else if (dimension === "nether" && y <= 20) id = B.LAVA;
          } else if (y === top) {
            id = profile.surface;
            if (col.id === "jagged_peaks" && hash(x, z, salt ^ 233) < 0.45)
              id = B.STONE;
            if (col.id === "frozen_peaks" && y > 63) id = B.PACKED_ICE;
            if (col.id === "windswept_hills" && y > 49) id = B.STONE;
          } else if (y >= top - 3)
            id = strataProfile
              ? strata[(y + col.strataOffset) % strata.length]
              : profile.soil;
          else {
            id =
              strataProfile && y > 18
                ? strata[(y + col.strataOffset) % strata.length]
                : profile.rock;
            if (dimension === "overworld") {
              if (
                id === B.STONE &&
                oreColumn[Math.floor(y / 4)] !== B.STONE &&
                hash(x + y * 17, z - y * 11, salt ^ 9001) < 0.57
              )
                id = oreColumn[Math.floor(y / 4)];
              id = carveCaves(id, col, y, caveNoise);
            }
          }
          if (col.entrance && y > 0 && y <= top) id = carveEntrance(id, col, y);
          if (
            dimension === "nether" &&
            y === col.roof - 1 &&
            hash(Math.floor(x / 3), Math.floor(z / 3), salt ^ 2903) < 0.05
          )
            id = B.GLOWSTONE;
          blocks[y * layer + index] = id;
        }
      }
    function trunk(x, y, z, height, id, wide = false) {
      for (let dy = 1; dy <= height; dy++)
        for (let dz = 0; dz <= (wide ? 1 : 0); dz++)
          for (let dx = 0; dx <= (wide ? 1 : 0); dx++)
            put(x + dx, y + dy, z + dz, id, true);
    }
    for (
      let gz = Math.floor((minZ - FEATURE_REACH) / FEATURE_SPACING);
      gz <= Math.floor((minZ + depth - 1 + FEATURE_REACH) / FEATURE_SPACING);
      gz++
    ) {
      for (
        let gx = Math.floor((minX - FEATURE_REACH) / FEATURE_SPACING);
        gx <= Math.floor((minX + width - 1 + FEATURE_REACH) / FEATURE_SPACING);
        gx++
      ) {
        const x =
          gx * FEATURE_SPACING + 1 + Math.floor(hash(gx, gz, salt ^ 1129) * 6);
        const z =
          gz * FEATURE_SPACING + 1 + Math.floor(hash(gx, gz, salt ^ 1879) * 6);
        if (!validXZ(x, z)) continue;
        const col = column(x, z),
          chance = hash(gx, gz, salt ^ 2713);
        if (col.caveMouth) continue;
        const biome = getBiomeById(col.id);
        writeTree(trees.primary(x, z, col, chance), put);
        if (col.id === "ice_spikes" && chance < 0.38) {
          const height = 9 + Math.floor(chance * 34);
          for (let dy = 0; dy < height; dy++) {
            const r = dy < height * 0.4 ? 2 : dy < height * 0.8 ? 1 : 0;
            for (let dz = -r; dz <= r; dz++)
              for (let dx = -r; dx <= r; dx++)
                if (Math.abs(dx) + Math.abs(dz) <= r + 1)
                  put(x + dx, col.top + dy + 1, z + dz, B.PACKED_ICE);
          }
        }
        if (
          biome.category === "ocean" &&
          biome.temperature < 0.1 &&
          chance < 0.13
        ) {
          const height = 6 + Math.floor(chance * 65);
          for (let dy = -8; dy < height; dy++) {
            const r = Math.max(1, 4 - Math.floor(Math.max(0, dy) / 3));
            for (let dz = -r; dz <= r; dz++)
              for (let dx = -r; dx <= r; dx++)
                if (dx * dx + dz * dz <= r * r + 1)
                  put(
                    x + dx,
                    WATER_LEVEL + dy,
                    z + dz,
                    dy < -2 ? B.BLUE_ICE : B.PACKED_ICE,
                    true
                  );
          }
        }
        if (col.id === "basalt_deltas" && chance < 0.65) {
          const height = 3 + Math.floor(chance * 17);
          trunk(x, col.top, z, height, B.BASALT, true);
        }
        if (col.id === "soul_sand_valley" && chance < 0.085 && col.top > 20)
          for (let i = -3; i <= 3; i++) {
            put(x + i, col.top + 1, z, B.MUSHROOM_STEM);
            if (i % 2 === 0)
              for (let dy = 1; dy < 4; dy++)
                put(x + i, col.top + dy, z + 1, B.MUSHROOM_STEM);
          }
        if (
          (col.id === "end_highlands" && chance < 0.38) ||
          (col.id === "end_midlands" && chance < 0.07)
        ) {
          trunk(x, col.top, z, 3 + Math.floor(chance * 10), B.CHORUS);
          for (const direction of [-1, 1]) {
            put(x + direction, col.top + 3, z, B.CHORUS);
            put(x + direction * 2, col.top + 4, z, B.CHORUS);
          }
          if (chance < 0.012) trunk(x, col.top, z, 3, B.PURPUR, true);
        }
        writeTree(trees.mushroom(x, z, col, chance), put);
      }
    }
    if (dimension === "end") {
      for (let i = 0; i < 10; i++) {
        const angle = (i * Math.PI) / 5 + phase * 0.03;
        const x = Math.round(Math.cos(angle) * 58),
          z = Math.round(Math.sin(angle) * 58);
        if (
          x + 3 < minX ||
          x - 3 >= minX + width ||
          z + 3 < minZ ||
          z - 3 >= minZ + depth
        )
          continue;
        const base = column(x, z).top,
          height = 20 + (i % 4) * 5;
        for (let dz = -2; dz <= 2; dz++)
          for (let dx = -2; dx <= 2; dx++) {
            if (dx * dx + dz * dz > 5) continue;
            for (let y = base; y <= base + height; y++)
              put(x + dx, y, z + dz, B.OBSIDIAN);
          }
        put(x, base + height + 1, z, B.GLOWSTONE);
      }
    }
    for (let z = minZ; z < minZ + depth; z++)
      for (let x = minX; x < minX + width; x++) {
        const col = heightmap[(z - minZ) * width + x - minX];
        if (!col || col.top < 0 || col.caveMouth || dimension !== "overworld")
          continue;
        const { top, id } = col,
          chance = hash(x, z, salt ^ 3199),
          biome = getBiomeById(id);
        if (top < WATER_LEVEL - 1) {
          if (id === "warm_ocean" && chance < 0.13) {
            put(x, top + 1, z, B.CORAL, true);
            if (chance < 0.04) put(x, top + 2, z, B.CORAL, true);
          } else if (chance < 0.14) put(x, top + 1, z, B.SEAGRASS, true);
          if (biome.category === "swamp" && chance < 0.12)
            put(x, WATER_LEVEL + 1, z, B.LILY_PAD);
        } else if (
          (biome.category === "desert" || biome.category === "badlands") &&
          id !== "wooded_badlands"
        ) {
          if (chance < 0.009)
            for (let dy = 1; dy <= 2 + Math.floor(chance * 250); dy++)
              put(x, top + dy, z, B.CACTUS);
          else if (chance < 0.045) put(x, top + 1, z, B.DEAD_BUSH);
        } else if (
          biome.category === "jungle" &&
          col.profile.bamboo &&
          chance < col.profile.bamboo
        ) {
          for (let dy = 1; dy <= 5 + Math.floor(chance * 26); dy++)
            put(x, top + dy, z, B.BAMBOO);
        } else if (
          col.profile.surface === B.GRASS ||
          col.profile.surface === B.MOSS ||
          col.profile.surface === B.PODZOL
        ) {
          let plant;
          if (id === "cherry_grove" && chance < 0.25) plant = B.PINK_PETALS;
          else if (id === "sunflower_plains" && chance < 0.2)
            plant = B.SUNFLOWER;
          else if (biome.category === "jungle" && chance < 0.003)
            plant = B.MELON;
          else if (chance < col.profile.flowers)
            plant =
              chance < col.profile.flowers / 2 ? B.RED_FLOWER : B.YELLOW_FLOWER;
          else if (chance < 0.14)
            plant =
              biome.category === "taiga" || id === "old_growth_birch_forest"
                ? B.FERN
                : B.TALL_GRASS;
          if (plant) put(x, top + 1, z, plant);
        }
        if (biome.category === "shore" && chance < 0.014) {
          for (let dy = 1; dy < 4; dy++) put(x, top + dy, z, B.SUGAR_CANE);
        }
      }
    if (legacy) {
      legacy.copyRegion(minX, minZ, width, depth, blocks);
      for (let z = 0; z < depth; z++)
        for (let x = 0; x < width; x++) {
          if (isLegacyColumn(minX + x, minZ + z))
            biomes[z * width + x] =
              BIOME_INDEX[getBiome(minX + x, minZ + z).id];
        }
    }
    return { blocks, biomes };
  }

  function generateChunk(cx, cz) {
    if (!Number.isInteger(cx) || !Number.isInteger(cz))
      throw new RangeError("Chunk coordinates must be integers");
    const result = generateRegion(cx * 16, cz * 16);
    return { cx, cz, ...result };
  }

  function safePoint(id, x, z) {
    const chunks = new Map();
    function block(wx, y, wz) {
      if (y < 0 || y >= WORLD_HEIGHT) return B.AIR;
      const cx = Math.floor(wx / 16),
        cz = Math.floor(wz / 16),
        key = `${cx},${cz}`;
      if (!chunks.has(key)) chunks.set(key, generateChunk(cx, cz));
      return chunks.get(key).blocks[
        y * 256 + (wz - cz * 16) * 16 + wx - cx * 16
      ];
    }
    for (const [dx, dz] of [
      [0, 0],
      [3, 0],
      [-3, 0],
      [0, 3],
      [0, -3],
      [6, 6],
      [-6, -6],
    ]) {
      const px = Math.floor(x) + dx,
        pz = Math.floor(z) + dz;
      if (!validXZ(px, pz)) continue;
      const col = column(px, pz),
        biome = getBiomeById(id);
      if (id === "the_void" && col.id === id)
        return { x: px + 0.5, y: 48.01, z: pz + 0.5, dimension };
      if (biome.category === "cave") {
        for (let y = 5; y < col.top - 5; y++) {
          if (
            getBiome(px, pz, y).id === id &&
            isSolid(block(px, y - 1, pz)) &&
            block(px, y, pz) === B.AIR &&
            block(px, y + 1, pz) === B.AIR
          )
            return { x: px + 0.5, y: y + 0.01, z: pz + 0.5, dimension };
        }
      } else if (getBiome(px, pz).id === id) {
        if (dimension === "nether") {
          for (let y = Math.max(22, col.top + 1); y < col.roof - 2; y++) {
            if (
              isSolid(block(px, y - 1, pz)) &&
              !isSolid(block(px, y, pz)) &&
              !isSolid(block(px, y + 1, pz))
            )
              return { x: px + 0.5, y: y + 0.01, z: pz + 0.5, dimension };
          }
        } else {
          let y = WORLD_HEIGHT - 3;
          while (y > 0 && !isSolid(block(px, y - 1, pz))) y--;
          y = Math.max(
            y,
            dimension === "overworld" && col.top <= WATER_LEVEL
              ? WATER_LEVEL + 1
              : 1
          );
          if (
            getBiome(px, pz, y).id === id &&
            !isSolid(block(px, y, pz)) &&
            !isSolid(block(px, y + 1, pz))
          )
            return { x: px + 0.5, y: y + 0.01, z: pz + 0.5, dimension };
        }
      }
    }
    return null;
  }

  function locateBiome(id, from = { x: 0, z: 0 }) {
    const target = getBiomeById(id);
    if (!target || !from || !validXZ(from.x, from.z)) return null;
    if (target.dimension !== dimension) {
      if (!otherDimensions.has(target.dimension))
        otherDimensions.set(
          target.dimension,
          createGenerator(
            seedString,
            target.dimension,
            generatorVersion === 1 ? 2 : generatorVersion
          )
        );
      return otherDimensions.get(target.dimension).locateBiome(id, from);
    }
    if (id === "the_end") return safePoint(id, 0, 0);
    if (id === "the_void") return safePoint(id, 205, 0);
    const gx = Math.floor(from.x / REGION_SIZE),
      gz = Math.floor(from.z / REGION_SIZE),
      key = `${gx},${gz}`;
    let atlas = atlases.get(key);
    if (!atlas) {
      function* samples() {
        for (const [dx, dz] of squareSpiral(LOCATOR_RINGS)) {
          const center = region(gx + dx, gz + dz);
          for (const [ox, oz] of [
            [0, 0],
            [-76, -76],
            [76, -76],
            [-76, 76],
            [76, 76],
            [-38, 0],
            [38, 0],
            [0, -38],
            [0, 38],
          ])
            yield [Math.floor(center.x + ox), Math.floor(center.z + oz)];
        }
      }
      atlas = {
        points: new Map(),
        pending: new Map(),
        scan: samples(),
        examined: 0,
        done: false,
      };
      if (atlases.size >= 3) atlases.delete(atlases.keys().next().value);
      atlases.set(key, atlas);
    }
    const cached = atlas.points.get(id);
    if (cached) return { ...cached };
    function record(candidateId, x, z) {
      if (atlas.points.has(candidateId)) return;
      if (!atlas.pending.has(candidateId)) atlas.pending.set(candidateId, []);
      atlas.pending.get(candidateId).push([x, z]);
    }
    function resolvePending() {
      const pending = atlas.pending.get(id) ?? [];
      for (const [x, z] of pending) {
        const point = safePoint(id, x, z);
        if (point) {
          atlas.points.set(id, point);
          atlas.pending.delete(id);
          return { ...point };
        }
      }
      atlas.pending.delete(id);
      return null;
    }
    const pendingPoint = resolvePending();
    if (pendingPoint) return pendingPoint;
    while (!atlas.done) {
      const next = atlas.scan.next();
      if (next.done) {
        atlas.done = true;
        break;
      }
      const [x, z] = next.value;
      atlas.examined++;
      if (!validXZ(x, z)) continue;
      const col = column(x, z);
      record(getBiome(x, z).id, x, z);
      if (dimension === "overworld" && !(legacy && isLegacyColumn(x, z))) {
        const caveIds = new Set();
        if (col.sulfur) caveIds.add("sulfur_caves");
        for (const [low, high] of col.caves) {
          if (high - low < (naturalLandforms ? 2 : 3)) continue;
          for (const y of [low + 1, high - 1]) caveIds.add(caveId(col, y));
        }
        for (const candidateId of caveIds) record(candidateId, x, z);
      }
      const point = resolvePending();
      if (point) return point;
    }
    return null;
  }

  function getSpawn() {
    if (legacy) return legacy.getSpawn();
    if (naturalLandforms) {
      naturalSpawn ??= findNaturalSpawn(
        surfaceColumn,
        WATER_LEVEL,
        salt,
        (point) => !column(point.x, point.z).caveMouth
      );
      return { ...naturalSpawn };
    }
    if (dimension === "end") {
      const point = safePoint("the_end", 0, 0);
      return { x: point.x, y: point.y, z: point.z };
    }
    const x = 21,
      z = 30;
    if (dimension === "overworld")
      return { x: x + 0.5, y: terrainHeight(x, z) + 1.01, z: z + 0.5 };
    const point = locateBiome("nether_wastes", { x, z });
    return point
      ? { x: point.x, y: point.y, z: point.z }
      : { x: 21.5, y: 40.01, z: 30.5 };
  }
  return {
    generateChunk,
    getBiome,
    terrainHeight,
    getSpawn,
    getTrees: trees.getTrees,
    getCaveEntrances: (gx, gz) => surfaceCaves?.getFeatures(gx, gz) ?? [],
    locateBiome,
    generateRegion,
    get cavePlanCacheSize() {
      return surfaceCaves?.cacheSize ?? 0;
    },
    // Bounded counters are useful for asserting atlas latency without timing-flaky tests.
    get locatorSamples() {
      return [...atlases.values()].reduce(
        (sum, atlas) => sum + atlas.examined,
        0
      );
    },
  };
}
