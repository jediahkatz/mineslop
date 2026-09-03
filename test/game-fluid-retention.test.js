import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK, BLOCKS } from "../src/blocks.js";
import {
  FLUID as F,
  BLOCK_STATE as S,
  normalizeCell,
} from "../src/block-state.js";
import { FLUID_SERVICE_LIMITS } from "../src/game-fluid-services.js";
import { ITEM } from "../src/items.js";
import { encodedBytes, MAX_RESERVED_BYTES } from "../src/save-budget.js";
import { CROP_GROW_SECONDS } from "../src/settlement.js";
import {
  fluidChannel,
  fluidServicesFixture,
  serviceSteps,
} from "./game-fluid-services-fixture.js";

const flowers = () => [
  ...fluidChannel(),
  [7, 1, 8, BLOCK.RED_FLOWER],
  [9, 1, 8, BLOCK.YELLOW_FLOWER],
];
const crop = (x, age = CROP_GROW_SECONDS) => ({
  dimension: "overworld",
  x,
  y: 1,
  z: 8,
  age,
});
const cropCells = () => [
  ...fluidChannel(),
  [7, 0, 8, BLOCK.FARMLAND],
  [7, 1, 8, BLOCK.WHEAT_CROP],
  [9, 0, 8, BLOCK.FARMLAND],
  [9, 1, 8, BLOCK.TALL_GRASS],
];
const counts = (overflow) => {
  const out = new Map();
  for (const entry of overflow.serialize().entries)
    out.set(entry.id, (out.get(entry.id) ?? 0) + entry.count);
  return out;
};

function authoredRemoval(f) {
  const plants = [7, 9].map((x) => ({
    x,
    y: 1,
    z: 8,
    before: f.world.getCell(x, 1, 8),
  }));
  const changes = plants.map((plant) => ({
    ...plant,
    after: normalizeCell({ id: BLOCK.WATER, fluid: F.WATER_1 }),
  }));
  const scope = {
    plants,
    changes,
    dimension: f.world.dimension,
    epoch: f.world.epoch,
  };
  const drops = plants.map((plant) => ({
    x: plant.x,
    y: plant.y,
    z: plant.z,
    stack: { id: BLOCKS[plant.before.id].drop, count: 1 },
  }));
  return { scope, drops, world: f.world.prepareMutation(changes) };
}

test("one synchronous fluid tick prepares exactly one multi-position retained batch and no inventory grant", (t) => {
  const f = fluidServicesFixture(t, { initial: flowers() });
  const batches = [];
  const prepare = f.overflow.prepareAddBatch.bind(f.overflow);
  f.overflow.prepareAddBatch = (entries) => {
    batches.push(structuredClone(entries));
    assert.equal(f.world.get(7, 1, 8), BLOCK.RED_FLOWER);
    assert.equal(f.world.get(9, 1, 8), BLOCK.YELLOW_FLOWER);
    assert.equal(f.overflow.size, 0);
    return prepare(entries);
  };
  const inventory = f.gameplay.serialize();
  f.put(8, 1, 8, BLOCK.WATER);
  serviceSteps(f.service, 1);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].length, 2);
  assert.deepEqual(batches[0].map(({ x, y, z }) => [x, y, z]).sort(), [
    [7, 1, 8],
    [9, 1, 8],
  ]);
  assert.equal(f.world.getFluid(7, 1, 8), F.WATER_1);
  assert.equal(f.world.getFluid(9, 1, 8), F.WATER_1);
  assert.equal(f.overflow.size, 2);
  assert.deepEqual(f.gameplay.serialize(), inventory);
  serviceSteps(f.service, 6);
  assert.equal(
    batches.length,
    1,
    "conservative replay must not duplicate retained loot"
  );
  assert.equal(
    f.overflow.reservedBytes,
    encodedBytes(f.overflow.serialize().entries) - 2
  );
});

