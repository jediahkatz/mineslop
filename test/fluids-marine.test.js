import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK, BLOCKS } from "../src/blocks.js";
import { BLOCK_STATE as S, FLUID as F } from "../src/block-state.js";
import {
  planKelpPlacement,
  planSpongeAbsorption,
  planWaterlogging,
} from "../src/fluid-actions.js";
import { FluidSystem } from "../src/fluids.js";
import { TransactionInvariantError } from "../src/transactions.js";
import {
  fluidFixture,
  fluidSteps,
  retainedPlantDrops,
} from "./fluid-fixture.js";

test("kelp placement converts source/falling water only and checks actual support", (t) => {
  const { world } = fluidFixture(t, {
    base: BLOCK.STONE,
    initial: [
      [8, 1, 8, { id: BLOCK.WATER, fluid: F.WATER_FALLING }],
      [8, 2, 8, BLOCK.WATER],
      [9, 1, 8, { id: BLOCK.WATER, fluid: F.WATER_1 }],
      [10, 1, 8, BLOCK.WATER],
      [10, 0, 8, BLOCK.MAGMA_BLOCK],
      [11, 1, 8, BLOCK.WATER],
      [11, 0, 8, BLOCK.AIR],
    ],
  });
  const before = world.serialize();
  const lower = planKelpPlacement(world, { x: 8, y: 1, z: 8 });
  assert.equal(lower.ok, true);
  assert.deepEqual(world.serialize(), before, "planning is pure");
  assert.deepEqual(lower.changes[0].after, {
    id: BLOCK.KELP,
    state: 0,
    fluid: F.WATER_SOURCE,
  });
  assert.equal(world.applyCells(lower.changes, { reads: lower.reads }), true);
  const upper = planKelpPlacement(world, { x: 8, y: 2, z: 8 });
  assert.equal(upper.ok, true);
  for (const x of [9, 10, 11])
    assert.equal(planKelpPlacement(world, { x, y: 1, z: 8 }).ok, false);
  assert.equal(
    planWaterlogging(world, { x: 8, y: 1, z: 8 }, false).ok,
    false,
    "an aquatic plant cannot be silently drained to an invalid dry live cell"
  );
});

test("kelp support loss waits for prepared retention; the column breaks bottom-up without losing water", (t) => {
  const { world, fluids, put } = fluidFixture(t, {
    base: BLOCK.STONE,
    initial: [
      [8, 1, 8, BLOCK.KELP],
      [8, 2, 8, BLOCK.KELP],
    ],
  });
  put(8, 0, 8, BLOCK.AIR);
  fluidSteps(fluids, 2);
  assert.equal(world.get(8, 1, 8), BLOCK.KELP);
  assert.ok(fluids.diagnostics().last.blockedDrops > 0);
  const { owner, prepareDrops } = retainedPlantDrops(world);
  fluids.prepareDrops = prepareDrops;
  owner.accept = false;
  fluidSteps(fluids, 1);
  assert.equal(world.get(8, 1, 8), BLOCK.KELP);
  assert.deepEqual(owner.drops, []);
  owner.accept = true;
  fluidSteps(fluids, 8);
  assert.equal(world.get(8, 1, 8), BLOCK.WATER);
  assert.equal(world.get(8, 2, 8), BLOCK.WATER);
  assert.equal(world.getFluid(8, 1, 8), F.WATER_SOURCE);
  assert.equal(world.getFluid(8, 2, 8), F.WATER_SOURCE);
  assert.deepEqual(
    owner.drops.map(({ stack }) => stack),
    [
      { id: BLOCK.KELP, count: 1 },
      { id: BLOCK.KELP, count: 1 },
    ]
  );
  assert.deepEqual(
    owner.plants.map(({ y }) => y),
    [1, 2]
  );
});

test("flow displaces a flower only in the same transaction as retained plant ownership", (t) => {
  const { world, fluids, put } = fluidFixture(t, {
    base: BLOCK.STONE,
    initial: [
      [8, 1, 8, BLOCK.AIR],
      [9, 1, 8, BLOCK.RED_FLOWER],
    ],
  });
  const { owner, prepareDrops } = retainedPlantDrops(world);
  fluids.prepareDrops = prepareDrops;
  owner.accept = false;
  put(8, 1, 8, BLOCK.WATER);
  fluidSteps(fluids, 1);
  assert.equal(world.get(9, 1, 8), BLOCK.RED_FLOWER);
  assert.equal(owner.drops.length, 0);
  owner.accept = true;
  fluidSteps(fluids, 1);
  assert.equal(world.get(9, 1, 8), BLOCK.WATER);
  assert.equal(world.getFluid(9, 1, 8), F.WATER_1);
  assert.deepEqual(
    owner.drops.map(({ stack }) => stack),
    [{ id: BLOCK.RED_FLOWER, count: 1 }]
  );
  assert.equal(owner.plants[0].before.id, BLOCK.RED_FLOWER);
});

