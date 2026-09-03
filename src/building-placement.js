import { BLOCK, BLOCKS } from "./blocks.js";
import {
  BLOCK_STATE as S,
  cellAfterBreaking,
  cellsEqual,
  FLUID,
  isSourceWater,
  normalizeCell,
} from "./block-state.js";
import {
  canAttachToFace,
  FACING_NAMES,
  HORIZONTAL_DIRECTIONS,
  resolveShape,
} from "./block-shapes.js";
import { CHUNK_SIZE } from "./terrain.js";
import { getWorldSpec, isEditablePosition } from "./world-spec.js";

const SHAPES = new Set([
  "slab",
  "stairs",
  "door",
  "trapdoor",
  "fence",
  "fence_gate",
  "ladder",
  "bed",
]);
const LINK_CONSUMERS = new Set([
  "door",
  "bed",
  "fence",
  "fence_gate",
  "ladder",
]);
const xyzKey = ({ x, y, z }) => `${x},${y},${z}`;
export const buildingKey = (dimension, position) =>
  `${dimension}:${xyzKey(position)}`;
export const buildingRefusal = (message) => ({ ok: false, message });
export const isBuildingBlock = (id) =>
  SHAPES.has(BLOCKS[id]?.shape) || BLOCKS[id]?.directional === "axis";
export const offsetPosition = (position, direction, distance = 1) => ({
  x: position.x + direction[0] * distance,
  y: position.y + direction[1] * distance,
  z: position.z + direction[2] * distance,
});

/** North=-Z, east=+X. Never infer a direction from the sign of a camera yaw. */
export function facingFromForward(forward) {
  if (
    !forward ||
    ![forward.x, forward.y, forward.z].every(Number.isFinite) ||
    (forward.x === 0 && forward.z === 0)
  )
    return null;
  return Math.abs(forward.x) > Math.abs(forward.z)
    ? forward.x > 0
      ? 1
      : 3
    : forward.z > 0
      ? 2
      : 0;
}

export function normalFace(normal) {
  if (
    !normal ||
    ![normal.x, normal.y, normal.z].every(Number.isInteger) ||
    Math.abs(normal.x) + Math.abs(normal.y) + Math.abs(normal.z) !== 1
  )
    return null;
  if (normal.y) return normal.y > 0 ? "up" : "down";
  return normal.x
    ? normal.x > 0
      ? "east"
      : "west"
    : normal.z > 0
      ? "south"
      : "north";
}

/**
 * A bounded, non-generating read set for pure proposals. Null neighbors are
 * prerequisites too. The validator also pins chunk admission/revisions, so
 * remove-and-replace or unload-and-readmit cannot revive an old proposal.
 */
export class BuildingReads {
  constructor(world) {
    this.world = world;
    this.spec = getWorldSpec(world.generatorVersion, world.dimension);
    this.dimension = world.dimension;
    this.seed = world.seed;
    this.generatorVersion = world.generatorVersion;
    this.epoch = world.epoch ?? world._epoch;
    this.revision = world._editRevision;
    this.coordinator = world.coordinator;
    this.records = new Map();
    this.view = {
      dimension: this.dimension,
      generatorVersion: this.generatorVersion,
      spec: this.spec,
      isLoaded: (x, z) =>
        this.read(Math.floor(x), this.spec.minY, Math.floor(z)) !== null,
      getCell: (x, y, z) => this.read(x, y, z),
      get: (x, y, z) => this.read(x, y, z)?.id ?? BLOCK.AIR,
    };
  }

  read(x, y, z) {
    if (![x, y, z].every(Number.isSafeInteger))
      throw new RangeError("Invalid building read");
    const key = xyzKey({ x, y, z });
    if (!this.records.has(key)) {
      if (this.records.size >= 8192)
        throw new RangeError("Building read limit");
      const cell = this.world.getCell(x, y, z);
      const before = cell === null ? null : Object.freeze(normalizeCell(cell));
      const column = `${Math.floor(x / CHUNK_SIZE)},${Math.floor(z / CHUNK_SIZE)}`;
      const chunk = this.world.chunks?.get(column);
      this.records.set(key, {
        x,
        y,
        z,
        before,
        column,
        chunk,
        incarnation: chunk?.incarnation,
        revision: chunk?.revision,
      });
    }
    return this.records.get(key).before;
  }

