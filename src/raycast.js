import { BOX_EPSILON, intersectRayBox, translateBox } from "./aabb.js";
import { resolveShape } from "./block-shapes.js";
import { readGeometryCell } from "./geometry-world.js";

const AXES = ["x", "y", "z"];
const OWNER_OFFSETS = [[0, 0, 0]];
for (let y = -1; y <= 1; y++)
  for (let z = -1; z <= 1; z++)
    for (let x = -1; x <= 1; x++)
      if (x || y || z) OWNER_OFFSETS.push([x, y, z]);

/**
 * DDA traversal with exact selection-box intersections. The one-cell owner
 * apron also visits shapes protruding from a neighbor (e.g. a fence's collision
 * channel); it is not enough to intersect only the voxel under the ray.
 *
 * Existing hit fields remain unchanged. `part` is a linked/half name where one
 * exists, otherwise the box index. `box` is the immutable local selected AABB.
 * `resolve` is an injectable pure resolver for geometry contract fixtures.
 */
export function raycast(
  world,
  origin,
  direction,
  maxDistance = 7,
  { channel = "selection", resolve = resolveShape } = {}
) {
  if (
    !origin ||
    !direction ||
    ![
      origin.x,
      origin.y,
      origin.z,
      direction.x,
      direction.y,
      direction.z,
      maxDistance,
    ].every(Number.isFinite) ||
    maxDistance < 0
  )
    return null;
  const length = Math.hypot(direction.x, direction.y, direction.z);
  if (!Number.isFinite(length) || !length) return null;
  const start = AXES.map((axis) => origin[axis]);
  const vector = AXES.map((axis) => direction[axis] / length);
  const voxel = start.map(Math.floor);
  if (!voxel.every(Number.isSafeInteger)) return null;
  const signs = vector.map(Math.sign);
  const delta = vector.map((component) =>
    component ? Math.abs(1 / component) : Infinity
  );
  const next = vector.map((component, axis) =>
    component
      ? (component > 0
          ? voxel[axis] + 1 - start[axis]
          : start[axis] - voxel[axis]) * delta[axis]
      : Infinity
  );
  const visited = new Set();
  const cells = new Map();
  const read = (x, y, z) => {
    const key = `${x},${y},${z}`;
    if (!cells.has(key)) cells.set(key, readGeometryCell(world, x, y, z));
    return cells.get(key);
  };
  let distance = 0;
  let best = null;
  while (distance <= maxDistance) {
    for (const [dx, dy, dz] of OWNER_OFFSETS) {
      const x = voxel[0] + dx,
        y = voxel[1] + dy,
        z = voxel[2] + dz;
      const key = `${x},${y},${z}`;
      if (visited.has(key)) continue;
      visited.add(key);
      const cell = read(x, y, z);
      if (!cell) continue;
      const shape = resolve(cell, (nx, ny, nz) => read(x + nx, y + ny, z + nz));
      const bounds = shape[channel];
      if (!bounds)
        throw new RangeError(`Unknown shape ray channel: ${channel}`);
      for (let boxIndex = 0; boxIndex < bounds.length; boxIndex++) {
        const localBox = bounds[boxIndex];
        const hit = intersectRayBox(
          start,
          vector,
          translateBox(localBox, x, y, z),
          best?.distance ?? maxDistance
        );
        if (!hit || (best && hit.distance >= best.distance - BOX_EPSILON))
          continue;
        const point = {
          x: origin.x + vector[0] * hit.distance,
          y: origin.y + vector[1] * hit.distance,
          z: origin.z + vector[2] * hit.distance,
        };
        best = {
          x,
          y,
          z,
          id: cell.id,
          state: cell.state ?? 0,
          fluid: cell.fluid,
          normal: { x: hit.normal[0], y: hit.normal[1], z: hit.normal[2] },
          distance: hit.distance,
          point,
          localPoint: { x: point.x - x, y: point.y - y, z: point.z - z },
          part: shape.part ?? boxIndex,
          boxIndex,
          box: localBox,
        };
      }
    }
    const boundary = Math.min(...next);
    if (best && best.distance <= boundary + BOX_EPSILON) return best;
    // Match historical tie order X, then Y, then Z. The apron already covers
    // every cell sharing an edge/corner, so grazing rays cannot miss a thin face.
    const axis =
      next[0] <= next[1] && next[0] <= next[2] ? 0 : next[1] <= next[2] ? 1 : 2;
    voxel[axis] += signs[axis];
    distance = next[axis];
    next[axis] += delta[axis];
  }
  return best;
}
