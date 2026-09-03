import { BLOCK, BLOCKS } from "./blocks.js";
import {
  cellsEqual,
  FLUID,
  isSourceWater,
  isWaterFluid,
  normalizeCell,
} from "./block-state.js";
import {
  FLUID_DIRECTIONS,
  HORIZONTAL_FLUID_DIRECTIONS,
} from "./fluid-constants.js";
import {
  canReceiveWater,
  FluidReadLimitError,
  FluidReadScope,
  fullTopSupport,
  isBubble,
  openFluidConnection,
  plantRemoval,
  supportsKelp,
  waterCell,
  waterLevel,
} from "./fluid-read.js";
import { isEditablePosition } from "./world-spec.js";

const DOWN = FLUID_DIRECTIONS[0];
const UP = FLUID_DIRECTIONS[1];

function canDrainDown(scope, x, y, z) {
  const below = scope.get(x, y - 1, z);
  return (
    canReceiveWater(below) &&
    !isSourceWater(below.fluid) &&
    openFluidConnection(scope, x, y, z, DOWN)
  );
}

function bubbleFluid(below) {
  if (below?.id === BLOCK.SOUL_SAND) return FLUID.BUBBLE_UP;
  if (below?.id === BLOCK.MAGMA_BLOCK) return FLUID.BUBBLE_DOWN;
  return below?.id === BLOCK.WATER && isBubble(below.fluid)
    ? below.fluid
    : FLUID.WATER_SOURCE;
}

function nextWater(scope, x, y, z, before) {
  const below = scope.get(x, y - 1, z);
  // Sources never become sources merely because ANY neighbor is wet. Once
  // explicitly placed/regenerated, they remain until an explicit removal.
  if (before.id === BLOCK.WATER && isSourceWater(before.fluid))
    return waterCell(bubbleFluid(below));

  const above = scope.get(x, y + 1, z);
  let sources = 0;
  let level = Infinity;
  for (const direction of HORIZONTAL_FLUID_DIRECTIONS) {
    const nx = x + direction.x,
      nz = z + direction.z;
    const neighbor = scope.get(nx, y, nz);
    if (!neighbor || !isWaterFluid(neighbor.fluid)) continue;
    if (!openFluidConnection(scope, x, y, z, direction)) continue;
    if (isSourceWater(neighbor.fluid)) sources++;
    // Gravity-first spread: waterfalls do not create a curtain seven blocks
    // wide along every falling cell. Their grounded bottom can spread laterally.
    if (!canDrainDown(scope, nx, y, nz))
      level = Math.min(level, waterLevel(neighbor.fluid) + 1);
  }

  // https://minecraft.wiki/w/Water#Source_blocks — two HORIZONTAL sources
  // plus full support or source water below, never merely flowing water below.
  if (
    sources >= 2 &&
    (isSourceWater(below?.fluid) || fullTopSupport(scope, x, y - 1, z))
  )
    return waterCell(bubbleFluid(below));
  if (
    above &&
    isWaterFluid(above.fluid) &&
    openFluidConnection(scope, x, y, z, UP)
  )
    return waterCell(FLUID.WATER_FALLING);
  if (level <= 7) return waterCell(level + 1);
  return before.id === BLOCK.WATER ? waterCell(FLUID.NONE) : before;
}

function coralDelay(x, y, z) {
  // A deterministic scheduled 3–4.75 s delay on the shared 5-game-tick clock,
  // within Java's 3–4.95 s interval; no random-tick or wall-clock dependency.
  return (
    12 +
    (((Math.imul(x, 734287) ^ Math.imul(y, 912931) ^ Math.imul(z, 438289)) >>>
      0) %
      8)
  );
}

/** Pure single-cell proposal. A tick plans ALL selected cells before any World
 * publication, preventing a queue's iteration order from spreading a wave more
 * than one cell per five game ticks. Reads include shape-derived prerequisites.
 *
 * This slice is gravity-first with level attenuation. Vanilla's four-block
 * shortest-drop direction search, lava interaction and kelp growth are separate.
 */
