import { BOX_EPSILON, containsPoint, intersectRayBox, overlaps, translateBox } from "./aabb.js";
import { isValidCell, normalizeCell } from "./block-state.js";
import { geometryEpoch, geometryWorldSpec, inHorizontalBounds, shapeAt } from "./geometry-world.js";
import { CHUNK_SIZE, WORLD_MAX, WORLD_MIN } from "./terrain.js";
import { isDimension } from "./world-spec.js";

/** Fractions within this distance of the GLOBAL minimum form one tie group. */
export const COMBAT_CONTACT_EPSILON = BOX_EPSILON;
export const COMBAT_COLLISION_LIMITS = Object.freeze({
  segmentLength: 16,
  radius: 1,
  candidates: 29,
  mobs: 28,
  players: 1,
  idLength: 1200,
  actorExtent: 8,
  envelopeMembers: 2,
  geometryCells: 2048,
  readCells: 4096,
  columns: 9,
  readOperations: 16384,
  geometryBoxes: 8192,
  partsPerCell: 16,
  boxTests: 8192,
});

const AXES = ["x", "y", "z"];
const limit = COMBAT_COLLISION_LIMITS;
const counters = () => ({
  candidates: 0, geometryCells: 0, cellReads: 0, columns: 0,
  readOperations: 0, geometryBoxes: 0, boxTests: 0,
});
class Refusal extends Error {}
const refuse = (reason) => { throw new Refusal(reason); };
const check = (condition, reason) => { if (!condition) refuse(reason); };
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const identity = (value) => value !== null && typeof value === "object";
const record = (value) => identity(value) && !Array.isArray(value);
const validId = (value) =>
  typeof value === "string" && value.length > 0 && value.length <= limit.idLength;
const coordinate = (value) => Number.isFinite(value) &&
  Number.isSafeInteger(Math.floor(value - 8)) &&
  Number.isSafeInteger(Math.ceil(value + 8));
const never = () => false;

function spend(counts, name, maximum, amount = 1) {
  check(counts[name] + amount <= maximum, `limit-${name}`);
  counts[name] += amount;
}

function vector(value) {
  check(record(value) && AXES.every((axis) => coordinate(value[axis])), "invalid-vector");
  return Object.freeze(AXES.map((axis) => value[axis]));
}

function bounds(value, extent = Infinity) {
  check(Array.isArray(value) && value.length === 6, "invalid-box");
  const copy = [0, 1, 2, 3, 4, 5].map((index) => value[index]);
  check(copy.every(coordinate) && [0, 1, 2].every((axis) =>
    copy[axis] < copy[axis + 3] && copy[axis + 3] - copy[axis] <= extent) &&
    copy[0] >= WORLD_MIN && copy[3] <= WORLD_MAX &&
    copy[2] >= WORLD_MIN && copy[5] <= WORLD_MAX, "invalid-box");
  return Object.freeze(copy);
}

const actorKey = (actor) => JSON.stringify([actor.kind, actor.id]);
function actorFacts(value, dimension, epoch, withBox) {
  check(record(value) && ["mob", "player"].includes(value.kind) &&
    validId(value.id) && integer(value.incarnation) && identity(value.ref) &&
    value.dimension === dimension && value.worldEpoch === epoch &&
    (value.kind !== "player" || integer(value.life)), "invalid-candidate");
  const actor = {
    kind: value.kind, id: value.id, incarnation: value.incarnation, ref: value.ref,
    dimension, worldEpoch: epoch, life: value.kind === "player" ? value.life : null,
  };
  if (withBox) actor.box = bounds(value.box, limit.actorExtent);
  actor.key = actorKey(actor);
  return Object.freeze(actor);
}

function ranges(query, spec, apron) {
  return [
    Math.max(WORLD_MIN, Math.floor(query[0]) - apron),
    Math.max(spec.minY, Math.floor(query[1]) - apron),
    Math.max(WORLD_MIN, Math.floor(query[2]) - apron),
    Math.min(WORLD_MAX - 1, Math.floor(query[3]) + apron),
    Math.min(spec.maxY - 1, Math.floor(query[4]) + apron),
    Math.min(WORLD_MAX - 1, Math.floor(query[5]) + apron),
  ];
}
const volume = (range) => [0, 1, 2].reduce(
  (total, axis) => total * Math.max(0, range[axis + 3] - range[axis] + 1), 1);

