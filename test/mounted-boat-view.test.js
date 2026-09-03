import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { getWorldSpec } from "../src/world-spec.js";
import {
  close, exitPose, freezePose, keyDown, mountedPlayerFixture,
  playerSnapshot, seatPose,
} from "./mounted-player-fixture.js";

// Explicit tagged boundary cases isolate Player's consumption contract.
// The companion owner suite MUST also pass without tagging or
// rewriting any real rider projection in its fixture.
const boatPose = (extra = {}) => seatPose({ vehicleType: "boat", id: 1, ...extra });
const wrap = (angle) => Math.atan2(Math.sin(angle), Math.cos(angle));
const snapshot = (player) => ({
  ...playerSnapshot(player), vehicleType: player.vehicleType, heading: player.hullHeading,
});

for (const enabled of [true, false]) {
  for (const dt of [0, 0.05]) {
    test(`continuing tagged boats add one shortest delta at dt=${dt}, enabled=${enabled}, retaining relative arrow look`, (t) => {
      const f = mountedPlayerFixture(t), p = f.player;
      p.yaw = -408.72136;
      p.pitch = 0.47;
      p.enabled = enabled;
      const initial = freezePose(boatPose({ hullYaw: Math.PI - 0.02 }));
      assert.equal(p.update(0, { riderPose: initial }), true);
      close(p.yaw, -408.72136);
      close(p.pitch, 0.47);
      keyDown(f, "ArrowLeft");
      keyDown(f, "ArrowUp");
      const next = freezePose(boatPose({ hullYaw: -Math.PI + 0.05 }));
      const immutable = structuredClone(next);
      const revision = p.poseRevision;
      const sample = t.mock.method(p, "sampleFluids"), camera = t.mock.method(p, "_syncCamera");
      assert.equal(p.update(dt, { riderPose: next }), true);
      const yaw = -408.72136 + 0.07 + (enabled ? 1.6 * dt : 0);
      const pitch = 0.47 + (enabled ? 1.3 * dt : 0);
      assert.deepEqual(next, immutable);
      assert.equal(p.poseRevision, revision + 1, "transport is part of the existing pose publication");
      assert.equal(sample.mock.callCount(), 1);
      assert.equal(camera.mock.callCount(), 1);
      assert.deepEqual(p.position.toArray(), [next.position.x, next.position.y, next.position.z]);
      assert.deepEqual(p.velocity.toArray(), [next.velocity.x, next.velocity.y, next.velocity.z]);
      close(p.yaw, yaw);
      close(p.pitch, pitch);
      assert.equal(p.update(0, { riderPose: next }), true);
      close(p.yaw, yaw);
      close(p.pitch, pitch);
      close(p.camera.getWorldDirection(new THREE.Vector3()).dot(p.forward), 1);
    });
  }
}

test("repeated missing boat identity or heading never carries an unowned turn", (t) => {
  for (const missing of [{ id: undefined }, { id: null }, { hullYaw: undefined }]) {
    const { player: p } = mountedPlayerFixture(t);
    p.yaw = 1.7;
    p.pitch = -0.31;
    assert.equal(p.update(0, { riderPose: boatPose({ hullYaw: 0.4 }) }), true);
    for (const hullYaw of [0.7, 1.1]) {
      assert.equal(p.update(0, {
        riderPose: boatPose({ hullYaw, ...missing }),
      }), true);
      close(p.yaw, 1.7);
      close(p.pitch, -0.31);
    }
    assert.equal(p.update(0, { riderPose: boatPose({ hullYaw: 1.4 }) }), true);
    close(p.yaw, 1.7, 1e-9);
    assert.equal(p.update(0, { riderPose: boatPose({ hullYaw: 1.6 }) }), true);
    close(p.yaw, 1.9);
    close(p.pitch, -0.31);
  }
});

