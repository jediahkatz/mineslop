import assert from "node:assert/strict";
import test from "node:test";
import {
  bodyBox,
  boxCollides,
  moveBody,
  sweepBoxAxis,
  sweepCameraDistance,
  visitWorldBoxes,
} from "../src/collision.js";
import {
  geometryWorldSpec,
  readGeometryCell,
  validBodyPosition,
} from "../src/geometry-world.js";
import { WORLD_MAX, WORLD_MIN } from "../src/terrain.js";
import { getWorldSpec } from "../src/world-spec.js";

test("geometry accepts live, archive and explicit specs without inventing End sea level", () => {
  const spec = getWorldSpec(4, "overworld");
  assert.equal(geometryWorldSpec(spec), spec);
  assert.equal(geometryWorldSpec({ spec, dimension: "overworld" }), spec);
  const context = {
    generatorVersion: 4,
    specForDimension: (dimension) => getWorldSpec(4, dimension),
  };
  assert.equal(geometryWorldSpec(context, "end").seaLevel, null);
  assert.equal(geometryWorldSpec({ generatorVersion: 4 }, "nether").maxY, 256);
  assert.equal(geometryWorldSpec(undefined).maxY, 96);
});

test("invalid, unloaded, out-of-build and high-flight cells never reach world accessors", () => {
  const world = {
    generatorVersion: 4,
    isLoaded: (x) => x < 16,
    getCell: () => assert.fail("a rejected cell read must not reach the world"),
  };
  for (const [x, y, z] of [
    [0, NaN, 0],
    [0, Infinity, 0],
    [0, 1e100, 0],
    [0.1, 0, 0],
    [0, -65, 0],
    [0, 320, 0],
    [0, 29_000_000.25, 0],
    [16, 0, 0],
    [WORLD_MIN - 1, 0, 0],
    [WORLD_MAX, 0, 0],
  ])
    assert.equal(readGeometryCell(world, x, y, z), null);
});

test("body validation retains signed and safe high flight but rejects malformed dimensions and sizes", () => {
  const world = { generatorVersion: 4, dimension: "overworld" };
  const position = { x: WORLD_MIN + 0.3, y: -64, z: WORLD_MAX - 0.3 };
  assert.equal(validBodyPosition(position, world, { radius: 0.3 }), true);
  assert.equal(
    validBodyPosition({ ...position, y: 29_000_000.25 }, world),
    true
  );
  for (const patch of [
    { x: WORLD_MIN - 1 },
    { x: WORLD_MAX },
    { y: -65 },
    { y: 1e100 },
    { y: NaN },
    { z: Infinity },
    { dimension: "unknown" },
  ])
    assert.equal(validBodyPosition({ ...position, ...patch }, world), false);
  for (const options of [{ radius: -1 }, { height: NaN }, { height: -1 }])
    assert.equal(validBodyPosition(position, world, options), false);
});

test("invalid collision/sweep inputs fail closed before cell access or unbounded traversal", () => {
  const world = {
    getCell: () => assert.fail("invalid geometry cannot read cells"),
  };
  for (const bounds of [
    null,
    [],
    [0, 0, 0, 1, 1],
    [0, 0, 0, 1, NaN, 1],
    [0, 0, 0, 1, Infinity, 1],
    [0, 2, 0, 1, 1, 1],
    [0, 1e100, 0, 1, 1e100, 1],
  ]) {
    assert.equal(boxCollides(world, bounds), true);
    assert.deepEqual(sweepBoxAxis(world, bounds, "x", 1), {
      amount: 0,
      blocked: true,
    });
    visitWorldBoxes(world, bounds, "collision", () =>
      assert.fail("invalid contact")
    );
  }
  const position = { x: 0.5, y: 1, z: 0.5 };
  const bounds = bodyBox(position);
  for (const amount of [NaN, Infinity, 1e100])
    assert.deepEqual(sweepBoxAxis(world, bounds, "y", amount), {
      amount: 0,
      blocked: true,
    });
  for (const displacement of [
    { x: 0, y: NaN, z: 0 },
    { x: 1e100, y: 0, z: 0 },
  ]) {
    const movement = moveBody(world, position, displacement);
    assert.deepEqual(movement.position, position);
    assert.deepEqual(movement.blocked, { x: true, y: true, z: true });
  }
  assert.equal(sweepCameraDistance(world, position, { x: 0, y: 0, z: 0 }), 0);
  assert.equal(
    sweepCameraDistance(world, position, { x: 1, y: 0, z: 0 }, Infinity),
    0
  );
  assert.equal(
    sweepCameraDistance(world, position, { x: 1, y: 0, z: 0 }, 4, NaN),
    0
  );
});

test("safe high-flight bodies collide with horizontal unloaded frontiers without build-height reads", () => {
  const world = {
    generatorVersion: 4,
    isLoaded: (x) => x < 16,
    getCell: () =>
      assert.fail("flight does not sample outside the build range"),
  };
  const position = { x: 15.5, y: 29_000_000.25, z: 0.5 };
  const movement = sweepBoxAxis(world, bodyBox(position), "x", 3);
  assert.ok(Math.abs(movement.amount - 0.2) < 1e-6);
  assert.equal(movement.blocked, true);
  assert.equal(boxCollides(world, bodyBox(position)), false);
});