test("prepared plant retention keeps exact tagged positions, dimension and detached stack metadata", (t) => {
  const f = fluidServicesFixture(t, { initial: flowers() });
  const plan = authoredRemoval(f);
  for (const drop of plan.drops) {
    drop.x += 0.125;
    drop.y += 0.25;
    drop.z += 0.75;
    drop.dimension = f.world.dimension;
    drop.epoch = f.world.epoch;
    drop.stack.data = { version: 1, name: `保持:${drop.x}|flower` };
    drop.pickupDelay = 3;
    drop.velocity = { x: -1, y: 2, z: 0.5 };
  }
  const original = structuredClone(plan.drops);
  const before = f.snapshot();
  const retained = f.service.prepareDrops(plan.drops, plan.scope);
  assert.ok(retained);
  assert.equal(retained.filter((p) => p.owner === f.overflow).length, 1);
  assert.deepEqual(f.snapshot(), before, "preparation publishes nothing");
  plan.drops[0].stack.data.name = "caller mutation";
  plan.drops[0].velocity.x = 30;
  assert.equal(f.coordinator.commit([plan.world, ...retained]).ok, true);
  const entries = f.overflow.serialize().entries;
  assert.equal(entries.length, original.length);
  for (let i = 0; i < entries.length; i++) {
    assert.deepEqual(
      [entries[i].x, entries[i].y, entries[i].z],
      [original[i].x, original[i].y, original[i].z]
    );
    assert.deepEqual(entries[i].data, original[i].stack.data);
    assert.deepEqual(entries[i].velocity, original[i].velocity);
    assert.equal(entries[i].pickupDelay, 3);
    assert.equal(entries[i].dimension, f.world.dimension);
  }
  assert.equal(f.coordinator.commit([plan.world, ...retained]).ok, false);
  assert.equal(f.overflow.size, original.length);
});

test("overflow-record refusal and full shared bytes retain plants AND retry work until admission succeeds", (t) => {
  for (const denial of ["records", "bytes"]) {
    const f = fluidServicesFixture(t, {
      initial: flowers(),
      maxEntries: denial === "records" ? 1 : undefined,
    });
    f.put(8, 1, 8, BLOCK.WATER);
    const filler = {};
    if (denial === "bytes")
      assert.equal(
        f.coordinator.register(
          filler,
          MAX_RESERVED_BYTES - f.coordinator.budget.totalBytes
        ),
        true
      );
    const before = f.snapshot(),
      bytes = f.coordinator.budget.totalBytes;
    serviceSteps(f.service, 2);
    assert.deepEqual(f.snapshot(), before);
    assert.equal(f.coordinator.budget.totalBytes, bytes);
    assert.ok(f.service.diagnostics().fluid.queued > 0);
    if (denial === "records") f.overflow.maxEntries = 2;
    else f.coordinator.release(filler);
    serviceSteps(f.service, 2);
    assert.equal(f.overflow.size, 2);
    assert.equal(f.world.get(7, 1, 8), BLOCK.WATER);
    assert.equal(f.world.get(9, 1, 8), BLOCK.WATER);
  }
});

test("a real missing Settlement batch API keeps both mature and seedling crops pending, with no harvest fallback", (t) => {
  const f = fluidServicesFixture(t, {
    initial: cropCells(),
    crops: [crop(7), crop(9, 0)],
  });
  f.settlement.prepareRemoveCrops = undefined;
  f.settlement.prepareHarvestCrop = () =>
    assert.fail("single-crop inventory harvest is not a batch debit");
  f.put(8, 1, 8, BLOCK.WATER);
  const before = f.snapshot();
  serviceSteps(f.service, 4);
  assert.deepEqual(f.snapshot(), before);
  assert.ok(f.service.diagnostics().fluid.queued > 0);
  assert.ok(f.service.diagnostics().dropRefusals > 0);
});

test("missing crop records are never fabricated, including the farmland/tall-grass seedling representation", (t) => {
  const f = fluidServicesFixture(t, {
    initial: cropCells(),
  });
  let called = 0;
  f.settlement.prepareRemoveCrops = () => {
    called++;
    return null;
  };
  f.put(8, 1, 8, BLOCK.WATER);
  const before = f.snapshot();
  serviceSteps(f.service, 3);
  assert.deepEqual(f.snapshot(), before);
  assert.equal(called, 0);
  assert.equal(f.settlement.crops.size, 0);
});

