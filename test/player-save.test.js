import assert from "node:assert/strict";
import test from "node:test";
import { MAX_LOOK_PITCH } from "../src/player.js";
import { restorePlayerSave } from "../src/player-save.js";
import { WORLD_MAX, WORLD_MIN } from "../src/terrain.js";

const emptyWorld = { isSolid: () => false };
const playerStub = () => ({
  position: { x: 21.5, y: 27.01, z: 30.5 },
  setPosition(position) {
    this.position = position;
  },
});
const state = { x: 0, y: 25, z: 0, yaw: 0.8, pitch: -0.4, flying: true };

test("restores saved position at all reachable horizontal world boundaries", () => {
  for (const x of [WORLD_MIN + 0.3, WORLD_MAX - 0.3]) {
    for (const z of [WORLD_MIN + 0.3, WORLD_MAX - 0.3]) {
      const player = playerStub();
      assert.equal(
        restorePlayerSave(player, emptyWorld, { ...state, x, z }),
        true
      );
      assert.deepEqual(player.position, { x, y: state.y, z });
      assert.equal(player.flying, true);
    }
  }
});

test("restores high-altitude creative flight without an arbitrary save ceiling", () => {
  const player = playerStub();
  assert.equal(
    restorePlayerSave(player, emptyWorld, { ...state, y: 250 }),
    true
  );
  assert.equal(player.position.y, 250);
  assert.equal(player.yaw, state.yaw);
  assert.equal(player.pitch, state.pitch);
});

test("invalid player saves do not partially mutate the player", () => {
  for (const patch of [
    { x: WORLD_MAX },
    { z: WORLD_MIN },
    { y: 0 },
    { y: Infinity },
    { y: 1e100 },
    { yaw: NaN },
    { pitch: "0" },
  ]) {
    const player = playerStub();
    const before = { ...player.position };
    assert.equal(
      restorePlayerSave(player, emptyWorld, { ...state, ...patch }),
      false
    );
    assert.deepEqual(player.position, before);
  }
});

test("a save inside a solid block falls back to the safe spawn", () => {
  const player = playerStub();
  const before = { ...player.position };
  const obstructed = { isSolid: (x, y, z) => x === 0 && y === 25 && z === 0 };
  assert.equal(restorePlayerSave(player, obstructed, state), false);
  assert.deepEqual(player.position, before);
});

test("a validated nearby fallback preserves saved cave heading without restoring an obstructed pose", () => {
  const player = playerStub();
  const obstructed = { isSolid: (x, y, z) => x === 0 && y === 25 && z === 0 };
  const fallbackPosition = { x: 0.5, y: 29.01, z: 0.5 };
  assert.equal(
    restorePlayerSave(
      player,
      obstructed,
      { ...state, yaw: -408.72136, flying: false },
      { fallbackPosition }
    ),
    true
  );
  assert.deepEqual(player.position, fallbackPosition);
  assert.equal(player.yaw, -408.72136);
  assert.equal(player.pitch, state.pitch);
  assert.equal(player.flying, false);
});

test("fallbacks cannot bypass pose validation or change a valid save's flight state", () => {
  const obstructed = { isSolid: (x, y) => x === 0 && y === 25 };
  for (const fallbackPosition of [
    { x: 0, y: 25, z: 0 },
    { x: WORLD_MAX, y: 30, z: 0 },
    { x: 0, y: Infinity, z: 0 },
  ]) {
    const player = playerStub();
    const before = { ...player.position };
    assert.equal(
      restorePlayerSave(player, obstructed, state, { fallbackPosition }),
      false
    );
    assert.deepEqual(player.position, before);
  }
  const player = playerStub();
  const fallbackPosition = { x: 1, y: 30, z: 1, flying: true };
  assert.equal(
    restorePlayerSave(
      player,
      emptyWorld,
      { ...state, flying: false },
      { fallbackPosition }
    ),
    true
  );
  assert.deepEqual(player.position, { x: state.x, y: state.y, z: state.z });
  assert.equal(player.flying, false);
  assert.equal(
    restorePlayerSave(
      player,
      emptyWorld,
      { ...state, yaw: NaN },
      { fallbackPosition }
    ),
    false
  );
});

test("saved yaw round-trips exactly and pitch uses the movement limit", () => {
  const player = playerStub();
  assert.equal(
    restorePlayerSave(player, emptyWorld, { ...state, yaw: 20, pitch: 8 }),
    true
  );
  assert.equal(player.yaw, 20);
  assert.equal(player.pitch, MAX_LOOK_PITCH);
});

test("a valid crouched pose is restored instead of moved out of its low ceiling", () => {
  const player = playerStub();
  const ceiling = { isSolid: (_x, y) => y === 27 };
  const saved = {
    ...state,
    y: 25.4,
    flying: false,
    yaw: -8.900715033327748,
    pitch: 1.53,
  };
  assert.equal(restorePlayerSave(player, ceiling, saved), true);
  assert.deepEqual(player.position, { x: saved.x, y: saved.y, z: saved.z });
  assert.equal(player.sneaking, true);
  assert.equal(player.yaw, saved.yaw);
  assert.equal(player.pitch, saved.pitch);
});
