import { cellsEqual, FLUID, isWaterFluid } from "./block-state.js";
import { fluidAtPoint } from "./collision.js";
import { captureEntityContext } from "./entity-context.js";
import {
  columnLoaded,
  geometryWorldSpec,
  inHorizontalBounds,
  readGeometryCell,
  shapeAt,
} from "./geometry-world.js";

export const AQUATIC_READ_LIMIT = 1024;
const zeroCurrent = Object.freeze({ x: 0, y: 0, z: 0 });
const fluidCodes = new Set(Object.values(FLUID));
export const finitePoint = (point) =>
  !!point && [point.x, point.y, point.z].every(Number.isFinite);
export const synchronousAquaticCallback = (callback) =>
  typeof callback === "function" &&
  Object.prototype.toString.call(callback) === "[object Function]";

/**
 * Shared, non-generating fallback. The fluid code is collision.fluidAtPoint's
 * exact shape-volume result, not a second water representation. surfaceY is
 * the top of the intersected local volume, not a scan up an entire water column.
 * The fluid owner may inject (world, point) => {fluid, surfaceY, current:{x,y,z}}.
 * `sampleFluidAtPoint` in fluid-sampling.js is directly compatible, including its
 * valid/loaded flags. Null also means unavailable. Current is the fluid owner's
 * unitless direction; each entity supplies acceleration/damping. Bubbles are
 * derived from canonical FLUID codes, never an independent water representation.
 */
export function sharedAquaticSample(world, point) {
  if (!finitePoint(point) || !columnLoaded(world, point.x, point.z))
    return null;
  const spec = geometryWorldSpec(world);
  // Out-of-build sky/void is dry, not an unloaded frontier or a support plane.
  if (point.y < spec.minY || point.y >= spec.maxY)
    return { fluid: FLUID.NONE, surfaceY: null, current: zeroCurrent };
  const resolved = shapeAt(
    world,
    Math.floor(point.x),
    Math.floor(point.y),
    Math.floor(point.z)
  );
  if (!resolved) return null;
  const fluid = fluidAtPoint(world, point);
  const localX = point.x - Math.floor(point.x);
  const localZ = point.z - Math.floor(point.z);
  let surfaceY = null;
  for (const bounds of resolved.shape.fluidVolume) {
    if (
      localX < bounds[0] ||
      localX > bounds[3] ||
      localZ < bounds[2] ||
      localZ > bounds[5]
    )
      continue;
    const top = Math.floor(point.y) + bounds[4];
    surfaceY = surfaceY === null ? top : Math.max(surfaceY, top);
  }
  return { fluid, surfaceY, current: zeroCurrent };
}

export function aquaticSample(world, point, provider = sharedAquaticSample) {
  if (!finitePoint(point) || !synchronousAquaticCallback(provider)) return null;
  const value = provider(world, point);
  if (
    !value ||
    value.valid === false ||
    value.loaded === false ||
    !fluidCodes.has(value.fluid)
  )
    return null;
  const current = value.current ?? zeroCurrent;
  if (
    !finitePoint(current) ||
    [current.x, current.y, current.z].some(
      (component) => Math.abs(component) > 1 + 1e-7
    ) ||
    (value.surfaceY !== null &&
      value.surfaceY !== undefined &&
      !Number.isFinite(value.surfaceY))
  )
    return null;
  return {
    fluid: value.fluid,
    water: isWaterFluid(value.fluid),
    source: value.fluid === FLUID.WATER_SOURCE,
    bubble:
      value.fluid === FLUID.BUBBLE_UP
        ? 1
        : value.fluid === FLUID.BUBBLE_DOWN
          ? -1
          : 0,
    surfaceY: value.surfaceY ?? null,
    current: { x: current.x, y: current.y, z: current.z },
  };
}

/** Unknown availability is never treated as an infinite loaded world. */
export function loadedAquaticArea(world, bounds, apron = 1) {
  if (
    !world ||
    (typeof world.isLoaded !== "function" && !(world.chunks instanceof Map)) ||
    !Array.isArray(bounds) ||
    bounds.length !== 6 ||
    !bounds.every(Number.isFinite) ||
    !Number.isInteger(apron) ||
    apron < 0 ||
    apron > 2 ||
    [0, 1, 2].some((axis) => bounds[axis] > bounds[axis + 3])
  )
    return false;
  const x0 = Math.floor(bounds[0]) - apron,
    x1 = Math.floor(bounds[3]) + apron;
  const z0 = Math.floor(bounds[2]) - apron,
    z1 = Math.floor(bounds[5]) + apron;
  if (
    !inHorizontalBounds(x0, z0) ||
    !inHorizontalBounds(x1, z1) ||
    (x1 - x0 + 1) * (z1 - z0 + 1) > AQUATIC_READ_LIMIT
  )
    return false;
  for (let x = x0; x <= x1; x++)
    for (let z = z0; z <= z1; z++) if (!columnLoaded(world, x, z)) return false;
  return true;
}

/**
 * Action-only read guard, including connected-shape neighbors. Movement never
 * creates these snapshots. Exact cells plus incarnation/revision reject an
 * unload/reload or equal-byte block replacement between prepare and commit.
 */
export function captureAquaticArea(world, context, bounds) {
  if (!loadedAquaticArea(world, bounds)) return null;
  const spec = geometryWorldSpec(world);
  const x0 = Math.floor(bounds[0]) - 1,
    x1 = Math.floor(bounds[3]) + 1;
  const z0 = Math.floor(bounds[2]) - 1,
    z1 = Math.floor(bounds[5]) + 1;
  const y0 = Math.max(spec.minY, Math.floor(bounds[1]) - 1);
  const y1 = Math.min(spec.maxY - 1, Math.floor(bounds[4]) + 1);
  if (
    (x1 - x0 + 1) * (z1 - z0 + 1) * Math.max(0, y1 - y0 + 1) >
    AQUATIC_READ_LIMIT
  )
    return null;
  const current = captureEntityContext(world, context);
  const cells = [];
  for (let x = x0; x <= x1; x++)
    for (let z = z0; z <= z1; z++)
      for (let y = y0; y <= y1; y++) {
        const cell = readGeometryCell(world, x, y, z);
        if (!cell) return null;
        cells.push({ x, y, z, cell: { ...cell } });
      }
  const columns = [];
  if (world.chunks instanceof Map) {
    for (let cx = Math.floor(x0 / 16); cx <= Math.floor(x1 / 16); cx++)
      for (let cz = Math.floor(z0 / 16); cz <= Math.floor(z1 / 16); cz++) {
        const key = `${cx},${cz}`;
        const chunk = world.chunks.get(key);
        if (!chunk) return null;
        columns.push({
          key,
          chunk,
          incarnation: chunk.incarnation,
          revision: chunk.revision,
        });
      }
  }
  return () =>
    current() &&
    loadedAquaticArea(world, bounds) &&
    columns.every(
      ({ key, chunk, incarnation, revision }) =>
        world.chunks.get(key) === chunk &&
        chunk.incarnation === incarnation &&
        chunk.revision === revision
    ) &&
    cells.every(({ x, y, z, cell }) =>
      cellsEqual(readGeometryCell(world, x, y, z), cell)
    );
}

export function aquaticSweepBounds(position, destination, radius, height) {
  return [
    Math.min(position.x, destination.x) - radius,
    Math.min(position.y, destination.y),
    Math.min(position.z, destination.z) - radius,
    Math.max(position.x, destination.x) + radius,
    Math.max(position.y, destination.y) + height,
    Math.max(position.z, destination.z) + radius,
  ];
}
