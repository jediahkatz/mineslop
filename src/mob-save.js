import { entityContextFor } from "./entity-context.js";
import { MAX_ECOLOGY_RESIDENTS, MAX_KILLED_MOBS, MAX_MOBS, MOB_SPECIES } from "./mob-species.js";
import { validSulfurState } from "./mob-sulfur.js";
import { encodedBytes } from "./save-budget.js";
import { WORLD_MAX, WORLD_MIN } from "./terrain.js";
import { isDimension } from "./world-spec.js";

const record = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const inRange = (value, min, max) =>
  Number.isFinite(value) && value >= min && value <= max;
const headerFields = new Set([
  "version",
  "seed",
  "dimension",
  "randomState",
  "nextId",
  "killed",
  "entities",
]);
const entityFields = new Set([
  "id",
  "kind",
  "position",
  "health",
  "yaw",
  "tamed",
  "angry",
  "attackCooldown",
  "fuse",
  "pacified",
  "absorbedBlock",
]);
export const MAX_ECOLOGY_MOB_RECORD_BYTES = 1024;

export const isMobId = (id) =>
  typeof id === "string" && id.length > 0 && id.length <= 100;

export const normalizeMobHeading = (yaw) =>
  yaw >= -Math.PI && yaw <= Math.PI
    ? yaw
    : Math.atan2(Math.sin(yaw), Math.cos(yaw));

/** Mob feet and the entire species collider must fit; this is NOT player flight. */
export function validMobPosition(position, spec, context, dimension) {
  if (
    !record(position) ||
    !spec ||
    !isDimension(dimension) ||
    (position.dimension !== undefined && position.dimension !== dimension) ||
    ![position.x, position.y, position.z].every(Number.isFinite)
  )
    return false;
  const bounds = entityContextFor(undefined, context).specForDimension(
    dimension
  );
  return (
    position.x >= WORLD_MIN + spec.radius &&
    position.x <= WORLD_MAX - spec.radius &&
    position.z >= WORLD_MIN + spec.radius &&
    position.z <= WORLD_MAX - spec.radius &&
    position.y >= bounds.minY &&
    position.y + spec.height <= bounds.maxY
  );
}

/**
 * Renderer-free, detached v1 ecosystem data. Absence is handled by the archive
 * caller; a present malformed/unsupported snapshot always rejects in full.
 */
export function normalizeMobSnapshot(
  data,
  context,
  dimension = data?.dimension
) {
  if (
    !record(data) ||
    !record(context) ||
    data.version !== 1 ||
    Object.keys(data).some((key) => !headerFields.has(key)) ||
    typeof data.seed !== "string" ||
    data.seed !== String(context.seed) ||
    !isDimension(dimension) ||
    data.dimension !== dimension ||
    !Array.isArray(data.entities) ||
    data.entities.length > MAX_MOBS + MAX_ECOLOGY_RESIDENTS ||
    !Array.isArray(data.killed) ||
    data.killed.length > MAX_KILLED_MOBS ||
    !Number.isSafeInteger(data.randomState) ||
    data.randomState < 0 ||
    data.randomState > 0xffffffff ||
    !Number.isSafeInteger(data.nextId) ||
    data.nextId < 0 ||
    data.nextId >= Number.MAX_SAFE_INTEGER
  )
    return null;

  const ids = new Set();
  const killed = [];
  for (const id of data.killed) {
    if (!isMobId(id) || ids.has(id)) return null;
    ids.add(id);
    killed.push(id);
  }
  const entities = [];
  let companions = 0, legacy = 0, ecology = 0;
  try {
    const bounds = entityContextFor(undefined, context);
    // Validate the context even for empty snapshots.
    bounds.specForDimension(dimension);
    for (const entry of data.entities) {
      const spec =
        record(entry) &&
        typeof entry.kind === "string" &&
        Object.hasOwn(MOB_SPECIES, entry.kind)
          ? MOB_SPECIES[entry.kind]
          : null;
      const dimensions =
        spec &&
        (Array.isArray(spec.dimension) ? spec.dimension : [spec.dimension]);
      if (
        !spec ||
        Object.keys(entry).some((key) => !entityFields.has(key)) ||
        !dimensions.includes(dimension) ||
        (spec.ecology ? ++ecology > MAX_ECOLOGY_RESIDENTS : ++legacy > MAX_MOBS) ||
        !isMobId(entry.id) ||
        ids.has(entry.id) ||
        // Turtle age is owned by the paired ecology sidecar. Base preflight
        // admits its smallest collider; host link validation checks actual age.
        !validMobPosition(entry.position, entry.kind === "turtle"
          ? { ...spec, radius: spec.radius / 2, height: spec.height / 2 }
          : spec, bounds, dimension) ||
        Object.keys(entry.position).some(
          (key) => !["x", "y", "z"].includes(key)
        ) ||
        !inRange(entry.health, Number.MIN_VALUE, spec.health) ||
        !Number.isFinite(entry.yaw) ||
        typeof entry.tamed !== "boolean" ||
        (entry.tamed && (entry.kind !== "wolf" || ++companions > 4)) ||
        !inRange(entry.angry, 0, 20) ||
        !inRange(entry.attackCooldown, 0, spec.cooldown) ||
        !inRange(entry.fuse, 0, 1.65) ||
        !inRange(entry.pacified, 0, 60) ||
        !validSulfurState(entry) ||
        (spec.ecology && encodedBytes(entry) + 1 > MAX_ECOLOGY_MOB_RECORD_BYTES)
      )
        return null;
      ids.add(entry.id);
      entities.push({
        id: entry.id,
        kind: entry.kind,
        position: {
          x: entry.position.x,
          y: entry.position.y,
          z: entry.position.z,
        },
        health: entry.health,
        yaw: normalizeMobHeading(entry.yaw),
        tamed: entry.tamed,
        angry: entry.angry,
        attackCooldown: entry.attackCooldown,
        fuse: entry.fuse,
        pacified: entry.pacified,
        ...(entry.kind === "sulfur_cube"
          ? { absorbedBlock: entry.absorbedBlock ?? null }
          : {}),
      });
    }
  } catch {
    return null;
  }
  return {
    version: 1,
    seed: data.seed,
    dimension,
    randomState: data.randomState,
    nextId: data.nextId,
    killed,
    entities,
  };
}
