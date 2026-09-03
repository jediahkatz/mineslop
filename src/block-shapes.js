import {
  box,
  boxes,
  EMPTY_BOXES,
  UNIT_BOX,
  rotateBox,
  subtractBoxes,
  subtractRectangles,
} from "./aabb.js";
import {
  BLOCK_STATE,
  defaultFluidFor,
  FLUID,
  isWaterFluid,
} from "./block-state.js";
import { BLOCK, BLOCKS } from "./blocks.js";
import {
  bedGeometry,
  doorGeometry,
  fenceGeometry,
  FACING_NAMES,
  gateGeometry,
  HORIZONTAL_DIRECTIONS,
  stairGeometry,
} from "./shape-connections.js";

export { HORIZONTAL_DIRECTIONS, FACING_NAMES } from "./shape-connections.js";
export { UNIT_BOX } from "./aabb.js";

const FULL = Object.freeze([UNIT_BOX]);
const NO_NEIGHBORS = () => null;
const cache = new Map();
const MAX_CACHED_SHAPES = 2048;
const RECTANGLE = Object.freeze([0, 0, 1, 1]);
export const SHAPE_FACES = Object.freeze({
  east: Object.freeze({ axis: 0, sign: 1, axes: Object.freeze([2, 1]) }),
  west: Object.freeze({ axis: 0, sign: -1, axes: Object.freeze([2, 1]) }),
  up: Object.freeze({ axis: 1, sign: 1, axes: Object.freeze([0, 2]) }),
  down: Object.freeze({ axis: 1, sign: -1, axes: Object.freeze([0, 2]) }),
  south: Object.freeze({ axis: 2, sign: 1, axes: Object.freeze([0, 1]) }),
  north: Object.freeze({ axis: 2, sign: -1, axes: Object.freeze([0, 1]) }),
});

const full = (channel) =>
  channel.length === 1 &&
  channel[0].every((value, index) => value === UNIT_BOX[index]);

/** Boundary rectangles occupied by the requested channel. */
export function faceCoverage(shape, face, channel = "occlusion") {
  const {
    axis,
    sign,
    axes: [u, v],
  } = SHAPE_FACES[face];
  const plane = sign > 0 ? 1 : 0;
  return Object.freeze(
    shape[channel]
      .filter((bounds) => bounds[axis] <= plane && bounds[axis + 3] >= plane)
      .map((bounds) =>
        Object.freeze([
          Math.max(0, bounds[u]),
          Math.max(0, bounds[v]),
          Math.min(1, bounds[u + 3]),
          Math.min(1, bounds[v + 3]),
        ])
      )
  );
}

export function coversFace(shape, face, channel = "support") {
  return (
    subtractRectangles([RECTANGLE], faceCoverage(shape, face, channel))
      .length === 0
  );
}

function sturdyCell(cell, facing, neighborhood = NO_NEIGHBORS) {
  if (!cell || !BLOCKS[cell.id]?.solid) return false;
  // A structural face must cover the entire cell face. A fence post, open gate
  // or thin ladder is not a wall. Exclude recursive link consumers, but let
  // stairs inspect actual cells around the support to resolve their corners.
  const kind = BLOCKS[cell.id].shape;
  if (["fence", "fence_gate", "ladder", "door", "bed"].includes(kind))
    return false;
  return coversFace(resolveShape(cell, neighborhood), FACING_NAMES[facing]);
}

function ladderGeometry(state, neighborhood) {
  const facing = state & BLOCK_STATE.FACING_MASK;
  const [dx, , dz] = HORIZONTAL_DIRECTIONS[(facing + 2) & 3];
  const valid = sturdyCell(neighborhood(dx, 0, dz), facing, (x, y, z) =>
    neighborhood(dx + x, y, dz + z)
  );
  const render = [
    box(2 / 16, 0, 14 / 16, 4 / 16, 1, 1),
    box(12 / 16, 0, 14 / 16, 14 / 16, 1, 1),
  ];
  for (const y of [1 / 16, 5 / 16, 9 / 16, 13 / 16])
    render.push(box(4 / 16, y, 14 / 16, 12 / 16, y + 2 / 16, 1));
  return {
    render: boxes(render.map((bounds) => rotateBox(bounds, facing))),
    collision: EMPTY_BOXES,
    selection: boxes([rotateBox(box(0, 0, 13 / 16, 1, 1, 1), facing)]),
    support: EMPTY_BOXES,
    climbable: valid,
    facing,
    attachment: Object.freeze({
      offset: Object.freeze([dx, 0, dz]),
      face: FACING_NAMES[facing],
      valid,
    }),
  };
}

function fluidHeight(fluid, neighborhood) {
  if (fluid === FLUID.NONE) return 0;
  const above = neighborhood(0, 1, 0);
  const aboveFluid = above
    ? (above.fluid ?? defaultFluidFor(above.id))
    : FLUID.NONE;
  if (
    (isWaterFluid(fluid) && isWaterFluid(aboveFluid)) ||
    (fluid === FLUID.LAVA_SOURCE && aboveFluid === FLUID.LAVA_SOURCE) ||
    fluid === FLUID.WATER_FALLING
  )
    return 1;
  if (fluid >= FLUID.WATER_1 && fluid <= FLUID.WATER_7) return (9 - fluid) / 9;
  // Preserve the historical source surface, including old water/lava saves.
  return 0.88;
}

