import { hash, seedHash } from "./noise.js";
import { rotateStructureXZ } from "./structure-layouts.js";

// Surface sites share an owner and a single selection. Different decorators
// cannot overwrite each other's containers, nor overlap a neighboring owner.
export const STRUCTURE_SPACING = 192;
export const STRUCTURE_MAX_SAMPLES = 256;
export const STRUCTURE_WORLD_LIMIT = 30000000;

const villageBiomes = new Set([
  "plains",
  "sunflower_plains",
  "meadow",
  "savanna",
  "savanna_plateau",
  "desert",
  "snowy_plains",
  "taiga",
  "snowy_taiga",
]);
const netherBiomes = new Set([
  "nether_wastes",
  "soul_sand_valley",
  "crimson_forest",
  "warped_forest",
  "basalt_deltas",
]);

export const oceanColumn = (column) =>
  !!column &&
  typeof column.id === "string" &&
  (column.id === "ocean" || column.id.endsWith("_ocean")) &&
  Number.isInteger(column.waterLevel);
export const beachColumn = (column) =>
  column?.id === "beach" || column?.id === "snowy_beach";
export const villageColumn = (column) =>
  !!column &&
  villageBiomes.has(column.id) &&
  column.waterLevel === null &&
  hasSurfaceSupport(column);
export const netherColumn = (column) =>
  !!column &&
  netherBiomes.has(column.id) &&
  Number.isInteger(column.lavaLevel) &&
  Number.isInteger(column.roof) &&
  column.top > column.lavaLevel + 1 &&
  hasSurfaceSupport(column);

export function hasSurfaceSupport(column) {
  return (
    !!column &&
    Number.isInteger(column.top) &&
    column.top === column.landTop &&
    !column.surfaceOpen &&
    (column.openings ?? []).every(([, high]) => high < column.top - 3)
  );
}

export function validateStructureContext(context) {
  if (
    !context ||
    !["overworld", "nether", "end"].includes(context.dimension) ||
    typeof context.sampleColumn !== "function" ||
    !Number.isSafeInteger(context.spec?.minY) ||
    !Number.isSafeInteger(context.spec?.maxY) ||
    context.spec.minY >= context.spec.maxY ||
    context.seed === undefined
  )
    throw new TypeError(
      "Structures require seed, dimension, spec and a cheap sampleColumn"
    );
}

export function createStructureSite(context, gx, gz) {
  validateStructureContext(context);
  if (!Number.isSafeInteger(gx) || !Number.isSafeInteger(gz))
    throw new RangeError("Structure owners must be safe integer coordinates");
  const seed = String(context.seed);
  const salt = seedHash(seed);
  const random = (label) =>
    hash(gx, gz, salt ^ seedHash(`structure/v1/${label}`));
  const origin = {
    x: gx * STRUCTURE_SPACING + 48 + Math.floor(random("anchor-x") * 96),
    y: 0,
    z: gz * STRUCTURE_SPACING + 48 + Math.floor(random("anchor-z") * 96),
  };
  if (
    !Number.isSafeInteger(origin.x) ||
    !Number.isSafeInteger(origin.z) ||
    origin.x - 32 < -STRUCTURE_WORLD_LIMIT ||
    origin.x + 32 >= STRUCTURE_WORLD_LIMIT ||
    origin.z - 32 < -STRUCTURE_WORLD_LIMIT ||
    origin.z + 32 >= STRUCTURE_WORLD_LIMIT
  )
    return null;
  const rotation = Math.floor(random("rotation") * 4);
  const columns = new Map();
  const sample = (x, z) => {
    const key = `${x},${z}`;
    if (columns.has(key)) return columns.get(key);
    if (columns.size >= STRUCTURE_MAX_SAMPLES)
      throw new RangeError("Structure description exceeded its column budget");
    const [rx, rz] = rotateStructureXZ(x, z, rotation);
    const column = context.sampleColumn(origin.x + rx, origin.z + rz);
    columns.set(key, column);
    return column;
  };
  return {
    seed,
    dimension: context.dimension,
    spec: context.spec,
    gx,
    gz,
    origin,
    rotation,
    random,
    sample,
  };
}

