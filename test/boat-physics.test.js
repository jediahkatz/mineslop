import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { BLOCK_STATE, FLUID } from "../src/block-state.js";
import { BOAT_DRAFT, boatInput } from "../src/boat-definitions.js";
import {
  boatBox,
  boatWaterState,
  boatWaterTarget,
  findBoatDismount,
  stepBoat,
} from "../src/boat-physics.js";
import { bodyBox, boxCollides } from "../src/collision.js";
import { sharedAquaticSample } from "../src/vehicle-water.js";
import { aquaticWorld, physicsBoat } from "./vehicle-fishing-fixture.js";

test("placement finds real water surfaces without selecting through solid geometry", () => {
  const world = aquaticWorld();
  const eye = { x: 0.5, y: world.surface + 2, z: 0.5 };
  const target = boatWaterTarget(world, eye, { x: 0, y: -1, z: 0 });
  assert.ok(target);
  assert.ok(target.point.y <= world.surface);
  world.setCell(0, 9, 0, { id: BLOCK.STONE });
  assert.equal(boatWaterTarget(world, eye, { x: 0, y: -1, z: 0 }), null);
});

test("buoyancy settles at a draft and W thrust is independent of mouse look", () => {
  const world = aquaticWorld();
  const boat = physicsBoat(world, { y: world.surface - BOAT_DRAFT + 0.1 });
  for (let tick = 0; tick < 40; tick++)
    assert.equal(stepBoat(world, boat, 0.05).moved, true);
  assert.ok(Math.abs(boat.y - (world.surface - BOAT_DRAFT)) < 0.02);
  const a = physicsBoat(world),
    b = physicsBoat(world);
  for (let tick = 0; tick < 20; tick++) {
    stepBoat(world, a, 0.05, { forward: 1, turn: 0, mouseYaw: 2 });
    stepBoat(world, b, 0.05, { forward: 1, turn: 0, mouseYaw: -1 });
  }
  assert.deepEqual(a, b);
  assert.ok(a.z < -1);
  assert.equal(a.x, 0.5);
  assert.ok(Math.abs(a.y - (world.surface - BOAT_DRAFT)) < 0.01);
});

test("A/D rotates the hull and reverse thrust does not turn the camera", () => {
  const world = aquaticWorld();
  const boat = physicsBoat(world);
  const input = boatInput(new Set(["KeyW", "KeyA"]));
  for (let tick = 0; tick < 16; tick++) stepBoat(world, boat, 0.05, input);
  assert.ok(boat.yaw > 0.2 && boat.x < 0.5);
  const reverse = physicsBoat(world);
  for (let tick = 0; tick < 10; tick++)
    stepBoat(world, reverse, 0.05, boatInput(new Set(["KeyS"])));
  assert.ok(reverse.z > 0.5);
  assert.equal(reverse.yaw, 0);
  assert.equal(boatInput(new Set(["ShiftLeft"])).dismount, true);
});

test("hull sweeps use fractional slabs and raised fence collision, without step-up", () => {
  for (const [cell, maximum, clears] of [
    [{ id: BLOCK.OAK_SLAB, fluid: FLUID.WATER_SOURCE }, Infinity, true],
    [
      { id: BLOCK.OAK_SLAB, state: BLOCK_STATE.TOP, fluid: FLUID.WATER_SOURCE },
      1.312501,
      false,
    ],
    [{ id: BLOCK.OAK_FENCE, fluid: FLUID.WATER_SOURCE }, 1.687501, false],
  ]) {
    const world = aquaticWorld();
    for (let z = -1; z <= 1; z++) world.setCell(2, 8, z, cell);
    const boat = physicsBoat(world, { vx: 6 });
    const y = boat.y;
    for (let tick = 0; tick < 12; tick++) stepBoat(world, boat, 0.05);
    assert.equal(boxCollides(world, boatBox(boat)), false);
    assert.ok(boat.x <= maximum);
    if (clears)
      assert.ok(
        boat.x > 1.7,
        "the empty upper half of a bottom slab remains traversable"
      );
    else
      assert.ok(Math.abs(boat.y - y) < 0.01, "boats never use player step-up");
  }
});

test("ascending source-water edges do not lift or pull a boat uphill", () => {
  const world = aquaticWorld();
  for (let x = 2; x <= 5; x++)
    for (let z = -2; z <= 2; z++) world.setCell(x, 9, z, { id: BLOCK.WATER });
  const boat = physicsBoat(world, { yaw: -Math.PI / 2 });
  const y = boat.y;
  for (let tick = 0; tick < 30; tick++)
    stepBoat(world, boat, 0.05, { forward: 1 });
  assert.ok(boat.x < 2);
  assert.ok(Math.abs(boat.y - y) < 0.01);
});

