import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { FLUID } from "../src/block-state.js";
import { inspectFishingOpenWater } from "../src/fishing-water.js";
import { sampleFluidAtPoint } from "../src/fluid-sampling.js";
import { aquaticSample, sharedAquaticSample } from "../src/vehicle-water.js";
import { aquaticWorld } from "./vehicle-fishing-fixture.js";

test("the complete source-water footprint qualifies, including collisionless aquatic plants", () => {
  const world = aquaticWorld();
  const bobber = { x: 0.5, y: world.surface - 0.035, z: 0.5 };
  assert.equal(inspectFishingOpenWater(world, bobber).valid, true);
  world.setCell(1, 7, -1, { id: BLOCK.SEAGRASS });
  assert.equal(inspectFishingOpenWater(world, bobber).valid, true);
});

test("flowing, falling and either bubble direction fail even in a remote lower corner", () => {
  const world = aquaticWorld();
  const bobber = { x: 0.5, y: world.surface - 0.035, z: 0.5 };
  for (const fluid of [
    FLUID.WATER_1,
    FLUID.WATER_7,
    FLUID.WATER_FALLING,
    FLUID.BUBBLE_UP,
    FLUID.BUBBLE_DOWN,
  ]) {
    world.setCell(-2, 7, 2, { id: BLOCK.WATER, fluid });
    assert.deepEqual(
      {
        loaded: inspectFishingOpenWater(world, bobber).loaded,
        valid: inspectFishingOpenWater(world, bobber).valid,
      },
      { loaded: true, valid: false }
    );
  }
  world.setCell(-2, 7, 2, { id: BLOCK.WATER });
  assert.equal(inspectFishingOpenWater(world, bobber).valid, true);
});

test("mixed layers, roofs and colliding waterlogged shapes fail the Java layer predicate", () => {
  for (const [x, y, z, cell] of [
    [2, 9, 2, { id: BLOCK.STONE }],
    [1, 9, 1, { id: BLOCK.WATER }],
    [0, 8, 0, { id: BLOCK.OAK_SLAB, fluid: FLUID.WATER_SOURCE }],
    [-1, 7, 1, { id: BLOCK.AIR }],
  ]) {
    const world = aquaticWorld();
    world.setCell(x, y, z, cell);
    assert.equal(
      inspectFishingOpenWater(world, {
        x: 0.5,
        y: world.surface - 0.035,
        z: 0.5,
      }).valid,
      false
    );
  }
});

test("unknown frontier is distinct from an invalid pond, and signed world bounds are respected", () => {
  const world = aquaticWorld();
  world.loaded = (x) => x < 3;
  assert.deepEqual(
    inspectFishingOpenWater(world, {
      x: 0.5,
      y: world.surface - 0.035,
      z: 0.5,
    }),
    { loaded: false, valid: false, reason: "frontier" }
  );
  const signed = aquaticWorld({ waterTop: -16, floor: -22 });
  assert.equal(
    inspectFishingOpenWater(signed, {
      x: 0.5,
      y: signed.surface - 0.035,
      z: 0.5,
    }).valid,
    true
  );
  const historical = aquaticWorld({
    generatorVersion: 3,
    waterTop: -16,
    floor: -22,
  });
  assert.equal(
    inspectFishingOpenWater(historical, { x: 0.5, y: -15.2, z: 0.5 }).valid,
    false
  );
});

test("the default sampler uses shared shape fluid volume rather than block-ID water guesses", () => {
  const world = aquaticWorld();
  world.setCell(0, 8, 0, { id: BLOCK.OAK_SLAB, fluid: FLUID.WATER_SOURCE });
  assert.equal(aquaticSample(world, { x: 0.5, y: 8.2, z: 0.5 }).water, false);
  const upper = aquaticSample(world, { x: 0.5, y: 8.7, z: 0.5 });
  assert.equal(upper.source, true);
  assert.equal(upper.surfaceY, 8.88);
  assert.deepEqual(upper.current, { x: 0, y: 0, z: 0 });
  const provider = (world, point) => ({
    ...sharedAquaticSample(world, point),
    current: { x: 0.75, y: -0.5, z: 0.25 },
  });
  assert.deepEqual(
    aquaticSample(world, { x: 0.5, y: 8.7, z: 0.5 }, provider).current,
    { x: 0.75, y: -0.5, z: 0.25 }
  );
});

test("the fluid owner's point sampler plugs in directly and unavailable samples freeze", () => {
  const world = aquaticWorld();
  const point = { x: 0.5, y: 8.7, z: 0.5 };
  world.setCell(0, 8, 0, { id: BLOCK.WATER, fluid: FLUID.BUBBLE_UP });
  const sample = aquaticSample(world, point, sampleFluidAtPoint);
  assert.equal(sample.water, true);
  assert.equal(sample.bubble, 1);
  assert.equal(sample.surfaceY, 8.88);
  assert.deepEqual(sample.current, { x: 0, y: 1, z: 0 });
  for (const flags of [
    { loaded: false },
    { valid: false },
    { current: { x: 2, y: 0, z: 0 } },
  ])
    assert.equal(
      aquaticSample(world, point, () => ({
        fluid: FLUID.WATER_SOURCE,
        surfaceY: 8.88,
        ...flags,
      })),
      null
    );
  world.loaded = () => false;
  assert.equal(aquaticSample(world, point, sampleFluidAtPoint), null);
});
