import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { PerspectiveCamera } from "three";
import {
  COAST_HULL_TURN,
  renderedCameraOrientation,
  shortestYawDelta,
  turnFollowEvidence,
  yawDeltaEvidence,
} from "./boat-survival/yaw-follow.mjs";

const wrap = (yaw) => shortestYawDelta(yaw, 0);
const options = { direction: 1 };

// Synthetic observations test the assertion only; they are not browser proof.
function sample(frame, hullYaw, yaw, {
  cameraYaw = yaw, pitch = -0.714, cameraPitch = pitch,
} = {}) {
  return {
    frame, hullYaw: wrap(hullYaw), yaw, pitch, cameraYaw: wrap(cameraYaw), cameraPitch,
    cameraForward: {
      x: -Math.sin(cameraYaw) * Math.cos(cameraPitch),
      y: Math.sin(cameraPitch),
      z: -Math.cos(cameraYaw) * Math.cos(cameraPitch),
    },
    relativeViewYaw: shortestYawDelta(yaw, hullYaw),
    relativeCameraYaw: shortestYawDelta(cameraYaw, hullYaw),
  };
}

const angles = [0, 0.12, 0.3, 0.55];
const following = () => angles.map((delta, frame) =>
  sample(frame, 1.5 + delta, 1.82 + delta));

test("camera orientation reads the actual world matrix without mutating it", () => {
  const camera = new PerspectiveCamera();
  const yaw = Math.PI - 0.03, pitch = -0.61;
  camera.rotation.set(pitch, yaw, 0, "YXZ");
  camera.updateMatrixWorld();
  const matrix = Object.freeze([...camera.matrixWorld.elements]);
  const before = [...matrix];
  const actual = renderedCameraOrientation(matrix);
  assert.ok(Math.abs(shortestYawDelta(actual.cameraYaw, yaw)) < 1e-12);
  assert.ok(Math.abs(actual.cameraPitch - pitch) < 1e-12);
  assert.ok(Math.abs(actual.cameraForward.x + Math.sin(yaw) * Math.cos(pitch)) < 1e-12);
  assert.ok(Math.abs(actual.cameraForward.y - Math.sin(pitch)) < 1e-12);
  assert.ok(Math.abs(actual.cameraForward.z + Math.cos(yaw) * Math.cos(pitch)) < 1e-12);
  assert.deepEqual(matrix, before);
  assert.equal(renderedCameraOrientation(null), null);
  assert.equal(renderedCameraOrientation(Array(16).fill(0)), null);
});

for (const direction of [1, -1]) {
  test(`once-only yaw follow crosses the ${direction > 0 ? "+" : "-"}pi hull seam`, () => {
    const observations = angles.map((delta, frame) => {
      const hull = direction * (3.05 + delta);
      return sample(frame, hull, hull + 0.47 + Math.PI * 8);
    });
    const before = structuredClone(observations);
    const evidence = turnFollowEvidence(observations, { direction });
    assert.equal(evidence.passed, true, JSON.stringify(evidence));
    assert.ok(Math.abs(evidence.hullDelta - direction * 0.55) < 1e-12);
    assert.ok(evidence.player.maximumDeltaError < 1e-12);
    assert.ok(evidence.camera.maximumDeltaError < 1e-12);
    assert.deepEqual(observations, before, "assertions cannot change observed state");
  });
}

test("nonzero hull rotation with frozen player/camera yaw is rejected", () => {
  const observations = angles.map((delta, frame) => sample(frame, 1.5 + delta, 1.82));
  const evidence = turnFollowEvidence(observations, options);
  assert.equal(evidence.passed, false);
  assert.ok(evidence.hullDelta > 0.15);
  assert.equal(evidence.playerDelta, 0);
  assert.equal(evidence.cameraDelta, 0);
  assert.ok(evidence.player.maximumDeltaError > 0.5);
  assert.ok(evidence.player.maximumOffsetError > 0.5);
});

test("applying the hull delta twice is rejected", () => {
  const observations = angles.map((delta, frame) =>
    sample(frame, 1.5 + delta, 1.82 + delta * 2));
  const evidence = turnFollowEvidence(observations, options);
  assert.equal(evidence.passed, false);
  assert.ok(evidence.player.maximumDeltaError > 0.5);
});

test("correct player yaw cannot mask a frozen actual render camera", () => {
  const observations = angles.map((delta, frame) =>
    sample(frame, 1.5 + delta, 1.82 + delta, { cameraYaw: 1.82 }));
  const evidence = turnFollowEvidence(observations, options);
  assert.equal(evidence.passed, false);
  assert.ok(evidence.player.maximumDeltaError < 1e-12);
  assert.equal(evidence.cameraDelta, 0);
  assert.ok(evidence.camera.maximumDeltaError > 0.5);
});

