import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { FLUID, normalizeCell } from "../src/block-state.js";
import { getItem, ITEM } from "../src/items.js";
import { MAX_RESERVED_BYTES } from "../src/save-budget.js";
import { MAX_CROP_BATCH_PLANTS } from "../src/settlement-crop-batch.js";
import { CROP_GROW_SECONDS } from "../src/settlement.js";
import {
  cropBatchFixture,
  cropDropCounts,
  prepareCropRemoval,
  retainedCropEntries,
} from "./settlement-crop-batch-fixture.js";

const expectedDrops = [
  { x: 7, y: 1, z: 8, stack: { id: ITEM.WHEAT, count: 2 } },
  { x: 7, y: 1, z: 8, stack: { id: ITEM.SEEDS, count: 1 } },
  { x: 9, y: 1, z: 8, stack: { id: ITEM.SEEDS, count: 1 } },
];

test("crop batch preparation owns only Settlement and publishes no cells, seeds, drops, callbacks or reservations", (t) => {
  const f = cropBatchFixture(t);
  const plants = f.plants();
  const before = f.snapshot();
  let notified = 0;
  f.settlement.onChange = () => notified++;
  f.overflow.onChange = () => notified++;
  f.world.onMutation = () => notified++;
  const forbidden = [
    [f.world, "prepareMutation"],
    [f.gameplay, "prepareInventory"],
    [f.overflow, "prepareAddBatch"],
    [f.coordinator, "commit"],
    [f.coordinator, "register"],
    [f.settlement, "serialize"],
  ].map(([owner, method]) =>
    t.mock.method(owner, method, () =>
      assert.fail(`source-only preparation called ${method}`)
    )
  );
  const source = f.settlement.prepareRemoveCrops(f.world, plants);
  for (const method of forbidden) method.mock.restore();
  assert.ok(source);
  assert.deepEqual(Object.keys(source).sort(), ["drops", "participant"]);
  assert.equal(source.participant.owner, f.settlement);
  assert.equal(source.participant.validate(), true);
  assert.deepEqual(source.drops, expectedDrops);
  assert.ok(Object.isFrozen(source));
  assert.ok(Object.isFrozen(source.drops));
  for (const drop of source.drops) {
    assert.ok(Object.isFrozen(drop));
    assert.ok(Object.isFrozen(drop.stack));
    assert.equal(getItem(drop.stack.id)?.id, drop.stack.id);
    assert.equal(getItem(drop.stack.id)?.kind, "material");
  }
  assert.deepEqual(f.snapshot(), before);
  assert.equal(notified, 0);
  assert.equal(f.settlement._busy, false);
});

test("batch yields match actual survival harvesting of the same planted and matured cells", (t) => {
  const batch = cropBatchFixture(t);
  const harvested = cropBatchFixture(t);
  const source = batch.settlement.prepareRemoveCrops(
    batch.world,
    batch.plants()
  );
  assert.ok(source);
  assert.equal(
    harvested.gameplay.inventoryTransaction((owned) => {
      owned.slots = Array.from({ length: 36 }, () => ({
        id: BLOCK.DIRT,
        count: 64,
      }));
      return true;
    }),
    true
  );
  for (const plant of harvested.plants()) {
    const plan = harvested.settlement.prepareHarvestCrop(
      harvested.world,
      { ...plant, id: plant.before.id },
      harvested.gameplay,
      {
        prepareDrops: (stacks) =>
          harvested.overflow.prepareEnqueue(
            stacks,
            plant,
            harvested.world.dimension
          ),
      }
    );
    assert.ok(plan);
    assert.equal(harvested.coordinator.commit(plan.participants).ok, true);
  }
  assert.deepEqual(
    harvested.overflow.serialize().entries.map(({ x, y, z, id, count }) => ({
      x,
      y,
      z,
      stack: { id, count },
    })),
    source.drops
  );
  assert.deepEqual(source.drops, expectedDrops);
});