test("async drop preparation never runs and fatal transaction invariants are not swallowed", (t) => {
  const { world, fluids, put } = fluidFixture(t, {
    base: BLOCK.STONE,
    initial: [[8, 1, 8, BLOCK.KELP]],
  });
  assert.throws(
    () =>
      new FluidSystem(world, {
        prepareDrops: async () =>
          assert.fail("must not invoke async preparation"),
      }),
    /synchronous/
  );
  put(8, 0, 8, BLOCK.AIR);
  fluids.prepareDrops = () => {
    throw new TransactionInvariantError("authored fatal hook");
  };
  assert.throws(() => fluids.update(0.25), TransactionInvariantError);
  assert.equal(world.get(8, 1, 8), BLOCK.KELP);
});

test("dry live coral uses a persisted scheduled delay and its registered dead form never revives", (t) => {
  const live = BLOCK.TUBE_CORAL_BLOCK;
  const { world, fluids, put } = fluidFixture(t, {
    base: BLOCK.STONE,
    initial: [
      [8, 1, 8, live],
      [9, 1, 8, BLOCK.AIR],
    ],
  });
  fluids.onMutation([{ x: 8, y: 1, z: 8 }]);
  fluidSteps(fluids, 1);
  assert.equal(world.get(8, 1, 8), live);
  const saved = fluids.serialize();
  assert.ok(
    saved.dimensions[0].queue.some((entry) => entry[5] === live && entry[6] > 1)
  );
  assert.equal(fluids.load(saved), true);
  fluidSteps(fluids, 20);
  assert.equal(world.get(8, 1, 8), BLOCKS[live].deadBlock);
  put(9, 1, 8, BLOCK.WATER);
  fluidSteps(fluids, 20);
  assert.equal(world.get(8, 1, 8), BLOCKS[live].deadBlock);
});

test("water arriving before coral's scheduled death cancels that dry interval", (t) => {
  const live = BLOCK.FIRE_CORAL_BLOCK;
  const { world, fluids, put } = fluidFixture(t, {
    base: BLOCK.STONE,
    initial: [
      [8, 1, 8, live],
      [9, 1, 8, BLOCK.AIR],
    ],
  });
  fluids.onMutation([{ x: 8, y: 1, z: 8 }]);
  fluidSteps(fluids, 1);
  put(9, 1, 8, BLOCK.WATER);
  fluidSteps(fluids, 24);
  assert.equal(world.get(8, 1, 8), live);
  put(9, 1, 8, BLOCK.AIR);
  fluidSteps(fluids, 1);
  assert.equal(world.get(8, 1, 8), live, "rewetting cleared the old deadline");
  fluidSteps(fluids, 20);
  assert.equal(world.get(8, 1, 8), BLOCKS[live].deadBlock);
});

test("explicit waterlogging preserves orientation and rejects non-hosts, doors and double slabs", (t) => {
  const { world } = fluidFixture(t, {
    initial: [
      [8, 1, 8, { id: BLOCK.OAK_STAIRS, state: S.TOP | 2 }],
      [9, 1, 8, { id: BLOCK.OAK_DOOR, state: S.OPEN }],
      [10, 1, 8, { id: BLOCK.OAK_SLAB, state: S.DOUBLE }],
    ],
  });
  const plan = planWaterlogging(world, { x: 8, y: 1, z: 8 });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.changes[0].after, {
    id: BLOCK.OAK_STAIRS,
    state: S.TOP | 2,
    fluid: F.WATER_SOURCE,
  });
  for (const x of [9, 10, 11])
    assert.equal(planWaterlogging(world, { x, y: 1, z: 8 }).ok, false);
});

test("sponge planning is pure, breadth-first and capped at 65 water cells with bounded reads", (t) => {
  const { world } = fluidFixture(t, { base: BLOCK.WATER });
  const before = world.serialize();
  t.mock.method(world.generator, "generateChunk", () =>
    assert.fail("sponge queries cannot generate")
  );
  const center = { x: 8, y: 8, z: 8 };
  const plan = planSpongeAbsorption(world, center);
  assert.equal(plan.ok, true);
  assert.equal(plan.waterCells, 65);
  assert.equal(plan.changes.length, 65);
  assert.equal(plan.spongeCell.id, BLOCK.WET_SPONGE);
  assert.ok(plan.reads.length <= 457);
  assert.ok(plan.visited <= 396);
  const distances = plan.changes.map(
    ({ x, y, z }) =>
      Math.abs(x - center.x) + Math.abs(y - center.y) + Math.abs(z - center.z)
  );
  assert.ok(distances.every((distance) => distance <= 7));
  assert.deepEqual(
    distances,
    [...distances].sort((a, b) => a - b)
  );
  assert.deepEqual(world.serialize(), before);
  assert.equal(planSpongeAbsorption(world, center, { maxCells: 66 }).ok, false);
  assert.equal(
    planSpongeAbsorption(world, center, { maxDistance: Infinity }).ok,
    false
  );
});

