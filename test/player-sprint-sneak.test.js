import assert from "node:assert/strict";
import test from "node:test";
import {
  collidesWithWorld,
  EYE_HEIGHT,
  moveWithCollisions,
  PLAYER_HEIGHT,
  SNEAK_EYE_HEIGHT,
  SNEAK_HEIGHT,
} from "../src/player.js";
import { controlFixture, dispatch } from "./control-fixture.js";

const key = (f, code, timeStamp = 1000, extra = {}) =>
  dispatch(f.document, "keydown", {
    code,
    timeStamp,
    target: f.element,
    ...extra,
  });
const up = (f, code) => dispatch(f.document, "keyup", { code });
const frames = (player, count = 1) => {
  for (let frame = 0; frame < count; frame++) player.update(1 / 60);
};
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);

for (const control of ["ControlLeft", "ControlRight"]) {
  test(`${control} sprints forward, not backward or sideways, and releases cleanly`, (t) => {
    const f = controlFixture(t);
    const walking = controlFixture(t);
    key(walking, "KeyW");
    key(f, "KeyW");
    key(f, control);
    frames(f.player, 60);
    frames(walking.player, 60);
    assert.equal(f.player.sprinting, true);
    const runDistance = 0.5 - f.player.position.z;
    const walkDistance = 0.5 - walking.player.position.z;
    assert.ok(runDistance > walkDistance * 1.2);
    up(f, control);
    frames(f.player);
    assert.equal(f.player.sprinting, false);
    up(f, "KeyW");
    key(f, control);
    key(f, "KeyD");
    frames(f.player);
    assert.equal(f.player.sprinting, false);
    key(f, "KeyS");
    frames(f.player);
    assert.equal(f.player.sprinting, false);
  });
}

test("double-tap W latches sprint across frames but releasing forward cancels it", (t) => {
  const f = controlFixture(t);
  key(f, "KeyW", 1000);
  frames(f.player, 3);
  up(f, "KeyW");
  frames(f.player, 3);
  key(f, "KeyW", 1200);
  frames(f.player, 30);
  assert.equal(f.player.sprinting, true);
  up(f, "KeyW");
  frames(f.player);
  assert.equal(f.player.sprinting, false);
  key(f, "KeyW", 1800);
  frames(f.player);
  assert.equal(f.player.sprinting, false);
});

test("held/repeated W and slow second taps cannot latch sprint", (t) => {
  const f = controlFixture(t);
  key(f, "KeyW", 1000);
  key(f, "KeyW", 1100, { repeat: true });
  key(f, "KeyW", 1150);
  frames(f.player);
  assert.equal(f.player.sprinting, false);
  up(f, "KeyW");
  key(f, "KeyW", 1800);
  frames(f.player);
  assert.equal(f.player.sprinting, false);
});

for (const cancellation of ["sneak", "backward", "hunger", "wall", "blur"]) {
  test(`${cancellation} cancels a latched sprint without resurrecting it`, (t) => {
    const f = controlFixture(t);
    key(f, "KeyW", 1000);
    up(f, "KeyW");
    key(f, "KeyW", 1100);
    frames(f.player);
    assert.equal(f.player.sprinting, true);
    if (cancellation === "sneak") key(f, "ShiftLeft");
    if (cancellation === "backward") key(f, "KeyS");
    if (cancellation === "hunger") f.player.canSprint = false;
    if (cancellation === "blur") dispatch(f.window, "blur");
    if (cancellation === "wall") {
      f.world.isSolid = (_x, y, z) => y === 0 || z === -1;
      frames(f.player, 20);
    }
    frames(f.player);
    assert.equal(f.player.sprinting, false);
    up(f, "ShiftLeft");
    up(f, "KeyS");
    f.player.canSprint = true;
    f.world.isSolid = (_x, y) => y === 0;
    frames(f.player);
    assert.equal(f.player.sprinting, false);
  });
}

for (const shift of ["ShiftLeft", "ShiftRight"]) {
  test(`${shift} lowers the eye/body and speed; Ctrl cannot sprint while sneaking`, (t) => {
    const f = controlFixture(t);
    const walking = controlFixture(t);
    key(walking, "KeyW");
    key(f, "KeyW");
    key(f, shift);
    key(f, "ControlLeft");
    frames(f.player, 60);
    frames(walking.player, 60);
    assert.equal(f.player.sneaking, true);
    assert.equal(f.player.height, SNEAK_HEIGHT);
    assert.equal(f.player.sprinting, false);
    close(f.player.eyePosition.y - f.player.position.y, SNEAK_EYE_HEIGHT);
    assert.ok(
      0.5 - f.player.position.z < (0.5 - walking.player.position.z) / 2
    );
    up(f, shift);
    frames(f.player);
    assert.equal(f.player.sneaking, false);
    assert.equal(f.player.height, PLAYER_HEIGHT);
    close(f.player.eyePosition.y - f.player.position.y, EYE_HEIGHT);
  });
}

