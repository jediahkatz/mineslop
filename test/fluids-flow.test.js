import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import {
  BLOCK_STATE as S,
  FLUID as F,
  isSourceWater,
} from "../src/block-state.js";
import { planWaterlogging } from "../src/fluid-actions.js";
import { fluidFixture, fluidSteps, waterLine } from "./fluid-fixture.js";

const corridor = (from = 0, to = 24, y = 1, z = 8) =>
  Array.from({ length: to - from + 1 }, (_, i) => [from + i, y, z, BLOCK.AIR]);

test("authored flat flow moves one cell per five game ticks, reaches seven, and drains", (t) => {
  const { world, fluids, put } = fluidFixture(t, {
    base: BLOCK.STONE,
    initial: corridor(),
  });
  put(8, 1, 8, BLOCK.WATER);
  fluidSteps(fluids, 1);
  assert.equal(world.getFluid(9, 1, 8), F.WATER_1);
  assert.equal(
    world.getFluid(10, 1, 8),
    F.NONE,
    "same-tick queue order cannot accelerate a wave"
  );
  fluidSteps(fluids, 6);
  assert.deepEqual(waterLine(world, 8, 16), [
    F.WATER_SOURCE,
    F.WATER_1,
    F.WATER_2,
    F.WATER_3,
    F.WATER_4,
    F.WATER_5,
    F.WATER_6,
    F.WATER_7,
    F.NONE,
  ]);
  assert.equal(world.getFluid(0, 1, 8), F.NONE);
  put(8, 1, 8, BLOCK.AIR);
  fluidSteps(fluids, 1);
  assert.equal(
    isSourceWater(world.getFluid(8, 1, 8)),
    false,
    "two FLOWING neighbors do not regenerate"
  );
  fluidSteps(fluids, 48);
  assert.ok(waterLine(world, 0, 24).every((fluid) => fluid === F.NONE));
});

test("falling feeds downward before lateral spread and only spreads from its grounded bottom", (t) => {
  const initial = [
    ...corridor(1, 15),
    ...Array.from({ length: 4 }, (_, i) => [8, i + 2, 8, BLOCK.AIR]),
    [9, 3, 8, BLOCK.AIR],
  ];
  const { world, fluids, put } = fluidFixture(t, {
    base: BLOCK.STONE,
    initial,
  });
  put(8, 5, 8, BLOCK.WATER);
  fluidSteps(fluids, 1);
  assert.equal(world.getFluid(8, 4, 8), F.WATER_FALLING);
  assert.equal(world.getFluid(8, 3, 8), F.NONE);
  fluidSteps(fluids, 4);
  for (let y = 1; y <= 4; y++)
    assert.equal(world.getFluid(8, y, 8), F.WATER_FALLING);
  assert.equal(world.getFluid(9, 1, 8), F.WATER_1);
  assert.equal(world.getFluid(9, 3, 8), F.NONE);
  fluidSteps(fluids, 8);
  assert.equal(world.getFluid(15, 1, 8), F.WATER_7);
  put(8, 5, 8, BLOCK.AIR);
  fluidSteps(fluids, 64);
  for (let y = 1; y <= 5; y++) assert.equal(world.getFluid(8, y, 8), F.NONE);
  assert.ok(waterLine(world, 1, 15).every((fluid) => fluid === F.NONE));
});

for (const [name, support, regenerates] of [
  ["solid support", BLOCK.STONE, true],
  ["source below", BLOCK.WATER, true],
  ["falling below", { id: BLOCK.WATER, fluid: F.WATER_FALLING }, false],
  ["flowing below", { id: BLOCK.WATER, fluid: F.WATER_3 }, false],
  ["air below", BLOCK.AIR, false],
  ["bottom slab", { id: BLOCK.OAK_SLAB }, false],
  ["top slab", { id: BLOCK.OAK_SLAB, state: S.TOP }, true],
]) {
  test(`two horizontal sources regenerate only with valid support: ${name}`, (t) => {
    const { world, fluids, put } = fluidFixture(t, {
      base: BLOCK.STONE,
      initial: [...corridor(7, 9), [8, 0, 8, support], [8, -1, 8, BLOCK.AIR]],
    });
    put(7, 1, 8, BLOCK.WATER);
    put(9, 1, 8, BLOCK.WATER);
    fluidSteps(fluids, 1);
    assert.equal(isSourceWater(world.getFluid(8, 1, 8)), regenerates);
  });
}

test("a water source overhead is a falling feed, not a second horizontal source", (t) => {
  const { world, fluids, put } = fluidFixture(t, {
    base: BLOCK.STONE,
    initial: [...corridor(7, 9), [8, 2, 8, BLOCK.AIR]],
  });
  put(7, 1, 8, BLOCK.WATER);
  put(8, 2, 8, BLOCK.WATER);
  fluidSteps(fluids, 2);
  assert.equal(world.getFluid(8, 1, 8), F.WATER_FALLING);
});

test("reversing activation order converges to the same drained state without sources", (t) => {
  const initial = corridor(1, 17).map(([x, y, z]) => [
    x,
    y,
    z,
    { id: BLOCK.WATER, fluid: x % 2 ? F.WATER_1 : F.WATER_2 },
  ]);
  const a = fluidFixture(t, {
    base: BLOCK.STONE,
    initial,
    limits: { maxUpdatesPerTick: 32 },
  });
  const b = fluidFixture(t, {
    base: BLOCK.STONE,
    initial,
    limits: { maxUpdatesPerTick: 32 },
  });
  const positions = initial.map(([x, y, z]) => ({ x, y, z }));
  a.fluids.onMutation(positions);
  b.fluids.onMutation([...positions].reverse());
  fluidSteps(a.fluids, 256);
  fluidSteps(b.fluids, 256);
  assert.deepEqual(waterLine(a.world, 1, 17), waterLine(b.world, 1, 17));
  assert.ok(waterLine(a.world, 1, 17).every((fluid) => fluid === F.NONE));
});