test("the real crop owner coalesces its source debit once and replaces generic crop loot", (t) => {
  const f = fluidServicesFixture(t, {
    initial: cropCells(),
    crops: [crop(7), crop(9, 0)],
  });
  let calls = 0;
  const cropPrepare = f.settlement.prepareRemoveCrops.bind(f.settlement);
  f.settlement.prepareRemoveCrops = (world, plants) => {
    calls++;
    assert.ok(Object.isFrozen(plants));
    assert.equal(plants.length, 2);
    assert.equal(f.settlement.crops.size, 2);
    return cropPrepare(world, plants);
  };
  f.put(8, 1, 8, BLOCK.WATER);
  const inventory = f.gameplay.serialize();
  const owners = [],
    commit = f.coordinator.commit.bind(f.coordinator);
  f.coordinator.commit = (participants) => {
    owners.push(participants.map((participant) => participant.owner));
    return commit(participants);
  };
  serviceSteps(f.service, 1);
  assert.equal(calls, 1);
  assert.equal(owners.length, 1);
  assert.equal(new Set(owners[0]).size, 4);
  assert.deepEqual(
    new Set(owners[0]),
    new Set([f.world, f.service, f.settlement, f.overflow])
  );
  assert.equal(f.settlement.crops.size, 0);
  assert.deepEqual(
    counts(f.overflow),
    new Map([
      [ITEM.WHEAT, 2],
      [ITEM.SEEDS, 2],
    ])
  );
  assert.deepEqual(f.gameplay.serialize(), inventory);
  serviceSteps(f.service, 4);
  assert.equal(calls, 1);
  assert.deepEqual(
    counts(f.overflow),
    new Map([
      [ITEM.WHEAT, 2],
      [ITEM.SEEDS, 2],
    ])
  );
});

test("receipt-shaped/duplicate-owner crop plans are not converted to another item grant", (t) => {
  for (const receipt of [true, false]) {
    const f = fluidServicesFixture(t, {
      initial: cropCells(),
      crops: [crop(7), crop(9, 0)],
    });
    const prepare = f.settlement.prepareRemoveCrops.bind(f.settlement);
    f.settlement.prepareRemoveCrops = (...args) => {
      const plan = prepare(...args);
      return receipt
        ? { ...plan, dropsCommitted: true }
        : {
            participants: [plan.participant, plan.participant],
            drops: plan.drops,
          };
    };
    f.put(8, 1, 8, BLOCK.WATER);
    const before = f.snapshot();
    serviceSteps(f.service, 2);
    assert.deepEqual(f.snapshot(), before);
    assert.ok(f.service.diagnostics().fluid.queued > 0);
  }
});

test("a source revision or epoch veto cannot orphan retained loot or publish half a crop batch", (t) => {
  for (const stale of ["crop", "epoch", "host"]) {
    const f = fluidServicesFixture(t, {
      initial: cropCells(),
      crops: [crop(7), crop(9, 0)],
    });
    const plan = authoredRemoval(f);
    const retained = f.service.prepareDrops(plan.drops, plan.scope);
    assert.ok(retained);
    if (stale === "crop")
      assert.equal(
        f.settlement.load(f.settlement.serialize(), { world: f.world }),
        true
      );
    if (stale === "epoch") f.world.setDimension("nether");
    if (stale === "host") f.game.overflow = {};
    const before = f.overflow.serialize(),
      crops = f.settlement.serialize();
    assert.equal(f.coordinator.commit([plan.world, ...retained]).ok, false);
    assert.deepEqual(f.overflow.serialize(), before);
    assert.deepEqual(f.settlement.serialize(), crops);
  }
});

test("throwing postcommit observers see all plant/retention owners already published and cannot duplicate drops", (t) => {
  const f = fluidServicesFixture(t, { initial: flowers() });
  const error = new Error("authored retained-drop observer");
  f.overflow.onChange = () => {
    assert.equal(f.world.get(7, 1, 8), BLOCK.WATER);
    assert.equal(f.world.get(9, 1, 8), BLOCK.WATER);
    assert.equal(f.overflow.size, 2);
    throw error;
  };
  f.put(8, 1, 8, BLOCK.WATER);
  serviceSteps(f.service, 1);
  assert.equal(f.service.diagnostics().fluid.last.observerErrors, 1);
  serviceSteps(f.service, 4);
  assert.equal(f.overflow.size, 2);
});

