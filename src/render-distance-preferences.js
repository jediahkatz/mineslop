import {
  DEFAULT_RENDER_RADIUS,
  MAX_RENDER_RADIUS,
  MIN_RENDER_RADIUS,
} from "./render-distance.js";

// Browser-local video preference; never included in portable world saves.
export const RENDER_DISTANCE_KEY = "voxelcraft-render-distance-v1";

export function normalizeRenderDistance(value) {
  return Number.isInteger(value) &&
    value >= MIN_RENDER_RADIUS && value <= MAX_RENDER_RADIUS
    ? value : DEFAULT_RENDER_RADIUS;
}

export function loadRenderDistance(storage) {
  try {
    const source = storage ?? globalThis.localStorage;
    return normalizeRenderDistance(
      JSON.parse(source?.getItem(RENDER_DISTANCE_KEY) ?? "null")
    );
  } catch {
    return DEFAULT_RENDER_RADIUS;
  }
}

export function saveRenderDistance(value, storage) {
  if (!Number.isInteger(value) ||
      value < MIN_RENDER_RADIUS || value > MAX_RENDER_RADIUS) return false;
  try {
    const target = storage ?? globalThis.localStorage;
    if (!target) return false;
    target.setItem(RENDER_DISTANCE_KEY, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