  at(position) {
    return this.read(position.x, position.y, position.z);
  }

  neighborhood(position) {
    return (dx, dy, dz) =>
      this.read(position.x + dx, position.y + dy, position.z + dz);
  }

  validate() {
    const world = this.world;
    return (
      !world._disposed &&
      world.seed === this.seed &&
      world.generatorVersion === this.generatorVersion &&
      world.dimension === this.dimension &&
      (world.epoch ?? world._epoch) === this.epoch &&
      world._editRevision === this.revision &&
      world.coordinator === this.coordinator &&
      [...this.records.values()].every(
        (read) =>
          world.chunks?.get(read.column) === read.chunk &&
          read.chunk?.incarnation === read.incarnation &&
          read.chunk?.revision === read.revision &&
          cellsEqual(world.getCell(read.x, read.y, read.z), read.before)
      )
    );
  }

  proposal(changes, extra = {}) {
    return Object.freeze({
      ok: true,
      dimension: this.dimension,
      epoch: this.epoch,
      changes: Object.freeze(
        changes.map(({ x, y, z, before, after }) =>
          Object.freeze({
            dimension: this.dimension,
            x,
            y,
            z,
            before: Object.freeze(normalizeCell(before)),
            after: Object.freeze(normalizeCell(after)),
          })
        )
      ),
      reads: Object.freeze(
        [...this.records.values()].map(({ x, y, z, before }) =>
          Object.freeze({ dimension: this.dimension, x, y, z, before })
        )
      ),
      validate: () => this.validate(),
      ...extra,
    });
  }
}

export function readBuildingHit(reads, hit) {
  if (
    !hit ||
    ![hit.x, hit.y, hit.z].every(Number.isSafeInteger) ||
    (hit.world !== undefined && hit.world !== reads.world) ||
    (hit.dimension !== undefined && hit.dimension !== reads.dimension)
  )
    return null;
  const cell = reads.at(hit);
  return cell &&
    (hit.id === undefined || hit.id === cell.id) &&
    (hit.state === undefined || hit.state === cell.state) &&
    (hit.fluid === undefined || hit.fluid === cell.fluid)
    ? cell
    : null;
}

function editable(reads, position) {
  return isEditablePosition(
    position.x,
    position.y,
    position.z,
    reads.generatorVersion,
    reads.dimension
  );
}

/** Matches the geometry resolver's structural attachment rules, including corners. */
export function buildingSupport(reads, position, face) {
  const cell = reads.at(position);
  if (!cell) return null;
  const definition = BLOCKS[cell.id];
  return (
    !!definition?.solid &&
    !LINK_CONSUMERS.has(definition.shape) &&
    canAttachToFace(cell, face, reads.neighborhood(position))
  );
}

function localPoint(hit) {
  const point =
    hit.localPoint ??
    (hit.point && {
      x: hit.point.x - hit.x,
      y: hit.point.y - hit.y,
      z: hit.point.z - hit.z,
    });
  return point &&
    [point.x, point.y, point.z].every(
      (value) => Number.isFinite(value) && value >= -1e-7 && value <= 1 + 1e-7
    )
    ? point
    : null;
}

function topHalf(hit, point) {
  if (hit.normal.y) return hit.normal.y < 0;
  return point ? point.y > 0.5 : null;
}

function mergeClickedSlab(cell, id, hit, point) {
  if (cell.id !== id || cell.state & S.DOUBLE) return false;
  const top = !!(cell.state & S.TOP);
  if (hit.normal.y) return top ? hit.normal.y < 0 : hit.normal.y > 0;
  return !!point && (top ? point.y <= 0.5 : point.y > 0.5);
}

