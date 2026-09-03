import { BOX_EPSILON } from "./aabb.js";
import { coversFace, resolveShape } from "./block-shapes.js";
import { BLOCK, BLOCKS } from "./blocks.js";
import { FLUID, isSourceWater, isWaterFluid } from "./block-state.js";
import {
  fluidCellKey,
  fluidColumnKey,
  MAX_FLUID_PLAN_READS,
} from "./fluid-constants.js";
import { inColumnBounds, inWorldBounds } from "./world-spec.js";

const BOUNDARY = Object.freeze({
  id: BLOCK.STONE,
  state: 0,
  fluid: FLUID.NONE,
});
const AIR = Object.freeze({ id: BLOCK.AIR, state: 0, fluid: FLUID.NONE });

export class FluidReadLimitError extends Error {}

/** Bounded, non-generating reads, including every derived-shape prerequisite.
 * Outside build bounds is a closed bottom/side or open sky, not an unloaded
 * frontier. Null resident reads, however, must never be interpreted as air.
 */
export class FluidReadScope {
  constructor(world, { maxReads = MAX_FLUID_PLAN_READS, stats } = {}) {
    this.world = world;
    this.maxReads = maxReads;
    this.stats = stats;
    this.cells = new Map();
    this.shapes = new Map();
    this.waiting = new Map();
  }

  get(x, y, z) {
    if (!inColumnBounds(x, z) || y < this.world.spec.minY) return BOUNDARY;
    if (y >= this.world.spec.maxY) return AIR;
    if (!Number.isSafeInteger(y)) return null;
    const key = fluidCellKey(x, y, z);
    const cached = this.cells.get(key);
    if (cached) return cached.before;
    if (this.cells.size >= this.maxReads)
      throw new FluidReadLimitError("Fluid read budget exhausted");
    const before = this.world.getCell(x, y, z);
    if (this.stats) this.stats.reads++;
    this.cells.set(key, { x, y, z, before });
    if (before === null) {
      const cx = Math.floor(x / 16),
        cz = Math.floor(z / 16);
      this.waiting.set(fluidColumnKey(cx, cz), [cx, cz]);
    }
    return before;
  }

  shape(x, y, z) {
    const key = fluidCellKey(x, y, z);
    if (this.shapes.has(key)) return this.shapes.get(key);
    const cell = this.get(x, y, z);
    if (!cell) return null;
    if (this.stats) this.stats.shapes++;
    const shape = resolveShape(cell, (dx, dy, dz) =>
      this.get(x + dx, y + dy, z + dz)
    );
    this.shapes.set(key, shape);
    return shape;
  }

  reads() {
    return [...this.cells.values()];
  }

  unloaded() {
    return [...this.waiting.values()];
  }
}

/** Only physically overlapping openings connect two cells. A dry source-only
 * host still cannot RECEIVE flowing water, even when its geometry has openings.
 * Java reference: https://minecraft.wiki/w/Waterlogging#Properties
 */
export function openFluidConnection(scope, x, y, z, direction) {
  const from = scope.shape(x, y, z);
  const to = scope.shape(x + direction.x, y + direction.y, z + direction.z);
  if (!from || !to) return false;
  for (const a of from.openFaces[direction.face])
    for (const b of to.openFaces[direction.opposite])
      if (
        Math.min(a[2], b[2]) - Math.max(a[0], b[0]) > BOX_EPSILON &&
        Math.min(a[3], b[3]) - Math.max(a[1], b[1]) > BOX_EPSILON
      )
        return true;
  return false;
}

export function isWashablePlant(cell) {
  return (
    !!cell &&
    BLOCKS[cell.id]?.shape === "cross" &&
    !BLOCKS[cell.id].waterloggable &&
    cell.id !== BLOCK.BAMBOO &&
    cell.id !== BLOCK.SULFUR_SPIKE
  );
}

export const canReceiveWater = (cell) =>
  !!cell &&
  (cell.id === BLOCK.AIR || cell.id === BLOCK.WATER || isWashablePlant(cell));

export function waterLevel(fluid) {
  if (isSourceWater(fluid) || fluid === FLUID.WATER_FALLING) return 0;
  return fluid >= FLUID.WATER_1 && fluid <= FLUID.WATER_7
    ? fluid - 1
    : Infinity;
}

export function fullTopSupport(scope, x, y, z) {
  const cell = scope.get(x, y, z);
  return (
    !!cell &&
    BLOCKS[cell.id]?.solid === true &&
    coversFace(scope.shape(x, y, z), "up")
  );
}

export function supportsKelp(scope, x, y, z) {
  const cell = scope.get(x, y, z);
  return (
    !!cell &&
    cell.id !== BLOCK.MAGMA_BLOCK &&
    (cell.id === BLOCK.KELP || fullTopSupport(scope, x, y, z))
  );
}

export function plantRemoval(cell, x, y, z) {
  const id = BLOCKS[cell.id]?.drop;
  return {
    plant: { x, y, z, before: { ...cell } },
    // Seagrass is destroyed without loot in Java. It is STILL reported as an
    // owned plant, so the caller must explicitly approve its joint removal.
    drops:
      cell.id !== BLOCK.SEAGRASS && Number.isInteger(id) && id > 0
        ? [{ x, y, z, stack: { id, count: 1 } }]
        : [],
  };
}

export const validFluidPosition = (world, x, y, z) =>
  inWorldBounds(x, y, z, world.spec);

export function isBubble(fluid) {
  return fluid === FLUID.BUBBLE_UP || fluid === FLUID.BUBBLE_DOWN;
}

export function waterCell(fluid) {
  return isWaterFluid(fluid)
    ? { id: BLOCK.WATER, state: 0, fluid }
    : { ...AIR };
}
