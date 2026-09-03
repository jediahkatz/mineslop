import assert from "node:assert/strict";
import { BLOCK } from "../src/blocks.js";
import { controlFixture, dispatch } from "./control-fixture.js";
import { shapeWorld } from "./shape-fixture.js";

export function mountedFloor() {
  const entries = [];
  for (let x = -4; x <= 4; x++)
    for (let z = -4; z <= 4; z++) entries.push([x, 0, z, BLOCK.STONE]);
  return entries;
}

/** Real Player/Three camera over detached authored geometry; no live saves. */
export function mountedPlayerFixture(
  t,
  {
    entries = mountedFloor(),
    position = { x: 0.5, y: 1, z: 0.5 },
    geometry,
    preferences,
  } = {}
) {
  const f = controlFixture(t, preferences);
  const world = shapeWorld(entries, geometry);
  world.ensureArea = () => assert.fail("mounted Player cannot admit terrain");
  world.getSpawn = () => assert.fail("committed poses cannot invent a spawn");
  f.player.world = world;
  f.player.setPosition(position);
  return { ...f, world };
}

// Same explicit projections as Boats.riderPose / findBoatDismount. No boat
// implementation, catalog substitution, gameplay owner or rendering mock.
export function seatPose(overrides = {}) {
  return {
    id: "boat-1",
    slot: 0,
    dimension: "overworld",
    position: { x: 0.5, y: 1.4, z: 0.5, dimension: "overworld" },
    velocity: { x: 1.25, y: -0.2, z: -0.75 },
    hullYaw: 0.73,
    grounded: false,
    seated: true,
    ...overrides,
  };
}

export function exitPose(overrides = {}) {
  return {
    position: { x: 2.5, y: 1.001, z: 0.5 },
    velocity: { x: 0, y: 0, z: 0 },
    grounded: true,
    swimming: false,
    ...overrides,
  };
}

export function freezePose(pose) {
  Object.freeze(pose.position);
  Object.freeze(pose.velocity);
  return Object.freeze(pose);
}

export const keyDown = (f, code, timeStamp = 1000, extra = {}) =>
  dispatch(f.document, "keydown", {
    code,
    timeStamp,
    target: f.element,
    ...extra,
  });
export const keyUp = (f, code) => dispatch(f.document, "keyup", { code });
export const tap = (f, code, timeStamp) => {
  keyDown(f, code, timeStamp);
  keyUp(f, code);
};
export const close = (actual, expected, tolerance = 1e-9) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${actual} != ${expected}`
  );

export function playerSnapshot(player) {
  return {
    revision: player.poseRevision,
    position: player.position.toArray(),
    eye: player.eyePosition.toArray(),
    velocity: player.velocity.toArray(),
    yaw: player.yaw,
    pitch: player.pitch,
    height: player.height,
    eyeHeight: player.eyeHeight,
    seated: player.seated,
    sneaking: player.sneaking,
    flying: player.flying,
    grounded: player.grounded,
    moving: player.moving,
    sprinting: player.sprinting,
    climbing: player.climbing,
    fallDistance: player.fallDistance,
    keys: [...player._keys],
    jumpQueued: player._jumpQueued,
    spaceTapAt: player._spaceTapAt,
    forwardTapAt: player._forwardTapAt,
    sprintLatched: player._sprintLatched,
    stepDistance: player._stepDistance,
    bobPhase: player._bobPhase,
    bob: player._bob,
    camera: player.camera.position.toArray(),
    cameraRotation: player.camera.quaternion.toArray(),
    fov: player.camera.fov,
    fluid: structuredClone(player.fluidState),
  };
}