test("sponge placement, aquatic removal, waterlogged drainage and retained kelp/lily loot share one World transaction", (t) => {
  const f = fluidServicesFixture(t, {
    initial: [
      [8, 1, 8, BLOCK.AIR],
      [9, 1, 8, BLOCK.KELP],
      [9, 2, 8, BLOCK.LILY_PAD],
      [8, 1, 9, BLOCK.SEAGRASS],
      [
        7,
        1,
        8,
        { id: BLOCK.OAK_STAIRS, state: S.TOP | 2, fluid: F.WATER_SOURCE },
      ],
    ],
  });
  const before = f.snapshot();
  const action = f.service.prepareSpongeAbsorption(
    { x: 8, y: 1, z: 8 },
    { place: true }
  );
  assert.ok(action);
  assert.equal(
    action.participants.filter((p) => p.owner === f.world).length,
    1
  );
  assert.equal(
    action.participants.filter((p) => p.owner === f.overflow).length,
    1
  );
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.coordinator.commit(action.participants).ok, true);
  assert.equal(f.world.get(8, 1, 8), BLOCK.WET_SPONGE);
  assert.equal(f.world.get(9, 1, 8), BLOCK.AIR);
  assert.equal(f.world.get(9, 2, 8), BLOCK.AIR);
  assert.equal(f.world.get(8, 1, 9), BLOCK.AIR);
  assert.deepEqual(f.world.getCell(7, 1, 8), {
    id: BLOCK.OAK_STAIRS,
    state: S.TOP | 2,
    fluid: F.NONE,
  });
  assert.equal(counts(f.overflow).get(BLOCK.KELP), 1);
  assert.equal(counts(f.overflow).get(BLOCK.LILY_PAD), 1);
  assert.equal(
    counts(f.overflow).has(BLOCK.SEAGRASS),
    false,
    "explicitly acknowledged seagrass destruction has no Java loot"
  );
  assert.equal(action.result.waterCells, 3);
  assert.equal(action.result.retentionPrepared, true);
});

test("sponge retention capacity and a prepared hand veto leave sponge center AND every aquatic host untouched", (t) => {
  const f = fluidServicesFixture(t, {
    initial: [
      [8, 1, 8, BLOCK.AIR],
      [9, 1, 8, BLOCK.KELP],
    ],
  });
  const action = f.service.prepareSpongeAbsorption(
    { x: 8, y: 1, z: 8 },
    { place: true }
  );
  assert.ok(action);
  const inventory = f.gameplay.prepareInventory(() => true);
  const before = f.snapshot();
  assert.equal(
    f.coordinator.commit([
      ...action.participants,
      { ...inventory, validate: () => false },
    ]).ok,
    false
  );
  assert.deepEqual(f.snapshot(), before);
  const filler = {};
  f.coordinator.register(
    filler,
    MAX_RESERVED_BYTES - f.coordinator.budget.totalBytes
  );
  assert.equal(f.coordinator.commit(action.participants).ok, false);
  assert.deepEqual(f.snapshot(), before);
  f.coordinator.release(filler);
  assert.equal(f.coordinator.commit(action.participants).ok, true);
  assert.equal(f.overflow.size, 1);
});

