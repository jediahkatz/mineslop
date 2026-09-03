import { getBiomeById } from "./biomes.js";
import { BLOCK as B } from "./blocks.js";
import { clamp, hash, seedHash } from "./noise.js";
import { v4CaveBiome } from "./terrain-v4-underground.js";
import {
  rememberV5, V5_LIMITS, V5_MAX_XZ, V5_MIN_XZ,
} from "./terrain-v5-config.js";

const CELL = 8;
const DIRECTIONS = Object.freeze([
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
].map(Object.freeze));
const triangle = (y, low, peak, high) =>
  clamp(Math.min((y - low) / (peak - low), (high - y) / (high - peak)));
const badlands = (col) => getBiomeById(col.id).category === "badlands";
export const v5MountainOres = (col) =>
  getBiomeById(col.id).category === "mountain" ||
  (col.mountain > 0.55 && col.landTop >= 128 && !badlands(col));

// Separate seeded occurrence, cardinally connected deposit size and air rules.
// Upper bounds are exclusive. These are original tuning constants, NOT vanilla
// feature code or universal vanilla ore percentages.
export const V5_ORES = Object.freeze([
  ["coal", 0, 320, 8, 20, 0],
  ["iron", -64, 320, 4, 10, 0],
  ["copper", -16, 112, 6, 18, 0],
  ["gold", -64, 256, 3, 8, 0.35],
  ["redstone", -64, 16, 4, 9, 0],
  ["lapis", -64, 64, 3, 7, 0.25],
  ["diamond", -64, 16, 2, 7, 0.75],
  ["emerald", -16, 320, 1, 3, 0],
  ["nether_quartz", 8, 120, 6, 14, 0],
  ["nether_gold", 8, 120, 3, 8, 0],
  ["ancient_debris", 8, 120, 1, 3, 1],
].map(([name, minY, maxY, minSize, maxSize, airDiscard]) => Object.freeze({
  name, minY, maxY, minSize, maxSize, airDiscard,
  salt: seedHash(`mineslop/v5/ore/${name}`),
  rare: name === "emerald" || name === "ancient_debris",
  nether: name.startsWith("nether_") || name === "ancient_debris",
  block: B[name === "ancient_debris" ? "ANCIENT_DEBRIS" : `${name.toUpperCase()}_ORE`],
  deepBlock: B[`DEEPSLATE_${name.toUpperCase()}_ORE`],
})));

export function v5OreChance(ore, y, col, salt) {
  if (!col || y < ore.minY || y >= ore.maxY) return 0;
  switch (ore.name) {
    case "coal":
      return 0.45 * triangle(y, 0, 96, 192) + (y >= 136 ? 0.20 : 0);
    case "iron":
      // The low background overlaps the upper mountain distribution: no
      // artificial 88–120 iron-free band when actual high rock exists.
      return (y <= 96 ? 0.075 : 0) + 0.36 * triangle(y, -24, 16, 56) +
        0.50 * triangle(y, 64, 232, 384);
    case "copper":
      return 0.50 * triangle(y, -16, 48, 112) *
        (v4CaveBiome(col, y, salt) === "dripstone_caves" ? 1.9 : 1);
    case "gold":
      return 0.27 * triangle(y, -64, -16, 32) +
        (badlands(col) && y >= 32 ? 0.58 : 0);
    case "diamond": return 0.23 * clamp((16 - y) / 80);
    case "redstone": return 0.16 + 0.22 * clamp((-y - 16) / 48);
    case "lapis": return 0.035 + 0.18 * triangle(y, -64, 0, 64);
    case "emerald":
      return v5MountainOres(col) ? 0.085 * triangle(y, -16, 232, 320) : 0;
    case "nether_quartz": return 0.44;
    case "nether_gold": return col.id === "basalt_deltas" ? 0.42 : 0.30;
    case "ancient_debris": return 0.0028 + 0.055 * triangle(y, 8, 16, 40);
    default: return 0;
  }
}

export const v5OreAcceptsHost = (ore, rock) => ore.nether
  ? rock === B.NETHERRACK || rock === B.BLACKSTONE
  : rock === B.STONE || rock === B.DEEPSLATE;

function depositShape(size, reach, random) {
  const points = [[0, 0, 0]], frontier = [];
  const seen = new Set(["0,0,0"]);
  const expand = ([x, y, z]) => {
    for (const [dx, dy, dz] of DIRECTIONS) {
      const point = [x + dx, y + dy, z + dz];
      if (point.some((n) => Math.abs(n) > reach)) continue;
      const key = point.join(",");
      if (seen.has(key)) continue;
      seen.add(key);
      frontier.push(point);
    }
  };
  expand(points[0]);
  // At most 24 growth steps and 6 frontier offers per selected cell.
  while (points.length < size && frontier.length) {
    const at = Math.floor(random(100 + points.length) * frontier.length);
    const [point] = frontier.splice(at, 1);
    points.push(point);
    expand(point);
  }
  return Int8Array.from(points.flat());
}