test("multiple positions share one actual overflow destination and one joint commit, without inventory grants or replay", (t) => {
  const f = cropBatchFixture(t, {
    crops: [{ x: 7, age: CROP_GROW_SECONDS }, { x: 9 }, { x: 12, age: 12 }],
  });
  const plants = f.plants(f.positions.slice(0, 2));
  const before = f.snapshot();
  const untouched = f.settlement.crops.get("overworld:12,1,8");
  const prepare = f.overflow.prepareAddBatch.bind(f.overflow);
  const batches = [];
  t.mock.method(f.overflow, "prepareAddBatch", (entries) => {
    batches.push(structuredClone(entries));
    assert.deepEqual(f.snapshot(), before);
    return prepare(entries);
  });
  const plan = prepareCropRemoval(f, plants);
  assert.ok(plan);
  assert.equal(batches.length, 1);
  assert.deepEqual(
    new Set(plan.participants.map(({ owner }) => owner)),
    new Set([f.world, f.settlement, f.overflow])
  );
  assert.deepEqual(f.snapshot(), before);
  const commit = f.coordinator.commit.bind(f.coordinator);
  let commits = 0;
  t.mock.method(f.coordinator, "commit", (participants) => {
    commits++;
    return commit(participants);
  });
  assert.equal(f.coordinator.commit(plan.participants).ok, true);
  assert.equal(commits, 1);
  for (const { x, y, z } of plants) {
    assert.equal(f.world.getFluid(x, y, z), FLUID.WATER_1);
    assert.equal(f.world.get(x, y - 1, z), BLOCK.FARMLAND);
    assert.equal(f.settlement.hasCrop(f.world, { x, y, z }), false);
  }
  assert.equal(f.settlement.crops.get("overworld:12,1,8"), untouched);
  assert.equal(f.overflow.size, 3);
  assert.deepEqual(
    cropDropCounts(f.overflow),
    new Map([
      [ITEM.WHEAT, 2],
      [ITEM.SEEDS, 2],
    ])
  );
  assert.deepEqual(f.gameplay.serialize(), before.gameplay);
  const committed = f.snapshot();
  assert.equal(f.coordinator.commit(plan.participants).ok, false);
  assert.deepEqual(f.snapshot(), committed);
});

test("mutable caller input cannot relocate drops or change the prepared cells and crop records", (t) => {
  const f = cropBatchFixture(t);
  const caller = structuredClone(f.plants());
  const mutation = f.world.prepareMutation(
    caller.map((plant) => ({
      ...plant,
      after: normalizeCell({ id: BLOCK.WATER, fluid: FLUID.WATER_1 }),
    }))
  );
  const source = f.settlement.prepareRemoveCrops(f.world, caller);
  assert.ok(mutation);
  assert.ok(source);
  caller[0].x = 10000;
  caller[0].before.id = BLOCK.AIR;
  caller[1].before.fluid = FLUID.WATER_SOURCE;
  caller.splice(0, caller.length, { x: 0, y: 0, z: 0 });
  assert.equal(Reflect.set(source.drops[0].stack, "count", 64), false);
  const retained = f.overflow.prepareAddBatch(
    retainedCropEntries(source.drops, f.world.dimension)
  );
  assert.ok(retained);
  assert.equal(
    f.coordinator.commit([mutation, source.participant, retained]).ok,
    true
  );
  assert.deepEqual(
    f.overflow.serialize().entries.map(({ x, y, z, id, count }) => ({
      x,
      y,
      z,
      stack: { id, count },
    })),
    expectedDrops
  );
});

test("capacity or a real destination veto preserves every source cell, crop record and retained stack", (t) => {
  const limited = cropBatchFixture(t, { maxEntries: 2 });
  assert.equal(
    limited.overflow.enqueue(
      [{ id: ITEM.SEEDS, count: 5 }],
      { x: 2, y: 1, z: 2 },
      limited.world.dimension
    ),
    true
  );
  const beforeLimited = limited.snapshot();
  assert.equal(prepareCropRemoval(limited), null);
  assert.deepEqual(limited.snapshot(), beforeLimited);
  limited.overflow.maxEntries = 4;
  const admitted = prepareCropRemoval(limited);
  assert.ok(admitted);
  assert.equal(limited.coordinator.commit(admitted.participants).ok, true);
  assert.equal(cropDropCounts(limited.overflow).get(ITEM.SEEDS), 7);

  const f = cropBatchFixture(t);
  const plan = prepareCropRemoval(f);
  assert.ok(plan);
  const before = f.snapshot();
  assert.equal(
    f.coordinator.commit(
      plan.participants.map((participant) =>
        participant.owner === f.overflow
          ? { ...participant, validate: () => false }
          : participant
      )
    ).ok,
    false
  );
  assert.deepEqual(f.snapshot(), before);
  const filler = {};
  assert.ok(
    plan.participants.reduce(
      (delta, participant) =>
        delta + participant.afterBytes - participant.beforeBytes,
      0
    ) > 0
  );
  assert.equal(
    f.coordinator.register(
      filler,
      MAX_RESERVED_BYTES - f.coordinator.budget.totalBytes
    ),
    true
  );
  const full = f.snapshot();
  assert.equal(f.coordinator.commit(plan.participants).ok, false);
  assert.deepEqual(f.snapshot(), full);
  assert.equal(f.coordinator.release(filler), true);
  assert.equal(f.coordinator.commit(plan.participants).ok, true);
  assert.equal(f.overflow.size, 3);
});

