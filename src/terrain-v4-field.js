import { BIOME_PROFILES, getBiomeById } from "./biomes.js";
import { BLOCK as B } from "./blocks.js";
import { clamp, fractal, hash, mix, noise, smooth } from "./noise.js";
import { oceanId, selectRegionBiome } from "./terrain-profiles.js";
import {
  remember,
  V4_LAVA_LEVEL,
  V4_LIMITS,
  v4InBounds,
} from "./terrain-v4-config.js";

const SEA = 63;
const REGION_SIZE = 192;
const ramp = (value, low, high) => smooth(clamp((value - low) / (high - low)));
const EMPTY = Object.freeze([]);

/**
 * Column-local entrance envelopes, not a cave/route planner. A contour passage
 * intersects hillsides at its own elevation; occasional rifts expose its roof.
 * The same envelopes reserve roots and lower the cheap bare-ground LOD height.
 * Full underground interval geometry is evaluated only by the voxel generator.
 */
function openingsAt(x, z, landTop, dry, salt) {
  if (!dry || landTop < SEA + 5) return { openings: EMPTY, top: landTop };
  const wx = x + (noise(x / 110, z / 110, salt ^ 43133) - 0.5) * 24;
  const wz = z + (noise(x / 110, z / 110, salt ^ 31847) - 0.5) * 24;
  const distance = Math.abs(noise(wx / 81, wz / 81, salt ^ 23743) - 0.5);
  const width = 1 - ramp(distance, 0.014, 0.063);
  const active = noise(x / 310, z / 310, salt ^ 49157) > 0.49;
  const openings = [];
  if (active && width > 0.12) {
    const low = 68 + Math.floor(noise(x / 139, z / 139, salt ^ 39041) * 29);
    const high = low + 2 + Math.floor(width * 7);
    if (landTop >= low + 1) openings.push([low, high]);
  }
  const riftDistance = Math.abs(noise(wx / 183, wz / 183, salt ^ 61379) - 0.5);
  const rift =
    (1 - ramp(riftDistance, 0.005, 0.027)) *
    ramp(noise(x / 417, z / 417, salt ^ 55331), 0.64, 0.83);
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
      ? Object.freeze(openings.map((interval) => Object.freeze(interval)))
      : EMPTY,
  };
}

function seabed(x, z, top, temperature, trench, salt) {
  const patch = noise(x / 47, z / 47, salt ^ 28151);
  const depth = SEA - top;
  if (top < -18 && (trench > 0.1 || patch < 0.56)) return B.DEEPSLATE;
  if (patch > 0.7 && depth > 7) return B.CLAY;
  if (temperature >= 0.64 && patch < 0.66) return B.SAND;
  if (depth < 28 && patch < 0.3) return B.SAND;
  return B.GRAVEL;
}

