export function positivePixelControl(result) {
  return result?.status === "pass" && result.positiveSurface === true &&
    result.draws > 0 && result.nonzeroChannels > 0 && result.changedChannels > 0 &&
    result.restoredChannels === 0 && result.glError === 0 &&
    typeof result.poseKey === "string" && result.poseKey.length > 0;
}

export function recoveryGate(result) {
  return result.sawLost === true && result.contextRestored === true &&
    result.recoveryDisposals > 0 && result.retired === true &&
    positivePixelControl(result.before) && positivePixelControl(result.after) &&
    result.before.poseKey === result.after.poseKey &&
    Array.isArray(result.errors) && result.errors.length === 0;
}