test("all notifications observe the complete shared transaction with Settlement released, even when observers throw", (t) => {
  const f = cropBatchFixture(t, {
    crops: [{ x: 7, age: CROP_GROW_SECONDS }, { x: 9 }, { x: 12 }],
  });
  const plants = f.plants(f.positions.slice(0, 2));
  const plan = prepareCropRemoval(f, plants);
  assert.ok(plan);
  const notifications = [];
  const observe = (name) => () => {
    assert.equal(f.settlement._busy, false);
    assert.equal(f.settlement.crops.size, 1);
    assert.equal(f.overflow.size, 3);
    for (const { x, y, z } of plants)
      assert.equal(f.world.getFluid(x, y, z), FLUID.WATER_1);
    for (const owner of [f.settlement, f.overflow])
      assert.equal(f.coordinator.usage(owner), owner.reservedBytes);
    assert.ok(
      f.settlement.prepareRemoveCrops(f.world, f.plants(f.positions.slice(2)))
    );
    notifications.push(name);
    throw new Error(`${name} postcommit observer`);
  };
  f.world.onMutation = observe("world");
  f.settlement.onChange = observe("settlement");
  f.overflow.onChange = observe("overflow");
  const committed = f.coordinator.commit(plan.participants);
  assert.equal(committed.ok, true);
  assert.equal(committed.observerErrors.length, 3);
  assert.deepEqual(notifications, ["world", "settlement", "overflow"]);
  assert.equal(f.coordinator.commit(plan.participants).ok, false);
  assert.equal(f.overflow.size, 3);
});

test("joint World, Settlement and overflow serialization reloads only untouched crops and never duplicates removed yields", (t) => {
  const options = {
    crops: [{ x: 7, age: CROP_GROW_SECONDS }, { x: 9 }, { x: 12 }],
  };
  const f = cropBatchFixture(t, options);
  const plan = prepareCropRemoval(f, f.plants(f.positions.slice(0, 2)));
  assert.ok(plan);
  assert.equal(f.coordinator.commit(plan.participants).ok, true);
  const saved = JSON.parse(JSON.stringify(f.snapshot()));
  const restored = cropBatchFixture(t, options);
  assert.equal(restored.world.loadEdits(saved.world), true);
  assert.equal(
    restored.settlement.load(saved.settlement, { world: restored.world }),
    true
  );
  assert.equal(restored.overflow.load(saved.overflow), true);
  assert.deepEqual(restored.snapshot(), saved);
  assert.equal(
    restored.settlement.prepareRemoveCrops(
      restored.world,
      restored.plants(restored.positions.slice(0, 2))
    ),
    null
  );
  const remaining = restored.settlement.prepareRemoveCrops(
    restored.world,
    restored.plants(restored.positions.slice(2))
  );
  assert.deepEqual(remaining?.drops, [
    { x: 12, y: 1, z: 8, stack: { id: ITEM.SEEDS, count: 1 } },
  ]);
  assert.deepEqual(restored.overflow.serialize(), saved.overflow);
});

test("maximum crop batches use bounded changed-record work, at most 512 cell reads and 512 retained stacks", (t) => {
  const crops = Array.from({ length: MAX_CROP_BATCH_PLANTS }, (_, index) => ({
    x: index % 16,
    z: Math.floor(index / 16),
    age: CROP_GROW_SECONDS,
  }));
  const f = cropBatchFixture(t, { crops });
  const plants = f.plants();
  let reads = 0;
  const getCell = f.world.getCell.bind(f.world);
  t.mock.method(f.world, "getCell", (...args) => {
    reads++;
    return getCell(...args);
  });
  t.mock.method(f.settlement, "serialize", () =>
    assert.fail("batch preparation cannot serialize unrelated crop ownership")
  );
  t.mock.method(f.world, "_generateSync", () =>
    assert.fail("batch preparation cannot generate a missing chunk")
  );
  for (const store of [
    f.settlement.crops,
    f.settlement.chests,
    f.settlement.furnaces,
  ])
    t.mock.method(store, Symbol.iterator, () =>
      assert.fail("batch preparation cannot scan the whole settlement")
    );
  const source = f.settlement.prepareRemoveCrops(f.world, plants);
  assert.ok(source);
  assert.ok(reads <= 2 * plants.length);
  assert.equal(source.drops.length, 2 * plants.length);
  assert.equal(f.settlement.crops.size, plants.length);
  assert.equal(f.overflow.size, 0);
  reads = 0;
  assert.equal(source.participant.validate(), true);
  assert.ok(reads <= 2 * plants.length);
  reads = 0;
  assert.equal(
    f.settlement.prepareRemoveCrops(f.world, [...plants, plants[0]]),
    null
  );
  assert.equal(reads, 0, "overlarge input rejects before reading any cells");
});
