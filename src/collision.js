import {
  box,
  BOX_EPSILON,
  containsPoint,
  intersectRayBox,
  overlaps,
  translateBox,
} from "./aabb.js";
import { resolveShape } from "./block-shapes.js";
import { FLUID } from "./block-state.js";
import {
  columnLoaded,
  geometryWorldSpec,
  inHorizontalBounds,
  readGeometryCell,
  shapeAt,
} from "./geometry-world.js";
import { WORLD_MAX, WORLD_MIN } from "./terrain.js";

export const MAX_STEP_HEIGHT = 0.6;
const AXES = ["x", "y", "z"];
const validQuery = (bounds) =>
  Array.isArray(bounds) &&
  bounds.length === 6 &&
  bounds.every(
    (value) => Number.isFinite(value) && Number.isSafeInteger(Math.floor(value))
  ) &&
  [0, 1, 2].every((axis) => bounds[axis] <= bounds[axis + 3]);

export function bodyBox(position, radius = 0.3, height = 1.8) {
  return box(
    position.x - radius,
    position.y,
    position.z - radius,
    position.x + radius,
    position.y + height,
    position.z + radius
  );
}

/** Includes owners just outside the query: a fence in y-1 reaches y+0.5.
 * Unloaded frontiers are column walls even above the build ceiling. Vertical
 * cell reads, however, always stay within the world's actual signed spec.
 */
export function visitWorldBoxes(
  world,
  query,
  channel,
  visit,
  { unloaded = "solid", borders = true } = {}
) {
  if (!validQuery(query)) return;
  const { minY, maxY } = geometryWorldSpec(world);
  const y0 = Math.max(minY, Math.floor(query[1]) - 1);
  const y1 = Math.min(maxY - 1, Math.floor(query[4]) + 1);
  for (
    let z = Math.max(WORLD_MIN - 1, Math.floor(query[2]) - 1);
    z <= Math.min(WORLD_MAX, Math.floor(query[5]) + 1);
    z++
  ) {
    for (
      let x = Math.max(WORLD_MIN - 1, Math.floor(query[0]) - 1);
      x <= Math.min(WORLD_MAX, Math.floor(query[3]) + 1);
      x++
    ) {
      const inside = inHorizontalBounds(x, z);
      if (!inside || !columnLoaded(world, x, z)) {
        if (
          (inside ? unloaded === "solid" : borders) &&
          channel === "collision"
        ) {
          const bounds = box(x, query[1] - 1, z, x + 1, query[4] + 1, z + 1);
          if (overlaps(query, bounds, -BOX_EPSILON))
            visit({
              box: bounds,
              x,
              y: null,
              z,
              cell: null,
              shape: null,
              frontier: true,
            });
        }
        continue;
      }
      for (let y = y0; y <= y1; y++) {
        const resolved = shapeAt(world, x, y, z, channel);
        if (!resolved) continue;
        const { cell, shape } = resolved;
        for (let part = 0; part < shape[channel].length; part++) {
          const localBox = shape[channel][part];
          const bounds = translateBox(localBox, x, y, z);
          if (overlaps(query, bounds, -BOX_EPSILON))
            visit({ box: bounds, localBox, x, y, z, cell, shape, part });
        }
      }
    }
  }
}

export function boxCollides(world, bounds, options) {
  if (!validQuery(bounds)) return true;
  let collision = false;
  visitWorldBoxes(
    world,
    bounds,
    "collision",
    (contact) => {
      if (overlaps(bounds, contact.box)) collision = true;
    },
    options
  );
  return collision;
}

