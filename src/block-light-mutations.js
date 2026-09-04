import { BLOCK_STATE, isWaterFluid } from "./block-state.js";
import { BLOCKS } from "./blocks.js";
import { opaqueCube } from "./mesh-palette.js";

// Covers the native fluid scheduler's default 96 x 4 catch-up work, as well
// as 256 x 4 single-cell hard-limit updates. Excess fails closed.
export const BLOCK_LIGHT_MUTATION_CELLS = 1024;

// Deliberately narrow proof, not a general shape/lighting equivalence guess.
// The solver treats all water levels identically. Full-cube log axes change
// artwork, not emission, occupancy or neighboring shape connections.
export function benignBlockLightChange({ before, after }) {
  if (!before || !after || before.id !== after.id) return false;
  if (before.fluid !== after.fluid &&
    !(isWaterFluid(before.fluid) && isWaterFluid(after.fluid))) return false;
  if (before.state === after.state) return true;
  return Boolean(opaqueCube[before.id] && BLOCKS[before.id]?.directional === "axis" &&
    !((before.state ^ after.state) & ~(BLOCK_STATE.AXIS_X | BLOCK_STATE.AXIS_Z)));
}
