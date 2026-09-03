import { getBiomeById } from "./biomes.js";
import { BLOCK as B, isSolid } from "./blocks.js";
import { clamp, hash, noise, smooth } from "./noise.js";
import { mergeCaveIntervals } from "./terrain-cave-field.js";
import { strata } from "./terrain-profiles.js";
import { remember, V4_LIMITS } from "./terrain-v4-config.js";

const BANDS = [-57, -29, 5, 39, 75, 113, 151, 191, 233, 277];
const triangle = (y, low, peak, high) =>
  clamp(Math.min((y - low) / (peak - low), (high - y) / (high - peak)));
const ramp = (n, a, b) => smooth(clamp((n - a) / (b - a)));
const wrap = (n, size) => ((n % size) + size) % size;

// HUD biome sampling needs only climate, not cave geometry or chunk generation.
export function v4CaveBiome(col, y, salt) {
  if (
    y >= 8 &&
    y < 49 &&
    col.temperature > 0.6 &&
    col.moisture > 0.46 &&
    noise(col.x / 187, col.z / 187, salt ^ 9791) > 0.66
  )
    return "sulfur_caves";
  if (y < -24 && noise(col.x / 233, col.z / 233, salt ^ 37123) > 0.54)
    return "deep_dark";
  return noise(col.x / 196, col.z / 196, salt ^ 6491) > 0.48
    ? "lush_caves"
    : "dripstone_caves";
}

