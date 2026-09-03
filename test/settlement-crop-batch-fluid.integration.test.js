import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { FLUID } from "../src/block-state.js";
import { GameFluidServices } from "../src/game-fluid-services.js";
import { ITEM } from "../src/items.js";
import { Settlement } from "../src/settlement.js";
import {
  cropBatchFixture,
  cropDropCounts,
} from "./settlement-crop-batch-fixture.js";

function activateCropFluids(t, f, saved = null) {
  assert.equal(f.settlement.constructor, Settlement);
  assert.equal(
    f.settlement.prepareRemoveCrops,
    Settlement.prototype.prepareRemoveCrops
  );
  const service = new GameFluidServices({
    world: f.world,
    settlement: f.settlement,
    overflow: f.overflow,
    coordinator: f.coordinator,
    context: f.context,
    saved,
  });
  const host = {
    world: f.world,
    settlement: f.settlement,
    overflow: f.overflow,
    gameplay: f.gameplay,
    coordinator: f.coordinator,
    worldContext: f.context,
    simulating: true,
    paused: false,
    building: false,
    failed: false,
  };
  assert.equal(service.activate(host).ok, true);
  f.world.onMutation = (event) => service.onMutation(f.world, event);
  f.world.onChunkAdmitted = (event) => service.onChunkLoaded(f.world, event);
  t.after(() => service.dispose());
  return service;
}

const steps = (service, count) => {
  for (let index = 0; index < count; index++)
    assert.equal(service.frame(0.25, { simulating: true }).ok, true);
};

test("REAL GameFluidServices washes actual planted mature and immature crops in one four-owner transaction and one yield batch", (t) => {
  const f = cropBatchFixture(t);
  const service = activateCropFluids(t, f);
  const inventory = f.gameplay.serialize();
  const batches = [];
  const prepare = f.overflow.prepareAddBatch.bind(f.overflow);
  t.mock.method(f.overflow, "prepareAddBatch", (entries) => {
    assert.equal(f.world.get(7, 1, 8), BLOCK.WHEAT_CROP);
    assert.equal(f.world.get(9, 1, 8), BLOCK.TALL_GRASS);
    assert.equal(f.settlement.crops.size, 2);
    assert.equal(f.overflow.size, 0);
    batches.push(structuredClone(entries));
    return prepare(entries);
  });
  const ownerBatches = [];
  const commit = f.coordinator.commit.bind(f.coordinator);
  t.mock.method(f.coordinator, "commit", (participants) => {
    if (participants.some(({ owner }) => owner === f.settlement))
      ownerBatches.push(participants.map(({ owner }) => owner));
    return commit(participants);
  });
  let notifications = 0;
  f.overflow.onChange = () => {
    notifications++;
    assert.equal(f.settlement.crops.size, 0);
    assert.equal(f.world.getFluid(7, 1, 8), FLUID.WATER_1);
    assert.equal(f.world.getFluid(9, 1, 8), FLUID.WATER_1);
    assert.equal(f.overflow.size, 3);
  };
  f.put(8, 1, 8, BLOCK.WATER);
  steps(service, 1);
  assert.equal(ownerBatches.length, 1);
  assert.equal(ownerBatches[0].length, 4);
  assert.deepEqual(
    new Set(ownerBatches[0]),
    new Set([f.world, service, f.settlement, f.overflow])
  );
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 3);
  assert.deepEqual(batches[0].map(({ x, y, z }) => [x, y, z]).sort(), [
    [7, 1, 8],
    [7, 1, 8],
    [9, 1, 8],
  ]);
  const counts = cropDropCounts(f.overflow);
  assert.deepEqual(
    counts,
    new Map([
      [ITEM.WHEAT, 2],
      [ITEM.SEEDS, 2],
    ])
  );
  assert.equal(counts.has(BLOCK.WHEAT_CROP), false);
  assert.equal(counts.has(BLOCK.TALL_GRASS), false);
  assert.equal(notifications, 1);
  assert.deepEqual(f.gameplay.serialize(), inventory);
  steps(service, 8);
  assert.equal(batches.length, 1);
  assert.equal(ownerBatches.length, 1);
  assert.deepEqual(cropDropCounts(f.overflow), counts);
});

