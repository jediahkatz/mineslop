// Pure observation math. No Game/Player imports, action calls or state writes.
export const YAW_TOLERANCE = 0.01;
export const DRIVEN_HULL_TURN = 0.15;
export const COAST_HULL_TURN = 0.02;
export const shortestYawDelta = (after, before) =>
  Math.atan2(Math.sin(after - before), Math.cos(after - before));

function forwardOrientation(forward) {
  if (![forward?.x, forward?.y, forward?.z].every(Number.isFinite)) return null;
  const horizontal = Math.hypot(forward.x, forward.z);
  const length = Math.hypot(horizontal, forward.y);
  if (horizontal < 1e-8 || length < 1e-8) return null;
  return {
    cameraForward: {
      x: forward.x / length, y: forward.y / length, z: forward.z / length,
    },
    cameraYaw: Math.atan2(-forward.x, -forward.z),
    cameraPitch: Math.atan2(forward.y, horizontal),
  };
}

export function renderedCameraOrientation(matrixWorldElements) {
  if (matrixWorldElements?.length !== 16) return null;
  // A Three.js camera looks down its world matrix's negative Z basis. Read the
  // renderer-owned matrix verbatim: do not refresh it or derive it from Player.
  return forwardOrientation({
    x: -matrixWorldElements[8],
    y: -matrixWorldElements[9],
    z: -matrixWorldElements[10],
  });
}

function validView(view) {
  return [view?.hullYaw, view?.yaw, view?.pitch].every(Number.isFinite) &&
    Math.abs(view.hullYaw) <= Math.PI + 1e-12;
}

// This is only the yaw/pitch following predicate. A complete turn also needs
// nonzero canonical hull motion, a direction and independent camera evidence.
export function yawDeltaEvidence(before, after) {
  if (!validView(before) || !validView(after))
    return { passed: false, reason: "Missing finite view or canonical hull angles" };
  const hullDelta = shortestYawDelta(after.hullYaw, before.hullYaw);
  const viewDelta = shortestYawDelta(after.yaw, before.yaw);
  const deltaError = Math.abs(viewDelta - hullDelta);
  const offsetBefore = shortestYawDelta(before.yaw, before.hullYaw);
  const offsetAfter = shortestYawDelta(after.yaw, after.hullYaw);
  const offsetError = Math.abs(shortestYawDelta(offsetAfter, offsetBefore));
  const pitchDelta = after.pitch - before.pitch;
  return {
    passed: deltaError < YAW_TOLERANCE && offsetError < YAW_TOLERANCE &&
      Math.abs(pitchDelta) < YAW_TOLERANCE,
    hullDelta, viewDelta, deltaError, offsetBefore, offsetAfter, offsetError,
    pitchDelta,
  };
}

function maxima(comparisons) {
  return {
    maximumDeltaError: Math.max(...comparisons.map((value) => value.deltaError)),
    maximumOffsetError: Math.max(...comparisons.map((value) => value.offsetError)),
    maximumPitchError: Math.max(...comparisons.map((value) => Math.abs(value.pitchDelta))),
  };
}

export function turnFollowEvidence(samples, {
  minimumHullTurn = DRIVEN_HULL_TURN, direction,
} = {}) {
  if (!(minimumHullTurn > 0 && minimumHullTurn < Math.PI) ||
    ![-1, 1].includes(direction))
    throw new RangeError("A turn needs a positive minimum rotation and signed direction");
  if (!Array.isArray(samples) || samples.length < 3 ||
    samples.some((sample, index) => !validView(sample) ||
      !Number.isSafeInteger(sample.frame) ||
      (index > 0 && sample.frame <= samples[index - 1].frame)))
    return { passed: false, reason: "Need three advancing frames with canonical hull/view angles" };

  const cameraViews = samples.map((sample) => {
    const actual = forwardOrientation(sample.cameraForward);
    // Missing render data is a failure, never a fallback to the player's yaw.
    if (!actual || ![sample.cameraYaw, sample.cameraPitch].every(Number.isFinite))
      return null;
    return { hullYaw: sample.hullYaw, yaw: actual.cameraYaw, pitch: actual.cameraPitch };
  });
  if (cameraViews.some((sample) => sample === null))
    return { passed: false, reason: "Actual rendered camera heading/forward was not recorded" };
  if (samples.some((sample) =>
    ![sample.relativeViewYaw, sample.relativeCameraYaw].every(Number.isFinite)))
    return { passed: false, reason: "Wrapped player/camera free-look offsets were not recorded" };

  const pairs = [];
  for (let index = 1; index < samples.length; index++) {
    pairs.push([index - 1, index]);
    if (index > 1) pairs.push([0, index]);
  }
  // Both adjacent-frame and start-relative checks matter: an extra application
  // followed by a compensating error must not hide behind correct endpoints.
  const player = pairs.map(([a, b]) => yawDeltaEvidence(samples[a], samples[b]));
  const camera = pairs.map(([a, b]) => yawDeltaEvidence(cameraViews[a], cameraViews[b]));
  const first = samples[0], last = samples.at(-1);
  const hullDelta = shortestYawDelta(last.hullYaw, first.hullYaw);
  const playerDelta = shortestYawDelta(last.yaw, first.yaw);
  const cameraDelta = shortestYawDelta(cameraViews.at(-1).yaw, cameraViews[0].yaw);
  const maximumCameraYawAlignmentError = Math.max(...samples.map((sample, index) =>
    Math.abs(shortestYawDelta(cameraViews[index].yaw, sample.yaw))));
  const maximumCameraPitchAlignmentError = Math.max(...samples.map((sample, index) =>
    Math.abs(cameraViews[index].pitch - sample.pitch)));
  const maximumRecordedCameraError = Math.max(...samples.flatMap((sample, index) => [
    Math.abs(shortestYawDelta(cameraViews[index].yaw, sample.cameraYaw)),
    Math.abs(cameraViews[index].pitch - sample.cameraPitch),
  ]));
  const maximumRecordedOffsetError = Math.max(...samples.flatMap((sample) => [
    Math.abs(shortestYawDelta(sample.relativeViewYaw,
      shortestYawDelta(sample.yaw, sample.hullYaw))),
    Math.abs(shortestYawDelta(sample.relativeCameraYaw,
      shortestYawDelta(sample.cameraYaw, sample.hullYaw))),
  ]));
  return {
    passed: hullDelta * direction > minimumHullTurn &&
      player.every((value) => value.passed) && camera.every((value) => value.passed) &&
      maximumCameraYawAlignmentError < YAW_TOLERANCE &&
      maximumCameraPitchAlignmentError < YAW_TOLERANCE &&
      maximumRecordedCameraError < YAW_TOLERANCE &&
      maximumRecordedOffsetError < YAW_TOLERANCE,
    hullDelta, playerDelta, cameraDelta, direction, minimumHullTurn,
    tolerance: YAW_TOLERANCE,
    player: maxima(player), camera: maxima(camera),
    maximumCameraYawAlignmentError, maximumCameraPitchAlignmentError,
    maximumRecordedCameraError, maximumRecordedOffsetError,
  };
}