function snapshot(facts, counts) {
  check(record(facts), "invalid-request");
  const from = vector(facts.from), to = vector(facts.to), radius = facts.radius;
  check(Number.isFinite(radius) && radius >= 0 && radius <= limit.radius, "invalid-radius");
  const direction = Object.freeze(to.map((value, axis) => value - from[axis]));
  check(Math.hypot(...direction) <= limit.segmentLength, "limit-segmentLength");
  const query = Object.freeze([
    ...from.map((value, axis) => Math.min(value, to[axis]) - radius),
    ...from.map((value, axis) => Math.max(value, to[axis]) + radius),
  ]);
  check([from, to].every((point) => inHorizontalBounds(point[0], point[2])) &&
    query[0] >= WORLD_MIN && query[3] <= WORLD_MAX &&
    query[2] >= WORLD_MIN && query[5] <= WORLD_MAX, "horizontal-bounds");
  const world = facts.world;
  check(record(world) && !world._disposed && isDimension(world.dimension) &&
    integer(geometryEpoch(world)) && world.chunks instanceof Map &&
    typeof world.isLoaded === "function" && typeof world.getCell === "function",
  "invalid-world");
  const actualSpec = geometryWorldSpec(world);
  check(Number.isSafeInteger(actualSpec.minY) && Number.isSafeInteger(actualSpec.maxY) &&
    actualSpec.minY < actualSpec.maxY, "invalid-world-spec");
  const spec = Object.freeze({ minY: actualSpec.minY, maxY: actualSpec.maxY });
  const owners = ranges(query, spec, 1);
  // One cell for protruding owners, TWO more for connected-shape support reads
  // (e.g. a fence -> supporting stair -> stair neighbor). Never an implicit load.
  const reads = ranges(query, spec, 3);
  check(volume(owners) <= limit.geometryCells, "limit-geometryCells");
  check(volume(reads) <= limit.readCells, "limit-readCells");
  const columns = [
    Math.floor(reads[0] / CHUNK_SIZE), Math.floor(reads[2] / CHUNK_SIZE),
    Math.floor(reads[3] / CHUNK_SIZE), Math.floor(reads[5] / CHUNK_SIZE),
  ];
  check((columns[2] - columns[0] + 1) * (columns[3] - columns[1] + 1) <= limit.columns,
    "limit-columns");
  check(record(facts.ticket) && validId(facts.ticket.id) &&
    integer(facts.ticket.runtimeEpoch) && integer(facts.ticket.revision), "invalid-ticket");
  const ticket = Object.freeze({
    id: facts.ticket.id, runtimeEpoch: facts.ticket.runtimeEpoch, revision: facts.ticket.revision,
  });
  check(Array.isArray(facts.candidates) && facts.candidates.length <= limit.candidates,
    "limit-candidates");
  const epoch = geometryEpoch(world), dimension = world.dimension;
  const candidates = [], keys = new Set();
  let mobs = 0, players = 0;
  for (let index = 0; index < facts.candidates.length; index++) {
    spend(counts, "candidates", limit.candidates);
    const actor = actorFacts(facts.candidates[index], dimension, epoch, true);
    if (actor.kind === "mob") mobs++;
    else players++;
    check(mobs <= limit.mobs && players <= limit.players, "limit-actor-kinds");
    check(!keys.has(actor.key), "duplicate-candidate");
    keys.add(actor.key);
    candidates.push(actor);
  }
  let envelope = null;
  if (facts.sourceEnvelope != null) {
    const raw = facts.sourceEnvelope;
    check(record(raw) && typeof raw.exited === "boolean" &&
      Array.isArray(raw.members) && raw.members.length > 0 &&
      raw.members.length <= limit.envelopeMembers, "invalid-source-envelope");
    const members = [];
    for (let index = 0; index < raw.members.length; index++)
      members.push(actorFacts(raw.members[index], dimension, epoch, false));
    check(new Set(members.map((member) => member.key)).size === members.length,
      "duplicate-envelope-member");
    envelope = Object.freeze({
      exited: raw.exited, box: bounds(raw.box, limit.actorExtent),
      members: Object.freeze(members),
    });
  }
  return Object.freeze({
    world, epoch, dimension, spec, from, to, direction, radius, query, ticket,
    owners, reads, columns, candidates: Object.freeze(candidates), envelope,
    chunks: world.chunks, getCell: world.getCell, isLoaded: world.isLoaded,
    seed: world.seed, generatorVersion: world.generatorVersion,
  });
}

