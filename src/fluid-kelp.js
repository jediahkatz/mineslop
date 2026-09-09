import { BLOCK } from "./blocks.js";
import { FLUID, isSourceWater, normalizeCell } from "./block-state.js";
import {
  KELP_GROW_TICKS,
  KELP_MAX_AGE,
  KELP_MAX_HEIGHT,
} from "./fluid-constants.js";
import { supportsKelp } from "./fluid-read.js";
import { isEditablePosition } from "./world-spec.js";

/** Both manual placement and natural extension accept source/falling water.
 * Bubble columns count as sources and become ordinary aquatic source water.
 * Lateral flow, dry cells and waterlogged structural hosts never qualify.
 */
export const isKelpWater = (cell) =>
  cell?.id === BLOCK.WATER &&
  (isSourceWater(cell.fluid) || cell.fluid === FLUID.WATER_FALLING);

function initialAge(world, x, y, z) {
  let hash = 2166136261;
  for (const char of `${world.seed}:${world.dimension}:${x},${y},${z}`)
    hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0) % KELP_MAX_AGE;
}

function rootedBelowLimit(scope, x, y, z) {
  let height = 1;
  let root = y - 1;
  while (scope.get(x, root, z)?.id === BLOCK.KELP) {
    if (++height >= KELP_MAX_HEIGHT) return false;
    root--;
  }
  return supportsKelp(scope, x, root, z);
}

/**
 * Called only for locally supported kelp in the shared bounded fluid proposal.
 * No age is written into block state (the registered mask is zero). Only tips
 * retain a saved timer. Cutting the tip exposes a newly initialized 0–24 tip.
 * This is a fixed-cadence equivalent, NOT Java's stochastic random-tick process.
 */
export function planKelpExtension(world, scope, entry, clock) {
  const { x, y, z } = entry;
  const above = scope.get(x, y + 1, z);
  if (above?.id === BLOCK.KELP) return {};
  const known = entry.kelpAge !== null && entry.kelpAge !== undefined;
  const kelp = {
    age: known ? entry.kelpAge : initialAge(world, x, y, z),
    due: known ? entry.kelpDue : clock + KELP_GROW_TICKS,
  };
  if (!known || clock < kelp.due) return { kelp };
  // Blockage, maximum age and height wait a whole new interval. A neighbor
  // wake may recheck support but must not turn a failed attempt into free growth.
  const next = { age: kelp.age, due: clock + KELP_GROW_TICKS };
  if (
    kelp.age >= KELP_MAX_AGE ||
    !isKelpWater(above) ||
    !isEditablePosition(x, y + 1, z, world.generatorVersion, world.dimension) ||
    !rootedBelowLimit(scope, x, y, z)
  )
    return { kelp: next };
  return {
    kelp,
    kelpNext: { x, y: y + 1, z, age: kelp.age + 1, due: next.due },
    change: {
      x,
      y: y + 1,
      z,
      before: above,
      after: normalizeCell({ id: BLOCK.KELP }),
    },
    reason: "kelp-growth",
  };
}
