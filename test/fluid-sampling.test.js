import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { BLOCK_STATE as S, FLUID as F } from "../src/block-state.js";
import { fluidAtPoint } from "../src/collision.js";
import {
  createFluidSample,
  fluidCurrent,
  MAX_FLUID_SAMPLE_CELLS,
  sampleFluid,
  sampleFluidAtPoint,
} from "../src/fluid-sampling.js";
import { fluidFixture } from "./fluid-fixture.js";

const near = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);

test("point sampling agrees exactly with shared fluid volumes and reuses its output vector", (t) => {
  const { world } = fluidFixture(t, { initial: [[8, 1, 8, BLOCK.WATER]] });
  const out = createFluidSample();
  const current = out.current;
  const wet = { x: 8.5, y: 1.5, z: 8.5 };
  assert.equal(sampleFluidAtPoint(world, wet, out), out);
  assert.equal(out.fluid, fluidAtPoint(world, wet));
  assert.equal(out.fluid, F.WATER_SOURCE);
  near(out.height, 0.88);
  near(out.surfaceY, 1.88);
  near(out.depth, 0.38);
  assert.equal(out.immersion, 1);
  assert.equal(out.canBreathe, false);
  const dry = { ...wet, y: 1.9 };
  assert.equal(sampleFluidAtPoint(world, dry, out), out);
  assert.equal(out.current, current);
  assert.equal(out.fluid, fluidAtPoint(world, dry));
  assert.equal(out.fluid, F.NONE);
  assert.equal(out.immersion, 0);
  assert.equal(out.surfaceY, null);
  assert.equal(out.canBreathe, true);
  assert.deepEqual(out.current, { x: 0, y: 0, z: 0 });
});

test("all lateral levels, falling water and lava expose the renderer's actual heights", (t) => {
  const codes = [
    F.WATER_1,
    F.WATER_2,
    F.WATER_3,
    F.WATER_4,
    F.WATER_5,
    F.WATER_6,
    F.WATER_7,
    F.WATER_FALLING,
  ];
  const { world } = fluidFixture(t, {
    initial: [
      ...codes.map((fluid, i) => [i + 2, 1, 8, { id: BLOCK.WATER, fluid }]),
      [12, 1, 8, BLOCK.LAVA],
    ],
  });
  for (const [i, fluid] of codes.entries()) {
    const height = fluid === F.WATER_FALLING ? 1 : (9 - fluid) / 9;
    const point = { x: i + 2.5, y: 1 + height / 2, z: 8.5 };
    const sample = sampleFluidAtPoint(world, point);
    assert.equal(sample.fluid, fluidAtPoint(world, point));
    assert.equal(sample.fluid, fluid);
    near(sample.height, height);
    assert.equal(
      sampleFluidAtPoint(world, { ...point, y: 1 + height + 0.001 }).fluid,
      F.NONE
    );
  }
  const lava = sampleFluidAtPoint(world, { x: 12.5, y: 1.5, z: 8.5 });
  assert.equal(lava.fluid, F.LAVA_SOURCE);
  assert.equal(lava.kind, "lava");
  assert.equal(lava.lavaImmersion, 1);
  assert.equal(lava.canBreathe, false);
});

test("waterlogged body immersion excludes solid slab volume and uses an independent eye sample", (t) => {
  const { world } = fluidFixture(t, {
    initial: [
      [8, 1, 8, { id: BLOCK.OAK_SLAB, state: S.TOP, fluid: F.WATER_SOURCE }],
      [10, 1, 8, { id: BLOCK.OAK_SLAB, fluid: F.WATER_SOURCE }],
    ],
  });
  const topWet = { x: 8.5, y: 1.25, z: 8.5 };
  assert.equal(sampleFluidAtPoint(world, topWet).fluid, F.WATER_SOURCE);
  assert.equal(sampleFluidAtPoint(world, { ...topWet, y: 1.75 }).fluid, F.NONE);
  const top = sampleFluid(
    world,
    { x: 8.5, y: 1, z: 8.5 },
    { height: 1, eyeHeight: 0.8 }
  );
  near(top.immersion, 0.5);
  near(top.height, 0.5);
  near(top.surfaceY, 1.5);
  assert.equal(top.eyeSubmerged, false);
  const bottom = sampleFluid(
    world,
    { x: 10.5, y: 1, z: 8.5 },
    { height: 1, eyeHeight: 0.75 }
  );
  near(bottom.immersion, 0.38);
  near(bottom.surfaceY, 1.88);
  assert.equal(bottom.eyeSubmerged, true);
  assert.equal(bottom.canBreathe, false);
  assert.equal(
    sampleFluidAtPoint(world, { x: 10.5, y: 1.25, z: 8.5 }).fluid,
    F.NONE
  );
});

for (const sign of [-1, 1]) {
  test(`flow-derived current points down the ${sign > 0 ? "east" : "west"} level gradient`, (t) => {
    const { world } = fluidFixture(t, {
      base: BLOCK.STONE,
      initial: [
        [8 - sign, 1, 8, BLOCK.WATER],
        [8, 1, 8, { id: BLOCK.WATER, fluid: F.WATER_3 }],
        [8 + sign, 1, 8, { id: BLOCK.WATER, fluid: F.WATER_6 }],
      ],
    });
    const current = fluidCurrent(world, 8, 1, 8);
    near(current.x, sign);
    assert.equal(current.y, 0);
    assert.equal(current.z, 0);
    near(Math.hypot(current.x, current.y, current.z), 1);
  });
}

