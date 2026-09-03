import { box, boxes, rotateBox } from "./aabb.js";
import { BLOCK_STATE } from "./block-state.js";
import { BLOCKS } from "./blocks.js";

// Facing is the outward/front normal; north is -Z, then clockwise.
export const HORIZONTAL_DIRECTIONS = Object.freeze([
  Object.freeze([0, 0, -1]),
  Object.freeze([1, 0, 0]),
  Object.freeze([0, 0, 1]),
  Object.freeze([-1, 0, 0]),
]);
export const FACING_NAMES = Object.freeze(["north", "east", "south", "west"]);
const sameHalf = (a, b) => (a & BLOCK_STATE.TOP) === (b & BLOCK_STATE.TOP);
const facingOf = (cell) => (cell?.state ?? 0) & BLOCK_STATE.FACING_MASK;
const stair = (cell) => BLOCKS[cell?.id]?.shape === "stairs";

function stairMask(facing) {
  // Four quarter columns, bits in local z*2+x order.
  return [0b0011, 0b1010, 0b1100, 0b0101][facing];
}

export function stairGeometry(cell, neighborhood) {
  const state = cell.state ?? 0;
  const facing = facingOf(cell);
  const [dx, , dz] = HORIZONTAL_DIRECTIONS[facing];
  const front = neighborhood(dx, 0, dz);
  const back = neighborhood(-dx, 0, -dz);
  let mask = stairMask(facing);
  let corner = "straight";
  const different = (side) => {
    const [x, , z] = HORIZONTAL_DIRECTIONS[side];
    const other = neighborhood(x, 0, z);
    return (
      !stair(other) ||
      facingOf(other) !== facing ||
      !sameHalf(state, other.state ?? 0)
    );
  };
  if (
    stair(front) &&
    sameHalf(state, front.state ?? 0) &&
    (facingOf(front) & 1) !== (facing & 1) &&
    different((facingOf(front) + 2) & 3)
  ) {
    mask &= stairMask(facingOf(front));
    corner =
      facingOf(front) === ((facing + 3) & 3) ? "outer_left" : "outer_right";
  } else if (
    stair(back) &&
    sameHalf(state, back.state ?? 0) &&
    (facingOf(back) & 1) !== (facing & 1) &&
    different(facingOf(back))
  ) {
    mask |= stairMask(facingOf(back));
    corner =
      facingOf(back) === ((facing + 3) & 3) ? "inner_left" : "inner_right";
  }
  const top = !!(state & BLOCK_STATE.TOP);
  const result = [box(0, top ? 0.5 : 0, 0, 1, top ? 1 : 0.5, 1)];
  const y0 = top ? 0 : 0.5;
  const y1 = top ? 0.5 : 1;
  // Emit the large half first, then any remaining quarter. No overlapping
  // volumes and no orientation-specific winding/UV special cases.
  for (const [bits, bounds] of [
    [0b0011, [0, y0, 0, 1, y1, 0.5]],
    [0b1100, [0, y0, 0.5, 1, y1, 1]],
    [0b0101, [0, y0, 0, 0.5, y1, 1]],
    [0b1010, [0.5, y0, 0, 1, y1, 1]],
  ]) {
    if ((mask & bits) === bits) {
      result.push(Object.freeze(bounds));
      mask &= ~bits;
    }
  }
  for (let i = 0; i < 4; i++) {
    if (!(mask & (1 << i))) continue;
    const x = (i & 1) / 2;
    const z = (i >> 1) / 2;
    result.push(box(x, y0, z, x + 0.5, y1, z + 0.5));
  }
  return { render: Object.freeze(result), corner };
}

export function doorGeometry(cell, neighborhood) {
  const upper = !!(cell.state & BLOCK_STATE.PART);
  const offset = Object.freeze([0, upper ? -1 : 1, 0]);
  const other = neighborhood(...offset);
  const linked =
    other?.id === cell.id && !!(other.state & BLOCK_STATE.PART) !== upper;
  const lowerState = upper && linked ? other.state : cell.state;
  const upperState = !upper && linked ? other.state : cell.state;
  const facing = lowerState & BLOCK_STATE.FACING_MASK;
  const open = !!(lowerState & BLOCK_STATE.OPEN);
  const right = !!(upperState & BLOCK_STATE.HINGE_RIGHT);
  const t = 3 / 16;
  const panel = !open
    ? box(0, 0, 1 - t, 1, 1, 1)
    : right
      ? box(1 - t, 0, 0, 1, 1, 1)
      : box(0, 0, 0, t, 1, 1);
  return {
    render: boxes([rotateBox(panel, facing)]),
    facing,
    open,
    hinge: right ? "right" : "left",
    part: upper ? "upper" : "lower",
    link: Object.freeze({ offset, valid: linked }),
  };
}

