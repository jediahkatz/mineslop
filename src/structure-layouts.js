import { BLOCK_STATE as S, FLUID } from "./block-state.js";

export const STRUCTURE_LAYOUT_VERSION = 1;

const facingBlocks = new Set([
  "OAK_STAIRS",
  "OAK_DOOR",
  "OAK_TRAPDOOR",
  "OAK_FENCE_GATE",
  "WHITE_BED",
  "LADDER",
  "NETHER_BRICK_STAIRS",
]);
const axisBlocks = new Set(["OAK_LOG", "SPRUCE_LOG", "ACACIA_LOG", "BASALT"]);
const wetShapes = new Set([
  "OAK_SLAB",
  "OAK_STAIRS",
  "OAK_TRAPDOOR",
  "OAK_FENCE",
  "LADDER",
]);
const directions = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

export function rotateStructureXZ(x, z, rotation) {
  switch (rotation) {
    case 0:
      return [x, z];
    case 1:
      return [-z, x];
    case 2:
      return [-x, -z];
    case 3:
      return [z, -x];
    default:
      throw new RangeError("Structure rotation must be 0, 1, 2 or 3");
  }
}

export function structurePoint(descriptor, x, y, z) {
  const [rx, rz] = rotateStructureXZ(x, z, descriptor.rotation);
  return {
    x: descriptor.origin.x + rx,
    y: descriptor.origin.y + y,
    z: descriptor.origin.z + rz,
  };
}

/** Local/world bounds are half-open cell bounds, including at negative X/Z. */
export function structureBounds(descriptor, bounds) {
  const [x0, y0, z0, x1, y1, z1] = bounds;
  const corners = [
    structurePoint(descriptor, x0, y0, z0),
    structurePoint(descriptor, x0, y0, z1 - 1),
    structurePoint(descriptor, x1 - 1, y0, z0),
    structurePoint(descriptor, x1 - 1, y0, z1 - 1),
  ];
  return {
    minX: Math.min(...corners.map((p) => p.x)),
    minY: descriptor.origin.y + y0,
    minZ: Math.min(...corners.map((p) => p.z)),
    maxX: Math.max(...corners.map((p) => p.x)) + 1,
    maxY: descriptor.origin.y + y1,
    maxZ: Math.max(...corners.map((p) => p.z)) + 1,
  };
}

export function rotateStructureState(block, state, rotation) {
  if (facingBlocks.has(block))
    return (
      (state & ~S.FACING_MASK) |
      (((state & S.FACING_MASK) + rotation) & S.FACING_MASK)
    );
  if (axisBlocks.has(block) && rotation & 1) {
    const axis = state & (S.AXIS_X | S.AXIS_Z);
    return (
      (state & ~(S.AXIS_X | S.AXIS_Z)) |
      (axis === S.AXIS_X ? S.AXIS_Z : axis === S.AXIS_Z ? S.AXIS_X : 0)
    );
  }
  return state;
}

export function freezeStructureData(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeStructureData(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * All brush ranges are INCLUSIVE. Each callback receives a canonical block
 * NAME, not an allocated ID. Only the catalog's validated emission adapter
 * resolves names. There are no reads, clipping feedback, loot or world state.
 */
export function createStructureBrush(descriptor, write) {
  const wet = (y) =>
    Number.isInteger(descriptor.waterLevel) &&
    descriptor.origin.y + y <= descriptor.waterLevel;
  const emptyBlock = (y) => (wet(y) ? "WATER" : "AIR");
  const set = (x, y, z, block, state = 0) => {
    const p = structurePoint(descriptor, x, y, z);
    const fluid =
      block === "WATER" || (wet(y) && wetShapes.has(block))
        ? FLUID.WATER_SOURCE
        : block === "LAVA"
          ? FLUID.LAVA_SOURCE
          : FLUID.NONE;
    write(p.x, p.y, p.z, block, {
      state: rotateStructureState(block, state, descriptor.rotation),
      fluid,
      mode: "replace",
    });
  };
  const fill = (x0, y0, z0, x1, y1, z1, block, state = 0) => {
    for (let y = y0; y <= y1; y++)
      for (let z = z0; z <= z1; z++)
        for (let x = x0; x <= x1; x++) set(x, y, z, block, state);
  };
  const clear = (x0, y0, z0, x1, y1, z1) => {
    for (let y = y0; y <= y1; y++) fill(x0, y, z0, x1, y, z1, emptyBlock(y));
  };
  const walls = (x0, y0, z0, x1, y1, z1, block) => {
    fill(x0, y0, z0, x1, y1, z0, block);
    fill(x0, y0, z1, x1, y1, z1, block);
    fill(x0, y0, z0 + 1, x0, y1, z1 - 1, block);
    fill(x1, y0, z0 + 1, x1, y1, z1 - 1, block);
  };
  const door = (x, y, z, facing, right = false) => {
    const state = facing | (right ? S.HINGE_RIGHT : 0);
    set(x, y, z, "OAK_DOOR", state);
    set(x, y + 1, z, "OAK_DOOR", state | S.PART);
  };
  const bed = (x, y, z, facing) => {
    const [dx, dz] = directions[facing];
    set(x, y, z, "WHITE_BED", facing);
    set(x + dx, y, z + dz, "WHITE_BED", facing | S.PART);
  };
  const foundations = (supports, block) => {
    for (const { x, z, bottom, top = 0 } of supports)
      fill(x, bottom, z, x, top, z, block);
  };
  return { set, fill, clear, walls, door, bed, foundations, emptyBlock };
}

/** A pitched roof with supported gables and correctly oriented stair eaves. */
export function oakRoof(b, x0, y, z0, x1, z1, gable = "PLANKS") {
  const middle = Math.floor((x0 + x1) / 2);
  for (let x = x0; x <= x1; x++) {
    const rise = Math.min(x - x0, x1 - x);
    if (x === middle) b.fill(x, y + rise, z0, x, y + rise, z1, "OAK_SLAB");
    else
      b.fill(
        x,
        y + rise,
        z0,
        x,
        y + rise,
        z1,
        "OAK_STAIRS",
        x < middle ? 1 : 3
      );
    if (rise > 0)
      for (const z of [z0 + 1, z1 - 1])
        b.fill(x, y, z, x, y + rise - 1, z, gable);
  }
}

export function localMarker(type, key, role, at, details = {}) {
  return { type, key, role, at, ...details };
}

/**
 * Marker positions are integer cell coordinates. Entity consumers spawn at
 * (x+.5,y,z+.5); containers use the exact block coordinate. IDs, not chunk
 * membership or callback count, are the persistent materialization keys.
 */
export function transformStructureMarkers(descriptor, markers) {
  return markers.map(({ at, localBounds, localEntry, facing, ...marker }) => ({
    ...marker,
    id: `${descriptor.id}/${marker.type}/${marker.key}`,
    structureId: descriptor.id,
    dimension: descriptor.dimension,
    position: structurePoint(descriptor, ...at),
    ...(localBounds
      ? { bounds: structureBounds(descriptor, localBounds) }
      : {}),
    ...(localEntry
      ? {
          entry: {
            ...structurePoint(descriptor, ...localEntry.slice(0, 3)),
            facing: (localEntry[3] + descriptor.rotation) & 3,
          },
        }
      : {}),
    ...(facing === undefined
      ? {}
      : { facing: (facing + descriptor.rotation) & 3 }),
  }));
}