function placementCell(definition, state, before) {
  // Only empty cells/water are replaceable here. Plant/crop ownership belongs
  // to its own prepared break path; building never erases a player's plant.
  if (before.id !== BLOCK.AIR && before.id !== BLOCK.WATER) return null;
  if (definition.id === BLOCK.WATER || definition.id === BLOCK.LAVA)
    return normalizeCell({ id: definition.id, state });
  if (definition.aquatic)
    return before.id === BLOCK.WATER && isSourceWater(before.fluid)
      ? normalizeCell({ id: definition.id, state, fluid: FLUID.WATER_SOURCE })
      : null;
  const keepWater =
    before.id === BLOCK.WATER &&
    isSourceWater(before.fluid) &&
    definition.waterloggable &&
    !["door", "bed"].includes(definition.shape) &&
    !(definition.shape === "slab" && state & S.DOUBLE);
  return normalizeCell({
    id: definition.id,
    state,
    fluid: keepWater ? FLUID.WATER_SOURCE : FLUID.NONE,
  });
}

function doorHinge(reads, position, facing, point) {
  const left = HORIZONTAL_DIRECTIONS[(facing + 3) & 3];
  const right = HORIZONTAL_DIRECTIONS[(facing + 1) & 3];
  const neighborDoor = (direction) => {
    const other = reads.at(offsetPosition(position, direction));
    return (
      BLOCKS[other?.id]?.shape === "door" &&
      !(other.state & S.PART) &&
      (other.state & S.FACING_MASK) === facing
    );
  };
  const leftDoor = neighborDoor(left),
    rightDoor = neighborDoor(right);
  if (leftDoor !== rightDoor) return leftDoor;
  const obstruction = (direction, face) =>
    [0, 1].reduce((count, dy) => {
      const at = offsetPosition({ ...position, y: position.y + dy }, direction);
      return count + Number(buildingSupport(reads, at, face) === true);
    }, 0);
  const difference =
    obstruction(right, FACING_NAMES[(facing + 3) & 3]) -
    obstruction(left, FACING_NAMES[(facing + 1) & 3]);
  if (difference) return difference > 0;
  return !!point && (point.x - 0.5) * right[0] + (point.z - 0.5) * right[2] > 0;
}

/** Pin geometry that Player.intersectsPlacement may sample through a neighbor. */
export function capturePlacementNeighborhood(reads, changes) {
  for (const { x, y, z } of changes)
    for (let dx = -3; dx <= 3; dx++)
      for (let dz = -3; dz <= 3; dz++)
        for (let dy = -2; dy <= 2; dy++) reads.read(x + dx, y + dy, z + dz);
}

