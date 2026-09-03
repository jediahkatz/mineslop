import { BOX_EPSILON, containsPoint, subtractRectangles } from "./aabb.js";
import { BLOCK, BLOCKS } from "./blocks.js";
import { AO, appendQuad, CORNERS, FACES } from "./mesh-geometry.js";
import { blockBatch, leafBlock, opaqueCube } from "./mesh-palette.js";

function rectangle(bounds, face) {
  const u = face.uAxis,
    v = face.vAxis;
  return [
    face.u[u] > 0 ? bounds[u] - face.o[u] : face.o[u] - bounds[u + 3],
    face.v[v] > 0 ? bounds[v] - face.o[v] : face.o[v] - bounds[v + 3],
    face.u[u] > 0 ? bounds[u + 3] - face.o[u] : face.o[u] - bounds[u],
    face.v[v] > 0 ? bounds[v + 3] - face.o[v] : face.o[v] - bounds[v],
  ];
}

function coversPlane(bounds, face, plane, coplanar = false) {
  const low = bounds[face.axis],
    high = bounds[face.axis + 3];
  if (face.n[face.axis] > 0)
    return (
      low <= plane + BOX_EPSILON &&
      (high > plane + BOX_EPSILON ||
        (coplanar && Math.abs(high - plane) <= BOX_EPSILON))
    );
  return (
    high >= plane - BOX_EPSILON &&
    (low < plane - BOX_EPSILON ||
      (coplanar && Math.abs(low - plane) <= BOX_EPSILON))
  );
}

function occludesPoint(snapshot, point) {
  const x = Math.floor(point[0]),
    y = Math.floor(point[1]),
    z = Math.floor(point[2]);
  const cell = snapshot.cellAt(x, y, z);
  if (!cell) return 0;
  if (opaqueCube[cell.id]) return 1;
  const shape = snapshot.shapeAt(x, y, z);
  return Number(
    shape.occlusion.some((bounds) =>
      containsPoint(bounds, [point[0] - x, point[1] - y, point[2] - z])
    )
  );
}

function vertexOcclusion(snapshot, point, face, a, b) {
  const epsilon = 0.00001;
  const sample = (u, v) =>
    occludesPoint(
      snapshot,
      point.map(
        (value, axis) =>
          value +
          face.n[axis] * epsilon +
          face.u[axis] * u * epsilon +
          face.v[axis] * v * epsilon
      )
    );
  const u = a ? 1 : -1,
    v = b ? 1 : -1;
  const sideA = sample(u, -v);
  const sideB = sample(-u, v);
  return sideA && sideB ? 3 : sideA + sideB + sample(u, v);
}

export function faceTexture(shape, face) {
  if (shape.textureAxis === "y") return { tile: face.tile, rotate: false };
  const axis = shape.textureAxis === "x" ? 0 : 2;
  if (face.n[axis])
    return { tile: face.n[axis] > 0 ? "top" : "bottom", rotate: false };
  return { tile: "side", rotate: !!face.u[axis] };
}

/** Emits the boundary of a union of boxes, subtracting exact covered strips.
 * Occlusion is independent of collision: a fence's invisible upper half never
 * punches a hole in a neighboring block, and glass never hides an opaque face.
 */
export function appendShape(
  context,
  snapshot,
  x,
  y,
  z,
  id,
  shape,
  atlas,
  tintFor,
  biome,
  { channel = "render", materialId = id } = {}
) {
  const definition = BLOCKS[materialId];
  const batch = blockBatch[materialId];
  const fluid =
    channel === "fluidVolume" ||
    materialId === BLOCK.WATER ||
    materialId === BLOCK.LAVA;
  const source = shape[channel];
  const host =
    channel === "fluidVolume" && id !== BLOCK.WATER && id !== BLOCK.LAVA
      ? shape.render
      : [];
  for (let index = 0; index < source.length; index++) {
    const bounds = source[index];
    for (const face of FACES) {
      const plane = bounds[face.axis + (face.n[face.axis] > 0 ? 3 : 0)];
      const cuts = [];
      for (let other = 0; other < source.length; other++) {
        if (
          other !== index &&
          coversPlane(source[other], face, plane, other < index)
        )
          cuts.push(rectangle(source[other], face));
      }
      for (const other of host)
        if (coversPlane(other, face, plane)) cuts.push(rectangle(other, face));
      const onBoundary =
        Math.abs(plane - (face.n[face.axis] > 0 ? 1 : 0)) < BOX_EPSILON;
      if (onBoundary) {
        const nx = x + face.n[0],
          ny = y + face.n[1],
          nz = z + face.n[2];
        const neighbor = snapshot.cellAt(nx, ny, nz);
        if (neighbor) {
          if (opaqueCube[neighbor.id]) continue;
          const otherShape = snapshot.shapeAt(nx, ny, nz);
          const matching =
            (neighbor.id === id &&
              (definition.transparent || batch === "glass" || fluid)) ||
            (leafBlock[id] && leafBlock[neighbor.id]);
          if (otherShape.fullOcclusion || (matching && otherShape.fullCube))
            continue;
          let occlusion = matching ? otherShape.render : otherShape.occlusion;
          if (fluid && otherShape.fluid === shape.fluid)
            occlusion = [...otherShape.occlusion, ...otherShape.fluidVolume];
          for (const other of occlusion) {
            const shifted = other.map(
              (value, axis) => value + face.n[axis % 3]
            );
            if (coversPlane(shifted, face, plane))
              cuts.push(rectangle(shifted, face));
          }
        }
      }
      const patches = cuts.length
        ? subtractRectangles([rectangle(bounds, face)], cuts)
        : [rectangle(bounds, face)];
      if (!patches.length) continue;
      const texture = fluid
        ? { tile: face.tile, rotate: false }
        : faceTexture(shape, face);
      const [u0, v0, u1, v1] = atlas.uvFor(
        materialId,
        texture.tile,
        shape.part
      );
      const tint = tintFor(materialId, texture.tile, biome);
      for (const [a0, b0, a1, b1] of patches) {
        const points = [],
          uv = [],
          shades = [],
          colors = [];
        for (const [a, b] of CORNERS) {
          const u = a ? a1 : a0,
            v = b ? b1 : b0;
          const point = face.o.map(
            (value, axis) => value + face.u[axis] * u + face.v[axis] * v
          );
          point[face.axis] = plane;
          const worldPoint = [point[0] + x, point[1] + y, point[2] + z];
          points.push(worldPoint);
          const occlusion =
            fluid || batch === "glass" || definition.emissive
              ? 0
              : vertexOcclusion(snapshot, worldPoint, face, a, b);
          const shade = definition.emissive
            ? 0.86 + face.shade * 0.14
            : face.shade * AO[occlusion];
          shades.push(shade);
          colors.push(tint.map((value) => value * shade));
          const tu = texture.rotate ? v : u;
          const tv = texture.rotate
            ? 1 - u
            : fluid && id === materialId && face.vAxis === 1
              ? v / bounds[4]
              : v;
          uv.push([u0 + (u1 - u0) * tu, v0 + (v1 - v0) * tv]);
        }
        appendQuad(context, batch, points, face.n, uv, colors, shades);
      }
    }
  }
}
