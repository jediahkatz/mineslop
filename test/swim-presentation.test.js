import assert from "node:assert/strict";
import test from "node:test";
import {
  advanceHeldMotion, composeHeldMotion, createHeldMotion, requestHeldSelection,
} from "../src/held-motion.js";
import { createPlayerRig, posePlayerRig } from "../src/player-rig.js";

const water = { swimming: true, fluidKnown: true, grounded: false, moving: true };
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
const pose = (motion, reduced = false) =>
  ({ ...composeHeldMotion(motion, false, false, reduced) });
function tick(motion, dt, state, kind = null) {
  advanceHeldMotion(motion, dt, state.moving, true, kind, 0.7, 0, state);
}
function interval(seconds, hz, update) {
  let remaining = seconds;
  let frame = 0;
  while (remaining > 1e-12) {
    const rate = Array.isArray(hz) ? hz[frame++ % hz.length] : hz;
    const dt = Math.min(remaining, 1 / rate);
    update(dt);
    remaining -= dt;
  }
}
const matrices = (rig) => rig.parts.flatMap((part) => part.node.matrixWorld.toArray());

test("swim entry, tread, movement and exit match at 10/30/60/144Hz and variable dt", () => {
  const runs = [10, 30, 60, 144, [144, 30, 60, 10, 120]].map((hz) => {
    const held = createHeldMotion(), rig = createPlayerRig();
    const snapshots = [];
    for (const [seconds, state] of [
      [0.23, water], [0.31, { ...water, moving: false }],
      [0.37, water], [0.21, { ...water, swimming: false, moving: false }],
    ]) {
      interval(seconds, hz, (dt) => {
        tick(held, dt, state);
        posePlayerRig(rig, dt, state);
      });
      snapshots.push([...Object.values(pose(held)), ...matrices(rig)]);
    }
    return snapshots;
  });
  for (const snapshots of runs)
    snapshots.forEach((snapshot, i) => snapshot.forEach((v, j) => close(v, runs[0][i][j])));
});

test("water entry/exit is bounded and continuous; invalid dt freezes filters", () => {
  const held = createHeldMotion(), rig = createPlayerRig();
  const idle = pose(held), standing = matrices(rig);
  tick(held, 0, water);
  posePlayerRig(rig, 0, water);
  assert.deepEqual(pose(held), idle);
  assert.deepEqual(matrices(rig), standing);
  interval(0.5, 60, (dt) => { tick(held, dt, water); posePlayerRig(rig, dt, water); });
  const swimming = pose(held), body = matrices(rig);
  for (const dt of [0, -1, NaN, Infinity]) {
    tick(held, dt, water);
    posePlayerRig(rig, dt, water);
    assert.deepEqual(pose(held), swimming);
    assert.deepEqual(matrices(rig), body);
  }
  const exit = { ...water, swimming: false, moving: false };
  tick(held, 1 / 144, exit);
  assert.ok(held.swim.weight.value > 0.95);
  interval(2, 60, (dt) => tick(held, dt, exit));
  assert.ok(held.swim.weight.value < 1e-6);
  assert.ok(Math.abs(pose(held).y - idle.y) < 1e-7);
  const large = createHeldMotion(), bounded = createHeldMotion();
  tick(large, 600, water);
  tick(bounded, 0.1, water);
  assert.deepEqual(pose(large), pose(bounded));
});

test("wet feet/eyes are insufficient; seats, flight, ladders, death and unknown reset swimming", () => {
  for (const override of [
    { swimming: false }, { grounded: true }, { swimming: undefined },
    { seated: true }, { flying: true }, { climbing: true },
    { dead: true }, { fluidKnown: false }, { fluidKnown: undefined },
  ]) {
    const held = createHeldMotion(), rig = createPlayerRig();
    const state = { ...water, ...override, underwater: true, inWater: true };
    interval(1, 60, (dt) => { tick(held, dt, state); posePlayerRig(rig, dt, state); });
    assert.equal(held.swim.weight.value, 0);
    assert.equal(rig.swim.weight.value, 0);
  }
  for (const override of [
    { seated: true }, { flying: true }, { climbing: true },
    { dead: true }, { fluidKnown: false },
  ]) {
    const held = createHeldMotion(), rig = createPlayerRig();
    interval(1, 60, (dt) => { tick(held, dt, water); posePlayerRig(rig, dt, water); });
    tick(held, 0, { ...water, ...override });
    posePlayerRig(rig, 0, { ...water, ...override });
    assert.equal(held.swim.weight.value, 0);
    assert.equal(rig.swim.weight.value, 0);
  }
});

test("swimming removes walking bob and respects bob/reduced-motion preferences", () => {
  const held = createHeldMotion();
  interval(0.6, 60, (dt) => tick(held, dt, { fluidKnown: true, moving: true }));
  tick(held, 1 / 60, water);
  const swimming = pose(held);
  held.walkPhase += 1;
  assert.deepEqual(pose(held), swimming, "residual walking filter cannot bob in water");
  const reduced = pose(held, true);
  assert.deepEqual(reduced, pose(createHeldMotion()));
  tick(held, 0, { ...water, bob: false });
  assert.deepEqual(pose(held), reduced);
  const rig = createPlayerRig();
  posePlayerRig(rig, 0.1, { moving: true });
  posePlayerRig(rig, 0.1, water);
  assert.equal(rig.gait, 0);
});

test("food, bow, shield, mining, equip and strike retain priority over swim decoration", () => {
  for (const action of ["food", "bow", "shield", "mining", "equip", "strike"]) {
    const motion = createHeldMotion();
    interval(1, 60, (dt) => tick(motion, dt, water));
    const swimPose = pose(motion);
    assert.notDeepEqual(swimPose, pose(createHeldMotion()));
    // Isolate the compositor at the exact accepted action endpoint.
    motion[action].value = 1;
    const actionPose = pose(motion);
    motion.swim.weight.value = 0;
    assert.deepEqual(pose(motion), actionPose, `${action} must own the pose`);
  }
  const held = createHeldMotion();
  interval(0.3, 60, (dt) => tick(held, dt, water, "bow"));
  const before = pose(held);
  requestHeldSelection(held);
  assert.deepEqual(pose(held), before, "selection impulse cannot teleport pose");
});

test("hidden-view reset reuses channels and removes all stale swimming/action work", () => {
  const held = createHeldMotion(), swim = held.swim, channels = held.channels;
  interval(0.7, 60, (dt) => tick(held, dt, water, "food"));
  advanceHeldMotion(held, 0, false, false);
  assert.equal(held.swim, swim);
  assert.equal(held.channels, channels);
  assert.equal(swim.phase, 0);
  assert.equal(swim.weight.value, 0);
  assert.deepEqual(pose(held), pose(createHeldMotion()));
});
