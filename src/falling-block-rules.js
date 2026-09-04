import { BLOCK, BLOCKS } from "./blocks.js";
import { FLUID, normalizeCell } from "./block-state.js";
import { resolveShape } from "./block-shapes.js";
import { isWashablePlant, plantRemoval } from "./fluid-read.js";
import { inWorldBounds } from "./world-spec.js";

export const isFallingBlock = (id) =>
  id === BLOCK.SAND || id === BLOCK.RED_SAND || id === BLOCK.GRAVEL;

/**
 * Cell-aligned gravity. An occupied shape (even a bottom slab or open gate)
 * cannot share its cell with a full sand cube; stop ABOVE it, never replace it.
 * Only fluids and explicitly washable cross plants are displaceable.
 */
export function planFallingBlock(world, { x, y, z }) {
  if (!inWorldBounds(x, y, z, world.spec) || y <= world.spec.minY)
    return null;
  const before = world.getCell(x, y, z);
  if (!before || !isFallingBlock(before.id)) return null;
  const below = world.getCell(x, y - 1, z);
  if (!below) return null; // Missing resident data is NEVER air.
  const liquid = below.id === BLOCK.WATER || below.id === BLOCK.LAVA;
  const plant = isWashablePlant(below);
  if (below.id !== BLOCK.AIR && !liquid && !plant) return null;
  // Solid cross-shaped exceptions must not be destroyed by gravity.
  if (plant && BLOCKS[below.id]?.solid) return null;
  const reads = [];
  if (y - 2 >= world.spec.minY) {
    const support = world.getCell(x, y - 2, z);
    if (!support) return null;
    reads.push({ x, y: y - 2, z, before: support });
    // Fences/closed gates extend above their own cell. Derived connections
    // stay inside the horizontal cell; the central post is always present.
    if (resolveShape(support).collision.some((box) => box[4] > 1))
      return null;
  }
  const displaced = liquid
    ? below
    : normalizeCell({
        id: below.fluid === FLUID.WATER_SOURCE ? BLOCK.WATER : BLOCK.AIR,
      });
  const changes = [
    { x, y, z, before, after: displaced },
    { x, y: y - 1, z, before: below, after: before },
  ];
  const removal = plant ? plantRemoval(below, x, y - 1, z) : null;
  return {
    changes,
    reads,
    plants: removal ? [removal.plant] : [],
    drops: removal?.drops ?? [],
    // Test the whole swept cell pair, not only the landing position.
    bounds: [x, y - 1, z, x + 1, y + 1, z + 1],
  };
}