test("source hosts coexist with water, emit through openings, and drain explicitly without losing the host", (t) => {
  const { world, fluids, put } = fluidFixture(t, {
    base: BLOCK.STONE,
    initial: corridor(4, 12),
  });
  put(10, 1, 8, { id: BLOCK.OAK_SLAB, state: S.TOP });
  put(8, 1, 8, { id: BLOCK.OAK_SLAB, state: S.TOP, fluid: F.WATER_SOURCE });
  fluidSteps(fluids, 12);
  assert.deepEqual(world.getCell(8, 1, 8), {
    id: BLOCK.OAK_SLAB,
    state: S.TOP,
    fluid: F.WATER_SOURCE,
  });
  assert.equal(world.getFluid(9, 1, 8), F.WATER_1);
  assert.equal(
    world.getFluid(10, 1, 8),
    F.NONE,
    "ordinary flow cannot waterlog a dry host"
  );
  assert.equal(
    world.getFluid(11, 1, 8),
    F.NONE,
    "open geometry alone does not admit flowing host water"
  );
  const plan = planWaterlogging(world, { x: 8, y: 1, z: 8 }, false);
  assert.equal(plan.ok, true);
  assert.equal(world.applyCells(plan.changes, { reads: plan.reads }), true);
  fluidSteps(fluids, 48);
  assert.deepEqual(world.getCell(8, 1, 8), {
    id: BLOCK.OAK_SLAB,
    state: S.TOP,
    fluid: F.NONE,
  });
  assert.equal(world.getFluid(9, 1, 8), F.NONE);
  assert.equal(world.get(10, 1, 8), BLOCK.OAK_SLAB);
});

test("waterlogged slab orientation uses actual open faces for downward emission", (t) => {
  const { world, fluids, put } = fluidFixture(t, {
    base: BLOCK.STONE,
    initial: [8, 10].flatMap((x) => [
      [x, 2, 8, BLOCK.AIR],
      [x, 3, 8, BLOCK.AIR],
    ]),
  });
  put(8, 3, 8, { id: BLOCK.OAK_SLAB, fluid: F.WATER_SOURCE });
  put(10, 3, 8, { id: BLOCK.OAK_SLAB, state: S.TOP, fluid: F.WATER_SOURCE });
  fluidSteps(fluids, 1);
  assert.equal(
    world.getFluid(8, 2, 8),
    F.NONE,
    "the bottom slab's solid bottom seals its water"
  );
  assert.equal(world.getFluid(10, 2, 8), F.WATER_FALLING);
});

test("bubble columns propagate through sources only, reverse and disappear after base/obstruction edits", (t) => {
  const { world, fluids, put } = fluidFixture(t, {
    base: BLOCK.STONE,
    initial: Array.from({ length: 6 }, (_, i) => [8, i + 1, 8, BLOCK.WATER]),
  });
  put(8, 0, 8, BLOCK.SOUL_SAND);
  fluidSteps(fluids, 6);
  for (let y = 1; y <= 6; y++)
    assert.equal(world.getFluid(8, y, 8), F.BUBBLE_UP);
  put(8, 0, 8, BLOCK.MAGMA_BLOCK);
  fluidSteps(fluids, 6);
  for (let y = 1; y <= 6; y++)
    assert.equal(world.getFluid(8, y, 8), F.BUBBLE_DOWN);
  put(8, 3, 8, { id: BLOCK.OAK_FENCE, fluid: F.WATER_SOURCE });
  fluidSteps(fluids, 6);
  assert.equal(world.getFluid(8, 2, 8), F.BUBBLE_DOWN);
  assert.equal(world.get(8, 3, 8), BLOCK.OAK_FENCE);
  for (let y = 4; y <= 6; y++)
    assert.equal(world.getFluid(8, y, 8), F.WATER_SOURCE);
  put(8, 3, 8, { id: BLOCK.WATER, fluid: F.WATER_1 });
  fluidSteps(fluids, 6);
  assert.equal(world.getFluid(8, 3, 8), F.WATER_FALLING);
  assert.equal(world.getFluid(8, 4, 8), F.WATER_SOURCE);
  put(8, 0, 8, BLOCK.STONE);
  fluidSteps(fluids, 6);
  for (const y of [1, 2, 4, 5, 6])
    assert.equal(world.getFluid(8, y, 8), F.WATER_SOURCE);
});

test("paused/invalid dt does no work and large dt has a four-tick catch-up bound", (t) => {
  const { world, fluids, put } = fluidFixture(t, {
    base: BLOCK.STONE,
    initial: corridor(),
  });
  put(8, 1, 8, BLOCK.WATER);
  const before = fluids.serialize();
  for (const dt of [0, -1, NaN, Infinity]) {
    assert.equal(fluids.update(dt), false);
    assert.deepEqual(fluids.serialize(), before);
    assert.equal(fluids.diagnostics().last.reads, 0);
  }
  fluids.update(0.249);
  assert.equal(world.getFluid(9, 1, 8), F.NONE);
  fluids.update(0.001);
  assert.equal(world.getFluid(9, 1, 8), F.WATER_1);
  fluids.update(1000);
  assert.equal(fluids.diagnostics().last.ticks, 4);
  assert.equal(fluids.diagnostics().last.discardedSeconds, 999);
});
