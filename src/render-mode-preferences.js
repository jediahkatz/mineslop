import {
  MAX_NEARBY_RENDER_RADIUS,
  MAX_RENDER_RADIUS,
  MIN_RENDER_RADIUS,
  NEARBY_RENDER_RADII,
} from "./render-distance.js";
import { normalizeRenderDistance } from "./render-distance-preferences.js";

// A separate browser-local preference keeps the previous extended-distance
// value intact. Merely loading a world never migrates or writes either key.
export const RENDER_MODE_KEY = "voxelcraft-render-mode-v1";
export const DEFAULT_RENDER_MODE = Object.freeze({
  version: 1,
  mode: "nearby",
  nearbyRadius: null,
});

export const isRenderMode = (value) => value === "nearby" || value === "extended";
const nearbyRadius = (value) => value === null ||
  (Number.isInteger(value) && value >= MIN_RENDER_RADIUS && value <= MAX_NEARBY_RENDER_RADIUS);

function readPreferences(value) {
  if (!value || typeof value !== "object") return null;
  try {
    if (Array.isArray(value)) return null;
    const fields = Object.getOwnPropertyDescriptors(value);
    if (!["version", "mode", "nearbyRadius"].every((key) =>
      Object.hasOwn(fields[key] ?? {}, "value"))) return null;
    const version = fields.version.value;
    const mode = fields.mode.value;
    const radius = fields.nearbyRadius.value;
    if (version !== 1 || !isRenderMode(mode) || !nearbyRadius(radius)) return null;
    return Object.freeze({ version, mode, nearbyRadius: radius });
  } catch {
    return null;
  }
}

export function normalizeRenderModePreferences(value) {
  return readPreferences(value) ?? DEFAULT_RENDER_MODE;
}

export function loadRenderModePreferences(storage) {
  try {
    const source = storage ?? globalThis.localStorage;
    return normalizeRenderModePreferences(JSON.parse(source?.getItem(RENDER_MODE_KEY) ?? "null"));
  } catch {
    return DEFAULT_RENDER_MODE;
  }
}

export function saveRenderModePreferences(value, storage) {
  const preferences = readPreferences(value);
  if (!preferences) return false;
  try {
    const target = storage ?? globalThis.localStorage;
    if (!target) return false;
    target.setItem(RENDER_MODE_KEY, JSON.stringify(preferences));
    return true;
  } catch {
    return false;
  }
}

/** Resolve a view policy, never rewrite the remembered extended distance. */
export function resolveRenderMode(value, extendedRadius, quality = "medium") {
  const preferences = normalizeRenderModePreferences(value);
  const extended = preferences.mode === "extended";
  const override = extended ? normalizeRenderDistance(extendedRadius) : preferences.nearbyRadius;
  const preset = NEARBY_RENDER_RADII[Object.hasOwn(NEARBY_RENDER_RADII, quality) ? quality : "medium"];
  return Object.freeze({
    mode: preferences.mode,
    distantTerrain: extended,
    override,
    radius: override ?? preset,
    maxRadius: extended ? MAX_RENDER_RADIUS : MAX_NEARBY_RENDER_RADIUS,
  });
}
