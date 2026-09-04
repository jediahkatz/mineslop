import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { World } from "../src/world.js";
import {
  MAX_ROUTE_NODES,
  PLAN_RADIUS,
  planShoreRoute,
  planTreeRoute,
  planWalkingRoute,
  scanReachable,
} from "./boat-survival/planning.js";
import {
  planNaturalPlankRecipes,
  recipeResources,
  resourceCounts,
} from "./realtime/survival.mjs";
import { ITEM } from "../src/items.js";

function terrainSignature(world) {
  const hash = createHash("sha256");
  for (const [key, chunk] of world.chunks) {
    hash.update(`${key}:${chunk.revision}:${chunk.incarnation}`);
    hash.update(new Uint8Array(chunk.blocks.buffer));
  }
  return {
    terrain: hash.digest("hex"),
    saved: world.serialize(),
    admitted: [...world.chunks.keys()],
    pending: world._requests.size,
  };
}

function checkRoute(world, route, origin, destination) {
  assert.ok(route.length > 1 && route.length <= MAX_ROUTE_NODES);
  assert.deepEqual(route[0], { x: origin.x, y: Math.floor(origin.y), z: origin.z });
  assert.deepEqual(route.at(-1), destination);
  for (let index = 0; index < route.length; index++) {
    const point = route[index];
    assert.equal(world.isLoaded(point.x, point.z), true);
    assert.equal(world.isSolid(Math.floor(point.x), point.y, Math.floor(point.z)), false);
    if (!index) continue;
    const previous = route[index - 1];
    assert.equal(Math.abs(previous.x - point.x) + Math.abs(previous.z - point.z), 1);
    assert.ok(Math.abs(previous.y - point.y) <= 1, "only flat or one-block transitions");
  }
}

test("UI-selectable boat-survival-6 has a native spawn → matching tree → navigable shore plan", {
  timeout: 120000,
}, () => {
  // Detached Node fixture only. The browser host never requests chunk admission.
  const world = new World("boat-survival-6", { useWorker: false }).generate(4);
  try {
    const spawn = world.getSpawn();
    const before = terrainSignature(world);
    const tree = planTreeRoute(world, spawn);
    const shore = planShoreRoute(world, tree.approach);
    checkRoute(world, tree.route, spawn, tree.approach);
    checkRoute(world, shore.route, tree.approach, shore.approach);
    assert.equal(tree.provenance.generatorVersion, 3);
    assert.equal(tree.provenance.radius, PLAN_RADIUS);
    assert.equal(tree.trunk.length, 3);
    assert.equal(new Set(tree.trunk.map(({ id }) => id)).size, 1);
    for (const cell of tree.trunk)
      assert.equal(world.get(cell.x, cell.y, cell.z), cell.id);
    assert.equal(world.get(shore.table.x, shore.table.y, shore.table.z), BLOCK.AIR);
    assert.equal(world.get(shore.support.x, shore.support.y, shore.support.z), shore.support.id);
    assert.deepEqual(terrainSignature(world), before,
      "planning cannot edit voxels, admit chunks, schedule generation or change saves");
    const returnRoute = planWalkingRoute(world, tree.approach, spawn);
    checkRoute(world, returnRoute.route, tree.approach, {
      x: spawn.x, y: Math.floor(spawn.y), z: spawn.z,
    });
    console.log(JSON.stringify({
      seed: world.seed, generatorVersion: world.generatorVersion, spawn,
      tree: { trunk: tree.trunk, approach: tree.approach, steps: tree.route.length - 1 },
      shore: {
        approach: shore.approach, table: shore.table, launch: shore.launch,
        steps: shore.route.length - 1,
      },
    }));
  } finally {
    world.dispose();
  }
});

test("untouched default cedar-valley still has a reachable native matching-log tree", () => {
  const world = new World("cedar-valley", { useWorker: false }).generate(4);
  try {
    const spawn = world.getSpawn();
    const before = terrainSignature(world);
    const tree = planTreeRoute(world, spawn);
    checkRoute(world, tree.route, spawn, tree.approach);
    assert.equal(new Set(tree.trunk.map(({ id }) => id)).size, 1);
    assert.deepEqual(terrainSignature(world), before);
  } finally {
    world.dispose();
  }
});

test("native route queries reject unbounded scans and unknown, unadmitted starts", () => {
  const world = new World("cedar-valley", { useWorker: false });
  try {
    const origin = { x: 0.5, y: 30, z: 0.5 };
    assert.throws(() => scanReachable(world, origin, { radius: 65 }), /radius/);
    assert.throws(() => scanReachable(world, origin, { radius: 2.5 }), /radius/);
    assert.throws(() => scanReachable(world, { ...origin, x: Infinity }), /finite/);
    assert.throws(() => planTreeRoute(world, origin), /not standing/);
    assert.equal(world.chunks.size, 0);
    assert.equal(world._requests.size, 0, "a failed plan cannot request its own terrain");
    assert.equal(world.edits.size, 0);
  } finally {
    world.dispose();
  }
});

test("three matching natural logs pay for twelve planks, table, boat and three spare planks", () => {
  const initial = [{ id: ITEM.APPLE, count: 4 }, { id: BLOCK.OAK_LOG, count: 3 }];
  let expected = resourceCounts(initial);
  for (const recipe of planNaturalPlankRecipes(expected))
    expected = recipeResources(expected, recipe);
  assert.deepEqual(expected, resourceCounts([
    { id: ITEM.APPLE, count: 4 }, { id: BLOCK.PLANKS, count: 12 },
  ]));
  expected = recipeResources(expected, "crafting_table");
  expected = recipeResources(expected, "oak_boat");
  assert.deepEqual(expected, resourceCounts([
    { id: ITEM.APPLE, count: 4 }, { id: BLOCK.PLANKS, count: 3 },
    { id: BLOCK.CRAFTING_TABLE, count: 1 }, { id: ITEM.OAK_BOAT, count: 1 },
  ]));
  assert.throws(() => recipeResources(
    [{ id: BLOCK.PLANKS, count: 4 }], "oak_boat"
  ), /cannot afford/);
});