test("an injected canonical current advects a stationary boat", () => {
  const world = aquaticWorld();
  const boat = physicsBoat(world);
  const sampleFluid = (world, point) => {
    const sample = sharedAquaticSample(world, point);
    return sample && { ...sample, current: { x: 1, y: 0, z: 0 } };
  };
  for (let tick = 0; tick < 20; tick++)
    stepBoat(world, boat, 0.05, {}, { sampleFluid });
  assert.ok(boat.x > 0.75);
  assert.ok(Math.abs(boat.z - 0.5) < 0.001);
});

test("bubble launches and prolonged submersion have explicit ejection signals", () => {
  const world = aquaticWorld();
  for (let x = -1; x <= 1; x++)
    for (let z = -1; z <= 1; z++)
      for (let y = 5; y <= 8; y++)
        world.setCell(x, y, z, { id: BLOCK.WATER, fluid: FLUID.BUBBLE_UP });
  const boat = physicsBoat(world);
  assert.equal(boatWaterState(world, boat).bubble, 1);
  let launched = false;
  for (let tick = 0; tick < 65; tick++)
    launched ||= stepBoat(world, boat, 0.05).bubbleImpulse === 1;
  assert.equal(launched, true);
  const deep = aquaticWorld({ waterTop: 12, floor: -20 });
  const submerged = physicsBoat(deep, { y: 8, passengers: ["player", null] });
  let eject = false;
  for (let tick = 0; tick < 65; tick++)
    eject ||= stepBoat(deep, submerged, 0.05).eject === true;
  assert.equal(eject, true);
  assert.ok(submerged.y < 8);
});

test("unavailable frontiers freeze motion and clocks instead of generating", () => {
  const world = aquaticWorld();
  const boat = physicsBoat(world, { vx: 4, bubbleTime: 1.5, submergedTime: 1 });
  world.loaded = (x) => x < 2;
  const before = structuredClone(boat);
  assert.equal(stepBoat(world, boat, 0.05, { forward: 1 }).reason, "frontier");
  assert.deepEqual(boat, before);
});

test("open-ocean dismount is a swimming pose with no fabricated platform", () => {
  const world = aquaticWorld();
  const boat = physicsBoat(world, { passengers: ["player", null] });
  const exit = findBoatDismount(world, boat, { otherBoats: [boat] });
  assert.ok(exit);
  assert.equal(exit.swimming, true);
  assert.equal(exit.grounded, false);
  assert.equal(world.cells.size, 0);
  assert.equal(boxCollides(world, boatBox(boat)), false);
  world.loaded = () => false;
  assert.equal(findBoatDismount(world, boat), null);
});

test("dismount clears a raised bank lip using actual support and swept headroom", () => {
  const world = aquaticWorld();
  world.setCell(2, 8, 0, { id: BLOCK.STONE });
  const boat = physicsBoat(world, { x: 0.9, passengers: ["player", null] });
  assert.equal(boxCollides(world, boatBox(boat, true)), false);
  const exit = findBoatDismount(world, boat, { otherBoats: [boat] });
  assert.ok(exit);
  assert.equal(exit.grounded, true);
  assert.equal(exit.swimming, false);
  assert.ok(exit.position.x > 2 && Math.abs(exit.position.y - 9.001) < 0.001);
  assert.equal(boxCollides(world, bodyBox(exit.position)), false);
  assert.equal(world.cells.size, 1);

  world.setCell(2, 10, 0, { id: BLOCK.STONE });
  const lowerExit = findBoatDismount(world, boat, { otherBoats: [boat] });
  assert.ok(lowerExit);
  assert.equal(
    lowerExit.swimming,
    true,
    "a low roof must not be bypassed to stand on the bank"
  );
});

test("a fence enclosure refuses dismount without moving the rider or fabricating support", () => {
  const world = aquaticWorld();
  for (let x = -1; x <= 1; x++)
    for (let z = -1; z <= 1; z++)
      if (x !== 0 || z !== 0)
        world.setCell(x, 8, z, {
          id: BLOCK.OAK_FENCE,
          fluid: FLUID.WATER_SOURCE,
        });
  const boat = physicsBoat(world, { passengers: ["player", null] });
  const before = structuredClone(boat);
  assert.equal(boxCollides(world, boatBox(boat, true)), false);
  assert.equal(findBoatDismount(world, boat, { otherBoats: [boat] }), null);
  assert.deepEqual(boat, before);
  assert.equal(world.cells.size, 8);
});