function sameWorld(state) {
  const world = state.world, spec = geometryWorldSpec(world);
  return !world._disposed && geometryEpoch(world) === state.epoch &&
    world.dimension === state.dimension && world.seed === state.seed &&
    world.generatorVersion === state.generatorVersion &&
    world.chunks === state.chunks && world.getCell === state.getCell &&
    world.isLoaded === state.isLoaded &&
    spec.minY === state.spec.minY && spec.maxY === state.spec.maxY;
}

function geometryReads(state, counts) {
  const { world, reads, columns: range } = state;
  const columns = new Map(), cells = new Map(), missing = new Map();
  for (let cz = range[1]; cz <= range[3]; cz++) {
    for (let cx = range[0]; cx <= range[2]; cx++) {
      spend(counts, "columns", limit.columns);
      spend(counts, "readOperations", limit.readOperations, 2);
      const key = `${cx},${cz}`;
      const loaded = world.isLoaded(cx * CHUNK_SIZE, cz * CHUNK_SIZE);
      const chunk = world.chunks.get(key);
      check(typeof loaded === "boolean" && (!loaded || (chunk &&
        integer(chunk.incarnation) && integer(chunk.revision))), "invalid-column");
      const entry = Object.freeze({
        key, cx, cz, loaded, chunk,
        incarnation: chunk?.incarnation, revision: chunk?.revision,
      });
      columns.set(key, entry);
      if (!loaded) missing.set(key, Object.freeze({ cx, cz }));
    }
  }
  const columnAt = (x, z) => {
    if (x < WORLD_MIN || x >= WORLD_MAX || z < WORLD_MIN || z >= WORLD_MAX) return null;
    const entry = columns.get(`${Math.floor(x / CHUNK_SIZE)},${Math.floor(z / CHUNK_SIZE)}`);
    check(!!entry, "geometry-outside-read-apron");
    return entry;
  };
  const current = (budget) => {
    if (!sameWorld(state)) return false;
    for (const entry of columns.values()) {
      spend(budget, "readOperations", limit.readOperations, 2);
      const chunk = world.chunks.get(entry.key);
      if (world.isLoaded(entry.cx * CHUNK_SIZE, entry.cz * CHUNK_SIZE) !== entry.loaded ||
        chunk !== entry.chunk || chunk?.incarnation !== entry.incarnation ||
        chunk?.revision !== entry.revision) return false;
    }
    return true;
  };
  const view = {
    dimension: state.dimension, spec: state.spec, generatorVersion: state.generatorVersion,
    isLoaded(x, z) {
      spend(counts, "readOperations", limit.readOperations);
      return columnAt(x, z)?.loaded === true;
    },
    getCell(x, y, z) {
      spend(counts, "readOperations", limit.readOperations);
      check([x, y, z].every(Number.isSafeInteger), "invalid-geometry-coordinate");
      if (y < state.spec.minY || y >= state.spec.maxY) return null;
      const column = columnAt(x, z);
      if (!column?.loaded) return null;
      check([x, y, z].every((value, axis) =>
        value >= reads[axis] && value <= reads[axis + 3]), "geometry-outside-read-apron");
      const key = `${x},${y},${z}`;
      if (cells.has(key)) return cells.get(key);
      check(counts.readOperations < limit.readOperations, "limit-readOperations");
      spend(counts, "cellReads", limit.readCells);
      spend(counts, "readOperations", limit.readOperations);
      const value = world.getCell(x, y, z);
      if (value === null) {
        missing.set(column.key, Object.freeze({ cx: column.cx, cz: column.cz }));
        cells.set(key, null);
        return null;
      }
      check(isValidCell(value), "invalid-geometry-cell");
      const cell = Object.freeze(normalizeCell(value));
      cells.set(key, cell);
      return cell;
    },
  };
  return { view, current, missing };
}

const expanded = (box, radius) =>
  box.map((value, axis) => value + (axis < 3 ? -radius : radius));
const pointAt = (state, fraction) =>
  state.from.map((value, axis) => value + state.direction[axis] * fraction);
