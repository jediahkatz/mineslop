import { BOX_EPSILON, intersectRayBox, overlaps } from "./aabb.js";
import { isWaterFluid } from "./block-state.js";
import {
  bodyBox,
  boxCollides,
  fluidAtPoint,
  visitWorldBoxes,
} from "./collision.js";
import { captureEntityContext } from "./entity-context.js";
import { CHUNK_SIZE, WORLD_MAX, WORLD_MIN } from "./terrain.js";
import { isDimension, isWorldPose } from "./world-spec.js";

// Velocity is blocks/second. These are discrete 20 Hz launch/drag/gravity
// constants, not an instantaneous raycast disguised as a thrown item.
export const PEARL_STEP_SECONDS = 1 / 20;
export const PEARL_SPEED = 30;
export const PEARL_GRAVITY = 12;
export const PEARL_AIR_DRAG = 0.99;
export const PEARL_WATER_DRAG = 0.8;
export const PEARL_RADIUS = 0.125;
export const MAX_PEARL_SPEED = 80;
export const PEARL_COLLISION_OFFSET = 1 / 64;
export const MAX_PEARL_QUERY_CELLS = 4096;
export const MAX_PEARL_QUERY_COLUMNS = 4;

const axes = ["x", "y", "z"];
export const finitePearlVector = (value) =>
  !!value && axes.every((axis) => Number.isFinite(value[axis]));
export const validPearlVelocity = (value) =>
  finitePearlVector(value) &&
  axes.every((axis) => Math.abs(value[axis]) <= MAX_PEARL_SPEED);

/** Projectiles may fly above the build ceiling or fall toward the void. */
export function validPearlPosition(position, context, dimension) {
  return (
    isDimension(dimension) &&
    isWorldPose(position, context, dimension) &&
    position.x >= WORLD_MIN + PEARL_RADIUS &&
    position.x <= WORLD_MAX - PEARL_RADIUS &&
    position.z >= WORLD_MIN + PEARL_RADIUS &&
    position.z <= WORLD_MAX - PEARL_RADIUS &&
    Number.isSafeInteger(Math.floor(position.y - 8)) &&
    Number.isSafeInteger(Math.ceil(position.y + 8))
  );
}

export function pearlLaunchVelocity(direction) {
  if (!finitePearlVector(direction)) return null;
  const length = Math.hypot(direction.x, direction.y, direction.z);
  if (!Number.isFinite(length) || length < 1e-8) return null;
  return Object.fromEntries(
    axes.map((axis) => [axis, (direction[axis] / length) * PEARL_SPEED])
  );
}

/** One fixed tick: move using the old velocity, then apply drag and gravity. */
export function integratePearl(position, velocity, { water = false } = {}) {
  if (!finitePearlVector(position) || !validPearlVelocity(velocity))
    return null;
  const drag = water ? PEARL_WATER_DRAG : PEARL_AIR_DRAG;
  return {
    position: Object.fromEntries(
      axes.map((axis) => [
        axis,
        position[axis] + velocity[axis] * PEARL_STEP_SECONDS,
      ])
    ),
    velocity: {
      x: velocity.x * drag,
      y: velocity.y * drag - PEARL_GRAVITY * PEARL_STEP_SECONDS,
      z: velocity.z * drag,
    },
  };
}

const validQuery = (query) =>
  Array.isArray(query) &&
  query.length === 6 &&
  query.every(
    (value) => Number.isFinite(value) && Number.isSafeInteger(Math.floor(value))
  ) &&
  [0, 1, 2].every((axis) => query[axis] <= query[axis + 3]) &&
  [0, 1, 2].reduce(
    (count, axis) =>
      count * (Math.floor(query[axis + 3]) - Math.floor(query[axis]) + 5),
    1
  ) <= MAX_PEARL_QUERY_CELLS;
const columnKey = (x, z) =>
  `${Math.floor(x / CHUNK_SIZE)},${Math.floor(z / CHUNK_SIZE)}`;
const sameCell = (a, b) =>
  a === b ||
  (!!a && !!b && a.id === b.id && a.state === b.state && a.fluid === b.fluid);

/**
 * Small, non-generating geometry read set. The two-cell apron covers protruding
 * owners AND their shape-connection reads. A missing apron freezes the query;
 * it is never treated as air or as an impact wall. Real World admissions and
 * revisions are pinned; cell-only authored fixtures use scalar comparisons.
 */
