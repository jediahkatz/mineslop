import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK_STATE, cellsEqual, FLUID, normalizeCell } from "../src/block-state.js";
import { BLOCK, BLOCKS } from "../src/blocks.js";
import {
  GAMEPLAY_LIGHT_LIMITS,
  GameplayLightScratch,
  gameplayEmissionLevel,
  readGameplayHabitat,
  readGameplayHabitatLight,
} from "../src/gameplay-light.js";
import { World } from "../src/world.js";
import { gameMobGenerator } from "./game-mob-integration-fixture.js";

function fixture(t) {
  const world = new World("gameplay-light", {
    generatorVersion: 3,
    generatorFactory: gameMobGenerator,
    useWorker: false,
  });
  world.generate(2);
  t.after(() => world.dispose());
  return world;
}

function put(world, x, y, z, id, options = {}) {
  const before = world.getCell(x, y, z);
  const after = normalizeCell({ id, ...options });
  if (!cellsEqual(before, after))
    assert.equal(world.applyCells([{ x, y, z, before, after }]), true);
}

const sample = (world, position, options) =>
  readGameplayHabitatLight(world, position, options);

test("gameplay emission is explicit and exact without renderer fallback", () => {
  assert.deepEqual([
    BLOCK.GLOWSTONE, BLOCK.SEA_LANTERN, BLOCK.LAVA,
    BLOCK.TORCH, BLOCK.GLOW_BERRIES, BLOCK.NETHER_PORTAL, BLOCK.END_PORTAL,
  ].map(gameplayEmissionLevel), [15, 15, 15, 14, 10, 11, 15]);
  assert.equal(BLOCKS[BLOCK.POTENT_SULFUR].emissive, true);
  assert.equal(gameplayEmissionLevel(BLOCK.POTENT_SULFUR), 0);
  assert.equal(gameplayEmissionLevel(BLOCK.SCULK), 0);
});

test("reverse propagation preserves exact air, water and waterlogged attenuation", (t) => {
  const world = fixture(t), target = { x: 8.5, y: 70, z: 8.5 };
  put(world, 8, 70, 8, BLOCK.TORCH);
  assert.equal(sample(world, target).blockLight, 14);
  put(world, 8, 70, 8, BLOCK.AIR);
  put(world, 9, 70, 8, BLOCK.TORCH);
  assert.equal(sample(world, target).blockLight, 13);
  put(world, 9, 70, 8, BLOCK.AIR);
  put(world, 10, 70, 8, BLOCK.TORCH);
  assert.equal(sample(world, target).blockLight, 12);
  put(world, 8, 70, 8, BLOCK.WATER);
  put(world, 9, 70, 8, BLOCK.SEA_LANTERN);
  assert.equal(sample(world, target).blockLight, 13);
  put(world, 8, 70, 8, BLOCK.OAK_SLAB, { fluid: FLUID.WATER_SOURCE });
  assert.equal(sample(world, target).blockLight, 13);
});

test("partial shape states transmit direct vertical and horizontal gameplay light", (t) => {
  const world = fixture(t), x = 8, target = { x: 8.5, y: 70, z: 8.5 };
  const shapes = [
    BLOCK.OAK_SLAB, BLOCK.OAK_STAIRS, BLOCK.OAK_FENCE,
    BLOCK.OAK_DOOR, BLOCK.OAK_TRAPDOOR,
  ];
  for (const id of shapes) {
    put(world, x, 71, 8, id);
    put(world, x, 72, 8, BLOCK.TORCH);
    const vertical = sample(world, target);
    assert.equal(vertical.blockLight, 12, `${BLOCKS[id].name} vertical`);
    assert.equal(vertical.skyLight, 15, `${BLOCKS[id].name} is not a full skylight cube`);
    put(world, x, 71, 8, BLOCK.AIR);
    put(world, x + 1, 70, 8, id);
    put(world, x + 2, 70, 8, BLOCK.TORCH);
    assert.equal(sample(world, target).blockLight, 12, `${BLOCKS[id].name} horizontal`);
    put(world, x + 1, 70, 8, BLOCK.AIR);
    put(world, x + 2, 70, 8, BLOCK.AIR);
  }
  put(world, x, 71, 8, BLOCK.OAK_SLAB, { state: BLOCK_STATE.DOUBLE });
  assert.equal(sample(world, target).skyLight, 0, "a double slab retains full-cube opacity");
});

test("cheap habitat metadata performs no voxel scan and full light has a hard operation bound", (t) => {
  const world = fixture(t), position = { x: 8.5, y: 70, z: 8.5 };
  const cells = t.mock.method(world, "getCell");
  assert.deepEqual(readGameplayHabitat(world, position), { biomeId: "plains" });
  assert.equal(cells.mock.callCount(), 0);
  const stats = {};
  assert.ok(sample(world, position, { stats }));
  assert.ok(stats.cellReads <= GAMEPLAY_LIGHT_LIMITS.maxBlockCells);
  assert.ok(stats.queuedCells <= GAMEPLAY_LIGHT_LIMITS.maxBlockCells);
  assert.ok(stats.maxQueue <= stats.queuedCells);
  const rejectedSky = {};
  const skyOnly = sample(world, position, { stats: rejectedSky, skipBlockAboveSky: 7 });
  assert.equal(skyOnly.skyLight, 15);
  assert.equal(skyOnly.blockLight, undefined);
  assert.equal(rejectedSky.queuedCells, 0);
  assert.ok(rejectedSky.cellReads < stats.cellReads);
});

test("reused Game scratch is result and operation equivalent to isolated fixture reads", (t) => {
  const world = fixture(t), position = { x: 8.5, y: 70, z: 8.5 };
  const scratch = new GameplayLightScratch();
  const cases = [
    () => put(world, 9, 70, 8, BLOCK.TORCH),
    () => put(world, 8, 70, 8, BLOCK.WATER),
    () => put(world, 8, 70, 8, BLOCK.OAK_SLAB, { fluid: FLUID.WATER_SOURCE }),
    () => put(world, 8, 71, 8, BLOCK.OAK_SLAB, { state: BLOCK_STATE.DOUBLE }),
  ];
  for (const arrange of cases) {
    arrange();
    const isolatedStats = {}, reusedStats = {};
    const isolated = sample(world, position, { stats: isolatedStats });
    const reused = sample(world, position, { stats: reusedStats, scratch });
    assert.deepEqual(reused, isolated);
    assert.deepEqual(reusedStats, isolatedStats);
  }
  const firstBudget = {}, secondBudget = {};
  assert.equal(sample(world, position, { maxCells: 1, stats: firstBudget, scratch }), null);
  assert.equal(sample(world, position, { maxCells: 1, stats: secondBudget, scratch }), null);
  assert.deepEqual(secondBudget, firstBudget);
});

test("budget exhaustion and chunk replacement are unknown, never darkness", (t) => {
  const world = fixture(t), position = { x: 8.5, y: 70, z: 8.5 };
  const budget = {};
  assert.equal(sample(world, position, { maxCells: 1, stats: budget }), null);
  assert.equal(budget.cellReads, 2, "the first over-budget read immediately marks unknown");

  const key = "0,0", original = world.chunks.get.bind(world.chunks);
  let lookups = 0;
  t.mock.method(world.chunks, "get", function (candidate) {
    if (candidate === key && ++lookups === 2) {
      const chunk = original(key);
      world._removeChunk(key, chunk);
      world._generateSync(0, 0);
      return original(key);
    }
    return original(candidate);
  });
  assert.equal(sample(world, position), null);
});
