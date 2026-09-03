// Test-only allowance for subtracting separately accumulated simulation clocks.
// Fixed at one picosecond: it never scales with uptime or admits a shorter draw.
// The derived 20 x 0.05s case has a 3.55e-15s deficit despite exact ItemUse charge;
// those are derived operands, not the missing original browser-failure operands.
export const BOW_CLOCK_ROUNDOFF_SECONDS = 1e-12;

export function hasFullBowDraw(
  initialSimulationTime,
  currentSimulationTime,
  releaseUse
) {
  if (
    !Number.isFinite(initialSimulationTime) ||
    !Number.isFinite(currentSimulationTime) ||
    releaseUse?.active !== true ||
    releaseUse.kind !== "bow" ||
    releaseUse.progress !== 1
  )
    return false;
  const simulationSeconds = currentSimulationTime - initialSimulationTime;
  return (
    Number.isFinite(simulationSeconds) &&
    1 - simulationSeconds <= BOW_CLOCK_ROUNDOFF_SECONDS
  );
}
