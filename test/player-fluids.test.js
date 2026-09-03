import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK } from "../src/blocks.js";
import { FLUID as F, BLOCK_STATE as S } from "../src/block-state.js";
import { fluidAtPoint } from "../src/collision.js";
import { sampleFluid, sampleFluidAtPoint } from "../src/fluid-sampling.js";
import {
  EYE_HEIGHT,
  PLAYER_FLUID_PHYSICS,
  PLAYER_HEIGHT,
  SNEAK_EYE_HEIGHT,
} from "../src/player.js";
import { controlFixture, dispatch } from "./control-fixture.js";
import { shapeWorld } from "./shape-fixture.js";

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
const press = (f, code) =>
  dispatch(f.document, "keydown", {
    code,
    timeStamp: 1000,
    target: f.element,
  });
const floor = () => {
  const entries = [];
  for (let x = -3; x <= 4; x++)
    for (let z = -3; z <= 4; z++) entries.push([x, 0, z, BLOCK.STONE]);
  return entries;
};
function playerFixture(
  t,
  entries,
  position = { x: 0.5, y: 1, z: 0.5 },
  options
) {
  const f = controlFixture(t);
  const world = shapeWorld(entries, options);
  world.getSpawn = () =>
    assert.fail("fluid queries and ordinary physics cannot generate a spawn");
  f.player.world = world;
  f.player.allowFlight = false;
  f.player.setPosition(position);
  return { ...f, world };
}
const column = (fluid) => [
  ...floor(),
  ...Array.from({ length: 5 }, (_, i) => [0, i + 1, 0, BLOCK.WATER, 0, fluid]),
];

test("Player samples resolved body volume and physical eye instead of a center-point/block-ID water heuristic", (t) => {
  const f = playerFixture(
    t,
    [...floor(), [0, 1, 0, BLOCK.OAK_SLAB, 0, F.WATER_SOURCE]],
    { x: 0.5, y: 1.5, z: 0.5 }
  );
  const state = f.player.fluidState,
    current = state.current;
  assert.equal(f.world.get(0, 1, 0), BLOCK.OAK_SLAB);
  assert.ok(f.player.sampleFluids().waterImmersion > 0);
  assert.deepEqual(
    state,
    sampleFluid(f.world, f.player.position, {
      height: PLAYER_HEIGHT,
      eyeHeight: EYE_HEIGHT,
      radius: 0.3,
    })
  );
  assert.equal(f.player.gameplayEnvironment().inWater, true);
  assert.equal(f.player.gameplayEnvironment().underwater, false);
  f.world.put(0, 1, 0, BLOCK.OAK_SLAB, S.TOP, F.WATER_SOURCE);
  f.player.setPosition({ x: 0.5, y: 2, z: 0.5 });
  assert.equal(
    f.player.sampleFluids().waterImmersion,
    0,
    "water is not inside the solid top half"
  );
  assert.equal(f.player.fluidState, state);
  assert.equal(f.player.fluidState.current, current);

  f.world.put(0, 1, 0, BLOCK.WATER);
  f.player.setPosition({ x: 0.5, y: 1, z: 0.5 });
  assert.equal(fluidAtPoint(f.world, { x: 0.5, y: 1.9, z: 0.5 }), F.NONE);
  assert.ok(
    f.player.sampleFluids().waterImmersion > 0.45,
    "the real body is wet even when the old feet+0.9 point lies above the surface"
  );
});

test("flowing-height and bubble eye projections use exact volumes and never mutate vitals", (t) => {
  const f = playerFixture(t, [[0, 1, 0, BLOCK.WATER, 0, F.WATER_7]], {
    x: 0.5,
    y: 0,
    z: 0.5,
  });
  const out = {};
  assert.equal(f.player.gameplayEnvironment(out), out);
  assert.equal(out.inWater, true);
  assert.equal(
    out.underwater,
    false,
    "WATER block ID alone is not eye submersion"
  );
  assert.equal(out.restoreAir, false);
  assert.equal(out.airKnown, true);
  f.world.put(0, 1, 0, BLOCK.WATER, 0, F.BUBBLE_UP);
  f.player.gameplayEnvironment(out);
  assert.equal(out.underwater, true);
  assert.equal(out.restoreAir, true);
  assert.equal(out.canBreathe, true);
  f.world.put(0, 1, 0, BLOCK.WATER, 0, F.BUBBLE_DOWN);
  assert.equal(f.player.gameplayEnvironment(out).restoreAir, true);
  f.player.setPosition({ x: 0.5, y: 1.1, z: 0.5 });
  f.player.gameplayEnvironment(out);
  assert.equal(f.player.fluidState.bubble, "down");
  assert.equal(
    out.restoreAir,
    false,
    "body contact alone does not grant full bubble air"
  );
  assert.equal(out.underwater, false);
  assert.equal(Object.hasOwn(f.player, "air"), false);
});

