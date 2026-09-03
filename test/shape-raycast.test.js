import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK_STATE as S } from "../src/block-state.js";
import { BLOCK } from "../src/blocks.js";
import { resolveShape } from "../src/block-shapes.js";
import { raycast } from "../src/raycast.js";
import { shapeWorld } from "./shape-fixture.js";

test("full-cube DDA keeps legacy hit fields and supplies exact point/local state", () => {
  const world = shapeWorld([[2, -20, 0, BLOCK.COPPER_BLOCK]]);
  const hit = raycast(
    world,
    { x: 0.5, y: -19.5, z: 0.5 },
    { x: 3, y: 0, z: 0 }
  );
  assert.deepEqual(
    {
      x: hit.x,
      y: hit.y,
      z: hit.z,
      id: hit.id,
      normal: hit.normal,
      distance: hit.distance,
    },
    {
      x: 2,
      y: -20,
      z: 0,
      id: BLOCK.COPPER_BLOCK,
      normal: { x: -1, y: 0, z: 0 },
      distance: 1.5,
    }
  );
  assert.deepEqual(hit.point, { x: 2, y: -19.5, z: 0.5 });
  assert.deepEqual(hit.localPoint, { x: 0, y: 0.5, z: 0.5 });
  assert.equal(hit.state, 0);
  assert.ok(Object.isFrozen(hit.box));
});

test("ray picking passes through slab/stair empty space and hits the actual tread", () => {
  const world = shapeWorld([
    [0, 0, 0, BLOCK.OAK_SLAB],
    [2, 0, 0, BLOCK.STONE],
  ]);
  const above = raycast(
    world,
    { x: -1, y: 0.75, z: 0.5 },
    { x: 1, y: 0, z: 0 }
  );
  assert.equal(above.id, BLOCK.STONE);
  const top = raycast(world, { x: 0.5, y: 2, z: 0.5 }, { x: 0, y: -1, z: 0 });
  assert.equal(top.distance, 1.5);
  assert.equal(top.point.y, 0.5);
  assert.equal(top.part, "bottom");
  assert.deepEqual(top.normal, { x: 0, y: 1, z: 0 });
  world.put(0, 0, 0, BLOCK.OAK_STAIRS);
  const low = raycast(world, { x: 0.5, y: 2, z: 0.75 }, { x: 0, y: -1, z: 0 });
  const high = raycast(world, { x: 0.5, y: 2, z: 0.25 }, { x: 0, y: -1, z: 0 });
  assert.equal(low.point.y, 0.5);
  assert.equal(high.point.y, 1);
});

test("grazing faces, inside starts, zero components and exact maximum range remain selectable", () => {
  const world = shapeWorld([[0, 0, 0, BLOCK.OAK_SLAB]]);
  const origin = { x: -1, y: 0.5, z: 0.5 };
  const direction = { x: 1, y: 0, z: 0 };
  assert.equal(raycast(world, origin, direction, 1).distance, 1);
  assert.equal(raycast(world, origin, direction, 0.999), null);
  assert.equal(raycast(world, { ...origin, y: 0.5001 }, direction), null);
  const inside = raycast(world, { x: 0.5, y: 0.25, z: 0.5 }, direction, 0);
  assert.equal(inside.distance, 0);
  assert.deepEqual(inside.normal, { x: 0, y: 0, z: 0 });
  assert.equal(raycast(world, origin, { x: 0, y: 0, z: 0 }), null);
  assert.equal(
    raycast(world, origin, { x: Number.MAX_VALUE, y: Number.MAX_VALUE, z: 0 }),
    null
  );
  assert.equal(raycast(world, origin, direction, Infinity), null);
});

test("protruding neighboring owners participate in DDA rather than only the visited voxel", () => {
  const world = shapeWorld([[0, 0, 0, BLOCK.OAK_FENCE]]);
  const origin = { x: -1, y: 1.25, z: 0.5 };
  const direction = { x: 1, y: 0, z: 0 };
  assert.equal(
    raycast(world, origin, direction),
    null,
    "fence selection follows its lower art"
  );
  const collision = raycast(world, origin, direction, 7, {
    channel: "collision",
  });
  assert.equal(collision.y, 0, "the owner is below the traversed voxel");
  assert.equal(collision.distance, 1 + 6 / 16);
  const selection = raycast(world, origin, direction, 7, {
    resolve(value, neighbors) {
      const shape = resolveShape(value, neighbors);
      return { ...shape, selection: shape.collision };
    },
  });
  assert.equal(selection.distance, collision.distance);
  assert.equal(selection.localPoint.y, 1.25);
});

test("linked door hits preserve the stored upper state and semantic part", () => {
  const world = shapeWorld([
    [0, 0, 0, BLOCK.OAK_DOOR, 0],
    [0, 1, 0, BLOCK.OAK_DOOR, S.PART | S.HINGE_RIGHT],
  ]);
  const hit = raycast(world, { x: 0.5, y: 1.5, z: -1 }, { x: 0, y: 0, z: 1 });
  assert.equal(hit.part, "upper");
  assert.equal(hit.state, S.PART | S.HINGE_RIGHT);
  assert.equal(hit.localPoint.z, 13 / 16);
  world.put(0, 0, 0, BLOCK.OAK_DOOR, S.OPEN);
  assert.equal(
    raycast(world, { x: 0.5, y: 1.5, z: -1 }, { x: 0, y: 0, z: 1 }),
    null
  );
});

test("near-world-edge selection retains sub-block precision and skips fluids", () => {
  const x = -29_000_000;
  const world = shapeWorld([
    [x, 0, 0, BLOCK.WATER],
    [x + 1, 0, 0, BLOCK.OAK_TRAPDOOR],
  ]);
  const hit = raycast(
    world,
    { x: x + 1.5, y: 2, z: 0.5 },
    { x: 0, y: -4, z: 0 }
  );
  assert.equal(hit.id, BLOCK.OAK_TRAPDOOR);
  assert.equal(hit.point.x, x + 1.5);
  assert.equal(hit.point.y, 3 / 16);
  assert.equal(
    raycast(world, { x: x + 0.5, y: 2, z: 0.5 }, { x: 0, y: -1, z: 0 }),
    null
  );
});
