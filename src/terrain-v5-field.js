import { BIOME_PROFILES, getBiomeById } from "./biomes.js";
import { BLOCK as B } from "./blocks.js";
import { clamp, fractal, hash, mix, noise, smooth } from "./noise.js";
import {
  selectV5LandBiome, V5_BIOME_SIZE, V5_MUSHROOMS, v5Owner, v5Ramp as ramp,
} from "./terrain-v5-biomes.js";
import {
  rememberV5, V5_LAVA_LEVEL, V5_LIMITS, v5InBounds,
} from "./terrain-v5-config.js";

const SEA = 63;
const EMPTY = Object.freeze([]);
const oceanId = (temperature, deep) =>
  temperature < 0.23 ? (deep ? "deep_frozen_ocean" : "frozen_ocean")
    : temperature < 0.4 ? (deep ? "deep_cold_ocean" : "cold_ocean")
      : temperature < 0.64 ? (deep ? "deep_ocean" : "ocean")
        : temperature < 0.8 ? (deep ? "deep_lukewarm_ocean" : "lukewarm_ocean")
          : "warm_ocean";

function openingsAt(x, z, landTop, dry, salt) {
  if (!dry || landTop < SEA + 5) return { openings: EMPTY, top: landTop };
  const wx = x + (noise(x / 110, z / 110, salt ^ 43133) - 0.5) * 24;
  const wz = z + (noise(x / 110, z / 110, salt ^ 31847) - 0.5) * 24;
  const distance = Math.abs(noise(wx / 81, wz / 81, salt ^ 23743) - 0.5);
  const width = 1 - ramp(distance, 0.014, 0.063);
  const openings = [];
  if (noise(x / 310, z / 310, salt ^ 49157) > 0.49 && width > 0.12) {
    const low = 68 + Math.floor(noise(x / 139, z / 139, salt ^ 39041) * 29);
    if (landTop >= low + 1) openings.push([low, low + 2 + Math.floor(width * 7)]);
  }
  const rift = (1 - ramp(
    Math.abs(noise(wx / 183, wz / 183, salt ^ 61379) - 0.5), 0.005, 0.027
  )) * ramp(noise(wx / 417, wz / 417, salt ^ 55331), 0.64, 0.83);
  const drop = Math.min(
    landTop - SEA - 3,
    Math.floor(rift * (16 + noise(x / 57, z / 57, salt ^ 49871) * 24))
  );
  if (drop >= 3) openings.push([landTop - drop + 1, landTop + 3]);
  let top = landTop;
  for (const [low, high] of openings)
    if (low <= top && high >= top) top = low - 1;
  return {
    top,
    openings: openings.length
      ? Object.freeze(openings.map((interval) => Object.freeze(interval))) : EMPTY,
  };
}

function seabed(x, z, top, temperature, trench, salt) {
  const patch = noise(x / 47, z / 47, salt ^ 28151);
  if (top < -18 && (trench > 0.1 || patch < 0.56)) return B.DEEPSLATE;
  if (patch > 0.7 && SEA - top > 7) return B.CLAY;
  if (temperature >= 0.64 && patch < 0.66) return B.SAND;
  return SEA - top < 28 && patch < 0.3 ? B.SAND : B.GRAVEL;
}

