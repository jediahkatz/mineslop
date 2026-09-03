import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK, isSolid } from "../../src/blocks.js";
import { ITEM, LOG_ITEMS } from "../../src/items.js";
import {
  collidesWithWorld,
  EYE_HEIGHT,
  moveWithCollisions,
} from "../../src/player.js";
import { raycast, World } from "../../src/world.js";
import {
  planNaturalPlankRecipes,
  planNaturalTree,
  recipeResources,
  resourceCounts,
  survivalAim,
  survivalPlanningRules,
  wearTargetDrop,
} from "./survival.mjs";

test("natural wear accounting distinguishes snow from dirt and stone", () => {
  assert.equal(wearTargetDrop(BLOCK.STONE), BLOCK.COBBLESTONE);
  for (const id of [BLOCK.GRASS, BLOCK.DIRT, BLOCK.PODZOL, BLOCK.MYCELIUM])
    assert.equal(wearTargetDrop(id), BLOCK.DIRT);
  assert.equal(wearTargetDrop(BLOCK.SNOW), BLOCK.SNOW);
  assert.equal(wearTargetDrop(BLOCK.SNOW_BLOCK), BLOCK.SNOW_BLOCK);
  assert.throws(() => wearTargetDrop(BLOCK.DIAMOND_ORE), /Unsupported/);
});

// Planner/accounting checks only. These never launch a browser and are NOT
// evidence that the trusted-input Survival integration flow has completed.
const key = ({ x, y, z }) => `${x},${y},${z}`;
const center = ({ x, y, z }) => ({ x: x + 0.5, y: y + 0.5, z: z + 0.5 });
const direction = (from, to) => ({
  x: to.x - from.x,
  y: to.y - from.y,
  z: to.z - from.z,
});

function readOnlyProjection(world, entries) {
  const changes = new Map(entries);
  const get = (x, y, z) => changes.get(`${x},${y},${z}`) ?? world.get(x, y, z);
  return {
    get,
    isSolid: (x, y, z) => isSolid(get(x, y, z)),
    isLoaded: (x, z) => world.isLoaded(x, z),
  };
}

test("real generated tree plan preserves terrain and passes real raycast/collision checks", {
  // Actual terrain generation, not a mocked planner-only microbenchmark.
  timeout: 10000,
}, () => {
  const world = new World("cedar-valley", { useWorker: false }).generate(1);
  try {
    const origin = world.generator.getSpawn();
    const original = [...world.chunks].map(([id, chunk]) => [
      id,
      chunk.blocks.slice(),
    ]);
    const before = world.serialize();
    const plan = planNaturalTree({
      world,
      origin,
      rules: survivalPlanningRules,
    });
    assert.equal(plan.trunk.length, 3);
    assert.ok(plan.approachDistance >= 2 && plan.approachDistance <= 3);
    assert.ok(!collidesWithWorld(world, plan.approach));
    const eye = { ...plan.approach, y: plan.approach.y + EYE_HEIGHT };
    for (const cell of plan.trunk) {
      assert.ok(LOG_ITEMS.includes(cell.id));
      assert.equal(world.get(cell.x, cell.y, cell.z), cell.id);
      assert.equal(
        key(raycast(world, eye, direction(eye, center(cell)), 5)),
        key(cell)
      );
    }
    const afterMining = readOnlyProjection(
      world,
      plan.trunk.map((cell) => [key(cell), BLOCK.AIR])
    );
    const movement = moveWithCollisions(afterMining, plan.approach, {
      x: plan.pickup.x - plan.approach.x,
      y: 0,
      z: plan.pickup.z - plan.approach.z,
    });
    assert.ok(
      Math.hypot(
        movement.position.x - plan.pickup.x,
        movement.position.z - plan.pickup.z
      ) < 0.000001
    );
    assert.ok(!collidesWithWorld(afterMining, plan.pickup));
    const workEye = {
      ...plan.workPosition,
      y: plan.workPosition.y + EYE_HEIGHT,
    };
    const support = raycast(
      afterMining,
      workEye,
      direction(workEye, plan.groundAim),
      5
    );
    assert.equal(key(support), key(plan.ground));
    assert.equal(support.normal.y, 1);
    const afterTable = readOnlyProjection(world, [
      ...plan.trunk.map((cell) => [key(cell), BLOCK.AIR]),
      [key(plan.table), BLOCK.CRAFTING_TABLE],
    ]);
    const wearAim = {
      x: plan.wearTarget.x + 0.5,
      y: plan.wearTarget.y + 0.98,
      z: plan.wearTarget.z + 0.5,
    };
    assert.equal(
      key(raycast(afterTable, workEye, direction(workEye, wearAim), 5)),
      key(plan.wearTarget)
    );
    assert.deepEqual(world.serialize(), before);
    assert.equal(world.chunks.size, original.length);
    for (const [id, blocks] of original)
      assert.deepEqual(world.chunks.get(id).blocks, blocks);
  } finally {
    world.dispose();
  }
});