export function createV4Underground(salt, counters) {
  const caveCache = new Map();
  const oreCache = new Map();

  function caves(col) {
    const key = `${col.x},${col.z}`;
    if (caveCache.has(key)) return caveCache.get(key);
    counters.caveColumns++;
    const { x, z } = col;
    const wx = x + (noise(x / 91, z / 91, salt ^ 21911) - 0.5) * 28;
    const wz = z + (noise(x / 91, z / 91, salt ^ 48973) - 0.5) * 28;
    const detail = noise(x / 11, z / 11, salt ^ 2879);
    // Keep a real bedrock foundation and a supporting surface cap, including
    // at a rift's exposed floor. Intervals do not use a fixed-height voxel array.
    const cap = Math.min(col.landTop - 5, col.top - 4);
    const intervals = [];
    for (let band = 0; band < BANDS.length; band++) {
      const base = BANDS[band];
      if (base > cap) break;
      const channelSalt = salt ^ Math.imul(band + 1, 43853);
      const worm =
        1 - Math.abs(noise(wx / 43, wz / 43, channelSalt ^ 3371) - 0.5) / 0.077;
      const room = ramp(
        noise(wx / 64, wz / 64, channelSalt ^ 31543),
        0.59,
        0.85
      );
      const presence = Math.max(worm * 0.72, room);
      if (presence <= 0) continue;
      const low = Math.max(
        -59,
        Math.floor(
          base + noise(x / 31, z / 31, channelSalt ^ 16231) * 9 + detail * 2
        )
      );
      const high = Math.min(
        cap,
        low +
          Math.floor(
            2 +
              presence * (band < 2 ? 17 : 12) +
              noise(x / 14, z / 14, channelSalt ^ 4639) * 3
          )
      );
      if (high - low >= 2) intervals.push([low, high]);
    }
    // Sparse chimneys join stacked passages. Their narrow footprint and
    // independent field leave plentiful roofs/floors instead of a huge hall.
    if (noise(wx / 28, wz / 28, salt ^ 53381) > 0.78) {
      const joins = [];
      for (let i = 1; i < intervals.length; i++) {
        const previous = intervals[i - 1];
        const next = intervals[i];
        if (next[0] - previous[1] <= 43) joins.push([previous[1], next[0]]);
      }
      intervals.push(...joins);
    }
    intervals.push(...col.openings);
    const result = Object.freeze(
      mergeCaveIntervals(intervals).map((interval) => Object.freeze(interval))
    );
    return remember(caveCache, key, result, V4_LIMITS.caves);
  }

  function oreCell(gx, gy, gz, mode, nether) {
    const key = `${gx},${gy},${gz},${mode},${Number(nether)}`;
    if (oreCache.has(key)) return oreCache.get(key);
    counters.oreCells++;
    const y = gy * 4 + 2;
    const channelSalt = salt ^ Math.imul(gy + 71, 7673);
    let weights;
    if (nether) {
      weights = [
        ["NETHER_QUARTZ_ORE", y > 8 && y < 118 ? 0.12 : 0],
        ["NETHER_GOLD_ORE", y > 7 && y < 118 ? 0.065 : 0],
        [
          "ANCIENT_DEBRIS",
          0.035 * triangle(y, 7, 16, 40) + (y >= 40 && y < 119 ? 0.005 : 0),
        ],
      ];
    } else {
      const below = clamp((16 - y) / 80);
      weights = [
        ["DIAMOND", 0.068 * below ** 1.4],
        ["REDSTONE", y < 16 ? 0.095 * (0.4 + below * 0.6) : 0],
        [
          "GOLD",
          0.065 * triangle(y, -64, -16, 40) +
            (mode & 1 && y > 32 && y < 160 ? 0.085 : 0),
        ],
        ["LAPIS", 0.065 * triangle(y, -64, 0, 72)],
        ["COPPER", 0.14 * triangle(y, -16, 48, 112)],
        ["IRON", 0.12 * triangle(y, -56, 16, 88) + 0.095 * ramp(y, 120, 240)],
        ["COAL", 0.17 * triangle(y, 0, 96, 256)],
        ["EMERALD", mode & 2 ? 0.05 * triangle(y, -16, 168, 300) : 0],
      ];
    }
    let chance = hash(gx, gz, channelSalt ^ (nether ? 59333 : 5861));
    let name = null;
    for (const [candidate, weight] of weights) {
      chance -= weight;
      if (chance < 0) {
        name = candidate;
        break;
      }
    }
    const result =
      name === null
        ? null
        : {
            name,
            x: gx * 4 + 1 + hash(gx, gz, channelSalt ^ 27011) * 2,
            y: gy * 4 + 1 + hash(gx, gz, channelSalt ^ 29917) * 2,
            z: gz * 4 + 1 + hash(gx, gz, channelSalt ^ 30259) * 2,
            radius: 1.65 + hash(gx, gz, channelSalt ^ 11329) * 0.85,
          };
    return remember(oreCache, key, result, V4_LIMITS.ores);
  }

  function oreAt(x, y, z, rock, col, nether = false) {
    if (
      nether
        ? rock !== B.NETHERRACK && rock !== B.BLACKSTONE
        : rock !== B.STONE && rock !== B.DEEPSLATE
    )
      return rock;
    const category = getBiomeById(col.id).category;
    const mode =
      Number(category === "badlands") |
      (category === "mountain" || col.mountain > 0.55 ? 2 : 0);
    const deposit = oreCell(
      Math.floor(x / 4),
      Math.floor(y / 4),
      Math.floor(z / 4),
      mode,
      nether
    );
    if (!deposit) return rock;
    const distance =
      (x + 0.5 - deposit.x) ** 2 +
      (y + 0.5 - deposit.y) ** 2 * 1.18 +
      (z + 0.5 - deposit.z) ** 2;
    if (distance > deposit.radius ** 2) return rock;
    if (nether) return B[deposit.name];
    return B[`${rock === B.DEEPSLATE ? "DEEPSLATE_" : ""}${deposit.name}_ORE`];
  }

  function rockAt(col, y) {
    const { x, z, landTop } = col;
    if (
      y === -64 ||
      (y < -60 && hash(x, z, salt ^ Math.imul(y, 6173)) < (-60 - y) / 5)
    )
      return B.BEDROCK;
    const category = getBiomeById(col.id).category;
    if (category === "badlands" && y >= 54 && y >= landTop - 72) {
      return strata[
        wrap(Math.floor((y + col.strataOffset) / 2), strata.length)
      ];
    }
    const deep =
      y < -8 ||
      (y <= 8 && hash(x, z, salt ^ Math.imul(y + 9, 3253)) > (y + 8) / 16);
    return deep ? B.DEEPSLATE : B.STONE;
  }

  function carve(writer, col) {
    const intervals = caves(col);
    const { x, z } = col;
    const growth = noise(x / 33, z / 33, salt ^ 8849);
    const chance = hash(x, z, salt ^ 9011);
    const aquifer = noise(x / 219, z / 219, salt ^ 22541);
    const waterTable =
      -34 + Math.floor(noise(x / 81, z / 81, salt ^ 6551) * 19);
    const ocean = getBiomeById(col.id).category === "ocean";
    const write = (y, id) => {
      if (y >= -64 && y < 320) writer.blocks[writer.at(x, y, z)] = id;
    };
    const block = (y) =>
      y < -64 || y >= 320 ? B.AIR : writer.blocks[writer.at(x, y, z)];
    for (const [unclippedLow, unclippedHigh] of intervals) {
      const low = Math.max(-59, unclippedLow);
      const high = Math.min(col.landTop, unclippedHigh);
      if (high < low) continue;
      const biome = v4CaveBiome(col, low, salt);
      const fluidTop = ocean
        ? high
        : aquifer > 0.71 && low <= waterTable
          ? Math.min(high, waterTable)
          : -Infinity;
      for (let y = low; y <= high; y++) {
        counters.voxelVisits++;
        write(
          y,
          y <= fluidTop ? B.WATER : y <= -55 && aquifer < 0.57 ? B.LAVA : B.AIR
        );
      }
      const floor = low - 1;
      const roof = high + 1;
      const floorSolid = isSolid(block(floor)) && block(floor) !== B.BEDROCK;
      const roofSolid = roof <= col.landTop && isSolid(block(roof));
      const dry = fluidTop < low && block(low) === B.AIR;
      if (biome === "sulfur_caves") {
        if (floorSolid) {
          write(floor, growth > 0.55 ? B.SULFUR : B.CINNABAR);
          if (dry && growth > 0.64 && chance < 0.12 && high - low >= 4) {
            write(floor, B.POTENT_SULFUR);
            write(low, B.WATER);
          } else if (dry && chance < 0.1) write(low, B.SULFUR_SPIKE);
        }
        if (roofSolid) {
          write(roof, growth > 0.4 ? B.SULFUR : B.CINNABAR);
          if (dry && chance > 0.9) write(high, B.SULFUR_SPIKE);
        }
      } else if (biome === "deep_dark") {
        if (floorSolid && growth > 0.48) write(floor, B.SCULK);
        if (roofSolid && growth > 0.7) write(roof, B.SCULK);
      } else if (biome === "lush_caves") {
        if (floorSolid && growth > 0.36) write(floor, B.MOSS);
        if (roofSolid && growth > 0.62) write(roof, B.MOSS);
        if (
          dry &&
          roofSolid &&
          high - low >= 5 &&
          growth > 0.46 &&
          chance < 0.12
        ) {
          const length = Math.min(
            high - low - 2,
            1 + (Math.floor(chance * 101) % 4)
          );
          for (let dy = 0; dy < length; dy++)
            write(
              high - dy,
              dy === length - 1 && growth > 0.64 && chance < 0.025
                ? B.GLOW_BERRIES
                : B.CAVE_VINE
            );
        }
      } else {
        if (floorSolid && growth < 0.5) write(floor, B.DRIPSTONE);
        if (roofSolid && growth < 0.38) write(roof, B.DRIPSTONE);
        if (dry && high - low >= 7) {
          const length = 1 + (Math.floor(chance * 997) % 3);
          if (floorSolid && chance < 0.07)
            for (let dy = 0; dy < length; dy++) write(low + dy, B.DRIPSTONE);
          if (roofSolid && chance > 0.94)
            for (let dy = 0; dy < length; dy++) write(high - dy, B.DRIPSTONE);
        }
      }
      if (floorSolid && floor < -8 && growth > 0.78 && biome !== "deep_dark")
        write(floor, B.COBBLED_DEEPSLATE);
    }
  }

  return {
    caves,
    oreAt,
    rockAt,
    carve,
    get cacheSizes() {
      return { caves: caveCache.size, ores: oreCache.size };
    },
  };
}
