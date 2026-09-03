import { defaultFluidFor, FLUID } from "./block-state.js";
import { BLOCK } from "./blocks.js";
import { resolveShape } from "./block-shapes.js";
import { CHUNK_SIZE, WORLD_MAX, WORLD_MIN } from "./terrain.js";
import { getWorldSpec, isDimension } from "./world-spec.js";

export const AIR_CELL = Object.freeze({
  id: BLOCK.AIR,
  state: 0,
  fluid: FLUID.NONE,
});
export const SOLID_CELL = Object.freeze({
  id: BLOCK.STONE,
  state: 0,
  fluid: FLUID.NONE,
});

/** Accepts a live world, archive context, or an explicit spec in authored tests. */
export function geometryWorldSpec(
  context,
  dimension = context?.dimension ?? "overworld"
) {
  if (typeof context?.specForDimension === "function")
    return context.specForDimension(dimension);
  if (
    context?.spec &&
    (context.dimension === undefined || context.dimension === dimension)
  )
    return context.spec;
  if (
    context?.spec === undefined &&
    Number.isFinite(context?.minY) &&
    Number.isFinite(context?.maxY)
  )
    return context;
  return getWorldSpec(context?.generatorVersion ?? 3, dimension);
}

export const geometryEpoch = (world) => world.epoch ?? world._epoch;
export const inHorizontalBounds = (x, z) =>
  Number.isFinite(x) &&
  Number.isFinite(z) &&
  x >= WORLD_MIN &&
  x < WORLD_MAX &&
  z >= WORLD_MIN &&
  z < WORLD_MAX;

export function columnLoaded(world, x, z) {
  if (!inHorizontalBounds(x, z)) return false;
  if (typeof world.isLoaded === "function") return world.isLoaded(x, z);
  if (world.chunks)
    return world.chunks.has(
      `${Math.floor(x / CHUNK_SIZE)},${Math.floor(z / CHUNK_SIZE)}`
    );
  return true;
}

/** A non-generating, detached scalar read with legacy test/world adapters. */
export function readGeometryCell(world, x, y, z) {
  if (![x, y, z].every(Number.isSafeInteger)) return null;
  const spec = geometryWorldSpec(world);
  if (y < spec.minY || y >= spec.maxY || !columnLoaded(world, x, z))
    return null;
  if (typeof world.getCell === "function") return world.getCell(x, y, z);
  const id =
    typeof world.get === "function"
      ? world.get(x, y, z)
      : world.isSolid?.(x, y, z)
        ? BLOCK.STONE
        : BLOCK.AIR;
  return {
    id,
    state: world.getBlockState?.(x, y, z) ?? 0,
    fluid: world.getFluid?.(x, y, z) ?? defaultFluidFor(id),
  };
}

export function shapeAt(world, x, y, z, channel) {
  const cell = readGeometryCell(world, x, y, z);
  if (!cell) return null;
  // Older physics-only callers deliberately expose isSolid without cell/state
  // APIs. Keep that adapter authoritative; modern worlds always use channels.
  if (
    (channel === "collision" || channel === "support") &&
    !world.getCell &&
    !world.getBlockState &&
    world.isSolid
  ) {
    return {
      cell,
      shape: resolveShape(world.isSolid(x, y, z) ? SOLID_CELL : AIR_CELL),
    };
  }
  return {
    cell,
    shape: resolveShape(cell, (dx, dy, dz) =>
      readGeometryCell(world, x + dx, y + dy, z + dz)
    ),
  };
}

/** Save bounds are not build bounds. Leave safe high-flight coordinates intact. */
export function validBodyPosition(
  position,
  context,
  {
    radius = 0,
    height = 2,
    dimension = position?.dimension ?? context?.dimension ?? "overworld",
    floorInclusive = true,
  } = {}
) {
  if (
    !position ||
    !isDimension(dimension) ||
    ![position.x, position.y, position.z, radius, height].every(
      Number.isFinite
    ) ||
    radius < 0 ||
    height < 0
  )
    return false;
  const { minY } = geometryWorldSpec(context, dimension);
  return (
    position.x >= WORLD_MIN + radius &&
    position.x <= WORLD_MAX - radius &&
    position.z >= WORLD_MIN + radius &&
    position.z <= WORLD_MAX - radius &&
    (radius > 0 || (position.x < WORLD_MAX && position.z < WORLD_MAX)) &&
    (floorInclusive ? position.y >= minY : position.y > minY) &&
    Number.isSafeInteger(Math.floor(position.y)) &&
    Number.isSafeInteger(Math.ceil(position.y + height))
  );
}