test("tree planner rejects edited terrain and unavailable chunks without exploration", () => {
  const empty = { chunks: new Map(), edits: new Map(), isLoaded: () => false };
  const args = {
    world: empty,
    origin: { x: 0, y: 1, z: 0 },
    rules: survivalPlanningRules,
  };
  assert.throws(
    () => planNaturalTree(args),
    /No accessible three-log trunk.*0 loaded chunks/
  );
  empty.edits.set("overworld:1,1,1", BLOCK.PLANKS);
  assert.throws(() => planNaturalTree(args), /unedited generated world/);
});

test("natural plank planning requires exactly three collected logs without changing the ledger", () => {
  for (const entries of [
    [],
    [{ id: BLOCK.SPRUCE_LOG, count: 2 }],
    [{ id: BLOCK.SPRUCE_LOG, count: 4 }],
    [
      { id: BLOCK.OAK_LOG, count: 1 },
      { id: BLOCK.BIRCH_LOG, count: 1 },
    ],
    [{ id: BLOCK.BIRCH_PLANKS, count: 12 }],
  ]) {
    const before = structuredClone(entries);
    assert.throws(
      () => planNaturalPlankRecipes(entries),
      /exactly three collected logs/
    );
    assert.deepEqual(entries, before);
  }
  const split = [
    { id: BLOCK.SPRUCE_LOG, count: 1 },
    { id: ITEM.APPLE, count: 4 },
    { id: BLOCK.SPRUCE_LOG, count: 2 },
  ];
  const before = structuredClone(split);
  assert.deepEqual(planNaturalPlankRecipes(split), [
    "spruce_planks",
    "spruce_planks",
    "spruce_planks",
  ]);
  assert.deepEqual(split, before);
});

test("recipe ledger conserves three non-oak logs through table placement and pickaxe", () => {
  const initial = [
    { id: ITEM.APPLE, count: 4 },
    { id: BLOCK.SPRUCE_LOG, count: 3 },
  ];
  const copy = structuredClone(initial);
  let resources = initial;
  const plankRecipes = planNaturalPlankRecipes(resources);
  assert.deepEqual(plankRecipes, [
    "spruce_planks",
    "spruce_planks",
    "spruce_planks",
  ]);
  for (const recipe of plankRecipes)
    resources = recipeResources(resources, recipe);
  assert.deepEqual(
    resources,
    resourceCounts([
      { id: ITEM.APPLE, count: 4 },
      { id: BLOCK.SPRUCE_PLANKS, count: 12 },
    ])
  );
  for (const recipe of ["sticks", "crafting_table"])
    resources = recipeResources(resources, recipe);
  assert.deepEqual(
    resources,
    resourceCounts([
      { id: ITEM.APPLE, count: 4 },
      { id: BLOCK.SPRUCE_PLANKS, count: 6 },
      { id: ITEM.STICK, count: 4 },
      { id: BLOCK.CRAFTING_TABLE, count: 1 },
    ])
  );
  resources = resourceCounts([
    ...resources,
    { id: BLOCK.CRAFTING_TABLE, count: -1 },
  ]);
  resources = recipeResources(resources, "wood_pickaxe");
  assert.deepEqual(
    resources,
    resourceCounts([
      { id: ITEM.APPLE, count: 4 },
      { id: BLOCK.SPRUCE_PLANKS, count: 3 },
      { id: ITEM.STICK, count: 2 },
      { id: ITEM.WOOD_PICKAXE, count: 1 },
    ])
  );
  assert.deepEqual(initial, copy);
  assert.throws(
    () => recipeResources(resources, "crafting_table"),
    /cannot afford/
  );
});