test("F5 and render-camera bob cannot change the physical eye's breathing projection", (t) => {
  const f = playerFixture(t, [[0, 1, 0, BLOCK.WATER, 0, F.BUBBLE_UP]], {
    x: 0.5,
    y: 0,
    z: 0.5,
  });
  const physical = f.player.eyePosition.clone();
  f.player._bob = 0.4;
  for (const perspective of ["back", "front", "first"]) {
    f.player.perspective = perspective;
    const environment = f.player.gameplayEnvironment();
    assert.equal(environment.underwater, true);
    assert.equal(environment.restoreAir, true);
    assert.ok(f.player.eyePosition.equals(physical));
    assert.equal(
      sampleFluidAtPoint(f.world, f.camera.position).fluid,
      F.NONE,
      "the displaced render camera is dry while the physical eye is in bubbles"
    );
  }
  press(f, "ShiftLeft");
  f.player.update(1 / 120, { recoverFromVoid: false });
  close(f.player.eyePosition.y - f.player.position.y, SNEAK_EYE_HEIGHT);
  assert.equal(
    f.player.fluidState.eyeFluid,
    fluidAtPoint(f.world, f.player.eyePosition)
  );
});

test("a resolved lateral gradient accelerates an idle swimmer and ordinary controls can oppose it", (t) => {
  const entries = [
    ...floor(),
    [-1, 1, 0, BLOCK.STONE],
    [0, 1, 0, BLOCK.WATER],
    [1, 1, 0, BLOCK.WATER, 0, F.WATER_4],
    [2, 1, 0, BLOCK.WATER, 0, F.WATER_7],
  ];
  for (const z of [-1, 1])
    for (let x = -1; x <= 3; x++) entries.push([x, 1, z, BLOCK.STONE]);
  const f = playerFixture(t, entries);
  assert.ok(f.player.sampleFluids().current.x > 0.9);
  f.player.update(0.1);
  assert.ok(f.player.position.x > 0.5);
  assert.ok(f.player.velocity.x > 0);
  const before = f.player.position.x;
  press(f, "KeyA");
  f.player.update(0.1);
  assert.ok(f.player.velocity.x < 0);
  assert.ok(f.player.position.x < before);
  const stats = f.player.fluidDiagnostics();
  assert.ok(stats.queries <= PLAYER_FLUID_PHYSICS.maxQueriesPerUpdate);
  assert.ok(
    stats.cells <= stats.queries * PLAYER_FLUID_PHYSICS.maxBodyCellsPerQuery
  );
});

test("held Space ascends below passive swim immersion, and releasing it restores gravity", (t) => {
  const f = playerFixture(t, column(F.WATER_SOURCE), {
    x: 0.5,
    y: 5.4,
    z: 0.5,
  });
  assert.ok(f.player.fluidState.waterImmersion > 0);
  assert.ok(
    f.player.fluidState.waterImmersion < PLAYER_FLUID_PHYSICS.swimImmersion
  );
  assert.equal(f.player.grounded, false);
  f.player.onJump = () => assert.fail("swimming cannot fabricate a ground jump");
  press(f, "Space");
  f.player.update(1 / 120, { recoverFromVoid: false });
  const ascent = f.player.velocity.y;
  assert.ok(ascent > 0);
  assert.ok(f.player.position.y > 5.4);
  dispatch(f.document, "keyup", { code: "Space" });
  f.player.update(1 / 120, { recoverFromVoid: false });
  close(f.player.velocity.y, ascent - 23 / 120);
  assert.ok(f.player.velocity.y < 0);
});

