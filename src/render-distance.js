import { validateLightCapabilities } from "./light-page-layout.js";

// Full-detail distance and its required source/shape halos share one contract.
// Explicit distances are independent of effects; Nearby can use the old presets.
export const MIN_RENDER_RADIUS = 2;
export const MAX_RENDER_RADIUS = 12;
// Retained default for the extended-distance preference, not the main-app mode.
export const DEFAULT_RENDER_RADIUS = 12;
export const MAX_WORLD_RADIUS = MAX_RENDER_RADIUS + 2;
export const MAX_RESIDENT_CHUNKS = (MAX_WORLD_RADIUS * 2 + 1) ** 2;
export const NEARBY_RENDER_RADII = Object.freeze({ low: 2, medium: 3, high: 4 });
export const MAX_NEARBY_RENDER_RADIUS = 4;

export function renderDistanceLayout(radius) {
  if (!Number.isInteger(radius) || radius < 0 || radius > MAX_RENDER_RADIUS)
    throw new RangeError(`Expected render radius 0–${MAX_RENDER_RADIUS}`);
  return Object.freeze({
    radius,
    tiles: radius * 2 + 1,
    visibleChunks: (radius * 2 + 1) ** 2,
    sourceChunks: (radius * 2 + 3) ** 2,
    spareChunks: (radius * 2 + 5) ** 2,
  });
}

export function streamingDistanceLayout(radius) {
  const layout = renderDistanceLayout(radius);
  return Object.freeze({
    detailRadius: radius,
    sourceRadius: radius + 1,
    dependencyRadius: radius + 2,
    demandRadius: radius + 2,
    retentionRadius: radius + 2,
    demandChunks: layout.spareChunks,
    retainedChunks: layout.spareChunks,
  });
}

export function validateRenderDistanceOverride(radius, gl, height) {
  if (radius === null) return null;
  renderDistanceLayout(radius);
  if (radius < MIN_RENDER_RADIUS)
    throw new RangeError(`Expected render distance override ${MIN_RENDER_RADIUS}–${MAX_RENDER_RADIUS} or null`);
  validateLightCapabilities(gl, height, radius);
  return radius;
}