for (const diagonal of [false, true]) {
  test(`sneaking protects a supported ${diagonal ? "diagonal corner" : "ledge"} without floating after release`, (t) => {
    const f = controlFixture(t);
    f.world.isSolid = (x, y, z) => x === 0 && y === 0 && z === 0;
    frames(f.player);
    key(f, "ShiftLeft");
    key(f, "KeyD");
    if (diagonal) key(f, "KeyW");
    frames(f.player, 180);
    assert.equal(f.player.position.y, 1);
    assert.equal(f.player.grounded, true);
    assert.ok(f.player.position.x < 1.3);
    assert.ok(f.player.position.z > -0.3);
    assert.ok(
      collidesWithWorld(
        f.world,
        { ...f.player.position, y: f.player.position.y - 0.01 },
        f.player.height
      ),
      "the footprint still overlaps real support"
    );
    up(f, "ShiftLeft");
    frames(f.player, 30);
    assert.ok(
      f.player.position.y < 1,
      "walking off the ledge is still possible"
    );
  });
}

test("a combined diagonal cannot cross a missing corner even when each axis has support", () => {
  const world = {
    isSolid: (x, y, z) =>
      y === 0 &&
      ((x === 0 && (z === 0 || z === 1)) || (z === 0 && (x === 0 || x === 1))),
  };
  const movement = moveWithCollisions(
    world,
    { x: 1.2, y: 1, z: 1.2 },
    { x: 0.2, y: -0.01, z: 0.2 },
    { height: SNEAK_HEIGHT, sneaking: true }
  );
  assert.ok(
    collidesWithWorld(world, { ...movement.position, y: 0.99 }, SNEAK_HEIGHT)
  );
  assert.equal(movement.grounded, true);
});

test("sneak edge protection does not anchor airborne or upward movement", () => {
  const world = { isSolid: (x, y, z) => x === 0 && y === 0 && z === 0 };
  for (const [y, vertical] of [
    [3, -0.1],
    [1, 0.5],
  ]) {
    const movement = moveWithCollisions(
      world,
      { x: 0.5, y, z: 0.5 },
      { x: 2, y: vertical, z: 0 },
      { height: SNEAK_HEIGHT, sneaking: true }
    );
    close(movement.position.x, 2.5);
    close(movement.position.y, y + vertical);
    assert.equal(movement.grounded, false);
  }
});

test("releasing sneak or losing focus cannot stand into a low ceiling", (t) => {
  const f = controlFixture(t);
  f.world.isSolid = (_x, y) => y === 0 || y === 3;
  f.player.setPosition({ x: 0.5, y: 1.4, z: 0.5 });
  key(f, "ShiftLeft");
  frames(f.player);
  assert.equal(f.player.sneaking, true);
  assert.equal(f.player.intersectsBlock(0, 3, 0), false);
  up(f, "ShiftLeft");
  frames(f.player);
  assert.equal(f.player.sneaking, true);
  assert.equal(collidesWithWorld(f.world, f.player.position), true);
  assert.equal(
    collidesWithWorld(f.world, f.player.position, f.player.height),
    false
  );
  dispatch(f.window, "blur");
  assert.equal(f.player.sneaking, true);
  assert.equal(f.player._keys.size, 0);
  f.world.isSolid = (_x, y) => y === 0;
  frames(f.player);
  assert.equal(f.player.sneaking, false);
  assert.equal(f.player.height, PLAYER_HEIGHT);
});

test("crouched collision sweeps use the smaller height without tunnelling", () => {
  const world = { isSolid: (_x, y) => y === 5 };
  const movement = moveWithCollisions(
    world,
    { x: 0.5, y: 1, z: 0.5 },
    { x: 0, y: 20, z: 0 },
    { height: SNEAK_HEIGHT }
  );
  close(movement.position.y, 5 - SNEAK_HEIGHT);
  assert.equal(movement.blocked.y, true);
  assert.equal(
    collidesWithWorld(world, movement.position, SNEAK_HEIGHT),
    false
  );
});
