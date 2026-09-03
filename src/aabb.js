// Shapes use immutable block-local [minX,minY,minZ,maxX,maxY,maxZ] tuples.
export const BOX_EPSILON = 1e-7;
export const box = (...coordinates) => Object.freeze(coordinates);
export const UNIT_BOX = box(0, 0, 0, 1, 1, 1);
export const EMPTY_BOXES = Object.freeze([]);
export const boxes = (values) =>
  Object.freeze(values.map((value) => Object.freeze([...value])));

export const overlaps = (a, b, epsilon = BOX_EPSILON) =>
  a[0] < b[3] - epsilon &&
  a[3] > b[0] + epsilon &&
  a[1] < b[4] - epsilon &&
  a[4] > b[1] + epsilon &&
  a[2] < b[5] - epsilon &&
  a[5] > b[2] + epsilon;

export const containsPoint = (bounds, point, epsilon = 0) =>
  point[0] >= bounds[0] - epsilon &&
  point[0] <= bounds[3] + epsilon &&
  point[1] >= bounds[1] - epsilon &&
  point[1] <= bounds[4] + epsilon &&
  point[2] >= bounds[2] - epsilon &&
  point[2] <= bounds[5] + epsilon;

export const translateBox = (bounds, x, y, z) =>
  box(
    bounds[0] + x,
    bounds[1] + y,
    bounds[2] + z,
    bounds[3] + x,
    bounds[4] + y,
    bounds[5] + z
  );

export function rotateBox(bounds, turns) {
  let result = bounds;
  for (let i = 0; i < (turns & 3); i++)
    result = box(
      1 - result[5],
      result[1],
      result[0],
      1 - result[2],
      result[4],
      result[3]
    );
  return result;
}

export const boxVolume = (bounds) =>
  (bounds[3] - bounds[0]) * (bounds[4] - bounds[1]) * (bounds[5] - bounds[2]);

/** Disjoint remainder of a box after subtracting another box. */
export function subtractBox(source, cutter) {
  if (!overlaps(source, cutter)) return [source];
  const low = [0, 1, 2].map((axis) => Math.max(source[axis], cutter[axis]));
  const high = [0, 1, 2].map((axis) =>
    Math.min(source[axis + 3], cutter[axis + 3])
  );
  const result = [];
  const remainder = [...source];
  for (let axis = 0; axis < 3; axis++) {
    if (remainder[axis] < low[axis]) {
      const piece = [...remainder];
      piece[axis + 3] = low[axis];
      result.push(Object.freeze(piece));
      remainder[axis] = low[axis];
    }
    if (remainder[axis + 3] > high[axis]) {
      const piece = [...remainder];
      piece[axis] = high[axis];
      result.push(Object.freeze(piece));
      remainder[axis + 3] = high[axis];
    }
  }
  return result;
}

export function subtractBoxes(source, cutters) {
  let result = source;
  for (const cutter of cutters)
    result = result.flatMap((piece) => subtractBox(piece, cutter));
  return Object.freeze(result);
}

// Rectangles are [minU,minV,maxU,maxV]. Keeping exact strips, rather than a
// coarse coverage bit, prevents the uncovered half of a slab face disappearing.
export function subtractRectangle(source, cutter) {
  const u0 = Math.max(source[0], cutter[0]);
  const v0 = Math.max(source[1], cutter[1]);
  const u1 = Math.min(source[2], cutter[2]);
  const v1 = Math.min(source[3], cutter[3]);
  if (u1 <= u0 + BOX_EPSILON || v1 <= v0 + BOX_EPSILON) return [source];
  const result = [];
  if (source[0] < u0) result.push([source[0], source[1], u0, source[3]]);
  if (source[2] > u1) result.push([u1, source[1], source[2], source[3]]);
  if (source[1] < v0) result.push([u0, source[1], u1, v0]);
  if (source[3] > v1) result.push([u0, v1, u1, source[3]]);
  return result;
}

export function subtractRectangles(source, cutters) {
  let result = source;
  for (const cutter of cutters)
    result = result.flatMap((piece) => subtractRectangle(piece, cutter));
  return Object.freeze(result.map((rectangle) => Object.freeze(rectangle)));
}

/** Slab intersection; direction is in distance units (normally normalized).
 * Starting inside returns distance zero and a zero normal, as legacy picking did.
 */
export function intersectRayBox(
  origin,
  direction,
  bounds,
  maxDistance = Infinity
) {
  let near = -Infinity;
  let far = maxDistance;
  let normalAxis = -1;
  let normalSign = 0;
  for (let axis = 0; axis < 3; axis++) {
    if (Math.abs(direction[axis]) < 1e-12) {
      if (origin[axis] < bounds[axis] || origin[axis] > bounds[axis + 3])
        return null;
      continue;
    }
    const a = (bounds[axis] - origin[axis]) / direction[axis];
    const b = (bounds[axis + 3] - origin[axis]) / direction[axis];
    const entry = Math.min(a, b);
    if (entry > near) {
      near = entry;
      normalAxis = axis;
      normalSign = direction[axis] > 0 ? -1 : 1;
    }
    far = Math.min(far, Math.max(a, b));
    if (near > far + BOX_EPSILON) return null;
  }
  if (far < 0 || near > maxDistance + BOX_EPSILON) return null;
  const normal = [0, 0, 0];
  if (near >= 0 && normalAxis !== -1) normal[normalAxis] = normalSign;
  return { distance: Math.max(0, near), far, normal };
}
