import { BLOCK, BLOCKS } from "./blocks.js";
import { cellsEqual, normalizeCell } from "./block-state.js";
import { plantRemoval } from "./fluid-read.js";
import { normalizeStack } from "./inventory-slots.js";
import { stationKey } from "./settlement-state.js";
import { inWorldBounds } from "./world-spec.js";
import {
  fluidServiceRecord as record,
  fluidServiceSynchronous as synchronous,
} from "./game-fluid-state.js";

export const FLUID_SERVICE_LIMITS = Object.freeze({
  plants: 256,
  changes: 256,
  drops: 512,
  participants: 4, // World, service guard, Settlement, overflow.
  prepareCellReads: 512,
  validationCellReads: 512, // Per coordinator validation pass; excludes owners' own reads.
});
const keyFor = ({ x, y, z }) => `${x},${y},${z}`;
const dropKey = ({ x, y, z }) =>
  `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`;

function captureCell(world, at, expected) {
  const before = world.getCell(at.x, at.y, at.z);
  if (before === null || (expected && !cellsEqual(before, expected)))
    return null;
  const key = `${Math.floor(at.x / 16)},${Math.floor(at.z / 16)}`;
  const chunk = world.chunks.get(key);
  if (!chunk) return null;
  const incarnation = chunk.incarnation,
    revision = chunk.revision;
  return {
    before,
    validate: () =>
      world.chunks.get(key) === chunk &&
      chunk.incarnation === incarnation &&
      chunk.revision === revision &&
      cellsEqual(world.getCell(at.x, at.y, at.z), before),
  };
}

function cleanDrops(drops, plants, service, scope) {
  if (!Array.isArray(drops) || drops.length > FLUID_SERVICE_LIMITS.drops)
    return null;
  const entries = [];
  for (const drop of drops) {
    if (
      !record(drop) ||
      ![drop.x, drop.y, drop.z].every(Number.isFinite) ||
      !plants.has(dropKey(drop)) ||
      (drop.dimension !== undefined && drop.dimension !== scope.dimension) ||
      (drop.epoch !== undefined && drop.epoch !== scope.epoch)
    )
      return null;
    const stack = normalizeStack(drop.stack, service.context);
    // Coordinates are retained exactly, never relocated to the player. The
    // overflow owner normalizes/detaches metadata and motion before publication.
    entries.push({
      ...stack,
      x: drop.x,
      y: drop.y,
      z: drop.z,
      dimension: scope.dimension,
      pickupDelay: drop.pickupDelay,
      velocity: drop.velocity,
    });
  }
  return entries;
}

/**
 * One real overflow batch, plus at most one crop-source participant.
 *
 * Required Settlement extension (no private map writes here):
 *   prepareRemoveCrops(world, frozenPlants) -> {participant, drops} | null
 * It MUST require existing crop records, pin their revision and live cells,
 * remove only those records, and return planned {x,y,z,stack} yields. It must
 * not mutate World, insert into inventory, retain/spawn drops or commit.
 * Its participant.owner must be Settlement itself. Receipt-style results from
 * prepareHarvestCrop/removeContainer are deliberately not accepted.
 */