export function fenceGeometry(cell, neighborhood, sturdyFace) {
  const connected = HORIZONTAL_DIRECTIONS.map(([x, y, z], side) => {
    const other = neighborhood(x, y, z);
    const definition = BLOCKS[other?.id];
    if (definition?.shape === "fence")
      return (
        (definition.fenceGroup ?? "wood") ===
        (BLOCKS[cell.id].fenceGroup ?? "wood")
      );
    if (definition?.shape === "fence_gate")
      return (facingOf(other) & 1) !== (side & 1);
    return (
      definition?.texture !== "leaves" &&
      sturdyFace(other, (side + 2) & 3, (dx, dy, dz) =>
        neighborhood(x + dx, y + dy, z + dz)
      )
    );
  });
  const render = [box(6 / 16, 0, 6 / 16, 10 / 16, 1, 10 / 16)];
  const collision = [box(6 / 16, 0, 6 / 16, 10 / 16, 1.5, 10 / 16)];
  connected.forEach((connected, side) => {
    if (!connected) return;
    for (const y of [6 / 16, 12 / 16])
      render.push(
        rotateBox(box(7 / 16, y, 0, 9 / 16, y + 3 / 16, 6 / 16), side)
      );
    collision.push(rotateBox(box(6 / 16, 0, 0, 10 / 16, 1.5, 6 / 16), side));
  });
  return {
    render: Object.freeze(render),
    collision: Object.freeze(collision),
    connections: Object.freeze(connected),
  };
}

export function gateGeometry(state) {
  const open = !!(state & BLOCK_STATE.OPEN);
  const facing = state & BLOCK_STATE.FACING_MASK;
  const render = [
    box(0, 0, 6 / 16, 2 / 16, 1, 10 / 16),
    box(14 / 16, 0, 6 / 16, 1, 1, 10 / 16),
  ];
  if (open) {
    for (const x of [0, 14 / 16])
      for (const y of [6 / 16, 12 / 16])
        render.push(box(x, y, 10 / 16, x + 2 / 16, y + 3 / 16, 1));
  } else {
    for (const y of [6 / 16, 12 / 16])
      render.push(box(2 / 16, y, 7 / 16, 14 / 16, y + 3 / 16, 9 / 16));
    render.push(box(7 / 16, 6 / 16, 7 / 16, 9 / 16, 15 / 16, 9 / 16));
  }
  return {
    render: boxes(render.map((bounds) => rotateBox(bounds, facing))),
    collision: boxes(
      open ? [] : [rotateBox(box(0, 0, 6 / 16, 1, 1.5, 10 / 16), facing)]
    ),
    open,
    facing,
  };
}

export function bedGeometry(cell, neighborhood) {
  const state = cell.state ?? 0;
  const facing = state & BLOCK_STATE.FACING_MASK;
  const head = !!(state & BLOCK_STATE.PART);
  const direction = HORIZONTAL_DIRECTIONS[facing];
  const offset = Object.freeze(
    direction.map((coordinate) => coordinate * (head ? -1 : 1))
  );
  const other = neighborhood(...offset);
  const linked =
    other?.id === cell.id &&
    facingOf(other) === facing &&
    !!(other.state & BLOCK_STATE.PART) !== head;
  const legZ = head ? 0 : 13 / 16;
  return {
    render: boxes([
      box(0, 3 / 16, 0, 1, 9 / 16, 1),
      ...[0, 13 / 16].map((x) =>
        rotateBox(box(x, 0, legZ, x + 3 / 16, 3 / 16, legZ + 3 / 16), facing)
      ),
    ]),
    collision: boxes([box(0, 0, 0, 1, 9 / 16, 1)]),
    facing,
    part: head ? "head" : "foot",
    link: Object.freeze({ offset, valid: linked }),
  };
}