const pointObject = (point) =>
  Object.freeze(Object.fromEntries(AXES.map((axis, index) => [axis, point[index]])));

function sweep(state, box, counts) {
  spend(counts, "boxTests", limit.boxTests);
  const obstacle = expanded(box, state.radius);
  const hit = intersectRayBox(state.from, state.direction, obstacle, 1);
  if (!hit || hit.distance > 1) return null;
  if (containsPoint(obstacle, state.from)) {
    // Embedded origins hit even at rest. A mere starting touch moving away or
    // tangentially must not repeatedly collide; entering touches and endpoints do.
    const entering = state.from.every((value, axis) =>
      (value > obstacle[axis] && value < obstacle[axis + 3]) ||
      (value === obstacle[axis] && state.direction[axis] > 0) ||
      (value === obstacle[axis + 3] && state.direction[axis] < 0));
    if (!entering) return null;
  }
  return { fraction: hit.distance, far: hit.far, normal: hit.normal };
}

function launchEnvelope(state, counts) {
  const envelope = state.envelope;
  if (!envelope || envelope.exited) return { leftAtStart: true, exit: 0, box: null };
  const box = expanded(envelope.box, state.radius);
  if (!containsPoint(box, state.from)) return { leftAtStart: true, exit: 0, box };
  spend(counts, "boxTests", limit.boxTests);
  const interval = intersectRayBox(state.from, state.direction, box, 1);
  return { leftAtStart: false, exit: interval?.far ?? 0, box };
}

const sameActor = (a, b) => a.kind === b.kind && a.id === b.id &&
  a.incarnation === b.incarnation && a.ref === b.ref && a.life === b.life &&
  a.dimension === b.dimension && a.worldEpoch === b.worldEpoch;

function actorSweep(state, actor, envelope, counts) {
  let hit = sweep(state, actor.box, counts);
  if (!hit || envelope.leftAtStart ||
    !state.envelope.members.some((member) => sameActor(member, actor))) return hit;
  if (hit.fraction <= envelope.exit) {
    if (containsPoint(envelope.box, state.to) || hit.far <= envelope.exit) return null;
    // A protected body can move beyond the immutable launch envelope. If it
    // still overlaps after exit, the first eligible contact is the exit, not a
    // permanent shooter exemption or a farther actor behind that body.
    hit = { ...hit, fraction: envelope.exit, normal: [0, 0, 0], afterEnvelopeExit: true };
  }
  return hit;
}

function contactGeometry(state, hit, box) {
  const center = pointAt(state, hit.fraction);
  return {
    fraction: hit.fraction, center: pointObject(center),
    point: pointObject(center.map((value, axis) =>
      Math.max(box[axis], Math.min(box[axis + 3], value - hit.normal[axis] * state.radius)))),
    normal: pointObject(hit.normal), box: Object.freeze([...box]),
  };
}

function worldContact(state, hit, box, cell, x, y, z, part) {
  return Object.freeze({
    kind: "world", ...contactGeometry(state, hit, box),
    cell: Object.freeze({ x, y, z, part, id: cell.id, state: cell.state, fluid: cell.fluid }),
  });
}

function actorContact(state, hit, actor) {
  return Object.freeze({
    kind: "actor", ...contactGeometry(state, hit, actor.box),
    actor: Object.freeze({
      kind: actor.kind, id: actor.id, key: actor.key, incarnation: actor.incarnation,
      dimension: actor.dimension, worldEpoch: actor.worldEpoch, life: actor.life,
    }),
  });
}

function tieOrder(a, b) {
  if (a.kind !== b.kind) return a.kind === "world" ? -1 : 1;
  if (a.kind === "actor") return a.actor.key < b.actor.key ? -1 : a.actor.key > b.actor.key ? 1 : 0;
  for (const key of ["x", "y", "z", "part"]) {
    if (a.cell[key] !== b.cell[key]) return a.cell[key] - b.cell[key];
  }
  return 0;
}

function nearest(contacts) {
  let minimum = Infinity, selected = null;
  for (const { contact } of contacts) minimum = Math.min(minimum, contact.fraction);
  // Pairwise epsilon comparison is non-transitive. Two bounded linear passes
  // make A~B~C chains deterministic under reversed candidate/geometry order.
  for (const entry of contacts) {
    if (entry.contact.fraction > minimum + COMBAT_CONTACT_EPSILON) continue;
    if (!selected || tieOrder(entry.contact, selected.contact) < 0) selected = entry;
  }
  return selected;
}

