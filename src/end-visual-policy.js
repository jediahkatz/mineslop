import { DISTANT_QUALITY } from "./distant-grid.js";

// The existing high-quality window, at every End position and generator version.
// Sampling density and detail radius still belong to the selected quality.
export const END_VISUAL_HORIZON = DISTANT_QUALITY.high.horizon;

export function visualHorizon(dimension, quality) {
  return dimension === "end"
    ? END_VISUAL_HORIZON
    : DISTANT_QUALITY[quality].horizon;
}

export function endVisualFog({
  dimension, outdoors, horizonVisible, terrainComplete, availableDistance,
  horizontalFar, detailFar, base, eyeY, minY, forward,
}) {
  // Never extend fog through missing geometry, stale coverage, caves or fluids.
  // The caller's existing streaming/depth policy remains authoritative there.
  if (dimension !== "end" || !outdoors || !horizonVisible || !terrainComplete)
    return base;

  const horizontal = Math.hypot(forward.x, forward.z);
  // A local native height disappears at island/void boundaries. The world floor
  // instead supplies a continuous reference plane for Three's view-depth fog.
  const floorDepth = Math.max(0, eyeY - minY) * Math.max(0, -forward.y);
  const farDepth = Math.max(8, horizontalFar * horizontal);
  const far = floorDepth + farDepth;
  const near = floorDepth + Math.min(farDepth - 1, farDepth * 0.95);
  // Reuse the renderer's coverage-driven expansion, not a spatial switch or a
  // timer hiding a radius discontinuity. At streaming distance this is a no-op.
  const blend = Math.max(0, Math.min(1,
    (Math.min(horizontalFar, availableDistance) - detailFar) /
      (END_VISUAL_HORIZON - detailFar)));
  if (blend === 1) return { near, far };
  return {
    near: base.near + (near - base.near) * blend,
    far: base.far + (far - base.far) * blend,
  };
}