test("REAL crop retention refusal keeps source cells and records pending, then admits one complete batch", (t) => {
  const f = cropBatchFixture(t, { maxEntries: 2 });
  const service = activateCropFluids(t, f);
  const prepare = f.overflow.prepareAddBatch.bind(f.overflow);
  const accepted = [];
  t.mock.method(f.overflow, "prepareAddBatch", (entries) => {
    const participant = prepare(entries);
    if (participant) accepted.push(structuredClone(entries));
    return participant;
  });
  f.put(8, 1, 8, BLOCK.WATER);
  const before = f.snapshot();
  steps(service, 3);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(accepted.length, 0);
  assert.ok(service.diagnostics().dropRefusals > 0);
  assert.ok(service.diagnostics().fluid.queued > 0);
  f.overflow.maxEntries = 3;
  steps(service, 2);
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].length, 3);
  assert.equal(f.settlement.crops.size, 0);
  assert.deepEqual(
    cropDropCounts(f.overflow),
    new Map([
      [ITEM.WHEAT, 2],
      [ITEM.SEEDS, 2],
    ])
  );
  steps(service, 6);
  assert.equal(accepted.length, 1);
});

test("REAL service rejects a record/cell maturity mismatch without substituting generic block loot", (t) => {
  const f = cropBatchFixture(t);
  f.put(9, 1, 8, BLOCK.WHEAT_CROP);
  const service = activateCropFluids(t, f);
  f.put(8, 1, 8, BLOCK.WATER);
  const before = f.snapshot();
  const prepare = t.mock.method(f.overflow, "prepareAddBatch", () =>
    assert.fail(
      "invalid crop ownership must refuse before any retained destination"
    )
  );
  steps(service, 3);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(prepare.mock.callCount(), 0);
  assert.ok(service.diagnostics().dropRefusals > 0);
});

test("saved REAL fluid work, World edits, crop records and retained yields reload without a second crop payment", (t) => {
  const f = cropBatchFixture(t);
  const service = activateCropFluids(t, f);
  f.put(8, 1, 8, BLOCK.WATER);
  steps(service, 1);
  const saved = JSON.parse(
    JSON.stringify({
      world: f.world.serialize(),
      settlement: f.settlement.serialize(),
      overflow: f.overflow.serialize(),
      sidecar: service.serialize(),
    })
  );
  assert.equal(saved.settlement.crops.length, 0);
  assert.equal(saved.overflow.entries.length, 3);
  const restored = cropBatchFixture(t);
  const admissions = [];
  restored.world.onChunkAdmitted = (event) => admissions.push(event);
  assert.equal(restored.world.loadEdits(saved.world), true);
  assert.equal(
    restored.settlement.load(saved.settlement, { world: restored.world }),
    true
  );
  assert.equal(restored.overflow.load(saved.overflow), true);
  const resumed = activateCropFluids(t, restored, saved.sidecar);
  assert.ok(admissions.length > 0);
  for (const event of admissions) {
    assert.ok(Object.isFrozen(event));
    assert.equal(resumed.onChunkLoaded(restored.world, event), true);
  }
  const before = restored.overflow.serialize();
  const inventory = restored.gameplay.serialize();
  const prepare = t.mock.method(restored.overflow, "prepareAddBatch", () =>
    assert.fail(
      "restored removed crops must not produce another retained batch"
    )
  );
  steps(resumed, 12);
  assert.equal(prepare.mock.callCount(), 0);
  assert.equal(restored.settlement.crops.size, 0);
  assert.deepEqual(restored.overflow.serialize(), before);
  assert.deepEqual(restored.gameplay.serialize(), inventory);
  assert.equal(restored.world.getFluid(7, 1, 8), FLUID.WATER_1);
  assert.equal(restored.world.getFluid(9, 1, 8), FLUID.WATER_1);
});
