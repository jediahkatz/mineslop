import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { FLUID } from "../src/block-state.js";
import { PLAYER_FLUID_PHYSICS } from "../src/player.js";
import { controlFixture, dispatch } from "./control-fixture.js";
import { closePoint } from "./dolphin-swim-fixture.js";
import { shapeWorld } from "./shape-fixture.js";

function swimmer(t, { water = true, position = { x: 0.5, y: 2, z: 0.5 }, fluid = FLUID.WATER_SOURCE } = {}) {
  const f = controlFixture(t);
  const cells = [];
  for (let x = -3; x <= 3; x++)
    for (let z = -3; z <= 3; z++)
      for (let y = 0; y <= (water ? 6 : 0); y++)
        cells.push([x, y, z, y === 0 ? BLOCK.STONE : BLOCK.WATER, 0, y === 0 ? FLUID.NONE : fluid]);
  f.player.world = shapeWorld(cells);
  f.player.allowFlight = false;
  f.player.setPosition(position);
  f.press = (code) => dispatch(f.document, "keydown", { code, timeStamp: 1000 });
  return f;
}

test("Player bounds and validates the transient swim multiplier without coercion", (t) => {
  const f = swimmer(t);
  f.press("KeyW");
  f.player.update(0.1);
  const normal = f.player.position.clone();
  for (const value of [
    undefined, null, false, true, "1.6", NaN, Infinity, -Infinity, -1, 0, 0.9,
    1.600001, Number.MAX_VALUE, [], {}, { valueOf() { assert.fail("no coercion"); } },
  ]) {
    f.player.setPosition({ x: 0.5, y: 2, z: 0.5 });
    f.player.update(0.1, { swimSpeedMultiplier: value });
    closePoint(f.player.position, normal);
  }
  f.player.setPosition({ x: 0.5, y: 2, z: 0.5 });
  f.player.update(0.1, { swimSpeedMultiplier: 1.6 });
  assert.ok(f.player.position.z < normal.z);
  f.player.setPosition({ x: 0.5, y: 2, z: 0.5 });
  f.player.update(0.1);
  closePoint(f.player.position, normal, "omitted assistance cannot persist");
  assert.equal(Object.hasOwn(f.player, "swimSpeedMultiplier"), false);
});

for (const kind of ["land", "shallow wading", "Creative flight", "ladder"]) {
  test(`swim assistance does not accelerate ${kind}`, (t) => {
    const plain = swimmer(t, { water: kind !== "land" });
    const boosted = swimmer(t, { water: kind !== "land" });
    for (const f of [plain, boosted]) {
      if (kind === "shallow wading") f.player.setPosition({ x: 0.5, y: 6.75, z: 0.5 });
      if (kind === "Creative flight") {
        f.player.allowFlight = true;
        f.player.flying = true;
        f.press("Space");
      }
      if (kind === "ladder") {
        f.player.world.put(0, 2, 0, BLOCK.LADDER);
        f.player.world.put(0, 3, 0, BLOCK.LADDER);
        f.player.world.put(0, 2, 1, BLOCK.STONE);
        f.player.world.put(0, 3, 1, BLOCK.STONE);
        f.player.setPosition({ x: 0.5, y: 2, z: 0.65 });
      }
      f.press("KeyW");
    }
    plain.player.update(0.1);
    boosted.player.update(0.1, { swimSpeedMultiplier: 1.6 });
    if (kind === "shallow wading")
      assert.ok(boosted.player.fluidState.waterImmersion < PLAYER_FLUID_PHYSICS.swimImmersion);
    if (kind === "ladder") assert.equal(boosted.player.climbing, true);
    closePoint(boosted.player.position, plain.player.position);
    closePoint(boosted.player.velocity, plain.player.velocity);
  });
}

