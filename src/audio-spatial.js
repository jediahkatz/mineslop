import { clamp } from "./audio-dsp.js";

export const ANIMAL_AUDIO_RADIUS = 24;
export const MAX_AUDIO_RADIUS = 32;
export const NEAR_AUDIO_RADIUS = 2;

const vector = (value) =>
  value &&
  Number.isFinite(value.x) &&
  Number.isFinite(value.y) &&
  Number.isFinite(value.z);

/**
 * World units are blocks. Explicit distance/pan override the camera calculation.
 * Pan is -1 left, +1 right; camera right is its world-space local +X column.
 * Missing position/distance denotes a local cue, not a source at world origin.
 */
export function spatialSound(
  options = {},
  listener = null,
  radius = ANIMAL_AUDIO_RADIUS
) {
  if (!options || typeof options !== "object" || Array.isArray(options))
    return null;
  for (const field of ["distance", "pan", "volume", "maxDistance"]) {
    if (options[field] !== undefined && !Number.isFinite(options[field]))
      return null;
  }
  let distance = 0;
  let pan = 0;
  if (options.position !== undefined) {
    if (!vector(options.position)) return null;
    if (vector(listener?.position)) {
      const dx = options.position.x - listener.position.x;
      const dy = options.position.y - listener.position.y;
      const dz = options.position.z - listener.position.z;
      distance = Math.hypot(dx, dy, dz);
      if (distance > 0 && vector(listener.right)) {
        const length = Math.hypot(
          listener.right.x,
          listener.right.y,
          listener.right.z
        );
        if (Number.isFinite(length) && length > 0)
          pan =
            (dx * listener.right.x +
              dy * listener.right.y +
              dz * listener.right.z) /
            (distance * length);
      }
    } else if (options.distance === undefined) {
      return null;
    }
  }
  distance = options.distance ?? distance;
  if (!Number.isFinite(distance) || distance < 0) return null;
  pan = clamp(options.pan ?? pan, -1, 1);
  if (!Number.isFinite(pan) || !Number.isFinite(radius)) return null;
  const reach = clamp(
    options.maxDistance ?? radius,
    NEAR_AUDIO_RADIUS + 1,
    MAX_AUDIO_RADIUS
  );
  const attenuation =
    distance <= NEAR_AUDIO_RADIUS
      ? 1
      : clamp((reach - distance) / (reach - NEAR_AUDIO_RADIUS), 0, 1) ** 2;
  return {
    distance,
    pan,
    gain: attenuation * clamp(options.volume ?? 1, 0, 1),
  };
}