/** Clips against every crossed exact box, not only the final position. */
export function sweepBoxAxis(world, bounds, axis, amount, options) {
  const index = typeof axis === "number" ? axis : AXES.indexOf(axis);
  if (
    !validQuery(bounds) ||
    !Number.isFinite(amount) ||
    ![0, 1, 2].includes(index)
  )
    return { amount: 0, blocked: true };
  if (!amount) return { amount: 0, blocked: false };
  const query = [...bounds];
  query[index] += Math.min(0, amount);
  query[index + 3] += Math.max(0, amount);
  if (!validQuery(query)) return { amount: 0, blocked: true };
  let allowed = amount;
  visitWorldBoxes(
    world,
    query,
    "collision",
    ({ box: obstacle }) => {
      for (let other = 0; other < 3; other++) {
        if (other === index) continue;
        if (
          bounds[other + 3] <= obstacle[other] + BOX_EPSILON ||
          bounds[other] >= obstacle[other + 3] - BOX_EPSILON
        )
          return;
      }
      if (amount > 0 && bounds[index + 3] <= obstacle[index] + BOX_EPSILON)
        allowed = Math.min(
          allowed,
          Math.max(0, obstacle[index] - bounds[index + 3])
        );
      else if (amount < 0 && bounds[index] >= obstacle[index + 3] - BOX_EPSILON)
        allowed = Math.max(
          allowed,
          Math.min(0, obstacle[index + 3] - bounds[index])
        );
      else if (overlaps(bounds, obstacle)) allowed = 0;
    },
    options
  );
  return { amount: allowed, blocked: Math.abs(allowed - amount) > BOX_EPSILON };
}

/** Exact support tops intersecting a footprint within a vertical interval. */
export function supportContacts(
  world,
  position,
  { radius = 0.3, maxDrop = 0.05, maxRise = 0, filter = () => true } = {}
) {
  const contacts = [];
  const query = box(
    position.x - radius,
    position.y - maxDrop - BOX_EPSILON * 2,
    position.z - radius,
    position.x + radius,
    position.y + maxRise + BOX_EPSILON * 2,
    position.z + radius
  );
  visitWorldBoxes(
    world,
    query,
    "support",
    (contact) => {
      const top = contact.box[4];
      if (
        top >= position.y - maxDrop - BOX_EPSILON &&
        top <= position.y + maxRise + BOX_EPSILON &&
        query[0] < contact.box[3] - BOX_EPSILON &&
        query[3] > contact.box[0] + BOX_EPSILON &&
        query[2] < contact.box[5] - BOX_EPSILON &&
        query[5] > contact.box[2] + BOX_EPSILON &&
        filter(contact)
      )
        contacts.push({ ...contact, height: top });
    },
    { unloaded: "empty", borders: false }
  );
  return contacts;
}

export function standingHeight(world, position, options) {
  const contacts = supportContacts(world, position, options);
  return contacts.length
    ? Math.max(...contacts.map((contact) => contact.height))
    : null;
}

export function hasBodySupport(world, position, options) {
  return standingHeight(world, position, options) !== null;
}

function sneakDisplacement(world, position, x, z, radius, stepHeight) {
  const supported = (dx, dz) =>
    hasBodySupport(
      world,
      { x: position.x + dx, y: position.y, z: position.z + dz },
      {
        radius,
        maxDrop: Math.max(0.05, stepHeight),
        maxRise: stepHeight,
      }
    );
  const reduce = (value) =>
    Math.sign(value) * Math.max(0, Math.abs(value) - 0.05);
  while (x && !supported(x, 0)) x = reduce(x);
  while (z && !supported(0, z)) z = reduce(z);
  while (x && z && !supported(x, z)) {
    x = reduce(x);
    z = reduce(z);
  }
  return { x, z };
}

function horizontalSweep(world, initial, x, z, radius, height) {
  const position = { ...initial };
  const blocked = { x: false, z: false };
  for (const [axis, amount] of [
    ["x", x],
    ["z", z],
  ]) {
    const moved = sweepBoxAxis(
      world,
      bodyBox(position, radius, height),
      axis,
      amount
    );
    position[axis] += moved.amount;
    blocked[axis] = moved.blocked;
  }
  return { position, blocked };
}

