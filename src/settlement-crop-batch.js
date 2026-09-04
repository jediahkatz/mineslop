import { cellsEqual, normalizeCell } from "./block-state.js";
import { cropBlock, cropDrops, cropRule, validCrop } from "./crop-rules.js";
import {
  captureStationRead,
  isRecord,
  settlementPositionValid,
  stationKey,
  stationRecordBytes,
} from "./settlement-state.js";
import { synchronousStationCallback } from "./settlement-transactions.js";
import { CHUNK_SIZE } from "./terrain.js";
import { TransactionCoordinator } from "./transactions.js";
import { getWorldSpec } from "./world-spec.js";

export const MAX_CROP_BATCH_PLANTS = 256;

/**
 * Source-only preparation: the caller supplies the World edit and ONE retained
 * drop destination in the same coordinator commit. At most two cell reads and
 * two plain yield stacks per plant; never scan or serialize the whole domain.
 * Bind/load the real World before this hot path; matching seed/coordinator alone
 * cannot establish which World owns a detached archive's crop records.
 */
export function prepareCropBatch(settlement, world, plants) {
  const plan = settlement._prepare(() => {
    if (
      !Array.isArray(plants) ||
      plants.length === 0 ||
      plants.length > MAX_CROP_BATCH_PLANTS ||
      !settlement.context ||
      settlement._world !== world ||
      !settlement._matchesWorld(world)
    )
      return null;
    const plantCount = plants.length;
    const context = settlement.context;
    const coordinator = settlement.coordinator;
    const chunks = world.chunks;
    const spec = world.spec;
    const { seed, generatorVersion, dimension, epoch } = world;
    const specForDimension = context.specForDimension;
    const getCell = world.getCell;
    const isLoaded = world.isLoaded;
    const boundWorld = settlement._world;
    const boundSeed = settlement._worldSeed;
    const boundGenerator = settlement._worldGenerator;
    const revision = settlement.revision;
    const beforeBytes = settlement.reservedBytes;
    const worldRevision = world._editRevision;
    const worldBytes = world._editBytes;
    const chests = settlement.chests;
    const furnaces = settlement.furnaces;
    const crops = settlement.crops;
    const recordBytes = settlement._recordBytes;
    const water = settlement._water;
    const chestViews = settlement._chestViews;
    if (
      !(coordinator instanceof TransactionCoordinator) ||
      ![chunks, chests, furnaces, crops, recordBytes, water, chestViews].every(
        (store) => store instanceof Map
      ) ||
      ![epoch, revision, beforeBytes, worldRevision, worldBytes].every(
        (value) => Number.isSafeInteger(value) && value >= 0
      ) ||
      !synchronousStationCallback(getCell) ||
      !synchronousStationCallback(isLoaded) ||
      !synchronousStationCallback(specForDimension) ||
      spec !== getWorldSpec(generatorVersion, dimension) ||
      specForDimension(dimension) !== spec
    )
      return null;
    const ready = () =>
      !world._disposed &&
      world.coordinator === coordinator &&
      settlement.coordinator === coordinator &&
      world._editRevision === worldRevision &&
      world._editBytes === worldBytes &&
      coordinator.usage(world) === worldBytes &&
      settlement.reservedBytes === beforeBytes &&
      coordinator.usage(settlement) === beforeBytes &&
      settlement.revision === revision &&
      settlement.context === context &&
      context.seed === seed &&
      context.generatorVersion === generatorVersion &&
      context.specForDimension === specForDimension &&
      settlement._world === boundWorld &&
      settlement._worldSeed === boundSeed &&
      settlement._worldGenerator === boundGenerator &&
      world.seed === seed &&
      world.generatorVersion === generatorVersion &&
      world.dimension === dimension &&
      world.epoch === epoch &&
      world.spec === spec &&
      world.chunks === chunks &&
      world.getCell === getCell &&
      world.isLoaded === isLoaded &&
      settlement.chests === chests &&
      settlement.furnaces === furnaces &&
      settlement.crops === crops &&
      settlement._recordBytes === recordBytes &&
      settlement._water === water &&
      settlement._chestViews === chestViews;
    if (!ready()) return null;
    const changes = [];
    const reads = [];
    const ownership = [];
    const drops = [];
    const seen = new Set();
    for (let index = 0; index < plantCount; index++) {
      const plant = plants[index];
      if (!isRecord(plant)) return null;
      const { x, y, z } = plant;
      if (
        !settlementPositionValid(dimension, x, y, z, context, true) ||
        (plant.world !== undefined && plant.world !== world) ||
        (plant.dimension !== undefined && plant.dimension !== dimension) ||
        (plant.epoch !== undefined && plant.epoch !== epoch)
      )
        return null;
      const key = stationKey(dimension, x, y, z);
      const crop = crops.get(key);
      if (
        seen.has(key) ||
        chests.has(key) ||
        furnaces.has(key) ||
        !isRecord(crop) ||
        !Object.isFrozen(crop)
      )
        return null;
      seen.add(key);
      // Canonical owned crops contain frozen data properties, not accessors.
      const age = Object.getOwnPropertyDescriptor(crop, "age")?.value;
      const rule = cropRule(crop);
      if (
        !validCrop(crop) ||
        !Number.isFinite(age) ||
        Object.entries({ dimension, x, y, z }).some(
          ([field, value]) =>
            Object.getOwnPropertyDescriptor(crop, field)?.value !== value
        )
      )
        return null;
      const expected = normalizeCell(plant.before);
      if (expected.id !== cropBlock(crop))
        return null;
      const chunk = chunks.get(
        `${Math.floor(x / CHUNK_SIZE)},${Math.floor(z / CHUNK_SIZE)}`
      );
      if (
        !chunk ||
        !Number.isSafeInteger(chunk.incarnation) ||
        chunk.incarnation < 1 ||
        !Number.isSafeInteger(chunk.revision) ||
        chunk.revision < 0
      )
        return null;
      const read = captureStationRead(world, x, y, z);
      const soil = captureStationRead(world, x, y - 1, z);
      const bytes = recordBytes.get(key);
      if (
        !read ||
        !soil ||
        !cellsEqual(read.before, expected) ||
        soil.before.id !== rule.soil ||
        bytes !== stationRecordBytes("crop", key, crop)
      )
        return null;
      changes.push({ kind: "crop", key, next: null });
      reads.push(read, soil);
      ownership.push({ key, crop, bytes });
      // Match prepareHarvestCrop's physical (non-Creative) yields.
      const stacks = cropDrops(crop);
      for (const stack of stacks)
        drops.push(Object.freeze({ x, y, z, stack: Object.freeze(stack) }));
    }
    const owned = () =>
      ownership.every(
        ({ key, crop, bytes }) =>
          crops.get(key) === crop &&
          recordBytes.get(key) === bytes &&
          !chests.has(key) &&
          !furnaces.has(key)
      );
    if (!ready() || !owned()) return null;
    const participant = settlement._prepareRecords(changes, {
      world,
      context,
      validate: () =>
        ready() && owned() && reads.every((read) => read.validate()),
    });
    return participant
      ? {
          participants: [participant],
          result: { drops: Object.freeze(drops) },
        }
      : null;
  });
  return plan
    ? Object.freeze({
        participant: plan.participants[0],
        drops: plan.result.drops,
      })
    : null;
}
