export const PIXEL_PROOF_VERSION = 2;

export function positivePixelControl(result) {
  const positiveCount = value => Number.isSafeInteger(value) && value > 0;
  return result?.proofVersion === PIXEL_PROOF_VERSION && result.status === "pass" &&
    result.positiveSurface === true &&
    positiveCount(result.draws) && positiveCount(result.restoredDraws) &&
    positiveCount(result.nonzeroChannels) && positiveCount(result.changedChannels) &&
    result.restoredChannels === 0 && result.glError === 0 &&
    Array.isArray(result.glErrors) && result.glErrors.length === 3 && result.glErrors.every(code => code === 0) &&
    Array.isArray(result.errors) && result.errors.length === 0 &&
    ["normal", "nativeHidden", "restored"].every(key => result.rendered?.[key] === true) &&
    ["paid-edit-controlled", "settled-route"].includes(result.poseKind) &&
    typeof result.poseKey === "string" && result.poseKey.length > 0 &&
    result.poseRestored === true && typeof result.originalPoseKey === "string" &&
    result.originalPoseKey.length > 0 && result.restoredPoseKey === result.originalPoseKey;
}

export function recoveryGate(result) {
  return result.sawLost === true && result.contextRestored === true &&
    result.recoveryDisposals > 0 && result.retired === true &&
    positivePixelControl(result.before) && positivePixelControl(result.after) &&
    result.before.poseKey === result.after.poseKey &&
    Array.isArray(result.errors) && result.errors.length === 0;
}
