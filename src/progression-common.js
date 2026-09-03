import {
  MAX_STRUCTURE_ID_LENGTH,
  parseStructureIdentity,
} from "./canonical-structure-identity.js";
import { seedHash } from "./noise.js";
import { TransactionInvariantError } from "./transactions.js";
import {
  createWorldContext,
  DIMENSIONS,
  getWorldSpec,
  inWorldBounds,
} from "./world-spec.js";

export {
  MAX_STRUCTURE_ID_LENGTH,
  MAX_STRUCTURE_MEMBER_ID_LENGTH,
} from "./canonical-structure-identity.js";

export const synchronousProgressCallback = (value) =>
  typeof value === "function" &&
  Object.prototype.toString.call(value) === "[object Function]";

/** Snapshot schemas accept data, never getters, custom prototypes or extensions. */
export function progressRecord(value, fields) {
  if (
    !value ||
    typeof value !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new RangeError("Invalid progression record");
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string" ||
      !fields.includes(key) ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, "value")
    )
      throw new RangeError("Unknown or non-data progression field");
  }
}

export function progressArray(value, maximum) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > maximum ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    throw new RangeError("Invalid progression array");
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, i);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value"))
      throw new RangeError("Sparse or non-data progression array");
  }
  return value;
}

export function progressId(value, maximum = 192) {
  if (
    typeof value !== "string" ||
    value.length > maximum ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.:/,-]*$/.test(value)
  )
    throw new RangeError("Invalid persistent progression identity");
  return value;
}

/**
 * Uses the same dependency-free, versioned ID grammar as stack map targets.
 * Existing short opaque/authored structure IDs retain their original contract;
 * NPC, trade-offer and jobsite IDs still use the unchanged progressId().
 */
export function progressStructureId(value, dimension, context) {
  if (typeof value !== "string" || !value.startsWith("structure:")) {
    parseStructureIdentity(value);
    return value;
  }
  if (value.length > MAX_STRUCTURE_ID_LENGTH)
    throw new RangeError("Canonical structure identity exceeds its bound");
  context = normalizeProgressContext(context);
  parseStructureIdentity(
    value,
    context.seed,
    context.generatorVersion,
    dimension
  );
  return value;
}

export function normalizeProgressContext(context) {
  if (!context || typeof context.seed !== "string" || context.seed.length > 80)
    throw new RangeError("Progression requires a world identity");
  if (
    context.specForDimension !== undefined &&
    !synchronousProgressCallback(context.specForDimension)
  )
    throw new RangeError("Invalid progression world specification");
  for (const dimension of DIMENSIONS) {
    const expected = getWorldSpec(context.generatorVersion, dimension);
    const actual =
      context.specForDimension === undefined
        ? expected
        : context.specForDimension(dimension);
    if (
      !actual ||
      ["minY", "maxY", "seaLevel", "voidY"].some(
        (key) => actual[key] !== expected[key]
      )
    )
      throw new RangeError("Mismatched progression world specification");
  }
  return createWorldContext(context);
}

export function progressPosition(value, dimension, context) {
  progressRecord(value, ["x", "y", "z"]);
  if (
    !DIMENSIONS.includes(dimension) ||
    !inWorldBounds(
      value.x,
      value.y,
      value.z,
      context.specForDimension(dimension)
    )
  )
    throw new RangeError("Progression position is outside its dimension");
  return { x: value.x, y: value.y, z: value.z };
}

export const progressPositionKey = ({ dimension, position: { x, y, z } }) =>
  `${dimension}:${x},${y},${z}`;

/** Only call with bounded, normalized, acyclic data. */
export function freezeProgressData(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeProgressData(child);
    Object.freeze(value);
  }
  return value;
}

/** Randomness is seeded; hashes are NEVER used as ownership identities. */
export function progressionRandom(identity) {
  let state = seedHash(identity);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export const progressionInteger = (random, low, high) =>
  low + Math.floor(random() * (high - low + 1));

/** Preparation must not commit; invariant failures are never retryable vetoes. */
export function prepareProgression(owner, build) {
  if (owner._busy || owner._disposed) return null;
  owner._busy = true;
  try {
    return build();
  } catch (error) {
    if (error instanceof TransactionInvariantError) throw error;
    return null;
  } finally {
    owner._busy = false;
  }
}

/** A peer may return one participant or a Settlement-style composed plan. */
export function progressionParticipants(value) {
  const result = value?.participants ?? (value ? [value] : null);
  if (!Array.isArray(result) || !result.length || result.length > 16)
    throw new RangeError("A prepared ownership destination is required");
  return [...result];
}

export function composeProgressionPlan(owner, source, peers, result) {
  if (!Array.isArray(peers) || peers.length > 16) return null;
  const participants = [source, ...peers];
  const seen = new Set();
  for (const participant of participants) {
    if (
      !participant ||
      seen.has(participant.owner) ||
      owner.coordinator.usage(participant.owner) === undefined ||
      owner.coordinator.usage(participant.owner) !== participant.beforeBytes ||
      !Number.isSafeInteger(participant.afterBytes) ||
      participant.afterBytes < 0 ||
      !synchronousProgressCallback(participant.validate) ||
      !synchronousProgressCallback(participant.publish) ||
      (participant.notify !== undefined &&
        !synchronousProgressCallback(participant.notify))
    )
      return null;
    seen.add(participant.owner);
  }
  return Object.freeze({
    participants: Object.freeze(participants),
    result: freezeProgressData(structuredClone(result)),
  });
}