export function createV5Ores({ salt, dimension, spec, sampleColumn, natural, counters }) {
  const cache = new Map();
  const ores = dimension === "end" ? []
    : V5_ORES.filter((ore) => ore.nether === (dimension === "nether"));

  function describe(ore, gx, gy, gz) {
    const key = `${ore.name}:${gx},${gy},${gz}`;
    if (cache.has(key)) return cache.get(key);
    counters.oreCells++;
    const channel = salt ^ ore.salt ^ Math.imul(gy + 131, 3529);
    const random = (label) => hash(gx, gz, channel ^ Math.imul(label + 1, 46439));
    // Rare deposits stay separated, with no neighboring 30-block blobs.
    // A column-owner-specific Y phase avoids artificial global empty Y planes.
    const phase = ore.rare ? Math.floor(hash(gx, gz, salt ^ ore.salt ^ 6197) * CELL) : 0;
    const offset = (label) => ore.rare ? 2 + Math.floor(random(label) * 4)
      : Math.floor(random(label) * CELL);
    const x = gx * CELL + offset(1), y = gy * CELL + phase + offset(2);
    const z = gz * CELL + offset(3), col = sampleColumn(x, z);
    let deposit = null;
    if (random(0) < v5OreChance(ore, y, col, salt)) {
      const maximum = ore.name === "copper" &&
        v4CaveBiome(col, y, salt) === "dripstone_caves" ? 24 : ore.maxSize;
      const roll = ore.rare ? random(4) ** 2 : random(4);
      const size = ore.minSize + Math.floor(roll * (maximum - ore.minSize + 1));
      deposit = {
        x, y, z, points: depositShape(size, ore.rare ? 1 : V5_LIMITS.depositReach, random),
      };
    }
    return rememberV5(cache, key, deposit, V5_LIMITS.deposits);
  }

  function exposed(x, y, z) {
    for (const [dx, dy, dz] of DIRECTIONS) {
      counters.oreExposureChecks++;
      if (natural.blockAt(x + dx, y + dy, z + dz) === B.AIR) return true;
    }
    return false;
  }

  function decorate(bounds, writer) {
    const reach = V5_LIMITS.depositReach;
    const minGX = Math.max(Math.floor(V5_MIN_XZ / CELL), Math.floor((bounds.minX - reach) / CELL));
    const maxGX = Math.min(Math.floor((V5_MAX_XZ - 1) / CELL),
      Math.floor((bounds.minX + bounds.width - 1 + reach) / CELL));
    const minGZ = Math.max(Math.floor(V5_MIN_XZ / CELL), Math.floor((bounds.minZ - reach) / CELL));
    const maxGZ = Math.min(Math.floor((V5_MAX_XZ - 1) / CELL),
      Math.floor((bounds.minZ + bounds.depth - 1 + reach) / CELL));
    for (const ore of ores) {
      const low = Math.max(spec.minY, ore.minY), high = Math.min(spec.maxY, ore.maxY);
      // One extra negative owner covers the rare per-column Y phase.
      const minGY = Math.floor((low - reach - (ore.rare ? CELL : 0)) / CELL);
      const maxGY = Math.floor((high - 1 + reach) / CELL);
      for (let gz = minGZ; gz <= maxGZ; gz++)
        for (let gy = minGY; gy <= maxGY; gy++)
          for (let gx = minGX; gx <= maxGX; gx++) {
            const deposit = describe(ore, gx, gy, gz);
            if (!deposit) continue;
            for (let i = 0; i < deposit.points.length; i += 3) {
              counters.oreCandidates++;
              const x = deposit.x + deposit.points[i];
              const y = deposit.y + deposit.points[i + 1];
              const z = deposit.z + deposit.points[i + 2];
              const rock = writer.get(x, y, z);
              if (!v5OreAcceptsHost(ore, rock)) continue;
              const col = sampleColumn(x, z);
              if (!v5OreChance(ore, y, col, salt)) continue;
              const discard = ore.name === "gold" && badlands(col) && y >= 32
                ? 0 : ore.airDiscard;
              if (discard && exposed(x, y, z) &&
                hash(x, z, salt ^ ore.salt ^ Math.imul(y + 4096, 16987)) < discard) {
                counters.oreExposureDiscards++;
                continue;
              }
              writer.blocks[writer.at(x, y, z)] = rock === B.DEEPSLATE ? ore.deepBlock : ore.block;
              counters.oreWrites++;
            }
          }
    }
  }
  return { decorate, get cacheSize() { return cache.size; } };
}