export function createV5Field(salt, dimension, counters) {
  const columns = new Map();
  const regions = new Map();
  const mushrooms = new Map();
  const temperatureAt = (x, z) =>
    clamp(0.5 + (fractal(x / 1710, z / 1710, salt ^ 8617) - 0.5) * 2.65);
  const moistureAt = (x, z) => noise(x / 1070, z / 1070, salt ^ 1889);
  const largeScale = (x, z) => {
    const wx = x + (noise(x / 640, z / 640, salt ^ 17891) - 0.5) * 210;
    const wz = z + (noise(x / 640, z / 640, salt ^ 24103) - 0.5) * 210;
    return { wx, wz, continental: fractal(wx / 1170, wz / 1170, salt ^ 4001) };
  };

  function region(gx, gz) {
    const key = `${gx},${gz}`;
    if (regions.has(key)) return regions.get(key);
    counters.regionSamples++;
    return rememberV5(
      regions, key, v5Owner(gx, gz, salt, temperatureAt, moistureAt, dimension),
      V5_LIMITS.regions
    );
  }

  function regional(x, z) {
    const wx = x + (noise(x / 470, z / 470, salt ^ 1283) - 0.5) * 112;
    const wz = z + (noise(x / 470, z / 470, salt ^ 1993) - 0.5) * 112;
    const gx = Math.floor(wx / V5_BIOME_SIZE);
    const gz = Math.floor(wz / V5_BIOME_SIZE);
    const candidates = [];
    let nearest;
    let minimum = Infinity;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const entry = region(gx + dx, gz + dz);
      const distance = Math.hypot(entry.x - wx, entry.z - wz);
      candidates.push([entry, distance]);
      if (distance < minimum) {
        minimum = distance;
        nearest = entry;
      }
    }
    let lift = 0, relief = 0, swamp = 0, weight = 0;
    for (const [entry, distance] of candidates) {
      const w = 1 - ramp(distance - minimum, 0, 96);
      lift += Math.max(0, entry.profile.height - 30) * 1.75 * w;
      relief += entry.profile.relief * w;
      swamp += Number(getBiomeById(entry.id).category === "swamp") * w;
      weight += w;
    }
    return {
      id: nearest.id, variant: nearest.variant,
      core: 1 - ramp(minimum, 64, 184),
      lift: lift / weight, relief: relief / weight, swamp: swamp / weight,
    };
  }

  function mushroomIsland(gx, gz) {
    if (!Number.isSafeInteger(gx) || !Number.isSafeInteger(gz)) return null;
    const key = `${gx},${gz}`;
    if (mushrooms.has(key)) return mushrooms.get(key);
    counters.mushroomCells++;
    let island = null;
    if (hash(gx, gz, salt ^ 21617) < V5_MUSHROOMS.occurrence) {
      const roll = (channel) => hash(gx, gz, salt ^ channel);
      const x = (gx + 0.25 + roll(30341) * 0.5) * V5_MUSHROOMS.spacing;
      const z = (gz + 0.25 + roll(52147) * 0.5) * V5_MUSHROOMS.spacing;
      const continental = largeScale(x, z).continental;
      if (v5InBounds(x, z) && continental > 0.2 && continental < 0.39) {
        const radius = V5_MUSHROOMS.minRadius +
          roll(42017) * (V5_MUSHROOMS.maxRadius - V5_MUSHROOMS.minRadius);
        island = Object.freeze({
          x, z, radiusX: radius, radiusZ: radius * (0.85 + roll(58913) * 0.3),
        });
      }
    }
    return rememberV5(mushrooms, key, island, V5_LIMITS.mushrooms);
  }

  function mushroomAt(x, z) {
    const gx = Math.floor(x / V5_MUSHROOMS.spacing);
    const gz = Math.floor(z / V5_MUSHROOMS.spacing);
    let strength = 0;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const island = mushroomIsland(gx + dx, gz + dz);
      if (!island) continue;
      const distance = Math.hypot(
        (x - island.x) / island.radiusX, (z - island.z) / island.radiusZ
      );
      strength = Math.max(strength, 1 - ramp(distance, 0.48, 1));
    }
    return strength;
  }

  function overworld(x, z) {
    const field = regional(x, z);
    const { wx, wz, continental } = largeScale(x, z);
    const temperature = temperatureAt(x, z), moisture = moistureAt(x, z);
    const detail = noise(wx / 39, wz / 39, salt ^ 2851);
    const small = noise(x / 11, z / 11, salt ^ 739) - 0.5;
    const uplift = fractal(wx / 570, wz / 570, salt ^ 17989);
    const erosion = noise(wx / 330, wz / 330, salt ^ 11351);
    const ridge = 1 - Math.abs(noise(wx / 190, wz / 190, salt ^ 9013) * 2 - 1);
    const mountain = ramp(uplift, 0.48, 0.74) * (1 - erosion * 0.65);
    const cliff = ramp(noise(wx / 360, wz / 360, salt ^ 41843), 0.5, 0.78);
    let id = field.id, height, trench = 0, channel = 0;
    if (continental < 0.44) {
      const shelf = ramp(0.44 - continental, 0, 0.09);
      const basin = ramp(0.34 - continental, 0, 0.16);
      trench = (1 - ramp(
        Math.abs(noise(wx / 183, wz / 183, salt ^ 52103) - 0.5), 0.007, 0.032
      )) * ramp(0.29 - continental, 0, 0.12) *
        ramp(noise(wx / 480, wz / 480, salt ^ 60149), 0.58, 0.77);
      height = SEA - 1 - shelf * (14 + detail * 8) -
        basin * (55 + noise(wx / 87, wz / 87, salt ^ 35591) * 26) -
        trench * 27 + small;
      const island = mushroomAt(x, z);
      if (island > 0) {
        height = mix(height, SEA + 9 + detail * 9, island);
        if (height > SEA + 1) id = "mushroom_fields";
      }
    } else {
      const inland = ramp(continental, 0.44, 0.58);
      // Uplift shapes mountains; a random mountain-biome palette no longer
      // manufactures high terrain in otherwise ordinary climate owners.
      height = SEA + 1 + inland * (
        10 + (continental - 0.44) * 112 + (uplift - 0.5) * 26 + field.lift +
        ridge ** 2 * (38 + field.relief * 2 + 112 * mountain) * mountain
      ) + (detail - 0.5) * (3 + inland * field.relief * 1.3) + small * 1.5;
      height += cliff * 27 * ramp(continental, 0.44, 0.459) *
        (1 - ramp(continental, 0.49, 0.55));
      if (id === "desert")
        height += inland * (1 - Math.abs(Math.sin(
          wx * 0.06 + wz * 0.024 + noise(wx / 150, wz / 150, salt ^ 193) * 9
        ))) ** 2 * 7;
      if (id === "badlands" || id === "savanna_plateau") {
        height = mix(height, Math.round(height / 7) * 7, 0.76 * inland);
        if (id === "badlands" && field.variant < 0.14)
          height += noise(wx / 24, wz / 24, salt ^ 1913) ** 4 *
            28 * inland * field.core;
      }
      const riverDistance = Math.abs(noise(wx / 310, wz / 310, salt ^ 3571) - 0.5);
      const drainage = (1 - mountain * 0.8) * (1 - ramp(continental, 0.65, 0.83));
      channel = (1 - ramp(riverDistance, 0.006, 0.033)) * drainage;
      const valley = (1 - ramp(riverDistance, 0.015, 0.105)) * drainage;
      const lake = ramp(noise(wx / 155, wz / 155, salt ^ 6311), 0.81, 0.94) * drainage;
      height = mix(height, SEA + 6 + detail * 3, valley * 0.55);
      height = mix(height, SEA - 7 + detail * 3, Math.max(channel, lake));
      height = mix(height, SEA - 1.8 + detail * 5.4, smooth(field.swamp) * 0.98);
    }
    if (height > 250) height = 250 + 44 * (1 - Math.exp((250 - height) / 44));
    const landTop = clamp(Math.floor(height), -57, 294);
    if (continental >= 0.44)
      id = selectV5LandBiome(field, { temperature, moisture, mountain, top: landTop });
    const flooded = landTop < SEA;
    const isSwamp = getBiomeById(id).category === "swamp" && continental >= 0.44;
    if (flooded && !isSwamp)
      id = continental < 0.44 ? oceanId(temperature, SEA - landTop >= 36)
        : temperature < 0.23 ? "frozen_river" : "river";
    else if (!isSwamp && id !== "mushroom_fields" && (
      (continental < 0.505 && landTop <= SEA + 4) ||
      (continental < 0.49 && cliff > 0.6) || (channel > 0.18 && landTop <= SEA + 2)
    ))
      id = temperature < 0.23 ? "snowy_beach" : cliff > 0.6 ? "stony_shore" : "beach";
    const profile = BIOME_PROFILES[id], category = getBiomeById(id).category;
    let surface = flooded && !isSwamp
      ? seabed(x, z, landTop, temperature, trench, salt) : profile.surface;
    const bareMountain = !flooded && category === "mountain" &&
      !["meadow", "cherry_grove", "grove"].includes(id);
    if (id === "frozen_peaks") surface = B.PACKED_ICE;
    else if (bareMountain || (landTop > 140 && mountain > 0.55 && temperature > 0.3))
      surface = B.STONE;
    const opening = openingsAt(
      x, z, landTop, !flooded && continental > 0.5 && !isSwamp && category !== "shore", salt
    );
    return {
      x, z, id, profile, temperature, moisture, continental,
      top: opening.top, landTop, bottom: -64,
      surface: opening.top < landTop ? B.STONE : surface,
      soil: surface === B.STONE ? B.STONE : flooded && !isSwamp ? surface : profile.soil,
      depth: Math.max(0, SEA - landTop), waterLevel: flooded ? SEA : null,
      frozen: flooded && temperature < 0.23, trench, cliff, mountain,
      strataOffset: category === "badlands"
        ? Math.floor(noise(x / 191, z / 191, salt ^ 1811) * 7) : 0,
      openings: opening.openings, surfaceOpen: opening.top !== landTop,
      treeSafe: opening.openings.every(([, high]) => high < landTop - 4),
    };
  }

  function nether(x, z) {
    const field = regional(x, z);
    const broad = noise(x / 103, z / 103, salt ^ 39119);
    const rough = noise(x / 29, z / 29, salt ^ 2851);
    const channel = 1 - ramp(
      Math.abs(noise(x / 169, z / 169, salt ^ 5527) - 0.5), 0.013, 0.07
    );
    let height = 30 + (broad - 0.3) * 48 + (rough - 0.5) * 11;
    if (field.id === "basalt_deltas") height += rough ** 2 * 17;
    height = mix(height, 17 + rough * 6, channel);
    const top = clamp(Math.floor(height), 9, 84), profile = BIOME_PROFILES[field.id];
    return {
      x, z, id: field.id, profile, temperature: 1,
      moisture: noise(x / 170, z / 170, salt ^ 881), continental: 1,
      top, landTop: top, bottom: 0, surface: profile.surface, soil: profile.soil,
      depth: 0, waterLevel: null, lavaLevel: V5_LAVA_LEVEL,
      roof: 97 + Math.floor(noise(x / 91, z / 91, salt ^ 1861) * 21),
      frozen: false, openings: EMPTY, surfaceOpen: false, treeSafe: top > 32,
    };
  }

  function end(x, z) {
    const radius = Math.hypot(x, z), detail = noise(x / 43, z / 43, salt ^ 4703);
    let id = "the_void", top = null, bottom = null;
    const centralEdge = 172 + noise(x / 91, z / 91, salt ^ 27551) * 29;
    if (radius < centralEdge) {
      id = "the_end";
      const rim = ramp(radius, centralEdge - 56, centralEdge);
      top = Math.floor(69 + detail * 13 - rim * 32);
      bottom = Math.max(8, top - Math.floor(5 + (1 - rim) * (28 + detail * 12)));
    } else if (radius > 448) {
      const wx = x + (noise(x / 380, z / 380, salt ^ 38431) - 0.5) * 120;
      const wz = z + (noise(x / 380, z / 380, salt ^ 12823) - 0.5) * 120;
      const island = fractal(wx / 221, wz / 221, salt ^ 6971), edge = ramp(island, 0.475, 0.7);
      if (island > 0.475) {
        id = island > 0.61 ? "end_highlands" : island > 0.52 ? "end_midlands" : "end_barrens";
        top = Math.floor(47 + edge * 83 + detail * 8);
        bottom = Math.max(12, top - Math.floor(4 + edge * 43 + detail * 5));
      } else if (noise(x / 42, z / 42, salt ^ 9181) > 0.83) {
        id = "small_end_islands";
        top = Math.floor(48 + detail * 14);
        bottom = top - 4 - Math.floor(detail * 5);
      }
    }
    const profile = BIOME_PROFILES[id];
    return {
      x, z, id, profile, top, landTop: top, bottom,
      temperature: 0.5, moisture: 0, continental: 0, surface: profile.surface,
      soil: profile.soil, depth: 0, waterLevel: null, frozen: false,
      openings: EMPTY, surfaceOpen: false, treeSafe: false,
    };
  }

  function sampleColumn(x, z) {
    counters.surfaceQueries++;
    if (!v5InBounds(x, z)) return null;
    x = Math.floor(x); z = Math.floor(z);
    const key = `${x},${z}`;
    if (columns.has(key)) return columns.get(key);
    counters.surfaceSamples++;
    return rememberV5(columns, key, Object.freeze(
      dimension === "overworld" ? overworld(x, z) : dimension === "nether" ? nether(x, z) : end(x, z)
    ), V5_LIMITS.columns);
  }
  return {
    sampleColumn, mushroomIsland,
    get cacheSizes() {
      return { columns: columns.size, regions: regions.size, mushrooms: mushrooms.size };
    },
  };
}
