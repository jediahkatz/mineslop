import { BLOCK, BLOCKS } from "./blocks.js";
import {
  cellsEqual,
  FLUID,
  isSourceWater,
  isValidCell,
  isWaterFluid,
  normalizeCell,
} from "./block-state.js";
import {
  FLUID_DIRECTIONS,
  fluidCellKey,
  MAX_SPONGE_DISTANCE,
  MAX_SPONGE_READS,
  MAX_SPONGE_WATER,
} from "./fluid-constants.js";
import {
  FluidReadScope,
  plantRemoval,
  supportsKelp,
  validFluidPosition,
  waterCell,
} from "./fluid-read.js";

const validPosition = (world, position) =>
  !!position && validFluidPosition(world, position.x, position.y, position.z);
const failed = (reason, scope) => ({
  ok: false,
  reason,
  changes: [],
  reads: scope?.reads() ?? [],
  waiting: scope?.unloaded() ?? [],
  drops: [],
  plants: [],
});
const complete = (scope, changes, extra = {}) =>
  scope.waiting.size
    ? failed("unloaded", scope)
    : {
        ok: true,
        reason: null,
        changes,
        reads: scope.reads(),
        waiting: [],
        drops: [],
        plants: [],
        ...extra,
      };

/** Explicit bucket/building action only. Ambient flow never calls this helper.
 * Aquatic plants cannot have a dry live canonical cell; break them (and retain
 * their drops) first. Shape/orientation and the host ID are otherwise preserved.
 */
export function planWaterlogging(world, position, filled = true) {
  if (!validPosition(world, position) || typeof filled !== "boolean")
    return failed("invalid-position");
  const scope = new FluidReadScope(world);
  const { x, y, z } = position;
  const before = scope.get(x, y, z);
  if (!before) return failed("unloaded", scope);
  if (before.id === BLOCK.WATER || before.id === BLOCK.LAVA)
    return failed("not-a-host", scope);
  const after = { ...before, fluid: filled ? FLUID.WATER_SOURCE : FLUID.NONE };
  if (!isValidCell(after)) return failed("invalid-host-fluid", scope);
  return complete(
    scope,
    cellsEqual(before, after) ? [] : [{ x, y, z, before, after }]
  );
}

/** https://minecraft.wiki/w/Kelp — manual placement accepts source/falling
 * water, not lateral levels. Placement converts falling water to an aquatic
 * source. No growth/age simulation is implemented by this slice.
 * The caller composes the proposed World change with its item consumption.
 */
export function planKelpPlacement(world, position) {
  if (!validPosition(world, position)) return failed("invalid-position");
  const scope = new FluidReadScope(world);
  const { x, y, z } = position;
  const before = scope.get(x, y, z);
  if (!before) return failed("unloaded", scope);
  if (
    before.id !== BLOCK.WATER ||
    (!isSourceWater(before.fluid) && before.fluid !== FLUID.WATER_FALLING)
  )
    return failed("requires-source-or-falling-water", scope);
  if (!supportsKelp(scope, x, y - 1, z))
    return failed(
      scope.waiting.size ? "unloaded" : "invalid-kelp-support",
      scope
    );
  return complete(scope, [
    {
      x,
      y,
      z,
      before,
      after: normalizeCell({ id: BLOCK.KELP }),
    },
  ]);
}

function spongeReplacement(before) {
  if (!before || !isWaterFluid(before.fluid)) return null;
  if ([BLOCK.WATER, BLOCK.KELP, BLOCK.SEAGRASS].includes(before.id))
    return waterCell(FLUID.NONE);
  const dry = { ...before, fluid: FLUID.NONE };
  if (isValidCell(dry)) return dry;
  const definition = BLOCKS[before.id];
  // This registry requires living aquatic coral to contain source water. It
  // cannot represent Java's briefly dry live plant: preserve the coral as its
  // registered dead host immediately on explicit drainage, never erase it.
  if (definition.coralFamily && !definition.deadCoral)
    return normalizeCell({
      id: definition.deadBlock,
      state: before.state,
      fluid: FLUID.NONE,
    });
  return null;
}