for (const fluid of [FLUID.WATER_SOURCE, FLUID.WATER_FALLING, FLUID.BUBBLE_UP, FLUID.BUBBLE_DOWN]) {
  test(`vertical ascent and idle current/bubble forces are unchanged for fluid ${fluid}`, (t) => {
    const plain = swimmer(t, { fluid }), boosted = swimmer(t, { fluid });
    for (const f of [plain, boosted]) f.press("Space");
    plain.player.update(0.1);
    boosted.player.update(0.1, { swimSpeedMultiplier: 1.6 });
    closePoint(boosted.player.position, plain.player.position);
    closePoint(boosted.player.velocity, plain.player.velocity);
  });
}

test("a real lateral fluid gradient pushes idle swimmers equally with and without assistance", (t) => {
  const plain = controlFixture(t), boosted = controlFixture(t);
  for (const f of [plain, boosted]) {
    f.player.world = shapeWorld([
      [0, 0, 0, BLOCK.STONE], [-1, 1, 0, BLOCK.STONE],
      [0, 1, 0, BLOCK.WATER], [1, 1, 0, BLOCK.WATER, 0, FLUID.WATER_4],
      [2, 1, 0, BLOCK.WATER, 0, FLUID.WATER_7],
      ...[-1, 1].flatMap((z) => [-1, 0, 1, 2, 3].map((x) => [x, 1, z, BLOCK.STONE])),
    ]);
    f.player.allowFlight = false;
    f.player.setPosition({ x: 0.5, y: 1, z: 0.5 });
    assert.ok(f.player.fluidState.current.x > 0.9);
  }
  plain.player.update(0.1);
  boosted.player.update(0.1, { swimSpeedMultiplier: 1.6 });
  assert.ok(plain.player.position.x > 0.5);
  closePoint(boosted.player.position, plain.player.position);
});

test("swimming displacement is stable under exact substep dt partitions", (t) => {
  const whole = swimmer(t), split = swimmer(t);
  for (const f of [whole, split]) f.press("KeyW");
  whole.player.update(0.1, { swimSpeedMultiplier: 1.6 });
  for (let i = 0; i < 12; i++) split.player.update(1 / 120, { swimSpeedMultiplier: 1.6 });
  closePoint(whole.player.position, split.player.position);
  closePoint(whole.player.velocity, split.player.velocity);
});

test("a water exit inside one update rechecks swimming at every collision substep", (t) => {
  const whole = swimmer(t, { position: { x: 0.5, y: 6.84, z: 0.5 } });
  const split = swimmer(t, { position: { x: 0.5, y: 6.84, z: 0.5 } });
  for (const f of [whole, split]) {
    f.player.velocity.y = 3.4;
    f.press("KeyW");
    f.press("Space");
  }
  assert.ok(whole.player.fluidState.waterImmersion > 0);
  whole.player.update(0.1, { swimSpeedMultiplier: 1.6 });
  let drySteps = 0;
  for (let i = 0; i < 12; i++) {
    const wet = split.player.sampleFluids().waterImmersion > 0;
    if (!wet) drySteps++;
    split.player.update(1 / 120, { swimSpeedMultiplier: wet ? 1.6 : 1 });
  }
  assert.ok(drySteps > 0);
  assert.equal(whole.player.fluidState.waterImmersion, 0);
  closePoint(whole.player.position, split.player.position);
  closePoint(whole.player.velocity, split.player.velocity);
});

for (const vehicleType of ["boat", "horse"]) {
  test(`${vehicleType} pose handoffs and seated updates ignore swim assistance`, (t) => {
    const plain = swimmer(t), boosted = swimmer(t);
    const riderPose = {
      position: { x: 0.5, y: 2, z: 0.5 }, velocity: { x: 0.2, y: 0.3, z: -0.4 },
      seated: true, grounded: false, vehicleType, dimension: "overworld",
    };
    assert.equal(plain.player.update(0.1, { riderPose }), true);
    assert.equal(boosted.player.update(0.1, { riderPose, swimSpeedMultiplier: 1.6 }), true);
    plain.press("KeyW");
    boosted.press("KeyW");
    plain.player.update(0.1);
    boosted.player.update(0.1, { swimSpeedMultiplier: 1.6 });
    closePoint(boosted.player.position, riderPose.position);
    closePoint(boosted.player.velocity, riderPose.velocity);
    closePoint(boosted.player.position, plain.player.position);
  });
}