/** Detached oriented proposal only. The controller supplies inventory and commit. */
export function prepareBuildingPlacement(world, id, hit, forward) {
  const definition = BLOCKS[id];
  const face = normalFace(hit?.normal);
  if (!definition || id === BLOCK.AIR || !face)
    return buildingRefusal("Choose a loaded block face");
  if (id === BLOCK.WHEAT_CROP)
    return buildingRefusal("Plant wheat with the seed interaction");
  const reads = new BuildingReads(world);
  const clicked = readBuildingHit(reads, hit);
  if (!clicked || clicked.id === BLOCK.AIR)
    return buildingRefusal("That block is no longer available");
  const point = localPoint(hit);
  let position = offsetPosition(hit, [
    hit.normal.x,
    hit.normal.y,
    hit.normal.z,
  ]);
  if (definition.shape === "slab" && mergeClickedSlab(clicked, id, hit, point))
    position = { x: hit.x, y: hit.y, z: hit.z };
  const before = reads.at(position);
  if (!before || !editable(reads, position))
    return buildingRefusal("The destination is outside the loaded build area");
  if (BLOCKS[before.id]?.shape === "cross")
    return buildingRefusal("Break the existing plant before building here");
  const facing = facingFromForward(forward);
  let state = 0;
  let after;
  const changes = [];
  if (
    definition.shape === "slab" &&
    before.id === id &&
    !(before.state & S.DOUBLE)
  ) {
    // One new slab fills the other half. A full block cannot coexist with water.
    after = normalizeCell({ id, state: S.DOUBLE, fluid: FLUID.NONE });
  } else {
    if (["slab", "stairs", "trapdoor"].includes(definition.shape)) {
      const top = topHalf(hit, point);
      if (top === null)
        return buildingRefusal("The exact hit height is required");
      if (top) state |= S.TOP;
    }
    if (definition.directional === "axis") {
      if (hit.normal.x) state |= S.AXIS_X;
      else if (hit.normal.z) state |= S.AXIS_Z;
    } else if (definition.shape === "ladder") {
      const attachedFacing = FACING_NAMES.indexOf(face);
      if (attachedFacing < 0 || buildingSupport(reads, hit, face) !== true)
        return buildingRefusal(
          "A ladder needs a complete supporting wall face"
        );
      state = attachedFacing;
    } else if (definition.shape === "trapdoor") {
      const side = FACING_NAMES.indexOf(face);
      if (side < 0 && facing === null)
        return buildingRefusal("A horizontal player direction is required");
      state |= side >= 0 ? side : (facing + 2) & 3;
      // Modern trapdoors, like gates and fences, can remain free-standing.
    } else if (
      ["stairs", "door", "fence_gate", "bed"].includes(definition.shape) ||
      definition.directional === true ||
      definition.directional === "facing"
    ) {
      if (facing === null)
        return buildingRefusal("A horizontal player direction is required");
      state |= facing;
    }
    if (definition.shape === "door") {
      if (
        buildingSupport(reads, { ...position, y: position.y - 1 }, "up") !==
        true
      )
        return buildingRefusal("A door needs a complete supporting top face");
      if (doorHinge(reads, position, facing, point)) state |= S.HINGE_RIGHT;
    }
    after = placementCell(definition, state, before);
    if (!after) return buildingRefusal("That space is occupied");
  }
  changes.push({ ...position, before, after });
  if (definition.shape === "door" || definition.shape === "bed") {
    const other =
      definition.shape === "door"
        ? { ...position, y: position.y + 1 }
        : offsetPosition(position, HORIZONTAL_DIRECTIONS[facing]);
    const otherBefore = reads.at(other);
    if (!otherBefore || !editable(reads, other))
      return buildingRefusal(
        "Both halves must be inside the loaded build area"
      );
    if (
      definition.shape === "bed" &&
      [position, other].some(
        (at) => buildingSupport(reads, { ...at, y: at.y - 1 }, "up") !== true
      )
    )
      return buildingRefusal("Both bed halves need supporting top faces");
    const otherAfter = placementCell(definition, state | S.PART, otherBefore);
    if (!otherAfter)
      return buildingRefusal("Clear the other half before placing this block");
    changes.push({ ...other, before: otherBefore, after: otherAfter });
  }
  capturePlacementNeighborhood(reads, changes);
  return reads.proposal(changes, {
    rootKey: buildingKey(world.dimension, position),
    id,
  });
}

/**
 * Canonical root is the lower door / bed foot. A loaded malformed partner is
 * distinct from an unavailable one; neither can yield a second linked item.
 */
export function readBuildingPair(reads, hit) {
  const cell = readBuildingHit(reads, hit);
  const kind = BLOCKS[cell?.id]?.shape;
  if (!cell || !["door", "bed"].includes(kind)) return null;
  const facing = cell.state & S.FACING_MASK;
  const direction = kind === "door" ? [0, 1, 0] : HORIZONTAL_DIRECTIONS[facing];
  const root = offsetPosition(hit, direction, cell.state & S.PART ? -1 : 0);
  const other = offsetPosition(root, direction);
  const lower = reads.at(root),
    upper = reads.at(other);
  const available = lower !== null && upper !== null;
  const valid =
    available &&
    lower.id === cell.id &&
    upper.id === cell.id &&
    !(lower.state & S.PART) &&
    !!(upper.state & S.PART) &&
    (lower.state & ~S.PART) === (upper.state & ~S.PART);
  return {
    kind,
    id: cell.id,
    facing,
    root,
    other,
    lower,
    upper,
    available,
    valid,
    rootKey: buildingKey(reads.dimension, root),
    cells: [
      { ...root, before: lower },
      { ...other, before: upper },
    ],
  };
}

export function linkedSupport(reads, pair) {
  const feet = pair.kind === "door" ? [pair.root] : [pair.root, pair.other];
  const supports = feet.map((position) =>
    buildingSupport(reads, { ...position, y: position.y - 1 }, "up")
  );
  return supports.includes(null) ? null : supports.every(Boolean);
}