function finish(cell, definition, geometry, neighborhood) {
  const render = geometry.render ?? EMPTY_BOXES;
  const collision =
    geometry.collision ?? (definition.solid ? render : EMPTY_BOXES);
  const selection = geometry.selection ?? render;
  const support = geometry.support ?? collision;
  const occlusion =
    geometry.occlusion ??
    (!definition.transparent && definition.texture !== "glass"
      ? render
      : EMPTY_BOXES);
  const fluid = cell.fluid ?? defaultFluidFor(cell.id);
  const liquid = cell.id === BLOCK.WATER || cell.id === BLOCK.LAVA;
  const occupied =
    liquid || definition.shape === "cross" ? EMPTY_BOXES : render;
  const fluidCapacity = subtractBoxes(FULL, occupied);
  const height = fluidHeight(fluid, neighborhood);
  const fluidVolume =
    height > 0
      ? subtractBoxes(fluidCapacity, [box(0, height, 0, 1, 1, 1)])
      : EMPTY_BOXES;
  const openFaces = {};
  const capacityShape = { occupied };
  for (const face of Object.keys(SHAPE_FACES))
    openFaces[face] = subtractRectangles(
      [RECTANGLE],
      faceCoverage(capacityShape, face, "occupied")
    );
  return Object.freeze({
    kind: definition.shape,
    part: null,
    climbable: false,
    textureAxis:
      definition.directional === "axis"
        ? cell.state & BLOCK_STATE.AXIS_X
          ? "x"
          : cell.state & BLOCK_STATE.AXIS_Z
            ? "z"
            : "y"
        : "y",
    ...geometry,
    render: liquid ? fluidVolume : render,
    collision,
    selection: liquid ? EMPTY_BOXES : selection,
    support,
    occlusion,
    fluid,
    fluidVolume,
    fluidCapacity,
    openFaces: Object.freeze(openFaces),
    fullCube: full(render) && !liquid,
    fullCollision: full(collision),
    fullOcclusion: full(occlusion),
  });
}

/**
 * Pure resolved channels. The callback reads relative cells and may return null
 * at unloaded/bounded edges; it never loads neighbors. All returned AABBs and
 * channel arrays are frozen. Collision is intentionally not inferred from art.
 */
export function resolveShape(cell, neighborhood = NO_NEIGHBORS) {
  const id = cell?.id ?? BLOCK.AIR;
  const definition = BLOCKS[id] ?? BLOCKS[BLOCK.AIR];
  const state = cell?.state ?? 0;
  const value = { id, state, fluid: cell?.fluid ?? defaultFluidFor(id) };
  const kind = definition.shape;
  const connected = ["stairs", "door", "fence", "ladder", "bed"].includes(kind);
  const fluid = value.fluid;
  const height = fluidHeight(fluid, neighborhood);
  const key = `${id}:${state}:${fluid}:${height}`;
  if (!connected && cache.has(key)) return cache.get(key);
  let geometry;
  if (id === BLOCK.AIR || !BLOCKS[id]) {
    geometry = { render: EMPTY_BOXES, collision: EMPTY_BOXES };
  } else if (kind === "slab") {
    geometry = {
      render:
        state & BLOCK_STATE.DOUBLE
          ? FULL
          : boxes([
              state & BLOCK_STATE.TOP
                ? box(0, 0.5, 0, 1, 1, 1)
                : box(0, 0, 0, 1, 0.5, 1),
            ]),
      part:
        state & BLOCK_STATE.DOUBLE
          ? "double"
          : state & BLOCK_STATE.TOP
            ? "top"
            : "bottom",
    };
  } else if (kind === "stairs") {
    geometry = stairGeometry(value, neighborhood);
  } else if (kind === "door") {
    geometry = doorGeometry(value, neighborhood);
  } else if (kind === "trapdoor") {
    const top = !!(state & BLOCK_STATE.TOP);
    const open = !!(state & BLOCK_STATE.OPEN);
    geometry = {
      render: boxes([
        open
          ? rotateBox(
              box(0, 0, 13 / 16, 1, 1, 1),
              state & BLOCK_STATE.FACING_MASK
            )
          : box(0, top ? 13 / 16 : 0, 0, 1, top ? 1 : 3 / 16, 1),
      ]),
      open,
      part: top ? "top" : "bottom",
    };
  } else if (kind === "fence") {
    geometry = fenceGeometry(value, neighborhood, sturdyCell);
  } else if (kind === "fence_gate") {
    geometry = gateGeometry(state);
  } else if (kind === "ladder") {
    geometry = ladderGeometry(state, neighborhood);
  } else if (kind === "bed") {
    geometry = bedGeometry(value, neighborhood);
    geometry.selection = geometry.collision;
  } else if (kind === "cross") {
    // Crosses retain the old crossed-quad renderer. Selection has a volume,
    // but plants never become solid just because their sprite fills a cell.
    geometry = { render: EMPTY_BOXES, selection: FULL, collision: EMPTY_BOXES };
    if (id === BLOCK.LILY_PAD)
      geometry.selection = boxes([box(0.02, 0, 0.02, 0.98, 0.08, 0.98)]);
  } else {
    geometry = { render: FULL };
  }
  const shape = finish(value, definition, geometry, neighborhood);
  if (!connected) {
    if (cache.size >= MAX_CACHED_SHAPES)
      cache.delete(cache.keys().next().value);
    cache.set(key, shape);
  }
  return shape;
}

/** Whether a new attachment can use the selected exact support face. */
export function canAttachToFace(cell, face, neighborhood = NO_NEIGHBORS) {
  return (
    Object.hasOwn(SHAPE_FACES, face) &&
    coversFace(resolveShape(cell, neighborhood), face)
  );
}