export function createV4Field(salt, dimension, counters) {
  const columns = new Map();
  const regions = new Map();
  const temperatureAt = (x, z) =>
    clamp(0.5 + (fractal(x / 1710, z / 1710, salt ^ 8617) - 0.5) * 2.65);
  const moistureAt = (x, z) => noise(x / 1070, z / 1070, salt ^ 1889);

  function region(gx, gz) {
    const key = `${gx},${gz}`;
    if (regions.has(key)) return regions.get(key);
    counters.regionSamples++;
    const x =
      (gx + 0.5 + (hash(gx, gz, salt ^ 7187) - 0.5) * 0.58) * REGION_SIZE;
    const z =
      (gz + 0.5 + (hash(gx, gz, salt ^ 2333) - 0.5) * 0.58) * REGION_SIZE;
    const temperature = temperatureAt(x, z);
    const moisture = moistureAt(x, z);
    const id = selectRegionBiome(
      dimension,
      temperature,
      moisture,
      0.7,
      hash(gx, gz, salt ^ 3191)
    );
    return remember(
      regions,
      key,
      { x, z, id, profile: BIOME_PROFILES[id] },
      V4_LIMITS.regions
    );
  }

  function regional(x, z) {
    const wx = x + (noise(x / 370, z / 370, salt ^ 1283) - 0.5) * 94;
    const wz = z + (noise(x / 370, z / 370, salt ^ 1993) - 0.5) * 94;
    const gx = Math.floor(wx / REGION_SIZE);
    const gz = Math.floor(wz / REGION_SIZE);
    const candidates = [];
    let nearest;
    let minimum = Infinity;
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++) {
        const entry = region(gx + dx, gz + dz);
        const distance = Math.hypot(entry.x - wx, entry.z - wz);
        candidates.push([entry, distance]);
        if (distance < minimum) {
          minimum = distance;
          nearest = entry;
        }
      }
    let lift = 0;
    let relief = 0;
    let swamp = 0;
    let weight = 0;
    for (const [entry, distance] of candidates) {
      const w = 1 - ramp(distance - minimum, 0, 62);
      lift += Math.max(0, entry.profile.height - 30) * 1.75 * w;
      relief += entry.profile.relief * w;
      swamp += Number(getBiomeById(entry.id).category === "swamp") * w;
      weight += w;
    }
    return {
      id: nearest.id,
      lift: lift / weight,
      relief: relief / weight,
      swamp: swamp / weight,
    };
  }

  function overworld(x, z) {
    const field = regional(x, z);
    const wx = x + (noise(x / 640, z / 640, salt ^ 17891) - 0.5) * 210;
    const wz = z + (noise(x / 640, z / 640, salt ^ 24103) - 0.5) * 210;
    const continental = fractal(wx / 1170, wz / 1170, salt ^ 4001);
    const temperature = temperatureAt(x, z);
    const moisture = moistureAt(x, z);
    const detail = noise(wx / 39, wz / 39, salt ^ 2851);
    const small = noise(x / 11, z / 11, salt ^ 739) - 0.5;
    const uplift = fractal(wx / 570, wz / 570, salt ^ 17989);
    const erosion = noise(wx / 330, wz / 330, salt ^ 11351);
    const ridge = 1 - Math.abs(noise(wx / 190, wz / 190, salt ^ 9013) * 2 - 1);
    const mountain = ramp(uplift, 0.48, 0.74) * (1 - erosion * 0.65);
    const cliff = ramp(noise(wx / 360, wz / 360, salt ^ 41843), 0.5, 0.78);
    let id = field.id;
    let height;
    let trench = 0;
    let channel = 0;
    if (continental < 0.44) {
      // The first 0.09 is the continental shelf. The deeper slope is a separate
      // field, so a deep biome is not a recolored 10-cell puddle.
      const shelf = ramp(0.44 - continental, 0, 0.09);
      const basin = ramp(0.34 - continental, 0, 0.16);
      const floor = noise(wx / 87, wz / 87, salt ^ 35591);
      trench =
        (1 -
          ramp(
            Math.abs(noise(wx / 183, wz / 183, salt ^ 52103) - 0.5),
            0.007,
            0.032
          )) *
        ramp(0.29 - continental, 0, 0.12) *
        ramp(noise(wx / 480, wz / 480, salt ^ 60149), 0.58, 0.77);
      height =
        SEA -
        1 -
        shelf * (14 + detail * 8) -
        basin * (55 + floor * 26) -
        trench * 27 +
        small;
      // Rare mycelium islands grow out of the continental shelf itself.
      const island = ramp(noise(wx / 97, wz / 97, salt ^ 21617), 0.79, 0.94);
      if (continental > 0.3 && island > 0) {
        height = mix(height, SEA + 7 + detail * 9, island);
        if (height > SEA + 1) id = "mushroom_fields";
      }
    } else {
      const inland = ramp(continental, 0.44, 0.58);
      height =
        SEA +
        1 +
        inland *
          (10 +
            (continental - 0.44) * 112 +
            (uplift - 0.5) * 26 +
            field.lift +
            ridge ** 2 * (20 + field.relief * 3.4) * mountain) +
        (detail - 0.5) * (3 + inland * field.relief * 1.3) +
        small * 1.5;
      height +=
        cliff *
        27 *
        ramp(continental, 0.44, 0.459) *
        (1 - ramp(continental, 0.49, 0.55));
      if (id === "desert")
        height +=
          inland *
          (1 -
            Math.abs(
              Math.sin(
                wx * 0.06 +
                  wz * 0.024 +
                  noise(wx / 150, wz / 150, salt ^ 193) * 9
              )
            )) **
            2 *
          7;
      const category = getBiomeById(id).category;
      if (category === "badlands" || id === "savanna_plateau") {
        height = mix(height, Math.round(height / 7) * 7, 0.76 * inland);
        if (id === "eroded_badlands")
          height += noise(wx / 24, wz / 24, salt ^ 1913) ** 4 * 34 * inland;
      }
      const riverDistance = Math.abs(
        noise(wx / 310, wz / 310, salt ^ 3571) - 0.5
      );
      const drainage =
        (1 - mountain * 0.8) * (1 - ramp(continental, 0.65, 0.83));
      channel = (1 - ramp(riverDistance, 0.006, 0.033)) * drainage;
      const valley = (1 - ramp(riverDistance, 0.015, 0.105)) * drainage;
      const lake =
        ramp(noise(wx / 155, wz / 155, salt ^ 6311), 0.81, 0.94) * drainage;
      height = mix(height, SEA + 6 + detail * 3, valley * 0.55);
      height = mix(height, SEA - 7 + detail * 3, Math.max(channel, lake));
      height = mix(
        height,
        SEA - 1.8 + detail * 5.4,
        smooth(field.swamp) * 0.98
      );
    }
    // Leave high-flight/build headroom and avoid a hard, flat summit clamp.
    if (height > 250) height = 250 + 44 * (1 - Math.exp((250 - height) / 44));
    const landTop = clamp(Math.floor(height), -57, 294);
    const flooded = landTop < SEA;
    const isSwamp =
      getBiomeById(id).category === "swamp" && continental >= 0.44;
    if (flooded && !isSwamp)
      id =
        continental < 0.44
          ? oceanId(temperature, SEA - landTop >= 36)
          : temperature < 0.23
            ? "frozen_river"
            : "river";
    else if (
      !isSwamp &&
      id !== "mushroom_fields" &&
      ((continental < 0.505 && landTop <= SEA + 4) ||
        (continental < 0.49 && cliff > 0.6) ||
        (channel > 0.18 && landTop <= SEA + 2))
    )
      id =
        temperature < 0.23
          ? "snowy_beach"
          : cliff > 0.6
            ? "stony_shore"
            : "beach";
    const profile = BIOME_PROFILES[id];
    const category = getBiomeById(id).category;
    const depth = Math.max(0, SEA - landTop);
    let surface =
      flooded && !isSwamp
        ? seabed(x, z, landTop, temperature, trench, salt)
        : profile.surface;
    if (id === "frozen_peaks" && landTop > 125) surface = B.PACKED_ICE;
    if (
      (id === "jagged_peaks" && hash(x, z, salt ^ 233) < 0.5) ||
      (id === "windswept_hills" && landTop > 108)
    )
      surface = B.STONE;
    const opening = openingsAt(
      x,
      z,
      landTop,
      !flooded && continental > 0.5 && !isSwamp && category !== "shore",
      salt
    );
    return {
      x,
      z,
      id,
      profile,
      temperature,
      moisture,
      continental,
      top: opening.top,
      landTop,
      bottom: -64,
      surface: opening.top < landTop ? B.STONE : surface,
      soil: flooded && !isSwamp ? surface : profile.soil,
      depth,
      waterLevel: flooded ? SEA : null,
      frozen: flooded && temperature < 0.23,
      trench,
      cliff,
      mountain: mountain + field.lift / 100,
      strataOffset:
        category === "badlands"
          ? Math.floor(noise(x / 191, z / 191, salt ^ 1811) * 7)
          : 0,
      openings: opening.openings,
      surfaceOpen: opening.top !== landTop,
      // Reject roots close to a thin roof as well as at an actual opening.
      treeSafe: opening.openings.every(([, high]) => high < landTop - 4),
    };
  }

  function nether(x, z) {
    const field = regional(x, z);
    const broad = noise(x / 103, z / 103, salt ^ 39119);
    const rough = noise(x / 29, z / 29, salt ^ 2851);
    const channel =
      1 -
      ramp(Math.abs(noise(x / 169, z / 169, salt ^ 5527) - 0.5), 0.013, 0.07);
    let height = 30 + (broad - 0.3) * 48 + (rough - 0.5) * 11;
    if (field.id === "basalt_deltas") height += rough ** 2 * 17;
    height = mix(height, 17 + rough * 6, channel);
    const top = clamp(Math.floor(height), 9, 84);
    const roof = 97 + Math.floor(noise(x / 91, z / 91, salt ^ 1861) * 21);
    const profile = BIOME_PROFILES[field.id];
    return {
      x,
      z,
      id: field.id,
      profile,
      temperature: 1,
      moisture: noise(x / 170, z / 170, salt ^ 881),
      continental: 1,
      top,
      landTop: top,
      bottom: 0,
      surface: profile.surface,
      soil: profile.soil,
      depth: 0,
      waterLevel: null,
      lavaLevel: V4_LAVA_LEVEL,
      roof,
      frozen: false,
      openings: EMPTY,
      surfaceOpen: false,
      treeSafe: top > 32,
    };
  }

  function end(x, z) {
    const radius = Math.hypot(x, z);
    const detail = noise(x / 43, z / 43, salt ^ 4703);
    let id = "the_void";
    let top = null;
    let bottom = null;
    const centralEdge = 172 + noise(x / 91, z / 91, salt ^ 27551) * 29;
    if (radius < centralEdge) {
      id = "the_end";
      const rim = ramp(radius, centralEdge - 56, centralEdge);
      top = Math.floor(69 + detail * 13 - rim * 32);
      bottom = Math.max(
        8,
        top - Math.floor(5 + (1 - rim) * (28 + detail * 12))
      );
    } else if (radius > 448) {
      const wx = x + (noise(x / 380, z / 380, salt ^ 38431) - 0.5) * 120;
      const wz = z + (noise(x / 380, z / 380, salt ^ 12823) - 0.5) * 120;
      const island = fractal(wx / 221, wz / 221, salt ^ 6971);
      const edge = ramp(island, 0.475, 0.7);
      if (island > 0.475) {
        id =
          island > 0.61
            ? "end_highlands"
            : island > 0.52
              ? "end_midlands"
              : "end_barrens";
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
      x,
      z,
      id,
      profile,
      top,
      landTop: top,
      bottom,
      temperature: 0.5,
      moisture: 0,
      continental: 0,
      surface: profile.surface,
      soil: profile.soil,
      depth: 0,
      waterLevel: null,
      frozen: false,
      openings: EMPTY,
      surfaceOpen: false,
      treeSafe: false,
    };
  }

  function sampleColumn(x, z) {
    counters.surfaceQueries++;
    if (!v4InBounds(x, z)) return null;
    x = Math.floor(x);
    z = Math.floor(z);
    const key = `${x},${z}`;
    if (columns.has(key)) return columns.get(key);
    counters.surfaceSamples++;
    const value =
      dimension === "overworld"
        ? overworld(x, z)
        : dimension === "nether"
          ? nether(x, z)
          : end(x, z);
    return remember(columns, key, Object.freeze(value), V4_LIMITS.columns);
  }

  return {
    sampleColumn,
    get cacheSizes() {
      return { columns: columns.size, regions: regions.size };
    },
  };
}