export function planFluidCell(world, entry, clock, stats) {
  const { x, y, z } = entry;
  const scope = new FluidReadScope(world, { stats });
  const result = {
    entry,
    change: null,
    reads: [],
    waiting: [],
    drops: [],
    plants: [],
    retryAt: null,
    coralId: null,
    coralDue: null,
    reason: "water",
  };
  if (!isEditablePosition(x, y, z, world.generatorVersion, world.dimension))
    return result;
  try {
    const before = scope.get(x, y, z);
    let after = before;
    if (before?.id === BLOCK.KELP && !supportsKelp(scope, x, y - 1, z)) {
      after = waterCell(FLUID.WATER_SOURCE);
      const removal = plantRemoval(before, x, y, z);
      result.plants.push(removal.plant);
      result.drops.push(...removal.drops);
      result.reason = "kelp-support";
    } else if (
      before &&
      BLOCKS[before.id]?.coralFamily &&
      !BLOCKS[before.id].deadCoral
    ) {
      let wet = isWaterFluid(before.fluid);
      if (!wet)
        for (const direction of FLUID_DIRECTIONS)
          wet =
            isWaterFluid(
              scope.get(x + direction.x, y + direction.y, z + direction.z)
                ?.fluid
            ) || wet;
      if (!wet) {
        const due =
          entry.coralId === before.id && entry.coralDue !== null
            ? entry.coralDue
            : clock + coralDelay(x, y, z);
        if (clock < due) {
          result.retryAt = due;
          result.coralId = before.id;
          result.coralDue = due;
        } else {
          after = normalizeCell({
            id: BLOCKS[before.id].deadBlock,
            state: before.state,
            fluid: before.fluid,
          });
          result.reason = "coral-decay";
        }
      }
    } else if (canReceiveWater(before)) {
      after = nextWater(scope, x, y, z, before);
      if (
        before.id !== BLOCK.AIR &&
        before.id !== BLOCK.WATER &&
        !cellsEqual(before, after)
      ) {
        const removal = plantRemoval(before, x, y, z);
        result.plants.push(removal.plant);
        result.drops.push(...removal.drops);
        result.reason = "water-displacement";
      }
    }
    result.reads = scope.reads();
    result.waiting = scope.unloaded();
    if (!result.waiting.length && before && !cellsEqual(before, after))
      result.change = { x, y, z, before, after };
    return result;
  } catch (error) {
    if (!(error instanceof FluidReadLimitError)) throw error;
    return { ...result, retryAt: clock + 1, reason: "read-limit" };
  }
}

/** Admission/recovery scanners inspect one cell at a time. Historical sources
 * remain dormant unless a local edit or saved recovery marker activates them.
 * Stable ocean interiors are never queued simply because they contain water.
 */
export function fluidScanCandidate(world, x, y, z, mode, stats) {
  const read = (nx, ny, nz) => {
    stats.reads++;
    return world.getCell(nx, ny, nz);
  };
  const cell = read(x, y, z);
  if (!cell) return null;
  // Recovery scans visit susceptible dry cells too; repeatedly expanding stable
  // sources there would manufacture new overflow forever in a one-cell queue.
  const expand = mode === "seed";
  const definition = BLOCKS[cell.id];
  if (
    cell.id === BLOCK.KELP ||
    (definition.coralFamily && !definition.deadCoral)
  )
    return {
      expand: expand && isWaterFluid(cell.fluid) && world.generatorVersion >= 4,
    };
  if (cell.id === BLOCK.SOUL_SAND || cell.id === BLOCK.MAGMA_BLOCK)
    return isSourceWater(read(x, y + 1, z)?.fluid) ? { expand } : null;
  if (isWaterFluid(cell.fluid)) {
    if (!isSourceWater(cell.fluid) || isBubble(cell.fluid)) return { expand };
    if (mode === "seed" && world.generatorVersion < 4) return null;
    for (const direction of FLUID_DIRECTIONS) {
      const neighbor = read(x + direction.x, y + direction.y, z + direction.z);
      if (
        neighbor === null ||
        neighbor.id === BLOCK.SOUL_SAND ||
        neighbor.id === BLOCK.MAGMA_BLOCK ||
        isBubble(neighbor.fluid) ||
        (canReceiveWater(neighbor) && !isSourceWater(neighbor.fluid))
      )
        return { expand };
    }
    return null;
  }
  if (mode === "recover" && canReceiveWater(cell))
    for (const direction of FLUID_DIRECTIONS)
      if (
        isWaterFluid(
          read(x + direction.x, y + direction.y, z + direction.z)?.fluid
        )
      )
        return { expand: false };
  return null;
}
