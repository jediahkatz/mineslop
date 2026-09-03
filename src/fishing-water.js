import { FLUID, normalizeCell } from "./block-state.js";
import { resolveShape } from "./block-shapes.js";
import { BLOCK, BLOCKS } from "./blocks.js";
import {
  geometryWorldSpec,
  readGeometryCell,
  shapeAt,
} from "./geometry-world.js";
import { finitePoint, loadedAquaticArea } from "./vehicle-water.js";

export function fishingOpenWaterBounds(position) {
  const x = Math.floor(position.x),
    y = Math.floor(position.y),
    z = Math.floor(position.z);
  return [x - 2, y - 1, z - 2, x + 3 - 1e-7, y + 3 - 1e-7, z + 3 - 1e-7];
}

const keyFor = (x, y, z) => `${x},${y},${z}`;

function cellType(world, x, y, z, afterCells) {
  const spec = geometryWorldSpec(world);
  if (y >= spec.maxY) return "above";
  if (y < spec.minY) return "invalid";
  const read = (x, y, z) =>
    afterCells?.get(keyFor(x, y, z)) ?? readGeometryCell(world, x, y, z);
  const cell = read(x, y, z);
  if (!cell) return "unloaded";
  if (
    cell.fluid === FLUID.NONE &&
    (cell.id === BLOCK.AIR || BLOCKS[cell.id]?.fishingAboveWater === true)
  )
    return "above";
  // Bubble water is a source for other mechanics, but NEVER for this predicate.
  if (cell.fluid !== FLUID.WATER_SOURCE) return "invalid";
  const shape = afterCells
    ? resolveShape(cell, (dx, dy, dz) => read(x + dx, y + dy, z + dz))
    : shapeAt(world, x, y, z)?.shape;
  return shape && shape.collision.length === 0 ? "water" : "invalid";
}

/**
 * Java's 5x4x5 layered open-water predicate, centered on the bobber cell:
 * offsets X/Z -2..2 and Y -1..2. Each full layer must be uniformly source
 * water without collision, or uniformly air/lily-pad-like registered blocks.
 * The bottom cannot be air, and water cannot resume above an air layer.
 * There is no sky ray, fish-mob, bait, biome, or generated-world requirement.
 */
export function inspectFishingOpenWater(world, position, afterCells) {
  if (!finitePoint(position))
    return { loaded: false, valid: false, reason: "invalid-position" };
  if (!loadedAquaticArea(world, fishingOpenWaterBounds(position)))
    return { loaded: false, valid: false, reason: "frontier" };
  const x = Math.floor(position.x),
    y = Math.floor(position.y),
    z = Math.floor(position.z);
  let previous = null;
  for (let dy = -1; dy <= 2; dy++) {
    let layer = null;
    for (let dx = -2; dx <= 2; dx++)
      for (let dz = -2; dz <= 2; dz++) {
        const type = cellType(world, x + dx, y + dy, z + dz, afterCells);
        if (type === "unloaded")
          return { loaded: false, valid: false, reason: "frontier" };
        if (type === "invalid")
          return { loaded: true, valid: false, reason: "source-or-clearance" };
        if (layer !== null && type !== layer)
          return { loaded: true, valid: false, reason: "mixed-layer" };
        layer = type;
      }
    if (previous === null && layer === "above")
      return { loaded: true, valid: false, reason: "dry-bottom" };
    if (previous === "above" && layer === "water")
      return { loaded: true, valid: false, reason: "water-above-air" };
    previous = layer;
  }
  return { loaded: true, valid: true, reason: null };
}

/**
 * Inspect a postcommit envelope's after-image as well as today's World. Another
 * observer may already have repaired its invalid water before we receive it.
 * This is predicate-only event data, not a replacement World or a mutation.
 */
export function inspectFishingMutationWater(world, position, changes) {
  if (!Array.isArray(changes) || changes.length > 1024)
    return { loaded: true, valid: false, reason: "mutation-limit" };
  const afterCells = new Map();
  try {
    for (const change of changes) {
      if (
        !mutationTouchesFishingWater(position, change) ||
        change.after === undefined
      )
        continue;
      afterCells.set(
        keyFor(change.x, change.y, change.z),
        normalizeCell(change.after)
      );
    }
  } catch {
    return { loaded: true, valid: false, reason: "invalid-mutation-cell" };
  }
  return inspectFishingOpenWater(world, position, afterCells);
}

export function mutationTouchesFishingWater(position, change) {
  if (!change || ![change.x, change.y, change.z].every(Number.isSafeInteger))
    return false;
  const x = Math.floor(position.x),
    y = Math.floor(position.y),
    z = Math.floor(position.z);
  // Include the apron used to resolve connected shape collision.
  return (
    Math.abs(change.x - x) <= 3 &&
    Math.abs(change.z - z) <= 3 &&
    change.y >= y - 2 &&
    change.y <= y + 3
  );
}
