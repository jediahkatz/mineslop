import {
  BOAT_BUBBLE_SECONDS,
  BOAT_MAX_SPEED,
  BOAT_MAX_VERTICAL_SPEED,
  BOAT_RADIUS,
  BOAT_RECORD_RESERVED_BYTES,
  BOAT_SEAT_HEIGHT,
  BOAT_SUBMERGE_SECONDS,
  boatHeading,
  boatWoodForItem,
  MAX_BOATS,
  validPassengerId,
} from "./boat-definitions.js";
import { entityContextFor } from "./entity-context.js";
import { cloneStack, isValidStack } from "./inventory-slots.js";
import { encodedBytes } from "./save-budget.js";
import { WORLD_MAX, WORLD_MIN } from "./terrain.js";
import { isWorldPose } from "./world-spec.js";

const record = (value) =>
  !!value && typeof value === "object" && !Array.isArray(value);
const bounded = (value, min, max) =>
  Number.isFinite(value) && value >= min && value <= max;
const fields = new Set([
  "id",
  "wood",
  "stack",
  "dimension",
  "x",
  "y",
  "z",
  "yaw",
  "vx",
  "vy",
  "vz",
  "turnVelocity",
  "submergedTime",
  "bubbleTime",
  "bubbleDirection",
  "paddlePhase",
  "passengers",
]);

export function cloneBoatRecord(boat, context) {
  return {
    ...boat,
    stack: cloneStack(boat.stack, context),
    passengers: [...boat.passengers],
  };
}

export function validBoatPosition(
  position,
  context,
  dimension = position?.dimension
) {
  return (
    isWorldPose(position, context, dimension) &&
    Number.isSafeInteger(Math.ceil(position.y + BOAT_SEAT_HEIGHT + 1.8)) &&
    position.x >= WORLD_MIN + BOAT_RADIUS &&
    position.x <= WORLD_MAX - BOAT_RADIUS &&
    position.z >= WORLD_MIN + BOAT_RADIUS &&
    position.z <= WORLD_MAX - BOAT_RADIUS
  );
}

/** No Three.js, live ownership, budget admission, or world generation here. */
export function normalizeBoatRecord(value, context) {
  try {
    if (
      !record(value) ||
      Object.keys(value).some((key) => !fields.has(key)) ||
      !Number.isSafeInteger(value.id) ||
      value.id < 1 ||
      !isValidStack(value.stack, context) ||
      value.stack.count !== 1 ||
      boatWoodForItem(value.stack.id) !== value.wood ||
      !validBoatPosition(value, context) ||
      !Number.isFinite(value.yaw) ||
      !bounded(value.vx, -BOAT_MAX_SPEED, BOAT_MAX_SPEED) ||
      !bounded(value.vz, -BOAT_MAX_SPEED, BOAT_MAX_SPEED) ||
      !bounded(value.vy, -BOAT_MAX_VERTICAL_SPEED, BOAT_MAX_VERTICAL_SPEED) ||
      !bounded(value.turnVelocity, -4, 4) ||
      !bounded(value.submergedTime, 0, BOAT_SUBMERGE_SECONDS) ||
      !bounded(value.bubbleTime, 0, BOAT_BUBBLE_SECONDS) ||
      ![-1, 0, 1].includes(value.bubbleDirection) ||
      !bounded(value.paddlePhase, 0, Math.PI * 2) ||
      !Array.isArray(value.passengers) ||
      value.passengers.length !== 2 ||
      !Array.from(value.passengers).every(
        (id) => id === null || validPassengerId(id)
      ) ||
      (value.passengers[0] === null && value.passengers[1] !== null) ||
      (value.passengers[0] !== null &&
        value.passengers[0] === value.passengers[1])
    )
      return null;
    const result = cloneBoatRecord(
      { ...value, yaw: boatHeading(value.yaw) },
      context
    );
    return encodedBytes(result) + 1 <= BOAT_RECORD_RESERVED_BYTES
      ? result
      : null;
  } catch {
    return null;
  }
}

export function normalizeBoatSnapshot(data, context) {
  try {
    context = entityContextFor(undefined, context);
    const empty = {
      version: 1,
      seed: String(context.seed),
      generatorVersion: context.generatorVersion,
      nextId: 1,
      boats: [],
    };
    if (data === undefined) return empty;
    if (
      !record(data) ||
      data.version !== 1 ||
      Object.keys(data).some((key) => !Object.hasOwn(empty, key)) ||
      data.seed !== empty.seed ||
      data.generatorVersion !== empty.generatorVersion ||
      !Number.isSafeInteger(data.nextId) ||
      data.nextId < 1 ||
      !Array.isArray(data.boats) ||
      data.boats.length > MAX_BOATS
    )
      return null;
    const ids = new Set(),
      passengers = new Set(),
      boats = [];
    for (const entry of data.boats) {
      const boat = normalizeBoatRecord(entry, context);
      if (!boat || boat.id >= data.nextId || ids.has(boat.id)) return null;
      ids.add(boat.id);
      for (const id of boat.passengers) {
        if (id === null) continue;
        if (passengers.has(id)) return null;
        passengers.add(id);
      }
      boats.push(boat);
    }
    return { ...empty, nextId: data.nextId, boats };
  } catch {
    return null;
  }
}
