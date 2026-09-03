import { noise } from "./noise.js";

// Exact interval union: never raise a floor, lower a ceiling, or fill cave air.
// Merging before decoration also prevents moss/vines on a removed internal roof.
export function mergeCaveIntervals(intervals) {
  const merged = [];
  for (const [low, high] of [...intervals].sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last && low <= last[1] + 1) last[1] = Math.max(last[1], high);
    else merged.push([low, high]);
  }
  return merged;
}

// v3 only. Warped contour passages join local caverns, leaving real rock between
// them. Presence, floor relief and roof relief have different wavelengths: a
// high chamber-density value cannot create an enormous level underground hall.
// Both the voxel generator and entrance planner use this same column sampler.
// No 3D noise, neighboring columns, caches or surface-feature planning here.
export function sampleCaveIntervals(x, z, top, salt, waterLevel) {
  if (top <= waterLevel + 2) return [];
  const wx = x + (noise(x / 57, z / 57, salt ^ 21911) - 0.5) * 16;
  const wz = z + (noise(x / 57, z / 57, salt ^ 48973) - 0.5) * 16;
  const tunnel =
    1 - Math.abs(noise(wx / 30, wz / 30, salt ^ 3371) - 0.5) / 0.085;
  const room = (noise(wx / 23, wz / 23, salt ^ 31543) - 0.57) / 0.3;
  const upper = Math.min(1, Math.max(tunnel * 0.56, room));
  const deep = 1 - Math.abs(noise(wx / 25, wz / 25, salt ^ 7331) - 0.5) / 0.07;
  const detail = noise(x / 9, z / 9, salt ^ 2879);
  const intervals = [];
  const add = (presence, floor, height) => {
    if (presence <= 0) return;
    const low = Math.floor(floor);
    const high = Math.min(top - 5, low + Math.floor(height));
    if (high - low >= 2) intervals.push([low, high]);
  };
  add(deep, 4 + noise(x / 19, z / 19, salt ^ 1747) * 4 + detail, 2 + deep * 4);
  add(
    upper,
    11 +
      noise(x / 26, z / 26, salt ^ 16231) * 9 +
      detail * 3 +
      (1 - upper) * 1.5,
    2 + upper * 9 + noise(x / 11, z / 11, salt ^ 4639) * 2
  );
  return mergeCaveIntervals(intervals);
}
