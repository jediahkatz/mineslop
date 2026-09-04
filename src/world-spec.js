import { hasExpandedTerrain, isSupportedGeneratorVersion } from "./generator-version.js";
import { WATER_LEVEL, WORLD_HEIGHT, WORLD_MAX, WORLD_MIN } from "./terrain.js";

export const DIMENSIONS = Object.freeze(["overworld", "nether", "end"]);
export const isDimension = (dimension) => DIMENSIONS.includes(dimension);

const historical = Object.freeze({
  overworld: Object.freeze({
    minY: 0,
    maxY: WORLD_HEIGHT,
    seaLevel: WATER_LEVEL,
    voidY: -20,
  }),
  nether: Object.freeze({
    minY: 0,
    maxY: WORLD_HEIGHT,
    seaLevel: null,
    voidY: -20,
  }),
  end: Object.freeze({
    minY: 0,
    maxY: WORLD_HEIGHT,
    seaLevel: null,
    voidY: -20,
  }),
});
const expanded = Object.freeze({
  overworld: Object.freeze({
    minY: -64,
    maxY: 320,
    seaLevel: 63,
    voidY: -128,
  }),
  nether: Object.freeze({
    minY: 0,
    maxY: 256,
    seaLevel: null,
    voidY: -64,
  }),
  end: Object.freeze({
    minY: 0,
    maxY: 256,
    seaLevel: null,
    voidY: -64,
  }),
});

/** Explicit capabilities: 1–3 are historical; 4–7 share expanded bounds.
 * This does not choose a new-world default or upgrade any persisted version.
 */
export function getWorldSpec(generatorVersion, dimension) {
  if (!isDimension(dimension)) throw new RangeError("Unknown dimension");
  if (!isSupportedGeneratorVersion(generatorVersion))
    throw new RangeError("Unsupported terrain generator version");
  return (hasExpandedTerrain(generatorVersion) ? expanded : historical)[dimension];
}

export const inColumnBounds = (x, z) =>
  Number.isSafeInteger(x) &&
  Number.isSafeInteger(z) &&
  x >= WORLD_MIN &&
  x < WORLD_MAX &&
  z >= WORLD_MIN &&
  z < WORLD_MAX;

export const inWorldBounds = (x, y, z, spec) =>
  inColumnBounds(x, z) &&
  Number.isSafeInteger(y) &&
  y >= spec.minY &&
  y < spec.maxY;

/** Historical saves disallow the bottom layer, even in an empty End column. */
export function isEditablePosition(x, y, z, generatorVersion, dimension) {
  return (
    inWorldBounds(x, y, z, getWorldSpec(generatorVersion, dimension)) &&
    (hasExpandedTerrain(generatorVersion) || y !== 0)
  );
}

export function createWorldContext({ seed, generatorVersion }) {
  getWorldSpec(generatorVersion, "overworld");
  return Object.freeze({
    seed,
    generatorVersion,
    specForDimension: (dimension) => getWorldSpec(generatorVersion, dimension),
  });
}

/** Entity positions can be above maxY; only safe voxel arithmetic bounds flight. */
export function isWorldPose(position, context, dimension = "overworld") {
  if (!position || !isDimension(dimension)) return false;
  const { x, y, z } = position;
  return (
    [x, y, z].every(Number.isFinite) &&
    x >= WORLD_MIN &&
    x < WORLD_MAX &&
    z >= WORLD_MIN &&
    z < WORLD_MAX &&
    y > context.specForDimension(dimension).voidY &&
    Number.isSafeInteger(Math.floor(y)) &&
    Number.isSafeInteger(Math.ceil(y + 2))
  );
}