/** Pure, breadth-first, water-connected absorption plan; never a World edit.
 *
 * The requested 65-water-cell / taxicab-7 contract is deliberately fixed here
 * rather than depending on version-varying sponge limits. At most 396 frontier
 * nodes and 457 distinct World reads are needed (the hard read guard is 1024).
 * Structural host IDs/orientation are retained while their water is drained,
 * matching Java's BucketPickup path (the Water wiki's immunity note conflicts):
 * https://github.com/PaperMC/Paper/commit/e9680a5afedcf05341b332870e0c542a17d78efa
 * Kelp/seagrass removals and lily pads above absorbed cells are reported.
 * There are at most 130 proposed cell changes.
 *
 * The building owner MUST compose changes, all reported plant/drop ownership,
 * and its own center placement into ONE coordinator transaction. `spongeCell`
 * is the suggested center state; the helper does not replace the center itself.
 * An unloaded frontier fails closed; no partial plan is presented as complete.
 */
export function planSpongeAbsorption(
  world,
  position,
  { maxCells = MAX_SPONGE_WATER, maxDistance = MAX_SPONGE_DISTANCE } = {}
) {
  if (
    !validPosition(world, position) ||
    !Number.isSafeInteger(maxCells) ||
    maxCells < 1 ||
    maxCells > MAX_SPONGE_WATER ||
    !Number.isSafeInteger(maxDistance) ||
    maxDistance < 1 ||
    maxDistance > MAX_SPONGE_DISTANCE
  )
    return failed("invalid-sponge-limit");
  const scope = new FluidReadScope(world, { maxReads: MAX_SPONGE_READS });
  const center = scope.get(position.x, position.y, position.z);
  if (!center) return failed("unloaded", scope);
  if (center.id === BLOCK.WET_SPONGE) return failed("already-wet", scope);
  const queue = [];
  const seen = new Set([fluidCellKey(position.x, position.y, position.z)]);
  const changes = new Map();
  const plants = [],
    drops = [];
  let waterCells = 0,
    cursor = 0;
  const append = (x, y, z, distance) => {
    if (distance > maxDistance || !validFluidPosition(world, x, y, z)) return;
    const key = fluidCellKey(x, y, z);
    if (seen.has(key)) return;
    seen.add(key);
    queue.push({ x, y, z, distance });
  };
  for (const direction of FLUID_DIRECTIONS)
    append(
      position.x + direction.x,
      position.y + direction.y,
      position.z + direction.z,
      1
    );
  while (cursor < queue.length && waterCells < maxCells) {
    const { x, y, z, distance } = queue[cursor++];
    const before = scope.get(x, y, z);
    const after = spongeReplacement(before);
    if (!after) continue;
    waterCells++;
    changes.set(fluidCellKey(x, y, z), { x, y, z, before, after });
    if (before.id === BLOCK.KELP || before.id === BLOCK.SEAGRASS) {
      const removal = plantRemoval(before, x, y, z);
      plants.push(removal.plant);
      drops.push(...removal.drops);
    }
    const above = scope.get(x, y + 1, z);
    if (above?.id === BLOCK.LILY_PAD) {
      changes.set(fluidCellKey(x, y + 1, z), {
        x,
        y: y + 1,
        z,
        before: above,
        after: waterCell(FLUID.NONE),
      });
      const removal = plantRemoval(above, x, y + 1, z);
      plants.push(removal.plant);
      drops.push(...removal.drops);
    }
    for (const direction of FLUID_DIRECTIONS)
      append(x + direction.x, y + direction.y, z + direction.z, distance + 1);
  }
  return complete(scope, [...changes.values()], {
    plants,
    drops,
    waterCells,
    spongeCell: normalizeCell({
      id: waterCells ? BLOCK.WET_SPONGE : BLOCK.SPONGE,
    }),
    limited: waterCells === maxCells && cursor < queue.length,
    visited: cursor,
  });
}
