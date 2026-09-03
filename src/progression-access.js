import { cellsEqual, normalizeCell } from "./block-state.js";
import { captureEntityContext } from "./entity-context.js";
import { synchronous } from "./enchantment-domain.js";
import { raycast } from "./raycast.js";
import { CHUNK_SIZE } from "./terrain.js";
import { inWorldBounds } from "./world-spec.js";
import { progressionStationKind, stationPosition } from "./progression-station-state.js";

export const PROGRESSION_REACH = 5.5;
export const MAX_PROGRESSION_READS = 512;
const vector = (value) => value && ["x", "y", "z"].every((axis) =>
  Number.isFinite(value[axis])
);
const copyVector = ({ x, y, z }) => ({ x, y, z });
const sameVector = (a, b) => vector(a) && a.x === b.x && a.y === b.y && a.z === b.z;

/**
 * Real resident-World read set, with epoch, chunk object, incarnation, revision
 * AND exact cells. It never requests/generates columns. Null in-bound cells are
 * unavailable, not AIR. The frozen validator can guard any prepared owner.
 */
export function progressionReadSet(world, context) {
  if (
    !world || world._disposed || !(world.chunks instanceof Map) ||
    !synchronous(world.getCell) || world.seed !== context.seed ||
    world.generatorVersion !== context.generatorVersion
  )
    return null;
  const current = captureEntityContext(world, context);
  const reads = new Map();
  const columns = new Map();
  let unavailable = false;
  const read = (x, y, z) => {
    if (!inWorldBounds(x, y, z, world.spec)) return null;
    const key = `${x},${y},${z}`;
    if (reads.has(key)) return reads.get(key).cell;
    if (reads.size >= MAX_PROGRESSION_READS) {
      unavailable = true;
      return null;
    }
    const columnKey = `${Math.floor(x / CHUNK_SIZE)},${Math.floor(z / CHUNK_SIZE)}`;
    const chunk = world.chunks.get(columnKey);
    if (!columns.has(columnKey))
      columns.set(columnKey, {
        chunk, incarnation: chunk?.incarnation, revision: chunk?.revision,
      });
    const value = world.getCell(x, y, z);
    const cell = value === null ? null : normalizeCell(value);
    if (!chunk || !Number.isSafeInteger(chunk.incarnation) ||
        !Number.isSafeInteger(chunk.revision) || cell === null)
      unavailable = true;
    reads.set(key, { x, y, z, cell });
    return cell;
  };
  return {
    read,
    view: {
      spec: world.spec, getCell: read,
      isLoaded: (x, z) => world.isLoaded(x, z),
    },
    validate() {
      return !unavailable && current() &&
        [...columns].every(([key, value]) =>
          world.chunks.get(key) === value.chunk &&
          value.chunk?.incarnation === value.incarnation &&
          value.chunk?.revision === value.revision
        ) && [...reads.values()].every(({ x, y, z, cell }) =>
          cellsEqual(world.getCell(x, y, z), cell)
        );
    },
  };
}

/**
 * readActor is a synchronous parent bridge:
 * {ref: actual Player, world, dimension, alive, eye, position, life?}.
 * A captured action pins both physical pose and (when supplied) shared life ID.
 * Long-lived menus re-capture for each click; ordinary frame revisions do not
 * permanently invalidate an otherwise reachable table.
 */
export function captureProgressionActor(world, gameplay, readActor) {
  if (
    !synchronous(readActor) || gameplay.dead || gameplay._disposed ||
    gameplay.coordinator !== world.coordinator
  )
    return null;
  const read = () => {
    const actor = readActor();
    if (
      !actor || !actor.ref || actor.world !== world ||
      actor.dimension !== world.dimension || actor.alive !== true ||
      !vector(actor.eye) || !vector(actor.position)
    )
      return null;
    return {
      ref: actor.ref, world, dimension: actor.dimension, life: actor.life,
      poseRevision: actor.poseRevision,
      forward: vector(actor.forward) ? copyVector(actor.forward) : null,
      eye: copyVector(actor.eye), position: copyVector(actor.position),
    };
  };
  const actor = read();
  if (!actor) return null;
  const current = captureEntityContext(world, gameplay.context);
  const mode = gameplay.mode;
  const context = gameplay.context;
  const handRevisions = ["main", "offhand"].map((hand) => gameplay.getHandRevision(hand));
  return {
    ...actor,
    validate() {
      const now = read();
      return !!now && current() && !gameplay.dead && !gameplay._disposed &&
        gameplay.coordinator === world.coordinator && gameplay.context === context &&
        gameplay.mode === mode && now.ref === actor.ref && now.life === actor.life &&
        now.poseRevision === actor.poseRevision &&
        (actor.forward === null ? now.forward === null : sameVector(now.forward, actor.forward)) &&
        sameVector(now.eye, actor.eye) && sameVector(now.position, actor.position) &&
        ["main", "offhand"].every((hand, index) =>
          gameplay.getHandRevision(hand) === handRevisions[index]
        );
    },
  };
}

export function captureStationAccess(world, gameplay, readActor, value, context) {
  try {
    const at = stationPosition(value, context);
    if (at.dimension !== world.dimension) return null;
    const actor = captureProgressionActor(world, gameplay, readActor);
    const reads = progressionReadSet(world, context);
    if (!actor || !reads) return null;
    const cell = reads.read(at.x, at.y, at.z);
    const kind = progressionStationKind(cell?.id);
    if (!kind || (value.kind !== undefined && value.kind !== kind)) return null;
    const delta = {
      x: at.x + 0.5 - actor.eye.x,
      y: at.y + 0.5 - actor.eye.y,
      z: at.z + 0.5 - actor.eye.z,
    };
    const distance = Math.hypot(delta.x, delta.y, delta.z);
    if (distance > PROGRESSION_REACH) return null;
    if (distance > 1e-8) {
      const direction = Object.fromEntries(Object.entries(delta).map(
        ([axis, amount]) => [axis, amount / distance]
      ));
      const obstruction = raycast(reads.view, actor.eye, direction, distance, {
        channel: "collision",
      });
      if (obstruction && (obstruction.x !== at.x ||
          obstruction.y !== at.y || obstruction.z !== at.z))
        return null;
    }
    if (!reads.validate()) return null;
    return {
      at, kind, cell, actor, reads,
      validate: () => actor.validate() && reads.validate(),
    };
  } catch {
    return null;
  }
}