/** null means ordinary mining; ok:false means recognized but unsafe to break. */
export function prepareBuildingBreak(
  world,
  hit,
  reads = new BuildingReads(world)
) {
  const cell = readBuildingHit(reads, hit);
  const id = cell?.id ?? hit?.id;
  if (!isBuildingBlock(id)) return null;
  if (!cell || !editable(reads, hit))
    return buildingRefusal("That building block is no longer available");
  const definition = BLOCKS[cell.id];
  const pair = readBuildingPair(reads, hit);
  let targets = [{ x: hit.x, y: hit.y, z: hit.z, before: cell }];
  let dropCount = definition.shape === "slab" && cell.state & S.DOUBLE ? 2 : 1;
  if (pair) {
    if (!pair.available)
      return buildingRefusal(
        "Load both linked halves before breaking this block"
      );
    if (pair.valid) targets = pair.cells;
    else dropCount = 0; // Orphan cleanup cannot pay the item a removed root already paid.
  }
  return reads.proposal(
    targets.map((target) => ({
      ...target,
      after: cellAfterBreaking(target.before),
    })),
    {
      rootKey: pair?.rootKey ?? buildingKey(world.dimension, hit),
      dropId: definition.drop ?? cell.id,
      dropCount,
    }
  );
}

export function prepareBuildingToggle(world, hit, forward) {
  const reads = new BuildingReads(world);
  const cell = readBuildingHit(reads, hit);
  const kind = BLOCKS[cell?.id ?? hit?.id]?.shape;
  if (!["door", "trapdoor", "fence_gate"].includes(kind)) return null;
  if (!cell)
    return buildingRefusal("That building block is no longer available");
  const pair = kind === "door" ? readBuildingPair(reads, hit) : null;
  if (pair && (!pair.valid || linkedSupport(reads, pair) !== true))
    return buildingRefusal(
      "Both door halves and their support must be available"
    );
  let state = cell.state ^ S.OPEN;
  if (kind === "fence_gate" && !(cell.state & S.OPEN)) {
    const facing = facingFromForward(forward);
    if (facing === (((cell.state & S.FACING_MASK) + 2) & 3))
      state = (state & ~S.FACING_MASK) | facing;
  }
  const targets = pair?.cells ?? [
    { x: hit.x, y: hit.y, z: hit.z, before: cell },
  ];
  const changes = targets.map((target) => ({
    ...target,
    after: normalizeCell({
      ...target.before,
      state: pair ? target.before.state ^ S.OPEN : state,
    }),
  }));
  capturePlacementNeighborhood(reads, changes);
  return reads.proposal(changes, {
    rootKey: pair?.rootKey ?? buildingKey(world.dimension, hit),
  });
}

/** null is unavailable support; callers must defer, not destroy unloaded links. */
export function buildingHasSupport(reads, hit) {
  const cell = readBuildingHit(reads, hit);
  if (!cell) return null;
  if (BLOCKS[cell.id]?.shape === "ladder") {
    const facing = cell.state & S.FACING_MASK;
    return buildingSupport(
      reads,
      offsetPosition(hit, HORIZONTAL_DIRECTIONS[(facing + 2) & 3]),
      FACING_NAMES[facing]
    );
  }
  const pair = readBuildingPair(reads, hit);
  if (!pair) return true;
  if (!pair.available) return null;
  return pair.valid ? linkedSupport(reads, pair) : false;
}

/** A preview uses derived corners/connections; these are never extra saved flags. */
export function proposedBuildingShape(world, proposal, index = 0) {
  if (!proposal?.ok || !proposal.changes[index]) return null;
  const target = proposal.changes[index];
  const cells = new Map(
    proposal.changes.map((change) => [xyzKey(change), change.after])
  );
  return resolveShape(target.after, (dx, dy, dz) => {
    const position = { x: target.x + dx, y: target.y + dy, z: target.z + dz };
    return (
      cells.get(xyzKey(position)) ??
      world.getCell(position.x, position.y, position.z)
    );
  });
}