function readSet(world, context, query) {
  if (!validQuery(query)) return null;
  const dimension = world.dimension;
  const spec = context.specForDimension(dimension);
  const current = captureEntityContext(world, context);
  const columns = new Map();
  const cells = new Map();
  const missing = new Map();
  let invalid = false;
  const readColumn = (x, z) => {
    if (x < WORLD_MIN || x >= WORLD_MAX || z < WORLD_MIN || z >= WORLD_MAX)
      return null;
    const key = columnKey(x, z);
    if (columns.has(key)) return columns.get(key);
    if (columns.size >= MAX_PEARL_QUERY_COLUMNS) {
      invalid = true;
      return null;
    }
    const cx = Math.floor(x / CHUNK_SIZE);
    const cz = Math.floor(z / CHUNK_SIZE);
    const loaded = world.isLoaded(cx * CHUNK_SIZE, cz * CHUNK_SIZE) === true;
    const chunk = world.chunks?.get(key);
    const entry = {
      cx,
      cz,
      loaded,
      chunk,
      incarnation: chunk?.incarnation,
      revision: chunk?.revision,
    };
    columns.set(key, entry);
    if (!loaded) missing.set(key, { cx, cz });
    return entry;
  };
  for (
    let cz = Math.floor((query[2] - 2) / CHUNK_SIZE);
    cz <= Math.floor((query[5] + 2) / CHUNK_SIZE);
    cz++
  ) {
    for (
      let cx = Math.floor((query[0] - 2) / CHUNK_SIZE);
      cx <= Math.floor((query[3] + 2) / CHUNK_SIZE);
      cx++
    )
      readColumn(cx * CHUNK_SIZE, cz * CHUNK_SIZE);
  }
  const view = {
    generatorVersion: context.generatorVersion,
    dimension,
    spec,
    isLoaded: (x, z) => readColumn(x, z)?.loaded === true,
    getCell(x, y, z) {
      if (y < spec.minY || y >= spec.maxY) return null;
      const column = readColumn(x, z);
      if (!column?.loaded) return null;
      const key = `${x},${y},${z}`;
      if (cells.has(key)) return cells.get(key).cell;
      if (cells.size >= MAX_PEARL_QUERY_CELLS) {
        invalid = true;
        return null;
      }
      const value = world.getCell(x, y, z);
      const cell = value && {
        id: value.id,
        state: value.state,
        fluid: value.fluid,
      };
      if (!cell) missing.set(columnKey(x, z), { cx: column.cx, cz: column.cz });
      cells.set(key, { x, y, z, cell, column });
      return cell;
    },
  };
  return {
    view,
    status() {
      return invalid ? "invalid" : missing.size ? "frontier" : "ready";
    },
    frontier: () => [...missing.values()],
    validate() {
      if (invalid || !current()) return false;
      for (const [key, entry] of columns) {
        if (
          (world.isLoaded(entry.cx * CHUNK_SIZE, entry.cz * CHUNK_SIZE) ===
            true) !==
          entry.loaded
        )
          return false;
        const chunk = world.chunks?.get(key);
        if (
          chunk !== entry.chunk ||
          chunk?.incarnation !== entry.incarnation ||
          chunk?.revision !== entry.revision
        )
          return false;
      }
      for (const { x, y, z, cell, column } of cells.values()) {
        if (
          !Number.isSafeInteger(column.revision) &&
          !sameCell(cell, world.getCell(x, y, z))
        )
          return false;
      }
      return true;
    },
  };
}

function readFailure(reads) {
  return {
    kind: reads?.status() === "frontier" ? "frontier" : "invalid",
    columns: reads?.frontier() ?? [],
    validate: () => !!reads && reads.validate(),
  };
}

const projectileBox = (position) => [
  position.x - PEARL_RADIUS,
  position.y - PEARL_RADIUS,
  position.z - PEARL_RADIUS,
  position.x + PEARL_RADIUS,
  position.y + PEARL_RADIUS,
  position.z + PEARL_RADIUS,
];

export function probePearlOrigin(world, context, position) {
  if (!validPearlPosition(position, context, world.dimension))
    return { kind: "invalid" };
  const bounds = projectileBox(position);
  const reads = readSet(world, context, bounds);
  if (!reads || reads.status() !== "ready") return readFailure(reads);
  const blocked = boxCollides(reads.view, bounds, {
    unloaded: "empty",
    borders: false,
  });
  if (reads.status() !== "ready") return readFailure(reads);
  return {
    kind: blocked ? "blocked" : "ready",
    validate: () => reads.validate(),
  };
}

/** Clip to an actual miss boundary, but still hit any earlier solid on the path. */
function clipFlight(position, displacement, spec) {
  let fraction = 1;
  let reason = null;
  const clip = (axis, limit, why) => {
    const value = (limit - position[axis]) / displacement[axis];
    if (value >= 0 && value <= fraction) {
      fraction = value;
      reason = why;
    }
  };
  for (const axis of ["x", "z"]) {
    if (displacement[axis] > 0) clip(axis, WORLD_MAX - PEARL_RADIUS, "border");
    if (displacement[axis] < 0) clip(axis, WORLD_MIN + PEARL_RADIUS, "border");
  }
  if (displacement.y < 0) clip("y", spec.voidY, "void");
  return { fraction, reason };
}

/**
 * Swept 1/4-block AABB against the collision channel, including thin/open/
 * partial shapes. This is deliberately not an entity hit or portal traversal.
 * At most one short fixed tick is queried, never a terrain-generating ray.
 */
