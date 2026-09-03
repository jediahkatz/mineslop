import { MathUtils } from "three";

/** Reuse the output in the frame loop; this only describes outdoor lighting. */
export function sampleOutdoorLighting(sunHeight, output = {}) {
  const height = Number.isFinite(sunHeight)
    ? MathUtils.clamp(sunHeight, -1, 1)
    : 1;
  const daylight = MathUtils.smoothstep(height, -0.18, 0.35);
  output.daylight = daylight;
  output.warmth =
    (1 - MathUtils.smoothstep(Math.abs(height), 0.08, 0.7)) * daylight;
  output.sunWarmth = 1 - MathUtils.smoothstep(height, 0.05, 0.55);
  output.sunIntensity =
    (2.05 + 0.6 * MathUtils.smoothstep(height, 0, 1)) *
    MathUtils.smoothstep(height, 0, 0.24);
  output.moonIntensity =
    0.26 * MathUtils.smoothstep(-height, 0, 0.3) * (1 - daylight);
  // The same directional light follows the visible celestial body. Its power
  // reaches zero at the handoff, so neither nighttime under-light nor a pop is
  // introduced when the direction reverses.
  output.keySign = height >= 0 ? 1 : -1;
  output.keyIntensity =
    height >= 0 ? output.sunIntensity : output.moonIntensity;
  output.hemisphereIntensity = 0.5 + daylight * 0.98;
  return output;
}