test("clipped source hosts retain source strength while gravity takes priority over a dry side opening", (t) => {
  const { world } = fluidFixture(t, {
    base: BLOCK.STONE,
    initial: [
      [8, 1, 8, { id: BLOCK.OAK_SLAB, state: S.TOP, fluid: F.WATER_SOURCE }],
      [9, 1, 8, { id: BLOCK.WATER, fluid: F.WATER_1 }],
      [8, 4, 8, BLOCK.WATER],
      [8, 3, 8, BLOCK.AIR],
      [9, 4, 8, BLOCK.AIR],
    ],
  });
  const host = sampleFluidAtPoint(world, { x: 8.5, y: 1.25, z: 8.5 });
  near(host.height, 0.5);
  near(
    host.current.x,
    1,
    "source pressure must not reverse because of host clipping"
  );
  assert.deepEqual(fluidCurrent(world, 8, 4, 8), { x: 0, y: -1, z: 0 });
});

test("falling currents descend and both bubble directions restore air only at a wet eye", (t) => {
  const { world } = fluidFixture(t, {
    base: BLOCK.STONE,
    initial: [
      [6, 1, 8, { id: BLOCK.WATER, fluid: F.WATER_FALLING }],
      [8, 1, 8, { id: BLOCK.WATER, fluid: F.BUBBLE_UP }],
      [10, 1, 8, { id: BLOCK.WATER, fluid: F.BUBBLE_DOWN }],
      [8, 2, 8, BLOCK.AIR],
    ],
  });
  assert.deepEqual(fluidCurrent(world, 6, 1, 8), { x: 0, y: -1, z: 0 });
  for (const [x, name, y] of [
    [8, "up", 1],
    [10, "down", -1],
  ]) {
    const sample = sampleFluidAtPoint(world, { x: x + 0.5, y: 1.5, z: 8.5 });
    assert.equal(sample.bubble, name);
    assert.equal(sample.restoresAir, true);
    assert.equal(sample.canBreathe, true);
    assert.equal(sample.current.y, y);
  }
  const body = sampleFluid(
    world,
    { x: 8.5, y: 1.5, z: 8.5 },
    { height: 1, eyeHeight: 0.75 }
  );
  assert.equal(body.bubble, "up");
  assert.equal(body.eyeFluid, F.NONE);
  assert.equal(
    body.restoresAir,
    false,
    "body contact does not fabricate a bubble at the eye"
  );
  assert.equal(body.canBreathe, true, "the eye is already in ordinary air");
});

test("sampling frontiers and high flight is non-generating and never treats unloaded water as known", (t) => {
  const { world } = fluidFixture(t, {
    radius: 0,
    initial: [[15, 1, 8, BLOCK.WATER]],
  });
  t.mock.method(world.generator, "generateChunk", () =>
    assert.fail("sampling cannot generate")
  );
  const unknown = sampleFluidAtPoint(world, { x: 16.1, y: 1.5, z: 8.5 });
  assert.equal(unknown.fluid, F.NONE);
  assert.equal(unknown.loaded, false);
  assert.equal(unknown.eyeLoaded, false);
  assert.equal(
    unknown.canBreathe,
    false,
    "an unloaded eye is not known breathable air"
  );
  assert.equal(
    sampleFluidAtPoint(world, { x: 8.5, y: 10000, z: 8.5 }).fluid,
    F.NONE
  );
  const edge = sampleFluid(
    world,
    { x: 15.8, y: 1, z: 8.5 },
    { height: 1, radius: 0.3 }
  );
  assert.ok(edge.immersion > 0 && edge.immersion < 0.88);
  assert.equal(edge.loaded, false);
  const touching = sampleFluid(
    world,
    { x: 15.5, y: 1, z: 8.5 },
    { height: 1, radius: 0.5 }
  );
  assert.equal(
    touching.loaded,
    true,
    "zero-volume contact with an unloaded column is not missing coverage"
  );
  assert.equal(world.chunks.size, 1);
});

test("sampling has a concrete cell bound, rejects pathological extents and clears reused output", (t) => {
  const { world } = fluidFixture(t);
  const get = world.getCell.bind(world);
  let reads = 0;
  t.mock.method(world, "getCell", (...position) => {
    reads++;
    return get(...position);
  });
  const out = createFluidSample(),
    current = out.current;
  assert.equal(
    sampleFluid(world, { x: 8.5, y: 1, z: 8.5 }, { height: 8, radius: 2 }, out),
    out
  );
  assert.ok(out.sampledCells <= MAX_FLUID_SAMPLE_CELLS);
  assert.ok(reads <= MAX_FLUID_SAMPLE_CELLS + 1);
  for (const [position, options] of [
    [{ x: 8, y: 1, z: 8 }, { height: Infinity }],
    [{ x: 8, y: 1, z: 8 }, { height: 9 }],
    [{ x: 8, y: 1, z: 8 }, { radius: 3 }],
    [{ x: 8, y: 1, z: 8 }, { radius: 0 }],
    [{ x: 8, y: 1, z: 8 }, { eyeHeight: -1 }],
    [{ x: Number.MAX_SAFE_INTEGER, y: 1, z: 8 }, { radius: 2 }],
    [{ x: 8, y: Number.MAX_SAFE_INTEGER, z: 8 }, { height: 8 }],
  ]) {
    reads = 0;
    sampleFluid(world, position, options, out);
    assert.equal(out.valid, false);
    assert.equal(out.current, current);
    assert.equal(out.fluid, F.NONE);
    assert.equal(reads, 0);
  }
});
