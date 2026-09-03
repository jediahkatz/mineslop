import assert from "node:assert/strict";
import test from "node:test";
import {
  collidesWithWorld,
  intersectsBlock,
  moveWithCollisions,
} from "../src/player.js";
import { WORLD_HEIGHT, WORLD_MAX, WORLD_MIN } from "../src/terrain.js";

const emptyWorld = { isSolid: () => false };
const floorWorld = { isSolid: (_x, y) => y === 0 };
const closeTo = (actual, expected) =>
  assert.ok(
    Math.abs(actual - expected) < 0.00001,
    `${actual} should equal ${expected}`
  );

test("placement exclusion uses feet, full body height, and a 0.6-wide body", () => {
  const feet = { x: 0.5, y: 1, z: 0.5 };
  assert.equal(intersectsBlock(feet, 0, 1, 0), true);
  assert.equal(intersectsBlock(feet, 0, 2, 0), true);
  assert.equal(intersectsBlock(feet, 0, 0, 0), false);
  assert.equal(intersectsBlock(feet, 0, 3, 0), false);
  assert.equal(intersectsBlock(feet, 1, 1, 0), false);
  assert.equal(intersectsBlock({ ...feet, x: 0.8 }, 1, 1, 0), true);
});

test("touching surfaces are not penetrating", () => {
  assert.equal(collidesWithWorld(floorWorld, { x: 0, y: 1, z: 0 }), false);
  assert.equal(collidesWithWorld(floorWorld, { x: 0, y: 0.99, z: 0 }), true);
  assert.equal(intersectsBlock({ x: 0.7, y: 1, z: 0.5 }, 1, 1, 0), false);
});

test("free movement preserves the original position argument", () => {
  const original = { x: 0, y: 10, z: 0 };
  const result = moveWithCollisions(emptyWorld, original, {
    x: 2,
    y: 3,
    z: -4,
  });
  assert.deepEqual(original, { x: 0, y: 10, z: 0 });
  closeTo(result.position.x, 2);
  closeTo(result.position.y, 13);
  closeTo(result.position.z, -4);
  assert.deepEqual(result.blocked, { x: false, y: false, z: false });
});

test("fast falling cannot tunnel through a single-block floor", () => {
  const result = moveWithCollisions(
    floorWorld,
    { x: 0.5, y: 10, z: 0.5 },
    { x: 0, y: -25, z: 0 }
  );
  closeTo(result.position.y, 1);
  assert.equal(result.grounded, true);
  assert.equal(result.blocked.y, true);
});

test("fast horizontal motion cannot tunnel through a wall", () => {
  const world = { isSolid: (x) => x === 2 };
  const result = moveWithCollisions(
    world,
    { x: 0, y: 3, z: 0 },
    { x: 30, y: 0, z: 0 }
  );
  closeTo(result.position.x, 1.7);
  assert.equal(result.blocked.x, true);
  assert.equal(collidesWithWorld(world, result.position), false);
});

test("diagonal movement slides along a wall without stopping the free axis", () => {
  const world = { isSolid: (x) => x === 1 };
  const result = moveWithCollisions(
    world,
    { x: 0.5, y: 2, z: 0 },
    { x: 3, y: 0, z: -3 }
  );
  closeTo(result.position.x, 0.7);
  closeTo(result.position.z, -3);
  assert.deepEqual(result.blocked, { x: true, y: false, z: false });
});

test("head collision stops upward movement without reporting grounded", () => {
  const world = { isSolid: (_x, y) => y === 5 };
  const result = moveWithCollisions(
    world,
    { x: 0.5, y: 1, z: 0.5 },
    { x: 0, y: 15, z: 0 }
  );
  closeTo(result.position.y, 3.2);
  assert.equal(result.blocked.y, true);
  assert.equal(result.grounded, false);
});

test("negative-direction walls respect player width", () => {
  const world = { isSolid: (x, _y, z) => x === -2 || z === -2 };
  const result = moveWithCollisions(
    world,
    { x: 0, y: 5, z: 0 },
    { x: -10, y: 0, z: -10 }
  );
  closeTo(result.position.x, -0.7);
  closeTo(result.position.z, -0.7);
  assert.equal(result.blocked.x, true);
  assert.equal(result.blocked.z, true);
});

test("exploration crosses the old 80-block boundary without an invisible wall", () => {
  const positive = moveWithCollisions(
    emptyWorld,
    { x: 79, y: 80, z: 79 },
    { x: 5, y: 0, z: 5 }
  );
  closeTo(positive.position.x, 84);
  closeTo(positive.position.z, 84);
  const negative = moveWithCollisions(
    emptyWorld,
    { x: -79, y: 80, z: -79 },
    { x: -5, y: 0, z: -5 }
  );
  closeTo(negative.position.x, -84);
  closeTo(negative.position.z, -84);
});

test("remote world-coordinate safety bounds still respect body width", () => {
  const positive = moveWithCollisions(
    emptyWorld,
    { x: WORLD_MAX - 1, y: 120, z: 0 },
    { x: 5, y: 0, z: 0 }
  );
  closeTo(positive.position.x, WORLD_MAX - 0.3);
  const negative = moveWithCollisions(
    emptyWorld,
    { x: WORLD_MIN + 1, y: 120, z: 0 },
    { x: -5, y: 0, z: 0 }
  );
  closeTo(negative.position.x, WORLD_MIN + 0.3);
});

test("unloaded chunks block movement until their terrain arrives", () => {
  let loaded = false;
  const world = { isSolid: () => false, isLoaded: (x) => x < 16 || loaded };
  const before = moveWithCollisions(
    world,
    { x: 15, y: 20, z: 0 },
    { x: 5, y: 0, z: 0 }
  );
  closeTo(before.position.x, 15.7);
  loaded = true;
  const after = moveWithCollisions(world, before.position, {
    x: 5,
    y: 0,
    z: 0,
  });
  closeTo(after.position.x, 20.7);
});

test("the build ceiling does not prevent flying above terrain", () => {
  const world = { isSolid: () => true };
  const result = moveWithCollisions(
    world,
    { x: 0, y: WORLD_HEIGHT, z: 0 },
    { x: 0, y: 20, z: 0 }
  );
  closeTo(result.position.y, WORLD_HEIGHT + 20);
  assert.equal(result.blocked.y, false);
});
