import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { normalizeCell } from "../src/block-state.js";
import {
  explodeBlocks,
  explosionTargets,
  findSafeLanding,
  ignitePortal,
} from "../src/world-interactions.js";
import { InteractionWorld } from "./interaction-fixture.js";

function testWorld() {
  return new InteractionWorld();
}

test("complete obsidian frames ignite in either axis across negative chunk boundaries", () => {
  for (const axis of ["x", "z"]) {
    const world = testWorld();
    for (let width = 0; width < 4; width++) {
      for (let height = 0; height < 5; height++) {
        if (width !== 0 && width !== 3 && height !== 0 && height !== 4)
          continue;
        world.set(
          -17 + (axis === "x" ? width : 0),
          20 + height,
          -17 + (axis === "z" ? width : 0),
          BLOCK.OBSIDIAN
        );
      }
    }
    assert.equal(ignitePortal(world, { x: -17, y: 22, z: -17 }), true);
    assert.equal(
      [...world.cells.values()].filter(
        (cell) => cell.id === BLOCK.NETHER_PORTAL
      ).length,
      6
    );
  }
});

test("an incomplete frame or an obstructed interior cannot create free portal blocks", () => {
  const world = testWorld();
  world.set(0, 10, 0, BLOCK.OBSIDIAN);
  assert.equal(ignitePortal(world, { x: 0, y: 10, z: 0 }), false);
  for (let x = 0; x < 4; x++) {
    for (let y = 10; y < 15; y++) {
      if (x === 0 || x === 3 || y === 10 || y === 14)
        world.set(x, y, 0, BLOCK.OBSIDIAN);
    }
  }
  world.set(1, 11, 0, BLOCK.STONE);
  assert.equal(ignitePortal(world, { x: 0, y: 10, z: 0 }), false);
});

test("explosions remove nearby terrain but preserve obsidian, fluids, bedrock and distant blocks", () => {
  const world = testWorld();
  world.set(0, 10, 0, BLOCK.DIRT);
  world.set(1, 10, 0, BLOCK.OBSIDIAN);
  world.set(0, 11, 0, BLOCK.WATER);
  world.set(20, 10, 0, BLOCK.STONE);
  world.cells.set(world.key(0, 0, 0), normalizeCell({ id: BLOCK.BEDROCK }));
  const changed = explodeBlocks(world, { x: 0.5, y: 10.5, z: 0.5 }, 3);
  assert.equal(changed.length, 1);
  assert.equal(world.get(0, 10, 0), 0);
  assert.equal(world.get(1, 10, 0), BLOCK.OBSIDIAN);
  assert.equal(world.get(0, 11, 0), BLOCK.WATER);
  assert.equal(world.get(20, 10, 0), BLOCK.STONE);
  assert.equal(world.get(0, 0, 0), BLOCK.BEDROCK);
});

test("blast candidate scans are bounded and read-only, including invalid extreme coordinates", () => {
  const world = testWorld();
  world.set(0, 10, 0, BLOCK.DIRT);
  world.set(7, 10, 0, BLOCK.DIRT);
  const before = new Map(world.cells);
  const hits = explosionTargets(world, { x: 0.5, y: 10.5, z: 0.5 }, 1e9);
  assert.deepEqual(
    hits.map(({ x, y, z }) => [x, y, z]),
    [[0, 10, 0]]
  );
  assert.deepEqual(world.cells, before);
  world.isLoaded = () =>
    assert.fail("unsafe coordinates must not enter a scan");
  for (const value of [Infinity, NaN, 1e20, -1e20, Number.MAX_SAFE_INTEGER])
    for (const axis of ["x", "y", "z"])
      assert.deepEqual(
        explosionTargets(world, { x: 0.5, y: 10.5, z: 0.5, [axis]: value }),
        []
      );
});

test("cave teleport preserves a valid underground landing instead of moving to the surface", () => {
  const world = testWorld();
  world.set(10, 10, 10, BLOCK.STONE);
  world.set(10, 50, 10, BLOCK.STONE);
  const landing = findSafeLanding(world, { x: 10, y: 11, z: 10 });
  assert.equal(landing.y, 11.01);
});

test("restoring an obstructed cave save finds nearby footing in the same cave instead of a surface canopy", () => {
  const world = testWorld();
  world.getBiome = (_x, _z, y) =>
    y <= 12
      ? { id: "deep_dark", category: "cave" }
      : y < 40
        ? { id: "lush_caves", category: "cave" }
        : { id: "forest", category: "forest" };
  for (const y of [
    4,
    ...Array.from({ length: 8 }, (_, index) => 14 + index),
    50,
  ])
    world.set(51, y, 985, BLOCK.STONE);
  const destination = { x: 51.72, y: 14, z: 985.99 };
  assert.equal(findSafeLanding(world, destination).y, 51.01);
  const before = new Map(world.cells);
  const landing = findSafeLanding(world, destination, {
    preferUnderground: true,
  });
  assert.deepEqual(landing, { x: 51.5, y: 22.01, z: 985.5 });
  assert.deepEqual(
    world.cells,
    before,
    "restoration never carves or builds a platform"
  );
  world.set(51, 24, 985, BLOCK.WATER);
  assert.deepEqual(
    findSafeLanding(world, destination, {
      preferUnderground: true,
      allowFlying: true,
    }),
    landing,
    "surface water must not pull a cave save into flight"
  );
});

test("creative void travel can fly and survival portal arrivals get a safe platform", () => {
  const world = testWorld();
  assert.equal(
    findSafeLanding(world, { x: 0, y: 40, z: 0 }, { allowFlying: true }).flying,
    true
  );
  assert.equal(world.cells.size, 0);
  const landing = findSafeLanding(world, { x: 0, y: 40, z: 0 });
  assert.equal(
    world.isSolid(
      Math.floor(landing.x),
      Math.floor(landing.y) - 1,
      Math.floor(landing.z)
    ),
    true
  );
  assert.equal(
    world.isSolid(
      Math.floor(landing.x),
      Math.floor(landing.y),
      Math.floor(landing.z)
    ),
    false
  );
});
