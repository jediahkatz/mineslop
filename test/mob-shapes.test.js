import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { FLUID } from "../src/block-state.js";
import { BLOCK } from "../src/blocks.js";
import {
  applyGravity,
  canOccupy,
  groundAt,
  hasLineOfSight,
  insideWorld,
  moveMob,
  waterHome,
} from "../src/mob-navigation.js";
import { shapeWorld } from "./shape-fixture.js";

const spec = { radius: 0.2, height: 0.8, stepHeight: 0.6 };
const close = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`);

test("mob ground search returns signed slab/bed heights, not integer top+1", () => {
  for (const [id, height] of [
    [BLOCK.OAK_SLAB, 0.5],
    [BLOCK.WHITE_BED, 9 / 16],
  ]) {
    const world = shapeWorld([[0, -10, 0, id]]);
    close(groundAt(world, 0.5, 0.5, spec), -10 + height);
    assert.equal(canOccupy(world, 0.5, -10 + height, 0.5, spec), true);
    assert.equal(canOccupy(world, 0.5, -10 + height - 0.01, 0.5, spec), false);
    assert.equal(insideWorld({ x: 0.5, y: -10 + height, z: 0.5 }, world), true);
  }
});

test("mob movement and gravity use exact fractional contacts and whole-footprint support", () => {
  const world = shapeWorld([
    [0, -1, 0, BLOCK.STONE],
    [1, -1, 0, BLOCK.STONE],
    [1, 0, 0, BLOCK.OAK_SLAB],
  ]);
  const entity = {
    spec,
    position: new THREE.Vector3(0.5, 0, 0.5),
    groundY: 0,
    velocityY: 0,
  };
  assert.equal(moveMob(world, entity, 1, 0), true);
  close(entity.position.x, 1.5);
  close(entity.position.y, 0.5);
  close(entity.groundY, 0.5);
  entity.position.y = 2;
  assert.equal(applyGravity(world, entity, 1), true);
  close(entity.position.y, 0.5);
  assert.equal(entity.velocityY, 0);
  assert.equal(
    groundAt(world, 1.95, 0.5, spec, { nearY: 0.5 }),
    null,
    "a tiny supported corner cannot bridge a cliff"
  );
});

test("mob sight crosses empty slab/stair regions, but solid treads and unloaded seams block it", () => {
  const world = shapeWorld([[0, 0, 0, BLOCK.OAK_SLAB]]);
  const from = { x: -1, y: 0.75, z: 0.5 },
    to = { x: 2, y: 0.75, z: 0.5 };
  assert.equal(hasLineOfSight(world, from, to), true);
  assert.equal(
    hasLineOfSight(world, { ...from, y: 0.25 }, { ...to, y: 0.25 }),
    false
  );
  world.put(0, 0, 0, BLOCK.OAK_STAIRS);
  assert.equal(
    hasLineOfSight(world, { ...from, z: 0.75 }, { ...to, z: 0.75 }),
    true
  );
  assert.equal(
    hasLineOfSight(world, { ...from, z: 0.25 }, { ...to, z: 0.25 }),
    false
  );
  const seam = shapeWorld([], { loaded: (x) => x < 1 });
  assert.equal(hasLineOfSight(seam, from, to), false);
});

test("aquatic occupancy tests actual water volume, including signed waterlogged cavities", () => {
  const fish = { radius: 0.1, height: 0.2, minWaterDepth: 2 };
  const waterlogged = shapeWorld([
    [0, -8, 0, BLOCK.OAK_SLAB, 0, FLUID.WATER_SOURCE],
  ]);
  assert.equal(canOccupy(waterlogged, 0.5, -7.45, 0.5, fish, true), true);
  assert.equal(canOccupy(waterlogged, 0.5, -7.7, 0.5, fish, true), false);
  assert.equal(canOccupy(waterlogged, 0.5, -7.15, 0.5, fish, true), false);
  const deep = shapeWorld([
    [0, -9, 0, BLOCK.WATER],
    [0, -8, 0, BLOCK.WATER],
    [0, -7, 0, BLOCK.WATER],
  ]);
  const home = waterHome(deep, 0.5, 0.5, fish);
  assert.ok(home < 0);
  assert.equal(canOccupy(deep, 0.5, home, 0.5, fish, true), true);
});