export function selectStructureKind(site) {
  if (!site || site.dimension === "end") return null;
  const column = site.sample(0, 0);
  if (!hasSurfaceSupport(column)) return null;
  const choice = site.random("family");
  if (site.dimension === "nether") {
    if (!netherColumn(column)) return null;
    return choice < 0.55 ? "nether_fortress" : "bastion_remnant";
  }
  if (oceanColumn(column)) {
    if (column.depth >= 26 && !column.frozen && choice < 0.22)
      return "ocean_monument";
    return choice < 0.62 ? "shipwreck" : "ocean_ruin";
  }
  if (beachColumn(column))
    return choice < 0.18 ? "shipwreck" : "buried_treasure";
  if (villageColumn(column) && choice < 0.55) return "village";
  if (column.waterLevel === null && choice >= 0.78) return "dungeon";
  return null;
}

export function sampleAxis(minimum, maximum, step) {
  const values = [];
  for (let n = minimum; n <= maximum; n += step) values.push(n);
  if (values.at(-1) !== maximum) values.push(maximum);
  return values;
}

/**
 * A sparse, bounded terrain survey, never a chunk/cave planner. Exact pier
 * coordinates are sampled separately. Large local relief, surface openings,
 * insufficient water/roof clearance, and mixed forbidden climates reject.
 */
export function surveyStructure(
  site,
  {
    x0,
    z0,
    x1,
    z1,
    step = 4,
    maxRelief = 3,
    height = 1,
    predicate = hasSurfaceSupport,
    submerged = false,
  }
) {
  const columns = [];
  for (const z of sampleAxis(z0, z1, step))
    for (const x of sampleAxis(x0, x1, step)) {
      const column = site.sample(x, z);
      if (!hasSurfaceSupport(column) || !predicate(column)) return null;
      columns.push({ x, z, column });
    }
  if (
    x0 <= 0 &&
    x1 >= 0 &&
    z0 <= 0 &&
    z1 >= 0 &&
    !columns.some(({ x, z }) => x === 0 && z === 0)
  ) {
    // Selection caches the anchor, but an offset survey grid can omit it.
    const column = site.sample(0, 0);
    if (!hasSurfaceSupport(column) || !predicate(column)) return null;
    columns.push({ x: 0, z: 0, column });
  }
  const minTop = Math.min(...columns.map(({ column }) => column.top));
  const maxTop = Math.max(...columns.map(({ column }) => column.top));
  if (maxTop - minTop > maxRelief) return null;
  const floorY = maxTop + 1;
  if (minTop - 1 < site.spec.minY || floorY + height >= site.spec.maxY)
    return null;
  if (
    columns.some(
      ({ column }) =>
        (Number.isInteger(column.roof) && floorY + height >= column.roof - 2) ||
        (submerged &&
          (!Number.isInteger(column.waterLevel) ||
            floorY + height > column.waterLevel - 2))
    )
  )
    return null;
  return { floorY, minTop, maxTop, columns };
}

export function structureSupports(site, points, floorY, maxDrop = 7) {
  const result = [];
  for (const [x, z, top = 0] of points) {
    const column = site.sample(x, z);
    if (
      !hasSurfaceSupport(column) ||
      floorY + top - column.top < 0 ||
      floorY + top - column.top > maxDrop
    )
      return null;
    result.push({ x, z, bottom: column.top - 1 - floorY, top });
  }
  return result;
}

export const supportMinimum = (supports) =>
  Math.min(0, ...supports.map(({ bottom }) => bottom));

export function dryLandColumn(column) {
  return (
    !!column &&
    column.waterLevel === null &&
    hasSurfaceSupport(column) &&
    !beachColumn(column) &&
    !oceanColumn(column) &&
    !netherBiomes.has(column.id)
  );
}
