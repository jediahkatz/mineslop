import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK_STATE as S } from "../src/block-state.js";
import { BLOCK } from "../src/blocks.js";
import {
  isLoosePosition,
  isLooseRecord,
  MAX_LOOSE_Y,
  stepLooseEntity,
} from "../src/loose-entity.js";
import { shapeWorld } from "./shape-fixture.js";

const options = { halfSize: 0.14, footprint: 0.14 };
const entity = (patch = {}) => ({
  x: 0.5,
  y: 2,
  z: 0.5,
  vx: 0,
  vy: 0,
  vz: 0,
  ...patch,
});
const close = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`);

test("loose item/XP contacts land on negative-Y fractional support", () => {
  const world = shapeWorld([[0, -10, 0, BLOCK.OAK_SLAB]]);
  for (const halfSize of [0.14, 0.08]) {
    const drop = entity({ y: -7, vy: -18 });
    for (let i = 0; i < 4; i++)
      stepLooseEntity(world, drop, 0.1, { halfSize, footprint: halfSize });
    close(drop.y, -9.5 + halfSize);
    assert.equal(drop.vy, 0);
  }
});

test("fast loose throws sweep thin upright trapdoors without turning them into whole cubes", () => {
  const world = shapeWorld([[2, 0, 0, BLOCK.OAK_TRAPDOOR, S.OPEN | 3]]);
  const drop = entity({ y: 0.5, vx: 32 });
  assert.equal(
    stepLooseEntity(world, drop, 0.1, { ...options, gravity: 0 }),
    true
  );
  close(drop.x, 2 + 13 / 16 - options.footprint);
  assert.equal(drop.vx, 0);
  assert.ok(drop.x > 2, "the empty part of the host voxel is traversable");
});

test("enclosed drops lift to exact bed tops and preserve inventory-owned metadata", () => {
  const world = shapeWorld([[0, 0, 0, BLOCK.WHITE_BED]]);
  const data = {
    version: 1,
    name: "Saved tool",
    enchantments: [{ id: "unbreaking", level: 2 }],
  };
  const drop = entity({ y: 0.3, data, durability: [7], id: 65536, count: 1 });
  const before = structuredClone(data);
  assert.equal(isLooseRecord(drop), true);
  assert.equal(stepLooseEntity(world, drop, 0.1, options), true);
  close(drop.y, 9 / 16 + options.halfSize);
  assert.equal(drop.data, data);
  assert.deepEqual(drop.data, before);
  assert.deepEqual(drop.durability, [7]);
});

test("signed loose validation uses the entry dimension and never a build-height flight ceiling", () => {
  const world = shapeWorld();
  assert.equal(isLoosePosition(entity({ y: -32 }), world), true);
  assert.equal(
    isLoosePosition(entity({ y: -32, dimension: "end" }), world),
    false
  );
  assert.equal(
    isLoosePosition(entity({ y: -1 })),
    false,
    "legacy callers retain their old nonnegative bounds"
  );
  for (const y of [320, 29_000_000.25, MAX_LOOSE_Y])
    assert.equal(isLoosePosition(entity({ y }), world), true);
  for (const y of [-65, MAX_LOOSE_Y + 1, NaN, Infinity])
    assert.equal(isLoosePosition(entity({ y }), world), false);
});

test("high-flight loose simulation makes no out-of-build cell reads or coordinate truncations", () => {
  const world = shapeWorld();
  const getCell = world.getCell.bind(world);
  let reads = 0;
  world.getCell = (x, y, z) => {
    reads++;
    assert.ok(y >= world.spec.minY && y < world.spec.maxY);
    return getCell(x, y, z);
  };
  const drop = entity({ y: 29_000_000.25 });
  assert.equal(stepLooseEntity(world, drop, 0.1, options), true);
  assert.ok(drop.y > 29_000_000);
  assert.equal(reads, 0);
  assert.equal(isLoosePosition(drop, world), true);
});

test("an unloaded swept frontier freezes the entire loose record before shape queries", () => {
  const world = shapeWorld([], { loaded: (x) => x < 16 });
  world.getCell = () =>
    assert.fail("unloaded motion must preflight before geometry reads");
  const drop = entity({
    x: 15.5,
    vx: 32,
    pickupDelay: 2,
    data: { version: 1, name: "Keep" },
  });
  const before = structuredClone(drop);
  assert.equal(stepLooseEntity(world, drop, 0.1, options), false);
  assert.deepEqual(drop, before);
});

test("invalid loose motion and unsafe poses refuse before mutation or column traversal", () => {
  const world = shapeWorld([], {
    loaded: () => assert.fail("invalid motion cannot traverse the world"),
  });
  for (const patch of [
    { x: Infinity },
    { y: 1e100 },
    { y: -65 },
    { vx: 1e100 },
    { vy: NaN },
  ]) {
    const drop = entity({ ...patch, data: { version: 1, name: "Unchanged" } });
    const before = structuredClone(drop);
    assert.equal(stepLooseEntity(world, drop, 0.1, options), false);
    assert.deepEqual(drop, before);
  }
  for (const patch of [
    { gravity: NaN },
    { drag: Infinity },
    { footprint: -1 },
  ]) {
    const drop = entity();
    const before = structuredClone(drop);
    assert.equal(
      stepLooseEntity(world, drop, 0.1, { ...options, ...patch }),
      false
    );
    assert.deepEqual(drop, before);
  }
});
