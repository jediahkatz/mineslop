import assert from "node:assert/strict";
import test from "node:test";
import { BLOCK_STATE as S } from "../src/block-state.js";
import { BLOCK } from "../src/blocks.js";
import {
  climbContact,
  intersectsCell,
  intersectsPlacement,
  standingHeight,
  sweepCameraDistance,
} from "../src/collision.js";
import { collidesWithWorld, moveWithCollisions } from "../src/player.js";
import { restorePlayerSave } from "../src/player-save.js";
import { spawnStandingHeight } from "../src/spawn-support.js";
import { controlFixture, dispatch } from "./control-fixture.js";
import { cell, shapeWorld } from "./shape-fixture.js";

const close = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`);
const floor = () => {
  const cells = [];
  for (let x = -2; x <= 4; x++)
    for (let z = -2; z <= 3; z++) cells.push([x, -1, z, BLOCK.STONE]);
  return cells;
};

test("a grounded player explicitly steps onto a half slab and successive stair treads", () => {
  const slab = shapeWorld([...floor(), [1, 0, 0, BLOCK.OAK_SLAB]]);
  const step = moveWithCollisions(
    slab,
    { x: 0.5, y: 0, z: 0.5 },
    { x: 1.2, y: -0.1, z: 0 }
  );
  close(step.position.x, 1.7);
  close(step.position.y, 0.5);
  assert.equal(step.grounded, true);
  assert.ok(step.stepped > 0);
  assert.equal(collidesWithWorld(slab, step.position), false);

  const stairs = shapeWorld([...floor(), [0, 0, 0, BLOCK.OAK_STAIRS]]);
  const climbed = moveWithCollisions(
    stairs,
    { x: 0.5, y: 0, z: 1.5 },
    { x: 0, y: -0.1, z: -1.4 }
  );
  close(climbed.position.z, 0.1);
  close(climbed.position.y, 1);
  assert.equal(climbed.grounded, true);
  assert.equal(collidesWithWorld(stairs, climbed.position), false);
});

test("steps do not climb full blocks, the high side of stairs, or a low ceiling", () => {
  const cube = shapeWorld([...floor(), [1, 0, 0, BLOCK.STONE]]);
  const blocked = moveWithCollisions(
    cube,
    { x: 0.5, y: 0, z: 0.5 },
    { x: 1, y: -0.1, z: 0 }
  );
  close(blocked.position.x, 0.7);
  close(blocked.position.y, 0);
  const stairs = shapeWorld([...floor(), [0, 0, 0, BLOCK.OAK_STAIRS]]);
  const highSide = moveWithCollisions(
    stairs,
    { x: 0.5, y: 0, z: -0.5 },
    { x: 0, y: -0.1, z: 1 }
  );
  close(highSide.position.z, -0.3);
  const ceiling = shapeWorld([
    ...floor(),
    [1, 0, 0, BLOCK.OAK_SLAB],
    [0, 2, 0, BLOCK.STONE],
  ]);
  const low = moveWithCollisions(
    ceiling,
    { x: 0.5, y: 0, z: 0.5 },
    { x: 1, y: -0.1, z: 0 }
  );
  close(low.position.x, 0.7);
  close(low.position.y, 0);
});

test("fractional contacts stop fast falls and horizontal motion through thin shapes", () => {
  const trapdoor = shapeWorld([[0, -10, 0, BLOCK.OAK_TRAPDOOR]]);
  const fall = moveWithCollisions(
    trapdoor,
    { x: 0.5, y: 4, z: 0.5 },
    { x: 0, y: -30, z: 0 }
  );
  close(fall.position.y, -10 + 3 / 16);
  assert.equal(fall.grounded, true);
  const door = shapeWorld([[0, 0, 0, BLOCK.OAK_TRAPDOOR, S.OPEN]]);
  const hit = moveWithCollisions(
    door,
    { x: 0.5, y: 0, z: -2 },
    { x: 0, y: 0, z: 5 },
    { stepHeight: 0 }
  );
  close(hit.position.z, 13 / 16 - 0.3);
  assert.equal(hit.blocked.z, true);
  const fence = shapeWorld([[0, 0, 0, BLOCK.OAK_FENCE]]);
  const invisibleHeight = moveWithCollisions(
    fence,
    { x: -1, y: 1.1, z: 0.5 },
    { x: 3, y: 0, z: 0 }
  );
  close(invisibleHeight.position.x, 6 / 16 - 0.3);
});

test("sneak edges follow fractional support, including a downward half step", () => {
  const world = shapeWorld([[0, 0, 0, BLOCK.OAK_SLAB]]);
  const sneaking = moveWithCollisions(
    world,
    { x: 0.5, y: 0.5, z: 0.5 },
    { x: 3, y: -0.02, z: 0 },
    { sneaking: true }
  );
  close(sneaking.position.y, 0.5);
  assert.ok(sneaking.position.x < 1.3);
  close(standingHeight(world, sneaking.position), 0.5);
  world.put(0, 0, 0, BLOCK.STONE);
  world.put(1, 0, 0, BLOCK.OAK_SLAB);
  const down = moveWithCollisions(
    world,
    { x: 0.5, y: 1, z: 0.5 },
    { x: 1, y: -0.02, z: 0 },
    { sneaking: true }
  );
  assert.ok(down.position.x > 1.3);
  const landed = moveWithCollisions(
    world,
    down.position,
    { x: 0, y: -1, z: 0 },
    { sneaking: true }
  );
  close(landed.position.y, 0.5);
});

test("placement excludes the actual body and derived neighboring fence arms", () => {
  const position = { x: 0.5, y: 0.5, z: 0.5 };
  assert.equal(intersectsCell(position, 0, 0, 0, cell(BLOCK.OAK_SLAB)), false);
  assert.equal(
    intersectsCell(position, 0, 0, 0, cell(BLOCK.OAK_SLAB, S.TOP)),
    true
  );
  assert.equal(
    intersectsCell(position, 0, 0, 0, cell(BLOCK.OAK_FENCE_GATE, S.OPEN)),
    false
  );
  const world = shapeWorld([[0, 0, 0, BLOCK.OAK_FENCE]]);
  const beside = { x: 0.9, y: 0, z: 0.5 };
  assert.equal(
    intersectsCell(beside, 0, 0, 0, cell(BLOCK.OAK_FENCE), undefined, {
      radius: 0.1,
    }),
    false
  );
  assert.equal(
    intersectsPlacement(
      world,
      beside,
      [{ x: 1, y: 0, z: 0, cell: cell(BLOCK.STONE) }],
      { radius: 0.1 }
    ),
    true
  );
});

test("camera clearance uses exact geometry and catches a fence protruding from below", () => {
  const slab = shapeWorld([[0, 0, 2, BLOCK.OAK_SLAB]]);
  const direction = { x: 0, y: 0, z: 1 };
  close(
    sweepCameraDistance(slab, { x: 0.5, y: 0.85, z: 0.5 }, direction, 4, 0.15),
    4
  );
  assert.ok(
    sweepCameraDistance(slab, { x: 0.5, y: 0.5, z: 0.5 }, direction, 4, 0.15) <
      1.5
  );
  const fence = shapeWorld([[0, 0, 2, BLOCK.OAK_FENCE]]);
  assert.ok(
    sweepCameraDistance(
      fence,
      { x: 0.5, y: 1.25, z: 0.5 },
      direction,
      4,
      0.15
    ) < 2
  );
});

test("attached ladders climb, sneak holds, and removing attachment stops climbing", (t) => {
  const f = controlFixture(t);
  const entries = floor();
  for (let y = 0; y < 5; y++) {
    entries.push([0, y, 0, BLOCK.LADDER], [0, y, 1, BLOCK.STONE]);
  }
  const world = shapeWorld(entries);
  f.player.world = world;
  f.player.allowFlight = false;
  f.player.setPosition({ x: 0.5, y: 0, z: 0.7 });
  f.player.yaw = Math.PI;
  assert.ok(climbContact(world, f.player.position));
  assert.equal(collidesWithWorld(world, f.player.position), false);
  dispatch(f.document, "keydown", { code: "KeyW", target: f.element });
  for (let frame = 0; frame < 30; frame++) f.player.update(1 / 60);
  assert.ok(f.player.position.y > 1);
  assert.equal(f.player.climbing, true);
  dispatch(f.document, "keydown", { code: "ShiftLeft", target: f.element });
  const heldY = f.player.position.y;
  for (let frame = 0; frame < 10; frame++) f.player.update(1 / 60);
  close(f.player.position.y, heldY);
  for (let y = 0; y < 5; y++) world.put(0, y, 1, BLOCK.AIR);
  dispatch(f.document, "keyup", { code: "KeyW" });
  for (let frame = 0; frame < 10; frame++) f.player.update(1 / 60);
  assert.equal(f.player.climbing, false);
  assert.ok(f.player.position.y < heldY);
});

test("spawn/restoration use signed fractional support without inventing a flight ceiling", () => {
  const world = shapeWorld([[0, -10, 0, BLOCK.OAK_SLAB]]);
  close(spawnStandingHeight(world, 0, 0), -9.49);
  const player = {
    setPosition(position) {
      this.position = position;
    },
  };
  for (const y of [-9.5, 320, 29_000_000.25]) {
    assert.equal(
      restorePlayerSave(player, world, {
        x: 0.5,
        y,
        z: 0.5,
        yaw: 0,
        pitch: 0,
        flying: true,
      }),
      true
    );
    assert.equal(player.position.y, y);
  }
  assert.equal(
    restorePlayerSave(player, world, {
      x: 0.5,
      y: -9.75,
      z: 0.5,
      yaw: 0,
      pitch: 0,
    }),
    false
  );
  assert.equal(
    restorePlayerSave(player, world, {
      x: 0.5,
      y: 1e100,
      z: 0.5,
      yaw: 0,
      pitch: 0,
    }),
    false
  );
});