export function prepareFluidPlantDrops(service, drops, scope) {
  const { world, settlement, overflow } = service;
  if (
    !service._actionAvailable() ||
    !record(scope) ||
    scope.dimension !== world.dimension ||
    scope.epoch !== world.epoch ||
    !Array.isArray(scope.plants) ||
    scope.plants.length > FLUID_SERVICE_LIMITS.plants ||
    !Array.isArray(scope.changes) ||
    scope.changes.length > FLUID_SERVICE_LIMITS.changes
  )
    return null;
  const validHost = service._captureGuard();
  const changes = new Map(),
    plants = new Map(),
    crops = new Map();
  const reads = [];
  for (const change of scope.changes) {
    if (
      !record(change) ||
      !inWorldBounds(change.x, change.y, change.z, world.spec) ||
      changes.has(keyFor(change))
    )
      return null;
    const before = normalizeCell(change.before),
      after = normalizeCell(change.after);
    const read = captureCell(world, change, before);
    if (!read) return null;
    reads.push(read);
    changes.set(keyFor(change), { ...change, before, after });
  }
  const cropRevision = settlement.revision;
  const hasCrop = settlement.hasCrop;
  const cropStore = settlement.crops;
  const chestStore = settlement.chests,
    furnaceStore = settlement.furnaces;
  if (
    !synchronous(hasCrop) ||
    !(cropStore instanceof Map) ||
    !(chestStore instanceof Map) ||
    !(furnaceStore instanceof Map)
  )
    return null;
  for (const plant of scope.plants) {
    if (!record(plant) || plants.has(keyFor(plant))) return null;
    const change = changes.get(keyFor(plant));
    const before = normalizeCell(plant.before);
    if (
      !change ||
      !cellsEqual(change.before, before) ||
      change.after.id === before.id ||
      BLOCKS[before.id]?.shape !== "cross"
    )
      return null;
    const key = stationKey(scope.dimension, plant.x, plant.y, plant.z);
    if (chestStore.has(key) || furnaceStore.has(key)) return null;
    const clean = Object.freeze({
      x: plant.x,
      y: plant.y,
      z: plant.z,
      before: Object.freeze(before),
    });
    plants.set(keyFor(clean), clean);
    if (hasCrop.call(settlement, world, clean)) {
      crops.set(keyFor(clean), clean);
    } else {
      // Tall grass is also the existing planted-wheat seedling. Do not invent
      // its missing crop record when farmland identifies the planted form.
      if (before.id === BLOCK.WHEAT_CROP || BLOCKS[before.id]?.crop)
        return null;
      if (before.id === BLOCK.TALL_GRASS && plant.y > world.spec.minY) {
        const support = captureCell(world, {
          x: plant.x,
          y: plant.y - 1,
          z: plant.z,
        });
        if (!support || support.before.id === BLOCK.FARMLAND) return null;
        reads.push(support);
      }
    }
  }
  for (const [key, change] of changes) {
    const ownerKey = stationKey(scope.dimension, change.x, change.y, change.z);
    if (
      chestStore.has(ownerKey) ||
      furnaceStore.has(ownerKey) ||
      (cropStore.has(ownerKey) && !crops.has(key))
    )
      return null;
  }
  let entries = cleanDrops(drops, plants, service, scope);
  if (!entries) return null;
  const retainedKinds = new Set(
    entries.map((entry) => `${dropKey(entry)}:${entry.id}`)
  );
  for (const [key, plant] of plants) {
    if (crops.has(key)) continue;
    const expected = plantRemoval(
      plant.before,
      plant.x,
      plant.y,
      plant.z
    ).drops;
    for (const { stack } of expected)
      if (!retainedKinds.has(`${key}:${stack.id}`)) return null;
  }
  const prepared = [];
  const prepareCrops = settlement.prepareRemoveCrops;
  if (crops.size) {
    if (!synchronous(prepareCrops)) return null;
    const plan = prepareCrops.call(
      settlement,
      world,
      Object.freeze([...crops.values()])
    );
    if (
      !record(plan) ||
      plan.dropsCommitted === true ||
      plan.result?.dropsCommitted === true ||
      plan.participant?.owner !== settlement ||
      !synchronous(plan.participant.validate) ||
      !synchronous(plan.participant.publish)
    )
      return null;
    const cropDrops = cleanDrops(plan.drops, crops, service, scope);
    if (!cropDrops) return null;
    // Generic block loot for tracked crops is replaced, not added a second
    // time. Settlement alone determines the yield of its owned crop state.
    entries = entries.filter((entry) => !crops.has(dropKey(entry)));
    entries.push(...cropDrops);
    prepared.push(plan.participant);
  }
  if (entries.length > FLUID_SERVICE_LIMITS.drops) return null;
  const prepareOverflow = overflow.prepareAddBatch;
  if (entries.length) {
    if (!synchronous(prepareOverflow)) return null;
    const destination = prepareOverflow.call(overflow, entries);
    if (!destination || destination.owner !== overflow) return null;
    prepared.push(destination);
  }
  const ownership = [...plants.values()].map((plant) => [
    plant,
    cropStore.get(stationKey(scope.dimension, plant.x, plant.y, plant.z)),
  ]);
  let used = false;
  const guard = Object.freeze({
    owner: service,
    beforeBytes: 0,
    afterBytes: 0,
    validate: () =>
      !used &&
      validHost() &&
      settlement.revision === cropRevision &&
      settlement.crops === cropStore &&
      settlement.chests === chestStore &&
      settlement.furnaces === furnaceStore &&
      settlement.hasCrop === hasCrop &&
      overflow.prepareAddBatch === prepareOverflow &&
      (!crops.size || settlement.prepareRemoveCrops === prepareCrops) &&
      ownership.every(([plant, record]) => {
        const key = stationKey(scope.dimension, plant.x, plant.y, plant.z);
        return (
          cropStore.get(key) === record &&
          !chestStore.has(key) &&
          !furnaceStore.has(key)
        );
      }) &&
      reads.every((read) => read.validate()),
    publish: () => {
      used = true;
    },
  });
  return [guard, ...prepared];
}