test("a shallow-water ground jump retains its ordinary impulse and callback", (t) => {
  const f = playerFixture(t, [
    ...floor(),
    [0, 1, 0, BLOCK.WATER, 0, F.WATER_7],
  ]);
  f.player.update(1 / 120, { recoverFromVoid: false });
  assert.equal(f.player.grounded, true);
  assert.ok(f.player.fluidState.waterImmersion > 0);
  assert.ok(
    f.player.fluidState.waterImmersion < PLAYER_FLUID_PHYSICS.swimImmersion
  );
  let jumps = 0;
  f.player.onJump = () => jumps++;
  press(f, "Space");
  f.player.update(1 / 120, { recoverFromVoid: false });
  close(f.player.velocity.y, 8 - 23 / 120);
  assert.equal(jumps, 1);
  assert.equal(f.player.grounded, false);
});

test("held Space in dry midair cannot supply swim ascent or a ground jump", (t) => {
  const f = playerFixture(t, floor(), { x: 0.5, y: 2.5, z: 0.5 });
  assert.equal(f.player.fluidState.waterImmersion, 0);
  f.player.onJump = () => assert.fail("dry midair has no jump support");
  press(f, "Space");
  f.player.update(1 / 120, { recoverFromVoid: false });
  close(f.player.velocity.y, -23 / 120);
  assert.equal(f.player.grounded, false);
});

for (const [fluid, direction] of [
  [F.BUBBLE_UP, 1],
  [F.BUBBLE_DOWN, -1],
]) {
  test(`authored ${direction > 0 ? "up" : "down"} bubbles accelerate vertically, restore eye air and clear falling`, (t) => {
    const entries = column(fluid);
    entries.push([
      0,
      0,
      0,
      direction > 0 ? BLOCK.SOUL_SAND : BLOCK.MAGMA_BLOCK,
    ]);
    const f = playerFixture(t, entries, { x: 0.5, y: 2, z: 0.5 });
    f.player.fallDistance = 12;
    f.player.onFall = () => assert.fail("bubble immersion cancels falling");
    f.player.update(0.1);
    assert.ok((f.player.position.y - 2) * direction > 0);
    assert.ok(f.player.velocity.y * direction > 0);
    assert.ok(f.player.velocity.y <= PLAYER_FLUID_PHYSICS.bubbleUpSpeed);
    assert.ok(f.player.velocity.y >= -PLAYER_FLUID_PHYSICS.bubbleDownSpeed);
    close(f.player.position.x, 0.5);
    close(f.player.position.z, 0.5);
    assert.equal(f.player.fallDistance, 0);
    assert.equal(f.player.gameplayEnvironment().restoreAir, true);
    for (let y = 1; y <= 5; y++) f.world.put(0, y, 0, BLOCK.WATER);
    assert.equal(f.player.sampleFluids().bubble, null);
    assert.equal(f.player.gameplayEnvironment().restoreAir, false);
  });
}

test("falling water has a downward acceleration distinct from an otherwise equal static source column", (t) => {
  const falling = playerFixture(t, column(F.WATER_FALLING), {
    x: 0.5,
    y: 2,
    z: 0.5,
  });
  const source = playerFixture(t, column(F.WATER_SOURCE), {
    x: 0.5,
    y: 2,
    z: 0.5,
  });
  assert.equal(falling.player.fluidState.current.y, -1);
  falling.player.update(0.1);
  source.player.update(0.1);
  assert.ok(falling.player.velocity.y < source.player.velocity.y);
  assert.ok(falling.player.position.y < source.player.position.y);
});

test("a fast landing in shallow level-seven water cancels fall damage before the landing callback", (t) => {
  const f = playerFixture(
    t,
    [...floor(), [0, 1, 0, BLOCK.WATER, 0, F.WATER_7]],
    { x: 0.5, y: 1.2, z: 0.5 }
  );
  assert.equal(f.player.fluidState.waterImmersion, 0);
  f.player.velocity.y = -32;
  f.player.fallDistance = 15;
  let falls = 0;
  f.player.onFall = () => falls++;
  f.player.update(1 / 120);
  close(f.player.position.y, 1);
  assert.equal(falls, 0);
  assert.equal(f.player.fallDistance, 0);
  assert.ok(f.player.fluidState.waterImmersion > 0);
});