test("refused pose data, geometry, time and ambiguous deliveries cannot poison the accepted boat baseline", (t) => {
  const f = mountedPlayerFixture(t), p = f.player;
  p.yaw = 1.7;
  const initial = boatPose({ hullYaw: 0.4 });
  assert.equal(p.update(0, { riderPose: initial }), true);
  const before = snapshot(p);
  for (const options of [
    { riderPose: boatPose({ id: 99, hullYaw: Infinity }) },
    { riderPose: boatPose({ id: 99, hullYaw: 1.5, vehicleType: "minecart" }) },
    { riderPose: boatPose({ id: 99, hullYaw: 1.5, dimension: "nether" }) },
    { riderPose: boatPose({ id: 99, hullYaw: 1.5, position: { x: 0.5, y: 0.5, z: 0.5 } }) },
    { riderPose: boatPose({ id: 99, hullYaw: 1.5 }), exitPose: exitPose() },
    { exitPose: exitPose({ position: { x: 0.5, y: 0.5, z: 0.5 } }) },
    { riderPose: boatPose({ id: 99, hullYaw: 1.5 }), recoverFromVoid: 0 },
  ]) {
    assert.equal(p.update(0.05, options), false);
    assert.deepEqual(snapshot(p), before);
  }
  for (const dt of [-1, NaN, Infinity]) {
    assert.equal(p.update(dt, { riderPose: boatPose({ id: 99, hullYaw: 1.5 }) }), false);
    assert.deepEqual(snapshot(p), before);
  }
  p.update(0);
  assert.deepEqual(snapshot(p), before, "zero-time absence is still a no-op");
  p.update(0.05);
  close(p.yaw, before.yaw);
  close(p.hullHeading, before.heading);
  assert.equal(p.update(0, { riderPose: boatPose({ hullYaw: 0.6 }) }), true);
  close(p.yaw, 1.9);
});

const discontinuities = {
  "committed exit": (f) => {
    assert.equal(f.player.update(0, { exitPose: exitPose() }), true);
  },
  "setPosition": (f) => f.player.setPosition(f.player.position),
  "vehicle ID": () => ({ id: 2 }),
  "horse switch": (f) => {
    assert.equal(f.player.update(0, {
      riderPose: boatPose({ vehicleType: "horse", hullYaw: 2.4 }),
    }), true);
  },
  "untyped pose": (f) => {
    assert.equal(f.player.update(0, {
      riderPose: boatPose({ vehicleType: undefined, hullYaw: 2.4 }),
    }), true);
  },
  "missing heading": (f) => {
    assert.equal(f.player.update(0, { riderPose: boatPose({ hullYaw: undefined }) }), true);
  },
  "missing identity": (f) => {
    assert.equal(f.player.update(0, { riderPose: boatPose({ id: undefined, hullYaw: 2.4 }) }), true);
  },
  "world identity": (f, t) => { f.player.world = mountedPlayerFixture(t).world; },
  "world epoch": (f) => { f.world.epoch++; },
  "dimension": (f) => {
    f.world.dimension = "nether";
    f.world.spec = getWorldSpec(4, "nether");
  },
};

for (const [name, reset] of Object.entries(discontinuities)) {
  test(`${name} ends boat-view continuity; a fresh baseline cannot snap and the next delta still applies`, (t) => {
    const f = mountedPlayerFixture(t), p = f.player;
    p.yaw = 2.7;
    p.pitch = -0.31;
    assert.equal(p.update(0, { riderPose: boatPose({ hullYaw: 0.4 }) }), true);
    const extra = reset(f, t) ?? {};
    close(p.yaw, 2.7);
    const next = boatPose({
      ...extra, hullYaw: 1.2, dimension: p.world.dimension,
      position: { x: 0.5, y: 1.4, z: 0.5, dimension: p.world.dimension },
    });
    assert.equal(p.update(0, { riderPose: next }), true);
    close(p.yaw, 2.7);
    close(p.pitch, -0.31);
    assert.equal(p.update(0, { riderPose: { ...next, hullYaw: 1.35 } }), true);
    close(p.yaw, 2.7 + wrap(1.35 - 1.2));
    close(p.pitch, -0.31);
  });
}

test("horse and untyped historical poses retain independent physical aim and existing Space semantics", (t) => {
  const f = mountedPlayerFixture(t), p = f.player;
  p.yaw = 1.7;
  p.pitch = 0.2;
  const horse = boatPose({ vehicleType: "horse", hullYaw: 0.4 });
  assert.equal(p.update(0, { riderPose: horse }), true);
  keyDown(f, "Space");
  assert.equal(p.vehicleKeys.has("Space"), true);
  assert.equal(p.update(0, { riderPose: { ...horse, hullYaw: 0.9 } }), true);
  assert.equal(p.vehicleKeys.has("Space"), true);
  close(p.yaw, 1.7);
  close(p.pitch, 0.2);
  for (const hullYaw of [1.1, 1.5]) {
    assert.equal(p.update(0, {
      riderPose: boatPose({ vehicleType: undefined, hullYaw }),
    }), true);
    assert.equal(p.vehicleKeys.has("Space"), false);
    assert.equal(p.vehicleType, null);
    close(p.yaw, 1.7);
    close(p.pitch, 0.2);
    assert.equal(p.flying, false);
  }
});