function querySegment(state, counts) {
  const reads = geometryReads(state, counts);
  const frontier = () => ({
    result: Object.freeze({
      kind: "frontier", columns: Object.freeze([...reads.missing.values()]),
      sourceEnvelopeExited: state.envelope?.exited ?? true,
    }),
    reads, selectedActor: null,
  });
  if (reads.missing.size) {
    check(reads.current(counts), "stale-geometry");
    return frontier();
  }
  const contacts = [], region = state.owners;
  for (let z = region[2]; z <= region[5]; z++) {
    for (let x = region[0]; x <= region[3]; x++) {
      for (let y = region[1]; y <= region[4]; y++) {
        spend(counts, "geometryCells", limit.geometryCells);
        const resolved = shapeAt(reads.view, x, y, z, "collision");
        if (!resolved) continue;
        const boxes = resolved.shape.collision;
        check(boxes.length <= limit.partsPerCell, "limit-partsPerCell");
        spend(counts, "geometryBoxes", limit.geometryBoxes, boxes.length);
        for (let part = 0; part < boxes.length; part++) {
          const box = translateBox(boxes[part], x, y, z);
          if (!overlaps(state.query, box, -BOX_EPSILON)) continue;
          const hit = sweep(state, box, counts);
          if (hit) contacts.push({
            contact: worldContact(state, hit, box, resolved.cell, x, y, z, part), actor: null,
          });
        }
      }
    }
  }
  check(reads.current(counts), "stale-geometry");
  if (reads.missing.size) return frontier();
  const envelope = launchEnvelope(state, counts);
  for (const actor of state.candidates) {
    const hit = actorSweep(state, actor, envelope, counts);
    if (hit) contacts.push({
      contact: actorContact(state, hit, actor), actor, afterEnvelopeExit: hit.afterEnvelopeExit === true,
    });
  }
  const selected = nearest(contacts), fraction = selected?.contact.fraction ?? 1;
  const sourceEnvelopeExited = envelope.leftAtStart || selected?.afterEnvelopeExit === true ||
    !containsPoint(envelope.box, pointAt(state, fraction));
  return {
    result: Object.freeze(selected
      ? { kind: "contact", contact: selected.contact, sourceEnvelopeExited }
      : { kind: "flight", sourceEnvelopeExited }),
    reads, selectedActor: selected?.actor ?? null,
  };
}

const equalArray = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);
function sameSegment(a, b) {
  if (a.world !== b.world || a.epoch !== b.epoch || a.dimension !== b.dimension ||
    a.ticket.id !== b.ticket.id || a.ticket.runtimeEpoch !== b.ticket.runtimeEpoch ||
    a.ticket.revision !== b.ticket.revision || a.radius !== b.radius ||
    !equalArray(a.from, b.from) || !equalArray(a.to, b.to) ||
    !!a.envelope !== !!b.envelope) return false;
  if (!a.envelope) return true;
  return a.envelope.exited === b.envelope.exited &&
    equalArray(a.envelope.box, b.envelope.box) &&
    a.envelope.members.length === b.envelope.members.length &&
    a.envelope.members.every((member, index) => sameActor(member, b.envelope.members[index]));
}

const close = (a, b) => Math.abs(a - b) <= COMBAT_CONTACT_EPSILON;
function sameNearest(before, after) {
  const a = before.result, b = after.result;
  if (a.kind !== b.kind || a.sourceEnvelopeExited !== b.sourceEnvelopeExited) return false;
  if (a.kind === "flight") return true;
  if (a.kind === "frontier") return a.columns.length === b.columns.length &&
    a.columns.every((column, index) => column.cx === b.columns[index].cx && column.cz === b.columns[index].cz);
  const first = a.contact, second = b.contact;
  if (first.kind !== second.kind || !close(first.fraction, second.fraction) ||
    !first.box.every((value, index) => close(value, second.box[index])) ||
    ["center", "point", "normal"].some((key) =>
      AXES.some((axis) => !close(first[key][axis], second[key][axis])))) return false;
  return first.kind === "actor"
    ? sameActor(before.selectedActor, after.selectedActor)
    : ["x", "y", "z", "part", "id", "state", "fluid"].every((key) =>
      first.cell[key] === second.cell[key]);
}

