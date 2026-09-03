import assert from "node:assert/strict";
import { BLOCK } from "../src/blocks.js";
import { FLUID, normalizeCell } from "../src/block-state.js";
import { DropOverflow } from "../src/drop-overflow.js";
import { Gameplay } from "../src/gameplay.js";
import { ITEM } from "../src/items.js";
import { CROP_GROW_SECONDS, Settlement } from "../src/settlement.js";
import { TransactionCoordinator } from "../src/transactions.js";
import { World } from "../src/world.js";
import { createWorldContext, getWorldSpec } from "../src/world-spec.js";

/**
 * Authored dry farm, NOT natural-world or GUI evidence. Actual World cells,
 * Gameplay seed debits, Settlement.plant/update, and registered item identities
 * create the crops; no provisional crop-batch implementation is substituted.
 */
export function cropBatchFixture(
  t,
  {
    crops = [
      { x: 7, age: CROP_GROW_SECONDS },
      { x: 9, age: 0 },
    ],
    generatorVersion = 4,
    dimension = "overworld",
    coordinator = new TransactionCoordinator(),
    maxEntries,
    initial = [],
  } = {}
) {
  const positions = crops.map(({ x, y, z = 8, age = 0 }) =>
    Object.freeze({
      dimension,
      x,
      y: y ?? (generatorVersion === 4 ? 1 : 2),
      z,
      age,
    })
  );
  const cells = new Map();
  const remember = (x, y, z, id) =>
    cells.set(`${x},${y},${z}`, { x, y, z, id });
  for (let x = 6; x <= 12; x++) remember(x, 1, 8, BLOCK.AIR);
  for (const [x, y, z, id] of initial) remember(x, y, z, id);
  for (const { x, y, z } of positions) {
    remember(x, y - 1, z, BLOCK.FARMLAND);
    remember(x, y, z, BLOCK.AIR);
  }
  const generatorFactory = (seed, activeDimension, version) => {
    const spec = getWorldSpec(version, activeDimension);
    return {
      getSpawn: () => ({ x: 8.5, y: 2, z: 8.5 }),
      generateChunk(cx, cz) {
        const blocks = new Uint16Array((spec.maxY - spec.minY) * 256).fill(
          BLOCK.STONE
        );
        for (const { x, y, z, id } of cells.values()) {
          if (
            Math.floor(x / 16) !== cx ||
            Math.floor(z / 16) !== cz ||
            y < spec.minY ||
            y >= spec.maxY
          )
            continue;
          blocks[(y - spec.minY) * 256 + (z - cz * 16) * 16 + x - cx * 16] = id;
        }
        return {
          cx,
          cz,
          minY: spec.minY,
          maxY: spec.maxY,
          blocks,
          biomes: new Uint8Array(256),
          sections: [],
        };
      },
    };
  };
  const world = new World("authored-settlement-crop-batch", {
    generatorVersion,
    dimension,
    coordinator,
    generatorFactory,
    useWorker: false,
  }).generate(0);
  for (const { x, z } of positions)
    if (!world.isLoaded(x, z))
      world._generateSync(Math.floor(x / 16), Math.floor(z / 16));
  const context = createWorldContext(world);
  const gameplay = new Gameplay({ context, coordinator, mode: "survival" });
  const settlement = new Settlement({ context, coordinator });
  const overflow = new DropOverflow({ context, coordinator, maxEntries });
  t.after(() => {
    overflow.dispose();
    settlement.dispose();
    gameplay.dispose();
    world.dispose();
  });
  assert.equal(
    gameplay.inventoryTransaction((owned) => {
      owned.slots.fill(null);
      for (let left = positions.length, slot = 0; left > 0; slot++) {
        const count = Math.min(left, 64);
        owned.slots[slot] = { id: ITEM.SEEDS, count };
        left -= count;
      }
      return true;
    }),
    true
  );
  const plantingOrder = [...positions].sort((a, b) => b.age - a.age);
  let previousAge = plantingOrder[0]?.age ?? 0;
  for (const [index, crop] of plantingOrder.entries()) {
    assert.ok(crop.age >= 0 && crop.age <= CROP_GROW_SECONDS);
    if (previousAge > crop.age)
      assert.equal(settlement.update(previousAge - crop.age, world), true);
    gameplay.select(Math.floor(index / 64));
    assert.equal(
      settlement.plant(
        world,
        { x: crop.x, y: crop.y - 1, z: crop.z },
        gameplay
      ),
      true
    );
    previousAge = crop.age;
  }
  if (previousAge > 0)
    assert.equal(settlement.update(previousAge, world), true);
  const fixture = {
    world,
    context,
    coordinator,
    settlement,
    gameplay,
    overflow,
    positions,
    plants: (targets = positions) =>
      Object.freeze(
        targets.map(({ x, y, z }) =>
          Object.freeze({
            x,
            y,
            z,
            before: Object.freeze({ ...world.getCell(x, y, z) }),
          })
        )
      ),
    put(x, y, z, value) {
      const before = world.getCell(x, y, z);
      assert.ok(before);
      assert.equal(
        world.applyCells([
          {
            x,
            y,
            z,
            before,
            after: normalizeCell(
              typeof value === "number" ? { id: value } : value
            ),
          },
        ]),
        true
      );
    },
    snapshot: () => ({
      world: world.serialize(),
      cells: positions.map(({ x, y, z }) => [
        world.getCell(x, y, z),
        world.getCell(x, y - 1, z),
      ]),
      settlement: settlement.serialize(),
      overflow: overflow.serialize(),
      gameplay: gameplay.serialize(),
      bytes: coordinator.budget.totalBytes,
    }),
  };
  return fixture;
}

export const retainedCropEntries = (drops, dimension) =>
  drops.map(({ x, y, z, stack }) => ({ ...stack, x, y, z, dimension }));

/** The actual three owners prepare first; only the test's caller commits. */
export function prepareCropRemoval(fixture, plants = fixture.plants()) {
  const { world, settlement, overflow } = fixture;
  const changes = plants.map((plant) => ({
    ...plant,
    after: normalizeCell({ id: BLOCK.WATER, fluid: FLUID.WATER_1 }),
  }));
  const mutation = world.prepareMutation(changes, { epoch: world.epoch });
  if (!mutation) return null;
  const source = settlement.prepareRemoveCrops(world, plants);
  if (!source) return null;
  const retained = overflow.prepareAddBatch(
    retainedCropEntries(source.drops, world.dimension)
  );
  return retained
    ? { source, participants: [mutation, source.participant, retained] }
    : null;
}

export function cropDropCounts(overflow) {
  const counts = new Map();
  for (const { id, count } of overflow.serialize().entries)
    counts.set(id, (counts.get(id) ?? 0) + count);
  return counts;
}