test("sponge drains source hosts without destroying their orientation or jumping an air gap", (t) => {
  const host = {
    id: BLOCK.OAK_STAIRS,
    state: S.TOP | 1,
    fluid: F.WATER_SOURCE,
  };
  const { world } = fluidFixture(t, {
    base: BLOCK.STONE,
    initial: [
      [8, 1, 8, BLOCK.AIR],
      [9, 1, 8, BLOCK.WATER],
      [10, 1, 8, host],
      [11, 1, 8, BLOCK.WATER],
      [8, 1, 9, BLOCK.AIR],
      [8, 1, 10, BLOCK.WATER],
    ],
  });
  const plan = planSpongeAbsorption(world, { x: 8, y: 1, z: 8 });
  assert.equal(plan.ok, true);
  assert.equal(plan.waterCells, 3);
  assert.deepEqual(
    plan.changes.map(({ x, y, z }) => [x, y, z]),
    [
      [9, 1, 8],
      [10, 1, 8],
      [11, 1, 8],
    ]
  );
  assert.deepEqual(plan.changes[1].after, { ...host, fluid: F.NONE });
  assert.deepEqual(
    world.getCell(10, 1, 8),
    host,
    "pure planning does not drain the live host"
  );
  assert.deepEqual(plan.drops, []);
});

test("sponge keeps drained live aquatic coral as its registered dead host", (t) => {
  const live = BLOCK.BRAIN_CORAL_FAN;
  const { world } = fluidFixture(t, {
    base: BLOCK.STONE,
    initial: [
      [8, 1, 8, BLOCK.AIR],
      [9, 1, 8, live],
    ],
  });
  const plan = planSpongeAbsorption(world, { x: 8, y: 1, z: 8 });
  assert.equal(plan.ok, true);
  assert.equal(plan.waterCells, 1);
  assert.deepEqual(plan.changes[0].after, {
    id: BLOCKS[live].deadBlock,
    state: 0,
    fluid: F.NONE,
  });
  assert.deepEqual(plan.drops, []);
  assert.equal(world.get(9, 1, 8), live);
});

test("sponge reports aquatic plants and lily-pad drops for one joint ownership transaction", (t) => {
  const { world } = fluidFixture(t, {
    base: BLOCK.STONE,
    initial: [
      [8, 1, 8, BLOCK.AIR],
      [9, 1, 8, BLOCK.KELP],
      [9, 2, 8, BLOCK.LILY_PAD],
      [8, 1, 9, BLOCK.SEAGRASS],
    ],
  });
  const { owner, prepareDrops } = retainedPlantDrops(world);
  const plan = planSpongeAbsorption(world, { x: 8, y: 1, z: 8 });
  assert.equal(plan.ok, true);
  assert.equal(plan.waterCells, 2);
  assert.equal(plan.plants.length, 3);
  assert.deepEqual(
    new Set(plan.drops.map(({ stack }) => stack.id)),
    new Set([BLOCK.KELP, BLOCK.LILY_PAD])
  );
  const worldPlan = world.prepareMutation(plan.changes, { reads: plan.reads });
  const drops = prepareDrops(plan.drops, { plants: plan.plants });
  owner.accept = false;
  assert.equal(world.coordinator.commit([worldPlan, drops]).ok, false);
  assert.equal(world.get(9, 1, 8), BLOCK.KELP);
  assert.equal(owner.drops.length, 0);
  owner.accept = true;
  assert.equal(world.coordinator.commit([worldPlan, drops]).ok, true);
  assert.equal(world.get(9, 1, 8), BLOCK.AIR);
  assert.equal(world.get(9, 2, 8), BLOCK.AIR);
  assert.equal(world.get(8, 1, 9), BLOCK.AIR);
  assert.equal(owner.drops.length, 2);
});

test("sponge helpers refuse an unloaded search frontier instead of returning a partial complete plan", (t) => {
  const { world } = fluidFixture(t, {
    radius: 0,
    base: BLOCK.STONE,
    initial: [
      [14, 1, 8, BLOCK.AIR],
      [15, 1, 8, BLOCK.WATER],
    ],
  });
  const before = world.serialize();
  t.mock.method(world.generator, "generateChunk", () =>
    assert.fail("no sponge generation")
  );
  const plan = planSpongeAbsorption(world, { x: 14, y: 1, z: 8 });
  assert.equal(plan.ok, false);
  assert.equal(plan.reason, "unloaded");
  assert.deepEqual(plan.changes, []);
  assert.ok(plan.waiting.some(([cx, cz]) => cx === 1 && cz === 0));
  assert.deepEqual(world.serialize(), before);
});