test("recipe ledger keeps mixed-log outputs distinct through table placement and pickaxe", () => {
  const entries = [
    { id: BLOCK.OAK_LOG, count: 1 },
    { id: BLOCK.BIRCH_LOG, count: 2 },
  ];
  let next = entries;
  const plankRecipes = planNaturalPlankRecipes(entries);
  assert.deepEqual(plankRecipes, ["planks", "birch_planks", "birch_planks"]);
  for (const recipe of plankRecipes) next = recipeResources(next, recipe);
  assert.deepEqual(
    next,
    resourceCounts([
      { id: BLOCK.PLANKS, count: 4 },
      { id: BLOCK.BIRCH_PLANKS, count: 8 },
    ])
  );
  const afterPlanks = structuredClone(next);
  assert.throws(() => recipeResources(next, "planks"), /cannot afford/);
  assert.throws(() => recipeResources(next, "birch_planks"), /cannot afford/);
  assert.throws(
    () => recipeResources([{ id: BLOCK.BIRCH_LOG, count: 3 }], "planks"),
    /cannot afford/
  );
  assert.throws(() => recipeResources(next, "not_a_recipe"), /Unsupported/);
  assert.throws(
    () => recipeResources(next, "charcoal"),
    /Unsupported immediate/
  );
  assert.deepEqual(next, afterPlanks);
  next = recipeResources(next, "sticks");
  assert.deepEqual(
    next,
    resourceCounts([
      { id: BLOCK.PLANKS, count: 2 },
      { id: BLOCK.BIRCH_PLANKS, count: 8 },
      { id: ITEM.STICK, count: 4 },
    ])
  );
  next = recipeResources(next, "crafting_table");
  assert.deepEqual(
    next,
    resourceCounts([
      { id: BLOCK.BIRCH_PLANKS, count: 6 },
      { id: ITEM.STICK, count: 4 },
      { id: BLOCK.CRAFTING_TABLE, count: 1 },
    ])
  );
  next = resourceCounts([...next, { id: BLOCK.CRAFTING_TABLE, count: -1 }]);
  next = recipeResources(next, "wood_pickaxe");
  assert.deepEqual(
    next,
    resourceCounts([
      { id: BLOCK.BIRCH_PLANKS, count: 3 },
      { id: ITEM.STICK, count: 2 },
      { id: ITEM.WOOD_PICKAXE, count: 1 },
    ])
  );
  assert.throws(() => recipeResources(next, "crafting_table"), /cannot afford/);
  assert.deepEqual(entries, [
    { id: BLOCK.OAK_LOG, count: 1 },
    { id: BLOCK.BIRCH_LOG, count: 2 },
  ]);
});

test("resource accounting includes real drop stacks and removes consumed zero counts", () => {
  const entries = [
    { id: ITEM.STICK, count: 3 },
    { id: BLOCK.PLANKS, count: 4 },
    { id: ITEM.STICK, count: 1 },
    { id: BLOCK.PLANKS, count: -4 },
  ];
  const original = structuredClone(entries);
  assert.deepEqual(resourceCounts(entries), [{ id: ITEM.STICK, count: 4 }]);
  assert.deepEqual(entries, original);
});

test("aiming selects the short yaw wrap and the real eye-to-voxel pitch", () => {
  const state = { yaw: Math.PI - 0.01, eye: { x: 0.5, y: 2.62, z: 0.5 } };
  const original = structuredClone(state);
  const aim = survivalAim(state, { x: 0.52, y: 2.5, z: 2.5 });
  assert.ok(Math.abs(aim.yaw - state.yaw) < 0.03);
  assert.ok(aim.pitch < 0);
  assert.deepEqual(state, original);
  const directionFromAim = {
    x: -Math.sin(aim.yaw) * Math.cos(aim.pitch),
    y: Math.sin(aim.pitch),
    z: -Math.cos(aim.yaw) * Math.cos(aim.pitch),
  };
  assert.ok(directionFromAim.x > 0 && directionFromAim.z > 0);
});
