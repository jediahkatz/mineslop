/** Presentation-only scalars. Never retains effect owners or save data. */
export function visualStrength(value) {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

export function playerVisionStrength(nightVision, conduitPower, medium) {
  const strength = Math.max(
    visualStrength(nightVision),
    Number(conduitPower === true && medium.cameraMediumKnown === true &&
      medium.underwater === true && medium.inLava !== true)
  );
  return strength * strength * (3 - 2 * strength);
}

/** Water visibility never borrows the distant surface terrain's horizon. */
export function playerWaterFogFar(strength, admittedDistance) {
  const cap = Number.isFinite(admittedDistance) ? Math.max(2, admittedDistance) : 2;
  return Math.min(cap, 20 + 28 * visualStrength(strength));
}
