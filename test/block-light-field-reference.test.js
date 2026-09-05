import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { FLUID } from "../src/block-state.js";
import { DenseSolver } from "./block-light-reference-fixture.js";
import { lightField, lightWorld, settleLight } from "./block-light-fixture.js";

test("negative-coordinate pages, edge aprons, mutations and GPU restore equal dense reference", (t) => {
  const columns = [];
  for (let x = -3; x <= 0; x++) for (let z = -2; z <= 0; z++) columns.push([x, z]);
  const world = lightWorld({ columns }), optimized = lightField(t), dense = lightField(t);
  dense.solver = new DenseSolver();
  const at = { x: -24, y: 8, z: -8 };
  const equivalent = () => {
    settleLight(optimized, world, at, 1); settleLight(dense, world, at, 1);
    assert.deepEqual(optimized.valid, dense.valid);
    assert.deepEqual(optimized.data, dense.data);
    for (const x of [-32.01, -31.99, -16.01, -15.99, -0.01])
      assert.deepEqual(optimized.sample({ x, y: 8, z: -8 }), dense.sample({ x, y: 8, z: -8 }));
  };
  world.put(-17, 8, -8, BLOCK.TORCH);
  world.put(-16, 8, -8, BLOCK.WATER, 0, FLUID.WATER_3);
  world.put(-33, 15, -16, BLOCK.LAVA);
  equivalent();
  // CPU fixture acknowledges uploads just as the existing field fixture does;
  // no GL or browser acceptance is claimed here.
  optimized.restoreGPU(); dense.restoreGPU();
  equivalent();
  world.put(-17, 8, -8, BLOCK.STONE);
  world.put(-33, 15, -16, BLOCK.AIR);
  optimized.update(world, at, 1); dense.update(world, at, 1);
  for (const field of [optimized, dense])
    assert.deepEqual(field.sample({ x: -16, y: 8, z: -8 }), [0, 0, 0], "no stale light on removal");
  equivalent();
  world.epoch++;
  equivalent();
});

for (const interruption of ["mutation", "world replacement"]) {
  test(`field ${interruption} during generation rollover preserves dense-reference lighting`, (t) => {
    let world = lightWorld();
    const optimized = lightField(t), dense = lightField(t);
    dense.solver = new DenseSolver();
    const at = { x: 8, y: 8, z: 8 };
    // Reach rollover through actual invalidations and scheduled field jobs,
    // without changing generation tags or manufacturing solver internals.
    for (let edit = 0; edit < 130 && !optimized.solver.resetPending; edit++) {
      world.put(8, 8, 8, edit % 2 ? BLOCK.TORCH : BLOCK.LAVA);
      let updates = 0;
      do {
        optimized.update(world, at, 0);
        optimized.texture.clearLayerUpdates();
        assert.ok(++updates < 100, "each mutation makes bounded progress");
      } while (optimized.pending && !optimized.solver.resetPending);
    }
    assert.equal(optimized.solver.phase, "reset");
    assert.equal(optimized.solver.resetPending, true);
    assert.ok(optimized.solver.cursor > 0, "rollover is partially cleared");
    const interruptedJob = optimized.job;
    if (interruption === "world replacement") world = lightWorld();
    else world.put(8, 8, 8, BLOCK.AIR);
    world.put(9, 8, 8, BLOCK.TORCH);

    optimized.update(world, at, 0);
    optimized.texture.clearLayerUpdates();
    assert.notEqual(optimized.job, interruptedJob, "the obsolete field job is discarded");
    assert.deepEqual(optimized.sample(at), [0, 0, 0], "old illumination stays unavailable");
    settleLight(optimized, world, at, 0);
    settleLight(dense, world, at, 0);
    assert.equal(optimized.solver.resetPending, false);
    assert.deepEqual(optimized.valid, dense.valid);
    // Dark/unavailable atlas bytes may legally retain old data. Compare the
    // authoritative completed pages and receiver samples, not unused storage.
    assert.deepEqual([...optimized.cache.keys()].sort(), [...dense.cache.keys()].sort());
    for (const [key, entry] of optimized.cache)
      assert.deepEqual(entry.values, dense.cache.get(key).values, key);
    for (const x of [7, 8, 9, 10, 15])
      assert.deepEqual(optimized.sample({ x, y: 8, z: 8 }), dense.sample({ x, y: 8, z: 8 }));
  });
}