test("copied player-yaw metadata cannot mask a frozen camera forward vector", () => {
  const observations = following();
  for (const observation of observations)
    observation.cameraForward = { ...observations[0].cameraForward };
  const evidence = turnFollowEvidence(observations, options);
  assert.equal(evidence.passed, false);
  assert.ok(evidence.maximumRecordedCameraError > 0.5);
});

test("compensating errors at intermediate frames cannot hide behind good endpoints", () => {
  const observations = following();
  observations[1] = sample(1, 1.62, 2.06); // One extra 0.12-radian application.
  assert.equal(yawDeltaEvidence(observations[0], observations.at(-1)).passed, true);
  const evidence = turnFollowEvidence(observations, options);
  assert.equal(evidence.passed, false);
  assert.ok(evidence.player.maximumDeltaError > 0.11);
});

test("snapping free-look to the hull heading is rejected", () => {
  const observations = angles.map((delta, frame) =>
    sample(frame, 1.5 + delta, 1.5 + delta + (frame === 0 ? 0.32 : 0)));
  const evidence = turnFollowEvidence(observations, options);
  assert.equal(evidence.passed, false);
  assert.ok(evidence.player.maximumOffsetError > 0.31);
});

test("player and independently rendered pitch must both remain unchanged", () => {
  for (const field of ["pitch", "cameraPitch"]) {
    const observations = angles.map((delta, frame) =>
      sample(frame, 1.5 + delta, 1.82 + delta, { [field]: -0.714 + delta }));
    assert.equal(turnFollowEvidence(observations, options).passed, false, field);
  }
});

test("released coasting must keep following a nonzero same-direction hull turn", () => {
  for (const direction of [1, -1]) {
    const observations = [0, 0.04, 0.11, 0.2].map((delta, frame) =>
      sample(frame, 2.1 + delta * direction, 2.42 + delta * direction));
    const coast = { direction, minimumHullTurn: COAST_HULL_TURN };
    assert.equal(turnFollowEvidence(observations, coast).passed, true);
    const frozen = observations.map((observation, frame) =>
      sample(frame, observation.hullYaw, 2.42));
    assert.equal(turnFollowEvidence(frozen, coast).passed, false);
    assert.equal(turnFollowEvidence(observations, { ...coast, direction: -direction }).passed, false);
  }
});

test("zero motion, duplicate frames and missing actual camera observations cannot pass", () => {
  const still = [0, 1, 2].map((frame) => sample(frame, 1.5, 1.82));
  assert.equal(turnFollowEvidence(still, options).passed, false);
  assert.equal(turnFollowEvidence(still, {
    ...options, minimumHullTurn: COAST_HULL_TURN,
  }).passed, false);
  assert.equal(turnFollowEvidence(following().map((value) => ({
    ...value, frame: 1,
  })), options).passed, false);
  const missingCamera = turnFollowEvidence(following().map((value) => ({
    ...value, cameraForward: null,
  })), options);
  assert.equal(missingCamera.passed, false);
  assert.match(missingCamera.reason, /camera heading\/forward was not recorded/);
  assert.throws(() => turnFollowEvidence(following(), {
    ...options, minimumHullTurn: 0,
  }), /positive minimum/);
});

// Optional read-only replay of an external historical report; no recorded
// camera heading is invented and no machine-local report is a test dependency.
if (process.env.BOAT_SURVIVAL_YAW_BASELINE_REPORT) {
  test("the supplied historical report fails the corrected player-yaw predicate", async () => {
    const path = process.env.BOAT_SURVIVAL_YAW_BASELINE_REPORT;
    const report = JSON.parse(await readFile(path, "utf8"));
    const turns = report.controls.filter(({ keys }) =>
      keys.length === 1 && ["KeyA", "KeyD"].includes(keys[0]));
    assert.equal(turns.length, 2);
    for (const turn of turns) {
      const extract = (state) => ({
        hullYaw: state.boats[0].yaw, yaw: state.yaw, pitch: state.pitch,
      });
      const evidence = yawDeltaEvidence(extract(turn.before), extract(turn.after));
      assert.ok(Math.abs(evidence.hullDelta) > 0.15);
      assert.equal(evidence.viewDelta, 0, "historical player yaw stayed frozen");
      assert.equal(evidence.passed, false, "the old green steering claim must be rejected");
      assert.equal(turn.before.cameraYaw, undefined);
      assert.equal(turn.after.cameraYaw, undefined);
      assert.equal(turn.before.cameraForward, undefined);
      assert.equal(turn.after.cameraForward, undefined);
      console.log(JSON.stringify({
        baseline: path, key: turn.keys[0], hullDelta: evidence.hullDelta,
        playerDelta: evidence.viewDelta, deltaError: evidence.deltaError,
        relativeOffsetBefore: evidence.offsetBefore, relativeOffsetAfter: evidence.offsetAfter,
        relativeOffsetError: evidence.offsetError, playerYawPredicatePassed: evidence.passed,
        renderedCameraEvidence: "not recorded; not evaluated",
      }));
    }
  });
}