test("kelp/source-host adapters preserve support reads/orientation and require the host's hand transaction", (t) => {
  const f = fluidServicesFixture(t, {
    initial: [
      [8, 1, 8, { id: BLOCK.WATER, fluid: F.WATER_FALLING }],
      [9, 1, 8, { id: BLOCK.OAK_SLAB, state: S.TOP, fluid: F.NONE }],
    ],
  });
  const before = f.gameplay.serialize();
  const kelp = f.service.prepareKelpPlacement({ x: 8, y: 1, z: 8 });
  assert.ok(kelp);
  f.put(8, 0, 8, BLOCK.MAGMA_BLOCK);
  assert.equal(f.coordinator.commit(kelp.participants).ok, false);
  f.put(8, 0, 8, BLOCK.STONE);
  assert.equal(
    f.coordinator.commit(
      f.service.prepareKelpPlacement({ x: 8, y: 1, z: 8 }).participants
    ).ok,
    true
  );
  assert.equal(f.world.getFluid(8, 1, 8), F.WATER_SOURCE);
  const fill = f.service.prepareWaterlogging({ x: 9, y: 1, z: 8 });
  assert.equal(f.coordinator.commit(fill.participants).ok, true);
  assert.deepEqual(f.world.getCell(9, 1, 8), {
    id: BLOCK.OAK_SLAB,
    state: S.TOP,
    fluid: F.WATER_SOURCE,
  });
  const drain = f.service.prepareWaterlogging({ x: 9, y: 1, z: 8 }, false);
  assert.equal(f.coordinator.commit(drain.participants).ok, true);
  assert.deepEqual(f.world.getCell(9, 1, 8), {
    id: BLOCK.OAK_SLAB,
    state: S.TOP,
    fluid: F.NONE,
  });
  assert.deepEqual(
    f.gameplay.serialize(),
    before,
    "these prepared adapters do not own hand consumption"
  );
});

test("oversized, wrongly tagged or unacknowledged plant batches reject before any overflow prepare", (t) => {
  const f = fluidServicesFixture(t, { initial: flowers() });
  const plan = authoredRemoval(f);
  let called = 0;
  const prepare = f.overflow.prepareAddBatch.bind(f.overflow);
  f.overflow.prepareAddBatch = (...args) => {
    called++;
    return prepare(...args);
  };
  for (const scope of [
    { ...plan.scope, epoch: -1 },
    { ...plan.scope, dimension: "nether" },
    { ...plan.scope, plants: [...plan.scope.plants, plan.scope.plants[0]] },
    {
      ...plan.scope,
      plants: Array(FLUID_SERVICE_LIMITS.plants + 1).fill(plan.scope.plants[0]),
    },
  ])
    assert.equal(f.service.prepareDrops(plan.drops, scope), null);
  assert.equal(f.service.prepareDrops([], plan.scope), null);
  assert.equal(
    f.service.prepareDrops(
      [{ ...plan.drops[0], dimension: "nether" }],
      plan.scope
    ),
    null
  );
  assert.equal(called, 0);
});

test("maximum authored plant intake uses one bounded read pass and one overflow participant", (t) => {
  const initial = Array.from(
    { length: FLUID_SERVICE_LIMITS.plants },
    (_, i) => [i % 16, 1, Math.floor(i / 16), BLOCK.RED_FLOWER]
  );
  const f = fluidServicesFixture(t, { initial });
  const plants = initial.map(([x, y, z]) => ({
    x,
    y,
    z,
    before: f.world.getCell(x, y, z),
  }));
  const changes = plants.map((plant) => ({
    ...plant,
    after: normalizeCell({ id: BLOCK.WATER, fluid: F.WATER_1 }),
  }));
  const drops = plants.map(({ x, y, z }) => ({
    x,
    y,
    z,
    stack: { id: BLOCK.RED_FLOWER, count: 1 },
  }));
  let reads = 0;
  const get = f.world.getCell.bind(f.world);
  f.world.getCell = (...args) => {
    reads++;
    return get(...args);
  };
  const retained = f.service.prepareDrops(drops, {
    plants,
    changes,
    epoch: f.world.epoch,
    dimension: f.world.dimension,
  });
  assert.ok(retained);
  assert.equal(reads, plants.length);
  assert.ok(reads <= FLUID_SERVICE_LIMITS.prepareCellReads);
  assert.equal(retained.filter((p) => p.owner === f.overflow).length, 1);
  reads = 0;
  assert.equal(
    retained.every((participant) => participant.validate()),
    true
  );
  assert.ok(reads <= FLUID_SERVICE_LIMITS.validationCellReads);
  assert.equal(
    f.overflow.size,
    0,
    "read/prepare/validate does not publish ownership"
  );
});