function tryStep(world, initial, normal, x, z, radius, height, stepHeight) {
  const query = [
    Math.min(initial.x, initial.x + x) - radius,
    initial.y,
    Math.min(initial.z, initial.z + z) - radius,
    Math.max(initial.x, initial.x + x) + radius,
    initial.y + height + stepHeight,
    Math.max(initial.z, initial.z + z) + radius,
  ];
  const candidates = new Set();
  visitWorldBoxes(world, query, "collision", (contact) => {
    const rise = contact.box[4] - initial.y;
    if (rise > BOX_EPSILON && rise <= stepHeight + BOX_EPSILON)
      candidates.add(rise);
  });
  const travel = (position) =>
    (position.x - initial.x) ** 2 + (position.z - initial.z) ** 2;
  let best = normal;
  for (const rise of [...candidates].sort((a, b) => a - b)) {
    const up = sweepBoxAxis(world, bodyBox(initial, radius, height), "y", rise);
    if (up.blocked) continue;
    const lifted = { ...initial, y: initial.y + rise };
    const candidate = horizontalSweep(world, lifted, x, z, radius, height);
    if (travel(candidate.position) <= travel(best.position) + BOX_EPSILON)
      continue;
    const down = sweepBoxAxis(
      world,
      bodyBox(candidate.position, radius, height),
      "y",
      -rise - 0.05
    );
    candidate.position.y += down.amount;
    if (
      !down.blocked ||
      boxCollides(world, bodyBox(candidate.position, radius, height))
    )
      continue;
    candidate.stepped = candidate.position.y - initial.y;
    candidate.grounded = true;
    best = candidate;
  }
  return best;
}

/** Axis-separated conservative sweeps with explicit, grounded-only stepping.
 * Substeps are for following multiple stair treads, not for tunnelling safety.
 */
export function moveBody(
  world,
  initialPosition,
  displacement,
  {
    radius = 0.3,
    height = 1.8,
    sneaking = false,
    stepHeight = MAX_STEP_HEIGHT,
  } = {}
) {
  const position = {
    x: initialPosition.x,
    y: initialPosition.y,
    z: initialPosition.z,
  };
  const blocked = { x: false, y: false, z: false };
  if (
    ![
      ...Object.values(position),
      displacement.x,
      displacement.y,
      displacement.z,
    ].every(Number.isFinite) ||
    !Object.values(position).every((value) =>
      Number.isSafeInteger(Math.floor(value))
    ) ||
    !inHorizontalBounds(position.x, position.z) ||
    ![radius, height, stepHeight].every(Number.isFinite) ||
    radius <= 0 ||
    height <= 0 ||
    !validQuery(bodyBox(position, radius, height))
  )
    return {
      position,
      blocked: { x: true, y: true, z: true },
      grounded: false,
      stepped: 0,
    };
  const steps = Math.max(
    1,
    Math.ceil(
      Math.max(
        Math.abs(displacement.x),
        Math.abs(displacement.y),
        Math.abs(displacement.z)
      ) / 0.2
    )
  );
  // Runtime input is bounded by velocity/dt; reject pathological external calls
  // instead of iterating a safe-integer flight coordinate's worth of substeps.
  if (steps > 4096)
    return {
      position,
      blocked: { x: true, y: true, z: true },
      grounded: false,
      stepped: 0,
    };
  const allowedStep = Math.max(0, Math.min(MAX_STEP_HEIGHT, stepHeight));
  let grounded = false;
  let stepped = 0;
  for (let i = 0; i < steps; i++) {
    const wasSupported =
      displacement.y <= 0 && hasBodySupport(world, position, { radius });
    const vertical = sweepBoxAxis(
      world,
      bodyBox(position, radius, height),
      "y",
      displacement.y / steps
    );
    position.y += vertical.amount;
    blocked.y ||= vertical.blocked;
    grounded =
      (vertical.blocked && displacement.y < 0) ||
      (displacement.y === 0 && wasSupported);
    const x = displacement.x / steps;
    const z = displacement.z / steps;
    const safe =
      sneaking && (grounded || wasSupported)
        ? sneakDisplacement(world, position, x, z, radius, allowedStep)
        : { x, z };
    const before = { ...position };
    let horizontal = horizontalSweep(
      world,
      before,
      safe.x,
      safe.z,
      radius,
      height
    );
    if (
      allowedStep &&
      (grounded || wasSupported) &&
      (horizontal.blocked.x || horizontal.blocked.z)
    )
      horizontal = tryStep(
        world,
        before,
        horizontal,
        safe.x,
        safe.z,
        radius,
        height,
        allowedStep
      );
    Object.assign(position, horizontal.position);
    blocked.x ||= horizontal.blocked.x || safe.x !== x;
    blocked.z ||= horizontal.blocked.z || safe.z !== z;
    stepped += horizontal.stepped ?? 0;
    grounded =
      !!horizontal.grounded ||
      (grounded && hasBodySupport(world, position, { radius }));
  }
  return { position, blocked, grounded, stepped };
}