/**
 * @typedef {object} CombatCollisionFacts
 * @property {object} world Non-generating World geometry interface: getCell,
 * isLoaded, chunks Map with canonical chunk objects/incarnation/revision, epoch,
 * dimension and spec. No health, owners, saves, generators or renderers are read.
 * @property {{id:string,runtimeEpoch:number,revision:number}} ticket Pending
 * runtime/contact identity. Consumed/cancelled tickets must not be returned by
 * readCurrent. This helper does not authorize an attack or consume the ticket.
 * @property {{x:number,y:number,z:number}} from Previous center.
 * @property {{x:number,y:number,z:number}} to Next center; maximum 16-block chord.
 * @property {number} radius AABB half-extent, [0,1], not a sphere approximation
 * inferred from a render model. No velocity, gravity or projectile size policy.
 * @property {ReadonlyArray<object>} candidates Complete active physical roster:
 * <=28 mobs plus <=1 player, each {kind,id,ref,incarnation,dimension,worldEpoch,
 * life (player only),box:[minX,minY,minZ,maxX,maxY,maxZ]}. `ref` is ONLY an opaque
 * canonical identity token; it is never dereferenced or returned. Supply actual
 * current scalar colliders, including immune and owner-unavailable bodies.
 * Never enumerate dormant byId residents, filter by damage eligibility, or
 * truncate an oversized roster. Completeness is the reader's contract.
 * @property {object|null} [sourceEnvelope] Immutable launch-envelope facts:
 * {exited,box,members:[actor identity facts]}. Box encloses the shooter/shared
 * mount at launch; <=2 members remain DISTINCT physical/damage candidates.
 * Members need not remain alive/present. Preserve this launch box while a ticket
 * is pending, install returned exited only with accepted motion/contact, and
 * keep exited sticky. A returning shot can hit either member after exit.
 */

/**
 * Bounded whole-segment swept AABB against actual connected collision shapes.
 * Results are immutable scalar records plus validate(): flight/contact/frontier/
 * invalid. Unknown terrain anywhere in the bounded read apron returns frontier,
 * never an explosive contact or a partial successful trace. All caps refuse the
 * entire request; stats describe work actually performed, not a partial result.
 *
 * @param {CombatCollisionFacts} facts Detached immutable scalar facts + readers.
 * @param {() => CombatCollisionFacts|null} readCurrent REQUIRED synchronous,
 * read-only current-facts provider. It must re-enumerate the COMPLETE active
 * roster (bounded before gathering; never dormant byId), re-read canonical
 * collider poses/refs/incarnations/life, and return the current World and SAME
 * still-pending ticket/segment/envelope; return null if unavailable. It may NOT
 * just return the selected actor or gate on a shared Wildlife revision.
 *
 * validate() performs exactly one fresh bounded nearest query, pins original
 * chunk identity/incarnation/revision/World epoch AND segment/runtime ticket,
 * then compares nearest kind/identity/fraction/geometry within the declared
 * tolerance. Every validation gets the same work caps (including pin checks).
 * An actor relocating ahead without a shared revision bump therefore rejects.
 * The provider's own work must obey the roster bound; arbitrary callback work
 * cannot be measured here. No optional always-true/selected-victim-only guard.
 * An owner refusing this contact must not ask this helper for a farther victim.
 */
export function traceCombatSegment(facts, readCurrent) {
  const counts = counters();
  try {
    check(typeof readCurrent === "function", "current-reader-required");
    const state = snapshot(facts, counts);
    const initial = querySegment(state, counts);
    const validate = () => {
      const budget = counters();
      try {
        const current = snapshot(readCurrent(), budget);
        if (!sameSegment(state, current) || !initial.reads.current(budget)) return false;
        return sameNearest(initial, querySegment(current, budget));
      } catch {
        return false;
      }
    };
    return Object.freeze({
      ...initial.result, ticket: state.ticket, dimension: state.dimension,
      worldEpoch: state.epoch, stats: Object.freeze({ ...counts }), validate,
    });
  } catch (error) {
    return Object.freeze({
      kind: "invalid", reason: error instanceof Refusal ? error.message : "reader-failed",
      stats: Object.freeze({ ...counts }), validate: never,
    });
  }
}
