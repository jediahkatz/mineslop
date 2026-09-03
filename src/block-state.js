import { BLOCK, BLOCKS } from "./blocks.js";

export const BLOCK_STATE = Object.freeze({
  FACING_MASK: 3,
  TOP: 4,
  OPEN: 8,
  HINGE_RIGHT: 16,
  PART: 32,
  DOUBLE: 64,
  AXIS_X: 128,
  AXIS_Z: 256,
});

export const FLUID = Object.freeze({
  NONE: 0,
  WATER_SOURCE: 1,
  WATER_1: 2,
  WATER_2: 3,
  WATER_3: 4,
  WATER_4: 5,
  WATER_5: 6,
  WATER_6: 7,
  WATER_7: 8,
  WATER_FALLING: 9,
  BUBBLE_UP: 10,
  BUBBLE_DOWN: 11,
  LAVA_SOURCE: 16,
});

const S = BLOCK_STATE;
const shapeMasks = Object.freeze({
  slab: S.TOP | S.DOUBLE,
  stairs: S.FACING_MASK | S.TOP,
  door: S.FACING_MASK | S.OPEN | S.HINGE_RIGHT | S.PART,
  trapdoor: S.FACING_MASK | S.TOP | S.OPEN,
  fence_gate: S.FACING_MASK | S.OPEN,
  ladder: S.FACING_MASK,
  bed: S.FACING_MASK | S.PART,
});

export const isRegisteredBlock = (id) =>
  Number.isInteger(id) && id >= 0 && id <= 65535 && BLOCKS[id]?.id === id;

export const isWaterFluid = (code) =>
  Number.isInteger(code) &&
  code >= FLUID.WATER_SOURCE &&
  code <= FLUID.BUBBLE_DOWN;

export const isSourceWater = (code) =>
  code === FLUID.WATER_SOURCE ||
  code === FLUID.BUBBLE_UP ||
  code === FLUID.BUBBLE_DOWN;

export function defaultFluidFor(id) {
  if (id === BLOCK.WATER || BLOCKS[id]?.aquatic === true)
    return FLUID.WATER_SOURCE;
  return id === BLOCK.LAVA ? FLUID.LAVA_SOURCE : FLUID.NONE;
}

/**
 * Registry declarations, not texture names, opt into orientation. In particular,
 * bamboo/sugar cane must not inherit log axes from their historical artwork.
 */
export function stateMaskFor(id) {
  const block = BLOCKS[id];
  if (!block) return 0;
  let mask = shapeMasks[block.shape] ?? 0;
  if (block.directional === "axis") mask |= S.AXIS_X | S.AXIS_Z;
  else if (block.directional === true || block.directional === "facing")
    mask |= S.FACING_MASK;
  return mask;
}

function validValues(id, state, fluid) {
  if (
    !isRegisteredBlock(id) ||
    !Number.isInteger(state) ||
    state < 0 ||
    state > 65535 ||
    (state & ~stateMaskFor(id)) !== 0 ||
    (state & (S.AXIS_X | S.AXIS_Z)) === (S.AXIS_X | S.AXIS_Z)
  )
    return false;
  const block = BLOCKS[id];
  if (block.shape === "slab" && state & S.DOUBLE && state & S.TOP) return false;
  if (id === BLOCK.WATER) return isWaterFluid(fluid);
  if (id === BLOCK.LAVA) return fluid === FLUID.LAVA_SOURCE;
  if (block.aquatic === true) return fluid === FLUID.WATER_SOURCE;
  if (fluid === FLUID.NONE) return true;
  return (
    fluid === FLUID.WATER_SOURCE &&
    block.waterloggable === true &&
    block.shape !== "door" &&
    block.shape !== "bed" &&
    !(block.shape === "slab" && state & S.DOUBLE)
  );
}

export function isValidCell(cell) {
  return (
    cell !== null &&
    typeof cell === "object" &&
    !Array.isArray(cell) &&
    validValues(
      cell.id,
      cell.state === undefined ? 0 : cell.state,
      cell.fluid === undefined ? defaultFluidFor(cell.id) : cell.fluid
    )
  );
}

/** Omitted components mean canonical defaults; explicit invalid values reject. */
export function normalizeCell(cell) {
  if (!isValidCell(cell)) throw new RangeError("Invalid block cell");
  return {
    id: cell.id,
    state: cell.state === undefined ? 0 : cell.state,
    fluid: cell.fluid === undefined ? defaultFluidFor(cell.id) : cell.fluid,
  };
}

export const cellsEqual = (a, b) =>
  a === b ||
  (a !== null &&
    a !== undefined &&
    b !== null &&
    b !== undefined &&
    a.id === b.id &&
    a.state === b.state &&
    a.fluid === b.fluid);

/** Explicit breaking is distinct from set(AIR), which installs a dry cell. */
export function cellAfterBreaking(cell) {
  const before = normalizeCell(cell);
  return normalizeCell({
    id:
      before.id !== BLOCK.WATER &&
      before.id !== BLOCK.LAVA &&
      before.fluid === FLUID.WATER_SOURCE
        ? BLOCK.WATER
        : BLOCK.AIR,
  });
}
