import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import {
  ANIMAL_NAVIGATION_LIMITS,
  animalRouteClear,
  createAnimalNavigation,
  groundAt,
  stepAnimalNavigation,
} from "../src/mob-navigation.js";
import { animalMob, flatWorld } from "./animal-behavior-fixture.js";

const intent = (yaw = 0, speed = 1) => ({ mode: "roam", yaw, speed });

test("route probes reject partial progress without modifying the real animal", () => {
  const world = flatWorld();
  const mob = animalMob("rabbit");
  const original = mob.position.clone();
  assert.equal(animalRouteClear(world, mob, Math.PI / 2, 1.6), true);
  for (let y = 9; y < 13; y++) world.edits.set(`2,${y},0`, BLOCK.STONE);
  assert.equal(animalRouteClear(world, mob, Math.PI / 2, 1.6), false);
  assert.deepEqual(mob.position, original);
  assert.equal(mob.groundY, 9);
});

test("an enclosed animal rests between bounded probes instead of shuffling every frame", () => {
  const world = flatWorld();
  const mob = animalMob("rabbit");
  for (let y = 9; y < 13; y++) {
    for (let coordinate = -1; coordinate <= 1; coordinate++) {
      world.edits.set(`-1,${y},${coordinate}`, BLOCK.STONE);
      world.edits.set(`1,${y},${coordinate}`, BLOCK.STONE);
      world.edits.set(`${coordinate},${y},-1`, BLOCK.STONE);
      world.edits.set(`${coordinate},${y},1`, BLOCK.STONE);
    }
  }
  const navigation = createAnimalNavigation();
  const initial = mob.position.clone();
  const first = stepAnimalNavigation(world, mob, navigation, intent(), 0.05);
  assert.equal(first.blocked, true);
  assert.equal(first.probes, ANIMAL_NAVIGATION_LIMITS.directions);
  for (let frame = 0; frame < 7; frame++) {
    const next = stepAnimalNavigation(world, mob, navigation, intent(), 0.1);
    assert.equal(next.probes, 0);
    assert.equal(next.moved, false);
  }
  assert.deepEqual(mob.position, initial);
  assert.equal(mob.root.rotation.y, 0);
  assert.equal(mob.moving, false);
  let retries = 0;
  for (let frame = 0; frame < 40; frame++) {
    const next = stepAnimalNavigation(world, mob, navigation, intent(), 0.1);
    assert.ok(next.probes <= ANIMAL_NAVIGATION_LIMITS.directions);
    retries += next.probes > 0 ? 1 : 0;
  }
  assert.ok(retries > 0 && retries < 10);
  assert.deepEqual(mob.position, initial);
});

test("animals turn before advancing and keep a selected wall detour", () => {
  const world = flatWorld();
  const mob = animalMob("rabbit", { x: 1.25, y: 9, z: 0.5 });
  for (let y = 9; y < 13; y++)
    for (let z = -4; z <= 4; z++) world.edits.set(`2,${y},${z}`, BLOCK.STONE);
  const navigation = createAnimalNavigation();
  const initial = mob.position.clone();
  const first = stepAnimalNavigation(world, mob, navigation, intent(Math.PI / 2), 0.05);
  assert.equal(first.moved, false);
  assert.ok(first.probes > 1);
  assert.notEqual(navigation.yaw, Math.PI / 2);
  const route = navigation.yaw;
  for (let frame = 0; frame < 8; frame++)
    stepAnimalNavigation(world, mob, navigation, intent(Math.PI / 2), 0.05);
  assert.equal(navigation.yaw, route);
  assert.deepEqual(mob.position, initial, "a half-turn does not translate sideways first");
});

test("animal routes avoid magma, water, cliffs and low ceilings", () => {
  for (const obstacle of ["magma", "water", "ceiling", "cliff"]) {
    const world = flatWorld({
      terrain: (x) => obstacle === "cliff" && x >= 1 ? 2 : 8,
    });
    const mob = animalMob("rabbit");
    if (obstacle === "magma") world.edits.set("1,8,0", BLOCK.MAGMA_BLOCK);
    if (obstacle === "water") world.edits.set("1,9,0", BLOCK.WATER);
    if (obstacle === "ceiling") world.edits.set("1,10,0", BLOCK.STONE);
    assert.equal(animalRouteClear(world, mob, Math.PI / 2, 1.2), false, obstacle);
    if (obstacle === "magma") {
      assert.equal(groundAt(world, 1.5, 0.5, mob.spec, { nearY: 9 }), 9);
      assert.equal(groundAt(world, 1.5, 0.5, mob.spec, {
        nearY: 9, avoidHazards: true,
      }), null);
    }
  }
});

test("navigation never reads unloaded positive or negative chunk seams", () => {
  for (const boundary of [0, 16]) {
    const world = flatWorld({ loaded: (x) => x < boundary });
    const mob = animalMob("rabbit", { x: boundary - 0.5, y: 9, z: 0.5 });
    assert.equal(animalRouteClear(world, mob, Math.PI / 2, 1.6), false);
    const navigation = createAnimalNavigation();
    for (let frame = 0; frame < 8; frame++)
      stepAnimalNavigation(world, mob, navigation, intent(Math.PI / 2), 0.1);
    assert.ok(mob.position.x + mob.spec.radius < boundary);
    assert.equal(world.unloadedReads, 0);
  }
});

test("large deltas and speeds cannot exceed bounded travel or probe work", () => {
  const world = flatWorld();
  const mob = animalMob("rabbit");
  const navigation = createAnimalNavigation();
  const initial = mob.position.clone();
  const result = stepAnimalNavigation(world, mob, navigation, intent(0, 100), 100);
  assert.ok(result.probes <= ANIMAL_NAVIGATION_LIMITS.directions);
  assert.ok(mob.position.distanceTo(initial) <=
    ANIMAL_NAVIGATION_LIMITS.maxSpeed * ANIMAL_NAVIGATION_LIMITS.step + 1e-9);
  for (const dt of [0, -1, NaN, Infinity]) {
    const before = mob.position.clone();
    assert.equal(stepAnimalNavigation(world, mob, navigation, intent(), dt).probes, 0);
    assert.deepEqual(mob.position, before);
  }
});