export function stepPearlFlight(world, context, projectile) {
  const { position, velocity } = projectile;
  if (
    !validPearlPosition(position, context, world.dimension) ||
    !validPearlVelocity(velocity)
  )
    return { kind: "invalid" };
  const displacement = Object.fromEntries(
    axes.map((axis) => [axis, velocity[axis] * PEARL_STEP_SECONDS])
  );
  const clip = clipFlight(
    position,
    displacement,
    context.specForDimension(world.dimension)
  );
  const end = axes.map(
    (axis) => position[axis] + displacement[axis] * clip.fraction
  );
  const start = axes.map((axis) => position[axis]);
  const query = [
    ...start.map((value, axis) => Math.min(value, end[axis]) - PEARL_RADIUS),
    ...start.map((value, axis) => Math.max(value, end[axis]) + PEARL_RADIUS),
  ];
  const reads = readSet(world, context, query);
  if (!reads || reads.status() !== "ready") return readFailure(reads);
  let hit = null;
  visitWorldBoxes(
    reads.view,
    query,
    "collision",
    (contact) => {
      const expanded = contact.box.map(
        (value, axis) => value + (axis < 3 ? -PEARL_RADIUS : PEARL_RADIUS)
      );
      const intersection = intersectRayBox(
        start,
        axes.map((axis) => displacement[axis]),
        expanded,
        clip.fraction
      );
      if (
        !intersection ||
        (hit && intersection.distance >= hit.fraction - BOX_EPSILON)
      )
        return;
      // Touching while moving away/tangentially is not an embedded impact.
      if (
        intersection.normal.every((value) => value === 0) &&
        !overlaps(projectileBox(position), contact.box)
      )
        return;
      const center = Object.fromEntries(
        axes.map((axis) => [
          axis,
          position[axis] + displacement[axis] * intersection.distance,
        ])
      );
      const normal = Object.fromEntries(
        axes.map((axis, i) => [axis, intersection.normal[i]])
      );
      hit = {
        fraction: intersection.distance,
        center,
        point: Object.fromEntries(
          axes.map((axis, i) => [
            axis,
            Math.max(
              contact.box[i],
              Math.min(
                contact.box[i + 3],
                center[axis] - normal[axis] * PEARL_RADIUS
              )
            ),
          ])
        ),
        normal,
        cell: { x: contact.x, y: contact.y, z: contact.z, ...contact.cell },
      };
    },
    { unloaded: "empty", borders: false }
  );
  const water = isWaterFluid(fluidAtPoint(reads.view, position));
  if (reads.status() !== "ready") return readFailure(reads);
  const validate = () => reads.validate();
  if (hit) return { kind: "impact", hit, validate };
  if (clip.reason) return { kind: "miss", reason: clip.reason, validate };
  const motion = integratePearl(position, velocity, { water });
  if (!motion || !validPearlPosition(motion.position, context, world.dimension))
    return { kind: "miss", reason: "flight-bound", validate };
  return { kind: "flight", ...motion, validate };
}

/**
 * Exactly ONE candidate, with feet at the contact (edge/corner contacts are
 * clamped to the struck box): top faces +1/64 block; side faces radius+1/64
 * outward. No support/dryness test, terrain edits,
 * stepping, crouch rescue or safe-spot search. Undersides/embedded contacts are
 * refused: fitting there would require more than this small-offset policy.
 */
export function pearlImpactPose(world, context, hit, { radius, height }) {
  if (
    !finitePearlVector(hit?.point) ||
    !finitePearlVector(hit?.normal) ||
    !Number.isFinite(radius) ||
    radius <= 0 ||
    radius > 0.5 ||
    !Number.isFinite(height) ||
    height <= 0 ||
    height > 2.5 ||
    axes.some((axis) => ![-1, 0, 1].includes(hit.normal[axis])) ||
    axes.reduce((sum, axis) => sum + Math.abs(hit.normal[axis]), 0) !== 1 ||
    hit.normal.y < 0
  )
    return { kind: "blocked" };
  const position = {
    x: hit.point.x + hit.normal.x * (radius + PEARL_COLLISION_OFFSET),
    y: hit.point.y + hit.normal.y * PEARL_COLLISION_OFFSET,
    z: hit.point.z + hit.normal.z * (radius + PEARL_COLLISION_OFFSET),
  };
  if (
    !validPearlPosition(position, context, world.dimension) ||
    position.x - radius < WORLD_MIN ||
    position.x + radius > WORLD_MAX ||
    position.z - radius < WORLD_MIN ||
    position.z + radius > WORLD_MAX
  )
    return { kind: "blocked" };
  const bounds = bodyBox(position, radius, height);
  const reads = readSet(world, context, bounds);
  if (!reads || reads.status() !== "ready") return readFailure(reads);
  const blocked = boxCollides(reads.view, bounds, {
    unloaded: "empty",
    borders: false,
  });
  if (reads.status() !== "ready") return readFailure(reads);
  return {
    kind: blocked ? "blocked" : "ready",
    position,
    validate: () => reads.validate(),
  };
}