test("unknown body coverage freezes motion and air projection, without interpreting a missing cell as air or water", (t) => {
  let ready = false;
  const f = playerFixture(
    t,
    column(F.BUBBLE_UP),
    { x: 0.9, y: 1, z: 0.5 },
    { loaded: (x) => ready || x <= 0 }
  );
  const before = f.player.position.clone();
  f.player.velocity.set(4, 3, 2);
  press(f, "KeyD");
  f.player.update(0.1);
  assert.ok(f.player.position.equals(before));
  assert.deepEqual(f.player.velocity.toArray(), [0, 0, 0]);
  assert.equal(f.player.fluidMovementBlocked, true);
  const environment = f.player.gameplayEnvironment();
  assert.equal(environment.airKnown, false);
  assert.equal(environment.restoreAir, false);
  assert.equal(environment.canBreathe, false);
  assert.equal(
    f.player.fluidState.eyeLoaded,
    true,
    "even a known wet eye must not grant air while the body footprint is unknown"
  );
  ready = true;
  f.player.update(1 / 60);
  assert.equal(f.player.fluidMovementBlocked, false);
  assert.ok(f.player.position.x > before.x);
});

test("dry walking retains its original acceleration, collider and height; flight ignores water forces", (t) => {
  const dry = controlFixture(t);
  press(dry, "KeyW");
  dry.player.update(0.1);
  let velocity = 0,
    distance = 0;
  const dt = 1 / 120,
    blend = 1 - Math.exp(-18 * dt);
  for (let i = 0; i < 12; i++) {
    velocity += (-4.317 - velocity) * blend;
    distance += velocity * dt;
  }
  close(dry.player.position.z, 0.5 + distance);
  close(dry.player.position.y, 1);
  close(dry.player.velocity.z, velocity);
  assert.equal(dry.player.grounded, true);
  assert.equal(dry.player.height, PLAYER_HEIGHT);
  assert.equal(dry.player.fluidState.immersion, 0);

  const wetFlight = playerFixture(t, column(F.BUBBLE_DOWN), {
    x: 0.5,
    y: 2,
    z: 0.5,
  });
  const dryFlight = playerFixture(t, floor(), { x: 0.5, y: 2, z: 0.5 });
  for (const f of [wetFlight, dryFlight]) {
    f.player.allowFlight = true;
    f.player.flying = true;
    press(f, "KeyW");
    f.player.update(0.1);
  }
  assert.deepEqual(
    wetFlight.player.position.toArray(),
    dryFlight.player.position.toArray()
  );
  assert.deepEqual(
    wetFlight.player.velocity.toArray(),
    dryFlight.player.velocity.toArray()
  );
});

test("paused/invalid dt does no fluid physics work and large dt has fixed query bounds", (t) => {
  const f = playerFixture(t, column(F.BUBBLE_UP), { x: 0.5, y: 2, z: 0.5 });
  const position = f.player.position.clone(),
    velocity = f.player.velocity.clone();
  for (const dt of [0, -1, NaN, Infinity]) {
    f.player.update(dt);
    assert.ok(f.player.position.equals(position));
    assert.ok(f.player.velocity.equals(velocity));
    assert.equal(f.player.fluidDiagnostics().queries, 0);
  }
  f.player.update(1000);
  assert.ok(
    f.player.fluidDiagnostics().queries <=
      PLAYER_FLUID_PHYSICS.maxQueriesPerUpdate
  );
  assert.ok(
    f.player.position.y < 3,
    "suspended wall time is not unbounded catch-up"
  );
});

test("signed void bounds are projected without a duplicate hazard loop or forced Survival teleport", (t) => {
  const f = playerFixture(t, [], { x: 0.5, y: -100, z: 0.5 });
  f.player.update(1 / 60, { recoverFromVoid: false });
  assert.equal(f.player.gameplayEnvironment().voidY, -128);
  assert.equal(f.player.gameplayEnvironment().inVoid, false);
  f.player.setPosition({ x: 0.5, y: -129, z: 0.5 });
  f.player.update(1 / 60, { recoverFromVoid: false });
  assert.ok(f.player.position.y < -129);
  assert.equal(f.player.gameplayEnvironment().inVoid, true);
  let spawns = 0;
  f.world.getSpawn = () => {
    spawns++;
    return { x: 0.5, y: 1, z: 0.5 };
  };
  f.player.update(1 / 60, { recoverFromVoid: true });
  assert.equal(spawns, 1);
  close(f.player.position.y, 1);
  f.player.allowFlight = true;
  f.player.flying = true;
  f.player.setPosition({ x: 0.5, y: 1_000_000.25, z: 0.5 });
  f.player.update(1 / 60, { recoverFromVoid: false });
  close(f.player.position.y, 1_000_000.25);
  assert.equal(f.player.fluidMovementBlocked, false);
  assert.equal(f.player.gameplayEnvironment().inVoid, false);
});