/** Swept camera/LOS volume; clearance expands obstacles by the near-plane size. */
export function sweepCameraDistance(
  world,
  origin,
  direction,
  maxDistance = 4,
  clearance = 0.15
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
      clearance,
    ].every(Number.isFinite) ||
    maxDistance < 0 ||
    clearance < 0
  )
    return 0;
  const start = [origin.x, origin.y, origin.z];
  const length = Math.hypot(direction.x, direction.y, direction.z);
  if (!Number.isFinite(length) || length === 0) return 0;
  const vector = [
    direction.x / length,
    direction.y / length,
    direction.z / length,
  ];
  const end = start.map((value, axis) => value + vector[axis] * maxDistance);
  const query = [
    ...start.map((value, axis) => Math.min(value, end[axis]) - clearance),
    ...start.map((value, axis) => Math.max(value, end[axis]) + clearance),
  ];
  if (!validQuery(query)) return 0;
  let distance = maxDistance;
  visitWorldBoxes(world, query, "collision", ({ box: bounds }) => {
    const expanded = bounds.map(
      (value, axis) => value + (axis < 3 ? -clearance : clearance)
    );
    const hit = intersectRayBox(start, vector, expanded, distance);
    if (hit) distance = Math.max(0, hit.distance - BOX_EPSILON);
  });
  return distance;
}

export function intersectsCell(
  position,
  x,
  y,
  z,
  cell,
  neighborhood,
  { radius = 0.3, height = 1.8 } = {}
) {
  const body = bodyBox(position, radius, height);
  return resolveShape(cell, neighborhood).collision.some((bounds) =>
    overlaps(body, translateBox(bounds, x, y, z))
  );
}

/** Proposed cells are resolved together, including new fence connections. */
export function intersectsPlacement(world, position, changes, options) {
  const proposed = new Map(
    changes.map(({ x, y, z, cell, after }) => [`${x},${y},${z}`, cell ?? after])
  );
  const read = (x, y, z) =>
    proposed.get(`${x},${y},${z}`) ?? readGeometryCell(world, x, y, z);
  const owners = new Set();
  for (const { x, y, z } of changes)
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          owners.add(`${x + dx},${y + dy},${z + dz}`);
  for (const key of owners) {
    const [x, y, z] = key.split(",").map(Number);
    const cell = read(x, y, z);
    if (
      cell &&
      intersectsCell(
        position,
        x,
        y,
        z,
        cell,
        (dx, dy, dz) => read(x + dx, y + dy, z + dz),
        options
      )
    )
      return true;
  }
  return false;
}

export function climbContact(world, position, radius = 0.3, height = 1.8) {
  const body = bodyBox(position, radius, height);
  const query = box(
    body[0] - 0.05,
    body[1],
    body[2] - 0.05,
    body[3] + 0.05,
    body[4],
    body[5] + 0.05
  );
  let result = null;
  visitWorldBoxes(
    world,
    query,
    "selection",
    (contact) => {
      if (contact.shape.climbable && overlaps(query, contact.box))
        result ??= contact;
    },
    { unloaded: "empty", borders: false }
  );
  return result;
}

export function fluidAtPoint(world, point) {
  const x = Math.floor(point.x),
    y = Math.floor(point.y),
    z = Math.floor(point.z);
  const resolved = shapeAt(world, x, y, z);
  if (!resolved) return FLUID.NONE;
  return resolved.shape.fluidVolume.some((bounds) =>
    containsPoint(bounds, [point.x - x, point.y - y, point.z - z])
  )
    ? resolved.shape.fluid
    : FLUID.NONE;
}

export function clampHorizontalBody(position, radius) {
  return {
    ...position,
    x: Math.max(WORLD_MIN + radius, Math.min(WORLD_MAX - radius, position.x)),
    z: Math.max(WORLD_MIN + radius, Math.min(WORLD_MAX - radius, position.z)),
  };
}
